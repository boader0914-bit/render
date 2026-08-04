"use strict";

const { timingSafeEqual } = require("node:crypto");

const NAVER_MAPS_GEOCODING_ENDPOINT = "https://maps.apigw.ntruss.com/map-geocode/v2/geocode";
const NAVER_MAPS_GEOCODING_HOSTS = Object.freeze(["maps.apigw.ntruss.com"]);
const NAVER_MAPS_API_KEY_ID_ENV = "NAVER_MAPS_API_KEY_ID";
const NAVER_MAPS_API_KEY_ENV = "NAVER_MAPS_API_KEY";
const NAVER_MAPS_GEOCODING_ENABLED_ENV = "NAVER_MAPS_GEOCODING_ENABLED";
const NAVER_MAPS_GEOCODING_MONTHLY_LIMIT_ENV = "NAVER_MAPS_GEOCODING_MONTHLY_LIMIT";
const NAVER_MAPS_PROVIDER_KEY = "naver_maps";
const CAPTURE_ARTIFACT_VERSION = "naver-maps-geocoding-capture/v1";
const TRANSIENT_DISPLAY_VERSION = "naver-maps-geocoding-transient-display/v2";
const MAX_PROVIDER_REQUESTS = 25;
const MAX_TRANSIENT_MONTHLY_REQUESTS = 10000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ADDRESS_LENGTH = 320;
const MAX_ADDRESS_ELEMENTS = 32;
const MAX_ELEMENT_TYPES = 8;
const RESULT_COUNT = 3;

function explicitRequestLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PROVIDER_REQUESTS ? parsed : 0;
}

function enabledFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function monthlyRequestLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return MAX_TRANSIENT_MONTHLY_REQUESTS;
  return Math.min(parsed, MAX_TRANSIENT_MONTHLY_REQUESTS);
}

function explicitMonthlyRequestLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TRANSIENT_MONTHLY_REQUESTS ? parsed : 0;
}

function kstMonthKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("NAVER Maps Geocoding budget clock invalid");
  return new Date(date.getTime() + (9 * 60 * 60 * 1000)).toISOString().slice(0, 7);
}

function createMonthlyRequestBudget(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const limit = monthlyRequestLimit(options.limit);
  let month = kstMonthKey(now());
  let used = 0;

  const refresh = () => {
    const current = kstMonthKey(now());
    if (current !== month) {
      month = current;
      used = 0;
    }
  };

  return Object.freeze({
    reserve(count = 1) {
      refresh();
      const requested = Number(count);
      if (!Number.isInteger(requested) || requested < 1 || used + requested > limit) {
        throw providerError("NAVER_GEOCODING_MONTHLY_BUDGET_EXHAUSTED", 429, "NAVER Maps Geocoding monthly display budget exhausted");
      }
      used += requested;
      return this.snapshot();
    },
    snapshot() {
      refresh();
      return Object.freeze({ month, limit, used, remaining: Math.max(0, limit - used) });
    }
  });
}

function boundedText(value, maximum = MAX_ADDRESS_LENGTH) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function safeCredential(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeRequestId(value) {
  return boundedText(value, 80);
}

function safeApprovalToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return token.length >= 16 && token.length <= 256 && !/[\u0000-\u001f\u007f]/.test(token) ? token : "";
}

function equalApprovalToken(leftValue, rightValue) {
  const left = Buffer.from(safeApprovalToken(leftValue), "utf8");
  const right = Buffer.from(safeApprovalToken(rightValue), "utf8");
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function captureApprovalValid(receipt, expectedApprovalToken, maxRequests) {
  if (!receipt || typeof receipt !== "object" || maxRequests < 1) return false;
  const approvedLimit = explicitRequestLimit(receipt.maxRequests);
  return receipt.mode === "capture"
    && receipt.providerKey === NAVER_MAPS_PROVIDER_KEY
    && approvedLimit >= maxRequests
    && equalApprovalToken(receipt.token, expectedApprovalToken);
}

function providerError(code, statusCode, message) {
  const error = new Error(message || "NAVER Maps Geocoding request failed");
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validatedEndpoint(value = NAVER_MAPS_GEOCODING_ENDPOINT) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("NAVER Maps Geocoding endpoint is not allowed");
  }
  if (
    url.protocol !== "https:"
    || !NAVER_MAPS_GEOCODING_HOSTS.includes(url.hostname)
    || url.port
    || url.username
    || url.password
    || url.pathname !== "/map-geocode/v2/geocode"
    || url.search
    || url.hash
  ) {
    throw new TypeError("NAVER Maps Geocoding endpoint is not allowed");
  }
  return url;
}

