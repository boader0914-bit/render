"use strict";

const crypto = require("node:crypto");
const {
  extractApolloState,
  naverPlaceAddress,
  parseRootKey,
  selectNaverOrganicResult
} = require("./naver_place_apollo_parser.cjs");
const {
  assertProviderCircuitState,
  classifyNaverAccessResponse,
  NAVER_PROVIDER_ID
} = require("./naver_provider_resilience.cjs");

const NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION = "naver-collector-strategy.v2";
const NAVER_COLLECTOR_SNAPSHOT_SCHEMA_VERSION = "naver-place-snapshot.v2";
const NAVER_COLLECTOR_COMPARISON_SCHEMA_VERSION = "naver-collector-comparison.v1";
const NAVER_COLLECTOR_STRATEGIES = Object.freeze(["current", "legacy_candidate"]);
const DEFAULT_NAVER_COLLECTOR_STRATEGY = "current";
const MAX_FIXTURE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_QUERY_CANDIDATES = 6;
const MAX_PROVIDER_CALL_BUDGET = 1;
const SERVICE_GLOBAL_PROVIDER_LOCK_KEY = `${NAVER_PROVIDER_ID}:service_global`;
const REGISTERED_FIXTURE_TRANSPORTS = new WeakSet();
const STRATEGY_METADATA = Object.freeze({
  current: Object.freeze({
    strategyVersion: "current.v2",
    queryPlanVersion: "current-query-candidates.v2",
    parserVersion: "apollo-safe-parser.v1",
    rankingContractVersion: "naver-place-rank-current.v2",
    legacyParserReferenceVersion: null,
    historicalSourceCommit: null,
    historicalCollectorBlob: null
  }),
  legacy_candidate: Object.freeze({
    strategyVersion: "legacy-candidate.4e4e190.v1",
    queryPlanVersion: "legacy-4e4e190-main-place.v1",
    parserVersion: "apollo-safe-parser.v1",
    rankingContractVersion: "naver-place-rank-legacy-exact50.v2",
    legacyParserReferenceVersion: "4e4e190-parser-reference.v1",
    historicalSourceCommit: "4e4e1906e2967fe58df66f8ad67f832043d2763b",
    historicalCollectorBlob: "bcbe229998da3afa6f31ee04375fb0766019e56f"
  })
});
const LODGING_SEARCH_SUFFIXES = Object.freeze([
  "글램핑장",
  "오토캠핑장",
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

class NaverCollectorStrategyError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "NaverCollectorStrategyError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function strategyError(code, message, statusCode = 400) {
  return new NaverCollectorStrategyError(code, message, statusCode);
}

function normalizedStrategy(value) {
  const strategy = String(value || DEFAULT_NAVER_COLLECTOR_STRATEGY).trim().toLowerCase();
  if (!NAVER_COLLECTOR_STRATEGIES.includes(strategy)) {
    throw strategyError("NAVER_COLLECTOR_STRATEGY_INVALID", "NAVER collector strategy is invalid");
  }
  return strategy;
}

function normalizedQuery(value, fieldName = "keyword") {
  const query = String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!query || query.length > 120 || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", `NAVER collector ${fieldName} contract is invalid`);
  }
  return query;
}

function uniqueQueryCandidates(values, fieldName) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_QUERY_CANDIDATES) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", `NAVER collector ${fieldName} contract is invalid`);
  }
  return Object.freeze([...new Set(values.map((value) => normalizedQuery(value, fieldName)))]);
}

function compactQuery(value) {
  return String(value || "").replace(/\s+/gu, "");
}

function lodgingSearchSuffix(value) {
  const compact = compactQuery(value);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.endsWith(suffix)) || "";
}

function lodgingSearchSuffixInQuery(value) {
  const compact = compactQuery(value);
  return LODGING_SEARCH_SUFFIXES.find((suffix) => compact.includes(suffix)) || "";
}

function legacyCompanySearchQueries(keyword) {
  const raw = normalizedQuery(keyword);
  const compact = compactQuery(raw);
  const suffix = lodgingSearchSuffixInQuery(compact) || "글램핑";
  const hasLodging = Boolean(lodgingSearchSuffixInQuery(compact));
  const ending = lodgingSearchSuffix(compact);
  const base = ending ? compact.slice(0, -ending.length) : compact;
  const spaced = ending ? `${compact.slice(0, -ending.length)} ${ending}`.trim() : compact;
  return uniqueQueryCandidates([
    raw,
    compact,
    ...(hasLodging ? [spaced] : []),
    ...(!hasLodging ? [`${raw} ${suffix}`, `${compact}${suffix}`] : []),
    ...(hasLodging && base.length >= 3 ? [base] : [])
  ], "legacy company query candidates");
}

