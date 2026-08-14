"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  extractApolloState,
  looksLikeAccessBlock,
  naverPlaceAddress,
  normalizeQuery,
  parseRootKey,
  selectNaverOrganicResult
} = require("./naver_place_apollo_parser.cjs");
const {
  createNaverLegacyCanaryLiveTransport,
  NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES,
  NAVER_LEGACY_CANARY_TIMEOUT_MS
} = require("./naver_legacy_canary_live_transport.cjs");
const { buildAdResponseDiagnostics } = require("./v2_place_ad_response_diagnostics.cjs");

const SCHEMA_VERSION = "v2-live-basic-place-job.v1";
const RESULT_SCHEMA_VERSION = "v2-live-basic-place-result.v1";
const APPROVAL_TOKEN = "N1-Basic-Live";
const PROVIDER_ID = "naver_place_main";
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,119}$/u;
const LIVE_ENV_NAMES = Object.freeze({
  approved: "V2_BASIC_PLACE_LIVE_APPROVED",
  approvedJobDigest: "V2_BASIC_PLACE_APPROVED_JOB_SHA256",
  requestBudget: "V2_BASIC_PLACE_REQUEST_BUDGET",
  automaticRetry: "V2_BASIC_PLACE_AUTOMATIC_RETRY",
  fallback: "V2_BASIC_PLACE_FALLBACK",
  operationalWrites: "V2_BASIC_PLACE_OPERATIONAL_WRITES"
});

class V2BasicPlaceError extends Error {
  constructor(code, stage, message, details = {}) {
    super(message);
    this.name = "V2BasicPlaceError";
    this.code = code;
    this.stage = stage;
    this.retryable = false;
    this.details = details;
  }
}

function fail(code, stage, message, details) {
  throw new V2BasicPlaceError(code, stage, message, details);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("V2_BASIC_PLACE_JOB_INVALID", "job-validation", "The job must be a JSON object");
  }
  const allowedKeys = new Set(["schemaVersion", "runId", "mode", "keyword", "timeoutMs", "responseSizeLimitBytes"]);
  const unknownKeys = Object.keys(raw).filter((key) => !allowedKeys.has(key));
  const schemaVersion = String(raw.schemaVersion || "");
  const runId = String(raw.runId || "");
  const mode = String(raw.mode || "");
  const keyword = normalizeQuery(raw.keyword);
  const timeoutMs = Number(raw.timeoutMs);
  const responseSizeLimitBytes = Number(raw.responseSizeLimitBytes);
  if (
    unknownKeys.length > 0
    || schemaVersion !== SCHEMA_VERSION
    || !RUN_ID_PATTERN.test(runId)
    || !["offline", "live"].includes(mode)
    || !keyword
    || keyword.length > 120
    || /[\u0000-\u001f\u007f]/u.test(keyword)
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1_000
    || timeoutMs > NAVER_LEGACY_CANARY_TIMEOUT_MS
    || !Number.isInteger(responseSizeLimitBytes)
    || responseSizeLimitBytes < 1
    || responseSizeLimitBytes > NAVER_LEGACY_CANARY_MAX_RESPONSE_BYTES
  ) {
    fail("V2_BASIC_PLACE_JOB_INVALID", "job-validation", "The job does not match the approved basic Place contract");
  }
  return Object.freeze({ schemaVersion, runId, mode, keyword, timeoutMs, responseSizeLimitBytes });
}

function validateLiveGate(job, jobBytes, env) {
  if (job.mode !== "live") return;
  const digest = sha256(jobBytes);
  const matched = (
    env[LIVE_ENV_NAMES.approved] === APPROVAL_TOKEN
    && env[LIVE_ENV_NAMES.approvedJobDigest] === digest
    && env[LIVE_ENV_NAMES.requestBudget] === "1"
    && env[LIVE_ENV_NAMES.automaticRetry] === "0"
    && env[LIVE_ENV_NAMES.fallback] === "0"
    && env[LIVE_ENV_NAMES.operationalWrites] === "0"
  );
  if (!matched) {
    fail("V2_BASIC_PLACE_LIVE_GATE_BLOCKED", "live-gate", "The live approval gate is not an exact match");
  }
}

function dereference(state, value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.__ref === "string") return state[value.__ref] && typeof state[value.__ref] === "object"
    ? state[value.__ref]
    : null;
  return value;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function shortText(value, limit = 1000) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, limit);
}

function placeIdOf(item) {
  const value = String(item?.id || item?.placeId || "").trim();
  return /^\d{1,30}$/u.test(value) ? value : "";
}

