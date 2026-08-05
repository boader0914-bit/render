"use strict";

const crypto = require("node:crypto");

const NAVER_LEGACY_CANARY_ENV_NAME = "NAVER_LEGACY_CANARY_ENABLED";
const NAVER_LEGACY_CANARY_PLAN_VERSION = "naver-legacy-preview-canary.v1";
const NAVER_LEGACY_CANARY_SCOPE = "main_place_only";
const NAVER_LEGACY_CANARY_PHASE = "naver_place_rank_main";
const NAVER_LEGACY_CANARY_STRATEGY = "legacy_candidate";
const NAVER_LEGACY_CANARY_STRATEGY_VERSION = "legacy-candidate.4e4e190.v1";

const FIXED_CANARY_PLAN = Object.freeze({
  planVersion: NAVER_LEGACY_CANARY_PLAN_VERSION,
  strategy: NAVER_LEGACY_CANARY_STRATEGY,
  strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
  phase: NAVER_LEGACY_CANARY_PHASE,
  collectorScope: NAVER_LEGACY_CANARY_SCOPE,
  display: 50,
  rankStart: 1,
  rankEnd: 50,
  maxProviderAttempts: 1,
  concurrency: 1,
  automaticRetry: false,
  automaticFallback: false,
  saveResult: false,
  externalCallOnRead: false,
  defaultEnabled: false,
  recentReuseEnabled: false,
  sharedReuseEnabled: false,
  completedReuseEnabled: false,
  fallbackSuccessAllowed: false,
  outputWriteApproved: false,
  manifestWriteApproved: false,
  snapshotWriteApproved: false,
  historyWriteApproved: false
});

class NaverLegacyCanaryError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "NaverLegacyCanaryError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function canaryError(code, message, statusCode = 409) {
  return new NaverLegacyCanaryError(code, message, statusCode);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function nonNegativeInteger(value, fieldName) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0 || number > 1) {
    throw canaryError("NAVER_LEGACY_CANARY_STATE_INVALID", `${fieldName} is invalid`);
  }
  return number;
}

function assertFixedCanaryOverrides(input = {}) {
  for (const [key, expected] of Object.entries(FIXED_CANARY_PLAN)) {
    if (input[key] !== undefined && input[key] !== expected) {
      throw canaryError(
        "NAVER_LEGACY_CANARY_CONTRACT_INVALID",
        `NAVER legacy canary fixed field ${key} cannot be overridden`,
        400
      );
    }
  }
}

function buildNaverLegacyCanaryPlan(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw canaryError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", "NAVER legacy canary plan is invalid", 400);
  }
  assertFixedCanaryOverrides(input);
  const releaseEnabled = input.releaseEnabled === true;
  const externalCallApproved = input.externalCallApproved === true;
  const oneShotApprovalPresent = input.oneShotApprovalPresent === true;
  const actualCallsEnabled = releaseEnabled && externalCallApproved && oneShotApprovalPresent;
  const blocker = !releaseEnabled
    ? "feature_gate_disabled"
    : (!externalCallApproved
        ? "external_call_approval_required"
        : (!oneShotApprovalPresent ? "one_shot_approval_required" : null));
  return deepFreeze({
    ...FIXED_CANARY_PLAN,
    enabled: releaseEnabled,
    actualCallsEnabled,
    externalCallApproved,
    providerHealthWriteApproved: input.providerHealthWriteApproved === true,
    resultWriteApproved: false,
    authorizedCallCount: nonNegativeInteger(input.authorizedCallCount, "authorizedCallCount"),
    executedCallCount: nonNegativeInteger(input.executedCallCount, "executedCallCount"),
    blocker
  });
}

function projectNaverLegacyCanaryStatus(plan = buildNaverLegacyCanaryPlan()) {
  return deepFreeze({
    strategy: plan.strategy,
    phase: plan.phase,
    collectorScope: plan.collectorScope,
    enabled: plan.enabled === true,
    actualCallsEnabled: plan.actualCallsEnabled === true,
    externalCallApproved: plan.externalCallApproved === true,
    providerHealthWriteApproved: plan.providerHealthWriteApproved === true,
    resultWriteApproved: false,
    maxProviderAttempts: plan.maxProviderAttempts,
    authorizedCallCount: nonNegativeInteger(plan.authorizedCallCount, "authorizedCallCount"),
    executedCallCount: nonNegativeInteger(plan.executedCallCount, "executedCallCount"),
    blocker: plan.blocker || null,
    planVersion: plan.planVersion
  });
}

function buildCanaryExecutionIdentity(collectorPlan = {}) {
  const required = [
    "strategyVersion",
    "queryPlanVersion",
    "parserVersion",
    "rankingContractVersion",
    "contractHash",
    "executionIdentityHash"
  ];
  if (collectorPlan.strategy !== NAVER_LEGACY_CANARY_STRATEGY) {
    throw canaryError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", "NAVER legacy canary strategy is invalid", 400);
  }
  for (const key of required) {
    if (!String(collectorPlan[key] || "").trim()) {
      throw canaryError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", `NAVER legacy canary ${key} is missing`, 400);
    }
  }
  return stableHash({
    collectorStrategy: collectorPlan.strategy,
    strategyVersion: collectorPlan.strategyVersion,
    queryPlanVersion: collectorPlan.queryPlanVersion,
    parserVersion: collectorPlan.parserVersion,
    rankingContractVersion: collectorPlan.rankingContractVersion,
    collectorScope: NAVER_LEGACY_CANARY_SCOPE,
    collectorContractHash: collectorPlan.contractHash,
    collectorExecutionIdentityHash: collectorPlan.executionIdentityHash
  });
}

function assertNoStoreCanaryPlan(plan) {
  if (
    plan.strategy !== NAVER_LEGACY_CANARY_STRATEGY
    || plan.collectorScope !== NAVER_LEGACY_CANARY_SCOPE
    || plan.maxProviderAttempts !== 1
    || plan.concurrency !== 1
    || plan.automaticRetry !== false
    || plan.automaticFallback !== false
    || plan.saveResult !== false
    || plan.externalCallOnRead !== false
    || plan.resultWriteApproved !== false
    || plan.outputWriteApproved !== false
    || plan.manifestWriteApproved !== false
    || plan.snapshotWriteApproved !== false
    || plan.historyWriteApproved !== false
    || plan.recentReuseEnabled !== false
    || plan.sharedReuseEnabled !== false
    || plan.completedReuseEnabled !== false
    || plan.fallbackSuccessAllowed !== false
  ) {
    throw canaryError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", "NAVER legacy canary no-store contract is invalid", 400);
  }
  return plan;
}

module.exports = {
  FIXED_CANARY_PLAN,
  NAVER_LEGACY_CANARY_ENV_NAME,
  NAVER_LEGACY_CANARY_PHASE,
  NAVER_LEGACY_CANARY_PLAN_VERSION,
  NAVER_LEGACY_CANARY_SCOPE,
  NAVER_LEGACY_CANARY_STRATEGY,
  NAVER_LEGACY_CANARY_STRATEGY_VERSION,
  NaverLegacyCanaryError,
  assertNoStoreCanaryPlan,
  buildCanaryExecutionIdentity,
  buildNaverLegacyCanaryPlan,
  canaryError,
  projectNaverLegacyCanaryStatus
};
