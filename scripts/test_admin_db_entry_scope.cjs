"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Exercise actual navigation/render entry points without starting app bootstrap,
// issuing API calls, or depending on a captured production response.
const args = process.argv.slice(2);
assert.ok(!args.length || (args.length === 2 && args[0] === "--source"), "Usage: node test_admin_db_entry_scope.cjs [--source <path|->]");
const source = fs.readFileSync(args[1] === "-" ? 0 : args[1] || path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const constantNames = ["ROLE_TABS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "REGION_ANALYSIS_TABS"];
const functionNames = ["isAdminUserViewMode", "currentRole", "isAdminRole", "roleTabs", "roleAllowsTab", "firstRoleTab",
  "adminPanelMobileTarget", "adminSectionAllowsAnchor", "adminAnchorAllowedForState", "adminPrimarySectionForTab", "adminMobileSectionForTab",
  "activateAdminPrimaryNav", "renderAll", "renderAdminConsoleDashboard", "setActiveTab", "setAdminPanelSection", "renderActiveRegionAnalysis"];
for (const name of ["isAdminHomeOverview", "isAdminDatabaseView", "isAdminDatabaseSection"]) {
  if (source.includes(`function ${name}(`)) functionNames.push(name);
}
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `Missing real function ${name}`); return found;
}
const declarations = [
  ...constantNames.map(name => {
    const found = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
      || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
    assert.ok(found, `Missing real constant ${name}`); return found;
  }), ...functionNames.map(declaration)
].join("\n");

const leafRenderers = ["renderAdminMemberRequestDashboard", "renderAdminDatabaseDashboard", "renderAdminRegionAnalysisDashboard",
  "renderAdminIntegrationRegistry", "renderSpecialDaysAdminCard", "renderKosisAdminCard", "renderTourismForecastAdminCard", "renderAdminSecurityDashboard",
  "renderRunResultApplySummary", "renderCollectionArchive", "renderSummary", "renderNotice", "renderReport", "renderCompanies", "renderTargets",
  "renderDecisionQueue", "renderHistoryOps", "renderCompanyMasterPanel", "renderDownloads", "syncYeogiManualInterface", "renderLocationDictionary",
  "renderDemand", "renderMap", "renderRegionComparison", "renderRegionSources", "renderIndustryHome", "renderRegionHome"];
const unrelatedRenderers = leafRenderers.filter(name => name !== "renderAdminDatabaseDashboard");

function element(onWrite = () => {}) {
  let html = "sentinel:old";
  return { hidden: false, value: "", textContent: "", dataset: {}, isConnected: true, getClientRects() { return [{}]; },
    get innerHTML() { return html; }, set innerHTML(value) { html = value; onWrite(value); },
    classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; }, querySelectorAll() { return []; }, scrollIntoView() {} };
}
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

