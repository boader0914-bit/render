"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const constants = ["ROLE_TABS", "TAB_LABELS", "B2B_TAB_LABELS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "REGION_ANALYSIS_TABS"];
const functions = ["roleTabs", "roleAllowsTab", "firstRoleTab", "tabLabel", "adminPanelMobileTarget", "adminPrimarySectionForTab", "adminMobileSectionForTab", "activateAdminPrimaryNav", "activateAdminMobileNav", "setActiveTab", "syncAppHistoryState", "restoreAppHistoryState", "renderRegionAnalysisShell", "adminHeaderView", "renderHeader", "renderAll", "loadRuns", "loadRun", "openAdminHomeRoute"];
const declarations = constants.map((name) => {
  const declaration = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"))?.[0]
    || source.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
}).concat(functions.map((name) => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
})).join("\n");

function fixture(role = "admin") {
  const calls = { industry: 0, region: 0, report: 0, scrollTop: 0, requests: [] };
  const region = { regionKey: "kr_gyeonggi_pocheon", name: "포천시", fullName: "경기도 포천시" };
  const state = {
    session: { role, username: "navigation-fixture" }, activeTab: "admin", adminPanelSection: "overview",
    analysisRegionSelection: { regionKey: region.regionKey, explicit: true }, lastRegionAnalysisTab: "dictionary",
    analysisNavigationSequence: 0, data: { run: { id: "old", keyword: "포천글램핑" } }, activeRunId: "old",
    runs: [{ id: "new", keyword: "산청글램핑" }, { id: "old", keyword: "포천글램핑" }]
  };
  const element = () => ({ hidden: false, textContent: "", innerHTML: "", value: "", classList: { toggle() {} }, setAttribute() {} });
  const els = Object.fromEntries(["regionAnalysisShell", "analysisRegionStatus", "analysisRegionManageButton", "pageTitle", "pageSubtitle", "runSelect", "reportBody", "companyList"].map((key) => [key, element()]));
  const history = { state: null, entries: [], replaceState(value) { this.state = structuredClone(value); }, pushState(value) { this.state = structuredClone(value); this.entries.push(this.state); } };
  const context = {
    state, els, console, APP_BRAND_NAME: "사분 데이터랩", loadRunRequestSequence: 0,
    currentRole: () => state.session.role, isAdminRole: () => state.session.role === "admin",
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    window: { history, location: { href: "http://offline/admin" }, requestAnimationFrame(fn) { fn(); }, scrollTo({ top }) { assert.equal(top, 0); calls.scrollTop++; } },
    fetchJson: async (url) => {
      calls.requests.push(url);
      if (url === "/api/runs") return { runs: state.runs };
      const run = state.runs.find((entry) => entry.id === url.split("/").at(-1));
      assert.ok(run, `Unexpected request: ${url}`);
      return { run };
    },
    fetch() { throw new Error("Navigation must not fetch external data"); },
    selectedAnalysisRegion: () => state.analysisRegionSelection?.regionKey ? region : null,
    analysisRegionLabel: () => region.fullName, analysisRunMatchesRegion: () => false,
    regionMasterUnits: () => [region], administrativeProvinceEntries: () => [],
    setAnalysisRegion(key, options) { state.analysisRegionSelection = { regionKey: key, explicit: options.explicit }; },
    analysisRunCollectedLabel: () => "2026. 9. 20. 14:00", analysisRunPeriodLabel: () => "2026-09-20 ~ 2026-10-20",
    adminHomeBasis: () => "현재 운영 기준", adminConsoleMasterSource: () => ({}),
    activeKeyword: () => "포천글램핑", dateRangeLabel: () => "수집 기간",
    renderIndustryHome() { calls.industry++; }, renderRegionHome() { calls.region++; }, renderReport() { calls.report++; },
    adminDbCompanyIdFromRoute: () => "", handleAdminDbCompanyHash() {},
    escapeHtml: (value) => String(value ?? "")
  };
  for (const name of ["applyAnalysisRegionToDictionary", "applyRoleUi", "syncPrimaryNavButtons", "syncB2BRegionSecondaryNav", "closeDrawer", "renderPlaceRankReplayNotice", "renderB2BEmptyPanels", "renderLocationDictionary", "renderDemand", "renderMap", "renderRegionComparison", "renderRegionSources", "renderDecisionQueue", "renderHistoryOps", "renderCompanyMasterPanel", "renderDownloads", "syncYeogiManualInterface", "setStatus", "reconcileAnalysisRegionSelection", "renderB2BSearchPanel", "renderB2BAccountPanel", "renderRunResultApplySummary", "renderCollectionArchive", "renderAdminConsoleDashboard", "renderSummary", "renderNotice", "renderCompanies", "renderTargets", "setAdminPanelSection", "scrollAdminMobileAnchor", "resetCollectionKeywordForFreshEntry", "clearAdminDbCompanyHash", "loadHistoryOps", "loadCompanyMasterSummary", "loadB2BMemberAdminOverview", "loadAccountDeleteAdminOverview", "loadSecurityHardeningOverview"]) context[name] = () => {};
  vm.createContext(context);
  const api = vm.runInContext(`${declarations}\n({ ${functions.join(", ")}, ADMIN_MOBILE_SECTIONS, ADMIN_COMPACT_SECTIONS, REGION_ANALYSIS_TABS })`, context);
  return { api, state, els, history, calls, context, region };
}

