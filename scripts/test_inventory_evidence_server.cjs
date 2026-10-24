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
  "createCompanyInventoryCapacityIndex", "withIndexedCompanyInventoryCapacity",
  "companyInventoryNeedsEvidenceRecovery", "companyInventorySnapshotWithCurrentCapacity", "applyCompanyManualCorrection",
  "companySnapshotEstimatedRevenue", "snapshotNumber", "companyHistoryObservationWithCurrentCapacity",
  "companySalesSignalFromItem", "companyRevenueSnapshotFromItem", "companyRevenueSnapshotPart", "hasActiveManualCorrection",
  "recoverCompanyProductSourceFromRuns",
  "summarizeAvailabilityRows",
  "manualCorrectionLodgingBasisTotal", "manualCorrectionRoomSegmentTotal", "manualCorrectionRoomSegments",
  "sanitizeManualCorrectionRoomSegments", "sanitizeB2BInterestLodgeSegment", "b2bInterestLodgeSegmentHasInput",
  "sanitizeInterestLodgeNumberText", "sanitizeManualCorrectionMeta", "manualCorrectionHasValue",
  "manualCorrectionHasBasis", "manualCorrectionMetaHasValue", "maxPositiveNumber",
  "parseBasisTotalFromRule", "operatingTotalFromVarianceRows", "resolvedStockBasis", "stockBasisRule",
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
  buildCapacityReview: require("./inventory_estimation.cjs").buildCapacityReview,
  collectionCapacityCoverageForBusiness: require("./lib/collection_capacity_coverage.cjs").collectionCapacityCoverageForBusiness,
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

// Historical production rules include a period-wide inventory gap after the
// actual room-count candidate. That aggregate must never raise room capacity.
for (const [name, count, days, gap] of [
  ["월명", 16, 27, 27], ["시즌", 10, 21, 28], ["피카푸", 38, 2, 147],
  ["토리", 19, 19, 103], ["더뷰", 29, 9, 56]
]) {
  const rule = `전체객실수후보=${count}개(날짜별 총량 최대값, ${days}일 확인) · 운영기준 미만 ${gap}개 오프라인/차단 추정`;
  assert.equal(context.parseBasisTotalFromRule(rule), count, `${name}: the period gap is not room capacity`);
  const basis = context.resolvedStockBasis({
    basisTotal: count, explicitBasisTotal: count, storedRule: rule,
    variance: { rows: [{ rawTotal: count }, { rawTotal: count - 1 }] }
  });
  assert.equal(basis.basisTotal, count, `${name}: legacy projection keeps the observed capacity`);
  assert.equal(basis.operatingTotal, count);
  assert.equal(context.stockBasisRule(rule, count, count, 0, gap), rule, "stored source text remains unchanged");
}
for (const [rule, count] of [
  ["전체객실수후보 19 · 운영기준 16", 19],
  ["데이유즈/캠프닉총량후보=3회(날짜별 총량 최대값)", 3],
  ["DB 보정값 = 10실", 10], ["보정값：10동", 10],
  ["기준=10", 10], ["후보: 12개", 12],
  ["전체객실수후보=19개 · 운영판매기준=16개 · 상시차단/운영축소 3개", 19]
]) assert.equal(context.parseBasisTotalFromRule(rule), count, `explicit legacy quantity: ${rule}`);
for (const rule of [
  "운영기준 미만 103개 오프라인/차단 추정", "기준 미만 147개", "기간 합계=147개",
  "기준 2명, 31일 기준", "기준=31일", "후보=10.5개", "보정값=1,000개", "기준=100000실",
  "전체객실수후보=0개", "기준 2026-09-20", "기준=28%", ""
]) assert.equal(context.parseBasisTotalFromRule(rule), null, `unrelated or ambiguous quantity: ${rule}`);

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
const fallbackPricingFixture = {
  ...fixedFixture,
  inventoryEvidence: { ...fixedFixture.inventoryEvidence, version: 4, phoneValuationPolicy: "same_product_observed_price_v1",
    lodging: { rows: [{ ...fixedFixture.inventoryEvidence.lodging.rows[0], phoneFallbackRevenue: 2240000, phoneFallbackBookings: 7,
      phonePriceEstimates: [{ productKey: "room-1", quantity: 7, unitPrice: 320000, revenue: 2240000,
        source: "same_product_same_weekday", sourceDate: "2026-10-03" }] }] } }
};
const fallbackDaily = context.compactProductSnapshotDaily(fallbackPricingFixture, {}, []);
assert.equal(fallbackDaily[0].phoneFallbackRevenue, 2240000);
assert.equal(fallbackDaily[0].phonePriceEstimates[0].sourceDate, "2026-10-03");
assert.equal(fallbackDaily[0].phoneValuationPolicy, "same_product_observed_price_v1");
const fallbackRecorded = context.buildHistoryObservations({ run: { id: "phone_fallback", checkIn: "2026-09-26" },
  availability: { items: [{ ...fallbackPricingFixture, companyId: "cmp_phone_fallback" }] } }, "2026-09-24T01:00:00.000Z");
