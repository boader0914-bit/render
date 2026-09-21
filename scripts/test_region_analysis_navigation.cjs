"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/app.js"), "utf8").replace(/\r\n/g, "\n");
const master = JSON.parse(fs.readFileSync(path.join(root, "web/data/region_master.json"), "utf8"));
const dictionary = JSON.parse(fs.readFileSync(path.join(root, "web/data/location_dictionary.json"), "utf8"));
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const POCHEON = "kr_gyeonggi_pocheon";
const SANCHEONG = "kr_gyeongnam_sancheong";
const names = [
  "regionMasterUnits", "administrativeRegionEntries", "administrativeProvinceEntries", "administrativeRegionForKey",
  "administrativeProvinceForValue", "administrativeProvinceForRegion", "administrativeRegionsForProvince",
  "administrativeRegionForLocationCard", "dictionaryStoredCardForRegion", "dictionaryAliasForCard", "tourismRegionEntries",
  "locationProfileAlias", "locationProfileSubjectForRegion", "locationProfileKeywordKey", "activeKeyword",
  "analysisRegionForKey", "selectedAnalysisRegion", "analysisRegionLabel", "analysisRegionStorageKey", "analysisRunRegion",
  "analysisRunMatchesRegion", "applyAnalysisRegionToDictionary", "setAnalysisRegion", "reconcileAnalysisRegionSelection",
  "renderRegionAnalysisShell", "renderActiveRegionAnalysis", "regionAnalysisEmptyHtml", "analysisMatchingRunButton",
  "dictionaryDemandContext", "demandRegionContextMatchesRun", "renderDemandRegionPending", "openDictionaryDemand",
  "renderDemand", "renderMap", "renderRegionComparison", "setActiveTab", "syncAppHistoryState", "restoreAppHistoryState",
  "selectDictionaryRegion", "selectDictionaryProvince", "loadRun", "loadLocationDictionary", "ensureLocationProfile", "locationProfileEntry",
  "locationProfileRunMatchesRegion", "locationRuntimeScope", "locationRuntimeStats", "locationProfilePlaceEvidence",
  "compactSearchText", "stripLocationBusinessWords", "locationProfileFirstObject", "locationProfilePlaceRowHasDetail",
  "locationProfileObservedAt", "locationProfileCurrentRunObservedAt", "locationProfileCandidateKeyword"
];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `Missing actual function ${name}`);
  return declaration;
}).join("\n");

function element() {
  return { innerHTML: "", textContent: "", value: "", hidden: false, disabled: false,
    classList: { toggle() {} }, setAttribute() {}, querySelectorAll: () => [] };
}