async function main() {
  const f = fixture();
  assert.deepEqual(Array.from(f.api.REGION_ANALYSIS_TABS), ["dictionary", "map", "demand", "regionCompare", "regionSources"]);
  assert.deepEqual(Array.from(f.api.ADMIN_MOBILE_SECTIONS.region.items, (item) => item.label), ["지역 현황", "지역 지도", "수요 전망", "지역 비교", "자료·출처"]);
  assert.equal(f.api.ADMIN_MOBILE_SECTIONS.analysis.items[0].tab, "industryHome", "The industry submenu must not bypass the start screen");
  f.api.activateAdminPrimaryNav("analysis");
  assert.equal(f.state.activeTab, "industryHome");
  assert.equal(f.state.activeRunId, "old", "Opening the start screen keeps old data available without opening it");
  assert.equal(f.els.regionAnalysisShell.hidden, true);
  assert.equal(f.calls.industry, 1);
  assert.equal(f.calls.scrollTop, 1, "Entering a home exposes its selectors even after a long report");
  assert.equal(f.calls.report, 0);
  assert.equal(f.els.pageTitle.textContent, "업종분석");
  assert.doesNotMatch(f.els.pageSubtitle.textContent, /현재 운영 기준|포천글램핑/);
  f.api.activateAdminPrimaryNav("region");
  assert.equal(f.state.activeTab, "regionHome");
  assert.equal(f.els.regionAnalysisShell.hidden, true);
  assert.equal(f.els.pageTitle.textContent, "지역분석");
  assert.equal(f.calls.region, 1);
  for (const tab of f.api.REGION_ANALYSIS_TABS) {
    f.api.setActiveTab(tab);
    assert.equal(f.state.lastRegionAnalysisTab, tab);
    assert.equal(f.els.regionAnalysisShell.hidden, false);
    assert.equal(f.state.analysisRegionSelection.regionKey, f.region.regionKey);
  }
  f.api.setActiveTab("regionHome");
  assert.equal(f.state.lastRegionAnalysisTab, "regionSources");
  const savedHome = structuredClone(f.history.state);
  f.api.setActiveTab("dictionary");
  const scrollBeforeHistory = f.calls.scrollTop;
  await f.api.restoreAppHistoryState(savedHome);
  assert.equal(f.calls.scrollTop, scrollBeforeHistory, "Back/forward retains browser scroll restoration");
  assert.equal(f.state.activeTab, "regionHome");
  assert.equal(f.state.lastRegionAnalysisTab, "regionSources");
  assert.equal(f.state.analysisRegionSelection.regionKey, f.region.regionKey);
  assert.equal(f.els.regionAnalysisShell.hidden, true);
  f.api.activateAdminMobileNav("analysis");
  assert.equal(f.state.activeTab, "industryHome");
  for (const item of f.api.ADMIN_COMPACT_SECTIONS.analysis.items) {
    f.api.activateAdminMobileNav("analysis", item.tab);
    assert.equal(f.state.activeTab, item.tab);
    assert.ok(["industryHome", "regionHome"].includes(item.tab));
  }
  f.api.openAdminHomeRoute("industry");
  assert.equal(f.state.activeTab, "industryHome");
  f.api.openAdminHomeRoute("region");
  assert.equal(f.state.activeTab, "regionHome");

  // Initial/background saved-run loading can update data but never navigates away
  // from the screen the administrator chose while its requests were pending.
  let release;
  const originalFetch = f.context.fetchJson;
  f.context.fetchJson = (url) => url === "/api/runs/new" ? new Promise((resolve) => { release = resolve; }) : originalFetch(url);
  const pending = f.api.loadRuns(true);
  await new Promise(setImmediate);
  assert.equal(typeof release, "function");
  f.api.activateAdminPrimaryNav("analysis");
  const sequence = f.state.analysisNavigationSequence;
  f.api.activateAdminPrimaryNav("analysis");
  assert.ok(f.state.analysisNavigationSequence > sequence, "Re-entering the same home invalidates pending detail navigation");
  release({ run: f.state.runs[0] });
  await pending;
  assert.equal(f.state.activeTab, "industryHome");
  assert.equal(f.state.activeRunId, "new");
  assert.equal(f.els.pageTitle.textContent, "업종분석");
  f.api.setActiveTab("report");
  assert.match(f.els.pageSubtitle.textContent, /자료 수집일 2026\. 9\. 20\. 14:00/);
  assert.match(f.els.pageSubtitle.textContent, /분석 대상 숙박기간 2026-09-20 ~ 2026-10-20/);
  assert.doesNotMatch(f.els.pageSubtitle.textContent, /현재 운영 기준/);

  f.api.setActiveTab("industryHome");
  const beforeEmptyRefresh = f.calls.industry;
  f.state.runs = [];
  await f.api.loadRuns();
  assert.equal(f.state.activeRunId, null, "An empty saved-run list clears the stale run reference");
  assert.equal(f.state.activeTab, "industryHome");
  assert.ok(f.calls.industry > beforeEmptyRefresh, "An empty saved-run response refreshes the start screen");
  f.api.renderAll();
  assert.equal(f.state.activeTab, "industryHome", "No-data render cycles preserve the start screen");

  const b2b = fixture("b2b");
  for (const tab of ["industryHome", "regionHome"]) {
    b2b.api.setActiveTab(tab);
    assert.equal(b2b.state.activeTab, "report");
    assert.equal(b2b.els.regionAnalysisShell.hidden, true);
  }
  assert.equal(b2b.calls.industry + b2b.calls.region, 0, "Member views never render administrative start screens");
  console.log("Analysis start navigation: desktop/mobile homes, five detail menus, prior selection/history, pending run isolation, factual date header and member boundary passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
