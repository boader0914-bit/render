"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createSearchDemandStore } = require("./lib/search_demand_store.cjs");
const M = require("./lib/search_demand_model.cjs");
const row = (keyword, pc = 10, mobile = 20) => ({ relKeyword: keyword, monthlyPcQcCnt: pc, monthlyMobileQcCnt: mobile });
const ad = (keyword = "경남글램핑", day = "2026-11-01", values = [row(keyword)], extra = {}) => M.normalizeSearchAdSnapshot({ keyword, observedAt: day + "T01:00:00.000Z", scopeId: "scope-a", keywordList: values, ...extra });
const trend = (extra = {}) => M.normalizeTrendSnapshot({ keyword: "경남글램핑", observedAt: "2026-11-01T00:00:00.000Z", scopeId: "scope-a", connectionProvider: "ncp_apihub", startDate: "2025-11-01", endDate: "2026-10-31", timeUnit: "month", results: [{ title: "경남글램핑", data: Array.from({ length: 12 }, (_, index) => ({ period: new Date(Date.UTC(2025, 10 + index, 1)).toISOString().slice(0, 10), ratio: 20 + index })) }], ...extra });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "search-demand-store-")), rootDir = path.join(directory, "store");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { rootDir, clock: () => new Date("2026-11-01T08:00:00.000Z") };
  return { directory, rootDir, options, store: createSearchDemandStore(options) };
}
async function footprint(root) {
  const result = {};
  async function walk(dir) { let items; try { items = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const item of items) { const file = path.join(dir, item.name); if (item.isDirectory()) await walk(file); else { const [stat, bytes] = await Promise.all([fs.stat(file), fs.readFile(file)]); result[path.relative(root, file)] = [stat.size, stat.mtimeMs, crypto.createHash("sha256").update(bytes).digest("hex")]; } }
  } await walk(root); return result;
}
function forecast(search, tr, extra = {}) { const factor = 20 / 31; return { schemaVersion: 1, keyword: search.keyword, keywordId: search.keywordId,
  modelVersion: "legacy-demand-ratio-v1", targetMonth: "2026-11", calculatedAt: "2026-11-01T08:00:00.000Z", sourceSnapshotIds: [search.snapshotId, tr.snapshotId], trendWindowId: tr.windowId,
  status: "verified", value: Math.round(search.anchor.total.value * factor), inputVolume: search.anchor.total.value, factor, changeRate: factor - 1,
  basePeriod: "2026-10", seasonalPeriod: "2025-11", method: "seasonal_ratio", reasonCode: "FORECAST_INPUTS_VERIFIED", metricDefinition: "estimated_monthly_search_scale",
  searchObservedAt: search.observedAt, trendObservedAt: tr.observedAt, ...extra }; }

