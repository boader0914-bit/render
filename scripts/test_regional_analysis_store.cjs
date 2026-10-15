"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRegionalAnalysisStore, latestCompletedMonth } = require("./lib/regional_analysis_store.cjs");

const NOW = new Date("2026-10-15T00:00:00Z");
const INPUT = { regionKey: "sancheong" };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "regional-store-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
function create(dataDir, extra = {}) {
  return createRegionalAnalysisStore({ dataDir, autoStart: false, now: () => NOW,
    resolveRegion: async key => ["sancheong", "pocheon"].includes(key) ? { regionKey: key, label: key === "sancheong" ? "경상남도 산청군" : "경기도 포천시" } : null,
    buildSnapshot: async () => ({ status: "ready", groups: [{ key: "visitors", status: "ready", value: 0 }] }), ...extra });
}
async function fileTree(root) {
  const result = {};
  async function walk(directoryName) {
    const entries = await fs.readdir(directoryName, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      const full = path.join(directoryName, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result[path.relative(root, full)] = await fs.readFile(full, "utf8");
    }
  }
  await walk(root); return result;
}

test("GET is provider-free, calculation-free and write-free, including the first visit", async t => {
  const dataDir = await directory(t); let calls = 0;
  const store = create(dataDir, { buildSnapshot: async () => { calls++; throw Error("GET must not build"); } });
  const before = await fileTree(dataDir);
  const result = await store.get(INPUT);
  assert.equal(result.status, "missing"); assert.equal(result.snapshot, null); assert.equal(result.job, null); assert.equal(result.policy.enabled, false);
  assert.equal(result.management.schemaVersion, 1);
  assert.equal(result.management.refresh.schedule.enabled, false);
  assert.equal(result.management.refresh.lastProvider.status, "never");
  assert.equal(result.management.refresh.lastProvider.jobId, null);
  await Promise.all(Array.from({ length: 10 }, () => store.get(INPUT)));
  assert.equal(calls, 0); assert.deepEqual(await fileTree(dataDir), before);
  await store.close(); assert.deepEqual(await fileTree(dataDir), before);
});

test("management keeps provider attempts visible after local rebuilds, failed refreshes and month rollover", async t => {
  const dataDir = await directory(t);
  let clock = new Date("2026-10-15T01:00:00Z"), fail = false, builds = 0;
  const createOptions = { now: () => clock, buildSnapshot: async (scope, options) => {
    builds++;
    if (fail && options.collectMissing) throw Object.assign(Error("private provider failure"), { code: "NETWORK_ERROR" });
    return { status: "ready", sourceFingerprint: "same-source", groups: [{ key: "visitors", label: "지역 방문자", periodType: "M", status: "ready",
      requestedThrough: scope.month, metrics: [{ key: "averageDailyVisitors", label: "일평균 방문자", unit: "명", latestPeriod: scope.month, latestValue: 0,
        rows: [{ period: scope.month, status: "observed", value: 0, retrievedAt: "2026-10-01T00:00:00Z" }], availableMonths: 1, expectedMonths: 13 }] }],
      ...(options.collectMissing ? { refreshDiagnostics: { status: "completed", steps: [{ key: "visitors", status: "complete", networkAttempted: true }] } } : {}) };
  } };
  let store = create(dataDir, createOptions);
  const provider = await store.request(INPUT, { collectMissing: true }); await store.waitForIdle();
  const first = await store.get(INPUT), resultId = first.snapshot.resultId;
  const providerFinishedAt = first.job.finishedAt;
  clock = new Date("2026-10-15T02:00:00Z");
  await store.request(INPUT, { collectMissing: false }); await store.waitForIdle();
  let state = await store.get(INPUT);
  assert.equal(state.snapshot.resultId, resultId);
  assert.equal(state.management.refresh.current.kind, "local");
  assert.equal(state.management.refresh.lastProvider.jobId, provider.job.id);
  assert.equal(state.management.refresh.lastProvider.finishedAt, providerFinishedAt);
  assert.equal(state.management.refresh.lastSuccessAt, providerFinishedAt);
  assert.notEqual(state.job.finishedAt, providerFinishedAt);
  fail = true; clock = new Date("2026-10-15T03:00:00Z");
  const failed = await store.request(INPUT, { collectMissing: true }); await store.waitForIdle();
  clock = new Date("2026-10-15T04:00:00Z");
  await store.request(INPUT); await store.waitForIdle(); state = await store.get(INPUT);
  assert.equal(state.management.refresh.lastProvider.jobId, failed.job.id);
  assert.equal(state.management.refresh.lastProvider.status, "failed");
  assert.equal(state.management.refresh.lastProvider.errorCode, "NETWORK_ERROR");
  assert.equal(state.management.refresh.lastSuccessAt, providerFinishedAt);
  assert.equal(state.snapshot.resultId, resultId);
  const before = await fileTree(dataDir), buildCount = builds;
  await store.get(INPUT); assert.deepEqual(await fileTree(dataDir), before); assert.equal(builds, buildCount);
  await store.close();
  clock = new Date("2026-11-01T00:00:00Z"); store = create(dataDir, createOptions);
  state = await store.get(INPUT);
  assert.equal(state.snapshot, null, "New rolling month does not pretend the previous snapshot is current");
  assert.equal(state.management.refresh.lastProvider.jobId, failed.job.id, "Previous month's real attempt remains visible");
  assert.equal((await store.get({ regionKey: "pocheon" })).management.refresh.lastProvider.status, "never", "No other region's refresh leaks into this region");
  assert.equal(builds, buildCount); await store.close();
});

test("normal zero, 13-month defaults and distinct scopes survive restart without rebuilding", async t => {
  const dataDir = await directory(t); let calls = 0;
  let store = create(dataDir, { buildSnapshot: async scope => { calls++; return { status: "ready", groups: [{ key: "visitors", value: 0 }], sourceFingerprint: "source-v1", month: scope.month }; } });
  await store.request(INPUT); await store.waitForIdle();
  const ready = await store.get(INPUT);
  assert.equal(ready.status, "ready"); assert.equal(ready.snapshot.scope.month, "2026-09"); assert.equal(ready.snapshot.scope.months, 13);
  assert.equal(ready.snapshot.groups[0].value, 0); assert.equal(ready.snapshot.sourceFingerprint, "source-v1"); assert.equal(ready.job.status, "completed");
  assert.equal((await store.get({ ...INPUT, months: 24 })).status, "missing");
  assert.equal((await store.get({ ...INPUT, month: "2026-08" })).status, "missing");
  await store.close();
  store = create(dataDir, { buildSnapshot: async () => { calls++; throw Error("restart must reuse"); } });
  const before = await fileTree(dataDir);
  assert.deepEqual(await store.get(INPUT), ready); assert.equal(calls, 1);
  assert.deepEqual(await fileTree(dataDir), before); await store.close();
});

test("scope validation rejects unsupported periods and unknown regions before any queue write", async t => {
  const dataDir = await directory(t), store = create(dataDir);
  for (const input of [{}, { regionKey: "unknown" }, { ...INPUT, month: "2026-13" }, { ...INPUT, month: "2026-11" }, { ...INPUT, month: "1999-01" },
    { ...INPUT, months: 12 }, { ...INPUT, regionKey: "../bad" }, { ...INPUT, extra: "unsupported" }]) {
    await assert.rejects(store.get(input), { statusCode: 400 });
    await assert.rejects(store.request(input), { statusCode: 400 });
  }
  assert.deepEqual(await fileTree(dataDir), {}); await store.close();
  const mismatched = create(dataDir, { resolveRegion: async () => ({ regionKey: "pocheon", label: "포천" }) });
  await assert.rejects(mismatched.get(INPUT), { code: "INVALID_REGIONAL_REGION" }); await mismatched.close();
});

test("concurrent duplicate requests share one job and distinct scopes run serially", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred();
  let calls = 0, active = 0, maximum = 0;
  const store = create(dataDir, { buildSnapshot: async () => {
    active++; maximum = Math.max(maximum, active); const count = ++calls;
    try { if (count === 1) { entered.resolve(); await gate.promise; } return { status: "ready", groups: [{ value: count }] }; }
    finally { active--; }
  } });
  const queued = await Promise.all(Array.from({ length: 15 }, () => store.request(INPUT, { collectMissing: true })));
  assert.equal(new Set(queued.map(value => value.job.id)).size, 1); assert.equal(queued.filter(value => !value.reused).length, 1);
  const running = store.waitForIdle(); await entered.promise;
  assert.equal((await store.request(INPUT)).reused, true);
  await store.request({ regionKey: "pocheon" }); gate.resolve(); await running;
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal((await store.get(INPUT)).job.status, "completed"); await store.close();
});

