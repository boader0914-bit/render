"use strict";

const crypto = require("node:crypto");

const NAVER_LEGACY_LIMITED_ACTIVATION_SCHEMA_VERSION = "naver-legacy-limited-activation.v1";
const NAVER_LEGACY_LIMITED_ACTIVATION_PROFILE = "preview-admin-keyword-fast-main-place.v1";
const NAVER_LEGACY_LIMITED_ACTIVATION_STRATEGY = "legacy_candidate";
const NAVER_LEGACY_LIMITED_ACTIVATION_SCOPE = "main_place_only";
const NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT = "/var/data/v2-preview-runtime";

const ACTIVE_LIMITS = Object.freeze({
  rankStart: 1,
  rankEnd: 50,
  display: 50,
  maxProviderAttempts: 1,
  callBudget: 1,
  concurrency: 1,
  automaticRetry: false,
  automaticFallback: false,
  externalCallOnRead: false,
  providerCircuitRequired: true,
  saveRunOnSuccessOnly: true,
  saveFailureRun: false
});

const LODGING_SUFFIXES = Object.freeze([
  "오토캠핑장",
  "글램핑장",
  "캠핑장",
  "야영장",
  "풀빌라",
  "카라반",
  "글램핑",
  "펜션",
  "리조트",
  "호텔",
  "모텔",
  "캠핑",
  "스테이",
  "숙소"
]);

class NaverLegacyLimitedActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NaverLegacyLimitedActivationError";
    this.code = code;
    this.statusCode = 400;
    this.retryable = false;
  }
}

function activationError(code, message) {
  return new NaverLegacyLimitedActivationError(code, message);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function normalizedToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizedQuery(value, fieldName = "legacy main query") {
  const query = String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!query || query.length > 120 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw activationError(
      "NAVER_LEGACY_LIMITED_QUERY_INVALID",
      `NAVER ${fieldName} is invalid`
    );
  }
  return query;
}

function compactQuery(value) {
  return String(value || "").normalize("NFC").replace(/\s+/gu, "");
}

function queryHash(value) {
  return crypto.createHash("sha256").update(normalizedQuery(value)).digest("hex");
}

function previewRuntimeMatches(environment = {}) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) return false;
  return environment.EXACT_V2_PREVIEW_RUNTIME === true
    && environment.RENDER === "true"
    && environment.PREVIEW_DATA_ROOT === NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT;
}

function activationBlockers(input = {}) {
  const environment = input.environment || input.env || {};
  const blockers = [];
  if (!previewRuntimeMatches(environment)) blockers.push("preview_runtime_required");
  if (normalizedToken(input.collectionSource) !== "admin_search") blockers.push("admin_search_source_required");
  if (normalizedToken(input.sourceRole) !== "admin") blockers.push("admin_role_required");
  if (normalizedToken(input.searchMode) !== "keyword") blockers.push("keyword_search_required");
  if (normalizedToken(input.collectionMode) !== "fast") blockers.push("fast_collection_mode_required");
  return Object.freeze(blockers);
}

function resolveNaverLegacyLimitedActivation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw activationError(
      "NAVER_LEGACY_LIMITED_ACTIVATION_INVALID",
      "NAVER legacy limited activation input is invalid"
    );
  }
  const blockers = activationBlockers(input);
  if (blockers.length) {
    return deepFreeze({
      schemaVersion: NAVER_LEGACY_LIMITED_ACTIVATION_SCHEMA_VERSION,
      activationProfile: NAVER_LEGACY_LIMITED_ACTIVATION_PROFILE,
      activationEnabled: false,
      executionEligible: false,
      strategy: "current",
      collectorScope: "current",
      blocker: blockers[0],
      blockers
    });
  }
  return deepFreeze({
    schemaVersion: NAVER_LEGACY_LIMITED_ACTIVATION_SCHEMA_VERSION,
    activationProfile: NAVER_LEGACY_LIMITED_ACTIVATION_PROFILE,
    activationEnabled: true,
    executionEligible: true,
    strategy: NAVER_LEGACY_LIMITED_ACTIVATION_STRATEGY,
    collectorScope: NAVER_LEGACY_LIMITED_ACTIVATION_SCOPE,
    blocker: null,
    blockers,
    requestedCollectionMode: "fast",
    effectiveCollectionMode: "fast",
    collectionModeForced: false,
    ...ACTIVE_LIMITS
  });
}

function resolveNaverLegacyLimitedActivationForTrustedServer(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw activationError(
      "NAVER_LEGACY_LIMITED_ACTIVATION_INVALID",
      "NAVER legacy limited activation input is invalid"
    );
  }
  const requestedCollectionMode = normalizedToken(input.collectionMode) || null;
  const serverEligible = previewRuntimeMatches(input.environment || input.env || {})
    && normalizedToken(input.collectionSource) === "admin_search"
    && normalizedToken(input.sourceRole) === "admin"
    && normalizedToken(input.searchMode) === "keyword"
    && new Set(["fast", "precision"]).has(requestedCollectionMode);
  if (!serverEligible) return resolveNaverLegacyLimitedActivation(input);
  const plan = resolveNaverLegacyLimitedActivation({ ...input, collectionMode: "fast" });
  return deepFreeze({
    ...plan,
    requestedCollectionMode,
    effectiveCollectionMode: "fast",
    collectionModeForced: requestedCollectionMode !== "fast"
  });
}

