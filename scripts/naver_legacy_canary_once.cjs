"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const {
  MAX_PROVIDER_CALL_BUDGET,
  buildCollectorStrategyPlan,
  selectNaverAdResult
} = require("./naver_collector_strategy.cjs");
const {
  extractApolloState,
  selectNaverOrganicResult
} = require("./naver_place_apollo_parser.cjs");
const {
  NAVER_LEGACY_CANARY_PHASE,
  NAVER_LEGACY_CANARY_PLAN_VERSION,
  NAVER_LEGACY_CANARY_SCOPE,
  NAVER_LEGACY_CANARY_STRATEGY,
  NAVER_LEGACY_CANARY_STRATEGY_VERSION,
  buildCanaryExecutionIdentity
} = require("./naver_legacy_canary_contract.cjs");
const {
  FAILURE_SUBTYPES,
  MAX_COOLDOWN_SECONDS,
  NAVER_PROVIDER_ID,
  classifyNaverAccessResponse,
  providerAvailability
} = require("./naver_provider_resilience.cjs");
const {
  createNaverProviderHealthStore
} = require("./naver_provider_health_store.cjs");
const {
  createNaverLegacyCanaryLiveTransport,
  isRegisteredNaverLegacyCanaryLiveTransport
} = require("./naver_legacy_canary_live_transport.cjs");

const NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION = "naver-legacy-canary-approval.v1";
const NAVER_LEGACY_CANARY_APPROVAL_TRUST_MODEL = "privileged_render_shell_operator_bound_to_workflow_revision";
const TARGET_PREVIEW_SERVICE_ID = "srv-d9jf91v41pts73cj9bu0";
const TARGET_PREVIEW_HOSTNAME = "sa-labs-datalab-v4-preview.onrender.com";
const TARGET_PREVIEW_RUNTIME_ROOT = "/var/data/v2-preview-runtime";
const APPROVAL_MAX_LIFETIME_MS = 15 * 60 * 1000;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DIAGNOSTIC_ID_PATTERN = /^crawl-[a-f0-9]{12}$/u;
const SAFE_PUBLIC_ERROR_CODES = new Set([
  "NAVER_ACCESS_BLOCKED",
  "NAVER_APOLLO_STATE_INVALID",
  "NAVER_HTTP_ERROR",
  "NAVER_LEGACY_CANARY_ABORTED",
  "NAVER_LEGACY_CANARY_ACTION_INVALID",
  "NAVER_LEGACY_CANARY_APPROVAL_INVALID",
  "NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED",
  "NAVER_LEGACY_CANARY_CONTRACT_INVALID",
  "NAVER_LEGACY_CANARY_FAILED",
  "NAVER_LEGACY_CANARY_INPUT_INVALID",
  "NAVER_LEGACY_CANARY_INPUT_REQUIRED",
  "NAVER_LEGACY_CANARY_INPUT_TOO_LARGE",
  "NAVER_LEGACY_CANARY_RESPONSE_INVALID",
  "NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE",
  "NAVER_LEGACY_CANARY_RUNTIME_INVALID",
  "NAVER_LEGACY_CANARY_STATE_UPDATE_FAILED",
  "NAVER_LEGACY_CANARY_STDIN_REQUIRED",
  "NAVER_LEGACY_CANARY_TIMEOUT",
  "NAVER_LEGACY_CANARY_TRANSPORT_DISABLED",
  "NAVER_LEGACY_CANARY_TRANSPORT_FAILED",
  "NAVER_LEGACY_CANARY_TRANSPORT_INVALID",
  "NAVER_PROVIDER_COOLDOWN_ACTIVE",
  "NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT",
  "NAVER_SEARCH_CONTRACT_UNAVAILABLE",
  "NAVER_TEMPORARY_UNAVAILABLE"
]);
const FIXTURE_OVERRIDE_KEYS = Object.freeze([
  "completedAt",
  "fetchImpl",
  "maxResponseBytes",
  "now",
  "providerStore",
  "runtimeIdentityValidator",
  "signal",
  "store",
  "timeoutMs",
  "transport"
]);
const CONTRACT_KEYS = Object.freeze([
  "categoryKey",
  "currentQueryCandidates",
  "display",
  "keyword",
  "legacyNaverQuery",
  "measurementPeriod",
  "rankEnd",
  "rankStart",
  "regionKey",
  "searchMode"
]);
const APPROVAL_KEYS = Object.freeze([
  "authorizedCallCount",
  "automaticFallback",
  "automaticRetry",
  "collectorScope",
  "concurrency",
  "expectedContractHash",
  "expectedExecutionIdentityHash",
  "expectedWorkflowRevision",
  "expiresAt",
  "externalCallApproved",
  "maxProviderAttempts",
  "notBefore",
  "phase",
  "planVersion",
  "providerHealthWriteApproved",
  "resultWriteApproved",
  "saveResult",
  "schemaVersion",
  "strategy",
  "strategyVersion",
  "targetCommit",
  "targetServiceId"
]);

