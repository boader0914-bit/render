"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { test } = require("node:test");
const { createCollectionPostprocessQueue } = require("./lib/collection_postprocess_queue.cjs");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "collection-postprocess-"));
  let instant = Date.parse("2026-10-20T00:00:00.000Z");
  const queues = [];
  const create = more => { const queue = createCollectionPostprocessQueue({ dataDir, now: () => new Date(instant), processRun: async () => {}, ...options, ...more }); queues.push(queue); return queue; };
  t.after(async () => {
    for (const queue of queues) await queue.close();
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(await fs.realpath(os.tmpdir())) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, create, advance: amount => { instant += amount; } };
}

test("enqueue is durable and idle; held runs require a separate durable release even with a scheduler", async t => {
  let calls = 0;
  const timers = new Map(); let timerId = 0;
  const f = await fixture(t, { processRun: async () => { calls++; }, setTimeoutImpl: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeoutImpl: id => timers.delete(id) });
  const queue = f.create();
  const held = await queue.enqueue("run_held", { deferred: true, context: { scheduleOccurrenceId: "rotation_2026-10-20_1", job: { workerKey: "manual" } } });
  assert.equal(held.state, "held"); assert.equal(held.scheduleOccurrenceId, "rotation_2026-10-20_1");
  assert.equal(calls, 0); assert.equal(JSON.parse(await fs.readFile(queue.stateFile)).jobs.run_held.status, "held");
  await queue.start(); assert.equal(await queue.runOnce(), null); assert.equal(calls, 0);
  const restarted = f.create(); assert.equal((await restarted.get("run_held")).state, "held");
  await restarted.release("run_held"); assert.equal((await restarted.runOnce()).state, "complete"); assert.equal(calls, 1);
});

test("run ids are idempotent before and after restart, including pruned terminal receipts", async t => {
  const seen = [];
  const f = await fixture(t, { maxRetained: 1, processRun: async (runId, context) => { seen.push([runId, context.job.value]); return { stages: { integrated: "complete" }, elapsedMs: 4, appended: true, ignoredPayload: "not retained" }; } });
  const queue = f.create();
  const first = await queue.enqueue("run_one", { context: { job: { value: 1 } } });
  assert.equal((await queue.enqueue("run_one", { context: { job: { value: 2 } } })).sequence, first.sequence);
  assert.equal((await queue.runOnce()).state, "complete");
  await queue.enqueue("run_two", { context: { job: { value: 3 } } }); await queue.runOnce();
  assert.equal((await queue.status()).items.length, 1);
  const restarted = f.create();
  const saved = await restarted.enqueue("run_one", { context: { job: { value: 999 } } });
  assert.equal(saved.state, "complete"); assert.deepEqual(saved.result, { stages: { integrated: "complete" }, elapsedMs: 4, appended: true });
  assert.equal(await restarted.runOnce(), null); assert.deepEqual(seen, [["run_one", 1], ["run_two", 3]]);
});

test("concurrent runOnce and enqueues never overlap processing and a queued run keeps its context", async t => {
  const entered = deferred(), finish = deferred(); let active = 0, maximum = 0; const seen = [];
  const f = await fixture(t, { processRun: async (runId, context) => { maximum = Math.max(maximum, ++active); seen.push([runId, context.attempt, context.job]); if (runId === "run_first") { entered.resolve(); await finish.promise; } active--; } });
  const queue = f.create(); await queue.enqueue("run_first", { context: { job: "first" } });
  const a = queue.runOnce(), b = queue.runOnce(); await entered.promise;
  await queue.enqueue("run_second", { context: { job: "second" } });
  const status = await queue.status({ runId: "run_first" });
  assert.equal(status.state, "running"); assert.equal(status.context, undefined);
  assert.equal((await queue.status()).activeRunId, "run_first");
  finish.resolve(); await Promise.all([a, b]); await queue.runOnce();
  assert.equal(maximum, 1); assert.deepEqual(seen, [["run_first", 1, "first"], ["run_second", 1, "second"]]);
});

