"use strict";

// Tiny authored filesystem fixtures only; no app, actual snapshot or provider.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createMonthlyCompanySourceCatalog, compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportSourceRevision } = require("./lib/monthly_report_source_revision.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const request = Object.freeze({ type: "company", targetId: "a", month: "2026-08", cutoffDate: "2026-08-31" });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const copied = value => JSON.parse(JSON.stringify(value));

async function fixture(t, { frozenDirectoryStats = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-source-continuation-"));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "monthly-source-continuation-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const companyFile = path.join(root, "company_master/companies.json"), regionFile = path.join(root, "regions.json"),
    mapFile = path.join(root, "tourism-map.json"), historyFile = path.join(root, "history/observations.jsonl"), outputs = path.join(root, "outputs");
  for (const directory of [path.dirname(companyFile), path.dirname(historyFile), path.join(outputs, "run1")]) await fs.mkdir(directory, { recursive: true });
  const company = { companyId: "a", primaryName: "Company A", placeIds: ["10"], bookingBusinessIds: ["20"],
    keywords: { k: { keyword: "fixture", runs: [{ runId: "run1", rank: 1, collectedAt: "2026-08-01T00:00:00Z" }] } } };
  await fs.writeFile(companyFile, JSON.stringify({ companies: { a: company } }));
  await fs.writeFile(regionFile, JSON.stringify({ units: [] })); await fs.writeFile(mapFile, JSON.stringify({ label: "Map A" }));
  await fs.writeFile(historyFile, JSON.stringify({ observationId: "one", companyId: "a", companyKey: "a", runId: "run1", stayDate: "2026-08-02", productType: "lodging",
    inventoryEvidenceVersion: 4, rawTotal: 10, supply: 10, sold: 2, collectedAt: "2026-08-01T00:00:00Z" }) + "\n");
  await fs.writeFile(path.join(outputs, "run1/result.json"), "{\"status\":\"complete\"}");
  const runRows = [{ id: "run1", keyword: "fixture", collectedAt: "2026-08-01T00:00:00Z", checkIn: "2026-08-01", bookingRangeDays: 2, collectionQuality: { status: "complete" } }];
  const directoryStats = new Map();
  const fileSystem = frozenDirectoryStats ? { ...fs, lstat: async (name, options) => {
    const stat = await fs.lstat(name, options);
    if (!stat.isDirectory()) return stat;
    if (!directoryStats.has(name)) directoryStats.set(name, stat);
    const initial = directoryStats.get(name);
    return new Proxy(stat, { get: (target, key) => {
      if (["size", "mtimeNs", "ctimeNs"].includes(key)) return initial[key];
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
  } } : fs;
  const readRevision = createMonthlyReportSourceRevision({ dataDir: root, outputsDir: outputs, regionMasterFile: regionFile,
    tourismRegionMapFile: mapFile, includeContext: false, fileSystem });
  const loadFullCatalog = async () => {
    const records = JSON.parse(await fs.readFile(companyFile, "utf8")).companies;
    return { companies: Object.values(records).map(row => ({ companyId: row.companyId, label: row.primaryName })), rawCompanies: new Map(Object.entries(records)), regions: [], runs: copied(runRows) };
  };
  const catalog = (options = {}) => createMonthlyCompanySourceCatalog({ dataDir: root, readRevision, loadFullCatalog,
    projectCapacityCompany: compactMonthlyCapacityCompany, version: "continuation-fixture-v1", ...options });
  const sources = (options = {}) => createMonthlyReportSources({ dataDir: root, regionMasterFile: regionFile,
    listRuns: async () => copied(runRows), readRevision, projectCapacityCompany: compactMonthlyCapacityCompany,
    companySourceVersion: "continuation-source-fixture-v1", ...options });
  async function inplace(file, from, to) {
    const before = await fs.stat(file, { bigint: true }), body = await fs.readFile(file, "utf8");
    assert.ok(body.includes(from)); const next = body.replace(from, to); assert.equal(Buffer.byteLength(next), Buffer.byteLength(body));
    const fd = await fs.open(file, "r+"); try { await fd.write(Buffer.from(next), 0, Buffer.byteLength(next), 0); } finally { await fd.close(); }
    const after = await fs.stat(file, { bigint: true }); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
  }
  return { root, companyFile, regionFile, mapFile, historyFile, outputs, readRevision, catalog, sources, inplace };
}

test("only the owning continuation omits R1; direct generic and opted-in reads retain their end assertion", async t => {
  const f = await fixture(t), generic = f.catalog(), optedIn = f.catalog({ useSourceReadValidationBoundary: true });
  await generic.readCompanyCatalog("a"); let before = generic.stats().revisionReads;
  await generic.readCompanyCatalog("a"); assert.equal(generic.stats().revisionReads - before, 3);
  await optedIn.readCompanyCatalog("a"); before = optedIn.stats().revisionReads;
  await optedIn.readCompanyCatalog("a", { continuationToken: {}, deferFinalAssertion: true });
  assert.equal(optedIn.stats().revisionReads - before, 2, "public options cannot mint the internal skip capability");
  before = optedIn.stats().revisionReads;
  const result = await optedIn.withCompanyCatalog("a", async data => {
    assert.equal(optedIn.stats().revisionReads - before, 1, "acquisition is the sole inspection before caller processing");
    return { id: data.rawCompanies.get("a").companyId };
  });
  assert.deepEqual(result, { id: "a" }); assert.equal(optedIn.stats().revisionReads - before, 2);
  await assert.rejects(optedIn.withCatalog(null), TypeError);
});

test("a continuation releases catalog serialization before nested generic and continuation reads", { timeout: 3000 }, async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true });
  await catalog.readCatalog(); const before = catalog.stats().revisionReads;
  const result = await catalog.withCompanyCatalog("a", async outer => {
    assert.equal((await catalog.readCatalog()).companies[0].companyId, "a");
    return catalog.withCatalog(async inner => [outer.companies[0].companyId, inner.companies[0].companyId]);
  });
  assert.deepEqual(result, ["a", "a"]); assert.equal(catalog.stats().revisionReads - before, 6);
});
test("product witness publication runs only after final source validation and never leaks its source owner into report payloads", async t => {
  const f = await fixture(t), evidence = [{ companyId: "a", productId: "room", productType: "lodging", count: 10, collectedAt: "2026-08-01T00:00:00Z", runId: "run1" }];
  let writes = 0, changeDuringRecalculation = false;
  const sources = f.sources({ useSourceReadValidationBoundary: true, recalculateCompanyObservations: async () => {
    if (changeDuringRecalculation) await f.inplace(f.mapFile, "Map A", "Map B");
    const rows = []; Object.defineProperty(rows, "productCapacityEvidence", { value: evidence }); return rows;
  }, publishProductCapacityEvidence: async (rows, context) => {
    assert.deepEqual(rows, evidence); await context.assertCurrent(); writes++;
  } });
  const normal = await sources.loadSources(request);
  assert.equal(writes, 1); assert.equal(Object.hasOwn(normal, "_productCapacityPublication"), false);
  changeDuringRecalculation = true;
  await assert.rejects(sources.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(writes, 1, "an invalidated read never invokes the witness publisher");
});

test("initial in-place source changes rebuild, and changes during consumption cannot publish a result", async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true });
  await catalog.readCompanyCatalog("a"); await f.inplace(f.companyFile, "Company A", "Company B");
  const fresh = await catalog.withCompanyCatalog("a", data => data.rawCompanies.get("a").primaryName);
  assert.equal(fresh, "Company B");
  let published = false;
  await assert.rejects(catalog.withCompanyCatalog("a", async () => {
    await f.inplace(f.companyFile, "Company B", "Company C"); return "must-not-publish";
  }).then(value => { published = true; return value; }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.equal(published, false);
  assert.equal((await catalog.readCompanyCatalog("a")).rawCompanies.get("a").primaryName, "Company C");
});

test("a replaced public validator cannot waive the privately captured final full assertion", async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true });
  await catalog.readCatalog(); let fakeCalls = 0;
  await assert.rejects(catalog.withCatalog(async data => {
    data._companySource.assertCurrent = async () => { fakeCalls++; };
    await f.inplace(f.mapFile, "Map A", "Map B"); return "invalid";
  }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  assert.equal(fakeCalls, 0);
});

