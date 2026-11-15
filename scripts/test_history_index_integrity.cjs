"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http"), { EventEmitter } = require("node:events"), { Worker } = require("node:worker_threads");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { createHistoryIndexIntegrityChecker } = require("./lib/history_index_integrity.cjs");
const { getAnalyticalPhaseDiagnostics } = require("./lib/analytical_phase_runtime.cjs");
const pin = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
const turn = () => new Promise(resolve => setImmediate(resolve)), flush = async () => { for (let n = 0; n < 5; n++) await turn(); };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, "history-integrity-worker-"));
  const file = path.join(root, "observations.jsonl"), indexFile = path.join(root, "index.sqlite");
  await fs.writeFile(file, JSON.stringify({ observationId: "fixture", companyId: "fixture-company", stayDate: "2026-09-01", sold: 0 }) + "\n");
  const seed = createHistoryObservationIndex({ file, indexFile }); await seed.ensure(); await seed.close();
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.match(path.basename(root), /^history-integrity-worker-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, indexFile, request: async () => ({ indexFile, expectedSignature: pin(await fs.lstat(indexFile, { bigint: true })), busyTimeoutMs: 1000 }) };
}

test("the real readonly worker executes the full check and preserves index/source bytes", async t => {
  const f = await fixture(t), check = createHistoryIndexIntegrityChecker(), before = await fs.readFile(f.indexFile), raw = await fs.readFile(f.file);
  const result = await check(await f.request()); assert.deepEqual(result, { quick_check: "ok" });
  assert.deepEqual(await fs.readFile(f.indexFile), before); assert.deepEqual(await fs.readFile(f.file), raw);
  assert.equal(check.status().completed, 1); assert.equal(check.status().activeWorkers, 0); assert.equal(check.status().exitObserved, 1);
  assert.equal(check.status().maximumActiveWorkers, 1);
});

test("a corrupt SQLite file is rejected rather than skipped, rebuilt or changed", async t => {
  const f = await fixture(t), check = createHistoryIndexIntegrityChecker(), original = await fs.readFile(f.file);
  const corrupt = Buffer.from("not a sqlite database"); await fs.writeFile(f.indexFile, corrupt);
  await assert.rejects(check(await f.request()), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
  assert.deepEqual(await fs.readFile(f.indexFile), corrupt); assert.deepEqual(await fs.readFile(f.file), original); assert.equal(check.status().exitObserved, 1);
});

test("parent index adoption rejects a file changed during the actual injected full check", async t => {
  const f = await fixture(t), entered = gate(), resume = gate(), original = await fs.readFile(f.file); let checks = 0;
  const store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, integrityCheck: async input => {
    assert.equal(input.indexFile, f.indexFile); assert.equal(typeof input.synchronousCheck, "function"); checks++; entered.resolve(); await resume.promise; return input.synchronousCheck();
  } });
  const pending = store.ensure(), rejected = assert.rejects(pending, { code: "HISTORY_OBSERVATION_INDEX_INTEGRITY_CHANGED" }); await entered.promise;
  const stat = await fs.stat(f.indexFile); await fs.utimes(f.indexFile, stat.atime, new Date(stat.mtimeMs + 2000)); resume.resolve(); await rejected;
  assert.equal(checks, 1); assert.equal(store.describe().ready, false); await store.close(); assert.deepEqual(await fs.readFile(f.file), original);
});

