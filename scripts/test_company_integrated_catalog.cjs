"use strict";

// Behavioral tests for the bounded metadata catalog used by saved integrated
// GETs. They use temporary synthetic files only; no app/provider is started.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createCompanyIntegratedCatalog, createCompanyIntegratedCatalogRevision, createRevisionCheckedCompanyCatalog } = require("./lib/company_integrated_catalog.cjs");
const { createMonthlyReportSelectorRevision } = require("./lib/monthly_report_selector_revision.cjs");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const clone = value => JSON.parse(JSON.stringify(value));
const copyCatalog = source => ({ ...clone({ ...source, rawCompanies: Object.fromEntries(source.rawCompanies) }),
  rawCompanies: new Map([...source.rawCompanies].map(([id, value]) => [id, clone(value)])) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-catalog-"));
  const id = "company_a", state = { revision: "revision-1", builds: 0, revisionReads: 0, failedRevision: "", buildHook: null, originalError: false };
  const company = { companyId: id, primaryName: "검수 업체", capacity: 16, capacitySource: "관리자 검수값",
    capacityBasis: { capacity: 16, count: 16, source: "db_review", revision: 3, warnings: [] },
    inventory: { daily: [{ privateHeavyInventory: "THIS_FULL_HISTORY_MUST_NOT_BE_CACHED" }] } };
  const raw = { companyId: id, primaryName: "검수 업체", manualCorrection: { lodgingBasisTotal: 16, active: true },
    _integratedCapacity: clone(company.capacityBasis),
    keywords: { keyword_a: { keyword: "경남글램핑", runs: [{ runId: "run_a", collectedAt: "2026-09-20T05:00:00Z", rank: 1 }] } },
    inventory: { snapshots: [{ privateHeavyInventory: "THIS_FULL_HISTORY_MUST_NOT_BE_CACHED" }] } };
  state.data = { companies: [company], rawCompanies: new Map([[id, raw]]),
    runs: [{ id: "run_a", collectionQuality: { status: "partial" },
      inventory: { privateHeavyInventory: "THIS_FULL_HISTORY_MUST_NOT_BE_CACHED" } }],
    regions: [{ id: "reference-not-needed-by-integrated-get" }], history: { observations: ["THIS_FULL_HISTORY_MUST_NOT_BE_CACHED"] } };
  const options = {
    dataDir: root, version: "test-catalog-v1", now: () => new Date("2026-10-18T00:00:00Z"),
    readRevision: async () => {
      state.revisionReads++;
      if (state.failedRevision === "throw") throw Object.assign(new Error("private revision source details"), { code: "EACCES" });
      if (state.failedRevision === "null") return null;
      return state.revision;
    },
    catalog: async () => {
      state.builds++;
      if (state.originalError) throw Object.assign(new Error("private full source details"), { code: "EACCES" });
      const value = copyCatalog(state.data);
      if (state.buildHook) await state.buildHook(state.builds, value);
      return value;
    },
    ...overrides
  };
  const make = changes => createCompanyIntegratedCatalog({ ...options, ...changes });
  const file = path.join(root, "company_integrated", "catalog.json");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("company-integrated-catalog-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, id, state, options, make, file };
}

test("compact metadata preserves reviewed capacity, partial run status, nulls and keyword evidence without full inventories", async t => {
  const f = await fixture(t); f.state.data.companies[0].capacity = null; f.state.data.companies[0].capacityBasis.capacity = null;
  f.state.data.rawCompanies.get(f.id)._integratedCapacity.capacity = null;
  const value = await f.make().catalog();
  assert.equal(value.companies[0].capacity, null);
  assert.equal(value.companies[0].capacitySource, "관리자 검수값");
  assert.equal(value.rawCompanies instanceof Map, true);
  assert.equal(value.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal, 16);
  assert.equal(value.rawCompanies.get(f.id)._integratedCapacity.capacity, null);
  assert.equal(value.rawCompanies.get(f.id).keywords.keyword_a.runs[0].rank, 1);
  assert.equal(value.runs[0].collectionQuality.status, "partial");
  const disk = await fs.readFile(f.file, "utf8");
  assert.ok(!disk.includes("THIS_FULL_HISTORY_MUST_NOT_BE_CACHED"));
  assert.equal(value.companies[0].inventory, undefined); assert.equal(value.rawCompanies.get(f.id).inventory, undefined);
  assert.equal(value.runs[0].inventory, undefined); assert.equal(value.history, undefined);
  assert.equal(f.state.builds, 1);
});

test("each memory hit checks the fresh revision and isolates nested consumer mutations", async t => {
  const f = await fixture(t), cache = f.make(), first = await cache.catalog(), reads = f.state.revisionReads;
  first.companies[0].capacity = 999;
  first.companies[0].capacityBasis.warnings.push("consumer mutation");
  first.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal = 999;
  first.rawCompanies.get(f.id).keywords.keyword_a.runs[0].rank = 999;
  first.runs[0].collectionQuality.status = "blocked";
  const next = await cache.catalog();
  assert.ok(f.state.revisionReads > reads, "a memory cache does not bypass change inspection");
  assert.equal(f.state.builds, 1);
  assert.equal(next.companies[0].capacity, 16); assert.deepEqual(next.companies[0].capacityBasis.warnings, []);
  assert.equal(next.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal, 16);
  assert.equal(next.rawCompanies.get(f.id).keywords.keyword_a.runs[0].rank, 1);
  assert.equal(next.runs[0].collectionQuality.status, "partial");
});

test("bounded selected metadata borrows only a freshly matching compact cache and never rebuilds", async t => {
  const f = await fixture(t), cache = f.make();
  assert.equal(await cache.cachedCompany(f.id), null, "an empty cache never starts a full source read");
  assert.equal(f.state.builds, 0);
  await cache.catalog(); const bytes = await fs.readFile(f.file), stat = await fs.stat(f.file, { bigint: true });
  f.state.originalError = true;
  const selected = await cache.cachedCompany(f.id);
  assert.equal(selected.company.companyId, f.id); assert.equal(selected.company.capacity, 16);
  assert.equal(selected.raw.manualCorrection.lodgingBasisTotal, 16);
  assert.equal(selected.data.runs[0].collectionQuality.status, "partial");
  assert.equal(JSON.stringify(selected).includes("THIS_FULL_HISTORY_MUST_NOT_BE_CACHED"), false);
  selected.company.capacity = 999; selected.raw.keywords.keyword_a.runs[0].rank = 999;
  assert.equal((await cache.cachedCompany(f.id)).company.capacity, 16);
  assert.equal((await cache.cachedCompany(f.id)).raw.keywords.keyword_a.runs[0].rank, 1);
  const restarted = f.make(); assert.equal((await restarted.cachedCompany(f.id)).company.capacity, 16);
  assert.equal(f.state.builds, 1, "restart hits do not rebuild or construct full inventories");
  assert.deepEqual(await fs.readFile(f.file), bytes);
  const after = await fs.stat(f.file, { bigint: true }); assert.deepEqual([after.ino, after.mtimeNs], [stat.ino, stat.mtimeNs]);
  f.state.revision = "changed-review-or-original";
  assert.equal(await cache.cachedCompany(f.id), null);
  assert.equal(await restarted.cachedCompany(f.id), null);
  assert.equal(f.state.builds, 1);
});

test("cached selected metadata refuses source races, invalidation, deletion, corruption and expired budgets", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog(); const count = f.state.builds;
  assert.equal(await cache.cachedCompany("deleted-company"), null);
  assert.equal(await cache.cachedCompany(f.id, { budgetMs: 0 }), null);
  f.state.failedRevision = "throw"; assert.equal(await cache.cachedCompany(f.id), null); f.state.failedRevision = "";
  let reads = 0;
  const raced = f.make({ readRevision: async () => ++reads === 1 ? f.state.revision : "changed-during-read" });
  assert.equal(await raced.cachedCompany(f.id), null);
  const invalidated = f.make({ readRevision: async () => { invalidated.invalidate(); return f.state.revision; } });
  assert.equal(await invalidated.cachedCompany(f.id), null);
  const expired = f.make({ readRevision: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return f.state.revision; } });
  assert.equal(await expired.cachedCompany(f.id, { budgetMs: 1 }), null);
  await fs.writeFile(f.file, '{"corrupt":true}'); assert.equal(await f.make().cachedCompany(f.id), null);
  assert.equal(f.state.builds, count, "every uncertain fast read defers instead of rebuilding");
});

