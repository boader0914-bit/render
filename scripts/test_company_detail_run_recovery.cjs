"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8").replace(/\r\n/g, "\n");
const declaration = name => { const text = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0]; assert.ok(text, name); return text; };
const copy = value => JSON.parse(JSON.stringify(value));

function runHarness() {
  const company = { companyId: "selected", placeIds: ["1"] }, calls = [];
  const files = ["manifest.json", "a_overall_place_rank.csv", "b_ad_place_list.csv", "c_naver_place_glamping_clusters.csv", "d_glamping_crawl_test.csv", "e_yeogi_manual_import.csv"];
  const rows = {
    "a_overall_place_rank.csv": [{ name: "overall", selected: true }, { name: "other", selected: false }],
    "b_ad_place_list.csv": [{ name: "ad", selected: true }], "c_naver_place_glamping_clusters.csv": [{ name: "regional", selected: true }],
    "d_glamping_crawl_test.csv": [{ name: "platform", selected: true, channel: "야놀자" }, { name: "replaced", selected: true, channel: "여기어때" }],
    "e_yeogi_manual_import.csv": [{ name: "manual", selected: true, channel: "여기어때" }]
  };
  const manifest = { keyword: "경남글램핑", checkIn: "2026-10-01", collectionPurpose: "revenue_detail", collectionMode: "precision", bookingRangeDays: 21, productCoverage: { known: true } };
  const context = vm.createContext({ URL, performance, companyDetailReadDiagnostics: { getStore: () => null }, fs: { existsSync: () => true }, path,
    fsp: { stat: async () => ({ mtime: new Date("2026-10-01T00:00:00.000Z") }), readdir: async () => [...files],
      readFile: async filename => { calls.push("read:" + path.basename(filename)); return JSON.stringify(rows[path.basename(filename)]); } },
    resolveRunDir: () => "/mock/run", readManifest: async () => manifest, isIncompleteRunDirectory: () => false, allowsDerivedUpdates: () => true,
    runCollectedAt: () => "2026-10-01T00:00:00.000Z", runCollectedAtSource: () => "manifest.completedAt", provinceKeyForRun: () => "gyeongnam",
    PROVINCES: { gyeongnam: { label: "경남", mapBounds: {} }, local: {} }, manifestFile: (_m, _r, all, match) => all.find(match),
    readRunConditions: async () => ({ keyword: "경남글램핑", checkIn: "2026-10-01", checkOut: "2026-10-02", adults: 2, productMode: "all" }),
    parseCsv: JSON.parse, normalizeYeogiManualRows: values => values,
    companyDetailAvailabilityRows: values => values.filter(row => row.selected),
    summarizeAvailabilityRows: (values, _directory, companies, range) => { calls.push("availability"); return { items: values, companies, range }; },
    summarizeRegionalRows: () => { calls.push("regions"); return []; }, summarizeStats: () => { calls.push("stats"); return {}; },
    summarizeRankingRows: () => { calls.push("ranking"); return {}; }, buildDemandStructure: () => { calls.push("demand"); return {}; },
    readCollectionDiagnostics: async () => { calls.push("diagnostics"); return {}; }, summarizePlatformRows: () => { calls.push("platform"); return {}; },
    summarizeCompanyPlatforms: () => { calls.push("companyPlatforms"); return {}; }, buildRunRegionalOperations: () => { calls.push("regionalOperations"); return {}; },
    placeRankComparisonForRun: async () => ({}), displayNameForRun: () => "동일 회차", downloadLabelForFile: () => "file",
    SEARCH_MODES: {}, COLLECTION_MODES: {}, COLLECTION_PURPOSES: {}, PRODUCT_MODES: {}, collectionExecutionProfile: () => ({ key: "revenue_detail", label: "same", note: "same", collectRegional: true }),
    collectionDbRouteProfile: () => ({ key: "revenue_detail" }), runDateFromId: () => "2026-10-01"
  });
  vm.runInContext(["measureCompanyDetailPhase", "measureCompanyDetailSyncPhase", "companyDetailSavedRunMetadata", "loadRun"].map(declaration).join("\n"), context);
  const options = { companyDetailCompany: company, capacityCompanies: [company], skipCompanyMaster: true, skipHistory: true, skipTraffic: true,
    skipTourismVisitors: true, skipTourismVisitorHistory: true, skipTourismDemandStrengthHistory: true, skipTourismResourceDemandHistory: true, skipTourismDiversityHistory: true };
  return { context, options, calls, rows, files };
}

