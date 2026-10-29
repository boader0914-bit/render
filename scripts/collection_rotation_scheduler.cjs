"use strict";

// This store owns scheduling receipts only. It never changes provider protection,
// source observations, company records, or an existing individual worker schedule.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { sanitizeCollectionQuality } = require("./lib/collection_diagnostics.cjs");
const { monitorRange, monitorItem } = require("./lib/collection_monitor.cjs");

const VERSION = 1;
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const DAY_MS = 86400000;
const WORKER_NAMES = { web: "2Gweb_worker", manual: "BG worker" };
const ONE_DAY_TRIAL_WORKERS = [{ workerKey: "web", dailyLimit: 3 }, { workerKey: "manual", dailyLimit: 3 }];
const DEFAULT_KEYWORDS = ["경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑", "충남글램핑", "전남글램핑", "전북글램핑", "대전글램핑", "서울근교글램핑", "경주글램핑", "여수글램핑", "가평글램핑", "포천글램핑"];
const PENDING = ["queued", "waiting"];
const TERMINAL = new Set(["complete", "reused", "partial", "failed", "blocked", "missed", "paused", "uncertain"]);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value && typeof value === "object" && !Array.isArray(value);
function fault(code, statusCode = 400) { return Object.assign(new Error(code), { code, statusCode }); }
function keysOnly(value, keys, code) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw fault(code); }
function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "2000-01-01" && value <= "2099-12-31"
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dateKey(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw fault("ROTATION_TIME_INVALID");
  return new Date(time + 9 * 3600000).toISOString().slice(0, 10);
}
function addDays(day, count) {
  if (!validDate(day) || !Number.isSafeInteger(count)) throw fault("ROTATION_DATE_INVALID");
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}
function scheduledAt(day, time) { return new Date(`${day}T${time}:00+09:00`).toISOString(); }
function safeCode(value, fallback = "ROTATION_OPERATION_FAILED") { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(value) ? value : fallback; }
const reconciliationHash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Pausing, including a protective pause, must neither invalidate a saved trial
// nor be reversed by one. The base plan identity deliberately excludes enabled.
const basePlanHash = config => reconciliationHash({ ...validateConfig(config), enabled: false });
const RECONCILE_CONDITIONS = ["searchMode", "checkIn", "checkOut", "bookingRangeDays", "bookingRangePlaceLimit", "adults",
  "collectionMode", "collectionPurpose", "productMode", "dayUseMode", "detailRankRanges"];
function rankRange(value) {
  if (typeof value !== "string" || value.length > 150 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value)) throw fault("ROTATION_COLLECTION_INVALID");
  let max = 0;
  for (const part of value.split(",")) {
    const [first, last = first] = part.split("-").map(Number);
    if (first < 1 || last > 100 || last < first) throw fault("ROTATION_COLLECTION_INVALID");
    max = Math.max(max, last);
  }
  return max;
}
function defaultConfig(at = new Date()) {
  return { version: VERSION, enabled: false, timezone: "Asia/Seoul", firstDate: dateKey(at), time: "09:00", keywordIntervalMinutes: 120,
    keywords: [...DEFAULT_KEYWORDS], workers: [{ workerKey: "web", dailyLimit: 2 }, { workerKey: "manual", dailyLimit: 2 }],
    collection: { bookingDays: 31, collectionMode: "precision", collectionPurpose: "revenue_detail", detailRankRanges: "1-20", productMode: "all", dayUseMode: "inspect" } };
}
function validateConfig(value) {
  keysOnly(value, ["version", "enabled", "timezone", "firstDate", "time", "keywordIntervalMinutes", "keywords", "workers", "collection"], "ROTATION_CONFIG_INVALID");
  if (value.version !== VERSION || typeof value.enabled !== "boolean" || value.timezone !== "Asia/Seoul" || !validDate(value.firstDate)
    || typeof value.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) throw fault("ROTATION_CONFIG_INVALID");
  if (!Array.isArray(value.keywords) || !value.keywords.length || value.keywords.length > 100) throw fault("ROTATION_KEYWORDS_REQUIRED");
  const keywords = value.keywords.map(input => {
    if (typeof input !== "string") throw fault("ROTATION_CONFIG_INVALID");
    const word = input.normalize("NFKC").trim();
    if (!word || word.length > 160 || /[\x00-\x1f\x7f]/.test(word)) throw fault("ROTATION_CONFIG_INVALID");
    return word;
  });
  if (new Set(keywords).size !== keywords.length) throw fault("ROTATION_DUPLICATE_KEYWORDS");
  if (!Array.isArray(value.workers) || !value.workers.length || value.workers.length > 2) throw fault("ROTATION_WORKERS_INVALID");
  const workers = value.workers.map(worker => {
    keysOnly(worker, ["workerKey", "dailyLimit"], "ROTATION_WORKERS_INVALID");
    if (!Object.hasOwn(WORKER_NAMES, worker.workerKey) || !Number.isSafeInteger(worker.dailyLimit) || worker.dailyLimit < 1 || worker.dailyLimit > 100) throw fault("ROTATION_WORKERS_INVALID");
    return { workerKey: worker.workerKey, dailyLimit: worker.dailyLimit };
  });
  if (new Set(workers.map(worker => worker.workerKey)).size !== workers.length) throw fault("ROTATION_WORKERS_INVALID");
  const slots = workers.reduce((sum, worker) => sum + worker.dailyLimit, 0);
  if (slots > keywords.length) throw fault("ROTATION_DAILY_SLOTS_EXCEED_KEYWORDS");
  const [hour, minute] = value.time.split(":").map(Number);
  if (!Number.isSafeInteger(value.keywordIntervalMinutes) || value.keywordIntervalMinutes < 1 || value.keywordIntervalMinutes > 1440
    || hour * 60 + minute + (slots - 1) * value.keywordIntervalMinutes >= 1440) throw fault("ROTATION_INTERVAL_INVALID");
  const collection = value.collection;
  keysOnly(collection, ["bookingDays", "collectionMode", "collectionPurpose", "detailRankRanges", "productMode", "dayUseMode"], "ROTATION_COLLECTION_INVALID");
  if (!Number.isSafeInteger(collection.bookingDays) || collection.bookingDays < 1 || collection.bookingDays > 31 || collection.collectionMode !== "precision"
    || !["basic_db", "revenue_detail"].includes(collection.collectionPurpose) || collection.productMode !== "all"
    || !["inspect", "lodging_only", "detail"].includes(collection.dayUseMode)) throw fault("ROTATION_COLLECTION_INVALID");
  rankRange(collection.detailRankRanges);
  return { version: VERSION, enabled: value.enabled, timezone: "Asia/Seoul", firstDate: value.firstDate, time: value.time,
    keywordIntervalMinutes: value.keywordIntervalMinutes, keywords, workers, collection: clone(collection) };
}
function workerOrder(config) {
  const order = [];
  const max = Math.max(...config.workers.map(worker => worker.dailyLimit));
  for (let round = 0; round < max; round += 1) for (const worker of config.workers) if (round < worker.dailyLimit) order.push(worker.workerKey);
  return order;
}
function planDays(input, options = {}) {
  const config = validateConfig(input);
  const days = options.days === undefined ? 7 : Number(options.days);
  if (!Number.isSafeInteger(days) || days < 1 || days > 31) throw fault("ROTATION_PREVIEW_DAYS_INVALID");
  const first = options.startDate || config.firstDate;
  if (!validDate(first) || first < config.firstDate) throw fault("ROTATION_DATE_INVALID");
  let cursor = options.cursor === undefined ? 0 : options.cursor;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= config.keywords.length) throw fault("ROTATION_CURSOR_INVALID");
  const initialCursor = cursor;
  const items = [];
  const order = workerOrder(config);
  for (let offset = 0; offset < days; offset += 1) {
    const day = addDays(first, offset);
    for (let index = 0; index < order.length; index += 1) {
      const at = new Date(Date.parse(scheduledAt(day, config.time)) + index * config.keywordIntervalMinutes * 60000).toISOString();
      items.push({ id: `rotation_${day}_${index + 1}`, date: day, day, index, workerKey: order[index], keyword: config.keywords[cursor],
        scheduledAt: at, notBeforeAt: at, status: "queued", checkIn: day, lastDate: addDays(day, config.collection.bookingDays - 1),
        bookingDays: config.collection.bookingDays, detailRankRanges: config.collection.detailRankRanges });
      cursor = (cursor + 1) % config.keywords.length;
    }
  }
  return { config, cursor: initialCursor, nextCursor: cursor, days, items };
}
function payloadFor(config, slot) {
  const day = slot.day || slot.date;
  return { keyword: slot.keyword, workerKey: slot.workerKey, trigger: "scheduled", scheduledCollection: true, searchMode: "keyword", checkIn: day,
    checkOut: addDays(day, config.collection.bookingDays === 1 ? 1 : config.collection.bookingDays - 1), bookingRangeDays: config.collection.bookingDays,
    bookingRangePlaceLimit: rankRange(config.collection.detailRankRanges), adults: 2, collectionMode: config.collection.collectionMode,
    collectionPurpose: config.collection.collectionPurpose, productMode: config.collection.productMode, dayUseMode: config.collection.dayUseMode,
    detailRankRanges: config.collection.detailRankRanges, sourceRole: "admin", collectionSource: "admin_search",
    collectionSourceLabel: `${WORKER_NAMES[slot.workerKey]} · 공동 순환예약`, clientRequestId: slot.id, scheduleOccurrenceId: slot.id };
}
function resultFor(value, quality) {
  const candidate = quality || value?.collectionQuality || value?.quality || value?.output?.collectionQuality;
  const status = candidate?.status;
  const runId = typeof value?.runId === "string" && /^[A-Za-z0-9_-]{1,240}$/.test(value.runId) ? value.runId : null;
  const result = { status: ["complete", "partial", "failed", "blocked"].includes(status) ? status : "failed", runId,
    collectionQuality: sanitizeCollectionQuality(candidate), errorCode: ["complete", "partial", "failed", "blocked"].includes(status) ? null : "RESULT_QUALITY_UNKNOWN" };
  if (["held", "queued", "running", "complete", "failed"].includes(value?.postprocess?.state)) {
    result.postprocess = { state: value.postprocess.state };
    if (/^[A-Z][A-Z0-9_]{1,99}$/.test(value.postprocess.errorCode || "")) result.postprocess.errorCode = value.postprocess.errorCode;
  }
  if (result.status === "complete" && !runId) return { ...result, status: "failed", errorCode: "RESULT_RUN_ID_MISSING" };
  if (result.status === "complete" && (candidate?.counts?.mainCount === 0 || value?.output?.counts?.naverOverall === 0)) return { ...result, status: "failed", errorCode: "RESULT_EMPTY" };
  if (result.status === "complete" && (value?.reused === true || value?.reusedResult === true || value?.cacheHit === true)) result.status = "reused";
  if (result.status === "blocked") result.errorCode = "PROVIDER_ACCESS_RESTRICTED";
  const pacing = value?.requestPacing || value?.output?.requestPacing;
  if (object(pacing)) {
    result.requestPacing = {};
    for (const key of ["requestCount", "httpRequests", "totalHttpRequests", "totalRequests", "minObservedStartIntervalMs", "maxInFlight", "waitMs", "totalWaitMs", "failedRequests", "cancelledBeforeStart"]) {
      if (Number.isFinite(pacing[key]) && pacing[key] >= 0) result.requestPacing[key] = pacing[key];
    }
  }
  const actualStartedAt = value?.output?.startedAt || value?.crawlTiming?.startedAt || value?.executionStartedAt;
  if (result.status !== "reused" && actualStartedAt && Number.isFinite(Date.parse(actualStartedAt))) result.executionStartedAt = new Date(actualStartedAt).toISOString();
  const observedAt = value?.reuse?.observedAt || value?.observedAt || actualStartedAt;
  if (observedAt && Number.isFinite(Date.parse(observedAt))) result.observedAt = new Date(observedAt).toISOString();
  return result;
}
function errorResult(error) {
  // The broker provides this code only when cancellation is confirmed before
  // any worker claimed the job. Generic cancellations remain uncertain.
  if (error?.code === "COLLECTOR_SCHEDULE_PAUSED") return { status: "paused", errorCode: "COLLECTOR_SCHEDULE_PAUSED" };
  const text = `${error?.code || ""} ${error?.message || ""}`;
  if ([403, 429].includes(Number(error?.statusCode || error?.status)) || /COLLECTOR_PROVIDER_BLOCKED|NAVER_\w*BLOCKED|BookingAPITooManyRequests|CAPTCHA|HTTP\s*(?:403|429)/i.test(text)) return { status: "blocked", errorCode: "PROVIDER_ACCESS_RESTRICTED" };
  // Dispatch acknowledgement is not proof that the remote crawl did not run.
  if (/TIMEOUT|STATE_LOST|UNKNOWN|INTERRUPT|SHUTDOWN|CANCEL|ABORT/i.test(String(error?.code || ""))) return { status: "uncertain", errorCode: safeCode(error?.code, "ROTATION_EXECUTION_UNCERTAIN") };
  return { status: "failed", errorCode: safeCode(error?.code, "COLLECTION_FAILED") };
}