class NaverLegacyCanaryOnceError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "NaverLegacyCanaryOnceError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
    this.providerFailureSubtype = meta.providerFailureSubtype || null;
    this.providerHttpStatus = meta.providerHttpStatus || null;
    this.retryAfterSeconds = meta.retryAfterSeconds ?? null;
    this.retryAt = meta.retryAt || null;
    this.diagnosticId = meta.diagnosticId || null;
    this.externalAttemptCount = Number(meta.externalAttemptCount || 0);
  }
}

function onceError(code, message, statusCode = 409, meta = {}) {
  return new NaverLegacyCanaryOnceError(code, message, statusCode, meta);
}

function fixtureModeFor(input = {}) {
  const fixtureMode = input.fixtureMode === true;
  const processIsProduction = process.env.RENDER === "true" || process.env.NODE_ENV === "production";
  const suppliedEnvironmentIsProduction = input.environment?.RENDER === "true"
    || input.environment?.NODE_ENV === "production";
  const hasFixtureOverride = FIXTURE_OVERRIDE_KEYS.some((key) => input[key] !== undefined);
  if (
    (fixtureMode && (processIsProduction || suppliedEnvironmentIsProduction))
    || (!fixtureMode && hasFixtureOverride)
  ) {
    throw onceError("NAVER_LEGACY_CANARY_TRANSPORT_INVALID", "The NAVER canary fixture boundary is invalid", 403);
  }
  return fixtureMode;
}

function normalizedInstant(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw onceError("NAVER_LEGACY_CANARY_APPROVAL_INVALID", `The NAVER canary ${label} is invalid`, 400);
  }
  return date;
}

function strictKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw onceError("NAVER_LEGACY_CANARY_APPROVAL_INVALID", `The NAVER canary ${label} is invalid`, 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw onceError("NAVER_LEGACY_CANARY_APPROVAL_INVALID", `The NAVER canary ${label} fields are invalid`, 400);
  }
}

