"use strict";

const assert = require("node:assert/strict");
const { FIXED_V2_WORKER_RUNTIME_FINGERPRINT } = require("./collection_worker_contract.cjs");
const { buildDisabledCollectorWorkerReleasePlan } = require("./collection_worker_release_plan.cjs");
const {
  V2_ENV_WORKER_BUILD_COMMAND, V2_ENV_WORKER_NPM_VERSION, V2_ENV_WORKER_REGION,
  V2_ENV_WORKER_SERVICE_ID, V2_ENV_WORKER_START_COMMAND, assertV2EnvWorkerReleaseEnvironment
} = require("./v2_env_worker_contract.cjs");

const plan = buildDisabledCollectorWorkerReleasePlan({ sourceCommit: "c".repeat(40) });
assert.equal(plan.region, V2_ENV_WORKER_REGION);
assert.equal(plan.buildCommand, V2_ENV_WORKER_BUILD_COMMAND);
assert.equal(plan.startCommand, V2_ENV_WORKER_START_COMMAND);
assert.equal(plan.externalCallsEnabled, false);
assert.equal(plan.resultWriteEnabled, false);
const verified = assertV2EnvWorkerReleaseEnvironment({
  serviceId: V2_ENV_WORKER_SERVICE_ID, region: V2_ENV_WORKER_REGION, buildCommand: plan.buildCommand,
  startCommand: plan.startCommand, npmVersion: V2_ENV_WORKER_NPM_VERSION,
  runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT
});
assert.equal(verified.runtimeFingerprint.node, "26.5.0");
assert.equal(verified.runtimeFingerprint.undici, "8.7.0");
assert.equal(verified.runtimeFingerprint.openssl, "3.5.7");
assert.equal(verified.runtimeFingerprint.platform, "linux");
assert.equal(verified.runtimeFingerprint.arch, "x64");
console.log("V2 environment Worker Singapore/runtime fixture checks passed");
