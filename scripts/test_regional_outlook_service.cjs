"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRegionalOutlookService, currentKstMonth } = require("./lib/regional_outlook_service.cjs");
const { shiftMonth } = require("./lib/regional_outlook.cjs");

const INPUT = { regionKey: "sancheong" };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function indicators(scope, value = 100, groupStatus = "ready") {
  const rows = Array.from({ length: 13 }, (_, index) => ({ period: shiftMonth(scope.month, index - 12), status: groupStatus === "ready" ? "observed" : "missing", value: groupStatus === "ready" ? value : null }));
  return { status: groupStatus === "ready" ? "ready" : "missing", scope, sourceFingerprint: `source-${value}-${groupStatus}`, indicatorVersion: "test-indicators-v1", networkAttempted: false,
    groups: [{ key: "visitors", label: "지역 방문자", category: "tourism", provider: "시험 제공기관", periodType: "M", status: groupStatus,
      metrics: [{ key: "daily", label: "일평균 방문자", unit: "명", rows }] }] };
}
function storedYear(year, { known = true, stale = false } = {}) {
  return { year, networkAttempted: false, categories: { holidays: { status: known ? stale ? "stale" : "ready" : "missing",
    updatedAt: known ? "2026-10-15T00:00:00Z" : null, stale, items: [], ...(known ? {} : { error: { code: "NOT_COLLECTED" } }) } } };
}
async function tree(root) {
  const result = {};
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else result[path.relative(root, file)] = await fs.readFile(file, "utf8");
    }
  }
  await walk(root); return result;
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "regional-outlook-service-"));
  const runtime = { time: new Date("2026-10-15T01:00:00Z"), value: 100, groupStatus: "ready", fail: null, reads: [], prepares: [], calendarReads: [], calendarRefreshes: [] };
  const services = [];
  function create(overrides = {}) {
    const service = createRegionalOutlookService({ dataDir, autoStart: false, now: () => runtime.time,
      resolveRegion: async key => ["sancheong", "pocheon"].includes(key) ? { regionKey: key, label: key === "sancheong" ? "경상남도 산청군" : "경기도 포천시" } : null,
      readIndicators: async (scope, settings) => { runtime.reads.push({ scope, settings }); if (runtime.fail) throw runtime.fail; return indicators(scope, runtime.value, runtime.groupStatus); },
      prepareIndicators: async scope => { runtime.prepares.push(scope); return { id: "test-preparation", status: "completed", steps: [{ key: "visitors", status: "ready", networkAttempted: false }] }; },
      specialDays: {
        async getCachedYear(year) { runtime.calendarReads.push(year); return storedYear(year); },
        async getYear(year) { runtime.calendarRefreshes.push(year); return storedYear(year); }
      }, ...options, ...overrides });
    services.push(service); return service;
  }
  t.after(async () => {
    for (const service of services) await service.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, runtime, create, service: create() };
}

test("outlook GET is calculation-free, provider-free and write-free for first visit and saved result", async t => {
  const { service, runtime, dataDir } = await fixture(t);
  const before = await tree(dataDir), initial = await service.get(INPUT);
  assert.equal(initial.status, "missing"); assert.equal(initial.snapshot, null); assert.equal(initial.scope.month, "2026-10");
  await Promise.all(Array.from({ length: 6 }, () => service.get(INPUT)));
  assert.equal(runtime.reads.length, 0); assert.equal(runtime.prepares.length, 0); assert.equal(runtime.calendarReads.length, 0);
  assert.deepEqual(await tree(dataDir), before);
  await service.request(INPUT); await service.waitForIdle();
  const savedFiles = await tree(dataDir), saved = await service.get(INPUT), reads = runtime.reads.length;
  assert.equal(saved.snapshot.targets[0].period, "2026-10");
  assert.equal(saved.snapshot.targets[1].period, "2026-11");
  await service.get(INPUT); assert.equal(runtime.reads.length, reads); assert.deepEqual(await tree(dataDir), savedFiles);
});

