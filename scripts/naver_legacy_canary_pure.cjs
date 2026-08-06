"use strict";

const crypto = require("node:crypto");
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
  NAVER_LEGACY_CANARY_STRATEGY,
  buildCanaryExecutionIdentity
} = require("./naver_legacy_canary_contract.cjs");
const {
  FAILURE_SUBTYPES,
  MAX_COOLDOWN_SECONDS,
  classifyNaverAccessResponse
} = require("./naver_provider_resilience.cjs");

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
const DIAGNOSTIC_ID_PATTERN = /^crawl-[a-f0-9]{12}$/u;
const SAFE_PUBLIC_ERROR_CODES = new Set([
  "NAVER_ACCESS_BLOCKED",
  "NAVER_APOLLO_STATE_INVALID",
  "NAVER_HTTP_ERROR",
  "NAVER_LEGACY_CANARY_ABORTED",
  "NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED",
  "NAVER_LEGACY_CANARY_CONTRACT_INVALID",
  "NAVER_LEGACY_CANARY_FAILED",
  "NAVER_LEGACY_CANARY_RESPONSE_INVALID",
  "NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE",
  "NAVER_LEGACY_CANARY_TIMEOUT",
  "NAVER_LEGACY_CANARY_TRANSPORT_DISABLED",
  "NAVER_LEGACY_CANARY_TRANSPORT_FAILED",
  "NAVER_LEGACY_CANARY_TRANSPORT_INVALID",
  "NAVER_SEARCH_CONTRACT_UNAVAILABLE",
  "NAVER_TEMPORARY_UNAVAILABLE"
]);

class NaverLegacyCanaryPureError extends Error {
  constructor(code, message, statusCode = 409, meta = {}) {
    super(message);
    this.name = "NaverLegacyCanaryPureError";
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

function pureError(code, message, statusCode = 409, meta = {}) {
  return new NaverLegacyCanaryPureError(code, message, statusCode, meta);
}

function strictKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw pureError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", `The NAVER canary ${label} is invalid`, 400);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw pureError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", `The NAVER canary ${label} fields are invalid`, 400);
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
    throw pureError("NAVER_LEGACY_CANARY_CONTRACT_INVALID", "The NAVER canary contract is invalid", 400);
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
    throw pureError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary planned more than one request", 409);
  }
  return Object.freeze({
    contract,
    collectorPlan,
    executionIdentityHash: buildCanaryExecutionIdentity(collectorPlan)
  });
}

function diagnosticId(executionIdentityHash, startedAt) {
  return `crawl-${crypto.createHash("sha256").update(`${executionIdentityHash}:${startedAt}`).digest("hex").slice(0, 12)}`;
}

function providerBlockedError(access, executionIdentityHash, startedAt, externalAttemptCount) {
  return pureError("NAVER_ACCESS_BLOCKED", "NAVER provider access is blocked", 503, {
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
    throw pureError(
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
    throw pureError("NAVER_APOLLO_STATE_INVALID", "The NAVER canary Apollo state is invalid", 502, { externalAttemptCount });
  }

  const query = livePlan.contract.legacyNaverQuery;
  let organic;
  let ads;
  try {
    organic = selectNaverOrganicResult(state, query, { allowPlaceList: false, required: false });
    ads = selectNaverAdResult(state, query, { companyMode: false, required: false });
  } catch (error) {
    throw pureError(
      String(error?.code || "NAVER_SEARCH_CONTRACT_UNAVAILABLE"),
      "The NAVER canary search contract is unavailable",
      502,
      { externalAttemptCount }
    );
  }
  if (!organic || organic.display !== 50) {
    throw pureError("NAVER_SEARCH_CONTRACT_UNAVAILABLE", "The NAVER canary rank 1-50 contract is unavailable", 502, {
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

function safeCanaryErrorResult(error) {
  const candidateCode = String(error?.code || "");
  const code = SAFE_PUBLIC_ERROR_CODES.has(candidateCode) ? candidateCode : "NAVER_LEGACY_CANARY_FAILED";
  const providerResponseSubtype = FAILURE_SUBTYPES.includes(error?.providerFailureSubtype)
    ? error.providerFailureSubtype
    : null;
  const diagnosticCandidate = String(error?.diagnosticId || "");
  const diagnosticIdValue = DIAGNOSTIC_ID_PATTERN.test(diagnosticCandidate) ? diagnosticCandidate : null;
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
    executedCallCount: externalAttemptCount === 0 || externalAttemptCount === 1 ? externalAttemptCount : 0,
    resultStored: false
  });
}

module.exports = {
  NaverLegacyCanaryPureError,
  buildLiveCanaryPlan,
  normalizedCanaryContract,
  parseLiveCanaryResponse,
  safeCanaryErrorResult
};