function normalizedCanaryContract(value) {
  strictKeys(value, CONTRACT_KEYS, "contract");
  const keyword = String(value.keyword || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  const legacyNaverQuery = String(value.legacyNaverQuery || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    !keyword
    || keyword !== legacyNaverQuery
    || keyword.length > 120
    || value.searchMode !== "keyword"
    || value.categoryKey !== "glamping"
    || value.rankStart !== 1
    || value.rankEnd !== 50
    || value.display !== 50
    || value.measurementPeriod !== null
    || !Array.isArray(value.currentQueryCandidates)
    || value.currentQueryCandidates.length !== 1
    || String(value.currentQueryCandidates[0] || "").normalize("NFC").trim().replace(/\s+/gu, " ") !== keyword
    || (value.regionKey !== null && !/^[a-z0-9][a-z0-9_-]{1,119}$/u.test(String(value.regionKey)))
  ) {
    throw onceError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", "The NAVER canary contract is invalid", 400);
  }
  return Object.freeze({
    keyword,
    searchMode: "keyword",
    rankStart: 1,
    rankEnd: 50,
    display: 50,
    regionKey: value.regionKey,
    categoryKey: "glamping",
    measurementPeriod: null,
    currentQueryCandidates: Object.freeze([keyword]),
    legacyNaverQuery: keyword
  });
}

function buildLiveCanaryPlan(contractInput) {
  const contract = normalizedCanaryContract(contractInput);
  const collectorPlan = buildCollectorStrategyPlan({
    contract,
    strategy: NAVER_LEGACY_CANARY_STRATEGY,
    callBudget: MAX_PROVIDER_CALL_BUDGET
  });
  if (collectorPlan.plannedRequestCount !== 1 || collectorPlan.executableRequestCount !== 1) {
    throw onceError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary planned more than one request", 409);
  }
  const executionIdentityHash = buildCanaryExecutionIdentity(collectorPlan);
  return Object.freeze({ contract, collectorPlan, executionIdentityHash });
}

function validateApproval(approval, livePlan, options = {}) {
  strictKeys(approval, APPROVAL_KEYS, "approval");
  const now = normalizedInstant(options.now ?? new Date(), "clock");
  const notBefore = normalizedInstant(approval.notBefore, "not-before time");
  const expiresAt = normalizedInstant(approval.expiresAt, "expiry time");
  if (
    approval.schemaVersion !== NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION
    || approval.targetServiceId !== TARGET_PREVIEW_SERVICE_ID
    || !COMMIT_PATTERN.test(String(approval.targetCommit || ""))
    || approval.planVersion !== NAVER_LEGACY_CANARY_PLAN_VERSION
    || approval.strategy !== NAVER_LEGACY_CANARY_STRATEGY
    || approval.strategyVersion !== NAVER_LEGACY_CANARY_STRATEGY_VERSION
    || approval.phase !== NAVER_LEGACY_CANARY_PHASE
    || approval.collectorScope !== NAVER_LEGACY_CANARY_SCOPE
    || !HASH_PATTERN.test(String(approval.expectedContractHash || ""))
    || !HASH_PATTERN.test(String(approval.expectedExecutionIdentityHash || ""))
    || approval.expectedContractHash !== livePlan.collectorPlan.contractHash
    || approval.expectedExecutionIdentityHash !== livePlan.executionIdentityHash
    || !Number.isInteger(approval.expectedWorkflowRevision)
    || approval.expectedWorkflowRevision < 0
    || approval.maxProviderAttempts !== 1
    || approval.authorizedCallCount !== 1
    || approval.concurrency !== 1
    || approval.automaticRetry !== false
    || approval.automaticFallback !== false
    || approval.externalCallApproved !== true
    || approval.providerHealthWriteApproved !== true
    || approval.resultWriteApproved !== false
    || approval.saveResult !== false
    || notBefore.getTime() > now.getTime()
    || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() - notBefore.getTime() > APPROVAL_MAX_LIFETIME_MS
    || expiresAt.getTime() - now.getTime() > APPROVAL_MAX_LIFETIME_MS
  ) {
    throw onceError("NAVER_LEGACY_CANARY_APPROVAL_INVALID", "The NAVER canary approval is invalid or expired", 409);
  }
  // This envelope is intentionally not a cryptographic signature. Privileged
  // access to the exact Render service shell is the authority boundary, and
  // expectedWorkflowRevision becomes single-use once beginAttempt succeeds.
  return Object.freeze({
    expectedWorkflowRevision: approval.expectedWorkflowRevision,
    expiresAt: expiresAt.toISOString(),
    targetCommit: approval.targetCommit
  });
}

function assertPreviewRuntime(environment, runtimeRoot, targetCommit) {
  const env = environment || {};
  if (
    env.RENDER !== "true"
    || env.NODE_ENV !== "production"
    || env.RENDER_SERVICE_ID !== TARGET_PREVIEW_SERVICE_ID
    || env.RENDER_EXTERNAL_HOSTNAME !== TARGET_PREVIEW_HOSTNAME
    || env.RENDER_GIT_COMMIT !== targetCommit
    || env.V2_PREVIEW_DATA_ROOT !== TARGET_PREVIEW_RUNTIME_ROOT
    || path.resolve(String(runtimeRoot || "")) !== TARGET_PREVIEW_RUNTIME_ROOT
  ) {
    throw onceError("NAVER_LEGACY_CANARY_RUNTIME_INVALID", "The NAVER canary runtime identity is invalid", 403);
  }
}

function diagnosticId(executionIdentityHash, startedAt) {
  return `crawl-${crypto.createHash("sha256").update(`${executionIdentityHash}:${startedAt}`).digest("hex").slice(0, 12)}`;
}

function providerBlockedError(access, executionIdentityHash, startedAt, externalAttemptCount) {
  return onceError("NAVER_ACCESS_BLOCKED", "NAVER provider access is blocked", 503, {
    providerFailureSubtype: access.subtype,
    providerHttpStatus: access.httpStatus,
    retryAfterSeconds: access.retryAfterSeconds,
    diagnosticId: diagnosticId(executionIdentityHash, startedAt),
    externalAttemptCount
  });
}

function parseLiveCanaryResponse(response, livePlan, startedAt, externalAttemptCount) {
  const status = Number(response?.status);
  const body = String(response?.body || "");
  const access = classifyNaverAccessResponse({ status, headers: response?.headers, body }, { now: startedAt });
  if (access.blocked) throw providerBlockedError(access, livePlan.executionIdentityHash, startedAt, externalAttemptCount);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw onceError(
      status >= 500 ? "NAVER_TEMPORARY_UNAVAILABLE" : "NAVER_HTTP_ERROR",
      "The NAVER canary response was not successful",
      status >= 500 ? 503 : 502,
      { externalAttemptCount }
    );
  }

  let state;
  try {
    state = extractApolloState(body);
  } catch {
    const invalidApolloAccess = classifyNaverAccessResponse({
      status,
      headers: response?.headers,
      body,
      apolloStateValidated: false
    }, { now: startedAt });
    if (invalidApolloAccess.blocked) {
      throw providerBlockedError(invalidApolloAccess, livePlan.executionIdentityHash, startedAt, externalAttemptCount);
    }
    throw onceError("NAVER_APOLLO_STATE_INVALID", "The NAVER canary Apollo state is invalid", 502, { externalAttemptCount });
  }

  const query = livePlan.contract.legacyNaverQuery;
  let organic;
  let ads;
  try {
    organic = selectNaverOrganicResult(state, query, { allowPlaceList: false, required: false });
    ads = selectNaverAdResult(state, query, { companyMode: false, required: false });
  } catch (error) {
    throw onceError(
      String(error?.code || "NAVER_SEARCH_CONTRACT_UNAVAILABLE"),
      "The NAVER canary search contract is unavailable",
      502,
      { externalAttemptCount }
    );
  }
  if (!organic) {
    throw onceError("NAVER_SEARCH_CONTRACT_UNAVAILABLE", "The NAVER canary search contract is unavailable", 502, { externalAttemptCount });
  }
  if (organic.display !== 50) {
    throw onceError("NAVER_SEARCH_CONTRACT_UNAVAILABLE", "The NAVER canary rank 1-50 contract is unavailable", 502, {
      externalAttemptCount
    });
  }

  const organicCount = Math.min(Array.isArray(organic.items) ? organic.items.length : 0, 50);
  const adCount = Math.min(Array.isArray(ads?.items) ? ads.items.length : 0, 50);
  return Object.freeze({
    status: organicCount || adCount ? "ready" : "zero",
    organicCount,
    adCount,
    observedRankCount: organicCount,
    providerResponseSubtype: "apollo_success"
  });
}

