"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createInsightCompanyDetailReader } = require("./lib/insight_company_detail_reader.cjs");
const { readScopedCompanyMaster, readScopedCompanyHistory } = require("./lib/company_detail_store.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "insight-scoped-detail-"));
  const master = path.join(directory, "company_master", "companies.json"), history = path.join(directory, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(master), { recursive: true }); await fs.mkdir(path.dirname(history), { recursive: true });
  const one = { companyId: "cmp_one", primaryName: "동명 글램핑", duplicateNotes: [{ mergedCompanyId: "CMP_MERGED" }], manualCorrection: { lodgingBasisTotal: 16 }, keywords: {} };
  const two = { companyId: "cmp_two", primaryName: "동명 글램핑", inventory: { private: "unrelated inventory" }, keywords: {} };
  const rows = [
    { observationId: "zero", companyKey: "cmp_one", publicBookings: 0, phoneBookings: 0, price: 0 },
    { observationId: "merged", companyKey: " cmp_merged ", publicBookings: 1, phoneBookings: 2, price: 100000 },
    { observationId: "other", companyKey: "cmp_two", companyName: one.primaryName, publicBookings: 99 },
    { observationId: "name-only", companyKey: one.primaryName, companyName: one.primaryName, publicBookings: 99 },
    { observationId: "unknown", companyId: "cmp_one", publicBookings: null, price: null, missing: true, collectionErrorCode: "HTTP_429" },
    { observationId: "reassigned", companyKey: "cmp_one", publicBookings: 7 },
    { observationId: "reassigned", companyKey: "cmp_two", publicBookings: 8 }
  ];
  await fs.writeFile(master, JSON.stringify({ companies: { cmp_one: one, cmp_two: two } }));
  await fs.writeFile(history, rows.map(JSON.stringify).join("\n") + "\n");
  const scheduler = createAnalyticalWorkScheduler(), calls = [];
  const summarize = async (id, options) => {
    assert.equal(scheduler.status().active, true, "source projection owns the common analytical lease");
    calls.push({ id, options });
    return { company: options.detailSources.master.companies[id], observations: options.detailSources.observations,
      ...(options.includeObservationFlow ? { observationFlow: { preserved: true } } : {}) };
  };
  const options = { dataDir: directory, projectionVersion: "fixture-v1", runWork: (operation, settings) => scheduler.run(operation, settings),
    summarize, identityForCompany: c => ({ companyIds: new Set([c.companyId, ...(c.duplicateNotes || []).map(n => n.mergedCompanyId)].map(id => id.trim().toLowerCase())) }),
    runIdsForCompany: () => [], dayKey: () => "2026-10-23" };
  t.after(async () => { await scheduler.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, master, history, one, two, rows, scheduler, calls, options };
}

test("streamed Insight detail keeps canonical and explicitly merged company IDs, real zero and unknown states", async t => {
  const f = await fixture(t), originals = await Promise.all([fs.readFile(f.master), fs.readFile(f.history)]);
  const sourceFs = Object.create(fs);
  sourceFs.readFile = async (file, ...rest) => {
    assert.notEqual(String(file), f.master, "whole master body must not be read");
    assert.notEqual(String(file), f.history, "whole history body must not be read");
    return fs.readFile(file, ...rest);
  };
  const read = createInsightCompanyDetailReader({ ...f.options, fileSystem: sourceFs,
    masterReader: async (...args) => { assert.equal(f.scheduler.status().activeKind, "insight-company-detail"); return readScopedCompanyMaster(...args); },
    historyReader: async (...args) => { assert.equal(f.scheduler.status().activeKind, "insight-company-detail"); return readScopedCompanyHistory(...args); } });
  assert.equal(read.runWork,f.options.runWork);
  assert.equal(Object.getOwnPropertyDescriptor(read,'runWork').enumerable,false);
  assert.deepEqual(Object.keys(read),[],'ownership capability cannot enter serialized customer fields');
  const data = await read("cmp_one");
  assert.deepEqual(data.observations.map(r => r.observationId), ["zero", "merged", "unknown"]);
  assert.equal(data.observations[0].publicBookings, 0); assert.equal(data.observations[0].price, 0);
  assert.equal(data.observations[2].publicBookings, null); assert.equal(data.observations[2].missing, true);
  assert.equal(data.observations[2].collectionErrorCode, "HTTP_429"); assert.equal(data.company.manualCorrection.lodgingBasisTotal, 16);
  assert.equal(f.calls[0].options.strictIdentity, true); assert.equal(f.calls[0].options.includeObservationFlow, false);
  assert.equal(f.calls[0].options.detailSources.master.companies.cmp_two.inventory, undefined);
  assert.deepEqual(await Promise.all([fs.readFile(f.master), fs.readFile(f.history)]), originals);
});

test("different companies and background analysis cannot overlap the detail source allocation lifetime", { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = gate(), release = gate(); let reading = 0, peak = 0, builds = 0;
  const read = createInsightCompanyDetailReader({ ...f.options, summarize: async (...args) => { builds++; return f.options.summarize(...args); },
    masterReader: async (...args) => {
      reading++; peak = Math.max(peak, reading);
      try { if (args[1] === "cmp_one") { entered.resolve(); await release.promise; } return await readScopedCompanyMaster(...args); }
      finally { reading--; }
    } });
  const first = read("cmp_one"); await entered.promise;
  const same = read("cmp_one"), second = read("cmp_two"); let otherRan = false;
  const other = f.scheduler.run(async () => { assert.equal(reading, 0); otherRan = true; }, { priority: "background", kind: "other-analysis" });
  await turn(); assert.equal(otherRan, false); assert.equal(f.calls.length, 0);
  release.resolve(); const [a, joined, b] = await Promise.all([first, same, second, other]);
  assert.deepEqual(joined, a); assert.equal(b.company.companyId, "cmp_two"); assert.equal(peak, 1); assert.equal(builds, 2);
  assert.equal(otherRan, true); assert.equal(f.scheduler.status().active, false);
});

test("a nested analytical caller never awaits a same-company request queued behind its own lease", { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = gate(), proceed = gate(), read = createInsightCompanyDetailReader(f.options);
  const parent = f.scheduler.run(async () => {
    entered.resolve(); await proceed.promise;
    const [a, b] = await Promise.all([read("cmp_one"), read("cmp_one")]);
    assert.deepEqual(a, b); return a;
  }, { kind: "parent-analysis" });
  await entered.promise; const queued = read("cmp_one"); await turn(); proceed.resolve();
  const [inside, outside] = await Promise.all([parent, queued]);
  assert.deepEqual(inside, outside); assert.equal(f.calls.length, 1);
  assert.ok(f.scheduler.status().timing.reentrantStarted >= 2);
});

test("legacy and integrated detail views use isolated saved caches, survive restart and rebuild only changed inputs", async t => {
  const f = await fixture(t), read = createInsightCompanyDetailReader(f.options);
  const a = await read("cmp_one"), again = await createInsightCompanyDetailReader(f.options)("cmp_one");
  assert.deepEqual(again, a); assert.equal(f.calls.length, 1);
  const legacy = await createInsightCompanyDetailReader({ ...f.options, integrationConnected: false })("cmp_one");
  assert.deepEqual(legacy.observationFlow, { preserved: true }); assert.equal(a.observationFlow, undefined);
  assert.equal(f.calls.length, 2);
  const names = await fs.readdir(path.join(f.directory, "company_master"));
  assert.ok(names.includes("insight_detail_read_models_v1_integrated")); assert.ok(names.includes("insight_detail_read_models_v1_legacy"));
  await fs.appendFile(f.history, JSON.stringify({ observationId: "new", companyKey: "cmp_one", publicBookings: 2 }) + "\n");
  assert.equal((await read("cmp_one")).observations.at(-1).publicBookings, 2); assert.equal(f.calls.length, 3);
});

test("source and build failures release the common lease and preserve the previous normal cache", async t => {
  const f = await fixture(t), read = createInsightCompanyDetailReader(f.options); await read("cmp_one");
  const directory = path.join(f.directory, "company_master", "insight_detail_read_models_v1_integrated");
  const file = path.join(directory, (await fs.readdir(directory))[0]), original = await fs.readFile(file);
  await fs.appendFile(f.history, JSON.stringify({ observationId: "new", companyKey: "cmp_one" }) + "\n");
  await assert.rejects(createInsightCompanyDetailReader({ ...f.options, summarize: async () => { throw Error("synthetic build failure"); } })("cmp_one"), /synthetic build failure/);
  assert.equal(f.scheduler.status().active, false); assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await read("cmp_one")).company.companyId, "cmp_one");
  assert.throws(() => createInsightCompanyDetailReader({ ...f.options, projectionVersion: "" }), TypeError);
});
