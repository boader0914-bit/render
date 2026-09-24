"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { inspectManifest } = require("./daily_collection_quality.cjs");
const { sanitizeCollectionProgress } = require("./collection_progress.cjs");

const LEASE_MS = 60_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RUN_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_FILES = 2048;
const TERMINAL_JOBS_IN_LEDGER = 200;
const ENV_KEYS = new Set([
  "CHECK_IN", "CHECK_OUT", "ADULTS", "SEARCH_MODE", "SEARCH_MODE_REQUESTED", "SEARCH_MODE_AUTO_CORRECTED",
  "SEARCH_INTENT", "SEARCH_REGION", "SEARCH_SCOPE", "SEARCH_SCOPE_LABEL", "COLLECTION_MODE", "COLLECTION_PURPOSE",
  "DETAIL_RANK_RANGES", "PRODUCT_MODE", "DAY_USE_MODE", "BOOKING_RANGE_DAYS", "BOOKING_RANGE_PLACE_LIMIT", "NAVER_BOOKING_STOCK_LIMIT",
  "SOURCE_ROLE", "COLLECTION_SOURCE", "COLLECTION_SOURCE_LABEL", "SCHEDULED_COLLECTION", "WORKER_COLLECTION", "RUN_STAMP",
  "NAVER_REQUEST_PACING_ENABLED", "NAVER_REQUEST_MIN_INTERVAL_MS", "NAVER_REQUEST_MAX_CONCURRENCY",
  "NAVER_REQUEST_PACING_START_DATE", "NAVER_BOOKING_DETAIL_CONCURRENCY", "NAVER_SCHEDULE_CONCURRENCY",
  "NAVER_OTA_OBSERVATION_CONCURRENCY", "NAVER_SCHEDULE_DELAY_MS", "NAVER_OTA_OBSERVATION_LIMIT",
  "REGIONAL_LIMIT", "REGIONAL_SEARCH_CONCURRENCY", "NAVER_BOOKING_ID_FALLBACK", "NAVER_COUPON_PAGE_FALLBACK",
  "COLLECTOR_WORKER_KEY", "COLLECTOR_TRIGGER", "COLLECTOR_RUN_TOKEN", "COLLECTOR_ENGINE", "COLLECTOR_JOB_ID",
]);
const PAYLOAD_KEYS = new Set([
  "keyword", "checkIn", "checkOut", "adults", "searchMode", "searchIntent", "searchRegion", "searchScope",
  "searchScopeLabel", "collectionMode", "collectionPurpose", "productMode", "dayUseMode", "detailRankRanges",
  "bookingRangeDays", "bookingRangePlaceLimit", "sourceRole", "collectionSource", "scheduledCollection",
  "workerKey", "trigger", "collectionEngine",
]);
const STAGES = new Set(["rank_main", "rank_regional", "ota_nol", "ota_yeogi", "ota_ddnayo", "inventory", "save", "uploading", "completing"]);
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ALL_STATUSES = new Set([...TERMINAL, "queued", "leased", "committing"]);

function problem(code, statusCode = 409) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
function errorCode(value, fallback = "COLLECTOR_JOB_FAILED") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{2,79}$/.test(value) ? value : fallback;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function sameSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function relativeFile(value) {
  if (typeof value !== "string" || !value || value.length > 240 || value !== value.normalize("NFC")
    || /[\\\x00-\x1f\x7f<>:"|?*%]/.test(value) || value.startsWith("/")) throw problem("COLLECTOR_INVALID_PATH", 400);
  const parts = value.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") || /[ .]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw problem("COLLECTOR_INVALID_PATH", 400);
  if (!/\.(json|csv|xlsx|md)$/i.test(value)) throw problem("COLLECTOR_INVALID_FILE_TYPE", 400);
  return value;
}
function runIdentifier(value) {
  if (typeof value !== "string" || value.length > 180 || !/^[a-z0-9][a-z0-9_-]*_glamping_\d{8}(?:_\d{6})?$/i.test(value)) {
    throw problem("COLLECTOR_INVALID_RUN_ID", 400);
  }
  return value;
}
async function exists(filename) {
  try { return await fsp.lstat(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
// Check every existing ancestor, including configured roots. Upload destinations
// are never resolved through a symlink, junction, or a non-directory ancestor.
async function checkedDirectory(directory, create = false) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat = await exists(cursor);
    if (!stat && create) {
      await fsp.mkdir(cursor).catch(error => { if (error.code !== "EEXIST") throw error; });
      stat = await fsp.lstat(cursor);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw problem("COLLECTOR_UNSAFE_STORAGE");
  }
  return absolute;
}
async function regularFile(filename) {
  await checkedDirectory(path.dirname(filename));
  const stat = await fsp.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw problem("COLLECTOR_UNSAFE_FILE");
  return stat;
}
async function fileHash(filename) {
  await regularFile(filename);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) })) hash.update(chunk);
  return hash.digest("hex");
}
async function atomicJson(filename, value) {
  await checkedDirectory(path.dirname(filename));
  const previous = await exists(filename);
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) throw problem("COLLECTOR_UNSAFE_STORAGE");
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}
function cleanEnv(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw problem("COLLECTOR_INVALID_ENV", 400);
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ENV_KEYS.has(key) || typeof value !== "string" || value.length > 2048 || /[\x00\r\n]/.test(value)) throw problem("COLLECTOR_INVALID_ENV", 400);
    output[key] = value;
  }
  if (output.DAY_USE_MODE !== undefined && !["inspect", "lodging_only", "detail"].includes(output.DAY_USE_MODE)) throw problem("COLLECTOR_INVALID_ENV", 400);
  return output;
}
function cleanPayload(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw problem("COLLECTOR_INVALID_PAYLOAD", 400);
  const output = {};
  for (const key of PAYLOAD_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    if (!["string", "boolean", "number"].includes(typeof value) || String(value).length > 2048) throw problem("COLLECTOR_INVALID_PAYLOAD", 400);
    output[key] = value;
  }
  if (output.dayUseMode !== undefined && !["inspect", "lodging_only", "detail"].includes(output.dayUseMode)) throw problem("COLLECTOR_INVALID_PAYLOAD", 400);
  return output;
}
function cleanContext(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "historicalBookingBusinesses")) {
    throw problem("COLLECTOR_INVALID_CONTEXT", 400);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_JSON_BYTES) throw problem("COLLECTOR_CONTEXT_TOO_LARGE", 413);
  const rows = input.historicalBookingBusinesses || [];
  if (!Array.isArray(rows)) throw problem("COLLECTOR_INVALID_CONTEXT", 400);
  const seen = new Set();
  const values = rows.map(row => {
    if (!row || typeof row !== "object" || Object.keys(row).some(key => !["placeId", "businessId"].includes(key))
      || typeof row.placeId !== "string" || typeof row.businessId !== "string"
      || !/^[1-9]\d{0,19}$/.test(row.placeId) || !/^[1-9]\d{0,19}$/.test(row.businessId) || seen.has(row.placeId)) throw problem("COLLECTOR_INVALID_CONTEXT", 400);
    seen.add(String(row.placeId));
    return { placeId: String(row.placeId), businessId: String(row.businessId) };
  });
  return { historicalBookingBusinesses: values };
}
function descriptors(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES) throw problem("COLLECTOR_INVALID_FILES", 400);
  const seen = new Set();
  let total = 0;
  const files = value.map(entry => {
    const filename = relativeFile(entry?.path);
    const key = filename.toLowerCase();
    if (seen.has(key)) throw problem("COLLECTOR_DUPLICATE_PATH", 400);
    seen.add(key);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) {
      throw problem("COLLECTOR_INVALID_FILE_DESCRIPTOR", 400);
    }
    total += entry.size;
    return { path: filename, size: entry.size, sha256: entry.sha256 };
  });
  if (total > MAX_RUN_BYTES) throw problem("COLLECTOR_RUN_TOO_LARGE", 413);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
