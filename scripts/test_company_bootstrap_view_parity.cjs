"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { makeCompanyBootstrapMaster } = require("./fixtures/company_bootstrap_fixture.cjs");
const { startCompanyBootstrapFixture } = require("./fixtures/company_bootstrap_api_harness.cjs");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/app.js"), "utf8").replace(/\r\n/g, "\n");
// Execute real view calculations. Do not substitute expected values for metric,
// review, capacity or filter functions: this test guards the API split itself.
const declarations = [...source.matchAll(/^(?:async )?function [^]*?^}$/gm)].map(match => match[0]).join("\n");
const constantNames = ["DEFAULT_LODGING_CATEGORY_KEY", "LODGING_CATEGORY_PROFILES", "ADMIN_DB_PROVINCE_ORDER",
  "ADMIN_DB_CHANNEL_OPTIONS", "ADMIN_DB_MANAGED_CHANNEL_KEYS", "ADMIN_DB_MANAGED_CHANNELS", "ADMIN_DB_AUTO_CHANNEL_KEYS",
  "ADMIN_DB_MANUAL_CHANNEL_KEYS", "ADMIN_DB_CHANNEL_LINKED_STATUSES", "ADMIN_DB_CHANNEL_REVIEW_STATUSES"];
const constants = constantNames.map(name => {
  const oneLine = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, "m"));
  const block = source.match(new RegExp(`^const ${name} = [^]*?^[\\]\\}];$`, "m"));
  assert.ok(oneLine || block, `Missing actual constant ${name}`);
  return (oneLine || block)[0];
}).join("\n");
const normalize = value => JSON.parse(JSON.stringify(value));

function evaluateView(master, data = null) {
  const state = { data, companyMaster: master, adminDbFilters: {}, companyMasterFilters: {}, session: { role: "admin", authenticated: true } };
  const context = { state, window: {}, console, URL, URLSearchParams,
    els: { keywordInput: { value: "경남글램핑" }, checkInInput: { value: "2026-10-16" }, checkOutInput: { value: "2026-11-15" } } };
  vm.createContext(context);
  const api = vm.runInContext(`${constants}\n${declarations}\n({adminDbRows,companyDecisionQueueEntries,adminDbStatusOptions,adminDbConfidenceOptions,adminDbSourceOptions,adminDbCategoryOptions,adminDbProvinceOptions,adminDbRegionOptions,adminDbFilterState,companyCheckFilterOptions,companyCheckFilterMatches,adminDbRoomCapacityPresentation})`, context);
  const rows = api.adminDbRows(master);
  const entries = api.companyDecisionQueueEntries(master);
  const ids = values => values.map(row => row.company.companyId).sort();
  const rowValues = rows.map(row => ({
    companyId: row.company.companyId, provinceKey: row.provinceKey, regionKey: row.regionKey,
    provinceLabel: row.provinceLabel, localityLabel: row.localityLabel, searchText: row.searchText,
    roomTotal: row.metrics.roomTotal, revenue: row.metrics.revenue, rate: row.metrics.rate,
    confidenceGrade: row.metrics.confidenceGrade, confidenceScore: row.metrics.confidenceScore,
    lowConfidence: row.metrics.lowConfidence, manualCorrection: row.metrics.manualCorrection,
    category: row.metrics.category, features: row.metrics.features, workType: row.metrics.workType,
    collection: row.metrics.collection, capacity: api.adminDbRoomCapacityPresentation(row),
    channels: { ...row.metrics.channels, naverObservation: undefined }
  }));
  const queueValues = entries.map(entry => {
    const { latest, previous, ...comparison } = entry.comparison;
    return { companyId: entry.company.companyId, profile: entry.profile, decision: entry.decision,
      workflow: entry.workflow, type: entry.type, priority: entry.priority, comparison,
      autoRecommendation: entry.autoRecommendation, revenueImpact: entry.revenueImpact, revenueEvidence: entry.revenueEvidence, include: entry.include };
  });
  const filters = {};
  const variants = {
    status: api.adminDbStatusOptions(rows).map(row => row[0]),
    confidence: api.adminDbConfidenceOptions(rows).map(row => row[0]),
    source: api.adminDbSourceOptions(rows).map(row => row[0]),
    category: api.adminDbCategoryOptions(rows).map(row => row.key),
    province: api.adminDbProvinceOptions(rows).map(row => row.key),
    ota: ["all", "ota_missing", "channel_needs_manual", "channel_not_found", "naver", "yeogi", "yanolja", "tteonayo", "onda", "airbnb"],
    feature: ["all", "pool", "seminar", "pet", "bbq"],
    query: ["", "산청", "경남글램핑", "모의 업체 4", "cmp_place_bootstrap_5", "부산", "펜션"]
  };
  for (const [key, values] of Object.entries(variants)) for (const value of values) {
    state.adminDbFilters = { [key]: value };
    filters[`${key}:${value}`] = ids(api.adminDbFilterState(master).filteredRows);
  }
  const queueFilters = Object.fromEntries(api.companyCheckFilterOptions().map(([key]) => [key,
    ids(entries.filter(entry => api.companyCheckFilterMatches(entry, key)))]));
  return normalize({ rowValues, queueValues, filters, queueFilters,
    totals: { companies: rows.length, queue: entries.length, open: entries.filter(entry => entry.workflow.key !== "done").length },
    options: { status: api.adminDbStatusOptions(rows), confidence: api.adminDbConfidenceOptions(rows),
      source: api.adminDbSourceOptions(rows), category: api.adminDbCategoryOptions(rows), province: api.adminDbProvinceOptions(rows) } });
}

