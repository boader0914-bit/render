"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  assertStoredSnapshotReadBoundary,
  validateLocationCollectionPolicyRegistry
} = require("./location_collection_policy.cjs");
const {
  buildCollectionRunPlan,
  readCollectionPolicyRegistry
} = require("./location_collection_planner.cjs");

const guard = installFixtureNetworkGuard({ label: "location collection read-boundary fixtures" });

try {
  const registry = readCollectionPolicyRegistry();
  assert.equal(validateLocationCollectionPolicyRegistry(registry), registry);
  assert.equal(assertStoredSnapshotReadBoundary(registry), true);

  const regions = [
    "kr_gyeonggi_pocheon",
    "kr_gyeongnam_sancheong",
    "kr_gyeongnam_hadong"
  ];
  for (const triggerContext of ["read", "admin_read", "member_read", "b2b_read", "screen_read", "http_read"]) {
    const plan = buildCollectionRunPlan({
      policyRegistry: registry,
      regions,
      asOf: "2026-08-05T00:00:00.000Z",
      triggerContext
    });
    assert.equal(plan.readBoundary, true, `${triggerContext} must be a stored-snapshot read boundary`);
    assert.deepEqual(plan.tasks, []);
    assert.deepEqual(plan.dueTasks, []);
    assert.equal(plan.actualCallsEnabled, false);
    assert.equal(plan.authorizedCallCount, 0);
    assert.equal(plan.executedCallCount, 0);
    assert.equal(plan.summary.dueTaskCount, 0);
    assert.equal(plan.skipped.length, registry.policies.length);
    assert.ok(plan.skipped.every((entry) => entry.reason === "external_call_on_read_forbidden"));
  }

  const readSurfacePlan = buildCollectionRunPlan({
    policyRegistry: registry,
    regions,
    asOf: "2026-08-05T00:00:00.000Z",
    readSurface: true
  });
  assert.equal(readSurfacePlan.readBoundary, true);
  assert.equal(readSurfacePlan.tasks.length, 0);

  const root = path.join(__dirname, "..");
  for (const relative of ["web/app.js", "scripts/glamping_app_server.cjs"]) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /location_collection_planner|location_api_transport/,
      `${relative} read surfaces must not import the collection planner or live transport`);
  }

  assert.equal(guard.blockedAttempts(), 0);
  console.log("Location collection read boundary fixtures passed (admin/member/B2B/UI reads: 0 external tasks)");
} finally {
  guard.restore();
}
