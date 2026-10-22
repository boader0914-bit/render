"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), native = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto"), vm = require("node:vm");
const { createMonthlyCompanySourceCatalog, compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { compactIndustrySources } = require("./lib/industry_analysis.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const sha = value => crypto.createHash("sha256").update(value).digest("hex"), json = value => JSON.parse(JSON.stringify(value));
const source = native.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
function extracted(name, globals = {}) { const start = source.indexOf("function " + name + "("), following = /\r?\n(?:async )?function /.exec(source.slice(start + 1)), end = start + 1 + following.index; assert.ok(start >= 0 && end > start); return vm.runInNewContext("(" + source.slice(start, end).trim() + ")", globals); }
const productSnapshotNumber = extracted("productSnapshotNumber"), maximum = extracted("companyMaximumRoomCapacity", { productSnapshotNumber });
const capacityRecord = extracted("withCompanyInventoryCapacityRecord", { companyMaximumRoomCapacity: maximum, productSnapshotNumber,
  manualCorrectionLodgingBasisTotal: correction => correction?.active === false ? null : Number(correction?.lodgingBasisTotal) || null });
const availabilityMatch = extracted("companyProductAvailabilityMatch", { extractNaverPlaceId: item => item.placeId, extractBookingBusinessId: item => item.bookingBusinessId });
const correctionContext = vm.createContext({ B2B_INTEREST_LODGE_SEGMENT_LIMIT: 12,
  applyInventoryEvidence: require("./inventory_estimation.cjs").applyInventoryEvidence,
  sanitizeMemberText: (value, max) => String(value || "").trim().slice(0, max),
  boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit) });
for (const name of ["productSnapshotNumber", "companyMaximumRoomCapacity", "withCompanyInventoryCapacityRecord", "applyCompanyManualCorrection",
  "manualCorrectionLodgingBasisTotal", "manualCorrectionRoomSegmentTotal", "manualCorrectionRoomSegments", "sanitizeManualCorrectionRoomSegments",
  "sanitizeB2BInterestLodgeSegment", "b2bInterestLodgeSegmentHasInput", "sanitizeInterestLodgeNumberText", "sanitizeManualCorrectionMeta",
  "manualCorrectionHasValue", "manualCorrectionHasBasis", "manualCorrectionMetaHasValue", "maxPositiveNumber", "parseBasisTotalFromRule", "stockBasisRule"]) {
  const start = source.indexOf("function " + name + "("), next = /\r?\n(?:async )?function /.exec(source.slice(start + 1));
  assert.ok(start >= 0 && next, name); vm.runInContext(source.slice(start, start + 1 + next.index), correctionContext);
}

async function temporary(t, beforeCleanup = async () => {}) { const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-company-source-")); t.after(async () => { await beforeCleanup(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); }); return root; }
function snapshot(runId, rows, extra = {}) { return { runId, collectedAt: "2026-08-01T00:00:00Z", inventoryEvidenceVersion: 4,
  productSnapshot: { runId, inventoryEvidenceVersion: 4, daily: rows, productDetails: "saved-product-body-".repeat(2000) }, ...extra }; }
function daily(date, total, extra = {}) { return { stayDate: date, productType: "lodging", rawTotal: total, supply: 16, sold: 4, publicBookings: 3, phoneBookings: 1,
  inventoryEvidenceVersion: 4, collectedAt: "2026-08-01T00:00:00Z", estimatedRevenue: 400000, publicRevenue: 300000, phoneRevenue: 100000, ...extra }; }
function rawCompanies() {
  const records = {};
  for (const [id, name, place] of [["a", "원본 A", "10"], ["b", "원본 B", "20"], ["c", "중복 C", "70"], ["d", "중복 D", "70"]]) records[id] = { companyId: id, primaryName: name, placeIds: [place], bookingBusinessIds: ["booking-" + id], lodgingTypes: ["glamping"], addresses: ["경기도 포천시 모의로"],
    runIds: ["run1"], firstRunId: "run1", lastRunId: "run1", duplicateNotes: id === "a" ? [{ mergedCompanyId: "old-a" }] : [],
    manualCorrection: { active: true, lodgingBasisTotal: 16, productStockCorrections: [{ productId: "p-" + id, count: 4 }] },
    keywords: { k: { keyword: "포천글램핑", runs: [{ runId: "run1", rank: id === "a" ? 1 : 2, collectedAt: "2026-08-01T00:00:00Z" }] } },
    inventory: { runIds: ["run1"], latest: snapshot("run1", [daily("2026-08-02", 16), daily("2026-08-03", 19), daily("2026-08-not-valid", 17), daily("2026-09-01", 12)]),
      previousLatest: snapshot("run1", [daily("2026-07-31", 11)]), snapshots: [snapshot("run1", [daily("2026-08-02", 15)])] }, largeUnusedOriginalField: "do-not-retain-all-company-body".repeat(2000) };
  return records;
}
const runs = [{ id: "run1", keyword: "포천글램핑", collectedAt: "2026-08-01T00:00:00Z", checkIn: "2026-08-01", bookingRangeDays: 32, collectionQuality: { status: "complete" } }];
async function fixture(t, { indexed = false } = {}) {
  let observationIndex = null;
  const root = await temporary(t, async () => { if (observationIndex) await observationIndex.close(); }), companyFile = path.join(root, "company_master/companies.json"), regionFile = path.join(root, "regions.json"), historyFile = path.join(root, "history/observations.jsonl");
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(companyFile, JSON.stringify({ companies: rawCompanies() }));
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", name: "포천시", fullName: "경기도 포천시" }] }));
  await fs.writeFile(historyFile, [JSON.stringify({ ...daily("2026-08-02", 16), companyKey: "old-a", runId: "run1", observationId: "a-observation" }),
    JSON.stringify({ ...daily("2026-08-02", 16), companyKey: "name-only-unknown", runId: "run1", observationId: "unknown" }), "not-json"].join("\n") + "\n");
  if (indexed) { observationIndex = createHistoryObservationIndex({ file: historyFile, indexFile: path.join(root, "history/indexes/observations.sqlite") }); await observationIndex.ensure(); }
  const readRevision = async () => { const values = await Promise.all([companyFile, regionFile, historyFile].map(async filename => { const stat = await fs.stat(filename, { bigint: true }); return [String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs), String(stat.ino)]; })); return sha(JSON.stringify(values)); };
  const make = (cached, hooks = {}) => createMonthlyReportSources({ dataDir: root, regionMasterFile: regionFile, listRuns: async () => json(runs), observationIndex,
    readRevision, ...(cached ? { projectCapacityCompany: compactMonthlyCapacityCompany, companySourceVersion: "explicit-fixture-calculation-1" } : {}),
    capacityForCompany: maximum, prepareCompanies: async companies => companies, ...hooks });
  return { root, companyFile, regionFile, historyFile, make, readRevision, observationIndex };
}

test("compact global capacity metadata preserves the exact application's maximum and provider matching without full product bodies", () => {
  const cases = Object.values(rawCompanies());
  cases.push({ companyId: "legacy", placeIds: ["90"], bookingBusinessIds: ["B"], inventory: { latest: { stockBasis: { lodgingMaxTotal: 99 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: -1 }] } } } });
  cases.push({ companyId: "text", inventory: { latest: { stockBasis: { lodgingMaxTotal: 88 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: "1,123실" }, { productType: "lodging", rawTotal: "3개" }, { productType: "dayuse", rawTotal: 99999 }] } } } });
  cases.push({ companyId: "v4", inventory: { latest: { inventoryEvidenceVersion: 4, capacityBasis: { currentObservedMaximum: 27 }, productSnapshot: { inventoryEvidenceVersion: 4, daily: [] } } } });
  cases.push({ companyId: "zero", inventory: { latest: { stockBasis: { lodgingMaxTotal: 900 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: 0 }] } } } });
  cases.push({ companyId: "missing", inventory: { latest: { stockBasis: { lodgingMaxTotal: 13 }, productSnapshot: { daily: [{ productType: "lodging", rawTotal: 60, missing: true }] } } } });
  for (const company of cases) {
    const before = JSON.stringify(company), compact = compactMonthlyCapacityCompany(company); assert.equal(maximum(compact), maximum(company), company.companyId);
    for (const item of [{ placeId: "10", bookingBusinessId: "booking-a" }, { placeId: "10", bookingBusinessId: "conflicting" }, { placeId: "other", bookingBusinessId: "booking-a" }, { bookingBusinessId: "B" }, {}]) {
      assert.equal(availabilityMatch(compact, item), availabilityMatch(company, item)); assert.deepEqual(json(capacityRecord(item, compact)), json(capacityRecord(item, company)));
    }
    assert.equal(JSON.stringify(company), before); assert.ok(!JSON.stringify(compact).includes("saved-product-body"));
  }
});

