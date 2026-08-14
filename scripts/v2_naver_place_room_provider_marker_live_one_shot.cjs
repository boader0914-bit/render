"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  FIXED_LEGACY_HEADERS,
  readBoundedBody
} = require("./naver_legacy_canary_live_transport.cjs");
const { classifyNaverAccessResponse } = require("./naver_provider_resilience.cjs");
const {
  CAPTURE_KIND,
  FIXTURE_SCHEMA_VERSION,
  LIVE_CAPTURE_KIND,
  collectRoomProviderMarker
} = require("./v2_naver_place_room_provider_marker_contract.cjs");

const JOB_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-live-job.v1";
const ONE_SHOT_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-live-result.v1";
const ERROR_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-live-error.v2";
const ACCESS_DIAGNOSTIC_SCHEMA_VERSION = "v2-naver-place-room-provider-marker-access-diagnostic.v1";
const REQUEST_ORIGIN = "https://pcmap.place.naver.com";
const ROOM_HEADER_SELECTOR = "h2.place_section_header";
const PROVIDER_MARKER_SELECTOR = ".place_section_header_extra";
const SELECTOR_VERSION = "naver-place-room-header.v1";
const LIVE_APPROVAL_NAME = "N5-D3-Live";
const SAFE_BLOCK_SUBTYPES = new Set(["http_403", "http_429", "challenge_html", "unknown_access_block"]);
const SAFE_HTTP_STATUS_CLASSES = new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "unknown"]);
const SAFE_CONTENT_TYPE_CLASSES = new Set(["html", "xhtml", "other"]);
const ACCESS_DIAGNOSTIC_KEYS = Object.freeze([
  "schemaVersion",
  "blockSubtype",
  "httpStatusClass",
  "contentTypeClass",
  "responseBytes",
  "retryAfterPresent",
  "requestAttempts",
  "fixtureRequests",
  "actualExternalRequests",
  "automaticRetries",
  "automaticFallbacks",
  "operationalWrites",
  "rawProviderResponseStored"
]);

function sanitizeAccessDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...ACCESS_DIAGNOSTIC_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return null;
  const counters = [
    value.requestAttempts,
    value.fixtureRequests,
    value.actualExternalRequests,
    value.automaticRetries,
    value.automaticFallbacks,
    value.operationalWrites
  ];
  if (
    value.schemaVersion !== ACCESS_DIAGNOSTIC_SCHEMA_VERSION
    || !SAFE_BLOCK_SUBTYPES.has(value.blockSubtype)
    || !SAFE_HTTP_STATUS_CLASSES.has(value.httpStatusClass)
    || !SAFE_CONTENT_TYPE_CLASSES.has(value.contentTypeClass)
    || !Number.isInteger(value.responseBytes)
    || value.responseBytes < 0
    || value.responseBytes > 1048576
    || typeof value.retryAfterPresent !== "boolean"
    || counters.some((counter) => !Number.isInteger(counter) || counter < 0 || counter > 1)
    || value.automaticRetries !== 0
    || value.automaticFallbacks !== 0
    || value.operationalWrites !== 0
    || value.rawProviderResponseStored !== false
  ) return null;
  return Object.freeze(Object.fromEntries(ACCESS_DIAGNOSTIC_KEYS.map((key) => [key, value[key]])));
}

class V2NaverPlaceRoomProviderMarkerLiveError extends Error {
  constructor(code, message, diagnostic = null) {
    super(message);
    this.name = "V2NaverPlaceRoomProviderMarkerLiveError";
    this.code = code;
    this.retryable = false;
    this.diagnostic = sanitizeAccessDiagnostic(diagnostic);
  }
}

function fail(code, message, diagnostic = null) {
  throw new V2NaverPlaceRoomProviderMarkerLiveError(code, message, diagnostic);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID", `${label} keys are invalid`);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value))).digest("hex");
}

function integer(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail("V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID", `${field} is invalid`);
  }
  return number;
}

