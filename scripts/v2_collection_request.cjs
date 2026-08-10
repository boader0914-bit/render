"use strict";

// This is the only business-request normalizer for newly created Preview
// collection jobs.  It deliberately contains no worker, provider, or storage
// decision: all callers receive the same date/range/call-plan contract.
const crypto = require("node:crypto");
const {
  V2_TOP20_RESILIENCE_MAXIMUM_BOOKING_RANGE_DAYS,
  V2_TOP20_SCHEDULE_REQUEST_GRANULARITY,
  v2Top20ResiliencePlan
} = require("./collection_worker_v2_top20_resilience.cjs");

const V2_COLLECTION_REQUEST_SCHEMA_VERSION = "collection-worker-v2-request.v2";
const V2_COLLECTION_EXECUTION_PROFILE = "v2_collector_single_source.v2";
const V2_COLLECTION_IDEMPOTENCY_DOMAIN = "lodging-datalab.v2-collection-execution.v2";
const V2_COLLECTION_SCOPE = "v2_collector_single_source";
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

class V2CollectionRequestError extends Error {
  constructor(code, message, statusCode = 422) {
    super(message);
    this.name = "V2CollectionRequestError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function requestError(code, message, statusCode) {
  return new V2CollectionRequestError(code, message, statusCode);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw requestError("V2_COLLECTION_REQUEST_INVALID", "collection request contains a non-finite value");
  }
  return JSON.stringify(value ?? null);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalDate(value, label) {
  const text = String(value || "").trim();
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw requestError("V2_COLLECTION_DATE_INVALID", `${label} is invalid`);
  }
  return text;
}

function inclusiveDateRangeDays(start, end) {
  const startMs = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  const endMs = Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10)));
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function normalizedClientRequestId(value) {
  const clientRequestId = String(value || "").trim();
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw requestError("V2_COLLECTION_CLIENT_REQUEST_INVALID", "client request identity is invalid", 400);
  }
  return clientRequestId;
}

function normalizeV2CollectionRequest(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!source) throw requestError("V2_COLLECTION_REQUEST_INVALID", "collection request must be an object", 400);
  const keyword = String(source.keyword || "").trim();
  const checkIn = canonicalDate(source.checkIn, "checkIn");
  const checkOut = canonicalDate(source.checkOut, "checkOut");
  const bookingRangeDays = inclusiveDateRangeDays(checkIn, checkOut);
  const rankStart = Number(source.rankStart ?? 1);
  const rankEnd = Number(source.rankEnd ?? 50);
  const detailRankStart = Number(source.detailRankStart ?? 1);
  const detailRankEnd = Number(source.detailRankEnd ?? 20);
  if (
    !keyword || keyword.length > 120 || /[\r\n\0]/u.test(keyword)
    || source.searchMode !== "keyword"
    || source.collectionMode !== "precision"
    || source.collectionPurpose !== "revenue_detail"
    || source.productMode !== "all"
    || checkOut < checkIn
    || bookingRangeDays < 1 || bookingRangeDays > V2_TOP20_RESILIENCE_MAXIMUM_BOOKING_RANGE_DAYS
    || !Number.isInteger(rankStart) || rankStart !== 1
    || !Number.isInteger(rankEnd) || rankEnd !== 50
    || !Number.isInteger(detailRankStart) || detailRankStart !== 1
    || !Number.isInteger(detailRankEnd) || detailRankEnd !== 20
  ) {
    throw requestError("V2_COLLECTION_REQUEST_INVALID", "collection request does not match the supported V2 range profile");
  }
  if (source.bookingRangeDays !== undefined && Number(source.bookingRangeDays) !== bookingRangeDays) {
    throw requestError("V2_COLLECTION_DATE_RANGE_INVALID", "booking range day count is invalid");
  }
  const clientRequestId = normalizedClientRequestId(source.clientRequestId);
  const plan = buildV2CollectionPlan({ bookingRangeDays });
  const base = {
    schemaVersion: V2_COLLECTION_REQUEST_SCHEMA_VERSION,
    keyword,
    keywordHash: sha256Hex(keyword),
    searchMode: "keyword",
    collectionMode: "precision",
    collectionPurpose: "revenue_detail",
    productMode: "all",
    checkIn,
    checkOut,
    bookingRangeDays,
    rankStart,
    rankEnd,
    detailRankStart,
    detailRankEnd,
    clientRequestId,
    measurementPeriod: Object.freeze({ start: checkIn, end: checkOut }),
    scheduleRequestGranularity: V2_TOP20_SCHEDULE_REQUEST_GRANULARITY,
    maximumProviderCalls: plan.maximumProviderCalls
  };
  const contractHash = sha256Hex(stableJson({
    domain: "lodging-datalab.v2-collection-contract.v2",
    contract: base
  }));
  const executionRequestHash = sha256Hex(stableJson({
    domain: V2_COLLECTION_IDEMPOTENCY_DOMAIN,
    contractHash,
    clientRequestId
  }));
  return Object.freeze({ ...base, contractHash, executionRequestHash });
}

function buildV2CollectionPlan(input = {}) {
  const bookingRangeDays = Number(input.bookingRangeDays || 1);
  const resiliencePlan = v2Top20ResiliencePlan(bookingRangeDays);
  return Object.freeze({
    bookingRangeDays: resiliencePlan.bookingRangeDays,
    scheduleRequestGranularity: resiliencePlan.scheduleRequestGranularity,
    plannedMainPlaceCalls: resiliencePlan.operationBudgets.main_place,
    plannedBookingBusinessCalls: resiliencePlan.operationBudgets.booking_business_graphql,
    plannedPlacePageCalls: resiliencePlan.operationBudgets.booking_business_place_page,
    plannedBookingItemsCalls: resiliencePlan.operationBudgets.booking_items,
    plannedDailyScheduleCalls: resiliencePlan.operationBudgets.daily_schedule,
    maximumProviderCalls: resiliencePlan.maximumProviderCalls
  });
}

function buildV2CollectionJobIdentity(input = {}) {
  const request = normalizeV2CollectionRequest(input);
  return Object.freeze({
    contractHash: request.contractHash,
    executionRequestHash: request.executionRequestHash,
    jobId: `job-v2-${request.contractHash.slice(0, 12)}-${request.executionRequestHash.slice(0, 12)}`,
    attemptId: `attempt:v2-${request.contractHash.slice(0, 12)}-${request.executionRequestHash.slice(0, 12)}`,
    idempotencyDomain: V2_COLLECTION_IDEMPOTENCY_DOMAIN
  });
}

function buildV2CollectionSignedContract(input = {}) {
  const request = normalizeV2CollectionRequest(input);
  return Object.freeze({ ...request });
}

module.exports = {
  V2_COLLECTION_EXECUTION_PROFILE,
  V2_COLLECTION_IDEMPOTENCY_DOMAIN,
  V2_COLLECTION_REQUEST_SCHEMA_VERSION,
  V2_COLLECTION_SCOPE,
  V2CollectionRequestError,
  buildV2CollectionJobIdentity,
  buildV2CollectionPlan,
  buildV2CollectionSignedContract,
  canonicalDate,
  inclusiveDateRangeDays,
  normalizeV2CollectionRequest,
  sha256Hex,
  stableJson
};
