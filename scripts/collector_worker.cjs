"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = 1;
const JOB_ENV_KEYS = new Set([
  "CHECK_IN", "CHECK_OUT", "ADULTS", "SEARCH_MODE", "SEARCH_MODE_REQUESTED", "SEARCH_MODE_AUTO_CORRECTED",
  "SEARCH_INTENT", "SEARCH_REGION", "SEARCH_SCOPE", "SEARCH_SCOPE_LABEL", "COLLECTION_MODE", "COLLECTION_PURPOSE",
  "DETAIL_RANK_RANGES", "PRODUCT_MODE", "BOOKING_RANGE_DAYS", "BOOKING_RANGE_PLACE_LIMIT", "NAVER_BOOKING_STOCK_LIMIT",
  "SOURCE_ROLE", "COLLECTION_SOURCE", "COLLECTION_SOURCE_LABEL", "SCHEDULED_COLLECTION", "RUN_STAMP",
  "NAVER_REQUEST_PACING_ENABLED", "NAVER_REQUEST_MIN_INTERVAL_MS", "NAVER_REQUEST_MAX_CONCURRENCY", "NAVER_REQUEST_PACING_START_DATE",
  "NAVER_BOOKING_DETAIL_CONCURRENCY", "NAVER_SCHEDULE_CONCURRENCY", "NAVER_SCHEDULE_DELAY_MS", "NAVER_OTA_OBSERVATION_CONCURRENCY",
  "NAVER_OTA_OBSERVATION_LIMIT", "NAVER_BOOKING_ID_FALLBACK", "NAVER_COUPON_PAGE_FALLBACK", "REGIONAL_LIMIT", "REGIONAL_SEARCH_CONCURRENCY"
]);
const RUNTIME_ENV_KEYS = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TZ", "NODE_PATH"]);
const STAGES = new Map([
  ["Collecting Naver main...", "rank_main"], ["Collecting Naver regional clusters...", "rank_regional"],
  ["Collecting NOL...", "ota_nol"], ["Checking Yeogi...", "ota_yeogi"], ["Collecting DDNayo...", "ota_ddnayo"],
  ["Observing external reservation links on Naver Place...", "inventory"],
  ["Checking Naver booking stock...", "inventory"], ["Writing outputs...", "save"]
]);
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,160}$/;
const FAIL_CODES = new Set(["COLLECTOR_CANCELLED", "COLLECTOR_SHUTDOWN", "COLLECTOR_HEARTBEAT_FAILED", "COLLECTOR_CRAWL_FAILED", "COLLECTOR_ARTIFACT_INVALID", "COLLECTOR_UPLOAD_FAILED", "COLLECTOR_JOB_INVALID"]);

function failure(code, status = 0) { const error = new Error(code); error.code = code; error.status = status; return error; }
function safeCode(error, fallback) { return FAIL_CODES.has(error?.code) ? error.code : fallback; }
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
  if (typeof token !== "string" || token.length < 32 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token) || typeof workerId !== "string" || !ID_PATTERN.test(workerId)) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  return {
    enabled: true, serverUrl: url.origin, token, workerId,
    cwd: path.resolve(overrides.cwd || path.join(__dirname, "..")),
    workDir: path.resolve(overrides.workDir || env.COLLECTOR_WORK_DIR || path.join(os.tmpdir(), "staydatalab-collector")),
    runtimeEnv: overrides.runtimeEnv || env,
    pollMs: bounded(overrides.pollMs ?? env.COLLECTOR_POLL_MS, 5000, 1, 60000),
    heartbeatMs: bounded(overrides.heartbeatMs, 10000, 1, 20000),
    requestTimeoutMs: bounded(overrides.requestTimeoutMs, 15000, 10, 30000),
    heartbeatTimeoutMs: bounded(overrides.heartbeatTimeoutMs, 5000, 10, 10000),
    killTimeoutMs: bounded(overrides.killTimeoutMs, 2000, 10, 5000),
    uploadAttempts: bounded(overrides.uploadAttempts, 3, 1, 3),
    retryMs: bounded(overrides.retryMs, 1000, 1, 5000),
    maxFiles: bounded(overrides.maxFiles, 2048, 1, 2048),
    maxFileBytes: bounded(overrides.maxFileBytes, 64 * 1024 * 1024, 1, 64 * 1024 * 1024),
    maxTotalBytes: bounded(overrides.maxTotalBytes, 256 * 1024 * 1024, 1, 256 * 1024 * 1024),
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
  });
}

