"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { test } = require("node:test");
const { createCompanyDetailRunProjectionStore } = require("./lib/company_detail_run_projection.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-run-projection-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputs = path.join(root, "outputs"), run = path.join(outputs, "run_1"); await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(run, "manifest.json"), JSON.stringify({ keyword: "경남글램핑", collectedAt: "2026-10-19" }));
  await fs.writeFile(path.join(run, "source.csv"), "id,rooms\nselected,0\n");
  const company = { companyId: "selected", placeIds: ["123"], manualCorrection: { rooms: 16 } };
  let builds = 0;
  const build = async () => { builds++; return { run: { id: "run_1", collectedAt: "2026-10-19" }, availability: { items: [{ companyId: "selected", rooms: 0,
    revenue: null, state: "unconfirmed", capacity: company.manualCorrection.rooms, raw: await fs.readFile(path.join(run, "source.csv"), "utf8") }] } }; };
  const make = extra => createCompanyDetailRunProjectionStore({ dataDir: root, outputsDir: outputs, projectionVersion: "test-projection-v1", ...options, ...extra });
  const request = extra => ({ runId: "run_1", company, build, ...extra });
  const cache = path.join(root, "company_master", "detail_run_projections");
  const cacheFiles = async () => (await fs.readdir(cache)).filter(name => name.endsWith(".json"));
  const saved = async () => { const files = await cacheFiles(); assert.equal(files.length, 1); return { file: path.join(cache, files[0]), text: await fs.readFile(path.join(cache, files[0]), "utf8") }; };
  return { root, outputs, run, company, build, make, request, saved, cache, builds: () => builds };
}

test("selected run projection is saved/reopened exactly, real zero and unknown remain distinct, and authoritative files are never changed", async t => {
  const f = await fixture(t), files = ["manifest.json", "source.csv"], before = {};
  for (const name of files) { const file = path.join(f.run, name); before[name] = { bytes: hash(await fs.readFile(file)), stat: await fs.stat(file, { bigint: true }) }; }
  const one = await f.make().get(f.request()), two = await f.make().get(f.request());
  assert.equal(one.cacheStatus, "calculated"); assert.equal(two.cacheStatus, "saved"); assert.equal(f.builds(), 1);
  assert.deepEqual(two.data, copy(one.data)); assert.equal(two.preparedAt, one.preparedAt);
  assert.equal(two.data.availability.items[0].rooms, 0); assert.equal(two.data.availability.items[0].revenue, null);
  for (const name of files) { assert.equal(hash(await fs.readFile(path.join(f.run, name))), before[name].bytes); assert.deepEqual(await fs.stat(path.join(f.run, name), { bigint: true }), before[name].stat); }
});

test("changed/add/remove source files, company correction and projection version invalidate only their saved projection", async t => {
  const f = await fixture(t), store = f.make(); await store.get(f.request());
  await fs.writeFile(path.join(f.run, "source.csv"), "id,rooms\nselected,1\n");
  assert.equal((await store.get(f.request())).cacheStatus, "calculated");
  await fs.writeFile(path.join(f.run, "product.json"), "[]"); assert.equal((await store.get(f.request())).cacheStatus, "calculated");
  await fs.unlink(path.join(f.run, "product.json")); assert.equal((await store.get(f.request())).cacheStatus, "calculated");
  f.company.manualCorrection.rooms = 17; assert.equal((await store.get(f.request())).data.availability.items[0].capacity, 17);
  assert.equal((await f.make({ projectionVersion: "test-projection-v2" }).get(f.request())).cacheStatus, "calculated");
  assert.equal(f.builds(), 6);
});

test("a failed or incomplete rebuild preserves the previous saved projection without certifying it against changed input", async t => {
  const f = await fixture(t), store = f.make(); await store.get(f.request()); const before = await f.saved();
  await fs.writeFile(path.join(f.run, "source.csv"), "changed");
  await assert.rejects(store.get(f.request({ build: async () => { throw new Error("raw read failure"); } })), { code: "COMPANY_DETAIL_RUN_BUILD_FAILED" });
  assert.equal((await f.saved()).text, before.text);
  await assert.rejects(store.get(f.request({ build: async () => null })), { code: "COMPANY_DETAIL_RUN_BUILD_INCOMPLETE" });
  assert.equal((await f.saved()).text, before.text);
});

