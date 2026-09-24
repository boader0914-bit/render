"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the server's real projection functions without starting a listener or
// reading/writing any production snapshots.
const source = fs.readFileSync(path.join(__dirname, "glamping_app_server.cjs"), "utf8");
const names = [
  "productSnapshotNumber", "productSnapshotType", "productSnapshotDate",
  "productSnapshotObservation", "dayOfWeekFromDate", "toNullableRate", "inventoryEstimateBreakdown",
  "companyMaximumRoomCapacity", "withCompanyInventoryCapacity", "withCompanyInventoryCapacityRecord", "companyProductAvailabilityMatch",
  "companyInventoryNeedsEvidenceRecovery", "companyInventorySnapshotWithCurrentCapacity", "applyCompanyManualCorrection",
  "companySnapshotEstimatedRevenue", "snapshotNumber", "companyHistoryObservationWithCurrentCapacity",
  "companySalesSignalFromItem", "companyRevenueSnapshotFromItem", "companyRevenueSnapshotPart", "hasActiveManualCorrection",
  "recoverCompanyProductSourceFromRuns",
  "summarizeAvailabilityRows",
  "manualCorrectionLodgingBasisTotal", "manualCorrectionRoomSegmentTotal", "manualCorrectionRoomSegments",
  "sanitizeManualCorrectionRoomSegments", "sanitizeB2BInterestLodgeSegment", "b2bInterestLodgeSegmentHasInput",
  "sanitizeInterestLodgeNumberText", "sanitizeManualCorrectionMeta", "manualCorrectionHasValue",
  "manualCorrectionHasBasis", "manualCorrectionMetaHasValue", "maxPositiveNumber",
  "historySeriesForItem", "normalizeSignalRows", "averageSignalRate",
  "summarizeProductSalesSignal", "compactProductSnapshotDaily",
  "applyManualBasisToSalesSummary", "buildHistoryObservations",
  "companyHistoryDailyIdentity", "historyDailyObservationMatchesCompany",
  "historyDailyObservationOrder", "historyDailyObservationIsNewer",
  "companyHistoryDailyFallback", "dateDiffDays", "stableHash",
  "normalizeObservationNumber", "normalizeCompanyIdentityName"
];
const context = vm.createContext({
  COMPANY_PRODUCT_SNAPSHOT_DAILY_LIMIT: 64,
  B2B_INTEREST_LODGE_SEGMENT_LIMIT: 12,
  applyInventoryEvidence: require("./inventory_estimation.cjs").applyInventoryEvidence,
  sanitizeMemberText: (value, max) => String(value || "").trim().slice(0, max),
  COLLECTION_PURPOSES: { revenue_detail: "상세정보 수집" },
  crypto: require("node:crypto"),
  extractNaverPlaceId: (item) => item.placeId || item.place_id || "",
  extractBookingBusinessId: (item) => item.bookingBusinessId || "",
  runCollectionDbRoute: () => ({ key: "test", label: "test" }),
  normalizeCollectionPurpose: () => "revenue_detail",
  compactKeyword: (value) => String(value || "").replace(/\s+/g, ""),
  kstDayKeyFromValue: (value) => String(value).slice(0, 10),
  boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit)
});
for (const name of names) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  const next = /\n(?:async )?function /.exec(source.slice(start + 1));
  const end = next ? start + 1 + next.index : -1;
  vm.runInContext(source.slice(start, end < 0 ? source.length : end), context);
}

const closedDayUse = context.productSnapshotObservation({
  date: "2026-09-26", bizItemId: "4223868", name: "당일글램핑", saleType: "데이유즈",
  total: 1, available: 0, soldOut: 1, stock: 0, bookingCount: 0,
  occupiedBookingCount: 0, open: false, price: 0
});
assert.equal(closedDayUse.sold, 0, "closed-day synthetic soldOut cannot override an explicit zero booking count");
assert.equal(closedDayUse.price, null);
assert.equal(closedDayUse.open, false);

