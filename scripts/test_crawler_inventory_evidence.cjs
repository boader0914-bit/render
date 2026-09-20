const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { productEvidence, summarizeEvidence } = require("./inventory_estimation.cjs");

const source = fs.readFileSync(path.join(__dirname, "gyeongnam_glamping_crawl.cjs"), "utf8");
function section(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return source.slice(start, end);
}

const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
function harness(byDate = {}, checkIn = "2026-09-20") {
  const context = {
    CHECK_IN: checkIn, addDays,
    shortDate: date => date.slice(5), formatWon: value => `${value}원`, formatRate: value => value === null ? "미확인" : `${Math.round(value * 100)}%`,
    collectNaverSchedulesForItems: async (_business, _items, _limit, date) => byDate[date] || [],
    mergeNaverCouponSignals: () => ({}), summarizeNaverCouponExposure: () => ({}), couponSource: () => ({})
  };
  const functions = [
    section("function asStockNumber(", "function naverBookingSaleType("),
    section("function naverBookingSaleType(", "const COUPON_SIGNAL_PATTERN"),
    section("function naverGroupedRoomCount(", "async function jsonCell("),
    section("function revenueProjectionFields(", "function dayTypeLabel("),
    section("function dayTypeLabel(", "async function collectNaverSchedulesForItems("),
    section("function operatingTotalBasisFromTotals(", "async function collectNaverBookingAvailability(")
  ].join("\n");
  return vm.runInNewContext(`${functions}\n({ naverBookingSaleType, scheduleQuantityProfile, compactNaverScheduleDetail, summarizeNaverScheduleGroup, summarizeNaverScheduleRevenue, summarizeNaverBookingAvailability, collectWeeklyNaverAvailability, operatingTotalBasisFromTotals })`, context);
}

function schedule(overrides = {}) {
  return { bizItemId: "fixture-product", name: "당일글램핑", saleType: "데이유즈", stock: 3,
    bookingCount: 0, occupiedBookingCount: 0, price: 99000, isBusinessDay: true, isSaleDay: true, ...overrides };
}

test("explicit provider product type takes precedence over promotional day-use wording", () => {
  const api = harness();
  const cases = [
    [{ name: "데이유즈도 가능한 객실", bizItemSubType: "ACCOMMODATION_NIGHT" }, "숙박"],
    [{ name: "글램핑 객실", bizItemSubType: "ACCOMMODATION_DAY_USE" }, "데이유즈"],
    [{ name: "숙박 객실", bizItemSubType: "ACCOMMODATION_CAMPNIC" }, "데이유즈"],
    [{ name: "허니데이 글램핑" }, "숙박"],
    [{ name: "글램핑 대실" }, "데이유즈"],
    [{ name: "피크닉" }, "데이유즈"]
  ];
  for (const [product, expected] of cases) {
    assert.equal(api.naverBookingSaleType(product), expected);
    const row = schedule({ ...product, saleType: api.naverBookingSaleType(product) });
    assert.equal(productEvidence(row).kind, expected === "데이유즈" ? "dayUse" : "lodging");
  }
});

test("closed zero-stock rows never become one sold room and occupied counts never become sales", () => {
  const api = harness();
  for (const listType of ["객실별 예약리스트", "객실 묶음 상품리스트", "객실 종류별 리스트"]) {
    const closed = api.scheduleQuantityProfile(schedule({ stock: 0, price: 0, isSaleDay: false }), listType);
    assert.equal(closed.total, 0);
    assert.equal(closed.soldOut, 0);
    assert.equal(closed.available, 0);
  }
  const blocked = api.scheduleQuantityProfile(schedule({ occupiedBookingCount: 2 }), "객실 종류별 리스트");
  assert.equal(blocked.soldOut, 0);
  assert.equal(blocked.available, 1);
  assert.equal(blocked.unverifiedOccupied, 2);
  assert.equal(blocked.unverifiedUnavailable, 2);
  const closedWithStock = api.scheduleQuantityProfile(schedule({ isBusinessDay: false }), "객실 종류별 리스트");
  assert.equal(closedWithStock.soldOut, 0);
  assert.equal(closedWithStock.unverifiedUnavailable, 3);
});

test("crawler product evidence matches the read model for room, pooled, missing and contradictory inputs", () => {
  const api = harness();
  const cases = [
    schedule({ listType: "객실별 예약리스트", stock: 1, bookingCount: 1 }),
    schedule({ listType: "객실 묶음 상품리스트", name: "민트 1~21번", stock: 16, bookingCount: 3 }),
    schedule({ listType: "객실 종류별 리스트", occupiedBookingCount: 2 }),
    schedule({ listType: "객실별 예약리스트", stock: 0, price: 0, open: false }),
    schedule({ listType: "객실 종류별 리스트", stock: 0, bookingCount: 2 }),
    schedule({ listType: "객실 종류별 리스트", stock: null, bookingCount: 2 }),
    schedule({ listType: "객실 종류별 리스트", bookingCount: null }),
    schedule({ listType: "객실 종류별 리스트", price: null, bookingCount: 1 })
  ];
  for (const row of cases) {
    const crawled = api.scheduleQuantityProfile(row, row.listType);
    const read = productEvidence(row);
    for (const key of ["total", "rawTotal", "available", "unverifiedOccupied", "unverifiedUnavailable", "inventoryConflict", "price"]) assert.equal(crawled[key], read[key], key);
    assert.equal(crawled.soldOut, read.sold);
    assert.equal(crawled.inventoryObserved, read.observed);
  }
});