function numericCoordinate(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length > 48 || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function addressElementTypes(row = {}) {
  const elements = Array.isArray(row.addressElements)
    ? row.addressElements.slice(0, MAX_ADDRESS_ELEMENTS)
    : [];
  return new Set(elements.flatMap((element) => {
    const values = Array.isArray(element?.types)
      ? element.types
      : (Array.isArray(element?.type) ? element.type : []);
    return values.slice(0, MAX_ELEMENT_TYPES);
  }).map((type) => boundedText(type, 64).toUpperCase()).filter(Boolean));
}

function conservativePrecision(row = {}) {
  const types = addressElementTypes(row);
  if (types.has("LAND_NUMBER")) return "parcel";
  if (types.has("ROAD_NAME")) return "street";
  if (["DONGMYUN", "RI"].some((type) => types.has(type))) return "locality";
  if (["SIDO", "SIGUGUN"].some((type) => types.has(type))) return "region";
  return "unknown";
}

function conservativeLocationStatus(precision, hasCoordinatePair) {
  if (!hasCoordinatePair) return "invalid";
  if (precision === "parcel") return "resolved";
  if (precision === "street") return "approximate";
  return "ambiguous";
}

function normalizeObservedAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw providerError("NAVER_GEOCODING_CLOCK_INVALID", 500, "NAVER Maps Geocoding observation time invalid");
  }
  return date.toISOString();
}

function normalizeNaverAddress(row = {}, options = {}) {
  const latitude = numericCoordinate(row.y);
  const longitude = numericCoordinate(row.x);
  const hasCoordinatePair = latitude !== null && longitude !== null;
  const precision = conservativePrecision(row);
  const status = conservativeLocationStatus(precision, hasCoordinatePair);
  const mappable = status === "resolved" || status === "approximate";
  const observedAt = normalizeObservedAt(options.observedAt ?? new Date());
  return Object.freeze({
    status,
    latitude: mappable ? latitude : null,
    longitude: mappable ? longitude : null,
    crs: "EPSG:4326",
    precision,
    source: "provider",
    providerKey: NAVER_MAPS_PROVIDER_KEY,
    confidence: null,
    resolvedAddress: boundedText(row.roadAddress || row.jibunAddress || ""),
    geocodedAt: observedAt
  });
}

