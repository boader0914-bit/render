"use strict";

const crypto = require("node:crypto");
const {
  computeCollectionContractHash,
  normalizeCollectionJobContract
} = require("./collection_worker_contract.cjs");
const {
  V2_ENV_WORKER_PHASE,
  V2_ENV_WORKER_STRATEGY,
  buildV2EnvWorkerNoStorePlan
} = require("./v2_env_worker_contract.cjs");

function adapterError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false });
}

function safeCircuitState(value) {
  const state = String(value?.state || "closed");
  if (!new Set(["closed", "open", "probe_allowed"]).has(state)) {
    throw adapterError("V2_ENV_WORKER_CIRCUIT_INVALID", "V2 environment Worker circuit state is invalid");
  }
  return Object.freeze({
    state,
    retryAt: typeof value?.retryAt === "string" ? value.retryAt : null
  });
}

function adaptPreviewCrawlToV2EnvWorkerCanary(input = {}, options = {}) {
  const normalizedContract = normalizeCollectionJobContract(input);
  const contractHash = computeCollectionContractHash(normalizedContract);
  const circuit = safeCircuitState(options.circuitState);
  const plan = buildV2EnvWorkerNoStorePlan({
    targetCommit: options.targetCommit,
    enabled: options.enabled === true,
    externalCallApproved: options.externalCallApproved === true,
    oneShotApprovalPresent: options.oneShotApprovalPresent === true
  });
  const circuitAllowsAttempt = circuit.state === "closed" || circuit.state === "probe_allowed";
  const jobPlanned = plan.actualCallsEnabled && circuitAllowsAttempt;
  return Object.freeze({
    schemaVersion: "v2-env-worker-job-adapter.v1",
    strategy: V2_ENV_WORKER_STRATEGY,
    phase: V2_ENV_WORKER_PHASE,
    contractHash,
    keywordHash: normalizedContract.keywordHash,
    measurementPeriod: normalizedContract.measurementPeriod,
    rankRange: Object.freeze({ start: normalizedContract.rankStart, end: normalizedContract.rankEnd }),
    jobKey: crypto.createHash("sha256").update(`${V2_ENV_WORKER_STRATEGY}\0${V2_ENV_WORKER_PHASE}\0${contractHash}`).digest("hex"),
    jobPlanned,
    maxProviderAttempts: jobPlanned ? 1 : 0,
    executedCallCount: 0,
    saveResult: false,
    automaticRetry: false,
    automaticFallback: false,
    currentPlannerUsed: false,
    top20PlannerUsed: false,
    regionCollectionUsed: false,
    blocker: !circuitAllowsAttempt ? "provider_circuit_open" : plan.blocker,
    retryAt: !circuitAllowsAttempt ? circuit.retryAt : null
  });
}

function assertPrivateExecutionContract(input = {}) {
  const normalized = normalizeCollectionJobContract(input);
  if (
    normalized.rankStart !== 1
    || normalized.rankEnd !== 50
    || normalized.searchMode !== "keyword"
  ) {
    throw adapterError("V2_ENV_WORKER_CANARY_CONTRACT_INVALID", "V2 environment Worker requires the fixed first Place request contract");
  }
  return input;
}

module.exports = {
  adaptPreviewCrawlToV2EnvWorkerCanary,
  assertPrivateExecutionContract
};