function fixture({ keyword = "포천글램핑", role = "admin", storage = new Map(), withMaster = true } = {}) {
  const calls = { metrics: 0, map: 0, sources: [], dictionary: [], forecast: [], headers: 0, fetch: [] };
  const state = {
    session: { role, username: "offline-fixture" }, activeTab: "dictionary", activeRunId: "run-pocheon",
    data: keyword ? { run: { id: "run-pocheon", keyword }, regions: [] } : null,
    runs: [{ id: "run-pocheon", keyword: "포천글램핑" }, { id: "run-sancheong", keyword: "산청글램핑" }],
    regionMaster: withMaster ? master : null, dictionary, tourismRegionMap: { regions: [] },
    analysisRegionSelection: null, analysisRegionRestored: false, selectedLocationCard: null,
    dictionaryPendingRegion: null, dictionaryProvince: "", locationProfiles: {}, locationProfileLoading: {},
    adminPanelSection: "overview", adminDbViewMode: "list", adminSelectedRegionKey: ""
  };
  const els = Object.fromEntries(["demandDashboard", "demandState", "regionAnalysisShell", "analysisRegionSelect",
    "analysisRegionStatus", "analysisRegionManageButton", "regionCompareDashboard", "regionSourcesDashboard",
    "dictionarySearchInput", "dictionarySearchStatus", "dictionaryResult", "mapCount", "mapLegend", "mapLayerRow",
    "clusterMap", "regionList", "runSelect"].map((name) => [name, element()]));
  const history = { state: null, entries: [], replaceState(value) { this.state = structuredClone(value); },
    pushState(value) { this.state = structuredClone(value); this.entries.push(this.state); } };
  const context = vm.createContext({
    state, els, console, URL, encodeURIComponent,
    REGION_ANALYSIS_TABS: new Set(["dictionary", "map", "demand", "regionCompare", "regionSources"]),
    ANALYSIS_REGION_STORAGE_KEY: "lodging-datalab:analysis-region:v1", loadRunRequestSequence: 0,
    LOCATION_PROFILE_RETRY_INTERVAL_MS: 30000,
    LOCATION_DICTIONARY_URL: "dictionary", REGION_MASTER_URL: "master", TOURISM_REGION_MAP_URL: "tourism-map",
    window: { history, location: { href: "http://offline/admin" }, localStorage: {
      getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value)
    } },
    document: { querySelectorAll: () => [], querySelector: () => null },
    fetch() { throw new Error("No external I/O permitted in navigation tests"); },
    fetchJson: async (url) => {
      calls.fetch.push(url);
      if (url === "dictionary") return dictionary;
      if (url === "master") return master;
      if (url === "tourism-map") return { regions: [] };
      const id = decodeURIComponent(url.split("/").at(-1));
      const run = state.runs.find((entry) => entry.id === id);
      assert.ok(run, `Unexpected request ${url}`);
      return { run, regions: [] };
    },
    isAdminRole: () => state.session.role === "admin",
    roleAllowsTab: (tab) => (state.session.role === "admin"
      ? ["report", "rank", "dictionary", "map", "demand", "regionCompare", "regionSources", "admin"]
      : ["report", "rank", "map", "demand", "account"]).includes(tab),
    firstRoleTab: () => "report", adminMobileSectionForTab: () => "analysis", ADMIN_COMPACT_SECTIONS: {},
    applyRoleUi() {}, syncPrimaryNavButtons() {}, syncB2BRegionSecondaryNav() {}, closeDrawer() {},
    renderHeader() { calls.headers++; }, renderB2BEmptyPanels() {}, renderReport() {}, renderPlaceRankReplayNotice() {},
    renderLocationDictionary() { calls.dictionary.push(state.analysisRegionSelection?.regionKey || ""); },
    renderRegionSources() { calls.sources.push(state.analysisRegionSelection?.regionKey || ""); },
    renderAdminConsoleDashboard() {}, renderB2BSearchPanel() {}, renderCompanyMasterPanel() {}, renderDownloads() {}, syncYeogiManualInterface() {},
    syncTourismForecastToAnalysisRegion(region) { calls.forecast.push(region?.regionKey || ""); },
    renderAll() { context.reconcileAnalysisRegionSelection(); context.renderActiveRegionAnalysis(); },
    loadHistoryOps: async () => {}, loadCompanyMasterSummary: async () => {}, loadB2BMemberAdminOverview: async () => {},
    loadAccountDeleteAdminOverview: async () => {}, loadSecurityHardeningOverview: async () => {},
    adminDbCompanyIdFromRoute: () => "", handleAdminDbCompanyHash() {}, setStatus() {},
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    demandTrafficAggregate: () => { calls.metrics++; return { totalSearchVolume: 99999 }; },
    finiteNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    optionalNumber: (value) => value === undefined || value === null || value === "" ? NaN : Number(value),
    summarizeSales: (items) => ({ sold: items.length, supply: items.length }),
    reportPlatformStats: () => ({ missingYeogi: 0, missingYanolja: 0, missingDdnayo: 0 }), targetEntries: () => [],
    demandMobileShare: () => NaN, demandTrendSource: () => ({}),
    demandRegionRows: () => (state.data?.regions || []).map((region) => ({ region, traffic: region.traffic || {}, primary: "참고" })),
    tourismVisitorSource: () => null, tourismVisitorPrimaryRegion: () => null,
    dateRangeLabel: () => "저장된 기간", productModeLabel: () => "숙박", tourismVisitorTableValue: () => "자료 대기",
    renderB2BDemandPlaybook: () => "", renderDemandStructure: () => "[own-run-demand]", renderHistoryLab: () => "[own-run-sales]",
    tourismVisitorReasonLabel: () => "자료 대기", tourismVisitorMonthLabel: () => "", fmtNumber: String, fmtRate: String,
    fmtSearchRate: String, demandTrendLabel: () => "대기", renderTourismVisitorHistory: () => "[own-run-visitors]",
    renderTourismDemandStrengthHistory: () => "", demandTrendChart: () => "", demandInterpretation: () => [],
    renderDemandTrendInsightCards: () => "", demandTrendActionText: () => "", tourismVisitorSourceNote: () => "[source-note]",
    demandCompanySample: () => "[own-run-company]", demandPriorityLabel: () => "확인",
    renderMapControls() { calls.map++; }, loadLocalMap: async () => null,
    regionBounds: () => ({}), b2bRegionMapModel: () => ({}), regionCoordinate: () => null, companyMapPointRows: () => [],
    renderRegions() {}, regionPrimary: () => "확인", CORE_COLORS: {}, project: () => [0, 0]
  });
  const api = vm.runInContext(`${declarations}\n({ ${names.join(", ")} })`, context);
  return { state, els, history, calls, api, context, storage };
}

