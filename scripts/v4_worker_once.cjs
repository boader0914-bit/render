const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ORIGINAL_COLLECTOR = path.join(ROOT, "scripts", "gyeongnam_glamping_crawl.cjs");
const FIXTURE_COLLECTOR = path.join(ROOT, "scripts", "fixtures", "v4_worker_fixture_collector.cjs");
const OFFLINE_NETWORK_BLOCKER = path.join(ROOT, "scripts", "fixtures", "v4_network_blocker.cjs");
const PARITY_FIXTURE_TRANSPORT = path.join(ROOT, "scripts", "fixtures", "v4_collector_fixture_transport.cjs");
const EXPECTED_COLLECTOR_BLOB = "bcbe229998da3afa6f31ee04375fb0766019e56f";
const BASELINE_COMMIT = "4e4e1906e2967fe58df66f8ad67f832043d2763b";
const JOB_SCHEMA = "datalab-v4-worker-job.v1";
const RESULT_SCHEMA = "datalab-v4-worker-result.v1";
const ENVELOPE_SCHEMA = "datalab-v4-worker-artifact.v1";
const DATA_MARKER_SCHEMA = "datalab-v4-worker-data-root.v1";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 2 * 1024 * 1024;
const PARITY_FIXTURE_SCENARIOS = new Set([
  "success",
  "empty",
  "duplicate",
  "missing-field",
  "booking",
  "provider-error",
  "timeout"
]);

const JOB_FIELDS = new Set([
  "schemaVersion",
  "jobId",
  "idempotencyKey",
  "keyword",
  "checkIn",
  "checkOut",
  "adults",
  "searchMode",
  "productMode",
  "collectionMode",
  "collectionPurpose",
  "detailRankRanges",
  "bookingRangeDays",
  "bookingRangePlaceLimit"
]);

const BASE_ENV_NAMES = [
  "PATH",
  "Path",
  "SYSTEMROOT",
  "SystemRoot",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_PATH"
];

const NUMERIC_TUNING = {
  REGIONAL_LIMIT: [0, 100],
  REGIONAL_SEARCH_CONCURRENCY: [1, 8],
  NAVER_BOOKING_STOCK_LIMIT: [0, 100],
  NAVER_BOOKING_DETAIL_CONCURRENCY: [1, 4],
  NAVER_SCHEDULE_CONCURRENCY: [1, 8],
  NAVER_SCHEDULE_DELAY_MS: [0, 500]
};

const BOOLEAN_TUNING = [
  "NAVER_BOOKING_ID_FALLBACK",
  "NAVER_COUPON_PAGE_FALLBACK"
];

