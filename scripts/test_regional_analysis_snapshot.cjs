"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRegionalAnalysisSnapshotBuilder, shiftMonth } = require("./lib/regional_analysis_snapshot.cjs");
const { DEFINITIONS } = require("./lib/kosis.cjs");
const scope = { regionKey: "pocheon", label: "경기도 포천시", month: "2026-09", months: 13 };
function fixture() {
  let retrievedAt = "2026-10-01T00:00:00Z";
  const calls = [];
  const series = Array.from({ length: 25 }, (_, i) => ({ yearMonth: shiftMonth(scope.month, i - 24).replace("-", ""),
    status: i === 24 ? "missing" : "complete", averageDailyVisitors: i === 24 ? 999 : 0, visitorDays: 0,
    stayOverall: 0, spendOverall: 0, values: { service: 0, culture: 0, visitor: 0, spend: 0, international: 0 } }));
  const tourismCollector = Object.fromEntries(["collectVisitorHistory", "collectDemandStrengthHistory", "collectResourceDemandHistory", "collectDiversityHistory"].map((method, i) => [method, async input => {
    calls.push({ method, ...input });
    const rows = series.map(point => ({ ...point, collectedAt: retrievedAt }));
    return { period: { endYearMonth: input.endYearMonth }, ...(i === 0 ? { regions: [{ regionKey: input.regionKey, series: rows }] } : { region: { regionKey: input.regionKey }, series: rows }), networkAttempted: false };
  }]));
  const kosisService = { getRegion: async regionKey => ({ region: { regionKey }, datasets: DEFINITIONS.map(d => ({ key: d.key, periodType: d.periodType,
    period: d.periodType === "Y" ? "2024" : "202608", status: "ready", retrievedAt, rows: d.metrics.flatMap(m => (d.breakdowns || [null]).map(b => ({ key: b?.key || m.key, unit: m.unit, value: 0, status: "observed" }))) })) }) };
  const searchTrendService = { get: async input => { calls.push({ method: "search", ...input }); return { ...input, keyword: "포천글램핑", partialMonth: false,
    startDate: "2025-09-01", endDate: "2026-09-30", retrievedAt, series: Array.from({ length: 13 }, (_, i) => ({ period: shiftMonth(scope.month, i - 12) + "-01", status: "observed", value: 0 })) }; } };
  const options = { tourismCollector, kosisService, searchTrendService, now: () => "2026-10-15T00:00:00Z" };
  return { options, calls, setTime: value => { retrievedAt = value; } };
}
test("each tourism indicator uses latest normal month inclusive13; normal zero stays observed", async () => {
  const f = fixture(), result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope, {});
  const visitor = result.groups[0];
  assert.equal(visitor.latestPeriod, "2026-08"); assert.equal(visitor.availableMonths, 13); assert.equal(visitor.expectedMonths, 13);
  assert.equal(visitor.metrics[0].rows[0].period, "2025-08"); assert.equal(visitor.metrics[0].rows.at(-1).value, 0);
  assert.equal(visitor.metrics[0].rows.at(-1).status, "observed");
  assert.equal(result.groups.find(g => g.key === "searchTrend").latestPeriod, "2026-09");
  assert.equal(result.groups.find(g => g.key === "kosis").expectedMonths, null);
  assert.equal(result.groups.find(g => g.key === "kosis").datasets.find(d => d.periodType === "Y").rows[0].value, 0);
  assert.equal(result.networkAttempted, false); assert.ok(f.calls.filter(c => c.method !== "search").every(c => c.collectMissing === false && c.force === false));
  assert.equal(result.capabilities.monthlyForecast, false);
});
test("failed/missing zero is not an observed value and wrong regions are rejected", async () => {
  const f = fixture();
  f.options.tourismCollector.collectVisitorHistory = async () => ({ regions: [{ regionKey: "other", series: [{ yearMonth: "202609", status: "complete", averageDailyVisitors: 0 }] }] });
  f.options.tourismCollector.collectDemandStrengthHistory = async () => ({ region: { regionKey: scope.regionKey }, series: [{ yearMonth: "202609", status: "failed", stayOverall: 0, spendOverall: 0 }] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  assert.equal(result.groups[0].errorCode, "REGION_MISMATCH"); assert.equal(result.groups[0].metrics[0].latestValue, null);
  assert.equal(result.groups[1].metrics[0].rows.at(-1).status, "error"); assert.equal(result.groups[1].metrics[0].latestValue, null);
});
test("source normalization never joins independently scaled search batches", async () => {
  const f = fixture();
  f.options.searchTrendService.get = async input => ({ ...input, keyword: "포천글램핑", partialMonth: false, startDate: "2025-10-01", endDate: "2026-09-30",
    series: input.months === 12 ? [{ period: "2026-09-01", value: 50, status: "observed" }] : [] });
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope);
  const trend = result.groups.find(g => g.key === "searchTrend");
  assert.equal(trend.availableMonths, 1); assert.equal(trend.metrics[0].rows.find(row => row.period === "2025-09").value, null);
  assert.equal(trend.normalizationPeriod, "2025-10-01 ~ 2026-09-30");
});
test("cache-only contract violation fails the build; only explicit refresh invokes preparation", async () => {
  const f = fixture(); let prepared = 0;
  f.options.prepare = async () => { prepared++; return { id: "job", status: "partial", steps: [] }; };
  const build = createRegionalAnalysisSnapshotBuilder(f.options);
  await build(scope); assert.equal(prepared, 0);
  await build(scope, { collectMissing: true }); assert.equal(prepared, 1);
  f.options.tourismCollector.collectVisitorHistory = async () => ({ collection: { operationCallsAttempted: 1 } });
  await assert.rejects(() => createRegionalAnalysisSnapshotBuilder(f.options)(scope), error => error.code === "REGIONAL_CACHE_ONLY_VIOLATION");
});
test("identical values retain source fingerprint across receive-time changes", async () => {
  const f = fixture(), build = createRegionalAnalysisSnapshotBuilder(f.options);
  const first = await build(scope); f.setTime("2026-10-02T00:00:00Z");
  const second = await build(scope);
  assert.equal(first.sourceFingerprint, second.sourceFingerprint);
});
test("failed KOSIS refresh preserves stale normal values with their real annual period", async () => {
  const f = fixture(), original = f.options.kosisService.getRegion;
  f.options.kosisService.getRegion = async key => {
    const result = await original(key);
    return { ...result, status: "stale", error: { code: "QUOTA_EXCEEDED" }, datasets: result.datasets.map(dataset => ({ ...dataset, status: "stale" })) };
  };
  const result = await createRegionalAnalysisSnapshotBuilder(f.options)(scope), group = result.groups.find(item => item.key === "kosis");
  assert.equal(group.metrics[0].latestValue, 0); assert.equal(group.stale, true); assert.equal(group.errorCode, "QUOTA_EXCEEDED");
  assert.equal(group.datasets.find(item => item.periodType === "Y").period, "2024");
});