function normalizedIdentifier(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  const identifier = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,119}$/u.test(identifier)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", `NAVER collector ${fieldName} contract is invalid`);
  }
  return identifier;
}

function normalizedPeriodBoundary(value, fieldName) {
  const boundary = String(value || "").trim();
  if (!boundary || (!/^\d{4}-\d{2}-\d{2}$/u.test(boundary) && !Number.isFinite(Date.parse(boundary)))) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", `NAVER collector ${fieldName} contract is invalid`);
  }
  return boundary;
}

function normalizedMeasurementPeriod(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", "NAVER collector measurement period is invalid");
  }
  const start = normalizedPeriodBoundary(value.start, "measurement period start");
  const end = normalizedPeriodBoundary(value.end, "measurement period end");
  if (Date.parse(start) > Date.parse(end)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", "NAVER collector measurement period is invalid");
  }
  return Object.freeze({ start, end });
}

function normalizedContract(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", "NAVER collector contract is invalid");
  }
  const keyword = normalizedQuery(value.keyword);
  const searchMode = String(value.searchMode || "").trim().toLowerCase();
  if (!new Set(["keyword", "company"]).has(searchMode)) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", "NAVER collector search mode is invalid");
  }
  const rankStart = Number(value.rankStart ?? 1);
  const rankEnd = Number(value.rankEnd ?? 50);
  if (!Number.isInteger(rankStart) || !Number.isInteger(rankEnd) || rankStart !== 1 || rankEnd < rankStart || rankEnd > 50) {
    throw strategyError("NAVER_COLLECTOR_CONTRACT_INVALID", "NAVER collector rank contract is invalid");
  }
  const currentQueryCandidates = value.currentQueryCandidates === undefined
    ? Object.freeze([keyword])
    : uniqueQueryCandidates(value.currentQueryCandidates, "current query candidates");
  const legacyNaverQuery = value.legacyNaverQuery === undefined
    ? keyword
    : normalizedQuery(value.legacyNaverQuery, "legacy NAVER query");
  return Object.freeze({
    keyword,
    searchMode,
    rankStart,
    rankEnd,
    display: 50,
    regionKey: normalizedIdentifier(value.regionKey, "region key"),
    categoryKey: normalizedIdentifier(value.categoryKey, "category key"),
    measurementPeriod: normalizedMeasurementPeriod(value.measurementPeriod),
    currentQueryCandidates,
    legacyNaverQuery
  });
}

function queryHash(query) {
  return crypto.createHash("sha256").update(normalizedQuery(query)).digest("hex");
}

function strategyQueryCandidates(contract, strategy) {
  if (strategy === "current") return contract.currentQueryCandidates;
  return contract.searchMode === "company"
    ? legacyCompanySearchQueries(contract.legacyNaverQuery)
    : Object.freeze([contract.legacyNaverQuery]);
}

function collectorContractHash(contract) {
  return crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION,
    keywordHash: queryHash(contract.keyword),
    searchMode: contract.searchMode,
    rankStart: contract.rankStart,
    rankEnd: contract.rankEnd,
    display: contract.display,
    regionKey: contract.regionKey,
    categoryKey: contract.categoryKey,
    measurementPeriod: contract.measurementPeriod,
    currentQueryHashes: contract.currentQueryCandidates.map(queryHash),
    legacyQueryHashes: strategyQueryCandidates(contract, "legacy_candidate").map(queryHash)
  })).digest("hex");
}

