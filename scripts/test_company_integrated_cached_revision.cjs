"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createCompanyIntegratedSourceRevision } = require("./lib/company_integrated_source_revision.cjs");
const A = "cmp_place_100", B = "cmp_place_200";
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-cached-revision-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("company-cached-revision-")); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
  await write("regions.json", { units: [100, 200].map(id => ({ regionKey: "region_" + id, regionId: "KR" + id, active: true, selectable: true, level: "local", name: "지역" + id, fullName: "시험도 지역" + id })) });
  await write("company_master/companies.json", { companies: Object.fromEntries([100, 200].map(id => ["cmp_place_" + id, {
    companyId: "cmp_place_" + id, primaryName: "모의 글램핑" + id, placeIds: [String(id)], addresses: ["시험도 지역" + id + " 주소"],
    manualCorrection: { capacity: 16 }, keywords: { initial: { keyword: "모의글램핑", runs: [{ runId: "run_" + id, collectedAt: "2026-09-01T00:00:00Z", rank: 1 }] } }
  }])) });
  await write("history/observations.jsonl", [A, B].map(companyId => JSON.stringify({ companyId, runId: "run_" + companyId.slice(10), stayDate: "2026-09-01", value: 0, status: "observed" })).join("\n") + "\n");
  await write("company_integrated/capacity-bases.json", { schemaVersion: 1, companies: { [A]: { count: 16 }, [B]: { count: 16 } } });
  for (const id of [100, 200]) await write(`outputs/run_${id}/manifest.json`, { collectedAt: "2026-09-01T00:00:00Z", checkIn: "2026-09-01", bookingRangeDays: 31, collectionQuality: { status: "complete" } });
  await write("history/special_days/2026.json", { holidays: [{ date: "2026-09-25" }] });
  await write("history/special_days/2027.json", { holidays: [{ date: "2027-01-01" }] });
  await write("tourism_data/cache/fixture.json", { region: { regionKey: "region_100" }, yearMonth: "202609", value: 0 });
  const fileSystem = Object.create(fs), counters = { reads: 0, opens: 0, writes: 0, stats: 0 }, control = { noBodies: false, lstat: null, readdir: null };
  fileSystem.readFile = async (...args) => { counters.reads++; if (control.noBodies) throw new Error("No JSON or original body reads in the cached lane"); return fs.readFile(...args); };
  fileSystem.open = async (...args) => { counters.opens++; if (control.noBodies) throw new Error("No original hashing or publication in the cached lane"); return fs.open(...args); };
  fileSystem.rename = async (...args) => { counters.writes++; if (control.noBodies) throw new Error("No publication in the cached lane"); return fs.rename(...args); };
  fileSystem.lstat = async (...args) => { counters.stats++; if (control.lstat) await control.lstat(...args); return fs.lstat(...args); };
  fileSystem.readdir = async (...args) => { if (control.readdir) await control.readdir(...args); return fs.readdir(...args); };
  const options = { dataDir: root, regionMasterFile: path.join(root, "regions.json"), fileSystem };
  return { root, write, options, control, counters, index: path.join(root, "company_integrated/revision-index.json") };
}
const scope = (companyId = A, month = "2026-09") => ({ companyId, month, cutoffDate: "", calculationVersion: "test-v1" });

test("fresh cached preparation is selected-scope equivalent and never reads bodies, rebuilds, or mutates the validated index", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options);
  assert.equal(await reader.prepareFreshCached({ scope: scope() }), null, "A durable file alone is not an in-process validated index");
  const full = await reader.prepare(), before = await fs.readFile(f.index), bodyCounters = { ...f.counters };
  f.control.noBodies = true;
  for (const month of ["2026-01", "2026-08", "2026-09", "2026-10", "2026-12", "2027-01"]) {
    for (const companyId of [A, B]) {
      const request = scope(companyId, month), prepared = await reader.prepareFreshCached({ scope: request });
      assert.ok(prepared); assert.deepEqual(Object.keys(prepared.companies), [companyId]);
      assert.equal(reader.forScope(prepared, request), reader.forScope(full, request));
      prepared.companies[companyId].revision = "mutated";
    }
  }
  const prepared = await reader.prepareFreshCached({ scope: scope() });
  assert.equal(reader.forScope(prepared, scope()), reader.forScope(full, scope()));
  assert.deepEqual({ reads: f.counters.reads, opens: f.counters.opens, writes: f.counters.writes }, { reads: bodyCounters.reads, opens: bodyCounters.opens, writes: bodyCounters.writes });
  assert.deepEqual(await fs.readFile(f.index), before);
  assert.equal(await createCompanyIntegratedSourceRevision(f.options).prepareFreshCached({ scope: scope() }), null, "Restart cannot trust an unvalidated on-disk cache");
});