test("selected read-only recovery retains exact run metadata, source order and manual-platform replacement without unrelated projections", async () => {
  const f = runHarness(), fast = await f.context.loadRun("run", f.options), fastCalls = [...f.calls]; f.calls.length = 0;
  const full = await f.context.loadRun("run", { ...f.options, includeRankComparison: true });
  assert.deepEqual(copy(fast.run), copy(full.run)); assert.deepEqual(copy(fast.availability), copy(full.availability));
  assert.deepEqual(copy(fast.availability.items).map(row => row.name), ["overall", "ad", "regional", "platform", "manual"]);
  assert.deepEqual(Object.keys(fast).sort(), ["availability", "run"]);
  for (const key of ["regions", "stats", "ranking", "demand", "diagnostics", "platform", "companyPlatforms", "regionalOperations"]) {
    assert.equal(fastCalls.includes(key), false, key + " must not run for selected recovery"); assert.equal(f.calls.includes(key), true, key + " retains its normal result-page behavior");
  }
  assert.equal(fastCalls.filter(value => value.startsWith("read:")).length, 5);
});

test("missing any read-only protection flag keeps the complete legacy result path", async () => {
  const f = runHarness();
  for (const flag of ["skipCompanyMaster", "skipHistory", "skipTraffic", "skipTourismVisitors", "skipTourismVisitorHistory", "skipTourismDemandStrengthHistory", "skipTourismResourceDemandHistory", "skipTourismDiversityHistory"]) {
    // Static branch guard assertion avoids invoking provider/write paths merely
    // to test that a deliberately unprotected option is excluded.
    const condition = declaration("loadRun").match(/const companyDetailReadOnly = ([^]*?);\n  if \(companyDetailReadOnly\)/)?.[1];
    assert.ok(condition);
    assert.equal(vm.runInNewContext(condition, { options: { ...f.options, [flag]: false }, Array }), false, flag);
  }
});

test("all 20 selected candidates contribute their common maximum and final observation sort; snapshots are not projected twice", async () => {
  const runIds = Array.from({ length: 22 }, (_, i) => "run_" + String(i + 1).padStart(2, "0"));
  const company = { companyId: "selected", placeIds: ["1"], runIds }, loaded = [], snapshots = [];
  const manifestAt = id => "2026-10-" + id.slice(-2) + "T00:00:00.000Z";
  const actualAt = id => id === "run_22" ? "2026-10-01T00:00:00.000Z" : id === "run_21" ? "2026-10-28T00:00:00.000Z" : manifestAt(id);
  const context = vm.createContext({ performance, companyDetailReadDiagnostics: { getStore: () => null },
    boundedUnique: (values, n) => [...new Set(values)].slice(0, n), companyRankObservationTimeMap: () => new Map(), companyProductStoredRunTimeMap: () => new Map(),
    resolveRunDir: id => id, readManifest: async id => ({ keyword: "test", id }), fsp: { stat: async id => ({ mtime: new Date(manifestAt(id)) }), readdir: async () => ["manifest.json"] },
    isIncompleteRunDirectory: () => false, runCollectedAt: id => manifestAt(id),
    companyProductRunObservedAt: (_company, _observations, id) => actualAt(id), companyProductAvailabilityMatch: () => "place_id",
    loadRun: async (id, options) => { loaded.push({ id, options }); return { run: { id, collectedAt: manifestAt(id) }, availability: { items: [{ id, inventoryEvidence: { capacityBasis: { currentObservedMaximum: id === "run_03" ? 31 : 16 } } }] } }; },
    applyCompanyManualCorrection: value => value, companyMaximumRoomCapacity: () => 16,
    applyInventoryEvidence: value => ({ ...value, inventoryEvidence: { ...value.inventoryEvidence, version: 4, capacityBasis: { count: value.inventoryCapacityBaseline.lodging } } }),
    compactCompanyProductSnapshot: (item, run) => { snapshots.push(run.id); return { products: [{ name: run.id }], capacityBasis: item.inventoryEvidence.capacityBasis }; },
    companySalesSignalFromItem: item => ({ maximum: item.inventoryCapacityBaseline.lodging }), companyRevenueSnapshotFromItem: () => ({}),
    buildHistoryObservations: ({ run, availability }) => [{ runId: run.id, total: availability.items[0].inventoryCapacityBaseline.lodging }], legacyProductPreviewFromItem: () => null
  });
  vm.runInContext(["measureCompanyDetailPhase", "measureCompanyDetailSyncPhase", "companyProductSourceRunIds", "companyProductRecoveryRunIds", "recoverCompanyProductSourceFromRuns"].map(declaration).join("\n"), context);
  const result = await context.recoverCompanyProductSourceFromRuns(company, [], { scoped: true });
  assert.deepEqual(loaded.map(row => row.id), [...runIds].reverse().slice(0, 20)); assert.equal(loaded.length, 20);
  assert.equal(result.productSnapshot.products[0].name, "run_21", "final actual-observation ordering is independent of initial candidate metadata ordering");
  assert.equal(result.evidenceProjections.length, 20); assert.equal(result.productSnapshot.capacityBasis.count, 31);
  for (const projection of result.evidenceProjections) assert.equal(projection.observations[0].total, 31, "the last candidate's higher maximum applies to all candidates");
  assert.equal(snapshots.length, 20, "each candidate's exact product snapshot is reused for selection");
  assert.ok(loaded.every(row => row.options.skipCompanyMaster && row.options.skipHistory && row.options.capacityCompanies[0] === company));
});