test("the parent holds serialized index ownership and services HTTP while a slow worker performs the same full check", async t => {
  const f = await fixture(t), started = gate(); let optionsSeen, settled = false, healthDuringCheck = false;
  const check = createHistoryIndexIntegrityChecker({ WorkerClass: function SlowWorker(filename, options) {
    optionsSeen = options; started.resolve();
    return new Worker(`const {performance}=require('node:perf_hooks');const until=performance.now()+200;while(performance.now()<until){};require(${JSON.stringify(path.join(__dirname, "lib/history_index_integrity.cjs"))});`, { ...options, eval: true });
  } });
  const store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, integrityCheck: input => check(input) });
  const server = http.createServer((req, res) => { healthDuringCheck = check.status().activeWorkers === 1 && !settled; res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const pending = store.ensure().then(value => { settled = true; return value; }); await started.promise;
  let closeSettled = false; const closing = store.close().then(() => { closeSettled = true; });
  const status = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/api/health`, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); }).on("error", reject));
  assert.equal(status, 200); assert.equal(healthDuringCheck, true); assert.equal(closeSettled, false, "index.close cannot overtake native validation");
  assert.equal((await pending).rows, 1); await closing; await new Promise(resolve => server.close(resolve));
  assert.deepEqual(optionsSeen.env, {}); assert.deepEqual(optionsSeen.execArgv, []); assert.equal(optionsSeen.resourceLimits.maxOldGenerationSizeMb, 64);
  assert.deepEqual(Object.keys(optionsSeen.workerData).sort(), ["busyTimeoutMs", "expectedSignature", "indexFile", "kind"]);
  assert.ok(Object.values(optionsSeen.workerData).every(value => ["string", "number"].includes(typeof value)), "no callback, credential or observation graph enters workerData");
});

function fakeFactory() {
  const workers = [], timers = new Map(); let at = 0;
  class FakeWorker extends EventEmitter { constructor(filename, options) { super(); this.filename = filename; this.options = options; this.terminateCalls = 0; workers.push(this); }
    terminate() { this.terminateCalls++; return new Promise(() => {}); } }
  const check = createHistoryIndexIntegrityChecker({ WorkerClass: FakeWorker, now: () => at,
    setTimeoutImpl(fn, ms) { const timer = { unref() {} }; timers.set(timer, { fn, due: at + ms }); return timer; }, clearTimeoutImpl: timer => timers.delete(timer) });
  return { check, workers, async advance(ms) { at += ms; for (const [timer, value] of [...timers]) if (value.due <= at) { timers.delete(timer); value.fn(); } await flush(); }, timers };
}
const fakeRequest = name => ({ indexFile: path.resolve(os.tmpdir(), name + ".sqlite"), expectedSignature: "1:2:3:4:5", timeoutMs: 20 });
const success = worker => { worker.emit("message", { kind: "history-index-full-integrity-v1", ok: true }); worker.emit("exit", 0); };

test("timeout requests termination but retains single-worker ownership until its observed exit", async () => {
  const f = fakeFactory(), first = f.check(fakeRequest("fixture-one")), rejected = assert.rejects(first, { code: "HISTORY_OBSERVATION_INDEX_INTEGRITY_TIMEOUT" });
  await flush(); const joined = f.check(fakeRequest("fixture-one")), joinedRejected = assert.rejects(joined, { code: "HISTORY_OBSERVATION_INDEX_INTEGRITY_TIMEOUT" });
  const next = f.check(fakeRequest("fixture-two")); let settled = false; first.catch(() => { settled = true; });
  await f.advance(20); assert.equal(f.workers[0].terminateCalls, 1); assert.equal(settled, false); assert.equal(f.check.status().activeWorkers, 1); assert.equal(f.workers.length, 1);
  await f.advance(10000); assert.equal(f.workers.length, 1); assert.equal(f.check.status().pendingChecks, 2);
  success(f.workers[0]); await rejected; await joinedRejected; await flush(); assert.equal(f.workers.length, 2); assert.equal(f.check.status().activeWorkers, 1);
  success(f.workers[1]); await next; assert.equal(f.check.status().maximumActiveWorkers, 1); assert.equal(f.check.status().activeWorkers, 0); assert.equal(f.timers.size, 0);
});

test("worker errors and untrusted replies cannot release ownership before exit or leak private diagnostics", async () => {
  const f = fakeFactory(), pending = f.check(fakeRequest("private-path")), rejected = assert.rejects(pending, { code: "HISTORY_OBSERVATION_INDEX_INTEGRITY_WORKER_FAILED" }); await flush();
  f.workers[0].emit("error", new Error("private credential source payload")); f.workers[0].emit("message", { kind: "history-index-full-integrity-v1", ok: true, secret: "private" });
  await flush(); assert.equal(f.check.status().activeWorkers, 1); assert.equal(f.check.status().failed, 0);
  f.workers[0].emit("exit", 1); await rejected; assert.equal(f.check.status().failed, 1);
  assert.doesNotMatch(JSON.stringify(f.check.status()), /private|credential|path|payload/);
});

test("real parent validation logs a numeric integrity phase and custom filesystem scopes require explicit checking", async t => {
  const f = await fixture(t), diagnostics = getAnalyticalPhaseDiagnostics(), store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile });
  await diagnostics.run("company-bootstrap", () => store.ensure()); await store.close();
  const record = diagnostics.status().records.at(-1), phase = record.phases.find(row => row.phase === "history_index_integrity_check");
  assert.ok(phase); assert.equal(phase.status, "completed"); assert.ok(phase.metadata.inputBytes > 0); assert.equal(phase.metadata.readCount, 1);
  assert.doesNotMatch(JSON.stringify(record), /fixture-company|observations\.jsonl|index\.sqlite/);
  assert.throws(() => createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, fileSystem: { ...fs } }), TypeError);
});
