"use strict";

const assert = require("node:assert/strict");
const { FIXED_V2_WORKER_RUNTIME_FINGERPRINT } = require("./collection_worker_contract.cjs");
const {
  V2_ENV_WORKER_BUILD_COMMAND,
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_SERVICE_ID,
  V2_ENV_WORKER_SOURCE_COLLECTOR_BLOB,
  V2_ENV_WORKER_START_COMMAND,
  V2_ENV_WORKER_STRATEGY,
  assertV2EnvWorkerNoStorePlan,
  assertV2EnvWorkerReleaseEnvironment,
  buildV2EnvWorkerNoStorePlan
} = require("./v2_env_worker_contract.cjs");

assert.equal(V2_ENV_WORKER_STRATEGY, "v2_env_4e4e190_worker");
assert.equal(V2_ENV_WORKER_PHASE, "naver_place_first_request_only");
assert.equal(V2_ENV_WORKER_SOURCE_COLLECTOR_BLOB, "bcbe229998da3afa6f31ee04375fb0766019e56f");
const disabled = assertV2EnvWorkerNoStorePlan(buildV2EnvWorkerNoStorePlan());
assert.equal(disabled.actualCallsEnabled, false);
assert.equal(disabled.authorizedCallCount, 0);
assert.equal(disabled.saveResult, false);
assert.equal(disabled.detailCollection, false);
assert.equal(disabled.bookingCollection, false);
assert.equal(disabled.revenueCalculation, false);
const active = assertV2EnvWorkerNoStorePlan(buildV2EnvWorkerNoStorePlan({
  targetCommit: "a".repeat(40), enabled: true, externalCallApproved: true, oneShotApprovalPresent: true
}));
assert.equal(active.actualCallsEnabled, true);
assert.equal(active.authorizedCallCount, 1);
assert.equal(active.maxProviderAttempts, 1);
assert.equal(active.automaticRetry, false);
assert.equal(active.automaticFallback, false);
assert.throws(() => buildV2EnvWorkerNoStorePlan({ saveResult: true }), { code: "V2_ENV_WORKER_CANARY_CONTRACT_INVALID" });
assert.throws(() => buildV2EnvWorkerNoStorePlan({ maxProviderAttempts: 2 }), { code: "V2_ENV_WORKER_CANARY_CONTRACT_INVALID" });
const release = assertV2EnvWorkerReleaseEnvironment({
  serviceId: V2_ENV_WORKER_SERVICE_ID,
  region: "singapore",
  buildCommand: V2_ENV_WORKER_BUILD_COMMAND,
  startCommand: V2_ENV_WORKER_START_COMMAND,
  npmVersion: "11.17.0",
  runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT
});
assert.deepEqual(release.runtimeFingerprint, FIXED_V2_WORKER_RUNTIME_FINGERPRINT);
console.log("V2 environment Worker contract fixture checks passed");
