"use strict";

const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");

const V2_ENV_WORKER_SCHEMA_VERSION = "v2-env-worker-contract.v1";
const V2_ENV_WORKER_STRATEGY = "v2_env_4e4e190_worker";
const V2_ENV_WORKER_PHASE = "naver_place_first_request_only";
const V2_ENV_WORKER_COLLECTOR_SCOPE = "main_place_first_request_no_store";
const V2_ENV_WORKER_SERVICE_ID = "srv-d9q6mrfavr4c73atllf0";
const V2_ENV_WORKER_SERVICE_NAME = "lodging-datalab-collector-preview";
const V2_ENV_WORKER_REGION = "singapore";
const V2_ENV_WORKER_SOURCE_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const V2_ENV_WORKER_SOURCE_SERVICE_ID = "srv-d8rjrmojs32c73c4tmhg";
const V2_ENV_WORKER_SOURCE_DEPLOY_ID = "dep-d9atqu5ckfvc73bubmgg";
const V2_ENV_WORKER_SOURCE_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const V2_ENV_WORKER_BUILD_COMMAND = "npm install";
const V2_ENV_WORKER_START_COMMAND = "npm run start:collector-worker";
const V2_ENV_WORKER_NPM_VERSION = "11.17.0";

const FIXED_NO_STORE_POLICY = Object.freeze({
  strategy: V2_ENV_WORKER_STRATEGY,
  phase: V2_ENV_WORKER_PHASE,
  collectorScope: V2_ENV_WORKER_COLLECTOR_SCOPE,
  saveResult: false,
  maxProviderAttempts: 1,
  concurrency: 1,
  automaticRetry: false,
  automaticFallback: false,
  detailCollection: false,
  bookingCollection: false,
  revenueCalculation: false,
  runManifestWrite: false,
  workbookWrite: false,
  companyWrite: false,
  productWrite: false,
  historyWrite: false,
  publicationWrite: false,
  regionInsightWrite: false,
  externalCallOnRead: false
});

function contractError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false });
}

function exactRuntimeFingerprint(value = {}) {
  const expected = FIXED_V2_WORKER_RUNTIME_FINGERPRINT;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
    || expectedKeys.some((key) => String(value[key]) !== String(expected[key]))
  ) {
    throw contractError("V2_ENV_WORKER_RUNTIME_MISMATCH", "V2 environment Worker runtime does not match the verified V2 runtime", 409);
  }
  return Object.freeze({ ...expected });
}

function assertV2EnvWorkerReleaseEnvironment(value = {}) {
  if (
    value.serviceId !== V2_ENV_WORKER_SERVICE_ID
    || String(value.region || "").toLowerCase() !== V2_ENV_WORKER_REGION
    || value.buildCommand !== V2_ENV_WORKER_BUILD_COMMAND
    || value.startCommand !== V2_ENV_WORKER_START_COMMAND
    || String(value.npmVersion || "") !== V2_ENV_WORKER_NPM_VERSION
  ) {
    throw contractError("V2_ENV_WORKER_RELEASE_MISMATCH", "V2 environment Worker release settings do not match the verified V2 execution environment", 409);
  }
  exactRuntimeFingerprint(value.runtimeFingerprint);
  return Object.freeze({
    schemaVersion: V2_ENV_WORKER_SCHEMA_VERSION,
    serviceId: V2_ENV_WORKER_SERVICE_ID,
    serviceName: V2_ENV_WORKER_SERVICE_NAME,
    region: V2_ENV_WORKER_REGION,
    buildCommand: V2_ENV_WORKER_BUILD_COMMAND,
    startCommand: V2_ENV_WORKER_START_COMMAND,
    npmVersion: V2_ENV_WORKER_NPM_VERSION,
    runtimeFingerprint: FIXED_V2_WORKER_RUNTIME_FINGERPRINT,
    sourceCommit: V2_ENV_WORKER_SOURCE_COMMIT,
    sourceServiceId: V2_ENV_WORKER_SOURCE_SERVICE_ID,
    sourceDeployId: V2_ENV_WORKER_SOURCE_DEPLOY_ID,
    sourceCollectorBlob: V2_ENV_WORKER_SOURCE_COLLECTOR_BLOB
  });
}

function buildV2EnvWorkerNoStorePlan(input = {}) {
  for (const [key, expected] of Object.entries(FIXED_NO_STORE_POLICY)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== expected) {
      throw contractError("V2_ENV_WORKER_CANARY_CONTRACT_INVALID", `V2 environment Worker fixed field ${key} cannot be overridden`);
    }
  }
  const targetCommit = String(input.targetCommit || "").trim();
  if (targetCommit && !/^[a-f0-9]{40}$/u.test(targetCommit)) {
    throw contractError("V2_ENV_WORKER_CANARY_CONTRACT_INVALID", "V2 environment Worker target commit is invalid");
  }
  const enabled = input.enabled === true;
  const externalCallApproved = input.externalCallApproved === true;
  const oneShotApprovalPresent = input.oneShotApprovalPresent === true;
  const actualCallsEnabled = enabled && externalCallApproved && oneShotApprovalPresent;
  return Object.freeze({
    schemaVersion: V2_ENV_WORKER_SCHEMA_VERSION,
    ...FIXED_NO_STORE_POLICY,
    targetServiceId: V2_ENV_WORKER_SERVICE_ID,
    targetCommit: targetCommit || null,
    enabled,
    externalCallApproved,
    oneShotApprovalPresent,
    actualCallsEnabled,
    authorizedCallCount: actualCallsEnabled ? 1 : 0,
    executedCallCount: 0,
    blocker: !enabled
      ? "worker_canary_disabled"
      : (!externalCallApproved
          ? "external_call_approval_required"
          : (!oneShotApprovalPresent ? "one_shot_approval_required" : null))
  });
}

function assertV2EnvWorkerNoStorePlan(plan) {
  for (const [key, expected] of Object.entries(FIXED_NO_STORE_POLICY)) {
    if (plan?.[key] !== expected) {
      throw contractError("V2_ENV_WORKER_CANARY_CONTRACT_INVALID", "V2 environment Worker no-store policy is invalid");
    }
  }
  if (plan.targetServiceId !== V2_ENV_WORKER_SERVICE_ID || ![0, 1].includes(Number(plan.authorizedCallCount))) {
    throw contractError("V2_ENV_WORKER_CANARY_CONTRACT_INVALID", "V2 environment Worker authorization is invalid");
  }
  return plan;
}

module.exports = {
  FIXED_NO_STORE_POLICY,
  V2_ENV_WORKER_BUILD_COMMAND,
  V2_ENV_WORKER_COLLECTOR_SCOPE,
  V2_ENV_WORKER_NPM_VERSION,
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_REGION,
  V2_ENV_WORKER_SCHEMA_VERSION,
  V2_ENV_WORKER_SERVICE_ID,
  V2_ENV_WORKER_SERVICE_NAME,
  V2_ENV_WORKER_SOURCE_COLLECTOR_BLOB,
  V2_ENV_WORKER_SOURCE_COMMIT,
  V2_ENV_WORKER_SOURCE_DEPLOY_ID,
  V2_ENV_WORKER_SOURCE_SERVICE_ID,
  V2_ENV_WORKER_START_COMMAND,
  V2_ENV_WORKER_STRATEGY,
  assertV2EnvWorkerNoStorePlan,
  assertV2EnvWorkerReleaseEnvironment,
  buildV2EnvWorkerNoStorePlan,
  exactRuntimeFingerprint
};