function fixture({ role = "admin", customerView = false, data = true, section = "overview", activeTab = "monthlyReports" } = {}) {
  const state = { session: { authenticated: true, role, username: "db-entry-fixture" }, adminUserViewMode: customerView,
    activeTab, adminPanelSection: section, adminMobileSection: "summary", adminMobileAnchor: "", analysisNavigationSequence: 1,
    adminViewsDeferred: true, activeRunId: "run-old", runs: [{ id: "run-old" }],
    data: data ? { run: { id: "run-old", keyword: "저장 키워드" }, preserved: { missing: null, zero: 0 } } : null,
    companyMaster: { totalCompanies: 16, revision: "old", companies: [] },
    adminBootstrapRunPending: null, adminBootstrapSummaryPending: false, adminBootstrapResumeTask: null };
  const calls = [], dom = {}, homeWrites = [], dbWrites = [], history = [];
  const marker = () => `${state.companyMaster?.revision || "missing"}|${state.data?.run?.id || "no-run"}`;
  const record = name => calls.push({ name, marker: marker(), tab: state.activeTab, section: state.adminPanelSection });
  const els = { adminConsoleDashboard: element(value => homeWrites.push(value)), adminDatabaseDashboard: element(value => dbWrites.push(value)) };
  const context = { state, els, console,
    document: { getElementById: () => element(), querySelectorAll: () => [], querySelector: () => element() },
    window: { requestAnimationFrame: fn => fn(), setTimeout: fn => fn(), scrollTo() {},
      MonthlyReports: { show() { record("monthly"); } }, RegionalAnalysis: { stop() {} }, RegionalOutlook: { stop() {} },
      StayIndustryAnalysis: { pause() {} }, RegionalReportPreparation: { pause() {} }, CompanyIntegrated: {} },
    fetch() { throw new Error("Render-only regression must not call a source API"); },
    fetchJson() { throw new Error("Rendering must not initiate source/API reads"); },
    adminConsoleMasterSource: () => state.companyMaster,
    companyDecisionQueueEntries: () => [], adminHomeTasks: () => [], adminHomeTaskRows: () => "no tasks",
    adminHomeLatestRun: () => state.data?.run || state.runs?.[0] || {}, adminHomeBasis: master => `basis:${master.revision || "missing"}`,
    adminHomeMetricCards: master => `metrics:${master.revision || "missing"}|${state.data?.run?.id || "no-run"}`,
    adminHomeFreshness: master => `freshness:${master.revision || "missing"}`, adminHomeRecentRows: () => marker(),
    fmtNumber: value => String(value), escapeHtml: value => String(value ?? ""),
    renderHeader() { record("header"); }, syncAppHistoryState() { history.push({ tab: state.activeTab, section: state.adminPanelSection }); },
    resumeAdminBootstrapReads() { record("resume"); return Promise.resolve(); }
  };
  for (const name of leafRenderers) context[name] = () => {
    record(name); dom[name] ||= element(); dom[name].innerHTML = marker();
    if (name === "renderAdminDatabaseDashboard") els.adminDatabaseDashboard.innerHTML = marker();
  };
  // Preserve old nesting, so the baseline fails because it really refreshes
  // hidden surfaces and paints DB several times, not because a helper is absent.
  context.renderCompanyMasterPanel = () => {
    record("renderCompanyMasterPanel"); dom.renderCompanyMasterPanel ||= element();
    dom.renderCompanyMasterPanel.innerHTML = marker(); context.renderAdminConsoleDashboard(state.companyMaster);
  };
  for (const name of ["reconcileAnalysisRegionSelection", "applyRoleUi", "renderRegionAnalysisShell", "renderB2BSearchPanel", "renderB2BAccountPanel",
    "renderB2BEmptyPanels", "renderPlaceRankReplayNotice", "applyAnalysisRegionToDictionary", "closeDrawer", "syncCompanyIntegratedPanel",
    "syncAdminSectionPanels", "syncAdminMobileNav", "syncAdminDesktopSecondaryNav", "syncRegionalReportPreparation", "setAnalysisRegion",
    "ensureHistoryOpsSelection", "ensureCrawlControls", "updateCrawlSpeedPreview", "ensureLatestCollectionResult", "resetCollectionKeywordForFreshEntry"]) context[name] = () => record(name);
  context.hideAdminRegionManagement = () => record("hideAdminRegionManagement");
  vm.createContext(context);
  const api = vm.runInContext(`${declarations}\n({${functionNames.join(",")}})`, context);
  function latest(revision = "new", run = "run-new") {
    state.companyMaster = { totalCompanies: 18, revision, companies: [] };
    state.data = { run: { id: run, keyword: "최신 저장 키워드" }, preserved: { missing: null, zero: 0 } };
    state.activeRunId = run; return { master: state.companyMaster, data: state.data };
  }
  const count = name => calls.filter(call => call.name === name).length;
  const assertOnlyDb = () => {
    assert.deepEqual(calls.filter(call => unrelatedRenderers.includes(call.name)).map(call => call.name), [], "DB entry must not rebuild member, settings, report, region or legacy tools");
    assert.equal(homeWrites.length, 0, "DB entry does not rewrite the hidden home summary");
  };
  return { state, calls, dom, els, homeWrites, dbWrites, history, context, api, count, latest, assertOnlyDb };
}

