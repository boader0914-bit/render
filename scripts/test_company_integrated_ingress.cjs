"use strict";
// All companies, dates and observations below are synthetic local fixtures.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => structuredClone(value);
async function fixture(t, { count = 2, autoStart = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "company-ingress-"));
  const companies = Array.from({ length: count }, (_, index) => ({ companyId: `synthetic-company-${index}`, primaryName: `모의 업체 ${index}`, capacity: 16 }));
  const runs = [{ id: "synthetic-run", keyword: "모의 검색", collectedAt: "2026-09-01T03:00:00Z", collectionQuality: { status: "complete" } }];
  const calls = { catalog: 0, targets: 0, sources: 0 }, services = [];
  const data = { months: ["2026-10"], observations: [], pause: null };
  const options = { dataDir: directory, autoStart, now: () => new Date("2026-10-21T00:00:00Z"),
    catalog: async () => { calls.catalog++; return { companies, runs }; },
    listTargets: async ({ companyIds } = {}) => { calls.targets++; return companies.filter(row => !companyIds || companyIds.includes(row.companyId)).map(row => ({ companyId: row.companyId, months: [...data.months] })); },
    loadSources: async request => {
      calls.sources++;
      const result = { companies, observations: copy(data.observations), runs };
      if (data.pause && request.targetId === companies[0].companyId && request.month === "2026-09") {
        const pause = data.pause; data.pause = null; pause.entered.resolve(); await pause.gate.promise;
      }
      return result;
    } };
  const make = (overrides = {}) => { const service = createCompanyIntegratedDb({ ...options, ...overrides }); services.push(service); return service; };
  t.after(async () => {
    for (const service of services) await service.stop();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("company-ingress-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, companies, calls, data, make, db: make(), queueFile: path.join(directory, "company_integrated", "queue.json"),
    monthFile: (id, month) => path.join(directory, "company_integrated", crypto.createHash("sha256").update(id).digest("hex"), `${month}.json`) };
}
const observation = (companyId, sold) => ({ companyId, companyKey: companyId, runId: "synthetic-run", collectedAt: "2026-09-01T03:00:00Z",
  stayDate: "2026-09-03", productType: "lodging", inventoryEvidenceVersion: 4, supply: 16, sold, publicBookings: sold,
  phoneBookings: 0, publicRevenue: sold * 100000, phoneRevenue: 0, estimatedRevenue: sold * 100000,
  partial: false, missing: false, unknownUnavailable: 0, phoneMissingPriceBookings: 0, sharedDayUseExcluded: 0,
  capacityBasis: { count: 16, source: "manual_review" } });

test("twenty durable ingress jobs perform no catalog, target or source reads until release; restart discovers old and new months", async t => {
  const f = await fixture(t, { count: 20 }), firstId = f.companies[0].companyId;
  await f.db.queueCompany(firstId, { months: ["2026-09"] }); await f.db.drain();
  const before = { ...f.calls }, gate = deferred(), entered = deferred();
  const held = f.db.deferProcessing(async () => {
    for (const company of f.companies) await f.db.queueCompany(company.companyId, { reason: "synthetic-ingress" });
    entered.resolve(); await gate.promise; return "all receipts persisted";
  });
  await entered.promise; await tick();
  assert.deepEqual(f.calls, before, "ingress stores jobs without entering the full catalog or materialization");
  const disk = JSON.parse(await fs.readFile(f.queueFile, "utf8"));
  assert.equal(Object.keys(disk.jobs).length, 20);
  assert.ok(Object.values(disk.jobs).every(job => job.status === "queued" && job.allMonths === true));
  await f.db.stop(); gate.resolve(); assert.equal(await held, "all receipts persisted"); await tick();
  assert.deepEqual(f.calls, before, "releasing after stop cannot restart dispatch");
  f.data.months = ["2026-10", "2026-11"];
  const restarted = f.make({ autoStart: false });
  assert.equal((await restarted.status()).counts.queued, 20); assert.deepEqual(f.calls, before);
  await restarted.drain(); assert.equal((await restarted.status()).counts.idle, 20);
  const index = JSON.parse(await fs.readFile(path.join(path.dirname(f.monthFile(firstId, "2026-09")), "index.json"), "utf8"));
  assert.deepEqual(index.months, ["2026-09", "2026-10", "2026-11"]);
  for (const month of index.months) assert.ok(JSON.parse(await fs.readFile(f.monthFile(firstId, month), "utf8")).snapshot);
});

test("nested and overlapping holds use a reference count; drain sleeps until the last hold releases", async t => {
  const f = await fixture(t), nested = deferred(), outer = deferred(), other = deferred(), entered = deferred();
  const first = f.db.deferProcessing(async () => {
    await f.db.queueCompany(f.companies[0].companyId);
    await f.db.deferProcessing(async () => { entered.resolve(); await nested.promise; });
    await outer.promise; return 17;
  });
  const second = f.db.deferProcessing(async () => { await f.db.queueCompany(f.companies[1].companyId); await other.promise; return 19; });
  await entered.promise; await tick();
  let drained = false; const draining = f.db.drain().then(() => { drained = true; });
  nested.resolve(); await tick(); outer.resolve(); assert.equal(await first, 17); await tick();
  assert.equal(drained, false); assert.deepEqual(f.calls, { catalog: 0, targets: 0, sources: 0 });
  other.resolve(); assert.equal(await second, 19); await draining;
  assert.equal((await f.db.status()).counts.idle, 2); assert.ok(f.calls.sources > 0);
});

test("synchronous and asynchronous writer failures release holds and preserve durable queued jobs", async t => {
  const f = await fixture(t);
  await assert.rejects(f.db.deferProcessing(null), TypeError);
  const error = new Error("synthetic writer failure");
  await assert.rejects(f.db.deferProcessing(() => { throw error; }), value => value === error);
  await assert.rejects(f.db.deferProcessing(async () => {
    await f.db.queueCompany(f.companies[0].companyId); assert.equal(f.calls.sources, 0); throw error;
  }), value => value === error);
  await f.db.drain(); assert.equal((await f.db.status()).counts.idle, 1);
  await f.db.queueCompany(f.companies[1].companyId); await f.db.drain();
  assert.equal((await f.db.status()).counts.idle, 2);
});

test("a hold also blocks a kick already pending initialization and stop wakes a waiting drain", async t => {
  const f = await fixture(t), gate = deferred(), entered = deferred();
  const queued = f.db.queueCompany(f.companies[0].companyId);
  const held = f.db.deferProcessing(async () => { await queued; entered.resolve(); await gate.promise; });
  await entered.promise; await tick(); assert.equal(f.calls.catalog, 0);
  const draining = f.db.drain(); await tick(); await f.db.stop(); await draining;
  gate.resolve(); await held; await tick(); assert.equal(f.calls.catalog, 0);
  assert.equal((await f.db.status()).counts.queued, 1);
});

test("ongoing materialization may finish but its stale generation cannot publish or dispatch the next company while held", async t => {
  const f = await fixture(t), id = f.companies[0].companyId;
  f.data.months = ["2026-09"]; f.data.observations = [observation(id, 2)];
  await f.db.queueCompany(id); await f.db.drain(); const prior = await fs.readFile(f.monthFile(id, "2026-09"), "utf8");
  f.data.observations = [observation(id, 3)]; const paused = f.data.pause = { entered: deferred(), gate: deferred() };
  await f.db.queueCompany(id); await paused.entered.promise;
  const releaseHold = deferred(), writerEntered = deferred();
  const held = f.db.deferProcessing(async () => {
    f.data.observations = [observation(id, 5)];
    await f.db.queueCompany(id, { reason: "newer-generation" }); await f.db.queueCompany(f.companies[1].companyId);
    writerEntered.resolve(); await releaseHold.promise;
  });
  await writerEntered.promise; paused.gate.resolve();
  for (let n = 0; n < 200 && (await f.db.status()).active; n++) await new Promise(resolve => setTimeout(resolve, 5));
  const waiting = await f.db.status(); assert.equal(waiting.active, false); assert.equal(waiting.counts.queued, 2);
  assert.equal(await fs.readFile(f.monthFile(id, "2026-09"), "utf8"), prior, "the earlier generation cannot overwrite the saved card");
  releaseHold.resolve(); await held; await f.db.drain();
  const result = await f.db.get(id, { month: "2026-09" }); assert.equal(result.snapshot.summary.lodging.sold, 5); assert.equal(result.roomBasis.capacity, 16);
});

test("explicit bootstrap and interactive enqueues are retained while automatic dispatch is held", async t => {
  const f = await fixture(t);
  await f.db.deferProcessing(async () => {
    await f.db.bootstrap();
    const pending = await f.db.get(f.companies[0].companyId, { month: "2026-10" });
    assert.equal(pending.status, "refreshing"); assert.equal(pending.selectedMonth, "2026-10");
    assert.equal((await f.db.status()).counts.queued, 2); assert.equal(f.calls.sources, 0);
  });
  await f.db.drain(); assert.equal((await f.db.status()).counts.idle, 2);
  assert.ok((await f.db.get(f.companies[0].companyId, { month: "2026-10" })).snapshot);
});
