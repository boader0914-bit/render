"use strict";

const Module = require("node:module");

const INSTALL_KEY = Symbol.for("lodging-datalab.frozen-v2-fetch-safety.v1");
const XLSX_GUARD_KEY = Symbol.for("lodging-datalab.frozen-v2-xlsx-guard.v1");
const APOLLO_MARKERS = Object.freeze([
  "window.__APOLLO_STATE__ = ",
  "window.__APOLLO_STATE__=",
  "__APOLLO_STATE__ = ",
  "__APOLLO_STATE__="
]);
const CHALLENGE_PATTERN = /captcha|wtmcaptcha|ncpt\.naver\.com|access\s*denied|sorry,?\s*you\s*have\s*been\s*blocked|비정상적\s*접근|자동입력\s*방지|보안\s*확인/iu;
const MAX_RETRY_AFTER_SECONDS = 120 * 60;

const FROZEN_REQUEST_ALLOWLIST = Object.freeze(new Map([
  ["pcmap.place.naver.com", Object.freeze([
    /^\/accommodation\/list$/u,
    /^\/accommodation\/[0-9]+(?:\/room)?$/u
  ])],
  ["pcmap-api.place.naver.com", Object.freeze([/^\/graphql$/u])],
  ["m.place.naver.com", Object.freeze([/^\/accommodation\/[0-9]+\/(?:home|room)$/u])],
  ["m.booking.naver.com", Object.freeze([
    /^\/graphql$/u,
    /^\/booking\/3\/bizes\/[0-9]+\/search\/?$/u
  ])],
  ["nol.yanolja.com", Object.freeze([
    /^\/discovery\/api\/list\/universal-search\/v1\/(?:list|count)$/u
  ])],
  ["www.goodchoice.kr", Object.freeze([/^\/product\/result$/u])],
  ["trip.ddnayo.com", Object.freeze([/^\/web-api\/total-search$/u])]
]));

function requestUrl(input) {
  try {
    const value = input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input && typeof input.url === "string"
          ? input.url
          : null;
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function requestHostname(input) {
  return requestUrl(input)?.hostname.toLowerCase() || null;
}

function isAllowedFrozenRequest(input) {
  const url = requestUrl(input);
  if (!url || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || url.hash) {
    return false;
  }
  const patterns = FROZEN_REQUEST_ALLOWLIST.get(url.hostname.toLowerCase());
  return Boolean(patterns?.some((pattern) => pattern.test(url.pathname)));
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function redirectedFetchInit(init, status, fromUrl, toUrl) {
  const next = { ...(init || {}), redirect: "manual" };
  const method = String(next.method || "GET").toUpperCase();
  const headers = new Headers(next.headers || {});
  if (fromUrl.origin !== toUrl.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }
  if (Number(status) === 303 || ([301, 302].includes(Number(status)) && method === "POST")) {
    next.method = "GET";
    delete next.body;
    for (const name of ["content-encoding", "content-language", "content-location", "content-type"]) headers.delete(name);
  }
  next.headers = headers;
  return next;
}

function isNaverHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "naver.com"
    || value.endsWith(".naver.com")
    || value === "naver.net"
    || value.endsWith(".naver.net");
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value[0] : value;
}

function parseSafeRetryAfter(value, now = Date.now()) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const source = String(value).trim();
  if (!source || source.length > 128) return null;
  if (/^\d+$/u.test(source)) {
    const seconds = Number(source);
    return Number.isSafeInteger(seconds) ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : MAX_RETRY_AFTER_SECONDS;
  }
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(source)) {
    return null;
  }
  const retryAt = Date.parse(source);
  if (!Number.isFinite(retryAt) || new Date(retryAt).toUTCString() !== source) return null;
  return Math.min(Math.max(0, Math.ceil((retryAt - now) / 1000)), MAX_RETRY_AFTER_SECONDS);
}

function hasApolloMarker(body) {
  const lowered = String(body || "").toLowerCase();
  return APOLLO_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
}

function looksLikeHtml(headers, body) {
  const contentType = String(headerValue(headers, "content-type") || "").toLowerCase();
  if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/u.test(contentType)) return true;
  return /^(?:<!doctype\s+html\b|<(?:html|head|body|script|div|main|form|section|meta|title)\b)/iu.test(
    String(body || "").trimStart().slice(0, 4096)
  );
}

function classifyAccessResponse(response, body) {
  const status = Number(response?.status);
  if (status === 403) return { blocked: true, subtype: "http_403", httpStatus: 403, retryAfterSeconds: null };
  if (status === 429) {
    return {
      blocked: true,
      subtype: "http_429",
      httpStatus: 429,
      retryAfterSeconds: parseSafeRetryAfter(headerValue(response?.headers, "retry-after"))
    };
  }
  if (looksLikeHtml(response?.headers, body) && !hasApolloMarker(body) && CHALLENGE_PATTERN.test(String(body || ""))) {
    return { blocked: true, subtype: "challenge_html", httpStatus: Number.isInteger(status) ? status : null, retryAfterSeconds: null };
  }
  return { blocked: false, subtype: null, httpStatus: Number.isInteger(status) ? status : null, retryAfterSeconds: null };
}