const occupied = context.productSnapshotObservation({
  date: "2026-10-05", bizItemId: "room", name: "객실", saleType: "숙박",
  stock: 8, available: 3, soldOut: 5, bookingCount: 2, occupiedBookingCount: 3, price: 100000
});
assert.equal(occupied.sold, 2, "unverified occupied inventory must not become observed bookings");
assert.equal(occupied.unverifiedOccupied, 3);
const closedBooked = context.productSnapshotObservation({
  date: "2026-10-05", bizItemId: "room", name: "객실", stock: 0,
  bookingCount: 2, occupiedBookingCount: 0, open: false, price: 100000
});
assert.equal(closedBooked.sold, 2, "explicit bookings survive a contradictory closed state and stock zero");
assert.equal(context.productSnapshotObservation({
  bizItemId: "missing", name: "상품", open: false
}).sold, null, "missing closed-day booking fields stay unknown");

const fixture = {
  weeklyDetail: "10/5 0/28",
  weeklyRevenueDetail: "10/5 2,800,000원(28개)",
  dayUseWeeklyRevenueDetail: "9/26 297,000원(3회)",
  inventoryEvidence: {
    version: 2,
    lodging: { rows: [
      { date: "2026-10-05", total: 21, available: 16, sold: 2, unverifiedOccupied: 3,
        inventoryShortfall: 0, estimatedRevenue: 200000, pricedSoldOut: 2, missingPriceSoldOut: 0 },
      { date: "2026-10-06", total: 27, available: 24, sold: 3, unverifiedOccupied: 0,
        inventoryShortfall: 0, estimatedRevenue: 330000, pricedSoldOut: 3, missingPriceSoldOut: 0 }
    ] },
    dayUse: { rows: [
      { date: "2026-09-26", total: 0, available: 0, sold: 0, unverifiedOccupied: 0,
        inventoryShortfall: 3, estimatedRevenue: 0, pricedSoldOut: 0, missingPriceSoldOut: 0 },
      { date: "2026-10-05", total: 3, available: 1, sold: 2, unverifiedOccupied: 0,
        inventoryShortfall: 0, estimatedRevenue: 198000, pricedSoldOut: 2, missingPriceSoldOut: 0 },
      { date: "2026-10-07", total: 0, available: 0, sold: 0, estimatedRevenue: 0, missing: true }
    ] }
  }
};
const before = JSON.stringify(fixture);
const history = context.historySeriesForItem(fixture, "lodging", "2026-10-05");
const signal = context.summarizeProductSalesSignal(history);
assert.equal(signal.totalSupply, 48, "variable daily supply is summed without re-normalizing to a fixed capacity");
assert.equal(signal.totalSold, 5, "availability gaps do not restore excluded occupancy as sales");
assert.equal(signal.averageRate, 0.104, "period rate uses the same summed numerator and denominator");

const daily = context.compactProductSnapshotDaily(fixture, { checkIn: "2026-10-05" }, [occupied, closedDayUse]);
const lodgingDay = daily.find((row) => row.productType === "lodging" && row.date === "2026-10-05");
assert.equal(lodgingDay.sold, 2, "day-use bookings do not subtract explicit lodging bookings");
assert.equal(lodgingDay.estimatedRevenue, 200000, "legacy revenue strings cannot override evidence-based daily amounts");
assert.equal(lodgingDay.actualRevenue, null);
assert.equal(lodgingDay.offlineReserved, 0);
const dayUseDay = daily.find((row) => row.productType === "dayuse" && row.date === "2026-10-05");
assert.equal(dayUseDay.sold, 2);
assert.equal(dayUseDay.estimatedRevenue, 198000);
const closed = daily.find((row) => row.date === "2026-09-26");
assert.equal(closed.sold, 0);
assert.equal(closed.estimatedRevenue, 0);
assert.equal(closed.reservationRate, null);
const missing = daily.find((row) => row.date === "2026-10-07");
assert.equal(missing.total, null);
assert.equal(missing.sold, null);
assert.equal(missing.estimatedRevenue, null, "failed collection must not manufacture a zero-revenue observation");
assert.equal(JSON.stringify(fixture), before, "read projections preserve stored evidence");
assert.equal(JSON.stringify(context.compactProductSnapshotDaily(fixture, {}, [occupied, closedDayUse])), JSON.stringify(daily));