class WorkerError extends Error {
  constructor(code, stage, message, options = {}) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable === true;
    this.exitCode = Number.isInteger(options.exitCode) ? options.exitCode : null;
    this.details = options.details && typeof options.details === "object" ? options.details : null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function gitBlobSha(filePath) {
  const worktreeBytes = await fsp.readFile(filePath);
  const bytes = Buffer.from(worktreeBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return crypto.createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

async function verifyOriginalCollector() {
  const actual = await gitBlobSha(ORIGINAL_COLLECTOR);
  if (actual !== EXPECTED_COLLECTOR_BLOB) {
    throw new WorkerError(
      "COLLECTOR_BLOB_MISMATCH",
      "baseline",
      "Frozen collector blob does not match the approved baseline."
    );
  }
  return actual;
}

function isContained(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(parent, child, code = "PATH_OUTSIDE_ROOT") {
  if (!isContained(parent, child)) {
    throw new WorkerError(code, "storage", "Resolved path is outside the dedicated worker root.");
  }
}

function safeIdentifier(value, field) {
  const text = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(text)) {
    throw new WorkerError("JOB_SPEC_INVALID_IDENTIFIER", "validate", `${field} is invalid.`);
  }
  return text;
}

function validDate(value, field) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new WorkerError("JOB_SPEC_INVALID_DATE", "validate", `${field} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new WorkerError("JOB_SPEC_INVALID_DATE", "validate", `${field} is not a calendar date.`);
  }
  return text;
}

function integer(value, field, fallback, min, max) {
  const source = value === undefined || value === null || value === "" ? fallback : value;
  const number = Number(source);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new WorkerError("JOB_SPEC_INVALID_INTEGER", "validate", `${field} must be an integer from ${min} to ${max}.`);
  }
  return number;
}

function enumValue(value, field, allowed, fallback) {
  const text = String(value || fallback || "").trim();
  if (!allowed.includes(text)) {
    throw new WorkerError("JOB_SPEC_INVALID_ENUM", "validate", `${field} is not allowed.`);
  }
  return text;
}

function defaultDetailRanges(purpose) {
  if (purpose === "basic_db") return "1-50";
  if (purpose === "demand_location") return "1-20";
  return "1-10";
}

function normalizeDetailRanges(value, fallback) {
  const source = String(value || fallback || "").trim();
  if (!source) return "";
  const normalized = [];
  for (const token of source.split(/[\s,]+/).filter(Boolean)) {
    const match = token.match(/^(\d{1,3})(?:[-~](\d{1,3}))?$/);
    if (!match) {
      throw new WorkerError("JOB_SPEC_INVALID_DETAIL_RANGE", "validate", "detailRankRanges contains an invalid token.");
    }
    const left = Number(match[1]);
    const right = Number(match[2] || match[1]);
    if (left < 1 || left > 100 || right < 1 || right > 100) {
      throw new WorkerError("JOB_SPEC_INVALID_DETAIL_RANGE", "validate", "detailRankRanges must stay within ranks 1 to 100.");
    }
    const from = Math.min(left, right);
    const to = Math.max(left, right);
    normalized.push(from === to ? String(from) : `${from}-${to}`);
  }
  return normalized.join(",");
}

function rankPlaceLimit(ranges) {
  const ranks = new Set();
  for (const token of String(ranges || "").split(",").filter(Boolean)) {
    const [fromText, toText] = token.split("-");
    const from = Number(fromText);
    const to = Number(toText || fromText);
    for (let rank = from; rank <= to && ranks.size < 20; rank += 1) ranks.add(rank);
  }
  return Math.min(20, ranks.size);
}

function normalizeJob(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new WorkerError("JOB_SPEC_NOT_OBJECT", "validate", "Job specification must be a JSON object.");
  }
  const unknown = Object.keys(spec).filter((key) => !JOB_FIELDS.has(key));
  if (unknown.length) {
    throw new WorkerError("JOB_SPEC_UNKNOWN_FIELD", "validate", `Unknown job field: ${unknown.sort()[0]}`);
  }
  if (spec.schemaVersion !== JOB_SCHEMA) {
    throw new WorkerError("JOB_SPEC_SCHEMA_INVALID", "validate", `schemaVersion must be ${JOB_SCHEMA}.`);
  }

  const jobId = safeIdentifier(spec.jobId, "jobId");
  const idempotencyKey = safeIdentifier(spec.idempotencyKey, "idempotencyKey");
  const keyword = String(spec.keyword || "").normalize("NFKC").trim();
  if (!keyword || keyword.length > 100 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    throw new WorkerError("JOB_SPEC_INVALID_KEYWORD", "validate", "keyword is empty, too long, or contains control characters.");
  }

  const checkIn = validDate(spec.checkIn, "checkIn");
  const checkOut = validDate(spec.checkOut, "checkOut");
  const daySpan = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86400000);
  if (daySpan < 1 || daySpan > 31) {
    throw new WorkerError("JOB_SPEC_DATE_RANGE_INVALID", "validate", "checkOut must be 1 to 31 days after checkIn.");
  }

  const collectionMode = enumValue(spec.collectionMode, "collectionMode", ["precision", "fast"], "precision");
  const collectionPurpose = enumValue(
    spec.collectionPurpose,
    "collectionPurpose",
    ["basic_db", "revenue_detail", "demand_location"],
    "revenue_detail"
  );
  if (collectionMode === "fast" && String(spec.detailRankRanges || "").trim()) {
    throw new WorkerError("JOB_SPEC_FAST_DETAIL_RANGE", "validate", "fast mode cannot request detailRankRanges.");
  }
  const detailRankRanges = collectionMode === "fast"
    ? ""
    : normalizeDetailRanges(spec.detailRankRanges, defaultDetailRanges(collectionPurpose));
  const bookingRangeDays = integer(spec.bookingRangeDays, "bookingRangeDays", daySpan + 1, 1, 31);
  const weeklyRange = collectionMode !== "fast" && collectionPurpose === "revenue_detail";
  const bookingRangePlaceLimit = weeklyRange
    ? integer(spec.bookingRangePlaceLimit, "bookingRangePlaceLimit", rankPlaceLimit(detailRankRanges) || 10, 0, 20)
    : 0;

  return {
    schemaVersion: JOB_SCHEMA,
    jobId,
    idempotencyKey,
    keyword,
    checkIn,
    checkOut,
    adults: integer(spec.adults, "adults", 2, 1, 20),
    searchMode: enumValue(spec.searchMode, "searchMode", ["keyword", "company"], "keyword"),
    productMode: enumValue(spec.productMode, "productMode", ["all", "lodging", "campnic"], "all"),
    collectionMode,
    collectionPurpose,
    detailRankRanges,
    bookingRangeDays,
    bookingRangePlaceLimit
  };
}

function jobFingerprint(job) {
  const copy = { ...job };
  delete copy.idempotencyKey;
  return sha256(stableJson(copy));
}

function sensitiveValuesFromEnv(env = process.env) {
  const values = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL)/i.test(name)) continue;
    if (typeof value === "string" && value.length >= 4) values.push(value);
  }
  return values.sort((a, b) => b.length - a.length);
}

function sanitizeText(value, sensitiveValues = sensitiveValuesFromEnv()) {
  let text = String(value || "");
  for (const secret of sensitiveValues) text = text.split(secret).join("[REDACTED]");
  text = text
    .replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 1200);
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fsp.rename(temp, filePath);
}

async function ensureDedicatedDataRoot(value) {
  if (!value || !path.isAbsolute(value)) {
    throw new WorkerError("DATA_ROOT_REQUIRED", "storage", "V4_WORKER_DATA_DIR must be an absolute dedicated path.");
  }
  const root = path.resolve(value);
  if (root === path.parse(root).root || isContained(ROOT, root) || isContained(root, ROOT)) {
    throw new WorkerError("DATA_ROOT_UNSAFE", "storage", "Worker data root cannot be the repository, its parent, or its child.");
  }

  let existed = true;
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkerError("DATA_ROOT_UNSAFE", "storage", "Worker data root must be a real directory.");
    }
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    if (error.code !== "ENOENT") throw error;
    existed = false;
    await fsp.mkdir(root, { recursive: true });
  }

  const marker = path.join(root, ".v4-worker-root.json");
  if (!fs.existsSync(marker)) {
    const entries = await fsp.readdir(root);
    if (existed && entries.length) {
      throw new WorkerError("DATA_ROOT_NOT_DEDICATED", "storage", "Existing data root is not marked as dedicated to the V4 worker.");
    }
    await writeJsonAtomic(marker, { schemaVersion: DATA_MARKER_SCHEMA, baselineCommit: BASELINE_COMMIT });
  } else {
    const parsed = JSON.parse(await fsp.readFile(marker, "utf8"));
    if (parsed.schemaVersion !== DATA_MARKER_SCHEMA || parsed.baselineCommit !== BASELINE_COMMIT) {
      throw new WorkerError("DATA_ROOT_MARKER_INVALID", "storage", "Dedicated data root marker is invalid.");
    }
  }

  const roots = {
    root,
    work: path.join(root, "work"),
    artifacts: path.join(root, "artifacts"),
    idempotency: path.join(root, "idempotency"),
    locks: path.join(root, "locks")
  };
  for (const child of Object.values(roots).slice(1)) {
    assertContained(root, child);
    await fsp.mkdir(child, { recursive: true });
  }
  return roots;
}

function configuredInteger(name, fallback, min, max) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new WorkerError("WORKER_ENV_INVALID", "environment", `${name} is outside its allowed range.`);
  }
  return number;
}

function minimalChildEnv(job, stage, idempotencyHash, fixtureScenario, parityScenario = "") {
  const env = {};
  for (const name of BASE_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, [min, max]] of Object.entries(NUMERIC_TUNING)) {
    if (process.env[name] === undefined || process.env[name] === "") continue;
    const number = configuredInteger(name, null, min, max);
    env[name] = String(number);
  }
  for (const name of BOOLEAN_TUNING) {
    if (process.env[name] === undefined || process.env[name] === "") continue;
    if (!/^[01]$/.test(process.env[name])) {
      throw new WorkerError("WORKER_ENV_INVALID", "environment", `${name} must be 0 or 1.`);
    }
    env[name] = process.env[name];
  }

  Object.assign(env, {
    NODE_ENV: fixtureScenario || parityScenario ? "test" : "production",
    CHECK_IN: job.checkIn,
    CHECK_OUT: job.checkOut,
    ADULTS: String(job.adults),
    SEARCH_MODE: job.searchMode,
    COLLECTION_MODE: job.collectionMode,
    COLLECTION_PURPOSE: job.collectionPurpose,
    DETAIL_RANK_RANGES: job.detailRankRanges,
    PRODUCT_MODE: job.productMode,
    BOOKING_RANGE_DAYS: String(job.bookingRangeDays),
    BOOKING_RANGE_PLACE_LIMIT: String(job.bookingRangePlaceLimit),
    SOURCE_ROLE: "recovery_worker",
    COLLECTION_SOURCE: "v4_recovery",
    COLLECTION_SOURCE_LABEL: "V4 recovery worker",
    RUN_STAMP: `v4_${idempotencyHash.slice(0, 16)}`,
    DATA_DIR: stage.data,
    OUTPUTS_DIR: stage.outputs,
    CONFIG_DIR: stage.config
  });
  if (fixtureScenario) env.V4_WORKER_FIXTURE_SCENARIO = fixtureScenario;
  if (parityScenario) {
    env.V4_PARITY_FIXTURE_SCENARIO = parityScenario;
    env.V4_PARITY_TRACE_FILE = path.join(stage.config, "network-trace.json");
  }
  return env;
}

async function runChild({ collectorScript, job, stage, idempotencyHash, fixtureScenario = "", parityScenario = "", signal }) {
  const timeoutMs = configuredInteger("V4_WORKER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1000, 4 * 60 * 60 * 1000);
  const env = minimalChildEnv(job, stage, idempotencyHash, fixtureScenario, parityScenario);
  return new Promise((resolve, reject) => {
    const childArgs = [];
    if (fixtureScenario && process.env.V4_WORKER_OFFLINE_NETWORK_BLOCKER === "1") {
      childArgs.push("--require", OFFLINE_NETWORK_BLOCKER);
    }
    if (parityScenario) childArgs.push("--require", PARITY_FIXTURE_TRANSPORT);
    childArgs.push(collectorScript, job.keyword);
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let timedOut = false;
    let aborted = false;
    let abortKillTimer = null;
    const collect = (target, chunk) => {
      const next = target + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGKILL");
        return target;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    child.once("error", reject);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      abortKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      abortKillTimer.unref();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    timer.unref();
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (aborted) {
        reject(new WorkerError("WORKER_SHUTDOWN", "shutdown", "Worker stopped after receiving a shutdown signal."));
        return;
      }
      if (outputTooLarge) {
        reject(new WorkerError("COLLECTOR_OUTPUT_TOO_LARGE", "collect", "Collector output exceeded the capture limit."));
        return;
      }
      if (timedOut) {
        reject(new WorkerError("COLLECTOR_TIMEOUT", "collect", "Collector exceeded the configured timeout.", { retryable: false }));
        return;
      }
      resolve({ code, signal: exitSignal, stdout, stderr });
    });
  });
}

async function readParityTrace(stage, scenario) {
  const traceFile = path.join(stage.config, "network-trace.json");
  const trace = await readJson(traceFile, "OFFLINE_PARITY_TRACE_INVALID", "network_isolation");
  if (
    trace.schemaVersion !== "datalab-v4-parity-network-trace.v1"
    || trace.scenario !== scenario
    || trace.networkBlockerLoaded !== true
    || trace.actualExternalRequests !== 0
    || !Number.isInteger(trace.fixtureRequestCount)
    || !Array.isArray(trace.routes)
  ) {
    throw new WorkerError(
      "OFFLINE_PARITY_TRACE_INVALID",
      "network_isolation",
      "Offline parity trace did not prove zero external requests."
    );
  }
  return {
    scenario: trace.scenario,
    networkBlockerLoaded: true,
    fixtureRequestCount: trace.fixtureRequestCount,
    actualExternalRequests: 0,
    routes: trace.routes
  };
}

async function readJson(filePath, code, stage) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    throw new WorkerError(code, stage, `Invalid JSON file: ${path.basename(filePath)}.`, { details: { cause: error.code || error.name } });
  }
}

async function scanArtifact(root, maxBytes) {
  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      assertContained(root, absolute, "ARTIFACT_PATH_INVALID");
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new WorkerError("ARTIFACT_SYMLINK_REJECTED", "validate_artifact", "Artifact cannot contain symbolic links.");
      }
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new WorkerError("ARTIFACT_ENTRY_INVALID", "validate_artifact", "Artifact contains an unsupported entry.");
      }
      totalBytes += stat.size;
      if (totalBytes > maxBytes) {
        throw new WorkerError("ARTIFACT_TOO_LARGE", "validate_artifact", "Artifact exceeds the configured size limit.");
      }
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const digest = crypto.createHash("sha256").update(await fsp.readFile(absolute)).digest("hex");
      files.push({ path: relative, size: stat.size, sha256: digest });
    }
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes };
}

async function discoverAndValidateArtifact(outputsRoot, job) {
  const entries = await fsp.readdir(outputsRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  if (directories.length !== 1 || entries.length !== 1) {
    throw new WorkerError("ARTIFACT_DIRECTORY_COUNT_INVALID", "validate_artifact", "Collector must create exactly one output directory.");
  }
  const runDir = path.join(outputsRoot, directories[0].name);
  assertContained(outputsRoot, runDir, "ARTIFACT_PATH_INVALID");
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = await readJson(manifestPath, "ARTIFACT_MANIFEST_INVALID", "validate_artifact");
  const declaredOutput = path.resolve(String(manifest.outputDir || ""));
  if (declaredOutput !== path.resolve(runDir)) {
    throw new WorkerError("ARTIFACT_MANIFEST_PATH_INVALID", "validate_artifact", "Manifest outputDir does not identify the staged run directory.");
  }
  if (manifest.keyword !== job.keyword || manifest.collectionMode !== job.collectionMode || manifest.collectionPurpose !== job.collectionPurpose) {
    throw new WorkerError("ARTIFACT_MANIFEST_JOB_MISMATCH", "validate_artifact", "Manifest does not match the normalized job specification.");
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) {
    throw new WorkerError("ARTIFACT_FILE_LIST_INVALID", "validate_artifact", "Manifest files list is empty or invalid.");
  }
  const declaredFiles = [...manifest.files, ...(Array.isArray(manifest.detailJsonFiles) ? manifest.detailJsonFiles : [])];
  for (const relative of declaredFiles) {
    const text = String(relative || "").replaceAll("\\", "/");
    if (!text || path.isAbsolute(text) || text.split("/").includes("..")) {
      throw new WorkerError("ARTIFACT_FILE_PATH_INVALID", "validate_artifact", "Manifest contains an unsafe file path.");
    }
    const filePath = path.resolve(runDir, ...text.split("/"));
    assertContained(runDir, filePath, "ARTIFACT_FILE_PATH_INVALID");
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new WorkerError("ARTIFACT_FILE_MISSING", "validate_artifact", `Manifest file is missing: ${text}`);
    }
  }
  const maxBytes = configuredInteger("V4_WORKER_MAX_ARTIFACT_BYTES", DEFAULT_MAX_ARTIFACT_BYTES, 1024, 2 * 1024 * 1024 * 1024);
  const inventory = await scanArtifact(runDir, maxBytes);
  return { runDir, manifest, inventory };
}

async function safeRemoveWork(workRoot, target) {
  if (!target || path.resolve(target) === path.resolve(workRoot)) return;
  assertContained(workRoot, target, "WORK_PATH_INVALID");
  await fsp.rm(target, { recursive: true, force: true });
}

async function readIdempotencyRecord(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new WorkerError("IDEMPOTENCY_RECORD_INVALID", "idempotency", "Idempotency record cannot be read.");
  }
}

function replayRecord(record, job, fingerprint, roots) {
  if (record.jobFingerprint !== fingerprint) {
    throw new WorkerError("IDEMPOTENCY_CONFLICT", "idempotency", "Idempotency key is already bound to a different job.");
  }
  if (record.status === "succeeded") {
    const artifactDir = path.join(roots.artifacts, record.artifactId);
    assertContained(roots.artifacts, artifactDir, "IDEMPOTENCY_RECORD_INVALID");
    if (!fs.existsSync(artifactDir)) {
      throw new WorkerError("IDEMPOTENCY_ARTIFACT_MISSING", "idempotency", "Recorded artifact is missing.");
    }
    return {
      schemaVersion: RESULT_SCHEMA,
      status: "duplicate",
      code: "IDEMPOTENT_REPLAY",
      jobId: job.jobId,
      idempotencyKeyHash: record.idempotencyKeyHash,
      artifactId: record.artifactId,
      artifactDir,
      manifestFile: "manifest.json",
      fileCount: record.fileCount,
      totalBytes: record.totalBytes,
      artifactDigest: record.artifactDigest,
      retryable: false,
      duplicate: true
    };
  }
  if (record.status === "failed") {
    throw new WorkerError(
      "IDEMPOTENCY_PREVIOUS_FAILURE",
      "idempotency",
      "This idempotency key already has a terminal failure. Use a new key for a deliberate retry.",
      { details: { originalCode: record.code } }
    );
  }
  throw new WorkerError("IDEMPOTENCY_RECORD_INVALID", "idempotency", "Idempotency record has an unknown status.");
}

async function recoverPromotedArtifact({ artifactDir, artifactId, job, fingerprint, idempotencyKeyHash, recordFile }) {
  if (!fs.existsSync(artifactDir)) return null;
  const stat = await fsp.lstat(artifactDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkerError("ARTIFACT_ORPHAN_CONFLICT", "idempotency", "Existing artifact target is not a safe directory.");
  }
  const envelope = await readJson(
    path.join(artifactDir, "worker-envelope.json"),
    "ARTIFACT_ORPHAN_CONFLICT",
    "idempotency"
  );
  if (
    envelope.schemaVersion !== ENVELOPE_SCHEMA
    || envelope.jobId !== job.jobId
    || envelope.jobFingerprint !== fingerprint
    || envelope.idempotencyKeyHash !== idempotencyKeyHash
    || envelope.collectorBlob !== EXPECTED_COLLECTOR_BLOB
  ) {
    throw new WorkerError("ARTIFACT_ORPHAN_CONFLICT", "idempotency", "Existing artifact envelope does not match this job.");
  }
  const manifestStat = await fsp.stat(path.join(artifactDir, "manifest.json")).catch(() => null);
  if (!manifestStat?.isFile()) {
    throw new WorkerError("ARTIFACT_ORPHAN_CONFLICT", "idempotency", "Existing artifact is missing its manifest.");
  }
  const inventory = await scanArtifact(
    artifactDir,
    configuredInteger("V4_WORKER_MAX_ARTIFACT_BYTES", DEFAULT_MAX_ARTIFACT_BYTES, 1024, 2 * 1024 * 1024 * 1024)
  );
  const record = {
    schemaVersion: RESULT_SCHEMA,
    status: "succeeded",
    jobId: job.jobId,
    idempotencyKeyHash,
    jobFingerprint: fingerprint,
    artifactId,
    fileCount: inventory.files.length,
    totalBytes: inventory.totalBytes,
    artifactDigest: sha256(stableJson(inventory.files)),
    createdAt: new Date().toISOString(),
    recoveredFromArtifact: true
  };
  await writeJsonAtomic(recordFile, record);
  return record;
}

async function executeJob(spec, options = {}) {
  const collectorBlob = await verifyOriginalCollector();
  const job = normalizeJob(spec);
  const roots = await ensureDedicatedDataRoot(options.dataRoot || process.env.V4_WORKER_DATA_DIR);
  const idempotencyKeyHash = sha256(job.idempotencyKey);
  const fingerprint = jobFingerprint(job);
  const recordFile = path.join(roots.idempotency, `${idempotencyKeyHash}.json`);
  const lockFile = path.join(roots.locks, `${idempotencyKeyHash}.lock`);
  const artifactId = `${job.jobId}-${idempotencyKeyHash.slice(0, 12)}`;
  const artifactDir = path.join(roots.artifacts, artifactId);
  assertContained(roots.artifacts, artifactDir, "ARTIFACT_PATH_INVALID");
  const existing = await readIdempotencyRecord(recordFile);
  if (existing) return replayRecord(existing, job, fingerprint, roots);

  let lockHandle;
  let stageRoot = null;
  let stage = null;
  let activeParityScenario = "";
  try {
    try {
      lockHandle = await fsp.open(lockFile, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new WorkerError("IDEMPOTENCY_IN_PROGRESS", "idempotency", "A job with this idempotency key is already running.");
      }
      throw error;
    }
    await lockHandle.writeFile(`${JSON.stringify({ schemaVersion: RESULT_SCHEMA, idempotencyKeyHash })}\n`, "utf8");

    const raced = await readIdempotencyRecord(recordFile);
    if (raced) return replayRecord(raced, job, fingerprint, roots);
    const recovered = await recoverPromotedArtifact({
      artifactDir,
      artifactId,
      job,
      fingerprint,
      idempotencyKeyHash,
      recordFile
    });
    if (recovered) return replayRecord(recovered, job, fingerprint, roots);

    stageRoot = await fsp.mkdtemp(path.join(roots.work, `${idempotencyKeyHash.slice(0, 12)}-`));
    assertContained(roots.work, stageRoot, "WORK_PATH_INVALID");
    stage = {
      root: stageRoot,
      data: path.join(stageRoot, "data"),
      config: path.join(stageRoot, "config"),
      outputs: path.join(stageRoot, "outputs")
    };
    for (const directory of [stage.data, stage.config, stage.outputs]) {
      assertContained(stageRoot, directory, "WORK_PATH_INVALID");
      await fsp.mkdir(directory, { recursive: true });
    }

    const fixtureScenario = options.fixtureScenario || "";
    const parityScenario = options.parityScenario || "";
    activeParityScenario = parityScenario;
    if (fixtureScenario && parityScenario) {
      throw new WorkerError("OFFLINE_MODE_CONFLICT", "environment", "Fixture collector and frozen collector parity modes are mutually exclusive.");
    }
    const collectorScript = fixtureScenario ? FIXTURE_COLLECTOR : ORIGINAL_COLLECTOR;
    if (fixtureScenario && !(process.env.NODE_ENV === "test" && process.env.V4_WORKER_ALLOW_OFFLINE_FIXTURE === "1")) {
      throw new WorkerError("OFFLINE_FIXTURE_FORBIDDEN", "environment", "Offline fixture mode is allowed only in the test environment.");
    }
    if (parityScenario && !(process.env.NODE_ENV === "test" && process.env.V4_WORKER_ALLOW_OFFLINE_PARITY === "1")) {
      throw new WorkerError("OFFLINE_PARITY_FORBIDDEN", "environment", "Frozen collector parity mode is allowed only in the test environment.");
    }
    if (parityScenario && !PARITY_FIXTURE_SCENARIOS.has(parityScenario)) {
      throw new WorkerError("OFFLINE_PARITY_INVALID", "environment", "Unknown frozen collector parity scenario.");
    }
    const child = await runChild({
      collectorScript,
      job,
      stage,
      idempotencyHash: idempotencyKeyHash,
      fixtureScenario,
      parityScenario,
      signal: options.signal
    });
    if (child.code !== 0) {
      const diagnostic = sanitizeText(child.stderr || child.stdout || `collector exited with ${child.code}`);
      throw new WorkerError("COLLECTOR_EXIT_NONZERO", "collect", diagnostic || "Collector exited with a non-zero status.", {
        exitCode: child.code
      });
    }

    const parityTrace = parityScenario ? await readParityTrace(stage, parityScenario) : null;
    const artifact = await discoverAndValidateArtifact(stage.outputs, job);
    if (fs.existsSync(artifactDir)) {
      throw new WorkerError("ARTIFACT_ALREADY_EXISTS", "promote", "Artifact target already exists without an idempotency record.");
    }

    const envelope = {
      schemaVersion: ENVELOPE_SCHEMA,
      baselineCommit: BASELINE_COMMIT,
      collectorBlob,
      jobId: job.jobId,
      idempotencyKeyHash,
      jobFingerprint: fingerprint,
      manifestFile: "manifest.json",
      createdAt: new Date().toISOString(),
      originalManifestOutputDir: path.relative(stageRoot, path.resolve(artifact.manifest.outputDir)).split(path.sep).join("/"),
      automaticRetry: false,
      automaticFallback: false
    };
    if (parityTrace) envelope.offlineParity = parityTrace;
    await writeJsonAtomic(path.join(artifact.runDir, "worker-envelope.json"), envelope);
    const finalInventory = await scanArtifact(
      artifact.runDir,
      configuredInteger("V4_WORKER_MAX_ARTIFACT_BYTES", DEFAULT_MAX_ARTIFACT_BYTES, 1024, 2 * 1024 * 1024 * 1024)
    );
    const artifactDigest = sha256(stableJson(finalInventory.files));
    await fsp.rename(artifact.runDir, artifactDir);

    const record = {
      schemaVersion: RESULT_SCHEMA,
      status: "succeeded",
      jobId: job.jobId,
      idempotencyKeyHash,
      jobFingerprint: fingerprint,
      artifactId,
      fileCount: finalInventory.files.length,
      totalBytes: finalInventory.totalBytes,
      artifactDigest,
      createdAt: new Date().toISOString()
    };
    await writeJsonAtomic(recordFile, record);
    return {
      schemaVersion: RESULT_SCHEMA,
      status: "succeeded",
      code: "OK",
      jobId: job.jobId,
      idempotencyKeyHash,
      artifactId,
      artifactDir,
      manifestFile: "manifest.json",
      fileCount: record.fileCount,
      totalBytes: record.totalBytes,
      artifactDigest,
      retryable: false,
      duplicate: false,
      ...(parityTrace ? { offlineParity: parityTrace } : {})
    };
  } catch (error) {
    const workerError = error instanceof WorkerError
      ? error
      : new WorkerError("WORKER_INTERNAL_ERROR", "worker", sanitizeText(error.message || error));
    if (activeParityScenario && stage) {
      const parityTrace = await readParityTrace(stage, activeParityScenario).catch(() => null);
      if (parityTrace) {
        workerError.details = { ...(workerError.details || {}), offlineParity: parityTrace };
      }
    }
    if (lockHandle && !fs.existsSync(recordFile)) {
      const recovered = await recoverPromotedArtifact({
        artifactDir,
        artifactId,
        job,
        fingerprint,
        idempotencyKeyHash,
        recordFile
      }).catch(() => null);
      if (recovered) return replayRecord(recovered, job, fingerprint, roots);
      await writeJsonAtomic(recordFile, {
        schemaVersion: RESULT_SCHEMA,
        status: "failed",
        jobId: job.jobId,
        idempotencyKeyHash,
        jobFingerprint: fingerprint,
        code: workerError.code,
        stage: workerError.stage,
        exitCode: workerError.exitCode,
        retryable: false,
        createdAt: new Date().toISOString()
      }).catch(() => {});
    }
    throw workerError;
  } finally {
    if (stageRoot) await safeRemoveWork(roots.work, stageRoot).catch(() => {});
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (lockHandle) await fsp.unlink(lockFile).catch(() => {});
  }
}

function parseArgs(argv) {
  let jobFile = "";
  let fixtureScenario = "";
  let parityScenario = "";
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--job-file") {
      jobFile = argv[++index] || "";
    } else if (token.startsWith("--job-file=")) {
      jobFile = token.slice("--job-file=".length);
    } else if (token === "--offline-fixture") {
      fixtureScenario = argv[++index] || "success";
    } else if (token.startsWith("--offline-fixture=")) {
      fixtureScenario = token.slice("--offline-fixture=".length) || "success";
    } else if (token === "--offline-parity") {
      parityScenario = argv[++index] || "success";
    } else if (token.startsWith("--offline-parity=")) {
      parityScenario = token.slice("--offline-parity=".length) || "success";
    } else {
      throw new WorkerError("WORKER_ARGUMENT_INVALID", "input", `Unknown argument: ${token}`);
    }
  }
  if (fixtureScenario && !["success", "slow", "exit", "partial", "missing-file", "manifest-outside"].includes(fixtureScenario)) {
    throw new WorkerError("OFFLINE_FIXTURE_INVALID", "input", "Unknown offline fixture scenario.");
  }
  if (parityScenario && !PARITY_FIXTURE_SCENARIOS.has(parityScenario)) {
    throw new WorkerError("OFFLINE_PARITY_INVALID", "input", "Unknown frozen collector parity scenario.");
  }
  if (fixtureScenario && parityScenario) {
    throw new WorkerError("OFFLINE_MODE_CONFLICT", "input", "Fixture collector and frozen collector parity modes are mutually exclusive.");
  }
  return { jobFile, fixtureScenario, parityScenario };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw new WorkerError("JOB_INPUT_TOO_LARGE", "input", "Job input exceeds 64 KiB.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJobSpec(jobFile) {
  let text;
  if (jobFile) {
    const filePath = path.resolve(jobFile);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new WorkerError("JOB_FILE_NOT_FOUND", "input", "Job file does not exist.");
    if (stat.size > MAX_INPUT_BYTES) throw new WorkerError("JOB_INPUT_TOO_LARGE", "input", "Job input exceeds 64 KiB.");
    text = await fsp.readFile(filePath, "utf8");
  } else {
    text = await readStdin();
  }
  if (!text.trim()) throw new WorkerError("JOB_INPUT_EMPTY", "input", "Job input is empty.");
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerError("JOB_INPUT_INVALID_JSON", "input", "Job input is not valid JSON.");
  }
}

function publicFailure(error, rawJobId) {
  const workerError = error instanceof WorkerError
    ? error
    : new WorkerError("WORKER_INTERNAL_ERROR", "worker", error?.message || String(error));
  const jobId = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(String(rawJobId || "")) ? String(rawJobId) : "";
  const result = {
    schemaVersion: RESULT_SCHEMA,
    status: "failed",
    code: workerError.code,
    stage: workerError.stage,
    jobId,
    message: sanitizeText(workerError.message),
    retryable: workerError.retryable === true
  };
  if (workerError.exitCode !== null) result.exitCode = workerError.exitCode;
  if (workerError.details) result.details = workerError.details;
  return result;
}

async function main() {
  let rawSpec = null;
  let output;
  const shutdown = new AbortController();
  const requestShutdown = () => shutdown.abort();
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
  try {
    const args = parseArgs(process.argv.slice(2));
    rawSpec = await readJobSpec(args.jobFile);
    output = await executeJob(rawSpec, {
      fixtureScenario: args.fixtureScenario,
      parityScenario: args.parityScenario,
      signal: shutdown.signal
    });
  } catch (error) {
    output = publicFailure(error, rawSpec?.jobId);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", requestShutdown);
    process.removeListener("SIGINT", requestShutdown);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

module.exports = {
  BASELINE_COMMIT,
  EXPECTED_COLLECTOR_BLOB,
  JOB_SCHEMA,
  OFFLINE_NETWORK_BLOCKER,
  ORIGINAL_COLLECTOR,
  PARITY_FIXTURE_SCENARIOS,
  PARITY_FIXTURE_TRANSPORT,
  RESULT_SCHEMA,
  WorkerError,
  ensureDedicatedDataRoot,
  executeJob,
  gitBlobSha,
  normalizeJob,
  publicFailure,
  runChild,
  verifyOriginalCollector
};

if (require.main === module) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(publicFailure(error, ""))}\n`);
    process.exitCode = 1;
  });
}
