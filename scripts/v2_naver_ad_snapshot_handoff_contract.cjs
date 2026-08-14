"use strict";

(function installV2NaverAdSnapshotHandoffContract() {
const MESSAGE_TYPE = "v2-naver-visible-place-ad-handoff.v1";
const SEARCH_ORIGIN = "https://search.naver.com";
const SEARCH_PATH = "/search.naver";
const HASH_NONCE_NAME = "datalabCapture";
const HASH_ORIGIN_NAME = "datalabOrigin";
const NONCE_PATTERN = /^[a-f0-9]{32}$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function reject(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function cleanText(value, limit) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, limit);
}

function normalizeNonce(value) {
  const nonce = String(value || "").trim();
  if (!NONCE_PATTERN.test(nonce)) reject("capture-handoff-nonce-invalid");
  return nonce;
}

function normalizeReturnOrigin(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    reject("capture-handoff-origin-invalid");
  }
  const localHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp)
    || url.origin !== String(value || "")
    || url.username
    || url.password
  ) reject("capture-handoff-origin-invalid");
  return url.origin;
}

function createCaptureNonce(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
    reject("capture-handoff-crypto-unavailable");
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function createCaptureSearchUrl({ keyword, nonce, returnOrigin }) {
  const query = cleanText(keyword, 120);
  if (!query || /[\u0000-\u001f\u007f<>]/u.test(query)) reject("capture-handoff-query-invalid");
  const normalizedNonce = normalizeNonce(nonce);
  const normalizedOrigin = normalizeReturnOrigin(returnOrigin);
  const url = new URL(SEARCH_PATH, SEARCH_ORIGIN);
  url.searchParams.set("where", "nexearch");
  url.searchParams.set("query", query);
  const fragment = new URLSearchParams();
  fragment.set(HASH_NONCE_NAME, normalizedNonce);
  fragment.set(HASH_ORIGIN_NAME, normalizedOrigin);
  url.hash = fragment.toString();
  return url.toString();
}

function createHandoffMessage(capture, nonce) {
  if (!capture || typeof capture !== "object" || Array.isArray(capture)) {
    reject("capture-handoff-payload-invalid");
  }
  return Object.freeze({
    type: MESSAGE_TYPE,
    nonce: normalizeNonce(nonce),
    capture
  });
}

function validateHandoffMessage(value, { expectedNonce } = {}) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "capture,nonce,type"
    || value.type !== MESSAGE_TYPE
    || normalizeNonce(value.nonce) !== normalizeNonce(expectedNonce)
    || !value.capture
    || typeof value.capture !== "object"
    || Array.isArray(value.capture)
  ) reject("capture-handoff-message-invalid");
  return value.capture;
}

const publicApi = Object.freeze({
  HASH_NONCE_NAME,
  HASH_ORIGIN_NAME,
  MESSAGE_TYPE,
  NONCE_PATTERN,
  SEARCH_ORIGIN,
  SEARCH_PATH,
  createCaptureNonce,
  createCaptureSearchUrl,
  createHandoffMessage,
  normalizeReturnOrigin,
  validateHandoffMessage
});

if (typeof module !== "undefined" && module.exports) module.exports = publicApi;
if (typeof document !== "undefined" && typeof globalThis !== "undefined") {
  globalThis.V2NaverAdSnapshotHandoffContract = publicApi;
}
})();
