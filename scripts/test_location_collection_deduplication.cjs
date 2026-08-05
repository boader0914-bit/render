"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "location collection deduplication fixtures" });

try {
  const {
    buildCollectionRunPlan,
    buildCollectionTaskKey,
    deduplicateSharedTasks,
    readCollectionPolicyRegistry
  } = require("./location_collection_planner.cjs");
  const { buildCollectionSnapshot } = require("./location_collection_snapshot_contract.cjs");

  const registry = readCollectionPolicyRegistry();
  const canonicalRegionRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_region_registry.json"),
    "utf8"
  ));
  const camping = registry.policies.find((policy) => policy.sourceId === "kto.gocamping.inventory");
  const events = registry.policies.find((policy) => policy.sourceId === "kto.tour_info.events");
  const regions = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];
  const sharedContext = {
    asOf: "2026-08-05T00:00:00.000Z",
    operation: "basedList",
    sourceSchemaVersion: "gocamping.fixture.v1",
    mappingVersion: "pilot-regions.fixture.v1"
  };
  const sharedKeys = regions.map((regionKey) => buildCollectionTaskKey(camping, {
    ...sharedContext,
    regionKey
  }));
  assert.equal(new Set(sharedKeys).size, 1, "region keys must not split a provider-level shared snapshot");

  const sharedDuplicates = regions.map((regionKey) => ({
    sourceId: camping.sourceId,
    regionKey: null,
    sharedCollectionScope: camping.sharedCollectionScope,
    targetRegionKeys: [regionKey],
    taskKey: sharedKeys[0],
    actualCallsEnabled: false
  }));
  const deduplicated = deduplicateSharedTasks(sharedDuplicates);
  assert.equal(deduplicated.length, 1);
  assert.deepEqual(deduplicated[0].targetRegionKeys, [...regions].sort());

  const regionalKey = buildCollectionTaskKey(events, {
    ...sharedContext,
    regionKey: regions[0],
    operation: "searchFestival2"
  });
  const exactRegionalDuplicates = deduplicateSharedTasks([
    { sourceId: events.sourceId, regionKey: regions[0], sharedCollectionScope: null, targetRegionKeys: [regions[0]], taskKey: regionalKey },
    { sourceId: events.sourceId, regionKey: regions[0], sharedCollectionScope: null, targetRegionKeys: [regions[0]], taskKey: regionalKey }
  ]);
  assert.equal(exactRegionalDuplicates.length, 1, "the same regional taskKey must be idempotent");
  assert.notEqual(regionalKey, buildCollectionTaskKey(events, {
    ...sharedContext,
    regionKey: regions[1],
    operation: "searchFestival2"
  }), "different canonical regions must have different non-shared task keys");
  assert.throws(() => deduplicateSharedTasks([
    { sourceId: events.sourceId, regionKey: regions[0], sharedCollectionScope: null, taskKey: regionalKey },
    { sourceId: events.sourceId, regionKey: regions[1], sharedCollectionScope: null, taskKey: regionalKey }
  ]), /Conflicting non-shared collection task key/);

  const planOptions = {
    policies: [camping],
    policyVersion: registry.policyVersion,
    canonicalRegionRegistry,
    regions,
    asOf: sharedContext.asOf,
    operations: { [camping.sourceId]: sharedContext.operation },
    sourceVersions: {
      [camping.sourceId]: {
        sourceSchemaVersion: sharedContext.sourceSchemaVersion,
        mappingVersion: sharedContext.mappingVersion
      }
    }
  };
  const firstPlan = buildCollectionRunPlan(planOptions);
  assert.equal(firstPlan.tasks.length, 1);
  assert.equal(firstPlan.tasks[0].taskKey, sharedKeys[0]);
  assert.deepEqual(firstPlan.tasks[0].targetRegionKeys, regions);

  const rawCompletedKeyPlan = buildCollectionRunPlan({
    ...planOptions,
    completedTaskKeys: [firstPlan.tasks[0].taskKey]
  });
  assert.equal(rawCompletedKeyPlan.tasks.length, 1, "raw completedTaskKeys must not prove a successful snapshot");

  const invalidReady = {
    snapshotId: "invalid-ready-without-contract-fields",
    sourceId: camping.sourceId,
    sharedCollectionScope: camping.sharedCollectionScope,
    taskKey: firstPlan.tasks[0].taskKey,
    status: "ready",
    watermark: { modifiedtime: "must-not-be-trusted" }
  };
  const invalidReadyPlan = buildCollectionRunPlan({
    ...planOptions,
    lastSuccessfulSnapshot: invalidReady
  });
  assert.equal(invalidReadyPlan.tasks.length, 1, "an invalid ready object must not suppress collection");
  assert.equal(invalidReadyPlan.tasks[0].watermark, null, "an invalid ready object must not provide a watermark");

  function collectionSnapshot({ snapshotId, taskKey, status, mappingVersion, collectedAt, watermark }) {
    const observed = status === "ready" || status === "zero";
    const zero = status === "zero";
    return buildCollectionSnapshot({
      snapshotId,
      taskKey,
      sourceId: camping.sourceId,
      regionKey: null,
      sharedCollectionScope: camping.sharedCollectionScope,
      operation: sharedContext.operation,
      measurementPeriod: firstPlan.tasks[0].measurementPeriod,
      overlapPeriod: null,
      collectedAt,
      asOf: sharedContext.asOf,
      providerPublishedAt: null,
      watermark,
      requestPlanVersion: "request-plan.fixture.v1",
      mappingVersion,
      sourceSchemaVersion: sharedContext.sourceSchemaVersion,
      sampleCount: observed ? (zero ? 0 : 1) : null,
      coverage: observed
        ? { numerator: zero ? 0 : 1, denominator: 1, ratio: zero ? 0 : 1 }
        : { numerator: null, denominator: null, ratio: null },
      status,
      confidence: observed ? { grade: "A", score: 90 } : { grade: "U", score: null },
      penalties: [],
      supersedesSnapshotId: null,
      provenance: { sourceId: camping.sourceId, fixture: true }
    });
  }

  const readySnapshot = collectionSnapshot({
    snapshotId: "snapshot-gocamping-ready-fixture",
    taskKey: firstPlan.tasks[0].taskKey,
    status: "ready",
    mappingVersion: sharedContext.mappingVersion,
    collectedAt: "2026-07-27T00:00:00.000Z",
    watermark: { modifiedtime: "ready-watermark" }
  });
  const repeatedPlan = buildCollectionRunPlan({
    ...planOptions,
    lastSuccessfulSnapshots: [readySnapshot]
  });
  assert.equal(repeatedPlan.tasks.length, 0);
  assert.equal(repeatedPlan.skipped.length, 1);
  assert.equal(repeatedPlan.skipped[0].reason, "successful_snapshot_already_exists");

  const zeroSnapshot = collectionSnapshot({
    snapshotId: "snapshot-gocamping-zero-fixture",
    taskKey: firstPlan.tasks[0].taskKey,
    status: "zero",
    mappingVersion: sharedContext.mappingVersion,
    collectedAt: "2026-07-26T00:00:00.000Z",
    watermark: { modifiedtime: "zero-watermark" }
  });
  assert.equal(buildCollectionRunPlan({ ...planOptions, lastSnapshot: zeroSnapshot }).tasks.length, 0,
    "a contract-valid zero snapshot must also suppress the same task");

  const changedMappingOptions = {
    ...planOptions,
    sourceVersions: {
      [camping.sourceId]: {
        sourceSchemaVersion: sharedContext.sourceSchemaVersion,
        mappingVersion: "pilot-regions.fixture.v2"
      }
    }
  };
  const changedMappingBaseline = buildCollectionRunPlan(changedMappingOptions);
  const failedSnapshot = collectionSnapshot({
    snapshotId: "snapshot-gocamping-failure-fixture",
    taskKey: changedMappingBaseline.tasks[0].taskKey,
    status: "missing",
    mappingVersion: "pilot-regions.fixture.v2",
    collectedAt: "2026-07-28T00:00:00.000Z",
    watermark: { modifiedtime: "failure-watermark-must-not-win" }
  });
  const changedMappingPlan = buildCollectionRunPlan({
    ...changedMappingOptions,
    lastSuccessfulSnapshot: readySnapshot,
    lastFailure: failedSnapshot
  });
  assert.equal(changedMappingPlan.tasks.length, 1);
  assert.notEqual(changedMappingPlan.tasks[0].taskKey, firstPlan.tasks[0].taskKey);
  assert.deepEqual(changedMappingPlan.tasks[0].watermark, { modifiedtime: "ready-watermark" },
    "only the contract-valid ready/zero watermark may survive a later failed attempt");
  assert.notDeepEqual(changedMappingPlan.tasks[0].watermark, failedSnapshot.watermark);
  assert.equal(changedMappingPlan.tasks[0].actualCallsEnabled, false);
  assert.equal(changedMappingPlan.tasks[0].authorizedCallCount, 0);
  assert.equal(changedMappingPlan.tasks[0].executedCallCount, 0);

  assert.equal(guard.blockedAttempts(), 0);
  console.log("Location collection deduplication fixtures passed (GoCamping shared once, taskKey idempotent)");
} finally {
  guard.restore();
}
