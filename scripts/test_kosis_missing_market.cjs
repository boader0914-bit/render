"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createKosisService, DEFINITIONS, MARKET_METRICS } = require("./lib/kosis.cjs");
const REGION = "kr_gyeonggi_pocheon", PROVINCE = "kr_admin_4100000000";
const units = [
  { regionKey: PROVINCE, regionId: PROVINCE, provinceRegionId: PROVINCE, name: "경기도", sidoFull: "경기도", level: "broad", active: true, selectable: true },
  { regionKey: REGION, regionId: "kr_admin_4165000000", provinceRegionId: PROVINCE, name: "포천시", fullName: "경기도 포천시", sidoFull: "경기도", level: "local", active: true, selectable: true }
];
const code = definition => definition.regionObject === "SGG" ? "31270" : "41650";
function metadata(definition) {
  const province = definition.regionObject === "SGG" ? "31" : "41";
  return [...definition.metrics.map(metric => ({ OBJ_ID: "ITEM", ITM_ID: metric.id, ITM_NM: metric.label, UNIT_NM: metric.unit })),
    { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: province, ITM_NM: "경기도", UP_ITM_ID: "00" },
    { OBJ_ID: definition.regionObject, OBJ_ID_SN: 1, ITM_ID: code(definition), ITM_NM: "포천시", UP_ITM_ID: province },
    ...(definition.breakdowns || []).map(item => ({ OBJ_ID: definition.breakdownObject, OBJ_ID_SN: 2, ITM_ID: item.id, ITM_NM: item.metadataName }))];
}
function rows(definition, dt = "123") {
  return definition.metrics.flatMap(metric => (definition.breakdowns || [null]).map(breakdown => ({
    TBL_ID: definition.tableId, ORG_ID: definition.orgId, ITM_ID: metric.id, C1: code(definition),
    ...(breakdown ? { C2: breakdown.id } : {}), PRD_SE: definition.periodType === "Y" ? "A" : definition.periodType,
    PRD_DE: definition.periodType === "M" ? "202608" : "2024", UNIT_NM: metric.unit, DT: dt, LST_CHN_DE: "20260910"
  })));
}
const reply = (payload, status = 200) => ({ status, ok: status === 200, text: async () => JSON.stringify(payload) });
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "staydatalab-kosis-missing-test-"));
  t.after(async () => { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("staydatalab-kosis-missing-test-")); await fs.rm(resolved, { recursive: true, force: true }); });
  const regionMasterFile = path.join(directory, "regions.json"), dataDir = path.join(directory, "data");
  await fs.writeFile(regionMasterFile, JSON.stringify({ units }));
  let time = Date.parse("2026-09-26T00:00:00Z"), provider = options.provider || ((url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)));
  const calls = [], serviceOptions = { dataDir, regionMasterFile, readApiKey: () => "fixture-only-key", now: () => time, sleep: async ms => { time += ms; }, ...options,
    fetchImpl: async (raw, init) => { const url = new URL(raw), definition = DEFINITIONS.find(item => item.tableId === url.searchParams.get("tblId")); calls.push({ datasetKey: definition.key, method: url.searchParams.get("method"), time }); return provider(url, definition, init); } };
  const cacheFile = path.join(dataDir, crypto.createHash("sha256").update(units[1].regionId).digest("hex").slice(0, 24) + ".json");
  return { service: createKosisService(serviceOptions), restart: () => createKosisService(serviceOptions), dataDir, regionMasterFile, cacheFile,
    attemptFile: cacheFile.replace(/\.json$/, "-attempt.json"), calls, advance: ms => { time += ms; }, setProvider: value => { provider = value; },
    editCache: async action => { const cache = JSON.parse(await fs.readFile(cacheFile, "utf8")); action(cache); await fs.writeFile(cacheFile, JSON.stringify(cache)); } };
}
async function tree(directory) {
  const result = {};
  async function visit(current, relative) { for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const next = path.join(current, entry.name), label = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await visit(next, label); else result[label] = crypto.createHash("sha256").update(await fs.readFile(next)).digest("hex");
  } }
  await visit(directory, ""); return result;
}

test("new local market collects exactly six missing totals with original proof, not age breakdowns", async t => {
  const f = await fixture(t), result = await f.service.refreshMissingMarketRegion(REGION), report = result.marketCollection;
  assert.equal(report.status, "complete"); assert.equal(report.changed, true); assert.equal(report.networkAttempted, true);
  assert.equal(f.calls.length, 12); assert.ok(f.calls.every(call => call.datasetKey !== "age_population"));
  assert.deepEqual(report.attemptedDatasetKeys, MARKET_METRICS.map(item => item.datasetKey));
  assert.deepEqual(report.collectedDatasetKeys, report.attemptedDatasetKeys); assert.deepEqual(report.remaining, []);
  for (const spec of MARKET_METRICS) { const dataset = result.datasets.find(item => item.key === spec.datasetKey); assert.equal(dataset.storedEvidenceVerification.status, "restored"); assert.ok(dataset.spatialEvidence.storedProvenance.sha256); }
  assert.equal(result.datasets.find(item => item.key === "age_population").status, "not_collected");
});