test("compact rank metadata tolerates null legacy run references without inventing evidence", () => {
  const company = { companyId: "legacy-null", keywords: { k: { runs: [null, { runId: "actual", rank: 0 }] } } };
  assert.deepEqual(compactMonthlyCapacityCompany(company).keywords.k.runs, [{}, { runId: "actual", rank: 0 }]);
});

test("complete saved rank metadata survives compaction without restoring company product bodies", () => {
  const company = rawCompanies().a;
  const metadata = { collectedDate: "2026-08-01", regionalRank: 0, searchMode: "keyword", collectionSource: "admin_search",
    unknownMetadata: { revision: 2, attempted: false, warnings: ["retained"], nullable: null }, futureRankField: [0, false, ""] };
  Object.assign(company.keywords.k.runs[0], metadata);
  const compact = compactMonthlyCapacityCompany(company);
  assert.deepEqual(compact.keywords.k.runs, company.keywords.k.runs);
  assert.ok(!JSON.stringify(compact).includes("saved-product-body"));
  assert.ok(!JSON.stringify(compact).includes("do-not-retain-all-company-body"));
  company.keywords.k.runs[0].unknownMetadata.warnings.push("later-original-edit");
  assert.deepEqual(compact.keywords.k.runs[0].unknownMetadata.warnings, ["retained"], "returned metadata owns an independent saved-JSON copy");
});

test("the real application correction callbacks produce identical complete items from full companies and the explicit compact projection", () => {
  const original = rawCompanies().a;
  original.manualCorrection.productStockCorrections = [{ bizItemId: "p-a", stayDate: "2026-08-02", observedStock: 16, correctedStock: 14, reason: "actual callback fixture" }];
  const cases = [json(original)];
  const disabled = json(original); disabled.manualCorrection = { active: false, lodgingBasisTotal: 100, dayUseBasisTotal: 80 }; cases.push(disabled);
  const cleared = json(original); delete cleared.manualCorrection; cases.push(cleared);
  const metadata = json(original); metadata.manualCorrection = { active: true, lodgingBasisTotal: 13, dayUseBasisTotal: 2,
    couponVisible: "visible", couponNames: "saved coupon", facilityTags: ["pool"], otaChannels: ["saved"], naverBookingStatus: "visible",
    productStockCorrections: [{ bizItemId: "p-a", stayDate: "2026-08-02", observedStock: 16, correctedStock: 4, reason: "reviewed product count" }] }; cases.push(metadata);
  const evidence = json(original); evidence.inventory.latest.productSnapshot.capacityBasis = { currentObservedMaximum: 27 }; cases.push(evidence);
  const legacy = json(original); delete legacy.manualCorrection; legacy.inventory = { latest: { inventoryEvidenceVersion: 2, stockBasis: { lodgingMaxTotal: 88 },
    productSnapshot: { inventoryEvidenceVersion: 2, daily: [{ productType: "lodging", rawTotal: null }] } } }; cases.push(legacy);
  const excluded = json(original); excluded.inventory.latest.productSnapshot.daily.push({ productType: "lodging", missing: true, rawTotal: 999 }); cases.push(excluded);
  const item = { placeId: "10", bookingBusinessId: "booking-a", name: "saved actual-function fixture", weeklyBasisTotal: 16,
    weeklyProductDetails: [{ date: "2026-08-02", bizItemId: "p-a", name: "숙박", saleType: "숙박", stock: 16, available: 12,
      bookingCount: 3, occupiedBookingCount: 4, price: 120000, inventoryObserved: true, queryAttempted: true, responseStatus: 200 }] };
  for (const company of cases) {
    const compact = compactMonthlyCapacityCompany(company), before = JSON.stringify(company);
    assert.equal(correctionContext.manualCorrectionHasValue(company.manualCorrection), correctionContext.manualCorrectionHasValue(compact.manualCorrection));
    assert.equal(correctionContext.companyMaximumRoomCapacity(company), correctionContext.companyMaximumRoomCapacity(compact));
    for (const candidate of [item, { ...item, placeId: "conflicting-place" }, { ...item, bookingBusinessId: "conflicting-booking" }]) {
      assert.equal(availabilityMatch(company, candidate), availabilityMatch(compact, candidate));
      assert.deepEqual(json(correctionContext.applyCompanyManualCorrection(json(candidate), company)),
        json(correctionContext.applyCompanyManualCorrection(json(candidate), compact)));
    }
    assert.equal(JSON.stringify(company), before); assert.ok(!JSON.stringify(compact).includes("saved-product-body"));
  }
  assert.match(source, /projectCorrectionCompany:\s*compactMonthlyCapacityCompany/, "only the actual app opts into its proven correction projection");
});

test("a derived-directory symlink cannot create files outside the configured data root", async t => {
  const root = await temporary(t), outside = await temporary(t);
  await fs.symlink(outside, path.join(root, "monthly_reports"), process.platform === "win32" ? "junction" : "dir");
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "actual-source",
    projectCapacityCompany: compactMonthlyCapacityCompany, loadFullCatalog: async () => ({ companies: [], regions: [], runs: [], rawCompanies: new Map() }) });
  await assert.rejects(catalog.readCompanyCatalog("absent"), { code: "MONTHLY_COMPANY_SOURCE_DIRECTORY_INVALID" });
  assert.deepEqual(await fs.readdir(outside), []);
});

