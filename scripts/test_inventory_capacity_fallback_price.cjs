"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const declaration = source.match(/function companyInventorySnapshotWithCurrentCapacity\([\s\S]+?\n\}/)?.[0];
assert.ok(declaration, "the actual server capacity fallback must be tested without starting the server");
const number = value => value == null || typeof value === "boolean" || value === "" ? null : Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const project = vm.runInNewContext(`(${declaration})`, {
  manualCorrectionLodgingBasisTotal: correction => correction?.active === false ? null : number(correction?.lodgingBasisTotal),
  companyMaximumRoomCapacity: company => company.maximum,
  productSnapshotNumber: number
});
const historyDeclaration = source.match(/function companyHistoryObservationWithCurrentCapacity\([\s\S]+?\n\}/)?.[0];
assert.ok(historyDeclaration);
const projectHistory = vm.runInNewContext(`(${historyDeclaration})`, {
  manualCorrectionLodgingBasisTotal: correction => correction?.active === false ? null : number(correction?.lodgingBasisTotal),
  companyMaximumRoomCapacity: company => company.maximum, productSnapshotNumber: number,
  companyInventorySnapshotWithCurrentCapacity: project
});
function fixture() {
  const row = { date: "2029-07-21", productType: "lodging", total: 25, rawTotal: 25, available: 0,
    sold: 17, publicBookings: 12, phoneBookings: 5, publicRevenue: 1234560, phoneRevenue: 845000, estimatedRevenue: 2079560,
    phonePricedBookings: 5, phoneMissingPriceBookings: 0, phoneAllocatedBookings: 5, phoneAllocatedRevenue: 845000,
    phoneRevenueLow: 845000, phoneRevenueHigh: 845000, phoneRevenueRangeComplete: true,
    phoneFallbackBookings: 0, phoneFallbackRevenue: 0,
    phonePriceEstimates: [{ productKey: "room_a", quantity: 5, unitPrice: 169000, revenue: 845000, sourceDate: "2029-07-21" }],
    phoneValuation: { policy: "proportional_product_shortfall_v2", recoveryPolicies: [{ policy: "uniform_current_catalog_price_v1", quantity: 5, revenue: 845000 }] },
    priceRecoveryPolicy: "inventory_price_recovery_v1",
    priceUnknownCauses: [{ code: "public_product_price_missing", channel: "public", quantity: 2, productKeys: ["room_b"] },
      { code: "company_capacity_unallocated_to_products", channel: "other", quantity: 3, productKeys: ["room_a"] }],
    inventoryEvidenceVersion: 5, partial: false, inventoryConflict: false, capacityConflict: false };
  return { inventoryEvidenceVersion: 5, capacityBasis: { count: 25, source: "observed_maximum" },
    productSnapshot: { inventoryEvidenceVersion: 5, capacityBasis: { count: 25, source: "observed_maximum" }, daily: [row] },
    revenue: { lodging: { phoneAllocatedBookings: 5, phoneAllocatedRevenue: 845000, phoneRevenueLow: 845000, phoneRevenueHigh: 845000,
      phoneValuation: row.phoneValuation, priceRecoveryPolicy: row.priceRecoveryPolicy, priceUnknownCauses: row.priceUnknownCauses } } };
}
function report(row) {
  const companyId = "cmp_place_capacity_fallback_fixture", runId = "fixture_glamping_20290721_090000", collectedAt = "2029-07-21T00:00:00.000Z";
  return buildMonthlyReportSnapshot({ type: "company", targetId: companyId, month: "2029-07", cutoffDate: "2029-07-31" }, {
    companies: [{ companyId, primaryName: "모의 객실기준 검토 업체", capacity: 26 }],
    runs: [{ id: runId, collectedAt, collectionQuality: { status: "complete" } }],
    observations: [{ ...row, companyId, runId, collectedAt, stayDate: row.date, supply: row.total }]
  }, "2029-08-01T00:00:00.000Z");
}

test("unrecalculable capacity changes retain only evidenced public partial revenue without stale phone-price contradictions", () => {
  const original = fixture(), before = JSON.stringify(original);
  const projected = project(original, { maximum: 26 }), row = projected.productSnapshot.daily[0];
  const monthly = report(row);
  assert.equal(row.phoneBookings, 0); assert.equal(row.phoneRevenue, 0); assert.equal(row.publicBookings, 12); assert.equal(row.publicRevenue, 1234560);
  assert.equal(row.recalculationUnavailable, true); assert.equal(row.partial, true);
  assert.equal(monthly.summary.lodging.coveredCompanyDays, 0, "partial source must never become a normal inventory day");
  assert.equal(monthly.summary.lodging.sold, null); assert.equal(monthly.summary.lodging.estimatedRevenue, null);
  assert.equal(monthly.summary.lodging.knownPartialPublicRevenue, 1234560, "known public subtotal must not be rejected because retired phone allocations remain");
  assert.equal(monthly.summary.lodging.knownPartialBlockedRevenue, 0);
  assert.equal(monthly.summary.lodging.knownPartialCompanyDays, 1);
  assert.equal(monthly.sources.partialEvidence[0].reason, "capacity_recalculation_unavailable");
  assert.equal(row.phoneAllocatedBookings, 0); assert.equal(row.phoneAllocatedRevenue, 0);
  assert.equal(row.phoneRevenueLow, null); assert.equal(row.phoneRevenueHigh, null); assert.equal(row.phoneRevenueRangeComplete, false);
  assert.equal(row.phoneValuation, null); assert.equal(row.priceRecoveryPolicy, null);
  assert.deepEqual(JSON.parse(JSON.stringify(row.priceUnknownCauses)), [original.productSnapshot.daily[0].priceUnknownCauses[0]]);
  assert.equal(projected.revenue.lodging.phoneAllocatedBookings, null); assert.equal(projected.revenue.lodging.phoneAllocatedRevenue, null);
  assert.equal(projected.revenue.lodging.phoneRevenueLow, null); assert.equal(projected.revenue.lodging.phoneRevenueHigh, null);
  assert.equal(projected.revenue.lodging.phoneValuation, null); assert.equal(projected.revenue.lodging.priceRecoveryPolicy, null);
  assert.equal(JSON.stringify(original), before, "raw snapshot and former valuation evidence stay byte-equivalent");
});