const originalSummary = { days: 31, totalSupply: 675, totalSold: 151, averageRate: 0.224, minTotal: 13, maxTotal: 27 };
const manual = context.applyManualBasisToSalesSummary(originalSummary, 28);
assert.equal(manual.totalSupply, 675);
assert.equal(manual.totalSold, 151);
assert.equal(manual.averageRate, 0.224);
assert.equal(manual.manualPotentialSupply, 868);
assert.equal(manual.manualInventoryGap, 193);
assert.equal(manual.manualOfflineReserved, 0);
assert.equal(manual.manualBasisUsedForSales, false);
assert.equal(context.applyManualBasisToSalesSummary(manual, 28).totalSold, 151);
assert.equal(originalSummary.totalSupply, 675);

const recorded = context.buildHistoryObservations({
  run: { id: "run_20260920", checkIn: "2026-10-05", keyword: "포천글램핑" },
  availability: { items: [{ ...fixture, name: "테스트", companyId: "cmp_evidence", price: "999,000원" }] }
}, "2026-09-20T06:00:00.000Z");
const historyLodging = recorded.find((row) => row.productType === "lodging" && row.stayDate === "2026-10-05");
assert.equal(historyLodging.sold, 2, "history persistence keeps explicit bookings instead of total minus availability");
assert.equal(historyLodging.unverifiedOccupied, 3);
assert.equal(historyLodging.estimatedRevenue, 200000);
assert.equal(historyLodging.price, "", "an unrelated facility price cannot replace same-date product revenue evidence");
const restored = context.companyHistoryDailyFallback({ companyId: "cmp_evidence", primaryName: "테스트" }, recorded);
const restoredLodging = restored.daily.find((row) => row.productType === "lodging" && row.date === "2026-10-05");
assert.equal(restoredLodging.sold, 2, "unverified occupancy does not make an evidence-based booking count contradictory");
assert.equal(restoredLodging.estimatedRevenue, 200000);
assert.equal(restoredLodging.unverifiedOccupied, 3);
assert.equal(restored.daily.find((row) => row.date === "2026-09-26").sold, 0);

