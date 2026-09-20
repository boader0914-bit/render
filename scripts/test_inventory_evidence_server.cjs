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
  "productSnapshotObservation", "dayOfWeekFromDate", "toNullableRate",
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

console.log("Inventory evidence server projection tests passed");