test("a new cache instance reuses validated persisted metadata with no full catalog read or file touch", async t => {
  const f = await fixture(t), first = await f.make().catalog();
  const before = await fs.readFile(f.file), statBefore = await fs.stat(f.file, { bigint: true });
  f.state.originalError = true; f.state.builds = 0;
  const value = await f.make().catalog();
  assert.deepEqual(value, first); assert.equal(f.state.builds, 0);
  assert.deepEqual(await fs.readFile(f.file), before);
  const statAfter = await fs.stat(f.file, { bigint: true });
  assert.deepEqual([statAfter.ino, statAfter.mtimeNs], [statBefore.ino, statBefore.mtimeNs]);
});

test("a fresh cached read completes independently while the original full-source path is blocked", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  const release = deferred(), started = deferred();
  f.state.buildHook = async () => { started.resolve(); await release.promise; };
  const background = f.options.catalog(); await started.promise;
  let timeout;
  try {
    const value = await Promise.race([cache.catalog(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("cached metadata waited for full source")), 500); })]);
    assert.equal(value.companies[0].capacity, 16); assert.equal(f.state.builds, 2, "only the explicitly blocked background catalog was added");
  } finally { clearTimeout(timeout); release.resolve(); await background; }
});

test("concurrent cold misses coalesce one compact catalog build", async t => {
  const f = await fixture(t), cache = f.make(), release = deferred(), entered = deferred();
  f.state.buildHook = async () => { entered.resolve(); await release.promise; };
  const pending = Array.from({ length: 8 }, () => cache.catalog());
  await entered.promise;
  // Yield at a barrier rather than asserting a machine-dependent duration.
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state.builds, 1);
  release.resolve(); const values = await Promise.all(pending);
  assert.equal(f.state.builds, 1);
  values[0].companies[0].primaryName = "consumer changed";
  assert.equal(values[1].companies[0].primaryName, "검수 업체");
});