const fixedFixture = {
  inventoryEvidence: { version: 3, lodging: { rows: [
    { date: "2026-09-26", total: 10, rawTotal: 3, available: 0, sold: 10,
      publicBookings: 3, phoneBookings: 7, sharedDayUseExcluded: 0, unknownUnavailable: 0,
      estimatedRevenue: 3200000, publicRevenue: 960000, phoneRevenue: 2240000,
      pricedSoldOut: 10, missingPriceSoldOut: 0, inventoryShortfall: 7 },
    { date: "2026-09-27", total: 10, rawTotal: 10, available: 6, sold: 2,
      publicBookings: 1, phoneBookings: 1, sharedDayUseExcluded: 2, unknownUnavailable: 0,
      estimatedRevenue: 400000, publicRevenue: 200000, phoneRevenue: 200000,
      pricedSoldOut: 2, missingPriceSoldOut: 0, inventoryShortfall: 0 }
  ] }, dayUse: null }
};
const fixedSeries = context.historySeriesForItem(fixedFixture, "lodging", "2026-09-26");
const fixedSignal = context.summarizeProductSalesSignal(fixedSeries);
assert.equal(fixedSignal.totalSupply, 20);
assert.equal(fixedSignal.totalSold, 12);
assert.equal(fixedSignal.phoneBookings, 8);
assert.equal(fixedSignal.publicBookings, 4);
assert.equal(fixedSignal.sharedDayUseExcluded, 2);
assert.equal(fixedSignal.averageRate, 0.6);
const fixedDaily = context.compactProductSnapshotDaily(fixedFixture, {}, []);
assert.equal(fixedDaily[0].inventoryEvidenceVersion, 3);
assert.equal(fixedDaily[0].offlineReserved, 7);
assert.equal(fixedDaily[0].phoneRevenue, 2240000);
assert.equal(fixedDaily[1].sharedDayUseExcluded, 2);
assert.equal(fixedDaily[1].sold, 2, "shared day-use is not reintroduced through total minus available");
const fixedRecorded = context.buildHistoryObservations({
  run: { id: "fixed_run", checkIn: "2026-09-26" },
  availability: { items: [{ ...fixedFixture, name: "시즌 테스트", companyId: "cmp_fixed" }] }
}, "2026-09-21T08:10:00.000Z");
assert.equal(fixedRecorded[0].phoneBookings, 7);
assert.equal(fixedRecorded[0].inventoryEvidenceVersion, 3);
const fixedRestored = context.companyHistoryDailyFallback({ companyId: "cmp_fixed" }, fixedRecorded);
assert.equal(fixedRestored.daily[0].sold, 10);
assert.equal(fixedRestored.daily[0].phoneBookings, 7);
assert.equal(fixedRestored.daily[1].sharedDayUseExcluded, 2);
assert.equal(fixedRestored.daily[1].sold, 2);
const missingFixed = context.summarizeProductSalesSignal([
  ...fixedSeries,
  { inventoryEvidenceVersion: 3, stayDate: "2026-09-28", total: 10, missing: true, unknownUnavailable: 10 }
]);
assert.equal(missingFixed.totalSupply, 30, "a failed day does not shrink maximum-room capacity");
assert.equal(missingFixed.totalSold, 12, "a failed day is not a telephone booking");
assert.equal(missingFixed.averageRate, null);
const capacityCompanies = [{
  companyId: "cmp_fixed", placeIds: ["10"], bookingBusinessIds: ["100"], inventory: {
    latest: { stockBasis: { lodgingMaxTotal: 8 } },
    snapshots: [{ stockBasis: { lodgingMaxTotal: 10 } }]
  }
}, { companyId: "cmp_other", placeIds: ["20"], bookingBusinessIds: ["200"], inventory: {
  latest: { stockBasis: { lodgingMaxTotal: 50 } }
} }];
const fixedInput = { placeId: "10", bookingBusinessId: "100", name: "same name" };
assert.equal(context.withCompanyInventoryCapacity(fixedInput, capacityCompanies).inventoryCapacityBaseline.lodging, 10);
assert.equal(context.withCompanyInventoryCapacity({ name: "same name" }, capacityCompanies).inventoryCapacityBaseline, undefined);
assert.equal(context.withCompanyInventoryCapacity({ placeId: "10", bookingBusinessId: "200" }, capacityCompanies).inventoryCapacityBaseline, undefined);
assert.equal(fixedInput.inventoryCapacityBaseline, undefined);

