"use strict";

global.fetch = async (url) => {
  throw new Error(`External requests are forbidden in location insight contract fixtures: ${url}`);
};

const assert = require("node:assert/strict");
const {
  CONTRACT_VERSIONS,
  ContractValidationError,
  OBSERVATION_STATUSES,
  SOURCE_CATALOG,
  SOURCE_KEYS,
  build,
  buildLeadTimeObservation,
  buildMaintenanceFeatureFrame,
  buildObservation,
  buildRegionalRevenueTargetFrame,
  normalizeObservation,
  redactSensitiveUrl,
  validateObservation
} = require("./location_insight_contract.cjs");

function observationFixture(overrides = {}) {
  return {
    sourceKey: "kto.visitors",
    metricKey: "tourism.visitors.count",
    value: 12840,
    unit: "persons",
    normalization: {
      method: "raw_count",
      version: "v1",
      parameters: { aggregation: "monthly" }
    },
    geo: {
      codeSystem: "MOIS_LEGAL_DONG",
      code: "4165000000",
      level: "sigungu",
      name: "경기도 포천시"
    },
    observedFrom: "2026-07-01",
    observedTo: "2026-07-31",
    sourceUpdatedAt: "2026-08-01T00:00:00.000Z",
    fetchedAt: "2026-08-02T00:00:00.000Z",
    sample: { n: 18, populationN: 18, unit: "properties" },
    coverage: { numerator: 18, denominator: 18, note: "all expected properties" },
    status: "ready",
    confidence: { grade: "A", score: 94, penalties: [] },
    rawPayload: { response: { body: { totalCount: 1 } } },
    ...overrides
  };
}

