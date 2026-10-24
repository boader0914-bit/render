"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { applyInventoryEvidence } = require("./inventory_estimation.cjs");
const DAY = "2027-02-13";
const product = (id, stock, extra = {}) => ({ date: DAY, bizItemId: id, name: id, saleType: "숙박", stock, bookingCount: 0, occupiedBookingCount: 0, open: true, price: 100000, ...extra });
const dayUse = (id, bookings) => product(id, 5, { name: "A룸 런치", saleType: "데이유즈", bookingCount: bookings, price: 50000 });
const item = (rows, baseline) => ({ checkIn: DAY, bookingRangeDays: 1, inventoryCapacityBaseline: baseline, weeklyProductDetails: rows });
const calculate = (rows, baseline) => applyInventoryEvidence(item(rows, baseline)).inventoryEvidence.lodging.rows[0];
function assertMass(row) {
  const causes = row.priceUnknownCauses;
  assert.ok(Array.isArray(causes));
  for (const cause of causes) {
    assert.ok(Number.isSafeInteger(cause.quantity) && cause.quantity > 0);
    assert.ok(["public", "other"].includes(cause.channel));
    assert.equal(new Set(cause.productKeys).size, cause.productKeys.length);
  }
  assert.equal(causes.filter(cause => cause.channel === "other").reduce((sum, cause) => sum + cause.quantity, 0), row.phoneMissingPriceBookings);
  assert.equal(causes.filter(cause => cause.channel === "public").reduce((sum, cause) => sum + cause.quantity, 0), row.missingPriceSoldOut - row.phoneMissingPriceBookings);
}
const cause = (code, channel, quantity, productKeys) => ({ code, channel, quantity, productKeys });

test("normally observed direct blocks without a price are distinct from an unallocated company capacity", () => {
  const row = calculate([product("priced", 1), product("unpriced", 1, { open: false, price: null })], { lodging: 4 });
  assert.deepEqual(row.priceUnknownCauses, [cause("explicit_product_price_missing", "other", 1, ["unpriced"]),
    cause("company_capacity_unallocated_to_products", "other", 2, ["priced", "unpriced"])]);
  assert.equal(row.phoneBookings, 3); assert.equal(row.phoneRevenue, 0); assert.equal(row.publicRevenue, 0);
  assert.equal(row.phoneMissingPriceBookings, 3); assertMass(row);
});

test("an inferred shortage without its own price does not borrow another product's price", () => {
  const row = calculate([product("a", 0, { price: null }), product("b", 1)], { lodging: 3, lodgingProducts: { a: 2, b: 1 } });
  assert.deepEqual(row.priceUnknownCauses, [cause("inferred_product_price_missing", "other", 2, ["a"])]);
  assert.equal(row.phoneBookings, 2); assert.equal(row.phoneRevenue, 0); assertMass(row);
});

test("overlapping maxima account for only the remaining rooms and retain already valued explicit blocks", () => {
  const row = calculate([product("a", 1, { open: false }), product("b", 1, { price: 200000 })], { lodging: 5, lodgingProducts: { a: 4, b: 4 } });
  assert.deepEqual(row.priceUnknownCauses, [cause("product_maxima_exceed_company_capacity", "other", 3, ["a", "b"])]);
  assert.equal(row.phoneBookings, 4); assert.equal(row.phoneRevenue, 100000); assert.equal(row.explicitBlockedBookings, 1); assertMass(row);
});

test("a shared residual with an incomplete price set and a catalog gap has disjoint integer causes", () => {
  const row = calculate([product("a", 0, { price: null }), product("b", 0, { price: 200000 }), dayUse("day", 1)],
    { lodging: 5, lodgingProducts: { a: 2, b: 2 } });
  assert.deepEqual(row.priceUnknownCauses, [cause("proportional_price_evidence_incomplete", "other", 3, ["a"]),
    cause("company_capacity_unallocated_to_products", "other", 1, ["a", "b"])]);
  assert.equal(row.sharedDayUseExcluded, 1); assert.equal(row.phoneBookings, 4); assert.equal(row.phoneRevenue, 0); assertMass(row);
});

test("public price omissions and other-channel price omissions remain separate diagnostic quantities", () => {
  const row = calculate([product("public", 2, { bookingCount: 1, price: null }), product("blocked", 1, { open: false, price: null })], { lodging: 3 });
  assert.deepEqual(row.priceUnknownCauses, [cause("public_product_price_missing", "public", 1, ["public"]),
    cause("explicit_product_price_missing", "other", 1, ["blocked"])]);
  assert.equal(row.publicBookings, 1); assert.equal(row.phoneBookings, 1); assert.equal(row.missingPriceSoldOut, 2); assertMass(row);
});

