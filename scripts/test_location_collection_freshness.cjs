"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  appendCollectionSnapshot,
  buildCollectionSnapshot,
  classifySnapshotFreshness,
  createCollectionSnapshotHistory,
  parseDurationMs,
  projectLatestUsableSnapshot
} = require("./location_collection_snapshot_contract.cjs");

const networkGuard = installFixtureNetworkGuard({ label: "location collection freshness fixtures" });
const contractSource = fs.readFileSync(path.join(__dirname, "location_collection_snapshot_contract.cjs"), "utf8");

function fixtureSnapshot(overrides = {}) {
  const sourceId = "kma.asos.daily_weather";
  return buildCollectionSnapshot({
    snapshotId: "snapshot-weather-ready",
    taskKey: "task:weather:2026-08-01",
    sourceId,
    regionKey: "kr_gyeongnam_sancheong",
    sharedCollectionScope: "",
    operation: "getWthrDataList",
    measurementPeriod: { from: "2026-07-31", to: "2026-07-31" },
    overlapPeriod: { from: "2026-07-25", to: "2026-07-31" },
    collectedAt: "2026-08-01T00:00:00.000Z",
    asOf: "2026-08-01T01:00:00.000Z",
    providerPublishedAt: "2026-07-31T23:00:00.000Z",
    watermark: { lastClosedDate: "2026-07-31" },
    requestPlanVersion: "pilot-request-plan.v1",
    mappingVersion: "asos-station-crosswalk.fixture.v1",
    sourceSchemaVersion: "kma.asos.daily.v1",
    sampleCount: 7,
    coverage: { numerator: 7, denominator: 7, note: "synthetic complete weather fixture" },
    status: "ready",
    confidence: { grade: "A", score: 94 },
    penalties: [],
    supersedesSnapshotId: "",
    provenance: {
      sourceId,
      provider: "KMA",
      datasetId: "15059093",
      fixtureOnly: true,
      networkAccess: false
    },
    ...overrides
  });
}

