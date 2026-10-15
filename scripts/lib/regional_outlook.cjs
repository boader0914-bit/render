"use strict";

const crypto = require("node:crypto");

// Deliberately small, reproducible baselines. These are estimates of each
// source metric, never room reservations, occupancy, or sales forecasts.
const VERSION = "regional-monthly-outlook-v1";
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const DATE = /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/;
const MIN_OBSERVATIONS = 6;
const MAX_HORIZON = 3;
const MIN_VALIDATION_FOLDS = 3;
const MIN_HOLIDAY_OBSERVATIONS = 24;
const HOLIDAY_FEATURES = ["holidayOrWeekendDays", "longBreakDays"];
const FORECAST_GROUPS = new Set(["visitors", "demandStrength", "resourceDemand", "diversity", "searchTrend"]);
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const mean = values => values.reduce((sum, value) => sum + value / values.length, 0);
const shiftMonth = (period, offset) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
};
const monthDistance = (from, to) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5));
const round = value => !Number.isFinite(value) ? null : Math.abs(value) > Number.MAX_SAFE_INTEGER / 1e6 ? value : Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validDate(value) {
  if (!DATE.test(value || "")) return false;
  const parsed = new Date(value + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function normalizeRows(metric, asOfMonth, bounded) {
  const source = Array.isArray(metric.historyRows) ? metric.historyRows : Array.isArray(metric.rows) ? metric.rows : [];
  const byPeriod = new Map(), duplicates = new Set();
  for (const row of source) {
    if (!MONTH.test(row?.period || "") || row.period > asOfMonth) continue;
    if (byPeriod.has(row.period)) duplicates.add(row.period);
    byPeriod.set(row.period, { period: row.period,
      status: row.status === "observed" && numeric(row.value) && (!bounded || row.value <= 100) ? "observed" : "missing",
      value: row.status === "observed" && numeric(row.value) && (!bounded || row.value <= 100) ? row.value : null });
  }
  for (const period of duplicates) byPeriod.set(period, { period, status: "error", value: null });
  return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function normalizeCalendar(calendar) {
  const result = new Map(), duplicates = new Set();
  for (const row of Array.isArray(calendar?.months) ? calendar.months : []) {
    if (!MONTH.test(row?.period || "")) continue;
    if (result.has(row.period)) duplicates.add(row.period);
    const daysInMonth = new Date(Date.UTC(Number(row.period.slice(0, 4)), Number(row.period.slice(5)), 0)).getUTCDate();
    const validCount = value => numeric(value) && Number.isInteger(value) && value <= daysInMonth ? value : null;
    const cleanNames = values => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === "string" && value.trim()).map(value => value.trim().slice(0, 200)))].sort() : [];
    const complete = row.coverageComplete !== false && Number(row.daysInMonth) === daysInMonth &&
      [row.holidayDays, row.weekendDays, row.holidayOrWeekendDays, row.longBreakDays].every(value => validCount(value) !== null);
    const status = row.status === "ready" && complete ? "ready" : ["ready", "partial"].includes(row.status) ? "partial" : "missing";
    result.set(row.period, { period: row.period, status, daysInMonth,
      holidayDays: validCount(row.holidayDays), weekendDays: validCount(row.weekendDays),
      holidayOrWeekendDays: validCount(row.holidayOrWeekendDays), longBreakDays: validCount(row.longBreakDays),
      holidayDates: Array.isArray(row.holidayDates) ? [...new Set(row.holidayDates.filter(validDate).filter(date => date.startsWith(row.period)))].sort() : [],
      holidays: Array.isArray(row.holidays) ? row.holidays.filter(item => validDate(item?.date) && item.date.startsWith(row.period)).map(item => ({ date: item.date, names: cleanNames(item.names) })).sort((a, b) => a.date.localeCompare(b.date)) : [],
      longestRunDays: numeric(row.longestRunDays) && Number.isInteger(row.longestRunDays) && row.longestRunDays <= 370 ? row.longestRunDays : null,
      longBreaks: Array.isArray(row.longBreaks) ? row.longBreaks.filter(item => validDate(item?.start) && validDate(item?.end) && item.start <= item.end &&
        Number.isInteger(item.days) && item.days >= 3 && item.days <= 370 && validCount(item.overlapDays) !== null).map(item => ({
        start: item.start, end: item.end, days: item.days, overlapDays: item.overlapDays, names: cleanNames(item.names),
        officialHolidayDates: Array.isArray(item.officialHolidayDates) ? [...new Set(item.officialHolidayDates.filter(validDate).filter(date => date >= item.start && date <= item.end))].sort() : [],
        boundaryComplete: item.boundaryComplete === true })) : [],
      holidayEveDates: Array.isArray(row.holidayEveDates) ? row.holidayEveDates.filter(validDate).filter(date => date.startsWith(row.period)).sort() : [],
      bridgeCandidateDates: Array.isArray(row.bridgeCandidateDates) ? row.bridgeCandidateDates.filter(validDate).filter(date => date.startsWith(row.period)).sort() : [],
      coverageComplete: status === "ready", updatedAt: typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null,
      stale: row.stale === true });
  }
  for (const period of duplicates) result.set(period, { period, status: "missing", reasonCode: "DUPLICATE_CALENDAR_MONTH" });
  return result;
}

