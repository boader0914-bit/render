"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = 1;
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const DAY_MS = 86400000;
const GRACE_MS = 5 * 60 * 1000;
const STATES = new Set(["queued", "running", "complete", "reused", "partial", "failed", "blocked", "interrupted", "missed"]);
const TERMINAL = new Set([...STATES].filter(value => !["queued", "running"].includes(value)));
const RECEIPT_ID = /^(?:scheduled_\d{4}-\d{2}-\d{2}|manual_[a-f0-9]{32,64})$/;

function fault(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
function object(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function keysOnly(value, keys, error) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw fault(error);
}
function date(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "2000-01-01" && value <= "2099-12-31"
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dateKey(value) {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw fault("KEYWORD_SCHEDULE_TIME_INVALID");
  return new Date(instant.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function addDays(day, count) { return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10); }
function scheduledAt(day, time) { return new Date(`${day}T${time}:00+09:00`).toISOString(); }
function uniqueKeywords(value) {
  if (!Array.isArray(value) || value.length > 100) throw fault("KEYWORD_SCHEDULE_KEYWORDS_INVALID");
  const found = new Set();
  const output = [];
  for (const input of value) {
    if (typeof input !== "string") throw fault("KEYWORD_SCHEDULE_KEYWORDS_INVALID");
    const keyword = input.normalize("NFKC").trim();
    if (!keyword || keyword.length > 160 || /[\x00-\x1f\x7f]/.test(keyword)) throw fault("KEYWORD_SCHEDULE_KEYWORDS_INVALID");
    // Only normalize Unicode and outside whitespace: internal spaces can change search intent.
    if (!found.has(keyword)) { found.add(keyword); output.push(keyword); }
  }
  return output;
}
function rankRange(value) {
  if (typeof value !== "string" || value.length > 150 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw fault("KEYWORD_SCHEDULE_RANK_INVALID");
  const ranks = new Set();
  for (const range of value.split(",")) {
    const [first, last = first] = range.split("-").map(Number);
    if (first < 1 || last > 100 || first > last) throw fault("KEYWORD_SCHEDULE_RANK_INVALID");
    for (let rank = first; rank <= last; rank += 1) ranks.add(rank);
  }
  return { value, max: Math.max(...ranks), count: ranks.size };
}
function validatePacing(value) {
  if (value === null) return null;
  const fields = ["enabled", "minIntervalMs", "maxConcurrentRequests", "detailConcurrency", "scheduleConcurrency", "otaConcurrency"];
  keysOnly(value, fields, "KEYWORD_SCHEDULE_PACING_INVALID");
  if (typeof value.enabled !== "boolean") throw fault("KEYWORD_SCHEDULE_PACING_INVALID");
  const result = { enabled: value.enabled };
  for (const key of fields.slice(1)) {
    if (value[key] === undefined) continue;
    const min = key === "minIntervalMs" ? 0 : 1;
    const max = key === "minIntervalMs" ? 60000 : 8;
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) throw fault("KEYWORD_SCHEDULE_PACING_INVALID");
    result[key] = value[key];
  }
  if (value.enabled && (result.minIntervalMs === undefined || result.maxConcurrentRequests === undefined)) throw fault("KEYWORD_SCHEDULE_PACING_INVALID");
  return result;
}
function defaultConfig(at = new Date()) {
  return { version: VERSION, enabled: false, timezone: "Asia/Seoul", repeat: "daily", firstDate: dateKey(at), time: "14:00", keywords: [],
    collection: { dateMode: "rolling", bookingDays: 31, checkIn: null, checkOut: null, adults: 2, detailRankRanges: "1-20",
      productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail" }, requestPacing: null };
}
function validateConfig(value) {
  keysOnly(value, ["version", "enabled", "timezone", "repeat", "firstDate", "time", "keywords", "collection", "requestPacing"], "KEYWORD_SCHEDULE_CONFIG_INVALID");
  if (value.version !== VERSION || typeof value.enabled !== "boolean" || value.timezone !== "Asia/Seoul"
    || !["once", "daily", "weekdays"].includes(value.repeat) || !date(value.firstDate)
    || typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw fault("KEYWORD_SCHEDULE_CONFIG_INVALID");
  const input = value.collection;
  keysOnly(input, ["dateMode", "bookingDays", "checkIn", "checkOut", "adults", "detailRankRanges", "productMode", "collectionMode", "collectionPurpose"], "KEYWORD_SCHEDULE_COLLECTION_INVALID");
  if (!["rolling", "fixed"].includes(input.dateMode) || !Number.isSafeInteger(input.bookingDays) || input.bookingDays < 1 || input.bookingDays > 31
    || !Number.isSafeInteger(input.adults) || input.adults < 1 || input.adults > 30 || input.productMode !== "all"
    || input.collectionMode !== "precision" || input.collectionPurpose !== "revenue_detail") throw fault("KEYWORD_SCHEDULE_COLLECTION_INVALID");
  rankRange(input.detailRankRanges);
  const collection = clone(input);
  if (input.dateMode === "fixed") {
    // Fixed checkOut is the final observed accommodation date (inclusive), not a stay's departure date.
    if (!date(input.checkIn) || !date(input.checkOut) || input.checkOut < input.checkIn) throw fault("KEYWORD_SCHEDULE_DATE_INVALID");
    const days = Math.round((Date.parse(input.checkOut) - Date.parse(input.checkIn)) / DAY_MS) + 1;
    if (days > 31 || days !== input.bookingDays) throw fault("KEYWORD_SCHEDULE_DATE_INVALID");
  } else {
    if (input.checkIn !== null || input.checkOut !== null) throw fault("KEYWORD_SCHEDULE_DATE_INVALID");
  }
  return { version: VERSION, enabled: value.enabled, timezone: "Asia/Seoul", repeat: value.repeat, firstDate: value.firstDate, time: value.time,
    keywords: uniqueKeywords(value.keywords), collection, requestPacing: validatePacing(value.requestPacing) };
}
function eligible(config, day) {
  if (day < config.firstDate || (config.repeat === "once" && day !== config.firstDate)) return false;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return config.repeat !== "weekdays" || (weekday >= 1 && weekday <= 5);
}
function scheduleExpiry(config, at) {
  const today = dateKey(at);
  if (config.collection.dateMode === "fixed"
    && (config.collection.checkIn < today || config.firstDate > config.collection.checkIn)) {
    return "KEYWORD_SCHEDULE_DATE_EXPIRED";
  }
  if (config.repeat === "once" && Date.parse(scheduledAt(config.firstDate, config.time)) + GRACE_MS < at.getTime()) {
    return "KEYWORD_SCHEDULE_TIME_EXPIRED";
  }
  if (config.collection.dateMode === "fixed") {
    const firstPossibleDay = config.firstDate > today ? config.firstDate : today;
    // Daily/weekday/once rules always reveal their next possible execution
    // within a week; a fixed arrival must still be valid on that execution day.
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = addDays(firstPossibleDay, offset);
      if (day > config.collection.checkIn) break;
      if (eligible(config, day) && Date.parse(scheduledAt(day, config.time)) + GRACE_MS >= at.getTime()) return null;
    }
    return "KEYWORD_SCHEDULE_DATE_EXPIRED";
  }
  return null;
}
function previewSchedule(config, at, taken) {
  if (scheduleExpiry(config, at)) return null;
  const today = dateKey(at);
  const firstPossibleDay = config.firstDate > today ? config.firstDate : today;
  for (let offset = 0; offset <= 370; offset += 1) {
    const day = addDays(firstPossibleDay, offset);
    // An unchanged fixed arrival date is unusable after that date, even though
    // its final observation date can still be in the future.
    if (config.collection.dateMode === "fixed" && day > config.collection.checkIn) break;
    if (!eligible(config, day) || taken.has(day)) continue;
    const due = scheduledAt(day, config.time);
    if (Date.parse(due) + GRACE_MS < at.getTime()) continue;
    return due;
  }
  return null;
}
function payloadFor(config, keyword, day, occurrenceId, index, trigger) {
  const collection = config.collection;
  const checkIn = collection.dateMode === "fixed" ? collection.checkIn : day;
  const lastDate = collection.dateMode === "fixed" ? collection.checkOut : addDays(day, collection.bookingDays - 1);
  const payload = { keyword, workerKey: "scheduled", trigger, scheduledCollection: trigger === "scheduled",
    searchMode: "keyword", checkIn, checkOut: collection.bookingDays === 1 ? addDays(checkIn, 1) : lastDate,
    adults: collection.adults, collectionMode: collection.collectionMode, collectionPurpose: collection.collectionPurpose,
    productMode: collection.productMode, detailRankRanges: collection.detailRankRanges, bookingRangeDays: collection.bookingDays,
    bookingRangePlaceLimit: rankRange(collection.detailRankRanges).max, sourceRole: "admin", collectionSource: "admin_search",
    collectionSourceLabel: trigger === "scheduled" ? "예약워커 · 예약수집" : "예약워커 · 즉시수집",
    clientRequestId: `${occurrenceId}_${index + 1}`, scheduleOccurrenceId: occurrenceId };
  if (config.requestPacing !== null) payload.requestPacing = clone(config.requestPacing);
  return payload;
}
function safeCode(value, fallback = "KEYWORD_SCHEDULE_OPERATION_FAILED") {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(value) ? value : fallback;
}
function errorState(error) {
  // Match provider responses, but never persist the original message (URLs/credentials may be in it).
  const text = `${error?.code || ""} ${error?.message || ""}`;
  if ([403, 429].includes(Number(error?.statusCode || error?.status)) || /COLLECTOR_PROVIDER_BLOCKED|NAVER_\w*BLOCKED|BookingAPITooManyRequests|CAPTCHA|HTTP\s*(?:403|429)/i.test(text)) return { status: "blocked", errorCode: "PROVIDER_ACCESS_RESTRICTED" };
  if (error?.cancelled || /CANCEL|ABORT|INTERRUPT|SHUTDOWN|STATE_LOST/i.test(String(error?.code || ""))) return { status: "interrupted", errorCode: safeCode(error?.code, "COLLECTION_INTERRUPTED") };
  if (/^COLLECTOR_/.test(String(error?.code || ""))) return { status: "interrupted", errorCode: safeCode(error.code, "COLLECTOR_STATE_UNKNOWN") };
  return { status: "failed", errorCode: safeCode(error?.code, "COLLECTION_FAILED") };
}
function finalResult(value, quality) {
  const candidate = quality || value?.collectionQuality || value?.quality || value?.output?.collectionQuality;
  const status = candidate?.status;
  const runId = typeof value?.runId === "string" && /^[a-zA-Z0-9_-]{1,240}$/.test(value.runId) ? value.runId : null;
  const result = { status: ["complete", "partial", "failed", "blocked"].includes(status) ? status : "failed", runId,
    errorCode: ["complete", "partial", "failed", "blocked"].includes(status) ? null : "RESULT_QUALITY_UNKNOWN" };
  if (result.status === "complete" && !runId) return { status: "failed", runId: null, errorCode: "RESULT_RUN_ID_MISSING" };
  if (result.status === "complete" && (candidate?.counts?.mainCount === 0 || value?.output?.counts?.naverOverall === 0)) return { status: "failed", runId, errorCode: "RESULT_EMPTY" };
  if (result.status === "complete" && (value?.reused === true || value?.reusedResult === true || value?.cacheHit === true)) result.status = "reused";
  if (result.status === "blocked") result.errorCode = "PROVIDER_ACCESS_RESTRICTED";
  return result;
}

function createKeywordWorkerScheduler(options = {}) {
  if (typeof options.runCrawler !== "function" || typeof options.dataDir !== "string") throw fault("KEYWORD_SCHEDULE_DEPENDENCIES_REQUIRED");
  const dataDir = path.resolve(options.dataDir);
  const configFile = path.join(dataDir, "config", "keyword-worker-schedule.json");
  const receiptDir = path.join(dataDir, "history", "keyword-worker-schedule");
  const now = options.now || (() => new Date());
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  const tickIntervalMs = Math.max(1000, Number(options.tickIntervalMs) || 15000);
  const getFreeBytes = options.getFreeBytes || (async () => { const info = await fs.statfs(dataDir); return Number(info.bavail) * Number(info.bsize); });
  const active = new Map();
  let initializePromise;
  let configLock = Promise.resolve();
  let timer = null;
  let ticking = null;
  let stopped = false;
  let pauseEpoch = 0;
  let lastError = null;
  let persistenceFailed = false;
  const instant = () => { const at = new Date(now()); if (!Number.isFinite(at.getTime())) throw fault("KEYWORD_SCHEDULE_TIME_INVALID"); return at; };
  const receiptPath = id => { if (!RECEIPT_ID.test(id)) throw fault("KEYWORD_SCHEDULE_RECEIPT_INVALID"); return path.join(receiptDir, `${id}.json`); };

  async function atomicWrite(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
      // Windows can briefly deny replacement while another status reader closes its handle.
      for (let attempt = 0; ; attempt += 1) {
        try { await fs.rename(temporary, file); break; }
        catch (error) {
          if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
      }
    } catch (error) {
      persistenceFailed = true;
      lastError = "KEYWORD_SCHEDULE_PERSISTENCE_FAILED";
      throw fault(lastError, 503);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async function readJson(file, missing) {
    let text;
    try { text = await fs.readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return missing; throw error; }
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  }
  async function readConfig() { return validateConfig(await readJson(configFile, defaultConfig(instant()))); }
  function validateReceipt(value, id) {
    keysOnly(value, ["version", "id", "day", "trigger", "workerKey", "status", "createdAt", "scheduledAt", "startedAt", "finishedAt", "errorCode", "config", "items", "durationMs"], "KEYWORD_SCHEDULE_STATE_INVALID");
    if (!object(value) || value.version !== VERSION || value.id !== id || !RECEIPT_ID.test(id) || !STATES.has(value.status)
      || !["manual", "scheduled"].includes(value.trigger) || !date(value.day) || !Array.isArray(value.items) || value.items.length > 100
      || value.items.some(item => !object(item) || !STATES.has(item.status) || typeof item.keyword !== "string" || uniqueKeywords([item.keyword])[0] !== item.keyword)) throw fault("KEYWORD_SCHEDULE_STATE_INVALID", 503);
    validateConfig(value.config);
    for (const item of value.items) keysOnly(item, ["keyword", "status", "runId", "startedAt", "endedAt", "durationMs", "errorCode"], "KEYWORD_SCHEDULE_STATE_INVALID");
    return value;
  }
  async function readReceipt(id) {
    const value = await readJson(receiptPath(id), null);
    return value === null ? null : validateReceipt(value, id);
  }
  async function listReceipts() {
    const entries = await fs.readdir(receiptDir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!entry.isFile() || entry.isSymbolicLink() || !RECEIPT_ID.test(id)) throw fault("KEYWORD_SCHEDULE_STATE_INVALID", 503);
      result.push(await readReceipt(id));
    }
    return result;
  }
  async function persistReceipt(value) { await atomicWrite(receiptPath(value.id), value); }
  async function initialize() {
    if (!initializePromise) initializePromise = (async () => {
      await fs.mkdir(receiptDir, { recursive: true });
      await readConfig();
      for (const entry of await listReceipts()) {
        if (TERMINAL.has(entry.status)) continue;
        entry.status = "interrupted";
        entry.finishedAt = instant().toISOString();
        entry.errorCode = "RESTART_RESULT_UNKNOWN";
        for (const item of entry.items) if (!TERMINAL.has(item.status)) Object.assign(item, { status: "interrupted", endedAt: entry.finishedAt, errorCode: "RESTART_RESULT_UNKNOWN" });
        await persistReceipt(entry);
      }
    })().catch(error => { lastError = safeCode(error?.code, "KEYWORD_SCHEDULE_STATE_INVALID"); throw fault(lastError, 503); });
    return initializePromise;
  }
  function serializeConfig(fn) {
    const operation = configLock.then(fn, fn);
    configLock = operation.catch(() => {});
    return operation;
  }
  async function updateConfig(patch) {
    await initialize();
    return serializeConfig(async () => {
      if (persistenceFailed) throw fault(lastError, 503);
      const existing = await readConfig();
      keysOnly(patch, ["version", "enabled", "timezone", "repeat", "firstDate", "time", "keywords", "collection", "requestPacing"], "KEYWORD_SCHEDULE_CONFIG_INVALID");
      if (patch.enabled !== undefined && patch.enabled !== existing.enabled) throw fault("KEYWORD_SCHEDULE_USE_ENABLE_ACTION");
      if (patch.collection !== undefined && !object(patch.collection)) throw fault("KEYWORD_SCHEDULE_COLLECTION_INVALID");
      const config = validateConfig({ ...existing, ...patch, collection: { ...existing.collection, ...patch.collection }, enabled: existing.enabled });
      await atomicWrite(configFile, config);
      return clone(config);
    });
  }
  async function setEnabled(value) {
    await initialize();
    if (typeof value !== "boolean") throw fault("KEYWORD_SCHEDULE_ENABLED_INVALID");
    return serializeConfig(async () => {
      if (persistenceFailed) throw fault(lastError, 503);
      const config = await readConfig();
      if (value && !config.keywords.length) throw fault("KEYWORD_SCHEDULE_KEYWORDS_REQUIRED");
      const expiryReason = value ? scheduleExpiry(config, instant()) : null;
      if (expiryReason) throw fault(expiryReason);
      config.enabled = value;
      await atomicWrite(configFile, config);
      if (!value) {
        pauseEpoch += 1;
        // Only future/unclaimed scheduled work is withdrawn by the application.
        // Immediate batches and an already running worker remain unaffected.
        const occurrenceIds = [...active.keys()].filter(id => id.startsWith("scheduled_"));
        if (occurrenceIds.length && typeof options.cancelPendingScheduled === "function") {
          await options.cancelPendingScheduled({ occurrenceIds, reason: "SCHEDULE_PAUSED" });
        }
      }
      return clone(config);
    });
  }
  async function createReceipt(config, day, trigger, requestId, missed = false) {
    const id = trigger === "scheduled" ? `scheduled_${day}` : `manual_${requestId ? crypto.createHash("sha256").update(requestId).digest("hex") : crypto.randomBytes(16).toString("hex")}`;
    const createdAt = instant().toISOString();
    const entry = { version: VERSION, id, day, trigger, workerKey: "scheduled", status: missed ? "missed" : "queued", createdAt,
      scheduledAt: trigger === "scheduled" ? scheduledAt(day, config.time) : null, startedAt: null, finishedAt: missed ? createdAt : null,
      errorCode: missed ? "SCHEDULE_WINDOW_MISSED" : null, config: clone(config), items: config.keywords.map(keyword => ({ keyword, status: missed ? "missed" : "queued", runId: null })) };
    let handle;
    try {
      handle = await fs.open(receiptPath(id), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      if (error.code === "EEXIST") return { created: false, entry: await readReceipt(id) };
      persistenceFailed = true;
      lastError = "KEYWORD_SCHEDULE_PERSISTENCE_FAILED";
      throw fault(lastError, 503);
    } finally { await handle?.close(); }
    return { created: true, entry };
  }
  function pendingEnd(entry, state, code) {
    for (const item of entry.items) if (!TERMINAL.has(item.status)) Object.assign(item, { status: state, errorCode: code, endedAt: instant().toISOString() });
    entry.status = state;
    entry.errorCode = code;
  }
  function aggregate(entry) {
    const states = entry.items.map(item => item.status);
    if (states.includes("blocked")) return "blocked";
    if (states.includes("interrupted")) return "interrupted";
    if (states.every(state => state === "reused")) return "reused";
    if (states.every(state => ["complete", "reused"].includes(state))) return "complete";
    if (states.some(state => ["complete", "reused", "partial"].includes(state))) return "partial";
    return "failed";
  }
  async function execute(entry, epoch) {
    try {
      for (let index = 0; index < entry.items.length; index += 1) {
        const item = entry.items[index];
        const policy = await readConfig();
        if (stopped || (entry.trigger === "scheduled" && (!policy.enabled || pauseEpoch !== epoch))) { pendingEnd(entry, "interrupted", "SCHEDULE_PAUSED"); break; }
        if (persistenceFailed) throw fault(lastError, 503);
        const freeBytes = await getFreeBytes();
        if (!Number.isFinite(freeBytes) || freeBytes <= MIN_FREE_BYTES) { pendingEnd(entry, "failed", "DISK_SPACE_UNAVAILABLE"); break; }
        const payload = payloadFor(entry.config, item.keyword, entry.day, entry.id, index, entry.trigger);
        if (payload.checkIn < dateKey(instant())) { pendingEnd(entry, "missed", "COLLECTION_DATE_EXPIRED"); break; }
        entry.status = "running";
        entry.startedAt ||= instant().toISOString();
        Object.assign(item, { status: "running", startedAt: instant().toISOString(), errorCode: null });
        await persistReceipt(entry); // Durable receipt always precedes submitting work.
        try {
          const result = await options.runCrawler(payload);
          const quality = options.inspectResult ? await options.inspectResult(result, payload) : null;
          Object.assign(item, finalResult(result, quality));
        } catch (error) { Object.assign(item, errorState(error)); }
        item.endedAt = instant().toISOString();
        item.durationMs = Math.max(0, Date.parse(item.endedAt) - Date.parse(item.startedAt));
        if (["blocked", "interrupted"].includes(item.status)) {
          pendingEnd(entry, item.status, item.errorCode || "COLLECTION_INTERRUPTED");
          await persistReceipt(entry);
          break;
        }
        await persistReceipt(entry);
      }
      if (!TERMINAL.has(entry.status)) entry.status = aggregate(entry);
      entry.finishedAt = instant().toISOString();
      entry.durationMs = entry.startedAt ? Math.max(0, Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)) : 0;
      await persistReceipt(entry);
      return clone(entry);
    } catch (error) {
      lastError = safeCode(error?.code, "KEYWORD_SCHEDULE_OPERATION_FAILED");
      // A missing completion receipt cannot be repaired by starting the collection again.
      if (!persistenceFailed) {
        pendingEnd(entry, "interrupted", lastError);
        entry.finishedAt = instant().toISOString();
        await persistReceipt(entry);
      }
      throw fault(lastError, 503);
    }
  }
  function launch(entry) {
    const promise = execute(entry, pauseEpoch).finally(() => { active.delete(entry.id); });
    active.set(entry.id, promise);
    return promise;
  }
  async function prepareNow(overrides = {}) {
    await initialize();
    keysOnly(overrides, ["keywords", "collection", "requestPacing", "requestId"], "KEYWORD_SCHEDULE_RUN_INVALID");
    if (overrides.requestId !== undefined && (typeof overrides.requestId !== "string" || !/^[A-Za-z0-9_-]{8,120}$/.test(overrides.requestId))) throw fault("KEYWORD_SCHEDULE_REQUEST_ID_INVALID");
    if (overrides.requestId) {
      const id = `manual_${crypto.createHash("sha256").update(overrides.requestId).digest("hex")}`;
      const accepted = await readReceipt(id);
      // Retrying acceptance is a lookup of the original snapshot, not a new
      // collection. Current connectivity, dates and config cannot invalidate it.
      if (accepted) return { created: false, entry: accepted };
    }
    if (stopped || persistenceFailed) throw fault(lastError || "KEYWORD_SCHEDULE_STOPPED", 503);
    if (overrides.collection !== undefined && !object(overrides.collection)) throw fault("KEYWORD_SCHEDULE_COLLECTION_INVALID");
    const existing = await readConfig();
    const config = validateConfig({ ...existing, ...(overrides.keywords === undefined ? {} : { keywords: overrides.keywords }),
      collection: { ...existing.collection, ...overrides.collection }, requestPacing: overrides.requestPacing === undefined ? existing.requestPacing : overrides.requestPacing });
    if (!config.keywords.length) throw fault("KEYWORD_SCHEDULE_KEYWORDS_REQUIRED");
    if (config.collection.dateMode === "fixed" && config.collection.checkIn < dateKey(instant())) throw fault("KEYWORD_SCHEDULE_DATE_EXPIRED");
    if (typeof options.beforeImmediateRun === "function") await options.beforeImmediateRun();
    return createReceipt(config, dateKey(instant()), "manual", overrides.requestId);
  }
  async function runNow(overrides = {}) {
    const { created, entry } = await prepareNow(overrides);
    if (!created) return active.get(entry.id) || clone(entry);
    return launch(entry);
  }
  async function enqueueNow(overrides = {}) {
    const { created, entry } = await prepareNow(overrides);
    // Persisted exclusive acceptance precedes HTTP 202. A later browser retry returns the same receipt.
    if (created) launch(entry).catch(() => {});
    return clone(entry);
  }
  async function executeTick() {
    await initialize();
    if (stopped || persistenceFailed) return null;
    const config = await readConfig();
    if (!config.enabled || !config.keywords.length) return null;
    const at = instant();
    // Do not produce another missed receipt every day for an expired fixed
    // range. Past once schedules retain their one exclusive missed receipt.
    if (scheduleExpiry(config, at) === "KEYWORD_SCHEDULE_DATE_EXPIRED") return null;
    const today = dateKey(at);
    const day = config.repeat === "once" && config.firstDate < today ? config.firstDate : today;
    if (!eligible(config, day)) return null;
    const due = Date.parse(scheduledAt(day, config.time));
    if (at.getTime() < due) return null;
    const { created, entry } = await createReceipt(config, day, "scheduled", null, at.getTime() - due > GRACE_MS);
    if (!created) return active.get(entry.id) || clone(entry);
    if (entry.status === "missed") return clone(entry);
    return launch(entry);
  }
  function tick() {
    if (!ticking) ticking = executeTick().catch(error => { lastError = safeCode(error?.code, "KEYWORD_SCHEDULE_OPERATION_FAILED"); throw fault(lastError, 503); }).finally(() => { ticking = null; });
    return ticking;
  }
  async function status() {
    try {
      await initialize();
      const config = await readConfig();
      const receipts = await listReceipts();
      const at = instant();
      const today = dateKey(at);
      const taken = new Set(receipts.filter(entry => entry.trigger === "scheduled").map(entry => entry.day));
      const expiryReason = scheduleExpiry(config, at);
      const previewNextRunAt = previewSchedule(config, at, taken);
      const nextRunAt = config.enabled && !persistenceFailed && !stopped ? previewNextRunAt : null;
      const ordered = receipts.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
      return { enabled: config.enabled, active: active.size > 0, activeOccurrenceIds: [...active.keys()], workerKey: "scheduled", config: clone(config), nextRunAt,
        previewNextRunAt, expired: Boolean(expiryReason), expiryReason,
        day: today, graceMs: GRACE_MS, today: ordered.filter(entry => entry.day === today).slice(0, 100), latest: ordered.slice(0, 20),
        lastError, stopped, note: "active means awaiting dispatch/result; use collector status for actual worker execution" };
    } catch (error) {
      return { enabled: false, active: active.size > 0, activeOccurrenceIds: [...active.keys()], workerKey: "scheduled", config: null, nextRunAt: null,
        previewNextRunAt: null, expired: false, expiryReason: null,
        day: dateKey(instant()), today: [], latest: [], lastError: safeCode(error?.code, "KEYWORD_SCHEDULE_STATE_INVALID"), stopped };
    }
  }
  async function start() {
    await initialize();
    stopped = false;
    if (!timer) {
      timer = setIntervalImpl(() => { tick().catch(() => {}); }, tickIntervalMs);
      timer?.unref?.();
    }
    return status();
  }
  function stop() {
    stopped = true;
    pauseEpoch += 1;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }
  return { status, updateConfig, setEnabled, tick, runNow, enqueueNow, start, stop };
}

module.exports = { createKeywordWorkerScheduler, defaultConfig, validateConfig, uniqueKeywords, payloadFor, dateKey, addDays, scheduledAt,
  MIN_FREE_BYTES, GRACE_MS, VERSION };
