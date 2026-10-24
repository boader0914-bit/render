"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyInventoryEvidence, observedProductCapacityEvidence } = require("./inventory_estimation.cjs");
const pika = require("./fixtures/pika_product_allocation_202609.cjs");
const date = "2026-09-26";
const lodging = (id, stock, extra = {}) => ({ date, bizItemId: id, name: id, saleType: "숙박", stock, bookingCount: 0, price: 100000, ...extra });
const dayUse = (id, name, bookings, extra = {}) => ({ date, bizItemId: id, name, saleType: "데이유즈", stock: 10, bookingCount: bookings, price: 50000, ...extra });
const input = (rows, baseline = { lodging: 20 }) => ({ checkIn: date, bookingRangeDays: 1, inventoryCapacityBaseline: baseline, weeklyProductDetails: rows });

test("lunch/dinner reuse is grouped by the same room stem, with independent products added separately", () => {
  const original = input([
    lodging("room", 0), dayUse("a-l", "A룸 런치 11~15시", 2), dayUse("a-d", "A룸 디너 16~21시", 3),
    dayUse("b-l", "B룸 lunch 11:00~15:00", 1), dayUse("b-d", "B룸 dinner 16:00~21:00", 4),
    dayUse("independent", "수영장 데이유즈", 2)
  ]);
  const before = JSON.stringify(original);
  const result = applyInventoryEvidence(original);
  const row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.sharedDayUseExcluded, 9, "max(2,3)+max(1,4)+independent 2");
  assert.equal(result.dayUseWeeklyPublicBookings, 12, "Time-slot session counts and revenue remain separate");
  assert.equal(result.dayUseWeeklyPublicRevenue, 600000);
  assert.equal(row.sharedDayUseEvidence.groups.length, 3);
  assert.equal(row.phoneBookings, 11);
  assert.equal(JSON.stringify(original), before);
  assert.equal(applyInventoryEvidence(result), result);
});

test("explicit room groups can pair differently worded lunch/dinner products; separate lodging is not deducted", () => {
  const rows = [lodging("room", 0), dayUse("l", "런치 A상품", 2, { sharedRoomGroupId: "shared-pool" }), dayUse("d", "디너 B상품", 3, { sharedRoomGroupId: "shared-pool" })];
  const result = applyInventoryEvidence({ ...input(rows), sharedRooms: { status: "separate" } });
  assert.equal(result.inventoryEvidence.dayUse.rows[0].sharedRoomReuse.physicalRoomBookings, 3);
  assert.equal(result.weeklySharedDayUseExcluded, 0);
  assert.equal(result.weeklyPhoneBookings, 20);
});

test("unclassified day use and an ambiguous single lunch/dinner product are not merged", () => {
  const result = applyInventoryEvidence(input([lodging("room", 0), dayUse("all", "런치·디너 통합 상품", 2), dayUse("picnic", "피크닉", 3)]));
  const evidence = result.inventoryEvidence.lodging.rows[0].sharedDayUseEvidence;
  assert.equal(evidence.physicalRoomBookings, 5);
  assert.equal(evidence.warnings[0].code, "ambiguous_lunch_dinner_product");
});

test("independently observed day-use bookings still exclude direct blocked rooms when day-use stock is missing", () => {
  const result = applyInventoryEvidence(input([lodging("closed", 4, { open: false }), dayUse("l", "A룸 런치", 1, { stock: null }), dayUse("d", "A룸 디너", 2, { stock: null })], { lodging: 4 }));
  const row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.partial, true);
  assert.equal(row.sharedDayUseExcluded, 2);
  assert.equal(row.phoneBookings, 2);
  assert.equal(row.explicitBlockedBookings, 2);
  assert.equal(row.phoneRevenue, 200000);
  assert.equal(row.rate, null);
  assert.equal(row.phoneRevenueLow, null);
  assert.equal(row.phoneRevenueHigh, null);
  assert.equal(result.inventoryEvidence.lodging.phoneRevenueLow, null);
  assert.equal(result.inventoryEvidence.lodging.phoneRevenueHigh, null);
});

