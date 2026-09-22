const defaultFs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const VERSION = 1;
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const KEYWORDS = Object.freeze([
  "경남글램핑", "대구글램핑", "부산글램핑", "경북글램핑", "충남글램핑",
  "전남글램핑", "전북글램핑", "대전글램핑", "서울근교글램핑", "경주글램핑",
  "여수글램핑", "가평글램핑", "포천글램핑"
]);
const ITEM_STATUSES = new Set(["pending", "running", "completed", "partial", "failed", "blocked", "interrupted"]);

function defaultConfig() {
  return { version: VERSION, enabled: false, timezone: "Asia/Seoul", hour: 14, minute: 0,
    keywords: [...KEYWORDS], bookingDays: 31, rankLimit: 20, minFreeBytes: MIN_FREE_BYTES };
}

function lowLoadRequestPacing(startDate) {
  return validateRequestPacing({ enabled: true, startDate, minIntervalMs: 200,
    maxConcurrentRequests: 2, detailConcurrency: 1, scheduleConcurrency: 2, otaConcurrency: 1 });
}

function validateRequestPacing(value) {
  const keys = ["enabled", "startDate", "minIntervalMs", "maxConcurrentRequests", "detailConcurrency", "scheduleConcurrency", "otaConcurrency"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key)) || typeof value.enabled !== "boolean"
    || typeof value.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate)
    || !Number.isFinite(Date.parse(`${value.startDate}T00:00:00Z`))
    || new Date(`${value.startDate}T00:00:00Z`).toISOString().slice(0, 10) !== value.startDate
    || !Number.isSafeInteger(value.minIntervalMs) || value.minIntervalMs < 100 || value.minIntervalMs > 60_000
    || value.maxConcurrentRequests > 2
    || keys.slice(3).some((key) => !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 8)) {
    throw new Error("invalid_daily_collection_request_pacing");
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function effectiveRequestPacing(config, day) {
  const value = config?.requestPacing;
  return value?.enabled && day >= value.startDate ? { ...value } : null;
}

function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== VERSION || typeof value.enabled !== "boolean"
    || value.timezone !== "Asia/Seoul" || value.hour !== 14 || value.minute !== 0
    || value.bookingDays !== 31 || value.rankLimit !== 20
    || !Array.isArray(value.keywords) || value.keywords.length !== KEYWORDS.length
    || value.keywords.some((keyword, index) => keyword !== KEYWORDS[index])
    || !Number.isSafeInteger(value.minFreeBytes) || value.minFreeBytes < MIN_FREE_BYTES) {
    throw new Error("invalid_daily_collection_config");
  }
  const result = { ...defaultConfig(), enabled: value.enabled, minFreeBytes: value.minFreeBytes };
  if (Object.hasOwn(value, "requestPacing")) result.requestPacing = validateRequestPacing(value.requestPacing);
  return result;
}

function dateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_scheduler_time");
  return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(day, count) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function scheduledAt(day) {
  return `${day}T05:00:00.000Z`;
}

function fingerprint(config, day) {
  const { enabled, minFreeBytes, requestPacing, ...collectionConfig } = config;
  const effective = effectiveRequestPacing(config, day);
  // Preparing a future profile must not invalidate an already-running day's ledger.
  if (effective) collectionConfig.requestPacing = effective;
  return crypto.createHash("sha256").update(JSON.stringify(collectionConfig)).digest("hex");
}

function brief(value, limit = 400) {
  return String(value || "").replace(/[\r\n]+/g, " ").slice(0, limit);
}

function blockingError(error) {
  const message = String(error?.message || error || "");
  if (/^COLLECTOR_/.test(error?.code || "")) return "collector_worker_unavailable";
  if (error?.cancelled || /^(ABORT_ERR|CRAWL_CANCELLED|cancel_requested)$/i.test(error?.code || "") || error?.name === "AbortError"
    || Number(error?.statusCode) === 499 || /\b(?:cancel_requested|crawl_cancelled)\b/i.test(message)) return "cancel_requested";
  if (error?.code === "ENOSPC" || /\bENOSPC\b/.test(message)) return "disk_full";
  if (/\bNAVER_MAIN_BLOCKED\s+HTTP\s+403\b/i.test(message)) return "naver_main_http_403";
  if (/\bNAVER_SCHEDULE_BLOCKED\s+HTTP\s+403\b/i.test(message)) return "naver_schedule_http_403";
  if (/\bNAVER_REQUEST_BLOCKED\s+HTTP\s+403\b/i.test(message)) return "naver_request_http_403";
  if (Number(error?.statusCode || error?.status) === 429
    || /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:Code)?)\s*[:=]?\s*429\b/i.test(message)) return "rate_limited";
  if (error?.code === "NAVER_REQUEST_BLOCKED" || /\bNAVER_REQUEST_BLOCKED\b/.test(message)) return "naver_request_blocked";
  return "";
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION
    || !value.days || typeof value.days !== "object" || Array.isArray(value.days)) {
    throw new Error("invalid_daily_collection_state");
  }
  for (const [day, entry] of Object.entries(value.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || entry?.day !== day
      || !Array.isArray(entry.items) || entry.items.length !== KEYWORDS.length
      || typeof entry.configFingerprint !== "string" || typeof entry.blockedReason !== "string"
      || entry.items.some((item, index) => item?.keyword !== KEYWORDS[index] || !ITEM_STATUSES.has(item.status))) {
      throw new Error("invalid_daily_collection_state");
    }
  }
  return value;
}

