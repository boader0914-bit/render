"use strict";

// The worker is intentionally explicit about every request.  These fallback
// operations are not retries: they are the bounded, legacy V2 identity
// resolution sequence for one company.
const V2_TOP20_RESILIENCE_SCHEMA_VERSION = "collection-worker-v2-top20-resilience.v1";
const V2_TOP20_RESILIENCE_OPERATION_BUDGETS = Object.freeze({
  main_place: 1,
  booking_business_graphql: 20,
  booking_business_place_page: 40,
  booking_items: 20,
  daily_schedule: 160
});
const V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS = 241;
const DETAIL_OPERATIONS = new Set([
  "booking_business_graphql",
  "booking_business_place_page",
  "booking_items",
  "daily_schedule"
]);
const BOOKING_ID_SOURCES = new Set(["live_graphql", "place_page", "historical_verified", "none"]);
// This is the artifact-level contract for a detail target.  Keep it separate
// from the legacy ready/zero-only transaction contract: a resilient run can
// safely persist its verified ranking even when a detail target was not
// collected or was blocked.
const DETAIL_STATUSES = new Set(["ready", "partial", "zero", "blocked", "failed", "not_collected", "missing"]);

function resilienceError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 409, retryable: false });
}

function providerIdForOperation(operation) {
  return operation === "main_place" ? "naver_place_main" : "naver_booking_detail";
}

function isDetailOperation(operation) {
  return DETAIL_OPERATIONS.has(String(operation || ""));
}

function normalizeHistoricalBookingHints(value, options = {}) {
  const items = Array.isArray(value) ? value : [];
  if (items.length > 20) throw resilienceError("V2_TOP20_HISTORICAL_HINTS_INVALID", "historical booking hints exceed the company limit");
  const seenPlaces = new Map();
  const seenIds = new Map();
  const normalized = items.map((item) => {
    const placeId = String(item?.placeId || "");
    const bookingBusinessId = String(item?.bookingBusinessId || "");
    const sourceRunId = String(item?.sourceRunId || "");
    const verifiedAt = String(item?.verifiedAt || "");
    const lastSeenAt = String(item?.lastSeenAt || "");
    if (!/^\d{1,30}$/u.test(placeId) || !/^\d{1,30}$/u.test(bookingBusinessId) || !sourceRunId
      || !Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(lastSeenAt))) {
      throw resilienceError("V2_TOP20_HISTORICAL_HINTS_INVALID", "historical booking hint is invalid");
    }
    if (seenPlaces.has(placeId) || seenIds.has(bookingBusinessId)) {
      throw resilienceError("V2_TOP20_HISTORICAL_HINT_CONFLICT", "historical booking hint conflicts");
    }
    seenPlaces.set(placeId, bookingBusinessId);
    seenIds.set(bookingBusinessId, placeId);
    return Object.freeze({ placeId, bookingBusinessId, sourceRunId, verifiedAt, lastSeenAt });
  });
  const allowedPlaceIds = options.placeIds instanceof Set ? options.placeIds : null;
  if (allowedPlaceIds && normalized.some((hint) => !allowedPlaceIds.has(hint.placeId))) {
    throw resilienceError("V2_TOP20_HISTORICAL_HINTS_INVALID", "historical booking hint is outside the current ranking");
  }
  return Object.freeze(normalized);
}

function summarizeResilientTop20Collection(input = {}) {
  const mainPlaceStatus = String(input.mainPlaceStatus || "failed");
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const detailCircuitOpen = input.detailCircuitOpen === true;
  if (mainPlaceStatus !== "ready") {
    return Object.freeze({ collectionStatus: mainPlaceStatus === "blocked" ? "blocked" : "failed", mainPlaceStatus, detailStatus: "not_collected", resultStored: false, targetCompanyCount: 0, detailReadyCompanyCount: 0, revenueReadyCompanyCount: 0, detailCoverageRate: 0, revenueCoverageRate: 0 });
  }
  const targetCompanyCount = targets.length;
  const ready = targets.filter((target) => ["ready", "zero"].includes(String(target?.detailCollectionStatus || target?.status || "")));
  const revenueReady = targets.filter((target) => target?.revenueInputValid === true);
  const blocked = targets.filter((target) => String(target?.detailCollectionStatus || target?.status || "") === "blocked");
  const allTerminal = targets.length > 0 && targets.every((target) => ["ready", "zero"].includes(String(target?.detailCollectionStatus || target?.status || "")));
  const collectionStatus = allTerminal ? "complete" : ready.length ? "partial" : "rank_only";
  const detailStatus = allTerminal ? "complete" : detailCircuitOpen || blocked.length ? "blocked" : "partial";
  return Object.freeze({
    collectionStatus,
    mainPlaceStatus: "ready",
    detailStatus,
    resultStored: true,
    targetCompanyCount,
    detailReadyCompanyCount: ready.length,
    revenueReadyCompanyCount: revenueReady.length,
    detailCoverageRate: targetCompanyCount ? ready.length / targetCompanyCount : 0,
    revenueCoverageRate: targetCompanyCount ? revenueReady.length / targetCompanyCount : 0
  });
}

function validateResilientProviderTrace(trace) {
  if (!Array.isArray(trace) || trace.length < 1 || trace.length > V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS) {
    throw resilienceError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "provider call trace is invalid");
  }
  const counts = Object.fromEntries(Object.keys(V2_TOP20_RESILIENCE_OPERATION_BUDGETS).map((key) => [key, 0]));
  trace.forEach((item, index) => {
    const operation = item?.operation === "booking_business" ? "booking_business_graphql" : item?.operation;
    if (Number(item?.requestOrdinal) !== index + 1 || !Object.hasOwn(counts, operation)) {
      throw resilienceError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "provider call trace is not contiguous");
    }
    counts[operation] += 1;
    if (counts[operation] > V2_TOP20_RESILIENCE_OPERATION_BUDGETS[operation]) {
      throw resilienceError("V2_TOP20_CALL_BUDGET_EXCEEDED", "provider call budget exceeded");
    }
  });
  if (counts.main_place !== 1) throw resilienceError("V2_TOP20_PROVIDER_CALL_TRACE_INVALID", "main Place call is required");
  return Object.freeze({ counts: Object.freeze(counts), total: trace.length });
}

module.exports = {
  BOOKING_ID_SOURCES,
  DETAIL_OPERATIONS,
  DETAIL_STATUSES,
  V2_TOP20_RESILIENCE_MAXIMUM_PROVIDER_CALLS,
  V2_TOP20_RESILIENCE_OPERATION_BUDGETS,
  V2_TOP20_RESILIENCE_SCHEMA_VERSION,
  isDetailOperation,
  normalizeHistoricalBookingHints,
  providerIdForOperation,
  summarizeResilientTop20Collection,
  validateResilientProviderTrace
};