test("input races during build, cache-hit verification and after publication fail closed and retain the previous cache", async t => {
  const f = await fixture(t), store = f.make(); await store.get(f.request()); const before = await f.saved();
  await fs.writeFile(path.join(f.run, "source.csv"), "changed before build");
  await assert.rejects(store.get(f.request({ build: async () => { const data = await f.build(); await fs.writeFile(path.join(f.run, "source.csv"), "changed during build"); return data; } })), { code: "COMPANY_DETAIL_RUN_SOURCE_CHANGED" });
  assert.equal((await f.saved()).text, before.text);
  await store.get(f.request()); const second = await f.saved();
  let hitRead = false;
  const hitFileSystem = { ...fs, readFile: async (file, ...args) => { const result = await fs.readFile(file, ...args); if (file === second.file) { hitRead = true; await fs.writeFile(path.join(f.run, "source.csv"), "changed during hit"); } return result; } };
  await assert.rejects(f.make({ fileSystem: hitFileSystem }).get(f.request()), { code: "COMPANY_DETAIL_RUN_SOURCE_CHANGED" }); assert.equal(hitRead, true);
  assert.equal((await f.saved()).text, second.text);
  await store.get(f.request()); const third = await f.saved(); await fs.writeFile(path.join(f.run, "source.csv"), "new before publication");
  let injected = false;
  const publishingFs = { ...fs, rename: async (from, to) => { await fs.rename(from, to); if (!injected && to === third.file) { injected = true; await fs.writeFile(path.join(f.run, "source.csv"), "changed after publication"); } } };
  await assert.rejects(f.make({ fileSystem: publishingFs }).get(f.request()), { code: "COMPANY_DETAIL_RUN_SOURCE_CHANGED" });
  assert.equal((await f.saved()).text, third.text); assert.deepEqual((await fs.readdir(f.cache)).filter(name => !name.endsWith(".json")), []);
});

test("write failure preserves the previous file and does not report a successful cached result", async t => {
  const f = await fixture(t); await f.make().get(f.request()); const before = await f.saved(); await fs.writeFile(path.join(f.run, "source.csv"), "changed");
  const failingFs = { ...fs, writeFile: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  await assert.rejects(f.make({ fileSystem: failingFs }).get(f.request()), { code: "COMPANY_DETAIL_RUN_CACHE_WRITE_FAILED" }); assert.equal((await f.saved()).text, before.text);
});

test("same-key concurrent reads share one build, different company revisions serialize publications without sharing stale data", async t => {
  const f = await fixture(t), store = f.make(); let active = 0, maxActive = 0;
  const pausedBuild = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 15)); const data = await f.build(); active--; return data; };
  const [a, b] = await Promise.all([store.get(f.request({ build: pausedBuild })), store.get(f.request({ build: pausedBuild }))]);
  assert.equal(f.builds(), 1); assert.equal(a.preparedAt, b.preparedAt);
  const companyA = { ...f.company, manualCorrection: { rooms: 18 } }, companyB = { ...f.company, manualCorrection: { rooms: 19 } };
  const buildFor = company => async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return { run: { id: "run_1" }, availability: { items: [{ capacity: company.manualCorrection.rooms }] } }; };
  const results = await Promise.all([store.get(f.request({ company: companyA, build: buildFor(companyA) })), store.get(f.request({ company: companyB, build: buildFor(companyB) }))]);
  assert.deepEqual(results.map(row => row.data.availability.items[0].capacity), [18, 19]); assert.equal(maxActive, 1);
});

test("source path traversal, symbolic links and corrupted saved JSON are rejected", async t => {
  const f = await fixture(t), store = f.make();
  for (const runId of [".", "..", "../outside", "a/b", "a\\b"]) await assert.rejects(store.get(f.request({ runId })), { code: "COMPANY_DETAIL_RUN_ID_INVALID" });
  await store.get(f.request()); const saved = await f.saved(); await fs.writeFile(saved.file, "broken JSON");
  await assert.rejects(store.get(f.request()), { code: "COMPANY_DETAIL_RUN_CACHE_INVALID" });
  try { await fs.symlink(path.join(f.run, "source.csv"), path.join(f.run, "linked.csv")); }
  catch (error) { if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) return t.diagnostic("symlink creation unavailable on this Windows profile"); throw error; }
  await assert.rejects(store.get(f.request()), { code: "COMPANY_DETAIL_RUN_SCAN_LIMIT" });
});