test("a normal zero has no cause; a failed booking response never creates a missing-price booking", () => {
  const normal = calculate([product("zero", 2, { price: null })], { lodging: 2 });
  assert.deepEqual(normal.priceUnknownCauses, []); assert.equal(normal.phoneBookings, 0); assert.equal(normal.estimatedRevenue, 0); assertMass(normal);
  const failed = calculate([product("failed", 2, { bookingCount: 1, price: null, collectionFailed: true, responseStatus: 429 })], { lodging: 2 });
  assert.equal(failed.partial, true); assert.equal(failed.publicBookings, 0); assert.deepEqual(failed.priceUnknownCauses, []); assertMass(failed);
  const stockMissing = calculate([product("partial", null, { bookingCount: 1, price: null })], { lodging: 2 });
  assert.deepEqual(stockMissing.priceUnknownCauses, [cause("invalid_product_response", "public", 1, ["partial"])]); assertMass(stockMissing);
});

test("a valid fallback price, input bytes, repeated calculation and unrelated dates retain their existing behavior", () => {
  const next = "2027-02-14", rows = [product("same", 2, { open: false, price: null }), product("same", 2, { date: next, price: 123000 })];
  const original = { ...item(rows, { lodging: 2 }), bookingRangeDays: 2 }, bytes = JSON.stringify(original);
  const result = applyInventoryEvidence(original), first = result.inventoryEvidence.lodging.rows[0];
  assert.equal(first.phoneBookings, 2); assert.equal(first.phoneRevenue, 246000); assert.equal(first.phoneFallbackBookings, 2);
  assert.deepEqual(first.priceUnknownCauses, []); assertMass(first);
  assert.equal(JSON.stringify(original), bytes); assert.equal(applyInventoryEvidence(result), result);
  for (const row of result.inventoryEvidence.lodging.rows) assertMass(row);
});

const singleRoom = (id, stock, extra = {}) => product(id, stock, { name: "객실 " + id, listType: "객실별 예약리스트", ...extra });
function declaredItem(rows, baseline, extras = {}) {
  const lodgingKeys = new Set(rows.filter(row => row.saleType !== "데이유즈").map(row => row.bizItemId));
  const dayUseKeys = new Set(rows.filter(row => row.saleType === "데이유즈").map(row => row.bizItemId));
  return { ...item(rows, baseline), nightItemCount: lodgingKeys.size, countedItemCount: lodgingKeys.size, dayUseItemCount: dayUseKeys.size, ...extras };
}
const recoveryRows = input => applyInventoryEvidence(input).inventoryEvidence.lodging.rows;

test("a fully declared single-room catalog supplies only pricing priors while raw zero inventory and maximum witnesses stay intact", () => {
  const input = declaredItem([singleRoom("a", 1), singleRoom("b", 0), singleRoom("c", 0, { price: 200000 })], { lodging: 3 });
  const bytes = JSON.stringify(input), result = applyInventoryEvidence(input), row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.total, 3); assert.equal(row.rawTotal, 1); assert.equal(row.available, 1); assert.equal(row.phoneBookings, 2);
  assert.equal(row.phoneRevenue, 300000); assert.equal(row.phoneAllocatedBookings, 2); assert.equal(row.phoneMissingPriceBookings, 0);
  assert.equal(row.priceRecoveryPolicy, "inventory_price_recovery_v1");
  assert.deepEqual(row.phoneValuation.recoveryPolicies, [{ policy: "catalog_single_room_identity_v1", quantity: 2, revenue: 300000,
    productKeys: ["b", "c"], estimatedQuantity: true, sourceDate: DAY }]);
  assert.ok(row.phonePriceEstimates.every(value => value.source === "same_product_same_date" && value.sourceDate === DAY && value.estimatedQuantity));
  assert.deepEqual(result.inventoryEvidence.lodging.productCapacityEvidence.map(value => [value.productKey, value.count]), [["a", 1], ["b", 0], ["c", 0]], "inferred pricing priors never become observed stock witnesses");
  assert.equal(JSON.stringify(input), bytes); assert.equal(applyInventoryEvidence(result), result); assertMass(row);
});

