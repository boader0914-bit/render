"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "regional momentum fixtures" });

const {
  RegionalMomentumContractError,
  SCHEMA_VERSIONS,
  buildMomentumRevenueValidation,
  buildRegionalMaintenanceForecast,
  buildRegionalMarketMomentum,
  buildRegionalSignalObservation,
  momentumComponentFromObservation,
  validateMomentum,
  validateRegionalSignalObservation
} = require("./regional_market_momentum_contract.cjs");

function payloadHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function expectContractError(run, expectedCode, expectedType = "") {
  assert.throws(run, (error) => {
    assert.ok(error instanceof RegionalMomentumContractError);
    assert.equal(error.code, "REGIONAL_MOMENTUM_CONTRACT_INVALID");
    if (expectedType) assert.equal(error.contractType, expectedType);
    assert.ok(error.errors.some((entry) => entry.code === expectedCode), `expected ${expectedCode}, received ${JSON.stringify(error.errors)}`);
    return true;
  });
}

const sourcePayload = { fixture: "pocheon-search-volume", rows: [{ value: 4210 }] };
const observationBase = {
  regionKey: "kr_gyeonggi_pocheon",
  signalKey: "search_interest",
  signalRole: "search_interest_driver",
  source: {
    sourceId: "fixture_search_interest",
    provider: "fixture-provider",
    datasetId: "fixture-dataset-search-1",
    officialUrl: "https://example.go.kr/catalog/search-interest"
  },
  observedAt: "2026-07-31T23:59:59.000Z",
  measurementPeriod: {
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-31T23:59:59.000Z"
  },
  sampleCount: 31,
  coverage: { numerator: 31, denominator: 31, note: "daily fixture coverage" },
  refreshedAt: "2026-08-01T01:00:00.000Z",
  asOf: "2026-08-01T02:00:00.000Z",
  availableAt: "2026-08-01T01:00:00.000Z",
  confidence: { grade: "A", score: 96, penalties: [] },
  normalization: {
    method: "fixture_min_max",
    version: "fixture-normalization.v1",
    parameters: { minimum: 0, maximum: 10000 }
  },
  provenance: {
    catalogVersion: "location-public-source-catalog.v1",
    fixtureId: "pocheon-search-volume-2026-07",
    payloadHash: payloadHash(sourcePayload),
    license: "fixture-only"
  }
};

const readyObservation = buildRegionalSignalObservation({
  ...observationBase,
  status: "ready",
  rawValue: 4210,
  normalizedValue: 68
});
assert.equal(readyObservation.schemaVersion, SCHEMA_VERSIONS.signalObservation);
assert.equal(readyObservation.status, "ready");
assert.equal(readyObservation.rawValue, 4210);
assert.equal(readyObservation.normalizedValue, 68);
assert.equal(readyObservation.provenance.payloadHash, payloadHash(sourcePayload));
assert.equal(readyObservation.provenance.fixtureId, "pocheon-search-volume-2026-07");
assert.equal(Object.isFrozen(readyObservation), true);
assert.equal(validateRegionalSignalObservation(readyObservation).valid, true);
const readyMomentumComponent = momentumComponentFromObservation(readyObservation, {
  key: "search_interest",
  metricKey: "search_interest_index",
  direction: "increase_positive",
  weight: 0.6
});
assert.equal(readyMomentumComponent.sourceId, readyObservation.source.sourceId);
assert.equal(readyMomentumComponent.normalizedValue, readyObservation.normalizedValue);
assert.deepEqual(readyMomentumComponent.measurementPeriod, readyObservation.measurementPeriod);
assert.equal(readyMomentumComponent.weight, 0.6);
assert.equal(Object.isFrozen(readyMomentumComponent), true);