function normalizeJob(input) {
  exactKeys(input, [
    "schemaVersion",
    "runId",
    "mode",
    "placeId",
    "timeoutMs",
    "responseSizeLimitBytes",
    "requestBudget",
    "automaticRetries",
    "automaticFallbacks",
    "fixtureScenario"
  ], "job");
  const job = {
    schemaVersion: input.schemaVersion,
    runId: String(input.runId || "").trim(),
    mode: String(input.mode || "").trim(),
    placeId: String(input.placeId || "").trim(),
    timeoutMs: integer(input.timeoutMs, "timeoutMs", 100, 30000),
    responseSizeLimitBytes: integer(input.responseSizeLimitBytes, "responseSizeLimitBytes", 1024, 1048576),
    requestBudget: integer(input.requestBudget, "requestBudget", 1, 1),
    automaticRetries: integer(input.automaticRetries, "automaticRetries", 0, 0),
    automaticFallbacks: integer(input.automaticFallbacks, "automaticFallbacks", 0, 0),
    fixtureScenario: String(input.fixtureScenario || "").trim()
  };
  if (
    job.schemaVersion !== JOB_SCHEMA_VERSION
    || !/^[a-z0-9][a-z0-9-]{7,100}$/u.test(job.runId)
    || !new Set(["offline", "live"]).has(job.mode)
    || !/^\d{1,30}$/u.test(job.placeId)
    || (job.mode === "offline" && job.fixtureScenario !== "success")
    || (job.mode === "live" && job.fixtureScenario !== "none")
  ) fail("V2_NAVER_ROOM_MARKER_LIVE_JOB_INVALID", "Job fields are invalid");
  return Object.freeze(job);
}

function jobApprovalDigest(input) {
  return sha256(stableJson(normalizeJob(input)));
}

function buildRequestEnvelope(input) {
  const job = normalizeJob(input);
  return Object.freeze({
    method: "GET",
    origin: REQUEST_ORIGIN,
    path: `/accommodation/${job.placeId}/home`,
    queryParameterNames: Object.freeze([]),
    redirect: "manual",
    requestBudget: 1,
    selectors: Object.freeze({
      version: SELECTOR_VERSION,
      roomHeader: ROOM_HEADER_SELECTOR,
      providerMarker: PROVIDER_MARKER_SELECTOR
    })
  });
}

function assertLiveApproval(input, environment = process.env) {
  const job = normalizeJob(input);
  if (job.mode !== "live") return true;
  if (
    environment.V2_NAVER_ROOM_MARKER_LIVE_APPROVED !== LIVE_APPROVAL_NAME
    || environment.V2_NAVER_ROOM_MARKER_REQUEST_BUDGET !== "1"
    || environment.V2_NAVER_ROOM_MARKER_APPROVED_JOB_SHA256 !== jobApprovalDigest(job)
  ) fail("V2_NAVER_ROOM_MARKER_LIVE_APPROVAL_REQUIRED", "Exact N5-D3-Live approval is required");
  return true;
}

function classTokens(attributes) {
  const match = String(attributes || "").match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
  return new Set(String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/u).filter(Boolean));
}

function decodeHtmlText(value) {
  const named = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " });
  return String(value || "")
    .replace(/<br\s*\/?\s*>/giu, " ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (token, entity) => {
      const normalized = String(entity).toLowerCase();
      if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
      if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
      return named[normalized] ?? token;
    })
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractExtraElement(innerHtml) {
  const elements = String(innerHtml || "").matchAll(/<([a-z][a-z0-9:-]*)\b([^>]*)>([\s\S]*?)<\/\1\s*>/giu);
  const matches = [];
  for (const match of elements) {
    if (classTokens(match[2]).has("place_section_header_extra")) {
      matches.push({ full: match[0], inner: match[3] });
    }
  }
  if (matches.length > 1) {
    fail("V2_NAVER_ROOM_MARKER_DOM_AMBIGUOUS", "Room header has multiple provider marker elements");
  }
  return matches[0] || null;
}