const sourceItem = {
  ...fixedInput,
  weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", saleType: "숙박", stock: 10, bookingCount: 1, price: 100000 }]
};
const correctedCompany = {
  ...capacityCompanies[0],
  manualCorrection: { active: true, roomSegments: [{ type: "기본", count: 4 }, { type: "대형", count: 2 }], updatedAt: "2026-09-23T01:00:00Z" }
};
const sourceBefore = JSON.stringify(sourceItem);
const companyBefore = JSON.stringify(correctedCompany);
const baseline = context.withCompanyInventoryCapacity(sourceItem, [correctedCompany]).inventoryCapacityBaseline;
assert.equal(baseline.lodging, 10, "observed maximum remains separate from the DB correction");
assert.equal(baseline.lodgingOverride.count, 6, "DB room segment counts provide the authoritative correction");
assert.equal(baseline.lodgingOverride.source, "db_manual_correction");
const corrected = context.applyCompanyManualCorrection(sourceItem, correctedCompany);
assert.equal(corrected.inventoryEvidence.version, 4);
assert.equal(corrected.inventoryEvidence.capacityBasis.source, "db_correction");
assert.equal(corrected.inventoryEvidence.lodging.operatingTotal, 6, "lower DB correction wins over an observed maximum");
assert.equal(corrected.weeklyBasisTotal, 6);
assert.equal(corrected.nightTotalStock, 6);
assert.equal(corrected.totalRooms, 6);
assert.equal(corrected.inventoryEvidence.lodging.rows[0].phoneBookings, 0);
assert.equal(corrected.inventoryEvidence.lodging.rows[0].rate, null, "contradictory public counts are not a valid rate");
assert.equal(corrected.inventoryEvidence.lodging.rows[0].publicBookings, 1);
const increased = context.applyCompanyManualCorrection(corrected, {
  ...correctedCompany, manualCorrection: { active: true, lodgingBasisTotal: 12 }
});
assert.equal(increased.weeklyBasisTotal, 12, "a saved v4 read view recalculates when correction changes");
const restoredObserved = context.applyCompanyManualCorrection(increased, { ...correctedCompany, manualCorrection: null });
assert.equal(restoredObserved.weeklyBasisTotal, 10, "clearing the DB correction restores the observed maximum");
assert.equal(restoredObserved.inventoryCapacityBaseline.lodgingOverride, undefined);
assert.equal(restoredObserved.inventoryEvidence.capacityBasis.source, "observed_maximum");
assert.equal(JSON.stringify(sourceItem), sourceBefore);
assert.equal(JSON.stringify(correctedCompany), companyBefore);

