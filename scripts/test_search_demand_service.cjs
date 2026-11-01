"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createSearchDemandStore } = require("./lib/search_demand_store.cjs");
const M = require("./lib/search_demand_model.cjs");
const { createSearchDemandService, csvCell } = require("./lib/search_demand_service.cjs");
const keyword = "경남글램핑", instant = "2026-11-01T07:21:00.000Z";
const row = (relKeyword, pc, mobile) => ({ relKeyword, monthlyPcQcCnt: pc, monthlyMobileQcCnt: mobile });
const ad = (day = "2026-11-01", rows = [row(keyword, 1790, 7870)]) => M.normalizeSearchAdSnapshot({ keyword, observedAt: day + "T07:20:51.000Z", scopeId: "copied-public-metric", keywordList: rows });
const trend = () => M.normalizeTrendSnapshot({ keyword, observedAt: "2026-11-01T01:00:00.000Z", scopeId: "mock-trend-only", connectionProvider: "ncp_apihub", startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month",
  results: [{ title: keyword, data: Array.from({ length: 12 }, (_, i) => ({ period: new Date(Date.UTC(2025, 10 + i, 1)).toISOString().slice(0, 10), ratio: 20 + i })) }] });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-service-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  const store = createSearchDemandStore({ rootDir: root, clock: () => new Date(instant) });
  const scheduler = { status: () => ({ enabled: false, running: false }), history: async () => ({ status: "missing", items: [], scanned: 0, truncated: false }) };
  const service = createSearchDemandService({ store, scheduler, clock: () => new Date(instant), readRegisteredKeywords: async () => [keyword, "가평글램핑"] });
  return { root, store, service };
}
async function footprint(directory) {
  const files = {};
  for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = path.join(entry.parentPath || entry.path, entry.name), stat = await fs.stat(file);
    files[path.relative(directory, file)] = [stat.size, stat.mtimeMs, crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")];
  }
  return files;
}

test("catalog merges registration and saved anchors without turning related words into registered jobs", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad("2026-11-01", [row(keyword, 1790, 7870), row("남해글램핑", 1, 2)]));
  const catalog = await f.service.catalog(); assert.equal(catalog.keywords.length, 2);
  assert.equal(catalog.keywords.find(x => x.keyword === keyword).hasSavedData, true);
  assert.equal(catalog.keywords.some(x => x.keyword === "남해글램핑"), false); assert.equal(catalog.scheduler.enabled, false);
});

test("actual copied base counts remain9660 while absent trend/related history stay unverified", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad());
  const analysis = await f.service.analyze({ keyword, day: "2026-11-01", month: "2026-11", sort: "searchVolumeDesc" });
  assert.equal(analysis.searchVolume.anchor.total.value, 9660); assert.equal(analysis.forecast.value, null);
  assert.equal(analysis.comparisons.day.absolute, null); assert.equal(analysis.comparisons.week.percent, null);
  assert.equal(analysis.related.total, 1); assert.equal(analysis.related.counts.returnedRows, 1);
  assert.equal(analysis.networkAttempted, false); assert.equal(analysis.readOnly, true);
});

test("analysis/report/CSV reads do not change saved bytes or publish a forecast", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad()); await f.store.saveSnapshot(trend());
  const before = await footprint(f.root);
  const a = await f.service.analyze({ keyword, day: "2026-11-01", month: "2026-11" });
  assert.equal(a.forecast.status, "verified"); assert.equal(a.forecast.preview, true); assert.equal(a.forecast.published, false);
  for (const cadence of ["daily", "weekly", "monthly"]) {
    await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence });
    const csv = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence, format: "csv" });
    assert.match(csv.csv, /조회 시점 최근 월간 검색량/); assert.equal(csv.networkAttempted, false);
  }
  assert.deepEqual(await footprint(f.root), before);
});

test("post-commit forecast publication preserves its sources and reuses unchanged input", async t => {
  const f = await fixture(t), s = ad(), tr = trend(); await f.store.saveSnapshot(s); await f.store.saveSnapshot(tr);
  const before = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "daily" });
  assert.equal((await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "daily" })).reportId, before.reportId);
  assert.equal((await f.service.onSnapshotCommitted(s)).status, "complete");
  assert.equal((await f.service.onSnapshotCommitted(s)).status, "reused");
  const stored = await f.store.listForecasts({ keyword, month: "2026-11" }); assert.equal(stored.total, 1);
  const a = await f.service.analyze({ keyword, day: "2026-11-01", month: "2026-11" });
  assert.equal(a.forecast.published, true); assert.deepEqual(a.forecast.sourceSnapshotIds, [s.snapshotId, tr.snapshotId]);
  const after = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "daily" }); assert.notEqual(after.reportId, before.reportId);
  assert.equal((await f.service.onSnapshotCommitted({ ...s, status: "partial" })).status, "held");
});