function roomPreview(state, item) {
  const rooms = (Array.isArray(item?.roomImages) ? item.roomImages : [])
    .map((entry) => dereference(state, entry))
    .filter(Boolean)
    .slice(0, 100);
  const prices = rooms.flatMap((room) => [finiteNumber(room.minPrice), finiteNumber(room.maxPrice)]).filter((value) => value !== null);
  const fallbackPrice = finiteNumber(item?.matchRoomMinPrice);
  return Object.freeze({
    count: rooms.length,
    names: rooms.map((room) => shortText(room.name, 300)).filter(Boolean).slice(0, 20),
    minimumPrice: prices.length > 0 ? Math.min(...prices) : fallbackPrice
  });
}

function projectPlace(state, item) {
  const preview = roomPreview(state, item);
  const hasBookingObserved = Object.prototype.hasOwnProperty.call(item || {}, "hasBooking")
    && typeof item.hasBooking === "boolean";
  return Object.freeze({
    placeId: placeIdOf(item),
    name: shortText(item?.name, 500),
    category: shortText(item?.category, 300),
    address: naverPlaceAddress(item),
    hasBooking: hasBookingObserved ? item.hasBooking : null,
    reviewScore: finiteNumber(item?.placeReviewScore),
    reviewCount: finiteNumber(item?.totalReviewCount ?? item?.blogCafeReviewCount),
    visitorReviewCount: finiteNumber(item?.placeReviewCount),
    minimumPrice: preview.minimumPrice,
    roomPreviewCount: preview.count,
    roomPreviewNames: preview.names
  });
}

function selectAdResult(state, query) {
  const keys = Object.keys(state?.ROOT_QUERY || {});
  const normalizedTarget = normalizeQuery(query);
  const key = keys.find((candidate) => {
    if (!candidate.startsWith("adBusinesses(") || candidate.includes('"channel":"openingPlace"')) return false;
    const args = parseRootKey(candidate)?.args;
    return normalizeQuery(args?.input?.query) === normalizedTarget && args?.input?.businessType === "accommodation";
  });
  if (!key) return Object.freeze({ contractPresent: false, total: 0, items: [] });
  const root = dereference(state, state.ROOT_QUERY[key]) || {};
  const items = (Array.isArray(root.items) ? root.items : []).map((entry) => dereference(state, entry)).filter(Boolean);
  return Object.freeze({
    contractPresent: true,
    total: Number.isFinite(Number(root.total)) ? Number(root.total) : items.length,
    items
  });
}

