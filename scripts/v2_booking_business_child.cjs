"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createRenderNetworkRecorder } = require("./v2_booking_business_render_network_diagnostics.cjs");

const PCMAP_GRAPHQL_URL = "https://pcmap-api.place.naver.com/graphql";
const RESULT_SCHEMA_VERSION = "v2-booking-business-child-result.v1";
const REPLAY_SCHEMA_VERSION = "v2-booking-business-sanitized-replay.v1";
const REQUEST_ENVELOPE_SCHEMA_VERSION = "v2-booking-business-fetch-envelope.v1";
const COPY_ONLY_APPROVED_JOB_SHA256 = "35875d7b67f83deff6abe46e8deb606cb6f8506fdd641030f9a829cf51fdc308";
const COPY_ONLY_EXPECTED_ENVELOPE_SHA256 = "2078ad1e1f436f524058822079837a8ab222eea7e54b375a7ad7fc2bba378d1d";
const LIVE_PLACE_ID_HASH = "2da4b6a5cb5efeff892338aa41ebbd81a4d9a49adf20ad414db547a041b4b20c";
const ALLOWED_MODES = new Set(["fixture", "replay", "live"]);
const REQUEST_HEADER_NAMES = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
  "origin",
  "referer",
  "user-agent"
]);
const ALLOWED_SCENARIOS = new Set([
  "success",
  "zero_null_booking",
  "zero_missing_booking",
  "graphql_error",
  "malformed_booking",
  "business_null",
  "malformed_json",
  "http_403",
  "http_429",
  "http_405",
  "http_405_challenge",
  "challenge_html",
  "http_500",
  "timeout",
  "oversized"
]);

class V2BookingBusinessChildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "V2BookingBusinessChildError";
    this.code = code;
    this.retryable = false;
  }
}

