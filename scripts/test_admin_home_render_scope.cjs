"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Execute the real navigation and render entry points. Leaf renderers only
// expose which saved state reached a DOM surface; no app bootstrap or I/O runs.
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--source"), "Usage: node test_admin_home_render_scope.cjs [--source <path|->]");
const source = fs.readFileSync(args[1] === "-" ? 0 : args[1] || path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const constants = ["ROLE_TABS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "REGION_ANALYSIS_TABS"];
const names = ["isAdminUserViewMode", "currentRole", "isAdminRole", "roleTabs", "roleAllowsTab", "firstRoleTab",
  "adminPanelMobileTarget", "adminSectionAllowsAnchor", "adminAnchorAllowedForState", "adminPrimarySectionForTab",
  "adminMobileSectionForTab", "activateAdminPrimaryNav", "renderAll", "renderAdminConsoleDashboard", "setActiveTab", "setAdminPanelSection", "adminHomeReadiness", "renderActiveRegionAnalysis"];
// The previous release must fail on hidden DOM work, not on a missing helper.
if (source.includes("function isAdminHomeOverview(")) names.push("isAdminHomeOverview");
const declarations = [
  ...constants.map(name => {
    const declaration = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
      || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
    assert.ok(declaration, `Missing real constant ${name}`); return declaration;
  }),
  ...names.map(name => {
    const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(declaration, `Missing real function ${name}`); return declaration;
  })
].join("\n");

const hiddenRenderers = ["renderAdminMemberRequestDashboard", "renderAdminDatabaseDashboard", "renderAdminRegionAnalysisDashboard",
  "renderAdminIntegrationRegistry", "renderSpecialDaysAdminCard", "renderKosisAdminCard", "renderTourismForecastAdminCard", "renderAdminSecurityDashboard",
  "renderRunResultApplySummary", "renderCollectionArchive", "renderSummary", "renderNotice", "renderReport", "renderCompanies",
  "renderTargets", "renderDecisionQueue", "renderHistoryOps", "renderCompanyMasterPanel", "renderDownloads", "syncYeogiManualInterface",
  "renderLocationDictionary", "renderDemand", "renderMap", "renderRegionComparison", "renderRegionSources", "renderIndustryHome", "renderRegionHome"];

function element(onWrite = () => {}) {
  let html = "sentinel:old";
  return { hidden: false, value: "", textContent: "", dataset: {},
    get innerHTML() { return html; }, set innerHTML(value) { html = value; onWrite(value); },
    classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {} };
}

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ role = "admin", customerView = false, data = true, section = "overview" } = {}) {
  const state = { session: { authenticated: true, role, username: "render-scope-fixture" }, adminUserViewMode: customerView,
    activeTab: "monthlyReports", adminPanelSection: section, adminMobileSection: "summary", adminMobileAnchor: "",
    analysisNavigationSequence: 1, adminViewsDeferred: true, activeRunId: "run-old", runs: [{ id: "run-old" }],
    data: data ? { run: { id: "run-old", keyword: "저장 키워드" }, preserved: { missing: null, zero: 0 } } : null,
    companyMaster: { totalCompanies: 16, revision: "old", companies: [] },
    adminBootstrapRunPending: null, adminBootstrapSummaryPending: false, adminBootstrapResumeTask: null };
  const calls = [], dom = {}, homeWrites = [], history = [];
  const marker = () => `${state.companyMaster?.revision || "missing"}|${state.data?.run?.id || "no-run"}`;
  const record = name => calls.push({ name, marker: marker(), tab: state.activeTab, section: state.adminPanelSection });
  const els = { adminConsoleDashboard: element(value => homeWrites.push(value)) };
  const context = { state, els, console,
    document: { getElementById: () => element(), querySelectorAll: () => [], querySelector: () => element() },
    window: { requestAnimationFrame: fn => fn(), setTimeout: fn => fn(), scrollTo() {},
      MonthlyReports: { show() { record("monthly"); } }, RegionalAnalysis: { stop() {} }, RegionalOutlook: { stop() {} },
      StayIndustryAnalysis: { pause() {} }, RegionalReportPreparation: { pause() {} }, CompanyIntegrated: {} },
    fetch() { throw new Error("Render-only tests must not make external requests"); },
    fetchJson() { throw new Error("Rendering must not initiate source/API reads"); },
    adminConsoleMasterSource: () => state.companyMaster,
    companyDecisionQueueEntries: () => [], adminHomeTasks: () => [], adminHomeTaskRows: () => "no tasks",
    adminHomeLatestRun: () => state.data?.run || state.runs?.[0] || {},
    adminHomeBasis: master => `basis:${master.revision || "missing"}`,
    adminHomeMetricCards: master => `metrics:${master.revision || "missing"}|${state.data?.run?.id || "no-run"}`,
    adminHomeFreshness: master => `freshness:${master.revision || "missing"}`,
    adminHomeRecentRows: () => `recent:${state.data?.run?.id || "no-run"}`,
    fmtNumber: value => String(value), escapeHtml: value => String(value ?? ""),
    renderHeader() { record("header"); },
    syncAppHistoryState() { history.push({ tab: state.activeTab, section: state.adminPanelSection }); },
    resumeAdminBootstrapReads() { record("resume"); return Promise.resolve(); }
  };
  for (const name of hiddenRenderers) context[name] = () => {
    record(name); dom[name] ||= element(); dom[name].innerHTML = marker();
  };
  // Preserve the real company-panel -> admin-console nesting so a hidden
  // company refresh cannot evade the dashboard child-render assertions.
  context.renderCompanyMasterPanel = () => {
    record("renderCompanyMasterPanel"); dom.renderCompanyMasterPanel ||= element();
    dom.renderCompanyMasterPanel.innerHTML = marker(); context.renderAdminConsoleDashboard(state.companyMaster);
  };
  for (const name of ["reconcileAnalysisRegionSelection", "applyRoleUi", "renderRegionAnalysisShell", "renderB2BSearchPanel", "renderB2BAccountPanel",
    "renderB2BEmptyPanels", "renderPlaceRankReplayNotice", "applyAnalysisRegionToDictionary", "closeDrawer", "syncCompanyIntegratedPanel",
    "syncAdminSectionPanels", "syncAdminMobileNav", "syncAdminDesktopSecondaryNav", "syncRegionalReportPreparation", "setAnalysisRegion",
    "ensureHistoryOpsSelection", "ensureCrawlControls", "updateCrawlSpeedPreview", "ensureLatestCollectionResult", "resetCollectionKeywordForFreshEntry"]) {
    context[name] = () => record(name);
  }
  vm.createContext(context);
  const api = vm.runInContext(`${declarations}\n({${names.join(",")}})`, context);
  const count = name => calls.filter(call => call.name === name).length;
  function latest(revision = "new", run = "run-new") {
    state.companyMaster = { totalCompanies: 18, revision, companies: [] };
    state.data = { run: { id: run, keyword: "최신 저장 키워드" }, preserved: { missing: null, zero: 0 } };
    state.activeRunId = run;
    return { master: state.companyMaster, data: state.data };
  }
  function assertNoHidden() {
    assert.deepEqual(calls.filter(call => hiddenRenderers.includes(call.name)).map(call => call.name), [], "home must not rebuild hidden result/DB/API/region surfaces");
  }
  return { state, calls, dom, els, homeWrites, history, context, api, count, latest, assertNoHidden };
}