const correctedHistory = {
  inventory: { latest: {
    stockBasis: { lodgingMaxTotal: 100 }, salesSignal: { lodging: { maxTotal: 100 } },
    productSnapshot: { inventoryEvidenceVersion: 3, daily: [{ productType: "lodging", total: 100, rawTotal: 10 }] }
  } }
};
assert.equal(context.companyMaximumRoomCapacity(correctedHistory), 10, "old guide or correction totals do not contaminate observed maxima");
assert.equal(context.companyMaximumRoomCapacity({ inventory: { latest: {
  productSnapshot: { inventoryEvidenceVersion: 4, capacityBasis: { observedMaximum: 28 },
    daily: [{ productType: "lodging", total: 28, rawTotal: 21 }] }
} } }), 28, "trusted v4 observed maximum survives after older runs age out");
const legacyRead = context.companyInventorySnapshotWithCurrentCapacity(correctedHistory.inventory.latest, correctedHistory);
assert.equal(legacyRead.productSnapshot.daily[0].total, 10, "snapshot-only v3 guide totals are removed even without a DB override");
assert.equal(legacyRead.capacityReview.required, true);
assert.equal(legacyRead.productSnapshot.daily[0].phoneBookings, 0);
const snapshotCompany = {
  ...correctedCompany,
  inventory: { latest: {
    runId: "saved_run", productSnapshot: {
      inventoryEvidenceVersion: 4, products: [{ key: "room" }], capacityBasis: { count: 10, source: "observed_maximum", observedMaximum: 10 },
      daily: [{ date: "2026-09-26", productType: "lodging", total: 10, rawTotal: 10, available: 7,
        publicBookings: 1, phoneBookings: 2, sold: 3, publicRevenue: 100000, phoneRevenue: 200000, estimatedRevenue: 300000,
        reservationRate: 0.3, inventoryEvidenceVersion: 4 }]
    },
    salesSignal: { lodging: { days: 1, minTotal: 10, maxTotal: 10, totalSupply: 10, totalSold: 3, phoneBookings: 2, averageRate: 0.3 } },
    revenue: { lodging: { revenue: 300000, adjustedRevenue: 300000 } }
  } }
};
assert.equal(context.companyInventoryNeedsEvidenceRecovery(snapshotCompany), true, "lower corrections request source recovery");
const savedSnapshot = snapshotCompany.inventory.latest;
const savedBefore = JSON.stringify(savedSnapshot);
const fallback = context.companyInventorySnapshotWithCurrentCapacity(savedSnapshot, snapshotCompany);
assert.equal(fallback.productSnapshot.daily[0].total, 6);
assert.equal(fallback.productSnapshot.daily[0].publicBookings, 1);
assert.equal(fallback.productSnapshot.daily[0].phoneBookings, 0);
assert.equal(fallback.productSnapshot.daily[0].estimatedRevenue, 100000, "only explicit public revenue survives without original product evidence");
assert.equal(fallback.productSnapshot.daily[0].reservationRate, null);
assert.equal(fallback.salesSignal.lodging.averageRate, null);
assert.equal(fallback.revenue.lodging.adjustedRevenue, null);
assert.equal(context.companySnapshotEstimatedRevenue({ ...fallback, price: 100000 }).estimatedRevenue, null, "missing recalculation is not a zero-revenue result");
assert.equal(fallback.capacityReview.required, true);
assert.equal(JSON.stringify(savedSnapshot), savedBefore, "snapshot-only fallback is a read projection");
const freshSnapshot = {
  ...savedSnapshot,
  productSnapshot: { ...savedSnapshot.productSnapshot, capacityBasis: { count: 6, source: "db_correction", observedMaximum: 10 },
    daily: savedSnapshot.productSnapshot.daily.map((row) => ({ ...row, total: 6 })) },
  salesSignal: { lodging: { minTotal: 6, maxTotal: 6 } }
};
assert.equal(context.companyInventorySnapshotWithCurrentCapacity(freshSnapshot, snapshotCompany), freshSnapshot);
assert.equal(context.companyInventoryNeedsEvidenceRecovery({ ...snapshotCompany, inventory: { latest: freshSnapshot } }), false);
assert.equal(context.companyInventoryNeedsEvidenceRecovery({ ...snapshotCompany, manualCorrection: null, inventory: { latest: freshSnapshot } }), true, "clearing a correction requests recovery even when version is current");
const originalHistoryRow = {
  ...savedSnapshot.productSnapshot.daily[0], companyKey: correctedCompany.companyId,
  stayDate: "2026-09-26", supply: 10, runId: "saved_run", collectedAt: "2026-09-23T01:00:00Z"
};
const projectedHistory = context.companyHistoryDailyFallback(snapshotCompany, [originalHistoryRow]);
assert.equal(projectedHistory.daily[0].total, 6);
assert.equal(projectedHistory.daily[0].phoneBookings, 0);
assert.equal(projectedHistory.daily[0].publicBookings, 1);
assert.equal(projectedHistory.daily[0].reservationRate, null);
assert.equal(originalHistoryRow.phoneBookings, 2, "history read projection preserves the persisted observation");
const clearedHistory = context.companyHistoryDailyFallback({ ...snapshotCompany, manualCorrection: null }, [{
  ...originalHistoryRow, supply: 6, total: 6
}]);
assert.equal(clearedHistory.daily[0].total, 10, "old v4 history without basis metadata is invalidated when the correction is cleared");
assert.equal(clearedHistory.daily[0].reservationRate, null);