test("admission defers without using an attempt and cannot run until explicitly admitted", async t => {
  let admitted = false, calls = 0;
  const f = await fixture(t, { idleIntervalMs: 10, canProcess: async () => admitted, processRun: async () => { calls++; } });
  const queue = f.create(); await queue.enqueue("run_admission");
  const postponed = await queue.runOnce(); assert.equal(postponed.state, "queued"); assert.equal(postponed.attempts, 0); assert.equal(postponed.admissionDeferrals, 1);
  admitted = true; assert.equal(await queue.runOnce(), null); f.advance(10);
  assert.equal((await queue.runOnce()).state, "complete"); assert.equal(calls, 1);
});

test("retry delays are capped, failures stay visible, terminal failure never restarts collection or retries indefinitely", async t => {
  let calls = 0;
  const f = await fixture(t, { maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 15, processRun: async () => { calls++; throw Object.assign(new Error("private password and cookie"), { code: "DERIVED_SOURCE_MISSING" }); } });
  const queue = f.create(); await queue.enqueue("run_failure");
  const one = await queue.runOnce(); assert.equal(one.attempts, 1); assert.equal(one.state, "queued"); assert.equal(one.lastErrorCode, "DERIVED_SOURCE_MISSING");
  assert.equal(Date.parse(one.nextAttemptAt) - Date.parse(one.updatedAt), 10); assert.equal(await queue.runOnce(), null);
  f.advance(10); const two = await queue.runOnce(); assert.equal(Date.parse(two.nextAttemptAt) - Date.parse(two.updatedAt), 15);
  f.advance(15); const three = await queue.runOnce(); assert.equal(three.state, "failed"); assert.equal(three.attempts, 3);
  await queue.enqueue("run_failure"); assert.equal(await queue.runOnce(), null); assert.equal(calls, 3);
  const text = await fs.readFile(queue.stateFile, "utf8"); assert.equal(text.includes("private password"), false);
  assert.equal((await f.create().get("run_failure")).state, "failed");
});

test("nonretryable processing failure preserves the last normal derived file and safe error only", async t => {
  const f = await fixture(t);
  const normal = path.join(f.dataDir, "previous-derived.json"), content = '{"value":16}'; await fs.writeFile(normal, content);
  const queue = f.create({ processRun: async () => { throw Object.assign(new Error("URL?token=private"), { code: "BAD_DERIVED_INPUT", retryable: false }); } });
  await queue.enqueue("run_invalid"); const failed = await queue.runOnce();
  assert.equal(failed.state, "failed"); assert.equal(failed.lastErrorCode, "BAD_DERIVED_INPUT"); assert.equal(failed.attempts, 1);
  assert.equal(await fs.readFile(normal, "utf8"), content); assert.equal(JSON.stringify(failed).includes("private"), false);
});

test("restart recovers only interrupted running rows, retaining held rows and bounded attempt budget", async t => {
  const f = await fixture(t, { maxAttempts: 2 });
  const queue = f.create(); await queue.enqueue("run_interrupted"); await queue.enqueue("run_still_held", { deferred: true });
  const directory = path.join(f.dataDir, "collection_postprocess", "runs");
  const files = await fs.readdir(directory);
  const records = await Promise.all(files.map(async file => ({ file, row: JSON.parse(await fs.readFile(path.join(directory, file))) })));
  const interrupted = records.find(item => item.row.runId === "run_interrupted");
  Object.assign(interrupted.row, { status: "running", attempts: 1, startedAt: interrupted.row.createdAt, nextAttemptAt: null });
  await fs.writeFile(path.join(directory, interrupted.file), JSON.stringify(interrupted.row));
  await fs.writeFile(path.join(f.dataDir, "collection_postprocess", "pending", interrupted.file), JSON.stringify(interrupted.row));
  const restarted = f.create();
  assert.equal((await restarted.get("run_interrupted")).state, "queued"); assert.equal((await restarted.get("run_still_held")).state, "held");
  assert.equal((await restarted.runOnce()).attempts, 2); assert.equal((await restarted.get("run_interrupted")).state, "complete");
  const exhaustedFile = path.join(directory, interrupted.file), exhausted = JSON.parse(await fs.readFile(exhaustedFile));
  exhausted.status = "running"; exhausted.context = {}; exhausted.nextAttemptAt = null; await fs.writeFile(exhaustedFile, JSON.stringify(exhausted));
  await fs.writeFile(path.join(f.dataDir, "collection_postprocess", "pending", interrupted.file), JSON.stringify(exhausted));
  const again = f.create(); assert.equal((await again.get("run_interrupted")).lastErrorCode, "COLLECTION_POSTPROCESS_INTERRUPTED_EXHAUSTED");
  assert.equal(await again.runOnce(), null);
});