function clamp(value, bounded) {
  return Math.min(bounded ? 100 : Number.MAX_VALUE, Math.max(0, value));
}

function observedRows(rows, cutoff) {
  return rows.filter(row => row.status === "observed" && row.period <= cutoff);
}

function rawPrediction(rows, target, origin, method, bounded) {
  const observed = observedRows(rows, origin);
  if (observed.length < MIN_OBSERVATIONS) return null;
  const latest = observed.at(-1), horizon = monthDistance(latest.period, target);
  if (horizon < 1 || horizon > MAX_HORIZON) return null;
  const byPeriod = new Map(observed.map(row => [row.period, row.value]));
  if (method === "seasonal_naive") {
    const yearAgo = byPeriod.get(shiftMonth(target, -12));
    return numeric(yearAgo) ? clamp(yearAgo, bounded) : null;
  }
  const recentPeriods = [0, -1, -2].map(offset => shiftMonth(latest.period, offset));
  const recent = recentPeriods.map(period => byPeriod.get(period)).filter(numeric);
  if (recent.length < 2) return null;
  const level = mean(recent);
  if (method === "recent_level") return clamp(level, bounded);
  if (method !== "recent_trend") return null;
  const six = Array.from({ length: 6 }, (_, i) => byPeriod.get(shiftMonth(latest.period, i - 5)));
  if (!six.every(numeric)) return null;
  const previous = mean(six.slice(0, 3)), current = mean(six.slice(3));
  // A three-month average is centred one month before the latest observation.
  // The damped slope is used only if historical paired tests beat a flat level.
  return clamp(current + (current - previous) / 3 * (horizon + 1) * 0.5, bounded);
}

function score(folds, horizon) {
  const error = folds.reduce((sum, row) => sum + Math.abs(row.value - row.actual), 0);
  const denominator = folds.reduce((sum, row) => sum + Math.abs(row.actual), 0);
  return { status: folds.length >= MIN_VALIDATION_FOLDS ? "validated" : "insufficient_validation",
    folds: folds.length, horizonMonths: horizon, mae: folds.length ? round(error / folds.length) : null,
    wapePct: denominator > 0 ? round(error / denominator * 100) : null,
    firstTargetPeriod: folds[0]?.period || "", lastTargetPeriod: folds.at(-1)?.period || "",
    method: "rolling_origin", note: "검증 시점 이후의 관측값은 학습에 사용하지 않습니다. 평균오차는 보장 범위가 아닙니다." };
}

function baselineFolds(rows, horizon, method, bounded) {
  return rows.filter(row => row.status === "observed").map(row => {
    const origin = shiftMonth(row.period, -horizon);
    // An older available month is a longer forecasting horizon, not another
    // test of this horizon. Missing origins must not dilute its error summary.
    if (observedRows(rows, origin).at(-1)?.period !== origin) return null;
    const value = rawPrediction(rows, row.period, origin, method, bounded);
    return value === null ? null : { period: row.period, origin, value, actual: row.value };
  }).filter(Boolean);
}