test("cache-only build ends indicators at completed month and reuses immutable result on unchanged values", async t => {
  const { service, runtime, dataDir } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle();
  const first = await service.get(INPUT), files = await tree(dataDir);
  assert.equal(runtime.reads[0].scope.month, "2026-09"); assert.equal(runtime.reads[0].scope.months, 13);
  assert.deepEqual(runtime.reads[0].settings, { collectMissing: false });
  assert.equal(runtime.prepares.length, 0); assert.equal(runtime.calendarRefreshes.length, 0);
  assert.deepEqual(runtime.calendarReads, [2025, 2026]);
  assert.equal(first.status, "ready"); assert.equal(first.snapshot.metrics[0].forecasts[0].value, 100);
  runtime.time = new Date("2026-10-20T00:00:00Z");
  await service.request(INPUT); await service.waitForIdle();
  const next = await service.get(INPUT);
  assert.equal(next.snapshot.resultId, first.snapshot.resultId); assert.equal(next.job.unchanged, true);
  const resultFiles = object => Object.keys(object).filter(file => file.includes(`${path.sep}results${path.sep}`));
  assert.deepEqual(resultFiles(await tree(dataDir)), resultFiles(files));
  assert.equal((await service.get({ ...INPUT, months: 24 })).snapshot, null);
});

test("restart reuses persisted outlook without any indicator or calendar reads", async t => {
  const { service, runtime, create, dataDir } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle(); const expected = await service.get(INPUT); await service.close();
  const restarted = create(), counts = { reads: runtime.reads.length, calendars: runtime.calendarReads.length };
  const before = await tree(dataDir);
  assert.deepEqual(await restarted.get(INPUT), expected);
  assert.equal(runtime.reads.length, counts.reads); assert.equal(runtime.calendarReads.length, counts.calendars);
  assert.deepEqual(await tree(dataDir), before);
});

test("explicit refresh is the only path that prepares sources and requests annual provider calendars", async t => {
  const { service, runtime } = await fixture(t);
  await service.request(INPUT, { collectMissing: true }); await service.waitForIdle();
  assert.equal(runtime.prepares.length, 1); assert.equal(runtime.prepares[0].month, "2026-09");
  assert.deepEqual(runtime.calendarRefreshes, [2025, 2026]);
  assert.deepEqual(runtime.calendarReads, [2025, 2026]);
  assert.equal((await service.get(INPUT)).snapshot.refreshRequested, true);
  assert.equal((await service.get(INPUT)).snapshot.networkAttempted, false, "Provider-capable refresh may still reuse provider caches");
});

test("missing holiday cache is not zero and stale normal holidays remain usable", async t => {
  const missing = await fixture(t, { specialDays: { getCachedYear: async year => storedYear(year, { known: false }) } });
  await missing.service.request(INPUT); await missing.service.waitForIdle();
  const absent = (await missing.service.get(INPUT)).snapshot;
  assert.equal(absent.status, "partial");
  assert.equal(absent.targets[0].calendar.holidayDays, null);
  assert.equal(absent.metrics[0].forecasts[0].value, 100);
  assert.equal(absent.metrics[0].forecasts[0].holiday.adjustmentApplied, false);
  const stale = await fixture(t, { specialDays: { getCachedYear: async year => storedYear(year, { stale: true }) } });
  await stale.service.request(INPUT); await stale.service.waitForIdle();
  const preserved = (await stale.service.get(INPUT)).snapshot;
  assert.equal(preserved.targets[0].calendar.holidayDays, 0);
  assert.equal(preserved.targets[0].calendar.stale, true);
});

test("source-change invalidation updates only current month and preserves immutable prior result files", async t => {
  const { service, runtime, dataDir } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot, oldFiles = await tree(dataDir);
  runtime.value = 200;
  assert.equal((await service.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "v2" })).queued, 1);
  await service.waitForIdle(); const second = (await service.get(INPUT)).snapshot;
  assert.notEqual(second.resultId, first.resultId); assert.equal(second.metrics[0].forecasts[0].value, 200);
  const afterFiles = await tree(dataDir);
  for (const file of Object.keys(oldFiles).filter(file => file.includes(`${path.sep}results${path.sep}`))) assert.equal(afterFiles[file], oldFiles[file]);
  assert.equal((await service.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "v2" })).deduped, true);
});