function createDefaultProviderStore(runtimeRoot, options = {}) {
  return createNaverProviderHealthStore({
    filePath: path.join(runtimeRoot, "provider_health", "naver_place_search.json"),
    runtimeRoot,
    store: options.store,
    now: options.now
  });
}

async function inspectNaverLegacyCanaryOnce(input = {}) {
  const fixtureMode = fixtureModeFor(input);
  const runtimeRoot = path.resolve(String(input.runtimeRoot || TARGET_PREVIEW_RUNTIME_ROOT));
  const targetCommit = String(input.targetCommit || "");
  const runtimeValidator = fixtureMode ? (input.runtimeIdentityValidator || assertPreviewRuntime) : assertPreviewRuntime;
  const environment = fixtureMode ? (input.environment || {}) : process.env;
  runtimeValidator(environment, runtimeRoot, targetCommit);
  const livePlan = buildLiveCanaryPlan(input.contract);
  const providerStore = fixtureMode && input.providerStore
    ? input.providerStore
    : createDefaultProviderStore(runtimeRoot, fixtureMode ? input : {});
  const state = await providerStore.read();
  const availability = providerAvailability(state, { now: fixtureMode ? (input.now ?? new Date()) : new Date() });
  return Object.freeze({
    status: "planned",
    strategy: NAVER_LEGACY_CANARY_STRATEGY,
    strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
    planVersion: NAVER_LEGACY_CANARY_PLAN_VERSION,
    phase: NAVER_LEGACY_CANARY_PHASE,
    collectorScope: NAVER_LEGACY_CANARY_SCOPE,
    targetServiceId: TARGET_PREVIEW_SERVICE_ID,
    targetCommit,
    contractHash: livePlan.collectorPlan.contractHash,
    executionIdentityHash: livePlan.executionIdentityHash,
    expectedWorkflowRevision: state.workflowRevision,
    providerState: state.state,
    canExecuteExplicitProbe: availability.available || availability.probeRequired,
    retryAt: availability.retryAt,
    maxProviderAttempts: 1,
    actualCallsEnabled: false,
    executedCallCount: 0,
    resultWriteApproved: false,
    approvalTrustModel: NAVER_LEGACY_CANARY_APPROVAL_TRUST_MODEL
  });
}