test("historical same-product maxima price a residual without increasing the fixed company total", () => {
  const result = applyInventoryEvidence(input([lodging("cheap", 1), lodging("dear", 2, { price: 200000 })], {
    lodging: 8, lodgingProducts: { cheap: { count: 3, sourceDate: "2026-09-01", runId: "original-run" }, dear: 5 }
  }));
  assert.equal(result.totalRooms, 8);
  assert.equal(result.weeklyPhoneBookings, 5);
  assert.equal(result.weeklyPhoneRevenue, 800000);
  assert.equal(result.weeklyPhoneMissingPriceBookings, 0);
  assert.equal(result.inventoryEvidence.lodging.productCapacityEvidence.find((row) => row.productKey === "cheap").runId, "original-run");
});

test("a reviewed product count is fixed above historical and current provider maxima", () => {
  const result = applyInventoryEvidence(input([lodging("room", 2)], { lodging: 10, lodgingProducts: { room: 10 }, lodgingOverride: { count: 3, products: [{ id: "room", count: 3 }] } }));
  assert.equal(result.totalRooms, 3);
  assert.equal(result.inventoryEvidence.lodging.productCapacityEvidence[0].count, 3);
  assert.equal(result.inventoryEvidence.lodging.productCapacityEvidence[0].source, "db_product_correction");
  assert.equal(result.weeklyPhoneRevenue, 100000);
});

test("overlapping product maxima retain a warning and do not invent a larger company capacity", () => {
  const result = applyInventoryEvidence(input([lodging("first", 1), lodging("second", 1)], { lodging: 5, lodgingProducts: { first: 5, second: 5 } }));
  assert.equal(result.totalRooms, 5);
  assert.equal(result.weeklyPhoneBookings, 3);
  assert.equal(result.weeklyPhoneRevenue, 0);
  assert.equal(result.weeklyPhoneMissingPriceBookings, 3);
  assert.ok(result.inventoryEvidence.capacityReview.codes.includes("product_maxima_exceed_company_capacity"));
});

test("day-use ambiguity is allocated using the residual product shortages and each product's own date price", () => {
  const result = applyInventoryEvidence(input([lodging("cheap", 0), lodging("dear", 0, { price: 300000 }), dayUse("day", "데이유즈", 1)], {
    lodging: 4, lodgingProducts: { cheap: 1, dear: 3 }
  }));
  const row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.phoneBookings, 3);
  assert.equal(row.phoneRevenue, 750000);
  assert.equal(row.phoneAllocatedBookings, 3);
  assert.equal(row.phoneAllocatedRevenue, 750000);
  assert.equal(row.phoneRevenueLow, 700000);
  assert.equal(row.phoneRevenueHigh, 900000);
  assert.deepEqual(row.phonePriceEstimates.map((value) => value.quantity), [0.75, 2.25]);
  assert.ok(row.phonePriceEstimates.every((value) => value.source === "same_product_same_date" && value.allocationSource === "proportional_product_shortfall" && value.priceSource === "same_product_same_date" && value.estimatedQuantity));
  assert.equal(row.phoneMissingPriceBookings, 0);
  assert.equal(result.weeklyRevenuePrecisionRate, 0, "Fractional allocations are not observed product sales");
});

test("a missing candidate price keeps the complete residual unpriced with integer quantities", () => {
  const result = applyInventoryEvidence(input([lodging("missing", 0, { price: null }), lodging("priced", 0, { price: 300000 }), dayUse("day", "데イユーズ", 1)], {
    lodging: 4, lodgingProducts: { missing: 2, priced: 2 }
  }));
  const row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.phoneRevenue, 0);
  assert.equal(row.phonePricedBookings, 0);
  assert.equal(row.phoneAllocatedBookings, 0);
  assert.equal(row.phoneMissingPriceBookings, 3);
  assert.equal(row.phoneRevenueRangeComplete, false);
  assert.equal(row.phoneRevenueLow, null);
  assert.equal(row.phoneRevenueHigh, null);
  assert.equal(row.phoneValuation.completePriceCoverage, false);
  assert.equal(result.inventoryEvidence.lodging.phoneRevenueLow, null);
  assert.equal(row.phoneValuation.allocationRanges[0].lowRevenue, null);
  assert.equal(row.phoneValuation.warnings[0].code, "proportional_price_evidence_incomplete");
});