function contentLength(response) {
  const value = response?.headers?.get?.("content-length");
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function boundedResponseText(response) {
  const declaredLength = contentLength(response);
  if (declaredLength != null && declaredLength > MAX_RESPONSE_BYTES) {
    throw providerError("NAVER_GEOCODING_RESPONSE_TOO_LARGE", 502, "NAVER Maps Geocoding response too large");
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        byteLength += chunk.length;
        if (byteLength > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw providerError("NAVER_GEOCODING_RESPONSE_TOO_LARGE", 502, "NAVER Maps Geocoding response too large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, byteLength).toString("utf8");
  }

  if (typeof response?.text !== "function") {
    throw providerError("NAVER_GEOCODING_INVALID_RESPONSE", 502, "NAVER Maps Geocoding response invalid");
  }
  const text = await response.text();
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw providerError("NAVER_GEOCODING_RESPONSE_TOO_LARGE", 502, "NAVER Maps Geocoding response too large");
  }
  return text;
}

async function responseJson(response) {
  if (!response || typeof response !== "object") {
    throw providerError("NAVER_GEOCODING_TRANSPORT_ERROR", 503, "NAVER Maps Geocoding response unavailable");
  }
  if (Number(response.status) === 429) {
    throw providerError("NAVER_GEOCODING_RATE_LIMITED", 429, "NAVER Maps Geocoding rate limited");
  }
  if (Number(response.status) >= 500) {
    throw providerError("NAVER_GEOCODING_UNAVAILABLE", Number(response.status), "NAVER Maps Geocoding unavailable");
  }
  if (response.ok === false || Number(response.status) >= 400) {
    throw providerError("NAVER_GEOCODING_REQUEST_FAILED", Number(response.status) || 400, "NAVER Maps Geocoding request rejected");
  }
  if (!Number.isInteger(Number(response.status)) || Number(response.status) < 200 || Number(response.status) >= 300) {
    throw providerError("NAVER_GEOCODING_INVALID_RESPONSE", 502, "NAVER Maps Geocoding response invalid");
  }

  let payload;
  try {
    payload = JSON.parse(await boundedResponseText(response));
  } catch (error) {
    if (error?.code) throw error;
    throw providerError("NAVER_GEOCODING_INVALID_RESPONSE", 502, "NAVER Maps Geocoding response invalid");
  }
  if (
    !payload
    || typeof payload !== "object"
    || payload.status !== "OK"
    || !Array.isArray(payload.addresses)
    || payload.addresses.length > RESULT_COUNT
    || payload.addresses.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw providerError("NAVER_GEOCODING_INVALID_RESPONSE", 502, "NAVER Maps Geocoding response invalid");
  }
  return payload;
}

function createNaverMapsGeocodingAdapter(options = {}) {
  const environment = options.env && typeof options.env === "object" ? options.env : process.env;
  const endpoint = validatedEndpoint(options.endpoint || NAVER_MAPS_GEOCODING_ENDPOINT);
  const apiKeyId = safeCredential(options.apiKeyId ?? environment[NAVER_MAPS_API_KEY_ID_ENV]);
  const apiKey = safeCredential(options.apiKey ?? environment[NAVER_MAPS_API_KEY_ENV]);
  const request = options.request ?? options.fetch;
  const maxRequests = explicitRequestLimit(options.maxRequests);
  const configured = Boolean(apiKeyId && apiKey && typeof request === "function");
  const captureApproved = captureApprovalValid(options.approvalReceipt, options.expectedApprovalToken, maxRequests);
  const enabled = options.enabled === true && configured && maxRequests > 0 && captureApproved;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const requestIds = new Set();
  let requestCount = 0;

  const configuration = () => Object.freeze({
    providerKey: NAVER_MAPS_PROVIDER_KEY,
    enabled,
    configured,
    captureApproved,
    endpointHost: endpoint.hostname,
    maxRequests,
    usedRequests: requestCount,
    remainingRequests: Math.max(0, maxRequests - requestCount),
    retryCount: 0
  });

  const captureAddress = async ({ normalizedAddress, requestId, signal } = {}) => {
    if (!enabled) {
      throw providerError("NAVER_GEOCODING_DISABLED", 503, "NAVER Maps Geocoding is disabled");
    }
    const companyRequestId = safeRequestId(requestId);
    if (!companyRequestId) {
      throw providerError("NAVER_GEOCODING_REQUEST_ID_REQUIRED", 400, "NAVER Maps Geocoding request ID is required");
    }
    if (requestIds.has(companyRequestId)) {
      throw providerError("NAVER_GEOCODING_DUPLICATE_REQUEST", 409, "NAVER Maps Geocoding permits one request per company");
    }
    if (requestCount >= maxRequests) {
      throw providerError("NAVER_GEOCODING_BUDGET_EXHAUSTED", 429, "NAVER Maps Geocoding request budget exhausted");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : providerError("NAVER_GEOCODING_ABORTED", 499, "NAVER Maps Geocoding request aborted");
    }

    const query = boundedText(normalizedAddress);
    if (!query) {
      throw providerError("NAVER_GEOCODING_ADDRESS_REQUIRED", 400, "NAVER Maps Geocoding address is required");
    }

    requestIds.add(companyRequestId);
    requestCount += 1;
    const requestUrl = new URL(endpoint.href);
    requestUrl.searchParams.set("query", query);
    requestUrl.searchParams.set("language", "kor");
    requestUrl.searchParams.set("page", "1");
    requestUrl.searchParams.set("count", String(RESULT_COUNT));

    let response;
    try {
      response = await request(requestUrl.href, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "x-ncp-apigw-api-key-id": apiKeyId,
          "x-ncp-apigw-api-key": apiKey
        },
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const statusCode = Number(error?.statusCode || error?.status || 0);
      if (statusCode === 429) {
        throw providerError("NAVER_GEOCODING_RATE_LIMITED", 429, "NAVER Maps Geocoding rate limited");
      }
      if (statusCode >= 500) {
        throw providerError("NAVER_GEOCODING_UNAVAILABLE", statusCode, "NAVER Maps Geocoding unavailable");
      }
      throw providerError("NAVER_GEOCODING_TRANSPORT_ERROR", statusCode || 503, "NAVER Maps Geocoding transport failed");
    }

    const payload = await responseJson(response);
    const observedAt = normalizeObservedAt(now());
    const results = Object.freeze(payload.addresses.map((row) => normalizeNaverAddress(row, { observedAt })));
    return Object.freeze({
      artifactVersion: CAPTURE_ARTIFACT_VERSION,
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      requestId: companyRequestId,
      observedAt,
      resultCount: results.length,
      results
    });
  };

  const adapter = async (input = {}) => (await captureAddress(input)).results;

  Object.defineProperties(adapter, {
    enabled: { enumerable: true, value: enabled },
    providerKey: { enumerable: true, value: NAVER_MAPS_PROVIDER_KEY },
    capture: { enumerable: true, value: captureAddress },
    configuration: { enumerable: true, value: configuration }
  });
  return adapter;
}

function createNaverMapsTransientGeocodingAdapter(options = {}) {
  const environment = options.env && typeof options.env === "object" ? options.env : process.env;
  const endpoint = validatedEndpoint(options.endpoint || NAVER_MAPS_GEOCODING_ENDPOINT);
  const apiKeyId = safeCredential(options.apiKeyId ?? environment[NAVER_MAPS_API_KEY_ID_ENV]);
  const apiKey = safeCredential(options.apiKey ?? environment[NAVER_MAPS_API_KEY_ENV]);
  const request = options.request ?? options.fetch;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const approvedMonthlyLimit = explicitMonthlyRequestLimit(
    options.monthlyLimit ?? environment[NAVER_MAPS_GEOCODING_MONTHLY_LIMIT_ENV]
  );
  const budget = options.budget && typeof options.budget.reserve === "function"
    ? options.budget
    : createMonthlyRequestBudget({
        limit: approvedMonthlyLimit || MAX_TRANSIENT_MONTHLY_REQUESTS,
        now
      });
  const configured = Boolean(apiKeyId && apiKey && typeof request === "function");
  const explicitlyEnabled = options.enabled === true
    || (options.enabled === undefined && enabledFlag(environment[NAVER_MAPS_GEOCODING_ENABLED_ENV]));
  const enabled = explicitlyEnabled && configured && approvedMonthlyLimit > 0;

  const configuration = () => Object.freeze({
    providerKey: NAVER_MAPS_PROVIDER_KEY,
    usage: "transient-display-only",
    enabled,
    configured,
    monthlyLimitApproved: approvedMonthlyLimit > 0,
    endpointHost: endpoint.hostname,
    retryCount: 0,
    cacheable: false,
    persistable: false,
    monthlyBudget: budget.snapshot?.() || null
  });

  const resolveForDisplay = async ({ normalizedAddress, requestId, signal } = {}) => {
    if (!enabled) {
      throw providerError("NAVER_GEOCODING_DISABLED", 503, "NAVER Maps Geocoding display lookup is disabled");
    }
    const displayRequestId = safeRequestId(requestId);
    if (!displayRequestId) {
      throw providerError("NAVER_GEOCODING_REQUEST_ID_REQUIRED", 400, "NAVER Maps Geocoding request ID is required");
    }
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : providerError("NAVER_GEOCODING_ABORTED", 499, "NAVER Maps Geocoding request aborted");
    }
    const query = boundedText(normalizedAddress);
    if (!query) {
      throw providerError("NAVER_GEOCODING_ADDRESS_REQUIRED", 400, "NAVER Maps Geocoding address is required");
    }

    // The budget is consumed before the outbound request. Failed requests are
    // still provider calls and must never be retried automatically.
    await budget.reserve(1);
    const requestUrl = new URL(endpoint.href);
    requestUrl.searchParams.set("query", query);
    requestUrl.searchParams.set("language", "kor");
    requestUrl.searchParams.set("page", "1");
    requestUrl.searchParams.set("count", String(RESULT_COUNT));

    let response;
    try {
      response = await request(requestUrl.href, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          "x-ncp-apigw-api-key-id": apiKeyId,
          "x-ncp-apigw-api-key": apiKey
        },
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const statusCode = Number(error?.statusCode || error?.status || 0);
      if (statusCode === 429) {
        throw providerError("NAVER_GEOCODING_RATE_LIMITED", 429, "NAVER Maps Geocoding rate limited");
      }
      if (statusCode >= 500) {
        throw providerError("NAVER_GEOCODING_UNAVAILABLE", statusCode, "NAVER Maps Geocoding unavailable");
      }
      throw providerError("NAVER_GEOCODING_TRANSPORT_ERROR", statusCode || 503, "NAVER Maps Geocoding transport failed");
    }

    const payload = await responseJson(response);
    const observedAt = normalizeObservedAt(now());
    const results = Object.freeze(payload.addresses.map((row) => normalizeNaverAddress(row, { observedAt })));
    return Object.freeze({
      version: TRANSIENT_DISPLAY_VERSION,
      usage: "single-display",
      cacheable: false,
      persistable: false,
      providerKey: NAVER_MAPS_PROVIDER_KEY,
      requestId: displayRequestId,
      observedAt,
      resultCount: results.length,
      results
    });
  };

  const adapter = async (input = {}) => (await resolveForDisplay(input)).results;
  Object.defineProperties(adapter, {
    enabled: { enumerable: true, value: enabled },
    providerKey: { enumerable: true, value: NAVER_MAPS_PROVIDER_KEY },
    resolveForDisplay: { enumerable: true, value: resolveForDisplay },
    configuration: { enumerable: true, value: configuration }
  });
  return adapter;
}

module.exports = {
  CAPTURE_ARTIFACT_VERSION,
  MAX_ADDRESS_LENGTH,
  MAX_PROVIDER_REQUESTS,
  MAX_TRANSIENT_MONTHLY_REQUESTS,
  MAX_RESPONSE_BYTES,
  NAVER_MAPS_API_KEY_ENV,
  NAVER_MAPS_API_KEY_ID_ENV,
  NAVER_MAPS_GEOCODING_ENABLED_ENV,
  NAVER_MAPS_GEOCODING_ENDPOINT,
  NAVER_MAPS_GEOCODING_HOSTS,
  NAVER_MAPS_GEOCODING_MONTHLY_LIMIT_ENV,
  NAVER_MAPS_PROVIDER_KEY,
  RESULT_COUNT,
  TRANSIENT_DISPLAY_VERSION,
  createMonthlyRequestBudget,
  createNaverMapsGeocodingAdapter,
  createNaverMapsTransientGeocodingAdapter,
  explicitMonthlyRequestLimit,
  kstMonthKey,
  monthlyRequestLimit,
  normalizeNaverAddress
};