test("failed refreshes and all-failed source bundles preserve the previous good snapshot", async t => {
  const dataDir = await directory(t); let mode = "normal";
  const store = create(dataDir, { buildSnapshot: async () => {
    if (mode === "throw") throw Object.assign(Error("password=DO_NOT_STORE"), { code: "TOKEN_DO_NOT_STORE" });
    if (mode === "all-failed") return { status: "partial", groups: [{ status: "failed" }, { status: "blocked" }] };
    return { status: "ready", groups: [{ value: 42, status: "ready" }] };
  } });
  await store.request(INPUT); await store.waitForIdle(); const original = (await store.get(INPUT)).snapshot;
  for (const next of ["throw", "all-failed"]) {
    mode = next; await store.request(INPUT, { collectMissing: true }); await store.waitForIdle();
    const result = await store.get(INPUT); assert.equal(result.job.status, "failed"); assert.deepEqual(result.snapshot, original);
  }
  const persisted = JSON.stringify(await fileTree(dataDir)); assert.ok(!persisted.includes("DO_NOT_STORE"));
  await store.get(INPUT); await store.close();
});

test("empty cache builds save a missing diagnostic, while a partial refresh keeps prior normal source groups", async t => {
  const dataDir = await directory(t); let mode = "empty";
  const store = create(dataDir, { buildSnapshot: async () => {
    if (mode === "empty") return { status: "missing", groups: [{ key: "visitors", status: "missing", metrics: [] }] };
    if (mode === "normal") return { status: "ready", groups: [{ key: "visitors", status: "ready", value: 12 }, { key: "searchTrend", status: "ready", value: 10 }] };
    return { status: "partial", groups: [{ key: "visitors", status: "failed", errorCode: "PROVIDER_FAILED" }, { key: "searchTrend", status: "ready", value: 20 }] };
  } });
  await store.request(INPUT); await store.waitForIdle();
  const empty = await store.get(INPUT); assert.equal(empty.status, "missing"); assert.ok(empty.snapshot); assert.equal(empty.job.resultStatus, "missing");
  mode = "normal"; await store.request(INPUT); await store.waitForIdle();
  mode = "partial"; await store.request(INPUT, { collectMissing: true }); await store.waitForIdle();
  const next = await store.get(INPUT); assert.equal(next.status, "partial"); assert.equal(next.snapshot.groups[0].value, 12);
  assert.equal(next.snapshot.groups[0].stale, true); assert.equal(next.snapshot.groups[0].refresh.errorCode, "PROVIDER_FAILED");
  assert.equal(next.snapshot.groups[1].value, 20); await store.close();
});