test("existing known revenue is retained and a DB product correction remains authoritative", () => {
  const rows = [singleRoom("a", 1), singleRoom("b", 0, { price: 200000 }), singleRoom("c", 0, { price: 300000 })];
  const input = declaredItem(rows, { lodging: 3, lodgingProducts: { b: 7 }, lodgingOverride: { count: 3, products: [{ id: "b", count: 1 }] } });
  const result = applyInventoryEvidence(input), row = result.inventoryEvidence.lodging.rows[0];
  assert.equal(row.phoneRevenue, 500000); assert.equal(row.phoneValuation.recoveryPolicies[0].revenue, 300000);
  assert.deepEqual(row.phoneValuation.recoveryPolicies[0].productKeys, ["c"]);
  assert.equal(result.inventoryEvidence.lodging.productCapacityEvidence.find(value => value.productKey === "b").count, 1);
  assert.equal(result.inventoryEvidence.lodging.productCapacityEvidence.find(value => value.productKey === "b").source, "db_product_correction");
  const fixed = recoveryRows(declaredItem(rows, { lodging: 3, lodgingOverride: { count: 3, products: [{ id: "b", count: 2 }] } }))[0];
  assert.equal(fixed.phoneRevenue, 400000); assert.equal(fixed.priceRecoveryPolicy, undefined, "an incompatible reviewed per-product count cannot be replaced by a one-room prior");
  assertMass(row); assertMass(fixed);
});

test("single-room pricing refuses raw multi-room stock, bundles, duplicate identities, missing declarations and incompatible totals", () => {
  const rows = [singleRoom("a", 1), singleRoom("b", 0), singleRoom("c", 0)];
  const cases = [
    declaredItem([singleRoom("a", 7), ...rows.slice(1)], { lodging: 3 }),
    declaredItem(rows.map(row => ({ ...row, listType: "상품타입별 예약리스트" })), { lodging: 3 }),
    declaredItem([rows[0], { ...rows[1], name: "객실-a" }, rows[2]], { lodging: 3 }),
    { ...declaredItem(rows, { lodging: 3 }), nightItemCount: undefined },
    { ...declaredItem(rows, { lodging: 3 }), countedItemCount: 2 },
    declaredItem(rows, { lodging: 4 }),
    declaredItem(rows, { lodging: 3 }, { collectionProductCoverage: { eligible: 3, queried: 2, truncated: 1, productListComplete: false, days: [] } })
  ];
  for (const input of cases) {
    const before = JSON.stringify(input), row = recoveryRows(input)[0];
    assert.equal(row.priceRecoveryPolicy, undefined); assert.equal(row.phoneRevenue, 0); assert.ok(row.phoneMissingPriceBookings > 0);
    assert.equal(JSON.stringify(input), before); assertMass(row);
  }
});

test("an erroneous date is held without blocking a different fully normal date in the same catalog", () => {
  const tomorrow = "2027-02-14", rows = [];
  for (const date of [DAY, tomorrow]) for (const [id, stock] of [["a", 1], ["b", 0], ["c", 0]]) rows.push(singleRoom(id, stock, { date,
    ...(date === DAY && id === "b" ? { collectionFailed: true, responseStatus: 429 } : {}) }));
  const result = recoveryRows(declaredItem(rows, { lodging: 3 }, { bookingRangeDays: 2 }));
  assert.equal(result[0].partial, true); assert.equal(result[0].priceRecoveryPolicy, undefined);
  assert.equal(result[1].phoneRevenue, 200000); assert.equal(result[1].priceRecoveryPolicy, "inventory_price_recovery_v1");
  result.forEach(assertMass);
});

test("shared lunch/dinner rooms are deducted once and a catalog residual uses only its still-missing integer quantity", () => {
  const rows = [singleRoom("a", 1), singleRoom("b", 0), singleRoom("c", 0, { price: 200000 }), singleRoom("d", 0, { price: 300000 }),
    dayUse("lunch", 1), { ...dayUse("dinner", 1), name: "A룸 디너" }];
  const row = recoveryRows(declaredItem(rows, { lodging: 4 }))[0];
  assert.equal(row.sharedDayUseExcluded, 1); assert.equal(row.phoneBookings, 2); assert.equal(row.phoneRevenue, 400000);
  assert.equal(row.phoneAllocatedBookings, 2); assert.equal(row.phoneValuation.recoveryPolicies[0].quantity, 2);
  assert.equal(row.phoneRevenueLow, 300000); assert.equal(row.phoneRevenueHigh, 500000); assertMass(row);
  const missingPrice = recoveryRows(declaredItem(rows.map(value => value.bizItemId === "c" ? { ...value, price: null } : value), { lodging: 4 }))[0];
  assert.equal(missingPrice.phoneRevenue, 0); assert.equal(missingPrice.priceRecoveryPolicy, undefined);
  assert.deepEqual(missingPrice.priceUnknownCauses, [cause("proportional_price_evidence_incomplete", "other", 2, ["c"])]); assertMass(missingPrice);
});

