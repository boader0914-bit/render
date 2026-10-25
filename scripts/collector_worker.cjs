"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { parseCollectionProgressLine } = require("./collection_progress.cjs");
const { StringDecoder } = require("node:string_decoder");
const { performance } = require("node:perf_hooks");

const PROTOCOL_VERSION = 1;
const JOB_ENV_KEYS = new Set([
  "CHECK_IN", "CHECK_OUT", "ADULTS", "SEARCH_MODE", "SEARCH_MODE_REQUESTED", "SEARCH_MODE_AUTO_CORRECTED",
  "SEARCH_INTENT", "SEARCH_REGION", "SEARCH_SCOPE", "SEARCH_SCOPE_LABEL", "COLLECTION_MODE", "COLLECTION_PURPOSE",
  "DETAIL_RANK_RANGES", "PRODUCT_MODE", "DAY_USE_MODE", "BOOKING_RANGE_DAYS", "BOOKING_RANGE_PLACE_LIMIT", "NAVER_BOOKING_STOCK_LIMIT",
  "SOURCE_ROLE", "COLLECTION_SOURCE", "COLLECTION_SOURCE_LABEL", "SCHEDULED_COLLECTION", "RUN_STAMP",
  "NAVER_REQUEST_PACING_ENABLED", "NAVER_REQUEST_MIN_INTERVAL_MS", "NAVER_REQUEST_MAX_CONCURRENCY", "NAVER_REQUEST_PACING_START_DATE",
  "NAVER_BOOKING_DETAIL_CONCURRENCY", "NAVER_SCHEDULE_CONCURRENCY", "NAVER_SCHEDULE_DELAY_MS", "NAVER_OTA_OBSERVATION_CONCURRENCY",
  "NAVER_OTA_OBSERVATION_LIMIT", "NAVER_BOOKING_ID_FALLBACK", "NAVER_COUPON_PAGE_FALLBACK", "REGIONAL_LIMIT", "REGIONAL_SEARCH_CONCURRENCY"
  , "COLLECTOR_WORKER_KEY", "COLLECTOR_TRIGGER", "COLLECTOR_RUN_TOKEN", "COLLECTOR_JOB_ID", "COLLECTOR_ENGINE"
]);
const RUNTIME_ENV_KEYS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ", "NODE_PATH"]);
const STAGES = new Map([
  ["Collecting Naver main...", "rank_main"], ["Collecting Naver regional clusters...", "rank_regional"],
  ["Collecting NOL...", "ota_nol"], ["Checking Yeogi...", "ota_yeogi"], ["Collecting DDNayo...", "ota_ddnayo"],
  ["Observing external reservation links on Naver Place...", "inventory"],
  ["Checking Naver booking stock...", "inventory"], ["Writing outputs...", "save"]
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const FAIL_CODES = new Set(["COLLECTOR_CANCELLED", "COLLECTOR_SHUTDOWN", "COLLECTOR_HEARTBEAT_FAILED", "COLLECTOR_CRAWL_FAILED", "COLLECTOR_ARTIFACT_INVALID", "COLLECTOR_UPLOAD_FAILED", "COLLECTOR_JOB_INVALID", "COLLECTOR_DISK_LOW"]);
const BROKER_FAILURE_CODES = new Set([
  "COLLECTOR_DUPLICATE_PATH", "COLLECTOR_FILE_SET_MISMATCH", "COLLECTOR_FILE_HASH_MISMATCH", "COLLECTOR_FILE_LENGTH_MISMATCH",
  "COLLECTOR_INVALID_MANIFEST", "COLLECTOR_INVALID_FILES", "COLLECTOR_INVALID_FILE_DESCRIPTOR", "COLLECTOR_INVALID_FILE_HASH",
  "COLLECTOR_INVALID_PATH", "COLLECTOR_INVALID_FILE_TYPE", "COLLECTOR_INVALID_RUN_ID", "COLLECTOR_RUN_ID_MISMATCH",
  "COLLECTOR_SCOPE_MISMATCH", "COLLECTOR_WORKER_RECEIPT_REQUIRED", "COLLECTOR_BLOCK_RECEIPT_REQUIRED",
  "COLLECTOR_FILE_TOO_LARGE", "COLLECTOR_RUN_TOO_LARGE", "COLLECTOR_MANIFEST_TOO_LARGE", "COLLECTOR_TOO_MANY_FILES",
  "COLLECTOR_UPLOAD_CONFLICT", "COLLECTOR_UPLOAD_IN_PROGRESS", "COLLECTOR_COMPLETION_CONFLICT", "COLLECTOR_OUTPUT_EXISTS",
  "COLLECTOR_UNSAFE_FILE", "COLLECTOR_UNSAFE_STORAGE", "COLLECTOR_PUBLICATION_FAILED", "COLLECTOR_PERSISTENCE_FAILED"
]);
const FAILURE_PHASES = new Set(["file_upload", "final_validation"]);
const SERVICE_CODES = new Set(["COLLECTOR_CONFIGURATION_INVALID", "COLLECTOR_WORKER_DISABLED", "COLLECTOR_CLAIM_AUTH_FAILED",
  "COLLECTOR_CLAIM_REJECTED", "COLLECTOR_RESPONSE_INVALID", "COLLECTOR_TERMINAL_ACK_REQUIRED", "COLLECTOR_PROVIDER_BLOCKED",
  "COLLECTOR_WORKER_HALTED", "COLLECTOR_WORKER_STOPPED", ...FAIL_CODES]);

function failure(code, status = 0) { const error = new Error(code); error.code = code; error.status = status; return error; }
function safeCode(error, fallback) { return FAIL_CODES.has(error?.code) ? error.code : fallback; }
function safeFailureDetails(value) {
  if (!FAILURE_PHASES.has(value?.failurePhase)) return {};
  return { failurePhase: value.failurePhase, ...(BROKER_FAILURE_CODES.has(value?.brokerErrorCode) ? { brokerErrorCode: value.brokerErrorCode } : {}) };
}
function bounded(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  return number;
}

function workerOptions(env = process.env, overrides = {}) {
  const enabled = overrides.enabled ?? env.COLLECTOR_WORKER_ENABLED === "1";
  if (!enabled) return { enabled: false };
  let url;
  try { url = new URL(overrides.serverUrl || env.COLLECTOR_SERVER_URL); } catch { throw failure("COLLECTOR_CONFIGURATION_INVALID"); }
  const localHttp = (overrides.allowLocalHttp ?? env.COLLECTOR_ALLOW_LOCAL_HTTP === "1")
    && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw failure("COLLECTOR_CONFIGURATION_INVALID");
  const token = overrides.token ?? env.COLLECTOR_WORKER_TOKEN;
  const workerId = overrides.workerId || env.COLLECTOR_WORKER_ID || "staydatalab-collector";
  const workerKey = overrides.workerKey ?? env.COLLECTOR_WORKER_KEY ?? null;
  if (workerKey !== null && !["manual", "scheduled"].includes(workerKey)) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  const apiBasePath = overrides.apiBasePath || env.COLLECTOR_API_PATH || (workerKey === "scheduled" ? "/api/collector-worker-scheduled" : "/api/collector-worker");
  if (!["/api/collector-worker", "/api/collector-worker-scheduled"].includes(apiBasePath)) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token) || typeof workerId !== "string" || !ID_PATTERN.test(workerId)) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  return {
    enabled: true, serverUrl: url.origin, token, workerId, workerKey, apiBasePath,
    cwd: path.resolve(overrides.cwd || path.join(__dirname, "..")),
    workDir: path.resolve(overrides.workDir || env.COLLECTOR_WORK_DIR || path.join(os.tmpdir(), "staydatalab-collector")),
    runtimeEnv: overrides.runtimeEnv || env,
    pollMs: bounded(overrides.pollMs ?? env.COLLECTOR_POLL_MS, 5000, 1, 60000),
    heartbeatMs: bounded(overrides.heartbeatMs, 10000, 1, 20000),
    requestTimeoutMs: bounded(overrides.requestTimeoutMs, 15000, 10, 30000),
    heartbeatTimeoutMs: bounded(overrides.heartbeatTimeoutMs, 5000, 10, 10000),
    heartbeatAttempts: bounded(overrides.heartbeatAttempts, 3, 1, 3),
    terminalStatusAttempts: bounded(overrides.terminalStatusAttempts, 3, 1, 3),
    killTimeoutMs: bounded(overrides.killTimeoutMs, 2000, 10, 5000),
    uploadAttempts: bounded(overrides.uploadAttempts, 3, 1, 3),
    retryMs: bounded(overrides.retryMs, 1000, 1, 5000),
    claimRetryBaseMs: bounded(overrides.claimRetryBaseMs ?? env.COLLECTOR_CLAIM_RETRY_BASE_MS, 5000, 1, 60000),
    claimRetryMaxMs: bounded(overrides.claimRetryMaxMs ?? env.COLLECTOR_CLAIM_RETRY_MAX_MS, 60000, 1, 300000),
    random: typeof overrides.random === "function" ? overrides.random : Math.random,
    sleepImpl: typeof overrides.sleepImpl === "function" ? overrides.sleepImpl : sleep,
    maxFiles: bounded(overrides.maxFiles, 2048, 1, 2048),
    maxFileBytes: bounded(overrides.maxFileBytes, 64 * 1024 * 1024, 1, 64 * 1024 * 1024),
    maxTotalBytes: bounded(overrides.maxTotalBytes, 256 * 1024 * 1024, 1, 256 * 1024 * 1024),
    minFreeBytes: bounded(overrides.minFreeBytes, 200 * 1024 * 1024, 1, Number.MAX_SAFE_INTEGER),
    maxJobs: overrides.maxJobs ?? Infinity,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    spawnImpl: overrides.spawnImpl || spawn,
    signal: overrides.signal,
    logger: overrides.logger || (() => {})
  };
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(failure("COLLECTOR_SHUTDOWN"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(failure("COLLECTOR_SHUTDOWN")); }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function readResponseJson(response, maxBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  if (!response.body) throw failure("COLLECTOR_RESPONSE_INVALID");
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw failure("COLLECTOR_RESPONSE_INVALID");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("COLLECTOR_RESPONSE_INVALID"); }
}

async function request(options, route, { method = "POST", body, file, headers = {}, signal, attempts = 1, timeoutMs = options.requestTimeoutMs, maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw failure("COLLECTOR_SHUTDOWN");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let stream, responseStatus = 0;
    try {
      stream = file ? fs.createReadStream(file) : null;
      const response = await options.fetchImpl(`${options.serverUrl}${options.apiBasePath || "/api/collector-worker"}${route}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json", "Content-Type": file ? "application/octet-stream" : "application/json", ...headers },
        body: stream || JSON.stringify(body ?? {}), ...(stream ? { duplex: "half" } : {})
      });
      responseStatus = response.status;
      if (!response.ok) {
        const error = failure("COLLECTOR_REQUEST_FAILED", response.status);
        // Never forward the response body: it can contain credentials, paths or
        // provider text. Only recognized broker codes from bounded JSON survive.
        try {
          const reply = await readResponseJson(response, 8 * 1024);
          if (BROKER_FAILURE_CODES.has(reply?.error)) error.brokerErrorCode = reply.error;
        } catch {}
        throw error;
      }
      return await readResponseJson(response, maxResponseBytes);
    } catch (error) {
      const retryable = error.code !== "COLLECTOR_RESPONSE_INVALID"
        && (!error.status || error.status === 408 || error.status === 429 || error.status >= 500);
      if (signal?.aborted || !retryable || attempt + 1 >= attempts) {
        const safeError = failure(error.code === "COLLECTOR_RESPONSE_INVALID" ? error.code : "COLLECTOR_REQUEST_FAILED", error.status || responseStatus || 0);
        if (error.code !== "COLLECTOR_RESPONSE_INVALID" && !error.status) safeError.transportFailure = true;
        if (BROKER_FAILURE_CODES.has(error?.brokerErrorCode)) safeError.brokerErrorCode = error.brokerErrorCode;
        throw safeError;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stream?.destroy();
    }
    await sleep(options.retryMs * (attempt + 1), signal);
  }
  throw failure("COLLECTOR_REQUEST_FAILED");
}

function transientRequest(error) {
  return error?.code === "COLLECTOR_REQUEST_FAILED"
    && (error.transportFailure === true || !error.status || error.status === 408 || error.status === 429 || (error.status >= 500 && error.status <= 599));
}

function terminalAcknowledgement(reply, job, proof) {
  if (reply?.ok !== true || reply.jobId !== job.id || reply.terminal !== true || reply.leaseReleased !== true
    || typeof reply.providerBlocked !== "boolean" || typeof reply.finishedAt !== "string" || reply.finishedAt.length > 40
    || !Number.isFinite(Date.parse(reply.finishedAt)) || new Date(reply.finishedAt).toISOString() !== reply.finishedAt) return null;
  if (reply.status === "failed" || reply.status === "cancelled") return reply;
  if (reply.status !== "completed" || !proof || reply.completionMatches !== true || reply.runId !== proof.runId
    || typeof reply.collectionFailed !== "boolean" || !["complete", "partial", "failed", "blocked"].includes(reply.qualityStatus)) return null;
  return reply;
}
function terminalFailureCode(reply, localProviderBlocked = false) {
  if (localProviderBlocked || reply.providerBlocked || reply.qualityStatus === "blocked" || reply.errorCode === "COLLECTOR_PROVIDER_BLOCKED") return "COLLECTOR_PROVIDER_BLOCKED";
  if (reply.status === "cancelled") return "COLLECTOR_CANCELLED";
  return safeCode({ code: reply.errorCode }, "COLLECTOR_CRAWL_FAILED");
}

function validateJob(job, options = {}) {
  if (!job || typeof job.id !== "string" || !ID_PATTERN.test(job.id) || typeof job.keyword !== "string" || !job.keyword.trim() || job.keyword.length > 160 || /[\x00-\x1f\x7f]/.test(job.keyword)
    || typeof job.leaseToken !== "string" || !/^[a-zA-Z0-9_-]{24,256}$/.test(job.leaseToken)
    || !Number.isSafeInteger(job.leaseMs) || job.leaseMs < 1000 || job.leaseMs > 60000
    || !job.env || typeof job.env !== "object" || Array.isArray(job.env)) throw failure("COLLECTOR_JOB_INVALID");
  for (const [key, value] of Object.entries(job.env)) {
    if (!JOB_ENV_KEYS.has(key) || typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw failure("COLLECTOR_JOB_INVALID");
  }
  if (job.env.RUN_STAMP && !/^[a-zA-Z0-9_-]{1,100}$/.test(job.env.RUN_STAMP)) throw failure("COLLECTOR_JOB_INVALID");
  if (job.env.SCHEDULED_COLLECTION && !["0", "1"].includes(job.env.SCHEDULED_COLLECTION)) throw failure("COLLECTOR_JOB_INVALID");
  if (job.env.DAY_USE_MODE !== undefined && !["inspect", "lodging_only", "detail"].includes(job.env.DAY_USE_MODE)) throw failure("COLLECTOR_JOB_INVALID");
  if (job.workerKey) {
    const engine = job.workerKey === "scheduled" ? "archive-keyword-adapted-v2" : "current-manual-v2";
    if (!["manual", "scheduled"].includes(job.workerKey) || job.workerKey !== (options.workerKey || "manual")
      || !["manual", "scheduled"].includes(job.trigger)
      || job.env.COLLECTOR_WORKER_KEY !== job.workerKey || job.env.COLLECTOR_TRIGGER !== job.trigger
      || job.env.COLLECTOR_JOB_ID !== job.id || job.env.COLLECTOR_ENGINE !== engine
      || !/^[a-p]{24}$/.test(job.env.COLLECTOR_RUN_TOKEN || "")
      || (job.env.SCHEDULED_COLLECTION === "1") !== (job.trigger === "scheduled")) throw failure("COLLECTOR_JOB_INVALID");
  } else if (options.workerKey === "scheduled" || ["COLLECTOR_WORKER_KEY", "COLLECTOR_TRIGGER", "COLLECTOR_RUN_TOKEN", "COLLECTOR_JOB_ID", "COLLECTOR_ENGINE"].some(key => job.env[key] !== undefined)) {
    throw failure("COLLECTOR_JOB_INVALID");
  }
  const rows = job.context?.historicalBookingBusinesses ?? [];
  if (!Array.isArray(rows) || rows.length > 20000) throw failure("COLLECTOR_JOB_INVALID");
  const seen = new Set();
  return rows.map((row) => {
    if (!row || typeof row.placeId !== "string" || typeof row.businessId !== "string" || !/^[1-9]\d{0,19}$/.test(row.placeId) || !/^[1-9]\d{0,19}$/.test(row.businessId)) throw failure("COLLECTOR_JOB_INVALID");
    if (seen.has(row.placeId)) throw failure("COLLECTOR_JOB_INVALID");
    seen.add(row.placeId);
    return { placeId: row.placeId, businessId: row.businessId };
  });
}

async function prepareJob(job, options) {
  const context = validateJob(job, options);
  await fsp.mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(options.workDir);
  const storage = await fsp.statfs(root);
  if (Number(storage.bavail) * Number(storage.bsize) < options.minFreeBytes + options.maxTotalBytes) throw failure("COLLECTOR_DISK_LOW");
  const directory = await fsp.mkdtemp(path.join(root, "job-"));
  const locations = Object.fromEntries(["data", "outputs", "config", "tmp"].map((name) => [name, path.join(directory, name)]));
  await Promise.all(Object.values(locations).map((dir) => fsp.mkdir(dir, { mode: 0o700 })));
  const contextFile = path.join(locations.config, "historical-booking-businesses.json");
  await fsp.writeFile(contextFile, JSON.stringify(context), { mode: 0o600, flag: "wx" });
  const env = {};
  for (const [key, value] of Object.entries(options.runtimeEnv)) if (RUNTIME_ENV_KEYS.has(key.toUpperCase()) && typeof value === "string") env[key] = value;
  Object.assign(env, job.env, { DATA_DIR: locations.data, OUTPUTS_DIR: locations.outputs, CONFIG_DIR: locations.config,
    TMPDIR: locations.tmp, TMP: locations.tmp, TEMP: locations.tmp,
    HISTORY_BOOKING_BUSINESS_CONTEXT_FILE: contextFile, COLLECTOR_WORKER_RUNTIME: "1" });
  return { directory, root, ...locations, env };
}

function stageReader(update, providerBlocked = () => {}, onCollectionProgress = () => {}) {
  let tail = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    tail += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const lines = tail.split(/\r?\n/);
    tail = lines.pop().slice(-4096);
    for (const line of lines) {
      if (STAGES.has(line.trim())) update(STAGES.get(line.trim()));
      if (line.trim() === "COLLECTOR_PROVIDER_BLOCKED") providerBlocked();
      const progress = parseCollectionProgressLine(line);
      if (progress) onCollectionProgress(progress);
    }
  };
}

async function digestFile(file) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest("hex") };
}

async function artifactsFor(prepared, options) {
  const jobRoot = await fsp.realpath(prepared.directory);
  const outputStat = await fsp.lstat(prepared.outputs);
  const outputRoot = await fsp.realpath(prepared.outputs);
  if (jobRoot !== prepared.directory || outputStat.isSymbolicLink() || !outputStat.isDirectory() || path.dirname(outputRoot) !== jobRoot) throw failure("COLLECTOR_ARTIFACT_INVALID");
  const entries = await fsp.readdir(prepared.outputs, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].isSymbolicLink()
    || entries[0].name.length > 180 || !/^[a-z0-9][a-z0-9_-]*_glamping_\d{8}(?:_\d{6})?$/i.test(entries[0].name)) throw failure("COLLECTOR_ARTIFACT_INVALID");
  const runId = entries[0].name;
  const root = await fsp.realpath(path.join(prepared.outputs, runId));
  if (path.dirname(root) !== outputRoot) throw failure("COLLECTOR_ARTIFACT_INVALID");
  const files = [];
  let total = 0;
  async function walk(directory, depth) {
    if (depth > 12) throw failure("COLLECTOR_ARTIFACT_INVALID");
    for (const entry of (await fsp.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink() || !(await fsp.realpath(absolute)).startsWith(root + path.sep)) throw failure("COLLECTOR_ARTIFACT_INVALID");
      if (stat.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > options.maxFileBytes || files.length >= options.maxFiles) throw failure("COLLECTOR_ARTIFACT_INVALID");
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (!relative || relative.length > 240 || relative !== relative.normalize("NFC") || !/\.(json|csv|xlsx|md)$/i.test(relative)
        || relative.split("/").some((part) => !part || part.startsWith(".") || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
        || /[\\\x00-\x1f\x7f<>:"|?*%]/.test(relative)) throw failure("COLLECTOR_ARTIFACT_INVALID");
      const digest = await digestFile(absolute);
      if (digest.size !== stat.size) throw failure("COLLECTOR_ARTIFACT_INVALID");
      total += digest.size;
      if (total > options.maxTotalBytes) throw failure("COLLECTOR_ARTIFACT_INVALID");
      files.push({ path: relative, ...digest, absolute });
    }
  }
  await walk(root, 0);
  if (!files.some((file) => file.path === "manifest.json")) throw failure("COLLECTOR_ARTIFACT_INVALID");
  return { runId, files };
}

async function removeOwnedJob(prepared) {
  const actual = await fsp.realpath(prepared.directory);
  if (path.dirname(actual) !== prepared.root || !path.basename(actual).startsWith("job-")) throw failure("COLLECTOR_ARTIFACT_INVALID");
  await fsp.rm(actual, { recursive: true, force: true });
}

async function runJob(job, options, { claimedAt = performance.now() } = {}) {
  if (!options?.enabled) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  let prepared, child, childDone, childClosed = true, childStopRequested = false, stopCode = "", stage = "rank_main";
  let heartbeatTimer, deadlineTimer, escalationTimer, urgentHeartbeat, progressTimer;
  let heartbeatChain = Promise.resolve(), completionAcknowledged = false;
  let progress = null;
  let providerBlocked = false;
  let leaseDeadlineAt = 0, terminalReply = null, terminalLookupPromise, terminalLookupAccepted = null, terminalLookupRequests = 0;
  let terminalAckRequired = false, completionProof = null;
  const controller = new AbortController();
  const stop = (code) => {
    if (!stopCode) stopCode = code;
    controller.abort();
    if (child && !childClosed && !childStopRequested) {
      childStopRequested = true;
      try { child.kill("SIGTERM"); } catch {}
      if (!escalationTimer) escalationTimer = setTimeout(() => { try { if (!childClosed) child.kill("SIGKILL"); } catch {} }, options.killTimeoutMs);
    }
  };
  const shutdown = () => stop("COLLECTOR_SHUTDOWN");
  options.signal?.addEventListener("abort", shutdown, { once: true });
  const credentials = { workerId: options.workerId, leaseToken: job?.leaseToken };
  const jobPath = `/jobs/${encodeURIComponent(job?.id || "invalid")}`;
  function heartbeatFailed(reason, status = 0, attempt = 0) {
    if (completionAcknowledged) return;
    if (!completionAcknowledged && !stopCode) emitServiceEvent(options, { event: "collector_heartbeat_failed",
      code: "COLLECTOR_HEARTBEAT_FAILED", reason, status, attempt });
    stop(stopCode || "COLLECTOR_HEARTBEAT_FAILED");
  }
  function deadline(requestStartedAt) {
    // A dispatch or a lost/late ACK grants no local time. The safety margin
    // covers transit and shutdown; only a validated ACK confirms renewal.
    const candidate = requestStartedAt + job.leaseMs - Math.min(5000, job.leaseMs / 4);
    leaseDeadlineAt = Math.max(leaseDeadlineAt, candidate);
    clearTimeout(deadlineTimer);
    const remainingMs = leaseDeadlineAt - performance.now();
    if (remainingMs <= 0) { heartbeatFailed("lease_deadline"); return; }
    deadlineTimer = setTimeout(() => heartbeatFailed("lease_deadline"), Math.max(1, Math.floor(remainingMs)));
  }
  function acceptTerminal(reply) {
    if (terminalReply) return;
    terminalReply = reply;
    completionAcknowledged = true;
    terminalAckRequired = false;
    clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer); clearTimeout(progressTimer);
    const code = terminalFailureCode(reply, providerBlocked);
    emitServiceEvent(options, { event: "collector_terminal_reconciled", code: reply.status === "completed"
      && !reply.collectionFailed && !reply.providerBlocked && !providerBlocked && !["failed", "blocked"].includes(reply.qualityStatus)
      ? "COLLECTOR_COMPLETION_CONFIRMED" : code });
    if (reply.status !== "completed" || reply.collectionFailed || reply.providerBlocked || providerBlocked || ["failed", "blocked"].includes(reply.qualityStatus)) stop(code);
  }
  function readTerminal() {
    // Share in-flight/accepted reads only: a later completion can change an
    // earlier nonterminal record. The request budget is global to this job.
    if (terminalLookupAccepted) return Promise.resolve(terminalLookupAccepted);
    if (terminalLookupPromise) return terminalLookupPromise;
    const attempts = options.terminalStatusAttempts || 3;
    if (terminalLookupRequests >= attempts) return Promise.resolve(null);
    terminalLookupPromise = (async () => {
      try { while (terminalLookupRequests < attempts) {
        const attempt = ++terminalLookupRequests;
        try {
          const reply = await request(options, `${jobPath}/terminal-status`, { body: { ...credentials, ...(completionProof || {}) },
            timeoutMs: options.heartbeatTimeoutMs, maxResponseBytes: 8 * 1024 });
          const accepted = terminalAcknowledgement(reply, job, completionProof);
          if (accepted) terminalLookupAccepted = accepted;
          if (!accepted) emitServiceEvent(options, { event: "collector_terminal_unverified", code: "COLLECTOR_TERMINAL_ACK_REQUIRED" });
          return accepted;
        } catch (error) {
          if (!transientRequest(error) || attempt >= attempts || options.signal?.aborted) {
            emitServiceEvent(options, { event: "collector_terminal_unverified", code: "COLLECTOR_TERMINAL_ACK_REQUIRED",
              status: error.status || 0 });
            return null;
          }
          // status=0 denotes an unknown transport status, not HTTP success.
          emitServiceEvent(options, { event: "collector_terminal_retry", code: "COLLECTOR_TERMINAL_TRANSIENT",
            status: error.status || 0, attempt, retryInMs: options.retryMs * attempt });
          try { await sleep(options.retryMs * attempt, options.signal); } catch { return null; }
        }
      }
      return null;
      } finally { terminalLookupPromise = null; }
    })();
    return terminalLookupPromise;
  }
  function terminalOutcome() {
    const successful = terminalReply.status === "completed" && !terminalReply.providerBlocked && !providerBlocked && !terminalReply.collectionFailed
      && !["failed", "blocked"].includes(terminalReply.qualityStatus);
    return { status: successful ? "completed" : terminalReply.status === "cancelled" ? "cancelled" : "failed",
      acknowledged: true, ...(successful ? { runId: terminalReply.runId } : { halted: true, code: terminalFailureCode(terminalReply, providerBlocked) }),
      retainedDirectory: prepared?.directory || null };
  }
  async function sendHeartbeat(blockOnly = false) {
    if (controller.signal.aborted || completionAcknowledged) return;
    const body = blockOnly ? { ...credentials, providerBlocked: true }
      : { ...credentials, stage, ...(progress ? { progress } : {}), ...(providerBlocked ? { providerBlocked: true } : {}) };
    const attempts = options.heartbeatAttempts || 3;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const requestStartedAt = performance.now(), remainingMs = leaseDeadlineAt - requestStartedAt;
      if (controller.signal.aborted || completionAcknowledged) return;
      if (remainingMs <= 0) { heartbeatFailed("lease_deadline", 0, attempt); return; }
      try {
        const reply = await request(options, `${jobPath}/heartbeat`, { body, signal: controller.signal,
          timeoutMs: Math.max(1, Math.min(options.heartbeatTimeoutMs, Math.floor(job.leaseMs / 3), Math.floor(remainingMs))), maxResponseBytes: 8 * 1024 });
        if (controller.signal.aborted || completionAcknowledged) return;
        if (performance.now() >= leaseDeadlineAt) { heartbeatFailed("lease_deadline", 0, attempt); return; }
        if (typeof reply?.cancelled !== "boolean") throw failure("COLLECTOR_HEARTBEAT_FAILED");
        if (reply.cancelled) { stop("COLLECTOR_CANCELLED"); return; }
        deadline(requestStartedAt);
        if (attempt > 1) emitServiceEvent(options, { event: "collector_heartbeat_recovered", code: "COLLECTOR_HEARTBEAT_RECOVERED", attempts: attempt });
        return;
      } catch (error) {
        if (completionAcknowledged) return;
        if (error.status === 409 && !options.signal?.aborted) {
          heartbeatFailed("request_rejected", 409, attempt);
          terminalAckRequired = true;
          const reply = await readTerminal();
          if (completionAcknowledged) return;
          if (reply) acceptTerminal(reply);
          return;
        }
        const waitMs = options.retryMs * attempt;
        const remaining = leaseDeadlineAt - performance.now();
        if (controller.signal.aborted || !transientRequest(error) || attempt >= attempts || remaining <= waitMs) {
          heartbeatFailed(options.signal?.aborted ? "shutdown" : error.code === "COLLECTOR_RESPONSE_INVALID" || error.code === "COLLECTOR_HEARTBEAT_FAILED"
            ? "malformed_ack" : !transientRequest(error) ? "request_rejected" : "retries_exhausted", error.status || 0, attempt); return;
        }
        emitServiceEvent(options, { event: "collector_heartbeat_retry", code: "COLLECTOR_HEARTBEAT_TRANSIENT",
          status: error.status || 0, attempt, retryInMs: waitMs, remainingLeaseMs: Math.max(0, Math.floor(remaining)) });
        try { await sleep(waitMs, controller.signal); } catch { return; }
      }
    }
  }
  function heartbeat() {
    heartbeatChain = heartbeatChain.then(() => sendHeartbeat());
    return heartbeatChain;
  }
  function nextHeartbeat() {
    if (controller.signal.aborted || completionAcknowledged) return;
    heartbeatTimer = setTimeout(() => { heartbeat().finally(nextHeartbeat); }, Math.min(options.heartbeatMs, Math.floor(job.leaseMs / 4)));
  }
  try {
    if (options.signal?.aborted) throw failure("COLLECTOR_SHUTDOWN");
    prepared = await prepareJob(job, options);
    deadline(claimedAt);
    await heartbeat();
    if (stopCode) throw failure(stopCode);
    nextHeartbeat();
    const collectorScript = job.workerKey === "scheduled" ? "archive_keyword_collector.cjs" : "gyeongnam_glamping_crawl.cjs";
    child = options.spawnImpl(process.execPath, [path.join(options.cwd, "scripts", collectorScript), job.keyword],
      { cwd: prepared.directory, env: prepared.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    childClosed = false;
    childDone = new Promise((resolve) => {
      child.once("error", () => { stop("COLLECTOR_CRAWL_FAILED"); });
      child.once("close", (code, signal) => { childClosed = true; clearTimeout(escalationTimer); resolve({ code, signal }); });
    });
    child.stdout?.on("data", stageReader((value) => { stage = value; }, () => {
      if (providerBlocked || controller.signal.aborted) return;
      providerBlocked = true;
      // The marker is emitted by the crawler's global stop gate, not inferred from log text.
      // Notify immediately; the already-stopped child may still save its failure receipt.
      // Protection bypasses the progress queue: another slow heartbeat must
      // not delay the broker's stop notification to the other worker lanes.
      urgentHeartbeat = sendHeartbeat(true);
    }, value => {
      if (controller.signal.aborted || (progress && (value.totalPlaces !== progress.totalPlaces || value.completedPlaces < progress.completedPlaces || value.updatedAt < progress.updatedAt))) return;
      progress = value;
      // Coalesce fast per-place updates. This contacts only our broker and never
      // changes the provider request rate or the lease's regular heartbeat.
      if (!progressTimer) progressTimer = setTimeout(() => {
        progressTimer = null;
        if (!controller.signal.aborted) heartbeat();
      }, 1000);
    }));
    child.stderr?.resume();
    const result = await childDone;
    if (stopCode) throw failure(stopCode);
    if (result.signal) throw failure("COLLECTOR_CRAWL_FAILED");
    clearTimeout(progressTimer); progressTimer = null;
    stage = "save";
    let artifacts;
    try { artifacts = await artifactsFor(prepared, options); } catch { throw failure("COLLECTOR_ARTIFACT_INVALID"); }
    let failureReceipt = null;
    if (result.code !== 0) {
      try {
        const descriptor = artifacts.files.find((file) => file.path === "manifest.json");
        if (descriptor.size > 1024 * 1024) throw failure("COLLECTOR_CRAWL_FAILED");
        const manifest = JSON.parse(await fsp.readFile(descriptor.absolute, "utf8"));
        if (manifest.workerCollection !== true || manifest.collectionFailed !== true || manifest.keyword !== job.keyword) throw failure("COLLECTOR_CRAWL_FAILED");
        failureReceipt = manifest.collectionQuality?.status === "blocked" ? "blocked" : "failed";
      } catch { throw failure("COLLECTOR_CRAWL_FAILED"); }
    }
    if (stopCode) throw failure(stopCode);
    let completionCancelled = false;
    let failurePhase = "file_upload";
    try {
      stage = "uploading";
      await heartbeat();
      if (stopCode) throw failure(stopCode);
      for (const file of artifacts.files) {
        if (stopCode) throw failure(stopCode);
        const reply = await request(options, `${jobPath}/files?path=${encodeURIComponent(file.path)}`, {
          method: "PUT", file: file.absolute, signal: controller.signal, attempts: options.uploadAttempts,
          headers: { "X-Collector-Lease": job.leaseToken, "X-Collector-Worker": options.workerId, "X-Content-SHA256": file.sha256, "Content-Length": String(file.size) }
        });
        if (reply?.ok !== true) throw failure("COLLECTOR_UPLOAD_FAILED");
      }
      if (stopCode) throw failure(stopCode);
      stage = "completing";
      failurePhase = "final_validation";
      await heartbeat();
      if (stopCode) throw failure(stopCode);
      completionProof = { runId: artifacts.runId,
        files: artifacts.files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })) };
      let reply;
      for (let attempt = 1; attempt <= options.uploadAttempts; attempt++) {
        if (terminalReply) break;
        try {
          reply = await request(options, `${jobPath}/complete`, { body: { ...credentials, ...completionProof }, signal: options.signal });
          if (reply?.ok !== true) throw failure("COLLECTOR_RESPONSE_INVALID");
          break;
        } catch (error) {
          const ambiguous = transientRequest(error) || error.code === "COLLECTOR_RESPONSE_INVALID" || error.status === 409
            || [401, 403].includes(error.status) || (error.status >= 200 && error.status < 300);
          if (!ambiguous) throw error;
          terminalAckRequired = true;
          const terminal = await readTerminal();
          if (terminal) { acceptTerminal(terminal); break; }
          if (!transientRequest(error) || attempt >= options.uploadAttempts || options.signal?.aborted) throw error;
          await sleep(options.retryMs * attempt, options.signal);
        }
      }
      if (terminalReply && (terminalReply.status !== "completed" || terminalReply.collectionFailed || terminalReply.providerBlocked || providerBlocked
        || ["failed", "blocked"].includes(terminalReply.qualityStatus))) throw failure(stopCode || "COLLECTOR_CRAWL_FAILED");
      if (terminalReply) reply = { ok: true };
      if (reply?.ok !== true) throw failure("COLLECTOR_UPLOAD_FAILED");
      completionAcknowledged = true;
      terminalAckRequired = false;
      completionCancelled = reply.cancelled === true;
    } catch (error) {
      const transferError = failure(stopCode || safeCode(error, "COLLECTOR_UPLOAD_FAILED"));
      if (!stopCode) Object.assign(transferError, safeFailureDetails({ failurePhase, brokerErrorCode: error?.brokerErrorCode }));
      throw transferError;
    }
    clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer); clearTimeout(progressTimer);
    await Promise.all([heartbeatChain, urgentHeartbeat]);
    if (completionCancelled && !providerBlocked && !failureReceipt) {
      options.logger({ event: "collector_job_cancelled", jobId: job.id, artifactsRetained: true });
      return { status: "cancelled", acknowledged: true, code: "COLLECTOR_CANCELLED", retainedDirectory: prepared.directory };
    }
    // A lost heartbeat after the completion ACK cannot restart or invalidate a completed crawl.
    let retainedDirectory = prepared.directory;
    if (!failureReceipt && !providerBlocked) {
      try { await removeOwnedJob(prepared); retainedDirectory = null; } catch {}
    }
    if (failureReceipt || providerBlocked) {
      const code = failureReceipt === "blocked" || providerBlocked ? "COLLECTOR_PROVIDER_BLOCKED" : "COLLECTOR_CRAWL_FAILED";
      options.logger({ event: "collector_failure_receipt_saved", jobId: job.id, code });
      return { status: "failed", acknowledged: true, code, runId: artifacts.runId, retainedDirectory };
    }
    options.logger({ event: "collector_job_completed", jobId: job.id, files: artifacts.files.length });
    return { status: "completed", acknowledged: true, runId: artifacts.runId, retainedDirectory };
  } catch (error) {
    const code = stopCode || safeCode(error, "COLLECTOR_JOB_INVALID");
    const details = stopCode ? {} : safeFailureDetails(error);
    stop(code);
    if (childDone && !childClosed) await childDone;
    if (terminalLookupPromise && !terminalReply) {
      const terminal = await terminalLookupPromise;
      if (terminal) acceptTerminal(terminal);
    }
    if (terminalReply) {
      return terminalOutcome();
    }
    let acknowledged = false;
    if (!terminalAckRequired && ID_PATTERN.test(job?.id || "") && typeof job?.leaseToken === "string") {
      try { acknowledged = (await request(options, `${jobPath}/fail`, { body: { ...credentials, code, ...details }, timeoutMs: options.heartbeatTimeoutMs }))?.ok === true; } catch {}
      if (!acknowledged) {
        terminalAckRequired = true;
        const terminal = await readTerminal();
        if (terminal) {
          acceptTerminal(terminal);
          return terminalOutcome();
        }
      }
    }
    options.logger({ event: "collector_job_failed", jobId: ID_PATTERN.test(job?.id || "") ? job.id : null, code, ...details, artifactsRetained: Boolean(prepared) });
    return { status: "failed", acknowledged, code, ...details, retainedDirectory: prepared?.directory || null };
  } finally {
    clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer); clearTimeout(escalationTimer); clearTimeout(progressTimer);
    controller.abort();
    options.signal?.removeEventListener("abort", shutdown);
    await Promise.all([heartbeatChain, urgentHeartbeat]);
  }
}

async function runWorker(options = workerOptions()) {
  if (!options.enabled) return { enabled: false, jobs: 0 };
  let jobs = 0, claimFailures = 0, claimRequestId = crypto.randomUUID();
  while (!options.signal?.aborted && jobs < options.maxJobs) {
    let reply;
    // The same nonce can outlive an outage with no issued lease. Confirm the
    // returned job by heartbeat before spawning, using this request's start.
    const claimStartedAt = performance.now();
    try { reply = await request(options, "/claim", { body: { workerId: options.workerId, protocolVersion: PROTOCOL_VERSION,
      claimRequestId, ...(options.workerKey ? { workerKey: options.workerKey } : {}) }, signal: options.signal }); }
    catch (error) {
      if (options.signal?.aborted) break;
      const status = Number.isInteger(error.status) ? error.status : 0;
      const transient = error.code === "COLLECTOR_REQUEST_FAILED" && (!status || [408, 429].includes(status) || status >= 500);
      if (!transient) throw failure([401, 403].includes(status) ? "COLLECTOR_CLAIM_AUTH_FAILED"
        : error.code === "COLLECTOR_RESPONSE_INVALID" ? error.code : "COLLECTOR_CLAIM_REJECTED", status);
      claimFailures++;
      const retryInMs = claimRetryDelay(options, claimFailures);
      emitServiceEvent(options, { event: "collector_claim_retry", code: "COLLECTOR_CLAIM_TRANSIENT", status,
        attempt: Math.min(claimFailures, Number.MAX_SAFE_INTEGER), retryInMs });
      // Keep the same request ID until a valid ACK. The broker can safely
      // replay a leased job when its first response was lost, without issuing
      // another lease or starting the provider crawler twice.
      try { await (options.sleepImpl || sleep)(retryInMs, options.signal); } catch { if (options.signal?.aborted) break; throw failure("COLLECTOR_WORKER_HALTED"); }
      continue;
    }
    if (!reply || !Object.hasOwn(reply, "job")) throw failure("COLLECTOR_RESPONSE_INVALID");
    if (reply.job !== null && (typeof reply.job !== "object" || Array.isArray(reply.job))) throw failure("COLLECTOR_RESPONSE_INVALID");
    if (claimFailures) emitServiceEvent(options, { event: "collector_claim_recovered", code: "COLLECTOR_CLAIM_RECOVERED", attempts: claimFailures });
    const claimedAt = claimStartedAt;
    claimFailures = 0; claimRequestId = crypto.randomUUID();
    if (reply.job === null) { try { await sleep(options.pollMs, options.signal); } catch { break; } continue; }
    const result = await runJob(reply.job, options, { claimedAt });
    jobs++;
    if (!result.acknowledged) throw failure("COLLECTOR_TERMINAL_ACK_REQUIRED");
    if (result.halted || (result.status === "failed" && result.code !== "COLLECTOR_CANCELLED")) return { enabled: true, jobs, halted: true, code: result.code, ...safeFailureDetails(result) };
  }
  return { enabled: true, jobs, stopped: Boolean(options.signal?.aborted) };
}

function emitServiceEvent(options, value) {
  // These events are deliberately assembled from codes/numbers only. Never
  // include exception text, URLs, response bodies, tokens or nonce values.
  try { options.logger?.(value); } catch { /* A logger cannot break the worker. */ }
}
function claimRetryDelay(options, failures) {
  const base = options.claimRetryBaseMs || 5000, maximum = options.claimRetryMaxMs || 60000;
  let random = 0.5; try { const value = (options.random || Math.random)(); if (Number.isFinite(value)) random = Math.max(0, Math.min(1, value)); } catch {}
  return Math.max(1, Math.min(maximum, Math.round(Math.min(maximum, base * 2 ** Math.min(16, Math.max(0, failures - 1))) * (0.8 + random * 0.4))));
}
async function quarantineWorker(options, error) {
  const code = SERVICE_CODES.has(error?.code) ? error.code : "COLLECTOR_WORKER_HALTED";
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
  emitServiceEvent(options, { event: "collector_worker_quarantined", code, status, requiresOperator: true });
  // A pending Promise alone does not keep Node alive. This abortable timer
  // keeps an intentionally protected service up without claiming another job.
  while (!options.signal?.aborted) {
    try { await sleep(60000, options.signal); } catch { if (options.signal?.aborted) break; }
  }
  return { quarantined: true, code, stopped: true };
}
async function runWorkerService(options, { runner = runWorker } = {}) {
  try {
    const result = await runner(options);
    if (options.signal?.aborted) return result;
    return quarantineWorker(options, failure(!options.enabled ? "COLLECTOR_WORKER_DISABLED" : result.code || "COLLECTOR_WORKER_STOPPED"));
  } catch (error) {
    if (options.signal?.aborted) return { stopped: true };
    return quarantineWorker(options, error);
  }
}

async function main() {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  const service = { signal: controller.signal, logger: event => process.stdout.write(`${JSON.stringify(event)}\n`) };
  try {
    let options;
    try { options = workerOptions(process.env, service); }
    catch (error) { await quarantineWorker(service, error); return; }
    await runWorkerService({ ...options, ...service });
  }
  finally { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
}

if (require.main === module) main().catch(error => {
  // Even an unexpected service-level rejection remains fail-closed and alive;
  // a supervisor restart must not turn an unverified terminal state into a job.
  const controller = new AbortController(), shutdown = () => controller.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  void quarantineWorker({ signal: controller.signal, logger: event => process.stdout.write(`${JSON.stringify(event)}\n`) }, error)
    .finally(() => { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); });
});
module.exports = { PROTOCOL_VERSION, JOB_ENV_KEYS, BROKER_FAILURE_CODES, workerOptions, runWorker, runWorkerService, runJob, artifactsFor, stageReader, validateJob, claimRetryDelay };
