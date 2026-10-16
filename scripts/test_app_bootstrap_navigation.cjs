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

function fixture({ role = "admin", historyRole = role, historyTab = "demand", adminUserView = false, routeCompany = "", companyMaster = { totalCompanies: 1 } } = {}) {
  const gate = deferred(), entered = deferred();
  const calls = { loaders: [], loaderArgs: [], restored: [], navigation: [], historyWrites: [], status: [], requests: [] };
  const initialHistory = { app: "lodging-datalab", role: historyRole, tab: historyTab, activeRunId: "prior-run",
    analysisRegionSelection: { regionKey: "prior-region", explicit: true }, adminPanelSection: "overview" };
  const state = { session: null, activeTab: "admin", analysisNavigationSequence: 0, activeRunId: "latest-run", companyMaster };
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
  context.restoreAppHistoryState = async (value, options) => { calls.restored.push(structuredClone(value)); return restore(value, options); };
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
  const state = { session: { role: "admin" }, runs: [], activeTab: "admin", activeRunId: null };
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

function runFixture({ activeTab = "admin", realMetadata = false } = {}) {
  const state = { session: { role: "admin" }, activeTab, analysisNavigationSequence: 0, adminPanelSection: "overview",
    adminMobileSection: "summary", runs: [{ id: "latest" }, { id: "manual" }, { id: "restored" }], activeRunId: "latest",
    data: { run: { id: "previous-good" } }, historyOps: { marker: "previous-history" }, companyMaster: { totalCompanies: 12 },
    adminBootstrapRunPending: null, adminBootstrapSummaryPending: false, adminBootstrapResumeTask: null };
  const requests = [], calls = [], statuses = [], hooks = {};
  const context = { state, loadRunRequestSequence: 0, els: { runSelect: { innerHTML: "", value: "" }, companyList: { innerHTML: "" } },
    window: { MonthlyReports: { show() { calls.push("monthly"); } }, scrollTo() {} },
    document: { getElementById: () => ({ dataset: {} }) },
    isAdminRole: () => state.session.role === "admin", roleAllowsTab: tab => state.session.role === "admin" || ["report", "rank", "map", "demand", "account"].includes(tab),
    firstRoleTab: () => state.session.role === "admin" ? "admin" : "report",
    REGION_ANALYSIS_TABS: new Set(["dictionary", "map", "demand", "regionCompare", "regionSources"]),
    ADMIN_COMPACT_SECTIONS: { summary: { anchor: "" } }, adminMobileSectionForTab: () => "summary",
    adminDbCompanyIdFromRoute: () => "", handleAdminDbCompanyHash() {},
    setStatus: text => statuses.push(text), escapeHtml: value => String(value),
    fetchJson: async url => {
      requests.push(url);
      if (hooks.fetch) return hooks.fetch(url);
      if (url === "/api/runs") return { runs: state.runs };
      if (url === "/api/history/summary") return { marker: "new-history" };
      if (url === "/api/company-master/summary") return { totalCompanies: 18 };
      return { run: { id: decodeURIComponent(url.split("/").at(-1)) } };
    },
    loadHistoryOps: async options => { calls.push("history"); return hooks.history ? hooks.history(options) : true; },
    loadCompanyMasterSummary: async options => { calls.push("summary"); return hooks.summary ? hooks.summary(options) : true; },
    loadRecrawlEtaEstimates: async () => { calls.push("eta"); },
    loadB2BMemberAdminOverview: async () => { calls.push("members"); },
    loadAccountDeleteAdminOverview: async () => { calls.push("account-delete"); },
    loadSecurityHardeningOverview: async () => { calls.push("security"); },
    renderAll: () => { calls.push("render"); }
  };
  for (const name of ["reconcileAnalysisRegionSelection", "renderB2BSearchPanel", "renderB2BEmptyPanels", "applyRoleUi", "renderRegionAnalysisShell",
    "renderHeader", "applyAnalysisRegionToDictionary", "syncAppHistoryState", "closeDrawer", "renderIndustryHome", "renderRegionHome",
    "renderPlaceRankReplayNotice", "renderHistoryOps", "ensureHistoryOpsSelection", "renderReport", "renderDecisionQueue", "renderMap", "renderDemand",
    "renderCompanyMasterPanel", "renderDownloads", "syncYeogiManualInterface", "renderLocationDictionary", "renderRegionComparison", "renderRegionSources", "setAnalysisRegion"]) context[name] = () => {};
  vm.createContext(context);
  const names = ["loadRuns", "loadRun", "resumeAdminBootstrapReads", "setActiveTab", "restoreAppHistoryState"];
  if (realMetadata) names.push("loadHistoryOps", "loadCompanyMasterSummary");
  const api = vm.runInContext(names.map(functionDeclaration).join("\n") + `\n({${names.join(",")}})`, context);
  return { state, requests, calls, statuses, hooks, context, api };
}

test("monthly bootstrap reads only the catalog and resumes saved result metadata after leaving", async () => {
  const f = runFixture({ activeTab: "monthlyReports" });
  await f.api.loadRuns(true, { bootstrap: true });
  assert.deepEqual(f.requests, ["/api/runs"]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.adminBootstrapRunPending, "latest");
  assert.equal(f.state.data.run.id, "previous-good");
  f.api.setActiveTab("admin");
  assert.equal(f.state.adminBootstrapRunPending, null, "pending admission is cleared before the resumed fetch starts");
  await f.state.adminBootstrapResumeTask;
  assert.deepEqual(f.requests, ["/api/runs", "/api/runs/latest"]);
  assert.deepEqual(f.calls.filter(name => ["history", "summary", "members", "account-delete", "security"].includes(name)), ["history", "summary"]);
  assert.equal(f.state.data.run.id, "latest");
  assert.equal(f.state.adminBootstrapResumeTask, null);
});

test("a late startup catalog never reselects or requeues a run after a direct user selection", async () => {
  const f = runFixture({ activeTab: "monthlyReports" }), catalog = deferred(), entered = deferred();
  f.hooks.fetch = async url => {
    if (url === "/api/runs") { entered.resolve(); await catalog.promise; return { runs: [{ id: "latest" }, { id: "manual" }] }; }
    return { run: { id: url.split("/").at(-1) } };
  };
  const startup = f.api.loadRuns(true, { bootstrap: true }); await entered.promise;
  await f.api.loadRun("manual");
  catalog.resolve(); await startup;
  assert.equal(f.state.activeRunId, "manual");
  assert.equal(f.state.data.run.id, "manual");
  assert.equal(f.state.adminBootstrapRunPending, null);
  assert.equal(f.context.els.runSelect.value, "manual");
  assert.deepEqual(f.requests, ["/api/runs", "/api/runs/manual"]);
});

test("entering reports during an already sent detail request defers all later metadata", async () => {
  const f = runFixture(), detail = deferred(), entered = deferred();
  f.hooks.fetch = async url => { entered.resolve(); await detail.promise; return { run: { id: url.split("/").at(-1) } }; };
  const startup = f.api.loadRun("latest", { bootstrap: true }); await entered.promise;
  f.api.setActiveTab("monthlyReports"); detail.resolve(); await startup;
  assert.deepEqual(f.requests, ["/api/runs/latest"]);
  assert.deepEqual(f.calls.filter(name => name !== "monthly"), []);
  assert.equal(f.state.adminBootstrapRunPending, "latest");
  assert.equal(f.state.data.run.id, "latest", "an already received saved result remains available without more startup reads");
});

test("entering reports at either metadata await boundary pauses the remaining bootstrap", async () => {
  for (const held of ["history", "summary"]) {
    const f = runFixture(), metadata = deferred(), entered = deferred();
    f.hooks[held] = async () => { entered.resolve(); await metadata.promise; return true; };
    const startup = f.api.loadRun("latest", { bootstrap: true }); await entered.promise;
    f.api.setActiveTab("monthlyReports"); metadata.resolve(); await startup;
    assert.equal(f.state.adminBootstrapRunPending, "latest");
    assert.equal(f.calls.filter(name => name === "render").length, 0);
    assert.equal(f.calls.filter(name => name === "summary").length, held === "history" ? 0 : 1);
    assert.equal(f.calls.filter(name => ["members", "account-delete", "security"].includes(name)).length, 0);
  }
});

test("a manual selection during an old history await cannot recreate the old pending run or start its summary", async () => {
  const f = runFixture(), history = deferred(), entered = deferred();
  let historyReads = 0;
  f.hooks.history = async () => { if (++historyReads === 1) { entered.resolve(); await history.promise; } return true; };
  const startup = f.api.loadRun("latest", { bootstrap: true }); await entered.promise;
  f.api.setActiveTab("monthlyReports");
  await f.api.loadRun("manual");
  history.resolve(); await startup;
  assert.equal(f.state.data.run.id, "manual");
  assert.equal(f.state.adminBootstrapRunPending, null);
  assert.equal(f.calls.filter(name => name === "summary").length, 1, "only the user's selected run continues to the summary");
});

test("late metadata responses from a cancelled startup cannot overwrite a later manual result", async () => {
  for (const heldPath of ["/api/history/summary", "/api/company-master/summary"]) {
    const f = runFixture({ realMetadata: true }), metadata = deferred(), entered = deferred();
    let held = false;
    f.hooks.fetch = async url => {
      if (url.startsWith("/api/runs/")) return { run: { id: url.split("/").at(-1) } };
      if (url === heldPath && !held) { held = true; entered.resolve(); await metadata.promise; return { marker: "stale-startup", totalCompanies: 99 }; }
      return { marker: "fresh-manual", totalCompanies: 18 };
    };
    const startup = f.api.loadRun("latest", { bootstrap: true }); await entered.promise;
    await f.api.loadRun("manual"); metadata.resolve(); await startup;
    assert.equal(f.state.data.run.id, "manual");
    assert.equal(f.state.historyOps.marker, "fresh-manual");
    assert.equal(f.state.companyMaster.marker, "fresh-manual");
    assert.equal(f.state.adminBootstrapRunPending, null);
  }
});

test("returning to reports while a pending run resumes pauses it again without duplicate resume requests", async () => {
  const f = runFixture({ activeTab: "monthlyReports" }), detail = deferred(), entered = deferred();
  f.state.adminBootstrapRunPending = "latest";
  let detailReads = 0;
  f.hooks.fetch = async url => {
    if (++detailReads === 1) { entered.resolve(); await detail.promise; }
    return { run: { id: url.split("/").at(-1) } };
  };
  f.api.setActiveTab("admin"); const task = f.state.adminBootstrapResumeTask; await entered.promise;
  assert.equal(f.api.resumeAdminBootstrapReads(), task);
  f.api.setActiveTab("monthlyReports"); detail.resolve(); await task;
  assert.equal(f.state.adminBootstrapRunPending, "latest");
  assert.equal(f.calls.filter(name => name === "history").length, 0);
  f.api.setActiveTab("admin"); await f.state.adminBootstrapResumeTask;
  assert.equal(detailReads, 2);
  assert.equal(f.state.adminBootstrapRunPending, null);
  assert.equal(f.calls.filter(name => name === "history").length, 1);
});

test("an empty-run startup defers and separately resumes the missing company summary", async () => {
  const init = fixture({ companyMaster: null });
  const pending = init.api.init(); await init.entered.promise;
  init.context.setActiveTab("monthlyReports"); init.gate.resolve(); await pending;
  assert.equal(init.state.adminBootstrapSummaryPending, true);
  assert.ok(!init.calls.loaders.includes("loadCompanyMasterSummary"));
  const f = runFixture({ activeTab: "monthlyReports", realMetadata: true });
  f.state.companyMaster = null;
  f.state.adminBootstrapSummaryPending = true;
  f.api.setActiveTab("admin"); await f.state.adminBootstrapResumeTask;
  assert.deepEqual(f.requests, ["/api/company-master/summary"]);
  assert.equal(f.state.companyMaster.totalCompanies, 18);
  assert.equal(f.state.adminBootstrapSummaryPending, false);
});

test("history restoration selects its explicit run without resuming the unrelated pending latest run", async () => {
  const f = runFixture({ activeTab: "monthlyReports" });
  f.state.adminBootstrapRunPending = "latest";
  await f.api.restoreAppHistoryState({ tab: "rank", activeRunId: "restored" });
  assert.deepEqual(f.requests, ["/api/runs/restored"]);
  assert.equal(f.state.activeRunId, "restored");
  assert.equal(f.state.adminBootstrapRunPending, null);
});

test("initial history restoration into reports defers its saved run without starting an unrelated detail fetch", async () => {
  const f = runFixture();
  await f.api.restoreAppHistoryState({ tab: "monthlyReports", activeRunId: "restored" }, { bootstrap: true });
  assert.equal(f.state.activeTab, "monthlyReports");
  assert.deepEqual(f.requests, []);
  assert.equal(f.state.adminBootstrapRunPending, "restored");
  assert.equal(f.state.data.run.id, "previous-good");
});

test("bootstrap history and summary failures preserve known saved values and remain visibly incomplete", async () => {
  const f = runFixture({ realMetadata: true });
  const previousHistory = f.state.historyOps, previousMaster = f.state.companyMaster;
  f.hooks.fetch = async url => {
    if (url.startsWith("/api/runs/")) return { run: { id: "latest" } };
    throw new Error("saved metadata unavailable");
  };
  await f.api.loadRun("latest", { bootstrap: true });
  assert.equal(f.state.historyOps, previousHistory);
  assert.equal(f.state.companyMaster, previousMaster);
  assert.match(f.state.adminBootstrapReadError, /확인하지 못했습니다/);
  assert.match(f.statuses.at(-1), /일부 미확인/);
  assert.ok(!f.statuses.includes("준비"));
});

test("resumed detail failure retains known source data and does not automatically retry", async () => {
  const f = runFixture();
  f.state.adminBootstrapRunPending = "latest";
  const previous = f.state.data;
  f.hooks.fetch = async () => { throw new Error("saved result unavailable"); };
  await f.api.resumeAdminBootstrapReads();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.requests, ["/api/runs/latest"]);
  assert.equal(f.state.data, previous);
  assert.equal(f.state.adminBootstrapRunPending, null);
  assert.equal(f.state.adminBootstrapResumeTask, null);
  assert.match(f.state.adminBootstrapReadError, /unavailable/);
  assert.match(f.statuses.at(-1), /확인 실패/);
});

test("a role change cannot resume or publish an administrator startup response", async () => {
  const f = runFixture(), detail = deferred(), entered = deferred();
  f.state.adminBootstrapRunPending = "latest";
  f.hooks.fetch = async () => { entered.resolve(); await detail.promise; return { run: { id: "latest" } }; };
  const previous = f.state.data;
  const pending = f.api.resumeAdminBootstrapReads(); await entered.promise;
  f.state.session.role = "b2b"; detail.resolve(); await pending;
  assert.equal(f.state.data, previous);
  assert.equal(f.calls.filter(name => name === "history").length, 0);
  f.state.adminBootstrapRunPending = "latest";
  await f.api.resumeAdminBootstrapReads();
  assert.equal(f.requests.length, 1);
});
