"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readBoundedBody } = require("./naver_legacy_canary_live_transport.cjs");

const JOB_SCHEMA_VERSION = "v2-naver-integrated-search-ad-diagnostic-job.v1";
const RESULT_SCHEMA_VERSION = "v2-naver-integrated-search-ad-diagnostic-result.v1";
const ERROR_SCHEMA_VERSION = "v2-naver-integrated-search-ad-diagnostic-error.v1";
const REQUEST_ORIGIN = "https://search.naver.com";
const REQUEST_PATH = "/search.naver";
const REQUEST_WHERE = "nexearch";
const LIVE_APPROVAL_NAME = "N8-D1-Live";
const MAX_ADVERTISEMENTS = 100;
const MAX_ANCHORS_PER_CONTAINER = 200;
const MAX_CONTAINERS = 500;
const FIXED_HEADERS = Object.freeze({
  accept: "text/html,application/xhtml+xml",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.5",
  "cache-control": "no-cache",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0.0.0 Safari/537.36"
});

class V2NaverIntegratedSearchAdDiagnosticError extends Error {
  constructor(code, stage, message, details = {}) {
    super(message);
    this.name = "V2NaverIntegratedSearchAdDiagnosticError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
    this.details = details && typeof details === "object" ? details : {};
  }
}

function fail(code, stage, message, details = {}) {
  throw new V2NaverIntegratedSearchAdDiagnosticError(code, stage, message, details);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("V2_N8_JOB_INVALID", "job-validation", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("V2_N8_JOB_INVALID", "job-validation", `${label} keys are invalid`);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function integer(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail("V2_N8_JOB_INVALID", "job-validation", `${field} is invalid`);
  }
  return number;
}

function cleanText(value, limit) {
  return String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function normalizeJob(input) {
  exactKeys(input, [
    "schemaVersion",
    "runId",
    "mode",
    "keyword",
    "timeoutMs",
    "responseSizeLimitBytes",
    "requestBudget",
    "automaticRetries",
    "automaticFallbacks",
    "fixtureScenario"
  ], "job");
  const job = {
    schemaVersion: String(input.schemaVersion || ""),
    runId: String(input.runId || "").trim(),
    mode: String(input.mode || "").trim(),
    keyword: cleanText(input.keyword, 120),
    timeoutMs: integer(input.timeoutMs, "timeoutMs", 500, 30000),
    responseSizeLimitBytes: integer(input.responseSizeLimitBytes, "responseSizeLimitBytes", 16384, 4194304),
    requestBudget: integer(input.requestBudget, "requestBudget", 1, 1),
    automaticRetries: integer(input.automaticRetries, "automaticRetries", 0, 0),
    automaticFallbacks: integer(input.automaticFallbacks, "automaticFallbacks", 0, 0),
    fixtureScenario: String(input.fixtureScenario || "").trim()
  };
  if (
    job.schemaVersion !== JOB_SCHEMA_VERSION
    || !/^[a-z0-9][a-z0-9-]{7,100}$/u.test(job.runId)
    || !new Set(["offline", "live"]).has(job.mode)
    || job.keyword.length < 2
    || /[<>]/u.test(job.keyword)
    || (job.mode === "offline" && !new Set(["visible-ads", "empty"]).has(job.fixtureScenario))
    || (job.mode === "live" && job.fixtureScenario !== "none")
  ) fail("V2_N8_JOB_INVALID", "job-validation", "Job fields are invalid");
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
    path: REQUEST_PATH,
    queryParameterNames: Object.freeze(["where", "query"]),
    where: REQUEST_WHERE,
    keyword: job.keyword,
    redirect: "manual",
    requestBudget: 1,
    headerNames: Object.freeze(Object.keys(FIXED_HEADERS).sort())
  });
}