test("corrupt state fails closed without overwriting the original bytes or invoking processing", async t => {
  let calls = 0; const f = await fixture(t, { processRun: async () => { calls++; } }); const queue = f.create();
  await fs.mkdir(path.dirname(queue.stateFile), { recursive: true }); await fs.writeFile(queue.stateFile, '{"version":1,"jobs":');
  await assert.rejects(queue.runOnce(), { code: "COLLECTION_POSTPROCESS_STATE_INVALID" });
  assert.equal(await fs.readFile(queue.stateFile, "utf8"), '{"version":1,"jobs":'); assert.equal(calls, 0);
});

test("write failure before durable enqueue returns no acknowledgement and never invokes work", async t => {
  const f = await fixture(t); const queue = f.create({ fileSystem: { ...fs, rename: async () => { throw Object.assign(new Error("disk is full at secret path"), { code: "ENOSPC" }); } } });
  await assert.rejects(queue.enqueue("run_nodisk"), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  await assert.rejects(queue.runOnce(), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  assert.equal((await queue.status()).errorCode, "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED");
});

test("a completion receipt write failure is never advertised as complete; restart safely retries idempotent derivation", async t => {
  let fail = false, calls = 0;
  const f = await fixture(t, { processRun: async () => { calls++; fail = true; } });
  const queue = f.create({ fileSystem: { ...fs, rename: async (...args) => { if (fail) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); return fs.rename(...args); } } });
  await queue.enqueue("run_receipt_failure");
  await assert.rejects(queue.runOnce(), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  assert.equal((await queue.get("run_receipt_failure")).state, "running");
  fail = false; const restarted = f.create({ processRun: async () => { calls++; } });
  assert.equal((await restarted.runOnce()).state, "complete"); assert.equal(calls, 2);
});

test("a first enqueue whose record succeeds but queue index fails is discovered once from the bounded pending spool", async t => {
  let calls = 0;
  const f = await fixture(t, { processRun: async () => { calls++; } });
  const queue = f.create({ fileSystem: { ...fs, rename: async (source, target) => {
    if (target.endsWith(path.sep + "queue.json")) throw Object.assign(new Error("index disk failure"), { code: "ENOSPC" });
    return fs.rename(source, target);
  } } });
  await assert.rejects(queue.enqueue("run_orphan", { context: { scheduleOccurrenceId: "rotation_2026-10-20_1" } }), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  const restarted = f.create();
  assert.equal((await restarted.status({ runId: "run_orphan" })).state, "queued");
  assert.equal((await restarted.runOnce()).state, "complete"); assert.equal(await restarted.runOnce(), null); assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, "collection_postprocess", "pending")), []);
});