function assertViewParity(full, compact, data = null) {
  const before = evaluateView(full, data), after = evaluateView(compact, data);
  assert.deepEqual(after, before, "compact API must preserve real client list, review, capacity and filter calculations");
  return before.totals;
}

function variedMaster() {
  const master = makeCompanyBootstrapMaster(28, { evidenceRows: 8 });
  const companies = Object.values(master.companies);
  const statuses = [null, "confirmed", "contact_ready", "hold", "exclude", "manual_needed", "recrawl_needed", "check_needed"];
  companies.forEach((company, index) => {
    company.adminReview = statuses[index % statuses.length] ? { status: statuses[index % statuses.length], updatedAt: index % 2 ? "2026-10-15T00:00:00.000Z" : "2026-10-17T00:00:00.000Z" } : null;
    company.collectionSources = index % 4 === 0 ? ["b2b_search"] : ["admin_search"];
    company.inventory.latest.confidenceGrade = ["A", "B", "C", "D", "E", ""][index % 6];
    if (index % 3 === 0) company.channelExposures = { yanolja: { status: "not_found" }, yeogi: { status: "broken_link" } };
    if (index % 5 === 0) { company.addresses = ["부산광역시 강서구 모의동"]; company.regions = ["강서"]; }
    if (index % 4 === 0) {
      for (const snapshot of [company.inventory.latest, company.inventory.previousLatest, ...company.inventory.snapshots]) {
        snapshot.salesSignal.dayUsePresence = index % 8 === 0 ? "unknown" : "present";
        snapshot.salesSignal.dayUseMissing = false;
        snapshot.salesSignal.dayUse = { days: 31, totalSupply: 93, totalSold: 0, averageRate: 0 };
      }
    }
    if (index === 3) {
      company.primaryName = "[모의] 조용한 펜션"; company.lodgingTypes = ["pension"];
      company.inventory.latest.productTypeSummary = "펜션";
    }
    if (index === 4) {
      company.manualCorrection = { lodgingBasisTotal: 10, regionOverride: "산청", otaChannels: ["야놀자"], facilityTags: ["반려견"], updatedAt: "2026-10-16T12:00:00.000Z" };
      company.manualCorrectionRevision = 9;
    }
    if (index === 6 || index === 7) {
      const latest = company.inventory.latest;
      latest.salesSignal.lodging.averageRate = index === 6 ? 0 : null;
      latest.salesSignal.lodging.totalSold = index === 6 ? 0 : null;
      for (const field of ["revenue", "adjustedRevenue", "pricedSoldOut", "missingPriceSoldOut", "avgSoldUnitPrice"])
        latest.revenue.lodging[field] = index === 6 ? 0 : null;
      latest.revenue.lodging.recalculationUnavailable = index === 7;
    }
    if (index === 8) company.inventory.previousLatest = null;
    if (index === 9) company.inventory = { latest: {}, snapshots: [] };
    if (index === 10) company.inventory.latest.revenue.lodging.byDayType = "평일 100만원(10개), 금요일 50만원(5개), 토요일 50만원(5개), 일요일 30만원(3개)";
    if (index === 11) { company.inventory.latest.rooms = [{ name: "반려동물 동반 바비큐 수영장 회의실" }]; company.inventory.latest.facilities = []; }
  });
  return master;
}

