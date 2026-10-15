"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildRegionalOutlook, shiftMonth, VERSION } = require("./lib/regional_outlook.cjs");
const { buildRegionalOutlookCalendar } = require("./lib/regional_outlook_calendar.cjs");

const makeRows = (count = 13, end = "2026-09", value = 100) => Array.from({ length: count }, (_, i) => ({
  period: shiftMonth(end, i + 1 - count), status: "observed", value: typeof value === "function" ? value(i, shiftMonth(end, i + 1 - count)) : value,
  retrievedAt: "2026-10-01T00:00:00Z"
}));
function snapshot(rows, { groupKey = "visitors", category = "tourism", unit = "명", historyRows } = {}) {
  return { sourceFingerprint: "snapshot-source", builtAt: "2026-10-01T00:00:00Z", scope: { regionKey: "pocheon", label: "경기도 포천시" },
    groups: [{ key: groupKey, label: groupKey === "searchTrend" ? "검색 트렌드" : "지역 방문자", category, provider: "테스트 제공기관", periodType: "M",
      sourceBatchId: groupKey === "searchTrend" ? "one-normalization-batch" : "", normalizationPeriod: groupKey === "searchTrend" ? "2025-09-01 ~ 2026-09-30" : "",
      metrics: [{ key: "value", label: "일평균 방문자", unit, rows, ...(historyRows ? { historyRows } : {}) }] }] };
}
function calendar(periods = makeRows(38, "2026-11").map(row => row.period), values = {}) {
  return { months: periods.map(period => {
    const daysInMonth = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0)).getUTCDate();
    return { period, status: "ready", daysInMonth, coverageComplete: true, holidayDays: 1, weekendDays: 8,
      holidayOrWeekendDays: 9, longBreakDays: 3, holidayDates: [period + "-01"], longBreaks: [], stale: false, updatedAt: "2026-10-01T00:00:00Z", ...values[period] };
  }) };
}
function build(rows = makeRows(), options = {}) {
  return buildRegionalOutlook({ snapshot: options.snapshot || snapshot(rows), calendar: options.calendar || calendar(), asOfDate: options.asOfDate || "2026-10-16" });
}

test("produces current and next monthly estimates with source units and excludes static population/industry", () => {
  const input = snapshot(makeRows());
  input.groups.push({ key: "kosis", category: "background", periodType: "mixed", metrics: [{ key: "population", unit: "명", rows: makeRows() }] });
  const result = build(null, { snapshot: input });
  assert.equal(result.calculationVersion, VERSION);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.targets.map(row => [row.period, row.kind]), [["2026-10", "current"], ["2026-11", "next"]]);
  assert.equal(result.metrics.length, 1); assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].periodType, "M"); assert.equal(result.groups[0].status, "complete");
  assert.equal(result.metrics[0].unit, "명"); assert.equal(result.metrics[0].latestPeriod, "2026-09");
  assert.ok(result.metrics[0].forecasts.every(row => row.status === "forecast" && row.value === 100));
  assert.equal(result.networkAttempted, false); assert.equal(result.summary.unavailable, 0);
});

test("uses exact year-ago month, never the nearest stored month as seasonality", () => {
  const rows = makeRows(13, "2026-09", (i, period) => period === "2025-10" ? 175 : period === "2025-11" ? 210 : 100);
  const result = build(rows).metrics[0].forecasts;
  assert.equal(result[0].method, "seasonal_naive"); assert.equal(result[0].value, 175);
  assert.equal(result[1].method, "seasonal_naive"); assert.equal(result[1].value, 210);
  assert.equal(result[0].validation.status, "insufficient_validation");
  rows.find(row => row.period === "2025-10").status = "missing";
  const missingMonth = build(rows).metrics[0].forecasts[0];
  assert.equal(missingMonth.method, "recent_level"); assert.equal(missingMonth.value, 100);
});

test("normal zero is forecastable while failed, partial, blocked or missing zero is not an observation", () => {
  const zeros = makeRows(13, "2026-09", 0);
  const valid = build(zeros).metrics[0];
  assert.equal(valid.latestValue, 0); assert.equal(valid.forecasts[0].value, 0);
  assert.equal(valid.forecasts[0].status, "forecast");
  assert.equal(valid.forecasts[1].validation.wapePct, null);
  const invalid = makeRows().map((row, i) => ({ ...row, value: 0, status: ["error", "partial", "blocked", "missing"][i % 4] }));
  const empty = build(invalid);
  assert.equal(empty.status, "missing"); assert.equal(empty.metrics[0].availableMonths, 0);
  assert.ok(empty.metrics[0].forecasts.every(row => row.value === null && row.reasonCode === "NO_OBSERVATIONS"));
});

