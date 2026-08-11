"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  buildV2CollectorExecutionMetadata,
} = require("./v2_collector_execution_metadata.cjs");

const guard = installFixtureNetworkGuard({ label: "V2 collector metadata separation" });
try {
  const legacyQuery = buildV2CollectorExecutionMetadata({
    collectorArchitecture: "v2_collector_single_source",
    collectorBackend: "v2_collector_worker",
    collectorEntryPoint: "gyeongnam_glamping_crawl",
    naverSearchStrategy: "legacy_candidate",
    rawCollectorStrategy: "legacy_candidate",
    automaticRetry: false,
    automaticFallback: false,
  });
  assert.deepEqual(legacyQuery, {
    collectorArchitecture: "v2_collector_single_source",
    collectorBackend: "v2_collector_worker",
    collectorEntryPoint: "gyeongnam_glamping_crawl",
    naverSearchStrategy: "legacy_candidate",
    legacyFrozenUsed: false,
    fallbackUsed: false,
    probeUsed: false,
    automaticRetry: false,
    automaticFallback: false,
  });

  const currentQuery = buildV2CollectorExecutionMetadata({
    collectorArchitecture: "v2_collector_single_source",
    naverSearchStrategy: "current",
  });
  assert.equal(currentQuery.naverSearchStrategy, "current");
  assert.equal(currentQuery.legacyFrozenUsed, false);
  assert.equal(guard.blockedAttempts(), 0);
  console.log("V2 collector metadata separation fixtures passed");
} finally {
  guard.restore();
}