const fallbackRestored = context.companyHistoryDailyFallback({ companyId: "cmp_phone_fallback" }, fallbackRecorded);
assert.equal(fallbackRestored.daily[0].phoneFallbackBookings, 7);
assert.equal(fallbackRestored.daily[0].phonePriceEstimates[0].unitPrice, 320000);
assert.equal(fallbackRestored.daily[0].phoneValuationPolicy, "same_product_observed_price_v1");
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
assert.equal(corrected.inventoryEvidence.version, 5);
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

const reviewedStockRule = { bizItemId: "room", stayDate: "2026-09-26", observedStock: 10, correctedStock: 6, reason: "업주 확인 재고 설정 실수" };
const stockReviewedCompany = { ...correctedCompany, manualCorrection: { ...correctedCompany.manualCorrection, productStockCorrections: [reviewedStockRule] } };
const staleStockRule = { ...reviewedStockRule, correctedStock: 4 };
const staleStockInput = { ...sourceItem, inventoryCapacityBaseline: { companyId: "stale_company", productStockCorrections: [staleStockRule] } };
const reviewedBaseline = context.withCompanyInventoryCapacity(staleStockInput, [stockReviewedCompany]).inventoryCapacityBaseline;
assert.deepEqual(reviewedBaseline.productStockCorrections, [reviewedStockRule], "current company DB replaces an inherited product correction");
const stockReviewed = context.applyCompanyManualCorrection(staleStockInput, stockReviewedCompany);
assert.equal(stockReviewed.inventoryEvidence.lodging.rows[0].rawTotal, 6);
assert.equal(stockReviewed.inventoryEvidence.lodging.rows[0].publicBookings, 1);
assert.equal(stockReviewed.inventoryEvidence.lodging.rows[0].capacityConflict, false);
assert.equal(stockReviewed.inventoryEvidence.normalizationEvidence[0].source.stock, 10);
assert.equal(stockReviewed.inventoryEvidence.normalizationEvidence[0].applied.stock, 6);
assert.equal(sourceItem.weeklyProductDetails[0].stock, 10);
assert.equal(staleStockInput.inventoryCapacityBaseline.productStockCorrections[0].correctedStock, 4, "input is not mutated when the DB rule wins");
for (const clearedCorrection of [null, { ...stockReviewedCompany.manualCorrection, active: false }]) {
  const clearedStock = context.applyCompanyManualCorrection(stockReviewed, { ...stockReviewedCompany, manualCorrection: clearedCorrection });
  assert.equal(clearedStock.inventoryCapacityBaseline.productStockCorrections, undefined, "clearing or disabling a DB correction removes inherited product rules");
  assert.equal(clearedStock.inventoryEvidence.lodging.rows[0].rawTotal, 10, "reprojection restores original stock after clearing");
  assert.equal(clearedStock.inventoryEvidence.normalizationEvidence.length, 0);
}
const otherStockInput = { ...staleStockInput, placeId: "20", bookingBusinessId: "200" };
const otherStockProjection = context.withCompanyInventoryCapacity(otherStockInput, [stockReviewedCompany, capacityCompanies[1]]);
assert.equal(otherStockProjection.inventoryCapacityBaseline.companyId, "cmp_other");
assert.equal(otherStockProjection.inventoryCapacityBaseline.productStockCorrections, undefined, "a different matched company never inherits the reviewed company's product rule");
assert.equal(context.applyCompanyManualCorrection(otherStockProjection, capacityCompanies[1]).inventoryEvidence.lodging.rows[0].rawTotal, 10);

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
} } }), 21, "inherited v4 maxima cannot overrule actual daily stock");
assert.equal(context.companyMaximumRoomCapacity({ inventory: { latest: {
  productSnapshot: { inventoryEvidenceVersion: 4, capacityBasis: { observedMaximum: 147, currentObservedMaximum: 28 },
    daily: [{ productType: "lodging", total: 147, rawTotal: 21 }] }
} } }), 28, "run-local observed maximum survives a truncated daily snapshot without inheriting its baseline");

