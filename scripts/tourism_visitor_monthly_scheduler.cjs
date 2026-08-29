const fsp = require("node:fs/promises");
const path = require("node:path");

const STATE_VERSION = "tourism-visitor-monthly-sync-v1";
const DEFAULT_MONTHS = 12;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 90 * 1000;

function kstDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("유효한 기준시각이 필요합니다.");
  const shifted = new Date(date.getTime() + (9 * 60 * 60 * 1000));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function kstDateKey(value = new Date()) {
  const parts = kstDateParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function yearMonthOffset(yearMonth, offset) {
  if (!/^\d{6}$/.test(String(yearMonth || ""))) throw new Error("기준월은 YYYYMM 형식이어야 합니다.");
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  if (month < 1 || month > 12) throw new Error("기준월이 올바르지 않습니다.");
  const date = new Date(Date.UTC(year, month - 1 + Number(offset || 0), 1));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function latestClosedYearMonth(value = new Date()) {
  const parts = kstDateParts(value);
  return yearMonthOffset(`${parts.year}${String(parts.month).padStart(2, "0")}`, -1);
}

function eligibleRegionKeys(regionMap = {}) {
  return Array.from(new Set((regionMap.regions || [])
    .filter((region) => /^\d{5}$/.test(String(region.ktoSggCd || "")))
    .filter((region) => !String(region.codeStatus || "").trim())
    .map((region) => String(region.regionKey || "").trim())
    .filter(Boolean)));
}

function publicCollectionSummary(history = {}) {
  const coverage = history.coverage && typeof history.coverage === "object" ? history.coverage : {};
  const collection = history.collection && typeof history.collection === "object" ? history.collection : {};
  return {
    status: String(history.status || "unavailable"),
    reason: String(history.reason || ""),
    period: history.period || null,
    coverage: {
      expectedRegionMonths: Number(coverage.expectedRegionMonths || 0),
      completeRegionMonths: Number(coverage.completeRegionMonths || 0),
      partialRegionMonths: Number(coverage.partialRegionMonths || 0),
      missingRegionMonths: Number(coverage.missingRegionMonths || 0),
      coverageRate: Number.isFinite(Number(coverage.coverageRate)) ? Number(coverage.coverageRate) : null
    },
    collection: {
      requestedMonths: Number(collection.requestedMonths || 0),
      cacheHitMonths: Number(collection.cacheHitMonths || 0),
      missingCacheMonths: Number(collection.missingCacheMonths || 0),
      networkAttemptedMonths: Number(collection.networkAttemptedMonths || 0),
      networkSucceededMonths: Number(collection.networkSucceededMonths || 0),
      networkFailedMonths: Number(collection.networkFailedMonths || 0)
    }
  };
}

function historyIsComplete(history = {}) {
  const coverage = history.coverage || {};
  const expected = Number(coverage.expectedRegionMonths || 0);
  const complete = Number(coverage.completeRegionMonths || 0);
  return expected > 0
    && complete === expected
    && Number(coverage.partialRegionMonths || 0) === 0
    && Number(coverage.missingRegionMonths || 0) === 0;
}

async function readJson(filePath) {
  try {
    const value = JSON.parse((await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function writeJsonAtomically(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function createMonthlyVisitorScheduler(options = {}) {
  const collector = options.collector;
  if (!collector || typeof collector.collectVisitorHistory !== "function" || typeof collector.readRegionMap !== "function") {
    throw new Error("월별 방문자 수집기 계약이 필요합니다.");
  }
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const setTimeoutFn = typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn : clearTimeout;
  const logger = options.logger || console;
  const enabled = options.enabled !== false;
  const months = Math.max(1, Math.min(12, Math.round(Number(options.months) || DEFAULT_MONTHS)));
  const concurrency = Math.max(1, Math.min(3, Math.round(Number(options.concurrency) || DEFAULT_CONCURRENCY)));
  const checkIntervalMs = Math.max(60_000, Number(options.checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS);
  const startupDelayMs = Math.max(0, Number(options.startupDelayMs) || DEFAULT_STARTUP_DELAY_MS);
  const stateFile = path.resolve(String(options.stateFile || path.join(process.cwd(), "tourism_data", "maintenance", "visitor_monthly_sync.json")));
  let timer = null;
  let activePromise = null;
  let nextCheckAt = "";

  async function persist(patch = {}) {
    const previous = await readJson(stateFile);
    const state = {
      version: STATE_VERSION,
      ...previous,
      policyMonths: months,
      ...patch,
      updatedAt: now().toISOString()
    };
    await writeJsonAtomically(stateFile, state);
    return state;
  }

  async function status() {
    const state = await readJson(stateFile);
    return {
      enabled,
      running: Boolean(activePromise),
      nextCheckAt,
      months,
      concurrency,
      stateFile,
      state,
      policy: {
        monthlyBatchOnly: true,
        pageOrCompanyRequestTriggersNetwork: false,
        sameDayNetworkRetryBlocked: true,
        missingIsNotZero: true,
        failedRefreshDoesNotOverwriteCompleteCache: true
      }
    };
  }

  async function runInternal({ force = false, trigger = "schedule" } = {}) {
    const checkedAt = now();
    const checkedAtIso = checkedAt.toISOString();
    const attemptDate = kstDateKey(checkedAt);
    const targetYearMonth = latestClosedYearMonth(checkedAt);
    if (!enabled && !force) {
      return { ok: false, status: "disabled", reason: "monthly_sync_disabled", targetYearMonth };
    }

    const regionMap = await collector.readRegionMap();
    const regionKeys = eligibleRegionKeys(regionMap);
    if (!regionKeys.length) {
      const state = await persist({
        lastCheckAt: checkedAtIso,
        lastResultStatus: "blocked",
        lastReason: "no_collectable_regions",
        targetYearMonth,
        eligibleRegionCount: 0
      });
      return { ok: false, status: "blocked", reason: "no_collectable_regions", targetYearMonth, state };
    }

    const inspection = await collector.collectVisitorHistory({
      regionKeys,
      months,
      endYearMonth: targetYearMonth,
      collectMissing: false,
      refresh: false,
      concurrency
    });
    if (historyIsComplete(inspection)) {
      const summary = publicCollectionSummary(inspection);
      const state = await persist({
        lastCheckAt: checkedAtIso,
        lastSuccessAt: checkedAtIso,
        lastResultStatus: "up_to_date",
        lastReason: "complete_cache_available",
        targetYearMonth,
        eligibleRegionCount: regionKeys.length,
        result: summary
      });
      return { ok: true, status: "up_to_date", reason: "complete_cache_available", targetYearMonth, result: summary, state };
    }

    const previousState = await readJson(stateFile);
    if (
      !force
      && previousState.lastAttemptKstDate === attemptDate
      && previousState.targetYearMonth === targetYearMonth
      && Number(previousState.policyMonths) === months
    ) {
      return {
        ok: false,
        status: "cooldown",
        reason: "network_attempt_already_made_today",
        targetYearMonth,
        result: publicCollectionSummary(inspection),
        state: previousState
      };
    }

    await persist({
      lastCheckAt: checkedAtIso,
      lastAttemptAt: checkedAtIso,
      lastAttemptKstDate: attemptDate,
      lastResultStatus: "running",
      lastReason: "",
      trigger,
      targetYearMonth,
      eligibleRegionCount: regionKeys.length,
      result: publicCollectionSummary(inspection)
    });

    try {
      const history = await collector.collectVisitorHistory({
        regionKeys,
        months,
        endYearMonth: targetYearMonth,
        collectMissing: true,
        refresh: true,
        retryIncomplete: true,
        concurrency
      });
      const summary = publicCollectionSummary(history);
      const succeeded = Number(summary.collection.networkSucceededMonths || 0) > 0 || historyIsComplete(history);
      const state = await persist({
        lastCompletedAt: now().toISOString(),
        ...(succeeded ? { lastSuccessAt: now().toISOString() } : {}),
        lastResultStatus: succeeded ? (historyIsComplete(history) ? "complete" : "partial") : "failed",
        lastReason: succeeded ? String(history.reason || "") : String(history.reason || "monthly_collection_failed"),
        targetYearMonth,
        eligibleRegionCount: regionKeys.length,
        result: summary
      });
      return {
        ok: succeeded,
        status: state.lastResultStatus,
        reason: state.lastReason,
        targetYearMonth,
        result: summary,
        state
      };
    } catch (error) {
      const state = await persist({
        lastCompletedAt: now().toISOString(),
        lastResultStatus: "error",
        lastReason: error?.message || "monthly_collection_error",
        targetYearMonth,
        eligibleRegionCount: regionKeys.length
      });
      return {
        ok: false,
        status: "error",
        reason: state.lastReason,
        targetYearMonth,
        state
      };
    }
  }

  function runOnce(options = {}) {
    if (activePromise) {
      if (options.rejectIfRunning) {
        const error = new Error("지역별 방문자수 월별 자료를 이미 갱신하고 있습니다.");
        error.statusCode = 409;
        error.code = "tourism_visitor_monthly_sync_busy";
        throw error;
      }
      return activePromise;
    }
    const promise = runInternal(options).finally(() => {
      if (activePromise === promise) activePromise = null;
    });
    activePromise = promise;
    return promise;
  }

  function schedule(delayMs) {
    if (!enabled || timer) return;
    nextCheckAt = new Date(now().getTime() + delayMs).toISOString();
    timer = setTimeoutFn(async () => {
      timer = null;
      nextCheckAt = "";
      try {
        const result = await runOnce({ trigger: "schedule" });
        if (!result.ok && !["cooldown", "disabled"].includes(result.status)) {
          logger.warn?.(`Tourism visitor monthly sync: ${result.status} (${result.reason || "unknown"})`);
        }
      } catch (error) {
        logger.warn?.(`Tourism visitor monthly sync failed: ${error?.message || error}`);
      } finally {
        schedule(checkIntervalMs);
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start() {
    schedule(startupDelayMs);
    return { enabled, nextCheckAt };
  }

  function stop() {
    if (timer) clearTimeoutFn(timer);
    timer = null;
    nextCheckAt = "";
  }

  return { runOnce, status, start, stop };
}

module.exports = {
  STATE_VERSION,
  DEFAULT_MONTHS,
  DEFAULT_CONCURRENCY,
  kstDateParts,
  kstDateKey,
  latestClosedYearMonth,
  eligibleRegionKeys,
  publicCollectionSummary,
  historyIsComplete,
  createMonthlyVisitorScheduler
};
