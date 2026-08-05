"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");

const guard = installFixtureNetworkGuard({ label: "location collection planner fixtures" });

try {
  const {
    buildCollectionRunPlan,
    readCollectionPolicyRegistry
  } = require("./location_collection_planner.cjs");

  const registry = readCollectionPolicyRegistry();
  const canonicalRegionRegistry = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "web", "data", "location_region_registry.json"),
    "utf8"
  ));
  const regions = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];

  const readPlan = buildCollectionRunPlan({
    policyRegistry: registry,
    asOf: "2026-08-05T00:00:00.000Z",
    triggerContext: "admin_read",
    readSurface: true
  });
  assert.equal(readPlan.readBoundary, true);
  assert.equal(readPlan.actualCallsEnabled, false);
  assert.equal(readPlan.tasks.length, 0);
  assert.equal(readPlan.authorizedCallCount, 0);
  assert.equal(readPlan.executedCallCount, 0);
  assert.ok(readPlan.skipped.every((entry) => entry.reason === "external_call_on_read_forbidden"));

  const sourceVersions = Object.fromEntries(registry.policies.map((policy) => [policy.sourceId, {
    sourceSchemaVersion: `${policy.sourceId}.fixture.v1`,
    mappingVersion: "pilot-region-mapping.fixture.v1",
    configVersion: "pilot-config.fixture.v1",
    keywordGroupVersion: "keyword-group.fixture.v1",
    keywordDictionaryVersion: "keyword-dictionary.fixture.v1",
    anchorVersion: "anchor.fixture.v1",
    timeUnit: "date",
    tableContractVersion: "table-contract.fixture.v1",
    providerReleaseVersion: "release.fixture.v1"
  }]));
  const plan = buildCollectionRunPlan({
    policyRegistry: registry,
    canonicalRegionRegistry,
    regions,
    asOf: "2026-08-05T00:00:00.000Z",
    operations: Object.fromEntries(registry.policies.map((policy) => [policy.sourceId, "fixtureOperation"])),
    sourceVersions,
    rollingDaysBySource: { "naver.datalab.search_trend": 30 },
    releasePeriods: { "kosis.population.sigungu": { from: "2026-07-01", to: "2026-07-31" } }
  });

  assert.equal(plan.schemaVersion, "location-collection-run-plan.v1");
  assert.equal(plan.readBoundary, false);
  assert.equal(plan.actualCallsEnabled, false);
  assert.equal(plan.summary.sourceCount, 16);
  assert.equal(plan.summary.dueTaskCount, 31, "ten regional sources plus one shared GoCamping source must be planned");
  assert.equal(plan.summary.blockedTaskCount, 31);
  assert.equal(plan.summary.executableTaskCount, 0);
  assert.equal(plan.authorizedCallCount, 0);
  assert.equal(plan.executedCallCount, 0);
  assert.throws(() => buildCollectionRunPlan({
    policies: [registry.policies.find((policy) => policy.sourceId === "kto.tour_info.events")],
    canonicalRegionRegistry,
    regions: ["kr_gyeonggi_not_a_real_region"],
    asOf: "2026-08-05T00:00:00.000Z"
  }), /Unknown or inactive canonical regionKey/);
  assert.throws(() => buildCollectionRunPlan({
    policies: [],
    regions,
    asOf: "2026-08-05T00:00:00.000Z"
  }), /canonicalRegionRegistry is required/);
  assert.throws(() => buildCollectionRunPlan({
    policies: [registry.policies.find((policy) => policy.sourceId === "kto.gocamping.inventory")],
    canonicalRegionRegistry,
    asOf: "2026-08-05T00:00:00.000Z"
  }), /At least one active canonical regionKey is required/);

  const campingTasks = plan.tasks.filter((task) => task.sourceId === "kto.gocamping.inventory");
  assert.equal(campingTasks.length, 1, "the national GoCamping snapshot must be shared");
  assert.equal(campingTasks[0].sharedCollectionScope, "provider:kto.gocamping:national");
  assert.deepEqual(campingTasks[0].targetRegionKeys, regions);
  assert.equal(campingTasks[0].regionKey, null);

  assert.equal(plan.tasks.some((task) => task.sourceId === "mois.legal_dong.reference"), false);
  assert.equal(plan.tasks.some((task) => task.sourceId === "molit.standard_node_link.snapshot"), false);
  assert.equal(plan.tasks.some((task) => task.sourceId === "public.raw_sns.regional_mentions"), false);
  assert.equal(plan.skipped.some((entry) => entry.sourceId === "mois.legal_dong.reference" && entry.reason === "automatic_collection_forbidden"), true);
  assert.equal(plan.skipped.some((entry) => entry.sourceId === "public.booking_inventory.lead_time" && entry.reason === "source_unavailable"), true);

  for (const task of plan.tasks) {
    assert.equal(task.due, true);
    assert.equal(task.executionState, "blocked");
    assert.equal(task.actualCallsEnabled, false);
    assert.equal(task.authorizedCallCount, 0);
    assert.equal(task.executedCallCount, 0);
    assert.match(task.taskKey, /^location-collection-task:[a-f0-9]{64}$/);
    assert.match(task.blocker, /^activation_status_/);
  }

  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, /(?:serviceKey|apiKey|clientSecret|secretKey|authorization|customerId|signature|password)/i);
  assert.equal(Object.isFrozen(plan), true);
  const source = fs.readFileSync(path.join(__dirname, "location_collection_planner.cjs"), "utf8");
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.equal(guard.blockedAttempts(), 0);
  console.log(`Location collection planner fixtures passed (${plan.tasks.length} due tasks, 0 external calls)`);
} finally {
  guard.restore();
}