function extractRoomSectionsFromPlaceHtml(html) {
  const source = String(html || "");
  if (!source || source.length > 1048576 || /\u0000/u.test(source)) {
    fail("V2_NAVER_ROOM_MARKER_HTML_INVALID", "Place HTML is invalid");
  }
  const sections = [];
  const headings = source.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2\s*>/giu);
  let matchingHeaderCount = 0;
  for (const match of headings) {
    if (!classTokens(match[1]).has("place_section_header")) continue;
    matchingHeaderCount += 1;
    const extra = extractExtraElement(match[2]);
    const headingWithoutExtra = extra ? match[2].replace(extra.full, " ") : match[2];
    const headingText = decodeHtmlText(headingWithoutExtra);
    if (!/^객실\s*[0-9]/u.test(headingText)) continue;
    sections.push(Object.freeze({
      sectionKind: "room_header",
      headingText,
      extraText: extra ? decodeHtmlText(extra.inner) : ""
    }));
  }
  if (matchingHeaderCount === 0 || sections.length === 0) {
    fail("V2_NAVER_ROOM_MARKER_SELECTOR_MISMATCH", "Room header selector did not produce a room observation");
  }
  return Object.freeze(sections);
}

function responseContentType(response) {
  return String(response?.headers?.get?.("content-type") || "").trim().toLowerCase();
}

function contentTypeClass(contentType) {
  const value = String(contentType || "").trim().toLowerCase();
  if (/^text\/html(?:\s*;|$)/u.test(value)) return "html";
  if (/^application\/xhtml\+xml(?:\s*;|$)/u.test(value)) return "xhtml";
  return "other";
}

function hasHeader(headers, name) {
  if (!headers) return false;
  if (typeof headers.has === "function") return headers.has(name);
  if (typeof headers !== "object" || Array.isArray(headers)) return false;
  return Object.keys(headers).some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function buildAccessBlockDiagnostic(access, response, body, audit) {
  const status = Number(response?.status);
  const validStatus = Number.isInteger(status) && status >= 100 && status <= 599;
  const subtype = SAFE_BLOCK_SUBTYPES.has(access?.subtype) ? access.subtype : "unknown_access_block";
  return Object.freeze({
    schemaVersion: ACCESS_DIAGNOSTIC_SCHEMA_VERSION,
    blockSubtype: subtype,
    httpStatusClass: validStatus ? `${Math.floor(status / 100)}xx` : "unknown",
    contentTypeClass: contentTypeClass(responseContentType(response)),
    responseBytes: Buffer.byteLength(String(body || ""), "utf8"),
    retryAfterPresent: hasHeader(response?.headers, "retry-after"),
    requestAttempts: Number(audit?.requestAttempts || 0),
    fixtureRequests: Number(audit?.fixtureRequests || 0),
    actualExternalRequests: Number(audit?.actualExternalRequests || 0),
    automaticRetries: Number(audit?.automaticRetries || 0),
    automaticFallbacks: Number(audit?.automaticFallbacks || 0),
    operationalWrites: Number(audit?.operationalWrites || 0),
    rawProviderResponseStored: audit?.rawProviderResponseStored === true
  });
}

function serializeTerminalError(error) {
  const payload = {
    schemaVersion: ERROR_SCHEMA_VERSION,
    status: "failed",
    code: String(error?.code || "V2_NAVER_ROOM_MARKER_LIVE_FAILED"),
    retryable: false
  };
  const diagnostic = sanitizeAccessDiagnostic(error?.diagnostic);
  if (diagnostic) payload.diagnostic = diagnostic;
  return Object.freeze(payload);
}

function assertFinalResponse(response, envelope) {
  if (response?.redirected === true || (response?.status >= 300 && response?.status < 400)) {
    fail("V2_NAVER_ROOM_MARKER_REDIRECTED", "Place request redirected");
  }
  if (response?.url) {
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch {
      fail("V2_NAVER_ROOM_MARKER_RESPONSE_INVALID", "Final response URL is invalid");
    }
    if (finalUrl.origin !== envelope.origin || finalUrl.pathname !== envelope.path) {
      fail("V2_NAVER_ROOM_MARKER_RESPONSE_MISMATCH", "Final response escaped the approved Place path");
    }
  }
}

async function readPlaceResponse(response, job, envelope, audit) {
  if (!response || !Number.isInteger(Number(response.status))) {
    fail("V2_NAVER_ROOM_MARKER_RESPONSE_INVALID", "Place response is invalid");
  }
  assertFinalResponse(response, envelope);
  const contentType = responseContentType(response);
  let body;
  try {
    body = await readBoundedBody(response, job.responseSizeLimitBytes, { allowTextFallback: true });
  } catch (error) {
    if (error?.code === "NAVER_LEGACY_CANARY_RESPONSE_TOO_LARGE") {
      fail("V2_NAVER_ROOM_MARKER_RESPONSE_TOO_LARGE", "Place response exceeded the approved size limit");
    }
    fail("V2_NAVER_ROOM_MARKER_RESPONSE_INVALID", "Place response body is invalid");
  }
  const access = classifyNaverAccessResponse({
    status: response.status,
    headers: response.headers,
    body,
    apolloStateValidated: false
  });
  if (access.blocked) {
    fail(
      "V2_NAVER_ROOM_MARKER_ACCESS_BLOCKED",
      "Naver Place access was blocked",
      buildAccessBlockDiagnostic(access, response, body, audit)
    );
  }
  if (response.status < 200 || response.status >= 300) {
    fail("V2_NAVER_ROOM_MARKER_HTTP_ERROR", `Naver Place returned HTTP ${response.status}`);
  }
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/u.test(contentType)) {
    fail("V2_NAVER_ROOM_MARKER_CONTENT_TYPE_INVALID", "Place response is not HTML");
  }
  return Object.freeze({
    body,
    responseStatus: Number(response.status),
    contentTypeClass: contentType.startsWith("application/xhtml+xml") ? "xhtml" : "html",
    responseBytes: Buffer.byteLength(body, "utf8")
  });
}