test("the actual home menu paints the newest home once without consuming the pending hidden refresh", () => {
  const f = fixture(), saved = f.latest();
  f.api.activateAdminPrimaryNav("summary");
  assert.equal(f.state.activeTab, "admin"); assert.equal(f.state.adminPanelSection, "overview");
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:new\|run-new/);
  assert.equal(f.homeWrites.length, 1, "setActiveTab plus setAdminPanelSection is one home navigation");
  f.assertNoHidden();
  assert.equal(f.state.adminViewsDeferred, true, "a home-only paint must not certify hidden panels as current");
  assert.equal(f.state.companyMaster, saved.master); assert.equal(f.state.data, saved.data);
  assert.equal(f.state.data.preserved.missing, null); assert.equal(f.state.data.preserved.zero, 0);
});

test("late render entry points refresh the active home while hidden DOM and source values stay untouched", () => {
  const f = fixture(); f.state.activeTab = "admin";
  const saved = f.latest("late", "run-late");
  f.api.renderAll(); f.api.renderAdminConsoleDashboard();
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:late\|run-late/);
  f.assertNoHidden();
  assert.equal(f.state.adminViewsDeferred, true);
  assert.equal(f.state.data, saved.data); assert.equal(f.state.companyMaster, saved.master);
  assert.equal(f.count("resume"), 0, "rendering itself does not start metadata reads");
});