test("the real DB primary menu paints latest saved DB once and retains deferred unrelated views", () => {
  const f = fixture(), saved = f.latest(); f.api.activateAdminPrimaryNav("database");
  assert.equal(f.state.activeTab, "admin"); assert.equal(f.state.adminPanelSection, "database");
  assert.equal(f.count("renderAdminDatabaseDashboard"), 1, "tab and subsection synchronization are one DB navigation");
  assert.equal(f.els.adminDatabaseDashboard.innerHTML, "new|run-new"); f.assertOnlyDb();
  assert.equal(f.state.adminViewsDeferred, true, "a DB-only paint cannot certify hidden report/member/settings DOM as fresh");
  assert.equal(f.state.companyMaster, saved.master); assert.equal(f.state.data, saved.data);
  assert.equal(f.state.data.preserved.missing, null); assert.equal(f.state.data.preserved.zero, 0);
});

test("selecting DB directly inside the admin tab also uses one current DB paint", () => {
  const f = fixture({ activeTab: "admin" }); f.latest("direct", "run-direct");
  f.api.setAdminPanelSection("database");
  assert.equal(f.count("renderAdminDatabaseDashboard"), 1); assert.equal(f.els.adminDatabaseDashboard.innerHTML, "direct|run-direct");
  f.assertOnlyDb(); assert.equal(f.state.adminViewsDeferred, true);
});

test("late saved-state render entry points refresh only the visible DB and never declare other panels current", () => {
  const f = fixture({ section: "database", activeTab: "admin" }); const saved = f.latest("arrived", "run-arrived");
  f.api.renderAll(); f.api.renderAdminConsoleDashboard();
  assert.equal(f.count("renderAdminDatabaseDashboard"), 2, "each actual callback paints current DB once");
  assert.equal(f.els.adminDatabaseDashboard.innerHTML, "arrived|run-arrived"); f.assertOnlyDb();
  assert.equal(f.state.adminViewsDeferred, true); assert.equal(f.state.companyMaster, saved.master); assert.equal(f.state.data, saved.data);
  assert.equal(f.count("resume"), 0);
});

test("DB can show master data without a selected result, retaining zero and unavailable distinctions", () => {
  for (const master of [{ totalCompanies: 0, companies: [], revision: "empty" }, { totalCompanies: 16, error: "saved DB unavailable", revision: "failed" }]) {
    const f = fixture({ data: false }); f.state.companyMaster = master;
    f.api.activateAdminPrimaryNav("database");
    assert.equal(f.count("renderAdminDatabaseDashboard"), 1); f.assertOnlyDb();
    assert.equal(f.state.data, null); assert.equal(f.state.companyMaster, master); assert.equal(f.state.adminViewsDeferred, true);
  }
});

test("DB to home keeps the one-summary transition and avoids a DB rerender", () => {
  const f = fixture(); f.api.activateAdminPrimaryNav("database");
  f.calls.length = 0; f.homeWrites.length = 0; f.dbWrites.length = 0; f.latest("home-after-db", "run-home");
  f.api.activateAdminPrimaryNav("summary");
  assert.equal(f.homeWrites.length, 1); assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:home-after-db\|run-home/);
  assert.equal(f.dbWrites.length, 0); assert.equal(f.count("renderCompanyMasterPanel"), 0); assert.equal(f.state.adminViewsDeferred, true);
});

