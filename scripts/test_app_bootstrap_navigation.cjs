"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const functions = ["init", "loadSession", "isAdminUserViewMode", "currentRole", "isAdminRole", "roleTabs", "roleAllowsTab", "restoreAppHistoryState"];
function functionDeclaration(name) {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `the regression must execute the actual ${name} implementation`);
  return declaration;
}
const declarations = functions.map(functionDeclaration);
for (const name of ["ROLE_TABS", "REGION_ANALYSIS_TABS"]) {
  const declaration = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
    || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
  assert.ok(declaration, name); declarations.unshift(declaration);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture({ role = "admin", historyRole = role, historyTab = "demand", adminUserView = false, routeCompany = "" } = {}) {
  const gate = deferred(), entered = deferred();
  const calls = { loaders: [], loaderArgs: [], restored: [], navigation: [], historyWrites: [], status: [], requests: [] };
  const initialHistory = { app: "lodging-datalab", role: historyRole, tab: historyTab, activeRunId: "prior-run",
    analysisRegionSelection: { regionKey: "prior-region", explicit: true }, adminPanelSection: "overview" };
  const state = { session: null, activeTab: "admin", analysisNavigationSequence: 0, activeRunId: "latest-run", companyMaster: { totalCompanies: 1 } };
  const history = { state: structuredClone(initialHistory) };
  const context = {
    state, loadRunRequestSequence: 0,
    els: { pageSubtitle: { textContent: "" }, companyList: { innerHTML: "" } },
    location: { pathname: role === "b2b" || adminUserView ? "/b2b" : "/admin" },
    window: { history, addEventListener() {} },
    fetchJson: async url => {
      calls.requests.push(url); assert.equal(url, "/api/session");
      return { authenticated: true, username: "bootstrap-test", role };
    },
    adminUserViewRequested: () => adminUserView,
    adminDbCompanyIdFromRoute: () => routeCompany,
    tourismDemandStrengthBackfillIsRunning: () => false,
    restoreB2BActiveSearch: async () => false,
    restoreB2BLatestHistoryRun: async () => false,
    setStatus: text => calls.status.push(text),
    escapeHtml: text => String(text),
    syncAppHistoryState() {
      const next = { app: "lodging-datalab", role: state.session?.role, tab: state.activeTab };
      history.state = next; calls.historyWrites.push({ ...next });
    },
    setActiveTab(tab, options = {}) {
      state.analysisNavigationSequence++;
      state.activeTab = context.roleAllowsTab(tab) ? tab : context.roleTabs()[0];
      if (Object.hasOwn(options, "analysisRegionSelection")) state.analysisRegionSelection = options.analysisRegionSelection;
      calls.navigation.push({ tab: state.activeTab, options });
    },
    loadRun: async runId => { calls.loaders.push(`loadRun:${runId}`); state.activeRunId = runId; }
  };
  const loaders = ["loadRuns", "loadLocationDictionary", "loadTrafficState", "loadLocationCardRequests", "loadLocationScoreOverrides",
    "loadB2BMemberAdminOverview", "loadAccountDeleteAdminOverview", "loadSecurityHardeningOverview", "loadTourismDataStatus",
    "loadSpecialDaysStatus", "loadTourismForecastStatus", "loadKosisStatus", "loadCompanyMasterSummary", "loadMemberSearchHistory", "loadB2BInterestLodgesFromServer"];
  const gatedLoader = role === "admin" && !adminUserView ? "loadRuns" : "loadMemberSearchHistory";
  for (const name of loaders) context[name] = async (...args) => {
    calls.loaders.push(name);
    calls.loaderArgs.push({ name, args });
    if (name === gatedLoader) { entered.resolve(); await gate.promise; }
  };
  for (const name of ["initializeThemeMode", "ensureCrawlControls", "registerPwaServiceWorker", "bindPwaLifecycleEvents", "applyRoleUi",
    "syncCollectionModeInputs", "bindEvents", "setDefaultDates", "renderAdminConsoleDashboard", "renderDemand",
    "startTourismDemandStrengthBackfillPolling", "handleAdminDbCompanyHash", "renderB2BEmptyPanels", "renderB2BSearchPanel",
    "restoreAdminCrawlRequests", "pollCrawlStatusUntilIdle", "syncAdminCrawlSubmitAvailability", "openAdminCrawlResult", "releaseAppBoot"]) context[name] = () => {};
  vm.createContext(context);
  const api = vm.runInContext(`${declarations.join("\n")}\n({ ${functions.join(", ")} })`, context);
  const restore = api.restoreAppHistoryState;
  context.restoreAppHistoryState = async value => { calls.restored.push(structuredClone(value)); return restore(value); };
  return { state, calls, context, api, gate, entered, initialHistory };
}

test("late initial history cannot replace a user's monthly report navigation or selected period", async () => {
  const f = fixture({ historyTab: "admin" });
  const pending = f.api.init(); await f.entered.promise;
  assert.equal(f.state.session.role, "admin");
  assert.equal(f.calls.loaderArgs.find(call => call.name === "loadRuns").args[1]?.bootstrap, true);
  const selection = { type: "region", targetId: "kr_gyeongnam_sancheong", month: "2026-10", cutoffDate: "2026-10-16" };
  f.context.setActiveTab("monthlyReports");
  f.state.monthlyReportSelection = selection;
  f.state.analysisRegionSelection = { regionKey: selection.targetId, explicit: true };
  f.gate.resolve(); await pending;
  assert.equal(f.state.activeTab, "monthlyReports");
  assert.equal(f.state.monthlyReportSelection, selection);
  assert.equal(f.state.analysisRegionSelection.regionKey, selection.targetId);
  assert.deepEqual(f.calls.restored, [], "bootstrap history is stale once the user navigates");
  assert.ok(!f.calls.loaders.includes("loadRun:prior-run"), "old history must not trigger its unrelated run fetch");
  assert.equal(f.calls.historyWrites.at(-1).tab, "monthlyReports");
  assert.deepEqual(f.calls.status, []);
});

test("unchanged startup still restores the valid saved view, region and run", async () => {
  const f = fixture();
  const pending = f.api.init(); await f.entered.promise;
  f.gate.resolve(); await pending;
  assert.equal(f.calls.restored.length, 1);
  assert.equal(f.state.activeTab, "demand");
  assert.equal(f.state.analysisRegionSelection.regionKey, "prior-region");
  assert.equal(f.state.activeRunId, "prior-run");
  assert.ok(f.calls.loaders.includes("loadRun:prior-run"));
  assert.equal(f.calls.navigation.at(-1).options.fromHistory, true);
});

test("navigation away and back still invalidates initial history even if the final tab has the same name", async () => {
  const f = fixture({ historyTab: "admin" });
  const pending = f.api.init(); await f.entered.promise;
  f.context.setActiveTab("monthlyReports");
  f.context.setActiveTab("admin");
  f.state.adminPanelSection = "database";
  f.gate.resolve(); await pending;
  assert.equal(f.state.activeTab, "admin");
  assert.equal(f.state.adminPanelSection, "database");
  assert.deepEqual(f.calls.restored, [], "checking only final tab equality would lose a later user choice");
});

test("a saved administrator view never grants a B2B session administrator bootstrap or report access", async () => {
  for (const historyRole of ["admin", "b2b"]) {
    const f = fixture({ role: "b2b", historyRole, historyTab: "monthlyReports" });
    const pending = f.api.init(); await f.entered.promise;
    f.gate.resolve(); await pending;
    assert.equal(f.state.session.role, "b2b");
    assert.equal(f.state.activeTab, "report");
    assert.ok(!f.calls.loaders.includes("loadRuns"));
    assert.ok(!f.calls.loaders.includes("loadCompanyMasterSummary"));
    assert.ok(!f.calls.loaders.includes("loadB2BMemberAdminOverview"));
    assert.ok(!f.calls.loaders.includes("loadRun:prior-run"));
    assert.ok(f.calls.navigation.every(call => call.tab !== "monthlyReports"));
    assert.deepEqual(f.calls.status, []);
  }
});

test("an explicit company route retains precedence over initial view restoration", async () => {
  const f = fixture({ routeCompany: "cmp_place_test" });
  const pending = f.api.init(); await f.entered.promise;
  f.gate.resolve(); await pending;
  assert.deepEqual(f.calls.restored, []);
  assert.ok(!f.calls.loaders.includes("loadRun:prior-run"));
});

test("administrator customer-view mode keeps the B2B bootstrap and rejects saved administrator tabs", async () => {
  const f = fixture({ role: "admin", adminUserView: true, historyTab: "monthlyReports" });
  const pending = f.api.init(); await f.entered.promise;
  f.gate.resolve(); await pending;
  assert.equal(f.api.isAdminRole(), false);
  assert.equal(f.state.activeTab, "report");
  assert.ok(!f.calls.loaders.includes("loadRuns"));
  assert.ok(!f.calls.loaders.includes("loadCompanyMasterSummary"));
  assert.ok(!f.calls.loaders.includes("loadRun:prior-run"));
  assert.ok(f.calls.navigation.every(call => call.tab !== "monthlyReports"));
});

test("bootstrap run loading skips only duplicate account reads while normal selection still refreshes them", async () => {
  const calls = [], requests = [];
  const state = { session: { role: "admin" }, runs: [], activeTab: "monthlyReports", activeRunId: null };
  const context = { state, loadRunRequestSequence: 0, els: { runSelect: { innerHTML: "", value: "" } },
    isAdminRole: () => state.session.role === "admin", setStatus() {}, escapeHtml: value => String(value),
    fetchJson: async url => {
      requests.push(url);
      return url === "/api/runs" ? { runs: [{ id: "latest", label: "최근 수집" }] } : { run: { id: "latest" } };
    },
    loadHistoryOps: async () => { calls.push("history"); },
    loadCompanyMasterSummary: async () => { calls.push("summary"); },
    loadB2BMemberAdminOverview: async () => { calls.push("members"); },
    loadAccountDeleteAdminOverview: async () => { calls.push("account-delete"); },
    loadSecurityHardeningOverview: async () => { calls.push("security"); },
    reconcileAnalysisRegionSelection() {}, renderB2BSearchPanel() {}, renderAll() { calls.push("render"); },
    adminDbCompanyIdFromRoute: () => "", handleAdminDbCompanyHash() {}, renderB2BEmptyPanels() {}
  };
  vm.createContext(context);
  const api = vm.runInContext(`${functionDeclaration("loadRuns")}\n${functionDeclaration("loadRun")}\n({loadRuns,loadRun})`, context);
  await api.loadRuns(true, { bootstrap: true });
  assert.deepEqual(calls, ["history", "summary", "render"]);
  assert.deepEqual(requests, ["/api/runs", "/api/runs/latest"]);
  assert.equal(state.data.run.id, "latest", "skipping duplicate account reads must not skip the saved result itself");
  calls.length = 0; requests.length = 0;
  await api.loadRuns(true);
  assert.deepEqual(calls, ["history", "summary", "members", "account-delete", "security", "render"]);
  assert.deepEqual(requests, ["/api/runs", "/api/runs/latest"]);
  calls.length = 0; requests.length = 0;
  state.session.role = "b2b";
  await api.loadRuns(true, { bootstrap: true });
  assert.deepEqual(requests, [], "bootstrap flag cannot grant an administrator-only run request");
  assert.deepEqual(calls, []);
  assert.equal(state.data, null);
});

test("late bootstrap state defers hidden dashboards and flushes the newest data once on leaving reports", () => {
  const state = { session: { role: "admin" }, activeTab: "monthlyReports", analysisNavigationSequence: 1,
    adminPanelSection: "overview", adminMobileSection: "summary", data: { run: { id: "new-result" } },
    companyMaster: { totalCompanies: 9 } };
  const calls = [], renderedMasters = [];
  const context = { state, els: {},
    window: { MonthlyReports: { show() { calls.push("monthly"); } }, scrollTo() {} },
    document: { getElementById: () => ({}) },
    isAdminRole: () => state.session.role === "admin", roleAllowsTab: () => true, firstRoleTab: () => "admin",
    REGION_ANALYSIS_TABS: new Set(["dictionary", "map", "demand", "regionCompare", "regionSources"]),
    ADMIN_COMPACT_SECTIONS: { summary: { anchor: "" } },
    adminMobileSectionForTab: () => "summary", adminConsoleMasterSource: () => state.companyMaster,
    renderHeader: () => calls.push("header"),
    renderAdminDatabaseDashboard: master => renderedMasters.push(master)
  };
  const stubs = ["reconcileAnalysisRegionSelection", "applyRoleUi", "renderRegionAnalysisShell", "renderIndustryHome", "renderRegionHome",
    "renderB2BSearchPanel", "renderB2BAccountPanel", "renderRunResultApplySummary", "renderCollectionArchive", "renderPlaceRankReplayNotice",
    "renderB2BEmptyPanels", "renderLocationDictionary", "renderDemand", "renderMap", "renderRegionComparison", "renderRegionSources",
    "renderSummary", "renderNotice", "renderReport", "renderCompanies", "renderTargets", "renderDecisionQueue", "renderHistoryOps",
    "renderCompanyMasterPanel", "renderDownloads", "syncYeogiManualInterface", "renderAdminMemberRequestDashboard", "renderAdminRegionAnalysisDashboard",
    "renderAdminIntegrationRegistry", "renderSpecialDaysAdminCard", "renderKosisAdminCard", "renderTourismForecastAdminCard", "renderAdminSecurityDashboard",
    "setAnalysisRegion", "applyAnalysisRegionToDictionary", "syncAppHistoryState", "closeDrawer"];
  for (const name of stubs) context[name] = () => calls.push(name);
  vm.createContext(context);
  const api = vm.runInContext(["renderAll", "renderAdminConsoleDashboard", "setActiveTab"].map(functionDeclaration).join("\n")
    + "\n({renderAll,renderAdminConsoleDashboard,setActiveTab})", context);
  api.renderAll(); api.renderAdminConsoleDashboard();
  assert.equal(state.adminViewsDeferred, true);
  assert.deepEqual(calls, ["header"], "hidden dashboards must not be rebuilt while monthly report data is displayed");
  assert.deepEqual(renderedMasters, []);
  const latestMaster = { totalCompanies: 14, revision: "arrived-after-report" };
  state.companyMaster = latestMaster;
  state.data = { run: { id: "latest-late-result" } };
  api.renderAll();
  assert.equal(state.data.run.id, "latest-late-result", "render deferral preserves received source state");
  calls.length = 0;
  api.setActiveTab("admin");
  assert.equal(state.activeTab, "admin");
  assert.equal(state.adminViewsDeferred, false);
  assert.equal(renderedMasters.length, 1);
  assert.equal(renderedMasters[0], latestMaster, "leaving reports uses the latest state, not the first deferred response");
  assert.ok(calls.includes("renderSummary"));
  assert.ok(calls.includes("renderCompanies"));
  api.setActiveTab("admin");
  assert.equal(renderedMasters.length, 1, "the deferred full refresh is consumed only once");
});