test("master review, run import and capacity-basis revisions replace cached compact fields", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  f.state.revision = "master-review-2";
  f.state.data.companies[0].primaryName = "새 업체명";
  f.state.data.companies[0].capacity = 17;
  f.state.data.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal = 17;
  let value = await cache.catalog();
  assert.equal(value.companies[0].primaryName, "새 업체명"); assert.equal(value.companies[0].capacity, 17);
  assert.equal(value.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal, 17);
  f.state.revision = "new-run-3";
  f.state.data.runs.push({ id: "run_b", collectionQuality: { status: "complete" } });
  f.state.data.runs[0].collectionQuality.status = "blocked";
  f.state.data.rawCompanies.get(f.id).keywords.keyword_a.runs.push({ runId: "run_b", collectedAt: "2026-10-18T00:00:00Z", rank: 2 });
  value = await cache.catalog();
  assert.deepEqual(value.runs.map(run => [run.id, run.collectionQuality.status]), [["run_a", "blocked"], ["run_b", "complete"]]);
  assert.equal(value.rawCompanies.get(f.id).keywords.keyword_a.runs.at(-1).rank, 2);
  f.state.revision = "capacity-basis-4";
  f.state.data.companies[0].capacityBasis.revision = 4;
  f.state.data.rawCompanies.get(f.id)._integratedCapacity.revision = 4;
  f.state.data.rawCompanies.get(f.id)._integratedCapacity.warnings = ["관리자 검토 필요"];
  value = await cache.catalog();
  assert.equal(value.companies[0].capacityBasis.revision, 4);
  assert.deepEqual(value.rawCompanies.get(f.id)._integratedCapacity.warnings, ["관리자 검토 필요"]);
  assert.equal(f.state.builds, 4);
});

test("a changed active-company roster cannot resurrect a deleted or merged cached company", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  f.state.revision = "deleted-or-merged-roster-2";
  f.state.data.companies = []; f.state.data.rawCompanies = new Map();
  const value = await cache.catalog();
  assert.deepEqual(value.companies, []); assert.equal(value.rawCompanies.size, 0); assert.equal(f.state.builds, 2);
});

for (const failure of ["throw", "null"]) test(`a fresh revision ${failure} never serves a stale successful catalog or overwrites its last good file`, async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog(); const before = await fs.readFile(f.file);
  f.state.failedRevision = failure;
  await assert.rejects(cache.catalog(), error => !String(error.message).includes("private revision source details"));
  assert.equal(f.state.builds, 1); assert.deepEqual(await fs.readFile(f.file), before);
  f.state.failedRevision = ""; assert.equal((await cache.catalog()).companies[0].capacity, 16);
});

test("corrupt persisted metadata is rebuilt from current sources and never returned as a successful empty/changed catalog", async t => {
  const f = await fixture(t); await f.make().catalog();
  const saved = JSON.parse(await fs.readFile(f.file, "utf8"));
  saved.value.companies[0].capacity = 999; await fs.writeFile(f.file, JSON.stringify(saved));
  f.state.builds = 0;
  assert.equal((await f.make().catalog()).companies[0].capacity, 16); assert.equal(f.state.builds, 1);
  await fs.writeFile(f.file, "{private-broken-cache"); f.state.originalError = true;
  await assert.rejects(f.make().catalog(), error => !String(error.message).includes("private") && !String(error.message).includes(f.root));
  assert.equal(await fs.readFile(f.file, "utf8"), "{private-broken-cache", "a failed rebuild does not publish an empty success");
});