test("a late company DB save refreshes home without recreating hidden legacy company tools", () => {
  const f = fixture(); f.state.activeTab = "admin"; f.latest("saved-review", "run-review");
  f.els.companyMasterPanel = element(); f.els.companyMasterState = element();
  const declaration = source.match(/^function renderCompanyMasterPanel\([^]*?^}/m)?.[0];
  assert.ok(declaration, "execute the actual late company-save render entry point");
  const legacyBuilders = ["companyMasterTools", "companyMasterOpsIntro", "companyMasterRouteSummary", "companyMasterBackfillResult", "companyMasterDiagnosticsPanel", "companyMasterDuplicateOps"];
  for (const name of legacyBuilders) f.context[name] = () => { f.calls.push({ name }); return "legacy tools"; };
  vm.runInContext(`${declaration}\nrenderCompanyMasterPanel();`, f.context);
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:saved-review\|run-review/);
  assert.equal(f.els.companyMasterPanel.innerHTML, "sentinel:old", "a hidden legacy panel does not receive DOM writes");
  assert.equal(f.els.companyMasterState.textContent, "", "the hidden company status is left for its real entry");
  assert.ok(!f.calls.some(call => legacyBuilders.includes(call.name)));
  f.assertNoHidden(); assert.equal(f.state.adminViewsDeferred, true);
});

test("a late DB detail response updates home without rebuilding or disposing the hidden DB view", () => {
  const f = fixture(); f.state.activeTab = "admin"; const saved = f.latest("detail-arrived", "run-detail");
  f.state.adminDbRouteCompanyId = "cmp-kept"; f.state.adminDbSelectedCompanyId = "cmp-kept"; f.state.adminDbViewMode = "review";
  f.els.adminDatabaseDashboard = element();
  let disposed = 0, filtersBuilt = 0;
  f.context.window.CompanyIntegrated.disposeWithin = () => { disposed++; };
  f.context.adminDbFilterState = () => { filtersBuilt++; assert.fail("a hidden DB response must not rebuild its filters and company list"); };
  const declaration = source.match(/^function renderAdminDatabaseDashboard\([^]*?^}/m)?.[0];
  assert.ok(declaration, "execute the actual DB-detail callback render entry point");
  vm.runInContext(`${declaration}\nrenderAdminDatabaseDashboard();`, f.context);
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:detail-arrived\|run-detail/);
  assert.equal(f.homeWrites.length, 1, "the detail callback can refresh the visible summary once");
  assert.equal(f.els.adminDatabaseDashboard.innerHTML, "sentinel:old");
  assert.equal(disposed, 0); assert.equal(filtersBuilt, 0); f.assertNoHidden();
  assert.equal(f.state.adminDbRouteCompanyId, "cmp-kept"); assert.equal(f.state.adminDbSelectedCompanyId, "cmp-kept");
  assert.equal(f.state.adminDbViewMode, "review"); assert.equal(f.state.companyMaster, saved.master);
  assert.equal(f.state.data, saved.data); assert.equal(f.state.adminViewsDeferred, true);
});