test("source changes arriving during a build cannot publish the older generation", async t => {
  const { runtime, create, dataDir } = await fixture(t), entered = deferred(), release = deferred(); let reads = 0;
  const service = create({ readIndicators: async scope => {
    const result = indicators(scope, ++reads === 1 ? 100 : 200);
    if (reads === 1) { entered.resolve(); await release.promise; }
    return result;
  } });
  await service.request(INPUT); const pending = service.waitForIdle(); await entered.promise;
  runtime.value = 200;
  await service.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "during-build-v2" });
  release.resolve(); await pending;
  const result = await service.get(INPUT);
  assert.equal(result.snapshot.metrics[0].forecasts[0].value, 200);
  const files = await tree(dataDir), resultFiles = Object.keys(files).filter(file => file.startsWith(`regional_outlook${path.sep}results${path.sep}`));
  assert.equal(resultFiles.length, 1, "Superseded generation should not have an immutable published result");
});

test("failure and all-failed source responses retain last good forecast and sanitize job error", async t => {
  const { service, runtime, dataDir } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot;
  runtime.fail = Object.assign(new Error("secret-test-token-must-not-escape"), { code: "UNSAFE_SECRET_TEST_TOKEN" });
  await service.request(INPUT); await service.waitForIdle();
  assert.equal((await service.get(INPUT)).job.status, "failed"); assert.deepEqual((await service.get(INPUT)).snapshot, first);
  runtime.fail = null; runtime.groupStatus = "failed";
  await service.request(INPUT); await service.waitForIdle();
  assert.equal((await service.get(INPUT)).job.status, "failed"); assert.deepEqual((await service.get(INPUT)).snapshot, first);
  assert.doesNotMatch(JSON.stringify(await tree(dataDir)), /secret-test-token|UNSAFE_SECRET_TEST_TOKEN/);
});

test("temporarily missing stored indicators must not erase the last normal outlook", async t => {
  const { service, runtime } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot;
  runtime.groupStatus = "missing";
  await service.request(INPUT); await service.waitForIdle();
  assert.equal((await service.get(INPUT)).snapshot.resultId, first.resultId);
  assert.equal((await service.get(INPUT)).snapshot.metrics[0].forecasts[0].value, 100);
});

test("an all-failed explicit preparation cannot masquerade as a successful cached refresh", async t => {
  const { create } = await fixture(t);
  const service = create({ prepareIndicators: async () => ({ status: "failed", steps: [{ key: "visitors", status: "failed", errorCode: "AUTH_ERROR", networkAttempted: true }] }) });
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot;
  await service.request(INPUT, { collectMissing: true }); await service.waitForIdle(); const result = await service.get(INPUT);
  assert.equal(result.job.status, "failed"); assert.equal(result.job.errorCode, "REGIONAL_SOURCE_UNAVAILABLE");
  assert.deepEqual(result.snapshot, first);
});

test("partial refresh diagnostics survive unchanged result reuse and source-generation followups", async t => {
  const { create } = await fixture(t); let service, invalidate = false;
  service = create({ prepareIndicators: async () => {
    if (invalidate) await service.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "refresh-v2" });
    return { status: "partial", steps: [{ key: "visitors", status: "failed", errorCode: "AUTH_ERROR", networkAttempted: true }, { key: "searchTrend", status: "ready", networkAttempted: false }] };
  } });
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot;
  await service.request(INPUT, { collectMissing: true }); await service.waitForIdle(); let result = await service.get(INPUT);
  assert.equal(result.snapshot.resultId, first.resultId); assert.equal(result.job.unchanged, true);
  assert.equal(result.job.refreshDiagnostics.status, "partial"); assert.equal(result.job.refreshDiagnostics.steps[0].errorCode, "AUTH_ERROR");
  invalidate = true;
  await service.request(INPUT, { collectMissing: true }); await service.waitForIdle(); result = await service.get(INPUT);
  assert.equal(result.snapshot.resultId, first.resultId); assert.equal(result.job.refreshDiagnostics.status, "partial");
  assert.equal(result.job.collectMissing, false, "A newer generation never repeats the provider refresh");
});

