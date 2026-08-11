"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  V2CollectorExecutionMetadataError,
  buildV2CollectorExecutionMetadata,
} = require("./v2_collector_execution_metadata.cjs");

const guard = installFixtureNetworkGuard({ label: "V2 legacy frozen classification" });
try {
  const frozen = buildV2CollectorExecutionMetadata({
    collectorBackend: "legacy_frozen",
    frozenAdapterExecuted: true,
    naverSearchStrategy: "legacy_candidate",
  });
  assert.equal(frozen.collectorArchitecture, "legacy_frozen");
  assert.equal(frozen.legacyFrozenUsed, true);

  assert.throws(() => buildV2CollectorExecutionMetadata({
    collectorArchitecture: "v2_collector_single_source",
    legacyFrozenUsed: true,
    naverSearchStrategy: "legacy_candidate",
  }), (error) => error instanceof V2CollectorExecutionMetadataError && error.code === "METADATA_INVALID");
  assert.equal(guard.blockedAttempts(), 0);
  console.log("V2 legacy frozen classification fixtures passed");
} finally {
  guard.restore();
}
