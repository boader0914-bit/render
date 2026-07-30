"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createV2CollectionPlan,
  parseRankRanges,
  rankRangePlaceLimit,
  timingAdjustment
} = require("./integration/contracts/v2_collection_plan.cjs");

const now = Date.parse("2026-07-30T00:00:00.000Z");
const precise = createV2CollectionPlan({
  keyword: "통영 글램핑",
  checkIn: "2026-08-01",
  checkOut: "2026-08-07",
  productMode: "all",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "1-10"
}, { now });
assert.equal(precise.collectionProfile, "revenue_detail_deep");
assert.equal(precise.detailPlaceLimit, 10);
assert.equal(precise.bookingRangeDays, 7);
assert.equal(precise.bookingRangePlaceLimit, 10);
assert.equal(precise.requestEstimate.discovery, 1);
assert.equal(precise.requestEstimate.detail, 10);
assert.equal(precise.requestEstimate.leadtime, 70);
assert.equal(precise.requestEstimate.ota, 2);
assert.deepEqual(precise.executionStages, ["discovery", "quick", "detail", "ota", "finalize"]);
assert.equal(precise.estimatedCompleteAt, new Date(now + precise.estimatedTotalSeconds * 1000).toISOString());
assert.equal(precise.stages.reduce((sum, stage) => sum + stage.seconds, 0), precise.estimatedTotalSeconds);

const fast = createV2CollectionPlan({
  targetName: "업체명 검색",
  targetDate: "2026-08-01",
  collectionMode: "fast",
  collectionPurpose: "revenue_detail",
  targetCount: 500
}, { now });
assert.equal(fast.targetCount, 100);
assert.equal(fast.detailRankRanges, "없음");
assert.equal(fast.requestEstimate.detail, 0);
assert.equal(fast.requestEstimate.leadtime, 0);
assert.equal(fast.requestEstimate.ota, 0);
assert.deepEqual(fast.executionStages, ["discovery", "quick", "finalize"]);
assert.ok(fast.estimatedTotalSeconds >= 45);

const basic = createV2CollectionPlan({
  targetName: "basic plan target",
  targetDate: "2026-08-01",
  collectionMode: "precision",
  collectionPurpose: "basic_db"
}, { now });
assert.deepEqual(basic.executionStages, ["discovery", "quick", "detail", "finalize"]);

const demand = createV2CollectionPlan({
  targetName: "demand plan target",
  targetDate: "2026-08-01",
  collectionMode: "precision",
  collectionPurpose: "demand_location"
}, { now });
assert.deepEqual(demand.executionStages, ["discovery", "quick", "detail", "finalize"]);

assert.deepEqual(parseRankRanges("1-3,7,10-8"), [
  { from: 1, to: 3 }, { from: 7, to: 7 }, { from: 8, to: 10 }
]);
assert.equal(rankRangePlaceLimit(parseRankRanges("1-100")), 20);
assert.deepEqual(timingAdjustment(100, []).rangeSeconds, { minimum: 70, maximum: 160 });
assert.equal(timingAdjustment(100, [
  { success: true, durationSeconds: 120 },
  { success: true, durationSeconds: 140 },
  { success: false, durationSeconds: 1 }
]).sampleCount, 2);
assert.deepEqual(
  createV2CollectionPlan({ keyword: "결정성", targetDate: "2026-08-01" }, { now }),
  createV2CollectionPlan({ keyword: "결정성", targetDate: "2026-08-01" }, { now })
);
assert.throws(
  () => createV2CollectionPlan({ keyword: "", targetDate: "2026-08-01" }),
  (error) => error.code === "V2_COLLECTION_KEYWORD_REQUIRED"
);
assert.throws(
  () => createV2CollectionPlan({ keyword: "오류", checkIn: "2026-08-05", checkOut: "2026-08-01" }),
  (error) => error.code === "V2_COLLECTION_DATE_RANGE_INVALID"
);

const source = fs.readFileSync(path.join(__dirname, "integration/contracts/v2_collection_plan.cjs"), "utf8");
assert.doesNotMatch(source, /require\(["']node:(?:fs|http|https|net)/);
assert.doesNotMatch(source, /process\.env|\bfetch\s*\(/);
console.log("V2 collection plan, request estimate and fresh timing contract checks passed");
