"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the real navigation and rendering boundary with deliberately
// mismatched region/run fixtures. Old run metrics must never enter the page.
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const names = [
  "activeKeyword", "locationProfileKeywordKey", "locationProfileCandidateKeyword", "locationProfileIsExactKeyword",
  "dictionaryDemandContext", "demandRegionContextMatchesRun", "renderDemandRegionPending", "openDictionaryDemand",
  "renderDemand", "setActiveTab", "syncAppHistoryState"
];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `Missing ${name}`);
  return declaration;
}).join("\n");

function fixture() {
  const state = {
    activeTab: "dictionary",
    session: { role: "admin" },
    selectedLocationCard: { regionKey: "kr_gyeongnam_sancheong", searchKeyword: "산청 글램핑" },
    dictionaryPendingRegion: null,
    demandRegionContext: null,
    data: { run: { keyword: "포천글램핑" } }
  };
  const els = { demandDashboard: { innerHTML: "" }, demandState: { textContent: "" } };
  const history = {
    state: null,
    replaceState(value) { this.state = value; },
    pushState(value) { this.state = value; }
  };
  let aggregateReads = 0;
  const context = vm.createContext({
    state, els,
    document: { querySelectorAll: () => [] },
    window: { history, location: { href: "http://localhost/admin" } },
    isAdminRole: () => false,
    roleAllowsTab: () => true,
    firstRoleTab: () => "report",
    applyRoleUi: () => {}, syncPrimaryNavButtons: () => {}, syncB2BRegionSecondaryNav: () => {},
    renderHeader: () => {}, closeDrawer: () => {}, renderB2BEmptyPanels: () => {}, renderLocationDictionary: () => {},
    administrativeRegionForLocationCard: () => ({ sido: "경남", sigungu: "산청군" }),
    administrativeRegionEntries: () => [
      { regionKey: "kr_gyeongnam_sancheong", sido: "경남", sigungu: "산청군" },
      { regionKey: "kr_gangwon_goseong", sido: "강원", sigungu: "고성군" },
      { regionKey: "kr_gyeongnam_goseong", sido: "경남", sigungu: "고성군" }
    ],
    locationProfileAlias: (card, region) => region,
    locationProfileSubjectForRegion: (region) => ({ regionKey: region.regionKey, searchKeyword: "" }),
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    demandTrafficAggregate: () => { aggregateReads++; return { totalSearchVolume: 99999 }; },
    finiteNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    demandMobileShare: () => NaN, demandTrendSource: () => ({}), demandRegionRows: () => [],
    tourismVisitorSource: () => null, tourismVisitorPrimaryRegion: () => null,
    dateRangeLabel: () => "저장된 기간", productModeLabel: () => "숙박",
    renderB2BDemandPlaybook: () => "", renderDemandStructure: () => "[stored-demand-structure]",
    renderHistoryLab: () => "[stored-sales-history]", tourismVisitorReasonLabel: () => "자료 대기",
    tourismVisitorMonthLabel: () => "", fmtNumber: String, fmtRate: String, fmtSearchRate: String,
    demandTrendLabel: () => "추세 대기", renderTourismVisitorHistory: () => "[stored-visitor-history]",
    renderTourismDemandStrengthHistory: () => "", demandTrendChart: () => "", demandInterpretation: () => [],
    renderDemandTrendInsightCards: () => "", demandTrendActionText: () => "",
    tourismVisitorSourceNote: () => "", demandCompanySample: () => "[stored-company-sample]"
  });
  const api = vm.runInContext(`${declarations}\n({ ${names.join(", ")} })`, context);
  return { state, els, history, api, aggregateReads: () => aggregateReads };
}

const f = fixture();
f.api.openDictionaryDemand();
assert.equal(f.state.activeTab, "demand");
assert.equal(f.state.demandRegionContext.regionKey, "kr_gyeongnam_sancheong");
assert.match(f.els.demandDashboard.innerHTML, /경남 산청군/);
assert.match(f.els.demandDashboard.innerHTML, /현재 수집자료: 포천글램핑/);
assert.match(f.els.demandDashboard.innerHTML, /필요한 키워드: 산청 글램핑/);
assert.doesNotMatch(f.els.demandDashboard.innerHTML, /99999|stored-demand-structure|stored-sales-history|stored-visitor-history|stored-company-sample/);
assert.equal(f.aggregateReads(), 0, "Mismatched run metrics are not even read");
const regionalHistoryEntry = f.history.state;
assert.equal(regionalHistoryEntry.demandRegionContext.regionKey, "kr_gyeongnam_sancheong");