test("heavy-work callback receives the byte estimate only on a miss, not on saved reuse", async t => {
  const calls = [], f = await fixture(t, { executeBuild: async (action, context) => { calls.push(context); return action(); } });
  const store = f.make(); await store.get(f.request()); await store.get(f.request());
  assert.equal(calls.length, 1); assert.equal(calls[0].companyId, "selected"); assert.equal(calls[0].runId, "run_1");
  assert.ok(calls[0].sourceBytes > 0 && calls[0].sourceFiles === 2);
});

test("cold builds for distinct keys are serial while a ready saved hit bypasses the busy build queue", async t => {
  const f = await fixture(t), store = f.make(); await store.get(f.request());
  let started, release; const began = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  const otherCompany = id => ({ companyId: id, placeIds: [id] });
  const buildFor = (id, pause) => async () => {
    active++; maximum = Math.max(maximum, active);
    try { if (pause) { started(); await held; } await new Promise(resolve => setTimeout(resolve, 10)); return { run: { id: "run_1" }, availability: { items: [{ companyId: id }] } }; }
    finally { active--; }
  };
  const first = store.get(f.request({ company: otherCompany("second"), build: buildFor("second", true) }));
  await began;
  const third = store.get(f.request({ company: otherCompany("third"), build: buildFor("third", false) }));
  let completed = false; const hit = await store.get(f.request()).then(value => { completed = true; return value; });
  assert.equal(hit.cacheStatus, "saved"); assert.equal(completed, true); assert.equal(active, 1, "ready hit did not have to release the held cold build");
  release(); await Promise.all([first, third]); assert.equal(maximum, 1); assert.equal(active, 0);
});

test("missing/deleted authoritative inputs cannot turn a previously saved result into a normal zero", async t => {
  const f = await fixture(t), store = f.make(); await store.get(f.request()); const before = await f.saved();
  await fs.rename(f.run, f.run + "-missing");
  await assert.rejects(store.get(f.request()), { code: "COMPANY_DETAIL_RUN_SOURCE_UNAVAILABLE" });
  assert.equal((await f.saved()).text, before.text);
});

test("oversized derived projections fail explicitly and preserve the previous normal saved projection", async t => {
  const f = await fixture(t); await f.make().get(f.request()); const before = await f.saved();
  const bounded = f.make({ maxCacheBytes: Buffer.byteLength(before.text) + 32 }); await fs.writeFile(path.join(f.run, "source.csv"), "changed");
  await assert.rejects(bounded.get(f.request({ build: async () => { const data = await f.build(); data.availability.items[0].extra = "x".repeat(4096); return data; } })), { code: "COMPANY_DETAIL_RUN_CACHE_LIMIT" });
  assert.equal((await f.saved()).text, before.text);
});

test("a saved-data checksum mismatch is rebuilt from verified authoritative inputs and never served", async t => {
  const f = await fixture(t), store = f.make(); const original = await store.get(f.request()), saved = await f.saved();
  const tampered = JSON.parse(saved.text); tampered.data.availability.items[0].rooms = 999;
  await fs.writeFile(saved.file, JSON.stringify(tampered));
  const recovered = await store.get(f.request()); assert.equal(recovered.cacheStatus, "calculated"); assert.equal(f.builds(), 2);
  assert.deepEqual(recovered.data, original.data); assert.equal(recovered.data.availability.items[0].rooms, 0);
});

test("a company correction changed during saved-hit verification cannot certify an old saved projection", async t => {
  const f = await fixture(t); await f.make().get(f.request()); const before = await f.saved();
  const racingFs = { ...fs, readFile: async (file, ...args) => { const value = await fs.readFile(file, ...args); if (file === before.file) f.company.manualCorrection.rooms = 29; return value; } };
  await assert.rejects(f.make({ fileSystem: racingFs }).get(f.request()), { code: "COMPANY_DETAIL_RUN_SOURCE_CHANGED" });
  assert.equal((await f.saved()).text, before.text);
});
