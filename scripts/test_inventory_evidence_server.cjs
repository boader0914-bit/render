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
  "companyMaximumRoomCapacity", "withCompanyInventoryCapacity", "companyProductAvailabilityMatch",
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
  const start = source.indexOf(`function ${name}(`);
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

console.log("Inventory evidence server projection tests passed");