test("a publication-pending refresh retains a prior partial source that contains observed normal zero", async t => {
  const dataDir = await directory(t); let pending = false;
  const store = create(dataDir, { buildSnapshot: async () => ({ status: pending ? "missing" : "partial", summary: { total: 99, ready: 99 },
    groups: [{ key: "visitors", status: pending ? "publication_pending" : "partial", metrics: [{ key: "daily", rows: [{ period: "2026-08", status: pending ? "missing" : "observed", value: pending ? null : 0 }] }] }],
    sourceFingerprint: pending ? "pending" : "normal" }) });
  await store.request(INPUT); await store.waitForIdle(); const original = (await store.get(INPUT)).snapshot;
  pending = true; await store.request(INPUT); await store.waitForIdle(); const result = (await store.get(INPUT)).snapshot;
  assert.equal(result.groups[0].metrics[0].rows[0].value, 0); assert.equal(result.groups[0].stale, true);
  assert.equal(result.groups[0].lastRefreshErrorCode, "REGIONAL_SOURCE_UNAVAILABLE");
  assert.equal(result.status, "partial"); assert.equal(result.summary.total, 1); assert.equal(result.summary.partial, 1); assert.equal(result.summary.stale, 1);
  assert.notEqual(result.sourceFingerprint, original.sourceFingerprint); assert.notEqual(result.sourceFingerprint, "pending"); await store.close();
});