async function runNaverLegacyCanaryOnce(input = {}) {
  const fixtureMode = fixtureModeFor(input);
  const started = normalizedInstant(fixtureMode ? (input.now ?? new Date()) : new Date(), "clock");
  const startedAt = started.toISOString();
  const runtimeRoot = path.resolve(String(input.runtimeRoot || TARGET_PREVIEW_RUNTIME_ROOT));
  const livePlan = buildLiveCanaryPlan(input.contract);
  const approval = validateApproval(input.approval, livePlan, { now: started });
  const runtimeValidator = fixtureMode ? (input.runtimeIdentityValidator || assertPreviewRuntime) : assertPreviewRuntime;
  const environment = fixtureMode ? (input.environment || {}) : process.env;
  runtimeValidator(environment, runtimeRoot, approval.targetCommit);
  const providerStore = fixtureMode && input.providerStore
    ? input.providerStore
    : createDefaultProviderStore(runtimeRoot, fixtureMode ? input : {});
  const current = await providerStore.read();
  if (current.workflowRevision !== approval.expectedWorkflowRevision) {
    throw onceError("NAVER_PROVIDER_WORKFLOW_REVISION_CONFLICT", "The NAVER provider state changed before the canary", 409);
  }

  const reservation = await providerStore.beginAttempt({
    expectedWorkflowRevision: approval.expectedWorkflowRevision,
    explicit: true,
    now: started
  });
  if (!reservation.allowed) {
    const availability = providerAvailability(reservation.state, { now: started });
    throw onceError("NAVER_PROVIDER_COOLDOWN_ACTIVE", "The NAVER provider is not available for the canary", 503, {
      retryAt: availability.retryAt,
      retryAfterSeconds: availability.retryAfterSeconds,
      externalAttemptCount: 0
    });
  }

  let transport = null;
  let parsed;
  try {
    transport = input.transport || createNaverLegacyCanaryLiveTransport({
      enabled: true,
      fetchImpl: fixtureMode ? input.fetchImpl : globalThis.fetch,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      allowTextFallback: fixtureMode
    });
    if (
      !isRegisteredNaverLegacyCanaryLiveTransport(transport)
      || typeof transport.callCount !== "function"
      || transport.maxCalls !== 1
    ) {
      throw onceError("NAVER_LEGACY_CANARY_TRANSPORT_INVALID", "The NAVER canary transport is invalid", 503);
    }
    const response = await transport(Object.freeze({
      providerId: NAVER_PROVIDER_ID,
      providerOperation: livePlan.collectorPlan.providerOperation,
      query: livePlan.contract.legacyNaverQuery,
      searchMode: livePlan.contract.searchMode,
      rankStart: 1,
      rankEnd: 50,
      display: 50,
      requestOrdinal: 1,
      callBudget: 1,
      actualCallsEnabled: true,
      fixtureOnly: false
    }), { signal: input.signal });
    const callCount = transport.callCount();
    if (callCount !== 1) {
      throw onceError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary call budget was not exactly one", 409, {
        externalAttemptCount: callCount
      });
    }
    parsed = parseLiveCanaryResponse(response, livePlan, startedAt, callCount);
    await providerStore.recordSuccess({
      expectedWorkflowRevision: reservation.state.workflowRevision,
      now: fixtureMode ? (input.completedAt ?? new Date()) : new Date()
    });
  } catch (error) {
    const safeError = error instanceof NaverLegacyCanaryOnceError
      ? error
      : onceError(
          String(error?.code || "NAVER_LEGACY_CANARY_TRANSPORT_FAILED"),
          "The NAVER canary failed",
          Number(error?.statusCode || 502),
          { externalAttemptCount: Number(transport?.callCount?.() || 0) }
        );
    try {
      if (safeError.code === "NAVER_ACCESS_BLOCKED") {
        const blockedState = await providerStore.recordBlock({
          expectedWorkflowRevision: reservation.state.workflowRevision,
          failure: {
            subtype: safeError.providerFailureSubtype || "unknown_access_block",
            httpStatus: safeError.providerHttpStatus,
            retryAfterSeconds: safeError.retryAfterSeconds,
            diagnosticId: safeError.diagnosticId
          },
          now: fixtureMode ? (input.completedAt ?? new Date()) : new Date()
        });
        safeError.retryAt = blockedState.retryAt;
      } else {
        await providerStore.releaseAttempt({
          expectedWorkflowRevision: reservation.state.workflowRevision,
          now: fixtureMode ? (input.completedAt ?? new Date()) : new Date()
        });
      }
    } catch {
      throw onceError("NAVER_LEGACY_CANARY_STATE_UPDATE_FAILED", "The NAVER canary safety state could not be updated", 503, {
        externalAttemptCount: Number(transport?.callCount?.() || 0),
        diagnosticId: safeError.diagnosticId
      });
    }
    throw safeError;
  }

  const completedAt = normalizedInstant(
    fixtureMode ? (input.completedAt ?? new Date()) : new Date(),
    "completion time"
  ).toISOString();
  return Object.freeze({
    ...parsed,
    strategyVersion: NAVER_LEGACY_CANARY_STRATEGY_VERSION,
    executionIdentityHash: livePlan.executionIdentityHash,
    diagnosticId: diagnosticId(livePlan.executionIdentityHash, startedAt),
    startedAt,
    completedAt,
    authorizedCallCount: 1,
    executedCallCount: 1,
    resultStored: false
  });
}