for (const indexed of [false, true]) test(`company-only projection preserves all source quantities, ranks, global unknown/conflict diagnostics (indexed=${indexed})`, async t => {
  const f = await fixture(t, { indexed }), direct = f.make(false), projected = f.make(true); const masterBefore = await fs.readFile(f.companyFile);
  for (const targetId of ["a", "b", "c", "absent"]) for (const month of ["2026-07", "2026-08", "2026-09"]) {
    const request = { type: "company", targetId, month, cutoffDate: "2026-09-30" };
    assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)), targetId + "/" + month);
  }
  assert.equal(projected.sourceReadMetrics().catalogFullReads, 1); assert.equal(projected.sourceReadMetrics().capacityPreparations, 1);
  assert.equal(projected.sourceReadMetrics().companyCatalog.builds, 1); assert.equal(projected.sourceReadMetrics().companyCatalog.retainedFullCompanies, 0);
  assert.equal(projected.sourceReadMetrics().companyCatalog.companyBodyReads, 9); assert.ok(projected.sourceReadMetrics().companyCatalog.compactBytes < masterBefore.length / 2);
  assert.deepEqual(await fs.readFile(f.companyFile), masterBefore);
});

test("active-id merged-alias overrides preserve original fallback quantities, last-winner order and diagnostics", async t => {
  const f = await fixture(t, { indexed: true }), master = JSON.parse(await fs.readFile(f.companyFile));
  master.companies.b.duplicateNotes = [{ mergedCompanyId: "a" }, { mergedCompanyId: "c" }];
  master.companies.a.inventory.latest.productSnapshot.daily = [daily("2026-08-02", 23, { sold: 9, publicBookings: 8, phoneBookings: 1 })];
  master.companies.c.inventory.latest.productSnapshot.daily = [daily("2026-08-04", 29, { sold: 11, publicBookings: 10, phoneBookings: 1 })];
  await fs.writeFile(f.companyFile, JSON.stringify(master));
  const direct = f.make(false), projected = f.make(true);
  for (const targetId of ["a", "b", "c", "d"]) {
    const request = { type: "company", targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)), targetId);
  }
  const b = await projected.loadSources({ type: "company", targetId: "b", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.ok(b.observations.some(row => row.stayDate === "2026-08-04" && row.sold === 11));
});

test("a restart reuses the saved projection; original changes rebuild it without TTL and new companies become visible", async t => {
  const f = await fixture(t), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  const first = f.make(true); await first.loadSources(request);
  const restarted = f.make(true); const original = await restarted.loadSources(request);
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 0); assert.equal(restarted.sourceReadMetrics().capacityPreparations, 0); assert.equal(restarted.sourceReadMetrics().companyCatalog.savedHits, 1);
  const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "실제 변경된 업체명"; master.companies.new = { ...master.companies.b, companyId: "new", primaryName: "새 업체", placeIds: ["new-place"] };
  await fs.writeFile(f.companyFile, JSON.stringify(master)); const refreshed = await restarted.loadSources(request);
  assert.equal(refreshed.companies.find(company => company.companyId === "a").primaryName, "실제 변경된 업체명"); assert.ok(refreshed.companies.some(company => company.companyId === "new"));
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 1); assert.notDeepEqual(refreshed.companies, original.companies);
});

for (const indexed of [false, true]) test(`all four source scopes and paired industry metadata share a verified generation without losing actual fallback rows (indexed=${indexed})`, async t => {
  const f = await fixture(t, { indexed }), master = JSON.parse(await fs.readFile(f.companyFile));
  master.companies.a.industryIds = ["caravan"];
  master.companies.a.regionKey = "pocheon"; master.companies.a.regions = ["경기도 포천시"];
  master.companies.b.regionId = "pocheon";
  master.companies.b.manualCorrection.regionOverride = "포천시";
  for (const company of Object.values(master.companies)) Object.assign(company.keywords.k.runs[0], {
    collectedDate: "2026-08-01", regionalRank: company.companyId === "a" ? 0 : 4, searchMode: "keyword", collectionSource: "admin_search",
    unknownMetadata: { company: company.companyId, falseFlag: false, nullable: null, nested: { saved: ["metadata", 7] } }
  });
  // A real active ID can also be a merged alias. Preserve the complete old
  // iteration/overwrite order, including quantities from its original body.
  master.companies.b.duplicateNotes = [{ mergedCompanyId: "a" }, { mergedCompanyId: "c" }];
  master.companies.a.inventory.latest.productSnapshot.daily[0].sold = 9;
  master.companies.c.inventory.latest.productSnapshot.daily.push(daily("2026-08-05", 26, { sold: 11, rank: 3, keyword: "포천글램핑" }));
  await fs.writeFile(f.companyFile, JSON.stringify(master));
  const sourceFiles = [f.companyFile, f.historyFile, f.regionFile], before = await Promise.all(sourceFiles.map(async file => [await fs.readFile(file), await fs.stat(file, { bigint: true })]));
  const projected = f.make(true), direct = f.make(false);
  for (const [type, targetId] of [["company", "b"], ["keyword", "포천글램핑"], ["region", "pocheon"], ["industry", "__industry_all__"]]) for (const month of ["2026-08", "2026-09"]) {
    const request = { type, targetId, month, cutoffDate: "2026-09-30" };
    const expected = await direct.loadSourcesWithCatalog(request), pair = await projected.loadSourcesWithCatalog(request);
    assert.deepEqual(json(pair.source), json(expected.source), type + "/" + month);
    assert.deepEqual(json(compactIndustrySources(pair.source, pair.catalog)), json(compactIndustrySources(expected.source, expected.catalog)), "paired classification/location " + type + "/" + month);
    assert.equal(typeof pair.catalog._companySource.assertCurrent, "function");
    assert.equal(pair.source.companies, pair.catalog.companies);
    assert.equal(pair.catalog.rawCompanies.get("d")._monthlySourceCompact, true);
    if (type !== "company") assert.ok(!JSON.stringify(pair.catalog).includes("saved-product-body"), "broad paired catalogs retain no original product inventories");
  }
  const metrics = projected.sourceReadMetrics();
  assert.equal(metrics.catalogFullReads, 1); assert.equal(metrics.capacityPreparations, 1); assert.equal(metrics.companyCatalog.builds, 1);
  assert.equal(metrics.preparedCatalogReads, 8); assert.deepEqual(metrics.preparedCatalogReadsByScope, { company: 2, keyword: 2, region: 2, industry: 2, other: 0 });
  assert.equal(metrics.companyProjectionReads, 2, "the existing company-only counter keeps its meaning");
  for (let index = 0; index < sourceFiles.length; index++) {
    assert.deepEqual(await fs.readFile(sourceFiles[index]), before[index][0]); const after = await fs.stat(sourceFiles[index], { bigint: true });
    for (const field of ["size", "mtimeNs", "ctimeNs", "ino", "dev"]) assert.equal(after[field], before[index][1][field], field);
  }
});

