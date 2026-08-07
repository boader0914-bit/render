"use strict";

const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_SERVICE_ID,
  V2_ENV_WORKER_STRATEGY
} = require("./v2_env_worker_contract.cjs");

const V2_ENV_WORKER_STATUS_PATH = "/api/admin/collection-worker/v2-env-canary/status";

const PRESERVED_PREVIEW_ENDPOINTS = Object.freeze([
  "POST /api/crawl-estimate",
  "POST /api/crawl",
  "GET /api/crawl-status",
  "POST /api/crawl/cancel",
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/member/runs/:id"
]);

function projectV2EnvWorkerStatus(orchestratorStatus = {}) {
  return Object.freeze({
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    targetServiceId: V2_ENV_WORKER_SERVICE_ID,
    targetCommit: /^[a-f0-9]{40}$/u.test(String(orchestratorStatus.targetWorkerCommit || ""))
      ? orchestratorStatus.targetWorkerCommit
      : null,
    enabled: orchestratorStatus.enabled === true,
    actualCallsEnabled: false,
    externalCallApproved: false,
    saveResult: false,
    maxProviderAttempts: 1,
    executedCallCount: 0,
    automaticRetry: false,
    automaticFallback: false,
    blocker: orchestratorStatus.enabled === true ? "one_shot_internal_dispatch_required" : "worker_canary_disabled"
  });
}

module.exports = {
  PRESERVED_PREVIEW_ENDPOINTS,
  V2_ENV_WORKER_STATUS_PATH,
  projectV2EnvWorkerStatus
};