test("verified old annual periods and actual zero are retained with zero requests and zero file changes", async t => {
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition, "0")) });
  await f.service.refreshMissingMarketRegion(REGION); f.advance(40 * 86400000);
  const before = await tree(f.dataDir), count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
  assert.equal(result.marketCollection.status, "not_needed"); assert.equal(result.marketCollection.changed, false); assert.equal(result.networkAttempted, false);
  assert.equal(f.calls.length, count); assert.deepEqual(await tree(f.dataDir), before);
  assert.ok(result.datasets.find(item => item.key === "employment").rows.every(row => row.value === 0));
  assert.equal(result.datasets.find(item => item.key === "employment").period, "2024");
});

test("one missing table uses two requests and preserves every previously stored dataset object", async t => {
  const f = await fixture(t); await f.service.refreshRegion(REGION); f.advance(300001);
  await f.editCache(cache => { delete cache.datasets.households; cache.datasets.population.retainedLegacyAnnotation = { note: "must survive without normalization" }; });
  const before = JSON.parse(await fs.readFile(f.cacheFile, "utf8")), count = f.calls.length;
  const result = await f.service.refreshMissingMarketRegion(REGION), after = JSON.parse(await fs.readFile(f.cacheFile, "utf8"));
  assert.equal(result.marketCollection.status, "complete"); assert.deepEqual(f.calls.slice(count).map(call => call.datasetKey), ["households", "households"]);
  for (const [key, value] of Object.entries(before.datasets)) assert.deepEqual(after.datasets[key], value, key);
});

test("unverified legacy values and missing original evidence are held, not reclassified as missing", async t => {
  for (const alteration of ["legacy", "missing-original"]) await t.test(alteration, async t => {
    const f = await fixture(t); await f.service.refreshMissingMarketRegion(REGION); f.advance(300001);
    if (alteration === "legacy") await f.editCache(cache => { for (const value of Object.values(cache.datasets)) { delete value.spatialEvidence; delete value.responseEvidence; } });
    else await fs.rename(path.join(f.dataDir, "evidence"), path.join(f.dataDir, "evidence-held"));
    const before = await tree(f.dataDir), count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
    assert.equal(result.marketCollection.status, "blocked"); assert.equal(result.marketCollection.skipped.length, 6);
    assert.ok(result.marketCollection.skipped.every(item => item.status === "unverified"));
    assert.equal(f.calls.length, count); assert.deepEqual(await tree(f.dataDir), before);
  });
});

test("suppressed values stay suppressed rather than triggering recurring replacement", async t => {
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition, "...")) });
  await f.service.refreshMissingMarketRegion(REGION); f.advance(300001);
  const before = await tree(f.dataDir), count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
  assert.equal(result.marketCollection.status, "blocked"); assert.ok(result.marketCollection.skipped.every(item => item.status === "suppressed"));
  assert.equal(f.calls.length, count); assert.deepEqual(await tree(f.dataDir), before);
});

test("non-core suppressed sex breakdowns do not make a valid market total missing", async t => {
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition)
    : rows(definition).map(row => ({ ...row, DT: ["population", "employment"].includes(definition.key) && row.ITM_ID !== definition.metrics[0].id ? "..." : row.DT }))) });
  const first = await f.service.refreshMissingMarketRegion(REGION); assert.equal(first.marketCollection.status, "complete");
  f.advance(300001); const before = await tree(f.dataDir), count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
  assert.equal(result.marketCollection.status, "not_needed"); assert.ok(result.marketCollection.skipped.every(item => item.status === "available"));
  assert.equal(f.calls.length, count); assert.deepEqual(await tree(f.dataDir), before);
});

test("an evidence-verified missing core total is eligible while other core tables stay untouched", async t => {
  const f = await fixture(t, { provider: (url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition)
    : rows(definition).map(row => ({ ...row, DT: definition.key === "population" && row.ITM_ID === "T20" ? "-" : row.DT }))) });
  const first = await f.service.refreshMissingMarketRegion(REGION); assert.equal(first.marketCollection.status, "partial");
  assert.deepEqual(first.marketCollection.remaining.map(item => [item.datasetKey, item.status]), [["population", "missing"]]);
  f.advance(300001); f.setProvider((url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)));
  const count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
  assert.equal(result.marketCollection.status, "complete"); assert.deepEqual(f.calls.slice(count).map(item => item.datasetKey), ["population", "population"]);
});

test("corrupt cache and interrupted attempts block acquisition without any writes", async t => {
  for (const alteration of ["cache", "attempt"]) await t.test(alteration, async t => {
    const f = await fixture(t); await f.service.refreshMissingMarketRegion(REGION); f.advance(300001);
    if (alteration === "cache") await fs.writeFile(f.cacheFile, "{invalid");
    else { const attempt = JSON.parse(await fs.readFile(f.attemptFile, "utf8")); attempt.finishedAt = null; await fs.writeFile(f.attemptFile, JSON.stringify(attempt)); }
    const before = await tree(f.dataDir), count = f.calls.length, result = await f.service.refreshMissingMarketRegion(REGION);
    assert.equal(result.marketCollection.status, "blocked"); assert.equal(result.marketCollection.stopReason, alteration === "cache" ? "CACHE_READ_ERROR" : "REFRESH_INCOMPLETE");
    assert.equal(f.calls.length, count); assert.deepEqual(await tree(f.dataDir), before);
  });
});