test("an unchanged source fingerprint reuses the immutable result and records only the verification job", async t => {
  const dataDir = await directory(t);
  const store = create(dataDir, { buildSnapshot: async () => ({ status: "ready", groups: [{ status: "ready", value: 5 }], sourceFingerprint: "same-normal-source" }) });
  await store.request(INPUT); await store.waitForIdle(); const first = await store.get(INPUT), files = await fileTree(dataDir);
  await store.request(INPUT); await store.waitForIdle(); const next = await store.get(INPUT), nextFiles = await fileTree(dataDir);
  assert.equal(next.snapshot.resultId, first.snapshot.resultId); assert.equal(next.job.unchanged, true);
  assert.deepEqual(Object.keys(nextFiles).filter(file => file.includes(`${path.sep}results${path.sep}`)), Object.keys(files).filter(file => file.includes(`${path.sep}results${path.sep}`)));
  await store.close();
});

test("published revisions are immutable; a corrupted latest result falls back without deleting evidence", async t => {
  const dataDir = await directory(t); let value = 1;
  const store = create(dataDir, { buildSnapshot: async () => ({ status: "ready", groups: [{ value: value++ }] }) });
  await store.request(INPUT); await store.waitForIdle(); const first = (await store.get(INPUT)).snapshot;
  await store.request(INPUT); await store.waitForIdle(); const second = (await store.get(INPUT)).snapshot;
  assert.notEqual(first.resultId, second.resultId);
  const before = await fileTree(dataDir), resultFile = Object.keys(before).find(file => file.endsWith(`${second.resultId}.json`));
  await fs.writeFile(path.join(dataDir, resultFile), "{corrupt");
  const tree = await fileTree(dataDir), fallback = await store.get(INPUT);
  assert.equal(fallback.snapshot.resultId, first.resultId); assert.equal(fallback.storage.errorCode, "REGIONAL_RESULT_INVALID");
  assert.deepEqual(await fileTree(dataDir), tree); await store.close();
});

test("provider work is interrupted after restart; queued local calculations resume safely", async t => {
  const dataDir = await directory(t); let calls = 0;
  let store = create(dataDir, { buildSnapshot: async () => { calls++; return { status: "ready", groups: [] }; } });
  await store.request(INPUT, { collectMissing: true }); await store.request({ regionKey: "pocheon" }); await store.close();
  store = create(dataDir, { buildSnapshot: async () => { calls++; return { status: "ready", groups: [] }; } });
  const before = await fileTree(dataDir), interrupted = await store.get(INPUT);
  assert.equal(interrupted.job.status, "interrupted"); assert.equal(interrupted.job.errorCode, "REGIONAL_REFRESH_INTERRUPTED");
  assert.deepEqual(await fileTree(dataDir), before, "recovery observation does not write during GET");
  await store.waitForIdle(); assert.equal(calls, 1); assert.equal((await store.get({ regionKey: "pocheon" })).status, "ready");
  assert.equal((await store.get(INPUT)).status, "missing"); await store.close();
});