test("only current catalog prices shared by every SKU can value an overlap without inventing SKU allocations", () => {
  const input = declaredItem([product("a", 1, { open: false }), product("b", 1)], { lodging: 4, lodgingProducts: { a: 4, b: 4 } });
  const row = recoveryRows(input)[0];
  assert.equal(row.phoneBookings, 3); assert.equal(row.explicitBlockedBookings, 1); assert.equal(row.explicitBlockedRevenue, 100000);
  assert.equal(row.phoneRevenue, 300000); assert.equal(row.phoneValuation.warnings[0].code, "product_maxima_exceed_company_capacity");
  assert.equal(row.phoneValuation.recoveryPolicies[0].policy, "uniform_current_catalog_price_v1");
  assert.equal(row.phoneValuation.recoveryPolicies[0].quantity, 2); assert.equal(row.phoneValuation.recoveryPolicies[0].revenue, 200000);
  const estimate = row.phonePriceEstimates.find(value => value.productKey === null);
  assert.deepEqual(estimate.productKeys, ["a", "b"]); assert.equal(estimate.quantity, 2); assert.equal(estimate.source, "same_product_same_date");
  assert.equal(estimate.estimatedQuantity, true); assert.equal(row.phoneMissingPriceBookings, 0); assertMass(row);
});

test("overlap recovery refuses mixed prices, stale fallback-only prices, incomplete catalogs and unverified sharing", () => {
  const baseline = { lodging: 4, lodgingProducts: { a: 4, b: 4 } }, rows = [product("a", 1), product("b", 1)];
  const cases = [
    declaredItem([rows[0], { ...rows[1], price: 200000 }], baseline),
    declaredItem([rows[0], { ...rows[1], price: 0 }], baseline),
    { ...declaredItem(rows, baseline), countedItemCount: 3 },
    declaredItem(rows, baseline, { collectionProductCoverage: { eligible: 2, queried: 2, truncated: 0, productListComplete: true,
      days: [{ date: DAY, eligible: 2, queried: 1, succeeded: 1, failed: 1, truncated: 0 }] } }),
    declaredItem([...rows, dayUse("day", 1)], baseline, { dayUsePresence: "unknown" })
  ];
  for (const input of cases) {
    const row = recoveryRows(input)[0];
    assert.equal(row.priceRecoveryPolicy, undefined); assert.equal(row.phoneValuation.recoveryPolicies, undefined); assertMass(row);
  }
});

test("public price omissions remain unfilled while independent catalog pricing recovers other-channel missing rooms", () => {
  const row = recoveryRows(declaredItem([singleRoom("a", 1, { bookingCount: 1, price: null }), singleRoom("b", 0)], { lodging: 2 }))[0];
  assert.equal(row.publicBookings, 1); assert.equal(row.publicRevenue, 0); assert.equal(row.phoneRevenue, 100000);
  assert.deepEqual(row.priceUnknownCauses, [cause("public_product_price_missing", "public", 1, ["a"])]); assertMass(row);
});

test("additional recovery rejects incomplete statuses, unknown occupied stock, inconsistent occupied counts and nonboolean sale flags", () => {
  const rows = [singleRoom("a", 1), singleRoom("b", 0), singleRoom("c", 0)];
  const mutations = [{ status: "partial" }, { collectionStatus: "incomplete" }, { queryStatus: "unknown" },
    { occupiedBookingCount: null }, { occupiedBookingCount: undefined }, { occupiedBookingCount: 1 }, { open: "true" }, { open: undefined }];
  for (const mutation of mutations) {
    const input = declaredItem(rows.map(row => row.bizItemId === "b" ? { ...row, ...mutation } : row), { lodging: 3 });
    const before = JSON.stringify(input), row = recoveryRows(input)[0];
    assert.equal(row.priceRecoveryPolicy, undefined); assert.equal(row.phoneRevenue, 0);
    assert.equal(row.rawTotal, 1); assert.equal(row.total, 3); assert.equal(row.available, 1, "strict recovery checks cannot rewrite current inventory behavior");
    assert.equal(JSON.stringify(input), before); assertMass(row);
  }
});