function pollutedCapacityCompany(current, inherited, priorStock = current, priorSales = inherited) {
  return { companyId: "pollution_fixture", placeIds: ["pollution"], inventory: {
    latest: { runId: "latest", stockBasis: { lodgingMaxTotal: inherited }, salesSignal: { lodging: { maxTotal: inherited } },
      productSnapshot: { inventoryEvidenceVersion: 4, capacityBasis: { count: inherited, source: "observed_maximum",
        observedMaximum: inherited, currentObservedMaximum: current },
        daily: [{ date: "2026-09-26", productType: "lodging", rawTotal: current, total: inherited }] } },
    previousLatest: { runId: "old", stockBasis: { lodgingMaxTotal: priorStock }, salesSignal: { lodging: { maxTotal: priorSales } } }
  } };
}
for (const [current, inherited, priorStock, expected] of [
  [19, 103, 19, 19], [10, 28, 10, 10], [37, 147, 38, 38], [29, 56, 29, 29], [44, 47, 47, 47]
]) {
  const company = pollutedCapacityCompany(current, inherited, priorStock);
  const before = JSON.stringify(company);
  assert.equal(context.companyMaximumRoomCapacity(company), expected, `current=${current}, inherited=${inherited}, prior stock=${priorStock}`);
  const input = { placeId: "pollution", weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room",
    name: "숙박", saleType: "숙박", stock: current, bookingCount: 1, price: 100000 }] };
  const projected = context.applyCompanyManualCorrection(input, company);
  assert.equal(projected.inventoryEvidence.capacityBasis.count, expected);
  assert.equal(projected.inventoryEvidence.capacityBasis.observedMaximum, expected);
  assert.equal(projected.inventoryEvidence.capacityBasis.currentObservedMaximum, current);
  const reviewed = context.applyCompanyManualCorrection(input, { ...company, manualCorrection: { active: true, lodgingBasisTotal: 8 } });
  assert.equal(reviewed.inventoryEvidence.capacityBasis.count, 8);
  assert.equal(reviewed.inventoryEvidence.capacityBasis.source, "db_correction");
  assert.equal(JSON.stringify(company), before, "fix is a read projection, not a stored snapshot rewrite");
}
assert.equal(context.companyMaximumRoomCapacity({ inventory: { latest: {
  salesSignal: { lodging: { maxTotal: 147 } }, productSnapshot: { daily: [{ productType: "lodging", total: 147 }] }
} } }), 0, "legacy sales and inferred daily totals alone are not verified stock");
assert.equal(context.companyMaximumRoomCapacity({ inventory: { latest: {
  manualCorrectionApplied: true, stockBasis: { lodgingMaxTotal: 147 }
} } }), 0, "a corrected legacy summary cannot establish a provider-observed maximum");
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
  inventoryEvidenceVersion: 5,
  productSnapshot: { ...savedSnapshot.productSnapshot, inventoryEvidenceVersion: 5, capacityBasis: { count: 6, source: "db_correction", observedMaximum: 10 },
    daily: savedSnapshot.productSnapshot.daily.map((row) => ({ ...row, total: 6 })) },
  salesSignal: { lodging: { minTotal: 6, maxTotal: 6 } }
};
assert.equal(context.companyInventorySnapshotWithCurrentCapacity(freshSnapshot, snapshotCompany), freshSnapshot);
assert.equal(context.companyInventoryNeedsEvidenceRecovery({ ...snapshotCompany, inventory: { latest: freshSnapshot } }), false);
assert.equal(context.manualCorrectionHasValue({ active: true, productStockCorrections: [reviewedStockRule] }), true, "a reviewed product rule remains an active correction even without a company-total edit");
assert.equal(context.companyInventoryNeedsEvidenceRecovery({ ...snapshotCompany,
  manualCorrection: { ...snapshotCompany.manualCorrection, productStockCorrections: [reviewedStockRule] },
  inventory: { latest: freshSnapshot } }), true, "a new product rule requests raw-source reprojection even when the company total already matches");
