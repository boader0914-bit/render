"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_MAX_SAMPLE_AGE_MS,
  calibrateCrawlTiming,
  timingSimilarityScore
} = require("./crawl_eta_model.cjs");
const { __test: serverModel } = require("./glamping_app_server.cjs");

const NOW = Date.parse("2026-08-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const baseConditions = Object.freeze({
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  collectionProfile: "revenue_detail_deep",
  searchMode: "keyword",
  requestedSearchMode: "keyword",
  productMode: "all",
  regionKey: "gyeongnam",
  collectRegional: true,
  collectOta: true,
  collectBookingStock: true,
  collectWeeklyRange: true,
  detailRankRanges: "1-10",
  rankRangeCount: 10,
  bookingRangeDays: 7,
  bookingRangePlaceLimit: 10
});

function timingEntry(durationSeconds, options = {}) {
  const ageDays = options.ageDays ?? 1;
  return {
    success: options.success ?? true,
    durationSeconds,
    modelTotalSeconds: options.modelTotalSeconds ?? 300,
    estimatedTotalSeconds: options.estimatedTotalSeconds ?? 300,
    endedAt: options.endedAt ?? new Date(NOW - ageDays * DAY_MS).toISOString(),
    conditions: { ...baseConditions, ...(options.conditions || {}) },
    stageTimings: options.stageTimings || []
  };
}

const cold = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: [],
  nowMs: NOW
});
assert.equal(cold.source, "model");
assert.equal(cold.estimatedTotalSeconds, 300);
assert.equal(cold.sampleCount, 0);

const underEstimated = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: [480, 500, 520].map((seconds, index) => timingEntry(seconds, { ageDays: index + 1 })),
  nowMs: NOW
});
assert.equal(underEstimated.method, "robust_workload_normalized_v2");
assert.ok(underEstimated.estimatedTotalSeconds > 300, "repeated underestimates must raise the next ETA");
assert.ok(underEstimated.estimatedTotalSeconds < 500, "history must remain blended with the cold model");
assert.equal(underEstimated.sampleCount, 3);

const overEstimated = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: [120, 130, 140].map((seconds, index) => timingEntry(seconds, { ageDays: index + 1 })),
  nowMs: NOW
});
assert.ok(overEstimated.estimatedTotalSeconds < 300, "repeated overestimates must lower the next ETA");
assert.ok(overEstimated.estimatedTotalSeconds > 120, "a small sample must not replace the model outright");

const outlierSafe = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 120,
  entries: [118, 120, 121, 122, 9000].map((seconds, index) => timingEntry(seconds, {
    modelTotalSeconds: 120,
    estimatedTotalSeconds: 120,
    ageDays: index + 1
  })),
  nowMs: NOW
});
assert.equal(outlierSafe.outlierCount, 1);
assert.ok(outlierSafe.calibratedSeconds >= 118 && outlierSafe.calibratedSeconds <= 123);
assert.ok(outlierSafe.estimatedTotalSeconds < 150, "one provider stall must not dominate ETA");

const lowerOutlierSafe = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 120,
  entries: [1, 118, 120, 121, 122].map((seconds, index) => timingEntry(seconds, {
    modelTotalSeconds: 120,
    estimatedTotalSeconds: 120,
    ageDays: index + 1
  })),
  nowMs: NOW
});
assert.equal(lowerOutlierSafe.outlierCount, 1);
assert.ok(lowerOutlierSafe.calibratedSeconds >= 117 && lowerOutlierSafe.calibratedSeconds <= 123);

const recentWins = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 120,
  entries: [
    timingEntry(120, { modelTotalSeconds: 120, ageDays: 1 }),
    timingEntry(600, { modelTotalSeconds: 120, ageDays: 90 })
  ],
  nowMs: NOW
});
assert.ok(recentWins.calibratedSeconds < 180, "real timestamp recency must strongly discount old timings");

const staleOnly = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: [timingEntry(900, { ageDays: DEFAULT_MAX_SAMPLE_AGE_MS / DAY_MS + 1 })],
  nowMs: NOW
});
assert.equal(staleOnly.source, "model");
assert.equal(staleOnly.estimatedTotalSeconds, 300);

const invalidEntries = [
  timingEntry(500, { success: false }),
  timingEntry(500, { success: "false" }),
  timingEntry(0),
  timingEntry(500, { endedAt: "not-a-date" }),
  timingEntry(500, { endedAt: new Date(NOW + DAY_MS).toISOString() }),
  timingEntry(500, { conditions: { collectionPurpose: "basic_db", collectionProfile: "basic_db_light" } })
];
for (const invalid of invalidEntries) {
  assert.equal(timingSimilarityScore(baseConditions, invalid) > 0 && Date.parse(invalid.endedAt) <= NOW, false);
}
const invalidOnly = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: invalidEntries,
  nowMs: NOW
});
assert.equal(invalidOnly.source, "model");
assert.equal(invalidOnly.sampleCount, 0);

const exactWorkload = timingEntry(360, { ageDays: 8 });
const nearButDifferent = timingEntry(120, {
  ageDays: 1,
  conditions: {
    detailRankRanges: "1-20",
    rankRangeCount: 20,
    bookingRangeDays: 30,
    bookingRangePlaceLimit: 20
  }
});
assert.ok(
  timingSimilarityScore(baseConditions, exactWorkload) > timingSimilarityScore(baseConditions, nearButDifferent),
  "an exact workload must receive the stronger similarity weight"
);