test("KST schedules do not run on enable, deduplicate missed occurrences and persist disabled state", async t => {
  const dataDir = await directory(t); let clock = new Date("2026-10-15T23:59:00Z"); // Oct 16 08:59 KST
  let calls = 0, store = create(dataDir, { now: () => clock, buildSnapshot: async (_, options) => { calls++; assert.equal(options.collectMissing, true); return { status: "ready", groups: [] }; } });
  assert.equal((await store.tick()).queued, 0);
  const policy = await store.updatePolicy(INPUT, { enabled: true, hour: 9, minute: 0, intervalHours: 24 });
  assert.equal(policy.nextRunAt, "2026-10-16T00:00:00.000Z"); assert.equal((await store.get(INPUT)).job, null);
  clock = new Date("2026-10-16T00:00:00Z"); assert.equal((await store.tick()).queued, 1); assert.equal((await store.tick()).queued, 0);
  await store.waitForIdle(); assert.equal(calls, 1);
  clock = new Date("2026-10-19T01:00:00Z"); assert.equal((await store.tick()).queued, 1); assert.equal((await store.tick()).queued, 0);
  await store.waitForIdle(); assert.equal(calls, 2, "missed days are not backfilled into repeated provider calls");
  assert.equal((await store.get(INPUT)).policy.nextRunAt, "2026-10-20T00:00:00.000Z");
  await store.updatePolicy(INPUT, { enabled: false }); await store.close();
  store = create(dataDir, { now: () => clock }); assert.equal((await store.get(INPUT)).policy.enabled, false); assert.equal((await store.tick()).queued, 0); await store.close();
});

test("rolling schedules advance to the newest completed KST month", async t => {
  const dataDir = await directory(t); let clock = new Date("2026-10-31T14:59:00Z");
  const store = create(dataDir, { now: () => clock });
  await store.updatePolicy(INPUT, { enabled: true, hour: 0, minute: 0, intervalHours: 24 });
  clock = new Date("2026-10-31T15:00:00Z"); await store.tick(); await store.waitForIdle();
  const result = await store.get(INPUT); assert.equal(result.snapshot.scope.month, "2026-10"); assert.equal(result.snapshot.scope.months, 13);
  assert.equal(latestCompletedMonth("2026-01-01T00:00:00+09:00"), "2025-12"); await store.close();
});

test("closing during a callback prevents a late result from being published", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred();
  const store = create(dataDir, { buildSnapshot: async () => { entered.resolve(); await gate.promise; return { status: "ready", groups: [{ value: 99 }] }; } });
  await store.request(INPUT); const running = store.waitForIdle(); await entered.promise;
  await store.close(); gate.resolve(); await running;
  const result = await store.get(INPUT); assert.equal(result.snapshot, null); assert.equal(result.job.status, "interrupted");
  await assert.rejects(store.request(INPUT), { code: "REGIONAL_STORE_CLOSED" });
  const recovered = create(dataDir);
  await recovered.waitForIdle(); assert.equal((await recovered.get(INPUT)).status, "ready", "an interrupted pure cache build resumes safely"); await recovered.close();
});

test("corrupt queue is surfaced safely and never overwrites a previously saved result", async t => {
  const dataDir = await directory(t); let store = create(dataDir);
  await store.request(INPUT); await store.waitForIdle(); const original = (await store.get(INPUT)).snapshot; await store.close();
  const queue = path.join(dataDir, "regional_analysis", "queue.json"); await fs.writeFile(queue, "{broken");
  store = create(dataDir); const result = await store.get(INPUT);
  assert.equal(result.snapshot.resultId, original.resultId); assert.equal(result.storage.errorCode, "REGIONAL_STORE_UNAVAILABLE");
  await assert.rejects(store.request(INPUT), { code: "REGIONAL_STORE_UNAVAILABLE" });
  assert.equal(await fs.readFile(queue, "utf8"), "{broken"); await store.close();
});