test("requires six real monthly observations and refuses forecasts more than three months past latest source", () => {
  const short = build(makeRows(5));
  assert.equal(short.status, "missing"); assert.equal(short.metrics[0].forecasts[0].reasonCode, "INSUFFICIENT_HISTORY");
  const lag = build(makeRows(13, "2026-08"));
  assert.equal(lag.metrics[0].forecasts[1].horizonMonths, 3);
  const stale = build(makeRows(13, "2026-06"));
  assert.equal(stale.status, "missing"); assert.ok(stale.metrics[0].forecasts.every(row => row.reasonCode === "STALE_SOURCE"));
});

test("gaps in the most recent three months are not filled from older observations", () => {
  const rows = makeRows(18);
  for (const row of rows) if (["2026-08", "2026-09"].includes(row.period)) row.status = "missing";
  // The latest real value is July; two previous normal months remain usable.
  const valid = build(rows); assert.equal(valid.metrics[0].latestPeriod, "2026-07");
  assert.equal(valid.metrics[0].forecasts[1].reasonCode, "STALE_SOURCE");
  const scarce = makeRows(8, "2026-09");
  scarce.find(row => row.period === "2026-08").status = "missing";
  scarce.find(row => row.period === "2026-07").status = "missing";
  const result = build(scarce).metrics[0].forecasts[0];
  assert.equal(result.status, "unavailable"); assert.equal(result.reasonCode, "RECENT_OBSERVATIONS_MISSING");
});

test("official monthly observations take priority over forecasts and are labelled as observations", () => {
  const result = build(makeRows(13, "2026-10", (i, period) => period === "2026-10" ? 123 : 100));
  const current = result.metrics[0].forecasts[0];
  assert.equal(current.status, "observed"); assert.equal(current.label, "공식 관측"); assert.equal(current.value, 123);
  assert.equal(current.method, "official_observation"); assert.equal(current.holiday.adjustmentApplied, false);
  assert.equal(result.metrics[0].forecasts[1].status, "forecast");
});

test("only Naver relative indices are bounded at100; tourism indices above100 retain their source scale", () => {
  const tourism = build(null, { snapshot: snapshot(makeRows(13, "2026-09", 153.7), { groupKey: "demandStrength", unit: "지수" }) });
  assert.equal(tourism.metrics[0].forecasts[0].value, 153.7);
  const rows = makeRows(12, "2026-09", i => i < 6 ? 5 : 80 + (i - 6) * 4);
  const search = build(null, { snapshot: snapshot(rows, { groupKey: "searchTrend", category: "search", unit: "상대지수" }) });
  assert.ok(search.metrics[0].forecasts.every(row => row.value === null || row.value >= 0 && row.value <= 100));
  assert.equal(search.metrics[0].sourceBatchId, "one-normalization-batch");
  assert.equal(search.metrics[0].normalizationPeriod, "2025-09-01 ~ 2026-09-30");
});

test("forecast input uses extended cached history while leaving display rows intact", () => {
  const all = makeRows(30), display = all.slice(-13), input = snapshot(display, { historyRows: all });
  const before = JSON.stringify(input);
  const result = build(null, { snapshot: input });
  assert.equal(result.metrics[0].availableMonths, 30); assert.equal(input.groups[0].metrics[0].rows.length, 13);
  assert.equal(JSON.stringify(input), before);
  assert.ok(result.metrics[0].forecasts[0].validation.folds >= 3);
});

test("historical evaluation uses each origin's available data; future data does not enter predictions or fingerprints", () => {
  const original = snapshot(makeRows(24));
  const result = build(null, { snapshot: original });
  const future = structuredClone(original);
  future.groups[0].metrics[0].rows.push(...makeRows(12, "2027-11", 999999));
  const same = build(null, { snapshot: future });
  assert.equal(same.sourceFingerprint, result.sourceFingerprint);
  assert.deepEqual(same.metrics, result.metrics);
  const series = makeRows(11, "2026-09", (i) => i === 10 ? 10000 : 100);
  const backtest = build(series).metrics[0].forecasts[0].validation;
  // The final shock cannot be forecast with its own actual value.
  assert.ok(backtest.mae > 100); assert.equal(backtest.method, "rolling_origin");
  assert.ok(backtest.lastTargetPeriod <= "2026-09");
});