test("reference edits and result additions are freshly checked even with unchanged parent-directory metadata", async t => {
  for (const kind of ["reference", "new-result", "in-place-result"]) {
    const f = await fixture(t, { frozenDirectoryStats: true }), catalog = f.catalog({ useSourceReadValidationBoundary: true });
    await catalog.readCatalog();
    await assert.rejects(catalog.withCatalog(async () => {
      if (kind === "reference") await f.inplace(f.mapFile, "Map A", "Map B");
      if (kind === "new-result") { await fs.mkdir(path.join(f.outputs, "run2")); await fs.writeFile(path.join(f.outputs, "run2/result.json"), "{}"); }
      if (kind === "in-place-result") await f.inplace(path.join(f.outputs, "run1/result.json"), "complete", "invalide");
      return "must-not-publish";
    }), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  }
});

test("tampered selected company bytes are rejected before the continuation executes", async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true });
  await catalog.readCatalog();
  const pointer = JSON.parse(await fs.readFile(path.join(catalog.directory, "current.json"), "utf8")), body = path.join(catalog.directory, pointer.generation, sha("a") + ".json");
  await f.inplace(body, "Company A", "Company Z"); let called = false;
  await assert.rejects(catalog.withCompanyCatalog("a", () => { called = true; }), { code: "MONTHLY_COMPANY_SOURCE_CACHE_INVALID" });
  assert.equal(called, false);
});