function safeFailure(code, classification = {}) {
  const error = new Error(code === "NAVER_ACCESS_BLOCKED"
    ? "NAVER provider access was blocked"
    : "NAVER provider request did not complete");
  error.name = "FrozenV2ProviderFailure";
  error.code = code;
  error.retryable = code === "NAVER_TEMPORARY_UNAVAILABLE";
  if (["http_403", "http_429", "challenge_html", "unknown_access_block"].includes(classification.subtype)) {
    error.providerFailureSubtype = classification.subtype;
  }
  if (Number.isInteger(classification.httpStatus)) error.providerHttpStatus = classification.httpStatus;
  if (Number.isInteger(classification.retryAfterSeconds) && classification.retryAfterSeconds >= 0) {
    error.retryAfterSeconds = Math.min(classification.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
  }
  return error;
}

function serializeFailure(error) {
  const payload = {
    version: 1,
    code: error.code === "NAVER_ACCESS_BLOCKED" ? "NAVER_ACCESS_BLOCKED" : "NAVER_TEMPORARY_UNAVAILABLE",
    retryable: error.code !== "NAVER_ACCESS_BLOCKED"
  };
  if (payload.code === "NAVER_ACCESS_BLOCKED") {
    if (error.providerFailureSubtype) payload.providerFailureSubtype = error.providerFailureSubtype;
    if (Number.isInteger(error.providerHttpStatus)) payload.providerHttpStatus = error.providerHttpStatus;
    if (Number.isInteger(error.retryAfterSeconds)) payload.retryAfterSeconds = error.retryAfterSeconds;
  }
  return `CRAWL_ERROR_V1:${JSON.stringify(payload)}`;
}

function installXlsxResolutionGuard() {
  if (Module[XLSX_GUARD_KEY]) return Module[XLSX_GUARD_KEY];
  const originalLoad = Module._load;
  Module._load = function frozenV2ModuleLoad(request, parent, isMain) {
    if (request === "xlsx") {
      const error = new Error("Frozen V2 uses the audited workbook compatibility bridge");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
  const state = Object.freeze({ installed: true, blockedModule: "xlsx" });
  Object.defineProperty(Module, XLSX_GUARD_KEY, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false
  });
  return state;
}

function installFetchSafetyPreload(target = globalThis) {
  if (target[INSTALL_KEY]) return target[INSTALL_KEY];
  const originalFetch = target.fetch;
  if (typeof originalFetch !== "function") {
    throw new TypeError("Frozen V2 fetch safety preload requires global fetch");
  }

  let latchedFailure = null;
  let markerEmitted = false;

  function stopWithFailure(error) {
    if (!latchedFailure) latchedFailure = error;
    if (!markerEmitted) {
      markerEmitted = true;
      process.stderr.write(`${serializeFailure(latchedFailure)}\n`);
    }
    if (!process.exitCode) process.exitCode = 1;
    throw latchedFailure;
  }

  async function safetyFetch(...args) {
    if (latchedFailure) return stopWithFailure(latchedFailure);
    let currentUrl = requestUrl(args[0]);
    let currentInit = { ...(args[1] || {}), redirect: "manual" };
    let response = null;
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      if (!isAllowedFrozenRequest(currentUrl)) {
        return stopWithFailure(safeFailure("FROZEN_V2_REQUEST_NOT_ALLOWED"));
      }
      try {
        response = await Reflect.apply(originalFetch, this, [currentUrl.href, currentInit]);
      } catch {
        return stopWithFailure(safeFailure("NAVER_TEMPORARY_UNAVAILABLE"));
      }
      if (!isRedirectStatus(response?.status)) break;
      if (redirectCount >= 5) {
        return stopWithFailure(safeFailure("FROZEN_V2_REDIRECT_LIMIT_EXCEEDED"));
      }
      const location = headerValue(response?.headers, "location");
      let nextUrl = null;
      try {
        nextUrl = location ? new URL(String(location), currentUrl) : null;
      } catch {
        nextUrl = null;
      }
      if (!isAllowedFrozenRequest(nextUrl)) {
        return stopWithFailure(safeFailure("FROZEN_V2_REDIRECT_NOT_ALLOWED"));
      }
      currentInit = redirectedFetchInit(currentInit, response.status, currentUrl, nextUrl);
      currentUrl = nextUrl;
    }
    if (latchedFailure) return stopWithFailure(latchedFailure);
    const hostname = requestHostname(currentUrl);
    if (!isNaverHostname(hostname)) return response;
    if (!response || typeof response.clone !== "function") return response;

    let clone;
    try {
      clone = response.clone();
    } catch {
      return response;
    }

    let body = "";
    try {
      body = await clone.text();
    } catch {
      body = "";
    }
    const classification = classifyAccessResponse(clone, body);
    body = "";

    if (classification.blocked) {
      return stopWithFailure(safeFailure("NAVER_ACCESS_BLOCKED", classification));
    }
    return response;
  }

  Object.defineProperty(safetyFetch, "name", {
    configurable: true,
    value: "frozenV2SafetyFetch"
  });

  target.fetch = safetyFetch;
  const state = Object.freeze({
    installed: true,
    version: 1,
    isAllowedFrozenRequest,
    isNaverHostname,
    xlsxGuard: installXlsxResolutionGuard()
  });
  Object.defineProperty(target, INSTALL_KEY, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false
  });
  return state;
}

const installedState = installFetchSafetyPreload();

module.exports = {
  classifyAccessResponse,
  isAllowedFrozenRequest,
  installFetchSafetyPreload,
  installXlsxResolutionGuard,
  installedState,
  isNaverHostname,
  parseSafeRetryAfter,
  requestHostname
};
