const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const STATE_VERSION = "tourism-demand-strength-backfill-v1";
const DEFAULT_DAILY_CALL_BUDGET = 800;
const CALLS_PER_WORK_ITEM = 2;
const INITIAL_BACKFILL_MONTHS = 36;
const MAX_DISTINCT_DAY_ATTEMPTS = 3;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 120 * 1000;
const SANCHEONG_REGION_KEY = "kr_gyeongnam_sancheong";
const SANCHEONG_LATEST_RECOVERY_ID = "sancheong-normalizer-v2-latest-recovery-20260829";
const SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION = "demand-strength-row-normalizer-v2";
const RECOVERY_PERMIT_STATUSES = new Set([
  "available",
  "claimed",
  "succeeded",
  "consumed",
  "satisfied_from_cache",
  "satisfied_from_daily_budget"
]);

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

function normalizeYearMonth(value = "") {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 6);
  const month = Number(digits.slice(4, 6));
  return /^\d{6}$/.test(digits) && month >= 1 && month <= 12 ? digits : "";
}

function yearMonthOffset(yearMonth, offset) {
  const normalized = normalizeYearMonth(yearMonth);
  if (!normalized) throw new Error("기준월은 YYYYMM 형식이어야 합니다.");
  const date = new Date(Date.UTC(
    Number(normalized.slice(0, 4)),
    Number(normalized.slice(4, 6)) - 1 + Number(offset || 0),
    1
  ));
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function latestClosedYearMonth(value = new Date()) {
  const parts = kstDateParts(value);
  return yearMonthOffset(`${parts.year}${String(parts.month).padStart(2, "0")}`, -1);
}

function compactText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isSancheongRegion(region = {}) {
  return region.regionKey === SANCHEONG_REGION_KEY || compactText(region.sigungu) === "산청군";
}

function eligibleRegions(regionMap = {}) {
  const deduped = new Map();
  for (const region of regionMap.regions || []) {
    const regionKey = String(region?.regionKey || "").trim();
    const ktoSidoCd = String(regionMap.provinceAliases?.[region?.sidoKey]?.ktoSidoCd || "").trim();
    if (
      !regionKey
      || !/^\d{2}$/.test(ktoSidoCd)
      || !/^\d{5}$/.test(String(region?.ktoSggCd || ""))
      || String(region?.codeStatus || "").trim()
    ) continue;
    if (!deduped.has(regionKey)) deduped.set(regionKey, { ...region, regionKey, ktoSidoCd });
  }
  return [...deduped.values()].sort((a, b) => {
    const sancheongDelta = Number(isSancheongRegion(b)) - Number(isSancheongRegion(a));
    if (sancheongDelta) return sancheongDelta;
    return a.regionKey.localeCompare(b.regionKey, "ko");
  });
}

function descendingMonths(endYearMonth, count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => yearMonthOffset(endYearMonth, -index));
}

function monthsAfter(startExclusive, endInclusive) {
  const start = normalizeYearMonth(startExclusive);
  const end = normalizeYearMonth(endInclusive);
  if (!start || !end || start >= end) return [];
  const result = [];
  let cursor = yearMonthOffset(start, 1);
  while (cursor <= end && result.length < INITIAL_BACKFILL_MONTHS * 4) {
    result.push(cursor);
    cursor = yearMonthOffset(cursor, 1);
  }
  return result;
}

function workItem(region = {}, yearMonth = "") {
  const normalizedMonth = normalizeYearMonth(yearMonth);
  return {
    key: `${region.regionKey}__${normalizedMonth}`,
    regionKey: region.regionKey,
    sigungu: String(region.sigungu || ""),
    ktoSggCd: String(region.ktoSggCd || ""),
    yearMonth: normalizedMonth
  };
}

function initialWorkItems(regions = [], targetYearMonth = "") {
  const orderedMonths = descendingMonths(targetYearMonth, INITIAL_BACKFILL_MONTHS);
  const sancheong = regions.filter(isSancheongRegion);
  const remainingRegions = regions.filter((region) => !isSancheongRegion(region));
  const result = [];
  for (const region of sancheong) {
    for (const yearMonth of orderedMonths) result.push(workItem(region, yearMonth));
  }
  for (const yearMonth of orderedMonths) {
    for (const region of remainingRegions) result.push(workItem(region, yearMonth));
  }
  return result;
}

function monthlyWorkItems(regions = [], completedThrough = "", targetYearMonth = "") {
  const months = monthsAfter(completedThrough, targetYearMonth).reverse();
  return months.flatMap((yearMonth) => regions.map((region) => workItem(region, yearMonth)));
}

function planIdentifier(kind, items = [], metadata = {}) {
  const digest = crypto.createHash("sha256");
  digest.update(JSON.stringify({ kind, metadata, items: items.map((item) => item.key) }));
  return digest.digest("hex").slice(0, 24);
}

function collectionFingerprint(regionMap = {}, demandStrengthSource = {}) {
  return {
    regionMapVersion: String(regionMap.version || ""),
    demandStrengthAdapter: String(demandStrengthSource.adapter || demandStrengthSource.version || ""),
    demandStrengthNormalizer: String(demandStrengthSource.normalizerVersion || ""),
    authorizedRecoveryId: SANCHEONG_LATEST_RECOVERY_ID
  };
}

function fingerprintMatches(left = null, right = null) {
  return Boolean(left && right)
    && String(left.regionMapVersion || "") === String(right.regionMapVersion || "")
    && String(left.demandStrengthAdapter || "") === String(right.demandStrengthAdapter || "")
    && String(left.demandStrengthNormalizer || "") === String(right.demandStrengthNormalizer || "")
    && String(left.authorizedRecoveryId || "") === String(right.authorizedRecoveryId || "");
}

function shouldGrantSancheongLatestRecovery(previous = null, current = null) {
  return Boolean(previous && current)
    && String(previous.regionMapVersion || "") === String(current.regionMapVersion || "")
    && String(previous.demandStrengthAdapter || "") === String(current.demandStrengthAdapter || "")
    && String(previous.demandStrengthNormalizer || "") === SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
    && String(current.demandStrengthNormalizer || "") === SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION
    && String(previous.authorizedRecoveryId || "") !== SANCHEONG_LATEST_RECOVERY_ID
    && String(current.authorizedRecoveryId || "") === SANCHEONG_LATEST_RECOVERY_ID;
}

function sancheongLatestRecoveryPermit(targetYearMonth = "", grantedAt = "") {
  const yearMonth = normalizeYearMonth(targetYearMonth);
  return {
    id: SANCHEONG_LATEST_RECOVERY_ID,
    regionKey: SANCHEONG_REGION_KEY,
    yearMonth,
    pairKey: `${SANCHEONG_REGION_KEY}__${yearMonth}`,
    normalizerVersion: SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
    maxCalls: CALLS_PER_WORK_ITEM,
    reservedCalls: 0,
    usedCalls: 0,
    reportedActualCalls: null,
    status: "available",
    grantedAt: String(grantedAt || ""),
    claimedAt: "",
    completedAt: "",
    outcome: "",
    reason: ""
  };
}

function recoveryPermitShapeValid(value = null) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!String(value.id || "") || !String(value.regionKey || "") || !String(value.pairKey || "")) return false;
  if (normalizeYearMonth(value.yearMonth) !== String(value.yearMonth || "")) return false;
  if (!RECOVERY_PERMIT_STATUSES.has(String(value.status || ""))) return false;
  for (const key of ["maxCalls", "reservedCalls", "usedCalls"]) {
    if (!Number.isInteger(Number(value[key])) || Number(value[key]) < 0) return false;
  }
  if (
    value.reportedActualCalls !== undefined
    && value.reportedActualCalls !== null
    && (!Number.isInteger(Number(value.reportedActualCalls)) || Number(value.reportedActualCalls) < 0 || Number(value.reportedActualCalls) > CALLS_PER_WORK_ITEM)
  ) return false;
  return Number(value.maxCalls) === CALLS_PER_WORK_ITEM
    && Number(value.reservedCalls) <= CALLS_PER_WORK_ITEM
    && Number(value.usedCalls) <= CALLS_PER_WORK_ITEM;
}