function safeCanaryErrorResult(error) {
  const candidateCode = String(error?.code || "");
  const code = SAFE_PUBLIC_ERROR_CODES.has(candidateCode)
    ? candidateCode
    : "NAVER_LEGACY_CANARY_FAILED";
  const providerResponseSubtype = FAILURE_SUBTYPES.includes(error?.providerFailureSubtype)
    ? error.providerFailureSubtype
    : null;
  const diagnosticCandidate = String(error?.diagnosticId || "");
  const diagnosticIdValue = DIAGNOSTIC_ID_PATTERN.test(diagnosticCandidate)
    ? diagnosticCandidate
    : null;
  const retryCandidate = typeof error?.retryAt === "string" ? new Date(error.retryAt) : null;
  const retryAt = retryCandidate
    && Number.isFinite(retryCandidate.getTime())
    && retryCandidate.toISOString() === error.retryAt
      ? error.retryAt
      : null;
  const retryAfterSeconds = Number.isInteger(error?.retryAfterSeconds)
    && error.retryAfterSeconds >= 0
    && error.retryAfterSeconds <= MAX_COOLDOWN_SECONDS
      ? error.retryAfterSeconds
      : null;
  const externalAttemptCount = Number(error?.externalAttemptCount);
  return Object.freeze({
    status: "failed",
    code,
    providerResponseSubtype,
    diagnosticId: diagnosticIdValue,
    retryAt,
    retryAfterSeconds,
    executedCallCount: externalAttemptCount === 0 || externalAttemptCount === 1
      ? externalAttemptCount
      : 0,
    resultStored: false
  });
}

module.exports = {
  APPROVAL_MAX_LIFETIME_MS,
  NAVER_LEGACY_CANARY_APPROVAL_SCHEMA_VERSION,
  NAVER_LEGACY_CANARY_APPROVAL_TRUST_MODEL,
  NaverLegacyCanaryOnceError,
  TARGET_PREVIEW_HOSTNAME,
  TARGET_PREVIEW_RUNTIME_ROOT,
  TARGET_PREVIEW_SERVICE_ID,
  assertPreviewRuntime,
  buildLiveCanaryPlan,
  inspectNaverLegacyCanaryOnce,
  normalizedCanaryContract,
  parseLiveCanaryResponse,
  runNaverLegacyCanaryOnce,
  safeCanaryErrorResult,
  validateApproval
};
