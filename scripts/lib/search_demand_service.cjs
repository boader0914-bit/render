"use strict";

const crypto = require("node:crypto");
const { normalizeKeyword, dateValid, monthValid, dayFromIso, monthRange, stableStringify } = require("./search_demand_model.cjs");
const { buildSearchDemandForecast, forecastFingerprint } = require("./search_demand_forecast.cjs");

const known = value => typeof value === "number" && Number.isFinite(value);
const shiftDay = (day, offset) => new Date(Date.parse(day + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
const valueOf = count => count?.state === "number" && known(count.value) ? count.value : null;
const emptyCount = () => ({ state: "unknown", value: null, raw: null, lowerBound: null, upperBoundExclusive: null });
const safeCode = error => /^SEARCH_DEMAND_[A-Z0-9_]{1,100}$/.test(error?.code || "") ? error.code : "SEARCH_DEMAND_UNAVAILABLE";
const csvCell = value => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
const countLabel = count => count?.state === "number" ? count.value : count?.state === "range"
  ? count.raw || (count.lowerBound > 0 ? `${count.lowerBound} 이상 ${count.upperBoundExclusive} 미만` : `<${count.upperBoundExclusive}`) : null;
function completedWeek(day) {
  const weekday = new Date(day + "T00:00:00Z").getUTCDay();
  const currentMonday = shiftDay(day, -((weekday + 6) % 7));
  return { from: shiftDay(currentMonday, -7), to: shiftDay(currentMonday, -1) };
}
function relatedDifference(before, after) {
  if (!after) return { status: "missing_after", newlyObserved: null, repeated: null, notObservedAgain: null, rows: [] };
  if (!before) return { status: "missing_baseline", newlyObserved: null, repeated: null, notObservedAgain: null, rows: [] };
  const old = new Map(before.observations.map(row => [row.keywordId, row]));
  const current = new Map(after.observations.map(row => [row.keywordId, row]));
  const ids = [...new Set([...old.keys(), ...current.keys()])];
  const rows = ids.map(keywordId => {
    const a = old.get(keywordId), b = current.get(keywordId);
    return { keywordId, keyword: (b || a).keyword, status: !a ? "newly_observed" : !b ? "not_observed_again" : "repeated",
      before: a ? { monthlyPc: a.monthlyPc, monthlyMobile: a.monthlyMobile, total: a.total } : null,
      after: b ? { monthlyPc: b.monthlyPc, monthlyMobile: b.monthlyMobile, total: b.total } : null,
      change: changes(b?.total, a?.total) };
  });
  return { status: "available", beforeSnapshotId: before.snapshotId, afterSnapshotId: after.snapshotId,
    beforeObservedAt: before.observedAt, afterObservedAt: after.observedAt,
    newlyObserved: rows.filter(row => row.status === "newly_observed").length,
    repeated: rows.filter(row => row.status === "repeated").length,
    notObservedAgain: rows.filter(row => row.status === "not_observed_again").length,
    definition: "appearance_in_saved_responses_not_creation_or_disappearance", rows };
}
function changes(current, previous) {
  const a = valueOf(current), b = valueOf(previous);
  return { status: a === null || b === null ? "missing" : b === 0 ? "zero_base" : "available", absolute: a === null || b === null ? null : a - b,
    percent: a === null || b === null || b === 0 ? null : (a - b) / b };
}
function selectedInput(input, clock) {
  const today = dayFromIso(new Date(clock()).toISOString());
  const day = input.day || today, month = input.month || day.slice(0, 7);
  if (!dateValid(day) || day > today || !monthValid(month)) throw Object.assign(new Error(), { code: "SEARCH_DEMAND_INVALID_REQUEST", statusCode: 400 });
  return { ...input, keyword: normalizeKeyword(input.keyword).keyword, day, month };
}

function createSearchDemandService({ store, readRegisteredKeywords = async () => [], scheduler = null, clock = Date.now } = {}) {
  if (!store || typeof store.getAnalysis !== "function" || typeof store.readLatest !== "function" || typeof store.listDaily !== "function") throw new TypeError("Search demand store required");
  const refreshStatus = () => {
    const saved = scheduler?.status?.() || { enabled: false, started: false, running: false, lastReason: "DISABLED", timezone: "Asia/Seoul", dailyAt: "09:30", monthlyDay: 2, monthlyAt: "08:30" };
    return { ...saved, status: saved.enabled === false ? "disabled" : saved.running === true ? "running" : "waiting" };
  };
  async function catalog() {
    const registered = await readRegisteredKeywords();
    if (!Array.isArray(registered) || registered.length > 100) throw Object.assign(new Error(), { code: "SEARCH_DEMAND_CATALOG_UNAVAILABLE" });
    const saved = typeof store.listKeywords === "function" ? await store.listKeywords() : [];
    const merged = new Map();
    for (const item of registered) { const row = normalizeKeyword(typeof item === "string" ? item : item.keyword); merged.set(row.keywordId, { keyword: row.keyword, keywordId: row.keywordId, kind: "anchor", registered: true, hasSavedData: false }); }
    for (const item of saved) {
      const row = normalizeKeyword(item.keyword), existing = merged.get(row.keywordId);
      merged.set(row.keywordId, { keyword: row.keyword, keywordId: row.keywordId, kind: "anchor", registered: Boolean(existing?.registered), hasSavedData: true,
        firstObservedAt: item.firstObservedAt || null, lastObservedAt: item.lastObservedAt || null });
    }
    return { schemaVersion: 1, status: "available", currentDay: dayFromIso(new Date(clock()).toISOString()), keywords: [...merged.values()], scheduler: refreshStatus(), readOnly: true, networkAttempted: false };
  }
  async function sources(input) {
    const [searchSnapshot, trendSnapshot] = await Promise.all([store.readLatest({ provider: "searchad", keyword: input.keyword, asOfDay: input.day }), store.readLatest({ provider: "datalab", keyword: input.keyword, asOfDay: input.day })]);
    return { searchSnapshot, trendSnapshot };
  }
  async function analysisForecast(input, source) {
    const records = typeof store.listForecasts === "function" ? await store.listForecasts({ keyword: input.keyword, month: input.month, day: input.day, limit: 100 }) : [];
    const rows = Array.isArray(records) ? records : records?.rows || records?.items || [];
    const record = rows.filter(row => row.targetMonth === input.month && row.status === "verified" && Date.parse(row.calculatedAt) <= Date.parse(input.day + "T14:59:59.999Z"))
      .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
    if (record) return { ...record, published: true, preview: false };
    const preview = buildSearchDemandForecast({ keyword: input.keyword, ...source, targetMonth: input.month,
      calculatedAt: input.day === dayFromIso(new Date(clock()).toISOString()) ? new Date(clock()).toISOString() : input.day + "T14:59:59.999Z" });
    return { ...preview, published: false, preview: preview.status === "verified", publicationStatus: "not_published" };
  }
  async function forecastHistory(input) {
    const found = typeof store.listForecasts === "function" ? await store.listForecasts({ keyword: input.keyword, month: input.month, day: input.day, limit: 100 }) : { rows: [], total: 0, truncated: false };
    return { rows: Array.isArray(found) ? found : found.rows || [], total: Array.isArray(found) ? found.length : found.total,
      truncated: found.truncated === true };
  }
  const evaluation = () => ({ status: "held", reasonCode: "COMPARABLE_CALENDAR_OBSERVATION_UNAVAILABLE",
    mae: null, mape: null, definition: "same_target_month_metric_and_data_cutoff_required",
    note: "최근 월간 검색량 관측을 달 전체의 확정 실적으로 바꾸지 않으며, 같은 정의의 사후 관측이 없어 정확도 평가는 보류합니다." });
  async function analyze(raw) {
    const input = selectedInput(raw, clock);
    const [analysis, source, jobs] = await Promise.all([store.getAnalysis(input), sources(input), scheduler?.history ? scheduler.history({ keyword: input.keyword, limit: 100 }) : null]);
    const anchor = source.searchSnapshot?.anchor;
    const [yesterday, lastWeek] = await Promise.all([store.listDaily({ keyword: input.keyword, from: shiftDay(input.day, -1), to: shiftDay(input.day, -1) }),
      store.listDaily({ keyword: input.keyword, from: shiftDay(input.day, -7), to: shiftDay(input.day, -7) })]);
    const list = value => Array.isArray(value) ? value : value?.rows || [];
    const exactToday = source.searchSnapshot?.day === input.day ? anchor?.total : null;
    return { ...analysis, status: source.searchSnapshot || source.trendSnapshot ? "available" : "missing", request: { keyword: input.keyword, day: input.day, month: input.month },
      comparisons: { day: changes(exactToday, list(yesterday)[0]?.total), week: changes(exactToday, list(lastWeek)[0]?.total) },
      forecast: await analysisForecast(input, source), forecastHistory: await forecastHistory(input), evaluation: evaluation(), refreshStatus: refreshStatus(), jobHistory: jobs,
      reportSummary: { searchObservedAt: source.searchSnapshot?.observedAt || null, trendObservedAt: source.trendSnapshot?.observedAt || null,
        definition: "recent_monthly_search_volume_snapshot", returnedRows: source.searchSnapshot?.counts?.returnedRows ?? null, uniqueRows: source.searchSnapshot?.counts?.uniqueRows ?? null },
      readOnly: true, networkAttempted: false };
  }
  async function report(raw) {
    const input = selectedInput(raw, clock), cadence = input.cadence || "daily";
    if (!["daily", "weekly", "monthly"].includes(cadence)) throw Object.assign(new Error(), { code: "SEARCH_DEMAND_INVALID_REQUEST", statusCode: 400 });
    const range = monthRange(input.month), week = completedWeek(input.day);
    const from = cadence === "daily" ? input.day : cadence === "weekly" ? week.from : range.from;
    const to = cadence === "monthly" ? [input.day, range.to].sort()[0] : cadence === "weekly" ? week.to : input.day;
    const active = { ...input, day: to, search: "", relatedKeyword: "", page: 1, pageSize: 200 };
    const source = from <= to ? await sources(active) : { searchSnapshot: null, trendSnapshot: null };
    let rows;
    if (cadence === "daily") {
      rows = (source.searchSnapshot?.day === to ? source.searchSnapshot.observations || [] : []).map(row => ({ day: to, keyword: row.keyword,
        observedAt: source.searchSnapshot.observedAt, monthlyPc: row.monthlyPc, monthlyMobile: row.monthlyMobile, total: row.total, status: row.status,
        isAnchor: row.isAnchor === true, snapshotId: source.searchSnapshot.snapshotId }));
    } else {
      const daily = from <= to ? await store.listDaily({ keyword: input.keyword, from, to }) : [];
      const found = new Map((Array.isArray(daily) ? daily : daily?.rows || []).map(row => [row.day, row]));
      rows = [];
      for (let day = from; day <= to; day = shiftDay(day, 1)) rows.push({ day, keyword: input.keyword, ...(found.get(day) || { observedAt: null, monthlyPc: emptyCount(), monthlyMobile: emptyCount(), total: emptyCount(), status: "missing", snapshotId: null }), isAnchor: true });
    }
    if (rows.length > 10000) throw Object.assign(new Error(), { code: "SEARCH_DEMAND_REPORT_BOUNDS" });
    const representative = rows.filter(row => row.isAnchor && row.status !== "missing" && valueOf(row.total) !== null).at(-1) || null;
    const [previous, jobHistory] = await Promise.all([
      from <= to ? store.readLatest({ provider: "searchad", keyword: input.keyword, asOfDay: shiftDay(from, -1) }) : null,
      scheduler?.history ? scheduler.history({ keyword: input.keyword, limit: 100 }) : null
    ]);
    const periodJobs = (jobHistory?.items || []).filter(row => {
      const stamp = row.scheduledAt || row.createdAt;
      if (!stamp || !Number.isFinite(Date.parse(stamp))) return false;
      const day = dayFromIso(stamp); return from <= day && day <= to;
    });
    const knownRequests = periodJobs.filter(row => Number.isSafeInteger(row.requestCount) && row.requestCount >= 0);
    const requestMetrics = { knownJobCount: knownRequests.length, unknownJobCount: periodJobs.length - knownRequests.length,
      knownRequestCountSubtotal: knownRequests.length ? knownRequests.reduce((sum, row) => sum + row.requestCount, 0) : null,
      completeCoverage: jobHistory?.status === "ready" && jobHistory.truncated === false && periodJobs.length > 0 && knownRequests.length === periodJobs.length,
      countBasis: "cumulative_attempts_of_jobs_grouped_by_scheduled_period",
      actualPeriodRequestCount: null, actualPeriodRequestCountStatus: "unverified_no_per_attempt_counter_history",
      scope: "saved_search_api_jobs_for_selected_anchor_and_scheduled_period_not_account_quota" };
    const created = new Date(clock()).toISOString();
    const counts = { rows: rows.length, known: rows.filter(row => valueOf(row.total) !== null).length, missing: rows.filter(row => row.status === "missing").length,
      ranged: rows.filter(row => row.total?.state === "range").length };
    const result = { schemaVersion: 1, reportId: null, cadence, status: rows.some(row => row.status !== "missing") ? "available" : "missing",
      request: { keyword: input.keyword, day: input.day, month: input.month }, selection: { keyword: input.keyword, day: input.day, month: input.month },
      scope: { from, to, observationBasis: "provider_recent_monthly_snapshot", noSummationAcrossObservationDays: true,
        rangeBasis: cadence === "weekly" ? "previous_completed_monday_sunday_kst" : cadence === "monthly" ? "selected_month_through_observation_cutoff" : "selected_kst_day" }, generatedAt: created,
      summary: { ...counts, representative: representative ? { day: representative.day, observedAt: representative.observedAt, total: representative.total } : null,
        returnedRows: source.searchSnapshot?.counts?.returnedRows ?? null, uniqueRows: source.searchSnapshot?.counts?.uniqueRows ?? null,
        missingIsNotZero: true, observedAnchorDays: new Set(rows.filter(row => row.isAnchor && row.status !== "missing").map(row => row.day)).size,
        expectedObservationDays: from <= to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0 }, rows,
      relatedChanges: relatedDifference(previous, source.searchSnapshot?.day >= from ? source.searchSnapshot : null),
      jobHistory: jobHistory ? { ...jobHistory, items: periodJobs } : null, requestMetrics,
      comparisons: { pc: changes(representative?.monthlyPc, previous?.anchor?.monthlyPc), mobile: changes(representative?.monthlyMobile, previous?.anchor?.monthlyMobile),
        total: changes(representative?.total, previous?.anchor?.total) },
      trend: source.trendSnapshot ? { snapshotId: source.trendSnapshot.snapshotId, windowId: source.trendSnapshot.windowId, observedAt: source.trendSnapshot.observedAt,
        startDate: source.trendSnapshot.startDate, endDate: source.trendSnapshot.endDate, series: source.trendSnapshot.series, coverage: source.trendSnapshot.coverage, status: source.trendSnapshot.status } : null,
      forecast: from <= to ? await analysisForecast(active, source) : null, forecastHistory: await forecastHistory(active), evaluation: evaluation(), readOnly: true, networkAttempted: false };
    // Generated time does not change report identity; every material saved input does.
    result.reportId = "sdr_" + crypto.createHash("sha256").update(stableStringify({
      version: 1, cadence, request: result.request, from, to, rows,
      relatedBefore: result.relatedChanges.beforeSnapshotId || null, trend: result.trend?.snapshotId || null,
      forecast: result.forecast ? { published: result.forecast.published, forecastId: result.forecast.forecastId || null,
        status: result.forecast.status, sourceSnapshotIds: result.forecast.sourceSnapshotIds || [], targetMonth: result.forecast.targetMonth,
        reasonCode: result.forecast.reasonCode, modelVersion: result.forecast.modelVersion, value: result.forecast.value } : null,
      forecasts: result.forecastHistory.rows.map(row => row.forecastId), requestMetrics,
      jobs: periodJobs.map(row => ({ jobId: row.jobId, status: row.status, requestCount: row.requestCount, lastRequestCount: row.lastRequestCount,
        postprocessStatus: row.postprocessStatus || null, errorCode: row.errorCode || null })), historyStatus: jobHistory?.status || null, historyTruncated: jobHistory?.truncated ?? null
    })).digest("hex");
    if (raw.format === "csv") {
      const header = ["관측일(KST)", "키워드", "관측시각(UTC)", "PC 월간 검색량", "모바일 월간 검색량", "합계", "자료 상태", "기준어 여부", "근거 스냅샷", "지표 정의"];
      result.csv = [header, ...rows.map(row => [row.day, row.keyword, row.observedAt, countLabel(row.monthlyPc), countLabel(row.monthlyMobile), countLabel(row.total), row.status,
        row.isAnchor ? "기준" : "연관", row.snapshotId, "조회 시점 최근 월간 검색량; 날짜별 합산 금지"])].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
    }
    return result;
  }
  async function onSnapshotCommitted(snapshot) {
    if (!snapshot || snapshot.status !== "ready" || typeof store.saveForecast !== "function") return { status: "held", reasonCode: "FORECAST_INPUTS_PARTIAL" };
    const now = new Date(clock()).toISOString(), day = dayFromIso(now), month = day.slice(0, 7);
    const source = await sources({ keyword: snapshot.keyword, day });
    const record = buildSearchDemandForecast({ keyword: snapshot.keyword, ...source, targetMonth: month, calculatedAt: now });
    if (record.status !== "verified") return { status: "held", reasonCode: record.reasonCode };
    const prior = typeof store.listForecasts === "function" ? await store.listForecasts({ keyword: snapshot.keyword, month, limit: 100 }) : [];
    const list = Array.isArray(prior) ? prior : prior?.rows || prior?.items || [];
    if (list.some(row => forecastFingerprint(row) === forecastFingerprint(record))) return { status: "reused", reasonCode: "FORECAST_SOURCE_ALREADY_PUBLISHED" };
    const saved = await store.saveForecast(record);
    return { status: "complete", forecastId: saved?.forecastId || null };
  }
  return { catalog, analyze, report, onSnapshotCommitted };
}

module.exports = { createSearchDemandService, csvCell, changes, selectedInput, safeCode, completedWeek, relatedDifference };