test("selecting home directly inside the admin tab also avoids the global refresh", () => {
  const f = fixture({ section: "database" }); f.state.activeTab = "admin"; f.latest("section-home");
  f.api.setAdminPanelSection("overview");
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:section-home\|run-new/);
  f.assertNoHidden(); assert.equal(f.state.adminViewsDeferred, true);
});

test("a later company DB selection in the same admin tab receives the newest deferred data", () => {
  const f = fixture(); f.latest("home"); f.api.activateAdminPrimaryNav("summary");
  f.calls.length = 0; f.latest("db-new", "run-db-new");
  f.api.setAdminPanelSection("database");
  assert.equal(f.state.activeTab, "admin"); assert.equal(f.state.adminPanelSection, "database");
  assert.equal(f.dom.renderAdminDatabaseDashboard?.innerHTML, "db-new|run-db-new");
  assert.equal(f.state.adminViewsDeferred, true, "DB refreshes itself while unrelated hidden views remain pending");
  assert.equal(f.count("renderAdminDatabaseDashboard"), 1);
  assert.equal(f.count("renderCompanies"), 0);
  assert.equal(f.count("renderAdminMemberRequestDashboard"), 0);
});

test("leaving home for a result or region view never exposes the old hidden surface", () => {
  const destinations = { rank: "renderCompanies", report: "renderReport", historyOps: "renderHistoryOps",
    dictionary: "renderLocationDictionary", map: "renderMap", demand: "renderDemand", regionSources: "renderRegionSources" };
  for (const [tab, renderer] of Object.entries(destinations)) {
    const f = fixture(); f.latest("home"); f.api.activateAdminPrimaryNav("summary"); f.assertNoHidden();
    f.latest("after-home", "run-after-home"); f.calls.length = 0;
    f.api.setActiveTab(tab);
    assert.equal(f.state.activeTab, tab); assert.equal(f.dom[renderer]?.innerHTML, "after-home|run-after-home", tab);
    assert.ok(f.count(renderer) > 0, `${tab} must not reuse the stale hidden DOM`);
  }
});

test("empty and failed saved state stays distinguishable on home without touching other screens", () => {
  for (const error of [null, "saved summary unavailable"]) {
    const f = fixture({ data: false });
    const master = error ? { error, revision: "failed", totalCompanies: 16 } : { revision: "empty", totalCompanies: 0, companies: [] };
    f.state.companyMaster = master; f.state.runs = [];
    f.api.activateAdminPrimaryNav("summary"); f.api.renderAll();
    assert.equal(f.state.data, null); assert.equal(f.state.companyMaster, master);
    assert.match(f.els.adminConsoleDashboard.innerHTML, error ? /saved summary unavailable/ : /metrics:empty\|no-run/);
    f.assertNoHidden(); assert.equal(f.state.adminViewsDeferred, true);
  }
});

test("saved regional entry and late startup updates never rebuild unrelated crawl or DB surfaces", () => {
  const destinations = { dictionary: "renderLocationDictionary", regionCompare: "renderRegionComparison", regionSources: "renderRegionSources", demand: "renderDemand" };
  for (const [tab, activeRenderer] of Object.entries(destinations)) {
    const f = fixture(); f.state.adminBootstrapRunPending = "unrelated-latest-run"; f.state.adminBootstrapSummaryPending = true;
    const saved = f.latest("regional-source", "a-different-region-run");
    f.api.setActiveTab(tab);
    assert.equal(f.count("resume"), 0, `${tab} must not resume unrelated full crawl reads`);
    assert.equal(f.state.adminBootstrapRunPending, "unrelated-latest-run");
    assert.equal(f.state.adminBootstrapSummaryPending, true);
    assert.equal(f.state.adminViewsDeferred, true);
    assert.deepEqual(f.calls.filter(call => hiddenRenderers.includes(call.name)).map(call => call.name), [activeRenderer]);
    assert.equal(f.state.data, saved.data);
    f.calls.length = 0; f.latest("arrived-in-background", "another-unrelated-run");
    f.api.renderAll();
    assert.deepEqual(f.calls.filter(call => hiddenRenderers.includes(call.name)).map(call => call.name), [activeRenderer], "a late startup response renders only the selected regional surface");
    assert.equal(f.count("resume"), 0);
    assert.equal(f.state.adminViewsDeferred, true);
  }
});