function selectMethod(rows, target, origin, bounded) {
  const latest = observedRows(rows, origin).at(-1);
  if (!latest) return null;
  const horizon = monthDistance(latest.period, target);
  const methods = ["seasonal_naive", "recent_level", "recent_trend"].filter(method => rawPrediction(rows, target, origin, method, bounded) !== null);
  if (!methods.length) return null;
  const folds = Object.fromEntries(methods.map(method => [method, baselineFolds(rows.filter(row => row.period <= origin), horizon, method, bounded)]));
  let selected = methods.includes("seasonal_naive") ? "seasonal_naive" : "recent_level";
  // Prefer the simple seasonal baseline when there are not yet enough paired
  // historical errors. Do not compare errors from different target months.
  for (const challenger of ["recent_level", "recent_trend"]) {
    if (!methods.includes(challenger) || challenger === selected) continue;
    const paired = new Set(folds[selected].map(row => row.period));
    const other = folds[challenger].filter(row => paired.has(row.period));
    if (other.length < MIN_VALIDATION_FOLDS) continue;
    const periods = new Set(other.map(row => row.period));
    const current = folds[selected].filter(row => periods.has(row.period));
    const currentError = current.reduce((sum, row) => sum + Math.abs(row.value - row.actual), 0);
    const otherError = other.reduce((sum, row) => sum + Math.abs(row.value - row.actual), 0);
    if (otherError < currentError * 0.9) selected = challenger;
  }
  return { method: selected, value: rawPrediction(rows, target, origin, selected, bounded), validation: score(folds[selected], horizon), horizon };
}

function holidayFeature(calendar, target, feature) {
  const current = calendar.get(target), previous = calendar.get(shiftMonth(target, -12));
  if (current?.status !== "ready" || previous?.status !== "ready" || !numeric(current[feature]) || !numeric(previous[feature])) return null;
  // The union of weekends and official holidays prevents double-counting a
  // holiday that falls on a weekend. A feature may also represent long breaks.
  return current[feature] / current.daysInMonth - previous[feature] / previous.daysInMonth;
}

function fitHoliday(rows, origin, calendar, feature) {
  const observed = observedRows(rows, origin);
  if (observed.length < MIN_HOLIDAY_OBSERVATIONS) return null;
  const byPeriod = new Map(observed.map(row => [row.period, row.value]));
  const pairs = observed.map(row => {
    const previous = byPeriod.get(shiftMonth(row.period, -12)), x = holidayFeature(calendar, row.period, feature);
    return numeric(previous) && x !== null ? { x, residual: row.value - previous } : null;
  }).filter(Boolean);
  if (pairs.length < 12 || pairs.filter(row => Math.abs(row.x) > 1e-9).length < 6) return null;
  const denominator = pairs.reduce((sum, row) => sum + row.x * row.x, 0);
  if (denominator < 1e-8) return null;
  const coefficient = pairs.reduce((sum, row) => sum + row.x * row.residual, 0) / denominator;
  return Number.isFinite(coefficient) ? { coefficient, pairs: pairs.length, feature } : null;
}

function holidayCandidate(rows, target, origin, calendar, feature, bounded) {
  const baseline = rawPrediction(rows, target, origin, "seasonal_naive", bounded);
  const model = fitHoliday(rows, origin, calendar, feature), x = holidayFeature(calendar, target, feature);
  return baseline === null || !model || x === null ? null : { ...model, value: clamp(baseline + model.coefficient * x, bounded), baseline };
}