function main() {
  assert.equal(CONTRACT_VERSIONS.observation, "location-insight.observation.v2");
  assert.deepEqual(OBSERVATION_STATUSES, ["ready", "zero", "missing", "partial", "stale", "conflict"]);
  for (const key of [
    "kto.visitors",
    "kto.resource_demand",
    "kto.demand_intensity",
    "kto.diversity",
    "kto.tour_info",
    "kto.camping",
    "kto.pet",
    "mois.legal_dong",
    "sgis",
    "sgis.boundary_snapshot",
    "kosis",
    "forest",
    "forest.trail",
    "forest.stand_snapshot",
    "vworld",
    "vworld.geocoder",
    "molit.road_network",
    "naver.trend",
    "naver.search_volume",
    "ota",
    "lodging.inventory",
    "lodging.revenue"
  ]) {
    assert.equal(SOURCE_KEYS.includes(key), true, `${key} must be registered`);
    assert.equal(SOURCE_CATALOG[key].key, key);
  }
  assert.equal(Object.isFrozen(SOURCE_CATALOG), true);
  assert.equal(Object.isFrozen(SOURCE_CATALOG["kto.visitors"].domains), true);

  const zero = buildObservation(observationFixture({
    metricKey: "tourism.events.count",
    value: 0,
    status: "zero",
    sample: { n: 0, populationN: 18, unit: "events" },
    rawPayload: { response: { body: { totalCount: 0, items: [] } } }
  }));
  const missing = buildObservation(observationFixture({
    metricKey: "tourism.social.mentions",
    value: 99,
    status: "missing",
    sample: { n: 0, populationN: 18, unit: "properties" },
    coverage: { numerator: 0, denominator: 18, note: "SNS source was not collected" },
    confidence: { grade: "U", score: null, penalties: [{ code: "source_not_collected" }] },
    rawPayloadHash: "",
    rawPayload: undefined
  }));
  assert.equal(zero.value, 0);
  assert.equal(zero.status, "zero");
  assert.equal(missing.value, null, "missing must never be silently treated as numeric zero");
  assert.equal(missing.status, "missing");
  assert.notEqual(zero.status, missing.status);

  const partial = buildObservation(observationFixture({
    sourceKey: "ota",
    metricKey: "ota.available_properties.count",
    value: 4,
    unit: "properties",
    coverage: { numerator: 4, denominator: 18, note: "4 of 18 properties returned authorized OTA observations" },
    sample: { n: 4, populationN: 18, unit: "properties" },
    status: "partial",
    confidence: {
      grade: "C",
      score: 58,
      penalties: [{ code: "ota_coverage_low", message: "OTA sample 4/18 properties" }]
    },
    rawPayload: { authorizedRows: 4 }
  }));
  assert.equal(partial.coverage.numerator, 4);
  assert.equal(partial.coverage.denominator, 18);
  assert.equal(partial.coverage.ratio, 4 / 18);
  assert.equal(partial.confidence.grade, "C");
  assert.equal(partial.confidence.penalties[0].code, "ota_coverage_low");

  const pointInTimeFeature = buildObservation(observationFixture({
    role: "feature",
    availableAt: "2026-08-02T00:00:00.000Z",
    featureAsOf: "2026-08-02T00:00:00.000Z"
  }));
  assert.equal(pointInTimeFeature.role, "feature");
  assert.equal(pointInTimeFeature.availableAt, pointInTimeFeature.featureAsOf);
  assert.throws(
    () => buildObservation(observationFixture({
      role: "feature",
      availableAt: "2026-08-03T00:00:00.000Z",
      featureAsOf: "2026-08-02T00:00:00.000Z"
    })),
    (error) => error instanceof ContractValidationError && error.errors.some((entry) => entry.code === "feature_leakage")
  );

  const invalidStatus = normalizeObservation(observationFixture({ status: "unavailable" }));
  const invalidStatusResult = validateObservation(invalidStatus);
  assert.equal(invalidStatusResult.valid, false);
  assert.equal(invalidStatusResult.errors.some((error) => error.path === "status" && error.code === "invalid_status"), true);
  assert.throws(
    () => buildObservation(observationFixture({ status: "unavailable" })),
    (error) => error instanceof ContractValidationError && error.errors.some((entry) => entry.code === "invalid_status")
  );

  const leadTime = buildLeadTimeObservation(observationFixture({
    sourceKey: "lodging.inventory",
    metricKey: "lodging.inventory.available",
    value: 1,
    unit: "boolean",
    normalization: { method: "availability_flag", version: "v1" },
    observedAt: "2026-08-01T09:00:00.000Z",
    targetDate: "2026-08-15",
    checkIn: "2026-08-15",
    checkOut: "2026-08-16",
    seriesKey: "property:pocheon-001:room:standard",
    runId: "run-20260801-0900",
    propertyId: "pocheon-001",
    regionKey: "kr_gyeonggi_pocheon",
    rawPayload: { available: true, checkIn: "2026-08-15" }
  }));
  assert.equal(leadTime.leadTimeDays, 14);
  assert.equal(leadTime.leadTimeBucket, "d08_14");
  assert.equal(leadTime.bucket, "d08_14");
  assert.equal(leadTime.targetDate, leadTime.checkIn);
  assert.equal(leadTime.propertyId, "pocheon-001");
  assert.equal(leadTime.timezone, "Asia/Seoul");

  const kstBoundaryLeadTime = buildLeadTimeObservation(observationFixture({
    sourceKey: "lodging.inventory",
    metricKey: "lodging.inventory.available",
    value: 1,
    unit: "rooms",
    normalization: { method: "raw_inventory_count", version: "v1" },
    observedAt: "2026-08-01T15:30:00.000Z",
    targetDate: "2026-08-15",
    checkIn: "2026-08-15",
    checkOut: "2026-08-16",
    seriesKey: "property:pocheon-001:room:standard",
    runId: "run-20260802-0030-kst",
    propertyId: "pocheon-001",
    regionKey: "kr_gyeonggi_pocheon",
    rawPayload: { available: 1 }
  }));
  assert.equal(kstBoundaryLeadTime.leadTimeDays, 13, "UTC evening must roll into the next Asia/Seoul business date");

  const maintenance = buildMaintenanceFeatureFrame({
    regionKey: "kr_gyeonggi_pocheon",
    sourceKeys: ["kto.visitors", "naver.trend", "lodging.inventory"],
    featureAsOf: "2026-08-05T00:00:00.000Z",
    window: {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-04T23:00:00.000Z",
      observationCount: 20,
      runCount: 5
    },
    freshness: {
      latestObservedAt: "2026-08-04T12:00:00.000Z"
    },
    failureStreak: {
      current: 2,
      max: 4,
      lastFailureAt: "2026-08-04T23:00:00.000Z",
      lastSuccessAt: "2026-08-04T12:00:00.000Z"
    },
    schedule: {
      cadenceHours: 24,
      lastAttemptAt: "2026-08-04T00:00:00.000Z",
      expectedNextAt: "2026-08-05T00:00:00.000Z"
    },
    latency: { p50Ms: 800, p95Ms: 2400, sampleN: 20 },
    rates: {
      missing: 0.1,
      partial: 0.2,
      conflict: 0.05,
      requestFailure: 0.1
    },
    coverage: { numerator: 18, denominator: 20 },
    volatility: { value: 0.22, method: "coefficient_of_variation", sampleN: 20 },
    publicationAge: {
      publicationId: "region-pocheon-v3",
      publishedAt: "2026-07-20T00:00:00.000Z"
    }
  });
  assert.equal(maintenance.freshness.ageHours, 12);
  assert.equal(maintenance.failureStreak.current, 2);
  assert.equal(maintenance.schedule.overdueHours, 0);
  assert.equal(maintenance.latency.p95Ms, 2400);
  assert.equal(maintenance.rates.missing, 0.1);
  assert.equal(maintenance.coverage.ratio, 0.9);
  assert.equal(maintenance.volatility.value, 0.22);
  assert.equal(maintenance.publicationAge.ageDays, 16);

  const revenueTarget = buildRegionalRevenueTargetFrame({
    regionKey: "kr_gyeonggi_pocheon",
    period: { from: "2026-08-01", to: "2026-08-07" },
    featureAsOf: "2026-07-31T23:59:59.000Z",
    featureWindow: { from: "2026-07-01", to: "2026-07-31T23:00:00.000Z" },
    targetComputedAt: "2026-08-08T00:00:00.000Z",
    revenueBasis: "settled_actual",
    modelRole: "target",
    isFinal: true,
    totalRevenue: 7000000,
    sample: {
      propertyCount: 10,
      propertyDays: 70,
      revenueObservationCount: 70,
      coverage: { numerator: 10, denominator: 12, note: "10 of 12 eligible properties" }
    }
  });
  assert.equal(revenueTarget.averageRevenuePerProperty, 700000);
  assert.equal(revenueTarget.averageRevenuePerPropertyDay, 100000);
  assert.equal(revenueTarget.sample.propertyCount, 10);
  assert.equal(revenueTarget.targetEligible, true);
  assert.throws(
    () => buildRegionalRevenueTargetFrame({
      regionKey: "kr_gyeonggi_pocheon",
      period: { from: "2026-08-01", to: "2026-08-07" },
      featureAsOf: "2026-08-02T00:00:00.000Z",
      featureWindow: { from: "2026-07-01", to: "2026-08-02T00:00:00.000Z" },
      targetComputedAt: "2026-08-08T00:00:00.000Z",
      revenueBasis: "settled_actual",
      modelRole: "target",
      isFinal: true,
      totalRevenue: 7000000,
      sample: {
        propertyCount: 10,
        propertyDays: 70,
        revenueObservationCount: 70,
        coverage: { numerator: 10, denominator: 12 }
      }
    }),
    (error) => error instanceof ContractValidationError && error.errors.some((entry) => entry.code === "target_leakage")
  );
  assert.throws(
    () => buildRegionalRevenueTargetFrame({
      regionKey: "kr_gyeonggi_pocheon",
      period: { from: "2026-08-01", to: "2026-08-07" },
      featureAsOf: "2026-07-31T23:59:59.000Z",
      targetComputedAt: "2026-08-08T00:00:00.000Z",
      revenueBasis: "booked_to_date_estimate",
      modelRole: "target",
      isFinal: false,
      totalRevenue: 7000000,
      sample: {
        propertyCount: 10,
        propertyDays: 70,
        revenueObservationCount: 70,
        coverage: { numerator: 10, denominator: 12 }
      }
    }),
    (error) => error instanceof ContractValidationError && error.errors.some((entry) => entry.code === "estimated_revenue_not_target")
  );

  const secretUrl = "https://example.test/openapi?serviceKey=super-secret-value&SGG_CD=41650&apiKey=another-secret#access_token=fragment-secret";
  const redacted = redactSensitiveUrl(secretUrl);
  assert.equal(redacted.includes("super-secret-value"), false);
  assert.equal(redacted.includes("another-secret"), false);
  assert.equal(redacted.includes("fragment-secret"), false);
  assert.equal(redacted.includes("SGG_CD=41650"), true, "non-secret request dimensions must remain auditable");
  const secretSafeObservation = buildObservation(observationFixture({
    sourceUrl: secretUrl,
    request: {
      url: secretUrl,
      headers: { Authorization: "Bearer do-not-store", "X-Request-Id": "request-1" },
      query: { serviceKey: "do-not-store-either", SGG_CD: "41650" }
    }
  }));
  assert.equal(secretSafeObservation.sourceUrl.includes("secret"), false);
  assert.match(secretSafeObservation.requestFingerprint, /^[a-f0-9]{64}$/);
  assert.match(secretSafeObservation.rawPayloadHash, /^[a-f0-9]{64}$/);
  assert.equal("request" in secretSafeObservation, false);
  assert.equal("rawPayload" in secretSafeObservation, false);

  const generic = build("observation", observationFixture());
  assert.equal(generic.contractType, "observation");
  assert.equal(Object.isFrozen(generic), true);
  assert.equal(Object.isFrozen(generic.confidence.penalties), true);

  console.log("Location insight observation, lead-time, maintenance, revenue target, and source catalog contract tests passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
