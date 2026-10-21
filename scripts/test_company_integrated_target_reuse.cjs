"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nativeFs = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const { createCompanyIntegratedTargets } = require("./lib/company_integrated_targets.cjs");

async function fixture(t, count = 20) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "company-target-reuse-"));
  t.after(async () => {
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const masterFile = path.join(dataDir, "master.json"), runsFile = path.join(dataDir, "runs.json");
  const historyFile = path.join(dataDir, "history", "observations.jsonl");
  await fs.mkdir(path.dirname(historyFile));
  const companies = Array.from({ length: count }, (_, i) => ({ companyId: `c${i}`, runIds: ["run-a"],
    privatePayload: { mustNotEscape: true }, inventory: { unusedProducts: Array(50).fill("discarded") } }));
  const runs = [{ id: "run-a", checkIn: "2026-09-30", bookingRangeDays: 2, rawPayload: "discarded" }];
  await fs.writeFile(masterFile, JSON.stringify(companies));
  await fs.writeFile(runsFile, JSON.stringify(runs));
  await fs.writeFile(historyFile, [
    { companyKey: "c0", runId: "run-a", stayDate: "2026-09-03", rawResponse: "discarded" },
    { companyKey: "c0", runId: "run-b", stayDate: "2026-11-01" },
    { companyKey: "c1", runId: "run-a", stayDate: "2025-08-01" }
  ].map(JSON.stringify).join("\n") + "\n");
  const calls = { catalog: 0, history: 0, revision: 0 };
  const originalReadStream = nativeFs.createReadStream;
  t.mock.method(nativeFs, "createReadStream", function(filename, ...options) {
    if (path.resolve(filename) === historyFile) calls.history++;
    return originalReadStream.call(this, filename, ...options);
  });
  const catalog = async () => {
    calls.catalog++;
    const [master, savedRuns] = await Promise.all([fs.readFile(masterFile, "utf8"), fs.readFile(runsFile, "utf8")]);
    return { rawCompanies: new Map(JSON.parse(master).map(company => [company.companyId, company])), runs: JSON.parse(savedRuns) };
  };
  const readRevision = async () => {
    calls.revision++;
    const hash = crypto.createHash("sha256");
    for (const file of [masterFile, runsFile, historyFile]) hash.update(await fs.readFile(file));
    return hash.digest("hex");
  };
  const append = rows => fs.appendFile(historyFile, rows.map(JSON.stringify).join("\n") + "\n");
  return { dataDir, masterFile, runsFile, historyFile, companies, runs, calls, catalog, readRevision, append };
}
const rowFor = (rows, id) => rows.find(row => row.companyId === id);

test("twenty company scopes share one verified projection and return independently mutable compact results", async t => {
  const f = await fixture(t);
  const list = createCompanyIntegratedTargets(f);
  for (let i = 0; i < 20; i++) {
    const rows = await list({ companyIds: [`c${i}`] });
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["companyId", "months"]);
    assert.ok(rows[0].months.includes("2026-09") && rows[0].months.includes("2026-10"));
    rows[0].months.length = 0;
    rows[0].companyId = "tampered";
  }
  assert.equal(f.calls.catalog, 1);
  assert.equal(f.calls.history, 1);
  assert.equal(f.calls.revision, 41, "each requested scope independently verifies before and after reuse");
  assert.deepEqual(await list({ companyIds: ["c0"] }), [{ companyId: "c0", months: ["2026-09", "2026-10", "2026-11"] }]);
  assert.equal(f.calls.catalog, 1);
});

test("simultaneous company requests share discovery, including when its full result exceeds the byte cap", async t => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const list = createCompanyIntegratedTargets({ ...f, maxCacheBytes: 1, catalog: async () => { enter(); await held; return f.catalog(); } });
  const pending = Array.from({ length: 20 }, (_, i) => list({ companyIds: [`c${i}`] }));
  await entered;
  // All callers finish their independent revision read before opening the gate.
  while (f.calls.revision < 20) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  const results = await Promise.all(pending);
  assert.equal(f.calls.catalog, 1); assert.equal(f.calls.history, 1);
  assert.equal(results.length, 20);
  assert.deepEqual(results.map(rows => rows[0].companyId), Array.from({ length: 20 }, (_, i) => `c${i}`));
  assert.equal((await list()).length, 20, "oversized response is complete, never truncated");
  assert.equal(f.calls.catalog, 2, "oversized projection is not retained");
});