function buildCollectorStrategyPlan(input = {}) {
  const strategy = normalizedStrategy(input.strategy);
  const contract = normalizedContract(input.contract || input);
  const callBudget = Number(input.callBudget ?? MAX_PROVIDER_CALL_BUDGET);
  if (!Number.isInteger(callBudget) || callBudget !== MAX_PROVIDER_CALL_BUDGET) {
    throw strategyError("NAVER_COLLECTOR_CALL_BUDGET_INVALID", "NAVER collector call budget must be exactly one");
  }
  const strategyMetadata = STRATEGY_METADATA[strategy];
  const contractHash = collectorContractHash(contract);
  const candidates = strategyQueryCandidates(contract, strategy);
  const candidateDescriptors = candidates.map((query, index) => Object.freeze({
    schemaVersion: NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION,
    providerId: NAVER_PROVIDER_ID,
    operation: "naver_place_rank_main",
    strategy,
    strategyVersion: strategyMetadata.strategyVersion,
    queryRole: index === 0 ? "primary" : "fallback",
    queryHash: queryHash(query),
    searchMode: contract.searchMode,
    regionKey: contract.regionKey,
    categoryKey: contract.categoryKey,
    display: contract.display,
    requestOrdinal: index + 1,
    callBudget
  }));
  const requestDescriptors = Object.freeze(candidateDescriptors.slice(0, callBudget));
  const candidateSequenceHash = crypto.createHash("sha256")
    .update(JSON.stringify(candidateDescriptors.map((descriptor) => descriptor.queryHash)))
    .digest("hex");
  const executionIdentityHash = crypto.createHash("sha256").update(JSON.stringify({
    providerId: NAVER_PROVIDER_ID,
    strategy,
    ...strategyMetadata,
    contractHash
  })).digest("hex");
  return Object.freeze({
    schemaVersion: NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION,
    providerId: NAVER_PROVIDER_ID,
    strategy,
    ...strategyMetadata,
    providerOperation: "naver_place_accommodation_search_snapshot",
    contractHash,
    executionIdentityHash,
    serviceGlobalProviderLockKey: SERVICE_GLOBAL_PROVIDER_LOCK_KEY,
    strategySingleFlightKey: `${NAVER_PROVIDER_ID}:${strategyMetadata.strategyVersion}:${executionIdentityHash}`,
    searchMode: contract.searchMode,
    regionKey: contract.regionKey,
    categoryKey: contract.categoryKey,
    rankStart: contract.rankStart,
    rankEnd: contract.rankEnd,
    display: contract.display,
    callBudget,
    candidateSequenceCount: candidateDescriptors.length,
    candidateQueryHashes: Object.freeze(candidateDescriptors.map((descriptor) => descriptor.queryHash)),
    candidateSequenceHash,
    plannedRequestCount: requestDescriptors.length,
    executableRequestCount: 1,
    requestDescriptors,
    externalCallOnRead: false,
    actualCallsEnabled: false,
    fixtureOnly: true
  });
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dereference(state, value) {
  if (!isObject(value)) return value;
  if (typeof value.__ref !== "string") return value;
  return isObject(state[value.__ref]) ? state[value.__ref] : null;
}

function legacyResultDescriptor(state, rootValue, operation) {
  const root = dereference(state, rootValue);
  if (!isObject(root)) return null;
  const containerKey = operation === "placeList" ? "businesses" : "business";
  const container = dereference(state, root[containerKey]);
  if (!isObject(container) || !Array.isArray(container.items)) return null;
  const items = container.items.map((entry) => dereference(state, entry));
  if (items.some((item) => !isObject(item))) {
    throw strategyError("NAVER_LEGACY_RESULT_INVALID", "Legacy NAVER result contains an invalid item");
  }
  const total = Number(container.total);
  return {
    key: "legacy-compatible-result",
    operation,
    type: operation,
    items,
    total: Number.isFinite(total) && total >= 0 ? total : items.length
  };
}

function containsFilterOpening(value) {
  if (Array.isArray(value)) return value.some(containsFilterOpening);
  if (!isObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => key === "filterOpening" || containsFilterOpening(nested));
}

function isFirstResultPage(args = {}) {
  const raw = args?.input?.start ?? args?.input?.page ?? args?.start ?? args?.page;
  if (raw === null || raw === undefined || raw === "") return true;
  const value = Number(raw);
  return Number.isInteger(value) && (value === 0 || value === 1);
}

function selectLegacyCompatibleResult(state, query, options = {}) {
  if (!isObject(state) || !isObject(state.ROOT_QUERY)) {
    throw strategyError("NAVER_APOLLO_STATE_INVALID", "NAVER Apollo state is invalid");
  }
  const operations = options.companyMode === true
    ? new Set(["accommodationSearch", "placeList"])
    : new Set(["accommodationSearch"]);
  const candidates = [];
  for (const [key, rootValue] of Object.entries(state.ROOT_QUERY)) {
    const parsed = parseRootKey(key);
    if (!parsed || !operations.has(parsed.operation)) continue;
    if (key.includes("filterOpening") || containsFilterOpening(parsed.args)) continue;
    if (parsed.args?.input?.query !== query || Number(parsed.args?.input?.display) !== 50) continue;
    if (!isFirstResultPage(parsed.args)) continue;
    const descriptor = legacyResultDescriptor(state, rootValue, parsed.operation);
    if (descriptor) candidates.push({ key, descriptor });
  }
  if (!candidates.length && options.required === false) return null;
  if (candidates.length !== 1) {
    throw strategyError(
      candidates.length > 1 ? "NAVER_SEARCH_AMBIGUOUS" : "NAVER_SEARCH_CONTRACT_UNAVAILABLE",
      candidates.length > 1
        ? "Legacy NAVER result is ambiguous"
        : "Legacy NAVER result contract is unavailable"
    );
  }
  return candidates[0].descriptor;
}

function adResultDescriptor(state, rootValue) {
  const root = dereference(state, rootValue);
  if (!isObject(root) || !Array.isArray(root.items)) return null;
  const items = root.items.map((entry) => dereference(state, entry));
  if (items.some((item) => !isObject(item))) return null;
  const total = Number(root.total);
  return {
    key: "safe-ad-result",
    operation: "adBusinesses",
    type: "adBusinesses",
    items,
    total: Number.isFinite(total) && total >= 0 ? total : items.length
  };
}

function selectNaverAdResult(state, query, options = {}) {
  if (!isObject(state) || !isObject(state.ROOT_QUERY)) {
    throw strategyError("NAVER_APOLLO_STATE_INVALID", "NAVER Apollo state is invalid");
  }
  const allowedBusinessTypes = options.companyMode === true
    ? new Set(["accommodation", "place"])
    : new Set(["accommodation"]);
  const candidates = [];
  for (const [key, rootValue] of Object.entries(state.ROOT_QUERY)) {
    const parsed = parseRootKey(key);
    if (!parsed || parsed.operation !== "adBusinesses") continue;
    if (key.includes("filterOpening") || containsFilterOpening(parsed.args)) continue;
    if (parsed.args?.input?.channel === "openingPlace") continue;
    if (parsed.args?.input?.query !== query) continue;
    if (!allowedBusinessTypes.has(String(parsed.args?.input?.businessType || ""))) continue;
    const descriptor = adResultDescriptor(state, rootValue);
    if (descriptor) candidates.push(descriptor);
  }
  if (!candidates.length) {
    if (options.required === false) return null;
    throw strategyError("NAVER_AD_CONTRACT_UNAVAILABLE", "NAVER ad result contract is unavailable");
  }
  if (candidates.length > 1) {
    const fingerprints = new Set(candidates.map((candidate) => JSON.stringify({
      total: candidate.total,
      ids: candidate.items.map((item) => String(item.id ?? item.placeId ?? ""))
    })));
    if (fingerprints.size > 1) {
      throw strategyError("NAVER_AD_SEARCH_AMBIGUOUS", "NAVER ad result is ambiguous");
    }
  }
  return candidates[0];
}

function optionalFiniteNumber(value, fieldName) {
  if (value === null || value === undefined || value === "") return null;
  if (!["string", "number"].includes(typeof value)) {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", `NAVER place item ${fieldName} is invalid`);
  }
  const number = Number(String(value).replace(/[^0-9.-]/gu, ""));
  if (!Number.isFinite(number)) {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", `NAVER place item ${fieldName} is invalid`);
  }
  return number;
}

function normalizedPlaceItem(item, rank) {
  const rawPlaceId = item.id ?? item.placeId;
  const rawName = item.name;
  if (!(["string", "number"].includes(typeof rawPlaceId)) || typeof rawName !== "string") {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", "NAVER place item is invalid");
  }
  if (typeof rawPlaceId === "number" && (!Number.isSafeInteger(rawPlaceId) || rawPlaceId < 0)) {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", "NAVER place item is invalid");
  }
  const rawCategory = item.category ?? "";
  const invalidAddressField = ["roadAddress", "jibunAddress", "address", "commonAddress"]
    .some((key) => Object.prototype.hasOwnProperty.call(item, key)
      && item[key] !== null
      && item[key] !== undefined
      && typeof item[key] !== "string");
  const rawAddress = naverPlaceAddress(item) ?? "";
  if (typeof rawCategory !== "string" || typeof rawAddress !== "string" || invalidAddressField) {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", "NAVER place item is invalid");
  }
  const placeId = String(rawPlaceId).trim();
  const name = rawName.normalize("NFC").trim();
  const category = rawCategory.normalize("NFC").trim();
  const address = rawAddress.normalize("NFC").trim();
  const hasControlCharacter = [placeId, name, category, address]
    .some((value) => /[\u0000-\u001f\u007f]/u.test(value));
  if (!placeId || placeId.length > 80 || !name || name.length > 200 || hasControlCharacter) {
    throw strategyError("NAVER_PLACE_ITEM_INVALID", "NAVER place item is invalid");
  }
  const reviewCount = optionalFiniteNumber(
    item.totalReviewCount ?? item.blogCafeReviewCount ?? item.placeReviewCount,
    "review count"
  );
  const price = optionalFiniteNumber(item.price, "price");
  return Object.freeze({
    placeId,
    name,
    category: category.slice(0, 200),
    address: address.slice(0, 300),
    reviewCount,
    price,
    rank
  });
}

function normalizedPlaceItems(items, rankEnd) {
  const result = [];
  const byId = new Map();
  for (const item of Array.from(items || []).slice(0, rankEnd)) {
    const normalized = normalizedPlaceItem(item, result.length + 1);
    const existing = byId.get(normalized.placeId);
    if (existing) {
      const same = existing.name === normalized.name
        && existing.category === normalized.category
        && existing.address === normalized.address;
      if (!same) throw strategyError("NAVER_PLACE_ID_CONFLICT", "NAVER place identity conflict");
      continue;
    }
    byId.set(normalized.placeId, normalized);
    result.push(normalized);
  }
  return Object.freeze(result);
}

function normalizedIso(value, fallback = "1970-01-01T00:00:00.000Z") {
  const source = value === null || value === undefined || value === "" ? fallback : String(value).trim();
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) {
    throw strategyError("NAVER_COLLECTOR_AS_OF_INVALID", "NAVER collector fixture timestamp is invalid");
  }
  return new Date(timestamp).toISOString();
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function snapshotHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function itemMissingFieldCount(items) {
  return items.reduce((total, item) => total
    + (item.category ? 0 : 1)
    + (item.address ? 0 : 1)
    + (item.reviewCount === null ? 1 : 0)
    + (item.price === null ? 1 : 0), 0);
}

function responseStatus(value) {
  const status = Number(value?.status ?? value?.statusCode);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response status is invalid");
  }
  return status;
}

