"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  V2_TOP20_PROFILE,
  V2_TOP20_SCOPE,
} = require("./collection_worker_v2_top20_contract.cjs");
const {
  deriveV2CollectorExecutionMetadata,
  projectV2CollectorExecution,
} = require("./v2_collector_execution_metadata.cjs");

const EXISTING_RUN_ID = "preview-worker-run-18fd255cafd83249a2a1";
const guard = installFixtureNetworkGuard({ label: "existing V2 run metadata projection" });
try {
  const projected = deriveV2CollectorExecutionMetadata({
    workerRun: true,
    v2Top20Profile: true,
    v2Top20Scope: true,
    manifest: {
      runId: EXISTING_RUN_ID,
      collectorActivationProfile: V2_TOP20_PROFILE,
      collectorScope: V2_TOP20_SCOPE,
      collectorStrategy: "legacy_candidate",
      automaticRetry: false,
      automaticFallback: false,
    },
  });
  assert.equal(projected.collectorArchitecture, "v2_collector_single_source");
  assert.equal(projected.collectorBackend, "v2_collector_worker");
  assert.equal(projected.collectorEntryPoint, "gyeongnam_glamping_crawl");
  assert.equal(projected.naverSearchStrategy, "legacy_candidate");
  assert.equal(projected.legacyFrozenUsed, false);
  assert.equal(projected.fallbackUsed, false);
  assert.equal(projected.probeUsed, false);
  const apiProjection = projectV2CollectorExecution(projected);
  assert.equal(apiProjection.architecture, "v2_collector_single_source");
  assert.equal(apiProjection.backend, "v2_collector_worker");
  assert.equal(apiProjection.entryPoint, "gyeongnam_glamping_crawl");
  assert.equal(guard.blockedAttempts(), 0);
  console.log("existing V2 run strategy projection fixtures passed");
} finally {
  guard.restore();
}