function fail(code, message) {
  throw new V2BookingBusinessChildError(code, message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function positiveInteger(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail("V2_BOOKING_BUSINESS_CHILD_CONFIG_INVALID", `${label} is invalid`);
  }
  return parsed;
}

function safeIdentifier(value, label) {
  const text = String(value || "").trim();
  if (!/^\d{1,30}$/u.test(text)) fail("V2_BOOKING_BUSINESS_CHILD_CONFIG_INVALID", `${label} is invalid`);
  return text;
}

function normalizeHeaderValue(value) {
  return String(value || "").trim().replace(/[\t ]+/gu, " ");
}

function requestHeaders(initHeaders) {
  const headers = new Headers(initHeaders || {});
  return Object.fromEntries([...headers.entries()].map(([name, value]) => [
    String(name).toLowerCase(),
    normalizeHeaderValue(value)
  ]));
}

function expectedRequestHeaders(placeId) {
  return Object.freeze({
    accept: "*/*",
    "accept-language": "ko-KR,ko;q=0.9",
    "content-type": "application/json",
    origin: "https://pcmap.place.naver.com",
    referer: `https://pcmap.place.naver.com/accommodation/${placeId}`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"
  });
}

function contentTypeClass(headers) {
  const value = String(headers?.get?.("content-type") || "").toLowerCase().split(";", 1)[0].trim();
  if (!value) return "none";
  if (value === "application/json" || value.endsWith("+json")) return "json";
  if (value === "text/html" || value === "application/xhtml+xml") return "html";
  if (value.startsWith("text/")) return "text";
  return "other";
}

function retryAfterSeconds(headers) {
  const value = String(headers?.get?.("retry-after") || "").trim();
  if (!/^\d{1,6}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : null;
}

function safeFetchFailureClass(error) {
  if (error?.name === "AbortError") return "aborted";
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) {
    return "timeout";
  }
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(code)) return "connection";
  if (["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(code)) return "tls";
  return "network";
}

function requestEnvelope(url, init, body, placeId) {
  const headers = requestHeaders(init?.headers);
  const headerNames = Object.keys(headers).sort();
  if (stableJson(headerNames) !== stableJson(REQUEST_HEADER_NAMES)) {
    fail("V2_BOOKING_BUSINESS_REQUEST_HEADERS_INVALID", "request header names changed");
  }
  const expected = expectedRequestHeaders(placeId);
  if (headerNames.some((name) => headers[name] !== expected[name])) {
    fail("V2_BOOKING_BUSINESS_REQUEST_HEADERS_INVALID", "request header values changed");
  }
  const bodyText = String(init?.body || "");
  const parsed = new URL(String(url));
  const value = Object.freeze({
    schemaVersion: REQUEST_ENVELOPE_SCHEMA_VERSION,
    method: "POST",
    origin: parsed.origin,
    path: parsed.pathname,
    redirect: "manual",
    headerNames,
    headerValueSha256: Object.freeze(Object.fromEntries(headerNames.map((name) => [name, sha256(headers[name])]))),
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
    bodySha256: sha256(bodyText),
    operationName: body.operationName,
    variableNames: Object.keys(body.variables).sort(),
    placeIdHash: sha256(placeId),
    querySha256: sha256(body.query),
    headerValuesStored: false,
    bodyStored: false,
    fullUrlStored: false
  });
  return Object.freeze({ ...value, envelopeSha256: sha256(stableJson(value)) });
}

function safeSourceRoot(value) {
  const root = path.resolve(String(value || ""));
  const collector = path.join(root, "scripts", "gyeongnam_glamping_crawl.cjs");
  const transport = path.join(root, "scripts", "naver_bounded_inventory_live_transport.cjs");
  if (!fs.statSync(collector, { throwIfNoEntry: false })?.isFile() || !fs.statSync(transport, { throwIfNoEntry: false })?.isFile()) {
    fail("V2_BOOKING_BUSINESS_SOURCE_INVALID", "source root is missing the frozen collector closure");
  }
  return root;
}

function functionSource(crawler, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(crawler);
  if (!match) fail("V2_BOOKING_BUSINESS_SOURCE_INVALID", `collector function is missing: ${name}`);
  const signatureClose = crawler.indexOf(")", match.index);
  const bodyOpen = crawler.indexOf("{", signatureClose);
  if (signatureClose < 0 || bodyOpen < 0) fail("V2_BOOKING_BUSINESS_SOURCE_INVALID", `collector function is malformed: ${name}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = bodyOpen; index < crawler.length; index += 1) {
    const character = crawler[index];
    const next = crawler[index + 1] || "";
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (["\"", "'", "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return crawler.slice(match.index, index + 1);
  }
  fail("V2_BOOKING_BUSINESS_SOURCE_INVALID", `collector function is unbalanced: ${name}`);
}

function fixtureEnvelope(scenario, placeId) {
  const bookingBusinessId = `9${String(placeId).slice(-9).padStart(9, "0")}`;
  const success = {
    data: {
      business: {
        base: { id: placeId, name: "Fixture Booking Lodge" },
        naverBooking: {
          bookingBusinessId,
          naverBookingUrl: `https://m.booking.naver.com/booking/3/bizes/${bookingBusinessId}`,
          naverBookingHubUrl: null
        }
      }
    }
  };
  if (scenario === "success") return { status: 200, contentType: "application/json", body: JSON.stringify(success) };
  if (scenario === "zero_null_booking") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ data: { business: { base: { id: placeId }, naverBooking: null } } }) };
  }
  if (scenario === "zero_missing_booking") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ data: { business: { base: { id: placeId } } } }) };
  }
  if (scenario === "graphql_error") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ errors: [{ message: "fixture GraphQL error" }], data: null }) };
  }
  if (scenario === "malformed_booking") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ data: { business: { naverBooking: "invalid" } } }) };
  }
  if (scenario === "business_null") {
    return { status: 200, contentType: "application/json", body: JSON.stringify({ data: { business: null } }) };
  }
  if (scenario === "malformed_json") return { status: 200, contentType: "application/json", body: "{" };
  if (scenario === "http_403") return { status: 403, contentType: "text/plain", body: "" };
  if (scenario === "http_429") return { status: 429, contentType: "text/plain", body: "", retryAfter: "120" };
  if (scenario === "http_405") return { status: 405, contentType: "text/plain", body: "method not allowed" };
  if (scenario === "http_405_challenge") {
    return { status: 405, contentType: "text/html", body: "<!doctype html><html><body>CAPTCHA access denied</body></html>" };
  }
  if (scenario === "challenge_html") {
    return { status: 200, contentType: "text/html", body: "<!doctype html><html><body>CAPTCHA access denied</body></html>" };
  }
  if (scenario === "http_500") return { status: 500, contentType: "application/json", body: JSON.stringify({ error: "fixture unavailable" }) };
  if (scenario === "oversized") return { status: 200, contentType: "application/json", body: "{}", declaredLength: 2 * 1024 * 1024 + 1 };
  if (scenario === "timeout") return { timeout: true };
  fail("V2_BOOKING_BUSINESS_FIXTURE_INVALID", "fixture scenario is not allowed");
}

