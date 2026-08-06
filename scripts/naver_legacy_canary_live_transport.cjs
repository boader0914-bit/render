"use strict";

const { NAVER_PROVIDER_ID } = require("./naver_provider_resilience.cjs");

const NAVER_PLACE_LIST_ORIGIN = "https://pcmap.place.naver.com";
const NAVER_PLACE_LIST_PATH = "/accommodation/list";
const NAVER_LEGACY_CANARY_TIMEOUT_MS = 25_000;
const NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FIXED_LEGACY_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9"
});
const REGISTERED_LIVE_TRANSPORTS = new WeakSet();

class NaverLegacyCanaryTransportError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = "NaverLegacyCanaryTransportError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = false;
  }
}

function transportError(code, message, statusCode = 502) {
  return new NaverLegacyCanaryTransportError(code, message, statusCode);
}

function normalizedTimeout(value) {
  const timeout = Number(value ?? NAVER_LEGACY_CANARY_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > NAVER_LEGACY_CANARY_TIMEOUT_MS) {
    throw transportError("NAVER_LEGACY_CANARY_TRANSPORT_INVALID", "The NAVER canary timeout is invalid", 400);
  }
  return timeout;
}

function normalizedResponseLimit(value) {
  const limit = Number(value ?? NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES);
  if (!Number.isInteger(limit) || limit < 1 || limit > NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES) {
    throw transportError("NAVER_LEGACY_CANARY_TRANSPORT_INVALID", "The NAVER canary response limit is invalid", 400);
  }
  return limit;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  if (typeof headers !== "object" || Array.isArray(headers)) return "";
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || "") : "";
}

function safeResponseHeaders(headers) {
  const result = {};
  const contentType = headerValue(headers, "content-type").slice(0, 160);
  const retryAfter = headerValue(headers, "retry-after").slice(0, 128);
  if (contentType) result["content-type"] = contentType;
  if (retryAfter) result["retry-after"] = retryAfter;
  return Object.freeze(result);
}

function assertLiveRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw transportError("NAVER_LEGACY_CANARY_REQUEST_INVALID", "The NAVER canary request is invalid", 400);
  }
  const query = String(request.query || "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (
    request.providerId !== NAVER_PROVIDER_ID
    || request.providerOperation !== "naver_place_accommodation_search_snapshot"
    || request.actualCallsEnabled !== true
    || request.fixtureOnly !== false
    || request.requestOrdinal !== 1
    || request.callBudget !== 1
    || !query
    || query.length > 120
    || /[\u0000-\u001f\u007f]/u.test(query)
  ) {
    throw transportError("NAVER_LEGACY_CANARY_REQUEST_INVALID", "The NAVER canary request is invalid", 400);
  }
  return query;
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best effort only. A cancellation failure must not mask a provider block
    // or the bounded-response safety error that caused cancellation.
  }
}

async function readBoundedBody(response, maxBytes, options = {}) {
  const contentLength = Number(headerValue(response?.headers, "content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await cancelResponseBody(response);
    throw transportError("NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE", "The NAVER canary response exceeded the safe limit", 502);
  }

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw transportError("NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE", "The NAVER canary response exceeded the safe limit", 502);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  if (options.allowTextFallback !== true || typeof response?.text !== "function") {
    throw transportError("NAVER_LEGACY_CANARY_RESPONSE_INVALID", "The NAVER canary response is invalid", 502);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw transportError("NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE", "The NAVER canary response exceeded the safe limit", 502);
  }
  return text;
}

function createNaverLegacyCanaryLiveTransport(options = {}) {
  if (options.enabled !== true || typeof options.fetchImpl !== "function") {
    throw transportError("NAVER_LEGACY_CANARY_TRANSPORT_DISABLED", "The NAVER canary live transport is disabled", 503);
  }
  const timeoutMs = normalizedTimeout(options.timeoutMs);
  const maxResponseBytes = normalizedResponseLimit(options.maxResponseBytes);
  const allowTextFallback = options.allowTextFallback === true;
  let callCount = 0;

  const transport = async function naverLegacyCanaryLiveTransport(request, context = {}) {
    const query = assertLiveRequest(request);
    if (callCount >= 1) {
      throw transportError("NAVER_LEGACY_CANARY_CALL_BUDGET_EXCEEDED", "The NAVER canary call budget was exceeded", 409);
    }
    if (context.signal?.aborted) {
      throw transportError("NAVER_LEGACY_CANARY_ABORTED", "The NAVER canary was aborted", 499);
    }

    const url = new URL(NAVER_PLACE_LIST_PATH, NAVER_PLACE_LIST_ORIGIN);
    url.searchParams.set("query", query);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    callCount += 1;

    try {
      const response = await options.fetchImpl(url, {
        method: "GET",
        headers: FIXED_LEGACY_HEADERS,
        redirect: "manual",
        signal: controller.signal
      });
      const status = Number(response?.status);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw transportError("NAVER_LEGACY_CANARY_RESPONSE_INVALID", "The NAVER canary response is invalid", 502);
      }
      // 403 and 429 are authoritative block signals. Classify them without
      // depending on a potentially oversized or unreadable response body.
      if (status === 403 || status === 429) await cancelResponseBody(response);
      const body = status === 403 || status === 429
        ? ""
        : await readBoundedBody(response, maxResponseBytes, { allowTextFallback });
      return Object.freeze({
        status,
        headers: safeResponseHeaders(response.headers),
        body
      });
    } catch (error) {
      if (error instanceof NaverLegacyCanaryTransportError) throw error;
      if (controller.signal.aborted) {
        throw transportError(
          context.signal?.aborted ? "NAVER_LEGACY_CANARY_ABORTED" : "NAVER_LEGACY_CANARY_TIMEOUT",
          context.signal?.aborted ? "The NAVER canary was aborted" : "The NAVER canary timed out",
          context.signal?.aborted ? 499 : 504
        );
      }
      throw transportError("NAVER_LEGACY_CANARY_TRANSPORT_FAILED", "The NAVER canary transport failed", 502);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener?.("abort", onAbort);
    }
  };

  Object.defineProperty(transport, "callCount", {
    value: () => callCount,
    configurable: false,
    enumerable: false,
    writable: false
  });
  Object.defineProperty(transport, "maxCalls", {
    value: 1,
    configurable: false,
    enumerable: false,
    writable: false
  });
  REGISTERED_LIVE_TRANSPORTS.add(transport);
  return Object.freeze(transport);
}

function isRegisteredNaverLegacyCanaryLiveTransport(value) {
  return typeof value === "function" && REGISTERED_LIVE_TRANSPORTS.has(value);
}

module.exports = {
  FIXED_LEGACY_HEADERS,
  NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES,
  NAVER_LEGACY_CANARY_TIMEOUT_MS,
  NAVER_PLACE_LIST_ORIGIN,
  NAVER_PLACE_LIST_PATH,
  NaverLegacyCanaryTransportError,
  createNaverLegacyCanaryLiveTransport,
  isRegisteredNaverLegacyCanaryLiveTransport,
  readBoundedBody,
  safeResponseHeaders
};