test("authentication and quota failures stop remaining tables and do not become zero", async t => {
  for (const code of ["AUTH_ERROR", "QUOTA_EXCEEDED"]) await t.test(code, async t => {
    const f = await fixture(t, { provider: () => reply({ err: code === "AUTH_ERROR" ? "10" : "40" }) });
    const result = await f.service.refreshMissingMarketRegion(REGION);
    assert.equal(result.marketCollection.status, "blocked"); assert.equal(result.marketCollection.stopReason, code); assert.equal(f.calls.length, 1);
    assert.ok(result.datasets.every(dataset => dataset.rows.length === 0)); assert.equal(result.marketCollection.changed, false);
    f.advance(300001); const count = f.calls.length;
    assert.equal((await f.service.refreshMissingMarketRegion(REGION)).marketCollection.stopReason, code); assert.equal(f.calls.length, count);
  });
});

test("persisted shared KOSIS daily budget applies to missing-only acquisition and survives restart", async t => {
  const f = await fixture(t, { dailyBudget: 3 }), first = await f.service.refreshMissingMarketRegion(REGION);
  assert.equal(f.calls.length, 3); assert.equal(first.marketCollection.stopReason, "QUOTA_EXCEEDED");
  const budget = JSON.parse(await fs.readFile(path.join(f.dataDir, "request-budget.json"), "utf8")); assert.equal(budget.count, 3);
  f.advance(300001); const result = await f.restart().refreshMissingMarketRegion(REGION);
  assert.equal(result.marketCollection.stopReason, "QUOTA_EXCEEDED"); assert.equal(f.calls.length, 3);
});

test("full and missing-only requests share cooldown and same-region singleflight", async t => {
  const f = await fixture(t); const results = await Promise.all([f.service.refreshMissingMarketRegion(REGION), f.service.refreshMissingMarketRegion(REGION)]);
  assert.equal(f.calls.length, 12); assert.equal(results.filter(result => result.marketCollection.status === "complete").length, 1);
  const reused = results.find(result => ["shared_inflight", "not_needed"].includes(result.marketCollection.status));
  assert.ok(reused); assert.equal(reused.marketCollection.networkAttempted, false);
  assert.equal((await f.service.refreshRegion(REGION)).error.code, "COOLDOWN"); assert.equal(f.calls.length, 12);
  await f.editCache(cache => { delete cache.datasets.households; });
  assert.equal((await f.service.refreshMissingMarketRegion(REGION)).marketCollection.stopReason, "COOLDOWN"); assert.equal(f.calls.length, 12);
});

test("a missing-only request reuses a full regional refresh already in flight", async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { provider: async (url, definition) => { entered(); await gate; return reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)); } });
  const full = f.service.refreshRegion(REGION); await started;
  const missing = f.service.refreshMissingMarketRegion(REGION); release(); await full;
  const result = await missing; assert.equal(f.calls.length, 14); assert.equal(result.marketCollection.status, "shared_inflight");
  assert.equal(result.marketCollection.changed, false); assert.deepEqual(result.marketCollection.attemptedDatasetKeys, []);
});

test("broad regions, aliases, inactive and unselectable regions do not trigger missing-only acquisition", async t => {
  const f = await fixture(t);
  for (const regionKey of [PROVINCE, units[1].regionId, "unknown"]) assert.equal((await f.service.refreshMissingMarketRegion(regionKey)).marketCollection.stopReason, "INVALID_REGION");
  for (const change of [{ active: false }, { selectable: false }]) { await fs.writeFile(f.regionMasterFile, JSON.stringify({ units: [units[0], { ...units[1], ...change }] })); assert.equal((await f.service.refreshMissingMarketRegion(REGION)).marketCollection.stopReason, "INVALID_REGION"); }
  assert.equal(f.calls.length, 0); assert.deepEqual(await tree(f.dataDir), {});
});

test("provider no-data remains absent with null values and is eligible at the next weekly check", async t => {
  const f = await fixture(t, { provider: () => reply({ err: "30" }) });
  const first = await f.service.refreshMissingMarketRegion(REGION); assert.equal(first.marketCollection.status, "partial"); assert.equal(first.marketCollection.stopReason, null);
  assert.ok(first.datasets.every(dataset => !dataset.rows.length)); assert.equal(f.calls.length, 6);
  f.advance(7 * 86400000); f.setProvider((url, definition) => reply(url.searchParams.get("method") === "getMeta" ? metadata(definition) : rows(definition)));
  assert.equal((await f.service.refreshMissingMarketRegion(REGION)).marketCollection.status, "complete"); assert.equal(f.calls.length, 18);
});