function firstDefinedQuery(candidates) {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return normalizedQuery(candidate);
    }
  }
  return null;
}

function lodgingSuffix(value) {
  const compact = compactQuery(value);
  return LODGING_SUFFIXES.find((suffix) => compact.includes(suffix)) || "글램핑";
}

function crawlerContextQuery(context = {}) {
  const direct = firstDefinedQuery([
    context.historicalNaverQuery,
    context.legacyNaverQuery,
    context.naverQuery
  ]);
  if (direct) return { query: direct, selectionSource: "crawler_historical_naver_query" };

  const province = context.province && typeof context.province === "object" ? context.province : {};
  const rawKeyword = firstDefinedQuery([
    context.rawKeyword,
    context.originalKeyword,
    context.keyword,
    context.primaryQuery
  ]);
  if (province.isCompany !== true && province.isLocal !== true && String(province.full || "").trim()) {
    const full = normalizedQuery(province.full, "historical province name");
    return {
      query: normalizedQuery(`${full} ${lodgingSuffix(rawKeyword || "글램핑")}`),
      selectionSource: "historical_province_query_rule"
    };
  }

  const platformQueries = context.platformQueries && typeof context.platformQueries === "object"
    ? context.platformQueries.naver
    : null;
  const fallback = firstDefinedQuery([
    ...(Array.isArray(platformQueries) ? platformQueries.slice(0, 1) : []),
    context.primaryQuery,
    rawKeyword
  ]);
  return fallback
    ? { query: fallback, selectionSource: "crawler_primary_query" }
    : null;
}

function chooseLegacyMainQuery(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw activationError("NAVER_LEGACY_LIMITED_QUERY_INVALID", "NAVER legacy main query input is invalid");
  }
  const explicit = firstDefinedQuery([input.explicitLegacyQuery]);
  const selected = explicit
    ? { query: explicit, selectionSource: "explicit_legacy_query" }
    : crawlerContextQuery(input.crawlerContext || {});
  if (!selected) {
    throw activationError("NAVER_LEGACY_LIMITED_QUERY_REQUIRED", "NAVER legacy main query is required");
  }
  return deepFreeze({
    query: selected.query,
    queryHash: queryHash(selected.query),
    selectionSource: selected.selectionSource,
    requestOrdinal: 1,
    plannedRequestCount: 1
  });
}

function projectNaverLegacyLimitedActivation(plan, querySelection = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw activationError(
      "NAVER_LEGACY_LIMITED_ACTIVATION_INVALID",
      "NAVER legacy limited activation plan is invalid"
    );
  }
  const projection = {
    schemaVersion: plan.schemaVersion,
    activationProfile: plan.activationProfile,
    activationEnabled: plan.activationEnabled === true,
    executionEligible: plan.executionEligible === true,
    strategy: plan.strategy,
    collectorScope: plan.collectorScope,
    blocker: plan.blocker || null,
    rankStart: plan.activationEnabled === true ? plan.rankStart : null,
    rankEnd: plan.activationEnabled === true ? plan.rankEnd : null,
    display: plan.activationEnabled === true ? plan.display : null,
    maxProviderAttempts: plan.activationEnabled === true ? plan.maxProviderAttempts : null,
    callBudget: plan.activationEnabled === true ? plan.callBudget : null,
    concurrency: plan.activationEnabled === true ? plan.concurrency : null,
    automaticRetry: plan.activationEnabled === true ? plan.automaticRetry : null,
    automaticFallback: plan.activationEnabled === true ? plan.automaticFallback : null,
    effectiveCollectionMode: plan.activationEnabled === true ? plan.effectiveCollectionMode : null,
    collectionModeForced: plan.activationEnabled === true ? plan.collectionModeForced === true : null,
    providerCircuitRequired: plan.activationEnabled === true ? plan.providerCircuitRequired : null,
    saveRunOnSuccessOnly: plan.activationEnabled === true ? plan.saveRunOnSuccessOnly : null,
    requestIdentityHash: querySelection && typeof querySelection.queryHash === "string"
      ? querySelection.queryHash
      : null,
    requestOrdinal: querySelection && querySelection.requestOrdinal === 1 ? 1 : null
  };
  return deepFreeze(projection);
}

module.exports = {
  ACTIVE_LIMITS,
  NAVER_LEGACY_LIMITED_ACTIVATION_PREVIEW_ROOT,
  NAVER_LEGACY_LIMITED_ACTIVATION_PROFILE,
  NAVER_LEGACY_LIMITED_ACTIVATION_SCHEMA_VERSION,
  NAVER_LEGACY_LIMITED_ACTIVATION_SCOPE,
  NAVER_LEGACY_LIMITED_ACTIVATION_STRATEGY,
  NaverLegacyLimitedActivationError,
  activationBlockers,
  chooseLegacyMainQuery,
  previewRuntimeMatches,
  projectNaverLegacyLimitedActivation,
  resolveNaverLegacyLimitedActivation,
  resolveNaverLegacyLimitedActivationForTrustedServer
};