function descriptorKey(files) { return digest(JSON.stringify(files)); }
function scopeCheck(manifest, job, runId, files) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw problem("COLLECTOR_INVALID_MANIFEST", 400);
  if (manifest.workerCollection !== true) throw problem("COLLECTOR_WORKER_RECEIPT_REQUIRED", 400);
  if (job.workerKey) {
    if (manifest.workerKey !== job.workerKey || manifest.trigger !== job.trigger || manifest.jobId !== job.id
      || manifest.collectorEngine !== job.env.COLLECTOR_ENGINE
      || !runId.includes(`_${job.workerKey}_${job.env.COLLECTOR_RUN_TOKEN}_glamping_`)) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
  }
  const compact = value => String(value ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (compact(manifest.keyword) !== compact(job.keyword)) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
  if (String(manifest.outputDir || "").replace(/\\/g, "/").split("/").pop() !== runId) throw problem("COLLECTOR_RUN_ID_MISMATCH", 400);
  const checkIn = job.env.CHECK_IN ?? job.payload.checkIn;
  if (checkIn !== undefined && runId.match(/_glamping_(\d{8})(?:_\d{6})?$/)?.[1] !== String(checkIn).replaceAll("-", "")) {
    throw problem("COLLECTOR_RUN_ID_MISMATCH", 400);
  }
  const fields = { CHECK_IN: "checkIn", CHECK_OUT: "checkOut", ADULTS: "adults", SEARCH_MODE: "searchMode", SEARCH_INTENT: "searchIntent",
    SEARCH_REGION: "searchRegion", SEARCH_SCOPE: "searchScope", COLLECTION_MODE: "collectionMode", COLLECTION_PURPOSE: "collectionPurpose",
    PRODUCT_MODE: "productMode", DAY_USE_MODE: "dayUseMode", BOOKING_RANGE_DAYS: "bookingRangeDays", BOOKING_RANGE_PLACE_LIMIT: "bookingRangePlaceLimit",
    SOURCE_ROLE: "sourceRole", COLLECTION_SOURCE: "collectionSource" };
  for (const [key, field] of Object.entries(fields)) {
    const expected = job.env[key] ?? job.payload[field];
    if (expected !== undefined && String(expected) !== String(manifest[field] ?? (field === "dayUseMode" ? "detail" : ""))) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
  }
  const ranks = value => compact(value).replace(/[~–]/g, "-");
  const expectedRanks = job.env.DETAIL_RANK_RANGES ?? job.payload.detailRankRanges;
  if (expectedRanks !== undefined && ranks(expectedRanks) !== ranks(manifest.detailRankRanges)) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
  const scheduled = job.env.SCHEDULED_COLLECTION !== undefined ? job.env.SCHEDULED_COLLECTION === "1" : job.payload.scheduledCollection === true;
  if (Boolean(manifest.scheduledCollection) !== scheduled) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
  if (!Array.isArray(manifest.files) || (!manifest.files.length && manifest.collectionFailed !== true) || !Array.isArray(manifest.detailJsonFiles || [])) throw problem("COLLECTOR_INVALID_MANIFEST", 400);
  const referenced = ["manifest.json", ...manifest.files, ...(manifest.detailJsonFiles || []).map(entry => entry?.file)].map(relativeFile);
  if (new Set(referenced.map(name => name.toLowerCase())).size !== referenced.length) throw problem("COLLECTOR_DUPLICATE_PATH", 400);
  const actual = new Set(files.map(file => file.path));
  if (actual.size !== referenced.length || referenced.some(name => !actual.has(name))) throw problem("COLLECTOR_FILE_SET_MISMATCH", 400);
  for (const name of Object.values(manifest.fileRoles || {})) {
    if (!manifest.files.includes(relativeFile(name))) throw problem("COLLECTOR_FILE_SET_MISMATCH", 400);
  }
}
async function diskFiles(base, relative = "") {
  const output = [];
  await checkedDirectory(path.join(base, relative));
  for (const entry of await fsp.readdir(path.join(base, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw problem("COLLECTOR_UNSAFE_FILE");
    if (entry.isDirectory()) output.push(...await diskFiles(base, name));
    else { relativeFile(name); await regularFile(path.join(base, ...name.split("/"))); output.push(name); }
  }
  return output;
}
async function validateFiles(base, files) {
  const stored = await diskFiles(base);
  if (stored.length !== files.length || stored.some(name => !files.some(file => file.path === name))) throw problem("COLLECTOR_FILE_SET_MISMATCH", 400);
  for (const file of files) {
    const filename = path.join(base, ...file.path.split("/"));
    const stat = await regularFile(filename);
    if (stat.size !== file.size || await fileHash(filename) !== file.sha256) throw problem("COLLECTOR_FILE_HASH_MISMATCH", 400);
  }
}
async function readJsonRequest(req) {
  const length = req.headers?.["content-length"];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_JSON_BYTES)) throw problem("COLLECTOR_REQUEST_TOO_LARGE", 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_JSON_BYTES) throw problem("COLLECTOR_REQUEST_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw problem("COLLECTOR_INVALID_JSON", 400); }
}
function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

function createCollectorBroker(options = {}) {
  const dataDir = path.resolve(options.dataDir || "");
  const outputsDir = path.resolve(options.outputsDir || path.join(dataDir, "outputs"));
  const brokerDir = path.resolve(options.brokerDir || path.join(dataDir, "collector"));
  const workerKey = options.workerKey || null;
  if (workerKey !== null && !["manual", "scheduled"].includes(workerKey)) throw problem("COLLECTOR_INVALID_WORKER", 400);
  const apiBasePath = options.apiBasePath || (workerKey === "scheduled" ? "/api/collector-worker-scheduled" : "/api/collector-worker");
  if (!["/api/collector-worker", "/api/collector-worker-scheduled"].includes(apiBasePath)) throw problem("COLLECTOR_INVALID_ROUTE", 400);
  const stagingDir = path.join(brokerDir, "staging");
  const receiptsDir = path.join(brokerDir, "receipts");
  const stateFile = path.join(brokerDir, "jobs.json");
  const token = typeof options.token === "string" ? options.token : "";
  const configured = token.length >= 32 && token.length <= 512 && !/\s/.test(token);
  const workerId = options.workerId || "staydatalab-collector";
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(workerId)) throw problem("COLLECTOR_INVALID_WORKER", 400);
  if (inside(outputsDir, brokerDir) || inside(brokerDir, outputsDir)) throw problem("COLLECTOR_UNSAFE_STORAGE", 400);
  let state = { version: 1, halted: null, workerLastSeenAt: null, jobs: [] };
  let ready = false;
  let initialization;
  let lastSeenPersistedAt = -Infinity;
  let chain = Promise.resolve();
  const uploading = new Map();
  const timestamp = () => {
    const value = options.now ? options.now() : Date.now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw problem("COLLECTOR_INVALID_CLOCK", 500);
    return milliseconds;
  };
  const iso = () => new Date(timestamp()).toISOString();
  const locked = operation => {
    const next = chain.then(operation, operation);
    chain = next.catch(() => {});
    return next;
  };
  const jobById = async id => {
    if (typeof id !== "string" || !/^collector_[a-f0-9-]{36}$/.test(id)) throw problem("COLLECTOR_JOB_NOT_FOUND", 404);
    const job = state.jobs.find(entry => entry.id === id);
    if (job) return job;
    const receiptPath = path.join(receiptsDir, `${id}.json`);
    if (!await exists(receiptPath)) throw problem("COLLECTOR_JOB_NOT_FOUND", 404);
    try {
      await regularFile(receiptPath);
      const receipt = JSON.parse(await fsp.readFile(receiptPath, "utf8"));
      if (receipt.id !== id || !TERMINAL.has(receipt.status)) throw new Error();
      return receipt;
    } catch { throw problem("COLLECTOR_STATE_INVALID", 503); }
  };
  const ownsLease = job => Boolean(job.leaseHash && !job.leaseReleasedAt);
  function setHalt(code) {
    // A later cancellation/lease error must not obscure an observed provider block.
    if (state.halted?.code !== "COLLECTOR_PROVIDER_BLOCKED") state.halted = { code, at: iso() };
  }
  function releasePrivateInput(job) { delete job.env; delete job.context; delete job.payload; }
  async function persist() {
    try {
      const finished = state.jobs.filter(job => TERMINAL.has(job.status) && !ownsLease(job));
      const archived = finished.slice(0, Math.max(0, finished.length - TERMINAL_JOBS_IN_LEDGER));
      for (const job of archived) await atomicJson(path.join(receiptsDir, `${job.id}.json`), job);
      if (archived.length) {
        const ids = new Set(archived.map(job => job.id));
        state.jobs = state.jobs.filter(job => !ids.has(job.id));
      }
      await atomicJson(stateFile, state);
      lastSeenPersistedAt = timestamp();
    }
    catch { state.halted = { code: "COLLECTOR_PERSISTENCE_FAILED", at: iso() }; throw problem("COLLECTOR_PERSISTENCE_FAILED", 503); }
  }
  function publicJob(job) {
    const output = { id: job.id, status: job.status, keyword: job.keyword, createdAt: job.createdAt, updatedAt: job.updatedAt };
    for (const key of ["startedAt", "finishedAt", "errorCode", "stage", "workerKey", "trigger", "failurePhase", "brokerErrorCode", "recovery", "progress", "progressReceivedAt"]) if (job[key]) output[key] = clone(job[key]);
    if (job.status === "completed") Object.assign(output, { runId: job.runId, outputDir: job.outputDir, manifest: clone(job.manifest), collectionQuality: clone(job.collectionQuality) });
    return output;
  }
  async function expireLeases() {
    // A scheduled job waiting through its observation day must never be claimed
    // on a later day, even between dispatch polling intervals. Active leases finish normally.
    const expiredQueue = state.jobs.filter(job => job.status === "queued" && Number.isSafeInteger(job.queueDeadline) && timestamp() >= job.queueDeadline);
    for (const job of expiredQueue) {
      job.status = "cancelled";
      job.errorCode = "COLLECTOR_QUEUE_DEADLINE";
      job.finishedAt = job.updatedAt = iso();
      releasePrivateInput(job);
    }
    if (expiredQueue.length) await persist();
    const expired = state.jobs.filter(job => ownsLease(job) && timestamp() >= job.leaseExpiresAt);
    if (!expired.length) return;
    for (const job of expired) {
      if (job.status !== "cancelled") { job.status = "interrupted"; job.errorCode = "COLLECTOR_LEASE_EXPIRED"; }
      job.leaseReleasedAt = job.finishedAt = job.updatedAt = iso();
      releasePrivateInput(job);
    }
    setHalt("COLLECTOR_LEASE_EXPIRED");
    await persist();
  }
  async function ensureReady() { if (!ready) await initialize(); }
  async function notifyProvider(event) {
    if (!event || !options.onProviderBlocked) return;
    // Callbacks may halt another broker or inspect this one; never call under locked().
    // Mark delivery only after success so a lost callback can be retried by a later
    // heartbeat, failure receipt, or idempotent completion handshake.
    await options.onProviderBlocked(event);
    await locked(async () => { const job = await jobById(event.id); job.providerNotifiedAt = iso(); await persist(); });
  }
  async function initialize() {
    if (initialization) return initialization;
    initialization = locked(async () => {
      await checkedDirectory(dataDir, true);
      await checkedDirectory(brokerDir, true);
      await checkedDirectory(stagingDir, true);
      await checkedDirectory(receiptsDir, true);
      await checkedDirectory(outputsDir, true);
      if (await exists(stateFile)) {
        try {
          await regularFile(stateFile);
          const parsed = JSON.parse(await fsp.readFile(stateFile, "utf8"));
          if (parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.some(job => !/^collector_[a-f0-9-]{36}$/.test(job.id || "") || !ALL_STATUSES.has(job.status))
            || new Set(parsed.jobs.map(job => job.id)).size !== parsed.jobs.length) throw new Error();
          state = parsed;
        } catch { throw problem("COLLECTOR_STATE_INVALID", 503); }
        const openJobs = state.jobs.filter(job => !TERMINAL.has(job.status) || ownsLease(job));
        for (const job of openJobs) {
          // Publication may have succeeded just before the receipt write failed.
          // Reconcile only its already-validated immutable files, never rerun work.
          let recovered = false;
          if (job.status === "committing" && job.completion && job.outputDir === path.join(outputsDir, runIdentifier(job.runId))) {
            try {
              await validateFiles(job.outputDir, job.completion.publishedFiles);
              job.manifest = JSON.parse(await fsp.readFile(path.join(job.outputDir, "manifest.json"), "utf8"));
              job.collectionQuality = inspectManifest(job.manifest);
              job.status = "completed";
              recovered = true;
            } catch { /* The original remains for explicit operator review. */ }
          }
          if (!recovered && job.status !== "cancelled") { job.status = "interrupted"; job.errorCode = "COLLECTOR_RESTART_INTERRUPTED"; }
          job.finishedAt = job.updatedAt = job.leaseReleasedAt = iso();
          releasePrivateInput(job);
        }
        if (openJobs.length) setHalt("COLLECTOR_RESTART_INTERRUPTED");
      }
      await persist();
      ready = true;
    });
    return initialization;
  }
  async function submit(input = {}) {
    await ensureReady();
    return locked(async () => {
      if (!configured) throw problem("COLLECTOR_DISABLED", 503);
      await expireLeases();
      if (state.halted) throw problem(state.halted.code, 503);
      const keyword = String(input.keyword || "").trim();
      if (!keyword || keyword.length > 200 || /[\x00-\x1f]/.test(keyword)) throw problem("COLLECTOR_INVALID_KEYWORD", 400);
      const job = { id: `collector_${crypto.randomUUID()}`, status: "queued", keyword, env: cleanEnv(input.env), payload: cleanPayload(input.payload),
        context: cleanContext(input.context), createdAt: iso(), updatedAt: iso(), uploads: {} };
      const target = job.payload.workerKey || workerKey;
      const trigger = job.payload.trigger || (job.env.SCHEDULED_COLLECTION === "1" || job.payload.scheduledCollection === true ? "scheduled" : "manual");
      if ((target && !["manual", "scheduled"].includes(target)) || !["manual", "scheduled"].includes(trigger)
        || (workerKey && target !== workerKey)
        || (job.payload.trigger && job.env.SCHEDULED_COLLECTION !== undefined && (job.env.SCHEDULED_COLLECTION === "1") !== (trigger === "scheduled"))) {
        throw problem("COLLECTOR_WRONG_WORKER", 400);
      }
      if (input.queueDeadline !== undefined) {
        if (trigger !== "scheduled" || !Number.isSafeInteger(input.queueDeadline) || input.queueDeadline <= 0) throw problem("COLLECTOR_QUEUE_DEADLINE_INVALID", 400);
        job.queueDeadline = input.queueDeadline;
      }
      if (target) {
        job.workerKey = target;
        job.trigger = trigger;
        job.payload.workerKey = target;
        job.payload.trigger = trigger;
        job.env.COLLECTOR_WORKER_KEY = target;
        job.env.COLLECTOR_TRIGGER = trigger;
        job.env.COLLECTOR_JOB_ID = job.id;
        job.env.COLLECTOR_RUN_TOKEN = [...crypto.randomBytes(12).toString("hex")].map(character => String.fromCharCode(97 + parseInt(character, 16))).join("");
        job.env.COLLECTOR_ENGINE = target === "scheduled" ? "archive-keyword-adapted-v2" : "current-manual-v2";
        job.env.SCHEDULED_COLLECTION = trigger === "scheduled" ? "1" : "0";
        job.payload.scheduledCollection = trigger === "scheduled";
      }
      state.jobs.push(job);
      await persist();
      return publicJob(job);
    });
  }
  async function getJob(id) {
    await ensureReady();
    return locked(async () => { await expireLeases(); return publicJob(await jobById(id)); });
  }
  async function status() {
    await ensureReady();
    return locked(async () => {
      await expireLeases();
      return { configured, workerKey, halted: Boolean(state.halted), errorCode: state.halted?.code || "", ...(state.halted?.failurePhase ? {failurePhase:state.halted.failurePhase} : {}), ...(state.halted?.brokerErrorCode ? {brokerErrorCode:state.halted.brokerErrorCode} : {}), activeJobId: state.jobs.find(ownsLease)?.id || null,
        queued: state.jobs.filter(job => job.status === "queued").length, workerLastSeenAt: state.workerLastSeenAt || null };
    });
  }
  async function halt(code, { cancelActive = false, cancelQueued = false, exceptJobId = null } = {}) {
    await ensureReady();
    return locked(async () => {
      setHalt(errorCode(code, "COLLECTOR_HALTED"));
      for (const job of state.jobs) {
        if (job.id === exceptJobId || TERMINAL.has(job.status)) continue;
        if ((job.status === "queued" && cancelQueued) || (ownsLease(job) && cancelActive)) {
          job.status = "cancelled";
          job.errorCode = state.halted.code;
          job.finishedAt = job.updatedAt = iso();
          releasePrivateInput(job);
          // Keep a running lease until its worker acknowledges stopping or it expires.
        }
      }
      await persist();
      return { halted: true, errorCode: state.halted.code };
    });
  }
  async function resetHalt() {
    await ensureReady();
    return locked(async () => {
      await expireLeases();
      if (state.jobs.some(job => ownsLease(job) || !TERMINAL.has(job.status))) throw problem("COLLECTOR_PENDING_JOBS");
      state.halted = null;
      await persist();
      return { halted: false, errorCode: "" };
    });
  }
  async function cancel(id) {
    await ensureReady();
    return locked(async () => {
      await expireLeases();
      const job = await jobById(id);
      if (!TERMINAL.has(job.status)) {
        job.status = "cancelled";
        job.errorCode = "COLLECTOR_CANCELLED";
        job.finishedAt = job.updatedAt = iso();
        releasePrivateInput(job);
        await persist();
      }
      return publicJob(job);
    });
  }
  async function cancelQueued(id,code="COLLECTOR_SCHEDULE_PAUSED") {
    await ensureReady();
    return locked(async()=>{
      const job=await jobById(id);
      if(job.status==="queued") {
        job.status="cancelled";job.errorCode=errorCode(code,"COLLECTOR_SCHEDULE_PAUSED");
        job.finishedAt=job.updatedAt=iso();releasePrivateInput(job);await persist();
      }
      return publicJob(job);
    });
  }
  function workerIdentity(value) { if (value !== workerId) throw problem("COLLECTOR_WRONG_WORKER", 403); }
  function checkLease(job, identity, leaseToken, allowTerminal = false) {
    workerIdentity(identity);
    if (typeof leaseToken !== "string" || !sameSecret(digest(leaseToken), job.leaseHash)) throw problem("COLLECTOR_LEASE_MISMATCH");
    if (!allowTerminal && (!ownsLease(job) || !["leased", "cancelled"].includes(job.status))) throw problem("COLLECTOR_LEASE_INACTIVE");
  }
  async function claim(body) {
    return locked(async () => {
      workerIdentity(body.workerId);
      if (body.workerKey !== undefined && body.workerKey !== workerKey) throw problem("COLLECTOR_WRONG_WORKER", 403);
      if (body.protocolVersion !== 1) throw problem("COLLECTOR_PROTOCOL_MISMATCH", 400);
      await expireLeases();
      state.workerLastSeenAt = iso();
      if (state.halted || state.jobs.some(ownsLease)) {
        if (timestamp() - lastSeenPersistedAt >= 60_000) await persist();
        return { job: null };
      }
      const job = state.jobs.find(entry => entry.status === "queued");
      if (!job) {
        if (timestamp() - lastSeenPersistedAt >= 60_000) await persist();
        return { job: null };
      }
      const leaseToken = crypto.randomBytes(32).toString("hex");
      job.leaseHash = digest(leaseToken);
      job.leaseExpiresAt = timestamp() + LEASE_MS;
      job.startedAt = job.updatedAt = iso();
      job.status = "leased";
      await checkedDirectory(path.join(stagingDir, job.id), true);
      await persist();
      return { job: { id: job.id, keyword: job.keyword, env: clone(job.env), context: clone(job.context), leaseToken, leaseMs: LEASE_MS,
        ...(job.workerKey ? { workerKey: job.workerKey, trigger: job.trigger } : {}) } };
    });
  }
  async function heartbeat(id, body) {
    let event, providerEvent;
    const result = await locked(async () => {
      await expireLeases();
      const job = await jobById(id);
      checkLease(job, body.workerId, body.leaseToken);
      if (body.stage !== undefined && !STAGES.has(body.stage)) throw problem("COLLECTOR_INVALID_STAGE", 400);
      if (body.providerBlocked !== undefined && typeof body.providerBlocked !== "boolean") throw problem("COLLECTOR_INVALID_STAGE", 400);
      const progress = body.progress === undefined ? null : sanitizeCollectionProgress(body.progress);
      if (body.progress !== undefined && !progress) throw problem("COLLECTOR_INVALID_PROGRESS", 400);
      job.leaseExpiresAt = timestamp() + LEASE_MS;
      state.workerLastSeenAt = job.updatedAt = iso();
      if (body.stage && job.stage !== body.stage) { job.stage = body.stage; event = { id, stage: body.stage }; }
      const previous = job.progress;
      if (progress && Date.parse(progress.updatedAt) <= timestamp() + 30000
        && (!previous || (progress.totalPlaces === previous.totalPlaces && progress.completedPlaces >= previous.completedPlaces && progress.updatedAt >= previous.updatedAt))
        && JSON.stringify(progress) !== JSON.stringify(previous)) {
        job.progress = progress;
        job.progressReceivedAt = iso();
        event = { ...event, id, progress: clone(progress), progressReceivedAt: job.progressReceivedAt };
      }
      if (body.providerBlocked === true && !job.providerBlockedAt) {
        job.providerBlockedAt = iso();
        state.halted = { code: "COLLECTOR_PROVIDER_BLOCKED", at: iso() };
      }
      if (job.providerBlockedAt && !job.providerNotifiedAt) {
        providerEvent = { id, workerKey, code: "COLLECTOR_PROVIDER_BLOCKED" };
      }
      await persist();
      return { cancelled: job.status === "cancelled" };
    });
    if (event && options.onProgress) { try { await options.onProgress(event); } catch { /* Progress display cannot invalidate the receipt. */ } }
    await notifyProvider(providerEvent);
    return result;
  }
  async function upload(id, relative, req) {
    const name = relativeFile(relative);
    const lengthHeader = req.headers["content-length"];
    const size = Number(lengthHeader);
    const sha256 = req.headers["x-content-sha256"];
    if (typeof lengthHeader !== "string" || !/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw problem("COLLECTOR_FILE_TOO_LARGE", 413);
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw problem("COLLECTOR_INVALID_FILE_HASH", 400);
    const reservation = `${id}/${name.toLowerCase()}`;
    let target;
    let temporary;
    let reserved = false;
    try {
      await locked(async () => {
        await expireLeases();
        const job = await jobById(id);
        checkLease(job, req.headers["x-collector-worker"], req.headers["x-collector-lease"]);
        if (job.status === "cancelled") throw problem("COLLECTOR_CANCELLED");
        if (uploading.has(reservation)) throw problem("COLLECTOR_UPLOAD_IN_PROGRESS");
        const match = Object.keys(job.uploads).find(file => file.toLowerCase() === name.toLowerCase());
        if (match && match !== name) throw problem("COLLECTOR_DUPLICATE_PATH", 400);
        if (match && (job.uploads[match].size !== size || job.uploads[match].sha256 !== sha256)) throw problem("COLLECTOR_UPLOAD_CONFLICT");
        const reservedBytes = [...uploading.values()].filter(entry => entry.id === id).reduce((sum, entry) => sum + entry.size, 0);
        const existingBytes = Object.values(job.uploads).reduce((sum, entry) => sum + entry.size, 0);
        if (existingBytes + reservedBytes + (match ? 0 : size) > MAX_RUN_BYTES) throw problem("COLLECTOR_RUN_TOO_LARGE", 413);
        if (!match && Object.keys(job.uploads).length + [...uploading.values()].filter(entry => entry.id === id).length >= MAX_FILES) throw problem("COLLECTOR_TOO_MANY_FILES", 413);
        uploading.set(reservation, { id, size: match ? 0 : size });
        reserved = true;
        const base = path.join(stagingDir, id);
        target = path.join(base, ...name.split("/"));
        if (!inside(base, target)) throw problem("COLLECTOR_INVALID_PATH", 400);
        let parent = base;
        await checkedDirectory(parent);
        const segments = name.split("/");
        for (let index = 0; index < segments.length; index++) {
          const segment = segments[index];
          const names = await fsp.readdir(parent);
          if (names.some(existing => existing.toLowerCase() === segment.toLowerCase() && existing !== segment)) throw problem("COLLECTOR_DUPLICATE_PATH", 400);
          if (index < segments.length - 1) { parent = path.join(parent, segment); await checkedDirectory(parent, true); }
        }
        temporary = `${target}.${crypto.randomUUID()}.upload`;
      });
      const hash = crypto.createHash("sha256");
      const handle = await fsp.open(temporary, "wx", 0o600);
      let bytes = 0;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > size || bytes > MAX_FILE_BYTES) throw problem("COLLECTOR_FILE_LENGTH_MISMATCH", 400);
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        if (bytes !== size) throw problem("COLLECTOR_FILE_LENGTH_MISMATCH", 400);
        if (hash.digest("hex") !== sha256) throw problem("COLLECTOR_FILE_HASH_MISMATCH", 400);
        await handle.sync();
      } finally { await handle.close(); }
      return await locked(async () => {
        await expireLeases();
        const job = await jobById(id);
        checkLease(job, req.headers["x-collector-worker"], req.headers["x-collector-lease"]);
        if (job.status === "cancelled") throw problem("COLLECTOR_CANCELLED");
        await checkedDirectory(path.dirname(target));
        if (await exists(target)) {
          if (!job.uploads[name] || (await regularFile(target)).size !== size || await fileHash(target) !== sha256) throw problem("COLLECTOR_UPLOAD_CONFLICT");
        } else await fsp.rename(temporary, target);
        job.uploads[name] = { path: name, size, sha256 };
        job.updatedAt = iso();
        await persist();
        return { ok: true };
      });
    } finally {
      if (temporary) await fsp.unlink(temporary).catch(() => {});
      if (reserved) await locked(async () => { uploading.delete(reservation); });
    }
  }
  async function complete(id, body) {
    let providerEvent;
    const result = await locked(async () => {
      await expireLeases();
      const job = await jobById(id);
      checkLease(job, body.workerId, body.leaseToken, true);
      const runId = runIdentifier(body.runId);
      const files = descriptors(body.files);
      const key = descriptorKey(files);
      if (job.status === "completed") {
        if (job.runId !== runId || job.completion?.descriptorKey !== key) throw problem("COLLECTOR_COMPLETION_CONFLICT");
        if (job.providerBlockedAt && !job.providerNotifiedAt) providerEvent = { id, workerKey, code: "COLLECTOR_PROVIDER_BLOCKED" };
        return { ok: true };
      }
      checkLease(job, body.workerId, body.leaseToken);
      if (job.status === "cancelled") {
        job.leaseReleasedAt = job.updatedAt = iso();
        setHalt("COLLECTOR_CANCELLED");
        await persist();
        return { ok: true, cancelled: true };
      }
      if ([...uploading.values()].some(entry => entry.id === id)) throw problem("COLLECTOR_UPLOAD_IN_PROGRESS");
      if (descriptorKey(descriptors(Object.values(job.uploads))) !== key) throw problem("COLLECTOR_FILE_SET_MISMATCH", 400);
      const base = path.join(stagingDir, id);
      await validateFiles(base, files);
      const manifestPath = path.join(base, "manifest.json");
      if ((await regularFile(manifestPath)).size > MAX_JSON_BYTES) throw problem("COLLECTOR_MANIFEST_TOO_LARGE", 413);
      let manifest;
      try { manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")); } catch { throw problem("COLLECTOR_INVALID_MANIFEST", 400); }
      scopeCheck(manifest, job, runId, files);
      await checkedDirectory(outputsDir);
      if ((await fsp.readdir(outputsDir)).some(name => name.toLowerCase() === runId.toLowerCase())) throw problem("COLLECTOR_OUTPUT_EXISTS");
      const outputDir = path.join(outputsDir, runId);
      manifest.outputDir = outputDir;
      const quality = inspectManifest(manifest);
      if (job.providerBlockedAt && quality.status !== "blocked") throw problem("COLLECTOR_BLOCK_RECEIPT_REQUIRED", 400);
      await atomicJson(manifestPath, manifest);
      const publishedFiles = files.map(file => ({ ...file }));
      const manifestEntry = publishedFiles.find(file => file.path === "manifest.json");
      manifestEntry.size = (await regularFile(manifestPath)).size;
      manifestEntry.sha256 = await fileHash(manifestPath);
      job.status = "committing";
      job.runId = runId;
      job.outputDir = outputDir;
      job.completion = { descriptorKey: key, publishedFiles };
      job.updatedAt = iso();
      await persist();
      // Exclusive publication lock prevents other broker instances from replacing
      // the same run; preexisting destinations are always rejected.
      const publishLock = path.join(outputsDir, `.collector-${runId}.lock`);
      let lock;
      try {
        lock = await fsp.open(publishLock, "wx", 0o600);
        if (await exists(outputDir)) throw problem("COLLECTOR_OUTPUT_EXISTS");
        await fsp.rename(base, outputDir);
        job.status = "completed";
        job.manifest = manifest;
        job.collectionQuality = quality;
        job.finishedAt = job.updatedAt = job.leaseReleasedAt = iso();
        releasePrivateInput(job);
        if (quality.status === "blocked" || manifest.collectionFailed === true) {
          setHalt(quality.status === "blocked" ? "COLLECTOR_PROVIDER_BLOCKED" : "COLLECTOR_CRAWL_FAILED");
          if (quality.status === "blocked" && !job.providerNotifiedAt) {
            job.providerBlockedAt ||= iso();
            providerEvent = { id, workerKey, code: "COLLECTOR_PROVIDER_BLOCKED" };
          }
        }
        await persist();
      } catch (error) {
        setHalt("COLLECTOR_PUBLICATION_FAILED");
        await persist().catch(() => {});
        throw problem(error.code === "COLLECTOR_OUTPUT_EXISTS" ? error.code : "COLLECTOR_PUBLICATION_FAILED", 503);
      } finally {
        await lock?.close().catch(() => {});
        if (lock) await fsp.unlink(publishLock).catch(() => {});
      }
      return { ok: true };
    });
    await notifyProvider(providerEvent);
    return result;
  }
  async function fail(id, body) {
    let providerEvent;
    const result = await locked(async () => {
      await expireLeases();
      const job = await jobById(id);
      checkLease(job, body.workerId, body.leaseToken, true);
      if (job.providerBlockedAt && !job.providerNotifiedAt) providerEvent = { id, workerKey, code: "COLLECTOR_PROVIDER_BLOCKED" };
      if (job.status === "failed" && job.errorCode === errorCode(body.code)) return { ok: true };
      if (job.status === "cancelled" && job.leaseReleasedAt) return { ok: true };
      checkLease(job, body.workerId, body.leaseToken);
      if (job.status !== "cancelled") { job.status = "failed"; job.errorCode = errorCode(body.code); }
      if (["file_upload", "final_validation"].includes(body.failurePhase)) job.failurePhase = body.failurePhase;
      if (require("./collector_worker.cjs").BROKER_FAILURE_CODES?.has(body.brokerErrorCode)) job.brokerErrorCode = body.brokerErrorCode;
      job.finishedAt = job.updatedAt = job.leaseReleasedAt = iso();
      releasePrivateInput(job);
      // An explicit failed execution is never permission to start the next one.
      // This also protects failures before a complete artifact receipt exists.
      setHalt(job.errorCode);
      if(state.halted?.code===job.errorCode) {
        if(job.failurePhase)state.halted.failurePhase=job.failurePhase;
        if(job.brokerErrorCode)state.halted.brokerErrorCode=job.brokerErrorCode;
      }
      await persist();
      return { ok: true };
    });
    await notifyProvider(providerEvent);
    return result;
  }
  async function handleHttp(req, res, inputUrl) {
    const url = inputUrl instanceof URL ? inputUrl : new URL(inputUrl || req.url, "http://collector.invalid");
    if (url.pathname !== apiBasePath && !url.pathname.startsWith(`${apiBasePath}/`)) return false;
    if (!configured) { req.resume?.(); send(res, 404, { error: "not_found" }); return true; }
    const authorization = req.headers?.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || !sameSecret(authorization.slice(7), token)) {
      req.resume?.(); send(res, 401, { error: "COLLECTOR_UNAUTHORIZED" }); return true;
    }
    try {
      await ensureReady();
      let result;
      if (req.method === "POST" && url.pathname === `${apiBasePath}/claim`) result = await claim(await readJsonRequest(req));
      else {
        const match = /^\/jobs\/(collector_[a-f0-9-]{36})\/(heartbeat|files|complete|fail)$/.exec(url.pathname.slice(apiBasePath.length));
        if (!match) throw problem("COLLECTOR_ROUTE_NOT_FOUND", 404);
        const [, id, action] = match;
        if (action === "files" && req.method === "PUT") {
          if (url.searchParams.getAll("path").length !== 1) throw problem("COLLECTOR_INVALID_PATH", 400);
          result = await upload(id, url.searchParams.get("path"), req);
        } else if (req.method === "POST" && action !== "files") {
          const body = await readJsonRequest(req);
          if (action === "heartbeat") result = await heartbeat(id, body);
          else if (action === "complete") result = await complete(id, body);
          else result = await fail(id, body);
        } else throw problem("COLLECTOR_METHOD_NOT_ALLOWED", 405);
      }
      send(res, 200, result);
    } catch (error) {
      req.resume?.();
      if (!res.headersSent) send(res, error.statusCode || 500, { error: errorCode(error.code, "COLLECTOR_INTERNAL_ERROR") });
    }
    return true;
  }
  // Explicit administrator recovery only. Never re-lease a failed job or issue provider requests.
  async function recover(id, input = {}) {
    await ensureReady();
    return locked(async () => {
      await expireLeases();
      if (state.jobs.some(job => !TERMINAL.has(job.status) || ownsLease(job)) || uploading.size) throw problem("COLLECTOR_RECOVERY_BUSY");
      const job = await jobById(id);
      if (job.status !== "failed" || job.errorCode !== "COLLECTOR_UPLOAD_FAILED" || !job.leaseReleasedAt || job.providerBlockedAt
        || state.halted?.code === "COLLECTOR_PROVIDER_BLOCKED") throw problem("COLLECTOR_RECOVERY_NOT_ELIGIBLE");
      const files = descriptors(Object.values(job.uploads || {}));
      const original = files.find(file => file.path === "manifest.json");
      if (!original || original.sha256 !== input.manifestSha256) throw problem("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
      const base = path.join(stagingDir, id);
      await validateFiles(base, files);
      if (original.size > MAX_JSON_BYTES) throw problem("COLLECTOR_MANIFEST_TOO_LARGE",413);
      const manifest = JSON.parse(await fsp.readFile(path.join(base, "manifest.json"), "utf8"));
      const expected = cleanPayload(input.expected);
      for (const key of ["keyword", "checkIn", "checkOut", "adults", "searchMode", "searchIntent", "searchRegion", "searchScope", "collectionMode", "collectionPurpose", "productMode", "detailRankRanges", "bookingRangeDays", "bookingRangePlaceLimit", "sourceRole", "collectionSource", "workerKey", "trigger", "scheduledCollection"]) {
        if (expected[key] === undefined) throw problem("COLLECTOR_RECOVERY_SCOPE_REQUIRED", 400);
      }
      if (expected.workerKey !== job.workerKey || expected.trigger !== job.trigger || expected.keyword !== job.keyword) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
      const normalized = clone(manifest);
      const unique = new Map();
      let duplicateReferences = 0;
      for (const entry of normalized.detailJsonFiles || []) {
        const name = relativeFile(entry.file);
        if (unique.has(name)) {
          const prior = unique.get(name);
          if (["field", "placeId", "bookingBusinessId", "itemCount", "originalLength"].some(key => prior[key] !== entry[key])) throw problem("COLLECTOR_RECOVERY_REFERENCE_CONFLICT");
          duplicateReferences++;
        } else unique.set(name, entry);
      }
      if (!duplicateReferences) throw problem("COLLECTOR_RECOVERY_NO_DUPLICATES");
      normalized.detailJsonFiles = [...unique.values()];
      if (normalized.counts) normalized.counts.detailJsonFiles = unique.size;
      const runId = runIdentifier(path.basename(String(manifest.outputDir || "")));
      const scopeJob = {...job, payload: expected, env: {
        COLLECTOR_ENGINE: job.workerKey === "scheduled" ? "archive-keyword-adapted-v2" : "current-manual-v2",
        COLLECTOR_RUN_TOKEN: manifest.collectorRunToken
      }};
      if (!/^[a-p]{24}$/.test(manifest.collectorRunToken || "")) throw problem("COLLECTOR_SCOPE_MISMATCH", 400);
      scopeCheck(normalized, scopeJob, runId, files);
      const quality = inspectManifest(normalized, expected);
      if (quality.status !== "complete") throw problem("COLLECTOR_RECOVERY_QUALITY_HOLD");
      const outputDir = path.join(outputsDir, runId);
      await checkedDirectory(outputsDir);
      if ((await fsp.readdir(outputsDir)).some(name=>name.toLowerCase()===runId.toLowerCase() && name!==runId)) throw problem("COLLECTOR_OUTPUT_EXISTS");
      const recoveryRoot = path.join(brokerDir, "recovery", id);
      await checkedDirectory(recoveryRoot, true);
      const sourceReceipt = path.join(recoveryRoot, "source.json");
      const sourceRecord = {version:1, jobId:id, originalStatus:job.status, originalErrorCode:job.errorCode, originalFinishedAt:job.finishedAt, manifestSha256:original.sha256, files};
      if (!await exists(sourceReceipt)) await fsp.writeFile(sourceReceipt, JSON.stringify(sourceRecord), {flag:"wx", mode:0o600});
      else {
        await regularFile(sourceReceipt);
        if (await fsp.readFile(sourceReceipt,"utf8") !== JSON.stringify(sourceRecord)) throw problem("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
      }
      let published;
      if (await exists(outputDir)) {
        await checkedDirectory(outputDir);
        await regularFile(path.join(outputDir,"manifest.json"));
        published = JSON.parse(await fsp.readFile(path.join(outputDir, "manifest.json"), "utf8"));
        const proof = published.recovery;
        if (proof?.jobId !== id || proof?.originalManifestSha256 !== original.sha256) throw problem("COLLECTOR_OUTPUT_EXISTS");
        normalized.outputDir = outputDir;
        normalized.collectionQuality = quality;
        normalized.recovery = proof;
        if (JSON.stringify(normalized) !== JSON.stringify(published)) throw problem("COLLECTOR_RECOVERY_SOURCE_MISMATCH");
      } else {
        const disk = await fsp.statfs(dataDir);
        if (Number(disk.bavail) * Number(disk.bsize) < files.reduce((sum,file)=>sum+file.size,0) + 200*1024*1024) throw problem("COLLECTOR_DISK_LOW");
        normalized.outputDir = outputDir;
        normalized.collectionQuality = quality;
        normalized.recovery = {version:1, jobId:id, recoveredAt:iso(), method:"deduplicate-detail-file-references", scopeVerification:"administrator-reviewed", originalManifestSha256:original.sha256, duplicateReferences};
        const candidate = path.join(recoveryRoot, `candidate-${crypto.randomUUID()}`);
        await checkedDirectory(candidate, true);
        for (const file of files) {
          const target = path.join(candidate, ...file.path.split("/"));
          await checkedDirectory(path.dirname(target), true);
          await fsp.copyFile(path.join(base, ...file.path.split("/")), target, fs.constants.COPYFILE_EXCL);
        }
        await atomicJson(path.join(candidate,"manifest.json"), normalized);
        const candidateFiles = files.map(file=>({...file}));
        const candidateManifest = candidateFiles.find(file=>file.path==="manifest.json");
        candidateManifest.size = (await regularFile(path.join(candidate,"manifest.json"))).size;
        candidateManifest.sha256 = await fileHash(path.join(candidate,"manifest.json"));
        await validateFiles(candidate,candidateFiles);
        const lockPath = path.join(outputsDir, `.collector-${runId}.lock`);
        let publicationLock;
        try {
          publicationLock = await fsp.open(lockPath,"wx",0o600);
          if (await exists(outputDir)) throw problem("COLLECTOR_OUTPUT_EXISTS");
          await fsp.rename(candidate,outputDir);
        } finally {
          await publicationLock?.close().catch(()=>{});
          if (publicationLock) await fsp.unlink(lockPath).catch(()=>{});
        }
        published = normalized;
      }
      const publishedFiles = files.map(file=>({...file}));
      const manifestFile = publishedFiles.find(file=>file.path === "manifest.json");
      manifestFile.size = (await regularFile(path.join(outputDir,"manifest.json"))).size;
      manifestFile.sha256 = await fileHash(path.join(outputDir,"manifest.json"));
      await validateFiles(outputDir,publishedFiles);
      job.recovery = {runId, ...published.recovery};
      if (!state.jobs.includes(job)) await atomicJson(path.join(receiptsDir,`${id}.json`),job);
      await persist();
      return {runId,outputDir,manifest:published,collectionQuality:quality,recovery:clone(job.recovery)};
    });
  }
  return { initialize, submit, getJob, cancel, cancelQueued, status, halt, resetHalt, recover, handleHttp };
}

module.exports = { createCollectorBroker, LEASE_MS, MAX_FILE_BYTES, MAX_RUN_BYTES };