test("nineteen broad paired reads reuse capacity preparation and no full company body remains in their catalog", async t => {
  const f = await fixture(t), projected = f.make(true);
  for (let index = 0; index < 19; index++) {
    const pair = await projected.loadSourcesWithCatalog({ type: "industry", targetId: "__industry_all__", month: index % 2 ? "2026-09" : "2026-08", cutoffDate: "2026-09-30" });
    assert.equal(pair.catalog.rawCompanies.get("a")._monthlySourceCompact, true);
    assert.ok(pair.source.observations.length > 0);
  }
  const metrics = projected.sourceReadMetrics(); assert.equal(metrics.catalogFullReads, 1); assert.equal(metrics.capacityPreparations, 1);
  assert.equal(metrics.companyCatalog.builds, 1); assert.equal(metrics.companyCatalog.hits, 18); assert.equal(metrics.preparedCatalogReadsByScope.industry, 19);
  const restarted = f.make(true); await restarted.loadSourcesWithCatalog({ type: "region", targetId: "pocheon", month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 0); assert.equal(restarted.sourceReadMetrics().capacityPreparations, 0);
  assert.equal(restarted.sourceReadMetrics().companyCatalog.savedHits, 1);
});

test("broad scopes load each run once without publishing cold run caches while company scopes retain cache reuse and full capacity identities", async t => {
  const f = await fixture(t); const loads = { direct: 0, projected: 0 };
  const recalculation = mode => createMonthlyCompanyRecalculation({ cacheDirectory: path.join(f.root, "derived-row-cache-" + mode),
    loadRun: async (id, options) => {
      loads[mode]++; assert.deepEqual(options.capacityCompanies.map(row => row.companyId), ["a", "b", "c", "d"]);
      assert.ok(options.capacityCompanies.every(row => maximum(row) === 19));
      for (const field of ["skipCompanyMaster", "skipHistory", "skipTraffic"]) assert.equal(options[field], true);
      assert.equal(options.applyCompanyMaster, false);
      return { run: { id }, availability: { items: ["a", "b", "c", "d"].map(companyId => ({ companyId, inventoryEvidence: { version: 4 }, savedQuantity: 7 })) } };
    },
    companyProductAvailabilityMatch: (company, item) => company.companyId === item.companyId,
    applyCompanyManualCorrection: (item, company) => ({ ...item, reviewedQuantity: company.manualCorrection.lodgingBasisTotal }),
    buildHistoryObservations: data => [daily("2026-08-06", data.availability.items[0].reviewedQuantity,
      { sold: data.availability.items[0].savedQuantity, runId: "run1" }), daily("2026-09-01", 16, { sold: 8, runId: "run1" })]
  });
  const direct = f.make(false, { recalculateCompanyObservations: recalculation("direct") });
  const projected = f.make(true, { recalculateCompanyObservations: recalculation("projected") });
  for (const [type, targetId] of [["industry", "__industry_all__"], ["keyword", "포천글램핑"], ["region", "pocheon"], ["company", "a"]]) {
    const request = { type, targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)), type);
  }
  assert.equal(loads.direct, 4); assert.equal(loads.projected, 4, "three broad cold reads never construct persistent run-row entries");
  const request = { type: "company", targetId: "b", month: "2026-08", cutoffDate: "2026-08-31" };
  assert.deepEqual(json(await projected.loadSources(request)), json(await direct.loadSources(request)));
  assert.equal(loads.direct, 5); assert.equal(loads.projected, 4, "the final company read reuses the company-built run rows");
  assert.equal(projected.sourceReadMetrics().companyCatalog.builds, 1);
});

