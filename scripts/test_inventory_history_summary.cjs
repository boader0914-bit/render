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
for (const name of ["productSnapshotNumber", "companySalesHistorySummary"]) {
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

const mixed = history([lodging, { ...lodging, date: "2026-09-22", partial: true,
  sold: 2, publicBookings: 2, phoneBookings: 0, unknownUnavailable: 8, reservationRate: null }]);
assert.equal(mixed.current.summary.supply, 20);
assert.equal(mixed.current.summary.sold, 10);
assert.equal(mixed.current.summary.reservationRate, null);
assert.equal(mixed.current.summary.rateObservedDays, 1);

const legacy = history([{ ...lodging, inventoryEvidenceVersion: 2, total: 8, sold: 2 }]);
assert.equal(legacy.current.summary.supply, 8);
assert.equal(legacy.current.summary.reservationRate, 0.25);
console.log("Inventory history summary: fixed capacity, partial-rate suppression, public/phone separation, shared day-use units and missing phone prices passed");
