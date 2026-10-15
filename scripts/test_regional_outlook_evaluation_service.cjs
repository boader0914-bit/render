"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createRegionalAnalysisStore } = require("./lib/regional_analysis_store.cjs");
const { createRegionalOutlookEvaluationService, createForecastPublicationJournal } = require("./lib/regional_outlook_evaluation_service.cjs");
const { buildRegionalOutlook, shiftMonth } = require("./lib/regional_outlook.cjs");
const INPUT = { regionKey: "sancheong" };
const resolveRegion = async key => key === INPUT.regionKey ? { regionKey: key, label: "경상남도 산청군" } : null;
function indicators(scope, value, receivedAt, status = "observed") {
  return { scope, status: "ready", networkAttempted: false, sourceFingerprint: `actual-${value}-${status}`, groups: [{ key: "visitors", label: "지역 방문자", category: "tourism", provider: "시험 공식 제공기관", periodType: "M", status: "ready", metrics: [{ key: "averageDailyVisitors", label: "일평균 방문자", unit: "명",
    rows: Array.from({ length: 14 }, (_, index) => ({ period: shiftMonth(scope.month, index - 13), status, value: status === "observed" ? value : null, retrievedAt: receivedAt })) }] }] };
}
async function tree(root) {
  const files = {};
  async function walk(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file); else files[path.relative(root, file)] = await fs.readFile(file, "utf8");
    }
  }
  await walk(root); return files;
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-evaluation-"));
  const runtime = { time: new Date("2026-09-02T01:00:00Z"), value: 100, actual: 110, actualStatus: "observed", actualFail: false, reads: [] }, services = [];
  const forecast = createRegionalAnalysisStore({ dataDir, resolveRegion, autoStart: false, now: () => runtime.time,
    directoryName: "regional_outlook", calculationVersion: "regional-outlook-storage-v1", defaultMonth: value => new Date(value).toISOString().slice(0, 7),
    buildSnapshot: scope => ({ ...buildRegionalOutlook({ snapshot: indicators({ ...scope, month: shiftMonth(scope.month, -1) }, runtime.value, "2026-09-01T00:00:00Z"), asOfDate: `${scope.month}-02`, calendar: { months: [] } }), sourceScope: { ...scope, month: shiftMonth(scope.month, -1) } }) });
  services.push(forecast);
  const create = (overrides = {}) => {
    const service = createRegionalOutlookEvaluationService({ dataDir, resolveRegion, autoStart: false, now: () => runtime.time,
      readIndicators: async (scope, options) => {
        runtime.reads.push({ scope, options }); if (runtime.actualFail) throw new Error("do-not-expose-test-secret");
        const result = indicators(scope, runtime.actual, new Date(runtime.time).toISOString(), runtime.actualStatus);
        return runtime.mutate ? runtime.mutate(result) : result;
      }, ...overrides });
    services.push(service); return service;
  };
  async function publish() { await forecast.request(INPUT); await forecast.waitForIdle(); return (await forecast.get(INPUT)).snapshot; }
  t.after(async () => { for (const service of services) await service.close(); assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, runtime, forecast, publish, create, evaluation: create() };
}

test("GET never inventories forecasts, reads indicators, queues work or writes, including restart", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  const before = await tree(f.dataDir);
  assert.equal((await f.evaluation.get(INPUT)).snapshot, null); assert.deepEqual(await tree(f.dataDir), before); assert.equal(f.runtime.reads.length, 0);
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  const saved = await f.evaluation.get(INPUT), files = await tree(f.dataDir), reads = f.runtime.reads.length;
  assert.equal(saved.job.status, "completed", JSON.stringify(saved)); assert.equal(saved.snapshot.summaryCounts.compared, 1);
  await f.evaluation.close(); const restarted = f.create();
  assert.deepEqual(await restarted.get(INPUT), saved); assert.equal(f.runtime.reads.length, reads); assert.deepEqual(await tree(f.dataDir), files);
  assert.equal(f.runtime.reads[0].scope.month, "2026-09"); assert.deepEqual(f.runtime.reads[0].options, { collectMissing: false });
});