function readReplayEnvelope(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (
    !exactKeys(value, ["schemaVersion", "status", "contentType", "body"])
    || value.schemaVersion !== REPLAY_SCHEMA_VERSION
    || !Number.isInteger(value.status)
    || value.status < 100
    || value.status > 599
    || typeof value.contentType !== "string"
    || !value.body
    || typeof value.body !== "object"
    || Array.isArray(value.body)
  ) fail("V2_BOOKING_BUSINESS_REPLAY_INVALID", "sanitized replay envelope is invalid");
  return { status: value.status, contentType: value.contentType, body: JSON.stringify(value.body) };
}

function assertGraphqlBoundary(url, init, expectedQuery, placeId) {
  const parsed = new URL(String(url));
  if (
    parsed.origin !== "https://pcmap-api.place.naver.com"
    || parsed.pathname !== "/graphql"
    || parsed.search !== ""
    || String(init?.method || "").toUpperCase() !== "POST"
    || init?.redirect !== "manual"
  ) fail("V2_BOOKING_BUSINESS_ENDPOINT_FORBIDDEN", "request escaped the approved booking-business GraphQL endpoint");
  let body;
  try {
    body = JSON.parse(String(init?.body || ""));
  } catch {
    fail("V2_BOOKING_BUSINESS_REQUEST_INVALID", "GraphQL request body is invalid");
  }
  if (
    !exactKeys(body, ["operationName", "query", "variables"])
    || body.operationName !== "naverBookingBusiness"
    || body.query !== expectedQuery
    || !exactKeys(body.variables, ["id", "isNx"])
    || body.variables.id !== placeId
    || body.variables.isNx !== false
  ) fail("V2_BOOKING_BUSINESS_REQUEST_INVALID", "GraphQL request contract changed");
  return body;
}

function createOneShotFetchBoundary(options) {
  const mode = options.mode;
  const placeId = options.placeId;
  const expectedQuery = options.expectedQuery;
  const envelope = options.envelope;
  const actualFetch = options.actualFetch;
  let callCount = 0;
  let externalCallCount = 0;
  let fixtureCallCount = 0;
  let responseStatus = null;
  let responseDiagnostic = null;
  let requestAudit = null;

  const boundary = async (url, init = {}) => {
    if (callCount !== 0) fail("V2_BOOKING_BUSINESS_CALL_BUDGET_EXCEEDED", "booking-business request budget exceeded one");
    const body = assertGraphqlBoundary(url, init, expectedQuery, placeId);
    const envelopeAudit = requestEnvelope(url, init, body, placeId);
    if (mode === "live" && (
      options.expectedEnvelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
      || envelopeAudit.envelopeSha256 !== COPY_ONLY_EXPECTED_ENVELOPE_SHA256
    )) fail("V2_BOOKING_BUSINESS_ENVELOPE_MISMATCH", "live request envelope does not match the approved digest");
    callCount += 1;
    requestAudit = Object.freeze({
      method: "POST",
      origin: "https://pcmap-api.place.naver.com",
      path: "/graphql",
      operationName: body.operationName,
      variableNames: Object.keys(body.variables).sort(),
      placeIdHash: sha256(placeId),
      querySha256: sha256(body.query),
      fetchEnvelope: envelopeAudit
    });
    if (mode === "live") {
      externalCallCount += 1;
      const started = process.hrtime.bigint();
      let response;
      try {
        response = await actualFetch(url, init);
      } catch (error) {
        responseDiagnostic = Object.freeze({
          status: null,
          contentTypeClass: "none",
          fetchHeadersElapsedMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          fetchOutcome: "rejected",
          fetchFailureClass: safeFetchFailureClass(error),
          retryAfterSeconds: null,
          rawBodyStored: false,
          responseHeadersStored: false
        });
        throw error;
      }
      responseStatus = Number(response?.status) || null;
      responseDiagnostic = Object.freeze({
        status: responseStatus,
        contentTypeClass: contentTypeClass(response?.headers),
        fetchHeadersElapsedMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        fetchOutcome: "response",
        fetchFailureClass: null,
        retryAfterSeconds: retryAfterSeconds(response?.headers),
        rawBodyStored: false,
        responseHeadersStored: false
      });
      return response;
    }
    fixtureCallCount += 1;
    if (envelope.timeout) {
      responseDiagnostic = Object.freeze({
        status: null,
        contentTypeClass: "none",
        fetchHeadersElapsedMs: null,
        fetchOutcome: "fixture_timeout",
        fetchFailureClass: "aborted",
        retryAfterSeconds: null,
        rawBodyStored: false,
        responseHeadersStored: false
      });
      return new Promise((resolve, reject) => {
        let settled = false;
        const rejectTimeout = () => {
          if (settled) return;
          settled = true;
          clearTimeout(keepAlive);
          reject(Object.assign(new Error("fixture timeout"), { name: "AbortError" }));
        };
        const keepAlive = setTimeout(rejectTimeout, options.timeoutMs + 100);
        const abort = rejectTimeout;
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener?.("abort", abort, { once: true });
      });
    }
    responseStatus = envelope.status;
    const headers = { "content-type": envelope.contentType };
    if (envelope.declaredLength) headers["content-length"] = String(envelope.declaredLength);
    if (envelope.retryAfter) headers["retry-after"] = envelope.retryAfter;
    const response = new Response(envelope.body, { status: envelope.status, headers });
    responseDiagnostic = Object.freeze({
      status: responseStatus,
      contentTypeClass: contentTypeClass(response.headers),
      fetchHeadersElapsedMs: null,
      fetchOutcome: "fixture_response",
      fetchFailureClass: null,
      retryAfterSeconds: retryAfterSeconds(response.headers),
      rawBodyStored: false,
      responseHeadersStored: false
    });
    return response;
  };
  Object.defineProperties(boundary, {
    audit: {
      value: () => Object.freeze({
        callCount,
        externalCallCount,
        fixtureCallCount,
        responseStatus,
        responseDiagnostic,
        request: requestAudit
      })
    }
  });
  return boundary;
}