test("any source metadata change is a miss without rebuilding or writing, and only normal preparation can establish a new baseline", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options); await reader.prepare();
  for (const [name, value] of [
    ["history/observations.jsonl", "malformed\n"],
    ["company_integrated/capacity-bases.json", { schemaVersion: 1, companies: { [A]: { count: 17 } } }],
    ["outputs/new-run/manifest.json", { status: "partial" }],
    ["history/special_days/2027.json", { holidays: [{ date: "2027-01-02" }] }],
    ["tourism_data/cache/fixture.json", { region: { regionKey: "region_100" }, yearMonth: "202609", value: 1 }]
  ]) {
    await f.write(name, value); const before = await fs.readFile(f.index), reads = f.counters.reads, writes = f.counters.writes;
    f.control.noBodies = true; assert.equal(await reader.prepareFreshCached({ scope: scope() }), null, name);
    assert.equal(f.counters.reads, reads); assert.equal(f.counters.writes, writes); assert.deepEqual(await fs.readFile(f.index), before);
    f.control.noBodies = false; await reader.prepare();
    f.control.noBodies = true; assert.ok(await reader.prepareFreshCached({ scope: scope() })); f.control.noBodies = false;
  }
});

test("source and durable-index changes during inspection cannot certify a mixed snapshot", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options); await reader.prepare(); f.control.noBodies = true;
  let changed = false;
  f.control.readdir = async file => { if (!changed && path.resolve(file) === path.join(f.root, "outputs")) { changed = true; await fs.appendFile(path.join(f.root, "history/observations.jsonl"), "changed-after-stat\n"); } };
  assert.equal(await reader.prepareFreshCached({ scope: scope() }), null);
  f.control.readdir = null; f.control.noBodies = false; await reader.prepare(); f.control.noBodies = true;
  let indexStats = 0;
  f.control.lstat = async file => { if (path.resolve(file) === f.index && ++indexStats === 2) await fs.writeFile(f.index, "{invalid}"); };
  assert.equal(await reader.prepareFreshCached({ scope: scope() }), null);
  f.control.lstat = null; assert.equal(await reader.prepareFreshCached({ scope: scope() }), null, "Corrupt replacement is never parsed or repaired in this lane");
});

test("cached preparation never joins its own blocked normal prepare chain", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options); const full = await reader.prepare();
  let release, entered; const blocked = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { entered = resolve; }); let once = false;
  f.control.readdir = async file => { if (!once && path.resolve(file) === path.join(f.root, "outputs")) { once = true; entered(); await blocked; } };
  const normal = reader.prepare(); await waiting;
  try {
    const value = await Promise.race([reader.prepareFreshCached({ scope: scope() }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("cached read joined normal chain")), 1000); timer.unref(); })]);
    assert.ok(value); assert.equal(reader.forScope(value, scope()), reader.forScope(full, scope()));
  } finally { release(); await normal; }
});

test("budget, abort, missing scope and filesystem uncertainty are bounded misses with no raw fallback", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options); await reader.prepare(); f.control.noBodies = true;
  assert.equal(await reader.prepareFreshCached(), null);
  assert.equal(await reader.prepareFreshCached({ scope: scope("missing") }), null);
  assert.equal(await reader.prepareFreshCached({ scope: scope(), budgetMs: 501 }), null);
  const abort = new AbortController(); abort.abort(); const stats = f.counters.stats;
  assert.equal(await reader.prepareFreshCached({ scope: scope(), signal: abort.signal }), null); assert.equal(f.counters.stats, stats);
  f.control.lstat = async () => new Promise(resolve => setTimeout(resolve, 5));
  const before = f.counters.stats; assert.equal(await reader.prepareFreshCached({ scope: scope(), budgetMs: 1 }), null); assert.equal(f.counters.stats - before, 1, "No further traversal after the first over-budget syscall");
  f.control.lstat = async () => { throw Object.assign(new Error("private filesystem error"), { code: "EIO" }); };
  assert.equal(await reader.prepareFreshCached({ scope: scope() }), null);
});
