"use strict";

const assert = require("node:assert/strict");
const { installFixtureNetworkGuard } = require("./fixture_network_guard.cjs");
const {
  CANARY_KEYWORD_PLACEHOLDER,
  CANARY_REGION_PLACEHOLDER,
  EXISTING_V2_FRESHNESS_ASSESSMENT,
  LEGACY_V2_COLLECTOR_BLOB,
  LEGACY_V2_DEPLOY_ID,
  LEGACY_V2_LIVE_COMMIT,
  LEGACY_V2_SERVICE_ID,
  LIMITED_PREVIEW_CANARY_PLAN,
  PREVIEW_E4_COLLECTOR_BLOB,
  buildDisabledLegacyCanaryPlan,
  validateDisabledLegacyCanaryPlan
} = require("./naver_collector_rollback_readiness.cjs");

function assertBlocked(overrides) {
  assert.throws(
    () => buildDisabledLegacyCanaryPlan(overrides),
    (error) => error && error.code === "NAVER_LEGACY_CANARY_PLAN_BLOCKED"
  );
}

function main() {
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.classification, "confirmed_fresh_collection");
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.serviceId, LEGACY_V2_SERVICE_ID);
  assert.equal(LEGACY_V2_SERVICE_ID, "srv-d8rjrmojs32c73c4tmhg");
  assert.equal(LEGACY_V2_DEPLOY_ID, "dep-d9atqu5ckfvc73bubmgg");
  assert.equal(LEGACY_V2_LIVE_COMMIT, "4e4e1906e2967fe58df66f8ad67f832043d2763b");
  assert.equal(LEGACY_V2_COLLECTOR_BLOB, "bcbe229998da3afa6f31ee04375fb0766019e56f");
  assert.equal(PREVIEW_E4_COLLECTOR_BLOB, "388cea0a5423c928e00111b750304e80598f868a");
  assert.equal(EXISTING_V2_FRESHNESS_ASSESSMENT.successWindows.length, 2);
  assert.deepEqual(EXISTING_V2_FRESHNESS_ASSESSMENT.resultSummary, {
    naverOverallCount: 50,
    naverRegionalCount: 10,
    resultFileCount: 8,
    collectionKinds: ["precision", "revenue_detail", "keyword"]
  });
  assert.doesNotMatch(JSON.stringify(EXISTING_V2_FRESHNESS_ASSESSMENT), /"run(?:Id|_id)"\s*:/i);

  const plan = buildDisabledLegacyCanaryPlan();
  assert.deepEqual(plan, LIMITED_PREVIEW_CANARY_PLAN);
  assert.equal(validateDisabledLegacyCanaryPlan(plan), true);
  assert.equal(plan.targetServiceId, "srv-d9jf91v41pts73cj9bu0");
  assert.equal(plan.targetCommit, null);
  assert.equal(plan.strategy, "legacy_candidate");
  assert.equal(plan.phase, "naver_place_rank_main");
  assert.equal(plan.scopeType, "main_place_only");
  assert.equal(plan.regionKey, CANARY_REGION_PLACEHOLDER);
  assert.equal(plan.keyword, CANARY_KEYWORD_PLACEHOLDER);
  assert.equal(plan.maxProviderAttempts, 1);
  assert.equal(plan.concurrency, 1);
  assert.equal(plan.automaticRetry, false);
  assert.equal(plan.automaticFallback, false);
  assert.equal(plan.actualCallsEnabled, false);
  assert.equal(plan.externalCallApproved, false);
  assert.equal(plan.previewWriteApproved, false);
  assert.equal(plan.authorizedCallCount, 0);
  assert.equal(plan.executedCallCount, 0);
  assert.equal(plan.saveResult, false);
  assert.equal(plan.circuitMustBeClosed, true);
  assert.equal(plan.stopOn403, true);
  assert.equal(plan.stopOn429, true);
  assert.equal(plan.stopOnChallenge, true);
  assert.equal(plan.rollbackStrategy, "current");
  assert.equal(plan.approvals.externalCallApproved, false);
  assert.equal(plan.approvals.previewWriteApproved, false);
  assert.deepEqual(plan.executionIdentity.requiredStores, []);
  assert.deepEqual(plan.executionIdentity.forbiddenStores, [
    "job_signature",
    "success_manifest",
    "history",
    "snapshot",
    "fallback_provenance"
  ]);
  assert.equal(plan.dataWrite.mode, "no_store_canary");
  assert.equal(plan.freshnessEvidence.requiredEvidence.includes("new_run_id"), false);
  assert.equal(plan.freshnessEvidence.requiredEvidence.includes("success_manifest_with_matching_execution_identity"), false);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.approvals));

  assertBlocked({ actualCallsEnabled: true });
  assertBlocked({ externalCallApproved: true });
  assertBlocked({ previewWriteApproved: true });
  assertBlocked({ authorizedCallCount: 1 });
  assertBlocked({ executedCallCount: 1 });
  assertBlocked({ saveResult: true });
  assertBlocked({ automaticRetry: true });
  assertBlocked({ automaticFallback: true });
  assertBlocked({ maxProviderAttempts: 2 });
  assertBlocked({ concurrency: 2 });
  assertBlocked({ targetCommit: "not-approved" });
  assertBlocked({ regionKey: "kr_fixture_region" });
  assertBlocked({ keyword: "synthetic query" });

  let transportCalls = 0;
  let writeCalls = 0;
  assertBlocked({ transport: () => { transportCalls += 1; } });
  assertBlocked({ writeSnapshot: () => { writeCalls += 1; } });
  assert.equal(transportCalls, 0);
  assert.equal(writeCalls, 0);

  console.log("NAVER legacy canary plan fixture tests passed.");
}

const networkGuard = installFixtureNetworkGuard({ label: "NAVER legacy canary plan fixtures" });
try {
  main();
  assert.equal(networkGuard.blockedAttempts(), 0, "canary plan fixtures must not attempt external network access");
} finally {
  networkGuard.restore();
}