const unpricedStoredSnapshot = { ...freshSnapshot, productSnapshot: { ...freshSnapshot.productSnapshot,
  daily: freshSnapshot.productSnapshot.daily.map(row => ({ ...row, phoneRevenue: 0, phonePricedBookings: 0, phoneMissingPriceBookings: 2 })) } };
const unpricedStoredCompany = { ...snapshotCompany, inventory: { latest: unpricedStoredSnapshot } };
assert.equal(context.companyInventoryNeedsEvidenceRecovery(unpricedStoredCompany), true, "current capacity does not skip the new same-product phone-price projection");
const currentPricingCompany = { ...unpricedStoredCompany, inventory: { latest: { ...unpricedStoredSnapshot,
  productSnapshot: { ...unpricedStoredSnapshot.productSnapshot, phoneValuationPolicy: "proportional_product_shortfall_v2" } } } };
assert.equal(context.companyInventoryNeedsEvidenceRecovery(currentPricingCompany), false, "a current pricing projection without any available price does not force repeated migration checks");
const oldSharedUnknown = { ...snapshotCompany, inventory: { latest: { ...freshSnapshot,
  productSnapshot: { ...freshSnapshot.productSnapshot, daily: freshSnapshot.productSnapshot.daily.map(row => ({ ...row,
    partial: true, sharedDayUseIncomplete: true, phoneBookings: 0, phoneMissingPriceBookings: 0 })) } } } };