test("a changed cache version rebuilds compact metadata even when its input revision is unchanged", async t => {
  const f = await fixture(t); await f.make().catalog(); f.state.builds = 0;
  await f.make({ version: "test-catalog-v2" }).catalog(); assert.equal(f.state.builds, 1);
});

test("one capacity-initialization revision change retries once and publishes only the stable second result", async t => {
  const f = await fixture(t);
  f.state.buildHook = async ordinal => {
    if (ordinal !== 1) return;
    f.state.revision = "capacity-created-2"; f.state.data.companies[0].capacity = 17;
    f.state.data.rawCompanies.get(f.id)._integratedCapacity.capacity = 17;
  };
  const value = await f.make().catalog();
  assert.equal(f.state.builds, 2); assert.equal(value.companies[0].capacity, 17);
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).sourceRevision, "capacity-created-2");
});

test("sources changing on both bounded build attempts cannot publish over the prior normal cache", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  const before = await fs.readFile(f.file); f.state.revision = "changed-2"; f.state.builds = 0;
  f.state.buildHook = async ordinal => { f.state.revision = "keeps-changing-" + ordinal; f.state.data.companies[0].capacity++; };
  await assert.rejects(cache.catalog());
  assert.equal(f.state.builds, 2, "there is no unbounded automatic retry");
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("a full-source error after invalidation preserves the old file and cannot return stale metadata as fresh", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog(); const before = await fs.readFile(f.file);
  f.state.revision = "changed-2"; f.state.originalError = true;
  await assert.rejects(cache.catalog(), error => !String(error.message).includes("private full source details"));
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("oversized compact metadata cannot bypass the configured memory/disk bound", async t => {
  const f = await fixture(t), limit = 4096;
  f.state.data.rawCompanies.get(f.id).keywords.keyword_a.runs = Array.from({ length: 200 }, (_, i) => ({
    runId: "large-run-" + i, collectedAt: "2026-09-20T05:00:00Z", rank: i + 1 }));
  await assert.rejects(f.make({ maxBytes: limit }).catalog());
  const bytes = await fs.readFile(f.file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  assert.ok(bytes === null || bytes.length <= limit);
});

test("manual invalidation with a changed source cannot return the prior compact object", async t => {
  const f = await fixture(t), cache = f.make(); await cache.catalog();
  const oldHash = sha(await fs.readFile(f.file));
  cache.invalidate(); f.state.revision = "explicit-change-2"; f.state.data.companies[0].primaryName = "새 메타자료";
  const value = await cache.catalog(); assert.equal(value.companies[0].primaryName, "새 메타자료");
  assert.equal(f.state.builds, 2); assert.notEqual(sha(await fs.readFile(f.file)), oldHash);
});

async function revisionFixture(t) {
  const f = await fixture(t), master = path.join(f.root, "company_master", "companies.json"), history = path.join(f.root, "history", "observations.jsonl");
  const capacity = path.join(f.root, "company_integrated", "capacity-bases.json"), regions = path.join(f.root, "regions.json"), outputs = path.join(f.root, "outputs");
  const runDir = path.join(outputs, "gyeongnam_glamping_20260920_140022"), manifest = path.join(runDir, "manifest.json");
  await fs.mkdir(path.dirname(master), { recursive: true }); await fs.mkdir(path.dirname(history), { recursive: true });
  await fs.mkdir(path.dirname(capacity), { recursive: true }); await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(master, JSON.stringify({ companies: { [f.id]: { companyId: f.id, manualCorrection: { lodgingBasisTotal: 16 } } } }));
  await fs.writeFile(history, "{\"fixture\":true}\n"); await fs.writeFile(regions, "{\"units\":[]}");
  await fs.writeFile(manifest, JSON.stringify({ collectionQuality: { status: "complete" } }));
  const io = { deniedMaster: false, bodyReads: [] };
  const guarded = new Proxy(fs, { get(target, name) {
    if (name === "lstat") return async (...args) => {
      if (io.deniedMaster && path.resolve(args[0]) === master) throw Object.assign(new Error("private unavailable master path"), { code: "EACCES" });
      return target.lstat(...args);
    };
    if (["readFile", "open"].includes(name)) return async (...args) => {
      io.bodyReads.push(path.resolve(args[0]));
      assert.notEqual(path.resolve(args[0]), master, "metadata revision must not parse the full company master");
      assert.notEqual(path.resolve(args[0]), history, "metadata revision must not load the observation history");
      assert.notEqual(path.resolve(args[0]), manifest, "manifest change checking needs metadata, not booking/detail bodies");
      return target[name](...args);
    };
    return target[name];
  } });
  const selector = createMonthlyReportSelectorRevision({ dataDir: f.root, outputsDir: outputs, regionMasterFile: regions, fileSystem: guarded });
  const reader = createCompanyIntegratedCatalogRevision({ dataDir: f.root, readSelectorRevision: selector, fileSystem: guarded });
  return { ...f, master, history, capacity, regions, outputs, runDir, manifest, io, reader };
}

test("real metadata revision detects an in-place equal-size master edit with restored mtime and never reads full bodies", async t => {
  const f = await revisionFixture(t), fixedTime = new Date("2026-09-01T00:00:00Z");
  await fs.utimes(f.master, fixedTime, fixedTime);
  const initial = await f.reader(), before = await fs.stat(f.master, { bigint: true });
  const text = await fs.readFile(f.master, "utf8"), changed = text.replace('"lodgingBasisTotal":16', '"lodgingBasisTotal":17');
  assert.notEqual(text, changed); assert.equal(Buffer.byteLength(text), Buffer.byteLength(changed));
  await fs.writeFile(f.master, changed); await fs.utimes(f.master, fixedTime, fixedTime);
  const after = await fs.stat(f.master, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs, "the real metadata edit must be represented by ctime");
  assert.notEqual(await f.reader(), initial);
  assert.ok(f.io.bodyReads.every(file => file === f.regions), "only the small region reference is content-hashed");
});

test("real metadata revision tracks capacity creation/change/removal and saved run/history imports without booking scans", async t => {
  const f = await revisionFixture(t); let previous = await f.reader();
  const changed = async action => { await action(); const next = await f.reader(); assert.notEqual(next, previous); previous = next; };
  await changed(() => fs.writeFile(f.capacity, JSON.stringify({ companies: { [f.id]: { count: 16, revision: 1 } } })));
  await changed(() => fs.writeFile(f.capacity, JSON.stringify({ companies: { [f.id]: { count: 17, revision: 2 } } })));
  await changed(() => fs.unlink(f.capacity));
  await changed(() => fs.writeFile(f.manifest, JSON.stringify({ collectionQuality: { status: "blocked" } })));
  const imported = path.join(f.outputs, "pocheon_glamping_20261018_090000");
  await changed(async () => { await fs.mkdir(imported); await fs.writeFile(path.join(imported, "manifest.json"), "{\"newRun\":true}"); });
  await changed(() => fs.appendFile(f.history, "{\"secondObservation\":true}\n"));
  // Raw request/booking evidence is outside this metadata contract. A write to
  // an existing nested body must not recreate the full booking scanner here.
  const details = path.join(f.runDir, "booking-details"); await fs.mkdir(details);
  const body = path.join(details, "response.json"); await fs.writeFile(body, "{\"old\":true}"); previous = await f.reader();
  await fs.writeFile(body, "{\"new\":true}"); assert.equal(await f.reader(), previous);
  assert.ok(f.io.bodyReads.every(file => file === f.regions));
});

test("missing or inaccessible required master invalidates a prior real metadata cache without a stale successful response", async t => {
  const f = await revisionFixture(t), cache = f.make({ readRevision: f.reader }); await cache.catalog();
  const before = await fs.readFile(f.file);
  f.io.deniedMaster = true;
  await assert.rejects(cache.catalog(), error => error.code === "COMPANY_CATALOG_SOURCE_UNAVAILABLE" && !error.message.includes("private"));
  assert.deepEqual(await fs.readFile(f.file), before); f.io.deniedMaster = false;
  await fs.rename(f.master, f.master + ".held");
  await assert.rejects(cache.catalog(), error => error.code === "COMPANY_CATALOG_SOURCE_UNAVAILABLE");
  assert.deepEqual(await fs.readFile(f.file), before);
  await fs.rename(f.master + ".held", f.master); assert.equal((await cache.catalog()).companies[0].capacity, 16);
});

test("full and compact catalogs produce identical real integrated GET metadata, review digest, zero observations and missing-day nulls", async t => {
  const f = await fixture(t), metadata = f.make(), services = [];
  const source = { companies: clone(f.state.data.companies), runs: clone(f.state.data.runs), context: { sources: [], networkAttempted: false },
    observations: [false, true].map((missing, index) => ({ companyId: f.id, runId: "run_a", productType: "lodging",
      collectedAt: "2026-09-20T03:00:00Z", date: "2026-09-" + (20 + index), inventoryEvidenceVersion: 4,
      supply: 16, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0, missing })),
    rankObservations: [] };
  const makeDb = (label, catalog) => {
    const dataDir = path.join(f.root, label), db = createCompanyIntegratedDb({ dataDir, catalog, autoStart: false,
      now: () => new Date("2026-10-18T00:00:00Z"), readRevision: async () => "fixed-local-source-revision",
      listTargets: async () => [{ companyId: f.id, months: ["2026-09"] }], loadSources: async () => clone(source) });
    services.push(db); return { db, dataDir };
  };
  t.after(async () => { for (const db of services) await db.stop(); });
  const full = makeDb("full", async () => copyCatalog(f.state.data)), compact = makeDb("compact", metadata.catalog);
  for (const { db } of [full, compact]) { await db.bootstrap(); await db.drain(); }
  const left = await full.db.get(f.id, { month: "2026-09" }), right = await compact.db.get(f.id, { month: "2026-09" });
  assert.deepEqual(right, left);
  assert.equal(right.snapshot.summary.lodging.sold, 0); assert.equal(right.snapshot.summary.lodging.estimatedRevenue, 0);
  assert.equal(right.snapshot.daily.find(row => row.date === "2026-09-21").lodging.sold, null);
  assert.equal(right.snapshot.quality.status, "partial");
  assert.equal(right.latestAttempts.find(row => row.date === "2026-09-21").reason, "missing_response");
  const stored = async root => JSON.parse(await fs.readFile(path.join(root, "company_integrated", sha(f.id), "2026-09.json"), "utf8"));
  assert.equal((await stored(full.dataDir)).metadataRevision, (await stored(compact.dataDir)).metadataRevision);
});

test("a failed atomic publication retains the prior file and exposes only a safe cache error", async t => {
  const f = await fixture(t); await f.make().catalog(); const before = await fs.readFile(f.file);
  f.state.revision = "new-source-awaiting-publication";
  const io = new Proxy(fs, { get(target, name) {
    if (name === "rename") return async () => { throw Object.assign(new Error("private publication path or device details"), { code: "EACCES" }); };
    return target[name];
  } });
  await assert.rejects(f.make({ fileSystem: io }).catalog(), error => !error.message.includes("private") && !error.message.includes(f.root));
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("a persisted metadata handle close error cannot leak filesystem details or return an unverified success", async t => {
  const f = await fixture(t); await f.make().catalog(); const before = await fs.readFile(f.file);
  const io = new Proxy(fs, { get(target, name) {
    if (name === "open") return async (...args) => {
      const handle = await target.open(...args);
      return new Proxy(handle, { get(file, method) {
        if (method === "close") return async () => { await file.close(); throw Object.assign(new Error("private cached source handle details"), { code: "EIO" }); };
        const value = file[method]; return typeof value === "function" ? value.bind(file) : value;
      } });
    };
    return target[name];
  } });
  await assert.rejects(f.make({ fileSystem: io }).catalog(), error => !error.message.includes("private") && !error.message.includes(f.root));
  assert.deepEqual(await fs.readFile(f.file), before);
});

test("a cache joining an older real monthly catalog flight publishes AFTER metadata only after that whole flight is revalidated", async t => {
  const f = await revisionFixture(t), started = deferred(), release = deferred(), cacheJoined = deferred();
  const writeMaster = (name, count) => fs.writeFile(f.master, JSON.stringify({ companies: { [f.id]: {
    companyId: f.id, primaryName: name, manualCorrection: { lodgingBasisTotal: count }, keywords: {} } } }));
  await writeMaster("BEFORE", 16);
  const preparedNames = [];
  const source = createMonthlyReportSources({ dataDir: f.root, regionMasterFile: f.regions, listRuns: async () => [],
    capacityForCompany: company => company.manualCorrection.lodgingBasisTotal,
    prepareCompanies: async companies => {
      preparedNames.push(companies[f.id].primaryName);
      if (preparedNames.length === 1) { started.resolve(); await release.promise; }
      return companies;
    } });
  // This assignment precedes every public source.catalog consumer, matching
  // the application contract. The private internal source reader stays intact.
  source.catalog = createRevisionCheckedCompanyCatalog({ catalog: source.catalog, readRevision: f.reader });
  const olderConsumer = source.catalog({ priority: "background" }); await started.promise;
  await writeMaster("AFTER", 17);
  const currentRevision = await f.reader();
  const cache = f.make({ readRevision: f.reader, catalog: options => { cacheJoined.resolve(); return source.catalog(options); } });
  const compactRead = cache.catalog(); await cacheJoined.promise;
  release.resolve();
  const [whole, value] = await Promise.all([olderConsumer, compactRead]);
  assert.deepEqual(preparedNames, ["BEFORE", "AFTER"], "the old full catalog flight must be retried from the newer master");
  assert.equal(whole.companies[0].primaryName, "AFTER");
  assert.equal(value.companies[0].primaryName, "AFTER"); assert.equal(value.companies[0].capacity, 17);
  assert.equal(value.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal, 17);
  const persisted = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(persisted.sourceRevision, currentRevision); assert.equal(persisted.value.companies[0].primaryName, "AFTER");
});

test("a real monthly catalog changing on both whole-flight attempts fails boundedly without replacing the last good compact file", async t => {
  const f = await revisionFixture(t); let count = 16, changeDuringPreparation = false, changingReads = 0;
  const writeMaster = () => fs.writeFile(f.master, JSON.stringify({ companies: { [f.id]: {
    companyId: f.id, primaryName: "VERSION_" + count, manualCorrection: { lodgingBasisTotal: count }, keywords: {} } } }));
  await writeMaster();
  const source = createMonthlyReportSources({ dataDir: f.root, regionMasterFile: f.regions, listRuns: async () => [],
    capacityForCompany: company => company.manualCorrection.lodgingBasisTotal,
    prepareCompanies: async companies => {
      if (changeDuringPreparation) { changingReads++; count++; await writeMaster(); }
      return companies;
    } });
  source.catalog = createRevisionCheckedCompanyCatalog({ catalog: source.catalog, readRevision: f.reader });
  const cache = f.make({ readRevision: f.reader, catalog: source.catalog });
  assert.equal((await cache.catalog()).companies[0].capacity, 16); const before = await fs.readFile(f.file);
  count = 17; await writeMaster(); changeDuringPreparation = true;
  await assert.rejects(cache.catalog());
  assert.equal(changingReads, 2, "the shared full catalog itself permits at most two verification attempts");
  assert.deepEqual(await fs.readFile(f.file), before, "an unstable full catalog must not certify or publish an old compact result");
});

async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("expected scheduling barrier was not reached");
}

test("a verified catalog flight queued outside a heavy owner cannot deadlock that owner's nested catalog", { timeout: 5000 }, async t => {
  const f = await revisionFixture(t), scheduler = createAnalyticalWorkScheduler(), entered = deferred(), release = deferred();
  const runWork = (operation, options) => scheduler.run(operation, options);
  const source = createMonthlyReportSources({ dataDir: f.root, regionMasterFile: f.regions, listRuns: async () => [],
    capacityForCompany: company => company.manualCorrection.lodgingBasisTotal, runWork });
  const checked = createRevisionCheckedCompanyCatalog({ catalog: source.catalog, readRevision: f.reader, runWork });
  const blocker = runWork(async () => { entered.resolve(); await release.promise; }, { kind: "ingestion" }); await entered.promise;
  const external = checked({ priority: "background" });
  await until(() => scheduler.status().queuedBackground === 1);
  const owner = runWork(() => checked(), { priority: "foreground", kind: "company-month" });
  release.resolve(); const [, whole, nested] = await Promise.all([blocker, external, owner]);
  assert.equal(whole.companies[0].companyId, f.id); assert.deepEqual(nested, whole);
  await scheduler.close();
});

test("a cold compact rebuild flight is created after lease admission and a nested owner may pass its queued caller", { timeout: 5000 }, async t => {
  const f = await fixture(t), scheduler = createAnalyticalWorkScheduler(), entered = deferred(), release = deferred();
  const runWork = (operation, options) => scheduler.run(operation, options);
  const cache = f.make({ runWork, catalog: options => runWork(() => f.options.catalog(), { ...options, kind: "full-source-catalog" }) });
  const blocker = runWork(async () => { entered.resolve(); await release.promise; }, { kind: "ingestion" }); await entered.promise;
  const external = cache.catalog({ priority: "background" });
  await until(() => scheduler.status().queuedBackground === 1);
  const owner = runWork(() => cache.catalog(), { priority: "foreground", kind: "company-month" });
  release.resolve(); const [, compact, nested] = await Promise.all([blocker, external, owner]);
  assert.equal(compact.companies[0].capacity, 16); assert.deepEqual(nested, compact);
  assert.equal(f.state.builds, 1, "the queued builder rechecks the compact result after the nested owner fills it");
  await scheduler.close();
});

test("memory and persisted compact hits bypass a busy heavy lease even while background work is memory-paused", { timeout: 5000 }, async t => {
  const f = await fixture(t); let ratio = 0.1;
  const scheduler = createAnalyticalWorkScheduler({ sampleMemory: async () => ({ ratio }) });
  const runWork = (operation, options) => scheduler.run(operation, options);
  const cache = f.make({ runWork }); await cache.prepare(); const before = await fs.readFile(f.file), beforeStat = await fs.stat(f.file, { bigint: true });
  const entered = deferred(), release = deferred();
  const blocker = runWork(async () => { entered.resolve(); await release.promise; }, { kind: "unrelated-heavy-work" }); await entered.promise;
  ratio = 0.9; await scheduler.checkpointPressure();
  let queuedRan = false; const pending = runWork(() => { queuedRan = true; }, { priority: "background" });
  const rejected = assert.rejects(pending, { code: "ANALYTICAL_WORK_CLOSED" });
  const memoryHit = await cache.catalog(), savedHit = await f.make({ runWork }).catalog();
  assert.deepEqual(memoryHit, savedHit); assert.equal(f.state.builds, 1); assert.equal(queuedRan, false);
  assert.equal(scheduler.status().activeKind, "unrelated-heavy-work"); assert.equal(scheduler.status().memory.paused, true);
  assert.deepEqual(await fs.readFile(f.file), before);
  const afterStat = await fs.stat(f.file, { bigint: true }); assert.deepEqual([afterStat.ino, afterStat.mtimeNs], [beforeStat.ino, beforeStat.mtimeNs]);
  release.resolve(); await blocker; await scheduler.close(); await rejected;
});

test("a saved preview reuses only original-bound compact memory while a derived revision rebuild is blocked", { timeout: 5000 }, async t => {
  const f = await fixture(t); let original = "original-master-1", previewReads = 0;
  const cache = f.make({ readPreviewRevision: async () => { previewReads++; return original; } });
  await cache.catalog(); const bytes = await fs.readFile(f.file), entered = deferred(), release = deferred();
  f.state.revision = "derived-capacity-revision-2"; f.state.data.companies[0].capacity = 18;
  f.state.buildHook = async () => { entered.resolve(); await release.promise; };
  const normal = cache.catalog(); await entered.promise; const beforePreview = previewReads;
  try {
    const value = await Promise.race([cache.preview(), new Promise((_, reject) => setTimeout(() => reject(Error("saved preview waited for derived rebuild")), 500))]);
    assert.equal(value.companies[0].capacity, 16); assert.equal(value.companies[0].inventory, undefined);
    assert.equal(previewReads, beforePreview + 2); assert.equal(cache.status().status, "preview"); assert.deepEqual(await fs.readFile(f.file), bytes);
    value.rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal = 999;
    assert.equal((await cache.preview()).rawCompanies.get(f.id).manualCorrection.lodgingBasisTotal, 16);
  } finally { release.resolve(); }
  assert.equal((await normal).companies[0].capacity, 18); assert.equal((await cache.preview()).companies[0].capacity, 18);
});

test("an original deletion or merge cannot reuse old preview membership and the engine rejects the old company", async t => {
  const f = await fixture(t); let original = "original-master-1";
  const cache = f.make({ readPreviewRevision: async () => original }); await cache.catalog();
  original = "original-master-2"; f.state.revision = "full-revision-2";
  f.state.data.companies[0].mergedIntoCompanyId = "new-company";
  const calls = [], engine = createCompanyIntegratedDb({ dataDir: f.root, autoStart: false,
    catalog: options => { calls.push(options); return options?.savedPreview ? cache.preview() : cache.catalog(); },
    loadSources: async () => assert.fail("deleted company cannot read sources"), listTargets: async () => [] });
  t.after(() => engine.stop());
  await assert.rejects(engine.get(f.id, { month: "2026-09", savedPreview: true }), { code: "company_not_found", statusCode: 404 });
  assert.deepEqual(calls, [{ savedPreview: true }]); assert.equal(f.state.builds, 2);
  assert.deepEqual((await cache.preview()).companies, []);
  await assert.rejects(engine.get(f.id, { month: "2026-09" }), { code: "company_not_found" }); assert.equal(calls.at(-1), undefined);
});

test("invalidation during the second original preview check rejects its old epoch and rebuilds before returning", { timeout: 5000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); let hold = false, reads = 0;
  const cache = f.make({ readPreviewRevision: async () => { if (hold && ++reads === 2) { entered.resolve(); await release.promise; } return "same-original"; } });
  await cache.catalog(); hold = true; const pending = cache.preview(); await entered.promise;
  cache.invalidate(); f.state.revision = "after-invalidation"; f.state.data.companies[0].capacity = 8;
  release.resolve(); assert.equal((await pending).companies[0].capacity, 8); assert.equal(f.state.builds, 2);
});

test("uninitialized or uncertain original preview validation falls back to the existing fully checked compact path", async t => {
  const f = await fixture(t); let bad = false;
  const cache = f.make({ readPreviewRevision: async () => { if (bad) throw Error("private original identity failure"); return "original-master"; } });
  assert.equal((await cache.preview()).companies[0].capacity, 16); assert.equal(f.state.builds, 1);
  bad = true; const reads = f.state.revisionReads; assert.equal((await cache.preview()).companies[0].capacity, 16);
  assert.ok(f.state.revisionReads > reads, "uncertain original identity cannot authorize the unchecked preview path");
  assert.throws(() => f.make({ readPreviewRevision: "not-a-function" }), TypeError);
});
