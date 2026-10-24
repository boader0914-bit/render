"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { observedProductCapacityEvidence, productCapacityBaselineAt, compactProductCapacityEvidence } = require("./lib/product_capacity_baseline.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
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