function historyPointForItem(history = {}, item = {}) {
  const directSeries = Array.isArray(history.series) ? history.series : [];
  const selectedRegion = (history.regions || []).find((region) => region?.regionKey === item.regionKey);
  const series = directSeries.length ? directSeries : (Array.isArray(selectedRegion?.series) ? selectedRegion.series : []);
  return series.find((point) => normalizeYearMonth(point?.yearMonth) === item.yearMonth) || series[0] || null;
}

function historyHasCompleteItem(history = {}, item = {}) {
  const directYearMonth = normalizeYearMonth(history.yearMonth);
  const directRegionKey = String(history.region?.regionKey || "");
  if (
    history.status === "ok"
    && directYearMonth === item.yearMonth
    && directRegionKey === item.regionKey
    && history.stay?.status === "ok"
    && history.spend?.status === "ok"
  ) return true;
  const point = historyPointForItem(history, item);
  if (point?.status === "complete") return true;
  const coverage = history.coverage || {};
  return history.status === "ok"
    && Number(coverage.expectedMonths || 0) === 1
    && Number(coverage.completeMonths || 0) === 1
    && Number(coverage.partialMonths || 0) === 0
    && Number(coverage.missingMonths || 0) === 0;
}

function historyFailureReason(history = {}) {
  const point = Array.isArray(history.series) ? history.series[0] : null;
  return String(point?.reason || history.reason || history.status || "demand_strength_collection_failed");
}

function operationCallsAttempted(result = {}) {
  const value = Number(
    result?.collection?.operationCallsAttempted
      ?? result?.operationCallsAttempted
      ?? 0
  );
  return Number.isFinite(value) ? Math.max(0, Math.min(CALLS_PER_WORK_ITEM, Math.round(value))) : 0;
}

function schedulerStateShapeValid(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== STATE_VERSION) return false;
  if (!value.dailyBudget || typeof value.dailyBudget !== "object" || Array.isArray(value.dailyBudget)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value.dailyBudget.kstDate || ""))) return false;
  for (const key of ["limitCalls", "usedCalls", "reservedCalls", "reservedWorkItems"]) {
    if (typeof value.dailyBudget[key] !== "number" || !Number.isFinite(value.dailyBudget[key]) || value.dailyBudget[key] < 0) {
      return false;
    }
  }
  if (!value.phase || !["initial_backfill", "monthly_maintenance"].includes(value.phase)) return false;
  if (!value.failures || typeof value.failures !== "object" || Array.isArray(value.failures)) return false;
  for (const key of ["terminalMissing", "staleManualReservations"]) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      return false;
    }
  }
  if (value.manualReservation !== undefined && value.manualReservation !== null && typeof value.manualReservation !== "object") {
    return false;
  }
  if (!recoveryPermitShapeValid(value.recoveryPermit)) return false;
  if (value.plan !== null && value.plan !== undefined) {
    if (typeof value.plan !== "object" || Array.isArray(value.plan)) return false;
    if (!String(value.plan.id || "") || !["initial_backfill", "monthly_maintenance"].includes(value.plan.kind)) return false;
    if (!Number.isFinite(Number(value.plan.cursor)) || Number(value.plan.cursor) < 0) return false;
    if (!Number.isFinite(Number(value.plan.totalItems)) || Number(value.plan.totalItems) < 0) return false;
    if (Number(value.plan.cursor) > Number(value.plan.totalItems)) return false;
  }
  return true;
}

async function readStateCandidate(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    let value = null;
    try {
      value = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      return { status: "invalid" };
    }
    return schedulerStateShapeValid(value)
      ? { status: "valid", value, raw }
      : { status: "invalid" };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable" };
  }
}

function stateUnavailableError() {
  const error = new Error("관광 수요 강도 백필 상태를 안전하게 읽을 수 없습니다.");
  error.statusCode = 503;
  error.code = "tourism_demand_strength_state_unavailable";
  return error;
}

async function readJson(filePath) {
  const primary = await readStateCandidate(filePath);
  if (primary.status === "valid") return { value: primary.value, recoveredFromBackup: false, fresh: false };
  const backup = await readStateCandidate(`${filePath}.bak`);
  if (backup.status === "valid") return { value: backup.value, recoveredFromBackup: true, fresh: false };
  if (primary.status === "missing" && backup.status === "missing") {
    return { value: null, recoveredFromBackup: false, fresh: true };
  }
  throw stateUnavailableError();
}