async function readResponseJson(response) {
  const chunks = [];
  let length = 0;
  if (!response.body) throw failure("COLLECTOR_RESPONSE_INVALID");
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) throw failure("COLLECTOR_RESPONSE_INVALID");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("COLLECTOR_RESPONSE_INVALID"); }
}

async function request(options, route, { method = "POST", body, file, headers = {}, signal, attempts = 1, timeoutMs = options.requestTimeoutMs } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw failure("COLLECTOR_SHUTDOWN");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let stream;
    try {
      stream = file ? fs.createReadStream(file) : null;
      const response = await options.fetchImpl(`${options.serverUrl}/api/collector-worker${route}`, {
        method, redirect: "error", signal: controller.signal,
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json", "Content-Type": file ? "application/octet-stream" : "application/json", ...headers },
        body: stream || JSON.stringify(body ?? {}), ...(stream ? { duplex: "half" } : {})
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw failure("COLLECTOR_REQUEST_FAILED", response.status);
      }
      return await readResponseJson(response);
    } catch (error) {
      const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
      if (signal?.aborted || !retryable || attempt + 1 >= attempts) throw failure("COLLECTOR_REQUEST_FAILED", error.status || 0);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      stream?.destroy();
    }
    await sleep(options.retryMs * (attempt + 1), signal);
  }
  throw failure("COLLECTOR_REQUEST_FAILED");
}

