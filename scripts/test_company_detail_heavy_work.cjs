"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { test } = require("node:test");
const { createHeavyWorkScheduler } = require("./lib/heavy_work_scheduler.cjs");
const { createCompanyDetailStore, readScopedCompanyMaster } = require("./lib/company_detail_store.cjs");
const { createCompanyDetailSourceIndex } = require("./lib/company_detail_source_index.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "detail-heavy-work-"));
  t.after(async () => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const masterFile = path.join(dataDir, "company_master/companies.json"), historyFile = path.join(dataDir, "history/observations.jsonl");
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const companies = { one: { companyId: "one", capacity: 16, runIds: [] }, two: { companyId: "two", capacity: 17, runIds: [] }, three: { companyId: "three", capacity: 18, runIds: [] } };
  await fs.writeFile(masterFile, JSON.stringify({ companies }));
  await fs.writeFile(historyFile, JSON.stringify({ observationId: "zero", companyKey: "one", sold: 0 }) + "\n" + JSON.stringify({ observationId: "missing", companyKey: "two", sold: null, missing: true }) + "\n");
  const work = createHeavyWorkScheduler({ memoryProbe: async () => ({ rssBytes: 1, cgroup: {} }) });
  const runHeavy = (action, options) => work.run(action, options);
  const options = { dataDir, projectionVersion: "heavy-work-test-v1", runHeavy, runIdsForCompany: company => company.runIds,
    matchesObservation: (row, company) => row.companyKey === company.companyId,
    build: async (id, { master, observations }) => ({ company: master.companies[id], observations }) };
  return { dataDir, masterFile, historyFile, companies, work, runHeavy, options };
}

test("saved and memory detail hits bypass a blocked heavy build; independent cold builds queue and same company joins", async t => {
  const f = await fixture(t), prime = createCompanyDetailStore(f.options); await prime.get("one");
  const held = gate(), started = gate(); let calls = 0;
  const store = createCompanyDetailStore({ ...f.options, build: async (...args) => { calls++; started.resolve(); await held.promise; return f.options.build(...args); } });
  const second = store.get("two"), joined = store.get("two"); await started.promise;
  const third = store.get("three");
  const hit = await store.get("one"); assert.equal(hit.cacheStatus, "saved"); assert.equal(hit.data.observations[0].sold, 0);
  assert.equal((await store.get("one")).cacheStatus, "memory"); assert.equal(f.work.status().queued, 1); assert.equal(calls, 1);
  held.resolve(); const [a, b] = await Promise.all([second, joined]); assert.deepEqual(a, b); await third;
  assert.equal(calls, 2); assert.ok(a.timings.heavyWaitMs >= 0); assert.equal(a.data.observations[0].sold, null); assert.equal(a.data.observations[0].missing, true);
});

test("source revision is sampled again after admission instead of certifying a pre-wait source", async t => {
  const f = await fixture(t), held = gate(), started = gate();
  const blocker = f.work.run(async () => { started.resolve(); await held.promise; }); await started.promise;
  const store = createCompanyDetailStore(f.options), pending = store.get("one"); await turn();
  f.companies.one.capacity = 31; await fs.writeFile(f.masterFile, JSON.stringify({ companies: f.companies })); held.resolve();
  await blocker; assert.equal((await pending).data.company.capacity, 31);
});

test("cold index preparation queues, persisted reuse returns without heavy admission, originals remain identical", async t => {
  const f = await fixture(t), before = await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), held = gate(), started = gate();
  const blocker = f.work.run(async () => { started.resolve(); await held.promise; }); await started.promise;
  let reads = 0;
  const index = createCompanyDetailSourceIndex({ dataDir: f.dataDir, runHeavy: f.runHeavy, masterReader: async (...args) => { reads++; return readScopedCompanyMaster(...args); } });
  const pending = index.prepare();
  for (let i = 0; i < 30 && index.status().phase !== "waiting"; i++) await turn();
  assert.equal(index.status().phase, "waiting"); assert.equal(reads, 0);
  held.resolve(); await blocker; assert.equal((await pending).cacheStatus, "built");
  // Hold another unrelated calculation. Index reuse must not wait for its GC.
  const again = gate(), secondStarted = gate();
  const second = f.work.run(async () => { secondStarted.resolve(); await again.promise; }); await secondStarted.promise;
  const restart = createCompanyDetailSourceIndex({ dataDir: f.dataDir, runHeavy: f.runHeavy });
  assert.equal((await restart.prepare()).cacheStatus, "reused"); again.resolve(); await second;
  assert.deepEqual(await Promise.all([fs.readFile(f.masterFile), fs.readFile(f.historyFile)]), before);
});

test("a detail-triggered detached index build is reentrant and releases correctly on the initial preparing response", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex({ dataDir: f.dataDir, runHeavy: f.runHeavy });
  const store = createCompanyDetailStore({ ...f.options, masterReader: index.readMaster, historyReader: index.readHistory });
  await assert.rejects(store.get("one"), { code: "COMPANY_DETAIL_SOURCE_INDEX_PREPARING" });
  await index.prepare();
  assert.equal(index.status().ready, true); assert.equal((await store.get("one")).data.company.capacity, 16);
});

test("an owner can prepare an index whose earlier singleflight is queued behind that owner", async t => {
  const f = await fixture(t), index = createCompanyDetailSourceIndex({ dataDir: f.dataDir, runHeavy: f.runHeavy });
  const entered = gate(), queued = gate(); let reads = 0;
  const outer = f.work.run(async () => { entered.resolve(); await queued.promise; await index.prepare(); reads++; }, { label: "outer-index-owner" });
  await entered.promise; const earlier = index.prepare();
  for (let i = 0; i < 50 && index.status().phase !== "waiting"; i++) await turn();
  assert.equal(index.status().phase, "waiting"); queued.resolve(); await Promise.all([outer, earlier]);
  assert.equal(index.status().ready, true); assert.equal(reads, 1);
  assert.equal(f.work.status().counts.completed >= 2, true);
});

test("an owner can load a company whose earlier singleflight is queued behind it without duplicate builds", async t => {
  const f = await fixture(t), entered = gate(), queued = gate(); let builds = 0;
  const store = createCompanyDetailStore({ ...f.options, build: async (...args) => { builds++; return f.options.build(...args); } });
  const outer = f.work.run(async () => { entered.resolve(); await queued.promise; return store.get("one"); }, { label: "outer-detail-owner" });
  await entered.promise; const earlier = store.get("one");
  for (let i = 0; i < 50 && !f.work.status().queued; i++) await turn();
  assert.equal(f.work.status().queued, 1); queued.resolve();
  const [a, b] = await Promise.all([outer, earlier]); assert.deepEqual(a.data, b.data); assert.equal(builds, 1);
});