test("B2B sessions and administrator customer view cannot use the admin home shortcut", () => {
  for (const options of [{ role: "b2b" }, { role: "admin", customerView: true }]) {
    const f = fixture(options); f.state.activeTab = "report"; f.state.adminViewsDeferred = false;
    f.api.activateAdminPrimaryNav("summary"); f.api.renderAdminConsoleDashboard(); f.api.setActiveTab("admin");
    assert.equal(f.api.isAdminRole(), false); assert.equal(f.state.activeTab, "report");
    assert.equal(f.homeWrites.length, 0);
    assert.equal(f.count("renderAdminDatabaseDashboard"), 0); assert.equal(f.count("renderAdminMemberRequestDashboard"), 0);
    assert.equal(f.count("renderCompanyMasterPanel"), 0); assert.equal(f.count("resume"), 0);
    assert.equal(f.els.adminConsoleDashboard.innerHTML, "sentinel:old");
  }
});

test("home-only rendering preserves pending bootstrap admission and renders late state only where visible", async () => {
  const f = fixture(), gate = deferred(), admitted = [];
  f.state.adminBootstrapRunPending = "pending-run"; f.state.adminBootstrapSummaryPending = true;
  f.context.resumeAdminBootstrapReads = () => {
    if (f.state.adminBootstrapResumeTask) return f.state.adminBootstrapResumeTask;
    admitted.push({ run: f.state.adminBootstrapRunPending, summary: f.state.adminBootstrapSummaryPending });
    f.state.adminBootstrapRunPending = null; f.state.adminBootstrapSummaryPending = false;
    const task = gate.promise.then(() => { f.latest("resumed", "pending-run"); f.api.renderAll(); })
      .finally(() => { f.state.adminBootstrapResumeTask = null; });
    f.state.adminBootstrapResumeTask = task; return task;
  };
  f.api.activateAdminPrimaryNav("summary"); const pending = f.state.adminBootstrapResumeTask;
  f.api.activateAdminPrimaryNav("summary");
  assert.deepEqual(admitted, [{ run: "pending-run", summary: true }]);
  assert.equal(f.state.adminBootstrapResumeTask, pending);
  f.assertNoHidden(); assert.equal(f.state.adminViewsDeferred, true);
  gate.resolve(); await pending;
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:resumed\|pending-run/);
  assert.equal(f.state.adminBootstrapResumeTask, null); f.assertNoHidden();
  f.api.setAdminPanelSection("database");
  assert.equal(f.dom.renderAdminDatabaseDashboard?.innerHTML, "resumed|pending-run");
});

test("non-home section selection retains collection controls, disclosure and integration synchronization", () => {
  for (const section of ["collect", "archive", "members", "files"]) {
    const f = fixture(); f.api.activateAdminPrimaryNav("summary"); f.calls.length = 0;
    f.api.setAdminPanelSection(section, { freshEntry: section === "collect", scroll: true });
    assert.equal(f.state.adminPanelSection, section); assert.equal(f.state.activeTab, "admin");
    assert.ok(f.count("syncAdminSectionPanels") > 0); assert.ok(f.count("syncAdminMobileNav") > 0);
    assert.ok(f.count("syncAdminDesktopSecondaryNav") > 0); assert.ok(f.count("syncRegionalReportPreparation") > 0);
    assert.ok(f.count("syncCompanyIntegratedPanel") > 0);
    if (section === "collect") {
      for (const name of ["resetCollectionKeywordForFreshEntry", "ensureCrawlControls", "updateCrawlSpeedPreview", "ensureLatestCollectionResult"]) assert.ok(f.count(name) > 0, name);
    }
  }
});