async function runRoomProviderMarkerLiveOneShot(input, options = {}) {
  const job = normalizeJob(input);
  assertLiveApproval(job, options.environment || process.env);
  const fetchImpl = options.fetchImpl || (job.mode === "live" ? globalThis.fetch : null);
  if (typeof fetchImpl !== "function") {
    fail("V2_NAVER_ROOM_MARKER_TRANSPORT_REQUIRED", "An offline fixture transport is required");
  }
  const envelope = buildRequestEnvelope(job);
  const endpoint = `${envelope.origin}${envelope.path}`;
  const audit = {
    requestBudget: 1,
    requestAttempts: 0,
    fixtureRequests: 0,
    actualExternalRequests: 0,
    automaticRetries: 0,
    automaticFallbacks: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeoutMs);
  try {
    audit.requestAttempts += 1;
    if (audit.requestAttempts > audit.requestBudget) {
      fail("V2_NAVER_ROOM_MARKER_REQUEST_BUDGET_EXCEEDED", "Place request budget was exceeded");
    }
    if (job.mode === "live") audit.actualExternalRequests += 1;
    else audit.fixtureRequests += 1;
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        ...FIXED_LEGACY_HEADERS,
        accept: "text/html,application/xhtml+xml;q=0.9",
        referer: endpoint
      },
      redirect: "manual",
      signal: controller.signal
    });
    const safeResponse = await readPlaceResponse(response, job, envelope, audit);
    const sections = extractRoomSectionsFromPlaceHtml(safeResponse.body);
    const markerResult = collectRoomProviderMarker({
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      placeId: job.placeId,
      captureKind: job.mode === "live" ? LIVE_CAPTURE_KIND : CAPTURE_KIND,
      sections
    });
    return Object.freeze({
      schemaVersion: ONE_SHOT_SCHEMA_VERSION,
      runId: job.runId,
      mode: job.mode,
      placeId: job.placeId,
      jobDigestSha256: jobApprovalDigest(job),
      request: Object.freeze({
        method: envelope.method,
        origin: envelope.origin,
        path: envelope.path,
        queryParameterNames: envelope.queryParameterNames,
        selectorVersion: envelope.selectors.version
      }),
      response: Object.freeze({
        status: safeResponse.responseStatus,
        contentTypeClass: safeResponse.contentTypeClass,
        responseBytes: safeResponse.responseBytes,
        parseStatus: "parsed"
      }),
      observation: markerResult,
      audit: Object.freeze(audit)
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail("V2_NAVER_ROOM_MARKER_TIMEOUT", "Place request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function allowedJobPath(value, mode) {
  const fixtureMode = mode === "fixture";
  const root = fixtureMode
    ? path.resolve(__dirname, "..", "tests", "fixtures")
    : path.resolve(__dirname, "..", "docs");
  const target = path.resolve(String(value || ""));
  const validName = fixtureMode
    ? path.extname(target).toLowerCase() === ".json"
    : target.toLowerCase().endsWith(".proposal.json");
  if (!target.startsWith(`${root}${path.sep}`) || !validName) {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID", "Job path is outside its approved mode root");
  }
  return target;
}

function allowedHtmlPath(value) {
  const root = path.resolve(__dirname, "..", "tests", "fixtures");
  const target = path.resolve(String(value || ""));
  if (!target.startsWith(`${root}${path.sep}`) || !target.toLowerCase().endsWith(".sanitized.html")) {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_PATH_INVALID", "HTML must be a sanitized fixture under tests/fixtures");
  }
  return target;
}

function readJson(target) {
  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    fail("V2_NAVER_ROOM_MARKER_FIXTURE_INVALID", "Fixture JSON is invalid");
  }
}

async function main(argv = process.argv.slice(2)) {
  const mode = String(argv[0] || "");
  if (mode === "fixture" && argv.length === 3) {
    const job = normalizeJob(readJson(allowedJobPath(argv[1], mode)));
    if (job.mode !== "offline") fail("V2_NAVER_ROOM_MARKER_MODE_INVALID", "Fixture CLI requires an offline job");
    const html = fs.readFileSync(allowedHtmlPath(argv[2]), "utf8");
    return runRoomProviderMarkerLiveOneShot(job, {
      fetchImpl: async () => new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      })
    });
  }
  if (mode === "live" && argv.length === 2) {
    const job = normalizeJob(readJson(allowedJobPath(argv[1], mode)));
    if (job.mode !== "live") fail("V2_NAVER_ROOM_MARKER_MODE_INVALID", "Live CLI requires a live job");
    return runRoomProviderMarkerLiveOneShot(job);
  }
  fail("V2_NAVER_ROOM_MARKER_MODE_INVALID", "Expected fixture <job.json> <capture.sanitized.html> or live <job.json>");
}

if (require.main === module) {
  main().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify(serializeTerminalError(error))}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ACCESS_DIAGNOSTIC_SCHEMA_VERSION,
  ERROR_SCHEMA_VERSION,
  JOB_SCHEMA_VERSION,
  LIVE_APPROVAL_NAME,
  ONE_SHOT_SCHEMA_VERSION,
  PROVIDER_MARKER_SELECTOR,
  REQUEST_ORIGIN,
  ROOM_HEADER_SELECTOR,
  SELECTOR_VERSION,
  V2NaverPlaceRoomProviderMarkerLiveError,
  allowedJobPath,
  assertLiveApproval,
  buildAccessBlockDiagnostic,
  buildRequestEnvelope,
  contentTypeClass,
  decodeHtmlText,
  extractRoomSectionsFromPlaceHtml,
  jobApprovalDigest,
  main,
  normalizeJob,
  runRoomProviderMarkerLiveOneShot,
  sanitizeAccessDiagnostic,
  serializeTerminalError
};