async function run() {
  const master = variedMaster();
  const server = await startCompanyBootstrapFixture({ master });
  const masterFile = path.join(server.dataDir, "company_master", "companies.json"), original = JSON.stringify(master);
  try {
    const cookie = await server.login();
    const fullResponse = await server.request("/api/company-master/summary", { cookie });
    const compactResponse = await server.request("/api/company-master/bootstrap", { cookie });
    assert.equal(fullResponse.status, 200); assert.equal(compactResponse.status, 200);
    const full = fullResponse.data, compact = compactResponse.data;
    assert.equal(compact.totalCompanies, 28);
    const noRun = assertViewParity(full, compact);
    const baseView = evaluateView(compact);
    assert.equal(baseView.rowValues.find(row => row.companyId === "cmp_place_bootstrap_6").rate, 0, "a normal observed zero stays zero");
    assert.equal(baseView.rowValues.find(row => row.companyId === "cmp_place_bootstrap_7").rate, null, "unknown reservation rate does not become a normal zero");
    assert.equal(baseView.rowValues.find(row => row.companyId === "cmp_place_bootstrap_0").roomTotal, 16, "DB correction remains the capacity basis");
    assert.deepEqual(baseView.rowValues.find(row => row.companyId === "cmp_place_bootstrap_11").features,
      { pool: true, seminar: true, pet: true, bbq: true }, "legacy room names retain facility filters without loading room evidence");
    const selected = full.companies[0];
    const currentRun = { run: { id: "current-parity", keyword: "경남글램핑", checkIn: "2026-10-16", checkOut: "2026-11-15", bookingRangeDays: 31 },
      availability: { items: [{ companyId: selected.companyId, name: selected.primaryName, nightItemCount: 16,
        inventoryConfidenceGrade: "A", inventoryStructureType: "individual", weeklyTotalStock: 496, weeklyTotalSoldOut: 31,
        weeklyNightRevenue: 3100000, weeklyNightPricedSoldOut: 31, weeklyNightMissingPriceSoldOut: 0,
        itemDetails: [{ bizItemId: "one", name: "숙박", stock: 16, available: 15, price: 100000 }] }] } };
    const withRun = assertViewParity(full, compact, currentRun);
    assert.notDeepEqual(evaluateView(compact, currentRun).queueValues, baseView.queueValues, "selected-run evidence actually participates in the comparison");
    assert.equal(await fsp.readFile(masterFile, "utf8"), original, "both view reads leave original company data unchanged");
    console.log(JSON.stringify({ companyBootstrapViewParity: "passed", noRun, withRun, scenarios: ["review lifecycle", "correction first", "zero versus missing", "day-use present absent unknown", "capacity and features", "all management filters", "selected-run override"] }));
  } finally {
    await server.stop();
  }
}

module.exports = { evaluateView, assertViewParity };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