function parseProviderBody(body, keyword) {
  let state;
  try {
    state = extractApolloState(body);
  } catch (error) {
    const blocked = looksLikeAccessBlock(body);
    fail(
      blocked ? "V2_BASIC_PLACE_ACCESS_BLOCKED" : "V2_BASIC_PLACE_APOLLO_UNAVAILABLE",
      "provider-parse",
      blocked ? "The Provider returned an access block" : "The Provider response did not contain the expected Place state"
    );
  }
  const organic = selectNaverOrganicResult(state, keyword, { allowPlaceList: true, required: false });
  if (!organic) fail("V2_BASIC_PLACE_ORGANIC_UNAVAILABLE", "provider-parse", "The organic Place contract was not present");
  const ads = selectAdResult(state, keyword);
  const providerDiagnostics = buildAdResponseDiagnostics({ state, query: keyword, body });
  return Object.freeze({
    operation: String(organic.operation || organic.type || ""),
    organicTotal: Number(organic.total || 0),
    organic: organic.items.slice(0, 50).map((item, index) => Object.freeze({ rank: index + 1, ...projectPlace(state, item) })),
    adContractPresent: ads.contractPresent,
    adTotal: ads.total,
    providerDiagnostics,
    advertisements: ads.items.slice(0, 100).map((item, index) => Object.freeze({
      adOrder: index + 1,
      ...projectPlace(state, item),
      adId: shortText(item?.adId, 300),
      adDescription: shortText(item?.adDescription || item?.promotionTitle, 1000)
    }))
  });
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(" | ") : value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function csvFor(rows, headers) {
  return `\uFEFF${[headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;
}

function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("V2_BASIC_PLACE_OUTPUT_PATH_INVALID", "artifact-write", "The artifact path is outside the isolated output root");
  }
  return resolved;
}

async function writeArtifacts(outputRoot, job, parsed, providerEvidence) {
  const root = path.resolve(outputRoot);
  await fs.mkdir(root, { recursive: true });
  const finalDirectory = assertInside(root, path.join(root, job.runId));
  const temporaryDirectory = assertInside(root, path.join(root, `.pending-${job.runId}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`));
  let finalExists = false;
  try {
    await fs.access(finalDirectory);
    finalExists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (finalExists) fail("V2_BASIC_PLACE_DUPLICATE_RUN", "artifact-write", "An artifact already exists for this run ID");
  const diagnosticsBytes = Buffer.from(`${JSON.stringify(parsed.providerDiagnostics, null, 2)}\n`, "utf8");
  const files = new Map([
    ["organic.json", `${JSON.stringify(parsed.organic, null, 2)}\n`],
    ["organic.csv", csvFor(parsed.organic, ["rank", "placeId", "name", "category", "address", "hasBooking", "reviewScore", "reviewCount", "visitorReviewCount", "minimumPrice", "roomPreviewCount", "roomPreviewNames"])],
    ["advertisements.json", `${JSON.stringify(parsed.advertisements, null, 2)}\n`],
    ["advertisements.csv", csvFor(parsed.advertisements, ["adOrder", "placeId", "name", "category", "address", "hasBooking", "reviewScore", "reviewCount", "visitorReviewCount", "minimumPrice", "roomPreviewCount", "roomPreviewNames", "adId", "adDescription"])],
    ["provider-diagnostics.json", diagnosticsBytes]
  ]);
  const fileManifest = {};
  try {
    await fs.mkdir(temporaryDirectory, { recursive: false });
    for (const [name, contents] of files) {
      const bytes = Buffer.from(contents, "utf8");
      await fs.writeFile(assertInside(temporaryDirectory, path.join(temporaryDirectory, name)), bytes, { flag: "wx" });
      fileManifest[name] = { bytes: bytes.length, sha256: sha256(bytes) };
    }
    const manifest = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId: job.runId,
      keyword: job.keyword,
      mode: job.mode,
      collectedAt: new Date().toISOString(),
      provider: providerEvidence,
      operation: parsed.operation,
      counts: {
        organicProviderTotal: parsed.organicTotal,
        organicRows: parsed.organic.length,
        adContractPresent: parsed.adContractPresent,
        adProviderTotal: parsed.adTotal,
        advertisementRows: parsed.advertisements.length
      },
      diagnostics: {
        schemaVersion: parsed.providerDiagnostics.schemaVersion,
        status: parsed.providerDiagnostics.status,
        sha256: fileManifest["provider-diagnostics.json"].sha256
      },
      contracts: {
        retryCount: 0,
        fallbackCount: 0,
        operationalWrites: 0,
        rawProviderResponseStored: false,
        providerHeadersStored: false,
        cookieValuesStored: false
      },
      files: fileManifest
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await fs.writeFile(assertInside(temporaryDirectory, path.join(temporaryDirectory, "manifest.json")), manifestBytes, { flag: "wx" });
    await fs.rename(temporaryDirectory, finalDirectory);
    return Object.freeze({ finalDirectory, manifest, manifestDigest: sha256(manifestBytes) });
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    if (error?.code === "EEXIST") fail("V2_BASIC_PLACE_DUPLICATE_RUN", "artifact-write", "An artifact already exists for this run ID");
    throw error;
  }
}

async function executeBasicPlaceJob(options) {
  const jobBytes = Buffer.isBuffer(options.jobBytes) ? options.jobBytes : Buffer.from(String(options.jobBytes || ""), "utf8");
  let rawJob;
  try {
    rawJob = JSON.parse(jobBytes.toString("utf8"));
  } catch {
    fail("V2_BASIC_PLACE_JOB_INVALID", "job-validation", "The job JSON is invalid");
  }
  const job = normalizeJob(rawJob);
  const env = options.env || process.env;
  validateLiveGate(job, jobBytes, env);
  if (job.mode === "offline" && typeof options.fetchImpl !== "function") {
    fail("V2_BASIC_PLACE_FIXTURE_REQUIRED", "transport", "Offline mode requires an injected fixture transport");
  }
  const fetchImpl = job.mode === "live" ? (options.fetchImpl || globalThis.fetch) : options.fetchImpl;
  if (typeof fetchImpl !== "function") fail("V2_BASIC_PLACE_FETCH_UNAVAILABLE", "transport", "Fetch is unavailable");
  const transport = createNaverLegacyCanaryLiveTransport({
    enabled: true,
    fetchImpl,
    providerId: PROVIDER_ID,
    timeoutMs: job.timeoutMs,
    maxResponseBytes: job.responseSizeLimitBytes,
    allowTextFallback: job.mode === "offline"
  });
  let response;
  try {
    response = await transport({
      providerId: PROVIDER_ID,
      providerOperation: "naver_place_accommodation_search_snapshot",
      query: job.keyword,
      requestOrdinal: 1,
      callBudget: 1,
      actualCallsEnabled: true,
      fixtureOnly: false
    });
  } catch (error) {
    fail(
      String(error?.code || "V2_BASIC_PLACE_TRANSPORT_FAILED").slice(0, 120),
      "transport",
      "The bounded Provider request failed",
      { externalRequests: job.mode === "live" ? transport.callCount() : 0 }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    fail("V2_BASIC_PLACE_HTTP_ERROR", "provider-response", "The Provider returned a non-success status", {
      status: response.status,
      externalRequests: job.mode === "live" ? 1 : 0
    });
  }
  let parsed;
  try {
    parsed = parseProviderBody(response.body, job.keyword);
  } catch (error) {
    if (error instanceof V2BasicPlaceError) {
      error.details = { ...error.details, externalRequests: job.mode === "live" ? 1 : 0 };
      throw error;
    }
    fail("V2_BASIC_PLACE_PARSE_FAILED", "provider-parse", "The Provider response could not be projected", {
      externalRequests: job.mode === "live" ? 1 : 0
    });
  }
  const providerEvidence = Object.freeze({
    origin: "https://pcmap.place.naver.com",
    path: "/accommodation/list",
    method: "GET",
    status: response.status,
    contentType: String(response.headers?.["content-type"] || ""),
    requestCount: 1,
    externalRequestCount: job.mode === "live" ? 1 : 0,
    fixtureRequestCount: job.mode === "offline" ? 1 : 0
  });
  let artifact;
  try {
    artifact = await writeArtifacts(options.outputRoot, job, parsed, providerEvidence);
  } catch (error) {
    if (error instanceof V2BasicPlaceError) {
      error.details = { ...error.details, externalRequests: providerEvidence.externalRequestCount };
      throw error;
    }
    fail("V2_BASIC_PLACE_ARTIFACT_FAILED", "artifact-write", "The isolated artifact could not be committed", {
      externalRequests: providerEvidence.externalRequestCount
    });
  }
  return Object.freeze({
    event: "v2_live_basic_place_complete",
    status: "completed",
    mode: job.mode,
    runId: job.runId,
    keyword: job.keyword,
    organicRows: parsed.organic.length,
    advertisementRows: parsed.advertisements.length,
    adDiagnosticStatus: parsed.providerDiagnostics.status,
    adCandidateCount: parsed.providerDiagnostics.advertisement.candidateCount,
    adMatchedCandidateCount: parsed.providerDiagnostics.advertisement.matchedCandidateCount,
    providerResponseDigest: parsed.providerDiagnostics.response.bodySha256,
    diagnosticsDigest: artifact.manifest.files["provider-diagnostics.json"].sha256,
    externalRequests: providerEvidence.externalRequestCount,
    fixtureRequests: providerEvidence.fixtureRequestCount,
    retryCount: 0,
    fallbackCount: 0,
    operationalWrites: 0,
    rawProviderResponseStored: false,
    artifactDirectory: artifact.finalDirectory,
    manifestDigest: artifact.manifestDigest
  });
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--job", "--output-root"].includes(key) || !argv[index + 1]) {
      fail("V2_BASIC_PLACE_ARGUMENT_INVALID", "cli", "Expected --job and --output-root arguments");
    }
    result[key.slice(2)] = argv[index + 1];
    index += 1;
  }
  if (!result.job || !result["output-root"]) fail("V2_BASIC_PLACE_ARGUMENT_INVALID", "cli", "Expected --job and --output-root arguments");
  return result;
}

function publicFailure(error) {
  return {
    event: "v2_live_basic_place_failed",
    status: "failed",
    stage: String(error?.stage || "unexpected").slice(0, 80),
    code: String(error?.code || "V2_BASIC_PLACE_UNEXPECTED").slice(0, 120),
    retryable: false,
    externalRequests: Number(error?.details?.externalRequests || 0),
    operationalWrites: 0
  };
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const result = await executeBasicPlaceJob({
      jobBytes: await fs.readFile(path.resolve(args.job)),
      outputRoot: path.resolve(args["output-root"]),
      env: process.env
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(publicFailure(error))}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  APPROVAL_TOKEN,
  LIVE_ENV_NAMES,
  RESULT_SCHEMA_VERSION,
  SCHEMA_VERSION,
  V2BasicPlaceError,
  executeBasicPlaceJob,
  normalizeJob,
  parseProviderBody,
  publicFailure,
  selectAdResult,
  sha256
};

if (require.main === module) main();
