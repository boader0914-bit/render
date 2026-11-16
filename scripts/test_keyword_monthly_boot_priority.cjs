"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const declaration = name => {
  const body = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(body, `execute the real ${name} implementation`);
  return body;
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 50; n++) { if (check()) return; await turn(); }
  assert.fail("bounded bootstrap progress did not settle");
}

function fixture(t, { role = "admin", authenticated = true, historyRole = role,
  historyTab = "keywordMonthly", customerView = false, companyRoute = "", beforeRestore = null } = {}) {
  const firstRead = deferred(), batch = deferred(), paint = deferred();
  const calls = { order: [], loaders: [], restored: [], requests: [], shows: [], paints: 0, statuses: [] };
  const savedHistory = { app: "lodging-datalab", role: historyRole, tab: historyTab, activeRunId: "unrelated-prior-run",
    analysisRegionSelection: { regionKey: "saved-region", explicit: true } };
  const state = { activeTab: "report", analysisNavigationSequence: 0, companyMaster: null, activeRunId: "latest-run" };
  const host = { id: "keywordMonthlyDashboard" }, history = { state: savedHistory };
  const context = {
    state, loadRunRequestSequence: 0,
    location: { pathname: customerView || role === "b2b" ? "/b2b" : "/admin" },
    window: { history, addEventListener() {}, KeywordMonthlyAnalysis: {
      configure: async () => {},
      show(element) {
        calls.shows.push(element.id);
        if (!context.isAdminRole() || state.session?.authenticated !== true) return Promise.resolve();
        calls.order.push("keyword-read"); return firstRead.promise;
      }
    } },
    document: { getElementById: id => id === host.id ? host : { dataset: {} } },
    els: { pageSubtitle: { textContent: "" }, companyList: { innerHTML: "" } },
    fetchJson: async url => { calls.requests.push(url); calls.order.push("session"); return { authenticated, role, username: "synthetic-bootstrap" }; },
    adminUserViewRequested: () => customerView,
    adminDbCompanyIdFromRoute: () => companyRoute,
    waitForCompanyMasterPaint: async () => { calls.paints++; calls.order.push("paint"); await paint.promise; },
    setStatus: status => calls.statuses.push(status), escapeHtml: String,
    tourismDemandStrengthBackfillIsRunning: () => false,
    restoreB2BActiveSearch: async () => true,
    restoreB2BLatestHistoryRun: async () => false,
    bindEvents: () => { if (beforeRestore) beforeRestore(context, state); },
    syncAppHistoryState: () => { history.state = { app: "lodging-datalab", role: state.session?.role, tab: state.activeTab }; },
    setActiveTab(tab, options = {}) {
      state.analysisNavigationSequence++; state.activeTab = context.roleAllowsTab(tab) ? tab : "report";
      if (Object.hasOwn(options, "analysisRegionSelection")) state.analysisRegionSelection = options.analysisRegionSelection;
      calls.order.push(`route:${state.activeTab}`);
      return state.activeTab === "keywordMonthly" ? context.window.KeywordMonthlyAnalysis.show(host) : undefined;
    },
    loadRun: async runId => { calls.loaders.push(`loadRun:${runId}`); state.activeRunId = runId; },
    resumeAdminBootstrapReads: async () => {}
  };
  const loaders = ["loadRuns", "loadLocationDictionary", "loadTrafficState", "loadLocationCardRequests", "loadLocationScoreOverrides",
    "loadB2BMemberAdminOverview", "loadAccountDeleteAdminOverview", "loadSecurityHardeningOverview", "loadTourismDataStatus",
    "loadSpecialDaysStatus", "loadTourismForecastStatus", "loadKosisStatus", "loadCompanyMasterSummary", "loadMemberSearchHistory", "loadB2BInterestLodgesFromServer"];
  for (const name of loaders) context[name] = async () => {
    calls.loaders.push(name); calls.order.push(name);
    if (name === "loadRuns" || name === "loadMemberSearchHistory") await batch.promise;
  };
  for (const name of ["initializeThemeMode", "ensureCrawlControls", "registerPwaServiceWorker", "bindPwaLifecycleEvents", "applyRoleUi",
    "syncCollectionModeInputs", "setDefaultDates", "renderAdminConsoleDashboard", "renderDemand", "startTourismDemandStrengthBackfillPolling",
    "renderB2BEmptyPanels", "renderB2BSearchPanel", "restoreAdminCrawlRequests", "pollCrawlStatusUntilIdle", "syncAdminCrawlSubmitAvailability",
    "openAdminCrawlResult", "releaseAppBoot"]) context[name] = () => {};
  context.handleAdminDbCompanyHash = () => false;
  const names = ["init", "loadSession", "isAdminUserViewMode", "currentRole", "isAdminRole", "roleTabs", "roleAllowsTab", "restoreAppHistoryState"];
  const constants = ["ROLE_TABS", "REGION_ANALYSIS_TABS"].map(name => {
    const body = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
      || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
    assert.ok(body, name); return body;
  });
  vm.createContext(context);
  const api = vm.runInContext([...constants, ...names.map(declaration), `({${names.join(",")}})`].join("\n"), context);
  const restore = api.restoreAppHistoryState;
  context.restoreAppHistoryState = async (value, options) => {
    calls.restored.push({ tab: value.tab, priority: options?.waitForPriorityRead === true });
    return restore(value, options);
  };
  t.after(() => { firstRead.resolve(); paint.resolve(); batch.resolve(); });
  return { api, context, state, calls, firstRead, paint, batch, history };
}

