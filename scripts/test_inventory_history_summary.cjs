"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const context = vm.createContext({
  boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit),
  kstDayKeyFromValue: (value) => String(value).slice(0, 10),
  historyDailyObservationIsNewer: (row, previous) => String(row.collectedAt) > String(previous.collectedAt)
});
for (const name of ["productSnapshotNumber", "inventoryEstimateBreakdown", "companySalesHistorySummary"]) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}
const lodging = {
  date: "2026-09-21", productType: "lodging", inventoryEvidenceVersion: 3,
  total: 10, sold: 8, publicBookings: 3, phoneBookings: 5, sharedDayUseExcluded: 2,
  unknownUnavailable: 0, publicRevenue: 300000, phoneRevenue: 500000,
  phonePricedBookings: 5, phoneMissingPriceBookings: 0, estimatedRevenue: 800000,
  reservationRate: 0.8, collectedAt: "2026-09-21T08:00:00.000Z"
};
const history = (rows) => context.companySalesHistorySummary([], rows, "2026-09-21");
const complete = history([lodging]);
assert.equal(complete.current.summary.supply, 10);
assert.equal(complete.current.summary.sold, 8);
assert.equal(complete.current.summary.publicBookings, 3);
assert.equal(complete.current.summary.phoneBookings, 5);
assert.equal(complete.current.summary.phonePricedBookings, 5);
assert.equal(complete.current.summary.reservationRate, 0.8);
assert.equal(complete.actualRevenueAvailable, false);
assert.equal(complete.actualObservation, false, "Phone estimates cannot be described as actual booking observations");
assert.equal(complete.containsEstimates, true);

const shared = history([lodging, {
  ...lodging, productType: "dayuse", total: 3, sold: 2, publicBookings: 2,
  phoneBookings: 0, sharedDayUseExcluded: 0, publicRevenue: 100000,
  phoneRevenue: 0, estimatedRevenue: 100000, phonePricedBookings: 0, reservationRate: 2 / 3
}]);
assert.equal(shared.current.daily[0].total, 10, "Day-use sessions never increase lodging capacity");
assert.equal(shared.current.daily[0].sold, 8);
assert.equal(shared.current.daily[0].dayUseBookings, 2);
assert.equal(shared.current.summary.reservationRate, 0.8);
assert.equal(shared.current.summary.estimatedRevenue, 900000);

for (const flags of [
  { partial: true }, { unknownUnavailable: 8 }, { inventoryConflict: true },
  { sharedDayUseIncomplete: true }, { reservationRate: null }
]) {
  const partial = history([{ ...lodging, ...flags, sold: 2, publicBookings: 2, phoneBookings: 0 }]);
  assert.equal(partial.current.daily[0].reservationRate, null);
  assert.equal(partial.current.summary.reservationRate, null);
  assert.equal(partial.current.summary.supply, 10, "Invalid rates do not shrink fixed capacity");
  assert.equal(partial.current.summary.phoneBookings, 0, "No missing inventory is invented as phone bookings");
  assert.equal(partial.current.summary.partial, true);
}
const missing = history([{ ...lodging, missing: true, partial: true, sold: null, publicBookings: 0,
  phoneBookings: 0, unknownUnavailable: 10, estimatedRevenue: null, reservationRate: null }]);
assert.equal(missing.current.summary.supply, 10);
assert.equal(missing.current.summary.sold, null);
assert.equal(missing.current.summary.missingDays, 1);
assert.equal(missing.current.summary.estimatedRevenue, null);

const unpriced = history([{ ...lodging, sold: 10, publicBookings: 0, phoneBookings: 10,
  publicRevenue: 0, phoneRevenue: 0, phonePricedBookings: 0, phoneMissingPriceBookings: 10,
  estimatedRevenue: 0, reservationRate: 1 }]);
assert.equal(unpriced.current.summary.phoneBookings, 10);
assert.equal(unpriced.current.summary.phoneMissingPriceBookings, 10);
assert.equal(unpriced.current.summary.estimatedRevenue, null, "Unpriced telephone estimates are not a zero-revenue observation");
assert.equal(unpriced.current.summary.revenuePartial, true);

const fallbackPrice = {
  productKey: "holiday-room", quantity: 10, unitPrice: 240000, revenue: 2400000,
  source: "same_product_nearest_date", sourceDate: "2026-09-20"
};
const holidayPhone = { ...lodging, date: "2026-09-26", inventoryEvidenceVersion: 4,
  sold: 10, publicBookings: 0, phoneBookings: 10, publicRevenue: 0, phoneRevenue: 2400000,
  phonePricedBookings: 10, phoneMissingPriceBookings: 0, estimatedRevenue: 2400000, reservationRate: 1,
  phoneFallbackRevenue: 2400000, phoneFallbackBookings: 10, phonePriceEstimates: [fallbackPrice],
  phoneValuationPolicy: "same_product_observed_price_v1" };