assert.equal(context.companyInventoryNeedsEvidenceRecovery(oldSharedUnknown), true, "old shared-day-use suppression reopens the read projection for explicit blocks");
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
  availabilityBookingBusinessId: (row) => row.bookingBusinessId || "", rowSearchRegion: () => "", rowAddressRegion: () => "",
  regionBoundaryInfo: () => ({}), normalizeInventoryMemo: () => "",
  evaluateInventoryConfidence: () => ({ structure: {} }), naverCouponSignalFromItem: () => ({ named: false })
});
const largeRow = { placeId: "no_glamping_name", name: "양주 르", totalRooms: 50, availableRooms: 49,
  weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", stock: 50, bookingCount: 1, price: 100000 }] };
const keywordReview = context.summarizeAvailabilityRows([largeRow], "", [], { keyword: "검증글램핑" }).items[0];
const originalJsonArrayField = context.jsonArrayField;
let structuredReads = 0;
context.jsonArrayField = (...args) => { structuredReads++; return originalJsonArrayField(...args); };
const duplicateProjection = context.summarizeAvailabilityRows([largeRow, largeRow, largeRow], "", [], { keyword: "검증글램핑" });
const duplicateReads = structuredReads;
structuredReads = 0;
const singleProjection = context.summarizeAvailabilityRows([largeRow], "", [], { keyword: "검증글램핑" });
assert.deepEqual(JSON.parse(JSON.stringify(duplicateProjection)), JSON.parse(JSON.stringify(singleProjection)), "duplicate place rows keep the first valid source values");
assert.equal(duplicateReads, structuredReads, "a retained place never rereads product JSON from subsequent ranking/platform rows");
const invalidFirst = { ...largeRow, totalRooms: 0, availableRooms: 0, weeklyProductDetails: [] };
const fallbackProjection = context.summarizeAvailabilityRows([invalidFirst, largeRow], "", [], { keyword: "검증글램핑" });
assert.deepEqual(JSON.parse(JSON.stringify(fallbackProjection)), JSON.parse(JSON.stringify(singleProjection)), "a first row without valid inventory cannot suppress a later valid row");
context.jsonArrayField = originalJsonArrayField;
assert.equal(keywordReview.inventoryEvidence.lodging.operatingTotal, 50);
assert.equal(keywordReview.inventoryEvidence.capacityReview.required, true, "collection keyword enables >40 review even when the name has no glamping text");
const typeReview = context.applyCompanyManualCorrection({ ...sourceItem, name: "양주 르", weeklyProductDetails: largeRow.weeklyProductDetails }, {
  ...capacityCompanies[0], lodgingTypes: ["글램핑"]
});
assert.equal(typeReview.inventoryEvidence.capacityReview.required, true, "the same-company DB lodging type reaches the inventory policy");

const limitedRow = { ...largeRow, placeId: "limited", bookingBusinessId: "1680978", totalRooms: 10,
  weeklyProductDetails: [{ date: "2026-09-26", bizItemId: "room", name: "숙박", stock: 10, bookingCount: 1, price: 100000 }] };
const coverageReceipt = { targets: [{ businessId: "1680978", eligible: 62, queried: 40, truncated: 22,
  productListComplete: true, expectedDays: 1,
  days: [{ date: "2026-09-26", eligible: 62, queried: 40, succeeded: 40, failed: 0, truncated: 22 }] }] };
const limitedBefore = JSON.stringify(limitedRow);
const limitedProjection = context.summarizeAvailabilityRows([limitedRow], "", [], { productCoverage: coverageReceipt }).items[0];
assert.equal(limitedProjection.collectionProductCoverage.truncated, 22);
assert.ok(limitedProjection.capacityReview.codes.includes("product_targets_truncated"), "saved per-business cap omissions warn even below 40 observed rooms");
assert.equal(limitedProjection.inventoryEvidence.capacityBasis.count, 10, "a warning does not adjust room capacity");
assert.equal(JSON.stringify(limitedRow), limitedBefore, "stored source rows remain intact");
const unrelatedProjection = context.summarizeAvailabilityRows([{ ...limitedRow, bookingBusinessId: "111" }], "", [], { productCoverage: coverageReceipt }).items[0];
assert.equal(unrelatedProjection.collectionProductCoverage, null);
assert.equal(unrelatedProjection.capacityReview.codes.includes("product_targets_truncated"), false, "other businesses do not inherit a keyword-wide cap warning");

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
    assert.equal(item.inventoryEvidence.lodging.phoneBookings, 4, "normally observed occupied rooms remain explicit estimates even before day-use verification");
    assert.equal(item.inventoryEvidence.lodging.rows[0].explicitBlockedDayUseUnverified, presence !== "absent");
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
    assert.equal(historyRows[0].phoneBookings, 4);
    assert.equal(historyRows[0].explicitBlockedBookings, 4);
    assert.equal(historyRows[0].explicitBlockedRevenue, 400000);
    assert.equal(historyRows[0].explicitBlockedDayUseUnverified, presence !== "absent");
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
  latest: { stockBasis: { lodgingMaxTotal: 147 }, productSnapshot: { inventoryEvidenceVersion: 4,
    capacityBasis: { observedMaximum: 147, currentObservedMaximum: 21 }, daily: [{ productType: "lodging", rawTotal: 21, total: 147 }] } },
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

// Run the real recovery function in an isolated VM without a server or saved
// business inputs. The test-only tap inspects strong-reference reachability at
// the candidate boundary; it does not claim a GC/RSS measurement.
function recoveryFunctionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} source exists`);
  const next = /\n(?:async )?function /.exec(source.slice(start + 1));
  return source.slice(start, next ? start + 1 + next.index : source.length);
}

function objectReachable(value, target, seen = new Set()) {
  if (value === target) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => objectReachable(child, target, seen));
}

async function recoveryCandidateRetentionFixture(config, historical) {
  const ids = Array.from({ length: config.count ?? 4 }, (_, i) => `run_${String(i).padStart(2, "0")}`);
  const company = { companyId: "retention_fixture", placeIds: config.bookingOnly ? [] : ["10"],
    bookingBusinessIds: ["20"], runIds: ids, inventory: { snapshots: ids.map((runId) => ({ runId, collectedAt: "2026-08-01T00:00:00Z" })) } };
  const calls = [], loaded = new Map(), selected = new Map(), captures = [];
  const observed = (id) => config.sameTime ? "2026-09-01T00:00:00Z"
    : config.observationOverride && id === ids[0] ? "2026-10-01T00:00:00Z" : "";
  const timestamp = (id) => `2026-09-${String(ids.indexOf(id) + 1).padStart(2, "0")}T00:00:00Z`;
  const rawInputs = () => JSON.stringify([...loaded.values()]);
  let beforeInputs = "";
  const sandbox = {
    boundedUnique: (values, limit) => [...new Set(values)].slice(0, limit),
    companyRankObservationTimeMap: () => new Map(),
    companyProductRunObservedAt: (_company, observations, id) => { assert.equal(observations[0].fixture, true); return observed(id); },
    extractNaverPlaceId: (item) => item.placeId || "",
    extractBookingBusinessId: (item) => item.bookingBusinessId || "",
    listRuns: async () => { calls.push(["listRuns"]); if (config.listFailure) throw Error("synthetic list failure"); return ids.map(id => ({ id, collectedAt: timestamp(id) })); },
    resolveRunDir: (id) => config.scoped && id === ids[0] ? "" : `fixture/${id}`,
    readManifest: async (dir) => ({ keyword: config.scoped && dir.endsWith(ids[1]) ? "???" : "fixture", collectedAt: timestamp(dir.split("/").at(-1)) }),
    fsp: { stat: async () => ({ mtime: new Date("2026-09-01T00:00:00Z") }), readdir: async () => ["manifest.json"] },
    isIncompleteRunDirectory: () => false,
    runCollectedAt: (_id, manifest) => manifest.collectedAt,
    loadRun: async (id, options) => {
      calls.push(["loadRun", id, JSON.parse(JSON.stringify(options))]);
      if (config.empty || config.skips && id === ids[0]) return null;
      if (config.skips && id === ids[1]) throw Error("synthetic load failure");
      const item = { fixtureId: id, placeId: config.bookingOnly ? "" : config.skips && id === ids[2] ? "wrong-place" : "10", bookingBusinessId: "20",
        legacy: Boolean(config.legacy), products: config.legacy ? [] : [{ key: id, price: 100000 }],
        inventoryEvidence: { capacityBasis: { currentObservedMaximum: ids.indexOf(id) + 10 } },
        quality: { status: "partial", missingDays: 2 }, daily: [{ date: "2026-09-26", total: 10, sold: null }],
        roomBasis: { source: "observed_maximum" }, selectedMetadata: { dayUseScheduleStatus: "not_requested" } };
      const unrelated = { fixtureOtherCompany: id, unneededPayload: "synthetic-other-company".repeat(30) };
      const run = config.noRun ? undefined : { id, collectedAt: config.sameTime ? "2026-09-01T00:00:00Z" : timestamp(id),
        updatedAt: "2026-08-02T00:00:00Z", files: { overall: `${id}_overall.csv` }, collectionQuality: { status: "complete" }, extraRunMetadata: { preserved: true } };
      const data = { ...(config.noRun ? {} : { run }), availability: { items: [item, unrelated] },
        ranking: { unrelated }, platform: { unrelated }, wholeRunSentinel: { id, keepOutOfCandidates: true } };
      loaded.set(id, data);
      return data;
    },
    applyCompanyManualCorrection: (item, selectedCompany) => {
      assert.equal(selectedCompany, company);
      const corrected = { ...item, manualFixtureCorrection: Boolean(config.manual) };
      selected.set(item.fixtureId, corrected); return corrected;
    },
    companyMaximumRoomCapacity: () => 6,
    applyInventoryEvidence: (item) => ({ ...item, inventoryEvidence: { version: config.legacy ? 1 : 4,
      capacityBasis: { count: item.inventoryCapacityBaseline.lodging, source: "observed_maximum" }, lodging: { observedMaximum: item.inventoryCapacityBaseline.lodging } } }),
    companySalesSignalFromItem: (item, run) => ({ run, total: item.inventoryEvidence.capacityBasis.count, quality: item.quality, dayUse: null }),
    companyRevenueSnapshotFromItem: (item) => ({ lodging: { revenue: item.manualFixtureCorrection ? 110000 : 100000 }, dayUse: { revenue: null, observed: false } }),
    compactCompanyProductSnapshot: (item, run, at) => ({ run, observedAt: at, products: item.products,
      capacityBasis: item.inventoryEvidence.capacityBasis, quality: item.quality, daily: item.daily, roomBasis: item.roomBasis, selectedMetadata: item.selectedMetadata }),
    buildHistoryObservations: ({ run, availability }, at) => {
      assert.equal(availability.items.length, 1); assert.equal(availability.items[0].companyId, company.companyId);
      return [{ run, collectedAt: at, sold: null, quality: availability.items[0].quality, manual: availability.items[0].manualFixtureCorrection }];
    },
    legacyProductPreviewFromItem: (item, run, at) => item.legacy ? ({ run, observedAt: at, legacyProducts: [{ key: item.fixtureId }], quality: item.quality }) : null,
    __candidateTap: (candidates) => {
      beforeInputs = rawInputs();
      for (const candidate of candidates) {
        const original = loaded.get(candidate.runId);
        assert.equal(candidate.data.run, original.run, "exact run metadata object is preserved");
        assert.equal(candidate.item, selected.get(candidate.runId), "exact selected corrected item is preserved before capacity projection");
        assert.equal(objectReachable(candidate, original), historical, "only the historical form retains the whole run root");
        assert.equal(objectReachable(candidate, original.availability.items[1]), historical, "other-company item is absent from the improved candidate graph");
        assert.equal(objectReachable(candidate, original.wholeRunSentinel), historical, "whole-run sentinel is not retained by the improved candidate");
      }
      captures.push(candidates.map(candidate => candidate.runId));
    }
  };
  const isolated = vm.createContext(sandbox);
  for (const name of ["companyProductStoredRunTimeMap", "companyProductSourceRunIds", "companyProductRecoveryRunIds", "companyProductAvailabilityMatch"]) {
    vm.runInContext(recoveryFunctionSource(name), isolated);
  }
  let recovery = recoveryFunctionSource("recoverCompanyProductSourceFromRuns");
  const compact = "data: { run: data.run },";
  assert.equal(recovery.split(compact).length, 2, "the real source has the compact run metadata boundary exactly once");
  if (historical) recovery = recovery.replace(compact, "data,");
  assert.equal(recovery.split("  loadedCandidates.sort(").length, 2, "candidate observation boundary is unique");
  recovery = recovery.replace("  loadedCandidates.sort(", "  globalThis.__candidateTap(loadedCandidates);\n  loadedCandidates.sort(");
  vm.runInContext(recovery, isolated);
  const value = await isolated.recoverCompanyProductSourceFromRuns(company, [{ fixture: true }], { scoped: Boolean(config.scoped) });
  assert.equal(rawInputs(), beforeInputs, "recovery never modifies synthetic saved inputs");
  return { value: JSON.parse(JSON.stringify(value)), calls, candidates: Array.from(captures[0]) };
}

async function verifyRecoveryCandidateRetention() {
  const scenarios = [
    { label: "full twenty-candidate bound", count: 25 },
    { label: "observation time precedes run time", observationOverride: true },
    { label: "equal-time insertion ordering", sameTime: true },
    { label: "missing run metadata uses stored time", noRun: true, listFailure: true },
    { label: "null, failed and conflicting identity skip", count: 6, skips: true },
    { label: "legacy preview and source file", legacy: true },
    { label: "no usable candidate", empty: true },
    { label: "scoped directory lookup", scoped: true },
    { label: "booking identity and manual correction", bookingOnly: true, manual: true }
  ];
  for (const scenario of scenarios) {
    const old = await recoveryCandidateRetentionFixture(scenario, true);
    const current = await recoveryCandidateRetentionFixture(scenario, false);
    assert.deepEqual(current, old, `${scenario.label}: all output values, retained candidate order and exact load options stay equivalent`);
    if (scenario.count === 25) {
      assert.equal(current.candidates.length, 20, "the real recovery selector caps retained candidates at20");
      assert.equal(current.candidates[0], "run_24"); assert.equal(current.candidates.at(-1), "run_05");
    }
    if (scenario.sameTime) assert.equal(current.value.productSnapshot.run.id, "run_03");
    if (scenario.observationOverride) assert.equal(current.value.productSnapshot.run.id, "run_00");
    if (scenario.legacy) {
      assert.equal(current.value.productSnapshot, null); assert.equal(current.value.evidenceProjections.length, 0);
      assert.equal(current.value.legacyProductPreview.sourceFile, "run_03_overall.csv");
    }
    if (scenario.empty) assert.deepEqual(current.value, { productSnapshot: null, evidenceProjections: [], legacyProductPreview: null, recoveredFromRun: false, identityMatch: "" });
  }
}

context.recoverCompanyProductSourceFromRuns(recoveryCompany, []).then(async (recovered) => {
  assert.equal(recovered.evidenceProjections.length, 2);
  for (const projection of recovered.evidenceProjections) {
    assert.equal(projection.snapshot.salesSignal.lodging.maxTotal, 27, "all recovered runs share the maximum observed across their raw sources");
    assert.equal(projection.snapshot.productSnapshot.capacityBasis.observedMaximum, 27);
  }
  await verifyRecoveryCandidateRetention();
  console.log("Inventory evidence server projection tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