function sanitizedReplayFromResult(result) {
  if (result.classification === "resolved") {
    return {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      status: 200,
      contentType: "application/json",
      body: {
        data: {
          business: {
            naverBooking: {
              bookingBusinessId: result.bookingBusinessId,
              naverBookingUrl: result.bookingUrl || null,
              naverBookingHubUrl: null
            }
          }
        }
      }
    };
  }
  if (result.classification === "zero") {
    return {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      status: 200,
      contentType: "application/json",
      body: { data: { business: { naverBooking: null } } }
    };
  }
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    status: 200,
    contentType: "application/json",
    body: { errors: [{ code: "sanitized_unavailable" }], data: null }
  };
}

function classifyResult(value) {
  const bookingBusinessId = String(value?.bookingBusinessId || "");
  const bookingUrl = String(value?.bookingUrl || "");
  if (bookingBusinessId) {
    return {
      classification: "resolved",
      bookingBusinessId,
      bookingBusinessIdHash: sha256(bookingBusinessId),
      bookingUrl,
      bookingUrlPresent: Boolean(bookingUrl),
      providerConfirmedZero: false,
      providerErrors: false
    };
  }
  if (value?.providerConfirmedZero === true) {
    return {
      classification: "zero",
      bookingBusinessId: "",
      bookingBusinessIdHash: null,
      bookingUrl: "",
      bookingUrlPresent: false,
      providerConfirmedZero: true,
      providerErrors: false
    };
  }
  return {
    classification: "unavailable",
    bookingBusinessId: "",
    bookingBusinessIdHash: null,
    bookingUrl: "",
    bookingUrlPresent: false,
    providerConfirmedZero: false,
    providerErrors: Array.isArray(value?.errors) && value.errors.length > 0
  };
}