function holidayResult(rows, target, origin, baseline, calendar, bounded) {
  const current = calendar.get(target);
  const context = { status: current?.status || "missing", adjustmentApplied: false, baselineValue: round(baseline.value), adjustment: 0,
    reasonCode: current?.status === "ready" ? "HOLIDAY_CONTEXT_ONLY" : "HOLIDAY_CALENDAR_UNAVAILABLE", feature: "", trainingPairs: 0 };
  if (current?.status !== "ready") return { value: baseline.value, holiday: context, validation: baseline.validation };
  if (rawPrediction(rows, target, origin, "seasonal_naive", bounded) === null) return { value: baseline.value, holiday: { ...context, reasonCode: "HOLIDAY_SEASONAL_BASELINE_REQUIRED" }, validation: baseline.validation };
  if (observedRows(rows, origin).length < MIN_HOLIDAY_OBSERVATIONS) return { value: baseline.value,
    holiday: { ...context, reasonCode: "HOLIDAY_HISTORY_INSUFFICIENT" }, validation: baseline.validation };
  let selected = null;
  for (const feature of HOLIDAY_FEATURES) {
    const candidate = holidayCandidate(rows, target, origin, calendar, feature, bounded);
    if (!candidate) continue;
    const folds = rows.filter(row => row.status === "observed" && row.period <= origin).map(row => {
      const foldOrigin = shiftMonth(row.period, -baseline.horizon);
      if (observedRows(rows, foldOrigin).at(-1)?.period !== foldOrigin) return null;
      const forecast = holidayCandidate(rows, row.period, foldOrigin, calendar, feature, bounded);
      const comparison = rawPrediction(rows, row.period, foldOrigin, baseline.method, bounded);
      return forecast && comparison !== null ? { period: row.period, origin: foldOrigin, value: forecast.value, baseline: comparison, actual: row.value } : null;
    }).filter(Boolean);
    if (folds.length < MIN_VALIDATION_FOLDS) continue;
    const rawError = folds.reduce((sum, row) => sum + Math.abs(row.baseline - row.actual), 0);
    const adjustedError = folds.reduce((sum, row) => sum + Math.abs(row.value - row.actual), 0);
    if (!(adjustedError < rawError * 0.9)) continue;
    if (!selected || adjustedError / folds.length < selected.error) selected = { candidate, folds, error: adjustedError / folds.length };
  }
  if (!selected) return { value: baseline.value, holiday: { ...context, reasonCode: "HOLIDAY_EFFECT_NOT_VALIDATED" }, validation: baseline.validation };
  return { value: selected.candidate.value, holiday: { ...context, adjustmentApplied: true, adjustment: round(selected.candidate.value - baseline.value),
    feature: selected.candidate.feature, trainingPairs: selected.candidate.pairs, reasonCode: "HOLIDAY_EFFECT_VALIDATED" }, validation: score(selected.folds, baseline.horizon) };
}