async function writeTextAtomically(filePath, text) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, text, { encoding: "utf8", mode: 0o600 });
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function writeJsonAtomically(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readStateCandidate(filePath);
  const backup = await readStateCandidate(`${filePath}.bak`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (existing.status === "valid") {
    await writeTextAtomically(`${filePath}.bak`, existing.raw.endsWith("\n") ? existing.raw : `${existing.raw}\n`);
  } else if (existing.status === "missing" && backup.status === "missing") {
    await writeTextAtomically(`${filePath}.bak`, serialized);
  }
  await writeTextAtomically(filePath, serialized);
}

function freshState(now, dailyCallBudget) {
  return {
    version: STATE_VERSION,
    phase: "initial_backfill",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    initialTargetYearMonth: "",
    initialCompletedAt: "",
    monthlyCompletedThrough: "",
    eligibleRegionCount: 0,
    planFingerprint: null,
    plan: null,
    failures: {},
    terminalMissing: {},
    inFlight: null,
    manualReservation: null,
    staleManualReservations: {},
    recoveryPermit: null,
    dailyBudget: {
      kstDate: kstDateKey(now),
      limitCalls: dailyCallBudget,
      usedCalls: 0,
      reservedCalls: 0,
      reservedWorkItems: 0
    },
    totals: {
      cacheReusedItems: 0,
      networkAttemptedItems: 0,
      networkCompletedItems: 0,
      failedItems: 0,
      terminalMissingItems: 0
    },
    lastRun: null
  };
}

function normalizeState(raw = {}, now, dailyCallBudget) {
  const state = { ...freshState(now, dailyCallBudget), ...raw };
  state.failures = state.failures && typeof state.failures === "object" && !Array.isArray(state.failures)
    ? state.failures
    : {};
  state.terminalMissing = state.terminalMissing && typeof state.terminalMissing === "object" && !Array.isArray(state.terminalMissing)
    ? state.terminalMissing
    : {};
  state.staleManualReservations = state.staleManualReservations
    && typeof state.staleManualReservations === "object"
    && !Array.isArray(state.staleManualReservations)
    ? state.staleManualReservations
    : {};
  state.recoveryPermit = recoveryPermitShapeValid(state.recoveryPermit)
    ? (state.recoveryPermit || null)
    : null;
  state.eligibleRegionCount = Math.max(0, Number(state.eligibleRegionCount || 0));
  state.totals = { ...freshState(now, dailyCallBudget).totals, ...(state.totals || {}) };
  const today = kstDateKey(now);
  const previousBudget = state.dailyBudget && typeof state.dailyBudget === "object" ? state.dailyBudget : {};
  state.dailyBudget = previousBudget.kstDate === today
    ? {
        kstDate: today,
        limitCalls: dailyCallBudget,
        usedCalls: Math.max(0, Number(previousBudget.usedCalls || 0)),
        reservedCalls: Math.max(0, Number(previousBudget.reservedCalls || 0)),
        reservedWorkItems: Math.max(0, Number(previousBudget.reservedWorkItems || 0))
      }
    : {
        kstDate: today,
        limitCalls: dailyCallBudget,
        usedCalls: 0,
        reservedCalls: 0,
        reservedWorkItems: 0
      };
  const manualReservation = state.manualReservation && typeof state.manualReservation === "object"
    ? state.manualReservation
    : null;
  if (manualReservation?.kstDate === today && manualReservation?.id) {
    state.manualReservation = {
        id: String(manualReservation.id),
        kstDate: today,
        requestedCalls: Math.max(0, Number(manualReservation.requestedCalls || 0)),
        reservedCalls: Math.max(0, Number(manualReservation.reservedCalls || 0)),
        reservedWorkItems: Math.max(0, Number(manualReservation.reservedWorkItems || 0)),
        createdAt: String(manualReservation.createdAt || "")
      };
  } else {
    if (manualReservation?.id) {
      state.staleManualReservations[String(manualReservation.id)] = {
        id: String(manualReservation.id),
        kstDate: String(manualReservation.kstDate || ""),
        requestedCalls: Math.max(0, Number(manualReservation.requestedCalls || 0)),
        reservedCalls: Math.max(0, Number(manualReservation.reservedCalls || 0)),
        reservedWorkItems: Math.max(0, Number(manualReservation.reservedWorkItems || 0)),
        createdAt: String(manualReservation.createdAt || ""),
        releasedAtKstDate: today
      };
    }
    state.manualReservation = null;
  }
  return state;
}

function publicBudget(value = {}) {
  const limitCalls = Math.max(0, Number(value.limitCalls || 0));
  const usedCalls = Math.max(0, Number(value.usedCalls || 0));
  const reservedCalls = Math.max(0, Number(value.reservedCalls || 0));
  return {
    kstDate: String(value.kstDate || ""),
    limitCalls,
    usedCalls,
    reservedCalls,
    remainingCalls: Math.max(0, limitCalls - usedCalls - reservedCalls),
    reservedWorkItems: Math.max(0, Number(value.reservedWorkItems || 0)),
    callsPerWorkItem: CALLS_PER_WORK_ITEM
  };
}

function publicPlan(plan = null) {
  if (!plan) return null;
  return {
    id: String(plan.id || ""),
    kind: String(plan.kind || ""),
    startYearMonth: String(plan.startYearMonth || ""),
    endYearMonth: String(plan.endYearMonth || ""),
    cursor: Math.max(0, Number(plan.cursor || 0)),
    totalItems: Math.max(0, Number(plan.totalItems || 0)),
    retryOnly: Boolean(plan.retryOnly),
    pass: Math.max(1, Number(plan.pass || 1))
  };
}

function projectedPublicPhase(state = {}, eligibleRegionCount = 0) {
  const plan = publicPlan(state.plan);
  if (state.phase === "monthly_maintenance") {
    return plan?.kind === "monthly_maintenance" ? "monthly" : "complete";
  }
  if (!plan || plan.kind !== "initial_backfill") return "priority_sancheong";

  if (plan.retryOnly) {
    const failureKeys = Object.keys(state.failures || {});
    if (failureKeys.some((key) => key.startsWith(`${SANCHEONG_REGION_KEY}__`))) {
      return "priority_sancheong";
    }
    const recentFloor = normalizeYearMonth(state.initialTargetYearMonth)
      ? yearMonthOffset(state.initialTargetYearMonth, -11)
      : "";
    if (recentFloor && failureKeys.some((key) => normalizeYearMonth(key.split("__").at(-1)) >= recentFloor)) {
      return "recent_12";
    }
    if (failureKeys.length) return "history_24";
  }

  const sancheongPairCount = Math.min(INITIAL_BACKFILL_MONTHS, plan.totalItems);
  if (plan.cursor < sancheongPairCount) return "priority_sancheong";
  const remainingRegionCount = Math.max(0, eligibleRegionCount - 1);
  const recentEndCursor = Math.min(
    plan.totalItems,
    sancheongPairCount + (remainingRegionCount * 12)
  );
  return plan.cursor < recentEndCursor ? "recent_12" : "history_24";
}

function publicSchedulerProjection(state = {}, runtime = {}) {
  const eligibleRegionCount = Math.max(0, Number(
    runtime.eligibleRegionCount ?? state.eligibleRegionCount ?? 0
  ));
  const plan = publicPlan(state.plan);
  const failureCount = Object.keys(state.failures || {}).length;
  let totalPairCount = plan?.totalItems || 0;
  let completedPairCount = 0;
  if (plan) {
    completedPairCount = plan.retryOnly
      ? Math.max(0, totalPairCount - failureCount)
      : Math.max(0, plan.cursor - failureCount);
  } else if (state.phase === "monthly_maintenance" && state.initialCompletedAt) {
    totalPairCount = eligibleRegionCount * INITIAL_BACKFILL_MONTHS;
    completedPairCount = totalPairCount;
  } else {
    totalPairCount = eligibleRegionCount * INITIAL_BACKFILL_MONTHS;
  }
  const budget = publicBudget(state.dailyBudget);
  const recoveryPermit = state.recoveryPermit && typeof state.recoveryPermit === "object"
    ? state.recoveryPermit
    : null;
  const latestFailureEntry = Object.entries(state.failures || {})
    .map(([key, value]) => ({ key, ...(value && typeof value === "object" ? value : {}) }))
    .sort((left, right) => String(right.lastAttemptAt || "").localeCompare(String(left.lastAttemptAt || "")))[0] || null;
  const latestFailureSeparator = latestFailureEntry?.key?.lastIndexOf("__") ?? -1;
  const latestFailureRegionKey = latestFailureSeparator > 0
    ? latestFailureEntry.key.slice(0, latestFailureSeparator)
    : "";
  const latestFailureYearMonth = latestFailureSeparator > 0
    ? normalizeYearMonth(latestFailureEntry.key.slice(latestFailureSeparator + 2))
    : "";
  return {
    stateIntegrity: "ok",
    phase: projectedPublicPhase(state, eligibleRegionCount),
    eligibleRegionCount,
    completedPairCount: Math.min(totalPairCount, completedPairCount),
    totalPairCount,
    todayUsedCalls: budget.usedCalls + budget.reservedCalls,
    dailyCallBudget: budget.limitCalls,
    recoveryStatus: String(recoveryPermit?.status || ""),
    recoveryCallsUsed: Math.max(0, Number(recoveryPermit?.usedCalls || 0) + Number(recoveryPermit?.reservedCalls || 0)),
    recoveryCallAllowance: recoveryPermit ? Math.max(0, Number(recoveryPermit.maxCalls || 0)) : 0,
    recoveryRegionKey: String(recoveryPermit?.regionKey || ""),
    recoveryYearMonth: String(recoveryPermit?.yearMonth || ""),
    recoveryOutcome: String(recoveryPermit?.outcome || ""),
    recoveryReason: String(recoveryPermit?.reason || ""),
    recoveryReportedActualCalls: recoveryPermit?.reportedActualCalls !== null
      && recoveryPermit?.reportedActualCalls !== undefined
      && Number.isInteger(Number(recoveryPermit.reportedActualCalls))
      ? Math.max(0, Number(recoveryPermit.reportedActualCalls))
      : null,
    recoveryCompletedAt: String(recoveryPermit?.completedAt || ""),
    activeFailureCount: failureCount,
    latestFailureRegionKey,
    latestFailureYearMonth,
    latestFailureReason: String(latestFailureEntry?.reason || ""),
    nextCheckAt: String(runtime.nextCheckAt || ""),
    lastResultStatus: String(state.lastRun?.status || ""),
    lastReason: String(state.lastRun?.reason || ""),
    running: Boolean(runtime.running),
    manualActive: Boolean(runtime.manualActive ?? state.manualReservation),
    staleManualReservationCount: Object.keys(state.staleManualReservations || {}).length,
    terminalMissingPairCount: Object.keys(state.terminalMissing || {}).length,
    completedThrough: String(state.monthlyCompletedThrough || "")
  };
}

function schedulerConflict(code, message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

function reservationInput(input = {}) {
  const maxPagesPerOperation = input.maxPagesPerOperation === undefined
    ? 1
    : Number(input.maxPagesPerOperation);
  if (maxPagesPerOperation !== 1) {
    const error = new Error("수동 수집은 작업별 최대 1페이지 정책만 허용합니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_max_pages_invalid";
    throw error;
  }
  const months = input.months === undefined ? null : Number(input.months);
  if (months !== null && (!Number.isInteger(months) || months <= 0)) {
    const error = new Error("수동 수집 개월 수는 1 이상의 정수여야 합니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_months_invalid";
    throw error;
  }
  const requestedCalls = input.requestedCalls === undefined
    ? (months === null ? NaN : months * CALLS_PER_WORK_ITEM)
    : Number(input.requestedCalls);
  if (!Number.isInteger(requestedCalls) || requestedCalls <= 0 || requestedCalls % CALLS_PER_WORK_ITEM !== 0) {
    const error = new Error("수동 수집 예약 호출 수는 지역·월 작업당 2회의 배수여야 합니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_requested_calls_invalid";
    throw error;
  }
  if (months !== null && requestedCalls !== months * CALLS_PER_WORK_ITEM) {
    const error = new Error("요청 호출 수가 개월 수 기준 예약량과 일치하지 않습니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_reservation_mismatch";
    throw error;
  }
  return {
    requestedCalls,
    reservedWorkItems: requestedCalls / CALLS_PER_WORK_ITEM,
    maxPagesPerOperation
  };
}

function reservationIdMatches(expected = "", received = "") {
  const expectedBuffer = Buffer.from(String(expected || ""));
  const receivedBuffer = Buffer.from(String(received || ""));
  return expectedBuffer.length > 0
    && expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function completedPairKeys(input = [], maximumPairs = 0) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    const error = new Error("완료된 지역·월 목록은 배열이어야 합니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_completed_pairs_invalid";
    throw error;
  }
  const keys = new Set();
  for (const pair of input) {
    const regionKey = String(pair?.regionKey || "").trim();
    const yearMonth = String(pair?.yearMonth || "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(regionKey) || normalizeYearMonth(yearMonth) !== yearMonth) {
      const error = new Error("완료된 지역·월 식별자가 올바르지 않습니다.");
      error.statusCode = 400;
      error.code = "tourism_demand_strength_manual_completed_pair_invalid";
      throw error;
    }
    keys.add(`${regionKey}__${yearMonth}`);
  }
  if (keys.size > Math.max(0, Number(maximumPairs || 0))) {
    const error = new Error("완료된 지역·월 수가 예약한 작업 범위를 초과했습니다.");
    error.statusCode = 400;
    error.code = "tourism_demand_strength_manual_completed_pairs_exceeded";
    throw error;
  }
  return [...keys];
}

function createDemandStrengthBackfillScheduler(options = {}) {
  const collector = options.collector;
  if (
    !collector
    || typeof collector.readRegionMap !== "function"
    || typeof collector.status !== "function"
    || typeof collector.collectDemandStrength !== "function"
  ) {
    throw new Error("관광 수요 강도 이력 수집기 계약이 필요합니다.");
  }
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const setTimeoutFn = typeof options.setTimeoutFn === "function" ? options.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeoutFn === "function" ? options.clearTimeoutFn : clearTimeout;
  const logger = options.logger || console;
  const enabled = options.enabled !== false;
  const dailyCallBudget = Math.max(
    CALLS_PER_WORK_ITEM,
    Math.floor(Number(options.dailyCallBudget) || DEFAULT_DAILY_CALL_BUDGET)
  );
  const checkIntervalMs = Math.max(60_000, Number(options.checkIntervalMs) || DEFAULT_CHECK_INTERVAL_MS);
  const startupDelayMs = Math.max(0, Number(options.startupDelayMs) || DEFAULT_STARTUP_DELAY_MS);
  const stateFile = path.resolve(String(
    options.stateFile
      || path.join(process.cwd(), "tourism_data", "maintenance", "demand_strength_backfill.json")
  ));
  const recoveryClaimFile = `${stateFile}.${SANCHEONG_LATEST_RECOVERY_ID}.claimed`;
  let timer = null;
  let activePromise = null;
  let nextCheckAt = "";
  let started = false;
  let manualMutationActive = false;
  let manualActiveReservationId = "";
  let runtimeOwnsManualReservation = false;

  async function claimSancheongLatestRecovery(item = {}, mode = "network") {
    let handle = null;
    try {
      await fsp.mkdir(path.dirname(recoveryClaimFile), { recursive: true });
      handle = await fsp.open(recoveryClaimFile, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        let existingMode = "";
        try {
          const existing = JSON.parse((await fsp.readFile(recoveryClaimFile, "utf8")).replace(/^\uFEFF/, ""));
          existingMode = String(existing?.mode || "");
        } catch {
          existingMode = "network";
        }
        return { claimed: false, reason: "claim_present", existingMode };
      }
      throw stateUnavailableError();
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        recoveryId: SANCHEONG_LATEST_RECOVERY_ID,
        regionKey: item.regionKey || SANCHEONG_REGION_KEY,
        yearMonth: item.yearMonth || "",
        mode,
        claimedAt: now().toISOString()
      })}\n`, "utf8");
      await handle.sync();
      return { claimed: true, reason: "", existingMode: mode };
    } catch {
      throw stateUnavailableError();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  function syncManualReservation(state = {}) {
    const persistedId = String(state.manualReservation?.id || "");
    if (persistedId) {
      if (manualActiveReservationId && manualActiveReservationId !== persistedId) {
        runtimeOwnsManualReservation = false;
      }
      manualActiveReservationId = persistedId;
      return;
    }
    if (
      runtimeOwnsManualReservation
      && manualActiveReservationId
      && state.staleManualReservations?.[manualActiveReservationId]
    ) return;
    manualActiveReservationId = "";
    runtimeOwnsManualReservation = false;
  }

  function hasCurrentManualReservation() {
    return Boolean(manualActiveReservationId);
  }

  function unavailableProjection({ running = false } = {}) {
    return {
      ok: false,
      status: "blocked",
      reason: "scheduler_state_unavailable",
      stateIntegrity: "unavailable",
      phase: "blocked",
      eligibleRegionCount: null,
      completedPairCount: null,
      totalPairCount: null,
      todayUsedCalls: null,
      dailyCallBudget,
      nextCheckAt,
      lastResultStatus: "blocked",
      lastReason: "scheduler_state_unavailable",
      running,
      manualActive: null,
      staleManualReservationCount: null,
      terminalMissingPairCount: null,
      completedThrough: "",
      plan: null,
      budget: null
    };
  }

  async function loadState() {
    const loaded = await readJson(stateFile);
    const state = loaded.fresh
      ? freshState(now(), dailyCallBudget)
      : normalizeState(loaded.value, now(), dailyCallBudget);
    if (loaded.recoveredFromBackup) {
      try {
        await writeJsonAtomically(stateFile, state);
      } catch {
        throw stateUnavailableError();
      }
    }
    syncManualReservation(state);
    return state;
  }

  async function persist(state, patch = {}) {
    const next = {
      ...state,
      ...patch,
      version: STATE_VERSION,
      updatedAt: now().toISOString()
    };
    try {
      await writeJsonAtomically(stateFile, next);
    } catch {
      throw stateUnavailableError();
    }
    return next;
  }

  function planForState(state, regions, targetYearMonth) {
    if (state.phase !== "monthly_maintenance") {
      state.phase = "initial_backfill";
      state.initialTargetYearMonth = normalizeYearMonth(state.initialTargetYearMonth) || targetYearMonth;
      const items = initialWorkItems(regions, state.initialTargetYearMonth);
      return {
        kind: "initial_backfill",
        startYearMonth: yearMonthOffset(state.initialTargetYearMonth, -(INITIAL_BACKFILL_MONTHS - 1)),
        endYearMonth: state.initialTargetYearMonth,
        items
      };
    }
    const completedThrough = normalizeYearMonth(state.monthlyCompletedThrough || state.initialTargetYearMonth);
    if (completedThrough && completedThrough >= targetYearMonth) return null;
    const items = monthlyWorkItems(regions, completedThrough, targetYearMonth);
    return {
      kind: "monthly_maintenance",
      startYearMonth: items.map((item) => item.yearMonth).sort()[0] || targetYearMonth,
      endYearMonth: targetYearMonth,
      items
    };
  }

  function attachPlan(state, proposed, regions, fingerprint) {
    if (!proposed) return { state, items: [], upToDate: true };
    const id = planIdentifier(proposed.kind, proposed.items, {
      startYearMonth: proposed.startYearMonth,
      endYearMonth: proposed.endYearMonth,
      regionKeys: regions.map((region) => region.regionKey),
      regionMapVersion: fingerprint.regionMapVersion,
      demandStrengthAdapter: fingerprint.demandStrengthAdapter,
      demandStrengthNormalizer: fingerprint.demandStrengthNormalizer,
      authorizedRecoveryId: fingerprint.authorizedRecoveryId
    });
    if (!state.plan || state.plan.id !== id) {
      state.plan = {
        id,
        kind: proposed.kind,
        startYearMonth: proposed.startYearMonth,
        endYearMonth: proposed.endYearMonth,
        cursor: 0,
        totalItems: proposed.items.length,
        retryOnly: false,
        pass: 1,
        createdAt: now().toISOString()
      };
      state.failures = {};
      state.inFlight = null;
    } else {
      state.plan.totalItems = proposed.items.length;
      state.plan.startYearMonth = proposed.startYearMonth;
      state.plan.endYearMonth = proposed.endYearMonth;
    }
    const planKeys = new Set(proposed.items.map((item) => item.key));
    for (const key of Object.keys(state.failures)) {
      if (!planKeys.has(key)) delete state.failures[key];
    }
    const items = state.plan.retryOnly
      ? proposed.items.filter((item) => state.failures[item.key])
      : proposed.items;
    state.plan.cursor = Math.min(Math.max(0, Number(state.plan.cursor || 0)), items.length);
    return { state, items, upToDate: false };
  }

  function cacheReadInput(item) {
    return {
      regionKey: item.regionKey,
      yearMonth: item.yearMonth,
      cacheOnly: true,
      force: false,
      maxPagesPerOperation: 1
    };
  }

  function networkInput(item) {
    return {
      regionKey: item.regionKey,
      yearMonth: item.yearMonth,
      force: false,
      maxPagesPerOperation: 1
    };
  }

  function resultEnvelope(state, status, reason, targetYearMonth, progress = {}) {
    return {
      ok: ["up_to_date", "initial_complete", "monthly_complete"].includes(status),
      status,
      reason,
      targetYearMonth,
      ...publicSchedulerProjection(state, {
        nextCheckAt,
        running: false
      }),
      plan: publicPlan(state.plan),
      budget: publicBudget(state.dailyBudget),
      progress
    };
  }

  async function finishPlan(state, targetYearMonth, progress) {
    const completedPlan = { ...state.plan };
    if (completedPlan.kind === "initial_backfill") {
      state.phase = "monthly_maintenance";
      state.initialCompletedAt = now().toISOString();
      state.monthlyCompletedThrough = completedPlan.endYearMonth;
      state.plan = null;
      state.failures = {};
      state.inFlight = null;
      state.lastRun = {
        at: now().toISOString(),
        status: "initial_complete",
        targetYearMonth,
        completedThrough: state.monthlyCompletedThrough,
        progress
      };
      state = await persist(state);
      return resultEnvelope(state, "initial_complete", "initial_36_month_backfill_complete", targetYearMonth, progress);
    }
    state.monthlyCompletedThrough = completedPlan.endYearMonth;
    state.plan = null;
    state.failures = {};
    state.inFlight = null;
    state.lastRun = {
      at: now().toISOString(),
      status: "monthly_complete",
      targetYearMonth,
      completedThrough: state.monthlyCompletedThrough,
      progress
    };
    state = await persist(state);
    return resultEnvelope(state, "monthly_complete", "latest_closed_month_supplement_complete", targetYearMonth, progress);
  }

  async function runInternal({ trigger = "schedule" } = {}) {
    const checkedAt = now();
    const targetYearMonth = latestClosedYearMonth(checkedAt);
    if (!enabled) {
      const state = normalizeState({}, checkedAt, dailyCallBudget);
      return resultEnvelope(state, "disabled", "demand_strength_backfill_disabled", targetYearMonth);
    }
    let state = null;
    try {
      state = await loadState();
    } catch (error) {
      if (error?.code === "tourism_demand_strength_state_unavailable") {
        return { ...unavailableProjection({ running: false }), targetYearMonth };
      }
      throw error;
    }
    if (state.manualReservation) {
      throw schedulerConflict(
        "tourism_demand_strength_manual_active",
        "수동 관광 수요 강도 수집 예약이 진행 중입니다."
      );
    }
    const collectorStatus = await Promise.resolve().then(() => collector.status()).catch(() => null);
    const demandStrengthSource = (collectorStatus?.sources || []).find((source) => source?.key === "demandStrength");
    if (demandStrengthSource?.status !== "ready") {
      const reason = `demand_strength_source_${demandStrengthSource?.status || "unavailable"}`;
      state.lastRun = {
        at: checkedAt.toISOString(),
        status: "blocked",
        reason,
        targetYearMonth,
        trigger,
        sourceStatus: String(demandStrengthSource?.status || "unavailable")
      };
      state = await persist(state);
      return resultEnvelope(state, "blocked", reason, targetYearMonth);
    }
    const regionMap = await collector.readRegionMap();
    const regions = eligibleRegions(regionMap);
    state.eligibleRegionCount = regions.length;
    if (!regions.length) {
      state.lastRun = { at: checkedAt.toISOString(), status: "blocked", reason: "no_eligible_regions", targetYearMonth, trigger };
      state = await persist(state);
      return resultEnvelope(state, "blocked", "no_eligible_regions", targetYearMonth);
    }

    const fingerprint = collectionFingerprint(regionMap, demandStrengthSource);
    const previousFingerprint = state.planFingerprint;
    const fingerprintMissingOnExistingWork = !state.planFingerprint && Boolean(
      state.plan
      || state.initialCompletedAt
      || state.monthlyCompletedThrough
      || Object.keys(state.failures || {}).length
      || Object.keys(state.terminalMissing || {}).length
    );
    if (fingerprintMissingOnExistingWork || (state.planFingerprint && !fingerprintMatches(state.planFingerprint, fingerprint))) {
      const grantSancheongLatestRecovery = shouldGrantSancheongLatestRecovery(previousFingerprint, fingerprint);
      state.phase = "initial_backfill";
      state.initialTargetYearMonth = targetYearMonth;
      state.initialCompletedAt = "";
      state.monthlyCompletedThrough = "";
      state.plan = null;
      state.failures = {};
      state.terminalMissing = {};
      state.inFlight = null;
      state.recoveryPermit = grantSancheongLatestRecovery
        ? sancheongLatestRecoveryPermit(targetYearMonth, now().toISOString())
        : null;
    }
    state.planFingerprint = fingerprint;

    const attached = attachPlan(state, planForState(state, regions, targetYearMonth), regions, fingerprint);
    state = attached.state;
    if (attached.upToDate) {
      state.lastRun = { at: checkedAt.toISOString(), status: "up_to_date", reason: "latest_closed_month_available", targetYearMonth, trigger };
      state = await persist(state);
      return resultEnvelope(state, "up_to_date", "latest_closed_month_available", targetYearMonth);
    }
    state = await persist(state);

    const items = attached.items;
    const progress = {
      inspectedItems: 0,
      cacheReusedItems: 0,
      networkAttemptedItems: 0,
      networkCompletedItems: 0,
      failedItems: 0,
      sameDaySkippedItems: 0,
      terminalMissingItems: 0,
      terminalSkippedItems: 0
    };

    for (let index = state.plan.cursor; index < items.length; index += 1) {
      const item = items[index];
      progress.inspectedItems += 1;
      if (state.terminalMissing[item.key]) {
        state.plan.cursor = index + 1;
        progress.terminalSkippedItems += 1;
        state = await persist(state);
        continue;
      }
      let inspection = null;
      try {
        inspection = await collector.collectDemandStrength(cacheReadInput(item));
      } catch {
        inspection = null;
      }
      if (inspection && historyHasCompleteItem(inspection, item)) {
        if (state.recoveryPermit?.status === "available" && state.recoveryPermit.pairKey === item.key) {
          const recoveryClosure = await claimSancheongLatestRecovery(item, "satisfied_from_cache");
          const priorNetworkClaim = !recoveryClosure.claimed && recoveryClosure.existingMode === "network";
          state.recoveryPermit = {
            ...state.recoveryPermit,
            status: priorNetworkClaim ? "consumed" : "satisfied_from_cache",
            usedCalls: priorNetworkClaim ? CALLS_PER_WORK_ITEM : 0,
            reportedActualCalls: null,
            claimedAt: now().toISOString(),
            outcome: priorNetworkClaim ? "claim_present_with_complete_cache" : "complete_cache",
            reason: recoveryClosure.reason,
            completedAt: now().toISOString()
          };
        }
        delete state.failures[item.key];
        delete state.terminalMissing[item.key];
        if (state.inFlight?.key === item.key) {
          const reservedForItem = Math.max(0, Number(state.inFlight.callsReserved || 0));
          if (state.inFlight.kstDate === state.dailyBudget.kstDate) {
            state.dailyBudget.reservedCalls = Math.max(0, state.dailyBudget.reservedCalls - reservedForItem);
            state.dailyBudget.usedCalls += reservedForItem;
            state.dailyBudget.reservedWorkItems = Math.max(0, state.dailyBudget.reservedWorkItems - 1);
          }
          state.inFlight = null;
        }
        state.plan.cursor = index + 1;
        state.totals.cacheReusedItems += 1;
        progress.cacheReusedItems += 1;
        state = await persist(state);
        continue;
      }

      const today = kstDateKey(now());
      if (state.dailyBudget.kstDate !== today) {
        state.lastRun = {
          at: now().toISOString(),
          status: "date_rollover",
          reason: "kst_daily_budget_date_changed",
          targetYearMonth,
          trigger,
          progress
        };
        state = await persist(state);
        return resultEnvelope(state, "date_rollover", "kst_daily_budget_date_changed", targetYearMonth, progress);
      }
      const previousFailure = state.failures[item.key];
      const reservedBeforeRestart = state.inFlight?.key === item.key && state.inFlight?.kstDate === today;
      if (reservedBeforeRestart || previousFailure?.lastAttemptKstDate === today) {
        if (reservedBeforeRestart) {
          const previousAttempts = Math.max(0, Number(previousFailure?.attempts || 0));
          const attempts = previousFailure?.lastAttemptKstDate === today
            ? Math.max(1, previousAttempts)
            : previousAttempts + 1;
          const lastAt = state.inFlight.reservedAt || now().toISOString();
          if (attempts >= MAX_DISTINCT_DAY_ATTEMPTS) {
            state.terminalMissing[item.key] = {
              reason: previousFailure?.reason || "reserved_before_restart",
              attempts,
              lastAt
            };
            delete state.failures[item.key];
            state.totals.terminalMissingItems += 1;
            progress.terminalMissingItems += 1;
          } else {
            state.failures[item.key] = {
              attempts,
              lastAttemptAt: lastAt,
              lastAttemptKstDate: today,
              reason: previousFailure?.reason || "reserved_before_restart"
            };
          }
          state.inFlight = null;
        }
        state.plan.cursor = index + 1;
        progress.sameDaySkippedItems += 1;
        state = await persist(state);
        continue;
      }

      const budget = publicBudget(state.dailyBudget);
      const recoveryPermitAvailable = state.recoveryPermit?.status === "available"
        && state.recoveryPermit.id === SANCHEONG_LATEST_RECOVERY_ID
        && state.recoveryPermit.normalizerVersion === fingerprint.demandStrengthNormalizer
        && state.recoveryPermit.regionKey === SANCHEONG_REGION_KEY
        && state.recoveryPermit.yearMonth === targetYearMonth
        && state.recoveryPermit.pairKey === item.key
        && Number(state.recoveryPermit.maxCalls || 0) === CALLS_PER_WORK_ITEM;
      const authorizedBudgetExhausted = budget.limitCalls === DEFAULT_DAILY_CALL_BUDGET
        && budget.usedCalls + budget.reservedCalls === DEFAULT_DAILY_CALL_BUDGET
        && budget.remainingCalls === 0;
      let usingRecoveryPermit = false;
      if (authorizedBudgetExhausted && recoveryPermitAvailable) {
        const recoveryClaim = await claimSancheongLatestRecovery(item, "network");
        if (recoveryClaim.claimed) {
          usingRecoveryPermit = true;
          state.recoveryPermit = {
            ...state.recoveryPermit,
            status: "claimed",
            reservedCalls: 0,
            usedCalls: CALLS_PER_WORK_ITEM,
            reportedActualCalls: null,
            claimedAt: now().toISOString(),
            outcome: "pending",
            reason: ""
          };
        } else {
          state.recoveryPermit = {
            ...state.recoveryPermit,
            status: "consumed",
            reservedCalls: 0,
            usedCalls: CALLS_PER_WORK_ITEM,
            reportedActualCalls: null,
            claimedAt: now().toISOString(),
            completedAt: now().toISOString(),
            outcome: "claim_present",
            reason: recoveryClaim.reason
          };
          state = await persist(state);
        }
      }
      if (budget.remainingCalls < CALLS_PER_WORK_ITEM && !usingRecoveryPermit) {
        state.lastRun = {
          at: now().toISOString(),
          status: "budget_exhausted",
          reason: "daily_call_budget_exhausted",
          targetYearMonth,
          trigger,
          progress
        };
        state = await persist(state);
        return resultEnvelope(state, "budget_exhausted", "daily_call_budget_exhausted", targetYearMonth, progress);
      }

      if (!usingRecoveryPermit && recoveryPermitAvailable) {
        const recoveryClosure = await claimSancheongLatestRecovery(item, "satisfied_from_daily_budget");
        const priorNetworkClaim = !recoveryClosure.claimed && recoveryClosure.existingMode === "network";
        state.recoveryPermit = {
          ...state.recoveryPermit,
          status: priorNetworkClaim ? "consumed" : "satisfied_from_daily_budget",
          usedCalls: priorNetworkClaim ? CALLS_PER_WORK_ITEM : 0,
          reportedActualCalls: null,
          claimedAt: now().toISOString(),
          outcome: priorNetworkClaim ? "claim_present_before_daily_budget" : "daily_budget_available",
          reason: recoveryClosure.reason,
          completedAt: now().toISOString()
        };
      }

      if (!usingRecoveryPermit) {
        state.dailyBudget.reservedCalls += CALLS_PER_WORK_ITEM;
        state.dailyBudget.reservedWorkItems += 1;
      }
      state.inFlight = {
        key: item.key,
        regionKey: item.regionKey,
        yearMonth: item.yearMonth,
        callsReserved: usingRecoveryPermit ? 0 : CALLS_PER_WORK_ITEM,
        kstDate: today,
        reservedAt: now().toISOString(),
        funding: usingRecoveryPermit ? "sancheong_latest_recovery" : "daily_budget"
      };
      state.totals.networkAttemptedItems += 1;
      progress.networkAttemptedItems += 1;
      state = await persist(state);

      let collected = null;
      let collectionError = null;
      let failureReason = "demand_strength_collection_failed";
      try {
        collected = await collector.collectDemandStrength(networkInput(item));
        failureReason = historyFailureReason(collected);
      } catch (error) {
        collectionError = error;
        failureReason = error?.message || failureReason;
      }
      const actualCalls = operationCallsAttempted(collected);
      if (usingRecoveryPermit) {
        state.recoveryPermit = {
          ...state.recoveryPermit,
          status: "consumed",
          reservedCalls: 0,
          usedCalls: CALLS_PER_WORK_ITEM,
          reportedActualCalls: collectionError ? null : actualCalls,
          outcome: collectionError ? "error" : "incomplete",
          reason: failureReason,
          completedAt: now().toISOString()
        };
      } else if (!collectionError) {
        state.dailyBudget.reservedCalls = Math.max(0, state.dailyBudget.reservedCalls - CALLS_PER_WORK_ITEM);
        state.dailyBudget.usedCalls += actualCalls;
        state.dailyBudget.reservedWorkItems = Math.max(0, state.dailyBudget.reservedWorkItems - 1);
      }
      const complete = Boolean(collected && historyHasCompleteItem(collected, item));
      if (complete) {
        if (usingRecoveryPermit) {
          state.recoveryPermit.status = "succeeded";
          state.recoveryPermit.outcome = "complete";
          state.recoveryPermit.reason = "";
        }
        delete state.failures[item.key];
        state.totals.networkCompletedItems += 1;
        progress.networkCompletedItems += 1;
      } else {
        const previousAttempts = Number(state.failures[item.key]?.attempts || 0);
        const attempts = previousAttempts + 1;
        const lastAt = now().toISOString();
        if (attempts >= MAX_DISTINCT_DAY_ATTEMPTS) {
          state.terminalMissing[item.key] = { reason: failureReason, attempts, lastAt };
          delete state.failures[item.key];
          state.totals.terminalMissingItems += 1;
          progress.terminalMissingItems += 1;
        } else {
          state.failures[item.key] = {
            attempts,
            lastAttemptAt: lastAt,
            lastAttemptKstDate: today,
            reason: failureReason
          };
        }
        state.totals.failedItems += 1;
        progress.failedItems += 1;
      }
      state.inFlight = null;
      state.plan.cursor = index + 1;
      state = await persist(state);
    }

    const failureCount = Object.keys(state.failures).length;
    if (failureCount) {
      state.plan.retryOnly = true;
      state.plan.cursor = 0;
      state.plan.pass = Math.max(1, Number(state.plan.pass || 1)) + 1;
      const status = progress.networkAttemptedItems === 0 && progress.sameDaySkippedItems > 0 ? "cooldown" : "partial";
      const reason = status === "cooldown" ? "failed_items_already_attempted_today" : "failed_or_partial_items_remain";
      state.lastRun = {
        at: now().toISOString(),
        status,
        reason,
        targetYearMonth,
        trigger,
        remainingFailureCount: failureCount,
        progress
      };
      state = await persist(state);
      return resultEnvelope(state, status, reason, targetYearMonth, progress);
    }
    return finishPlan(state, targetYearMonth, progress);
  }

  function runOnce(options = {}) {
    if (manualMutationActive || hasCurrentManualReservation()) {
      throw schedulerConflict(
        "tourism_demand_strength_manual_active",
        "수동 관광 수요 강도 수집 예약이 진행 중입니다."
      );
    }
    if (activePromise) {
      if (options.rejectIfRunning) {
        const error = new Error("관광 수요 강도 백필을 이미 실행하고 있습니다.");
        error.statusCode = 409;
        error.code = "tourism_demand_strength_backfill_busy";
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

  async function beginManualReservation(input = {}) {
    const reservation = reservationInput(input);
    if (activePromise) {
      throw schedulerConflict(
        "tourism_demand_strength_scheduler_active",
        "자동 관광 수요 강도 백필이 진행 중입니다."
      );
    }
    if (manualMutationActive || hasCurrentManualReservation()) {
      throw schedulerConflict(
        "tourism_demand_strength_manual_active",
        "다른 수동 관광 수요 강도 수집 예약이 진행 중입니다."
      );
    }
    manualMutationActive = true;
    try {
      let state = await loadState();
      if (activePromise) {
        throw schedulerConflict(
          "tourism_demand_strength_scheduler_active",
          "자동 관광 수요 강도 백필이 진행 중입니다."
        );
      }
      if (state.manualReservation) {
        throw schedulerConflict(
          "tourism_demand_strength_manual_active",
          "다른 수동 관광 수요 강도 수집 예약이 진행 중입니다."
        );
      }
      const budget = publicBudget(state.dailyBudget);
      if (budget.remainingCalls < reservation.requestedCalls) {
        const error = new Error("당일 관광 수요 강도 API 호출 예산이 부족합니다.");
        error.statusCode = 429;
        error.code = "tourism_demand_strength_daily_quota_exceeded";
        throw error;
      }
      const reservationId = crypto.randomUUID();
      state.dailyBudget.reservedCalls += reservation.requestedCalls;
      state.dailyBudget.reservedWorkItems += reservation.reservedWorkItems;
      state.manualReservation = {
        id: reservationId,
        kstDate: state.dailyBudget.kstDate,
        requestedCalls: reservation.requestedCalls,
        reservedCalls: reservation.requestedCalls,
        reservedWorkItems: reservation.reservedWorkItems,
        createdAt: now().toISOString()
      };
      state = await persist(state);
      runtimeOwnsManualReservation = true;
      syncManualReservation(state);
      return {
        ok: true,
        status: "manual_reserved",
        reservationId,
        requestedCalls: reservation.requestedCalls,
        maxPagesPerOperation: reservation.maxPagesPerOperation,
        ...publicSchedulerProjection(state, { nextCheckAt, running: false }),
        budget: publicBudget(state.dailyBudget)
      };
    } finally {
      manualMutationActive = false;
    }
  }

  async function finishManualReservation(input = {}) {
    if (activePromise) {
      throw schedulerConflict(
        "tourism_demand_strength_scheduler_active",
        "자동 관광 수요 강도 백필이 진행 중입니다."
      );
    }
    if (manualMutationActive) {
      throw schedulerConflict(
        "tourism_demand_strength_manual_active",
        "수동 관광 수요 강도 예약 상태를 변경하고 있습니다."
      );
    }
    manualMutationActive = true;
    try {
      let state = await loadState();
      const activeReservation = state.manualReservation;
      const staleReservation = Object.values(state.staleManualReservations || {})
        .find((reservation) => reservationIdMatches(reservation?.id, input.reservationId)) || null;
      const current = activeReservation && reservationIdMatches(activeReservation.id, input.reservationId)
        ? activeReservation
        : staleReservation;
      if (!current) {
        throw schedulerConflict(
          "tourism_demand_strength_manual_reservation_not_found",
          "유효한 당일 수동 수집 예약을 찾을 수 없습니다."
        );
      }
      const hasActualCalls = Object.prototype.hasOwnProperty.call(input, "actualCalls");
      const requestedActualCalls = hasActualCalls
        ? Number(input.actualCalls)
        : (input.failed ? current.reservedCalls : NaN);
      if (!Number.isInteger(requestedActualCalls) || requestedActualCalls < 0) {
        const error = new Error("실제 API 호출 수는 0 이상의 정수여야 합니다.");
        error.statusCode = 400;
        error.code = "tourism_demand_strength_manual_actual_calls_invalid";
        throw error;
      }
      if (requestedActualCalls > current.reservedCalls) {
        const error = new Error("실제 호출 수가 예약한 최대 호출 수를 초과했습니다.");
        error.statusCode = 400;
        error.code = "tourism_demand_strength_manual_actual_calls_exceeded";
        throw error;
      }
      const pairKeys = completedPairKeys(input.completedPairs, current.reservedWorkItems);
      const lateSettlement = Boolean(staleReservation);
      if (!lateSettlement) {
        state.dailyBudget.reservedCalls = Math.max(
          0,
          state.dailyBudget.reservedCalls - current.reservedCalls
        );
        state.dailyBudget.reservedWorkItems = Math.max(
          0,
          state.dailyBudget.reservedWorkItems - current.reservedWorkItems
        );
        state.manualReservation = null;
      } else {
        delete state.staleManualReservations[current.id];
      }
      state.dailyBudget.usedCalls += requestedActualCalls;
      let clearedTerminalMissingPairCount = 0;
      for (const key of pairKeys) {
        if (state.terminalMissing[key]) {
          delete state.terminalMissing[key];
          clearedTerminalMissingPairCount += 1;
        }
      }
      state = await persist(state);
      if (reservationIdMatches(manualActiveReservationId, input.reservationId)) {
        runtimeOwnsManualReservation = false;
      }
      syncManualReservation(state);
      return {
        ok: !input.failed,
        status: lateSettlement
          ? (input.failed ? "manual_late_failed_settled" : "manual_late_settled")
          : (input.failed ? "manual_failed_settled" : "manual_settled"),
        actualCalls: requestedActualCalls,
        clearedTerminalMissingPairCount,
        ...publicSchedulerProjection(state, { nextCheckAt, running: false }),
        budget: publicBudget(state.dailyBudget)
      };
    } finally {
      manualMutationActive = false;
    }
  }

  async function status() {
    let state = null;
    try {
      state = await loadState();
    } catch (error) {
      if (error?.code === "tourism_demand_strength_state_unavailable") {
        return {
          enabled,
          ...unavailableProjection({ running: Boolean(activePromise) }),
          checkIntervalMs,
          startupDelayMs,
          source: null,
          policy: {
            persistentState: true,
            failClosedStateRecovery: true,
            dailyCallBudgetSharedWithManualCollection: true
          }
        };
      }
      throw error;
    }
    const [collectorStatus, regionMap] = await Promise.all([
      Promise.resolve().then(() => collector.status()).catch(() => null),
      Promise.resolve().then(() => collector.readRegionMap()).catch(() => null)
    ]);
    const demandStrengthSource = (collectorStatus?.sources || []).find((source) => source?.key === "demandStrength") || null;
    const currentEligibleRegionCount = regionMap
      ? eligibleRegions(regionMap).length
      : state.eligibleRegionCount;
    return {
      enabled,
      ...publicSchedulerProjection(state, {
        eligibleRegionCount: currentEligibleRegionCount,
        nextCheckAt,
        running: Boolean(activePromise),
        manualActive: hasCurrentManualReservation()
      }),
      checkIntervalMs,
      startupDelayMs,
      budget: publicBudget(state.dailyBudget),
      plan: publicPlan(state.plan),
      source: demandStrengthSource ? {
        key: "demandStrength",
        status: String(demandStrengthSource.status || "unavailable"),
        serviceKeyConfigured: Boolean(demandStrengthSource.serviceKeyConfigured),
        endpointConfigured: Boolean(demandStrengthSource.endpointConfigured),
        adapter: String(demandStrengthSource.adapter || demandStrengthSource.version || ""),
        normalizerVersion: String(demandStrengthSource.normalizerVersion || "")
      } : null,
      policy: {
        persistentState: true,
        sancheongFullHistoryFirst: true,
        allRegionsMonthByMonthNewestFirst: true,
        eligibleKtoSigunguCodeRequired: true,
        eligibleKtoSidoCodeRequired: true,
        callsPerRegionMonth: CALLS_PER_WORK_ITEM,
        cacheInspectedBeforeBudgetReservation: true,
        maxPagesPerOperation: 1,
        sameDayBudgetEnforced: true,
        collectorOwnsGoodCacheProtection: true,
        maxDistinctDayAttempts: MAX_DISTINCT_DAY_ATTEMPTS,
        terminalMissingIsNotZero: true,
        sancheongLatestRecoveryPermit: true,
        dailyCallBudgetSharedWithManualCollection: true,
        failClosedStateRecovery: true,
        initialBackfillMonths: INITIAL_BACKFILL_MONTHS,
        monthlySupplementUsesLatestClosedMonth: true
      }
    };
  }

  function schedule(delayMs) {
    if (!enabled || !started || timer) return;
    nextCheckAt = new Date(now().getTime() + delayMs).toISOString();
    timer = setTimeoutFn(async () => {
      timer = null;
      nextCheckAt = "";
      try {
        const result = await runOnce({ trigger: "schedule" });
        if (!result.ok && !["budget_exhausted", "cooldown", "date_rollover", "disabled"].includes(result.status)) {
          logger.warn?.(`Tourism demand strength backfill: ${result.status} (${result.reason || "unknown"})`);
        }
      } catch (error) {
        logger.warn?.(`Tourism demand strength backfill failed: ${error?.message || error}`);
      } finally {
        schedule(checkIntervalMs);
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start() {
    if (manualMutationActive || hasCurrentManualReservation()) {
      throw schedulerConflict(
        "tourism_demand_strength_manual_active",
        "수동 관광 수요 강도 수집 예약이 진행 중입니다."
      );
    }
    started = true;
    schedule(startupDelayMs);
    return { enabled, nextCheckAt };
  }

  function stop() {
    started = false;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    nextCheckAt = "";
  }

  return {
    start,
    stop,
    runOnce,
    status,
    beginManualReservation,
    finishManualReservation
  };
}

module.exports = {
  STATE_VERSION,
  DEFAULT_DAILY_CALL_BUDGET,
  CALLS_PER_WORK_ITEM,
  INITIAL_BACKFILL_MONTHS,
  MAX_DISTINCT_DAY_ATTEMPTS,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  SANCHEONG_REGION_KEY,
  SANCHEONG_LATEST_RECOVERY_ID,
  SANCHEONG_LATEST_RECOVERY_NORMALIZER_VERSION,
  kstDateKey,
  latestClosedYearMonth,
  eligibleRegions,
  initialWorkItems,
  monthlyWorkItems,
  historyHasCompleteItem,
  createDemandStrengthBackfillScheduler
};
