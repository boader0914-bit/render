"use strict";

const crypto = require("node:crypto");
const {
  MAX_PROVIDER_CALL_BUDGET,
  buildCollectorStrategyPlan,
  collectNaverPlaceSnapshot
} = require("./naver_collector_strategy.cjs");
const {
  NAVER_LEGACY_CANARY_SCOPE,
  NAVER_LEGACY_CANARY_STRATEGY,
  assertNoStoreCanaryPlan,
  buildCanaryExecutionIdentity,
  buildNaverLegacyCanaryPlan,
  canaryError,
  projectNaverLegacyCanaryStatus
} = require("./naver_legacy_canary_contract.cjs");

const APPROVAL_MAX_LIFETIME_MS = 15 * 60 * 1000;
const APPROVAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,79}$/u;

function normalizedNow(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw canaryError("NAVER_LEGACY_CANARY_STATE_INVALID", "NAVER legacy canary clock is invalid", 500);
  }
  return date;
}

function safeDiagnosticId(executionIdentityHash, startedAt) {
  return `canary-${crypto.createHash("sha256").update(`${executionIdentityHash}:${startedAt}`).digest("hex").slice(0, 16)}`;
}

function assertOneShotApproval(approval, collectorPlan, executionIdentityHash, now) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_REQUIRED", "A one-shot NAVER canary approval is required", 409);
  }
  const approvalId = String(approval.approvalId || "").trim().toLowerCase();
  if (!APPROVAL_ID_PATTERN.test(approvalId)) {
    throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_REQUIRED", "A valid one-shot NAVER canary approval is required", 409);
  }
  if (
    approval.externalCallApproved !== true
    || approval.fixtureOnly !== true
    || approval.resultWriteApproved !== false
    || approval.providerHealthWriteApproved !== false
    || approval.maxProviderAttempts !== 1
    || approval.collectorScope !== NAVER_LEGACY_CANARY_SCOPE
  ) {
    throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_REQUIRED", "The one-shot NAVER canary approval is incomplete", 409);
  }
  if (
    approval.contractHash !== collectorPlan.contractHash
    || approval.executionIdentityHash !== executionIdentityHash
  ) {
    throw canaryError("NAVER_LEGACY_CANARY_CONTRACT_MISMATCH", "The one-shot NAVER canary contract does not match", 409);
  }
  const expiresAt = new Date(approval.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now || expiresAt.getTime() - now.getTime() > APPROVAL_MAX_LIFETIME_MS) {
    throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_EXPIRED", "The one-shot NAVER canary approval has expired", 409);
  }
  return Object.freeze({ approvalId, expiresAt: expiresAt.toISOString() });
}

function assertOneCallFixtureTransport(transport) {
  if (typeof transport !== "function" || typeof transport.fixtureCallCount !== "function") {
    throw canaryError("NAVER_LEGACY_CANARY_TRANSPORT_UNAVAILABLE", "The NAVER canary transport is unavailable", 503);
  }
  if (transport.maxFixtureCalls !== 1) {
    throw canaryError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary transport budget is not one", 409);
  }
}

function safeCanaryResult(snapshot, executionIdentityHash, startedAt, completedAt) {
  const organicCount = Number(snapshot?.organicCount || 0);
  const adCount = Number(snapshot?.adCount || 0);
  return Object.freeze({
    status: snapshot?.status || "missing",
    strategyVersion: snapshot?.strategyVersion || null,
    executionIdentityHash,
    organicCount,
    adCount,
    observedRankCount: organicCount,
    providerResponseSubtype: "apollo_success",
    diagnosticId: safeDiagnosticId(executionIdentityHash, startedAt),
    startedAt,
    completedAt
  });
}

function createNaverLegacyCanaryRunner(options = {}) {
  const releaseEnabled = options.releaseEnabled === true;
  const fixtureExecutionEnabled = options.fixtureExecutionEnabled === true;
  const transport = options.transport;
  const providerReservation = options.providerReservation;
  const clock = typeof options.now === "function" ? options.now : () => new Date();
  const usedApprovalIds = new Set();
  let activeExecution = null;
  let authorizedCallCount = 0;
  let executedCallCount = 0;

  function status() {
    const plan = buildNaverLegacyCanaryPlan({
      releaseEnabled,
      externalCallApproved: false,
      oneShotApprovalPresent: false,
      providerHealthWriteApproved: false,
      authorizedCallCount,
      executedCallCount
    });
    assertNoStoreCanaryPlan(plan);
    return projectNaverLegacyCanaryStatus(plan);
  }

  async function execute(input = {}) {
    if (!releaseEnabled) {
      throw canaryError("NAVER_LEGACY_CANARY_DISABLED", "The NAVER legacy canary is disabled", 503);
    }
    if (fixtureExecutionEnabled !== true || input.fixtureMode !== true) {
      throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_REQUIRED", "The NAVER legacy canary requires an explicit one-shot approval", 409);
    }

    const collectorPlan = buildCollectorStrategyPlan({
      contract: input.contract,
      strategy: NAVER_LEGACY_CANARY_STRATEGY,
      callBudget: MAX_PROVIDER_CALL_BUDGET
    });
    if (collectorPlan.plannedRequestCount !== 1 || collectorPlan.executableRequestCount !== 1) {
      throw canaryError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary planned more than one request", 409);
    }
    const executionIdentityHash = buildCanaryExecutionIdentity(collectorPlan);
    if (activeExecution) {
      if (activeExecution.executionIdentityHash === executionIdentityHash) return activeExecution.promise;
      throw canaryError("NAVER_LEGACY_CANARY_BUSY", "Another NAVER canary contract is already active", 409);
    }

    const now = normalizedNow(clock());
    const approval = assertOneShotApproval(input.approval, collectorPlan, executionIdentityHash, now);
    if (usedApprovalIds.has(approval.approvalId)) {
      throw canaryError("NAVER_LEGACY_CANARY_APPROVAL_USED", "The one-shot NAVER canary approval was already used", 409);
    }
    assertOneCallFixtureTransport(transport);
    authorizedCallCount = 1;

    const promise = (async () => {
      usedApprovalIds.add(approval.approvalId);
      const startedAt = now.toISOString();
      const beforeCalls = transport.fixtureCallCount();
      const snapshot = await collectNaverPlaceSnapshot({
        contract: input.contract,
        strategy: NAVER_LEGACY_CANARY_STRATEGY,
        fixtureMode: true,
        allowLegacyCandidate: true,
        providerReservation,
        transport,
        signal: input.signal,
        asOf: startedAt,
        callBudget: MAX_PROVIDER_CALL_BUDGET
      });
      const callDelta = transport.fixtureCallCount() - beforeCalls;
      if (callDelta !== 1) {
        throw canaryError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary transport call budget was not exactly one", 409);
      }
      executedCallCount = 1;
      const completedAt = normalizedNow(clock()).toISOString();
      return safeCanaryResult(snapshot, executionIdentityHash, startedAt, completedAt);
    })();
    activeExecution = { executionIdentityHash, promise };
    try {
      return await promise;
    } finally {
      if (activeExecution?.promise === promise) activeExecution = null;
    }
  }

  return Object.freeze({ execute, status });
}

module.exports = {
  APPROVAL_MAX_LIFETIME_MS,
  createNaverLegacyCanaryRunner,
  safeCanaryResult
};