test("authenticated keyword reload reads and gives its data a display turn before administrator bootstrap", async t => {
  const f = fixture(t), pending = f.api.init();
  await until(() => f.calls.order.includes("keyword-read"));
  assert.equal(f.state.activeTab, "keywordMonthly");
  assert.equal(f.state.adminBootstrapSummaryPending, true, "a newer company/home route can resume its skipped summary while the keyword read is pending");
  assert.deepEqual(f.calls.requests, ["/api/session"]);
  assert.deepEqual(f.calls.loaders, [], "even the company summary waits for the independent saved analysis");
  assert.deepEqual(f.calls.restored, [{ tab: "keywordMonthly", priority: true }]);
  f.firstRead.resolve(); await until(() => f.calls.paints === 1);
  assert.deepEqual(f.calls.loaders, [], "response parsing in the startup batch cannot precede the saved view's display opportunity");
  f.paint.resolve(); await until(() => f.calls.loaders.includes("loadRuns"));
  assert.equal(f.calls.loaders.includes("loadCompanyMasterSummary"), false);
  assert.equal(f.state.adminBootstrapSummaryPending, true);
  f.batch.resolve(); await pending;
  assert.equal(f.calls.shows.length, 1); assert.equal(f.calls.restored.length, 1);
  assert.equal(f.history.state.tab, "keywordMonthly");
  assert.deepEqual(f.calls.statuses, []);
});

test("a newer navigation before restore prevents both early and late keyword restoration", async t => {
  const f = fixture(t, { beforeRestore: context => context.setActiveTab("monthlyReports") });
  f.paint.resolve(); const pending = f.api.init();
  await until(() => f.calls.loaders.includes("loadRuns"));
  assert.deepEqual(f.calls.shows, []); assert.deepEqual(f.calls.restored, []);
  f.batch.resolve(); await pending;
  assert.equal(f.state.activeTab, "monthlyReports"); assert.deepEqual(f.calls.shows, []);
});

test("navigation during the priority read is never replaced by its initial keyword route", async t => {
  const f = fixture(t), pending = f.api.init(); await until(() => f.calls.order.includes("keyword-read"));
  f.context.setActiveTab("monthlyReports"); f.firstRead.resolve();
  await until(() => f.calls.loaders.includes("loadRuns"));
  assert.equal(f.calls.paints, 0, "a hidden former destination does not delay the current route for paint");
  f.batch.resolve(); await pending;
  assert.equal(f.state.activeTab, "monthlyReports"); assert.equal(f.calls.shows.length, 1); assert.equal(f.calls.restored.length, 1);
});