try {
  const policy = {
    policyId: "policy.kma.asos.daily",
    staleAfter: { hours: 168 },
    freshnessPolicy: { basis: "proposal_only", freshForHours: 126, staleAfterHours: 168 }
  };
  const ready = fixtureSnapshot();

  assert.equal(parseDurationMs("P7D"), 7 * 86400000);
  assert.equal(parseDurationMs("PT24H"), 86400000);
  assert.equal(parseDurationMs({ value: 2, unit: "days" }), 2 * 86400000);
  assert.equal(parseDurationMs({ hours: 168 }), 7 * 86400000);
  assert.equal(parseDurationMs({ hours: null }), null);
  assert.equal(parseDurationMs("unverified"), null);

  const fresh = classifySnapshotFreshness(ready, policy, "2026-08-03T00:00:00.000Z");
  const aging = classifySnapshotFreshness(ready, policy, "2026-08-06T12:00:00.000Z");
  const stale = classifySnapshotFreshness(ready, policy, "2026-08-08T00:00:00.000Z");
  assert.equal(fresh.status, "fresh");
  assert.equal(fresh.reason, "within_freshness_window");
  assert.equal(aging.status, "aging");
  assert.equal(aging.reason, "stale_threshold_approaching");
  assert.equal(stale.status, "stale", "the exact staleAfter boundary is stale");
  assert.equal(stale.reason, "stale_after_exceeded");

  const unverified = classifySnapshotFreshness(ready, { staleAfter: null }, "2026-08-08T00:00:00.000Z");
  assert.equal(unverified.status, "unknown");
  assert.equal(unverified.reason, "stale_after_unverified");
  const clockSkew = classifySnapshotFreshness(ready, policy, "2026-07-31T00:00:00.000Z");
  assert.equal(clockSkew.status, "unknown");
  assert.equal(clockSkew.reason, "reference_after_as_of");
  const absent = classifySnapshotFreshness(null, policy, "2026-08-08T00:00:00.000Z");
  assert.equal(absent.status, "unknown");
  assert.equal(absent.reason, "snapshot_missing");

  const baseHistory = createCollectionSnapshotHistory({
    historyId: "history:sancheong:weather",
    sourceId: ready.sourceId,
    regionKey: ready.regionKey,
    createdAt: ready.collectedAt,
    snapshots: [ready]
  });
  const missingAttempt = fixtureSnapshot({
    snapshotId: "snapshot-weather-missing",
    taskKey: "task:weather:2026-08-02",
    measurementPeriod: { from: "2026-08-01", to: "2026-08-01" },
    overlapPeriod: { from: "2026-07-26", to: "2026-08-01" },
    collectedAt: "2026-08-02T00:00:00.000Z",
    asOf: "2026-08-02T01:00:00.000Z",
    providerPublishedAt: "",
    watermark: null,
    sampleCount: null,
    coverage: { numerator: null, denominator: null, note: "synthetic provider failure" },
    status: "missing",
    confidence: { grade: "U", score: null },
    penalties: [{ code: "provider_failure", message: "Synthetic fixture", points: null }]
  });
  const historyAfterFailure = appendCollectionSnapshot(baseHistory, missingAttempt);

  const freshFailureProjection = projectLatestUsableSnapshot(historyAfterFailure, policy, "2026-08-03T00:00:00.000Z");
  assert.equal(freshFailureProjection.latestAttemptStatus, "missing");
  assert.equal(freshFailureProjection.lastSuccessfulStatus, "ready");
  assert.equal(freshFailureProjection.servingStatus, "missing", "data quality failure remains separate from the preserved value snapshot");
  assert.equal(freshFailureProjection.staleReason, "latest_attempt_missing");
  assert.equal(freshFailureProjection.servedSnapshot.snapshotId, ready.snapshotId);
  assert.equal(freshFailureProjection.lastSuccessfulSnapshotPreserved, true);

  const staleFailureProjection = projectLatestUsableSnapshot(historyAfterFailure, policy, "2026-08-08T00:00:00.000Z");
  assert.equal(staleFailureProjection.servingStatus, "stale");
  assert.equal(staleFailureProjection.latestAttemptStatus, "missing");
  assert.equal(staleFailureProjection.lastSuccessfulStatus, "ready");
  assert.equal(staleFailureProjection.staleReason, "stale_after_exceeded");
  assert.equal(staleFailureProjection.servedSnapshot.snapshotId, ready.snapshotId, "stale state must retain the last successful snapshot");
  assert.equal(staleFailureProjection.freshnessStatus, "stale");

  const partialOnly = fixtureSnapshot({
    snapshotId: "snapshot-weather-partial-only",
    taskKey: "task:weather:partial-only",
    sampleCount: 3,
    coverage: { numerator: 3, denominator: 7, note: "synthetic partial" },
    status: "partial",
    confidence: { grade: "C", score: 55 },
    penalties: [{ code: "qc_partial", message: "Synthetic fixture", points: 25 }]
  });
  const partialOnlyHistory = createCollectionSnapshotHistory({
    historyId: "history:sancheong:weather:partial",
    sourceId: partialOnly.sourceId,
    regionKey: partialOnly.regionKey,
    createdAt: partialOnly.collectedAt,
    snapshots: [partialOnly]
  });
  const partialProjection = projectLatestUsableSnapshot(partialOnlyHistory, policy, "2026-08-03T00:00:00.000Z");
  assert.equal(partialProjection.servingStatus, "partial");
  assert.equal(partialProjection.servedSnapshot, null, "partial data must not be promoted to a successful snapshot");
  assert.equal(partialProjection.lastSuccessfulSnapshotPreserved, false);

  assert.doesNotMatch(contractSource, /\bfetch\s*\(|https?\.(?:get|request)\s*\(|\baxios\b|XMLHttpRequest|WebSocket/, "snapshot contract must contain no network execution path");
  assert.equal(networkGuard.blockedAttempts(), 0, "freshness fixtures must never call the network");
  console.log("Location collection freshness and stale preservation fixture checks passed");
} finally {
  networkGuard.restore();
}