const zeroObservation = buildRegionalSignalObservation({
  ...observationBase,
  status: "zero",
  sampleCount: 31,
  rawValue: undefined,
  normalizedValue: undefined
});
assert.equal(zeroObservation.status, "zero");
assert.equal(zeroObservation.rawValue, 0);
assert.equal(zeroObservation.normalizedValue, 0);
assert.notEqual(zeroObservation.status, "missing");

const missingObservation = buildRegionalSignalObservation({
  ...observationBase,
  status: "missing",
  sampleCount: 0,
  coverage: { numerator: 0, denominator: 31, note: "fixture payload absent" },
  rawValue: 0,
  normalizedValue: 0,
  confidence: { grade: "U", score: null }
});
assert.equal(missingObservation.status, "missing");
assert.equal(missingObservation.rawValue, null, "missing must never be coerced to zero");
assert.equal(missingObservation.normalizedValue, null);
assert.equal(missingObservation.confidence.grade, "U");
assert.equal(missingObservation.confidence.score, null);

expectContractError(
  () => buildRegionalSignalObservation({
    ...observationBase,
    status: "ready",
    rawValue: 1,
    normalizedValue: 1,
    provenance: { ...observationBase.provenance, payloadHash: "not-a-sha256" }
  }),
  "invalid_hash",
  "regional_signal_observation"
);
expectContractError(
  () => buildRegionalSignalObservation({
    ...observationBase,
    status: "ready",
    rawValue: 1,
    normalizedValue: 1,
    source: { ...observationBase.source, officialUrl: "https://example.go.kr/catalog?serviceKey=fixture-secret" }
  }),
  "credential_url_forbidden",
  "regional_signal_observation"
);
expectContractError(
  () => buildRegionalSignalObservation({
    ...observationBase,
    status: "ready",
    rawValue: 1,
    normalizedValue: 1,
    availableAt: "2026-08-02T00:00:00.000Z"
  }),
  "feature_leakage",
  "regional_signal_observation"
);

function momentumComponent(overrides = {}) {
  return {
    key: "search_interest",
    signalRole: "search_interest_driver",
    sourceId: "fixture_search_interest",
    metricKey: "search_interest_index",
    direction: "increase_positive",
    normalizedValue: 80,
    weight: 0.6,
    status: "ready",
    availableAt: "2026-08-01T01:00:00.000Z",
    measurementPeriod: {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-07-31T23:59:59.000Z"
    },
    coverage: { numerator: 31, denominator: 31 },
    confidence: { grade: "A", score: 96 },
    ...overrides
  };
}

const momentumBase = {
  regionKey: "kr_gyeonggi_pocheon",
  scope: "within_region_time_series",
  period: { from: "2026-07-01", to: "2026-07-31" },
  featureAsOf: "2026-08-01T02:00:00.000Z",
  modelVersion: "regional-momentum.fixture.v1",
  weightsVersion: "regional-momentum.weights.fixture.v1",
  normalizationVersion: "regional-momentum.normalization.fixture.v1",
  minimumWeightCoverage: 0.7,
  components: [
    momentumComponent(),
    momentumComponent({
      key: "booking_lead_time",
      signalRole: "lead_time_driver",
      sourceId: "fixture_booking_lead_time",
      metricKey: "booking_lead_time_index",
      direction: "decrease_positive",
      normalizedValue: 40,
      weight: 0.4
    })
  ],
  dataQuality: {
    status: "ready",
    grade: "A",
    score: 95,
    coverage: { numerator: 2, denominator: 2 },
    penalties: []
  }
};

const momentum = buildRegionalMarketMomentum(momentumBase);
assert.equal(momentum.schemaVersion, SCHEMA_VERSIONS.momentum);
assert.equal(momentum.status, "ready");
assert.equal(momentum.value, 72, "80*0.6 + (100-40)*0.4 must use direction-aligned weighted values");
assert.equal(momentum.calculation.totalWeight, 1);
assert.equal(momentum.calculation.observedWeight, 1);
assert.equal(momentum.calculation.weightCoverage, 1);
assert.equal(momentum.calculation.qualityAdjustsValue, false);
assert.equal(momentum.calculation.revenueUsedAsFeature, false);
assert.equal(momentum.publishable, true);
assert.match(momentum.snapshotHash, /^[a-f0-9]{64}$/);
const tamperedMomentumValidation = validateMomentum({ ...momentum, value: 73 });
assert.equal(tamperedMomentumValidation.valid, false);
assert.ok(tamperedMomentumValidation.errors.some((entry) => entry.code === "hash_mismatch"));