const holidaySnapshot = history([holidayPhone]);
assert.equal(holidaySnapshot.current.summary.estimatedRevenue, 2400000);
assert.equal(holidaySnapshot.current.summary.phoneFallbackRevenue, 2400000);
assert.equal(holidaySnapshot.current.daily[0].phonePriceEstimates[0].sourceDate, "2026-09-20");
assert.equal(holidaySnapshot.current.daily[0].priceEvidenceType, "same_product_observed_fallback");
const holidayArchive = context.companySalesHistorySummary([holidayPhone], [], "2026-10-01");
const holidayMonth = holidayArchive.past.years[0].months[0];
assert.equal(holidayMonth.summary.estimatedRevenue, 2400000, "valued product evidence in history belongs in the monthly total even outside the latest snapshot");
assert.equal(holidayMonth.summary.phoneBookings, 10);
assert.equal(holidayMonth.summary.phoneFallbackBookings, 10);
assert.equal(holidayMonth.weeks[0].daily[0].phonePriceEstimates[0].productKey, "holiday-room");
for (const flag of [{ missing: true }, { partial: true }, { inventoryConflict: true }, { sharedDayUseIncomplete: true }]) {
  const excluded = context.companySalesHistorySummary([{ ...holidayPhone, ...flag }], [], "2026-10-01");
  assert.equal(excluded.past.years[0].months[0].summary.estimatedRevenue, null);
}
const legacyPriceHistory = context.companySalesHistorySummary([{ ...lodging, inventoryEvidenceVersion: 2,
  price: 100000, estimatedRevenue: 800000 }], [], "2026-10-01");
assert.equal(legacyPriceHistory.past.years[0].months[0].summary.estimatedRevenue, null, "a representative legacy price is not per-product revenue evidence");
const inconsistentRevenueHistory = context.companySalesHistorySummary([{ ...holidayPhone, estimatedRevenue: 9999999 }], [], "2026-10-01");
assert.equal(inconsistentRevenueHistory.past.years[0].months[0].summary.estimatedRevenue, null);

const explicitSharedBlock = { ...holidayPhone, total: 17, sold: 8, publicBookings: 0, phoneBookings: 8,
  phoneRevenue: 2072000, phonePricedBookings: 8, estimatedRevenue: 2072000,
  phoneFallbackRevenue: 0, phoneFallbackBookings: 0, phonePriceEstimates: [],
  explicitBlockedBookings: 8, explicitBlockedRevenue: 2072000, explicitBlockedDayUseUnverified: true,
  partial: true, sharedDayUseIncomplete: true, reservationRate: null,
  dayUseMode: "lodging_only", dayUsePresence: "present", dayUseScheduleStatus: "excluded" };
const partialBlocks = history([explicitSharedBlock]);
assert.equal(partialBlocks.current.daily[0].estimatedRevenue, 2072000, "observed closed room amounts survive unmeasured day-use sharing");
assert.equal(partialBlocks.current.daily[0].phoneBookings, 8);
assert.equal(partialBlocks.current.daily[0].explicitBlockedBookings, 8, "explicit blocks are a subset, not added twice");
assert.equal(partialBlocks.current.summary.estimatedRevenue, 2072000);
assert.equal(partialBlocks.current.summary.reservationRate, null);
assert.equal(partialBlocks.current.summary.partial, true);
assert.equal(partialBlocks.current.summary.revenuePartial, true);
assert.equal(partialBlocks.current.summary.explicitBlockedDayUseUnverified, true);
const partialBlockHistory = context.companySalesHistorySummary([explicitSharedBlock], [], "2026-10-01");
assert.equal(partialBlockHistory.past.years[0].months[0].summary.estimatedRevenue, 2072000);
const missingDayUse = history([explicitSharedBlock, { ...explicitSharedBlock, productType: "dayuse", missing: true,
  estimatedRevenue: null, sold: null, phoneBookings: 0, explicitBlockedBookings: 0, explicitBlockedRevenue: 0 }]);
