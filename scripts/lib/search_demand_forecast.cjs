"use strict";

const crypto = require("node:crypto");
const MODEL_VERSION = "legacy-demand-ratio-v1";
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const SNAPSHOT = /^sd_[a-f0-9]{64}$/;
const WINDOW = /^tw_[a-f0-9]{64}$/;
const known = value => typeof value === "number" && Number.isFinite(value);
const compact = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const iso = value => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const kstDay = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10);
const shiftMonth = (month, n) => { const [y, m] = month.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

// Compatibility adapter for the existing demandNextMonthProjection formula.
// It does not edit that function or relabel a recent-period count as a calendar
// month's actual total. Partial data fail closed before the old ratio is used.
function buildSearchDemandForecast({ keyword, searchSnapshot, trendSnapshot, targetMonth, calculatedAt = new Date().toISOString() } = {}) {
  const base = { schemaVersion: 1, keyword: String(keyword || ""), targetMonth: MONTH.test(targetMonth || "") ? targetMonth : null,
    modelVersion: MODEL_VERSION, status: "held", value: null, inputVolume: null, factor: null, changeRate: null,
    metricDefinition: "estimated_monthly_search_scale", reasonCode: "FORECAST_INPUTS_MISSING", calculatedAt: iso(calculatedAt) ? new Date(calculatedAt).toISOString() : null };
  const held = reasonCode => ({ ...base, reasonCode });
  if (!base.targetMonth || !base.calculatedAt || !compact(keyword)) return held("FORECAST_INVALID_SELECTION");
  if (!searchSnapshot || !trendSnapshot) return held("FORECAST_INPUTS_MISSING");
  if (searchSnapshot.provider !== "searchad" || trendSnapshot.provider !== "datalab"
    || compact(searchSnapshot.keyword) !== compact(keyword) || compact(trendSnapshot.keyword) !== compact(keyword)
    || searchSnapshot.keywordId !== trendSnapshot.keywordId || !/^kw_[a-f0-9]{64}$/.test(searchSnapshot.keywordId || "")) return held("FORECAST_KEYWORD_MISMATCH");
  if (searchSnapshot.status !== "ready" || trendSnapshot.status !== "ready" || !searchSnapshot.anchor?.isAnchor || searchSnapshot.anchor.conflicting
    || compact(searchSnapshot.anchor.keyword) !== compact(keyword)) return held("FORECAST_INPUTS_PARTIAL");
  if (!iso(searchSnapshot.observedAt) || !iso(trendSnapshot.observedAt)
    || Date.parse(searchSnapshot.observedAt) > Date.parse(base.calculatedAt) || Date.parse(trendSnapshot.observedAt) > Date.parse(base.calculatedAt)) return held("FORECAST_OBSERVATION_TIME_INVALID");
  if (kstDay(searchSnapshot.observedAt) !== kstDay(base.calculatedAt)) return held("FORECAST_SEARCH_SNAPSHOT_NOT_FRESH");
  const total = searchSnapshot.anchor.total;
  if (total?.state !== "number" || !known(total.value) || total.value < 0) return held("FORECAST_SEARCH_COUNT_NOT_EXACT");
  if (!SNAPSHOT.test(searchSnapshot.snapshotId || "") || !SNAPSHOT.test(trendSnapshot.snapshotId || "") || !WINDOW.test(trendSnapshot.windowId || "")) return held("FORECAST_SOURCE_ID_INVALID");
  const raw = trendSnapshot.series;
  if (trendSnapshot.timeUnit !== "month" || !Array.isArray(raw) || raw.length !== 12
    || raw.some(row => !/^20\d{2}-(?:0[1-9]|1[0-2])-01$/.test(row.period || "") || row.state !== "observed" || !known(row.ratio) || row.ratio < 0 || row.ratio > 100)) return held("FORECAST_TREND_COVERAGE_INCOMPLETE");
  const series = raw.map(row => ({ period: row.period.slice(0, 7), value: row.ratio }));
  if (new Set(series.map(row => row.period)).size !== 12 || series.some((row, i) => i > 0 && row.period !== shiftMonth(series[i - 1].period, 1))) return held("FORECAST_TREND_WINDOW_INVALID");
  const first = series[0], last = series[series.length - 1];
  if (String(trendSnapshot.startDate || "").slice(0, 7) !== first.period || String(trendSnapshot.endDate || "").slice(0, 7) !== last.period) return held("FORECAST_TREND_WINDOW_INVALID");
  if (shiftMonth(last.period, 1) !== targetMonth) return held("FORECAST_TARGET_OUTSIDE_BASE");
  const seasonal = series.slice(0, -1).filter(row => row.period.slice(5) === targetMonth.slice(5)).at(-1);
  let factor, method, seasonalPeriod = null;
  if (last.value > 0 && seasonal) {
    factor = seasonal.value / last.value; method = "seasonal_ratio"; seasonalPeriod = seasonal.period;
  } else {
    const avg = rows => rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
    const recent = avg(series.slice(-3)), previous = avg(series.slice(-6, -3));
    if (previous > 0) { factor = 1 + Math.max(-0.35, Math.min(0.35, (recent - previous) / previous)); method = "recent_three_month"; }
    else if (first.value > 0) { factor = 1 + Math.max(-0.25, Math.min(0.25, ((last.value - first.value) / first.value) / 3)); method = "twelve_month_trend"; }
    else return held("FORECAST_TREND_BASIS_UNAVAILABLE");
  }
  if (!known(factor) || factor < 0 || !Number.isSafeInteger(Math.round(total.value * factor))) return held("FORECAST_RESULT_INVALID");
  return { schemaVersion: 1, keyword: searchSnapshot.keyword, keywordId: searchSnapshot.keywordId, modelVersion: MODEL_VERSION,
    targetMonth, calculatedAt: base.calculatedAt, sourceSnapshotIds: [searchSnapshot.snapshotId, trendSnapshot.snapshotId], trendWindowId: trendSnapshot.windowId,
    status: "verified", value: Math.max(0, Math.round(total.value * factor)), inputVolume: total.value, factor, changeRate: factor - 1,
    basePeriod: last.period, seasonalPeriod, method, reasonCode: "FORECAST_INPUTS_VERIFIED", metricDefinition: "estimated_monthly_search_scale",
    searchObservedAt: searchSnapshot.observedAt, trendObservedAt: trendSnapshot.observedAt };
}

function forecastFingerprint(record) {
  return crypto.createHash("sha256").update(JSON.stringify({ modelVersion: record.modelVersion, targetMonth: record.targetMonth, sourceSnapshotIds: record.sourceSnapshotIds })).digest("hex");
}

module.exports = { MODEL_VERSION, buildSearchDemandForecast, forecastFingerprint };