test("empty reads create no directories, files or synthetic zero observations", async t => {
  const f = await fixture(t); assert.equal(await f.store.readLatest({ provider: "searchad", keyword: "경남글램핑" }), null);
  const model = await f.store.getAnalysis({ keyword: "경남글램핑", month: "2026-11", day: "2026-11-01" });
  assert.equal(model.searchVolume.status, "missing"); assert.equal(model.searchVolume.anchor, null); assert.equal(model.related.counts.returnedRows, null);
  assert.deepEqual(await footprint(f.rootDir), {}); await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
});
test("saving identical snapshots is idempotent and immutable files are read back", async t => {
  const f = await fixture(t), value = ad(); const saved = await f.store.saveSnapshot(value), before = await footprint(f.rootDir);
  assert.equal(saved.created, true); const same = await f.store.saveSnapshot(value);
  assert.equal(same.reused, true); assert.deepEqual(await footprint(f.rootDir), before);
  assert.deepEqual(await f.store.readLatest({ provider: "searchad", keyword: "경남 글램핑" }), value);
});
test("different store instances serialize writes and preserve every published snapshot", async t => {
  const f = await fixture(t), other = createSearchDemandStore(f.options);
  const values = Array.from({ length: 6 }, (_, index) => ad("기준어" + index));
  await Promise.all(values.map((value, index) => (index % 2 ? other : f.store).saveSnapshot(value)));
  const listed = await f.store.listSnapshots({ limit: 20 }); assert.equal(listed.total, 6);
  for (const value of values) assert.equal((await f.store.readLatest({ provider: "searchad", keyword: value.keyword })).snapshotId, value.snapshotId);
});
test("exact-day and as-of reads do not substitute a different date or future observation", async t => {
  const f = await fixture(t), old = ad("경남글램핑", "2026-10-31"), newer = ad(); await f.store.saveSnapshot(newer); await f.store.saveSnapshot(old);
  assert.equal((await f.store.readLatest({ provider: "searchad", keyword: "경남글램핑", day: "2026-10-31" })).snapshotId, old.snapshotId);
  assert.equal(await f.store.readLatest({ provider: "searchad", keyword: "경남글램핑", day: "2026-10-30" }), null);
  assert.equal((await f.store.readLatest({ provider: "searchad", keyword: "경남글램핑", asOfDay: "2026-10-31" })).snapshotId, old.snapshotId);
  await assert.rejects(f.store.readLatest({ provider: "searchad", keyword: "경남글램핑", day: "2026-11-01", asOfDay: "2026-11-01" }));
});
test("exact-ID reads bind the published historical snapshot without substituting the latest or writing", async t => {
  const f = await fixture(t), old = ad("경남글램핑", "2026-10-31"), newer = ad();
  assert.equal(await f.store.readSnapshot({ snapshotId: old.snapshotId }), null);
  await assert.rejects(fs.stat(f.rootDir), { code: "ENOENT" });
  await f.store.saveSnapshot(old); await f.store.saveSnapshot(newer); const before = await footprint(f.rootDir);
  assert.equal((await f.store.readSnapshot({ snapshotId: old.snapshotId })).snapshotId, old.snapshotId);
  assert.equal((await f.store.readSnapshot({ snapshotId: newer.snapshotId })).snapshotId, newer.snapshotId);
  assert.equal(await f.store.readSnapshot({ snapshotId: "sd_" + "0".repeat(64) }), null);
  await assert.rejects(f.store.readSnapshot({ snapshotId: "../outside" }));
  assert.deepEqual(await footprint(f.rootDir), before);
});
test("all related rows survive storage and pagination without changing the saved data", async t => {
  const f = await fixture(t), value = ad("경남글램핑", "2026-11-01", [row("경남글램핑"), ...Array.from({ length: 861 }, (_, index) => row("연관어" + index, index, 1))]);
  await f.store.saveSnapshot(value); const before = await footprint(f.rootDir);
  const model = await f.store.getAnalysis({ keyword: "경남글램핑", day: "2026-11-01", month: "2026-11", page: 3, pageSize: 20 });
  assert.equal(model.related.total, 862); assert.equal(model.related.rows.length, 20); assert.equal(model.related.counts.returnedRows, 862);
  assert.deepEqual(await footprint(f.rootDir), before);
});
test("one term seen under multiple seeds has one daily observation rather than a sum", async t => {
  const f = await fixture(t), first = ad("경남글램핑", "2026-11-01", [row("경남글램핑"), row("공통연관어", 10, 20)]);
  const second = ad("가평글램핑", "2026-11-01", [row("가평글램핑"), row("공통연관어", 20, 30)], { observedAt: "2026-11-01T02:00:00.000Z" });
  await f.store.saveSnapshot(first); await f.store.saveSnapshot(second);
  const daily = await f.store.listDaily({ keyword: "공통연관어", from: "2026-11-01", to: "2026-11-01" });
  assert.equal(daily.rows.length, 1); assert.equal(daily.rows[0].total.value, 50); assert.equal(daily.rows[0].snapshotId, second.snapshotId);
  assert.equal((await f.store.listKeywords()).length, 2, "related terms do not become registered anchor keywords");
});
test("selected anchor scope prevents a different credential scope from replacing its related daily value", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad("경남글램핑", "2026-11-01", [row("경남글램핑"), row("공통연관어", 10, 20)]));
  await f.store.saveSnapshot(ad("가평글램핑", "2026-11-01", [row("가평글램핑"), row("공통연관어", 1000, 2000)], { scopeId: "scope-b", observedAt: "2026-11-01T02:00:00.000Z" }));
  const model = await f.store.getAnalysis({ keyword: "경남글램핑", relatedKeyword: "공통연관어", day: "2026-11-01", month: "2026-11" });
  assert.equal(model.daily.rows[0].total.value, 30); assert.equal(JSON.stringify(model).includes("scope-a"), false); assert.equal(JSON.stringify(model).includes("scope-b"), false);
});
test("a newer held anchor keeps the prior normal observation explicitly stale", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad("경남글램핑", "2026-10-31", [row("경남글램핑", 1790, 7870)]));
  await f.store.saveSnapshot(ad("경남글램핑", "2026-11-01", [row("다른키워드", 1, 2)]));
  const model = await f.store.getAnalysis({ keyword: "경남글램핑", day: "2026-11-01", month: "2026-11" });
  assert.equal(model.searchVolume.status, "stale"); assert.equal(model.searchVolume.anchor.total.value, 9660); assert.equal(model.searchVolume.day, "2026-10-31");
});
test("whole trend windows and their historical timestamps remain separate", async t => {
  const f = await fixture(t), first = trend(), second = trend({ startDate: "2025-12-01", observedAt: "2026-11-02T00:00:00.000Z" });
  await f.store.saveSnapshot(first); await f.store.saveSnapshot(second);
  const model = await f.store.getAnalysis({ keyword: "경남글램핑", day: "2026-11-01", month: "2026-11" });
  assert.equal(model.trend.windowId, first.windowId); assert.equal(model.trend.series.length, 12); assert.equal(model.trend.startDate, "2025-11-01");
});
test("GET-style methods leave all stored bytes and modification times unchanged", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad()); await f.store.saveSnapshot(trend()); const before = await footprint(f.rootDir);
  await f.store.readLatest({ provider: "searchad", keyword: "경남글램핑" }); await f.store.listKeywords();
  await f.store.listSnapshots({ keyword: "경남글램핑" }); await f.store.listDaily({ keyword: "경남글램핑", from: "2026-11-01", to: "2026-11-02" });
  await f.store.getAnalysis({ keyword: "경남글램핑", month: "2026-11", day: "2026-11-01" }); await f.store.listForecasts({ keyword: "경남글램핑", month: "2026-11" });
  assert.deepEqual(await footprint(f.rootDir), before);
});
test("tampered snapshot and index contents fail instead of becoming empty successful data", async t => {
  const f = await fixture(t), value = ad(); await f.store.saveSnapshot(value);
  const file = path.join(f.rootDir, "snapshots", value.snapshotId + ".json"), changed = JSON.parse(await fs.readFile(file, "utf8")); changed.anchor.total.value = 999;
  await fs.writeFile(file, JSON.stringify(changed));
  await assert.rejects(f.store.readLatest({ provider: "searchad", keyword: "경남글램핑" }), { code: "SEARCH_DEMAND_SNAPSHOT_HASH_MISMATCH" });
});
test("symlink and hardlink snapshot targets are never followed or overwritten", async t => {
  const f = await fixture(t), value = ad(); await f.store.saveSnapshot(value);
  const target = path.join(f.rootDir, "snapshots", value.snapshotId + ".json"), other = path.join(f.directory, "outside.json");
  await fs.rename(target, other); await fs.link(other, target);
  await assert.rejects(f.store.readLatest({ provider: "searchad", keyword: "경남글램핑" }), { code: "SEARCH_DEMAND_UNSAFE_OR_OVERSIZE_FILE" });
});
test("an unsafe parent or oversized file is a verification error rather than an absent dataset", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad());
  const catalog = path.join(f.rootDir, "index", "catalog.json"); await fs.writeFile(catalog, "{}");
  await assert.rejects(f.store.getAnalysis({ keyword: "경남글램핑", day: "2026-11-01", month: "2026-11" }), { code: "SEARCH_DEMAND_CATALOG_INVALID" });
});
test("corrupt catalog count fields never reach metadata or analysis output", async t => {
  const f = await fixture(t); await f.store.saveSnapshot(ad());
  const file = path.join(f.rootDir, "index", "catalog.json"), original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const change of [
    counts => { counts.secretKey = "must-not-return"; },
    counts => { counts.validRows = -1; },
    counts => { counts.returnedRows = 999; },
    counts => { counts.reconciled = false; },
    counts => { counts.partialKeys = "private-text"; }
  ]) {
    const catalog = structuredClone(original); change(catalog.snapshots[0].counts); await fs.writeFile(file, JSON.stringify(catalog));
    for (const read of [() => f.store.listSnapshots({ keyword: "경남글램핑" }), () => f.store.listKeywords(),
      () => f.store.getAnalysis({ keyword: "경남글램핑", day: "2026-11-01", month: "2026-11" })]) {
      await assert.rejects(read(), { code: "SEARCH_DEMAND_CATALOG_INVALID" });
    }
    assert.equal((await fs.readFile(file, "utf8")), JSON.stringify(catalog), "readers must not repair or rewrite the corrupt record");
  }
});
test("existing writer locks are not stolen or removed", async t => {
  const f = await fixture(t); await fs.mkdir(f.rootDir); const lock = path.join(f.rootDir, "writer.lock"); await fs.writeFile(lock, "existing-lock");
  await assert.rejects(f.store.saveSnapshot(ad()), { code: "SEARCH_DEMAND_STORE_BUSY" }); assert.equal(await fs.readFile(lock, "utf8"), "existing-lock");
});
test("verified forecasts bind exact immutable inputs and remain append-only", async t => {
  const f = await fixture(t), search = ad("경남글램핑", "2026-11-01", [row("경남글램핑", 1790, 7870)]), tr = trend();
  await f.store.saveSnapshot(search); await f.store.saveSnapshot(tr);
  const record = forecast(search, tr), saved = await f.store.saveForecast(record); assert.match(saved.forecastId, /^sf_[a-f0-9]{64}$/);
  const before = await footprint(f.rootDir); assert.equal((await f.store.saveForecast(record)).forecastId, saved.forecastId); assert.deepEqual(await footprint(f.rootDir), before);
  const next = await f.store.saveForecast({ ...record, calculatedAt: "2026-11-01T08:01:00.000Z" }); assert.notEqual(next.forecastId, saved.forecastId);
  const listed = await f.store.listForecasts({ keyword: "경남글램핑", month: "2026-11" }); assert.equal(listed.total, 2); assert.equal(listed.rows[0].forecastId, next.forecastId);
});
test("unpublished or wrongly bound forecasts and arbitrary extra fields are rejected", async t => {
  const f = await fixture(t), search = ad(), tr = trend(); await f.store.saveSnapshot(search); await f.store.saveSnapshot(tr);
  await assert.rejects(f.store.saveForecast(forecast(search, tr, { status: "held" })), { code: "SEARCH_DEMAND_FORECAST_INVALID" });
  await assert.rejects(f.store.saveForecast(forecast(search, tr, { secret: "must-not-persist" })), { code: "SEARCH_DEMAND_FORECAST_INVALID" });
  await assert.rejects(f.store.saveForecast(forecast(search, tr, { inputVolume: 999 })), { code: "SEARCH_DEMAND_FORECAST_SOURCE_MISMATCH" });
  await assert.rejects(f.store.saveForecast(forecast(search, tr, { trendWindowId: "tw_" + "0".repeat(64) })), { code: "SEARCH_DEMAND_FORECAST_SOURCE_MISMATCH" });
  assert.equal((await f.store.listForecasts({ keyword: "경남글램핑" })).total, 0);
});