test("legacy references are journaled; orphan results never enter the evaluation", async t => {
  const f = await fixture(t), first = await f.publish();
  const state = JSON.parse(await fs.readFile(path.join(f.dataDir, "regional_outlook/queue.json")));
  const scopeKey = Object.keys(state.results)[0], orphan = { ...first, resultId: crypto.randomUUID(), generatedAt: "2026-09-01T00:00:00Z" };
  await fs.writeFile(path.join(f.dataDir, "regional_outlook/results", scopeKey, `${orphan.resultId}.json`), JSON.stringify(orphan));
  f.runtime.time = new Date("2026-10-16T01:00:00Z"); await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  const result = (await f.evaluation.get(INPUT)).snapshot;
  assert.ok(result.rows.length); assert.ok(result.rows.every(row => row.predictionRef.resultId === first.resultId));
  assert.ok(result.rows.every(row => row.predictionRef.coverage === "legacy_reference"));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(orphan.resultId));
});

test("publication journal is immutable and survives more than eight forecast revisions and lost old references", async t => {
  const f = await fixture(t), first = await f.publish();
  await f.evaluation.recordPublication(first); await f.evaluation.waitForIdle();
  const journalBefore = Object.fromEntries(Object.entries(await tree(f.dataDir)).filter(([key]) => key.includes(`${path.sep}publications${path.sep}`)));
  f.runtime.time = new Date("2026-09-03T01:00:00Z"); await f.evaluation.recordPublication(first); await f.evaluation.waitForIdle();
  for (let index = 0; index < 10; index++) { f.runtime.value++; await f.publish(); }
  const stateFile = path.join(f.dataDir, "regional_outlook/queue.json"), state = JSON.parse(await fs.readFile(stateFile));
  for (const [id, job] of Object.entries(state.jobs)) if (job.resultId === first.resultId) delete state.jobs[id];
  await fs.writeFile(stateFile, JSON.stringify(state));
  f.runtime.time = new Date("2026-10-16T01:00:00Z"); await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  const result = (await f.evaluation.get(INPUT)).snapshot;
  assert.ok(result.rows.every(row => row.predictionRef.resultId === first.resultId));
  assert.ok(result.rows.every(row => row.predictionRef.coverage === "recorded"));
  for (const [file, content] of Object.entries(journalBefore)) assert.equal((await tree(f.dataDir))[file], content);
});

test("official corrections create new evaluation revisions without altering the forecast, unchanged values reuse saved results", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  const first = (await f.evaluation.get(INPUT)).snapshot, files = await tree(f.dataDir);
  assert.equal(first.rows.find(row => row.status === "compared").actualValue, 110);
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  assert.equal((await f.evaluation.get(INPUT)).snapshot.resultId, first.resultId);
  f.runtime.time = new Date("2026-10-17T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  assert.equal((await f.evaluation.get(INPUT)).snapshot.resultId, first.resultId, "A newer read timestamp alone is not a correction");
  f.runtime.actual = 120;
  await f.evaluation.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "corrected-value" }); await f.evaluation.waitForIdle();
  const second = (await f.evaluation.get(INPUT)).snapshot;
  assert.notEqual(second.resultId, first.resultId); assert.equal(second.rows.find(row => row.status === "compared").actualValue, 120);
  const after = await tree(f.dataDir);
  for (const [file, value] of Object.entries(files).filter(([key]) => key.includes(`${path.sep}results${path.sep}`) || key.includes(`${path.sep}publications${path.sep}`))) assert.equal(after[file], value);
});

test("error, missing and partial actual reads preserve previous compared result and cannot become zero", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle(); const first = (await f.evaluation.get(INPUT)).snapshot;
  for (const status of ["missing", "partial", "error"]) {
    f.runtime.actualStatus = status; await f.evaluation.request(INPUT); await f.evaluation.waitForIdle(); const result = await f.evaluation.get(INPUT);
    assert.equal(result.job.status, "failed", status); assert.deepEqual(result.snapshot, first);
  }
  f.runtime.actualFail = true; await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  assert.deepEqual((await f.evaluation.get(INPUT)).snapshot, first); assert.doesNotMatch(JSON.stringify(await tree(f.dataDir)), /do-not-expose-test-secret/);
});

