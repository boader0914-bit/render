"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const NOW = new Date("2031-06-12T00:00:00Z");
const FIRST = { industry: "glamping", region: "all", month: "2031-04", cutoffDate: "2031-04-30" };
const SECOND = { ...FIRST, month: "2031-05", cutoffDate: "2031-05-31" };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "industry-dispatch-hold-"));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, store: createIndustryAnalysisStore({ dataDir: directory, autoStart: false, now: () => NOW,
    calculate: async request => ({ request, summary: { sold: 0 }, period: { monthClosed: true } }), ...options }) };
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test("a claimed job finishes naturally during a hold, new jobs retain their order and resume only after release", async t => {
  const entered = deferred(), ownerRelease = deferred(), batchRelease = deferred(), batchEntered = deferred(), calls = [];
  const { directory, store } = await fixture(t, { calculate: async request => {
    calls.push(request.month);
    if (request.month === FIRST.month) { entered.resolve(); await ownerRelease.promise; }
    return { request, summary: { sold: 0 }, period: { monthClosed: true } };
  } });
  await store.get(FIRST); const draining = store.drain(); await entered.promise;
  let queued;
  const held = store.deferProcessing(async () => {
    await store.get(SECOND);
    const queue = JSON.parse(await fs.readFile(path.join(directory, "industry_analysis", "queue.json"), "utf8"));
    queued = Object.values(queue.jobs).find(row => row.request.month === SECOND.month);
    batchEntered.resolve(); await batchRelease.promise;
  });
  t.after(async () => { ownerRelease.resolve(); batchRelease.resolve(); await held; await store.stop(); });
  await batchEntered.promise; ownerRelease.resolve();
  const deadline = Date.now() + 5000;
  while ((await store.status()).active && Date.now() < deadline) await turn();
  assert.equal((await store.status()).active, false, "claimed worker must finish without waiting for the repair hold");
  const first = await store.readSaved(FIRST);
  assert.equal(first.storage.status, "ready", JSON.stringify(first)); assert.equal(first.summary.sold, 0);
  assert.deepEqual(calls, [FIRST.month]);
  const queue = JSON.parse(await fs.readFile(path.join(directory, "industry_analysis", "queue.json"), "utf8"));
  const pending = Object.values(queue.jobs).find(row => row.request.month === SECOND.month);
  assert.equal(pending.status, "queued"); assert.equal(pending.queueOrder, queued.queueOrder); assert.equal(pending.generation, queued.generation);
  batchRelease.resolve(); await held; await draining;
  assert.deepEqual(calls, [FIRST.month, SECOND.month]);
  assert.equal((await store.get(SECOND)).storage.status, "ready");
  await store.stop();
});

test("nested holds and callback failures release every hold without deleting or failing queued jobs", async t => {
  const calls = [];
  const { store } = await fixture(t, { autoStart: true, calculate: async request => {
    calls.push(request.month); return { request, summary: { sold: 1 }, period: { monthClosed: true } };
  } });
  await assert.rejects(store.deferProcessing(async () => {
    await store.get(FIRST);
    await store.deferProcessing(async () => { await store.get(SECOND); });
    await turn(); assert.deepEqual(calls, [], "releasing an inner hold must not dispatch a job");
    assert.deepEqual((await store.status()).counts, { queued: 2 });
    throw Object.assign(Error("operator failure"), { code: "TEST_OPERATOR_FAILURE" });
  }), { code: "TEST_OPERATOR_FAILURE" });
  await store.drain();
  assert.deepEqual(calls, [FIRST.month, SECOND.month]);
  assert.deepEqual((await store.status()).counts, { ready: 2 });
  await assert.rejects(store.deferProcessing(null), /function/);
  await store.stop();
});

test("shutdown wakes a drain waiting for a hold and leaves the queued job durable", async t => {
  const release = deferred(), entered = deferred(); let calls = 0;
  const { store } = await fixture(t, { calculate: async () => { calls++; throw Error("must not run"); } });
  const held = store.deferProcessing(async () => { await store.get(FIRST); entered.resolve(); await release.promise; });
  await entered.promise;
  const draining = store.drain(); await turn(); await store.stop(); await draining;
  release.resolve(); await held;
  assert.equal(calls, 0); assert.deepEqual((await store.status()).counts, { queued: 1 });
});