// Keep unrelated legacy CSV parsing and confidence scoring out of this fixture;
// exercise the real row-to-evidence boundary with an otherwise anonymous name.
Object.assign(context, {
  numericField: (row, fields) => context.productSnapshotNumber(fields.map((key) => row[key]).find((value) => value !== undefined)),
  jsonArrayField: (row, fields) => fields.map((key) => row[key]).find(Array.isArray) || [],
  parseWeeklyReservationRates: () => ({}), parseStockVarianceDetail: () => ({}), parseBasisTotalFromRule: () => null,
  resolvedStockBasis: () => ({}), offlineReservedTotalForOperating: () => 0, stockBasisRule: () => "",
  naverChannelObservationFromItem: () => ({}), availabilityPlaceKey: (row) => `place:${row.placeId}`,
  availabilityBookingBusinessId: () => "", rowSearchRegion: () => "", rowAddressRegion: () => "",
  regionBoundaryInfo: () => ({}), normalizeInventoryMemo: () => "",
  evaluateInventoryConfidence: () => ({ structure: {} }), naverCouponSignalFromItem: () => ({ named: false })
});
const largeRow = { placeId: "no_glamping_name", name: "양주 르", totalRooms: 50, availableRooms: 49,
  weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", stock: 50, bookingCount: 1, price: 100000 }] };
const keywordReview = context.summarizeAvailabilityRows([largeRow], "", [], { keyword: "검증글램핑" }).items[0];
assert.equal(keywordReview.inventoryEvidence.lodging.operatingTotal, 50);
assert.equal(keywordReview.inventoryEvidence.capacityReview.required, true, "collection keyword enables >40 review even when the name has no glamping text");
const typeReview = context.applyCompanyManualCorrection({ ...sourceItem, name: "양주 르", weeklyProductDetails: largeRow.weeklyProductDetails }, {
  ...capacityCompanies[0], lodgingTypes: ["글램핑"]
});
assert.equal(typeReview.inventoryEvidence.capacityReview.required, true, "the same-company DB lodging type reaches the inventory policy");

for (const [mode, scheduleStatus] of [["inspect", "not_requested"], ["lodging_only", "excluded"], ["detail", "not_requested_basic"]]) {
  for (const presence of ["present", "unknown", "absent"]) {
    const unqueriedRow = { placeId: "day-use-unqueried", name: "검증업체", totalRooms: 10, availableRooms: 5,
      dayUseMode: mode, dayUsePresence: presence, dayUseScheduleStatus: scheduleStatus, dayUseSharingStatus: "unconfirmed",
      "데이유즈상품수": presence === "present" ? 1 : "",
      weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", stock: 10,
        bookingCount: 1, occupiedBookingCount: 4, price: 100000 }] };
    const result = context.summarizeAvailabilityRows([unqueriedRow], "", [], { keyword: "검증", checkIn: "2026-09-26" });
    const item = result.items[0];
    assert.equal(item.dayUseMode, mode);
    assert.equal(item.dayUsePresence, presence);
    assert.equal(item.inventoryEvidence.dayUse, null);
    assert.equal(item.inventoryEvidence.lodging.phoneBookings, presence === "absent" ? 4 : 0);
    const sales = context.companySalesSignalFromItem(item, { checkIn: "2026-09-26" });
    assert.equal(sales.dayUse.totalSold, null, "company DB never treats unqueried day-use sales as observed zero");
    assert.equal(sales.dayUse.totalSupply, null);
    assert.equal(sales.dayUse.observed, false);
    assert.equal(sales.dayUseMissing, true);
    assert.equal(sales.dayUse.missingReason, presence === "absent" ? "no_day_use_product" : scheduleStatus);
    const revenue = context.companyRevenueSnapshotFromItem(item);
    assert.equal(revenue.dayUse.revenue, null);
    assert.equal(revenue.dayUse.adjustedRevenue, null);
    assert.equal(revenue.dayUse.observed, false);
    assert.equal(result.stats.dayUseEstimatedRevenue, null, "run summary retains unobserved revenue as null");
    assert.equal(result.stats.dayUseObservedCount, 0);
    assert.equal(result.stats.dayUseUnobservedCount, 1);
    const historyRows = context.buildHistoryObservations({ run: { id: "day_use_fixture", keyword: "검증", checkIn: "2026-09-26" },
      availability: { items: [{ ...item, companyId: "cmp_day_use" }] } }, "2026-09-24T00:00:00Z");
    assert.equal(historyRows.filter(row => row.productType === "dayuse").length, 0);
    assert.equal(historyRows[0].phoneBookings, presence === "absent" ? 4 : 0);
    assert.equal(historyRows[0].dayUseMode, mode);
    assert.equal(historyRows[0].dayUseScheduleStatus, scheduleStatus);
    const dailySnapshot = context.compactProductSnapshotDaily(item, { checkIn: "2026-09-26" });
    assert.equal(dailySnapshot[0].dayUsePresence, presence);
    assert.equal(dailySnapshot[0].dayUseScheduleStatus, scheduleStatus);
    const fallbackSnapshot = context.companyHistoryDailyFallback({ companyId: "cmp_day_use" }, historyRows);
    assert.equal(fallbackSnapshot.daily[0].dayUseMode, mode);
    assert.equal(fallbackSnapshot.daily[0].dayUseScheduleStatus, scheduleStatus);
  }
}
const legacyProjection = context.summarizeAvailabilityRows([{ ...largeRow, weeklyProductDetails: [{
  date: "2026-09-26", bizItemId: "room", name: "숙박", stock: 10, bookingCount: 1, occupiedBookingCount: 4, price: 100000
}] }], "", [], { checkIn: "2026-09-26" });
assert.equal(legacyProjection.items[0].dayUsePresence, undefined, "legacy absence of metadata is not silently upgraded to unknown");
assert.equal(legacyProjection.items[0].inventoryEvidence.lodging.phoneBookings, 4, "legacy calculation remains unchanged");
assert.equal(legacyProjection.stats.dayUseEstimatedRevenue, 0, "legacy summary compatibility is retained");