test("a saved 27-to-26 capacity fallback preserves the evidenced 24 public bookings as a separate 5976000 partial subtotal", () => {
  // Minimal values from a saved recalculated row. No server, provider or raw
  // files are read or changed, and this is not a normal-day promotion.
  const saved = { companyId: "cmp_place_capacity_fallback_fixture", productType: "lodging", date: "2026-09-24", stayDate: "2026-09-24",
    runId: "pocheon_glamping_20260921_145744", collectedAt: "2026-09-21T06:02:27.815Z", inventoryEvidenceVersion: 5,
    supply: 27, rawTotal: 26, available: 2, sold: 25, publicBookings: 24, phoneBookings: 1,
    publicRevenue: 5976000, phoneRevenue: 249000, estimatedRevenue: 6225000,
    phonePricedBookings: 1, phoneMissingPriceBookings: 0, phoneAllocatedBookings: 1, phoneAllocatedRevenue: 249000,
    phoneRevenueLow: 249000, phoneRevenueHigh: 249000, phoneFallbackBookings: 0, phoneFallbackRevenue: 0,
    phonePriceEstimates: [{ productKey: null, productKeys: ["4066789", "4066841"], quantity: 1, unitPrice: 249000,
      revenue: 249000, sourceDate: "2026-09-24", source: "same_product_same_date", recoveryPolicy: "uniform_current_catalog_price_v1" }],
    phoneValuation: { policy: "proportional_product_shortfall_v2", recoveryPolicies: [{ policy: "uniform_current_catalog_price_v1", quantity: 1, revenue: 249000 }] },
    priceRecoveryPolicy: "inventory_price_recovery_v1", priceUnknownCauses: [], capacityConflict: false, inventoryConflict: false,
    capacityBasis: { count: 27, source: "observed_maximum" }, partial: false, missing: false };
  const before = JSON.stringify(saved), row = projectHistory(saved, { maximum: 26 });
  const monthly = buildMonthlyReportSnapshot({ type: "company", targetId: saved.companyId, month: "2026-09", cutoffDate: "2026-09-30" }, {
    companies: [{ companyId: saved.companyId, capacity: 26 }],
    runs: [{ id: saved.runId, collectedAt: saved.collectedAt, collectionQuality: { status: "complete" } }], observations: [row]
  }, "2026-10-01T00:00:00.000Z");
  assert.equal(row.supply, 26); assert.equal(row.sold, 24); assert.equal(row.phoneBookings, 0); assert.equal(row.phoneRevenue, 0);
  assert.equal(row.recalculationUnavailable, true); assert.equal(row.partial, true);
  assert.equal(row.phoneAllocatedBookings, 0); assert.equal(row.phoneAllocatedRevenue, 0);
  assert.equal(monthly.summary.lodging.coveredCompanyDays, 0); assert.equal(monthly.summary.lodging.estimatedRevenue, null);
  assert.equal(monthly.summary.lodging.knownPartialRevenue, 5976000);
  assert.equal(monthly.summary.lodging.knownPartialPublicRevenue, 5976000);
  assert.equal(monthly.summary.lodging.knownPartialBlockedRevenue, 0); assert.equal(monthly.summary.lodging.knownPartialCompanyDays, 1);
  assert.ok(monthly.summary.lodging.runIds.includes(saved.runId));
  assert.equal(monthly.sources.partialEvidence[0].reason, "capacity_recalculation_unavailable");
  assert.equal(monthly.sources.partialEvidence[0].includedInPartialSubtotal, true);
  assert.equal(JSON.stringify(saved), before);
});

test("current-capacity snapshots retain their normal phone evidence and no-money fallbacks never become observed zero revenue", () => {
  const original = fixture();
  assert.equal(project(original, { maximum: 25 }), original, "no changed basis means no fallback and no metadata removal");
  for (const amount of [null, 0]) {
    const snapshot = fixture(); snapshot.productSnapshot.daily[0].publicRevenue = amount;
    const row = project(snapshot, { maximum: 26 }).productSnapshot.daily[0], monthly = report(row);
    assert.equal(row.publicRevenue, amount); assert.equal(monthly.summary.lodging.knownPartialRevenue, null);
    assert.equal(monthly.summary.lodging.estimatedRevenue, null); assert.equal(monthly.summary.lodging.coveredCompanyDays, 0);
  }
});