test("cache fingerprint ignores retrieval timestamps and same-month as-of day but responds to real values and holidays", () => {
  const input = snapshot(makeRows()), cal = calendar(), first = build(null, { snapshot: input, calendar: cal });
  input.builtAt = "2026-10-20T00:00:00Z";
  input.groups[0].metrics[0].rows.forEach(row => { row.retrievedAt = "2026-10-20T00:00:00Z"; });
  cal.months.forEach(row => { row.updatedAt = "2026-10-20T00:00:00Z"; });
  const repeated = build(null, { snapshot: input, calendar: cal, asOfDate: "2026-10-20" });
  assert.equal(repeated.sourceFingerprint, first.sourceFingerprint);
  input.groups[0].metrics[0].rows.at(-1).value = 101;
  assert.notEqual(build(null, { snapshot: input, calendar: cal }).sourceFingerprint, first.sourceFingerprint);
  input.groups[0].metrics[0].rows.at(-1).value = 100;
  cal.months.at(-1).holidayDays++;
  assert.notEqual(build(null, { snapshot: input, calendar: cal }).sourceFingerprint, first.sourceFingerprint);
});

test("missing official holiday data remains missing, with no guessed uplift or fabricated zero holiday count", () => {
  const result = build(makeRows(), { calendar: { months: [] } });
  assert.equal(result.status, "partial");
  assert.equal(result.targets[0].calendar.status, "missing");
  assert.equal(result.metrics[0].forecasts[0].holiday.reasonCode, "HOLIDAY_CALENDAR_UNAVAILABLE");
  assert.equal(result.metrics[0].forecasts[0].holiday.adjustmentApplied, false);
  assert.equal(result.metrics[0].forecasts[0].value, 100);
});

test("short holiday history provides long-break context without asserting a numerical causal effect", () => {
  const cal = calendar(); cal.months.find(row => row.period === "2026-10").longBreakDays = 9;
  const result = build(makeRows(13), { calendar: cal });
  const current = result.metrics[0].forecasts[0];
  assert.equal(result.targets[0].calendar.longBreakDays, 9);
  assert.equal(current.holiday.adjustmentApplied, false); assert.equal(current.holiday.reasonCode, "HOLIDAY_HISTORY_INSUFFICIENT");
  assert.equal(current.value, 100);
});

test("duplicate monthly observations or invalid search values cannot become normal zero or silently win", () => {
  const rows = makeRows(6); rows.push({ ...rows.at(-1), value: 999 });
  const result = build(rows);
  assert.equal(result.metrics[0].availableMonths, 5); assert.equal(result.status, "missing");
  const invalid = build(null, { snapshot: snapshot(makeRows(8, "2026-09", 101), { groupKey: "searchTrend", category: "search", unit: "상대지수" }) });
  assert.equal(invalid.metrics[0].availableMonths, 0); assert.equal(invalid.status, "missing");
});

test("holiday coefficients are accepted only after at least24 months and three genuinely past validation origins", () => {
  // Vary the count by month AND year. The signal is exactly proportional to
  // official free-day exposure; last-year values therefore miss shifted breaks.
  const periods = makeRows(40, "2026-11").map(row => row.period);
  const values = Object.fromEntries(periods.map((period, i) => [period, { holidayOrWeekendDays: 8 + (i * 7 % 9), longBreakDays: 3 + (i * 5 % 7) }]));
  const cal = calendar(periods, values);
  const byMonth = new Map(cal.months.map(row => [row.period, row]));
  const rows = makeRows(36, "2026-09", (i, period) => 100 + 700 * byMonth.get(period).holidayOrWeekendDays / byMonth.get(period).daysInMonth);
  const result = build(rows, { calendar: cal });
  const current = result.metrics[0].forecasts[0];
  assert.equal(current.holiday.adjustmentApplied, true);
  assert.equal(current.method, "seasonal_holiday"); assert.equal(current.holiday.feature, "holidayOrWeekendDays");
  assert.ok(current.holiday.trainingPairs >= 12); assert.ok(current.validation.folds >= 3);
  assert.ok(current.validation.mae < 0.00001);
  const expected = 100 + 700 * byMonth.get("2026-10").holidayOrWeekendDays / byMonth.get("2026-10").daysInMonth;
  assert.ok(Math.abs(current.value - expected) < 0.00001);
  const short = build(rows.slice(-24), { calendar: cal }).metrics[0].forecasts[0];
  assert.equal(short.holiday.adjustmentApplied, false); assert.equal(short.holiday.reasonCode, "HOLIDAY_EFFECT_NOT_VALIDATED");
});

test("abundant history alone does not justify a holiday uplift without validated predictive improvement", () => {
  const result = build(makeRows(36, "2026-09", 100));
  assert.equal(result.metrics[0].forecasts[0].holiday.adjustmentApplied, false);
  assert.equal(result.metrics[0].forecasts[0].value, 100);
  assert.equal(result.metrics[0].forecasts[0].holiday.reasonCode, "HOLIDAY_EFFECT_NOT_VALIDATED");
});