function responseBody(value) {
  const raw = value?.body ?? value?.text ?? "";
  const body = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  if (Buffer.byteLength(body, "utf8") > MAX_FIXTURE_RESPONSE_BYTES) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_TOO_LARGE", "NAVER fixture response is too large", 413);
  }
  return body;
}

function safeTransportFailure(error) {
  if (error instanceof NaverCollectorStrategyError) return error;
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return strategyError("NAVER_COLLECTOR_FIXTURE_ABORTED", "NAVER fixture collection was aborted", 499);
  }
  return strategyError("NAVER_COLLECTOR_FIXTURE_TRANSPORT_FAILED", "NAVER fixture transport failed", 502);
}

function ownStaticDataValue(source, key) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response accessors are not allowed");
  }
  return descriptor.value;
}

function staticFixtureHeaders(value) {
  if (value === undefined) return undefined;
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response headers are invalid");
  }
  const result = {};
  for (const key of Object.keys(value)) {
    const raw = ownStaticDataValue(value, key);
    if (!["string", "number"].includes(typeof raw)) {
      throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response header values must be primitive");
    }
    result[key] = String(raw);
  }
  return Object.freeze(result);
}

function clonedStaticFixtureError(value) {
  const name = ownStaticDataValue(value, "name");
  const code = ownStaticDataValue(value, "code");
  const cloned = new Error("static fixture transport failure");
  cloned.name = typeof name === "string" && name.length <= 80 ? name : "Error";
  if (["string", "number"].includes(typeof code)) cloned.code = String(code).slice(0, 80);
  return Object.freeze(cloned);
}