async function runTests() {
  const initial = fixture({ keyword: null });
  initial.api.reconcileAnalysisRegionSelection();
  assert.equal(initial.api.selectedAnalysisRegion(), null, "No run means no arbitrary Sancheong default");
  assert.equal(initial.els.analysisRegionSelect.value, "");

  const f = fixture();
  f.api.reconcileAnalysisRegionSelection();
  assert.equal(f.api.selectedAnalysisRegion().regionKey, POCHEON);
  assert.equal(f.state.analysisRegionSelection.explicit, false);
  for (const tab of ["demand", "map", "dictionary", "regionCompare", "regionSources"]) {
    f.api.setActiveTab(tab);
    assert.equal(f.api.selectedAnalysisRegion().regionKey, POCHEON, `${tab} preserves Pocheon`);
    assert.equal(f.els.analysisRegionSelect.value, POCHEON);
    assert.equal(f.history.state.analysisRegionSelection.regionKey, POCHEON);
    assert.equal(f.history.state.tab, tab);
  }
  assert.match(f.els.regionCompareDashboard.innerHTML, /포천시/);
  assert.equal(f.calls.sources.at(-1), POCHEON);
  assert.equal(f.calls.forecast.at(-1), POCHEON);

  f.api.setAnalysisRegion(SANCHEONG);
  const sancheongHistory = structuredClone(f.history.state);
  await f.api.loadRun("run-pocheon");
  assert.equal(f.api.selectedAnalysisRegion().regionKey, SANCHEONG, "Changing run never overwrites explicit region");
  f.api.setActiveTab("demand");
  const beforeMismatch = f.calls.metrics;
  assert.match(f.els.demandDashboard.innerHTML, /산청군/);
  assert.match(f.els.demandDashboard.innerHTML, /data-analysis-open-run="run-sancheong"/);
  assert.doesNotMatch(f.els.demandDashboard.innerHTML, /99999|own-run/);
  f.api.setActiveTab("map");
  assert.match(f.els.regionList.innerHTML, /산청군.*지도 자료 없음/);
  f.api.setActiveTab("regionCompare");
  assert.match(f.els.regionCompareDashboard.innerHTML, /산청군.*비교 자료 없음/);
  assert.equal(f.calls.metrics, beforeMismatch);
  assert.equal(f.api.selectedAnalysisRegion().regionKey, SANCHEONG, "Comparison cannot change the baseline");

  f.api.setActiveTab("demand");
  await f.api.loadRun("run-sancheong");
  assert.match(f.els.demandDashboard.innerHTML, /own-run-demand/);
  f.api.setAnalysisRegion(POCHEON);
  const pocheonHistory = structuredClone(f.history.state);
  await f.api.restoreAppHistoryState(sancheongHistory);
  assert.equal(f.state.activeTab, "regionSources");
  assert.equal(f.api.selectedAnalysisRegion().regionKey, SANCHEONG);
  await f.api.restoreAppHistoryState(pocheonHistory);
  assert.equal(f.state.activeTab, "demand");
  assert.equal(f.api.selectedAnalysisRegion().regionKey, POCHEON);

  f.api.selectDictionaryProvince("경남");
  assert.equal(f.api.selectedAnalysisRegion().level, "broad", "Province choice never selects its first county");
  assert.equal(f.state.selectedLocationCard, null);
  assert.equal(f.state.dictionaryPendingRegion.level, "broad");
  f.api.selectDictionaryRegion(POCHEON);
  assert.equal(f.api.selectedAnalysisRegion().regionKey, POCHEON);
  assert.ok(f.calls.headers > 0, "Changing region updates the header without changing view");

  const reloaded = fixture({ keyword: "산청글램핑", storage: f.storage });
  reloaded.api.reconcileAnalysisRegionSelection();
  assert.equal(reloaded.api.selectedAnalysisRegion().regionKey, POCHEON, "Last explicit choice beats newly selected collection");
  for (const keyword of ["서울근교글램핑", "고성글램핑", "글램핑"]) {
    const ambiguous = fixture({ keyword });
    ambiguous.api.reconcileAnalysisRegionSelection();
    assert.equal(ambiguous.api.selectedAnalysisRegion(), null, `${keyword} is not guessed from a first region/province`);
  }
  const contradictory = fixture();
  contradictory.api.reconcileAnalysisRegionSelection();
  contradictory.state.data.tourismVisitorHistory = { regions: [{ regionKey: SANCHEONG }] };
  assert.equal(contradictory.api.analysisRunMatchesRegion(), false, "Contradictory regional evidence is never relabelled");
  const broad = fixture({ keyword: "경남글램핑" });
  broad.api.reconcileAnalysisRegionSelection();
  broad.state.data.regions = [{ regionKey: SANCHEONG }];
  assert.equal(broad.api.analysisRunMatchesRegion(), true, "A province may contain its own counties");
  broad.api.setAnalysisRegion(SANCHEONG);
  assert.equal(broad.api.analysisRunMatchesRegion(), false, "A province aggregate cannot stand in for one county");

  const member = fixture({ keyword: "서울근교글램핑", role: "b2b", withMaster: false });
  member.api.setActiveTab("demand");
  assert.match(member.els.demandDashboard.innerHTML, /own-run-demand/, "B2B search-area reports retain their existing scope");
  assert.equal(member.els.regionAnalysisShell.hidden, true);
  member.api.setActiveTab("regionCompare");
  assert.equal(member.state.activeTab, "report", "Administrator routes remain restricted");

  const concurrent = fixture({ withMaster: false });
  await concurrent.api.loadRun("run-pocheon");
  await concurrent.api.loadLocationDictionary();
  assert.equal(concurrent.api.selectedAnalysisRegion().regionKey, POCHEON, "Run-before-master boot yields the same selection");
  const reverse = fixture({ keyword: null, withMaster: false });
  await reverse.api.loadLocationDictionary();
  await reverse.api.loadRun("run-pocheon");
  assert.equal(reverse.api.selectedAnalysisRegion().regionKey, POCHEON, "Master-before-run boot yields the same selection");

  const race = fixture();
  race.api.reconcileAnalysisRegionSelection();
  let finishMap;
  race.context.loadLocalMap = () => new Promise((resolve) => { finishMap = resolve; });
  const oldMap = race.api.renderMap();
  race.api.setAnalysisRegion(SANCHEONG, { render: false });
  await race.api.renderMap();
  const newMapMarkup = race.els.clusterMap.innerHTML;
  finishMap({ features: [] });
  await oldMap;
  assert.equal(race.els.clusterMap.innerHTML, newMapMarkup, "A delayed Pocheon map must not overwrite newly selected Sancheong");
  assert.match(newMapMarkup, /산청군/);

  const sourceRace = fixture();
  sourceRace.api.reconcileAnalysisRegionSelection();
  sourceRace.state.activeTab = "regionSources";
  let finishProfile;
  sourceRace.context.fetchJson = () => new Promise((resolve) => { finishProfile = resolve; });
  const profile = sourceRace.api.ensureLocationProfile({ regionKey: POCHEON });
  finishProfile({ region: { regionKey: POCHEON } });
  await profile;
  assert.equal(sourceRace.calls.sources.at(-1), POCHEON, "Loaded source evidence refreshes the active sources view");
  sourceRace.state.locationProfiles = {};
  const oldProfile = sourceRace.api.ensureLocationProfile({ regionKey: POCHEON });
  sourceRace.api.setAnalysisRegion(SANCHEONG, { render: false });
  const rendersBeforeOldResponse = sourceRace.calls.sources.length;
  finishProfile({ region: { regionKey: POCHEON } });
  await oldProfile;
  assert.equal(sourceRace.calls.sources.length, rendersBeforeOldResponse, "A response for the previous region cannot rerender current sources");

  const adminHistory = fixture();
  adminHistory.api.reconcileAnalysisRegionSelection();
  const adminEntries = adminHistory.history.entries.length;
  await adminHistory.api.restoreAppHistoryState({ tab: "admin", adminPanelSection: "database", adminDbViewMode: "region",
    adminSelectedRegionKey: SANCHEONG, analysisRegionSelection: { regionKey: POCHEON, explicit: true, source: "user" } });
  assert.equal(adminHistory.state.adminPanelSection, "database");
  assert.equal(adminHistory.state.adminDbViewMode, "region");
  assert.equal(adminHistory.state.adminSelectedRegionKey, SANCHEONG);
  assert.equal(adminHistory.api.selectedAnalysisRegion().regionKey, POCHEON, "DB working region remains independent of analysis selection");
  assert.equal(adminHistory.history.entries.length, adminEntries, "Back/forward restoration does not push another history entry");

  const duplicateName = fixture();
  duplicateName.api.setAnalysisRegion("kr_admin_4882000000", { render: false });
  const gangwonItem = { name: "강원 고성 표본", address: "강원특별자치도 고성군", region: "고성군", totalRooms: 5 };
  duplicateName.state.data = { run: { id: "run-gangwon", keyword: "고성글램핑", regionKey: "kr_admin_5182000000" },
    availability: { items: [gangwonItem] }, regions: [{ regionKey: "kr_admin_5182000000", region: "고성군", places: [gangwonItem] }] };
  const card = { regionKey: "kr_admin_4882000000", searchKeyword: "고성글램핑" };
  const alias = { sido: "경남", sigungu: "고성군" };
  const rejectedRuntime = duplicateName.api.locationRuntimeStats(card, alias);
  assert.equal(rejectedRuntime.items.length, 0, "Equal county names cannot import another province's inventory into regional overview");
  const injectedRuntime = { items: [gangwonItem], regions: duplicateName.state.data.regions };
  assert.equal(duplicateName.api.locationProfilePlaceEvidence(null, injectedRuntime, card, alias).observed, false,
    "Place evidence independently guards an untrusted/stale runtime source");
  const savedOwnProfile = { naverPlace: { items: [{ name: "경남 고성 저장 표본", region: "고성군" }], collectedAt: "2026-09-01" } };
  const savedPlace = duplicateName.api.locationProfilePlaceEvidence(savedOwnProfile, injectedRuntime, card, alias);
  assert.equal(savedPlace.rows[0].name, "경남 고성 저장 표본", "Own region profile evidence remains available independently of the current collection");
  assert.equal(savedPlace.detailRows.length, 0);
  duplicateName.state.session.role = "b2b";
  assert.equal(duplicateName.api.locationRuntimeScope(card, alias).items.length, 1, "Existing member collection scope is preserved");

  const historyRace = fixture();
  historyRace.api.reconcileAnalysisRegionSelection();
  let finishOldRun;
  historyRace.context.fetchJson = () => new Promise((resolve) => { finishOldRun = resolve; });
  const back = historyRace.api.restoreAppHistoryState({ tab: "demand", activeRunId: "run-sancheong",
    analysisRegionSelection: { regionKey: SANCHEONG, explicit: true, source: "user" } });
  await historyRace.api.restoreAppHistoryState({ tab: "map", activeRunId: "run-pocheon",
    analysisRegionSelection: { regionKey: POCHEON, explicit: true, source: "user" } });
  finishOldRun({ run: { id: "run-sancheong", keyword: "산청글램핑" } });
  await back;
  assert.equal(historyRace.state.activeRunId, "run-pocheon", "Returning to an already loaded run cancels an older history fetch");
  assert.equal(historyRace.state.data.run.keyword, "포천글램핑");
  assert.equal(historyRace.state.activeTab, "map");
  assert.equal(historyRace.api.selectedAnalysisRegion().regionKey, POCHEON);

  for (const tab of ["dictionary", "map", "demand", "regionCompare", "regionSources"]) {
    assert.ok(html.includes(`data-region-analysis-tab="${tab}"`), `Missing mobile route ${tab}`);
  }
  for (const tab of ["regionCompare", "regionSources"]) assert.ok(html.includes(`data-panel="${tab}"`));
  console.log("Regional analysis navigation: shared selection, boot order, persisted preference, mismatch guards, independent views, history, saved-run links and B2B boundaries passed");
}

module.exports = { fixture, runTests, POCHEON, SANCHEONG };
if (require.main === module) runTests().catch((error) => { console.error(error); process.exitCode = 1; });