test("scheduled job cumulative calls are never promoted to actual calls on that calendar day", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad());
  const scheduler = { status: () => ({ enabled: true, running: false }), history: async () => ({ status: "ready", truncated: false, items: [
    { jobId: "mock-job", provider: "datalab", keyword, scheduledAt: "2026-11-01T00:00:00.000Z", lastAttemptDay: "2026-11-04", requestCount: 3, lastRequestCount: 1, status: "complete" }
  ] }) };
  const service = createSearchDemandService({ store: f.store, scheduler, clock: () => Date.parse("2026-11-04T03:00:00.000Z") });
  const report = await service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "daily" });
  assert.equal(report.requestMetrics.knownRequestCountSubtotal, 3); assert.equal(report.requestMetrics.actualPeriodRequestCount, null);
  assert.equal(report.requestMetrics.countBasis, "cumulative_attempts_of_jobs_grouped_by_scheduled_period");
});

test("same definition day/week comparisons use exact observed dates and do not infer missing days", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad("2026-10-25", [row(keyword, 1000, 2000)]));
  await f.store.saveSnapshot(ad("2026-10-31", [row(keyword, 0, 0)])); await f.store.saveSnapshot(ad());
  const a = await f.service.analyze({ keyword, day: "2026-11-01", month: "2026-11" });
  assert.equal(a.comparisons.day.status, "zero_base"); assert.equal(a.comparisons.day.absolute, 9660); assert.equal(a.comparisons.day.percent, null);
  assert.equal(a.comparisons.week.absolute, 6660); assert.equal(a.comparisons.week.percent, 2.22);
  const report = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "weekly" });
  assert.equal(report.rows.length, 7); assert.equal(report.summary.missing, 6); assert.equal(report.summary.representative.total.value, 3000);
  assert.deepEqual({ from: report.scope.from, to: report.scope.to }, { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(report.scope.noSummationAcrossObservationDays, true); assert.equal(Object.hasOwn(report.summary, "totalSearchVolume"), false);
});

test("reports compare prior response membership without inventing missing baselines or summing monthly observations", async t => {
  const f = await fixture(t);
  await f.store.saveSnapshot(ad("2026-10-31", [row(keyword, 100, 200), row("기존연관어", 10, 20)]));
  await f.store.saveSnapshot(ad("2026-11-01", [row(keyword, 1790, 7870), row("다음연관어", 30, 40)]));
  const r = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "monthly" });
  assert.equal(r.relatedChanges.newlyObserved, 1); assert.equal(r.relatedChanges.repeated, 1); assert.equal(r.relatedChanges.notObservedAgain, 1);
  assert.equal(r.comparisons.total.absolute, 9360); assert.equal(r.summary.observedAnchorDays, 1); assert.equal(r.summary.expectedObservationDays, 1);
  assert.equal(r.evaluation.status, "held"); assert.equal(r.evaluation.mae, null); assert.equal(r.evaluation.mape, null);
  assert.equal(r.requestMetrics.knownRequestCountSubtotal, null); assert.equal(r.requestMetrics.knownJobCount, 0);
  assert.equal(r.forecastHistory.total, 0);
});

test("reports retain whole daily related output and protect spreadsheet formula-like words", async t => {
  const f = await fixture(t); const rows = [row(keyword, 1790, 7870), row("=테스트", "<10", 100), ...Array.from({ length: 250 }, (_, i) => row("관련검증" + i, i, 2))];
  await f.store.saveSnapshot(ad("2026-11-01", rows));
  const r = await f.service.report({ keyword, day: "2026-11-01", month: "2026-11", cadence: "daily", format: "csv" });
  assert.equal(r.rows.length, 252); assert.ok(r.csv.includes("'=테스트")); assert.ok(r.csv.includes("<10"));
  assert.ok(r.csv.includes("100 이상 110 미만"));
  assert.equal(csvCell("@unsafe"), '"\'@unsafe"');
});

test("future dates are rejected and missing keyword never falls back to a different saved anchor", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad());
  await assert.rejects(f.service.analyze({ keyword, day: "2026-11-02", month: "2026-11" }), { code: "SEARCH_DEMAND_INVALID_REQUEST" });
  const a = await f.service.analyze({ keyword: "없는검색어", day: "2026-11-01", month: "2026-11" });
  assert.equal(a.status, "missing"); assert.equal(a.searchVolume.anchor, null); assert.equal(a.selection.keyword, "없는검색어");
});