function assertLiveApproval(input, environment = process.env) {
  const job = normalizeJob(input);
  if (job.mode !== "live") return true;
  if (
    environment.V2_N8_INTEGRATED_AD_LIVE_APPROVED !== LIVE_APPROVAL_NAME
    || environment.V2_N8_INTEGRATED_AD_REQUEST_BUDGET !== "1"
    || environment.V2_N8_INTEGRATED_AD_APPROVED_JOB_SHA256 !== jobApprovalDigest(job)
  ) fail("V2_N8_LIVE_APPROVAL_REQUIRED", "approval", "Exact N8-D1-Live approval is required");
  return true;
}

function decodeHtml(value) {
  const named = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " });
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (token, entity) => {
    const normalized = String(entity).toLowerCase();
    if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    return named[normalized] ?? token;
  });
}

function attributeValue(attributes, name) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "iu");
  const match = String(attributes || "").match(pattern);
  return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function textFromHtml(value) {
  return cleanText(
    decodeHtml(String(value || "").replace(/<script\b[\s\S]*?<\/script\s*>/giu, " ").replace(/<style\b[\s\S]*?<\/style\s*>/giu, " ").replace(/<[^>]*>/gu, " ")),
    300
  );
}

function hasExplicitAdLabel(value) {
  return />\s*(?:<[^>]+>\s*)*광고\s*(?:<\/[^>]+>\s*)*</u.test(String(value || ""));
}

function placeIdFromAdvertiserUrl(value) {
  try {
    const redirect = new URL(String(value || ""));
    if (redirect.protocol !== "https:" || redirect.hostname !== "ader.naver.com") return null;
    const destinationValue = redirect.searchParams.get("fu") || "";
    const destination = new URL(destinationValue);
    if (destination.protocol !== "https:" || destination.hostname !== "map.naver.com") return null;
    const parts = destination.pathname.split("/").filter(Boolean);
    const placeIndex = parts.indexOf("place");
    const placeId = placeIndex >= 0 ? parts[placeIndex + 1] : "";
    return /^\d{1,30}$/u.test(placeId) ? placeId : null;
  } catch {
    return null;
  }
}

function scanAdvertiserAnchors(containerHtml) {
  const rows = [];
  let anchorCount = 0;
  for (const match of String(containerHtml || "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu)) {
    anchorCount += 1;
    if (anchorCount > MAX_ANCHORS_PER_CONTAINER) break;
    const href = attributeValue(match[1], "href");
    const placeId = placeIdFromAdvertiserUrl(href);
    if (!placeId) continue;
    rows.push(Object.freeze({ placeId, name: textFromHtml(match[2]) }));
  }
  return Object.freeze({ anchorCount, rows: Object.freeze(rows) });
}

function extractIntegratedSearchAdEvidence(html) {
  const source = String(html || "");
  const bytes = Buffer.byteLength(source, "utf8");
  if (!source || bytes > 4194304 || /\u0000/u.test(source)) {
    fail("V2_N8_HTML_INVALID", "provider-parse", "Integrated search HTML is invalid");
  }
  const advertisements = [];
  const seen = new Set();
  let scannedContainerCount = 0;
  let candidateContainerCount = 0;
  let explicitAdLabelCount = 0;
  let scannedAnchorCount = 0;
  let advertiserLinkCount = 0;
  let duplicateLinkCount = 0;
  let unnamedPlaceCount = 0;

  for (const match of source.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/giu)) {
    scannedContainerCount += 1;
    if (scannedContainerCount > MAX_CONTAINERS) break;
    const inner = match[1];
    if (!hasExplicitAdLabel(inner)) continue;
    candidateContainerCount += 1;
    explicitAdLabelCount += 1;
    const anchors = scanAdvertiserAnchors(inner);
    scannedAnchorCount += anchors.anchorCount;
    advertiserLinkCount += anchors.rows.length;
    const bestNameByPlaceId = new Map();
    for (const row of anchors.rows) {
      const current = bestNameByPlaceId.get(row.placeId) || "";
      if (row.name.length > current.length) bestNameByPlaceId.set(row.placeId, row.name);
    }
    duplicateLinkCount += Math.max(0, anchors.rows.length - bestNameByPlaceId.size);
    for (const [placeId, name] of bestNameByPlaceId.entries()) {
      if (seen.has(placeId)) {
        duplicateLinkCount += 1;
        continue;
      }
      if (advertisements.length >= MAX_ADVERTISEMENTS) continue;
      seen.add(placeId);
      if (!name) unnamedPlaceCount += 1;
      advertisements.push(Object.freeze({
        adOrder: advertisements.length + 1,
        placeId,
        name,
        evidenceLevel: name ? "explicit-ad-label-place-destination-and-name" : "explicit-ad-label-and-place-destination"
      }));
    }
  }
  const namedPlaceCount = advertisements.filter((row) => row.name).length;
  return Object.freeze({
    collectionViable: advertisements.length > 0 && namedPlaceCount === advertisements.length,
    scannedContainerCount,
    candidateContainerCount,
    explicitAdLabelCount,
    scannedAnchorCount,
    advertiserLinkCount,
    duplicateLinkCount,
    uniquePlaceIdCount: advertisements.length,
    namedPlaceCount,
    unnamedPlaceCount,
    advertisements: Object.freeze(advertisements)
  });
}