function validateJob(job) {
  if (!job || typeof job.id !== "string" || !ID_PATTERN.test(job.id) || typeof job.keyword !== "string" || !job.keyword.trim() || job.keyword.length > 160 || /[\x00-\x1f\x7f]/.test(job.keyword)
    || typeof job.leaseToken !== "string" || !/^[a-zA-Z0-9_-]{24,256}$/.test(job.leaseToken)
    || !Number.isSafeInteger(job.leaseMs) || job.leaseMs < 1000 || job.leaseMs > 60000
    || !job.env || typeof job.env !== "object" || Array.isArray(job.env)) throw failure("COLLECTOR_JOB_INVALID");
  for (const [key, value] of Object.entries(job.env)) {
    if (!JOB_ENV_KEYS.has(key) || typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) throw failure("COLLECTOR_JOB_INVALID");
  }
  if (job.env.RUN_STAMP && !/^[a-zA-Z0-9_-]{1,100}$/.test(job.env.RUN_STAMP)) throw failure("COLLECTOR_JOB_INVALID");
  if (job.env.SCHEDULED_COLLECTION && !["0", "1"].includes(job.env.SCHEDULED_COLLECTION)) throw failure("COLLECTOR_JOB_INVALID");
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
  const context = validateJob(job);
  await fsp.mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const root = await fsp.realpath(options.workDir);
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

function stageReader(update) {
  let tail = "";
  return (chunk) => {
    tail += chunk.toString("utf8");
    const lines = tail.split(/\r?\n/);
    tail = lines.pop().slice(-512);
    for (const line of lines) if (STAGES.has(line.trim())) update(STAGES.get(line.trim()));
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

async function runJob(job, options) {
  if (!options?.enabled) throw failure("COLLECTOR_CONFIGURATION_INVALID");
  let prepared, child, childDone, childClosed = true, stopCode = "", stage = "rank_main";
  let heartbeatTimer, deadlineTimer, escalationTimer, heartbeatPending;
  const controller = new AbortController();
  const stop = (code) => {
    if (!stopCode) stopCode = code;
    controller.abort();
    if (child && !childClosed) {
      try { child.kill("SIGTERM"); } catch {}
      if (!escalationTimer) escalationTimer = setTimeout(() => { try { if (!childClosed) child.kill("SIGKILL"); } catch {} }, options.killTimeoutMs);
    }
  };
  const shutdown = () => stop("COLLECTOR_SHUTDOWN");
  options.signal?.addEventListener("abort", shutdown, { once: true });
  const credentials = { workerId: options.workerId, leaseToken: job?.leaseToken };
  const jobPath = `/jobs/${encodeURIComponent(job?.id || "invalid")}`;
  function deadline() {
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => stop("COLLECTOR_HEARTBEAT_FAILED"), Math.max(1, job.leaseMs - Math.min(5000, job.leaseMs / 4)));
  }
  async function heartbeat() {
    try {
      const reply = await request(options, `${jobPath}/heartbeat`, { body: { ...credentials, stage }, signal: controller.signal,
        timeoutMs: Math.min(options.heartbeatTimeoutMs, Math.floor(job.leaseMs / 3)) });
      if (typeof reply?.cancelled !== "boolean") throw failure("COLLECTOR_HEARTBEAT_FAILED");
      if (reply.cancelled) { stop("COLLECTOR_CANCELLED"); return; }
      deadline();
    } catch { stop(stopCode || "COLLECTOR_HEARTBEAT_FAILED"); }
  }
  function nextHeartbeat() {
    if (controller.signal.aborted) return;
    heartbeatTimer = setTimeout(() => { heartbeatPending = heartbeat().finally(nextHeartbeat); }, Math.min(options.heartbeatMs, Math.floor(job.leaseMs / 4)));
  }
  try {
    if (options.signal?.aborted) throw failure("COLLECTOR_SHUTDOWN");
    prepared = await prepareJob(job, options);
    deadline();
    await heartbeat();
    if (stopCode) throw failure(stopCode);
    nextHeartbeat();
    child = options.spawnImpl(process.execPath, [path.join(options.cwd, "scripts", "gyeongnam_glamping_crawl.cjs"), job.keyword],
      { cwd: prepared.directory, env: prepared.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    childClosed = false;
    childDone = new Promise((resolve) => {
      child.once("error", () => { stop("COLLECTOR_CRAWL_FAILED"); });
      child.once("close", (code, signal) => { childClosed = true; clearTimeout(escalationTimer); resolve({ code, signal }); });
    });
    child.stdout?.on("data", stageReader((value) => { stage = value; }));
    child.stderr?.resume();
    const result = await childDone;
    if (stopCode) throw failure(stopCode);
    if (result.signal) throw failure("COLLECTOR_CRAWL_FAILED");
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
    try {
      for (const file of artifacts.files) {
        if (stopCode) throw failure(stopCode);
        const reply = await request(options, `${jobPath}/files?path=${encodeURIComponent(file.path)}`, {
          method: "PUT", file: file.absolute, signal: controller.signal, attempts: options.uploadAttempts,
          headers: { "X-Collector-Lease": job.leaseToken, "X-Collector-Worker": options.workerId, "X-Content-SHA256": file.sha256, "Content-Length": String(file.size) }
        });
        if (reply?.ok !== true) throw failure("COLLECTOR_UPLOAD_FAILED");
      }
      if (stopCode) throw failure(stopCode);
      stage = "save";
      const reply = await request(options, `${jobPath}/complete`, { body: { ...credentials, runId: artifacts.runId,
        files: artifacts.files.map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 })) },
        // The child has exited and all bytes are uploaded. A completion may
        // already be committed when its ACK is lost and heartbeat returns 409;
        // allow only this idempotent completion handshake to resolve that case.
        signal: options.signal, attempts: options.uploadAttempts });
      if (reply?.ok !== true) throw failure("COLLECTOR_UPLOAD_FAILED");
      completionCancelled = reply.cancelled === true;
    } catch (error) { throw failure(stopCode || safeCode(error, "COLLECTOR_UPLOAD_FAILED")); }
    clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer);
    await heartbeatPending;
    if (completionCancelled) {
      options.logger({ event: "collector_job_cancelled", jobId: job.id, artifactsRetained: true });
      return { status: "cancelled", acknowledged: true, code: "COLLECTOR_CANCELLED", retainedDirectory: prepared.directory };
    }
    // A lost heartbeat after the completion ACK cannot restart or invalidate a completed crawl.
    let retainedDirectory = null;
    try { await removeOwnedJob(prepared); } catch { retainedDirectory = prepared.directory; }
    if (failureReceipt) {
      const code = failureReceipt === "blocked" ? "COLLECTOR_PROVIDER_BLOCKED" : "COLLECTOR_CRAWL_FAILED";
      options.logger({ event: "collector_failure_receipt_saved", jobId: job.id, code });
      return { status: "failed", acknowledged: true, code, runId: artifacts.runId, retainedDirectory };
    }
    options.logger({ event: "collector_job_completed", jobId: job.id, files: artifacts.files.length });
    return { status: "completed", acknowledged: true, runId: artifacts.runId, retainedDirectory };
  } catch (error) {
    const code = stopCode || safeCode(error, "COLLECTOR_JOB_INVALID");
    stop(code);
    if (childDone && !childClosed) await childDone;
    let acknowledged = false;
    if (ID_PATTERN.test(job?.id || "") && typeof job?.leaseToken === "string") {
      try { acknowledged = (await request(options, `${jobPath}/fail`, { body: { ...credentials, code }, timeoutMs: options.heartbeatTimeoutMs }))?.ok === true; } catch {}
    }
    options.logger({ event: "collector_job_failed", jobId: ID_PATTERN.test(job?.id || "") ? job.id : null, code, artifactsRetained: Boolean(prepared) });
    return { status: "failed", acknowledged, code, retainedDirectory: prepared?.directory || null };
  } finally {
    clearTimeout(heartbeatTimer); clearTimeout(deadlineTimer); clearTimeout(escalationTimer);
    controller.abort();
    options.signal?.removeEventListener("abort", shutdown);
    await heartbeatPending;
  }
}