const trueZero = context.companySalesSignalFromItem({ dayUseMode: "detail", dayUsePresence: "present", dayUseScheduleStatus: "requested",
  inventoryEvidence: { version: 4, dayUse: { rows: [{ date: "2026-09-26", total: 3, available: 3, sold: 0,
    publicBookings: 0, phoneBookings: 0, partial: false, missing: false }] } } }, { checkIn: "2026-09-26" });
assert.equal(trueZero.dayUse.totalSold, 0, "observed normal zero bookings remain zero");
assert.equal(trueZero.dayUse.totalSupply, 3);
assert.equal(trueZero.dayUse.averageRate, 0);

const recoveryCompany = { companyId: "recovery", placeIds: ["10"], runIds: ["old", "latest"], inventory: {
  latest: { stockBasis: { lodgingMaxTotal: 21 }, productSnapshot: { inventoryEvidenceVersion: 3 } },
  snapshots: [{ stockBasis: { lodgingMaxTotal: 28 }, productSnapshot: { inventoryEvidenceVersion: 3 } }]
} };
context.listRuns = async () => [];
context.companyProductStoredRunTimeMap = () => new Map();
context.companyProductRecoveryRunIds = () => ["old", "latest"];
context.companyProductRunObservedAt = (_company, _observations, runId) => runId === "old" ? "2026-09-20T01:00:00Z" : "2026-09-23T01:00:00Z";
context.loadRun = async (runId) => ({ run: { id: runId }, availability: { items: [{
  placeId: "10", weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", saleType: "숙박",
    stock: runId === "old" ? 27 : 21, bookingCount: 1, price: 100000 }]
}] } });
context.companySalesSignalFromItem = (item) => ({ lodging: { maxTotal: item.weeklyBasisTotal } });
context.companyRevenueSnapshotFromItem = () => ({});
context.compactCompanyProductSnapshot = (item) => ({ products: [{ key: "room" }], capacityBasis: item.inventoryEvidence.capacityBasis });
context.buildHistoryObservations = () => [];
context.recoverCompanyProductSourceFromRuns(recoveryCompany, []).then((recovered) => {
  assert.equal(recovered.evidenceProjections.length, 2);
  for (const projection of recovered.evidenceProjections) {
    assert.equal(projection.snapshot.salesSignal.lodging.maxTotal, 27, "all recovered runs share the maximum observed across their raw sources");
    assert.equal(projection.snapshot.productSnapshot.capacityBasis.observedMaximum, 27);
  }
  console.log("Inventory evidence server projection tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