test("a later non-DB result or region entry receives the latest state rather than stale hidden DOM", () => {
  for (const [tab, renderer] of Object.entries({ report: "renderReport", rank: "renderCompanies", historyOps: "renderHistoryOps",
    dictionary: "renderLocationDictionary", map: "renderMap", demand: "renderDemand", regionSources: "renderRegionSources" })) {
    const f = fixture(); f.api.activateAdminPrimaryNav("database"); f.calls.length = 0; f.latest("after-db", "run-after-db");
    f.api.setActiveTab(tab);
    assert.equal(f.state.activeTab, tab); assert.equal(f.dom[renderer]?.innerHTML, "after-db|run-after-db", tab);
    assert.equal(f.state.adminViewsDeferred, ["dictionary", "regionCompare", "regionSources", "demand"].includes(tab), `${tab} refreshes only its own saved surface when independent of the selected crawl`);
  }
});

test("member, collection and settings sections still consume their pending refresh and retain own side effects", () => {
  for (const [section, renderer] of Object.entries({ members: "renderAdminMemberRequestDashboard", collect: "renderRunResultApplySummary", files: "renderAdminIntegrationRegistry" })) {
    const f = fixture(); f.api.activateAdminPrimaryNav("database"); f.calls.length = 0; f.latest("own-section", "run-own");
    f.api.setAdminPanelSection(section, { freshEntry: section === "collect" });
    assert.equal(f.state.adminPanelSection, section); assert.equal(f.dom[renderer]?.innerHTML, "own-section|run-own", section);
    assert.equal(f.state.adminViewsDeferred, false); assert.ok(f.count("syncAdminSectionPanels") > 0);
    if (section === "collect") for (const name of ["resetCollectionKeywordForFreshEntry", "ensureCrawlControls", "updateCrawlSpeedPreview", "ensureLatestCollectionResult"]) assert.ok(f.count(name) > 0, name);
  }
});

test("late bootstrap data renders only visible DB, while another late response follows the newly active destination", async () => {
  const f = fixture(), gate = deferred(); f.state.adminBootstrapSummaryPending = true;
  let admitted = 0;
  f.context.resumeAdminBootstrapReads = () => {
    if (f.state.adminBootstrapResumeTask) return f.state.adminBootstrapResumeTask;
    admitted++; f.state.adminBootstrapSummaryPending = false;
    return (f.state.adminBootstrapResumeTask = gate.promise.then(() => { f.latest("bootstrap-new", "run-bootstrap"); f.api.renderAll(); }));
  };
  f.api.activateAdminPrimaryNav("database"); const pending = f.state.adminBootstrapResumeTask;
  f.api.activateAdminPrimaryNav("database"); assert.equal(admitted, 1);
  gate.resolve(); await pending;
  assert.equal(f.els.adminDatabaseDashboard.innerHTML, "bootstrap-new|run-bootstrap"); f.assertOnlyDb();
  assert.equal(f.state.adminViewsDeferred, true);
  f.api.activateAdminPrimaryNav("summary"); f.calls.length = 0; f.dbWrites.length = 0;
  f.latest("after-leaving", "run-home-late"); f.api.renderAll();
  assert.match(f.els.adminConsoleDashboard.innerHTML, /metrics:after-leaving\|run-home-late/); assert.equal(f.dbWrites.length, 0);
});

test("a real direct DB-save callback paints DB once without hidden parent summary or legacy tools", () => {
  const f = fixture({ section: "database", activeTab: "admin" }); f.latest("review-saved", "run-review");
  f.els.companyMasterPanel = element(); f.els.companyMasterState = element();
  for (const name of ["companyMasterTools", "companyMasterOpsIntro", "companyMasterRouteSummary", "companyMasterBackfillResult", "companyMasterDiagnosticsPanel", "companyMasterDuplicateOps"]) {
    f.context[name] = () => { assert.fail(`hidden legacy builder ${name} must not run on the DB page`); };
  }
  vm.runInContext(`${declaration("renderCompanyMasterPanel")}\nrenderCompanyMasterPanel();`, f.context);
  assert.equal(f.count("renderAdminDatabaseDashboard"), 1); assert.equal(f.els.adminDatabaseDashboard.innerHTML, "review-saved|run-review");
  assert.equal(f.els.companyMasterPanel.innerHTML, "sentinel:old"); assert.equal(f.els.companyMasterState.textContent, ""); f.assertOnlyDb();
});