test("Mint 31-day day-use sample has three observed bookings and no 1,188,000-won synthetic fill", async () => {
  const closed = new Set(["2026-09-26", "2026-10-03", "2026-10-10", "2026-10-17"]);
  const byDate = {};
  for (let index = 0; index < 31; index += 1) {
    const date = addDays("2026-09-20", index);
    byDate[date] = [schedule({ date, stock: closed.has(date) ? 0 : 3, price: closed.has(date) ? 0 : 99000,
      isSaleDay: !closed.has(date), bookingCount: date === "2026-09-20" ? 1 : date === "2026-10-05" ? 2 : 0 })];
  }
  const api = harness(byDate);
  const weekly = await api.collectWeeklyNaverAvailability("fixture-business", byDate["2026-09-20"], byDate["2026-09-20"], 31, "회");
  assert.equal(weekly.days, 31);
  assert.equal(weekly.dates.length, 31);
  assert.equal(weekly.productDetails.length, 31);
  assert.equal(weekly.totalStock, 81);
  assert.equal(weekly.totalSoldOut, 3);
  assert.equal(weekly.totalEstimatedRevenue, 297000);
  assert.equal(weekly.totalAdjustedEstimatedRevenue, 297000);
  assert.equal(weekly.totalMissingPriceEstimatedRevenue, 0);
  assert.equal(weekly.totalMissingPriceSoldOut, 0);
  assert.equal(weekly.totalOfflineReserved, 0);
  assert.equal(weekly.totalInventoryShortfall, 12);
  assert.equal(weekly.soldOutDays, 0);
  for (const date of weekly.dates) {
    assert.equal(date.soldOut, date.productDetails.reduce((sum, row) => sum + row.soldOut, 0));
    assert.equal(date.total, date.productDetails.reduce((sum, row) => sum + row.total, 0));
    assert.equal(date.inventoryShortfall, date.productDetails.reduce((sum, row) => sum + row.inventoryShortfall, 0));
    if (closed.has(date.date)) { assert.equal(date.soldOut, 0); assert.equal(date.total, 0); }
  }
  const read = summarizeEvidence(weekly.productDetails.map(productEvidence), "dayUse");
  assert.equal(read.total, weekly.totalStock);
  assert.equal(read.sold, weekly.totalSoldOut);
  assert.equal(read.revenue, weekly.totalEstimatedRevenue);
  assert.equal(read.inventoryShortfall, weekly.totalInventoryShortfall);
  assert.doesNotMatch(weekly.basisRule, /전체객실수후보|오프라인/);
});

test("lower observed channel inventory stays separate from sales and the denominator is the date sum", async () => {
  const byDate = {};
  for (let index = 0; index < 7; index += 1) {
    const date = addDays("2026-09-20", index);
    byDate[date] = [
      schedule({ date, bizItemId: "mint", name: "민트 1~21번", saleType: "숙박", stock: index === 6 ? 8 : 16, bookingCount: index === 0 ? 3 : 0, price: 100000 }),
      schedule({ date, bizItemId: "lavender", name: "라벤더 1~7번", saleType: "숙박", stock: 5, price: 100000 })
    ];
  }
  const api = harness(byDate);
  const weekly = await api.collectWeeklyNaverAvailability("fixture", byDate["2026-09-20"], byDate["2026-09-20"], 7);
  assert.equal(weekly.operatingTotal, 21);
  assert.equal(weekly.totalStock, 139); // 6 * 21 + 13, not 21 * 7.
  assert.equal(weekly.totalSoldOut, 3);
  assert.equal(weekly.totalEstimatedRevenue, 300000);
  assert.equal(weekly.totalInventoryShortfall, 8);
  assert.equal(weekly.totalOfflineReserved, 0);
  assert.equal(weekly.structuralBlockedTotal, 0);
  assert.equal(weekly.dates[6].soldOut, 0);
  assert.equal(weekly.dates[6].inventoryShortfall, 8);
  assert.equal(weekly.totalStock, weekly.productDetails.reduce((sum, row) => sum + row.total, 0));
});

test("real bookings with missing prices stay missing instead of borrowing another product price", () => {
  const api = harness();
  const revenue = api.summarizeNaverScheduleRevenue([
    schedule({ bookingCount: 1 }), schedule({ bookingCount: 2, price: null }),
    schedule({ stock: 0, price: 0, isSaleDay: false }), schedule({ occupiedBookingCount: 2 })
  ], "객실 종류별 리스트");
  assert.equal(revenue.estimatedRevenue, 99000);
  assert.equal(revenue.pricedSoldOut, 1);
  assert.equal(revenue.missingPriceSoldOut, 2);
  assert.equal(revenue.adjustedEstimatedRevenue, 99000);
  assert.equal(revenue.missingPriceEstimatedRevenue, 0);
});

test("shared-room day-use evidence does not blindly subtract separate direct overnight bookings", () => {
  const api = harness();
  const night = schedule({ bizItemId: "night", name: "민트 1~21번", saleType: "숙박", stock: 16, bookingCount: 2, occupiedBookingCount: 2 });
  const day = schedule({ bizItemId: "day", bookingCount: 2 });
  const result = api.summarizeNaverBookingAvailability([night], [night], "fixture", "", { night: 1, dayUse: 1 }, { dayUseItems: [day], dayUseSchedules: [day] });
  assert.equal(result.nightSoldOutStock, 2);
  assert.equal(result.nightEstimatedRevenue, 198000);
  assert.equal(result.dayUseEstimatedRevenue, 198000);
  const details = result.itemDetails;
  assert.equal(details[0].unverifiedOccupied, 2);
  assert.equal(details[0].soldOut, 2);
  assert.equal(details[0].calculationVersion, "booking-evidence-v2");
});