const lowQualityMomentum = buildRegionalMarketMomentum({
  ...momentumBase,
  components: momentumBase.components.map((component) => ({
    ...component,
    confidence: { grade: "D", score: 20, penalties: [{ code: "fixture_quality_penalty", points: 40 }] }
  })),
  dataQuality: {
    status: "partial",
    grade: "D",
    score: 20,
    coverage: { numerator: 1, denominator: 2 },
    penalties: [{ code: "fixture_quality_penalty", points: 40 }]
  }
});
assert.equal(lowQualityMomentum.value, momentum.value, "quality metadata must not alter the momentum value");
assert.equal(lowQualityMomentum.publishable, false, "partial data quality must gate publication without changing the indicator value");
assert.notEqual(lowQualityMomentum.snapshotHash, momentum.snapshotHash, "quality remains auditable even though it does not adjust the value");

const crossRegionMomentum = buildRegionalMarketMomentum({ ...momentumBase, scope: "cross_region_snapshot" });
assert.equal(crossRegionMomentum.scope, "cross_region_snapshot");
assert.equal(momentum.scope, "within_region_time_series");
assert.notEqual(crossRegionMomentum.snapshotHash, momentum.snapshotHash, "within-region and cross-region scopes must remain distinct snapshots");
expectContractError(
  () => buildRegionalMarketMomentum({ ...momentumBase, scope: "mixed_scope" }),
  "invalid_scope",
  "regional_market_momentum"
);

expectContractError(
  () => buildRegionalMarketMomentum({
    ...momentumBase,
    components: [
      momentumBase.components[0],
      momentumComponent({
        key: "regional_revenue",
        signalRole: "regional_average_revenue",
        sourceId: "fixture_revenue_target",
        metricKey: "settled_revenue",
        weight: 0.4
      })
    ]
  }),
  "target_leakage",
  "regional_market_momentum"
);

const insufficientMomentum = buildRegionalMarketMomentum({
  ...momentumBase,
  components: [
    momentumComponent({ weight: 0.4 }),
    momentumComponent({
      key: "ota_availability",
      signalRole: "ota_supply_driver",
      sourceId: "fixture_ota_supply",
      metricKey: "ota_availability_index",
      normalizedValue: null,
      weight: 0.6,
      status: "missing",
      confidence: { grade: "U", score: null }
    })
  ],
  dataQuality: {
    status: "partial",
    grade: "C",
    score: 55,
    coverage: { numerator: 1, denominator: 2 },
    penalties: [{ code: "fixture_missing_ota", points: 20 }]
  }
});
assert.equal(insufficientMomentum.status, "partial");
assert.equal(insufficientMomentum.value, null);
assert.equal(insufficientMomentum.calculation.weightCoverage, 0.4);
assert.equal(insufficientMomentum.publishable, false);

const conflictMomentum = buildRegionalMarketMomentum({
  ...momentumBase,
  components: [
    momentumBase.components[0],
    momentumComponent({
      key: "tourism_conflict",
      signalRole: "tourism_driver",
      sourceId: "fixture_tourism_conflict",
      metricKey: "tourism_intensity",
      normalizedValue: null,
      weight: 0.4,
      status: "conflict",
      confidence: { grade: "C", score: 50 }
    })
  ],
  dataQuality: { ...momentumBase.dataQuality, status: "partial", grade: "C", score: 60 }
});
assert.equal(conflictMomentum.status, "conflict");
assert.equal(conflictMomentum.value, null);
assert.equal(conflictMomentum.publishable, false);

