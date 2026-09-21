"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const names = ["adminSelectedRegion", "openAnalysisRegionManagement", "returnToRegionAnalysis"];
const declarations = names.map(name => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
});
const pocheon = { regionKey: "kr_gyeonggi_pocheon", fullName: "경기도 포천시" };
const sancheong = { regionKey: "kr_gyeongnam_sancheong", fullName: "경상남도 산청군" };
function setup(admin = true) {
  const state = { activeTab: "demand", adminSelectedRegionKey: "", adminDbFilters: { query: "남은 업체 검색", province: "old", status: "needs_work" }, analysisRegionKey: pocheon.regionKey };
  const calls = [];
  const context = vm.createContext({
    state, isAdminRole: () => admin, selectedAnalysisRegion: () => pocheon,
    clearAdminDbCompanyHash: () => calls.push("clearCompanyRoute"),
    setActiveTab: tab => { state.activeTab = tab; calls.push(`tab:${tab}`); },
    setAdminPanelSection: panel => { state.adminPanelSection = panel; },
    renderAdminDatabaseDashboard: () => calls.push("renderDB"),
    syncAppHistoryState: () => calls.push("saveHistory"),
    setAnalysisRegion: key => { state.analysisRegionKey = key; calls.push(`region:${key}`); },
    window: { requestAnimationFrame: fn => fn() },
    document: { getElementById: () => ({ scrollIntoView: () => calls.push("scrollManagement") }) }
  });
  const api = vm.runInContext(`${declarations.join("\n")}\n({${names.join(",")}})`, context);
  return { state, calls, api };
}

const fixture = setup();
fixture.api.openAnalysisRegionManagement();
assert.equal(fixture.state.adminSelectedRegionKey, pocheon.regionKey);
assert.equal(fixture.state.adminDbFilters.region, pocheon.regionKey);
assert.equal(fixture.state.adminDbFilters.query, "");
assert.equal(fixture.state.adminDbViewMode, "region");
assert.equal(fixture.state.adminPanelSection, "database");
assert.equal(fixture.state.regionManagementReturnContext.tab, "demand");
assert.equal(fixture.state.regionManagementReturnContext.regionKey, pocheon.regionKey);
assert.equal(fixture.state.analysisRegionKey, pocheon.regionKey, "Opening DB cannot change the analysis region");
assert.equal(fixture.api.adminSelectedRegion({ adminRegionalOperations: { regions: [sancheong] } }), null, "Missing Pocheon management data cannot fall back to Sancheong");
fixture.state.adminSelectedRegionKey = sancheong.regionKey;
fixture.api.returnToRegionAnalysis();
assert.equal(fixture.state.activeTab, "demand");
assert.equal(fixture.state.analysisRegionKey, pocheon.regionKey, "DB work-region changes cannot replace the return region");

for (const tab of ["dictionary", "map", "regionCompare", "regionSources"]) {
  const item = setup();
  item.state.activeTab = tab;
  item.api.openAnalysisRegionManagement();
  item.api.returnToRegionAnalysis();
  assert.equal(item.state.activeTab, tab, "Every analysis view can return from DB");
}
const b2b = setup(false);
b2b.api.openAnalysisRegionManagement();
b2b.api.returnToRegionAnalysis();
assert.equal(b2b.calls.length, 0, "B2B cannot open region management");
const noSelection = setup();
assert.equal(noSelection.api.adminSelectedRegion({ adminRegionalOperations: { regions: [sancheong] } }), sancheong);
const dictionaryStart = html.indexOf('id="dictionaryPanel"');
const dictionaryEnd = html.indexOf('id="targetPanel"');
const dictionaryHtml = html.slice(dictionaryStart, dictionaryEnd);
assert.ok(!dictionaryHtml.includes("dictionary-admin-operations"));
assert.ok(!dictionaryHtml.includes('id="adminRegionAnalysisDashboard"'));
assert.equal((html.match(/id="adminRegionAnalysisDashboard"/g) || []).length, 1);
assert.ok(html.indexOf('id="regionDataManagement"') > html.indexOf('id="adminDatabaseDashboard"'));
assert.ok(html.indexOf('id="regionDataManagement"') < html.indexOf('id="companyMasterAdminCard"'));
assert.ok(!html.includes("data-dictionary-view="), "Duplicate analysis tabs have been removed");
async function checkManagementHistory() {
  const { fixture: sharedFixture, POCHEON, SANCHEONG } = require("./test_region_analysis_navigation.cjs");
  const saved = sharedFixture();
  saved.api.reconcileAnalysisRegionSelection();
  saved.state.activeTab = "admin";
  saved.state.adminPanelSection = "database";
  saved.state.adminDbViewMode = "region";
  saved.state.adminSelectedRegionKey = POCHEON;
  saved.state.regionManagementReturnContext = { regionKey: POCHEON, label: "경기도 포천시", tab: "demand" };
  saved.api.syncAppHistoryState();
  const pocheonEntry = structuredClone(saved.history.state);
  saved.state.regionManagementReturnContext = { regionKey: SANCHEONG, label: "경상남도 산청군", tab: "map" };
  await saved.api.restoreAppHistoryState(pocheonEntry);
  assert.equal(saved.state.regionManagementReturnContext.regionKey, POCHEON, "Earlier DB history restores its own return region");
  assert.equal(saved.state.regionManagementReturnContext.tab, "demand", "Earlier DB history restores its own analysis view");
  await saved.api.restoreAppHistoryState({ tab: "admin", adminPanelSection: "database" });
  assert.equal(saved.state.regionManagementReturnContext, null, "History without a return destination cannot reuse a later visit");
  console.log("Region management navigation: exact-region DB entry, empty-data isolation, five-view return, history destinations and role boundaries passed");
}
checkManagementHistory().catch(error => { console.error(error); process.exitCode = 1; });