test("a true zero is compared and protected journal rejects conflicting same-id content", async t => {
  const f = await fixture(t), forecast = await f.publish(); f.runtime.actual = 0; f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  const row = (await f.evaluation.get(INPUT)).snapshot.rows.find(row => row.status === "compared");
  assert.equal(row.actualValue, 0); assert.equal(row.errorPct, null); assert.equal(row.absoluteError, 100);
  const journal = createForecastPublicationJournal({ dataDir: f.dataDir, now: () => f.runtime.time });
  await assert.rejects(journal.capture({ ...forecast, sourceFingerprint: "tampered" }), { code: "REGIONAL_RESULT_INVALID" });
});

test("invalid actual metadata cannot replace a previously comparable official result", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle(); const first = (await f.evaluation.get(INPUT)).snapshot;
  for (const mutate of [result => { result.groups[0].provider = "다른 제공기관"; return result; },
    result => { result.groups[0].metrics[0].unit = "지수"; return result; },
    result => { result.groups[0].metrics[0].rows.push(result.groups[0].metrics[0].rows.at(-1)); return result; }]) {
    f.runtime.mutate = mutate; await f.evaluation.request(INPUT); await f.evaluation.waitForIdle(); const saved = await f.evaluation.get(INPUT);
    assert.equal(saved.job.status, "failed"); assert.equal(saved.job.errorCode, "REGIONAL_SOURCE_UNAVAILABLE"); assert.deepEqual(saved.snapshot, first);
  }
});

test("no publication is a normal empty validation; providers and historical recalculation remain forbidden", async t => {
  const f = await fixture(t); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle();
  assert.equal((await f.evaluation.get(INPUT)).snapshot.summaryCounts.total, 0); assert.equal(f.runtime.reads.length, 0);
  await assert.rejects(f.evaluation.request(INPUT, { collectMissing: true }), { statusCode: 400 });
  await assert.rejects(f.evaluation.request({ ...INPUT, month: "2026-09" }), { code: "REGIONAL_PAST_OUTLOOK_READ_ONLY" });
});

test("a publication arriving during evaluation invalidates the older calculation generation", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  let entered, release, reads = 0;
  const waiting = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const service = f.create({ readIndicators: async scope => { const result = indicators(scope, 110, f.runtime.time.toISOString()); if (++reads === 1) { entered(); await held; } return result; } });
  await service.request(INPUT); const idle = service.waitForIdle(); await waiting;
  const next = await f.publish(); await service.recordPublication(next); release(); await idle;
  const result = await service.get(INPUT);
  assert.equal(result.job.status, "completed"); assert.ok(reads >= 2);
  assert.ok(result.snapshot.rows.some(row => row.issueMonth === "2026-10" && row.predictionRef.resultId === next.resultId));
});

test("monthly rollover evaluates newly closed targets and preserves the previous evaluation file", async t => {
  const f = await fixture(t); await f.publish(); f.runtime.time = new Date("2026-10-16T01:00:00Z");
  await f.evaluation.request(INPUT); await f.evaluation.waitForIdle(); const october = (await f.evaluation.get(INPUT)).snapshot;
  assert.equal(october.summaryCounts.compared, 1); assert.equal(october.summaryCounts.pending, 1);
  f.runtime.time = new Date("2026-10-31T15:00:00Z");
  assert.equal((await f.evaluation.tick()).queued, 1); await f.evaluation.waitForIdle();
  const november = (await f.evaluation.get(INPUT)).snapshot;
  assert.equal(november.scope.month, "2026-11"); assert.equal(november.summaryCounts.compared, 2);
  assert.deepEqual((await f.evaluation.get({ ...INPUT, month: "2026-10" })).snapshot, october);
});