function createCollectionRotationScheduler(options = {}) {
  if (typeof options.dataDir !== "string" || typeof options.executeSlot !== "function") throw fault("ROTATION_DEPENDENCIES_REQUIRED");
  const dataDir = path.resolve(options.dataDir);
  const storePath = path.join(dataDir, "config", "collection-rotation.sqlite");
  const now = options.now || (() => new Date());
  const getFreeBytes = options.getFreeBytes || (async () => { const info = fs.statfsSync(dataDir); return Number(info.bavail) * Number(info.bsize); });
  const getWorkerState = options.getWorkerState || (async () => ({ ready: false }));
  const tickIntervalMs = Math.max(1000, Number(options.tickIntervalMs) || 15000);
  const setIntervalImpl = options.setIntervalImpl || setInterval;
  const clearIntervalImpl = options.clearIntervalImpl || clearInterval;
  let db = null;
  let timer = null;
  let stopped = false;
  let ticking = null;
  let activeId = null;
  let lastError = null;
  let epoch = 0;
  const instant = () => { const at = new Date(now()); if (!Number.isFinite(at.getTime())) throw fault("ROTATION_TIME_INVALID"); return at; };
  function transaction(callback) {
    db.exec("BEGIN IMMEDIATE");
    try { const value = callback(); db.exec("COMMIT"); return value; } catch (error) { try { db.exec("ROLLBACK"); } catch { /* Retain original error. */ } throw error; }
  }
  function state() { return db.prepare("SELECT * FROM rotation_state WHERE id = 1").get(); }
  function configOf(record = state()) { return validateConfig(JSON.parse(record.config_json)); }
  function event(kind, code = null, itemId = null) {
    db.prepare("INSERT INTO rotation_events(at,kind,code,item_id) VALUES(?,?,?,?)").run(instant().toISOString(), kind, code, itemId);
  }
  function initialize() {
    if (db) return;
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    db = new DatabaseSync(storePath);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    db.exec(`CREATE TABLE IF NOT EXISTS rotation_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, config_json TEXT NOT NULL,
      cursor INTEGER NOT NULL, plan_state TEXT NOT NULL, reason TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rotation_revisions (revision INTEGER PRIMARY KEY, config_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rotation_days (day TEXT PRIMARY KEY, revision INTEGER NOT NULL, cursor_start INTEGER NOT NULL, cursor_next INTEGER NOT NULL,
        config_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rotation_slots (id TEXT PRIMARY KEY, day TEXT NOT NULL REFERENCES rotation_days(day), slot_index INTEGER NOT NULL,
        worker_key TEXT NOT NULL, keyword TEXT NOT NULL, scheduled_at TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        error_code TEXT, result_json TEXT, receipt_json TEXT, UNIQUE(day,slot_index), UNIQUE(day,keyword));
      CREATE TABLE IF NOT EXISTS rotation_events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, code TEXT, item_id TEXT);`);
    db.exec(`CREATE TABLE IF NOT EXISTS rotation_reconciliations (slot_id TEXT PRIMARY KEY REFERENCES rotation_slots(id), run_id TEXT NOT NULL,
      expected_version TEXT NOT NULL, applied_version TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, previous_row_json TEXT NOT NULL,
      proof_json TEXT NOT NULL, reconciled_at TEXT NOT NULL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS rotation_one_day_trials (trial_id TEXT PRIMARY KEY, day TEXT NOT NULL UNIQUE,
      base_revision INTEGER NOT NULL, base_plan_hash TEXT NOT NULL, workers_json TEXT NOT NULL, created_at TEXT NOT NULL,
      cancelled_at TEXT, allocated_at TEXT);
      CREATE TABLE IF NOT EXISTS rotation_one_day_trial_days (day TEXT PRIMARY KEY REFERENCES rotation_days(day),
      trial_id TEXT NOT NULL UNIQUE REFERENCES rotation_one_day_trials(trial_id), effective_plan_hash TEXT NOT NULL);`);
    if (!state()) transaction(() => {
      const config = defaultConfig(instant());
      const at = instant().toISOString();
      db.prepare("INSERT INTO rotation_state VALUES(1,?,?,?,0,'disabled',NULL,?)").run(VERSION, 0, JSON.stringify(config), at);
    });
    if (Number(state().version) !== VERSION) throw fault("ROTATION_STORE_VERSION_INVALID", 503);
    configOf();
    const unresolved = db.prepare("SELECT id FROM rotation_slots WHERE status='running'").all();
    if (unresolved.length) transaction(() => {
      const record = state();
      const config = configOf(record); config.enabled = false;
      for (const row of unresolved) db.prepare("UPDATE rotation_slots SET status='uncertain',error_code='ROTATION_RESTART_EXECUTION_UNCERTAIN' WHERE id=?").run(row.id);
      db.prepare("UPDATE rotation_slots SET status='paused',error_code='ROTATION_UNRESOLVED_EXECUTION' WHERE status IN ('queued','waiting')").run();
      db.prepare("UPDATE rotation_state SET config_json=?,plan_state='review',reason='ROTATION_UNRESOLVED_EXECUTION',updated_at=? WHERE id=1").run(JSON.stringify(config), instant().toISOString());
      event("recovered_uncertain", "ROTATION_UNRESOLVED_EXECUTION");
    });
  }
  function rowItem(row) {
    const result = row.result_json ? JSON.parse(row.result_json) : {};
    const snapshot = db.prepare("SELECT config_json,revision FROM rotation_days WHERE day=?").get(row.day);
    const config = JSON.parse(snapshot.config_json);
    const receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null;
    const trialId = db.prepare("SELECT trial_id FROM rotation_one_day_trial_days WHERE day=?").get(row.day)?.trial_id;
    return { id: row.id, day: row.day, date: row.day, index: row.slot_index, revision: snapshot.revision, ...(trialId ? { trialId } : {}), workerKey: row.worker_key, keyword: row.keyword,
      scheduledAt: row.scheduled_at, notBeforeAt: notBefore(row), status: row.status, acceptedAt: row.started_at,
      startedAt: result.executionStartedAt || null, finishedAt: row.finished_at, endedAt: row.finished_at,
      errorCode: row.error_code, reason: row.error_code, runId: result.runId || null, ...result, receipt,
      checkIn: row.day, lastDate: addDays(row.day, config.collection.bookingDays - 1), bookingDays: config.collection.bookingDays, detailRankRanges: config.collection.detailRankRanges,
      collection: clone(config.collection), conditions: { ...clone(config.collection), checkIn: row.day,
        checkOut: addDays(row.day, config.collection.bookingDays === 1 ? 1 : config.collection.bookingDays - 1), bookingRangeDays: config.collection.bookingDays, searchMode: "keyword" } };
  }
  function notBefore(row) {
    const prior = db.prepare("SELECT started_at,finished_at,result_json FROM rotation_slots WHERE day=? AND slot_index<? ORDER BY slot_index DESC LIMIT 1").get(row.day, row.slot_index);
    const dayConfig = JSON.parse(db.prepare("SELECT config_json FROM rotation_days WHERE day=?").get(row.day).config_json);
    const priorResult = prior?.result_json ? JSON.parse(prior.result_json) : null;
    // Without verified crawler timing, using receipt acceptance could start the
    // next crawl too soon after an unobserved queue delay. Completion is a safe
    // upper bound for the prior start; reused results make no new HTTP start.
    const priorStart = priorResult?.executionStartedAt || (priorResult?.status === "reused" ? prior?.started_at : prior?.finished_at || prior?.started_at);
    return new Date(Math.max(Date.parse(row.scheduled_at), priorStart ? Date.parse(priorStart) + dayConfig.keywordIntervalMinutes * 60000 : 0,
      prior?.finished_at ? Date.parse(prior.finished_at) : 0)).toISOString();
  }
  function itemsForDay(day) { return db.prepare("SELECT * FROM rotation_slots WHERE day=? ORDER BY slot_index").all(day).map(rowItem); }
  function pause(reason, planState = "paused") {
    transaction(() => {
      const config = configOf(); config.enabled = false;
      db.prepare("UPDATE rotation_state SET config_json=?,plan_state=?,reason=?,updated_at=? WHERE id=1").run(JSON.stringify(config), planState, reason, instant().toISOString());
      db.prepare("UPDATE rotation_slots SET status='paused',error_code=? WHERE status IN ('queued','waiting')").run(reason);
      event("paused", reason);
    });
    epoch += 1;
  }
  async function conflict(config, phase) {
    if (!options.conflictCheck) return null;
    const value = await options.conflictCheck(clone(config), { phase });
    if (!value) return null;
    if (value === true) return { code: "ROTATION_SCHEDULE_CONFLICT" };
    if (typeof value === "string") return { code: safeCode(value, "ROTATION_SCHEDULE_CONFLICT") };
    return { code: safeCode(value.code, "ROTATION_SCHEDULE_CONFLICT"), wait: value.wait === true, workerKey: Object.hasOwn(WORKER_NAMES, value.workerKey) ? value.workerKey : null };
  }
  function workerProblem(value) {
    if (!object(value)) return "ROTATION_WORKER_STATE_UNKNOWN";
    if (value.retired) return "ROTATION_WORKER_RETIRED";
    if (value.halted || value.protected || value.held || value.hold) return safeCode(value.errorCode, "ROTATION_WORKER_PROTECTED");
    if (value.ready !== true) return safeCode(value.errorCode, "ROTATION_WORKER_NOT_READY");
    return null;
  }
  async function checkActivation(config) {
    const overlap = await conflict(config, "enable");
    if (overlap) throw fault(overlap.code, 409);
    const freeBytes = await getFreeBytes();
    if (!Number.isFinite(freeBytes) || freeBytes <= MIN_FREE_BYTES) throw fault("ROTATION_DISK_SPACE_UNAVAILABLE", 409);
    for (const worker of config.workers) {
      const value = await getWorkerState(worker.workerKey);
      const problem = workerProblem(value);
      if (problem) throw fault(problem, 409);
      if (value.active) throw fault("ROTATION_COLLECTORS_BUSY", 409);
    }
  }
  function trialBaseConfig(config) {
    if (config.time !== "09:00" || config.keywordIntervalMinutes !== 120 || config.keywords.length < 6
      || JSON.stringify(config.workers) !== JSON.stringify([{ workerKey: "web", dailyLimit: 2 }, { workerKey: "manual", dailyLimit: 2 }])) {
      throw fault("ROTATION_TRIAL_BASE_CONFIG_INVALID", 409);
    }
    return validateConfig({ ...config, workers: clone(ONE_DAY_TRIAL_WORKERS) });
  }
  function trialMatches(row, record, config) {
    if (!row || row.base_revision !== record.revision || row.base_plan_hash !== basePlanHash(config)) return false;
    try {
      return validDate(row.day) && /^[a-f0-9-]{36}$/.test(row.trial_id)
        && JSON.stringify(JSON.parse(row.workers_json)) === JSON.stringify(ONE_DAY_TRIAL_WORKERS)
        && Boolean(trialBaseConfig(config));
    } catch { return false; }
  }
  function trialSummary(row, record = state(), config = configOf(record)) {
    const today = dateKey(instant());
    let trialStatus = row.cancelled_at ? "cancelled" : row.day < today ? "expired" : row.allocated_at ? "allocated" : "armed";
    if (!["cancelled", "expired"].includes(trialStatus) && !trialMatches(row, record, config)) trialStatus = "needs_verification";
    return { trialId: row.trial_id, day: row.day, baseRevision: row.base_revision, basePlanHash: row.base_plan_hash,
      workers: clone(ONE_DAY_TRIAL_WORKERS), baseDailySlots: 4, trialDailySlots: 6, returnDay: validDate(row.day) ? addDays(row.day, 1) : null,
      createdAt: row.created_at, cancelledAt: row.cancelled_at, status: trialStatus };
  }
  function trialForDay(day) { return db.prepare("SELECT * FROM rotation_one_day_trials WHERE day=? AND cancelled_at IS NULL").get(day); }
  function configForDay(config, day, record = state()) {
    const trial = trialForDay(day), binding = db.prepare("SELECT trial_id FROM rotation_one_day_trial_days WHERE day=?").get(day);
    if (binding && binding.trial_id !== trial?.trial_id) throw fault("ROTATION_TRIAL_PLAN_CHANGED", 409);
    if (!trial) return config;
    if (!trialMatches(trial, record, config)) throw fault("ROTATION_TRIAL_PLAN_CHANGED", 409);
    return trialBaseConfig(config);
  }
  function planWithTrials(config, planOptions = {}) {
    // Keep the exported pure planner unchanged. The persisted scheduler owns the
    // date overrides and carries each day's cursor into the next day's plan.
    const base = planDays(config, planOptions), record = state();
    const first = planOptions.startDate || config.firstDate;
    let cursor = base.cursor;
    const items = [];
    for (let offset = 0; offset < base.days; offset += 1) {
      const day = addDays(first, offset), trial = trialForDay(day);
      const planned = planDays(configForDay(config, day, record), { startDate: day, days: 1, cursor });
      items.push(...planned.items.map(item => trial ? { ...item, trialId: trial.trial_id } : item));
      cursor = planned.nextCursor;
    }
    return { ...base, nextCursor: cursor, items };
  }
  function checkTrialExpectation(input, keys) {
    keysOnly(input, keys, "ROTATION_TRIAL_INPUT_INVALID");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
      || typeof input.expectedPlanHash !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedPlanHash)) throw fault("ROTATION_TRIAL_INPUT_INVALID");
    const record = state(), config = configOf(record);
    if (record.revision !== input.expectedRevision || basePlanHash(config) !== input.expectedPlanHash) throw fault("ROTATION_TRIAL_PLAN_CHANGED", 409);
    return { record, config };
  }
  function checkNewTrial(input) {
    const checked = checkTrialExpectation(input, ["day", "expectedRevision", "expectedPlanHash"]);
    const today = dateKey(instant());
    if (!validDate(input.day) || input.day <= today || input.day > addDays(today, 31) || input.day < checked.config.firstDate) throw fault("ROTATION_TRIAL_DATE_INVALID");
    if (db.prepare("SELECT day FROM rotation_days WHERE day=?").get(input.day)) throw fault("ROTATION_TRIAL_DAY_ALLOCATED", 409);
    if (db.prepare("SELECT trial_id FROM rotation_one_day_trials WHERE day=?").get(input.day)) throw fault("ROTATION_TRIAL_EXISTS", 409);
    if (db.prepare("SELECT trial_id FROM rotation_one_day_trials WHERE cancelled_at IS NULL AND day>=? LIMIT 1").get(today)) throw fault("ROTATION_TRIAL_PENDING", 409);
    return { ...checked, candidate: trialBaseConfig(checked.config) };
  }
  function previewOneDayTrial(input) {
    initialize();
    const { record, config, candidate } = checkNewTrial(input);
    const today = dateKey(instant());
    let first = config.firstDate > today ? config.firstDate : today;
    if (db.prepare("SELECT day FROM rotation_days WHERE day=?").get(first)) first = addDays(first, 1);
    let cursor = record.cursor;
    for (let day = first; day < input.day; day = addDays(day, 1)) cursor = planDays(config, { startDate: day, days: 1, cursor }).nextCursor;
    const trial = planDays(candidate, { startDate: input.day, days: 1, cursor });
    const next = planDays(config, { startDate: addDays(input.day, 1), days: 1, cursor: trial.nextCursor });
    return { baseRevision: record.revision, basePlanHash: basePlanHash(config), day: input.day, baseDailySlots: 4, trialDailySlots: 6,
      returnDay: addDays(input.day, 1), items: trial.items, nextDayItems: next.items, configUnchanged: true };
  }
  async function registerOneDayTrial(input) {
    initialize();
    const { config, candidate } = checkNewTrial(input);
    if (!config.enabled) throw fault("ROTATION_TRIAL_REQUIRES_ENABLED", 409);
    if (activeId || ticking) throw fault("ROTATION_COLLECTORS_BUSY", 409);
    const checkEpoch = epoch;
    await checkActivation(candidate);
    transaction(() => {
      const current = checkNewTrial(input);
      if (checkEpoch !== epoch || !current.config.enabled || activeId || ticking) throw fault("ROTATION_CONFIG_CHANGED", 409);
      const at = instant().toISOString(), trialId = crypto.randomUUID();
      db.prepare("INSERT INTO rotation_one_day_trials(trial_id,day,base_revision,base_plan_hash,workers_json,created_at) VALUES(?,?,?,?,?,?)")
        .run(trialId, input.day, current.record.revision, input.expectedPlanHash, JSON.stringify(ONE_DAY_TRIAL_WORKERS), at);
      event("one_day_trial_registered", null, trialId);
    });
    return status();
  }
  function cancelOneDayTrial(input) {
    initialize();
    transaction(() => {
      checkTrialExpectation(input, ["trialId", "expectedRevision", "expectedPlanHash"]);
      if (typeof input.trialId !== "string" || !/^[a-f0-9-]{36}$/.test(input.trialId)) throw fault("ROTATION_TRIAL_INPUT_INVALID");
      const trial = db.prepare("SELECT * FROM rotation_one_day_trials WHERE trial_id=?").get(input.trialId);
      if (!trial) throw fault("ROTATION_TRIAL_NOT_FOUND", 404);
      if (trial.cancelled_at || trial.allocated_at || trial.day <= dateKey(instant())
        || db.prepare("SELECT day FROM rotation_days WHERE day=?").get(trial.day)) throw fault("ROTATION_TRIAL_CANCEL_FORBIDDEN", 409);
      db.prepare("UPDATE rotation_one_day_trials SET cancelled_at=? WHERE trial_id=?").run(instant().toISOString(), trial.trial_id);
      event("one_day_trial_cancelled", null, trial.trial_id);
    });
    return status();
  }
  function preview(config = undefined, previewOptions = {}) {
    initialize();
    const record = state();
    const input = validateConfig(config === undefined ? configOf(record) : config);
    const original = configOf(record);
    let cursor = previewOptions.cursor === undefined ? record.cursor : previewOptions.cursor;
    if (previewOptions.startKeyword !== undefined) {
      if (typeof previewOptions.startKeyword !== "string" || !input.keywords.includes(previewOptions.startKeyword)) throw fault("ROTATION_START_POSITION_INVALID");
      cursor = input.keywords.indexOf(previewOptions.startKeyword);
    }
    if (config !== undefined && JSON.stringify(input.keywords) !== JSON.stringify(original.keywords)) {
      const next = original.keywords[record.cursor];
      const index = input.keywords.indexOf(next);
      if (index < 0 && previewOptions.cursor === undefined && previewOptions.startKeyword === undefined) throw fault("ROTATION_START_POSITION_REQUIRED");
      if (index >= 0 && previewOptions.cursor === undefined && previewOptions.startKeyword === undefined) cursor = index;
    }
    const today = dateKey(instant());
    const requestedStart = previewOptions.startDate || (input.firstDate > today ? input.firstDate : today);
    return planWithTrials(input, { ...previewOptions, startDate: requestedStart, cursor });
  }
  async function updateConfig(input, updateOptions = {}) {
    initialize();
    if (!object(input)) throw fault("ROTATION_CONFIG_INVALID");
    const expectedRevision = state().revision;
    const current = configOf();
    if (db.prepare("SELECT trial_id FROM rotation_one_day_trials WHERE cancelled_at IS NULL AND day>=? LIMIT 1").get(dateKey(instant()))) throw fault("ROTATION_TRIAL_PENDING", 409);
    if (current.enabled || activeId) throw fault("ROTATION_ACTIVE_EDIT_FORBIDDEN", 409);
    if (input.enabled === true) throw fault("ROTATION_SAVE_MUST_BE_DISABLED", 409);
    const config = validateConfig({ ...current, ...input, enabled: false });
    const nextKeyword = current.keywords[state().cursor];
    if (updateOptions.startKeyword !== undefined && (typeof updateOptions.startKeyword !== "string" || !config.keywords.includes(updateOptions.startKeyword))) throw fault("ROTATION_START_POSITION_INVALID");
    const cursor = config.keywords.indexOf(updateOptions.startKeyword === undefined ? nextKeyword : updateOptions.startKeyword);
    if (cursor < 0) throw fault("ROTATION_START_POSITION_REQUIRED", 409);
    transaction(() => {
      if (state().revision !== expectedRevision || configOf().enabled || activeId) throw fault("ROTATION_CONFIG_CHANGED", 409);
      if (db.prepare("SELECT trial_id FROM rotation_one_day_trials WHERE cancelled_at IS NULL AND day>=? LIMIT 1").get(dateKey(instant()))) throw fault("ROTATION_TRIAL_PENDING", 409);
      const revision = expectedRevision + 1;
      const at = instant().toISOString();
      db.prepare("INSERT INTO rotation_revisions VALUES(?,?,?)").run(revision, JSON.stringify(config), at);
      const unresolved = db.prepare("SELECT COUNT(*) AS count FROM rotation_slots WHERE status='uncertain'").get().count > 0;
      db.prepare("UPDATE rotation_state SET revision=?,config_json=?,cursor=?,plan_state=?,reason=?,updated_at=? WHERE id=1")
        .run(revision, JSON.stringify(config), cursor, unresolved ? "review" : "disabled", unresolved ? "ROTATION_UNRESOLVED_EXECUTION" : null, at);
      event("saved");
    });
    return status();
  }
  function dailyLimitsCandidate(input) {
    keysOnly(input, ["workers", "expectedRevision"], "ROTATION_LIMITS_INPUT_INVALID");
    const record = state(), current = configOf(record);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw fault("ROTATION_LIMITS_INPUT_INVALID");
    if (record.revision !== input.expectedRevision) throw fault("ROTATION_CONFIG_CHANGED", 409);
    if (activeId || ticking) throw fault("ROTATION_COLLECTORS_BUSY", 409);
    if (record.reason && record.reason !== "ROTATION_PAUSED_BY_USER"
      || ["review", "uncertain", "attention", "error"].includes(record.plan_state)) throw fault("ROTATION_LIMITS_PROTECTED", 409);
    if (db.prepare("SELECT id FROM rotation_slots WHERE status='uncertain' LIMIT 1").get()) throw fault("ROTATION_UNRESOLVED_EXECUTION", 409);
    if (db.prepare("SELECT trial_id FROM rotation_one_day_trials WHERE cancelled_at IS NULL AND day>=? LIMIT 1").get(dateKey(instant()))) throw fault("ROTATION_TRIAL_PENDING", 409);
    if (!Array.isArray(input.workers) || input.workers.length !== current.workers.length
      || input.workers.some((worker, index) => worker?.workerKey !== current.workers[index].workerKey)) throw fault("ROTATION_LIMITS_INPUT_INVALID");
    const config = validateConfig({ ...current, workers: input.workers });
    return { record, current, config };
  }
  function nextUnallocatedDay(config, today = dateKey(instant())) {
    const latest = db.prepare("SELECT MAX(day) AS day FROM rotation_days").get().day;
    const first = config.firstDate > today ? config.firstDate : today;
    return latest && latest >= first ? addDays(latest, 1) : first;
  }
  async function updateDailyLimits(input) {
    initialize();
    const before = dailyLimitsCandidate(input), checkEpoch = epoch, day = dateKey(instant());
    const changed = JSON.stringify(before.current.workers) !== JSON.stringify(before.config.workers);
    const metadata = revision => ({ changed, previousRevision: before.record.revision, revision,
      previousDailySlots: workerOrder(before.current).length, dailySlots: workerOrder(before.config).length,
      effectiveFrom: nextUnallocatedDay(before.config), todayAllocated: Boolean(db.prepare("SELECT day FROM rotation_days WHERE day=?").get(day)),
      todayAllocatedSlotsPreserved: true, enabledPreserved: true, cursorPreserved: true });
    if (!changed) return { ...status(), dailyLimitsUpdate: metadata(before.record.revision) };
    // Read the same admission guards as activation, but never activate, pause,
    // rewrite an allocated day, or change any collection/pacing condition.
    await checkActivation(before.config);
    transaction(() => {
      const after = dailyLimitsCandidate(input);
      if (checkEpoch !== epoch || dateKey(instant()) !== day || before.record.config_json !== after.record.config_json
        || before.record.cursor !== after.record.cursor || before.record.plan_state !== after.record.plan_state || before.record.reason !== after.record.reason) throw fault("ROTATION_CONFIG_CHANGED", 409);
      const revision = after.record.revision + 1, at = instant().toISOString();
      db.prepare("INSERT INTO rotation_revisions VALUES(?,?,?)").run(revision, JSON.stringify(after.config), at);
      db.prepare("UPDATE rotation_state SET revision=?,config_json=?,updated_at=? WHERE id=1").run(revision, JSON.stringify(after.config), at);
      event("daily_limits_saved");
    });
    const result = status();
    return { ...result, dailyLimitsUpdate: metadata(result.revision) };
  }
  async function setEnabled(enabled) {
    initialize();
    if (typeof enabled !== "boolean") throw fault("ROTATION_ENABLED_INVALID");
    if (!enabled) { pause("ROTATION_PAUSED_BY_USER"); return status(); }
    if (activeId) throw fault("ROTATION_COLLECTORS_BUSY", 409);
    const record = state();
    const config = configOf(record);
    if (config.enabled) return status();
    if (!record.revision) throw fault("ROTATION_SAVE_REQUIRED", 409);
    if (db.prepare("SELECT COUNT(*) AS count FROM rotation_slots WHERE status='uncertain'").get().count) throw fault("ROTATION_UNRESOLVED_EXECUTION", 409);
    const checkEpoch = epoch;
    await checkActivation(config);
    if (epoch !== checkEpoch || record.revision !== state().revision || activeId) throw fault("ROTATION_CONFIG_CHANGED", 409);
    transaction(() => {
      config.enabled = true;
      db.prepare("UPDATE rotation_state SET config_json=?,plan_state='scheduled',reason=NULL,updated_at=? WHERE id=1").run(JSON.stringify(config), instant().toISOString());
      event("enabled");
    });
    stopped = false;
    return status();
  }
  function allocateDay(day) {
    return transaction(() => {
      const record = state();
      const original = configOf(record);
      if (!original.enabled) return false;
      const trial = trialForDay(day), config = configForDay(original, day, record);
      const existing = db.prepare("SELECT * FROM rotation_days WHERE day=?").get(day);
      if (existing) {
        if (trial) {
          const binding = db.prepare("SELECT * FROM rotation_one_day_trial_days WHERE day=?").get(day);
          if (!trial.allocated_at || binding?.trial_id !== trial.trial_id || binding.effective_plan_hash !== basePlanHash(config)
            || basePlanHash(JSON.parse(existing.config_json)) !== basePlanHash(config)) throw fault("ROTATION_TRIAL_PLAN_CHANGED", 409);
        }
        return false;
      }
      const plan = planDays(config, { startDate: day, days: 1, cursor: record.cursor });
      const at = instant().toISOString();
      db.prepare("INSERT INTO rotation_days VALUES(?,?,?,?,?,?)").run(day, record.revision, record.cursor, plan.nextCursor, JSON.stringify(config), at);
      const insert = db.prepare("INSERT INTO rotation_slots(id,day,slot_index,worker_key,keyword,scheduled_at,status) VALUES(?,?,?,?,?,?,'queued')");
      for (const slot of plan.items) insert.run(slot.id, day, slot.index, slot.workerKey, slot.keyword, slot.scheduledAt);
      if (trial) {
        db.prepare("INSERT INTO rotation_one_day_trial_days(day,trial_id,effective_plan_hash) VALUES(?,?,?)").run(day, trial.trial_id, basePlanHash(config));
        db.prepare("UPDATE rotation_one_day_trials SET allocated_at=? WHERE trial_id=?").run(at, trial.trial_id);
      }
      db.prepare("UPDATE rotation_state SET cursor=?,updated_at=? WHERE id=1").run(plan.nextCursor, at);
      event("allocated");
      return true;
    });
  }
  async function executeTick() {
    initialize();
    if (stopped || activeId) return null;
    const config = configOf();
    if (!config.enabled) return null;
    const day = dateKey(instant());
    // Only today's observation may be allocated. Downtime is a gap, never a
    // catch-up burst masquerading as data observed on a previous date.
    db.prepare("UPDATE rotation_slots SET status='missed',error_code='ROTATION_DATE_EXPIRED',finished_at=? WHERE day<? AND status IN ('queued','waiting')").run(instant().toISOString(), day);
    if (day < config.firstDate || instant().getTime() < Date.parse(scheduledAt(day, config.time))) return null;
    try { allocateDay(day); }
    catch (error) {
      if (error?.code !== "ROTATION_TRIAL_PLAN_CHANGED") throw error;
      pause(error.code, "review");
      return null;
    }
    const row = db.prepare("SELECT * FROM rotation_slots WHERE day=? AND status IN ('queued','waiting') ORDER BY slot_index LIMIT 1").get(day);
    if (!row) return null;
    const notBeforeAt = notBefore(row);
    if (instant().getTime() < Date.parse(notBeforeAt)) return null;
    const executionEpoch = epoch;
    const dayConfig = JSON.parse(db.prepare("SELECT config_json FROM rotation_days WHERE day=?").get(day).config_json);
    const wait = reason => { db.prepare("UPDATE rotation_slots SET status='waiting',error_code=? WHERE id=? AND status IN ('queued','waiting')").run(reason, row.id); return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id)); };
    try {
      const overlap = await conflict(dayConfig, "tick");
      if (overlap?.wait || overlap?.code === "ALL_COLLECTORS_BUSY" || overlap?.code === "ROTATION_COLLECTORS_BUSY") return wait(overlap.code);
      if (overlap) { pause(overlap.code); return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id)); }
      const worker = await getWorkerState(row.worker_key);
      const problem = workerProblem(worker);
      if (problem) { pause(problem); return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id)); }
      if (worker.active) return wait("ROTATION_COLLECTORS_BUSY");
      const freeBytes = await getFreeBytes();
      if (!Number.isFinite(freeBytes) || freeBytes <= MIN_FREE_BYTES) { pause("ROTATION_DISK_SPACE_UNAVAILABLE"); return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id)); }
    } catch (error) {
      pause(safeCode(error?.code, "ROTATION_PREFLIGHT_FAILED"));
      return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id));
    }
    if (stopped || executionEpoch !== epoch || !configOf().enabled) return null;
    if (dateKey(instant()) !== day) {
      db.prepare("UPDATE rotation_slots SET status='missed',error_code='ROTATION_DATE_EXPIRED',finished_at=? WHERE id=?").run(instant().toISOString(), row.id);
      return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(row.id));
    }
    const startedAt = instant().toISOString();
    const slot = rowItem(row);
    const receipt = { version: VERSION, id: slot.id, workerKey: slot.workerKey, keyword: slot.keyword, day, acceptedAt: startedAt };
    transaction(() => {
      const changed = db.prepare("UPDATE rotation_slots SET status='running',started_at=?,error_code=NULL,receipt_json=? WHERE id=? AND status IN ('queued','waiting')")
        .run(startedAt, JSON.stringify(receipt), slot.id);
      if (changed.changes !== 1) throw fault("ROTATION_RECEIPT_ALREADY_ACCEPTED", 409);
      event("accepted", null, slot.id);
    });
    activeId = slot.id;
    let result;
    try {
      const payload = payloadFor(dayConfig, slot);
      const value = await options.executeSlot(payload, { ...slot, startedAt, receipt });
      const quality = options.inspectResult ? await options.inspectResult(value, payload) : null;
      result = resultFor(value, quality);
    } catch (error) { result = errorResult(error); }
    try {
      const finishedAt = instant().toISOString();
      result.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
      if (result.executionStartedAt && (Date.parse(result.executionStartedAt) < Date.parse(startedAt) || Date.parse(result.executionStartedAt) > Date.parse(finishedAt))) {
        delete result.executionStartedAt;
        if (result.status !== "reused") delete result.observedAt;
      }
      if (result.executionStartedAt) result.executionDurationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(result.executionStartedAt));
      transaction(() => {
        db.prepare("UPDATE rotation_slots SET status=?,finished_at=?,error_code=?,result_json=? WHERE id=? AND status='running'")
          .run(result.status, finishedAt, result.errorCode, JSON.stringify(result), slot.id);
        event("finished", result.errorCode, slot.id);
      });
      if (!["complete", "reused"].includes(result.status)) pause(result.errorCode || `ROTATION_RESULT_${result.status.toUpperCase()}`, result.status === "uncertain" ? "review" : "paused");
      // The durable collection receipt is the boundary. Optional derived work
      // may start only after this transaction; failure cannot undo completion.
      if (options.onResultCommitted) {
        try { await options.onResultCommitted(result, { ...slot, finishedAt }); }
        catch { options.logger?.warn?.("COLLECTION_POSTPROCESS_RELEASE_PENDING"); }
      }
      return rowItem(db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(slot.id));
    } catch (error) {
      // A successful crawl without a durable completion receipt must not run again.
      lastError = safeCode(error?.code, "ROTATION_PERSISTENCE_FAILED");
      try { pause(lastError, "review"); } catch { /* A persisted running receipt remains fail-closed on restart. */ }
      stopped = true;
      throw fault(lastError, 503);
    } finally { activeId = null; }
  }
  function tick() {
    if (!ticking) ticking = executeTick().catch(error => { lastError = safeCode(error?.code); throw fault(lastError, 503); }).finally(() => { ticking = null; });
    return ticking;
  }
  function history(query = {}) {
    initialize();
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000
      || (query.from !== undefined && !validDate(query.from)) || (query.to !== undefined && !validDate(query.to))
      || (query.from && query.to && query.to < query.from)) throw fault("ROTATION_HISTORY_QUERY_INVALID");
    const bounds = [query.from || "2000-01-01", query.to || "2099-12-31"];
    const total = db.prepare("SELECT COUNT(*) AS count FROM rotation_slots WHERE day>=? AND day<=?").get(...bounds).count;
    const rows = db.prepare("SELECT * FROM rotation_slots WHERE day>=? AND day<=? ORDER BY day DESC,slot_index LIMIT ? OFFSET ?").all(...bounds, limit, offset);
    return { items: rows.map(rowItem), limit, offset, total, hasMore: offset + rows.length < total, from: query.from || null, to: query.to || null };
  }
  function reconciliationSlot(slotId) {
    const row = db.prepare("SELECT * FROM rotation_slots WHERE id=?").get(slotId);
    if (!row) throw fault("ROTATION_RECONCILE_SLOT_NOT_FOUND", 404);
    const snapshot = db.prepare("SELECT config_json,revision FROM rotation_days WHERE day=?").get(row.day);
    if (!snapshot) throw fault("ROTATION_RECONCILE_SNAPSHOT_MISSING", 409);
    return { row, snapshot, version: reconciliationHash({ row, config: snapshot.config_json, revision: snapshot.revision }) };
  }
  function reconciliationIdle() {
    if (activeId || ticking) throw fault("ROTATION_RECONCILE_EXECUTION_ACTIVE", 409);
    if (configOf().enabled) throw fault("ROTATION_RECONCILE_PLAN_ACTIVE", 409);
  }
  async function reconcileCompleted(input = {}) {
    initialize();
    keysOnly(input, ["slotId", "runId", "dryRun", "expectedVersion", "reviewLegacy"], "ROTATION_RECONCILE_INPUT_INVALID");
    const { slotId, runId, expectedVersion } = input, dryRun = input.dryRun === undefined ? true : input.dryRun, reviewLegacy = input.reviewLegacy === true;
    if (typeof slotId !== "string" || !/^rotation_\d{4}-\d{2}-\d{2}_\d{1,3}$/.test(slotId)
      || typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,240}$/.test(runId) || typeof dryRun !== "boolean"
      || input.reviewLegacy !== undefined && typeof input.reviewLegacy !== "boolean"
      || expectedVersion !== undefined && (typeof expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(expectedVersion))) throw fault("ROTATION_RECONCILE_INPUT_INVALID");
    reconciliationIdle();
    const original = reconciliationSlot(slotId), { row, snapshot } = original;
    const prior = db.prepare("SELECT * FROM rotation_reconciliations WHERE slot_id=?").get(slotId);
    if (prior) {
      if (prior.run_id !== runId || row.status !== "complete" || original.version !== prior.applied_version
        || expectedVersion !== undefined && expectedVersion !== prior.expected_version && expectedVersion !== prior.applied_version) throw fault("ROTATION_RECONCILE_ALREADY_DIFFERENT", 409);
      return { dryRun, applied: false, alreadyApplied: true, expectedVersion: prior.expected_version, evidenceRechecked: false,
        verifiedAt: prior.reconciled_at, manifestSha256: prior.manifest_sha256, item: rowItem(row), planRemainsDisabled: true };
    }
    if (!["uncertain", "running"].includes(row.status)) throw fault("ROTATION_RECONCILE_STATUS_INELIGIBLE", 409);
    if (!row.started_at || !Number.isFinite(Date.parse(row.started_at)) || dateKey(row.started_at) !== row.day) throw fault("ROTATION_RECONCILE_ACCEPTANCE_INVALID", 409);
    let receipt = null;
    try { receipt = row.receipt_json ? JSON.parse(row.receipt_json) : null; } catch { throw fault("ROTATION_RECONCILE_RECEIPT_INVALID", 409); }
    if (!object(receipt) || receipt.id !== row.id || receipt.workerKey !== row.worker_key || receipt.keyword !== row.keyword || receipt.day !== row.day
      || receipt.acceptedAt !== row.started_at) throw fault("ROTATION_RECONCILE_RECEIPT_INVALID", 409);
    if (!dryRun && !expectedVersion) throw fault("ROTATION_RECONCILE_PREVIEW_REQUIRED", 409);
    if (typeof options.verifyPersistedResult !== "function") throw fault("ROTATION_RECONCILE_VERIFIER_REQUIRED", 503);
    const payload = payloadFor(JSON.parse(snapshot.config_json), rowItem(row));
    const conditions = Object.fromEntries(RECONCILE_CONDITIONS.map(key => [key, payload[key]]));
    const expected = { runId, slotId, workerKey: row.worker_key, keyword: row.keyword, day: row.day, trigger: "scheduled", acceptedAt: row.started_at,
      receiptSha256: crypto.createHash("sha256").update(row.receipt_json).digest("hex"),
      conditions, identities: { scheduleOccurrenceId: receipt.scheduleOccurrenceId || receipt.id,
        ...(receipt.jobId ? { jobId: receipt.jobId } : {}),
        ...(receipt.runTokenSha256 ? { runTokenSha256: receipt.runTokenSha256 } : receipt.runToken ? { runTokenSha256: crypto.createHash("sha256").update(receipt.runToken).digest("hex") } : {}) } };
    // This dependency must read saved server-owned manifests/artifacts itself.
    // An HTTP caller's claimed manifest/conditions are never accepted here.
    const verified = await options.verifyPersistedResult({ runId, reviewLegacy, expected: clone(expected), slot: clone(rowItem(row)), receipt: clone(receipt) });
    if (!object(verified) || verified.verified !== true || verified.runId !== runId || verified.workerKey !== row.worker_key
      || verified.keyword !== row.keyword || verified.trigger !== "scheduled" || verified.nonEmpty !== true
      || verified.collectionQuality?.status !== "complete" || verified.collectionQuality?.blockedReason || verified.collectionQuality?.failure
      || verified.blocked === true || verified.partial === true || verified.reused === true || verified.reusedResult === true || verified.cacheHit === true
      || verified.status !== undefined && verified.status !== "complete") throw fault("ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE", 409);
    const quality = sanitizeCollectionQuality(verified.collectionQuality);
    if (quality?.reason && quality.reason !== "manifest_checks_passed") throw fault("ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE", 409);
    for (const key of ["naverOtaBlocked", "naverOtaFailed", "naverScheduleFailed", "naverScheduleBlocked"]) {
      if (Number(quality?.counts?.[key]) > 0) throw fault("ROTATION_RECONCILE_RESULT_NOT_VERIFIED_COMPLETE", 409);
    }
    if (!object(verified.conditions) || RECONCILE_CONDITIONS.some(key => verified.conditions[key] !== conditions[key])) throw fault("ROTATION_RECONCILE_CONDITIONS_MISMATCH", 409);
    const proof = verified.proof, bindings = [];
    if (!object(proof) || typeof proof.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(proof.manifestSha256)) throw fault("ROTATION_RECONCILE_PROOF_MISSING", 409);
    for (const key of ["scheduleOccurrenceId", "jobId", "runTokenSha256"]) {
      const wanted = expected.identities[key], actual = proof[key];
      if (actual !== undefined && actual !== null && actual !== "") {
        if (typeof actual !== "string" || key === "jobId" && !/^[A-Za-z0-9_-]{1,240}$/.test(actual) || key === "runTokenSha256" && !/^[a-f0-9]{64}$/.test(actual)
          || typeof wanted === "string" && actual !== wanted) throw fault("ROTATION_RECONCILE_IDENTITY_CONFLICT", 409);
        if (typeof wanted === "string") bindings.push(key);
      }
    }
    const began = Date.parse(verified.executionStartedAt), finished = Date.parse(verified.finishedAt);
    if (typeof verified.executionStartedAt !== "string" || !verified.executionStartedAt.includes("T") || typeof verified.finishedAt !== "string" || !verified.finishedAt.includes("T")
      || !Number.isFinite(began) || !Number.isFinite(finished) || began < Date.parse(row.started_at) || finished < began || finished > instant().getTime()
      || dateKey(began) !== row.day) throw fault("ROTATION_RECONCILE_OBSERVATION_TIME_MISMATCH", 409);
    let bindingMode = "persisted_execution_identity", legacyReview = null;
    if (!bindings.length) {
      const legacy = proof.legacyReview;
      if (!reviewLegacy || !object(legacy) || legacy.slotId !== slotId || legacy.acceptedAt !== row.started_at
        || legacy.receiptSha256 !== expected.receiptSha256 || legacy.uniqueCandidateCount !== 1 || legacy.method !== "administrator-reviewed-legacy-job"
        || typeof proof.jobId !== "string" || !/^[A-Za-z0-9_-]{1,240}$/.test(proof.jobId)
        || !/^[a-f0-9]{64}$/.test(proof.runTokenSha256 || "")
        || began - Date.parse(row.started_at) > 5 * 60000) throw fault("ROTATION_RECONCILE_STRONG_ID_REQUIRED", 409);
      bindingMode = "administrator_reviewed_legacy";
      bindings.push("administrator-reviewed-legacy-job");
      legacyReview = { method: legacy.method, slotId, acceptedAt: row.started_at, receiptSha256: expected.receiptSha256,
        uniqueCandidateCount: 1, jobId: proof.jobId, runTokenSha256: proof.runTokenSha256,
        manifestHadScheduleOccurrenceId: false };
    }
    const checked = reconciliationSlot(slotId);
    reconciliationIdle();
    if (checked.version !== original.version) throw fault("ROTATION_RECONCILE_STATE_CHANGED", 409);
    const verifiedAt = instant().toISOString();
    const artifactProof = {};
    for (const key of ["jobReceiptSha256", "descriptorsSha256"]) {
      if (proof[key] !== undefined) {
        if (typeof proof[key] !== "string" || !/^[a-f0-9]{64}$/.test(proof[key])) throw fault("ROTATION_RECONCILE_PROOF_MISSING", 409);
        artifactProof[key] = proof[key];
      }
    }
    if (proof.verifiedFiles !== undefined) {
      if (!Number.isSafeInteger(proof.verifiedFiles) || proof.verifiedFiles < 1 || proof.verifiedFiles > 50000) throw fault("ROTATION_RECONCILE_PROOF_MISSING", 409);
      artifactProof.verifiedFiles = proof.verifiedFiles;
    }
    const proofBasis = { manifestSha256: proof.manifestSha256, ...artifactProof, bindings, bindingMode,
      ...(proof.jobId ? { jobId: proof.jobId } : {}), ...(proof.runTokenSha256 ? { runTokenSha256: proof.runTokenSha256 } : {}),
      ...(legacyReview ? { legacyReview } : {}), runId, workerKey: row.worker_key, keyword: row.keyword,
      day: row.day, trigger: "scheduled", conditions, executionStartedAt: new Date(began).toISOString(), finishedAt: new Date(finished).toISOString() };
    const previewVersion = reconciliationHash({ slotVersion: original.version, proof: proofBasis });
    if (expectedVersion && expectedVersion !== previewVersion) throw fault("ROTATION_RECONCILE_PROOF_CHANGED", 409);
    const proofRecord = { ...proofBasis, verifiedAt };
    if (dryRun) return { dryRun: true, applied: false, alreadyApplied: false, expectedVersion: previewVersion, evidenceRechecked: true,
      proof: proofRecord, item: rowItem(row), planRemainsDisabled: true };
    const bytes = await getFreeBytes();
    if (!Number.isFinite(bytes) || bytes <= MIN_FREE_BYTES) throw fault("ROTATION_DISK_SPACE_UNAVAILABLE", 409);
    const result = { status: "complete", runId, collectionQuality: quality, errorCode: null, executionStartedAt: new Date(began).toISOString(),
      observedAt: new Date(began).toISOString(), durationMs: finished - Date.parse(row.started_at), executionDurationMs: finished - began,
      reconciliation: { verifiedAt, manifestSha256: proof.manifestSha256, bindings, bindingMode } };
    transaction(() => {
      reconciliationIdle();
      if (reconciliationSlot(slotId).version !== original.version) throw fault("ROTATION_RECONCILE_STATE_CHANGED", 409);
      const changed = db.prepare(`UPDATE rotation_slots SET status='complete',finished_at=?,error_code=NULL,result_json=?
        WHERE id=? AND status=? AND started_at IS ? AND finished_at IS ? AND error_code IS ? AND result_json IS ? AND receipt_json IS ?`)
        .run(new Date(finished).toISOString(), JSON.stringify(result), row.id, row.status, row.started_at, row.finished_at, row.error_code, row.result_json, row.receipt_json);
      if (changed.changes !== 1) throw fault("ROTATION_RECONCILE_STATE_CHANGED", 409);
      const appliedVersion = reconciliationSlot(slotId).version;
      db.prepare("INSERT INTO rotation_reconciliations(slot_id,run_id,expected_version,applied_version,manifest_sha256,previous_row_json,proof_json,reconciled_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(slotId, runId, previewVersion, appliedVersion, proof.manifestSha256, JSON.stringify(row), JSON.stringify(proofRecord), verifiedAt);
      event("reconciled_complete", "ROTATION_VERIFIED_PERSISTED_RESULT", slotId);
    });
    return { dryRun: false, applied: true, alreadyApplied: false, expectedVersion: previewVersion, evidenceRechecked: true,
      verifiedAt, proof: proofRecord, item: rowItem(reconciliationSlot(slotId).row), planRemainsDisabled: true };
  }
  function monitorSnapshot(query = {}) {
    const range = monitorRange(query, instant());
    const unavailable = errorCode => ({ version: VERSION, ...range, available: false, errorCode,
      enabled: null, planState: "unknown", reason: null, keywords: [], currentPlan: null, items: [], coverage: { complete: false, days: [] } });
    // Diagnostics must never open, recover, migrate, allocate or tick a store.
    if (!db) return unavailable("COLLECTION_MONITOR_ROTATION_NOT_INITIALIZED");
    let reading = false;
    try {
      db.exec("BEGIN;"); reading = true;
      const record = state(), config = configOf(record), snapshots = new Map();
      for (const row of db.prepare("SELECT day,revision,config_json FROM rotation_days WHERE day>=? AND day<=? ORDER BY day").all(range.from, range.to)) {
        if (typeof row.config_json !== "string" || Buffer.byteLength(row.config_json) > 65536) throw fault("COLLECTION_MONITOR_STATE_INVALID");
        snapshots.set(row.day, { revision: row.revision, config: validateConfig(JSON.parse(row.config_json)) });
      }
      const trialDays = new Map(db.prepare("SELECT day,trial_id FROM rotation_one_day_trial_days WHERE day>=? AND day<=? ORDER BY day LIMIT 8")
        .all(range.from, range.to).map(row => [row.day, row.trial_id]));
      if (trialDays.size > 7) throw fault("COLLECTION_MONITOR_STATE_INVALID");
      // Bound aggregate JSON bytes in SQLite, before transferring result text.
      // Raw private receipt_json is deliberately never selected.
      const footprint = db.prepare(`SELECT COUNT(*) AS count,
        COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS result_bytes,
        COALESCE(MAX(length(CAST(result_json AS BLOB))),0) AS max_result_bytes
        FROM rotation_slots WHERE day>=? AND day<=?`).get(range.from, range.to);
      if (footprint.count > 700) throw fault("COLLECTION_MONITOR_SCAN_LIMIT");
      if (footprint.result_bytes > 8 * 1024 * 1024 || footprint.max_result_bytes > 1024 * 1024) throw fault("COLLECTION_MONITOR_PAYLOAD_LIMIT");
      const rows = db.prepare(`SELECT id,day,slot_index,worker_key,keyword,scheduled_at,status,started_at,finished_at,error_code,result_json
        FROM rotation_slots WHERE day>=? AND day<=? ORDER BY day,slot_index LIMIT 701`).all(range.from, range.to);
      if (rows.length !== footprint.count || rows.length > 700) throw fault("COLLECTION_MONITOR_STATE_CHANGED");
      for (const [day, snapshot] of snapshots) {
        if (rows.filter(row => row.day === day).length !== workerOrder(snapshot.config).length) throw fault("COLLECTION_MONITOR_DAY_SNAPSHOT_INCOMPLETE");
      }
      const items = rows.map(row => {
        const snapshot = snapshots.get(row.day);
        if (!snapshot || row.result_json && (typeof row.result_json !== "string" || Buffer.byteLength(row.result_json) > 1024 * 1024)) throw fault("COLLECTION_MONITOR_STATE_INVALID");
        const result = row.result_json ? JSON.parse(row.result_json) : {};
        if (!object(result)) throw fault("COLLECTION_MONITOR_STATE_INVALID");
        const conditions = payloadFor(snapshot.config, { ...row, day: row.day, workerKey: row.worker_key, keyword: row.keyword });
        const conflict = result.status !== undefined && result.status !== row.status;
        return monitorItem({ id: row.id, day: row.day, index: row.slot_index, revision: snapshot.revision,
          workerKey: row.worker_key, keyword: row.keyword, scheduledAt: row.scheduled_at, notBeforeAt: notBefore(row),
          status: conflict ? "uncertain" : row.status, acceptedAt: row.started_at, startedAt: result.executionStartedAt,
          finishedAt: row.finished_at, errorCode: conflict ? "COLLECTION_MONITOR_RESULT_STATUS_MISMATCH" : row.error_code,
          runId: result.runId, collectionQuality: result.collectionQuality, conditions,
          trialId: trialDays.get(row.day), planKind: trialDays.has(row.day) ? "one_day_trial" : "regular" });
      });
      const projectionStart = nextUnallocatedDay(config, range.today), projectedDays = new Map();
      if (projectionStart <= range.to) {
        const start = range.from > projectionStart ? range.from : projectionStart;
        const offsetDays = (Date.parse(start) - Date.parse(projectionStart)) / DAY_MS, perDay = workerOrder(config).length;
        let projectedCursor = record.cursor + offsetDays * perDay;
        // A later selected week must carry the extra two positions of any
        // intervening date-scoped trial, without allocating or changing it.
        const futureTrials = db.prepare("SELECT * FROM rotation_one_day_trials WHERE cancelled_at IS NULL AND day>=? AND day<? ORDER BY day LIMIT 32").all(projectionStart, start);
        if (futureTrials.length > 31) throw fault("COLLECTION_MONITOR_SCAN_LIMIT");
        for (const trial of futureTrials) {
          if (!trialMatches(trial, record, config)) throw fault("ROTATION_TRIAL_PLAN_CHANGED", 409);
          projectedCursor += workerOrder(trialBaseConfig(config)).length - perDay;
        }
        projectedCursor %= config.keywords.length;
        const days = (Date.parse(range.to) - Date.parse(start)) / DAY_MS + 1;
        for (const slot of planWithTrials(config, { days, startDate: start, cursor: projectedCursor }).items) {
          const effective = configForDay(config, slot.day, record);
          projectedDays.set(slot.day, { dailySlots: workerOrder(effective).length, planKind: slot.trialId ? "one_day_trial" : "regular" });
          items.push(monitorItem({ ...slot, revision: record.revision, projected: true,
            planKind: slot.trialId ? "one_day_trial" : "regular", conditions: payloadFor(effective, slot) }));
        }
      }
      const days = [];
      for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
        const saved = snapshots.get(day), projected = projectedDays.get(day);
        days.push({ day, status: saved ? "saved" : projected ? "projected" : day < config.firstDate ? "not_started" : "missing",
          count: items.filter(item => item.day === day).length,
          dailySlots: saved ? workerOrder(saved.config).length : projected?.dailySlots ?? null,
          planKind: saved ? trialDays.has(day) ? "one_day_trial" : "regular" : projected?.planKind ?? null });
      }
      const result = { version: VERSION, ...range, available: true, errorCode: null, enabled: config.enabled, stopped,
        planState: activeId ? "running" : record.plan_state, reason: record.reason ? safeCode(record.reason) : null,
        revision: record.revision, updatedAt: typeof record.updated_at === "string" && Number.isFinite(Date.parse(record.updated_at)) ? new Date(record.updated_at).toISOString() : null, activeSlotId: activeId,
        keywords: [...new Set([...config.keywords, ...items.map(item => item.keyword)])],
        currentPlan: { source: "saved_config", revision: record.revision, dailySlots: workerOrder(config).length, workers: clone(config.workers),
          time: config.time, keywordIntervalMinutes: config.keywordIntervalMinutes, bookingDays: config.collection.bookingDays,
          detailRankRanges: config.collection.detailRankRanges, keywordCount: config.keywords.length, nextUnallocatedDay: projectionStart },
        projectionEnabled: config.enabled && !stopped, items,
        coverage: { complete: days.every(day => day.status !== "missing"), days, actualItems: rows.length,
          projectedItems: items.length - rows.length, source: "initialized_rotation_store", historyFrom: range.from, historyTo: range.to } };
      db.exec("COMMIT;"); reading = false;
      return result;
    } catch (error) {
      if (reading) { try { db.exec("ROLLBACK;"); } catch { /* A diagnostic failure never repairs a store. */ } }
      return unavailable(safeCode(error?.code, "COLLECTION_MONITOR_STATE_UNAVAILABLE"));
    }
  }
  function status() {
    initialize();
    const record = state();
    const config = configOf(record);
    const day = dateKey(instant());
    const todayItems = itemsForDay(day);
    let nextDay = config.firstDate > day ? config.firstDate : day;
    if (db.prepare("SELECT day FROM rotation_days WHERE day=?").get(nextDay)) nextDay = addDays(nextDay, 1);
    let planned;
    try { planned = planWithTrials(config, { days: 7, startDate: nextDay, cursor: record.cursor }); }
    catch (error) {
      if (error?.code !== "ROTATION_TRIAL_PLAN_CHANGED") throw error;
      // A read reports the invalid trial; it must not silently show a valid
      // six-slot forecast or mutate the enabled/protection state.
      planned = { items: [] };
    }
    const pending = todayItems.filter(item => [...PENDING, "running"].includes(item.status));
    const upcomingItems = [...pending, ...planned.items];
    const nextRunAt = config.enabled && !stopped ? upcomingItems[0]?.notBeforeAt || null : null;
    const counts = {};
    for (const item of todayItems) counts[item.status] = (counts[item.status] || 0) + 1;
    const oneDayTrials = db.prepare("SELECT * FROM rotation_one_day_trials ORDER BY day DESC LIMIT 31").all().map(row => trialSummary(row, record, config));
    const oneDayTrial = oneDayTrials.filter(trial => ["armed", "allocated", "needs_verification"].includes(trial.status)).sort((a, b) => a.day.localeCompare(b.day))[0] || oneDayTrials[0] || null;
    return { version: VERSION, config, revision: record.revision, basePlanHash: basePlanHash(config), oneDayTrials, oneDayTrial, cursor: record.cursor, nextKeyword: config.keywords[record.cursor], enabled: config.enabled,
      active: Boolean(activeId), activeSlotId: activeId, planState: activeId ? "running" : record.plan_state, reason: record.reason, updatedAt: record.updated_at,
      day, todayItems, todayCounts: counts, upcomingItems, nextRunAt, previewNextRunAt: upcomingItems[0]?.notBeforeAt || null, latest: history({ limit: 40 }).items,
      lastError, stopped, note: "Allocation is durable; active means dispatch/result pending, not proof of remote execution." };
  }
  function start() {
    initialize(); stopped = false;
    if (!timer) { timer = setIntervalImpl(() => { tick().catch(() => {}); }, tickIntervalMs); timer?.unref?.(); }
    return status();
  }
  function stop() { stopped = true; epoch += 1; if (timer) clearIntervalImpl(timer); timer = null; }
  function close() { stop(); if (activeId || ticking) throw fault("ROTATION_EXECUTION_ACTIVE", 409); if (db) { db.close(); db = null; } }
  function isEnabled() { initialize(); return configOf().enabled && !stopped; }
  return { status, monitorSnapshot, preview, previewOneDayTrial, registerOneDayTrial, cancelOneDayTrial, updateConfig, updateDailyLimits, setEnabled, tick, start, stop, history, close, isEnabled, reconcileCompleted, storePath };
}

module.exports = { createCollectionRotationScheduler, defaultConfig, validateConfig, planDays, payloadFor, resultFor, errorResult,
  dateKey, addDays, scheduledAt, workerOrder, DEFAULT_KEYWORDS, WORKER_NAMES, VERSION, MIN_FREE_BYTES, TERMINAL };
