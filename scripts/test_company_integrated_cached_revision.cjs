"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedSourceRevision } = require("./lib/company_integrated_source_revision.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
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
      assert.equal(Object.hasOwn(prepared, "revision"), false, "A scoped certificate must not advertise a current global revision");
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
    ["company_master/companies.json", await fs.readFile(path.join(f.root, "company_master", "companies.json"), "utf8") + "\n"],
    ["history/observations.jsonl", "malformed\n"],
    ["company_integrated/capacity-bases.json", { schemaVersion: 1, companies: { [A]: { count: 17 } } }],
    ["outputs/run_100/new-response.json", { status: "partial" }],
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
  f.control.readdir = async file => { if (!changed && path.resolve(file) === path.join(f.root, "outputs", "run_100")) { changed = true; await fs.appendFile(path.join(f.root, "history/observations.jsonl"), "changed-after-stat\n"); } };
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

test("unrelated run bodies are skipped while the scoped token equals a complete fresh preparation", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options), request = scope();
  const full = await reader.prepare(), before = reader.forScope(full, request); let touchedUnrelated = 0;
  f.control.lstat = async file => { if (path.resolve(file).startsWith(path.join(f.root, "outputs", "run_200") + path.sep)) touchedUnrelated++; };
  await f.write("outputs/run_200/new-response.json", { status: "blocked" });
  await f.write("outputs/unreferenced/new-response.json", { status: "error" });
  f.control.noBodies = true;
  const cached = await reader.prepareFreshCached({ scope: request }); assert.ok(cached);
  assert.equal(touchedUnrelated, 0, "No lstat or body read for another company's original run");
  assert.equal(reader.forScope(cached, request), before);
  f.control.noBodies = false; const fresh = await reader.prepare();
  assert.equal(reader.forScope(cached, request), reader.forScope(fresh, request));
  assert.notEqual(reader.forScope(fresh, scope(B)), reader.forScope(full, scope(B)), "The full baseline still detects the other company's changed run");
});

test("history-only run references, own run additions/removals and unsafe references cannot escape scoped inspection", async t => {
  const f = await fixture(t), reader = createCompanyIntegratedSourceRevision(f.options), request = scope();
  await f.write("history/observations.jsonl", JSON.stringify({ companyId: A, runId: "history_only", stayDate: "2026-08-31", value: 0, status: "observed" }) + "\n");
  await f.write("outputs/history_only/manifest.json", { collectedAt: "2026-08-31T00:00:00Z", status: "complete" });
  let full = await reader.prepare(); assert.ok(await reader.prepareFreshCached({ scope: request }));
  await f.write("outputs/history_only/nested/response.json", { value: 1 }); f.control.noBodies = true;
  assert.equal(await reader.prepareFreshCached({ scope: request }), null, "Previous-month history references remain inputs without a master run ID");
  f.control.noBodies = false; const fresh = await reader.prepare();
  assert.notEqual(reader.forScope(fresh, request), reader.forScope(full, request)); full = fresh;
  await fs.unlink(path.join(f.root, "outputs", "run_100", "manifest.json")); f.control.noBodies = true;
  assert.equal(await reader.prepareFreshCached({ scope: request }), null, "Removing an own original is never a ready zero");
  f.control.noBodies = false; await reader.prepare();
  await f.write("history/observations.jsonl", JSON.stringify({ companyId: A, runId: "../../outside", stayDate: "2026-09-01", value: 0 }) + "\n");
  await reader.prepare(); f.control.noBodies = true;
  let escaped = false; f.control.lstat = async file => { const relative = path.relative(f.root, path.resolve(file)); if (relative.startsWith("..")) escaped = true; };
  assert.equal(await reader.prepareFreshCached({ scope: request }), null); assert.equal(escaped, false);
});

test("every retained witness descriptor remains a dependency even when compact evidence omits that run", async t => {
  const f = await fixture(t), request = scope(), store = createProductCapacityStore({ dataDir: f.root });
  for (const runId of ["retained", "descriptor_only"]) await f.write(`outputs/${runId}/manifest.json`, { collectedAt: "2026-05-01T00:00:00Z", status: "complete" });
  const master = JSON.parse(await fs.readFile(path.join(f.root, "company_master", "companies.json"), "utf8"));
  const companies = new Map(Object.entries(master.companies));
  await store.publish([{ companyId: A, productId: "room", productType: "lodging", count: 14, collectedAt: "2026-05-01T00:00:00Z", runId: "retained" },
    { companyId: B, productId: "room", productType: "lodging", count: 14, collectedAt: "2026-05-01T00:00:00Z", runId: "descriptor_only" }],
  { companies, sourceRevision: "test-source", assertCurrent: async () => {} });
  const witness = id => path.join(store.directory, digest(id) + ".json"), value = JSON.parse(await fs.readFile(witness(A), "utf8"));
  const extra = JSON.parse(await fs.readFile(witness(B), "utf8")).runs[0];
  const { checksum, ...body } = value; body.runs.push(extra);
  await fs.writeFile(witness(A), JSON.stringify({ ...body, checksum: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex") }));
  const reader = createCompanyIntegratedSourceRevision(f.options), full = await reader.prepare();
  assert.deepEqual(full.companies[A].productCapacity.evidence.map(row => row.runId), ["retained"]);
  f.control.noBodies = true; assert.ok(await reader.prepareFreshCached({ scope: request }));
  await f.write("outputs/descriptor_only/new-response.json", { changed: true });
  assert.equal(await reader.prepareFreshCached({ scope: request }), null, "The extra descriptor can turn a valid witness into an invalid-source warning");
  f.control.noBodies = false; const fresh = await reader.prepare();
  assert.notEqual(reader.forScope(full, request), reader.forScope(fresh, request));
  const index = JSON.parse(await fs.readFile(f.index, "utf8")); delete index.parts.productCapacity[A].sourceRunIds;
  const { checksum: indexChecksum, ...indexBody } = index; await fs.writeFile(f.index, JSON.stringify({ ...indexBody, checksum: digest(indexBody) }));
  const oldShape = createCompanyIntegratedSourceRevision(f.options); await oldShape.prepare(); f.control.noBodies = true;
  assert.equal(await oldShape.prepareFreshCached({ scope: request }), null, "Unknown descriptor coverage in an older validated index is a miss");
});