function actualDbFixture(mode = "list", options = {}) {
  const f = fixture({ section: "database", activeTab: "admin", ...options }); f.state.adminDbViewMode = mode;
  f.state.adminDbSelectedCompanyId = "cmp-kept";
  const rows = [{ company: { id: "cmp-kept" }, metrics: { revenue: 0, channels: {} } }];
  const filters = { query: "" }; let disposed = 0;
  const c = f.context;
  c.window.CompanyIntegrated.disposeWithin = () => { disposed++; };
  c.adminDbFilterState = master => {
    f.calls.push({ name: "filters", revision: master.revision });
    return { rows, filteredRows: rows, filters, provinceOptions: [], regionOptions: [], categoryOptions: [], statusOptions: [], confidenceOptions: [], sourceOptions: [] };
  };
  c.adminDbGroupedRows = () => []; c.adminDbCompanyIdFromRoute = () => ""; c.adminDbMasterHasRows = () => true;
  c.ensureAdminDbMasterLoadedForRoute = () => assert.fail("saved master exists"); c.fmtWon = value => String(value);
  c.adminDbMetricCard = () => "metric"; c.adminDbSelectedRow = () => rows[0];
  c.captureAdminDbSearchInput = () => null; c.restoreAdminDbSearchInput = () => {};
  c.adminDbCompanyExplorerHtml = () => `company-list:${f.state.companyMaster.revision}`;
  c.adminDbRegionWorkspaceHtml = () => `region-list:${f.state.companyMaster.revision}`;
  c.adminDbSelectedDetailPanel = () => `detail:${f.state.companyMaster.revision}`;
  for (const name of ["adminDbCompanySearchShellHtml", "adminDbUserViewBridgeHtml", "adminDbAuditBoard", "adminDbWorkPanel", "adminDbCollectionPanel", "adminRegionalDatabasePanel"]) c[name] = () => name;
  for (const name of ["bindAdminDbCompanySelectButtons", "applyPendingCompanyEdit"]) c[name] = () => f.calls.push({ name });
  vm.runInContext(["adminDbViewMode", "adminDbIntegratedContextCurrent", "adminDbReplaceBoardHtml", "renderAdminDatabaseDashboard"].map(declaration).join("\n"), c);
  return { ...f, actualRender: () => vm.runInContext("renderAdminDatabaseDashboard();", c), disposed: () => disposed };
}

test("actual company list and review renderers do not build hidden regional analysis", () => {
  for (const mode of ["list", "review"]) {
    const f = actualDbFixture(mode); const saved = f.latest(`fresh-${mode}`, "run-current"); f.actualRender();
    assert.match(f.els.adminDatabaseDashboard.innerHTML, new RegExp(`${mode === "list" ? "company-list" : "detail"}:fresh-${mode}`));
    assert.equal(f.count("renderAdminRegionAnalysisDashboard"), 0, `${mode} is not the region DB`);
    assert.equal(f.disposed(), 1); assert.equal(f.count("bindAdminDbCompanySelectButtons"), 1);
    assert.equal(f.state.adminDbSelectedCompanyId, "cmp-kept"); assert.equal(f.state.companyMaster, saved.master); assert.equal(f.state.data, saved.data);
  }
});

test("the actual primary DB entry mounts its integrated detail once after rendering instead of restarting it", () => {
  const f = actualDbFixture("review"); f.state.activeTab = "monthlyReports"; f.latest("detail-current");
  f.api.activateAdminPrimaryNav("database");
  assert.equal(f.dbWrites.length, 1); assert.equal(f.count("syncCompanyIntegratedPanel"), 1);
  assert.equal(f.count("syncRegionalReportPreparation"), 0);
  assert.equal(f.count("hideAdminRegionManagement"), 1); f.assertOnlyDb();
});