function qualitySummary(value) {
  if (!value || typeof value !== "object" || !["complete", "partial", "failed", "blocked"].includes(value.status)) {
    throw new Error("invalid_collection_quality_result");
  }
  const counts = {};
  if (value.counts && typeof value.counts === "object") {
    for (const [key, count] of Object.entries(value.counts)) {
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,59}$/.test(key) && Number.isFinite(count) && count >= 0) counts[key] = count;
    }
  }
  return { status: value.status, reason: brief(value.reason), blockedReason: brief(value.blockedReason), counts };
}

function createDailyKeywordCollectionScheduler(options = {}) {
  if (typeof options.runCrawler !== "function" || typeof options.inspectResult !== "function"
    || typeof options.isBusy !== "function") throw new Error("daily_collection_dependencies_required");
  const fs = options.fs || defaultFs;
  const dataDir = path.resolve(options.dataDir || process.cwd());
  const configFile = path.resolve(options.configFile || path.join(dataDir, "config", "daily_keyword_collection.json"));
  const stateFile = path.resolve(options.stateFile || path.join(dataDir, "history", "daily_keyword_collection_state.json"));
  const now = options.now || (() => new Date());
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const tickIntervalMs = Math.max(1000, Number(options.tickIntervalMs) || 60_000);
  const logger = options.logger || console;
  const getFreeBytes = options.getFreeBytes || (async () => {
    const stats = await fs.statfs(dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  });
  let activePromise = null;
  let timer = null;
  let started = false;
  let stopRequested = false;
  let lastError = "";
  let persistenceError = "";
  let recovered = false;

  const instant = () => {
    const result = new Date(now());
    if (!Number.isFinite(result.getTime())) throw new Error("invalid_scheduler_time");
    return result;
  };

  async function readJson(file, fallback) {
    let source;
    try { source = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  }

  async function config() {
    return validateConfig(await readJson(configFile, defaultConfig()));
  }

  async function readState() {
    return validateState(await readJson(stateFile, { version: VERSION, days: {} }));
  }

  async function persist(state) {
    const temp = `${stateFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temp, stateFile);
    } catch (error) {
      // A lost completion or stop decision must not be followed by another crawl.
      persistenceError = `state_persistence_failed: ${brief(error?.code || error?.message || error)}`;
      throw error;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  async function recoverInterrupted(state) {
    if (recovered) return;
    let changed = false;
    for (const entry of Object.values(state.days)) {
      for (const item of entry.items) {
        if (item.status !== "running") continue;
        Object.assign(item, { status: "interrupted", endedAt: instant().toISOString(),
          error: "server_restarted_result_unknown", quality: { status: "failed", reason: "interrupted_result_unknown", counts: {} } });
        changed = true;
      }
    }
    if (changed) await persist(state);
    recovered = true;
  }

  async function halt(state, day, reason) {
    day.blockedReason = brief(reason);
    day.stoppedAt = instant().toISOString();
    await persist(state);
  }

  function payloadFor(keyword, day, policy) {
    const payload = { keyword, checkIn: day, checkOut: addDays(day, policy.bookingDays - 1),
      searchMode: "keyword", productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail",
      detailRankRanges: `1-${policy.rankLimit}`, bookingRangeDays: policy.bookingDays,
      bookingRangePlaceLimit: policy.rankLimit, sourceRole: "admin", collectionSource: "admin_search",
      scheduledCollection: true,
      clientRequestId: `daily_${day}_${KEYWORDS.indexOf(keyword) + 1}` };
    const requestPacing = effectiveRequestPacing(policy, day);
    if (requestPacing) payload.requestPacing = requestPacing;
    return payload;
  }

  async function executeTick() {
    try {
      if (persistenceError) { lastError = persistenceError; return; }
      const policy = await config();
      const state = await readState();
      lastError = "";
      await recoverInterrupted(state);
      if (!policy.enabled || stopRequested) return;
      const at = instant();
      const key = dateKey(at);
      if (at.getTime() < new Date(scheduledAt(key)).getTime()) return;
      let day = state.days[key];
      if (!day) {
        day = { day: key, scheduledAt: scheduledAt(key), configFingerprint: fingerprint(policy, key),
          requestPacing: effectiveRequestPacing(policy, key),
          createdAt: at.toISOString(), blockedReason: "", items: policy.keywords.map((keyword) => ({ keyword, status: "pending" })) };
        state.days[key] = day;
        await persist(state);
      }
      if (day.configFingerprint !== fingerprint(policy, key)) {
        await halt(state, day, "same_day_configuration_changed");
        return;
      }
      if (day.blockedReason) return;
      if (!day.items.some((item) => item.status === "pending")) return;
      for (const item of day.items) {
        if (item.status !== "pending") continue;
        if (stopRequested || dateKey(instant()) !== key) return;
        const currentPolicy = await config();
        if (!currentPolicy.enabled) return;
        if (fingerprint(currentPolicy, key) !== day.configFingerprint) {
          await halt(state, day, "same_day_configuration_changed");
          return;
        }
        if (await options.isBusy()) return;
        let freeBytes;
        try {
          freeBytes = await getFreeBytes(dataDir);
          if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes) || freeBytes < 0) throw new Error("invalid_free_bytes");
        } catch {
          await halt(state, day, "disk_check_failed");
          return;
        }
        day.lastFreeBytes = freeBytes;
        day.diskCheckedAt = instant().toISOString();
        if (freeBytes < currentPolicy.minFreeBytes) {
          await halt(state, day, "insufficient_disk_space");
          return;
        }
        const payload = payloadFor(item.keyword, key, currentPolicy);
        item.status = "running";
        item.startedAt = instant().toISOString();
        item.requestPacing = payload.requestPacing ? { ...payload.requestPacing } : null;
        day.startedAt ||= day.items.find((entry) => entry.startedAt)?.startedAt || item.startedAt;
        await persist(state); // An unrecorded job must never be started.
        let blockingReason = "";
        try {
          const result = await options.runCrawler(payload);
          item.runId = brief(result?.runId, 240);
          const quality = qualitySummary(await options.inspectResult(result, payload));
          const mainCount = quality.counts.mainCount ?? quality.counts.naverOverall ?? result?.output?.counts?.naverOverall;
          if (quality.status !== "blocked" && (!item.runId || mainCount === 0 || result?.output?.counts?.naverOverall === 0)) {
            quality.status = "failed";
            quality.reason = !item.runId ? "missing_run_id" : "empty_main_results";
          }
          item.quality = quality;
          item.status = quality.status === "complete" ? "completed" : quality.status;
          if (quality.status === "blocked") blockingReason = quality.blockedReason || quality.reason || "collection_blocked";
        } catch (error) {
          blockingReason = blockingError(error);
          item.status = blockingReason ? "blocked" : "failed";
          item.error = brief(error?.message || error);
          item.quality = { status: item.status, reason: blockingReason || "collection_failed", counts: {} };
        }
        item.endedAt = instant().toISOString();
        item.durationMs = Math.max(0, new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime());
        if (blockingReason) {
          await halt(state, day, blockingReason);
          return;
        }
        await persist(state);
      }
      day.finishedAt = instant().toISOString();
      day.durationMs = Math.max(0, new Date(day.finishedAt).getTime() - new Date(day.startedAt).getTime());
      await persist(state);
    } catch (error) {
      // Never replace a corrupt ledger or continue after an unrecorded completion.
      lastError = persistenceError || brief(error?.message || error);
      logger.warn?.(`Daily keyword collection stopped: ${lastError}`);
    }
  }

  function tick() {
    if (activePromise) return activePromise;
    activePromise = executeTick().finally(() => { activePromise = null; });
    return activePromise;
  }

  async function status() {
    let policy;
    let state;
    let error = lastError;
    try { policy = await config(); } catch { error = error || "invalid_daily_collection_config"; }
    try { state = await readState(); } catch { error = error || "invalid_daily_collection_state"; }
    const at = instant();
    const key = dateKey(at);
    const day = state?.days[key] || null;
    const pending = !day || day.items.some((item) => item.status === "pending" || item.status === "running");
    const nextDay = day?.blockedReason || !pending ? addDays(key, 1) : key;
    return { enabled: Boolean(policy?.enabled && !error), active: Boolean(activePromise),
      config: policy || null, nextRunAt: policy?.enabled && !error ? scheduledAt(nextDay) : null,
      day: key, scheduledAt: scheduledAt(key), items: day?.items || [],
      requestPacing: day ? day.requestPacing || null : effectiveRequestPacing(policy, key),
      startedAt: day?.startedAt || day?.items.find((item) => item.startedAt)?.startedAt || null,
      durationMs: day?.durationMs ?? null,
      totalCollectionDurationMs: day ? day.items.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0) : null,
      finishedAt: day?.finishedAt || null, blockedReason: day?.blockedReason || error || "",
      lastError: error, lastFreeBytes: day?.lastFreeBytes ?? null, diskCheckedAt: day?.diskCheckedAt || null };
  }

  function scheduleNext() {
    if (!started || stopRequested || timer) return;
    timer = setTimer(async () => {
      timer = null;
      try { await tick(); } finally { scheduleNext(); }
    }, tickIntervalMs);
    timer.unref?.();
  }

  async function start() {
    if (!started) {
      started = true;
      stopRequested = false;
      // Start asynchronously so server startup is not held by a full collection batch.
      scheduleNext();
    }
    return status();
  }

  function stop() {
    started = false;
    stopRequested = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { start, stop, tick, status };
}

module.exports = { createDailyKeywordCollectionScheduler, defaultConfig, validateConfig, dateKey,
  addDays, blockingError, KEYWORDS, MIN_FREE_BYTES, lowLoadRequestPacing, validateRequestPacing, effectiveRequestPacing };