assert.equal(missingDayUse.current.summary.estimatedRevenue, 2072000, "a missing day-use response cannot erase an observed lodging-block subtotal");
for (const flag of [{ missing: true }, { inventoryConflict: true }, { explicitBlockedRevenue: 0, phoneRevenue: 0,
  phonePricedBookings: 0, phoneMissingPriceBookings: 8, estimatedRevenue: 0 }]) {
  const rejected = history([{ ...explicitSharedBlock, ...flag }]);
  assert.equal(rejected.current.summary.estimatedRevenue, null, "missing, conflicting or entirely unpriced blocks remain unavailable");
}
const knownPublicOnly = history([{ ...explicitSharedBlock, publicBookings: 3, phoneBookings: 0, sold: 3,
  publicRevenue: 777000, phoneRevenue: 0, phonePricedBookings: 0, explicitBlockedBookings: 0,
  explicitBlockedRevenue: 0, explicitBlockedDayUseUnverified: false, estimatedRevenue: 777000 }]);
assert.equal(knownPublicOnly.current.summary.estimatedRevenue, 777000, "unqueried sharing does not erase normally observed public reservation revenue");
assert.equal(knownPublicOnly.current.summary.reservationRate, null);
assert.equal(knownPublicOnly.current.summary.revenuePartial, true);
const unexplainedGap = history([{ ...explicitSharedBlock, publicBookings: 3, phoneBookings: 5, sold: 8,
  publicRevenue: 777000, phoneRevenue: 1295000, explicitBlockedBookings: 0, explicitBlockedRevenue: 0,
  estimatedRevenue: 2072000 }]);
assert.equal(unexplainedGap.current.summary.estimatedRevenue, 777000, "a partial response cannot price an unexplained gap as if it were an explicit block");

const mixed = history([lodging, { ...lodging, date: "2026-09-22", partial: true,
  sold: 2, publicBookings: 2, phoneBookings: 0, unknownUnavailable: 8, reservationRate: null }]);
assert.equal(mixed.current.summary.supply, 20);
assert.equal(mixed.current.summary.sold, 10);
assert.equal(mixed.current.summary.reservationRate, null);
assert.equal(mixed.current.summary.rateObservedDays, 1);

const legacy = history([{ ...lodging, inventoryEvidenceVersion: 2, total: 8, sold: 2 }]);
assert.equal(legacy.current.summary.supply, 8);
assert.equal(legacy.current.summary.reservationRate, 0.25);
assert.equal(complete.current.summary.dayUseBookings, 0, "legacy summary retains its prior shape and values");

for (const [mode, status] of [["inspect", "not_requested"], ["lodging_only", "excluded"], ["detail", "not_requested_basic"]]) {
  for (const presence of ["present", "unknown", "absent"]) {
    const unqueried = { ...lodging, inventoryEvidenceVersion: 4,
      dayUseMode: mode, dayUsePresence: presence, dayUseScheduleStatus: status,
      publicBookings: 3, phoneBookings: 0, sold: 3, partial: presence !== "absent" };
    const current = history([unqueried]);
    assert.equal(current.current.daily[0].dayUseBookings, null);
    assert.equal(current.current.daily[0].dayUseObserved, false);
    assert.equal(current.current.daily[0].dayUseMissingReason, presence === "absent" ? "no_day_use_product" : status);
    assert.equal(current.current.summary.dayUseBookings, null);
    assert.equal(current.current.summary.dayUseObservedDays, 0);
    assert.equal(current.current.summary.dayUseUnobservedDays, 1);
    const month = context.companySalesHistorySummary([], [unqueried], "2026-10-01");
    assert.equal(month.past.years[0].months[0].summary.dayUseBookings, null, "monthly reporting must not convert unqueried day use into zero bookings");
  }
}
const observedDayUseZero = history([lodging, { ...lodging, productType: "dayuse", total: 3, sold: 0,
  publicBookings: 0, phoneBookings: 0, sharedDayUseExcluded: 0, dayUseMode: "detail",
  dayUsePresence: "present", dayUseScheduleStatus: "requested" }]);
assert.equal(observedDayUseZero.current.daily[0].dayUseBookings, 0);
assert.equal(observedDayUseZero.current.daily[0].dayUseObserved, true);
assert.equal(observedDayUseZero.current.summary.dayUseObservedDays, 1);
const mixedCoverage = history([lodging, { ...lodging, date: "2026-09-22", dayUseMode: "inspect",
  dayUsePresence: "present", dayUseScheduleStatus: "not_requested" }]);
assert.equal(mixedCoverage.current.summary.dayUseBookings, null);
assert.equal(mixedCoverage.current.summary.dayUsePartial, true);
console.log("Inventory history summary: fixed capacity, partial-rate suppression, public/phone separation, shared day-use units and missing phone prices passed");