test("one real legacy flush after DB entry stays clean through later ordinary tab navigation", () => {
  // The actual DB renderer is installed in this fixture too. A hidden call
  // through the real admin-console child path would mark the global flag dirty
  // again, even though an ordinary stubbed DB leaf would conceal that bug.
  const f = actualDbFixture("list"); f.state.activeTab = "monthlyReports";
  f.api.activateAdminPrimaryNav("database"); assert.equal(f.state.adminViewsDeferred, true);
  f.latest("after-db-flush", "run-after-db-flush"); f.calls.length = 0; f.dbWrites.length = 0;
  f.api.setActiveTab("rank");
  assert.equal(f.state.activeTab, "rank"); assert.equal(f.state.adminViewsDeferred, false);
  assert.equal(f.count("renderRunResultApplySummary"), 1, "deferred legacy surfaces refresh once on this first real entry");
  assert.equal(f.count("renderSummary"), 1); assert.equal(f.count("filters"), 0); assert.equal(f.dbWrites.length, 0);
  assert.equal(f.dom.renderCompanies?.innerHTML, "after-db-flush|run-after-db-flush");

  f.calls.length = 0; f.api.setActiveTab("report");
  assert.equal(f.state.adminViewsDeferred, false); assert.equal(f.count("renderReport"), 1);
  for (const name of ["renderRunResultApplySummary", "renderSummary", "renderCompanies", "renderAdminMemberRequestDashboard", "filters"]) assert.equal(f.count(name), 0, name);
  assert.equal(f.dbWrites.length, 0);

  f.calls.length = 0; f.api.setActiveTab("demand");
  assert.equal(f.state.adminViewsDeferred, false); assert.equal(f.count("renderDemand"), 1);
  assert.equal(f.count("renderRunResultApplySummary"), 0); assert.equal(f.count("renderSummary"), 0);

  f.calls.length = 0; f.latest("late-db-change", "run-late-db-change"); f.actualRender();
  assert.equal(f.state.adminViewsDeferred, true, "an actual late DB response still marks changed saved state pending");
  assert.equal(f.count("filters"), 0); assert.equal(f.dbWrites.length, 0);
  f.api.setActiveTab("report");
  assert.equal(f.state.adminViewsDeferred, false); assert.equal(f.count("renderRunResultApplySummary"), 1);
  assert.equal(f.dom.renderReport?.innerHTML, "late-db-change|run-late-db-change");
});

test("actual region DB still builds its regional analysis and preserves selected company", () => {
  const f = actualDbFixture("region"); f.latest("region-current"); f.actualRender();
  assert.match(f.els.adminDatabaseDashboard.innerHTML, /region-list:region-current/);
  assert.equal(f.count("renderAdminRegionAnalysisDashboard"), 1); assert.equal(f.state.adminDbSelectedCompanyId, "cmp-kept");
});

test("actual failed DB response remains a failure instead of empty list or fabricated zero", () => {
  const f = actualDbFixture(); const master = { error: "DB detail unavailable", revision: "failed", totalCompanies: 16 };
  f.state.companyMaster = master; f.actualRender();
  assert.match(f.els.adminDatabaseDashboard.innerHTML, /로딩 실패: DB detail unavailable/);
  assert.equal(f.count("filters"), 0); assert.equal(f.state.companyMaster, master); assert.equal(f.homeWrites.length, 0);
});

test("a direct late DB detail response cannot rebuild an inactive DB underneath another view", () => {
  for (const destination of [{ activeTab: "monthlyReports", section: "database" }, { activeTab: "admin", section: "members" }]) {
    const f = actualDbFixture(); f.latest("late-detail", "run-late-detail");
    f.state.activeTab = destination.activeTab; f.state.adminPanelSection = destination.section; f.state.adminViewsDeferred = false;
    f.actualRender();
    assert.equal(f.disposed(), 0); assert.equal(f.count("filters"), 0); assert.equal(f.dbWrites.length, 0);
    assert.equal(f.state.adminViewsDeferred, true, "the saved detail remains pending until the actual DB entry");
    assert.equal(f.state.adminDbSelectedCompanyId, "cmp-kept"); assert.equal(f.homeWrites.length, 0);
  }
});