test("a pending journal survives failure before ordinary record publication and restores held status without processing", async t => {
  let calls = 0;
  const f = await fixture(t, { processRun: async () => { calls++; } });
  const queue = f.create({ fileSystem: { ...fs, rename: async (source, target) => {
    if (target.includes(path.sep + "runs" + path.sep)) throw Object.assign(new Error("record disk failure"), { code: "ENOSPC" });
    return fs.rename(source, target);
  } } });
  await assert.rejects(queue.enqueue("run_held_orphan", { deferred: true, context: { scheduleOccurrenceId: "rotation_2026-10-20_1" } }), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  const restarted = f.create();
  assert.equal((await restarted.status({ runId: "run_held_orphan" })).state, "held"); assert.equal(await restarted.runOnce(), null); assert.equal(calls, 0);
  await restarted.release("run_held_orphan"); assert.equal((await restarted.runOnce()).state, "complete"); assert.equal(calls, 1);
});

test("a durable completed receipt preceding an index failure is recovered without repeating derived work", async t => {
  let completed = false, calls = 0;
  const f = await fixture(t, { processRun: async () => { completed = true; calls++; } });
  const queue = f.create({ fileSystem: { ...fs, rename: async (source, target) => {
    if (completed && target.endsWith(path.sep + "queue.json")) throw Object.assign(new Error("index disk failure"), { code: "ENOSPC" });
    return fs.rename(source, target);
  } } });
  await queue.enqueue("run_done_before_index"); await assert.rejects(queue.runOnce(), { code: "COLLECTION_POSTPROCESS_STORE_WRITE_FAILED" });
  const restarted = f.create(); assert.equal((await restarted.get("run_done_before_index")).state, "complete");
  assert.equal(await restarted.runOnce(), null); assert.equal(calls, 1);
});

test("context limits and credential rejection prevent public or durable secret metadata", async t => {
  const f = await fixture(t), queue = f.create();
  for (const context of [{ apiKey: "private" }, { job: { collectorRunToken: "private" } }, { authorization: "private" }]) {
    await assert.rejects(queue.enqueue("run_secret", { context }), { code: "COLLECTION_POSTPROCESS_CONTEXT_SECRET" });
  }
  await assert.rejects(queue.enqueue("run_big", { context: { text: "a".repeat(65536) } }), { code: "COLLECTION_POSTPROCESS_CONTEXT_TOO_LARGE" });
  const context = { job: { value: 1 }, b2bSubscribers: ["member_1"] }; await queue.enqueue("run_safe", { context }); context.job.value = 7;
  const saved = await queue.status({ runId: "run_safe" }); assert.equal(saved.context, undefined); assert.equal(saved.b2bSubscribers, undefined);
  assert.equal((await queue.status({ limit: 1000 })).items.length, 1);
  for (const runId of ["../outside", ".", "", "a/b", "a\\b"]) await assert.rejects(queue.enqueue(runId), { code: "COLLECTION_POSTPROCESS_INPUT_INVALID" });
  assert.equal(await queue.get("constructor"), null, "an inherited object key is not a stored receipt");
});

test("pending capacity rejects new work without dropping queued or held records", async t => {
  const f = await fixture(t, { maxPending: 1 }), queue = f.create();
  await queue.enqueue("run_capacity", { deferred: true });
  await assert.rejects(queue.enqueue("run_overflow"), { code: "COLLECTION_POSTPROCESS_QUEUE_FULL" });
  assert.equal((await queue.get("run_capacity")).state, "held"); assert.equal(await queue.get("run_overflow"), null);
});

test("held recovery is not truncated by a recent terminal-history limit", async t => {
  const f = await fixture(t, { maxRetained: 2 }), queue = f.create();
  await queue.enqueue("run_old_held", { deferred: true, context: { scheduleOccurrenceId: "rotation_2026-10-20_1" } });
  for (const runId of ["run_recent_one", "run_recent_two"]) { await queue.enqueue(runId); await queue.runOnce(); }
  assert.equal((await queue.status({ limit: 2 })).items.some(row => row.runId === "run_old_held"), false);
  const held = await queue.held(); assert.equal(held.length, 1); assert.equal(held[0].runId, "run_old_held");
  assert.equal(held[0].scheduleOccurrenceId, "rotation_2026-10-20_1"); assert.equal(held[0].context, undefined);
});

test("shutdown aborts cooperative work, saves a retry receipt, cancels scheduling and never starts another run", async t => {
  const entered = deferred(); let calls = 0;
  const f = await fixture(t, { processRun: async (runId, { signal }) => { calls++; entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("shutdown"), { code: "POSTPROCESS_SHUTDOWN" })), { once: true })); } });
  const queue = f.create(); await queue.enqueue("run_shutdown"); await queue.enqueue("run_later");
  const work = queue.runOnce(); await entered.promise; await queue.close();
  assert.equal((await work).state, "queued"); assert.equal(await queue.runOnce(), null); assert.equal(calls, 1);
  assert.equal((await queue.get("run_later")).attempts, 0); assert.equal((await queue.status()).closed, true);
});

test("status reads during active processing remain immediate and never rewrite queue state", async t => {
  const entered = deferred(), finish = deferred(); let writes = 0;
  const f = await fixture(t, { processRun: async () => { entered.resolve(); await finish.promise; } });
  const queue = f.create({ fileSystem: { ...fs, rename: async (...args) => { writes++; return fs.rename(...args); } } });
  await queue.enqueue("run_status"); const work = queue.runOnce(); await entered.promise;
  const before = writes;
  for (let index = 0; index < 5; index++) assert.equal((await queue.status({ runId: "run_status" })).state, "running");
  assert.equal((await queue.status()).active, true); assert.equal(writes, before);
  finish.resolve(); await work;
});
