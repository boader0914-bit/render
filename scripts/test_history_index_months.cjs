"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), http = require("node:http");
const { EventEmitter } = require("node:events"), { Worker } = require("node:worker_threads"), { DatabaseSync } = require("node:sqlite");
const { createHistoryObservationIndex } = require("./lib/history_observation_index.cjs");
const { createHistoryIndexMonthsReader } = require("./lib/history_index_months.cjs");
const pin = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}:${stat.dev}`;
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve)), flush = async () => { for (let n = 0; n < 5; n++) await turn(); };
async function fixture(t, content = null) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, "history-month-worker-"));
  const file = path.join(root, "observations.jsonl"), indexFile = path.join(root, "index.sqlite");
  await fs.writeFile(file, content ?? [
    '\uFEFF{"companyId":"fixture","stayDate":"2026-09-99","sold":0}',
    '{"companyId":"fixture","date":"2026-10-weird"}',
    '{"companyId":"fixture","stayDate":"2026-10"}',
    '{"companyId":"fixture","stayDate":"2026-09-01"}', "null", "[]", "{partial", ""
  ].join("\n"));
  const seed = createHistoryObservationIndex({ file, indexFile }); await seed.ensure(); await seed.close();
  t.after(async () => { assert.equal(path.dirname(await fs.realpath(root)), parent); assert.match(path.basename(root), /^history-month-worker-/); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, indexFile, request: async () => ({ indexFile, expectedSignature: pin(await fs.lstat(indexFile, { bigint: true })), busyTimeoutMs: 1000 }) };
}

test("real readonly month worker preserves exact old SQL semantics, malformed-month handling and saved bytes", async t => {
  const f = await fixture(t), reader = createHistoryIndexMonthsReader(), before = await fs.readFile(f.indexFile), raw = await fs.readFile(f.file);
  assert.deepEqual(await reader(await f.request()), ["2026-10", "2026-09"]);
  assert.deepEqual(await fs.readFile(f.indexFile), before); assert.deepEqual(await fs.readFile(f.file), raw);
  assert.equal(reader.status().completed, 1); assert.equal(reader.status().activeWorkers, 0); assert.equal(reader.status().exitObserved, 1);
  assert.equal(reader.status().maximumActiveWorkers, 1);
  // The monthly_object predicate stays in the SQL. Even a fixture with an
  // inconsistent derived flag must not gain a month by dropping that filter.
  const db = new DatabaseSync(f.indexFile); db.prepare("UPDATE physical_rows SET monthly_object=0 WHERE options_month=?").run("2026-10"); db.close();
  assert.deepEqual(await reader(await f.request()), ["2026-09"]);
});

test("real parent listMonths holds serialized index ownership while slow SQL worker leaves HTTP responsive", async t => {
  const f = await fixture(t), started = gate(); let optionsSeen, settled = false, healthDuringQuery = false;
  const reader = createHistoryIndexMonthsReader({ WorkerClass: function SlowWorker(filename, options) {
    optionsSeen = options; started.resolve();
    return new Worker(`const {performance}=require('node:perf_hooks');const until=performance.now()+250;while(performance.now()<until){};require(${JSON.stringify(path.join(__dirname, "lib/history_index_months.cjs"))});`, { ...options, eval: true });
  } });
  const store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, monthsQuery: input => reader(input) });
  const server = http.createServer((req, res) => { healthDuringQuery = reader.status().activeWorkers === 1 && !settled; res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const pending = store.listMonths().then(value => { settled = true; return value; }); await started.promise;
  let closeSettled = false; const closing = store.close().then(() => { closeSettled = true; });
  const status = await new Promise((resolve, reject) => http.get(`http://127.0.0.1:${server.address().port}/api/health`, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); }).on("error", reject));
  assert.equal(status, 200); assert.equal(healthDuringQuery, true); assert.equal(closeSettled, false, "close cannot overtake native query exit");
  assert.deepEqual(await pending, ["2026-10", "2026-09"]); await closing; await new Promise(resolve => server.close(resolve));
  assert.deepEqual(optionsSeen.env, {}); assert.deepEqual(optionsSeen.execArgv, []); assert.equal(optionsSeen.resourceLimits.maxOldGenerationSizeMb, 64);
  assert.deepEqual(Object.keys(optionsSeen.workerData).sort(), ["busyTimeoutMs", "expectedSignature", "indexFile", "kind"]);
  assert.ok(Object.values(optionsSeen.workerData).every(value => ["string", "number"].includes(typeof value)), "no callback, credentials or raw observation graph enters workerData");
});

test("parent rejects source edits while an injected exact query is running", async t => {
  const f = await fixture(t), started = gate(), resume = gate(); let called = 0;
  const store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, monthsQuery: async ({ synchronousQuery }) => {
    called++; started.resolve(); await resume.promise; return synchronousQuery();
  } });
  const pending = store.listMonths(), rejected = assert.rejects(pending, { code: "HISTORY_OBSERVATION_SOURCE_CHANGED" }); await started.promise;
  await fs.appendFile(f.file, '\n{"companyId":"new","stayDate":"2026-11-01"}\n'); resume.resolve(); await rejected;
  assert.equal(called, 1); await store.close();
});

