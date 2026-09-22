"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const names = ["companyKey", "adminDbProvinceIdentity", "adminDbLocalityKey", "adminManagementRegionIdentity", "adminSelectedRegion", "openAnalysisRegionManagement", "returnToRegionAnalysis", "adminDbFilterState"];
const declarations = names.map(name => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  return declaration;
});
const provinceOrder = source.match(/^const ADMIN_DB_PROVINCE_ORDER = \[[^]*?^\];/m)?.[0];
const units = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web/data/region_master.json"), "utf8")).units;
const pocheon = units.find(region => region.active && region.name === "포천시");
const sancheong = units.find(region => region.active && region.name === "산청군");
const serverSource = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const serverRegionStart = serverSource.indexOf("const ADMIN_REGION_GROUPS =");
const serverRegionEnd = serverSource.indexOf("function topicParticle(", serverRegionStart);
const serverClassification = vm.runInNewContext([
  serverSource.slice(serverRegionStart, serverRegionEnd),
  ...["compactKeyword", "adminRegionClassification"].map(name => serverSource.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))[0]),
  "adminRegionClassification"
].join("\n"));
const managementPocheon = serverClassification("포천", "경기도 포천시");
const managementSancheong = serverClassification("산청", "경상남도 산청군");
function setup(admin = true, selected = pocheon, rows = []) {
  const state = { activeTab: "demand", adminSelectedRegionKey: "", adminDbFilters: { query: "남은 업체 검색", province: "old", status: "needs_work" }, analysisRegionKey: pocheon.regionKey };
  const calls = [];
  const context = vm.createContext({
    state, isAdminRole: () => admin, selectedAnalysisRegion: () => selected,
    administrativeRegionForKey: key => units.find(region => [region.regionKey, region.regionId, region.officialCode].includes(key)),
    adminDbFilters: () => state.adminDbFilters,
    adminDbRows: () => rows,
    adminDbProvinceOptions: () => rows.map(row => ({ key: row.provinceKey })),
    adminDbRegionOptions: () => rows.map(row => ({ key: row.regionKey })),
    adminDbCategoryOptions: () => [], adminDbStatusOptions: () => [], adminDbConfidenceOptions: () => [], adminDbSourceOptions: () => [],
    compactSearchText: value => String(value),
    clearAdminDbCompanyHash: () => calls.push("clearCompanyRoute"),
    setActiveTab: tab => { state.activeTab = tab; calls.push(`tab:${tab}`); },
    setAdminPanelSection: panel => { state.adminPanelSection = panel; },
    renderAdminDatabaseDashboard: () => calls.push("renderDB"),
    syncAppHistoryState: () => calls.push("saveHistory"),
    setAnalysisRegion: key => { state.analysisRegionKey = key; calls.push(`region:${key}`); },
    window: { requestAnimationFrame: fn => fn() },
    document: { getElementById: () => ({ scrollIntoView: () => calls.push("scrollManagement") }) }
  });
  const api = vm.runInContext(`${provinceOrder}\n${declarations.join("\n")}\n({${names.join(",")}})`, context);
  return { state, calls, api };
}

