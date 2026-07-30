"use strict";

const crypto = require("node:crypto");

const LIVE_PROVIDER_ID = "v2-live-collection";
const PROVIDER_KEYS = Object.freeze({
  naverSearch: "naver-search",
  naverBooking: "naver-booking",
  nol: "nol",
  ddnayo: "ddnayo"
});
const ALL_PROVIDER_KEYS = Object.freeze(Object.values(PROVIDER_KEYS));
const LIVE_STAGES = Object.freeze(["discovery", "quick", "detail", "ota"]);
const LIVE_APPROVAL_VERSION = "v2-live-approval-v1";
const NAVER_SEARCH_MODES = Object.freeze({
  disabled: "disabled",
  apiHub: "api-hub",
  internalWeb: "internal-web"
});
const NAVER_API_HUB_LOCAL_HOST = "naverapihub.apigw.ntruss.com";
const NAVER_API_HUB_LOCAL_PATH = "/search/v1/local";
const NAVER_API_HUB_LOCAL_ENDPOINT = `https://${NAVER_API_HUB_LOCAL_HOST}${NAVER_API_HUB_LOCAL_PATH}`;
const NAVER_API_HUB_SORTS = Object.freeze(["random", "comment"]);

const NAVER_BOOKING_BUSINESS_QUERY = `
  query naverBookingBusiness($id: String!, $isNx: Boolean) {
    business: placeDetail(input: { id: $id, isNx: $isNx, deviceType: "mobile" }) {
      base { id name }
      naverBooking { bookingBusinessId naverBookingUrl naverBookingHubUrl }
    }
  }
`;

const NAVER_BOOKING_ITEMS_QUERY = `
  query searchBizItem($bizItemSearchParams: BizItemSearchParams) {
    searchBizItem(input: $bizItemSearchParams) {
      id
      bizItems {
        id businessId bizItemId bizItemType bizItemSubType name
        isClosedBooking isClosedBookingUser isImp price
        minBookingCount maxBookingCount bookableSettingJson
        bookingCountSettingJson priceByDates
        minMaxPrice { minPrice maxPrice isSinglePrice }
      }
    }
  }
`;

const NAVER_DAILY_SCHEDULE_QUERY = `
  query dailySchedule($scheduleParams: ScheduleParams) {
    schedule(input: $scheduleParams) {
      bizItemSchedule { daily { date } }
    }
  }
`;

const DEFAULT_ENDPOINT_BUILDERS = Object.freeze({
  search({ query }) {
    return `https://pcmap.place.naver.com/accommodation/list?query=${encodeURIComponent(query)}`;
  },
  apiHubSearch({ query, sort = "random" }) {
    const url = new URL(NAVER_API_HUB_LOCAL_ENDPOINT);
    url.searchParams.set("query", cleanText(query, 180));
    url.searchParams.set("display", "5");
    url.searchParams.set("start", "1");
    url.searchParams.set("sort", NAVER_API_HUB_SORTS.includes(sort) ? sort : "random");
    return url.toString();
  },
  bookingBusiness() {
    return "https://pcmap-api.place.naver.com/graphql";
  },
  bookingItems() {
    return "https://m.booking.naver.com/graphql";
  },
  bookingSchedule() {
    return "https://m.booking.naver.com/graphql";
  },
  nol() {
    return "https://nol.yanolja.com/discovery/api/list/universal-search/v1/list";
  },
  ddnayo({ query }) {
    return `https://trip.ddnayo.com/web-api/total-search?searchKeyword=${encodeURIComponent(query)}&pageNumber=1&pageSize=24&orderBy=recommend`;
  }
});

class V2LiveCollectionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "V2LiveCollectionError";
    this.code = options.code || "V2_LIVE_COLLECTION_ERROR";
    this.category = options.category || "internal";
    this.statusCode = Number(options.statusCode || 500);
    this.retryable = Boolean(options.retryable);
    this.retryAfterMs = Math.max(0, Number(options.retryAfterMs || 0) || 0);
    this.provider = cleanText(options.provider, 64);
    this.operation = cleanText(options.operation, 96);
    this.requestKey = cleanText(options.requestKey, 128);
    this.details = options.details && typeof options.details === "object"
      ? clone(options.details)
      : null;
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value, maximum = 240) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback, maximum = 100_000) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(maximum, Math.floor(number)));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizedRequestBody(value) {
  if (typeof value !== "string") return canonicalize(value ?? null);
  try {
    return canonicalize(JSON.parse(value));
  } catch {
    return value;
  }
}