function contentTypeClass(value) {
  const contentType = String(value || "").trim().toLowerCase();
  if (/^text\/html(?:\s*;|$)/u.test(contentType)) return "html";
  if (/^application\/xhtml\+xml(?:\s*;|$)/u.test(contentType)) return "xhtml";
  return "other";
}

function statusClass(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : "unknown";
}

function responseHeader(response, name) {
  return String(response?.headers?.get?.(name) || "").trim();
}

function challengeDetected(body) {
  return /captcha|verify(?:ing|ication)?\s+(?:you|human)|비정상적인\s*접근|자동입력\s*방지/iu.test(String(body || ""));
}

function requestUrl(job) {
  const url = new URL(REQUEST_PATH, REQUEST_ORIGIN);
  url.searchParams.set("where", REQUEST_WHERE);
  url.searchParams.set("query", job.keyword);
  return url;
}

async function runIntegratedSearchAdDiagnostic(input, options = {}) {
  const job = normalizeJob(input);
  assertLiveApproval(job, options.environment || process.env);
  if (job.mode === "offline" && typeof options.fetchImpl !== "function") {
    fail("V2_N8_OFFLINE_TRANSPORT_REQUIRED", "transport", "Offline mode requires an explicit fixture transport");
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("V2_N8_TRANSPORT_UNAVAILABLE", "transport", "Fetch transport is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeoutMs);
  let response;
  try {
    response = await fetchImpl(requestUrl(job), {
      method: "GET",
      headers: FIXED_HEADERS,
      redirect: "manual",
      signal: controller.signal
    });
  } catch (error) {
    fail(
      error?.name === "AbortError" ? "V2_N8_TIMEOUT" : "V2_N8_TRANSPORT_FAILED",
      "transport",
      "The integrated search request failed",
      { externalRequests: job.mode === "live" ? 1 : 0 }
    );
  } finally {
    clearTimeout(timer);
  }
  const audit = Object.freeze({
    requestBudget: 1,
    requestAttempts: 1,
    fixtureRequests: job.mode === "offline" ? 1 : 0,
    actualExternalRequests: job.mode === "live" ? 1 : 0,
    automaticRetries: 0,
    automaticFallbacks: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    cookiesSent: false,
    trackingUrlsStored: false
  });
  const status = Number(response?.status);
  const contentType = responseHeader(response, "content-type");
  if (response?.redirected || (status >= 300 && status < 400)) {
    fail("V2_N8_REDIRECTED", "provider-response", "Redirects are not allowed", audit);
  }
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    fail("V2_N8_HTTP_ERROR", "provider-response", "Provider returned a non-success status", {
      ...audit,
      httpStatusClass: statusClass(status)
    });
  }
  const typeClass = contentTypeClass(contentType);
  if (!new Set(["html", "xhtml"]).has(typeClass)) {
    fail("V2_N8_CONTENT_TYPE_INVALID", "provider-response", "Provider response was not HTML", {
      ...audit,
      httpStatusClass: statusClass(status),
      contentTypeClass: typeClass
    });
  }
  let body;
  try {
    body = await readBoundedBody(response, job.responseSizeLimitBytes, {
      allowTextFallback: job.mode === "offline"
    });
  } catch {
    fail("V2_N8_RESPONSE_TOO_LARGE_OR_INVALID", "provider-response", "Provider response exceeded the safe boundary", audit);
  }
  if (challengeDetected(body)) {
    fail("V2_N8_ACCESS_BLOCKED", "provider-response", "Provider access challenge detected", {
      ...audit,
      httpStatusClass: statusClass(status),
      contentTypeClass: typeClass,
      responseBytes: Buffer.byteLength(body, "utf8")
    });
  }
  const evidence = extractIntegratedSearchAdEvidence(body);
  return Object.freeze({
    schemaVersion: RESULT_SCHEMA_VERSION,
    event: "v2_naver_integrated_search_ad_diagnostic_complete",
    status: "completed",
    runId: job.runId,
    mode: job.mode,
    keyword: job.keyword,
    jobDigestSha256: jobApprovalDigest(job),
    request: buildRequestEnvelope(job),
    response: Object.freeze({
      status,
      httpStatusClass: statusClass(status),
      contentTypeClass: typeClass,
      responseBytes: Buffer.byteLength(body, "utf8"),
      bodySha256: sha256(body),
      parseStatus: evidence.collectionViable ? "advertisements-observed" : "no-viable-advertisements"
    }),
    evidence,
    audit
  });
}

function publicFailure(error) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const allowed = [
    "actualExternalRequests",
    "automaticFallbacks",
    "automaticRetries",
    "contentTypeClass",
    "fixtureRequests",
    "httpStatusClass",
    "operationalWrites",
    "rawProviderResponseStored",
    "requestAttempts",
    "requestBudget",
    "responseBytes"
  ];
  const diagnostic = Object.fromEntries(allowed.filter((key) => Object.hasOwn(details, key)).map((key) => [key, details[key]]));
  return Object.freeze({
    schemaVersion: ERROR_SCHEMA_VERSION,
    event: "v2_naver_integrated_search_ad_diagnostic_failed",
    status: "failed",
    stage: cleanText(error?.stage || "unexpected", 80),
    code: cleanText(error?.code || "V2_N8_UNEXPECTED", 120),
    retryable: false,
    ...(Object.keys(diagnostic).length ? { diagnostic: Object.freeze(diagnostic) } : {})
  });
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--job" || !argv[1]) {
    fail("V2_N8_ARGUMENT_INVALID", "cli", "Expected --job <path>");
  }
  return path.resolve(argv[1]);
}