function buildRegionalOutlook({ snapshot = {}, calendar = {}, asOfDate } = {}) {
  if (!validDate(asOfDate)) throw Object.assign(new Error("A valid Korea-time as-of date is required"), { code: "INVALID_AS_OF_DATE" });
  const asOfMonth = asOfDate.slice(0, 7), calendarMap = normalizeCalendar(calendar);
  const targets = [0, 1].map((offset, i) => {
    const period = shiftMonth(asOfMonth, offset);
    return { period, kind: i ? "next" : "current", label: i ? "다음 달 전망" : "이번 달 예상",
      calendar: calendarMap.get(period) || { period, status: "missing" } };
  });
  const metrics = [], fingerprintMetrics = [];
  for (const group of Array.isArray(snapshot.groups) ? snapshot.groups : []) {
    if (!FORECAST_GROUPS.has(group.key) || group.category === "background" || group.periodType !== "M") continue;
    if (!["tourism", "search"].includes(group.category)) continue;
    for (const metric of Array.isArray(group.metrics) ? group.metrics : []) {
      const bounded = group.key === "searchTrend" || metric.unit === "상대지수";
      const rows = normalizeRows(metric, asOfMonth, bounded), observed = observedRows(rows, asOfMonth), latest = observed.at(-1);
      const forecasts = targets.map(target => {
        const actual = observed.find(row => row.period === target.period);
        if (actual) return { period: target.period, kind: target.kind, label: "공식 관측", status: "observed", value: actual.value,
          method: "official_observation", reasonCode: "", validation: { status: "not_applicable", folds: 0, mae: null, wapePct: null },
          holiday: { status: target.calendar.status, adjustmentApplied: false, baselineValue: actual.value, adjustment: 0, reasonCode: "OFFICIAL_OBSERVATION" } };
        let reasonCode = !latest ? "NO_OBSERVATIONS" : observed.length < MIN_OBSERVATIONS ? "INSUFFICIENT_HISTORY" : monthDistance(latest.period, target.period) > MAX_HORIZON ? "STALE_SOURCE" : "RECENT_OBSERVATIONS_MISSING";
        const baseline = selectMethod(rows, target.period, asOfMonth, bounded);
        if (!baseline) return { period: target.period, kind: target.kind, label: target.label, status: "unavailable", value: null, method: "", reasonCode,
          validation: { status: "insufficient_validation", folds: 0, mae: null, wapePct: null },
          holiday: { status: target.calendar.status, adjustmentApplied: false, baselineValue: null, adjustment: null, reasonCode: "FORECAST_UNAVAILABLE" } };
        const result = holidayResult(rows, target.period, asOfMonth, baseline, calendarMap, bounded);
        return { period: target.period, kind: target.kind, label: target.label, status: "forecast", value: round(result.value),
          method: result.holiday.adjustmentApplied ? "seasonal_holiday" : baseline.method, reasonCode: "", horizonMonths: baseline.horizon,
          validation: result.validation, holiday: result.holiday };
      });
      metrics.push({ key: `${group.key}:${metric.key}`, metricKey: metric.key, groupKey: group.key, groupLabel: group.label,
        label: metric.label, unit: metric.unit, provider: group.provider, latestPeriod: latest?.period || "", latestValue: latest?.value ?? null,
        availableMonths: observed.length, sourceBatchId: group.sourceBatchId || "", normalizationPeriod: group.normalizationPeriod || "",
        boundedRelativeIndex: bounded, forecasts });
      fingerprintMetrics.push({ groupKey: group.key, key: metric.key, unit: metric.unit, sourceBatchId: group.sourceBatchId || "",
        normalizationPeriod: group.normalizationPeriod || "", sourceStatus: typeof group.status === "string" ? group.status : "",
        sourceErrorCode: typeof group.errorCode === "string" ? group.errorCode : "", rows });
    }
  }
  const all = metrics.flatMap(metric => metric.forecasts), available = all.filter(row => row.status !== "unavailable");
  const summary = { totalMetrics: metrics.length, total: all.length, forecast: all.filter(row => row.status === "forecast").length,
    observed: all.filter(row => row.status === "observed").length, unavailable: all.filter(row => row.status === "unavailable").length,
    holidayAdjusted: all.filter(row => row.holiday.adjustmentApplied).length,
    validated: all.filter(row => row.status === "forecast" && row.validation.status === "validated").length };
  const groups = [...new Set(metrics.map(metric => metric.groupKey))].map(key => {
    const source = snapshot.groups.find(group => group.key === key), children = metrics.filter(metric => metric.groupKey === key);
    const childTargets = children.flatMap(metric => metric.forecasts);
    const availableTargets = childTargets.filter(row => ["observed", "forecast"].includes(row.status) && numeric(row.value));
    const failedSource = ["failed", "error", "blocked"].includes(source.status);
    const status = !availableTargets.length ? failedSource ? "failed" : "missing"
      : availableTargets.length === childTargets.length && targets.every(target => target.calendar.status === "ready") && !failedSource ? "complete" : "partial";
    return { key, label: source.label, category: source.category, provider: source.provider, periodType: "M", status,
      sourceStatus: typeof source.status === "string" ? source.status : "", sourceErrorCode: typeof source.errorCode === "string" ? source.errorCode : "",
      availableTargets: availableTargets.length, expectedTargets: childTargets.length, metrics: children };
  });
  const fingerprintCalendar = [...calendarMap.values()].sort((a, b) => a.period.localeCompare(b.period)).map(({ updatedAt, ...row }) => row);
  return { modelVersion: VERSION, calculationVersion: VERSION, sourceFingerprint: hash({ version: VERSION, regionKey: snapshot.scope?.regionKey || "", asOfMonth,
    metrics: fingerprintMetrics, calendar: fingerprintCalendar }),
    asOfDate, asOfMonth, scope: { regionKey: snapshot.scope?.regionKey || "", label: snapshot.scope?.label || "", month: asOfMonth },
    status: !available.length ? "missing" : groups.every(group => group.status === "complete") ? "ready" : "partial",
    targets, groups, metrics, summary, networkAttempted: false,
    methodology: { minimumObservations: MIN_OBSERVATIONS, maximumHorizonMonths: MAX_HORIZON, minimumValidationFolds: MIN_VALIDATION_FOLDS,
      holidayMinimumObservations: MIN_HOLIDAY_OBSERVATIONS, holidayValidationImprovementPct: 10 },
    notes: ["공식 관측과 이번 달 예상·다음 달 전망을 구분합니다. 오류·누락은 0으로 채우지 않습니다.",
      "같은 달 전년값 또는 최근 관측 수준을 기준으로 계산하며, 평균 검증오차는 미래의 보장 범위가 아닙니다.",
      "공휴일·주말·연휴는 특일정보 저장 자료로 표시합니다. 충분한 이력과 과거 검증이 없으면 매출이나 수요에 임의의 가산율을 넣지 않습니다.",
      "검색 관심도는 같은 조회기간의 상대지수이며 절대 검색량·예약률·매출로 환산하지 않습니다. 인구·산업 기초 통계는 월별 전망에서 제외합니다."] };
}

module.exports = { buildRegionalOutlook, VERSION, shiftMonth, monthDistance };