f.api.setActiveTab("demand");
assert.equal(f.state.demandRegionContext, null, "The general demand menu retains its collection-based behavior");
assert.match(f.els.demandDashboard.innerHTML, /포천글램핑/);
assert.match(f.els.demandDashboard.innerHTML, /99999|stored-demand-structure/);
assert.equal(f.aggregateReads(), 1);

f.api.setActiveTab("demand", { fromHistory: true, demandRegionContext: regionalHistoryEntry.demandRegionContext });
assert.equal(f.aggregateReads(), 1, "Back navigation restores the region guard");
assert.doesNotMatch(f.els.demandDashboard.innerHTML, /stored-sales-history/);

f.state.data = { run: { keyword: "산청글램핑" } };
f.api.renderDemand();
assert.match(f.els.demandDashboard.innerHTML, /stored-demand-structure/);
assert.equal(f.aggregateReads(), 2, "A whitespace-normalized exact keyword match can use its own run");

f.state.data = { run: { keyword: "경남글램핑" } };
f.api.renderDemand();
assert.equal(f.aggregateReads(), 2, "Province-wide aggregates cannot stand in for a selected county");
assert.doesNotMatch(f.els.demandDashboard.innerHTML, /stored-company-sample/);

f.state.demandRegionContext = {
  regionKey: "kr_gyeongnam_goseong", label: "경남 고성군", keyword: "고성글램핑", requiresRegionEvidence: true
};
f.state.data = { run: { keyword: "고성글램핑" }, tourismVisitorHistory: { regions: [{ regionKey: "kr_gangwon_goseong" }] } };
f.api.renderDemand();
assert.equal(f.aggregateReads(), 2, "An identical keyword cannot override a conflicting official region key");
assert.match(f.els.demandDashboard.innerHTML, /지역코드까지 일치/);
f.state.data.tourismVisitorHistory.regions = [];
f.api.renderDemand();
assert.equal(f.aggregateReads(), 2, "Ambiguous place names without region evidence stay pending");
f.state.data.tourismVisitorHistory.regions = [{ regionKey: "kr_gyeongnam_goseong" }];
f.api.renderDemand();
assert.equal(f.aggregateReads(), 3, "Matching official region evidence disambiguates the place name");
f.state.data.tourismVisitorHistory.regions.push({ regionKey: "kr_gangwon_goseong" });
f.api.renderDemand();
assert.equal(f.aggregateReads(), 3, "A mixed-region run cannot represent only one county");

f.state.selectedLocationCard = null;
f.state.dictionaryPendingRegion = { regionKey: "kr_gangwon_goseong", sido: "강원", sigungu: "고성군" };
f.api.openDictionaryDemand();
assert.match(f.els.demandDashboard.innerHTML, /강원 고성군/);
assert.equal(f.state.demandRegionContext.requiresRegionEvidence, true, "Duplicate county names are detected from the administrative master");
assert.equal(f.aggregateReads(), 3, "A region without an explicitly linked keyword never uses stale data");

f.state.dictionaryPendingRegion = null;
f.api.openDictionaryDemand();
assert.match(f.els.demandDashboard.innerHTML, /지역을 먼저 선택/);
assert.equal(f.aggregateReads(), 3);

f.state.data = null;
f.state.selectedLocationCard = { regionKey: "kr_gyeongnam_sancheong", searchKeyword: "산청글램핑" };
f.api.openDictionaryDemand();
assert.match(f.els.demandDashboard.innerHTML, /수집결과 없음/);
f.api.setActiveTab("demand");
assert.equal(f.state.demandRegionContext, null);
assert.match(f.els.demandDashboard.innerHTML, /수집결과를 선택하면/);
assert.doesNotMatch(f.els.demandDashboard.innerHTML, /경남 산청군/);

console.log("Dictionary demand context: mismatched, exact, broad, unlinked, empty, direct-menu, and history cases passed");
