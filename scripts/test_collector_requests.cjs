"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { createCollectorRequests } = require("./collector_requests.cjs");
const payload = (id = "request-test-0001") => ({ clientRequestId: id, workerKey: "scheduled", keyword: "포천글램핑", checkIn: "2026-09-23", checkOut: "2026-09-24" });
const result = (status = "complete", extra = {}) => ({ runId: "pocheon_glamping_test", collectionQuality: { status }, workerKey: "scheduled", trigger: "manual", ...extra });
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "collector-requests-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, api: createCollectorRequests({ dataDir, run: async () => result(), ...options }) };
}
async function terminal(api, id = "request-test-0001") {
  for (let i = 0; i < 100; i++) { const row = await api.get(id); if (row.status !== "pending") return row; await delay(10); }
  throw new Error("Fixture request did not finish");
}

test("durable acceptance returns before work completes and same request runs once", async t => {
  let release, count = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const { api, dataDir } = await fixture(t, { run: async () => { count++; await hold; return result(); } });
  const first = await api.submit(payload());
  assert.equal(first.status, "pending");
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "history/collector-requests/request-test-0001.json"), "utf8")).status, "pending");
  const duplicate = await api.submit(payload());
  assert.equal(duplicate.requestId, first.requestId);
  await delay(10); assert.equal(count, 1);
  release();
  const finished = await terminal(api);
  assert.equal(finished.status, "complete");
  assert.equal(finished.result.runId, "pocheon_glamping_test");
  assert.equal((await api.submit(payload())).status, "complete");
  assert.equal(count, 1);
});

test("concurrent distinct requests are persisted while earlier collection is still running", async t => {
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const { api } = await fixture(t, { run: async () => { await hold; return result(); } });
  const rows = await Promise.all([api.submit(payload("request-concurrent-1")), api.submit(payload("request-concurrent-2"))]);
  assert.equal(rows.every(row => row.status === "pending"), true);
  assert.equal((await api.list()).length, 2);
  release(); await Promise.all(rows.map(row => terminal(api, row.requestId)));
});

test("same ID with different scope is rejected and existing accepted receipt survives offline preflight", async t => {
  let offline = false, checks = 0;
  const { api } = await fixture(t, { preflight: async () => { checks++; if (offline) throw Object.assign(new Error("offline"), { code: "COLLECTOR_OFFLINE" }); } });
  await api.submit(payload()); await terminal(api); offline = true;
  assert.equal((await api.submit(payload())).status, "complete");
  await assert.rejects(api.submit({ ...payload(), keyword: "가평글램핑" }), { code: "COLLECTION_REQUEST_CONFLICT" });
  assert.equal(checks, 1);
  await assert.rejects(api.submit(payload("request-offline-1")), { code: "COLLECTOR_OFFLINE" });
  assert.equal((await api.list()).length, 1);
});

test("partial, blocked, reused and unverified results keep their actual outcomes", async t => {
  const values = new Map([
    ["request-partial-1", result("partial")], ["request-blocked-1", result("blocked")],
    ["request-reused-11", result("complete", { reused: true })],
    ["request-missing-1", result("complete", { runId: null })],
    ["request-quality-1", result("complete", { collectionQuality: null })]
  ]);
  const { api } = await fixture(t, { run: async input => values.get(input.clientRequestId) });
  for (const id of values.keys()) await api.submit(payload(id));
  const rows = await Promise.all([...values.keys()].map(id => terminal(api, id)));
  assert.deepEqual(rows.map(row => row.status), ["partial", "blocked", "reused", "failed", "failed"]);
});

test("errors are recorded without tokens, raw logs or request secrets", async t => {
  const { api, dataDir } = await fixture(t, { run: async () => { throw Object.assign(new Error("TOKEN_SUPER_SECRET cookie=value"), { code: "COLLECTOR_PROVIDER_BLOCKED" }); } });
  await api.submit({ ...payload(), unsafeSecret: "SECRET_PAYLOAD" });
  const row = await terminal(api);
  assert.equal(row.status, "blocked");
  const saved = await fs.readFile(path.join(dataDir, "history/collector-requests/request-test-0001.json"), "utf8");
  assert.doesNotMatch(JSON.stringify(row) + saved, /TOKEN_SUPER_SECRET|cookie=value|SECRET_PAYLOAD/);
  assert.equal(Object.hasOwn(row, "fingerprint"), false);
});

test("restart marks pending receipt interrupted and never repeats collection", async t => {
  const { api, dataDir } = await fixture(t);
  await api.submit(payload()); await terminal(api);
  const file = path.join(dataDir, "history/collector-requests/request-test-0001.json");
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  Object.assign(saved, { status: "pending", finishedAt: null, result: null, secret: "do-not-publish" });
  await fs.writeFile(file, JSON.stringify(saved));
  let count = 0;
  const restarted = createCollectorRequests({ dataDir, run: async () => { count++; return result(); } });
  assert.equal((await restarted.get(saved.requestId)).status, "interrupted");
  const replay = await restarted.submit(payload());
  assert.equal(replay.status, "interrupted");
  assert.equal(Object.hasOwn(replay, "secret"), false);
  assert.equal(count, 0);
});

test("invalid and absent request IDs cannot read or create receipts", async t => {
  const { api } = await fixture(t);
  await assert.rejects(api.submit(payload("../bad")), { statusCode: 400 });
  await assert.rejects(api.get("../outside"), { statusCode: 404 });
  await assert.rejects(api.get("request-absent-1"), { statusCode: 404 });
  assert.deepEqual(await api.list(), []);
});

test("operating web receipts survive restart with their actual execution role", async t => {
  const input={...payload("request-web-restart-1"),workerKey:"web"};
  const {api,dataDir}=await fixture(t,{run:async()=>result("complete",{workerKey:"web"})});
  assert.equal((await api.submit(input)).workerKey,"web");
  assert.equal((await terminal(api,input.clientRequestId)).result.workerKey,"web");
  let reruns=0;
  const restarted=createCollectorRequests({dataDir,run:async()=>{reruns++;return result();}});
  const saved=await restarted.get(input.clientRequestId);
  assert.equal(saved.status,"complete");
  assert.equal(saved.workerKey,"web");
  assert.equal((await restarted.submit(input)).result.workerKey,"web");
  assert.equal(reruns,0);
});