test("logout, another session, or customer-view conversion while reading cannot admit administrator startup", async t => {
  for (const alter of [f => { f.state.session.authenticated = false; }, f => { f.state.session = { ...f.state.session, username: "another-synthetic-session" }; },
    f => { f.state.adminUserViewMode = true; }, f => { f.state.session.role = "b2b"; }]) {
    const f = fixture(t), pending = f.api.init(); await until(() => f.calls.order.includes("keyword-read"));
    alter(f); f.firstRead.resolve(); await pending;
    assert.deepEqual(f.calls.loaders, []); assert.equal(f.calls.paints, 0); assert.equal(f.calls.restored.length, 1);
  }
});

test("priority restoration requires fresh authentication, the same role, administrator access and no company deep link", async t => {
  for (const options of [{ authenticated: false }, { role: "b2b", historyRole: "admin" }, { customerView: true },
    { historyRole: "b2b" }, { companyRoute: "synthetic-company" }]) {
    const f = fixture(t, options); f.paint.resolve();
    const pending = f.api.init();
    if (options.authenticated === false) await pending;
    else await until(() => f.calls.loaders.includes(options.role === "b2b" || options.customerView ? "loadMemberSearchHistory" : "loadRuns"));
    assert.equal(f.calls.order.includes("keyword-read"), false); assert.equal(f.calls.restored.some(row => row.priority), false);
    f.batch.resolve(); await pending;
    assert.equal(f.calls.order.includes("keyword-read"), false);
  }
});

test("other initial menu bootstraps retain their summary-first and late history order", async t => {
  const f = fixture(t, { historyTab: "demand" }); f.paint.resolve();
  const pending = f.api.init(); await until(() => f.calls.loaders.includes("loadRuns"));
  assert.ok(f.calls.order.indexOf("loadCompanyMasterSummary") < f.calls.order.indexOf("loadRuns"));
  assert.deepEqual(f.calls.restored, []); assert.deepEqual(f.calls.shows, []);
  f.batch.resolve(); await pending;
  assert.deepEqual(f.calls.restored, [{ tab: "demand", priority: false }]); assert.equal(f.state.activeTab, "demand");
});

test("a settled unavailable saved read does not block the ordinary startup indefinitely", async t => {
  const f = fixture(t), pending = f.api.init(); await until(() => f.calls.order.includes("keyword-read"));
  f.firstRead.resolve({ status: "needs_verification" }); f.paint.resolve();
  await until(() => f.calls.loaders.includes("loadRuns")); f.batch.resolve(); await pending;
  assert.equal(f.calls.shows.length, 1); assert.deepEqual(f.calls.statuses, []);
});

test("the actual keyword navigation returns its one read promise without resuming unrelated work", async () => {
  const read = deferred(), host = { id: "keywordMonthlyDashboard" }, calls = [];
  const state = { activeTab: "admin", adminPanelSection: "overview", adminViewsDeferred: true,
    adminBootstrapSummaryPending: true, adminBootstrapRunPending: "unrelated-run" };
  const context = { state, document: { getElementById: id => id === host.id ? host : { dataset: {} } },
    window: { KeywordMonthlyAnalysis: { show: element => { calls.push(element.id); return read.promise; } } }, els: {},
    REGION_ANALYSIS_TABS: new Set(), ADMIN_COMPACT_SECTIONS: {}, isAdminRole: () => true, roleAllowsTab: () => true,
    firstRoleTab: () => "admin", adminMobileSectionForTab: () => "analysis",
    resumeAdminBootstrapReads: () => assert.fail("old crawl/bootstrap cannot precede the saved keyword destination"),
    renderAll: () => assert.fail("hidden full dashboard cannot delay the saved keyword destination") };
  for (const name of ["applyAnalysisRegionToDictionary", "applyRoleUi", "renderRegionAnalysisShell", "renderHeader", "closeDrawer", "syncAppHistoryState"]) context[name] = () => {};
  vm.createContext(context); const navigate = vm.runInContext(`${declaration("setActiveTab")}\nsetActiveTab`, context);
  assert.equal(navigate("keywordMonthly"), read.promise);
  assert.deepEqual(calls, [host.id]); assert.equal(state.adminBootstrapRunPending, "unrelated-run");
  read.resolve(); await read.promise;
});