for (const [type, targetId] of [["keyword", "포천글램핑"], ["region", "pocheon"], ["industry", "__industry_all__"]]) {
  test(`a damaged nonselected company body fails closed for ${type} without changing originals`, async t => {
    const f = await fixture(t), projected = f.make(true), request = { type, targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    await projected.loadSources(request); const original = await fs.readFile(f.companyFile), base = path.join(f.root, "monthly_reports/company_sources"), pointer = JSON.parse(await fs.readFile(path.join(base, "current.json")));
    await fs.writeFile(path.join(base, pointer.generation, sha("b") + ".json"), "damaged-derived-body");
    await assert.rejects(projected.loadSourcesWithCatalog(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
    assert.deepEqual(await fs.readFile(f.companyFile), original);
  });
  test(`a mid-read original change rejects a mixed ${type} generation`, async t => {
    const f = await fixture(t), request = { type, targetId, month: "2026-08", cutoffDate: "2026-08-31" };
    await f.make(true).loadSources(request); const pointer = path.join(f.root, "monthly_reports/company_sources/current.json"), before = await fs.readFile(pointer);
    const failing = f.make(true, { recalculateCompanyObservations: async () => {
      const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.b.manualCorrection.lodgingBasisTotal = 23;
      await fs.writeFile(f.companyFile, JSON.stringify(master)); return [];
    } });
    await assert.rejects(failing.loadSourcesWithCatalog(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
    assert.deepEqual(await fs.readFile(pointer), before, "failed reads do not replace the last verified generation");
  });
}

test("recalculation sees all capacity identities but can lazily load a nonselected full company from the same verified generation", async t => {
  const f = await fixture(t); let calls = 0;
  const projected = f.make(true, { recalculateCompanyObservations: async (request, data) => {
    calls++; assert.equal(data.rawCompanies.get(request.targetId)._monthlySourceCompact, undefined);
    assert.ok(data.rawCompanies.get("b")._monthlySourceCompact); assert.equal(data.rawCompanies.size, 4);
    assert.equal(data.rawCompanies.get("b").inventory.latest.productSnapshot.daily.length, 1);
    assert.ok(!JSON.stringify(data).includes("_companySource")); const selectedB = await data._companySource.readCompany("b");
    assert.equal(selectedB.inventory.latest.productSnapshot.daily.length, 4); assert.equal(selectedB.largeUnusedOriginalField.length > 1000, true);
    assert.equal(maximum(selectedB), maximum(data.rawCompanies.get("b"))); await data._companySource.assertCurrent(); return [];
  } });
  await projected.loadSources({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }); assert.equal(calls, 1);
});

test("mid-read original changes fail closed and preserve the last good source pointer and existing monthly aggregate", async t => {
  const f = await fixture(t), aggregate = path.join(f.root, "company_integrated/preserved-month.json"); await fs.mkdir(path.dirname(aggregate)); await fs.writeFile(aggregate, "preserved-month-and-calculatedAt");
  const request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }; await f.make(true).loadSources(request);
  const pointer = path.join(f.root, "monthly_reports/company_sources/current.json"), beforePointer = await fs.readFile(pointer); let changed = false;
  const failing = f.make(true, { recalculateCompanyObservations: async () => { if (!changed) { changed = true; const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "changed-during-read"; await fs.writeFile(f.companyFile, JSON.stringify(master)); } return []; } });
  await assert.rejects(failing.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.deepEqual(await fs.readFile(pointer), beforePointer); assert.equal(await fs.readFile(aggregate, "utf8"), "preserved-month-and-calculatedAt");
  assert.equal((await failing.loadSources(request)).companies.find(company => company.companyId === "a").primaryName, "changed-during-read");
});

for (const corrupt of ["selected-body", "catalog", "pointer"]) test(`corrupt ${corrupt} is rejected without returning a stale result or changing originals`, async t => {
  const f = await fixture(t), projected = f.make(true), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  await projected.loadSources(request); const original = await fs.readFile(f.companyFile), base = path.join(f.root, "monthly_reports/company_sources"), pointer = JSON.parse(await fs.readFile(path.join(base, "current.json")));
  const corruptFile = corrupt === "selected-body" ? path.join(base, pointer.generation, sha("a") + ".json") : corrupt === "catalog" ? path.join(base, pointer.generation, "catalog.json") : path.join(base, "current.json");
  await fs.writeFile(corruptFile, "corrupt-derived-only"); await assert.rejects(projected.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); assert.deepEqual(await fs.readFile(f.companyFile), original);
});

test("continuous source changes never publish a mixed-generation catalog", async t => {
  const f = await fixture(t), pointer = path.join(f.root, "monthly_reports/company_sources/current.json"); let preparations = 0;
  const projected = f.make(true, { prepareCompanies: async companies => { const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "generation-" + (++preparations); await fs.writeFile(f.companyFile, JSON.stringify(master)); return companies; } });
  await assert.rejects(projected.loadSources({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(preparations, 2); await assert.rejects(fs.stat(pointer), { code: "ENOENT" });
});

test("only current and previous own derived generations remain after repeated source changes", async t => {
  const f = await fixture(t), projected = f.make(true), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  for (let i = 0; i < 4; i++) { const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.primaryName = "source-" + i; await fs.writeFile(f.companyFile, JSON.stringify(master)); await projected.loadSources(request); }
  const names = await fs.readdir(path.join(f.root, "monthly_reports/company_sources")); assert.equal(names.filter(name => name.startsWith("generation-")).length, 2);
  assert.equal(projected.sourceReadMetrics().companyCatalog.cleanupFailures, 0); assert.equal(projected.sourceReadMetrics().catalogFullReads, 4);
});

async function smallGenerationFixture(t, options = {}) {
  const root = await temporary(t), directory = path.join(root, "monthly_reports/company_sources");
  const original = path.join(root, "original.txt"); await fs.writeFile(original, "original-must-remain");
  let revision = 1, changing = false, failure = null;
  const raw = { companyId: "a", primaryName: "selected", placeIds: ["a"] };
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "r" + revision,
    projectCapacityCompany: company => ({ companyId: company.companyId }),
    loadFullCatalog: async () => { if (failure) throw failure; if (changing) revision++;
      return { companies: [{ companyId: "a" }], rawCompanies: new Map([["a", raw]]), regions: [], runs: [] }; }, ...options });
  const names = async () => (await fs.readdir(directory)).filter(name => /^generation-[a-f0-9]{32}$/.test(name)).sort();
  return { root, directory, original, catalog, names, raw, next: () => revision++, change: () => { changing = true; revision++; },
    fail: error => { failure = error; }, read: () => catalog.readCompanyCatalog("a") };
}

test("twenty repeatedly changing reads remove every unpublished attempt without growing stored generations", async t => {
  const f = await smallGenerationFixture(t); f.change();
  for (let index = 0; index < 20; index++) await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await f.names(), []); assert.equal(f.catalog.stats().abandonedGenerationsRemoved, 40);
  assert.equal(f.catalog.stats().abandonedCleanupFailures, 0);
  assert.equal(await fs.readFile(f.original, "utf8"), "original-must-remain");
});

test("failed replacements preserve the published current and previous generation byte for byte", async t => {
  const f = await smallGenerationFixture(t); await f.read(); f.next(); await f.read();
  const names = await f.names(), pointer = await fs.readFile(path.join(f.directory, "current.json")), saved = [];
  for (const name of names) for (const file of await fs.readdir(path.join(f.directory, name))) saved.push([name, file, await fs.readFile(path.join(f.directory, name, file))]);
  assert.equal(names.length, 2); f.change(); await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.deepEqual(await f.names(), names); assert.deepEqual(await fs.readFile(path.join(f.directory, "current.json")), pointer);
  for (const [name, file, bytes] of saved) assert.deepEqual(await fs.readFile(path.join(f.directory, name, file)), bytes);
});

test("load and oversized-company failures clean only their newly created unpublished generation", async t => {
  const failed = await smallGenerationFixture(t); const error = Error("source failed"); failed.fail(error);
  await assert.rejects(failed.read(), caught => caught === error); assert.deepEqual(await failed.names(), []);
  const oversized = await smallGenerationFixture(t, { maxCompanyBytes: 128 }); oversized.raw.large = "x".repeat(256);
  await assert.rejects(oversized.read(), { code: "MONTHLY_COMPANY_SOURCE_TOO_LARGE" }); assert.deepEqual(await oversized.names(), []);
});

test("write failure removes its partial generation and uncertain rename preserves a freshly published pointer", async t => {
  const writing = await smallGenerationFixture(t), originalOpen = fs.open, originalRename = fs.rename;
  try {
    fs.open = async function(file, ...args) { if (String(file).startsWith(writing.directory + path.sep) && /^[a-f0-9]{64}[.]json$/.test(path.basename(String(file)))) throw Object.assign(Error(), { code: "EACCES" }); return originalOpen.call(this, file, ...args); };
    await assert.rejects(writing.read(), { code: "EACCES" }); assert.deepEqual(await writing.names(), []);
  } finally { fs.open = originalOpen; }
  const renaming = await smallGenerationFixture(t);
  try {
    fs.rename = async function(from, to) { await originalRename.call(this, from, to); if (to === path.join(renaming.directory, "current.json")) throw Object.assign(Error(), { code: "EIO" }); };
    await assert.rejects(renaming.read(), { code: "EIO" });
    const pointer = JSON.parse(await fs.readFile(path.join(renaming.directory, "current.json")));
    assert.deepEqual(await renaming.names(), [pointer.generation]);
    assert.equal(JSON.parse(await fs.readFile(path.join(renaming.directory, pointer.generation, sha("a") + ".json"))).companyId, "a");
  } finally { fs.rename = originalRename; }
  assert.equal((await renaming.read()).rawCompanies.get("a").primaryName, "selected");
});

test("unremovable abandoned generations reach a hard count cap rather than growing on later reads", async t => {
  const f = await smallGenerationFixture(t, { maxStoredGenerations: 3, maxGenerationBytes: 4096 }), originalUnlink = fs.unlink;
  f.change();
  try {
    fs.unlink = async function(file, ...args) { if (String(file).startsWith(f.directory + path.sep) && /^[a-f0-9]{64}[.]json$/.test(path.basename(String(file)))) throw Object.assign(Error(), { code: "EACCES" }); return originalUnlink.call(this, file, ...args); };
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" });
    assert.equal((await f.names()).length, 3);
    await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" }); assert.equal((await f.names()).length, 3);
    assert.equal(f.catalog.stats().abandonedCleanupFailures, 3); assert.equal(f.catalog.stats().storageLimitStops, 2);
  } finally { fs.unlink = originalUnlink; }
  assert.equal(await fs.readFile(f.original, "utf8"), "original-must-remain");
});

test("prebuild byte budget reserves the next generation without deleting preexisting directories", async t => {
  const f = await smallGenerationFixture(t, { maxGenerationBytes: 256, maxStoredBytes: 512 }), name = "generation-" + "a".repeat(32);
  const full = path.join(f.directory, name); await fs.mkdir(full, { recursive: true });
  const file = path.join(full, sha("orphan") + ".json"), bytes = Buffer.alloc(500, 1); await fs.writeFile(file, bytes);
  await assert.rejects(f.read(), { code: "MONTHLY_COMPANY_SOURCE_STORAGE_LIMIT" });
  assert.deepEqual(await f.names(), [name]); assert.deepEqual(await fs.readFile(file), bytes);
  assert.equal(f.catalog.stats().fullCatalogReads, 0);
});

test("complete rank metadata cannot bypass the compact catalog byte bound", async t => {
  const root = await temporary(t), company = rawCompanies().a;
  company.keywords.k.runs[0].unknownMetadata = "rank-metadata-".repeat(200);
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "unchanged-raw-source", maxCatalogBytes: 512,
    projectCapacityCompany: compactMonthlyCapacityCompany, loadFullCatalog: async () => ({ companies: [{ companyId: "a" }],
      rawCompanies: new Map([["a", company]]), regions: [], runs: [] }) });
  await assert.rejects(catalog.readCatalog(), { code: "MONTHLY_COMPANY_SOURCE_TOO_LARGE" });
  const files = await fs.readdir(path.join(root, "monthly_reports/company_sources"));
  assert.deepEqual(files, [], "an oversized rank catalog publishes no pointer or partial generation");
});

test("an unverifiable fresh pointer preserves abandoned attempts instead of guessing what can be removed", async t => {
  const root = await temporary(t), directory = path.join(root, "monthly_reports/company_sources");
  let revision = 0;
  const catalog = createMonthlyCompanySourceCatalog({ dataDir: root, readRevision: async () => "r" + revision,
    projectCapacityCompany: company => ({ companyId: company.companyId }),
    loadFullCatalog: async () => {
      revision++;
      await fs.writeFile(path.join(directory, "current.json"), "invalid-pointer-must-remain");
      return { companies: [{ companyId: "a" }], rawCompanies: new Map([["a", { companyId: "a" }]]), regions: [], runs: [] };
    } });
  await assert.rejects(catalog.readCompanyCatalog("a"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.equal((await fs.readdir(directory)).filter(name => /^generation-[a-f0-9]{32}$/.test(name)).length, 2);
  assert.equal(catalog.stats().abandonedCleanupFailures, 2);
  assert.equal(catalog.stats().abandonedGenerationsRemoved, 0);
  assert.equal(await fs.readFile(path.join(directory, "current.json"), "utf8"), "invalid-pointer-must-remain");
});

test("only explicit source-read opt-in removes the intermediate catalog assertion and retains both read boundaries", async t => {
  const f = await fixture(t), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  const generic = f.make(true);
  await generic.loadSources(request);
  let before = generic.sourceReadMetrics().companyCatalog.revisionReads;
  await generic.loadSources(request);
  assert.equal(generic.sourceReadMetrics().companyCatalog.revisionReads - before, 4,
    "default catalog has its original three assertions, plus the final source assertion");
  const optedIn = f.make(true, { useSourceReadValidationBoundary: true });
  await optedIn.loadSources(request);
  before = optedIn.sourceReadMetrics().companyCatalog.revisionReads;
  await optedIn.loadSources(request);
  assert.equal(optedIn.sourceReadMetrics().companyCatalog.revisionReads - before, 3,
    "opt-in retains initial revision, catalog-end revision and source-end revision");
  assert.throws(() => f.make(true, { useSourceReadValidationBoundary: "true" }), TypeError);
});

async function validationBoundaryFixture(t, { maxCachedRunBytes } = {}) {
  const f = await fixture(t); let loads = 0, mutation = null, trigger = "", lastBoundary = null, lastData = null;
  const helper = createMonthlyCompanyRecalculation({ cacheDirectory: path.join(f.root, "boundary-run-cache"), cacheVersion: "boundary-fixture-v1",
    ...(maxCachedRunBytes ? { maxCachedRunBytes } : {}), useSourceReadValidationBoundary: true,
    projectCorrectionCompany: compactMonthlyCapacityCompany,
    loadRun: async id => {
      loads++;
      if (trigger === "build" && mutation) { const fn = mutation; mutation = null; await fn(); }
      return { run: { id, collectionQuality: { status: "complete" } }, availability: { items: [{ placeId: "10" }, { placeId: "20" }] } };
    }, companyProductAvailabilityMatch: availabilityMatch,
    applyCompanyManualCorrection: (item, company) => ({ ...item, supply: company.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 4 } }),
    buildHistoryObservations: ({ availability }) => availability.items.map(item => ({ ...item, stayDate: "2026-08-02", productType: "lodging", inventoryEvidenceVersion: 4 })) });
  const adapter = f.make(true, { useSourceReadValidationBoundary: true, recalculateCompanyObservations: async (request, data, options) => {
    lastData = data; lastBoundary = options.sourceReadValidationBoundary;
    assert.equal(lastBoundary.owner, data._companySource); assert.equal(lastBoundary.revision, data._companySource.revision);
    assert.equal(Object.isFrozen(lastBoundary), true); assert.equal(lastBoundary.isActive(), true);
    const rows = await helper(request, data, options);
    if (trigger === "hit" && mutation) { const fn = mutation; mutation = null; await fn(); }
    return rows;
  } });
  return { ...f, adapter, helper, loads: () => loads, arm: (phase, fn) => { trigger = phase; mutation = fn; },
    last: () => ({ boundary: lastBoundary, data: lastData }) };
}

test("one validated source boundary reduces repeated cache inspections while preserving complete paired results", async t => {
  const f = await fixture(t);
  const dependencies = { cacheDirectory: path.join(f.root, "boundary-parity-cache"), cacheVersion: "boundary-parity-v1",
    projectCorrectionCompany: compactMonthlyCapacityCompany,
    loadRun: async id => ({ run: { id, collectionQuality: { status: "complete" } }, availability: { items: [{ placeId: "10" }, { placeId: "20" }] } }),
    companyProductAvailabilityMatch: availabilityMatch,
    applyCompanyManualCorrection: (item, company) => ({ ...item, supply: company.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 4 } }),
    buildHistoryObservations: ({ availability }) => availability.items.map(item => ({ ...item, stayDate: "2026-08-02", productType: "lodging", inventoryEvidenceVersion: 4 })) };
  const generic = f.make(true, { recalculateCompanyObservations: createMonthlyCompanyRecalculation(dependencies) });
  const optedIn = f.make(true, { useSourceReadValidationBoundary: true,
    recalculateCompanyObservations: createMonthlyCompanyRecalculation({ ...dependencies, useSourceReadValidationBoundary: true }) });
  const request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  await generic.loadSources(request); await optedIn.loadSources(request);
  let before = generic.sourceReadMetrics().companyCatalog.revisionReads;
  const expected = await generic.loadSourcesWithCatalog(request);
  const genericChecks = generic.sourceReadMetrics().companyCatalog.revisionReads - before;
  before = optedIn.sourceReadMetrics().companyCatalog.revisionReads;
  const actual = await optedIn.loadSourcesWithCatalog(request);
  const boundaryChecks = optedIn.sourceReadMetrics().companyCatalog.revisionReads - before;
  assert.equal(genericChecks, 5, "three catalog assertions, one cache-hit assertion and one final source assertion");
  assert.equal(boundaryChecks, 3, "one acquisition, one catalog-end and one final source inspection");
  assert.deepEqual(json(actual), json(expected), "the complete source/catalog contract is unchanged");
  for (const [type, targetId] of [["region", "pocheon"], ["keyword", "포천글램핑"], ["industry", "__industry_all__"]]) {
    const scoped = { ...request, type, targetId };
    assert.deepEqual(json(await optedIn.loadSourcesWithCatalog(scoped)), json(await generic.loadSourcesWithCatalog(scoped)), type);
  }
});

for (const phase of ["build", "hit"]) for (const changed of ["source", "identity"]) {
  test(`an opted-in ${phase} cannot return or issue a report after a mid-read ${changed} change`, async t => {
    const f = await validationBoundaryFixture(t), request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
    if (phase === "hit") await f.adapter.loadSources(request);
    const reportDirectory = path.join(f.root, "issued-reports"), protectedReport = path.join(reportDirectory, "existing-issued-report.json");
    await fs.mkdir(reportDirectory); await fs.writeFile(protectedReport, "previous-issued-report-and-calculatedAt");
    const beforeReport = await fs.readFile(protectedReport), beforeStat = await fs.stat(protectedReport, { bigint: true });
    f.arm(phase, async () => {
      if (changed === "source") await fs.appendFile(f.historyFile, JSON.stringify({ ...daily("2026-08-03", 19), companyKey: "a", runId: "run1" }) + "\n");
      else {
        const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.placeIds = ["new-provider-identity"];
        await fs.writeFile(f.companyFile, JSON.stringify(master));
      }
    });
    const service = require("./lib/monthly_reports.cjs").createMonthlyReportService({ dataDir: reportDirectory,
      loadSources: f.adapter.loadSources, now: () => new Date("2026-10-22T00:00:00Z") });
    await assert.rejects(service.preview(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
    assert.deepEqual(await fs.readdir(reportDirectory), [path.basename(protectedReport)], "no new report file or preview-derived publication");
    assert.deepEqual(await fs.readFile(protectedReport), beforeReport);
    const afterStat = await fs.stat(protectedReport, { bigint: true });
    for (const key of ["size", "mtimeNs", "ctimeNs", "ino", "dev"]) assert.equal(afterStat[key], beforeStat[key], key);
    const failed = f.last(); assert.equal(failed.boundary.isActive(), false, "failure always closes the private capability");
    await assert.rejects(f.helper(request, failed.data, { sourceReadValidationBoundary: failed.boundary }),
      error => error.code === "MONTHLY_RECALCULATION_UNAVAILABLE");
    const oldRevision = failed.boundary.revision, loads = f.loads();
    await f.adapter.loadSources(request);
    assert.notEqual(f.last().boundary.revision, oldRevision);
    assert.ok(f.loads() > loads, "next fresh source revision cannot reuse the previous revision's corrected run rows");
    assert.equal(f.last().boundary.isActive(), false, "success also closes the capability");
  });
}

test("final fresh validation covers oversize fallback, no-target reads and recovered context failures", async t => {
  const request = { type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" };
  const fallback = await validationBoundaryFixture(t, { maxCachedRunBytes: 128 });
  fallback.arm("hit", async () => fs.appendFile(fallback.historyFile, "changed-source\n"));
  await assert.rejects(fallback.adapter.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(fallback.helper.stats().runRowOversizeFallbacks, 1);
  assert.equal(fallback.last().boundary.isActive(), false);
  const noTarget = await validationBoundaryFixture(t);
  noTarget.arm("hit", async () => fs.appendFile(noTarget.historyFile, "changed-with-no-target\n"));
  await assert.rejects(noTarget.adapter.loadSources({ ...request, targetId: "not-in-catalog" }), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(noTarget.loads(), 0, "no eligible target still reaches the final fresh assertion without loading a run");
  assert.equal(noTarget.last().boundary.isActive(), false);
  for (const empty of [false, true]) {
    const f = await fixture(t);
    const adapter = f.make(true, { useSourceReadValidationBoundary: true,
      ...(empty ? { recalculateCompanyObservations: async (_request, _data, { sourceReadValidationBoundary }) => {
        assert.equal(sourceReadValidationBoundary.isActive(), true); return [];
      } } : {}),
      readContext: async () => { await fs.appendFile(f.historyFile, "changed-during-context\n"); throw Error("recoverable local context failure"); } });
    await assert.rejects(adapter.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  }
  const cancelled = await fixture(t); let cancelledBoundary;
  const adapter = cancelled.make(true, { useSourceReadValidationBoundary: true,
    recalculateCompanyObservations: async (_request, _data, { sourceReadValidationBoundary }) => {
      cancelledBoundary = sourceReadValidationBoundary; throw Error("cancelled source reconstruction");
    } });
  await assert.rejects(adapter.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(cancelledBoundary.isActive(), false, "callback failure cannot leave its boundary active");
});

function pairValues(pair) {
  return json({ source: pair.source, catalog: { ...pair.catalog, rawCompanies: [...pair.catalog.rawCompanies] } });
}
function assertFrozenJson(value) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item !== "object") continue;
    assert.equal(Object.isFrozen(item), true);
    for (const key of Object.keys(item)) pending.push(item[key]);
  }
}

for (const indexed of [false, true]) test(`explicit frozen metadata sharing preserves all four complete source/catalog values (indexed=${indexed})`, async t => {
  const f = await fixture(t, { indexed }), master = JSON.parse(await fs.readFile(f.companyFile));
  master.companies.a.keywords.k.runs[0].unknownMetadata = { nested: [{ nullable: null, zero: 0, enabled: false }], warnings: ["saved-rank-metadata"] };
  await fs.writeFile(f.companyFile, JSON.stringify(master));
  const generic = f.make(true), shared = f.make(true, { shareFrozenCatalogMetadata: true });
  for (const [type, targetId] of [["company", "a"], ["region", "pocheon"], ["keyword", "포천글램핑"], ["industry", "__industry_all__"]]) {
    for (const month of ["2026-07", "2026-08", "2026-09"]) {
      const request = { type, targetId, month, cutoffDate: "2026-09-30" };
      const actual = await shared.loadSourcesWithCatalog(request), expected = await generic.loadSourcesWithCatalog(request);
      assert.deepEqual(pairValues(actual), pairValues(expected), `${type}/${month}`);
      if (type === "industry") assert.deepEqual(json(compactIndustrySources(actual.source, actual.catalog)), json(compactIndustrySources(expected.source, expected.catalog)));
    }
  }
  const metrics = shared.sourceReadMetrics().companyCatalog;
  assert.equal(metrics.sharedMetadataBuilds, 1, "one independent frozen tree per verified generation");
  assert.equal(metrics.sharedMetadataReads, 12);
  assert.equal(generic.sourceReadMetrics().companyCatalog.sharedMetadataBuilds, 0);
  assert.match(source, /shareFrozenCatalogMetadata:\s*true/, "the actual application explicitly opts in");
});

test("frozen metadata shares values while each map and selected full company remain isolated", async t => {
  const f = await fixture(t), adapter = f.make(true, { shareFrozenCatalogMetadata: true });
  const broad = { type: "industry", targetId: "__industry_all__", month: "2026-08", cutoffDate: "2026-08-31" };
  const first = await adapter.loadSourcesWithCatalog(broad), second = await adapter.loadSourcesWithCatalog(broad);
  for (const key of ["companies", "regions", "runs"]) {
    assert.strictEqual(first.catalog[key], second.catalog[key]); assertFrozenJson(first.catalog[key]);
  }
  assert.notStrictEqual(first.catalog.rawCompanies, second.catalog.rawCompanies);
  assert.strictEqual(first.catalog.rawCompanies.get("b"), second.catalog.rawCompanies.get("b"));
  assertFrozenJson(first.catalog.rawCompanies.get("b"));
  assert.throws(() => { first.catalog.rawCompanies.get("b").manualCorrection.productStockCorrections.push({ count: 99 }); }, TypeError);
  first.catalog.rawCompanies.clear(); assert.equal(second.catalog.rawCompanies.size, 4);
  const selected = await adapter.loadSourcesWithCatalog({ ...broad, type: "company", targetId: "a" });
  const originalName = selected.catalog.rawCompanies.get("a").primaryName;
  assert.equal(Object.isFrozen(selected.catalog.rawCompanies.get("a")), false);
  selected.catalog.rawCompanies.get("a").primaryName = "private selected mutation";
  const body = await selected.catalog._companySource.readCompany("a"); body.primaryName = "another private mutation";
  const again = await adapter.loadSourcesWithCatalog({ ...broad, type: "company", targetId: "a" });
  assert.equal(again.catalog.rawCompanies.get("a").primaryName, originalName);
  assert.equal(second.catalog.rawCompanies.get("a").primaryName, originalName);
  assert.equal(adapter.sourceReadMetrics().companyCatalog.sharedMetadataBuilds, 1);
  const full = await adapter.catalog();
  assert.equal(Object.isFrozen(full.rawCompanies.get("a")), false);
  assert.ok(full.rawCompanies.get("a").largeUnusedOriginalField, "public full catalog contract remains complete and mutable");
});

test("generic mutable copies and original full catalogs are never frozen by the sharing opt-in", async t => {
  const f = await fixture(t), generic = f.make(true);
  const request = { type: "industry", targetId: "__industry_all__", month: "2026-08", cutoffDate: "2026-08-31" };
  const first = await generic.loadSourcesWithCatalog(request), original = pairValues(first);
  first.catalog.companies[0].primaryName = "mutable generic value";
  first.catalog.runs[0].collectionQuality.status = "mutable caller edit";
  first.catalog.rawCompanies.get("b").manualCorrection.productStockCorrections.push({ productId: "private", count: 3 });
  first.catalog.rawCompanies.delete("a");
  assert.deepEqual(pairValues(await generic.loadSourcesWithCatalog(request)), original);
  const originalFull = { companies: [{ companyId: "a", placeIds: ["10"] }], regions: [{ id: "pocheon" }], runs: json(runs), rawCompanies: new Map([["a", rawCompanies().a]]) };
  const owned = createMonthlyCompanySourceCatalog({ dataDir: await temporary(t), readRevision: async () => "stable-source",
    loadFullCatalog: async () => originalFull, projectCapacityCompany: compactMonthlyCapacityCompany, shareFrozenCatalogMetadata: true });
  await owned.readCatalog();
  assert.equal(Object.isFrozen(originalFull.companies), false);
  assert.equal(Object.isFrozen(originalFull.companies[0].placeIds), false);
  assert.equal(Object.isFrozen(originalFull.rawCompanies.get("a").manualCorrection), false);
  originalFull.companies[0].placeIds.push("still-mutable-original");
  originalFull.rawCompanies.get("a").manualCorrection.lodgingBasisTotal = 25;
  assert.deepEqual((await owned.readCatalog()).companies[0].placeIds, ["10"], "shared tree owns a separate JSON copy");
});

test("frozen sharing reloads saved generations and rejects changed sources without reusing the old tree", async t => {
  const f = await fixture(t), request = { type: "industry", targetId: "__industry_all__", month: "2026-08", cutoffDate: "2026-08-31" };
  const adapter = f.make(true, { shareFrozenCatalogMetadata: true, useSourceReadValidationBoundary: true });
  const before = await adapter.loadSourcesWithCatalog(request);
  const restarted = f.make(true, { shareFrozenCatalogMetadata: true, useSourceReadValidationBoundary: true });
  assert.deepEqual(pairValues(await restarted.loadSourcesWithCatalog(request)), pairValues(before));
  assert.equal(restarted.sourceReadMetrics().catalogFullReads, 0);
  assert.equal(restarted.sourceReadMetrics().companyCatalog.savedHits, 1);
  let changed = false;
  const changing = f.make(true, { shareFrozenCatalogMetadata: true, useSourceReadValidationBoundary: true,
    readContext: async () => {
      if (!changed) { changed = true; const master = JSON.parse(await fs.readFile(f.companyFile)); master.companies.a.placeIds = ["new-source-identity"]; await fs.writeFile(f.companyFile, JSON.stringify(master)); }
      return { sources: [], networkAttempted: false };
    } });
  await assert.rejects(changing.loadSourcesWithCatalog(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  const after = await changing.loadSourcesWithCatalog(request);
  assert.deepEqual(after.catalog.companies.find(company => company.companyId === "a").placeIds, ["new-source-identity"]);
  assert.notStrictEqual(after.catalog.companies, before.catalog.companies);
  assert.equal(changing.sourceReadMetrics().companyCatalog.sharedMetadataBuilds, 2);
  const absent = await changing.loadSourcesWithCatalog({ ...request, type: "company", targetId: "absent" });
  assert.equal(absent.catalog.rawCompanies.has("absent"), false);
  await assert.rejects(after.catalog._companySource.readCompany("absent"), { code: "MONTHLY_COMPANY_SOURCE_COMPANY_NOT_FOUND" });
});

test("frozen sharing is an independent explicit boolean opt-in", async t => {
  const f = await fixture(t);
  for (const invalid of [null, 0, 1, "true", {}]) {
    assert.throws(() => f.make(true, { shareFrozenCatalogMetadata: invalid }), TypeError);
    assert.throws(() => createMonthlyCompanySourceCatalog({ dataDir: f.root, readRevision: f.readRevision,
      loadFullCatalog: async () => ({}), projectCapacityCompany: compactMonthlyCapacityCompany, shareFrozenCatalogMetadata: invalid }), TypeError);
  }
});
