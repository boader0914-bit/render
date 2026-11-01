"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildSearchDemandForecast, forecastFingerprint } = require("./lib/search_demand_forecast.cjs");

function fixture(values = [60, 65, 70, 75, 80, 85, 90, 95, 100, 80, 60, 40]) {
  const keywordId = "kw_" + "1".repeat(64);
  return { keyword: "경남글램핑", targetMonth: "2026-11", calculatedAt: "2026-11-01T07:20:52.000Z",
    searchSnapshot: { keyword: "경남글램핑", keywordId, provider: "searchad", status: "ready", snapshotId: "sd_" + "2".repeat(64), observedAt: "2026-11-01T07:20:51.000Z",
      anchor: { keyword: "경남글램핑", isAnchor: true, conflicting: false, total: { state: "number", value: 9660 } } },
    trendSnapshot: { keyword: "경남글램핑", keywordId, provider: "datalab", status: "ready", timeUnit: "month", snapshotId: "sd_" + "3".repeat(64), windowId: "tw_" + "4".repeat(64), observedAt: "2026-11-01T01:00:00.000Z", startDate: "2025-11-01", endDate: "2026-10-31",
      series: values.map((ratio, i) => ({ period: new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10), ratio, state: "observed" })) } };
}

test("valid sources apply the existing ratio with actual period and snapshot bindings", () => {
  const result = buildSearchDemandForecast(fixture());
  assert.equal(result.status, "verified"); assert.equal(result.value, 14490); assert.equal(result.factor, 1.5);
  assert.equal(result.basePeriod, "2026-10"); assert.equal(result.seasonalPeriod, "2025-11"); assert.equal(result.targetMonth, "2026-11");
  assert.equal(result.metricDefinition, "estimated_monthly_search_scale"); assert.equal(result.sourceSnapshotIds.length, 2);
});

test("missing, ranged, wrong-keyword, future, stale and incomplete sources never turn into zero forecasts", () => {
  const changes = [x => x.searchSnapshot = null, x => x.searchSnapshot.anchor.total = { state: "range", value: null },
    x => x.searchSnapshot.keyword = "남해글램핑", x => x.trendSnapshot.series[3].ratio = null, x => x.trendSnapshot.series[3].state = "missing",
    x => x.trendSnapshot.series.pop(), x => x.targetMonth = "2026-12", x => x.searchSnapshot.observedAt = "2026-11-02T00:00:00.000Z",
    x => x.searchSnapshot.observedAt = "2026-10-31T01:00:00.000Z", x => x.trendSnapshot.series[4].period = x.trendSnapshot.series[3].period];
  for (const change of changes) { const f = fixture(); change(f); const result = buildSearchDemandForecast(f); assert.equal(result.status, "held"); assert.equal(result.value, null); }
});

test("observed zero stays numeric and unchanged source inputs have the same forecast fingerprint", () => {
  const f = fixture(); f.searchSnapshot.anchor.total.value = 0;
  assert.equal(buildSearchDemandForecast(f).value, 0);
  const a = buildSearchDemandForecast(fixture()), f2 = fixture(); f2.calculatedAt = "2026-11-01T08:00:00.000Z";
  assert.equal(forecastFingerprint(a), forecastFingerprint(buildSearchDemandForecast(f2)));
});

test("new adapter reproduces the unchanged legacy function on complete valid trend inputs", () => {
  const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const legacy = app.match(/^function demandNextMonthProjection\([^]*?^}/m)?.[0]; assert.ok(legacy);
  for (const ratios of [[60,65,70,75,80,85,90,95,100,80,60,40], [10,20,30,40,50,60,70,80,90,100,20,0], [0,0,0,0,0,1,2,3,4,0,0,0]]) {
    const f = fixture(ratios), series = f.trendSnapshot.series.map((r, index) => ({ value: r.ratio, month: Number(r.period.slice(5, 7)), year: Number(r.period.slice(0, 4)), index, label: r.period.slice(0, 7) }));
    const average = rows => rows.reduce((s, r) => s + r.value, 0) / rows.length;
    const recent = average(series.slice(-3)), prior = average(series.slice(-6, -3));
    const stats = { last: series.at(-1), recentChange: prior ? (recent-prior)/prior : NaN, overallChange: series[0].value ? (series.at(-1).value-series[0].value)/series[0].value : NaN };
    const context = vm.createContext({ finiteNumber: (v,d) => typeof v === "number" && Number.isFinite(v) ? v : d,
      demandSeasonalTrendEntryForMonth: (_, month) => series.slice(0,-1).find(r=>r.month===month), demandPeriodFromEntry: r=>r.label,
      demandShiftPeriod: () => "2026-11", demandPeriodShortLabel: p=>p, demandPeriodLongLabel: p=>p,
      trendShortPeriodLabel: r=>r?.label||"", trendLongPeriodLabel: r=>r?.label||"", trendIndexLabel: String,
      formatSignedRate: String, fmtNumber: String });
    const old = vm.runInContext(legacy+"\ndemandNextMonthProjection", context)({totalSearchVolume:9660},{hasSeries:true,series},stats);
    assert.equal(buildSearchDemandForecast(f).value, old.projectedVolume);
  }
});