test("parent rejects index identity changes and malformed injected results rather than publishing a zero", async t => {
  const f = await fixture(t), original = await fs.readFile(f.file);
  const changed = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, monthsQuery: async ({ synchronousQuery }) => {
    const result = synchronousQuery(), stat = await fs.stat(f.indexFile); await fs.utimes(f.indexFile, stat.atime, new Date(stat.mtimeMs + 2000)); return result;
  } });
  await assert.rejects(changed.listMonths(), { code: "HISTORY_OBSERVATION_INDEX_MONTHS_CHANGED" }); await changed.close();
  for (const result of [["2026-09", "2026-10"], ["2026-09", "2026-09"], ["invalid"], Array(1), null]) {
    const store = createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, monthsQuery: () => result });
    await assert.rejects(store.listMonths(), { code: "HISTORY_OBSERVATION_INDEX_INVALID" }); await store.close();
  }
  assert.deepEqual(await fs.readFile(f.file), original);
});

test("wrong pinned identity, corrupt SQLite and invalid arguments fail closed without changing originals", async t => {
  const f = await fixture(t), reader = createHistoryIndexMonthsReader(), raw = await fs.readFile(f.file), before = await fs.readFile(f.indexFile);
  await assert.rejects(reader({ ...(await f.request()), expectedSignature: "wrong" }), { code: "HISTORY_OBSERVATION_INDEX_MONTHS_CHANGED" });
  assert.deepEqual(await fs.readFile(f.indexFile), before);
  await fs.writeFile(f.indexFile, "not sqlite"); await assert.rejects(reader(await f.request()), { code: "HISTORY_OBSERVATION_INDEX_INVALID" });
  assert.deepEqual(await fs.readFile(f.file), raw); assert.equal(await fs.readFile(f.indexFile, "utf8"), "not sqlite");
  await assert.rejects(reader({ indexFile: "relative", expectedSignature: "x" }), TypeError);
  await assert.rejects(reader({ ...(await f.request()), timeoutMs: 120001 }), TypeError);
  assert.throws(() => createHistoryObservationIndex({ file: f.file, indexFile: f.indexFile, fileSystem: { ...fs }, integrityCheck: ({ synchronousCheck }) => synchronousCheck() }), TypeError);
});

function fakeFactory() {
  const workers = [], timers = new Map(); let at = 0;
  class FakeWorker extends EventEmitter {
    constructor(filename, options) { super(); this.options = options; this.terminateCalls = 0; workers.push(this); }
    terminate() { this.terminateCalls++; return Promise.resolve(); }
  }
  const reader = createHistoryIndexMonthsReader({ WorkerClass: FakeWorker, setTimeoutImpl: callback => { const key = {}; timers.set(key, callback); return key; }, clearTimeoutImpl: key => timers.delete(key), now: () => at++ });
  const input = { indexFile: path.resolve("synthetic-index.sqlite"), expectedSignature: "synthetic-signature", busyTimeoutMs: 1000, timeoutMs: 50 };
  const success = worker => { worker.emit("message", { kind: worker.options.workerData.kind, ok: true, months: ["2026-11"] }); worker.emit("exit", 0); };
  return { reader, workers, timers, input, success };
}

test("timeouts and joins keep actual worker ownership until exit; later files cannot overlap", async () => {
  const f = fakeFactory(), first = f.reader(f.input), joined = f.reader(f.input);
  const firstRejected = assert.rejects(first, { code: "HISTORY_OBSERVATION_INDEX_MONTHS_TIMEOUT" });
  const joinedRejected = assert.rejects(joined, { code: "HISTORY_OBSERVATION_INDEX_MONTHS_TIMEOUT" });
  const second = f.reader({ ...f.input, indexFile: path.resolve("another-synthetic-index.sqlite") }); await flush();
  assert.equal(f.workers.length, 1); const worker = f.workers[0]; [...f.timers.values()][0](); await flush();
  assert.equal(worker.terminateCalls, 1); assert.equal(f.reader.status().activeWorkers, 1); assert.equal(f.workers.length, 1);
  worker.emit("exit", 0); await firstRejected; await joinedRejected; await flush(); assert.equal(f.workers.length, 2);
  f.success(f.workers[1]); assert.deepEqual(await second, ["2026-11"]); assert.equal(f.reader.status().maximumActiveWorkers, 1);
  assert.equal(f.reader.status().pendingQueries, 0); assert.equal(f.reader.status().timedOut, 1);
});

test("tampered, duplicate or sparse worker messages fail without losing native ownership", async () => {
  for (const variant of ["extra", "invalid", "duplicate-month", "sparse", "two-messages"]) {
    const f = fakeFactory(), result = f.reader(f.input), rejected = assert.rejects(result, { code: "HISTORY_OBSERVATION_INDEX_MONTHS_WORKER_FAILED" }); await flush();
    const worker = f.workers[0], message = { kind: worker.options.workerData.kind, ok: true, months: ["2026-11"] };
    if (variant === "extra") message.secret = "must-not-cross";
    if (variant === "invalid") message.months = ["2026-00"];
    if (variant === "duplicate-month") message.months = ["2026-11", "2026-11"];
    if (variant === "sparse") message.months = Array(1);
    worker.emit("message", message); if (variant === "two-messages") worker.emit("message", message);
    assert.equal(f.reader.status().activeWorkers, 1); worker.emit("exit", 0); await rejected;
    assert.equal(f.reader.status().activeWorkers, 0); assert.equal(f.reader.status().pendingQueries, 0);
  }
});