const fixture = setup();
fixture.api.openAnalysisRegionManagement();
assert.equal(fixture.state.adminSelectedRegionKey, managementPocheon.regionKey);
assert.equal(fixture.state.adminDbFilters.region, managementPocheon.regionKey);
assert.equal(fixture.state.adminDbFilters.province, managementPocheon.provinceKey);
assert.equal(fixture.state.adminDbFilters.query, "");
assert.equal(fixture.state.adminDbViewMode, "region");
assert.equal(fixture.state.adminPanelSection, "database");
assert.equal(fixture.state.regionManagementReturnContext.tab, "demand");
assert.equal(fixture.state.regionManagementReturnContext.regionKey, pocheon.regionKey);
assert.equal(fixture.state.analysisRegionKey, pocheon.regionKey, "Opening DB cannot change the analysis region");
assert.equal(fixture.api.adminSelectedRegion({ adminRegionalOperations: { regions: [managementPocheon] } }), managementPocheon, "The real server contract matches the administrative selection");
assert.equal(fixture.api.adminSelectedRegion({ adminRegionalOperations: { regions: [managementSancheong] } }), null, "Missing Pocheon management data cannot fall back to Sancheong");
fixture.api.adminDbFilterState();
assert.equal(fixture.state.adminDbFilters.region, managementPocheon.regionKey, "An empty selected region does not widen to nationwide data");
assert.equal(fixture.state.adminDbFilters.province, managementPocheon.provinceKey);
fixture.state.adminSelectedRegionKey = managementSancheong.regionKey;
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
assert.equal(noSelection.api.adminSelectedRegion({ adminRegionalOperations: { regions: [managementSancheong] } }), managementSancheong);
const legacySelection = setup();
legacySelection.state.adminSelectedRegionKey = pocheon.regionKey;
assert.equal(legacySelection.api.adminSelectedRegion({ adminRegionalOperations: { regions: [managementPocheon] } }), managementPocheon, "History with the old administrative key still resolves correctly");
for (const officialCode of ["4165000000", "4182000000", "4882000000", "5182000000", "5180000000", "2772000000", "4800000000"]) {
  const region = units.find(entry => entry.active && entry.officialCode === officialCode);
  assert.ok(region, officialCode);
  const item = setup(true, region);
  item.api.openAnalysisRegionManagement();
  const actual = serverClassification(region.sigungu || region.name, region.fullName);
  assert.equal(item.state.adminSelectedRegionKey, actual.regionKey, `${region.fullName}: navigation must match the server's key`);
  assert.equal(item.state.adminDbFilters.province, actual.provinceKey);
  assert.equal(item.state.adminDbFilters.region, region.level === "broad" ? "all" : actual.regionKey);
  assert.equal(item.state.regionManagementReturnContext.regionKey, region.regionKey, "Return navigation preserves the administrative identity");
}
const unmappedRegion = units.find(region => region.active && region.officialCode === "1200000000");
const unmapped = setup(true, unmappedRegion);
unmapped.api.openAnalysisRegionManagement();
unmapped.api.adminDbFilterState();
assert.equal(unmapped.state.regionManagementReturnContext.mappingPending, true, "An unrecognized management province remains explicitly pending");
assert.equal(unmapped.state.adminDbFilters.province, unmappedRegion.regionKey, "An unmapped province cannot silently broaden to nationwide records");
assert.equal(unmapped.api.adminSelectedRegion({ adminRegionalOperations: { regions: [managementPocheon] } }), null);
const actualPocheonRow = { ...managementPocheon, metrics: { category: {} }, company: { primaryName: "포천 표본" } };
const actualSancheongRow = { ...managementSancheong, metrics: { category: {} }, company: { primaryName: "산청 표본" } };
const populated = setup(true, pocheon, [actualPocheonRow, actualSancheongRow]);
populated.api.openAnalysisRegionManagement();
assert.deepEqual(Array.from(populated.api.adminDbFilterState().filteredRows), [actualPocheonRow], "The mapped filter selects the requested region's real server rows only");
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
  saved.state.regionManagementReturnContext = { regionKey: POCHEON, label: "경기도 포천시", tab: "demand", managementRegionKey: managementPocheon.regionKey, provinceKey: managementPocheon.provinceKey };
  saved.api.syncAppHistoryState();
  const pocheonEntry = structuredClone(saved.history.state);
  saved.state.regionManagementReturnContext = { regionKey: SANCHEONG, label: "경상남도 산청군", tab: "map" };
  await saved.api.restoreAppHistoryState(pocheonEntry);
  assert.equal(saved.state.regionManagementReturnContext.regionKey, POCHEON, "Earlier DB history restores its own return region");
  assert.equal(saved.state.regionManagementReturnContext.tab, "demand", "Earlier DB history restores its own analysis view");
  assert.equal(saved.state.regionManagementReturnContext.managementRegionKey, managementPocheon.regionKey);
  assert.equal(saved.state.regionManagementReturnContext.provinceKey, managementPocheon.provinceKey);
  await saved.api.restoreAppHistoryState({ tab: "admin", adminPanelSection: "database" });
  assert.equal(saved.state.regionManagementReturnContext, null, "History without a return destination cannot reuse a later visit");
  console.log("Region management navigation: exact-region DB entry, empty-data isolation, five-view return, history destinations and role boundaries passed");
}
checkManagementHistory().catch(error => { console.error(error); process.exitCode = 1; });