test("mixed same-date and fallback prices preserve integer allocation totals and retain the per-product fallback proof", () => {
  const result = applyInventoryEvidence({ checkIn: date, bookingRangeDays: 2,
    inventoryCapacityBaseline: { lodging: 4, lodgingProducts: { cheap: 1, dear: 3 } }, weeklyProductDetails: [
      lodging("cheap", 0), lodging("dear", 0, { price: null }), dayUse("day", "데이유즈", 1),
      lodging("cheap", 1, { date: "2026-09-27" }), lodging("dear", 3, { date: "2026-09-27", price: 300000 }), dayUse("day", "데이유즈", 0, { date: "2026-09-27" })
    ] });
  const row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.phoneRevenue, 750000);
  assert.equal(row.phoneAllocatedBookings, 3);
  assert.equal(row.phoneFallbackBookings, 0, "Fallback counters cover direct quantities, not fractional allocation weights");
  assert.equal(row.phoneFallbackRevenue, 0);
  assert.equal(row.phonePriceEstimates.find((estimate) => estimate.productKey === "dear").priceSource, "same_product_nearest_date");
  assert.equal(row.phonePriceEstimates.find((estimate) => estimate.productKey === "dear").quantity, 2.25);
});

test("legacy error flags cannot supply capacities, prices, or blocked sales", () => {
  for (const error of [{ responseStatus: 403 }, { error: "blocked" }, { failed: true }, { status: "rate_limited" }, { stockObserved: false }]) {
    const original = input([lodging("room", 0, error)], { lodging: 3, lodgingProducts: { room: 3 } });
    const result = applyInventoryEvidence(original);
    assert.equal(result.weeklyPhoneBookings, 0);
    assert.equal(result.weeklyPhoneRevenue, 0);
    assert.equal(result.weeklyUnknownUnavailable, 3);
    assert.equal(observedProductCapacityEvidence(original).products[0].observed, false);
  }
});

test("an unavailable historical capacity store preserves healthy observations and exposes no raw error details", () => {
  const result = applyInventoryEvidence(input([lodging("room", 5, { bookingCount: 1 })], {
    lodging: 5, productCapacityWarnings: [{ code: "PRODUCT_CAPACITY_STORE_CORRUPT", count: 2,
      message: "secret-token /private/path/source.json", rawPath: "/private/path/source.json", token: "secret-token" }]
  }));
  assert.equal(result.weeklyPublicBookings, 1);
  assert.equal(result.weeklyPublicRevenue, 100000);
  assert.equal(result.inventoryEvidence.lodging.rows[0].available, 4);
  const warning = result.inventoryEvidence.capacityReview.reasons.find((row) => row.code === "PRODUCT_CAPACITY_STORE_CORRUPT");
  assert.equal(warning.scope, "observation");
  assert.equal(warning.severity, "warning");
  assert.deepEqual(warning.evidence, { count: 2 });
  assert.doesNotMatch(JSON.stringify(warning), /secret-token|private\/path|rawPath/);
});

test("Pika's seven preserved dates reproduce the approved reuse and allocation review without editing source rows", () => {
  let additional = 0, targetRooms = 0;
  for (const source of pika.rows) {
    const original = { companyId: pika.companyId, checkIn: source.date, bookingRangeDays: 1, weeklyProductDetails: source.products,
      inventoryCapacityBaseline: { lodging: 38, lodgingProducts: pika.capacities } };
    const before = JSON.stringify(original);
    const result = applyInventoryEvidence(original);
    const row = result.inventoryEvidence.lodging.rows[0];
    assert.equal(row.phoneBookings, source.expectedPhoneBookings, source.date);
    assert.equal(row.phoneRevenue - source.priorPhoneRevenue, source.expectedAdditionalRevenue, source.date);
    assert.equal(row.phoneMissingPriceBookings, 0, source.date);
    if (source.date === "2026-09-04") assert.equal(row.sharedDayUseExcluded, 1, "Lunch 1 + dinner 1 uses one physical room");
    assert.equal(JSON.stringify(original), before);
    additional += row.phoneRevenue - source.priorPhoneRevenue;
    targetRooms += row.phoneBookings - (source.date === "2026-09-04" ? 2 : source.expectedPhoneBookings);
  }
  assert.equal(additional, 9191226);
  assert.equal(targetRooms, 1);
});