test("actual special-day calendar contract preserves named long breaks and distinct unknown coverage", () => {
  const periods = makeRows(15, "2026-11").map(row => row.period);
  const years = [2025, 2026].map(year => ({ year, categories: { holidays: { status: "ready", updatedAt: "2026-10-01T00:00:00Z", items:
    year === 2026 ? [{ date: "2026-10-09", name: "한글날", isHoliday: true, kind: "holidays" }] : [] } } }));
  const cal = buildRegionalOutlookCalendar({ periods, years });
  const result = build(makeRows(), { calendar: cal }), target = result.targets[0].calendar;
  assert.equal(target.status, "ready"); assert.equal(target.coverageComplete, true);
  assert.equal(target.holidayDays, 1); assert.equal(target.longestRunDays, 3);
  assert.ok(target.holidays.some(row => row.date === "2026-10-09" && row.names.includes("한글날")));
  assert.ok(target.longBreaks.some(row => row.start === "2026-10-09" && row.names.includes("한글날") && row.officialHolidayDates.includes("2026-10-09")));
  assert.equal(target.updatedAt, "2026-10-01T00:00:00.000Z");
  const unknown = build(makeRows(), { calendar: buildRegionalOutlookCalendar({ periods, years: [] }) });
  assert.equal(unknown.targets[0].calendar.holidayDays, null);
  assert.equal(unknown.targets[0].calendar.longBreakDays, null);
  assert.equal(unknown.metrics[0].forecasts[0].holiday.adjustmentApplied, false);
});

test("as-of date validation rejects non-calendar dates and omitted dates", () => {
  for (const asOfDate of [undefined, "2026-02-30", "2026-13-01", "2026-10-16T00:00:00Z"]) {
    assert.throws(() => buildRegionalOutlook({ snapshot: snapshot(makeRows()), asOfDate }), error => error.code === "INVALID_AS_OF_DATE");
  }
});

test("forecast groups accurately distinguish complete, partial, missing, and failed for shared saved summaries", () => {
  const complete = build(makeRows(13, "2026-09", 0)).groups[0];
  assert.equal(complete.status, "complete"); assert.equal(complete.periodType, "M");
  assert.equal(complete.availableTargets, 2); assert.equal(complete.expectedTargets, 2);
  const partial = build(makeRows(13, "2026-07", 0)).groups[0];
  assert.equal(partial.status, "partial"); assert.equal(partial.availableTargets, 1);
  const missing = build(makeRows(5)).groups[0];
  assert.equal(missing.status, "missing"); assert.equal(missing.availableTargets, 0);
  const failedSource = snapshot(makeRows().map(row => ({ ...row, status: "error", value: 0 })));
  failedSource.groups[0].status = "failed"; failedSource.groups[0].errorCode = "AUTH_ERROR";
  const failed = build(null, { snapshot: failedSource }).groups[0];
  assert.equal(failed.status, "failed"); assert.equal(failed.sourceErrorCode, "AUTH_ERROR"); assert.equal(failed.availableTargets, 0);
  const missingCalendar = build(makeRows(), { calendar: { months: [] } }).groups[0];
  assert.equal(missingCalendar.status, "partial"); assert.equal(missingCalendar.availableTargets, 2);
  const failedWithPrior = snapshot(makeRows()); failedWithPrior.groups[0].status = "failed"; failedWithPrior.groups[0].errorCode = "AUTH_ERROR";
  const retained = build(null, { snapshot: failedWithPrior });
  assert.equal(retained.status, "partial"); assert.equal(retained.groups[0].status, "partial");
  assert.equal(retained.groups[0].availableTargets, 2);
  assert.notEqual(retained.sourceFingerprint, build(makeRows()).sourceFingerprint);
});

test("forecast groups include only the four monthly tourism sources and Naver search", () => {
  const input = snapshot(makeRows());
  const source = input.groups[0];
  input.groups = ["visitors", "demandStrength", "resourceDemand", "diversity", "searchTrend", "unapprovedMetric", "kosis"].map(key => ({ ...source, key,
    category: key === "searchTrend" ? "search" : "tourism" }));
  const result = build(null, { snapshot: input });
  assert.deepEqual(result.groups.map(group => group.key), ["visitors", "demandStrength", "resourceDemand", "diversity", "searchTrend"]);
  assert.ok(result.groups.every(group => group.periodType === "M" && group.status === "complete"));
});
