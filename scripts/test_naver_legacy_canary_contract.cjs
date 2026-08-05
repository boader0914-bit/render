"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  FIXED_CANARY_PLAN,
  NAVER_LEGACY_CANARY_ENV_NAME,
  NAVER_LEGACY_CANARY_PLAN_VERSION,
  assertNoStoreCanaryPlan,
  buildCanaryExecutionIdentity,
  buildNaverLegacyCanaryPlan,
  projectNaverLegacyCanaryStatus
} = require("./naver_legacy_canary_contract.cjs");

const ROOT = path.resolve(__dirname, "..");

const disabled = buildNaverLegacyCanaryPlan();
assert.equal(disabled.strategy, "legacy_candidate");
assert.equal(disabled.phase, "naver_place_rank_main");
assert.equal(disabled.collectorScope, "main_place_only");
assert.equal(disabled.display, 50);
assert.equal(disabled.rankStart, 1);
assert.equal(disabled.rankEnd, 50);
assert.equal(disabled.maxProviderAttempts, 1);
assert.equal(disabled.concurrency, 1);
assert.equal(disabled.automaticRetry, false);
assert.equal(disabled.automaticFallback, false);
assert.equal(disabled.saveResult, false);
assert.equal(disabled.externalCallOnRead, false);
assert.equal(disabled.defaultEnabled, false);
assert.equal(disabled.enabled, false);
assert.equal(disabled.actualCallsEnabled, false);
assert.equal(disabled.externalCallApproved, false);
assert.equal(disabled.providerHealthWriteApproved, false);
assert.equal(disabled.resultWriteApproved, false);
assert.equal(disabled.authorizedCallCount, 0);
assert.equal(disabled.executedCallCount, 0);
assert.equal(disabled.blocker, "feature_gate_disabled");
assert.equal(disabled.planVersion, NAVER_LEGACY_CANARY_PLAN_VERSION);
assert.equal(NAVER_LEGACY_CANARY_ENV_NAME, "NAVER_LEGACY_CANARY_ENABLED");
assert.equal(Object.isFrozen(disabled), true);
assert.equal(assertNoStoreCanaryPlan(disabled), disabled);

const gateOnly = buildNaverLegacyCanaryPlan({ releaseEnabled: true });
assert.equal(gateOnly.enabled, true);
assert.equal(gateOnly.actualCallsEnabled, false, "feature gate alone must not enable calls");
assert.equal(gateOnly.blocker, "external_call_approval_required");

const approvalWithoutOneShot = buildNaverLegacyCanaryPlan({
  releaseEnabled: true,
  externalCallApproved: true
});
assert.equal(approvalWithoutOneShot.actualCallsEnabled, false);
assert.equal(approvalWithoutOneShot.blocker, "one_shot_approval_required");

assert.throws(
  () => buildNaverLegacyCanaryPlan({ saveResult: true }),
  (error) => error.code === "NAVER_LEGACY_CANARY_CONTRACT_INVALID"
);
assert.throws(
  () => buildNaverLegacyCanaryPlan({ maxProviderAttempts: 2 }),
  (error) => error.code === "NAVER_LEGACY_CANARY_CONTRACT_INVALID"
);

const status = projectNaverLegacyCanaryStatus(disabled);
assert.deepEqual(Object.keys(status), [
  "strategy",
  "phase",
  "collectorScope",
  "enabled",
  "actualCallsEnabled",
  "externalCallApproved",
  "providerHealthWriteApproved",
  "resultWriteApproved",
  "maxProviderAttempts",
  "authorizedCallCount",
  "executedCallCount",
  "blocker",
  "planVersion"
]);
assert.equal(Object.isFrozen(status), true);

const collectorPlan = Object.freeze({
  strategy: "legacy_candidate",
  strategyVersion: "legacy-candidate.4e4e190.v1",
  queryPlanVersion: "legacy-4e4e190-main-place.v1",
  parserVersion: "apollo-safe-parser.v1",
  rankingContractVersion: "naver-place-rank-legacy-exact50.v2",
  contractHash: "a".repeat(64),
  executionIdentityHash: "b".repeat(64)
});
const identity = buildCanaryExecutionIdentity(collectorPlan);
assert.match(identity, /^[a-f0-9]{64}$/u);
assert.notEqual(
  identity,
  buildCanaryExecutionIdentity({ ...collectorPlan, queryPlanVersion: "legacy-4e4e190-main-place.v2" })
);

for (const file of ["naver_legacy_canary_contract.cjs", "naver_legacy_canary_runner.cjs"]) {
  const source = fs.readFileSync(path.join(ROOT, "scripts", file), "utf8");
  assert.doesNotMatch(source, /require\(["']node:(?:fs|child_process|http|https|net|tls)["']\)/u);
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
}
assert.doesNotMatch(JSON.stringify({ ...FIXED_CANARY_PLAN, ...status }), /keyword|cookie|authorization|rawHtml|placeId|companyName|address|https?:/iu);

console.log("NAVER legacy canary contract and disabled release gate tests passed.");
