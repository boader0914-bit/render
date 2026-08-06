"use strict";

const {
  FIXED_V2_WORKER_RUNTIME_FINGERPRINT
} = require("./collection_worker_contract.cjs");

const COLLECTION_WORKER_RELEASE_PLAN_VERSION = "collector-worker-disabled-release.v1";
const COLLECTION_WORKER_SERVICE_TYPE = "background_worker";
const COLLECTION_WORKER_REGION = "singapore";
const COLLECTION_WORKER_START_COMMAND = "npm run start:collector-worker";

function buildDisabledCollectorWorkerReleasePlan(input = {}) {
  const repository = String(input.repository || "boader0914-bit/render").trim();
  const branch = String(input.branch || "preview/v2-development").trim();
  const sourceCommit = String(input.sourceCommit || "").trim();
  if (!repository || !branch || !/^[a-f0-9]{40}$/u.test(sourceCommit)) {
    throw new TypeError("collector worker release source is invalid");
  }
  return Object.freeze({
    planVersion: COLLECTION_WORKER_RELEASE_PLAN_VERSION,
    serviceType: COLLECTION_WORKER_SERVICE_TYPE,
    region: COLLECTION_WORKER_REGION,
    runtime: "node",
    nodeVersion: FIXED_V2_WORKER_RUNTIME_FINGERPRINT.node,
    repository,
    branch,
    sourceCommit,
    buildCommand: "npm ci --omit=dev",
    startCommand: COLLECTION_WORKER_START_COMMAND,
    autoDeploy: false,
    persistentDisk: false,
    cronSchedule: null,
    externalIngress: false,
    executionModel: "worker_pull",
    workerMode: "disabled",
    externalCallsEnabled: false,
    resultWriteEnabled: false,
    automaticRetry: false,
    automaticFallback: false,
    maxProviderAttempts: 0,
    authorizedCallCount: 0,
    executedCallCount: 0,
    blocker: "synthetic_artifact_validation_required"
  });
}

module.exports = {
  COLLECTION_WORKER_REGION,
  COLLECTION_WORKER_RELEASE_PLAN_VERSION,
  COLLECTION_WORKER_SERVICE_TYPE,
  COLLECTION_WORKER_START_COMMAND,
  buildDisabledCollectorWorkerReleasePlan
};