function offlineFixture(job) {
  const fixtureName = job.fixtureScenario === "visible-ads"
    ? "v2_naver_integrated_search_visible_ads.sanitized.html"
    : "v2_naver_integrated_search_empty.sanitized.html";
  const fixturePath = path.resolve(__dirname, "..", "tests", "fixtures", fixtureName);
  const body = fs.readFileSync(fixturePath, "utf8");
  return async () => new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

async function main() {
  try {
    const jobPath = parseArguments(process.argv.slice(2));
    const input = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    const job = normalizeJob(input);
    const result = await runIntegratedSearchAdDiagnostic(job, {
      fetchImpl: job.mode === "offline" ? offlineFixture(job) : globalThis.fetch
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicFailure(error))}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ERROR_SCHEMA_VERSION,
  FIXED_HEADERS,
  JOB_SCHEMA_VERSION,
  LIVE_APPROVAL_NAME,
  REQUEST_ORIGIN,
  REQUEST_PATH,
  REQUEST_WHERE,
  RESULT_SCHEMA_VERSION,
  assertLiveApproval,
  buildRequestEnvelope,
  contentTypeClass,
  extractIntegratedSearchAdEvidence,
  jobApprovalDigest,
  normalizeJob,
  placeIdFromAdvertiserUrl,
  publicFailure,
  runIntegratedSearchAdDiagnostic,
  statusClass
};

if (require.main === module) main();