test("master identity, appended history and new-run scope each invalidate the projection", async t => {
  const f = await fixture(t);
  const list = createCompanyIntegratedTargets(f);
  assert.equal((await list()).length, 20);
  f.companies[0].deletedAt = "2026-10-21T00:00:00Z";
  await fs.writeFile(f.masterFile, JSON.stringify(f.companies));
  assert.equal(rowFor(await list(), "c0"), undefined, "deleted identity cannot survive through cached discovery");
  await f.append([{ companyKey: "c2", runId: "older", stayDate: "2025-01-01" }]);
  assert.deepEqual(rowFor(await list(), "c2").months, ["2025-01", "2026-09", "2026-10"]);
  f.companies[2].runIds.push("new-run");
  await fs.writeFile(f.masterFile, JSON.stringify(f.companies));
  f.runs.push({ id: "new-run", checkIn: "2027-01-31", bookingRangeDays: 2 });
  await fs.writeFile(f.runsFile, JSON.stringify(f.runs));
  assert.deepEqual(rowFor(await list(), "c2").months, ["2025-01", "2026-09", "2026-10", "2027-01", "2027-02"]);
  assert.equal(f.calls.catalog, 4); assert.equal(f.calls.history, 4);
});

test("run scopes remain separate, with sixteen entries bounded and the all-history projection prioritized", async t => {
  const f = await fixture(t, 2);
  await f.append(Array.from({ length: 17 }, (_, i) => ({ companyKey: "c0", runId: `scope-${i}`, stayDate: "2024-01-01" })));
  const list = createCompanyIntegratedTargets(f);
  const all = await list();
  assert.deepEqual(await list({ runId: "run-b" }), [{ companyId: "c0", months: ["2026-11"] }]);
  assert.deepEqual(rowFor(await list({ runId: "run-a" }), "c0").months, ["2026-09", "2026-10"]);
  for (let i = 0; i < 17; i++) assert.deepEqual(await list({ runId: `scope-${i}` }), [{ companyId: "c0", months: ["2024-01"] }]);
  const discovered = f.calls.catalog;
  assert.deepEqual(await list(), all);
  assert.deepEqual(await list({ runId: "scope-16" }), [{ companyId: "c0", months: ["2024-01"] }]);
  assert.equal(f.calls.catalog, discovered, "all scope and newest run survive eviction");
  await list({ runId: "scope-0" });
  assert.equal(f.calls.catalog, discovered + 1, "old non-default scope is rebuilt after eviction");
  assert.equal(f.calls.history, f.calls.catalog);
});

test("aggregate byte limit evicts non-default entries without truncating a response", async t => {
  const f = await fixture(t, 2);
  const list = createCompanyIntegratedTargets({ ...f, maxCacheBytes: 350 });
  const all = await list();
  const a = await list({ runId: "run-a" });
  const b = await list({ runId: "run-b" });
  assert.equal(all.length, 2); assert.equal(a.length, 2); assert.equal(b.length, 1);
  const before = f.calls.catalog;
  assert.deepEqual(await list(), all);
  assert.equal(f.calls.catalog, before, "default scope is prioritized under the aggregate byte limit");
  assert.deepEqual(await list({ runId: "run-a" }), a);
  assert.equal(f.calls.catalog, before + 1, "older non-default scope cannot stay beyond the aggregate bound");
  assert.throws(() => createCompanyIntegratedTargets({ ...f, maxCacheBytes: 8 * 1024 * 1024 + 1 }), TypeError);
});