async function execute(config = process.env) {
  const sourceRoot = safeSourceRoot(config.V2_BOOKING_BUSINESS_SOURCE_ROOT);
  const placeId = safeIdentifier(config.V2_BOOKING_BUSINESS_PLACE_ID, "place ID");
  const mode = String(config.V2_BOOKING_BUSINESS_TRANSPORT_MODE || "");
  if (!ALLOWED_MODES.has(mode)) fail("V2_BOOKING_BUSINESS_CHILD_CONFIG_INVALID", "transport mode is invalid");
  const scenario = String(config.V2_BOOKING_BUSINESS_FIXTURE_SCENARIO || "success");
  if (mode === "fixture" && !ALLOWED_SCENARIOS.has(scenario)) {
    fail("V2_BOOKING_BUSINESS_FIXTURE_INVALID", "fixture scenario is invalid");
  }
  if (mode === "live" && (
    config.V2_BOOKING_BUSINESS_LIVE_APPROVED !== "N3-Copy-Only-Live"
    || config.V2_BOOKING_BUSINESS_APPROVED_JOB_SHA256 !== COPY_ONLY_APPROVED_JOB_SHA256
    || sha256(placeId) !== LIVE_PLACE_ID_HASH
  )) fail("V2_BOOKING_BUSINESS_LIVE_NOT_APPROVED", "copy-only live booking-business call is not approved");
  const checkIn = String(config.V2_BOOKING_BUSINESS_CHECK_IN || "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(checkIn) || Number.isNaN(Date.parse(`${checkIn}T00:00:00Z`))) {
    fail("V2_BOOKING_BUSINESS_CHILD_CONFIG_INVALID", "check-in is invalid");
  }
  const adults = positiveInteger(config.V2_BOOKING_BUSINESS_ADULTS, "adult count", 20);
  const timeoutMs = positiveInteger(config.V2_BOOKING_BUSINESS_TIMEOUT_MS, "timeout", 25_000);
  const responseSizeLimit = positiveInteger(config.V2_BOOKING_BUSINESS_RESPONSE_LIMIT_BYTES, "response size limit", 2 * 1024 * 1024);
  const crawlerPath = path.join(sourceRoot, "scripts", "gyeongnam_glamping_crawl.cjs");
  const crawler = fs.readFileSync(crawlerPath, "utf8");
  const names = [
    "assertNaverTransportAvailable",
    "throwIfNaverAccessBlocked",
    "executeBoundedInventoryGraphql",
    "getNaverBookingBusiness"
  ];
  const sources = Object.fromEntries(names.map((name) => [name, functionSource(crawler, name)]));
  const sourceDigest = sha256(names.map((name) => sources[name]).join("\n"));
  const localRequire = createRequire(path.join(sourceRoot, "package.json"));
  const { createCrawlFailure } = localRequire("./scripts/crawl_failure_contract.cjs");
  const { classifyNaverAccessResponse } = localRequire("./scripts/naver_provider_resilience.cjs");
  const { createNaverBoundedInventoryLiveTransport, GRAPHQL_DOCUMENTS } = localRequire("./scripts/naver_bounded_inventory_live_transport.cjs");
  const expectedQuery = GRAPHQL_DOCUMENTS.naver_booking_business;
  const envelope = mode === "replay"
    ? readReplayEnvelope(config.V2_BOOKING_BUSINESS_REPLAY_FILE)
    : (mode === "fixture" ? fixtureEnvelope(scenario, placeId) : null);
  const fetchBoundary = createOneShotFetchBoundary({
    mode,
    placeId,
    expectedQuery,
    envelope,
    timeoutMs,
    expectedEnvelopeSha256: config.V2_BOOKING_BUSINESS_EXPECTED_ENVELOPE_SHA256,
    actualFetch: globalThis.fetch
  });
  const transport = createNaverBoundedInventoryLiveTransport({
    enabled: true,
    fetchImpl: fetchBoundary,
    providerId: "naver_booking_detail",
    allowTextFallback: mode !== "live",
    budgetProfileId: "top3_v1",
    bookingRangeDays: 1,
    timeoutMs,
    maxResponseBytes: responseSizeLimit
  });
  const sandbox = vm.createContext({
    classifyNaverAccessResponse,
    createCrawlFailure,
    CHECK_IN: checkIn,
    ADULTS: adults,
    NAVER_LEGACY_INVENTORY_ACTIVATION: true,
    NAVER_BOUNDED_INVENTORY_TRANSPORT: transport,
    NAVER_BOOKING_DETAIL_RECOVERY_PROBE: true,
    naverBookingBusinessQuery: expectedQuery
  });
  vm.runInContext(
    `let naverAccessFailure = null;\n${names.map((name) => sources[name]).join("\n")}\nthis.lookup = getNaverBookingBusiness;`,
    sandbox
  );
  const networkRecorder = config.V2_BOOKING_BUSINESS_NETWORK_DIAGNOSTICS === "1"
    ? (globalThis.__V2_BOOKING_BUSINESS_RENDER_NETWORK_RECORDER__ || createRenderNetworkRecorder())
    : null;
  let normalized;
  let error = null;
  let networkDiagnostic = null;
  try {
    normalized = classifyResult(await sandbox.lookup(placeId, 1));
  } catch (caught) {
    const providerFailureSubtype = ["http_403", "http_429", "challenge_html", "unknown_access_block"].includes(caught?.providerFailureSubtype)
      ? caught.providerFailureSubtype
      : null;
    error = {
      code: String(caught?.code || "V2_BOOKING_BUSINESS_LOOKUP_FAILED"),
      retryable: Boolean(caught?.retryable),
      providerFailureSubtype,
      providerHttpStatus: Number.isInteger(caught?.providerHttpStatus) ? caught.providerHttpStatus : null,
      retryAfterSeconds: providerFailureSubtype === "http_429" && Number.isInteger(caught?.retryAfterSeconds)
        ? caught.retryAfterSeconds
        : null
    };
    normalized = {
      classification: "failed",
      bookingBusinessId: "",
      bookingBusinessIdHash: null,
      bookingUrl: "",
      bookingUrlPresent: false,
      providerConfirmedZero: false,
      providerErrors: false
    };
  } finally {
    networkDiagnostic = networkRecorder?.snapshot() || null;
    networkRecorder?.close();
  }
  const transportCounts = transport.callCounts();
  const boundaryAudit = fetchBoundary.audit();
  if (
    transportCounts.naver_booking_business !== 1
    || transportCounts.naver_booking_items !== 0
    || transportCounts.naver_booking_schedule !== 0
    || transportCounts.total !== 1
    || boundaryAudit.callCount !== 1
  ) fail("V2_BOOKING_BUSINESS_CALL_AUDIT_INVALID", "booking-business execution escaped the one-call contract");
  const result = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    status: error ? "failed" : "succeeded",
    classification: normalized.classification,
    placeId,
    placeIdHash: sha256(placeId),
    bookingBusinessId: normalized.bookingBusinessId,
    bookingBusinessIdHash: normalized.bookingBusinessIdHash,
    bookingUrl: normalized.bookingUrl,
    bookingUrlPresent: normalized.bookingUrlPresent,
    providerConfirmedZero: normalized.providerConfirmedZero,
    providerErrors: normalized.providerErrors,
    providerStatus: boundaryAudit.responseStatus,
    responseDiagnostic: boundaryAudit.responseDiagnostic,
    error,
    runtime: {
      nodeVersion: process.version,
      undiciVersion: process.versions.undici || null,
      platform: process.platform,
      architecture: process.arch
    },
    sourceFunctionDigest: sourceDigest,
    querySha256: sha256(expectedQuery),
    request: boundaryAudit.request,
    networkDiagnostic,
    calls: {
      bookingBusiness: transportCounts.naver_booking_business,
      bookingItems: transportCounts.naver_booking_items,
      dailySchedule: transportCounts.naver_booking_schedule,
      total: transportCounts.total,
      actualExternal: boundaryAudit.externalCallCount,
      fixture: boundaryAudit.fixtureCallCount
    },
    concurrency: transport.maxObservedConcurrency(),
    retries: 0,
    fallbacks: 0,
    htmlFallbackCalls: 0,
    historicalFallbackReads: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    headersStored: false,
    fullRequestUrlStored: false
  };
  result.sanitizedReplay = sanitizedReplayFromResult(result);
  return Object.freeze(result);
}

async function main() {
  try {
    const result = await execute(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: RESULT_SCHEMA_VERSION,
      status: "failed",
      classification: "failed",
      error: { code: String(error?.code || "V2_BOOKING_BUSINESS_CHILD_FAILED"), retryable: false },
      calls: { bookingBusiness: 0, bookingItems: 0, dailySchedule: 0, total: 0, actualExternal: 0, fixture: 0 },
      retries: 0,
      fallbacks: 0,
      operationalWrites: 0,
      rawProviderResponseStored: false,
      headersStored: false,
      fullRequestUrlStored: false
    })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  ALLOWED_SCENARIOS,
  COPY_ONLY_APPROVED_JOB_SHA256,
  COPY_ONLY_EXPECTED_ENVELOPE_SHA256,
  PCMAP_GRAPHQL_URL,
  REPLAY_SCHEMA_VERSION,
  REQUEST_ENVELOPE_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  assertGraphqlBoundary,
  createOneShotFetchBoundary,
  execute,
  fixtureEnvelope,
  functionSource,
  requestEnvelope,
  sanitizedReplayFromResult
};
