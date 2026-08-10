"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  buildV2Top20ExecutionContract,
  normalizeV2Top20PrepareContract
} = require("./collection_worker_v2_top20_protocol.cjs");
const { v2Top20ResiliencePlan } = require("./collection_worker_v2_top20_resilience.cjs");

const guard = installFixtureNetworkGuard({ label: "top20 date range contract fixtures" });
const base = {
  keyword: "Synthetic regional lodging",
  checkIn: "2026-08-18",
  checkOut: "2026-08-18",
  searchMode: "keyword",
  collectionPurpose: "revenue_detail",
  collectionMode: "precision",
  productMode: "all",
  bookingRangeDays: 1,
  rankStart: 1,
  rankEnd: 50,
  detailRankStart: 1,
  detailRankEnd: 20
};

try {
  const oneDay = buildV2Top20ExecutionContract(base);
  const threeDays = buildV2Top20ExecutionContract({ ...base, checkOut: "2026-08-20", bookingRangeDays: 3 });
  assert.equal(oneDay.bookingRangeDays, 1);
  assert.equal(oneDay.maximumProviderCalls, 241);
  assert.equal(threeDays.bookingRangeDays, 3);
  assert.equal(threeDays.scheduleRequestGranularity, "per_product_day");
  assert.equal(threeDays.maximumProviderCalls, 561);
  assert.equal(v2Top20ResiliencePlan(7).maximumProviderCalls, 1201);
  assert.throws(() => normalizeV2Top20PrepareContract({ ...base, checkOut: "2026-08-20", bookingRangeDays: 1 }), (error) => error.code === "COLLECTION_WORKER_V2_TOP20_DATE_RANGE_INVALID");
  assert.throws(() => normalizeV2Top20PrepareContract({ ...base, checkOut: "2026-08-17" }), (error) => error.code === "COLLECTION_WORKER_V2_TOP20_DATE_RANGE_INVALID");
  assert.throws(() => normalizeV2Top20PrepareContract({ ...base, checkOut: "2026-08-25" }), (error) => error.code === "COLLECTION_WORKER_V2_TOP20_DATE_RANGE_EXCEEDED");
  assert.equal(guard.blockedAttempts(), 0);
  console.log(JSON.stringify({
    inclusiveKstRange: true,
    oneDayBudget: oneDay.maximumProviderCalls,
    threeDayBudget: threeDays.maximumProviderCalls,
    maximumSevenDayBudget: v2Top20ResiliencePlan(7).maximumProviderCalls,
    invalidRangeRejected: true,
    externalNetworkCalls: 0
  }));
} finally {
  guard.restore();
}