const staleMomentum = buildRegionalMarketMomentum({
  ...momentumBase,
  components: [
    momentumBase.components[0],
    { ...momentumBase.components[1], status: "stale" }
  ],
  dataQuality: {
    ...momentumBase.dataQuality,
    status: "stale",
    grade: "C",
    score: 64,
    penalties: [{ code: "fixture_stale_lead_time", points: 15 }]
  }
});
assert.equal(staleMomentum.status, "stale");
assert.equal(staleMomentum.value, 72);
assert.equal(staleMomentum.publishable, false);

expectContractError(
  () => buildRegionalMarketMomentum({
    ...momentumBase,
    components: [
      { ...momentumBase.components[0], availableAt: "2026-08-02T00:00:00.000Z" },
      momentumBase.components[1]
    ]
  }),
  "feature_leakage",
  "regional_market_momentum"
);

function momentumSeries(values, extra = {}) {
  return values.map((value, index) => ({
    periodKey: `2026-${String(index + 1).padStart(2, "0")}`,
    value,
    revenueUsedAsFeature: false,
    ...extra
  }));
}

function revenueSeries(values, extra = {}) {
  return values.map((value, index) => ({
    periodKey: `2026-${String(index + 1).padStart(2, "0")}`,
    value,
    revenueBasis: "settled_actual",
    isFinal: true,
    ...extra
  }));
}

const revenueValidation = buildMomentumRevenueValidation({
  regionKey: "kr_gyeonggi_pocheon",
  modelVersion: "regional-momentum.fixture.v1",
  evaluatedAt: "2026-08-05T00:00:00.000Z",
  minimumSampleCount: 6,
  lags: [-1, 0, 1, 2],
  momentumSeries: momentumSeries([10, 20, 30, 40, 50, 60]),
  revenueSeries: revenueSeries([100, 200, 300, 400, 500, 600])
});
assert.equal(revenueValidation.schemaVersion, SCHEMA_VERSIONS.revenueValidation);
assert.equal(revenueValidation.status, "ready");
assert.equal(revenueValidation.sampleCount, 6);
assert.equal(revenueValidation.metrics.pearson, 1);
assert.equal(revenueValidation.metrics.spearman, 1);
assert.deepEqual(revenueValidation.metrics.directionAgreement, { comparable: 5, agreed: 5, rate: 1 });
assert.deepEqual(
  revenueValidation.metrics.lagCorrelations.map((entry) => ({ lag: entry.lag, sampleCount: entry.sampleCount, pearson: entry.pearson })),
  [
    { lag: -1, sampleCount: 5, pearson: 1 },
    { lag: 0, sampleCount: 6, pearson: 1 },
    { lag: 1, sampleCount: 5, pearson: 1 },
    { lag: 2, sampleCount: 4, pearson: 1 }
  ]
);
assert.equal(revenueValidation.guardrails.targetLeakageDetected, false);
assert.equal(revenueValidation.guardrails.publishable, true);
assert.match(revenueValidation.evidenceHash, /^[a-f0-9]{64}$/);

const insufficientRevenueValidation = buildMomentumRevenueValidation({
  regionKey: "kr_gyeongnam_sancheong",
  modelVersion: "regional-momentum.fixture.v1",
  evaluatedAt: "2026-08-05T00:00:00.000Z",
  minimumSampleCount: 6,
  momentumSeries: momentumSeries([10, 20, 30]),
  revenueSeries: revenueSeries([100, 200, 300])
});
assert.equal(insufficientRevenueValidation.status, "partial");
assert.equal(insufficientRevenueValidation.sampleCount, 3);
assert.equal(insufficientRevenueValidation.metrics.pearson, null);
assert.equal(insufficientRevenueValidation.metrics.spearman, null);
assert.equal(insufficientRevenueValidation.guardrails.publishable, false);

