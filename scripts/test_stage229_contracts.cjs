"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_API_BASE,
  INSIGHTS_DIMENSIONS,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_LIFECYCLE_STATES,
  INSIGHTS_MINIMUM_COHORT_SIZE,
  INSIGHTS_MINIMUM_FORECAST_SERIES,
  INSIGHTS_OBSERVATION_FRESH_HOURS,
  INSIGHTS_PROVIDER_ID,
  INSIGHTS_READINESS_STATES,
  INSIGHTS_REQUIRED_LEAD_DAYS,
  INSIGHTS_SIGNAL_FRESH_HOURS,
  INSIGHTS_SIGNAL_KINDS,
  INSIGHTS_STAGE,
  allowedActionsForLifecycle,
  assertLifecycleTransition,
  deriveCohortDescriptor,
  deriveForecast,
  deriveLocationAnalysis,
  deriveReportScopes,
  normalizeSignalObservation,
  selectLocationEvidence,
  selectReportEvidence,
  stableHash
} = require("./integration/contracts/insights.cjs");
const {
  createDeterministicInsightsFixtureProvider
} = require("./integration/services/insights_fixture_provider.cjs");
const {
  INTEGRATION_FEATURE_DEFINITIONS,
  readIntegrationFeatureFlags
} = require("./integration_feature_flags.cjs");

const ROOT = path.resolve(__dirname, "..");
const SIGNAL_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "signal_contract_v1.json");
const CASE_FIXTURE_PATH = path.join(ROOT, "test", "fixtures", "stage229", "location_forecast_cases_v1.json");

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function code(error) {
  return error?.code || "";
}

function observationsFor(testCase) {
  const rows = [];
  testCase.stockSeries.forEach((series, seriesIndex) => {
    const productKey = `stage229-product-${seriesIndex + 1}`;
    for (const point of series.points) {
      const common = {
        companyId: testCase.tenantCompanyId,
        productKey,
        targetDate: series.stayDate,
        observedAt: point.observedAt,
        synthetic: true
      };
      rows.push({ ...common, kind: "product.total-stock", value: 10 });
      rows.push({ ...common, kind: "product.available-stock", value: point.availableUnits });
    }
  });
  rows.push({
    companyId: testCase.tenantCompanyId,
    productKey: "stage229-product-1",
    targetDate: `${testCase.forecastInputMonth}-30`,
    observedAt: "2026-07-28T23:10:00.000Z",
    channel: "fixture-ota",
    kind: "ota.exposure",
    value: true,
    synthetic: true
  });
  return rows.map((row, index) => ({
    ...row,
    observationId: `obs_stage229_contract_${testCase.id}_${String(index + 1).padStart(2, "0")}`
  }));
}

function cohortCompany(companyId, region = "Stage 229 합성 지역") {
  return {
    company: { companyId, region, category: "glamping" },
    observations: [
      {
        companyId,
        productKey: "standard",
        targetDate: "2026-07-30",
        observedAt: "2026-07-29T00:00:00.000Z",
        kind: "product.total-stock",
        value: 10,
        synthetic: true
      },
      {
        companyId,
        productKey: "standard",
        targetDate: "2026-07-30",
        observedAt: "2026-07-29T00:00:00.000Z",
        kind: "product.available-stock",
        value: 3,
        synthetic: true
      },
      {
        companyId,
        productKey: "standard",
        targetDate: "2026-07-30",
        observedAt: "2026-07-29T00:00:00.000Z",
        kind: "product.price",
        value: 150000,
        synthetic: true
      },
      {
        companyId,
        productKey: "standard",
        targetDate: "2026-07-30",
        observedAt: "2026-07-29T00:00:00.000Z",
        channel: "fixture-ota",
        kind: "ota.exposure",
        value: true,
        synthetic: true
      }
    ].map((row, index) => ({
      ...row,
      observationId: `obs_stage229_report_${companyId}_${index + 1}`
    }))
  };
}