test("source events persist version deduplication and rebuild only known regions from cache", async t => {
  const dataDir = await directory(t); let version = 1, calls = 0;
  const buildSnapshot = async (_, options) => { calls++; assert.equal(options.collectMissing, false); return { status: "ready", groups: [{ status: "ready", value: version }], sourceFingerprint: `version-${version}` }; };
  let store = create(dataDir, { buildSnapshot });
  assert.deepEqual(await store.sourceChanged({ regionKey: "pocheon", sourceKey: "visitors", sourceVersion: "before-first-request" }), { ignored: true, deduped: false, queued: 0 });
  assert.deepEqual(await fileTree(dataDir), {}, "unseen sources do not create first backfills");
  await store.request(INPUT); await store.waitForIdle(); version = 2;
  const changed = await store.sourceChanged({ regionKey: "sancheong", sourceKey: "visitors", sourceVersion: "v2" }); assert.equal(changed.queued, 1);
  assert.equal((await store.get(INPUT)).snapshot.groups[0].value, 1, "source event does not discard the previous snapshot");
  await store.waitForIdle(); assert.equal((await store.get(INPUT)).snapshot.groups[0].value, 2); await store.close();
  store = create(dataDir, { buildSnapshot });
  const before = await fileTree(dataDir), duplicate = await store.sourceChanged({ regionKey: "sancheong", sourceKey: "visitors", sourceVersion: "v2" });
  assert.equal(duplicate.deduped, true); assert.deepEqual(await fileTree(dataDir), before); await store.waitForIdle(); assert.equal(calls, 2); await store.close();
});

test("source changes during a build prevent stale publication and coalesce into one cache-only follow-up", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred(); let calls = 0;
  const store = create(dataDir, { buildSnapshot: async (_, options) => {
    const call = ++calls;
    if (call === 1) { entered.resolve(); await gate.promise; }
    else assert.equal(options.collectMissing, false);
    return { status: "ready", groups: [{ status: "ready", value: call }] };
  } });
  await store.request(INPUT, { collectMissing: true }); const running = store.waitForIdle(); await entered.promise;
  await store.sourceChanged({ regionKey: "sancheong", sourceKey: "visitors", sourceVersion: "v2" });
  await store.sourceChanged({ regionKey: "sancheong", sourceKey: "searchTrend", sourceVersion: "v3" });
  assert.equal((await store.get(INPUT)).snapshot, null); gate.resolve(); await running;
  const result = await store.get(INPUT); assert.equal(result.snapshot.groups[0].value, 2); assert.equal(calls, 2);
  const files = await fileTree(dataDir); assert.equal(Object.keys(files).filter(file => file.includes(`${path.sep}results${path.sep}`)).length, 1, "superseded result was not published or saved as a normal revision");
  const queue = JSON.parse(files[path.join("regional_analysis", "queue.json")]); assert.ok(Object.values(queue.jobs).some(job => job.status === "superseded")); await store.close();
});

test("a persisted source change survives restart as a local rebuild, never a repeated provider request", async t => {
  const dataDir = await directory(t);
  let store = create(dataDir); await store.request(INPUT); await store.waitForIdle();
  await store.sourceChanged({ regionKey: "sancheong", sourceKey: "visitors", sourceVersion: "v2" }); await store.close();
  let calls = 0;
  store = create(dataDir, { buildSnapshot: async (_, options) => { calls++; assert.equal(options.collectMissing, false); return { status: "ready", groups: [{ status: "ready", value: 2 }] }; } });
  await store.waitForIdle(); assert.equal(calls, 1); assert.equal((await store.get(INPUT)).snapshot.groups[0].value, 2); await store.close();
});