test("unavailable revisions and changed-source discovery errors fail closed and preserve a verified last-good cache", async t => {
  const f = await fixture(t, 2);
  let revisionFailure = false, sourceFailure = false;
  const list = createCompanyIntegratedTargets({ ...f,
    readRevision: () => revisionFailure ? Promise.reject(new Error("unavailable")) : f.readRevision(),
    catalog: () => sourceFailure ? Promise.reject(new Error("catalog read failed")) : f.catalog() });
  const good = await list();
  revisionFailure = true;
  await assert.rejects(list(), { code: "COMPANY_TARGET_SOURCE_UNAVAILABLE", statusCode: 503 });
  revisionFailure = false;
  assert.deepEqual(await list(), good);
  assert.equal(f.calls.catalog, 1, "revision failure did not discard the verified last-good entry");
  await f.append([{ companyKey: "c0", runId: "older", stayDate: "2023-01-01" }]);
  sourceFailure = true;
  await assert.rejects(list(), { code: "COMPANY_TARGET_SOURCE_UNAVAILABLE" });
  sourceFailure = false;
  assert.ok(rowFor(await list(), "c0").months.includes("2023-01"));
  assert.equal(f.calls.catalog, 2); assert.equal(f.calls.history, 2);
});

test("one concurrent source change retries once, while continued changes never publish or serve stale results", async t => {
  const f = await fixture(t, 2);
  let mutate = true;
  const list = createCompanyIntegratedTargets({ ...f, catalog: async () => {
    const result = await f.catalog();
    if (mutate) { mutate = false; await f.append([{ companyKey: "c0", runId: "new", stayDate: "2022-01-01" }]); }
    return result;
  } });
  assert.ok(rowFor(await list(), "c0").months.includes("2022-01"));
  assert.equal(f.calls.catalog, 2); assert.equal(f.calls.history, 2);
  let unstable = false, sequence = 0;
  const guarded = createCompanyIntegratedTargets({ ...f, readRevision: () => unstable ? Promise.resolve(`changing-${++sequence}`) : f.readRevision() });
  const good = await guarded();
  const before = f.calls.catalog;
  unstable = true;
  await assert.rejects(guarded(), { code: "COMPANY_TARGET_SOURCE_CHANGED", statusCode: 503 });
  assert.equal(f.calls.catalog, before + 2, "only one discovery retry is allowed");
  unstable = false;
  assert.deepEqual(await guarded(), good);
  assert.equal(f.calls.catalog, before + 2, "unstable source did not replace last-good cache");
});

test("a cache-hit revision race is rechecked and yields the new month rather than the cached result", async t => {
  const f = await fixture(t, 2);
  let flipAfterFirst = false, revisionCalls = 0;
  const list = createCompanyIntegratedTargets({ ...f, readRevision: async () => {
    if (flipAfterFirst && ++revisionCalls === 2) await f.append([{ companyKey: "c0", runId: "new", stayDate: "2021-03-01" }]);
    return f.readRevision();
  } });
  await list();
  flipAfterFirst = true;
  assert.ok(rowFor(await list(), "c0").months.includes("2021-03"));
  assert.equal(f.calls.catalog, 2);
});

test("history stream errors are closed and rejected, and callers without a revision keep uncached behavior", async t => {
  const f = await fixture(t, 2);
  const original = nativeFs.createReadStream;
  const broken = new PassThrough();
  let fail = true;
  t.mock.method(nativeFs, "createReadStream", function(filename, ...options) {
    if (fail && path.resolve(filename) === f.historyFile) {
      fail = false;
      setImmediate(() => broken.destroy(Object.assign(new Error("read failed"), { code: "EIO" })));
      return broken;
    }
    return original.call(this, filename, ...options);
  });
  const list = createCompanyIntegratedTargets(f);
  await assert.rejects(list(), { code: "COMPANY_TARGET_SOURCE_UNAVAILABLE" });
  assert.equal(broken.destroyed, true);
  assert.equal((await list()).length, 2, "failed flight is removed so recovery can proceed");
  const uncached = createCompanyIntegratedTargets({ dataDir: f.dataDir, catalog: f.catalog });
  const before = f.calls.catalog;
  assert.deepEqual(await uncached({ companyIds: ["c0"] }), await uncached({ companyIds: ["c0"] }));
  assert.equal(f.calls.catalog, before + 2);
  assert.throws(() => createCompanyIntegratedTargets({ ...f, readRevision: "not a function" }), TypeError);
});