const estimatedRevenueValidation = buildMomentumRevenueValidation({
  regionKey: "kr_gyeongnam_hadong",
  modelVersion: "regional-momentum.fixture.v1",
  evaluatedAt: "2026-08-05T00:00:00.000Z",
  momentumSeries: momentumSeries([10, 20, 30, 40, 50, 60]),
  revenueSeries: revenueSeries([100, 200, 300, 400, 500, 600], { revenueBasis: "estimated" })
});
assert.equal(estimatedRevenueValidation.status, "conflict");
assert.equal(estimatedRevenueValidation.metrics.pearson, null);
assert.equal(estimatedRevenueValidation.guardrails.targetLeakageDetected, false);
assert.equal(estimatedRevenueValidation.guardrails.targetBasisConflict, true);
assert.equal(estimatedRevenueValidation.guardrails.publishable, false);

const targetLeakageValidation = buildMomentumRevenueValidation({
  regionKey: "kr_gyeonggi_pocheon",
  modelVersion: "regional-momentum.fixture.v1",
  evaluatedAt: "2026-08-05T00:00:00.000Z",
  momentumSeries: momentumSeries([10, 20, 30, 40, 50, 60], { revenueUsedAsFeature: true }),
  revenueSeries: revenueSeries([100, 200, 300, 400, 500, 600])
});
assert.equal(targetLeakageValidation.status, "conflict");
assert.equal(targetLeakageValidation.metrics.lagCorrelations.length, 0);
assert.equal(targetLeakageValidation.guardrails.targetLeakageDetected, true);

const maintenanceBase = {
  regionKey: "kr_gyeonggi_pocheon",
  forecastHorizon: { from: "2026-08-06", to: "2026-08-12", days: 7 },
  modelVersion: "regional-maintenance.fixture.v1",
  featureAsOf: "2026-08-05T00:00:00.000Z",
  generatedAt: "2026-08-05T01:00:00.000Z",
  inputCoverage: { numerator: 18, denominator: 20, note: "fixture input coverage" },
  sourceObservationCount: 90,
  demandPressure: 72,
  confidenceInterval: { lower: 64, upper: 81, level: 0.9 },
  status: "ready",
  confidence: { grade: "B", score: 84, penalties: [] },
  penalties: []
};

const maintenance = buildRegionalMaintenanceForecast(maintenanceBase);
assert.equal(maintenance.schemaVersion, SCHEMA_VERSIONS.maintenanceForecast);
assert.equal(maintenance.status, "ready");
assert.equal(maintenance.demandPressure, 72);
assert.deepEqual(maintenance.confidenceInterval, { lower: 64, upper: 81, level: 0.9 });
assert.equal(maintenance.operationalOnly, true);

const missingMaintenance = buildRegionalMaintenanceForecast({
  ...maintenanceBase,
  status: "missing",
  inputCoverage: { numerator: 0, denominator: 20, note: "no fixture observations" },
  sourceObservationCount: 0,
  demandPressure: 0,
  confidenceInterval: { lower: 0, upper: 0, level: 0.9 },
  confidence: { grade: "U", score: null }
});
assert.equal(missingMaintenance.status, "missing");
assert.equal(missingMaintenance.demandPressure, null);
assert.equal(missingMaintenance.confidenceInterval.lower, null);
assert.equal(missingMaintenance.confidenceInterval.upper, null);
assert.equal(missingMaintenance.confidence.grade, "U");
assert.equal(missingMaintenance.confidence.score, null);

expectContractError(
  () => buildRegionalMaintenanceForecast({
    ...maintenanceBase,
    confidenceInterval: { lower: 73, upper: 81, level: 0.9 }
  }),
  "invalid_interval",
  "regional_maintenance_forecast"
);

assert.equal(networkGuard.blockedAttempts(), 0, "momentum contract fixtures must never call the network");
networkGuard.restore();
console.log("Regional market momentum contract fixture checks passed");
