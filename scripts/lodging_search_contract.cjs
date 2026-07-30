"use strict";

const { resolveLodgingSearchIntent } = require("./lodging_search_intent.cjs");

const INTENT_SEARCH_MODES = Object.freeze({
  region_search: "keyword",
  company_search: "company",
  company_in_region: "company"
});

function normalizeLegacySearchMode(value) {
  return value === "company" ? "company" : "keyword";
}

function intentWarning(resolvedIntent = {}) {
  if (resolvedIntent.intent === "platform_search") {
    return "플랫폼 검색은 아직 수집 연결 전입니다.";
  }
  if (resolvedIntent.intent === "unknown") {
    return "검색어를 입력하거나 더 구체적으로 작성해 주세요.";
  }
  if (Number(resolvedIntent.confidence) < 0.8) {
    return "자동 판정 신뢰도가 낮아 첫 번째 검색 후보로 실행합니다.";
  }
  return "";
}

function resolveSearchIntentContract(payload = {}, options = {}) {
  const keyword = String(payload.keyword || "").trim();
  const requestedSearchIntentMode = payload.searchIntentMode === "auto" ? "auto" : "legacy";
  const resolvedIntent = resolveLodgingSearchIntent(keyword, { regionMap: options.regionMap || {} });
  const intentSupported = Boolean(INTENT_SEARCH_MODES[resolvedIntent.intent]);
  const legacyMode = normalizeLegacySearchMode(payload.searchMode);
  const resolvedSearchMode = requestedSearchIntentMode === "auto"
    ? (INTENT_SEARCH_MODES[resolvedIntent.intent] || legacyMode)
    : legacyMode;
  const selectedSearchCandidate = requestedSearchIntentMode === "auto"
    ? (resolvedIntent.searchCandidates?.[0] || null)
    : null;

  return {
    requestedSearchIntentMode,
    resolvedIntent,
    resolvedSearchMode,
    intentSupported: requestedSearchIntentMode === "auto" ? intentSupported : Boolean(keyword),
    intentWarning: requestedSearchIntentMode === "auto" ? intentWarning(resolvedIntent) : "",
    selectedSearchCandidate
  };
}

function assertSupportedSearchIntent(contract = {}) {
  if (contract.intentSupported) return contract;
  const error = new Error(contract.intentWarning || "현재 지원하지 않는 검색 방식입니다.");
  error.statusCode = 400;
  error.code = contract.resolvedIntent?.intent === "platform_search"
    ? "PLATFORM_SEARCH_NOT_CONNECTED"
    : "SEARCH_INTENT_UNSUPPORTED";
  throw error;
}

module.exports = {
  INTENT_SEARCH_MODES,
  assertSupportedSearchIntent,
  resolveSearchIntentContract
};