async function runWorker(options = workerOptions()) {
  if (!options.enabled) return { enabled: false, jobs: 0 };
  let jobs = 0;
  while (!options.signal?.aborted && jobs < options.maxJobs) {
    let reply;
    try { reply = await request(options, "/claim", { body: { workerId: options.workerId, protocolVersion: PROTOCOL_VERSION }, signal: options.signal }); }
    catch { if (options.signal?.aborted) break; throw failure("COLLECTOR_CLAIM_FAILED"); }
    if (!reply || !Object.hasOwn(reply, "job")) throw failure("COLLECTOR_RESPONSE_INVALID");
    if (reply.job === null) { try { await sleep(options.pollMs, options.signal); } catch { break; } continue; }
    const result = await runJob(reply.job, options);
    jobs++;
    if (!result.acknowledged) throw failure("COLLECTOR_TERMINAL_ACK_REQUIRED");
    if (result.status === "failed" && result.code !== "COLLECTOR_CANCELLED") break;
  }
  return { enabled: true, jobs, stopped: Boolean(options.signal?.aborted) };
}

async function main() {
  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  try { await runWorker(workerOptions(process.env, { signal: controller.signal,
    logger: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) })); }
  finally { process.removeListener("SIGINT", shutdown); process.removeListener("SIGTERM", shutdown); }
}

if (require.main === module) main().catch(() => { process.stderr.write("collector_worker_stopped\n"); process.exitCode = 1; });
module.exports = { PROTOCOL_VERSION, JOB_ENV_KEYS, workerOptions, runWorker, runJob, artifactsFor, stageReader };