async function main() {
  const signalFixture = readJson(SIGNAL_FIXTURE_PATH);
  const caseFixture = readJson(CASE_FIXTURE_PATH);

  assert.equal(INSIGHTS_STAGE, 229);
  assert.equal(INSIGHTS_API_BASE, "/api/integration/insights");
  assert.equal(INSIGHTS_PROVIDER_ID, "stage229-deterministic-signal-fixture");
  assert.equal(INSIGHTS_FIXTURE_VERSION, "stage229-deterministic-signals-v1");
  assert.equal(INSIGHTS_ALGORITHM_VERSION, "v2-stage229-location-forecast-v1");
  assert.equal(INSIGHTS_MINIMUM_FORECAST_SERIES, 3);
  assert.equal(INSIGHTS_MINIMUM_COHORT_SIZE, 3);
  assert.deepEqual(INSIGHTS_REQUIRED_LEAD_DAYS, [14, 7, 1]);
  assert.equal(INSIGHTS_OBSERVATION_FRESH_HOURS, 24);
  assert.equal(INSIGHTS_SIGNAL_FRESH_HOURS, 168);
  assert.deepEqual(INSIGHTS_READINESS_STATES, [
    "not-collected", "collecting", "insufficient-data", "not-published", "ready"
  ]);
  assert.deepEqual(INSIGHTS_LIFECYCLE_STATES, [
    "requested", "draft", "in-review", "changes-requested", "reviewed", "published"
  ]);
  assert.deepEqual(INSIGHTS_DIMENSIONS.map((row) => row.key), [
    "tourism", "industry", "catchment", "accessibility", "interest", "ota", "leadtime"
  ]);

  assert.equal(signalFixture.fixtureVersion, INSIGHTS_FIXTURE_VERSION);
  assert.equal(signalFixture.providerId, INSIGHTS_PROVIDER_ID);
  assert.equal(signalFixture.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
  assert.deepEqual(signalFixture.expectedKinds, INSIGHTS_SIGNAL_KINDS);
  assert.ok(Object.values(signalFixture.sourceBoundary).every((value) => value === true || value === 0));
  assert.equal(caseFixture.fixtureVersion, INSIGHTS_FIXTURE_VERSION);
  assert.equal(caseFixture.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
  assert.deepEqual(caseFixture.thresholds, {
    minimumCompleteSeries: 3,
    leadDays: [14, 7, 1],
    minimumStockPairPoints: 9,
    minimumAnonymousCohort: 3,
    freshObservationHours: 24,
    freshSignalHours: 168
  });
  assert.equal(
    stableHash(signalFixture, 64),
    "690f783d1c79e4864ddbdbf8bf3f2a144dda703a54b3fd53713699e9af13367b",
    "signal fixture changed without an explicit fixture-version update"
  );
  assert.equal(
    stableHash(caseFixture, 64),
    "1af0ab9f240195f9738b8790f38713e7027d761e9d6fab3905436adf0d3adb93",
    "forecast fixture changed without an explicit fixture-version update"
  );

  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.reliability.dependsOn, ["freshObservation"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.locationCard.dependsOn, ["reliability"]);
  assert.deepEqual(INTEGRATION_FEATURE_DEFINITIONS.businessReport.dependsOn, ["freshObservation"]);
  const dependencyBase = {
    NODE_ENV: "test",
    V2_INTEGRATION_AUTH_ENABLED: "true",
    V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true",
    V2_INTEGRATION_FRESH_COMPANY_ENABLED: "true",
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: "true"
  };
  assert.equal(readIntegrationFeatureFlags({ NODE_ENV: "test", V2_INTEGRATION_RELIABILITY_ENABLED: "true" }).reliability, false);
  assert.equal(readIntegrationFeatureFlags({ ...dependencyBase, V2_INTEGRATION_LOCATION_CARD_ENABLED: "true" }).locationCard, false);
  assert.equal(readIntegrationFeatureFlags({ ...dependencyBase, V2_INTEGRATION_BUSINESS_REPORT_ENABLED: "true" }).businessReport, true);
  const enabled = readIntegrationFeatureFlags({
    ...dependencyBase,
    V2_INTEGRATION_RELIABILITY_ENABLED: "true",
    V2_INTEGRATION_LOCATION_CARD_ENABLED: "true",
    V2_INTEGRATION_BUSINESS_REPORT_ENABLED: "true"
  });
  assert.equal(enabled.reliability, true);
  assert.equal(enabled.locationCard, true);
  assert.equal(enabled.businessReport, true);

  const provider = createDeterministicInsightsFixtureProvider({ fixture: signalFixture });
  const providerInput = {
    companyId: "cmp_place_stage229_tenant",
    runId: "run_stage229_fixture_0001",
    observedAt: signalFixture.asOf,
    periodMonth: signalFixture.asOf.slice(0, 7),
    region: "Stage 229 합성 지역"
  };
  const firstSignals = await provider.collect(providerInput);
  const secondSignals = await provider.collect(providerInput);
  assert.deepEqual(secondSignals, firstSignals, "the fixture adapter must be deterministic for identical input");
  assert.equal(firstSignals.providerId, INSIGHTS_PROVIDER_ID);
  assert.equal(firstSignals.fixtureVersion, INSIGHTS_FIXTURE_VERSION);
  assert.equal(firstSignals.externalNetworkCalls, 0);
  assert.equal(firstSignals.synthetic, true);
  assert.deepEqual(firstSignals.signals.map((row) => row.kind), INSIGHTS_SIGNAL_KINDS);
  assert.deepEqual(firstSignals.signals.map((row) => row.index), [70, 66, 76, 82, 74, 66, 70, 68, 80]);
  assert.ok(firstSignals.signals.every((row) => row.sourceUrl.startsWith("https://signals.example.invalid/")));
  assert.ok(firstSignals.signals.every((row) => row.provenance.externalNetworkCalls === 0));
  assert.deepEqual(provider.diagnostics(), {
    providerId: INSIGHTS_PROVIDER_ID,
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
    fixtureVersion: INSIGHTS_FIXTURE_VERSION,
    fixtureCollections: 2,
    generatedSignals: INSIGHTS_SIGNAL_KINDS.length * 2,
    externalRequests: 0,
    credentialReads: 0,
    legacyRuntimeReads: 0,
    legacyRuntimeCopies: 0,
    productionMutations: 0
  });

  assert.throws(
    () => normalizeSignalObservation({ ...firstSignals.signals[0], synthetic: false }),
    (error) => code(error) === "INSIGHTS_SYNTHETIC_REQUIRED"
  );
  assert.throws(
    () => normalizeSignalObservation({ ...firstSignals.signals[0], sourceUrl: "https://example.com/real-provider" }),
    (error) => code(error) === "INSIGHTS_EXTERNAL_PROVIDER_FORBIDDEN"
  );
  assert.throws(
    () => normalizeSignalObservation({ ...firstSignals.signals[0], provenance: { path: "C:\\legacy\\outputs\\signal.json" } }),
    (error) => code(error) === "INSIGHTS_RAW_PATH_FORBIDDEN"
  );

  const insufficientCase = caseFixture.cases.find((row) => row.id === "cold-start-insufficient");
  const readyCase = caseFixture.cases.find((row) => row.id === "minimum-ready-boundary");
  assert.ok(insufficientCase && readyCase);
  const insufficientForecast = deriveForecast(observationsFor(insufficientCase), {
    asOf: caseFixture.asOf,
    forecastMonth: insufficientCase.reportMonth
  });
  assert.equal(insufficientForecast.state, "insufficient-data");
  assert.equal(insufficientForecast.sampleCount, 2);
  assert.equal(insufficientForecast.value, null);
  assert.equal(insufficientForecast.bookingPacePerDay, null);
  assert.equal(insufficientForecast.interval, null);
  assert.ok(insufficientForecast.missingReasons.length > 0);

  const readyObservations = observationsFor(readyCase);
  const readyForecast = deriveForecast(readyObservations, {
    asOf: caseFixture.asOf,
    forecastMonth: readyCase.reportMonth
  });
  assert.deepEqual(
    deriveForecast(readyObservations, { asOf: caseFixture.asOf, forecastMonth: readyCase.reportMonth }),
    readyForecast,
    "fixed input must produce a byte-stable forecast contract"
  );
  assert.equal(readyForecast.state, "ready");
  assert.equal(readyForecast.algorithmVersion, INSIGHTS_ALGORITHM_VERSION);
  assert.equal(readyForecast.forecastMonth, readyCase.reportMonth, "the output period is next month while inputs stay historical");
  assert.ok(readyForecast.inputPeriod.to.startsWith(readyCase.forecastInputMonth));
  assert.equal(readyForecast.sampleCount, readyCase.expected.sampleCount);
  assert.equal(readyForecast.pointsPerSeries * readyForecast.sampleCount, readyCase.expected.stockPairPointCount);
  assert.equal(readyForecast.value, 70);
  assert.equal(readyForecast.bookingPacePerDay, 4.62);
  assert.deepEqual(readyForecast.interval, { low: 58.7, high: 81.3, display: "58.7~81.3점" });
  const staleForecast = deriveForecast(readyObservations, {
    asOf: "2026-07-31T00:00:00.000Z",
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(staleForecast.state, "insufficient-data");
  assert.equal(staleForecast.freshness.state, "stale");
  assert.equal(staleForecast.value, null);
  const unrelatedFreshRows = [
    ...readyObservations,
    {
      observationId: "obs_stage229_unrelated_fresh_quick",
      companyId: readyCase.tenantCompanyId,
      kind: "quick.profile",
      observedAt: "2026-07-30T23:00:00.000Z",
      value: true,
      synthetic: true
    },
    {
      observationId: "obs_stage229_unrelated_fresh_ota",
      companyId: readyCase.tenantCompanyId,
      productKey: "stage229-unrelated",
      targetDate: "2026-07-31",
      channel: "fixture-ota",
      kind: "ota.exposure",
      observedAt: "2026-07-30T23:05:00.000Z",
      value: true,
      synthetic: true
    },
    ...["product.total-stock", "product.available-stock"].map((kind, index) => ({
      observationId: `obs_stage229_incomplete_fresh_${index}`,
      companyId: readyCase.tenantCompanyId,
      productKey: "stage229-incomplete-fresh-series",
      targetDate: "2026-07-31",
      kind,
      observedAt: "2026-07-30T23:10:00.000Z",
      value: index === 0 ? 10 : 6,
      synthetic: true
    }))
  ];
  const unrelatedFreshForecast = deriveForecast(unrelatedFreshRows, {
    asOf: "2026-07-31T23:30:00.000Z",
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(unrelatedFreshForecast.sampleCount, 3);
  assert.equal(unrelatedFreshForecast.freshness.state, "stale", "unrelated fresh quick/OTA or incomplete stock rows must not freshen a complete series");
  assert.equal(unrelatedFreshForecast.state, "insufficient-data");
  assert.equal(unrelatedFreshForecast.value, null);
  assert.equal(deriveForecast([], { asOf: caseFixture.asOf, forecastMonth: readyCase.reportMonth }).state, "not-collected");

  const analysis = deriveLocationAnalysis({
    observations: readyObservations,
    signals: firstSignals.signals,
    asOf: caseFixture.asOf,
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(analysis.state, "ready");
  assert.equal(analysis.overallScore, 76.2);
  assert.deepEqual(analysis.dimensions.map((row) => row.score), [70.1, 70, 68, 80, 75.2, 100, 70]);
  assert.equal(analysis.readiness.freshness.observations, "fresh");
  assert.equal(analysis.readiness.freshness.signals, "fresh");
  assert.equal(analysis.readiness.nextCollectionCta, null);

  const ancientIrrelevantObservation = {
    observationId: "obs_stage229_ancient_irrelevant_quick",
    companyId: readyCase.tenantCompanyId,
    kind: "quick.profile",
    observedAt: "2025-01-01T00:00:00.000Z",
    value: true,
    synthetic: true
  };
  const ancientDuplicateSignal = {
    ...firstSignals.signals[0],
    signalId: "sig_stage229_ancient_duplicate",
    observedAt: "2025-01-01T00:00:00.000Z"
  };
  const locationLineage = selectLocationEvidence(
    [...readyObservations, ancientIrrelevantObservation],
    [...firstSignals.signals, ancientDuplicateSignal],
    { asOf: caseFixture.asOf, forecastMonth: readyCase.reportMonth }
  );
  const locationObservationIds = locationLineage.observations.map((row) => row.observationId);
  const locationSignalIds = locationLineage.signals.map((row) => row.signalId);
  assert.equal(locationLineage.completeSeriesCount, 3);
  assert.equal(locationLineage.observations.length, 19, "lineage must include only 18 complete-series stock rows and the scored OTA row");
  assert.equal(locationLineage.signals.length, INSIGHTS_SIGNAL_KINDS.length, "lineage must retain one latest signal per required kind");
  assert.equal(locationObservationIds.includes(ancientIrrelevantObservation.observationId), false, "irrelevant ancient observations must not enter evidence lineage");
  assert.equal(locationSignalIds.includes(ancientDuplicateSignal.signalId), false, "superseded ancient signals must not enter evidence lineage");
  assert.ok(firstSignals.signals.every((row) => locationSignalIds.includes(row.signalId)));

  const staleOtaObservations = readyObservations.map((row) => (
    row.kind === "ota.exposure" ? { ...row, observedAt: "2026-07-27T00:00:00.000Z" } : row
  ));
  const staleOtaAnalysis = deriveLocationAnalysis({
    observations: staleOtaObservations,
    signals: firstSignals.signals,
    asOf: caseFixture.asOf,
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(staleOtaAnalysis.forecast.state, "ready", "fresh complete leadtime remains independently ready");
  assert.equal(staleOtaAnalysis.state, "insufficient-data");
  assert.equal(staleOtaAnalysis.dimensions.find((row) => row.key === "ota").score, null);
  assert.equal(staleOtaAnalysis.readiness.freshness.observations, "stale");
  assert.equal(staleOtaAnalysis.readiness.nextCollectionCta.kind, "collect-ota");

  const partialSignalAnalysis = deriveLocationAnalysis({
    observations: readyObservations,
    signals: firstSignals.signals.slice(0, -1),
    asOf: caseFixture.asOf,
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(partialSignalAnalysis.state, "insufficient-data");
  assert.equal(partialSignalAnalysis.readiness.freshness.signals, "missing");
  assert.equal(partialSignalAnalysis.readiness.freshness.presentSignalKinds, INSIGHTS_SIGNAL_KINDS.length - 1);
  assert.equal(partialSignalAnalysis.dimensions.find((row) => row.key === "accessibility").score, null);
  const staleSignals = firstSignals.signals.map((row, index) => (
    index === 0 ? { ...row, observedAt: "2026-07-21T00:00:00.000Z" } : row
  ));
  const staleSignalAnalysis = deriveLocationAnalysis({
    observations: readyObservations,
    signals: staleSignals,
    asOf: caseFixture.asOf,
    forecastMonth: readyCase.reportMonth
  });
  assert.equal(staleSignalAnalysis.state, "insufficient-data");
  assert.equal(staleSignalAnalysis.readiness.freshness.signals, "stale");
  assert.equal(staleSignalAnalysis.dimensions.find((row) => row.key === "tourism").score, null);
  assert.equal(staleSignalAnalysis.readiness.nextCollectionCta.kind, "collect-signals");

  const companyRows = [
    cohortCompany("cmp_place_stage229_tenant"),
    cohortCompany("cmp_place_stage229_cohort_a"),
    cohortCompany("cmp_place_stage229_cohort_b"),
    cohortCompany("cmp_place_stage229_cohort_c")
  ];
  companyRows[1].observations.push({
    observationId: "obs_stage229_peer_ancient_irrelevant",
    companyId: "cmp_place_stage229_cohort_a",
    kind: "quick.profile",
    observedAt: "2025-01-01T00:00:00.000Z",
    value: true,
    synthetic: true
  });
  const scopes = deriveReportScopes("cmp_place_stage229_tenant", companyRows, { asOf: caseFixture.asOf });
  assert.deepEqual(scopes.map((row) => row.scope), readyCase.expected.requiredReportScopes);
  assert.ok(scopes.every((row) => row.state === "ready"));
  assert.equal(scopes.find((row) => row.scope === "own").minimumSampleCount, 1);
  assert.ok(scopes.filter((row) => row.anonymous).every((row) => row.minimumSampleCount === 3));
  assert.equal(scopes.find((row) => row.scope === "anonymous-cohort").sampleCount, 3, "the tenant's own lodge must not count toward k=3 peers");
  assert.equal(scopes.find((row) => row.scope === "own").metrics.soldRate, 70, "repeated D14/D7/D1 observations must use the latest product/stay stock pair");
  assert.doesNotMatch(JSON.stringify(scopes), /cmp_place_stage229_cohort_/);
  const reportLineage = selectReportEvidence("cmp_place_stage229_tenant", companyRows, { asOf: caseFixture.asOf });
  const reportObservationIds = new Set(reportLineage.observations.map((row) => row.observationId));
  const expectedPeerMetricIds = companyRows.slice(1).flatMap((entry) => (
    entry.observations.filter((row) => [
      "product.total-stock", "product.available-stock", "product.price", "ota.exposure"
    ].includes(row.kind)).map((row) => row.observationId)
  ));
  assert.ok(expectedPeerMetricIds.every((id) => reportObservationIds.has(id)), "report evidence must include exact metric rows from every eligible peer");
  assert.equal(reportObservationIds.has("obs_stage229_peer_ancient_irrelevant"), false, "ancient irrelevant peer IDs must not enter report evidence");
  assert.deepEqual(reportLineage.scopeCompanyIds.anonymousCohort, [
    "cmp_place_stage229_cohort_a",
    "cmp_place_stage229_cohort_b",
    "cmp_place_stage229_cohort_c"
  ]);
  assert.match(reportLineage.cohortSnapshotHash, /^[a-f0-9]{64}$/);
  assert.equal(
    selectReportEvidence("cmp_place_stage229_tenant", companyRows, { asOf: caseFixture.asOf }).cohortSnapshotHash,
    reportLineage.cohortSnapshotHash,
    "identical report inputs must produce a deterministic cohort snapshot hash"
  );

  const stalePeerRows = structuredClone(companyRows);
  stalePeerRows.at(-1).observations = stalePeerRows.at(-1).observations.map((row) => ({
    ...row,
    observedAt: "2026-07-27T00:00:00.000Z"
  }));
  const stalePeerScopes = deriveReportScopes("cmp_place_stage229_tenant", stalePeerRows, { asOf: caseFixture.asOf });
  assert.equal(stalePeerScopes.find((row) => row.scope === "national").sampleCount, 3, "stale peers must not count toward anonymous aggregates");
  assert.equal(stalePeerScopes.find((row) => row.scope === "region").sampleCount, 3);
  assert.equal(stalePeerScopes.find((row) => row.scope === "anonymous-cohort").sampleCount, 2);
  assert.equal(stalePeerScopes.find((row) => row.scope === "anonymous-cohort").state, "insufficient-data");
  const stalePeerLineage = selectReportEvidence("cmp_place_stage229_tenant", stalePeerRows, { asOf: caseFixture.asOf });
  assert.equal(stalePeerLineage.companyIds.includes("cmp_place_stage229_cohort_c"), false);
  assert.equal(stalePeerLineage.observations.some((row) => row.companyId === "cmp_place_stage229_cohort_c"), false);

  const tooSmall = deriveReportScopes("cmp_place_stage229_tenant", companyRows.slice(0, 3), { asOf: caseFixture.asOf });
  assert.equal(tooSmall.find((row) => row.scope === "own").state, "ready");
  assert.equal(tooSmall.find((row) => row.scope === "anonymous-cohort").state, "insufficient-data");
  const emptyOwn = {
    company: {
      companyId: "cmp_place_stage229_empty",
      region: "Stage 229 합성 지역",
      category: "glamping"
    },
    observations: []
  };
  const emptyScopes = deriveReportScopes("cmp_place_stage229_empty", [emptyOwn, ...companyRows.slice(1)], { asOf: caseFixture.asOf });
  assert.equal(emptyScopes.find((row) => row.scope === "own").sampleCount, 0);
  assert.equal(emptyScopes.find((row) => row.scope === "own").state, "insufficient-data");
  assert.equal(emptyScopes.find((row) => row.scope === "national").sampleCount, 3, "an empty company must not count toward anonymous aggregate k");
  assert.equal(emptyScopes.find((row) => row.scope === "anonymous-cohort").state, "insufficient-data");

  const repeatedCompany = cohortCompany("cmp_place_stage229_repeated");
  repeatedCompany.observations.push(
    {
      companyId: repeatedCompany.company.companyId,
      productKey: "standard",
      targetDate: "2026-06-30",
      observedAt: "2026-06-01T00:00:00.000Z",
      kind: "product.total-stock",
      value: 100,
      synthetic: true
    },
    {
      companyId: repeatedCompany.company.companyId,
      productKey: "standard",
      targetDate: "2026-06-30",
      observedAt: "2026-06-01T00:00:00.000Z",
      kind: "product.price",
      value: 300000,
      synthetic: true
    },
    {
      companyId: repeatedCompany.company.companyId,
      productKey: "standard",
      targetDate: "2026-06-30",
      channel: "fixture-ota",
      observedAt: "2026-06-01T00:00:00.000Z",
      kind: "ota.exposure",
      value: false,
      synthetic: true
    }
  );
  const repeatedDescriptor = deriveCohortDescriptor(repeatedCompany.company, repeatedCompany.observations);
  assert.equal(repeatedDescriptor.sizeBand, "medium", "older repeated total-stock must not inflate the latest company size band");
  assert.equal(repeatedDescriptor.priceBand, "standard", "older repeated price must not change the latest price band");
  assert.equal(repeatedDescriptor.otaBand, "low", "older repeated OTA rows must not add exposure channels");

  assert.deepEqual(allowedActionsForLifecycle("requested"), ["create-draft"]);
  assert.deepEqual(allowedActionsForLifecycle("published"), []);
  for (const [from, to] of [
    ["requested", "draft"],
    ["draft", "in-review"],
    ["in-review", "changes-requested"],
    ["changes-requested", "draft"],
    ["in-review", "reviewed"],
    ["reviewed", "published"]
  ]) {
    assert.equal(assertLifecycleTransition(from, to), true, `${from} -> ${to}`);
  }
  assert.throws(
    () => assertLifecycleTransition("requested", "published"),
    (error) => code(error) === "INSIGHTS_LIFECYCLE_INVALID" && error.statusCode === 409
  );
  assert.throws(
    () => assertLifecycleTransition("published", "draft"),
    (error) => code(error) === "INSIGHTS_LIFECYCLE_INVALID"
  );

  console.log("Stage 229 contracts, deterministic fixture, cold-start, cohort, forecast and lifecycle checks passed");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