function approvalTokenDigest(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function strictCalendarDate(value, label = "targetDate") {
  const text = cleanText(value, 16);
  const timestamp = Date.parse(`${text}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)
    || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 10) !== text) {
    throw liveError(`${label} must use a real YYYY-MM-DD calendar date`, {
      code: "V2_LIVE_TARGET_DATE_INVALID",
      category: "input",
      statusCode: 400,
      retryable: false
    });
  }
  return text;
}

function normalizeApprovalManifest(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw liveError("Live approval manifest must be valid JSON", {
        code: "V2_LIVE_APPROVAL_MANIFEST_INVALID",
        category: "approval",
        statusCode: 503,
        retryable: false
      });
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw liveError("Live approval manifest is required", {
      code: "V2_LIVE_APPROVAL_MANIFEST_REQUIRED",
      category: "approval",
      statusCode: 503,
      retryable: false
    });
  }
  const issuedAtMs = Date.parse(String(parsed.issuedAt || ""));
  const expiresAtMs = Date.parse(String(parsed.expiresAt || ""));
  const requestCaps = {
    perRun: positiveInteger(parsed.requestCaps?.perRun, 0, 10_000),
    perDay: positiveInteger(parsed.requestCaps?.perDay, 0, 1_000_000)
  };
  const providers = [...new Set((Array.isArray(parsed.providers) ? parsed.providers : [])
    .map((provider) => cleanText(provider, 64).toLowerCase()))];
  const stages = [...new Set((Array.isArray(parsed.stages) ? parsed.stages : [])
    .map((stage) => cleanText(stage, 32).toLowerCase()))];
  const targets = (Array.isArray(parsed.targets) ? parsed.targets : []).map((target) => ({
    targetName: cleanText(target?.targetName, 180),
    regionCode: cleanText(target?.regionCode, 80).toLowerCase(),
    targetDates: [...new Set((Array.isArray(target?.targetDates) ? target.targetDates : [])
      .map((date) => strictCalendarDate(date)))]
  }));
  const providerCaps = {};
  for (const provider of providers) {
    providerCaps[provider] = {
      perRun: positiveInteger(parsed.providerCaps?.[provider]?.perRun, 0, 10_000),
      perDay: positiveInteger(parsed.providerCaps?.[provider]?.perDay, 0, 1_000_000),
      costMicros: positiveInteger(parsed.providerCaps?.[provider]?.costMicros, 0, Number.MAX_SAFE_INTEGER),
      stages: [...new Set((Array.isArray(parsed.providerCaps?.[provider]?.stages)
        ? parsed.providerCaps[provider].stages
        : []).map((stage) => cleanText(stage, 32).toLowerCase()))]
    };
  }
  const maximumCostMicros = positiveInteger(parsed.cost?.maximumCostMicros, 0, Number.MAX_SAFE_INTEGER);
  const hasExplicitCostContract = Boolean(
    parsed.cost
    && typeof parsed.cost === "object"
    && Object.prototype.hasOwnProperty.call(parsed.cost, "currency")
    && Object.prototype.hasOwnProperty.call(parsed.cost, "maximumCostMicros")
    && providers.every((provider) => Object.prototype.hasOwnProperty.call(parsed.providerCaps?.[provider] || {}, "costMicros"))
  );
  const manifest = {
    version: cleanText(parsed.version, 64),
    approvalId: cleanText(parsed.approvalId, 160),
    issuedAt: Number.isFinite(issuedAtMs) ? new Date(issuedAtMs).toISOString() : "",
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : "",
    targets,
    providers,
    stages,
    requestCaps,
    providerCaps,
    cost: {
      currency: cleanText(parsed.cost?.currency || "KRW", 8).toUpperCase(),
      maximumCostMicros
    }
  };
  if (manifest.version !== LIVE_APPROVAL_VERSION
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(manifest.approvalId)
    || !manifest.issuedAt || !manifest.expiresAt || issuedAtMs >= expiresAtMs
    || !targets.length || targets.some((target) => !target.targetName || !target.targetDates.length)
    || !providers.length || providers.some((provider) => !ALL_PROVIDER_KEYS.includes(provider))
    || !stages.length || stages.some((stage) => !LIVE_STAGES.includes(stage))
    || requestCaps.perRun < 1 || requestCaps.perDay < 1
    || providers.some((provider) => providerCaps[provider].perRun < 1
      || providerCaps[provider].perDay < 1
      || !providerCaps[provider].stages.length
      || providerCaps[provider].stages.some((stage) => !stages.includes(stage)))
    || !hasExplicitCostContract || !manifest.cost.currency) {
    throw liveError("Live approval manifest is incomplete or outside the supported contract", {
      code: "V2_LIVE_APPROVAL_MANIFEST_INVALID",
      category: "approval",
      statusCode: 503,
      retryable: false
    });
  }
  return Object.freeze(manifest);
}

function approvalManifestDigest(value) {
  return crypto.createHash("sha256").update(stableJson(normalizeApprovalManifest(value)), "utf8").digest("hex");
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left || "")) || !/^[a-f0-9]{64}$/i.test(String(right || ""))) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function stableRequestKey(input = {}) {
  const canonical = {
    runKey: cleanText(input.runKey, 160),
    provider: cleanText(input.provider, 64),
    method: cleanText(input.method || "GET", 16).toUpperCase(),
    url: String(input.url || ""),
    body: normalizedRequestBody(input.body)
  };
  return `v2req_${crypto.createHash("sha256").update(stableJson(canonical)).digest("hex")}`;
}

function nowValue(clock) {
  const value = typeof clock === "function" ? clock() : Date.now();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

function dayKey(clock) {
  return new Date(nowValue(clock)).toISOString().slice(0, 10);
}

function collectedAt(clock) {
  return new Date(nowValue(clock)).toISOString();
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  if (headers instanceof Map) return String(headers.get(name) || headers.get(name.toLowerCase()) || "");
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target);
  return key ? String(headers[key] || "") : "";
}

function parseRetryAfterMs(headers, clock = Date.now) {
  const value = headerValue(headers, "retry-after").trim();
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowValue(clock)) : 0;
}

function boundedBackoffMs(options = {}) {
  const attempt = Math.max(1, positiveInteger(options.attempt, 1, 10));
  const baseMs = positiveInteger(options.baseMs, 500, 300_000);
  const maximumMs = Math.max(baseMs, positiveInteger(options.maximumMs, 30_000, 900_000));
  const retryAfterMs = positiveInteger(options.retryAfterMs, 0, 86_400_000);
  const exponential = baseMs * (2 ** Math.max(0, attempt - 1));
  return retryAfterMs > 0
    ? Math.max(retryAfterMs, Math.min(maximumMs, exponential))
    : Math.max(0, Math.min(maximumMs, exponential));
}

function liveError(message, options = {}) {
  return new V2LiveCollectionError(message, options);
}

function classifyProviderFailure(reason, context = {}) {
  if (reason instanceof V2LiveCollectionError) return reason;
  const message = cleanText(reason?.message || reason || "Provider request failed", 300);
  const code = String(reason?.code || "").toUpperCase();
  const name = String(reason?.name || "").toLowerCase();
  if (name === "aborterror" || code.includes("TIMEOUT") || /timed?\s*out/i.test(message)) {
    return liveError("Provider request timed out", {
      code: "V2_PROVIDER_TIMEOUT",
      category: "timeout",
      statusCode: 504,
      retryable: true,
      ...context
    });
  }
  return liveError(message || "Provider network request failed", {
    code: "V2_PROVIDER_NETWORK",
    category: "network",
    statusCode: 503,
    retryable: true,
    ...context
  });
}

function httpStatusError(response = {}, context = {}, clock = Date.now) {
  const status = Number(response.status || 0);
  if (status >= 200 && status < 300) return null;
  if (status === 429) {
    return liveError("Provider rate limit exceeded", {
      code: "V2_PROVIDER_RATE_LIMITED",
      category: "rate-limit",
      statusCode: 429,
      retryable: true,
      retryAfterMs: parseRetryAfterMs(response.headers, clock),
      ...context
    });
  }
  if (status === 401) {
    return liveError("Provider authentication failed", {
      code: "V2_PROVIDER_AUTH",
      category: "auth",
      statusCode: 502,
      retryable: false,
      ...context
    });
  }
  if (status === 403) {
    return liveError("Provider request was forbidden", {
      code: "V2_PROVIDER_FORBIDDEN",
      category: "forbidden",
      statusCode: 502,
      retryable: false,
      ...context
    });
  }
  if ([408, 504].includes(status)) {
    return liveError("Provider request timed out", {
      code: "V2_PROVIDER_TIMEOUT",
      category: "timeout",
      statusCode: 504,
      retryable: true,
      ...context
    });
  }
  if (status >= 500) {
    return liveError(`Provider returned HTTP ${status}`, {
      code: "V2_PROVIDER_UPSTREAM",
      category: "upstream",
      statusCode: 503,
      retryable: true,
      ...context
    });
  }
  return liveError(`Provider returned HTTP ${status || "unknown"}`, {
    code: "V2_PROVIDER_HTTP",
    category: "http",
    statusCode: 502,
    retryable: false,
    ...context
  });
}

function emptyResponseError(context = {}, message = "Provider returned an empty response") {
  return liveError(message, {
    code: "V2_PROVIDER_EMPTY",
    category: "empty",
    statusCode: 502,
    retryable: false,
    ...context
  });
}

function schemaError(message, context = {}) {
  return liveError(message, {
    code: "V2_PROVIDER_SCHEMA",
    category: "schema",
    statusCode: 502,
    retryable: false,
    ...context
  });
}

function disabledTransport() {
  throw liveError("Live provider transport is disabled", {
    code: "V2_LIVE_TRANSPORT_DISABLED",
    category: "configuration",
    statusCode: 503,
    retryable: false
  });
}
Object.defineProperty(disabledTransport, "transportKind", { value: "disabled" });

function createFetchTransport(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const transport = async (request = {}) => {
    const response = await fetchImpl(request.url, {
      method: request.method || "GET",
      headers: request.headers || {},
      body: request.body === undefined || request.body === null ? undefined : request.body,
      signal: request.signal,
      redirect: "error"
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      url: response.url || request.url,
      text
    };
  };
  Object.defineProperty(transport, "transportKind", { value: "fetch" });
  return transport;
}

async function normalizeTransportResponse(value, request) {
  if (!value || typeof value !== "object") return { status: 0, headers: {}, url: request.url, body: value };
  if (typeof value.text === "function") {
    return {
      status: Number(value.status || 0),
      headers: value.headers || {},
      url: value.url || request.url,
      body: await value.text()
    };
  }
  return {
    status: Number(value.status || 0),
    headers: value.headers || {},
    url: value.url || request.url,
    body: value.body !== undefined ? value.body : (value.data !== undefined ? value.data : value.text)
  };
}

function parseResponseBody(response, expected, context) {
  const body = response.body;
  if (body === undefined || body === null || (typeof body === "string" && !body.trim())) {
    throw emptyResponseError(context);
  }
  if (expected === "json" && typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      throw schemaError("Provider response was not valid JSON", context);
    }
  }
  return body;
}

function assertProviderPayload(payload, context = {}) {
  const serialized = typeof payload === "string" ? payload : stableJson(payload);
  if (/captcha|WtmCaptcha|ncpt\.naver\.com|access\s+denied|temporarily\s+blocked/i.test(serialized)) {
    throw liveError("Provider returned a challenge or block page", {
      code: "V2_PROVIDER_CHALLENGE",
      category: "auth",
      statusCode: 502,
      retryable: false,
      ...context
    });
  }
  const errors = payload && typeof payload === "object" && Array.isArray(payload.errors) ? payload.errors : [];
  if (errors.length) {
    const message = cleanText(errors.map((row) => row?.message || row).join("; "), 300) || "Provider GraphQL error";
    throw liveError(message, {
      code: /auth|unauthor|forbidden|permission/i.test(message) ? "V2_PROVIDER_AUTH" : "V2_PROVIDER_SCHEMA",
      category: /auth|unauthor|forbidden|permission/i.test(message) ? "auth" : "schema",
      statusCode: 502,
      retryable: false,
      ...context
    });
  }
  return payload;
}

function jsonEnd(source, start) {
  const opening = source[start];
  const closing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!closing) return -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function extractApolloState(html) {
  const source = String(html || "");
  const marker = /window\.__APOLLO_STATE__\s*=\s*/g;
  const match = marker.exec(source);
  if (!match) throw schemaError("Naver Apollo state was not found");
  const start = match.index + match[0].length;
  const end = jsonEnd(source, start);
  if (end < 0) throw schemaError("Naver Apollo state JSON did not terminate");
  try {
    return JSON.parse(source.slice(start, end));
  } catch {
    throw schemaError("Naver Apollo state was not valid JSON");
  }
}

function parseRootKey(key) {
  const start = String(key || "").indexOf("(");
  const end = String(key || "").lastIndexOf(")");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(String(key).slice(start + 1, end));
  } catch {
    return null;
  }
}

function pickNaverSearchKey(state, query) {
  const keys = Object.keys(state?.ROOT_QUERY || {});
  const exact = keys.find((key) => {
    if (!key.startsWith("accommodationSearch(") || key.includes("filterOpening")) return false;
    const parsed = parseRootKey(key);
    return parsed?.input?.query === query;
  });
  return exact || "";
}

function pickNaverPlaceListKey(state, query) {
  const keys = Object.keys(state?.ROOT_QUERY || {});
  const exact = keys.find((key) => key.startsWith("placeList(") && parseRootKey(key)?.input?.query === query);
  return exact || "";
}

function pickNaverAdKey(state, query) {
  const keys = Object.keys(state?.ROOT_QUERY || {});
  const exact = keys.find((key) => {
    if (!key.startsWith("adBusinesses(") || key.includes('"channel":"openingPlace"')) return false;
    return parseRootKey(key)?.input?.query === query;
  });
  return exact || "";
}

function dereference(state, value) {
  if (!value || typeof value !== "object") return null;
  if (value.__ref) return state[value.__ref] || null;
  return value;
}

function roomPrice(state, item = {}) {
  const direct = numeric(item.minPrice ?? item.matchRoomMinPrice ?? item.price);
  const roomPrices = (Array.isArray(item.roomImages) ? item.roomImages : [])
    .map((row) => dereference(state, row))
    .map((row) => numeric(row?.minPrice ?? row?.price))
    .filter((row) => row !== null);
  return roomPrices.length ? Math.min(...roomPrices) : direct;
}

function stripMarkup(value) {
  return cleanText(String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code) || 0xfffd)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16) || 0xfffd)))
    .replace(/&(?:amp|#38);/gi, "&")
    .replace(/&(?:lt|#60);/gi, "<")
    .replace(/&(?:gt|#62);/gi, ">")
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39);/gi, "'"), 240);
}

function stableNaverApiHubLocalIdentity(item = {}) {
  const publicIdentity = {
    source: "naver-api-hub-local",
    title: normalizeCompanyName(stripMarkup(item.title || item.name)),
    link: cleanText(item.link, 500),
    address: cleanText(item.address, 240),
    roadAddress: cleanText(item.roadAddress, 240),
    mapx: cleanText(item.mapx, 64),
    mapy: cleanText(item.mapy, 64)
  };
  return `local_${crypto.createHash("sha256").update(stableJson(publicIdentity), "utf8").digest("hex")}`;
}

function normalizeNaverApiHubLocalItem(item = {}, options = {}) {
  const title = stripMarkup(item.title || item.name);
  const address = cleanText(item.address, 240);
  const roadAddress = cleanText(item.roadAddress, 240);
  const mapx = cleanText(item.mapx, 64);
  const mapy = cleanText(item.mapy, 64);
  return {
    placeId: stableNaverApiHubLocalIdentity({ ...item, title, address, roadAddress, mapx, mapy }),
    identitySource: "naver-api-hub-local",
    bookingBusinessId: "",
    name: title,
    title,
    link: cleanText(item.link, 500),
    category: stripMarkup(item.category),
    address,
    roadAddress,
    mapx,
    mapy,
    rank: Number(options.rank || 0) || null,
    reviewCount: null,
    rating: null,
    price: null,
    hasBooking: false,
    latitude: null,
    longitude: null,
    url: cleanText(item.link, 500),
    ad: false
  };
}

function parseNaverApiHubLocalPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.items)) {
    throw schemaError("Naver API HUB Local Search response did not contain an item array");
  }
  if (payload.items.length > 5) {
    throw schemaError("Naver API HUB Local Search response exceeded the approved display bound");
  }
  return {
    total: numeric(payload.total) ?? payload.items.length,
    start: numeric(payload.start) ?? 1,
    display: numeric(payload.display) ?? payload.items.length,
    items: payload.items.map((row, index) => normalizeNaverApiHubLocalItem(row, { rank: index + 1 })),
    ads: []
  };
}

function normalizeNaverSearchItem(item = {}, options = {}) {
  const value = item?.data && typeof item.data === "object" ? item.data : item;
  const placeId = cleanText(value.id || value.placeId || value.place_id, 120);
  const booking = value.naverBooking || value.booking || {};
  return {
    placeId,
    bookingBusinessId: cleanText(value.bookingBusinessId || booking.bookingBusinessId, 120),
    name: cleanText(value.name || value.title || value.companyName, 180),
    category: cleanText(value.category || value.businessCategory, 120),
    address: cleanText(value.commonAddress || value.roadAddress || value.address || value.location, 240),
    rank: Number(options.rank || value.rank || 0) || null,
    reviewCount: numeric(value.totalReviewCount ?? value.blogCafeReviewCount ?? value.reviewCount ?? value.review?.count),
    rating: numeric(value.placeReviewScore ?? value.rating ?? value.review?.score),
    price: roomPrice(options.state || {}, value),
    hasBooking: value.hasBooking === true || Boolean(value.bookingBusinessId || booking.bookingBusinessId),
    latitude: numeric(value.y ?? value.latitude ?? value.lat),
    longitude: numeric(value.x ?? value.longitude ?? value.lng),
    url: cleanText(value.url || value.placeUrl || (placeId ? `https://pcmap.place.naver.com/accommodation/${placeId}` : ""), 500),
    ad: Boolean(options.ad || value.adId || value.adText)
  };
}

function directArray(value) {
  const candidates = [
    value?.items,
    value?.results,
    value?.businesses,
    value?.data?.items,
    value?.data?.results,
    value?.data?.businesses,
    value?.data?.business?.items
  ];
  return candidates.find(Array.isArray);
}

function parseNaverSearchPayload(payload, options = {}) {
  const query = cleanText(options.query, 180);
  if (payload && typeof payload === "object" && !Array.isArray(payload) && !payload.ROOT_QUERY) {
    const rows = directArray(payload);
    if (!rows) throw schemaError("Naver search response did not contain an item array");
    return {
      total: numeric(payload.total ?? payload.data?.total) ?? rows.length,
      items: rows.map((row, index) => normalizeNaverSearchItem(row, { rank: index + 1 })),
      ads: (Array.isArray(payload.ads) ? payload.ads : []).map((row, index) => normalizeNaverSearchItem(row, { rank: index + 1, ad: true }))
    };
  }
  const state = typeof payload === "string" ? extractApolloState(payload) : payload;
  if (!state?.ROOT_QUERY || typeof state.ROOT_QUERY !== "object") throw schemaError("Naver search response did not contain ROOT_QUERY");
  const searchKey = pickNaverSearchKey(state, query) || pickNaverPlaceListKey(state, query);
  const adKey = pickNaverAdKey(state, query);
  if (!searchKey && !adKey) throw schemaError("Naver search response did not contain a supported search contract");
  const searchResult = searchKey ? state.ROOT_QUERY[searchKey] : null;
  const placeList = searchKey?.startsWith("placeList(");
  const refs = searchResult
    ? (placeList ? searchResult.businesses?.items : searchResult.business?.items) || []
    : [];
  const adRefs = adKey ? state.ROOT_QUERY[adKey]?.items || [] : [];
  return {
    total: numeric(placeList ? searchResult?.businesses?.total : searchResult?.business?.total) ?? refs.length,
    items: refs.map((row, index) => normalizeNaverSearchItem(dereference(state, row) || {}, { state, rank: index + 1 })),
    ads: adRefs.map((row, index) => normalizeNaverSearchItem(dereference(state, row) || {}, { state, rank: index + 1, ad: true }))
  };
}

function normalizeCompanyName(value) {
  return cleanText(value, 180)
    .toLowerCase()
    .replace(/(?:주식회사|유한회사|㈜)/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function companyNameScore(candidate, target) {
  const left = normalizeCompanyName(candidate);
  const right = normalizeCompanyName(target);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;
  const targetCharacters = new Set([...right]);
  const overlap = [...new Set([...left])].filter((character) => targetCharacters.has(character)).length;
  return Math.round((overlap / Math.max(left.length, right.length)) * 60);
}

function normalizeRegionText(value) {
  return cleanText(value, 180).toLowerCase()
    .replace(/경상남도/g, "경남")
    .replace(/경상북도/g, "경북")
    .replace(/전라남도/g, "전남")
    .replace(/전라북도|전북특별자치도/g, "전북")
    .replace(/충청남도/g, "충남")
    .replace(/충청북도/g, "충북")
    .replace(/강원특별자치도|강원도/g, "강원")
    .replace(/제주특별자치도/g, "제주")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function regionMatches(address, regionHint) {
  const expected = normalizeRegionText(regionHint);
  if (!expected) return true;
  const actual = normalizeRegionText(address);
  return Boolean(actual && (actual.includes(expected) || expected.includes(actual)));
}

function selectNaverCompany(result = {}, targetName = "", regionHint = "") {
  const rows = [...(result.items || []), ...(result.ads || [])]
    .filter((row) => row?.name && regionMatches(`${row.address || ""} ${row.roadAddress || ""}`, regionHint));
  if (!rows.length) return null;
  const ranked = rows
    .map((row, index) => ({ row, index, score: companyNameScore(row.name, targetName) }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (ranked[0].score < 80) return null;
  if (ranked[1] && ranked[1].score === ranked[0].score && ranked[1].row.placeId !== ranked[0].row.placeId) return null;
  return ranked[0].row;
}

function parseBookingBusinessPayload(payload) {
  const row = payload?.data?.business?.naverBooking || payload?.business?.naverBooking || payload?.naverBooking || payload;
  if (!row || typeof row !== "object") throw schemaError("Naver booking business response had an invalid schema");
  return {
    bookingBusinessId: cleanText(row.bookingBusinessId || row.businessId, 120),
    bookingUrl: cleanText(row.naverBookingUrl || row.naverBookingHubUrl || row.bookingUrl, 500)
  };
}

function parseBookingItemsPayload(payload) {
  const rows = payload?.data?.searchBizItem?.bizItems
    ?? payload?.searchBizItem?.bizItems
    ?? payload?.bizItems
    ?? payload?.items
    ?? payload?.products;
  if (!Array.isArray(rows)) throw schemaError("Naver booking item response did not contain bizItems");
  return rows;
}

function parseDailySchedulePayload(payload, targetDate) {
  if (payload?.schedule && typeof payload.schedule === "object" && !payload?.data?.schedule) return payload.schedule;
  if (payload?.day && typeof payload.day === "object") return payload.day;
  const scheduleRoot = payload?.data?.schedule ?? payload?.schedule;
  if (!scheduleRoot || typeof scheduleRoot !== "object") throw schemaError("Naver booking schedule response did not contain schedule data");
  const dates = scheduleRoot?.bizItemSchedule?.daily?.date;
  if (!dates || typeof dates !== "object") return null;
  return dates[targetDate] || null;
}

function itemPrice(item = {}, targetDate = "") {
  const dated = item.priceByDates && typeof item.priceByDates === "object" ? item.priceByDates[targetDate] : null;
  return numeric(dated?.price ?? dated ?? item.price ?? item.minMaxPrice?.minPrice);
}

function normalizeBookingProducts(items = [], schedules = new Map(), targetDate = "", maximum = 8) {
  return items.slice(0, maximum).map((item, index) => {
    const itemId = cleanText(item.bizItemId || item.id || `item-${index + 1}`, 120);
    const schedule = schedules.get(itemId) || schedules.get(cleanText(item.id, 120)) || null;
    const totalStock = numeric(schedule?.totalStock ?? schedule?.stock ?? item.totalStock);
    const explicitAvailable = numeric(schedule?.availableStock ?? item.availableStock);
    const used = Math.max(0, numeric(schedule?.bookingCount) || 0) + Math.max(0, numeric(schedule?.occupiedBookingCount) || 0);
    const open = schedule ? schedule.isBusinessDay !== false && schedule.isSaleDay !== false : null;
    const availableStock = explicitAvailable !== null
      ? explicitAvailable
      : (totalStock === null ? null : (open === false ? 0 : Math.max(0, totalStock - used)));
    return {
      productKey: `naver:${itemId}`,
      targetDate,
      price: numeric(schedule?.price) ?? itemPrice(item, targetDate),
      totalStock,
      availableStock,
      productName: cleanText(item.name, 180),
      bookingBusinessId: cleanText(item.businessId, 120),
      sourceItemId: itemId
    };
  });
}

function parseNolPayload(payload) {
  const rows = payload?.items ?? payload?.data?.items;
  if (!Array.isArray(rows)) throw schemaError("NOL response did not contain items");
  return rows
    .filter((row) => !row?.type || row.type === "PRODUCT_ITEM")
    .map((row, index) => {
      const value = row.data || row;
      return {
        name: cleanText(value.title || value.name, 180),
        externalId: cleanText(value.id || value.productId || row.serverLogMeta?.productId, 120),
        rank: index + 1,
        url: cleanText(value.action?.web || value.url, 500)
      };
    });
}

function parseDdnayoPayload(payload) {
  const rows = payload?.data?.contents ?? payload?.contents ?? payload?.items;
  if (!Array.isArray(rows)) throw schemaError("Ddnayo response did not contain contents");
  return rows.map((row, index) => ({
    name: cleanText(row.accommodationName || row.name, 180),
    externalId: cleanText(row.accommodationId || row.productId || row.id, 120),
    rank: index + 1,
    url: cleanText(row.productUrl || row.url, 500)
  }));
}

function exposedForTarget(rows, targetName) {
  return rows.some((row) => companyNameScore(row.name, targetName) >= 80);
}

function runKeyForInput(input = {}) {
  const explicit = cleanText(input.runId || input.clientRequestId || input.requestId, 160);
  if (explicit) return explicit;
  const fallback = stableJson({
    targetName: normalizeCompanyName(input.targetName || input.keyword || input.companyName),
    targetDate: cleanText(input.targetDate, 16),
    tenantCompanyId: cleanText(input.tenantCompanyId, 160)
  });
  return `anonymous_${crypto.createHash("sha256").update(fallback).digest("hex").slice(0, 24)}`;
}

function targetNameForInput(input = {}) {
  const value = cleanText(input.targetName || input.keyword || input.companyName, 180);
  if (!value) throw liveError("targetName is required", {
    code: "V2_LIVE_TARGET_REQUIRED",
    category: "input",
    statusCode: 400,
    retryable: false
  });
  return value;
}

function targetDateForInput(input = {}, clock = Date.now) {
  const value = cleanText(input.targetDate, 16) || new Date(nowValue(clock)).toISOString().slice(0, 10);
  return strictCalendarDate(value);
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function boundedDateRange(startValue, endValue, maximum = 31) {
  const start = strictCalendarDate(startValue, "checkIn");
  const end = strictCalendarDate(endValue || start, "checkOut");
  if (Date.parse(`${end}T00:00:00.000Z`) < Date.parse(`${start}T00:00:00.000Z`)) {
    throw liveError("checkOut must not precede checkIn", {
      code: "V2_LIVE_TARGET_DATE_INVALID",
      category: "input",
      statusCode: 400,
      retryable: false
    });
  }
  const dates = [];
  for (let date = start; date <= end && dates.length < maximum; date = nextDate(date)) dates.push(date);
  return dates;
}

function normalizeAllowlist(value = {}) {
  const result = {};
  for (const provider of ALL_PROVIDER_KEYS) {
    const rows = Array.isArray(value[provider]) ? value[provider] : [];
    result[provider] = new Set(rows.map((row) => String(row || "").trim().toLowerCase()).filter(Boolean));
  }
  return result;
}

function createV2LiveCollectionProvider(options = {}) {
  const clock = options.clock || Date.now;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const transport = typeof options.transport === "function" ? options.transport : disabledTransport;
  const liveEnabled = options.liveEnabled === true;
  const naverSearchMode = cleanText(options.naverSearchMode || NAVER_SEARCH_MODES.disabled, 32).toLowerCase();
  const naverApiHubKeyId = String(options.naverApiHubKeyId || "").trim();
  const naverApiHubKey = String(options.naverApiHubKey || "").trim();
  const naverApiHubSort = cleanText(options.naverApiHubSort || "random", 16).toLowerCase();
  const approvalHash = String(options.liveApprovalTokenSha256 || "").toLowerCase();
  const quotaRepository = options.quotaRepository;
  let approvalManifest = null;
  let approvalManifestError = null;
  try {
    approvalManifest = normalizeApprovalManifest(options.approvalManifest);
  } catch (error) {
    approvalManifestError = error;
  }
  const seedSourceUrl = cleanText(options.seedSourceUrl, 500);
  const seedSourceProvider = cleanText(options.seedSourceProvider || PROVIDER_KEYS.naverSearch, 64);
  const approvedProviders = new Set(Array.isArray(options.approvedProviders) ? options.approvedProviders : []);
  const killSwitches = Object.fromEntries(ALL_PROVIDER_KEYS.map((provider) => [provider, options.killSwitches?.[provider] !== false]));
  const hostnameAllowlist = normalizeAllowlist(options.hostnameAllowlist);
  if (naverSearchMode === NAVER_SEARCH_MODES.apiHub) {
    const officialHostConfigured = hostnameAllowlist[PROVIDER_KEYS.naverSearch].has(NAVER_API_HUB_LOCAL_HOST);
    hostnameAllowlist[PROVIDER_KEYS.naverSearch] = new Set(officialHostConfigured ? [NAVER_API_HUB_LOCAL_HOST] : []);
  }
  const endpointBuilders = { ...DEFAULT_ENDPOINT_BUILDERS, ...(options.endpointBuilders || {}) };
  const otaProviders = (Array.isArray(options.otaProviders) ? options.otaProviders : [PROVIDER_KEYS.nol, PROVIDER_KEYS.ddnayo])
    .filter((provider) => [PROVIDER_KEYS.nol, PROVIDER_KEYS.ddnayo].includes(provider));
  const requestedStages = [...new Set(
    (Array.isArray(options.requestedStages) ? options.requestedStages : LIVE_STAGES)
      .map((stage) => cleanText(stage, 32).toLowerCase())
      .filter((stage) => LIVE_STAGES.includes(stage))
  )];
  const budget = Object.freeze({
    perRun: positiveInteger(options.requestBudget?.perRun, 0, 10_000),
    perDay: positiveInteger(options.requestBudget?.perDay, 0, 1_000_000)
  });
  const timeoutMs = Math.max(1, positiveInteger(options.timeoutMs, 15_000, 120_000));
  const maxAttempts = Math.max(1, Math.min(5, positiveInteger(options.maxAttempts, 2, 5)));
  const baseBackoffMs = positiveInteger(options.baseBackoffMs, 500, 300_000);
  const maximumBackoffMs = Math.max(baseBackoffMs, positiveInteger(options.maximumBackoffMs, 30_000, 900_000));
  const maximumProducts = Math.max(1, Math.min(20, positiveInteger(options.maximumProducts, 8, 20)));
  const requestCache = new Map();
  const inFlight = new Map();
  const runContexts = new Map();
  const metrics = {
    transportAttempts: 0,
    externalNetworkCalls: 0,
    cacheHits: 0,
    retries: 0,
    failures: {},
    attemptsByProvider: {}
  };

  function redactSecrets(value) {
    let text = String(value ?? "");
    for (const secret of [naverApiHubKeyId, naverApiHubKey].filter(Boolean)) {
      text = text.split(secret).join("[redacted]");
    }
    return text;
  }

  function sanitizedFailure(reason, context = {}) {
    const message = redactSecrets(reason?.message || reason || "Provider request failed");
    if (reason instanceof V2LiveCollectionError) {
      let details = reason.details;
      if (details) {
        try {
          details = JSON.parse(redactSecrets(JSON.stringify(details)));
        } catch {
          details = null;
        }
      }
      return liveError(message, {
        code: reason.code,
        category: reason.category,
        statusCode: reason.statusCode,
        retryable: reason.retryable,
        retryAfterMs: reason.retryAfterMs,
        provider: context.provider || reason.provider,
        operation: context.operation || reason.operation,
        requestKey: context.requestKey || reason.requestKey,
        details
      });
    }
    const safe = new Error(message);
    safe.name = cleanText(reason?.name || "Error", 80) || "Error";
    safe.code = cleanText(reason?.code, 120);
    return classifyProviderFailure(safe, context);
  }

  function approvalValid() {
    if (!approvalManifest || approvalManifestError) return false;
    return timingSafeHexEqual(approvalManifestDigest(approvalManifest), approvalHash);
  }

  function providersForRequestedStages() {
    const providers = new Set();
    if (requestedStages.some((stage) => ["discovery", "quick", "detail"].includes(stage))) {
      providers.add(PROVIDER_KEYS.naverSearch);
    }
    if (requestedStages.includes("detail")) providers.add(PROVIDER_KEYS.naverBooking);
    if (requestedStages.includes("ota")) otaProviders.forEach((provider) => providers.add(provider));
    return [...providers];
  }

  function providersForStage(stage) {
    if (["discovery", "quick"].includes(stage)) return [PROVIDER_KEYS.naverSearch];
    if (stage === "detail") return [PROVIDER_KEYS.naverSearch, PROVIDER_KEYS.naverBooking];
    if (stage === "ota") return [...otaProviders];
    return [];
  }

  function readiness() {
    const reasons = [];
    const requiredProviders = providersForRequestedStages();
    if (!requestedStages.length) reasons.push("requested-stage-empty");
    if (!liveEnabled) reasons.push("live-disabled");
    if (approvalManifestError || !approvalManifest) reasons.push("approval-manifest-invalid");
    else {
      if (!approvalValid()) reasons.push("approval-manifest-digest-invalid");
      if (nowValue(clock) < Date.parse(approvalManifest.issuedAt)) reasons.push("approval-not-active");
      if (nowValue(clock) >= Date.parse(approvalManifest.expiresAt)) reasons.push("approval-expired");
      if (budget.perRun !== approvalManifest.requestCaps.perRun) reasons.push("per-run-budget-manifest-mismatch");
      if (budget.perDay !== approvalManifest.requestCaps.perDay) reasons.push("daily-budget-manifest-mismatch");
      for (const stage of requestedStages) {
        if (!approvalManifest.stages.includes(stage)) reasons.push(`stage-not-approved:${stage}`);
      }
    }
    if (transport === disabledTransport || transport.transportKind === "disabled") reasons.push("transport-disabled");
    if (!quotaRepository || typeof quotaRepository.reserveProviderRequest !== "function") reasons.push("durable-quota-repository-required");
    if (budget.perRun < 1) reasons.push("per-run-budget-disabled");
    if (budget.perDay < 1) reasons.push("daily-budget-disabled");
    if (!seedSourceUrl) reasons.push("seed-source-missing");
    if (naverSearchMode === NAVER_SEARCH_MODES.disabled) reasons.push("naver-search-mode-disabled");
    else if (![NAVER_SEARCH_MODES.apiHub, NAVER_SEARCH_MODES.internalWeb].includes(naverSearchMode)) {
      reasons.push("naver-search-mode-invalid");
    } else if (naverSearchMode === NAVER_SEARCH_MODES.apiHub) {
      if (!naverApiHubKeyId || !naverApiHubKey) reasons.push("naver-api-hub-credentials-missing");
      if (!NAVER_API_HUB_SORTS.includes(naverApiHubSort)) reasons.push("naver-api-hub-sort-invalid");
    }
    for (const provider of requiredProviders) {
      if (!approvedProviders.has(provider)) reasons.push(`provider-not-approved:${provider}`);
      if (approvalManifest && !approvalManifest.providers.includes(provider)) reasons.push(`provider-not-in-manifest:${provider}`);
      if (killSwitches[provider] !== false) reasons.push(`kill-switch-open:${provider}`);
      if (!hostnameAllowlist[provider]?.size) reasons.push(`hostname-allowlist-empty:${provider}`);
    }
    if (!hostnameAllowlist[seedSourceProvider]?.size) reasons.push(`hostname-allowlist-empty:${seedSourceProvider}`);
    if (seedSourceUrl && hostnameAllowlist[seedSourceProvider]?.size) {
      try {
        validatedUrl(seedSourceProvider, seedSourceUrl);
      } catch (error) {
        reasons.push(`seed-source-invalid:${error.code || "unknown"}`);
      }
    }
    const endpointNames = new Set();
    if (requestedStages.some((stage) => ["discovery", "quick", "detail"].includes(stage))) {
      if (naverSearchMode === NAVER_SEARCH_MODES.apiHub) endpointNames.add("apiHubSearch");
      if (naverSearchMode === NAVER_SEARCH_MODES.internalWeb) endpointNames.add("search");
    }
    if (requestedStages.includes("detail")) {
      endpointNames.add("bookingBusiness");
      endpointNames.add("bookingItems");
      endpointNames.add("bookingSchedule");
    }
    if (requestedStages.includes("ota")) otaProviders.forEach((provider) => endpointNames.add(provider));
    for (const endpointName of endpointNames) {
      if (typeof endpointBuilders[endpointName] !== "function") reasons.push(`endpoint-builder-missing:${endpointName}`);
    }
    return {
      ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      requestedStages: [...requestedStages],
      requiredProviders
    };
  }

  function assertProviderName(provider) {
    if (!ALL_PROVIDER_KEYS.includes(provider)) {
      throw liveError(`Unsupported live provider: ${provider}`, {
        code: "V2_LIVE_PROVIDER_INVALID",
        category: "configuration",
        statusCode: 500,
        retryable: false,
        provider
      });
    }
  }

  function assertNaverSearchModeReady() {
    if (![NAVER_SEARCH_MODES.apiHub, NAVER_SEARCH_MODES.internalWeb].includes(naverSearchMode)) {
      throw liveError("Naver Search transport mode is disabled or invalid", {
        code: "V2_LIVE_NAVER_SEARCH_MODE_DISABLED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider: PROVIDER_KEYS.naverSearch
      });
    }
    if (naverSearchMode === NAVER_SEARCH_MODES.apiHub
      && (!naverApiHubKeyId || !naverApiHubKey || !NAVER_API_HUB_SORTS.includes(naverApiHubSort))) {
      throw liveError("Naver API HUB Local Search credentials or sort contract are not configured", {
        code: "V2_LIVE_NAVER_API_HUB_CONFIGURATION_REQUIRED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider: PROVIDER_KEYS.naverSearch
      });
    }
  }

  function validatedUrl(provider, value, validation = {}) {
    assertProviderName(provider);
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      throw liveError("Provider endpoint URL is invalid", {
        code: "V2_LIVE_ENDPOINT_INVALID",
        category: "configuration",
        statusCode: 500,
        retryable: false,
        provider
      });
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw liveError("Provider endpoint must be credential-free HTTPS", {
        code: "V2_LIVE_ENDPOINT_FORBIDDEN",
        category: "configuration",
        statusCode: 500,
        retryable: false,
        provider
      });
    }
    if (!hostnameAllowlist[provider]?.has(parsed.hostname.toLowerCase())) {
      throw liveError(`Provider hostname is not allowlisted: ${parsed.hostname}`, {
        code: "V2_LIVE_HOST_NOT_ALLOWED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (provider === PROVIDER_KEYS.naverSearch && naverSearchMode === NAVER_SEARCH_MODES.apiHub) {
      if (parsed.hostname.toLowerCase() !== NAVER_API_HUB_LOCAL_HOST || parsed.port || parsed.pathname !== NAVER_API_HUB_LOCAL_PATH) {
        throw liveError("Naver API HUB Local Search endpoint is outside the official contract", {
          code: "V2_LIVE_NAVER_API_HUB_ENDPOINT_INVALID",
          category: "configuration",
          statusCode: 503,
          retryable: false,
          provider
        });
      }
      if (validation.outbound === true) {
        const allowedParameters = new Set(["query", "display", "start", "sort"]);
        const parameters = [...parsed.searchParams.keys()];
        const display = Number(parsed.searchParams.get("display"));
        const start = Number(parsed.searchParams.get("start"));
        const sort = parsed.searchParams.get("sort") || "";
        if (!cleanText(parsed.searchParams.get("query"), 180)
          || parameters.some((name) => !allowedParameters.has(name))
          || parameters.length !== 4 || new Set(parameters).size !== 4
          || !Number.isInteger(display) || display < 1 || display > 5
          || start !== 1
          || !NAVER_API_HUB_SORTS.includes(sort)) {
          throw liveError("Naver API HUB Local Search request is outside the bounded official contract", {
            code: "V2_LIVE_NAVER_API_HUB_REQUEST_INVALID",
            category: "configuration",
            statusCode: 503,
            retryable: false,
            provider
          });
        }
      }
    }
    return parsed.toString();
  }

  function approvedTarget(input = {}) {
    if (!approvalManifest) return null;
    const targetName = normalizeCompanyName(input.targetName || input.keyword || input.companyName);
    const regionCode = cleanText(input.regionCode || input.regionLabel, 80).toLowerCase();
    const targetDate = targetDateForInput(input, clock);
    return approvalManifest.targets.find((target) => (
      normalizeCompanyName(target.targetName) === targetName
      && target.regionCode === regionCode
      && target.targetDates.includes(targetDate)
    )) || null;
  }

  function assertApprovalScope(provider, stage, input = {}) {
    if (!approvalValid()) {
      throw liveError("An exact approval manifest digest is required", {
        code: "V2_LIVE_APPROVAL_REQUIRED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider
      });
    }
    const now = nowValue(clock);
    if (now < Date.parse(approvalManifest.issuedAt) || now >= Date.parse(approvalManifest.expiresAt)) {
      throw liveError("The live approval manifest is not active", {
        code: "V2_LIVE_APPROVAL_EXPIRED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider
      });
    }
    if (!approvalManifest.stages.includes(stage)
      || !approvalManifest.providers.includes(provider)
      || !approvalManifest.providerCaps[provider]?.stages.includes(stage)) {
      throw liveError("Provider stage is outside the approved live scope", {
        code: "V2_LIVE_STAGE_NOT_APPROVED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider,
        operation: stage
      });
    }
    const target = approvedTarget(input);
    if (!target) {
      throw liveError("Collection target or target date is outside the approved live scope", {
        code: "V2_LIVE_TARGET_NOT_APPROVED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider,
        operation: stage
      });
    }
    return target;
  }

  function assertProviderReady(provider, url, stage, input = {}) {
    assertProviderName(provider);
    if (!liveEnabled) {
      throw liveError("V2 live collection is disabled", {
        code: "V2_LIVE_DISABLED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    assertApprovalScope(provider, stage, input);
    if (!approvedProviders.has(provider)) {
      throw liveError(`Provider is outside the approved live scope: ${provider}`, {
        code: "V2_LIVE_PROVIDER_NOT_APPROVED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider
      });
    }
    if (provider === PROVIDER_KEYS.naverSearch) assertNaverSearchModeReady();
    if (killSwitches[provider] !== false) {
      throw liveError(`Provider kill switch is open: ${provider}`, {
        code: "V2_LIVE_KILL_SWITCH_OPEN",
        category: "kill-switch",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (transport === disabledTransport || transport.transportKind === "disabled") {
      throw liveError("Live provider transport is disabled", {
        code: "V2_LIVE_TRANSPORT_DISABLED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (budget.perRun < 1 || budget.perDay < 1) {
      throw liveError("Live request budget must be explicitly positive", {
        code: "V2_LIVE_BUDGET_REQUIRED",
        category: "quota",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (budget.perRun !== approvalManifest.requestCaps.perRun || budget.perDay !== approvalManifest.requestCaps.perDay) {
      throw liveError("Runtime request budgets must exactly match the approved manifest", {
        code: "V2_LIVE_BUDGET_MANIFEST_MISMATCH",
        category: "quota",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (!quotaRepository || typeof quotaRepository.reserveProviderRequest !== "function") {
      throw liveError("A durable provider quota repository is required", {
        code: "V2_LIVE_DURABLE_QUOTA_REQUIRED",
        category: "quota",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    if (!seedSourceUrl) {
      throw liveError("An approved seedSourceUrl is required", {
        code: "V2_LIVE_SEED_SOURCE_REQUIRED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider
      });
    }
    validatedUrl(seedSourceProvider, seedSourceUrl);
    return validatedUrl(provider, url, { outbound: true });
  }

  async function reserveBudget(provider, stage, runKey, requestKey, input = {}) {
    const target = assertApprovalScope(provider, stage, input);
    const providerCap = approvalManifest.providerCaps[provider];
    try {
      return await quotaRepository.reserveProviderRequest({
        reservationId: `provider_reservation_${crypto.randomUUID()}`,
        approvalId: approvalManifest.approvalId,
        approvalDigest: approvalHash,
        provider,
        stage,
        runId: runKey,
        requestKey,
        targetHash: crypto.createHash("sha256").update(stableJson(target)).digest("hex"),
        day: dayKey(clock),
        costMicros: providerCap.costMicros,
        currency: approvalManifest.cost.currency,
        caps: {
          perRun: approvalManifest.requestCaps.perRun,
          perDay: approvalManifest.requestCaps.perDay,
          providerPerRun: providerCap.perRun,
          providerPerDay: providerCap.perDay,
          maximumCostMicros: approvalManifest.cost.maximumCostMicros
        }
      }, { type: "worker", id: "v2-live-provider-quota" });
    } catch (error) {
      throw liveError(error.message || "Live provider request quota exceeded", {
        code: error.code === "FRESH_PROVIDER_QUOTA_EXCEEDED"
          ? "V2_LIVE_REQUEST_BUDGET_EXCEEDED"
          : (error.code || "V2_LIVE_DURABLE_QUOTA_FAILED"),
        category: "quota",
        statusCode: Number(error.statusCode || 503),
        retryable: false,
        provider,
        operation: stage,
        requestKey
      });
    }
  }

  function assertRequestScope(input = {}, executionStages = [], collectionPlan = {}) {
    const detailDates = collectionPlan.collectWeeklyRange === true
      ? boundedDateRange(collectionPlan.checkIn || input.checkIn || input.targetDate, collectionPlan.checkOut || input.checkOut || input.targetDate)
      : [targetDateForInput(input, clock)];
    const estimate = collectionPlan.requestEstimate && typeof collectionPlan.requestEstimate === "object"
      ? collectionPlan.requestEstimate
      : {};
    const estimatedCalls = {
      [PROVIDER_KEYS.naverSearch]: Math.max(0, Number(estimate.discovery || 0)) + Math.max(0, Number(estimate.quick || 0)),
      [PROVIDER_KEYS.naverBooking]: Math.max(0, Number(estimate.detail || 0)) + Math.max(0, Number(estimate.leadtime || 0))
    };
    const otaEstimate = Math.max(0, Number(estimate.ota || 0));
    for (const provider of otaProviders) estimatedCalls[provider] = Math.ceil(otaEstimate / Math.max(1, otaProviders.length));
    const estimatedRequestTotal = Math.max(0, Number(estimate.total || Object.values(estimatedCalls).reduce((sum, value) => sum + value, 0)));
    const estimatedCostMicros = Object.entries(estimatedCalls).reduce((sum, [provider, calls]) => (
      sum + calls * Math.max(0, Number(approvalManifest?.providerCaps?.[provider]?.costMicros || 0))
    ), 0);
    if (estimatedRequestTotal > 0 && approvalManifest && approvalValid() && (
      approvalManifest.requestCaps.perRun < estimatedRequestTotal
      || approvalManifest.requestCaps.perDay < estimatedRequestTotal
      || Object.entries(estimatedCalls).some(([provider, calls]) => calls > 0 && (
        approvalManifest.providerCaps[provider]?.perRun < calls
        || approvalManifest.providerCaps[provider]?.perDay < calls
      ))
      || approvalManifest.cost.maximumCostMicros < estimatedCostMicros
    )) {
      throw liveError("Approved provider caps cannot cover the bounded collection plan", {
        code: "V2_LIVE_PLAN_BUDGET_INSUFFICIENT",
        category: "quota",
        statusCode: 503,
        retryable: false,
        details: { estimatedRequestTotal, estimatedCalls, estimatedCostMicros }
      });
    }
    for (const stage of executionStages.filter((value) => LIVE_STAGES.includes(value))) {
      if (!requestedStages.includes(stage)) {
        throw liveError(`Collection stage is not enabled by runtime configuration: ${stage}`, {
          code: "V2_LIVE_STAGE_NOT_CONFIGURED",
          category: "configuration",
          statusCode: 503,
          retryable: false,
          operation: stage
        });
      }
      const stageInputs = stage === "detail" && collectionPlan.collectWeeklyRange === true
        ? detailDates.map((targetDate) => ({ ...input, targetDate }))
        : [input];
      for (const stageInput of stageInputs) {
        for (const provider of providersForStage(stage)) assertApprovalScope(provider, stage, stageInput);
      }
    }
    return {
      approvalId: approvalManifest?.approvalId || "",
      targetDate: targetDateForInput(input, clock),
      detailTargetDates: detailDates,
      estimatedRequestTotal,
      estimatedCalls,
      estimatedCostMicros,
      executionStages: [...executionStages]
    };
  }

  async function callTransportWithTimeout(request) {
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(liveError("Provider request timed out", {
          code: "V2_PROVIDER_TIMEOUT",
          category: "timeout",
          statusCode: 504,
          retryable: true,
          provider: request.provider,
          operation: request.operation,
          requestKey: request.requestKey
        }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => transport({ ...request, signal: controller.signal, timeoutMs })),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestWithPolicy(provider, operation, runKey, request = {}, approval = {}) {
    const stage = cleanText(approval.stage, 32).toLowerCase();
    const approvalInput = approval.input || {};
    const url = assertProviderReady(provider, request.url, stage, approvalInput);
    const normalized = {
      provider,
      operation,
      runKey,
      method: cleanText(request.method || "GET", 16).toUpperCase(),
      url,
      headers: clone(request.headers || {}),
      body: request.body
    };
    const requestKey = stableRequestKey(normalized);
    if (requestCache.has(requestKey)) {
      metrics.cacheHits += 1;
      return clone(requestCache.get(requestKey));
    }
    if (inFlight.has(requestKey)) {
      metrics.cacheHits += 1;
      return clone(await inFlight.get(requestKey));
    }
    const promise = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          assertProviderReady(provider, url, stage, approvalInput);
          await reserveBudget(provider, stage, runKey, requestKey, approvalInput);
          metrics.transportAttempts += 1;
          metrics.attemptsByProvider[provider] = (metrics.attemptsByProvider[provider] || 0) + 1;
          if (transport.transportKind === "fetch") metrics.externalNetworkCalls += 1;
          const raw = await callTransportWithTimeout({ ...normalized, requestKey, attempt });
          const response = await normalizeTransportResponse(raw, normalized);
          const statusFailure = httpStatusError(response, { provider, operation, requestKey }, clock);
          if (statusFailure) throw statusFailure;
          const result = {
            status: response.status,
            headers: response.headers,
            url: response.url || url,
            requestKey,
            upstreamProvider: provider,
            body: parseResponseBody(response, request.expected || "json", { provider, operation, requestKey })
          };
          requestCache.set(requestKey, clone(result));
          return result;
        } catch (reason) {
          lastError = sanitizedFailure(reason, { provider, operation, requestKey });
          metrics.failures[lastError.category] = (metrics.failures[lastError.category] || 0) + 1;
          if (!lastError.retryable || attempt >= maxAttempts) throw lastError;
          const delayMs = boundedBackoffMs({
            attempt,
            baseMs: baseBackoffMs,
            maximumMs: maximumBackoffMs,
            retryAfterMs: lastError.retryAfterMs
          });
          metrics.retries += 1;
          await sleep(delayMs, { kind: "retry", provider, operation, requestKey, attempt });
        }
      }
      throw lastError || liveError("Provider request failed", { provider, operation, requestKey });
    })();
    inFlight.set(requestKey, promise);
    try {
      return clone(await promise);
    } finally {
      inFlight.delete(requestKey);
    }
  }

  async function searchContext(input = {}, options = {}) {
    const runKey = runKeyForInput(input);
    const targetName = targetNameForInput(input);
    const stage = cleanText(options.stage || "discovery", 32).toLowerCase();
    const searchKind = cleanText(options.kind || "discovery", 32).toLowerCase();
    const query = cleanText(options.query || input.discoveryQuery || targetName, 180);
    if (!liveEnabled) {
      throw liveError("V2 live collection is disabled", {
        code: "V2_LIVE_DISABLED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider: PROVIDER_KEYS.naverSearch,
        operation: stage
      });
    }
    assertApprovalScope(PROVIDER_KEYS.naverSearch, stage, input);
    assertNaverSearchModeReady();
    const apiHub = naverSearchMode === NAVER_SEARCH_MODES.apiHub;
    const searchBuilder = apiHub ? endpointBuilders.apiHubSearch : endpointBuilders.search;
    if (typeof searchBuilder !== "function") {
      throw liveError("Naver Search endpoint builder is not configured for the selected mode", {
        code: "V2_LIVE_NAVER_SEARCH_ENDPOINT_REQUIRED",
        category: "configuration",
        statusCode: 503,
        retryable: false,
        provider: PROVIDER_KEYS.naverSearch
      });
    }
    const searchUrl = apiHub
      ? searchBuilder({ query, sort: naverApiHubSort, input: clone(input) })
      : searchBuilder({ query, input: clone(input) });
    assertProviderReady(PROVIDER_KEYS.naverSearch, searchUrl, stage, input);
    const contextKey = `${runKey}|${crypto.createHash("sha256").update(stableJson({
      searchKind,
      searchMode: naverSearchMode,
      query,
      targetName,
      region: input.regionLabel || input.regionCode || "",
      targetDate: targetDateForInput(input, clock)
    })).digest("hex")}`;
    if (runContexts.has(contextKey)) return clone(runContexts.get(contextKey));
    const operation = apiHub ? "naver-api-hub-local-search" : "naver-search";
    const response = await requestWithPolicy(PROVIDER_KEYS.naverSearch, operation, runKey, {
      url: searchUrl,
      expected: apiHub ? "json" : "text",
      headers: apiHub ? {
        accept: "application/json",
        "user-agent": "lodging-datalab-v2-live-collector/1.0",
        "X-NCP-APIGW-API-KEY-ID": naverApiHubKeyId,
        "X-NCP-APIGW-API-KEY": naverApiHubKey
      } : {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "user-agent": "lodging-datalab-v2-live-collector/1.0"
      }
    }, { stage, input });
    let result;
    try {
      assertProviderPayload(response.body, { provider: PROVIDER_KEYS.naverSearch, operation });
      result = apiHub
        ? parseNaverApiHubLocalPayload(response.body)
        : parseNaverSearchPayload(response.body, { query });
    } catch (reason) {
      throw sanitizedFailure(reason, {
        provider: PROVIDER_KEYS.naverSearch,
        operation
      });
    }
    const selected = selectNaverCompany(result, targetName, input.regionLabel || input.regionCode || "");
    if (!selected) {
      throw liveError("Naver search returned no unambiguous name-and-region company match", {
        code: "V2_PROVIDER_COMPANY_MATCH_REJECTED",
        category: "identity",
        statusCode: 422,
        retryable: false,
        provider: PROVIDER_KEYS.naverSearch,
        operation
      });
    }
    const conditionHash = crypto.createHash("sha256").update(stableJson({
      provider: PROVIDER_KEYS.naverSearch,
      channel: "naver-search",
      searchMode: naverSearchMode,
      searchKind,
      query: normalizeCompanyName(query),
      region: normalizeRegionText(input.regionLabel || input.regionCode || ""),
      targetDate: targetDateForInput(input, clock)
    })).digest("hex");
    const context = {
      runKey,
      targetName,
      query,
      searchKind,
      searchMode: naverSearchMode,
      conditionHash,
      requestKey: response.requestKey,
      searchUrl: response.url || searchUrl,
      result,
      selected
    };
    runContexts.set(contextKey, clone(context));
    return clone(context);
  }

  async function discover(input = {}) {
    const context = await searchContext(input, {
      stage: "discovery",
      kind: "discovery",
      query: input.discoveryQuery || targetNameForInput(input)
    });
    const row = context.selected;
    if (!row.placeId) throw schemaError("Naver company candidate is missing placeId", {
      provider: PROVIDER_KEYS.naverSearch,
      operation: "discovery"
    });
    const externalIdentities = [{ source: row.identitySource || "naver-place", externalId: row.placeId }];
    if (row.bookingBusinessId) externalIdentities.push({ source: "naver-booking", externalId: row.bookingBusinessId });
    return {
      provider: LIVE_PROVIDER_ID,
      providerMode: "live",
      dataMode: "live",
      synthetic: false,
      source: context.searchUrl,
      collectedAt: collectedAt(clock),
      candidate: {
        companyName: row.name,
        regionLabel: cleanText(input.regionLabel || input.regionCode || row.address, 120),
        address: row.roadAddress || row.address,
        roadAddress: row.roadAddress || "",
        // API HUB may return a third-party homepage. It participates in the
        // provider-local identity hash but is not persisted as a trusted URL.
        link: context.searchMode === NAVER_SEARCH_MODES.apiHub ? "" : row.link || row.url || "",
        mapx: row.mapx || "",
        mapy: row.mapy || "",
        placeId: row.placeId,
        bookingBusinessId: row.bookingBusinessId,
        externalIdentities,
        duplicateCandidates: []
      }
    };
  }

  async function collectQuick(input = {}) {
    const context = await searchContext(input, {
      stage: "quick",
      kind: "discovery",
      query: input.discoveryQuery || targetNameForInput(input)
    });
    const rankingQuery = cleanText(input.rankingQuery, 180);
    const ranking = rankingQuery
      ? await searchContext(input, { stage: "quick", kind: "ranking", query: rankingQuery })
      : null;
    const row = context.selected;
    return {
      provider: LIVE_PROVIDER_ID,
      providerMode: "live",
      dataMode: "live",
      synthetic: false,
      source: context.searchUrl,
      collectedAt: collectedAt(clock),
      profile: {
        companyName: row.name,
        regionLabel: cleanText(input.regionLabel || input.regionCode || row.address, 120),
        category: row.category,
        rank: ranking?.selected?.rank ?? null,
        reviewCount: row.reviewCount,
        latitude: row.latitude,
        longitude: row.longitude,
        roadAddress: row.roadAddress || "",
        link: context.searchMode === NAVER_SEARCH_MODES.apiHub ? "" : row.link || row.url || "",
        mapx: row.mapx || "",
        mapy: row.mapy || "",
        rankingCondition: ranking ? {
          conditionHash: ranking.conditionHash,
          requestKey: ranking.requestKey,
          provider: PROVIDER_KEYS.naverSearch,
          channel: "naver-search"
        } : null
      }
    };
  }

  async function collectDetail(input = {}) {
    const context = await searchContext(input, {
      stage: "detail",
      kind: "discovery",
      query: input.discoveryQuery || targetNameForInput(input)
    });
    const runKey = context.runKey;
    const targetDate = targetDateForInput(input, clock);
    let bookingBusinessId = cleanText(context.selected.bookingBusinessId, 120);
    let bookingUrl = "";
    if (!bookingBusinessId) {
      const endpoint = endpointBuilders.bookingBusiness({ placeId: context.selected.placeId, input: clone(input) });
      const response = await requestWithPolicy(PROVIDER_KEYS.naverBooking, "naver-booking-business", runKey, {
        method: "POST",
        url: endpoint,
        expected: "json",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://pcmap.place.naver.com",
          referer: context.selected.url || context.searchUrl
        },
        body: JSON.stringify({
          operationName: "naverBookingBusiness",
          query: NAVER_BOOKING_BUSINESS_QUERY,
          variables: { id: context.selected.placeId, isNx: false }
        })
      }, { stage: "detail", input });
      assertProviderPayload(response.body, { provider: PROVIDER_KEYS.naverBooking, operation: "naver-booking-business" });
      const booking = parseBookingBusinessPayload(response.body);
      bookingBusinessId = booking.bookingBusinessId;
      bookingUrl = booking.bookingUrl;
    }
    if (!bookingBusinessId) {
      throw emptyResponseError({ provider: PROVIDER_KEYS.naverBooking, operation: "naver-booking-business" }, "Naver company has no booking business identity");
    }
    const itemsEndpoint = endpointBuilders.bookingItems({ bookingBusinessId, targetDate, input: clone(input) });
    const itemsResponse = await requestWithPolicy(PROVIDER_KEYS.naverBooking, "naver-booking-items", runKey, {
      method: "POST",
      url: itemsEndpoint,
      expected: "json",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: "https://m.booking.naver.com",
        referer: bookingUrl || `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}/search`
      },
      body: JSON.stringify({
        operationName: "searchBizItem",
        query: NAVER_BOOKING_ITEMS_QUERY,
        variables: { bizItemSearchParams: { businessId: bookingBusinessId } }
      })
    }, { stage: "detail", input });
    assertProviderPayload(itemsResponse.body, { provider: PROVIDER_KEYS.naverBooking, operation: "naver-booking-items" });
    const items = parseBookingItemsPayload(itemsResponse.body).slice(0, maximumProducts);
    if (!items.length) {
      throw emptyResponseError({ provider: PROVIDER_KEYS.naverBooking, operation: "naver-booking-items" }, "Naver booking returned no products");
    }
    const schedules = new Map();
    for (const item of items) {
      const itemId = cleanText(item.bizItemId || item.id, 120);
      if (!itemId) continue;
      const scheduleEndpoint = endpointBuilders.bookingSchedule({ bookingBusinessId, itemId, targetDate, input: clone(input) });
      const scheduleResponse = await requestWithPolicy(PROVIDER_KEYS.naverBooking, "naver-booking-schedule", runKey, {
        method: "POST",
        url: scheduleEndpoint,
        expected: "json",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://m.booking.naver.com",
          referer: bookingUrl || `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}/search`
        },
        body: JSON.stringify({
          operationName: "dailySchedule",
          query: NAVER_DAILY_SCHEDULE_QUERY,
          variables: {
            scheduleParams: {
              businessId: bookingBusinessId,
              businessTypeId: 3,
              startDateTime: `${targetDate}T00:00:00`,
              endDateTime: `${targetDate}T00:00:00`,
              bizItemId: itemId
            }
          }
        })
      }, { stage: "detail", input });
      assertProviderPayload(scheduleResponse.body, { provider: PROVIDER_KEYS.naverBooking, operation: "naver-booking-schedule" });
      const schedule = parseDailySchedulePayload(scheduleResponse.body, targetDate);
      if (schedule) schedules.set(itemId, schedule);
    }
    return {
      provider: LIVE_PROVIDER_ID,
      providerMode: "live",
      dataMode: "live",
      synthetic: false,
      source: itemsResponse.url || itemsEndpoint,
      collectedAt: collectedAt(clock),
      bookingBusinessId,
      products: normalizeBookingProducts(items, schedules, targetDate, maximumProducts)
    };
  }

  async function collectOta(input = {}) {
    const runKey = runKeyForInput(input);
    const targetName = targetNameForInput(input);
    const targetDate = targetDateForInput(input, clock);
    if (!otaProviders.length) {
      throw liveError("No OTA provider is configured", {
        code: "V2_LIVE_OTA_PROVIDER_REQUIRED",
        category: "configuration",
        statusCode: 503,
        retryable: false
      });
    }
    const specs = otaProviders.map((provider) => {
      if (provider === PROVIDER_KEYS.nol) {
        const url = endpointBuilders.nol({ query: targetName, targetDate, input: clone(input) });
        const body = {
          keyword: targetName,
          category: "LOCAL_ACCOMMODATION",
          filters: [],
          sort: "RECOMMEND",
          userLocation: { latitude: 37.5665, longitude: 126.978, locationType: "DEFAULT", locationTime: 0 },
          localAccommodation: {
            checkInDate: targetDate,
            checkOutDate: nextDate(targetDate),
            capacityAdults: 2,
            childrenAges: []
          },
          page: 1
        };
        return {
          provider,
          operation: "nol-search",
          url,
          request: {
            method: "POST",
            url,
            expected: "json",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              origin: "https://nol.yanolja.com"
            },
            body: JSON.stringify(body)
          }
        };
      }
      const url = endpointBuilders.ddnayo({ query: targetName, targetDate, input: clone(input) });
      return {
        provider,
        operation: "ddnayo-search",
        url,
        request: {
          method: "GET",
          url,
          expected: "json",
          headers: { accept: "application/json" }
        }
      };
    });
    // Validate the complete OTA request set before the first transport call so
    // a partial provider run cannot start under a closed gate.
    specs.forEach((spec) => assertProviderReady(spec.provider, spec.url, "ota", input));
    const channels = [];
    const sources = [];
    for (const spec of specs) {
      const response = await requestWithPolicy(spec.provider, spec.operation, runKey, spec.request, { stage: "ota", input });
      assertProviderPayload(response.body, { provider: spec.provider, operation: spec.operation });
      const rows = spec.provider === PROVIDER_KEYS.nol ? parseNolPayload(response.body) : parseDdnayoPayload(response.body);
      sources.push(response.url || spec.url);
      channels.push({
        channel: spec.provider === PROVIDER_KEYS.nol ? "yanolja-nol" : "ddnayo",
        productKey: "company",
        targetDate,
        exposed: exposedForTarget(rows, targetName),
        provider: spec.provider,
        sourceUrl: response.url || spec.url,
        requestKey: response.requestKey
      });
    }
    return {
      provider: LIVE_PROVIDER_ID,
      providerMode: "live",
      dataMode: "live",
      synthetic: false,
      source: sources[0],
      sources,
      collectedAt: collectedAt(clock),
      channels
    };
  }

  function setKillSwitch(provider, opened) {
    assertProviderName(provider);
    if (opened === false && !approvalValid()) {
      throw liveError("A valid approval manifest is required to close a provider kill switch", {
        code: "V2_LIVE_APPROVAL_REQUIRED",
        category: "approval",
        statusCode: 403,
        retryable: false,
        provider
      });
    }
    killSwitches[provider] = opened !== false;
    return { provider, open: killSwitches[provider] };
  }

  function diagnostics() {
    const ready = readiness();
    return clone({
      providerId: LIVE_PROVIDER_ID,
      kind: "live",
      dataMode: "live",
      synthetic: false,
      seedSourceUrl,
      ready: ready.ready,
      reasons: ready.reasons,
      requestedStages: ready.requestedStages,
      requiredProviders: ready.requiredProviders,
      liveEnabled,
      naverSearchMode,
      approvalConfigured: Boolean(approvalHash),
      approvalValid: approvalValid(),
      approvalId: approvalManifest?.approvalId || "",
      approvalExpiresAt: approvalManifest?.expiresAt || "",
      approvedProviders: [...approvedProviders].sort(),
      killSwitches,
      hostnameAllowlist: Object.fromEntries(ALL_PROVIDER_KEYS.map((provider) => [provider, [...hostnameAllowlist[provider]].sort()])),
      requestBudget: budget,
      timeoutMs,
      maxAttempts,
      requestCacheEntries: requestCache.size,
      runContextCount: runContexts.size,
      transportKind: transport.transportKind || "injected",
      durableQuota: Boolean(quotaRepository && typeof quotaRepository.reserveProviderRequest === "function"),
      ...metrics
    });
  }

  return Object.freeze({
    id: LIVE_PROVIDER_ID,
    kind: "live",
    get enabled() {
      return readiness().ready;
    },
    synthetic: false,
    dataMode: "live",
    durableQuota: true,
    seedSourceUrl,
    discover,
    collectQuick,
    collectDetail,
    collectOta,
    assertRequestScope,
    setKillSwitch,
    diagnostics
  });
}

module.exports = {
  ALL_PROVIDER_KEYS,
  DEFAULT_ENDPOINT_BUILDERS,
  LIVE_PROVIDER_ID,
  NAVER_API_HUB_LOCAL_ENDPOINT,
  NAVER_API_HUB_LOCAL_HOST,
  NAVER_SEARCH_MODES,
  PROVIDER_KEYS,
  V2LiveCollectionError,
  approvalTokenDigest,
  approvalManifestDigest,
  boundedBackoffMs,
  classifyProviderFailure,
  companyNameScore,
  createFetchTransport,
  createV2LiveCollectionProvider,
  extractApolloState,
  normalizeBookingProducts,
  normalizeApprovalManifest,
  normalizeNaverApiHubLocalItem,
  normalizeNaverSearchItem,
  parseBookingBusinessPayload,
  parseBookingItemsPayload,
  parseDailySchedulePayload,
  parseDdnayoPayload,
  parseNaverApiHubLocalPayload,
  parseNaverSearchPayload,
  parseNolPayload,
  parseRetryAfterMs,
  stableNaverApiHubLocalIdentity,
  stableRequestKey
};