test("consumer failures preserve their exact value and do not strand future acquisitions", async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true }); await catalog.readCatalog();
  for (const error of [Object.assign(new Error("original"), { code: "CUSTOM_PROCESSING_ERROR", statusCode: 418 }), undefined, null, "same-string"]) {
    let caught = false;
    try { await catalog.withCatalog(() => { throw error; }); } catch (actual) { caught = true; assert.equal(actual, error); }
    assert.equal(caught, true);
  }
  assert.equal((await catalog.withCatalog(data => data.companies[0])).companyId, "a");
});

test("an expired read cannot lend its skip token to a later or unawaited acquisition", async t => {
  const f = await fixture(t), catalog = f.catalog({ useSourceReadValidationBoundary: true }); let prior;
  await catalog.withCatalog(data => { prior = data; return data.companies.length; });
  await f.inplace(f.companyFile, "Company A", "Company Z");
  const before = catalog.stats().revisionReads;
  const later = await Promise.resolve().then(() => catalog.readCompanyCatalog("a", { continuationToken: prior, sourceReadValidationBoundary: { isActive: () => true } }));
  assert.equal(later.rawCompanies.get("a").primaryName, "Company Z");
  assert.ok(catalog.stats().revisionReads - before >= 2, "a later read obtains its own fresh checks and generation");
});

test("source and paired-source adapters use two checks without changing values in every scope", async t => {
  const f = await fixture(t), generic = f.sources(), owned = f.sources({ useSourceReadValidationBoundary: true });
  for (const [type, targetId] of [["company", "a"], ["region", "none"], ["keyword", "fixture"], ["industry", "all"]]) {
    const scoped = { ...request, type, targetId }; await generic.loadSources(scoped); await owned.loadSources(scoped);
    for (const paired of [false, true]) {
      const before = owned.sourceReadMetrics().companyCatalog.revisionReads;
      const actual = paired ? await owned.loadSourcesWithCatalog(scoped) : await owned.loadSources(scoped);
      const expected = paired ? await generic.loadSourcesWithCatalog(scoped) : await generic.loadSources(scoped);
      const normalize = value => paired ? copied({ source: value.source, catalog: { ...value.catalog, rawCompanies: [...value.catalog.rawCompanies] } }) : copied(value);
      assert.deepEqual(normalize(actual), normalize(expected), type);
      assert.equal(owned.sourceReadMetrics().companyCatalog.revisionReads - before, 2);
    }
  }
});

test("adapter preserves processing error identity and closes a deferred/unawaited cache-validation scope", async t => {
  const f = await fixture(t), error = Object.assign(new Error("MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY"), { code: "EXACT_CONTEXT_ERROR", statusCode: 418 });
  const failing = f.sources({ useSourceReadValidationBoundary: true, readContext: async () => { throw error; } });
  await assert.rejects(failing.loadSources(request), actual => actual === error);
  let boundary, data, resume, lateTask, expired;
  const gate = new Promise(resolve => { resume = resolve; });
  const helper = createMonthlyCompanyRecalculation({ useSourceReadValidationBoundary: true,
    loadRun: async () => { throw Error("must-not-load-after-expiry"); }, applyCompanyManualCorrection: value => value,
    companyProductAvailabilityMatch: () => false, buildHistoryObservations: () => [] });
  const adapter = f.sources({ useSourceReadValidationBoundary: true, recalculateCompanyObservations: async (_request, acquired, options) => {
    boundary = options.sourceReadValidationBoundary; data = acquired;
    assert.equal(boundary.isActive(), true);
    lateTask = gate.then(() => helper(request, data, { sourceReadValidationBoundary: boundary }));
    lateTask.catch(() => {}); return [];
  } });
  await adapter.loadSourcesWithCatalog(request); expired = boundary;
  assert.equal(expired.isActive(), false); resume();
  await assert.rejects(lateTask, { code: "MONTHLY_RECALCULATION_UNAVAILABLE" });
  await adapter.loadSources(request); assert.notEqual(boundary, expired); assert.equal(expired.isActive(), false); assert.equal(boundary.isActive(), false);
});
