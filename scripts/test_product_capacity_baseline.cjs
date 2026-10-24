"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { observedProductCapacityEvidence, productCapacityBaselineAt, compactProductCapacityEvidence, mergeProductCapacityBaselines } = require("./lib/product_capacity_baseline.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const room = (id, stock, extra = {}) => ({ bizItemId: id, name: id, saleType: "숙박", date: "2026-09-20", stock, bookingCount: 0, occupiedBookingCount: 0, price: 100000, open: true, ...extra });
const company = { companyId: "cmp_pika", placeIds: ["123"], bookingBusinessIds: ["456"], manualCorrection: null };
test("only exact-company normal normalized product witnesses enter cumulative maxima and future observations cannot rewrite an earlier baseline", () => {
  const item = { weeklyProductDetails: [room("a", 14), room("a", 99, { collectionFailed: true, date: "2026-09-21" }),
    room("b", 8), room("error", 90, { responseStatus: 403 }), room("zero", 0), room("conflict", 1, { bookingCount: 2 }),
    room("numbered", 20, { listType: "객실별 예약리스트" })] };
  const early = observedProductCapacityEvidence(item, company, { runId: "early", collectedAt: "2026-09-01T01:00:00Z" });
  assert.deepEqual(early.map(row => [row.productId, row.count]), [["a", 14], ["b", 8], ["numbered", 1]]);
  const future = { ...early[0], count: 16, runId: "future", collectedAt: "2026-09-25T01:00:00Z" };
  assert.equal(productCapacityBaselineAt([...early, future], company.companyId, "2026-09-20T01:00:00Z").lodgingProducts.a.count, 14);
  assert.equal(productCapacityBaselineAt([...early, future], company.companyId, "2026-09-26T01:00:00Z").lodgingProducts.a.count, 16);
  assert.deepEqual(productCapacityBaselineAt(early, "other", "2026-09-26T01:00:00Z").lodgingProducts, {});
  assert.deepEqual(productCapacityBaselineAt(early, company.companyId, "invalid").lodgingProducts, {});
  const corrected = observedProductCapacityEvidence(item, { ...company, manualCorrection: { productStockCorrections: [{ bizItemId: "a", stayDate: "2026-09-20", observedStock: 14, correctedStock: 10, reason: "확인값" }] } }, { runId: "early", collectedAt: "2026-09-01T01:00:00Z" });
  assert.equal(corrected.find(row => row.productId === "a").count, 10);
  assert.equal(item.weeklyProductDetails[0].stock, 14, "original provider response remains unchanged");
});
test("capacity witnesses preserve first increases without retaining every repeated run", () => {
  const early = { companyId: "a", productId: "room", productType: "lodging", count: 10, collectedAt: "2026-09-01T01:00:00Z", runId: "one" };
  const rows = [early, { ...early, collectedAt: "2026-09-02T01:00:00Z", runId: "two" }, { ...early, count: 12, collectedAt: "2026-09-03T01:00:00Z", runId: "three" }];
  assert.deepEqual(compactProductCapacityEvidence(rows).map(row => row.runId), ["one", "three"]);
});
test("all-company reconstruction includes unreviewed firms, all keywords and prior months while respecting as-of time and failed-run exclusion", async () => {
  const runs = [
    { id: "future", collectedAt: "2026-10-01T01:00:00Z", keyword: "경남글램핑", checkIn: "2026-10-01", collectionQuality: { status: "complete" } },
    { id: "latest", collectedAt: "2026-09-24T01:00:00Z", keyword: "경남글램핑", checkIn: "2026-09-24", collectionQuality: { status: "complete" } },
    { id: "early", collectedAt: "2026-08-01T01:00:00Z", keyword: "진주글램핑", checkIn: "2026-08-01", bookingRangeDays: 1, collectionQuality: { status: "complete" } },
    { id: "blocked", collectedAt: "2026-09-22T01:00:00Z", keyword: "경남글램핑", collectionQuality: { status: "blocked" } }
  ];
  const current = { ...company, runIds: runs.map(row => row.id) }, seen = [], loaded = [];
  const data = { rawCompanies: new Map([[current.companyId, current]]), companies: [{ companyId: current.companyId }], runs };
  const f = createMonthlyCompanyRecalculation({ recalculateAllInventory: true,
    readProductCapacityEvidence: async () => [{ companyId: current.companyId, productId: "room", productType: "lodging", count: 20, collectedAt: "2026-09-26T01:00:00Z" }],
    loadRun: async id => { loaded.push(id); return { run: { id }, availability: { items: [{ placeId: "123", weeklyProductDetails: [room("room", id === "early" ? 14 : 7)] }] } }; },
    companyProductAvailabilityMatch: (c, item) => c.placeIds.includes(item.placeId),
    applyCompanyManualCorrection: item => { seen.push(item.inventoryCapacityBaseline?.lodgingProducts?.room?.count); return { ...item, inventoryEvidence: { version: 5 } }; },
    buildHistoryObservations: value => [{ stayDate: "2026-09-26", inventoryEvidenceVersion: 5, productType: "lodging", count: value.availability.items[0].inventoryCapacityBaseline.lodgingProducts.room.count }]
  });
  const rows = await f({ type: "company", targetId: current.companyId, month: "2026-09", cutoffDate: "2026-09-30" }, data);
  assert.deepEqual(loaded, ["early", "latest"]); assert.deepEqual(seen, [14, 14]);
  assert.equal(rows.at(-1).count, 14); assert.ok(rows.every(row => row.companyId === current.companyId && row.readOnlyRecalculated));
  assert.equal(rows.productCapacityEvidence.length, 3);
  assert.equal(current.manualCorrection, null, "an unreviewed capacity is never converted to a manual DB review");
});
test("merging a smaller current maximum cannot replace an earlier larger same-product witness", () => {
  const historical = { room: { count: 14, source: "normal_saved_product_response", runId: "old", observedAt: "2026-05-01T00:00:00Z" } };
  assert.deepEqual(mergeProductCapacityBaselines(historical, { room: { count: 7, runId: "now" }, second: 2 }), { ...historical, second: 2 });
  assert.equal(mergeProductCapacityBaselines({ room: 7 }, historical).room.count, 14);
  assert.equal(historical.room.runId, "old");
});
function coreDependencies(loadRun) {
  return { loadRun, companyProductAvailabilityMatch: (c, item) => c.placeIds.includes(item.placeId),
    applyCompanyManualCorrection: (item, c) => applyInventoryEvidence({ ...item, dayUsePresence: "absent", inventoryCapacityBaseline: {
      ...item.inventoryCapacityBaseline, lodging: 16, lodgingOverride: { count: c.manualCorrection.lodgingBasisTotal } } }),
    buildHistoryObservations: value => value.availability.items.flatMap(item => item.inventoryEvidence.lodging.rows.map(row => ({ ...row,
      stayDate: row.date, productType: "lodging", supply: row.total, inventoryEvidenceVersion: item.inventoryEvidence.version,
      witnesses: item.inventoryEvidence.lodging.productCapacityEvidence }))) };
}
test("250 cross-keyword runs retain an older omitted maximum through verified persistent milestones and never borrow a future maximum", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "long-product-capacity-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("long-product-capacity-")); await fs.rm(root, { recursive: true, force: true }); });
  const runs = Array.from({ length: 250 }, (_, i) => {
    const collectedAt = new Date(Date.UTC(2026, 0, 1 + i)).toISOString();
    return { id: "run_" + i, keyword: i % 2 ? "지역숙소" : "광역글램핑", collectedAt, checkIn: collectedAt.slice(0, 10), bookingRangeDays: 1,
      collectedAtSource: "manifest", collectionQuality: { status: "complete" } };
  });
  const hidden = runs[130], future = { ...runs[249], id: "future", collectedAt: "2026-09-25T00:00:00.000Z", checkIn: "2026-09-25" };
  for (const run of [hidden, future]) { const dir = path.join(root, "outputs", run.id); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(run)); }
  const current = { ...company, runIds: runs.slice(0, 120).map(row => row.id), lastRunId: runs[249].id,
    keywords: { local: { keyword: "지역숙소", runs: runs.slice(-80).filter(row => row.keyword === "지역숙소").map(row => ({ runId: row.id })) },
      broad: { keyword: "광역글램핑", runs: runs.slice(-80).filter(row => row.keyword === "광역글램핑").map(row => ({ runId: row.id })) } },
    manualCorrection: { lodgingBasisTotal: 16 } };
  assert.ok(!current.runIds.includes(hidden.id)); assert.ok(Object.values(current.keywords).every(value => !value.runs.some(row => row.runId === hidden.id)));
  const store = createProductCapacityStore({ dataDir: root }), evidence = [hidden, future].map(run => ({ companyId: current.companyId, productId: "room", productType: "lodging", count: run === hidden ? 14 : 18,
    collectedAt: run.collectedAt, sourceDate: run.checkIn, runId: run.id, source: "normal_saved_product_response" }));
  await store.publish(evidence, { companies: new Map([[current.companyId, current]]), sourceRevision: "verified-long-history", assertCurrent: async () => {} });
  const loaded = [], helper = createMonthlyCompanyRecalculation({ ...coreDependencies(async id => {
    loaded.push(id); const run = runs.find(row => row.id === id);
    return { run: { id }, availability: { items: [{ placeId: "123", checkIn: run.checkIn, bookingRangeDays: 1,
      weeklyProductDetails: [room("room", 7, { date: run.checkIn }), room("second", 2, { date: run.checkIn })] }] } };
  }), recalculateAllInventory: true, readPersistedProductCapacityEvidence: companies => store.readForCompanies(companies) });
  const data = { rawCompanies: new Map([[current.companyId, current]]), companies: [{ companyId: current.companyId }], runs: [...runs, future] };
  const result = await helper({ type: "company", targetId: current.companyId, month: "2026-09", cutoffDate: "2026-09-30" }, data);
  assert.ok(result.length > 0); assert.ok(!loaded.includes(hidden.id), "the old normal run really is outside bounded company references");
  assert.ok(!loaded.includes(future.id));
  for (const row of result) {
    assert.equal(row.witnesses.find(product => product.productKey === "room").count, 14, "normal as-of persistent maximum survives 250 runs");
    assert.equal(row.phoneBookings, 7); assert.equal(row.phoneRevenue, 700000); assert.equal(row.phoneMissingPriceBookings, 0);
  }
  assert.equal(result.productCapacityWarnings.length, 0);
  assert.ok(result.productCapacityEvidence.some(row => row.runId === hidden.id && row.count === 14));
});
test("run-row cache binds as-of persistent maxima even when its original catalog revision is unchanged", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-capacity-run-cache-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "product-capacity-run-cache-")); await fs.rm(root, { recursive: true, force: true }); });
  const current = { ...company, runIds: ["new"], manualCorrection: { lodgingBasisTotal: 16 } }, run = { id: "new", keyword: "지역숙소", collectedAt: "2026-09-07T00:00:00.000Z", checkIn: "2026-09-07", collectionQuality: { status: "complete" } };
  const data = { rawCompanies: new Map([[current.companyId, current]]), companies: [{ companyId: current.companyId }], runs: [run],
    _companySource: { revision: "unchanged-original-revision", assertCurrent: async () => {}, readCompany: async () => current } };
  let evidence = [], warnings = [], loads = 0;
  const helper = createMonthlyCompanyRecalculation({ ...coreDependencies(async id => { loads++; return { run: { id }, availability: { items: [{ placeId: "123", checkIn: run.checkIn, bookingRangeDays: 1,
    weeklyProductDetails: [room("room", 7, { date: run.checkIn }), room("second", 2, { date: run.checkIn })] }] } }; }),
    cacheDirectory: root, recalculateAllInventory: true, readPersistedProductCapacityEvidence: async () => ({ evidence, warnings }) });
  const request = { type: "company", targetId: current.companyId, month: "2026-09", cutoffDate: "2026-09-30" };
  assert.equal((await helper(request, data))[0].phoneMissingPriceBookings, 7); assert.equal(loads, 1);
  evidence = [{ companyId: current.companyId, productId: "room", productType: "lodging", count: 14, collectedAt: "2026-05-01T00:00:00.000Z", runId: "old", source: "normal_saved_product_response" }];
  assert.equal((await helper(request, data))[0].phoneRevenue, 700000); assert.equal(loads, 2, "a validated older maximum invalidates old run rows");
  await helper(request, data); assert.equal(loads, 2, "unchanged effective maxima reuse the verified compact run rows");
  evidence = [...evidence, { ...evidence[0], count: 18, collectedAt: "2026-09-25T00:00:00.000Z", runId: "future" }];
  assert.equal((await helper(request, data))[0].phoneRevenue, 700000); assert.equal(loads, 2, "future maxima neither leak nor invalidate earlier as-of run rows");
  evidence = []; warnings = [{ companyId: current.companyId, code: "PRODUCT_CAPACITY_CACHE_INVALID", message: "저장된 최대관측 근거 재검증 필요" }];
  const fallback = await helper(request, data); assert.equal(loads, 3); assert.equal(fallback[0].phoneMissingPriceBookings, 7);
  assert.equal(fallback[0].phoneRevenue, 0); assert.equal(fallback.productCapacityWarnings[0].code, "PRODUCT_CAPACITY_CACHE_INVALID", "an unpriced fallback is explicitly marked, never a confirmed zero");
});