function stageFixture(multiplier = 1) {
  return [
    { key: "rank_main", group: "rank", status: "done", skipped: false, durationSeconds: 30 * multiplier, estimatedSeconds: 30 },
    { key: "rank_regional", group: "rank", status: "done", skipped: false, durationSeconds: 15 * multiplier, estimatedSeconds: 15 },
    { key: "ota_nol", group: "ota", status: "done", skipped: false, durationSeconds: 90 * multiplier, estimatedSeconds: 30 },
    { key: "ota_yeogi", group: "ota", status: "done", skipped: true, durationSeconds: 0, estimatedSeconds: 30 },
    { key: "inventory", group: "inventory", status: "done", skipped: false, durationSeconds: 60 * multiplier, estimatedSeconds: 60 },
    { key: "save", group: "save", status: "done", skipped: false, durationSeconds: 15 * multiplier, estimatedSeconds: 30 }
  ];
}

const stageCalibrated = calibrateCrawlTiming({
  conditions: baseConditions,
  modelTotalSeconds: 300,
  entries: [1, 1.03, 0.97].map((multiplier, index) => timingEntry(300 * multiplier, {
    ageDays: index + 1,
    stageTimings: stageFixture(multiplier)
  })),
  nowMs: NOW
});
assert.deepEqual(Object.keys(stageCalibrated.stageFactors).sort(), ["inventory", "ota", "rank", "save"]);
assert.ok(stageCalibrated.stageFactors.ota > stageCalibrated.stageFactors.inventory);
assert.ok(stageCalibrated.stageFactors.inventory > stageCalibrated.stageFactors.save);
assert.equal(stageCalibrated.stageSamples.ota.sampleCount, 3);

const scaledStages = serverModel.scaleCrawlStages([
  { key: "rank", seconds: 25 },
  { key: "ota", seconds: 25 },
  { key: "inventory", seconds: 25 },
  { key: "save", seconds: 25 }
], 200, stageCalibrated.stageFactors);
assert.equal(scaledStages.reduce((sum, stage) => sum + stage.seconds, 0), 200);
assert.ok(scaledStages.find((stage) => stage.key === "ota").seconds > scaledStages.find((stage) => stage.key === "save").seconds);

const commonPayload = {
  keyword: "경남글램핑",
  checkIn: "2026-08-03",
  checkOut: "2026-08-09",
  searchMode: "keyword",
  productMode: "all",
  collectionMode: "precision",
  collectionPurpose: "revenue_detail",
  detailRankRanges: "1-10",
  bookingRangePlaceLimit: 10
};
const tenPlaceEstimate = serverModel.estimateCrawlCompletion(commonPayload, { entries: [] });
const twentyPlaceEstimate = serverModel.estimateCrawlCompletion({
  ...commonPayload,
  detailRankRanges: "1-20",
  bookingRangePlaceLimit: 20
}, { entries: [] });
assert.ok(twentyPlaceEstimate.estimatedTotalSeconds > tenPlaceEstimate.estimatedTotalSeconds);
assert.equal(tenPlaceEstimate.basis.timing.source, "model");
assert.equal(tenPlaceEstimate.basis.rankRangeCount, 10);
assert.equal(twentyPlaceEstimate.basis.detailPlaceLimit, 20);

const productAllEstimate = serverModel.estimateCrawlCompletion(commonPayload, { entries: [] });
const productLodgingEstimate = serverModel.estimateCrawlCompletion({ ...commonPayload, productMode: "lodging" }, { entries: [] });
assert.equal(
  productAllEstimate.basis.timing.modelTotalSeconds,
  productLodgingEstimate.basis.timing.modelTotalSeconds,
  "a display-only product filter must not invent a runtime difference"
);

const companyLocationEstimate = serverModel.estimateCrawlCompletion({
  ...commonPayload,
  keyword: "테스트 숙소",
  searchMode: "company",
  collectionPurpose: "demand_location",
  detailRankRanges: "1-20"
}, { entries: [] });
assert.equal(companyLocationEstimate.basis.collectRegional, false);
assert.equal(companyLocationEstimate.stages.some((stage) => stage.key === "ota"), false, "company search skips regional collection");

const liveJob = {
  estimate: tenPlaceEstimate,
  stageEvents: [{
    key: "rank_main",
    group: "rank",
    label: "네이버 순위",
    status: "active",
    skipped: false,
    startedAt: new Date(Date.now() - 240 * 1000).toISOString(),
    endedAt: "",
    durationSeconds: null,
    estimatedSeconds: 20
  }]
};
const liveRemaining = serverModel.crawlRuntimeRemainingSeconds(liveJob, 240);
assert.ok(liveRemaining > 0, "an overdue active stage with pending work must never report zero remaining time");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "scripts", "glamping_app_server.cjs"), "utf8");
for (const source of [appSource, serverSource]) {
  assert.match(source, /detailPlaceCount \? 12 \+ detailPlaceCount \* 3\.3 : 6/);
  assert.match(source, /rangePlaceCount|placeLimit/);
  assert.match(source, /\* 4\.8/);
}
assert.doesNotMatch(appSource.slice(appSource.indexOf("function crawlPreviewMeta"), appSource.indexOf("function normalizeCrawlEstimate")), /trendSeconds/);
assert.doesNotMatch(serverSource.slice(serverSource.indexOf("function estimateCrawlCompletion"), serverSource.indexOf("function scaleCrawlStages")), /trendSeconds/);

console.log("Robust crawl ETA model, workload parity, stage calibration, and live remaining checks passed");