test("region-management cleanup hides stale regional surfaces and pauses their work without rendering", {
  skip: !source.includes("function hideAdminRegionManagement(")
}, () => {
  const f = fixture({ section: "database", activeTab: "admin" });
  const board = element(), container = element(), slot = element(), overview = { open: false };
  let pauses = 0; const stops = [];
  board.querySelector = selector => selector === ".region-management-overview" ? overview : selector === "[data-regional-analysis-manage]" ? slot : null;
  f.els.adminRegionAnalysisDashboard = board;
  f.context.document.getElementById = id => id === "regionDataManagement" ? container : null;
  f.context.window.RegionalReportPreparation.pause = () => { pauses++; };
  f.context.window.RegionalAnalysis.stop = target => { stops.push(target); };
  f.state.adminRegionOverviewOpen = true; f.state.adminSelectedRegionKey = "kr_gyeongnam_sancheong";
  vm.runInContext(`${declaration("hideAdminRegionManagement")}\nhideAdminRegionManagement();`, f.context);
  assert.equal(board.hidden, true); assert.equal(container.hidden, true); assert.equal(f.state.adminRegionOverviewOpen, false);
  assert.equal(pauses, 1); assert.deepEqual(stops, [slot]); assert.equal(board.innerHTML, "sentinel:old");
  assert.equal(f.state.adminSelectedRegionKey, "kr_gyeongnam_sancheong"); assert.equal(f.count("renderAdminRegionAnalysisDashboard"), 0);
});

test("B2B and administrator customer-view sessions cannot enter or render privileged DB", () => {
  for (const options of [{ role: "b2b" }, { role: "admin", customerView: true }]) {
    const f = fixture({ ...options, activeTab: "report" }); f.state.adminViewsDeferred = false;
    f.api.activateAdminPrimaryNav("database"); f.api.setActiveTab("admin"); f.api.renderAdminConsoleDashboard();
    assert.equal(f.api.isAdminRole(), false); assert.equal(f.state.activeTab, "report");
    assert.equal(f.count("renderAdminDatabaseDashboard"), 0); assert.equal(f.count("renderAdminMemberRequestDashboard"), 0);
    assert.equal(f.homeWrites.length, 0); assert.equal(f.dbWrites.length, 0);
    const direct = actualDbFixture("list", options); direct.actualRender();
    assert.equal(direct.disposed(), 0); assert.equal(direct.count("filters"), 0); assert.equal(direct.dbWrites.length, 0);
  }
});

function installTiming(f) {
  const timingSource = fs.readFileSync(path.join(__dirname, "../web/admin-transition-timing.js"), "utf8");
  let now = 1000, wall = 1700000001000, nextFrame = 0;
  const main = element(), frames = new Map();
  f.context.document.visibilityState = "visible";
  f.context.document.body = { classList: { contains: name => name === "role-admin" } };
  f.context.document.getElementById = id => id === "appMain" ? main : element();
  Object.assign(f.context.window, { document: f.context.document, Date: { now: () => wall },
    performance: { now: () => now, timeOrigin: wall - now },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    requestAnimationFrame: callback => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id)
  });
  vm.runInContext(timingSource, f.context);
  vm.runInContext(["beginAdminScreenTransition", "finishAdminScreenTransition"].map(declaration).join("\n"), f.context);
  return { main, frames, now: () => now,
    advance(ms) { now += ms; wall += ms; },
    frame() {
      now += 16; wall += 16; const batch = [...frames.entries()];
      assert.ok(batch.length, "the actual render must schedule a readiness frame");
      for (const [id, callback] of batch) { if (!frames.has(id)) continue; frames.delete(id); callback(now); }
    } };
}

