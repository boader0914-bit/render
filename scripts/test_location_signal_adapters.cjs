"use strict";

global.fetch = async (url) => {
  throw new Error(`External requests are forbidden in location signal adapter fixtures: ${url}`);
};

const assert = require("node:assert/strict");
const {
  SignalAdapterError,
  adaptLodgingInventoryRow,
  adaptNaverDataLabSeries,
  adaptNaverSearchAdRows,
  adaptRegionalRevenue,
  parseSearchVolumeValue
} = require("./location_signal_adapters.cjs");

const pocheonGeo = Object.freeze({
  codeSystem: "MOIS_LEGAL_DONG",
  code: "4165000000",
  level: "sigungu",
  name: "경기도 포천시"
});

function main() {
  const incompleteTrend = adaptNaverDataLabSeries({
    series: {
      title: "포천 글램핑 수요",
      keywords: ["포천글램핑", "포천 글램핑", "서울근교글램핑"],
      data: [
        { period: "2026-06-01", ratio: 0 },
        { period: "2026-07-01", ratio: 64.2 }
      ]
    },
    timeUnit: "month",
    expectedPeriods: ["2026-06", "2026-07", "2026-08"],
    geo: pocheonGeo,
    fetchedAt: "2026-09-05T00:00:00.000Z",
    availableAt: "2026-09-05T00:00:00.000Z",
    featureAsOf: "2026-09-10T00:00:00.000Z"
  });
  assert.equal(incompleteTrend.modelRole, "feature");
  assert.deepEqual(incompleteTrend.keywordVariants, ["포천글램핑", "포천 글램핑", "서울근교글램핑"]);
  assert.deepEqual(incompleteTrend.expectedPeriods, ["2026-06-01", "2026-07-01", "2026-08-01"]);
  assert.deepEqual(incompleteTrend.observedPeriods, ["2026-06-01", "2026-07-01"]);
  assert.equal(incompleteTrend.coverage.ratio, 2 / 3);
  assert.equal(incompleteTrend.observations[0].value, 0, "an observed relative index of zero must remain numeric zero");
  assert.equal(incompleteTrend.observations[0].status, "partial", "incomplete expected periods must be explicit");
  assert.equal(incompleteTrend.observations[1].value, 64.2);
  assert.equal(incompleteTrend.observations[2].status, "missing");
  assert.equal(incompleteTrend.observations[2].value, null);
  assert.equal(incompleteTrend.observations[0].normalization.parameters.isAbsoluteSearchVolume, false);
  assert.equal(incompleteTrend.observations[0].role, "feature");
  assert.equal(incompleteTrend.observations[0].availableAt, "2026-09-05T00:00:00.000Z");
  assert.equal(incompleteTrend.observations[0].featureAsOf, "2026-09-10T00:00:00.000Z");

  const completeZeroTrend = adaptNaverDataLabSeries({
    series: { title: "포천 글램핑", keywords: ["포천글램핑"], data: [{ period: "2026-07-01", ratio: 0 }] },
    timeUnit: "month",
    expectedPeriods: ["2026-07"],
    geo: pocheonGeo,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-05T00:00:00.000Z"
  });
  assert.equal(completeZeroTrend.observations[0].status, "zero");
  assert.equal(completeZeroTrend.observations[0].value, 0);

  const staleTrend = adaptNaverDataLabSeries({
    series: { title: "포천 글램핑", keywords: ["포천글램핑"], data: [{ period: "2026-07-01", ratio: 42 }] },
    timeUnit: "month",
    expectedPeriods: ["2026-07"],
    staleAfterDays: 30,
    geo: pocheonGeo,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    availableAt: "2026-08-01T00:00:00.000Z",
    featureAsOf: "2026-09-15T00:00:00.000Z"
  });
  assert.equal(staleTrend.observations[0].status, "stale");
  assert.equal(staleTrend.observations[0].confidence.penalties.some((penalty) => penalty.code === "source_refresh_stale"), true);

  assert.throws(
    () => adaptNaverDataLabSeries({
      series: { title: "포천 글램핑", data: [{ period: "2026-07-01", ratio: 50 }] },
      timeUnit: "month",
      expectedPeriods: ["2026-07"],
      geo: pocheonGeo,
      fetchedAt: "2026-08-10T00:00:00.000Z",
      availableAt: "2026-08-10T00:00:00.000Z",
      featureAsOf: "2026-08-05T00:00:00.000Z"
    }),
    (error) => error instanceof SignalAdapterError && error.code === "FEATURE_LEAKAGE"
  );

  const censored = parseSearchVolumeValue("<10");
  assert.equal(censored.kind, "censored");
  assert.equal(censored.lowerBound, 0);
  assert.equal(censored.upperBound, 9);
  assert.equal(censored.pointEstimate, null, "a censored value must not be imputed to 5");
  assert.equal(parseSearchVolumeValue(0).value, 0);
  assert.equal(parseSearchVolumeValue("").kind, "missing");
  assert.equal(parseSearchVolumeValue("not-a-number").kind, "missing");

  const searchVolume = adaptNaverSearchAdRows({
    rows: [{ relKeyword: "포천글램핑", monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: "120" }],
    requestedKeyword: "포천글램핑",
    keywordVariants: ["포천글램핑", "포천 글램핑"],
    yearMonth: "202607",
    geo: pocheonGeo,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-05T00:00:00.000Z"
  });
  const pcVolume = searchVolume.observations.find((observation) => observation.metricKey.endsWith(".pc"));
  const mobileVolume = searchVolume.observations.find((observation) => observation.metricKey.endsWith(".mobile"));
  const totalVolume = searchVolume.observations.find((observation) => observation.metricKey.endsWith(".total"));
  assert.equal(searchVolume.keywordMatchType, "exact");
  assert.equal(pcVolume.status, "partial");
  assert.deepEqual(pcVolume.value, { lowerBound: 0, upperBound: 9, pointEstimate: null, censoring: "less_than_10" });
  assert.equal(pcVolume.normalization.parameters.pointEstimate, null);
  assert.equal(mobileVolume.status, "ready");
  assert.equal(mobileVolume.value, 120);
  assert.deepEqual(totalVolume.value, { lowerBound: 120, upperBound: 129, pointEstimate: null, censoring: "component_range_sum" });
  assert.equal(JSON.stringify(searchVolume).includes('"pointEstimate":5'), false);

  const zeroSearchVolume = adaptNaverSearchAdRows({
    row: { relKeyword: "포천글램핑", monthlyPcQcCnt: "0", monthlyMobileQcCnt: 0 },
    requestedKeyword: "포천글램핑",
    yearMonth: "202607",
    geo: pocheonGeo,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-05T00:00:00.000Z"
  });
  assert.deepEqual(zeroSearchVolume.observations.map((observation) => observation.status), ["zero", "zero", "zero"]);
  assert.deepEqual(zeroSearchVolume.observations.map((observation) => observation.value), [0, 0, 0]);

  const missingSearchVolume = adaptNaverSearchAdRows({
    row: { relKeyword: "포천글램핑", monthlyPcQcCnt: "", monthlyMobileQcCnt: "parse-error" },
    requestedKeyword: "포천글램핑",
    yearMonth: "202607",
    geo: pocheonGeo,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-05T00:00:00.000Z"
  });
  assert.deepEqual(missingSearchVolume.observations.map((observation) => observation.status), ["missing", "missing", "missing"]);
  assert.deepEqual(missingSearchVolume.observations.map((observation) => observation.value), [null, null, null]);

  const relatedFallback = adaptNaverSearchAdRows({
    rows: [{ relKeyword: "포천캠핑", monthlyPcQcCnt: 40, monthlyMobileQcCnt: 160 }],
    requestedKeyword: "포천글램핑",
    yearMonth: "202607",
    geo: pocheonGeo,
    fetchedAt: "2026-08-02T00:00:00.000Z",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-05T00:00:00.000Z"
  });
  assert.equal(relatedFallback.keywordMatchType, "related");
  assert.equal(relatedFallback.status, "partial");
  assert.equal(relatedFallback.observations.every((observation) => observation.status === "partial"), true);
  assert.equal(
    relatedFallback.observations.every((observation) => observation.confidence.penalties.some((penalty) => penalty.code === "related_keyword_fallback")),
    true
  );

  const zeroInventory = adaptLodgingInventoryRow({
    row: { total: "0", available: 0, checkIn: "2026-08-15", checkOut: "2026-08-16" },
    propertyId: "pocheon-001",
    regionKey: "kr_gyeonggi_pocheon",
    runId: "inventory-run-1",
    seriesKey: "property:pocheon-001:standard",
    geo: pocheonGeo,
    observedAt: "2026-08-01T09:00:00.000Z",
    fetchedAt: "2026-08-01T09:00:00.000Z",
    availableAt: "2026-08-01T09:00:00.000Z",
    featureAsOf: "2026-08-01T10:00:00.000Z"
  });
  assert.equal(zeroInventory.status, "zero");
  assert.equal(zeroInventory.observations[0].status, "zero");
  assert.equal(zeroInventory.observations[0].value, 0);
  assert.equal(zeroInventory.observations[1].status, "zero");
  assert.equal(zeroInventory.observations[1].value, 0);
  assert.equal(zeroInventory.observations[2].status, "missing", "0/0 availability ratio must remain undefined");
  assert.equal(zeroInventory.observations[0].leadTimeDays, 14);

  const missingInventory = adaptLodgingInventoryRow({
    row: { total: "", available: null, checkIn: "2026-08-15", checkOut: "2026-08-16" },
    propertyId: "pocheon-001",
    regionKey: "kr_gyeonggi_pocheon",
    runId: "inventory-run-2",
    geo: pocheonGeo,
    observedAt: "2026-08-01T09:00:00.000Z",
    fetchedAt: "2026-08-01T09:00:00.000Z",
    availableAt: "2026-08-01T09:00:00.000Z",
    featureAsOf: "2026-08-01T10:00:00.000Z"
  });
  assert.equal(missingInventory.observations[0].status, "missing");
  assert.equal(missingInventory.observations[0].value, null);
  assert.equal(missingInventory.observations[1].status, "missing");
  assert.equal(missingInventory.observations[1].value, null);

  const conflictingInventory = adaptLodgingInventoryRow({
    row: { total: 3, available: 4, checkIn: "2026-08-15", checkOut: "2026-08-16" },
    propertyId: "pocheon-001",
    regionKey: "kr_gyeonggi_pocheon",
    runId: "inventory-run-3",
    geo: pocheonGeo,
    observedAt: "2026-08-01T09:00:00.000Z",
    fetchedAt: "2026-08-01T09:00:00.000Z",
    availableAt: "2026-08-01T09:00:00.000Z",
    featureAsOf: "2026-08-01T10:00:00.000Z"
  });
  assert.equal(conflictingInventory.status, "conflict");
  assert.equal(conflictingInventory.observations[0].status, "ready");
  assert.equal(conflictingInventory.observations[1].status, "conflict");
  assert.equal(conflictingInventory.observations[1].value, 4);
  assert.equal(conflictingInventory.observations[2].status, "conflict");

  const actualRevenue = adaptRegionalRevenue({
    revenueBasis: "settled_actual",
    modelRole: "target",
    isFinal: true,
    regionKey: "kr_gyeonggi_pocheon",
    period: { from: "2026-08-01", to: "2026-08-07" },
    featureAsOf: "2026-07-31T23:59:59.000Z",
    featureWindow: { from: "2026-07-01", to: "2026-07-31T23:00:00.000Z" },
    targetComputedAt: "2026-08-08T00:00:00.000Z",
    availableAt: "2026-08-08T00:00:00.000Z",
    totalRevenue: 7000000,
    sample: {
      propertyCount: 10,
      propertyDays: 70,
      revenueObservationCount: 70,
      coverage: { numerator: 10, denominator: 12 }
    }
  });
  assert.equal(actualRevenue.revenueBasis, "settled_actual");
  assert.equal(actualRevenue.modelRole, "target");
  assert.equal(actualRevenue.isFinal, true);
  assert.equal(actualRevenue.targetEligible, true);
  assert.equal(actualRevenue.averageRevenuePerPropertyDay, 100000);
  assert.equal(actualRevenue.availableAt, "2026-08-08T00:00:00.000Z");

  const estimateRevenue = adaptRegionalRevenue({
    revenueBasis: "booked_to_date_estimate",
    isFinal: false,
    regionKey: "kr_gyeonggi_pocheon",
    period: { from: "2026-09-01", to: "2026-09-07" },
    featureAsOf: "2026-08-20T00:00:00.000Z",
    featureWindow: { from: "2026-08-01", to: "2026-08-19T23:59:59.000Z" },
    availableAt: "2026-08-20T00:00:00.000Z",
    totalRevenue: 2800000,
    sample: {
      propertyCount: 8,
      propertyDays: 56,
      revenueObservationCount: 32,
      coverage: { numerator: 8, denominator: 12 }
    }
  });
  assert.equal(estimateRevenue.revenueBasis, "booked_to_date_estimate");
  assert.equal(estimateRevenue.modelRole, "proxy_target");
  assert.equal(estimateRevenue.isFinal, false);
  assert.equal(estimateRevenue.targetEligible, false, "booked-to-date estimates must never become actual targets");

  assert.throws(
    () => adaptRegionalRevenue({
      revenueBasis: "booked_to_date_estimate",
      modelRole: "target",
      isFinal: false,
      regionKey: "kr_gyeonggi_pocheon",
      period: { from: "2026-09-01", to: "2026-09-07" },
      featureAsOf: "2026-08-20T00:00:00.000Z",
      availableAt: "2026-08-20T00:00:00.000Z",
      totalRevenue: 2800000,
      sample: { propertyCount: 8, propertyDays: 56, revenueObservationCount: 32, coverage: { numerator: 8, denominator: 12 } }
    }),
    (error) => error instanceof SignalAdapterError && error.code === "ESTIMATED_REVENUE_NOT_TARGET"
  );
  assert.throws(
    () => adaptRegionalRevenue({
      revenueBasis: "booked_to_date_estimate",
      isFinal: false,
      regionKey: "kr_gyeonggi_pocheon",
      period: { from: "2026-09-01", to: "2026-09-07" },
      featureAsOf: "2026-08-20T00:00:00.000Z",
      availableAt: "2026-08-21T00:00:00.000Z",
      totalRevenue: 2800000,
      sample: { propertyCount: 8, propertyDays: 56, revenueObservationCount: 32, coverage: { numerator: 8, denominator: 12 } }
    }),
    (error) => error instanceof SignalAdapterError && error.code === "FEATURE_LEAKAGE"
  );

  assert.equal(Object.isFrozen(incompleteTrend), true);
  assert.equal(Object.isFrozen(searchVolume.observations), true);
  assert.equal(Object.isFrozen(actualRevenue), true);

  console.log("Location signal adapter trend, search-volume, inventory, and revenue boundary tests passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