function staticFixtureResponse(value) {
  if (value instanceof Error) return clonedStaticFixtureError(value);
  if (!isObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response must be a static object");
  }
  const status = ownStaticDataValue(value, "status");
  const statusCode = ownStaticDataValue(value, "statusCode");
  const bodyValue = ownStaticDataValue(value, "body");
  const textValue = ownStaticDataValue(value, "text");
  const headersValue = ownStaticDataValue(value, "headers");
  const selectedBody = bodyValue === undefined ? textValue : bodyValue;
  if (
    (status !== undefined && !["string", "number"].includes(typeof status))
    || (statusCode !== undefined && !["string", "number"].includes(typeof statusCode))
  ) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response status must be primitive");
  }
  if (selectedBody !== undefined && typeof selectedBody !== "string" && !Buffer.isBuffer(selectedBody)) {
    throw strategyError("NAVER_FIXTURE_RESPONSE_INVALID", "NAVER fixture response body must be a string or Buffer");
  }
  const body = Buffer.isBuffer(selectedBody) ? Buffer.from(selectedBody) : selectedBody;
  return Object.freeze({
    status,
    statusCode,
    headers: staticFixtureHeaders(headersValue),
    body
  });
}

function createStaticNaverFixtureTransport(response, options = {}) {
  const fixtureResponse = staticFixtureResponse(response);
  const maxCalls = options.maxCalls === undefined ? Number.POSITIVE_INFINITY : Number(options.maxCalls);
  if (!(maxCalls === Number.POSITIVE_INFINITY || (Number.isInteger(maxCalls) && maxCalls >= 1))) {
    throw strategyError("NAVER_FIXTURE_CALL_BUDGET_INVALID", "NAVER fixture call budget is invalid");
  }
  const budgetErrorCode = String(options.budgetErrorCode || "NAVER_FIXTURE_CALL_BUDGET_EXCEEDED").trim();
  if (!/^[A-Z][A-Z0-9_]{2,79}$/u.test(budgetErrorCode)) {
    throw strategyError("NAVER_FIXTURE_CALL_BUDGET_INVALID", "NAVER fixture call budget error code is invalid");
  }
  let callCount = 0;
  const transport = async function registeredStaticFixtureTransport(request) {
    if (callCount >= maxCalls) {
      throw strategyError(budgetErrorCode, "NAVER fixture transport call budget was exceeded", 409);
    }
    callCount += 1;
    if (fixtureResponse instanceof Error) throw fixtureResponse;
    return fixtureResponse;
  };
  Object.defineProperty(transport, "fixtureCallCount", {
    value: () => callCount,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(transport, "maxFixtureCalls", {
    value: maxCalls,
    configurable: false,
    enumerable: false,
    writable: false
  });
  REGISTERED_FIXTURE_TRANSPORTS.add(transport);
  return Object.freeze(transport);
}

function assertFixtureProviderReservation(reservation) {
  try {
    if (!reservation || typeof reservation !== "object") throw new TypeError("missing reservation");
    assertProviderCircuitState(reservation.state);
  } catch {
    throw strategyError("NAVER_PROVIDER_RESERVATION_REQUIRED", "A valid fixture provider reservation is required", 409);
  }
  if (reservation.allowed !== true || reservation.state.state !== "probe_allowed") {
    const error = strategyError("NAVER_PROVIDER_COOLDOWN_ACTIVE", "NAVER provider is not available for a fixture attempt", 503);
    error.retryAt = reservation.retryAt || reservation.state.retryAt || undefined;
    throw error;
  }
}

function providerBlockedError(access) {
  const error = strategyError("NAVER_ACCESS_BLOCKED", "NAVER provider access is blocked", 503);
  error.providerFailureSubtype = access.subtype;
  error.providerHttpStatus = access.httpStatus;
  error.retryAfterSeconds = access.retryAfterSeconds;
  return error;
}

async function collectNaverPlaceSnapshot(input = {}) {
  const strategy = normalizedStrategy(input.strategy);
  if (input.fixtureMode !== true) {
    throw strategyError("NAVER_COLLECTOR_STRATEGY_FIXTURE_ONLY", "NAVER collector strategy adapter is fixture-only", 403);
  }
  if (strategy === "legacy_candidate" && input.allowLegacyCandidate !== true) {
    throw strategyError("NAVER_LEGACY_STRATEGY_DISABLED", "Legacy NAVER collector candidate is disabled", 403);
  }
  if (typeof input.transport !== "function") {
    throw strategyError("NAVER_FIXTURE_TRANSPORT_REQUIRED", "A fixture transport is required");
  }
  if (!REGISTERED_FIXTURE_TRANSPORTS.has(input.transport)) {
    throw strategyError("NAVER_FIXTURE_TRANSPORT_UNTRUSTED", "Only registered static fixture transports are allowed", 403);
  }
  assertFixtureProviderReservation(input.providerReservation);
  if (input.signal?.aborted) {
    throw strategyError("NAVER_COLLECTOR_FIXTURE_ABORTED", "NAVER fixture collection was aborted", 499);
  }

  const contract = normalizedContract(input.contract || input);
  const plan = buildCollectorStrategyPlan({
    contract,
    strategy,
    callBudget: input.callBudget
  });
  const selectedQuery = strategyQueryCandidates(contract, strategy)[0];
  const fixtureRequest = Object.freeze({
    providerId: NAVER_PROVIDER_ID,
    providerOperation: plan.providerOperation,
    query: selectedQuery,
    searchMode: contract.searchMode,
    rankStart: contract.rankStart,
    rankEnd: contract.rankEnd,
    display: contract.display,
    requestOrdinal: 1,
    callBudget: plan.callBudget,
    actualCallsEnabled: false,
    fixtureOnly: true
  });

  let response;
  try {
    response = await input.transport(fixtureRequest, { signal: input.signal });
  } catch (error) {
    throw safeTransportFailure(error);
  }
  const status = responseStatus(response);
  const body = responseBody(response);
  const access = classifyNaverAccessResponse({
    status,
    headers: response?.headers,
    body
  });
  if (access.blocked) {
    throw providerBlockedError(access);
  }
  if (status < 200 || status >= 300) {
    throw strategyError(
      status >= 500 ? "NAVER_TEMPORARY_UNAVAILABLE" : "NAVER_HTTP_ERROR",
      "NAVER fixture response was not successful",
      status >= 500 ? 503 : 502
    );
  }

  let state;
  try {
    state = extractApolloState(body);
  } catch (error) {
    const invalidApolloAccess = classifyNaverAccessResponse({
      status,
      headers: response?.headers,
      body,
      apolloStateValidated: false
    });
    if (invalidApolloAccess.blocked) throw providerBlockedError(invalidApolloAccess);
    if (error?.code) throw error;
    throw strategyError("NAVER_APOLLO_STATE_INVALID", "NAVER Apollo state is invalid");
  }
  let selected;
  let selectedAds;
  let items;
  let adItems;
  try {
    selected = selectNaverOrganicResult(state, selectedQuery, {
      allowPlaceList: contract.searchMode === "company",
      required: false
    });
    selectedAds = selectNaverAdResult(state, selectedQuery, {
      companyMode: contract.searchMode === "company",
      required: false
    });
    if (!selected && !(contract.searchMode === "company" && selectedAds)) {
      throw strategyError("NAVER_SEARCH_CONTRACT_UNAVAILABLE", "NAVER result contract is unavailable");
    }
    items = normalizedPlaceItems(selected?.items || [], contract.rankEnd);
    adItems = normalizedPlaceItems(selectedAds?.items || [], contract.rankEnd);
  } catch (error) {
    const invalidContractAccess = classifyNaverAccessResponse({
      status,
      headers: response?.headers,
      body,
      apolloStateValidated: false
    });
    if (invalidContractAccess.blocked) throw providerBlockedError(invalidContractAccess);
    throw error;
  }
  const rawProviderTotal = Number(selected?.total);
  const providerTotal = Number.isFinite(rawProviderTotal) && rawProviderTotal >= 0
    ? rawProviderTotal
    : items.length;
  const rawAdTotal = Number(selectedAds?.total);
  const providerAdTotal = Number.isFinite(rawAdTotal) && rawAdTotal >= 0
    ? rawAdTotal
    : adItems.length;
  const observedAt = normalizedIso(input.asOf);
  const measurementPeriod = contract.measurementPeriod || Object.freeze({
    start: observedAt,
    end: observedAt
  });
  const collectionStatus = !selected && adItems.length
    ? "partial"
    : (items.length || adItems.length ? "ready" : "zero");
  const missingFieldCount = itemMissingFieldCount([...items, ...adItems]);
  const snapshotCore = {
    schemaVersion: NAVER_COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
    source: "naver_place_search",
    providerId: NAVER_PROVIDER_ID,
    strategy,
    strategyVersion: plan.strategyVersion,
    executionIdentityHash: plan.executionIdentityHash,
    contractHash: plan.contractHash,
    providerOperation: plan.providerOperation,
    regionKey: contract.regionKey,
    categoryKey: contract.categoryKey,
    measurementPeriod,
    observedAt,
    collectedAt: observedAt,
    status: collectionStatus,
    sampleCount: items.length,
    organicCount: items.length,
    adCount: adItems.length,
    providerTotal,
    providerAdTotal,
    coverage: {
      requestedRankCount: contract.rankEnd - contract.rankStart + 1,
      observedOrganicCount: items.length,
      observedAdCount: adItems.length,
      providerTotal,
      providerAdTotal
    },
    confidence: {
      grade: null,
      reason: "synthetic_fixture_not_scored"
    },
    penalties: collectionStatus === "partial" ? ["organic_contract_missing"] : [],
    missingFieldCount,
    rankRange: Object.freeze({ start: contract.rankStart, end: contract.rankEnd }),
    items,
    adItems,
    provenance: {
      fixtureOnly: true,
      actualCallsEnabled: false,
      externalProviderAttemptCount: 0,
      executedFixtureTransportCount: 1,
      externalCallOnRead: false,
      strategySchemaVersion: NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION,
      queryPlanVersion: plan.queryPlanVersion,
      parserVersion: plan.parserVersion,
      legacyParserReferenceVersion: plan.legacyParserReferenceVersion,
      legacyParserReferenceUsed: false,
      rankingContractVersion: plan.rankingContractVersion,
      historicalSourceCommit: plan.historicalSourceCommit,
      historicalCollectorBlob: plan.historicalCollectorBlob,
      serviceGlobalProviderLockKey: plan.serviceGlobalProviderLockKey,
      strategySingleFlightKey: plan.strategySingleFlightKey,
      candidateSequenceCount: plan.candidateSequenceCount,
      candidateSequenceHash: plan.candidateSequenceHash,
      plannedRequestCount: plan.plannedRequestCount,
      selectedRequestDescriptor: plan.requestDescriptors[0]
    }
  };
  return deepFreeze({
    ...snapshotCore,
    snapshotHash: snapshotHash(snapshotCore)
  });
}

function safePlanProjection(snapshot) {
  const descriptor = snapshot?.provenance?.selectedRequestDescriptor || {};
  return Object.freeze({
    strategy: snapshot?.strategy || null,
    strategyVersion: snapshot?.strategyVersion || null,
    queryPlanVersion: snapshot?.provenance?.queryPlanVersion || null,
    queryRole: descriptor.queryRole || null,
    queryHash: descriptor.queryHash || null,
    plannedRequestCount: Number(snapshot?.provenance?.plannedRequestCount || 0),
    candidateSequenceCount: Number(snapshot?.provenance?.candidateSequenceCount || 0),
    candidateSequenceHash: snapshot?.provenance?.candidateSequenceHash || null,
    callBudget: Number(descriptor.callBudget || 0),
    display: Number(descriptor.display || 0)
  });
}

function comparisonFixtureId(value) {
  const fixtureId = String(value || "synthetic-main-place").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,79}$/u.test(fixtureId) ? fixtureId : "synthetic-main-place";
}

function compareCollectorSnapshots(current, legacy, options = {}) {
  const left = Array.isArray(current?.items) ? current.items : [];
  const right = Array.isArray(legacy?.items) ? legacy.items : [];
  const leftIds = left.map((item) => item.placeId);
  const rightIds = right.map((item) => item.placeId);
  const currentPlan = safePlanProjection(current);
  const legacyPlan = safePlanProjection(legacy);
  const sameContract = Boolean(current?.contractHash && current.contractHash === legacy?.contractHash);
  const sameOrder = JSON.stringify(leftIds) === JSON.stringify(rightIds);
  const sameSampleCount = left.length === right.length;
  const samePrimaryQuery = Boolean(currentPlan.queryHash && currentPlan.queryHash === legacyPlan.queryHash);
  const sameCandidateSequence = Boolean(
    currentPlan.candidateSequenceHash
    && currentPlan.candidateSequenceHash === legacyPlan.candidateSequenceHash
  );
  const requestPlanningDifference = samePrimaryQuery && sameCandidateSequence
    ? "none"
    : "primary_or_candidate_sequence_differs";
  const parserDifference = sameOrder && sameSampleCount
    ? "none"
    : "place_id_or_rank_difference";
  let classification = "needs_single_canary";
  if (options.legacyPortable === false) classification = "legacy_not_portable";
  else if (requestPlanningDifference === "none" && parserDifference === "none") classification = "equivalent";
  else if (requestPlanningDifference !== "none" && parserDifference === "none") classification = "query_plan_difference";
  else if (right.length > left.length) classification = "parser_compatibility_gain";
  else if (left.length >= right.length) classification = "current_safer";
  const currentAdItems = Array.isArray(current?.adItems) ? current.adItems : [];
  const legacyAdItems = Array.isArray(legacy?.adItems) ? legacy.adItems : [];
  return deepFreeze({
    schemaVersion: NAVER_COLLECTOR_COMPARISON_SCHEMA_VERSION,
    fixtureId: comparisonFixtureId(options.fixtureId),
    contractVersion: NAVER_COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
    currentPlan,
    legacyPlan,
    plannedRequestCount: {
      current: currentPlan.plannedRequestCount,
      legacy: legacyPlan.plannedRequestCount
    },
    executedTransportCount: { current: 1, legacy: 1 },
    status: { current: current?.status || "missing", legacy: legacy?.status || "missing" },
    blockSubtype: { current: null, legacy: null },
    organicCount: { current: left.length, legacy: right.length },
    adCount: { current: currentAdItems.length, legacy: legacyAdItems.length },
    ranks: {
      current: left.map((item) => item.rank),
      legacy: right.map((item) => item.rank)
    },
    placeIdSet: {
      current: [...new Set(leftIds)].sort(),
      legacy: [...new Set(rightIds)].sort()
    },
    missingFieldCount: {
      current: Number(current?.missingFieldCount || 0),
      legacy: Number(legacy?.missingFieldCount || 0)
    },
    parserDifference,
    requestPlanningDifference,
    snapshotDifference: current?.snapshotHash === legacy?.snapshotHash ? "none" : "strategy_snapshot_differs",
    expectedContract: "current_safe_main_place_snapshot",
    securityRisk: "fixture_only_no_external_transport",
    canaryRelevance: classification === "equivalent" ? "low" : "needs_single_canary",
    classification,
    sameContract,
    sameOrder,
    sameSampleCount,
    currentSampleCount: left.length,
    legacySampleCount: right.length,
    onlyCurrent: leftIds.filter((id) => !rightIds.includes(id)),
    onlyLegacy: rightIds.filter((id) => !leftIds.includes(id))
  });
}

module.exports = {
  DEFAULT_NAVER_COLLECTOR_STRATEGY,
  MAX_FIXTURE_RESPONSE_BYTES,
  MAX_PROVIDER_CALL_BUDGET,
  NAVER_COLLECTOR_COMPARISON_SCHEMA_VERSION,
  NAVER_COLLECTOR_SNAPSHOT_SCHEMA_VERSION,
  NAVER_COLLECTOR_STRATEGIES,
  NAVER_COLLECTOR_STRATEGY_SCHEMA_VERSION,
  NaverCollectorStrategyError,
  buildCollectorStrategyPlan,
  collectNaverPlaceSnapshot,
  compareCollectorSnapshots,
  createStaticNaverFixtureTransport,
  legacyCompanySearchQueries,
  normalizedStrategy,
  selectLegacyCompatibleResult,
  selectNaverAdResult
};