test("actual home-to-DB navigation connects input timestamp, one mount and display-readiness timing", {
  skip: !source.includes("function beginAdminScreenTransition(")
}, () => {
  const f = actualDbFixture("review"), timing = installTiming(f); f.state.adminPanelSection = "overview";
  f.api.activateAdminPrimaryNav("summary", { inputTimeStamp: timing.now() - 12 });
  assert.equal(timing.main.dataset.appTransitionDestination, "admin:overview");
  assert.equal(timing.main.dataset.appTransitionInputWaitMs, "12");
  timing.frame(); timing.frame(); assert.equal(timing.main.dataset.appTransitionStatus, "ready");
  const homeSequence = timing.main.dataset.appTransitionSeq;
  f.calls.length = 0; f.dbWrites.length = 0;
  f.api.activateAdminPrimaryNav("database", { inputTimeStamp: timing.now() - 9 });
  assert.equal(timing.main.dataset.appTransitionDestination, "admin:database");
  assert.equal(timing.main.dataset.appTransitionInputWaitMs, "9"); assert.equal(timing.main.dataset.appTransitionSource, "primary");
  assert.ok(Number(timing.main.dataset.appTransitionSeq) > Number(homeSequence));
  assert.equal(f.dbWrites.length, 1); assert.equal(f.count("syncCompanyIntegratedPanel"), 1);
  timing.frame(); timing.frame();
  assert.equal(timing.main.dataset.appTransitionStatus, "ready"); assert.equal(timing.main.dataset.appTransitionDisplayMs, "32");
  assert.equal(f.state.adminViewsDeferred, true);
});

test("an actual loading detail keeps its navigation clock until ready and cannot certify a later abandoned view", {
  skip: !source.includes("function beginAdminScreenTransition(")
}, () => {
  const f = actualDbFixture("review"), timing = installTiming(f); f.state.activeTab = "monthlyReports";
  f.state.adminDbCompanyDetailLoading = { "cmp-kept": true };
  f.api.activateAdminPrimaryNav("database", { inputTimeStamp: timing.now() - 6 }); timing.frame(); timing.frame();
  assert.equal(timing.main.dataset.appTransitionStatus, "waiting");
  const sequence = timing.main.dataset.appTransitionSeq, started = timing.main.dataset.appTransitionStartedAt;
  timing.advance(500); f.latest("detail-arrived", "run-detail-arrived"); f.state.adminDbCompanyDetailLoading["cmp-kept"] = false;
  f.actualRender(); timing.frame(); timing.frame();
  assert.equal(timing.main.dataset.appTransitionStatus, "ready"); assert.equal(timing.main.dataset.appTransitionSeq, sequence);
  assert.equal(timing.main.dataset.appTransitionStartedAt, started); assert.equal(timing.main.dataset.appTransitionDisplayMs, "564");
  assert.equal(timing.main.dataset.appTransitionInputWaitMs, "6"); assert.match(f.els.adminDatabaseDashboard.innerHTML, /detail:detail-arrived/);

  f.state.adminDbCompanyDetailLoading["cmp-kept"] = true; f.api.activateAdminPrimaryNav("database"); timing.frame(); timing.frame();
  assert.equal(timing.main.dataset.appTransitionStatus, "waiting");
  f.api.activateAdminPrimaryNav("members");
  assert.equal(timing.main.dataset.appTransitionStatus, "invalidated");
  const priorWrites = f.dbWrites.length;
  f.state.adminDbCompanyDetailLoading["cmp-kept"] = false; f.actualRender();
  assert.equal(f.dbWrites.length, priorWrites); assert.equal(timing.main.dataset.appTransitionStatus, "invalidated");
  assert.equal(timing.main.dataset.appTransitionDisplayMs, undefined); assert.equal(f.state.adminViewsDeferred, true);
});