test("monthly rollover computes new current month locally and leaves prior month read-only", async t => {
  const { service, runtime } = await fixture(t);
  await service.request(INPUT); await service.waitForIdle(); const october = (await service.get(INPUT)).snapshot;
  runtime.time = new Date("2026-10-31T15:00:00Z"); assert.equal(currentKstMonth(runtime.time), "2026-11");
  await assert.rejects(service.request({ ...INPUT, month: "2026-10" }), { code: "REGIONAL_PAST_OUTLOOK_READ_ONLY" });
  const tick = await service.tick(); assert.equal(tick.queued, 1); await service.waitForIdle();
  const november = (await service.get(INPUT)).snapshot;
  assert.equal(november.asOfMonth, "2026-11"); assert.equal(november.sourceScope.month, "2026-10");
  assert.equal(november.targets[1].period, "2026-12");
  assert.deepEqual((await service.get({ ...INPUT, month: "2026-10" })).snapshot, october);
  const refreshes = runtime.calendarRefreshes.length;
  runtime.value = 300; await service.sourceChanged({ regionKey: INPUT.regionKey, sourceKey: "visitors", sourceVersion: "nov-update" }); await service.waitForIdle();
  assert.deepEqual((await service.get({ ...INPUT, month: "2026-10" })).snapshot, october);
  assert.equal((await service.get(INPUT)).snapshot.metrics[0].forecasts[0].value, 300);
  assert.equal(runtime.calendarRefreshes.length, refreshes);
});

test("queued previous-month builds cannot create a historical forecast after the month has closed", async t => {
  const { service, runtime } = await fixture(t);
  await service.request(INPUT);
  runtime.time = new Date("2026-10-31T15:00:00Z");
  await service.waitForIdle();
  assert.equal((await service.get({ ...INPUT, month: "2026-10" })).snapshot?.resultId || null, null);
  assert.equal(runtime.reads.length, 0);
});

test("a build finishing after month rollover cannot rewrite the prior published forecast", async t => {
  const { runtime, create } = await fixture(t), entered = deferred(), release = deferred(); let wait = false;
  const service = create({ readIndicators: async scope => {
    if (wait) { entered.resolve(); await release.promise; }
    return indicators(scope, wait ? 999 : 100);
  } });
  await service.request(INPUT); await service.waitForIdle(); const first = (await service.get(INPUT)).snapshot;
  wait = true; await service.request(INPUT); const pending = service.waitForIdle(); await entered.promise;
  runtime.time = new Date("2026-10-31T15:00:00Z"); release.resolve(); await pending;
  assert.equal((await service.get({ ...INPUT, month: "2026-10" })).snapshot?.resultId, first.resultId);
});

test("restart must not recover an old queued local calculation into a past-month forecast", async t => {
  const { service, runtime, create } = await fixture(t);
  await service.request(INPUT); await service.close();
  runtime.time = new Date("2026-10-31T15:00:00Z");
  const restarted = create(); await restarted.waitForIdle();
  assert.equal((await restarted.get({ ...INPUT, month: "2026-10" })).snapshot?.resultId || null, null);
  assert.equal(runtime.reads.length, 0);
});

test("calendar changes only queue known mutable region scopes and deduplicate identical source versions", async t => {
  const { service, runtime } = await fixture(t);
  await service.calendarChanged("calendar-v1"); assert.equal(runtime.reads.length, 0);
  await service.request(INPUT); await service.waitForIdle();
  await service.calendarChanged("calendar-v1"); await service.waitForIdle();
  const count = runtime.reads.length;
  await service.calendarChanged("calendar-v1"); await service.waitForIdle(); assert.equal(runtime.reads.length, count);
  runtime.time = new Date("2026-10-31T15:00:00Z");
  await service.calendarChanged("calendar-v2"); await service.waitForIdle(); assert.equal(runtime.reads.length, count, "Only a past region exists until rollover tick");
});
