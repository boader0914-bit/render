"use strict";

// Authored, tiny saved JSON only. Exercise public authority behavior rather
// than inspecting the helper's private brand registry or assuming a brand key.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyReportIndustryProjection } = require("./lib/industry_monthly_snapshot.cjs");
const { mayBorrowMonthlyEvidence, registerIndustryDiscard, withIndustryEvidenceScope } = require("./lib/monthly_snapshot_owned_inputs.cjs");
const { YIELD_CODE } = require("./lib/cooperative_work_checkpoint.cjs");

const clone = value => JSON.parse(JSON.stringify(value));
const request = { type: "industry", targetId: "__industry_all__", month: "2026-08", cutoffDate: "2026-08-31" };
const generatedAt = "2026-08-31T12:00:00.000Z";
const readOptions = { includeContext: false, priority: "background" };
function canBorrowInIndustry(source) {
  const discard = registerIndustryDiscard(() => {});
  assert.equal(mayBorrowMonthlyEvidence(source, discard), false, "a registered callback alone is not an active scope");
  return withIndustryEvidenceScope(source, source, discard, () => mayBorrowMonthlyEvidence(source, discard));
}
async function savedBytes(root) {
  const result = new Map();
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(file);
      else {
        assert.equal(entry.isFile(), true);
        assert.ok((await fs.stat(file)).size < 64 * 1024, "fixture stays small");
        result.set(path.relative(root, file), await fs.readFile(file));
      }
    }
  }
  await visit(root); return result;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-owned-source-wiring-"));
  t.after(async () => {
    const resolved = path.resolve(root), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent);
    assert.ok(path.basename(resolved).startsWith("monthly-owned-source-wiring-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "company_master")); await fs.mkdir(path.join(root, "history"));
  const company = { companyId: "a", primaryName: "Authored fixture", addresses: ["경기도 포천시 모의로"], keywords: {} };
  const runs = ["r1", "r2"].map((id, i) => ({ id, keyword: "모의글램핑", collectedAt: `2026-08-0${i + 1}T00:00:00.000Z`, collectionQuality: { status: "complete" } }));
  const rows = runs.map((run, i) => ({ companyKey: "a", companyId: "a", runId: run.id, observationId: `authored-${i}`,
    stayDate: "2026-08-05", collectedAt: run.collectedAt, productType: "lodging", inventoryEvidenceVersion: 3,
    supply: 4, sold: 1, publicBookings: 1, phoneBookings: 0, publicRevenue: 100, phoneRevenue: 0, estimatedRevenue: 100,
    phonePriceEstimates: [], phoneValuation: { policy: "authored", allocationRanges: [{ low: 0, high: 0 }] },
    sharedDayUseEvidence: { status: "authored", groups: [] },
    capacityWitnesses: [{ companyId: "a", productType: "lodging", productId: "authored-room", count: 4, collectedAt: run.collectedAt }],
    capacityBasis: { count: 4, source: "authored" } }));
  const masterFile = path.join(root, "company_master", "companies.json"), historyFile = path.join(root, "history", "observations.jsonl");
  await fs.writeFile(masterFile, JSON.stringify({ companies: { a: company } }));
  await fs.writeFile(historyFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const protectedFiles = new Map([[masterFile, await fs.readFile(masterFile)], [historyFile, await fs.readFile(historyFile)]]);
  const counters = { historyReads: 0, recalculations: 0, publications: 0 };
  const options = {
    dataDir: root, regionMasterFile: path.join(root, "regions.json"), listRuns: async () => clone(runs),
    readRevision: async () => "authored-source-v1", projectCapacityCompany: compactMonthlyCapacityCompany,
    useSourceReadValidationBoundary: true, capacityForCompany: () => 4,
    observationIndex: {
      ensure: async () => ({ generation: "authored-history-v1", malformedHistoryLines: 0 }),
      readRows: async (query, consume) => {
        counters.historyReads++;
        const text = await fs.readFile(historyFile, "utf8");
        for (const line of text.trim().split("\n")) {
          const row = JSON.parse(line);
          if (row.stayDate.startsWith(query.month + "-")) consume(row);
        }
      }
    },
    recalculateCompanyObservations: async () => {
      counters.recalculations++;
      const result = [];
      result.persistedProductCapacityInput = { companyIds: ["a"], evidence: [], warnings: [] };
      return result;
    },
    readPersistedProductCapacityEvidence: async () => ({ evidence: [], warnings: [] }),
    publishProductCapacityEvidence: async () => { counters.publications++; }
  };
  function catalog() {
    const raw = clone(company);
    return { companies: [{ companyId: "a", primaryName: company.primaryName, placeIds: [], regionKey: "fixture", regionKeys: ["fixture"], capacity: 4 }],
      rawCompanies: new Map([["a", raw]]), regions: [], runs: clone(runs),
      _companySource: { revision: "authored-source-v1", assertCurrent: async () => {}, readCompany: async () => clone(raw) } };
  }
  function capturedProvider(after = async () => {}) {
    const captured = [];
    async function consume(work) { const result = await work(catalog()); captured.push(result.source || result); await after(result); return result; }
    return { captured, provider: { readCatalog: async () => catalog(), readCompanyCatalog: async () => catalog(),
      withCatalog: consume, withCompanyCatalog: async (_id, work) => consume(work), stats: () => ({}) } };
  }
  return { root, rows, counters, options, capturedProvider,
    create: overrides => createMonthlyReportSources({ ...options, ...overrides }),
    assertProtected: async () => { for (const [file, bytes] of protectedFiles) assert.deepEqual(await fs.readFile(file), bytes); } };
}

test("owned saved JSON opt-in rejects non-booleans and an unverified source boundary", async t => {
  const f = await fixture(t);
  for (const value of [null, 0, 1, "true", {}, []]) {
    assert.throws(() => f.create({ ownedSavedJsonObservations: value }), { name: "TypeError" });
  }
  assert.throws(() => f.create({ ownedSavedJsonObservations: true, useSourceReadValidationBoundary: false }), { name: "TypeError" });
  assert.doesNotThrow(() => f.create({ useSourceReadValidationBoundary: false }));
  assert.doesNotThrow(() => f.create({ ownedSavedJsonObservations: false, useSourceReadValidationBoundary: false }));
  await f.assertProtected();
});

test("default-false saved sources stay eager even inside a registered industry scope", async t => {
  const f = await fixture(t), source = await f.create().loadSources(request, readOptions);
  const body = JSON.stringify(source), original = source.observations.find(row => row.runId === "r1");
  assert.equal(canBorrowInIndustry(source), false);
  let discarded;
  const discard = registerIndustryDiscard((reason, row) => { if (reason === "superseded_observation") discarded = row; });
  const snapshot = withIndustryEvidenceScope(source, source, discard,
    () => buildMonthlyReportSnapshot(request, source, generatedAt, { onDiscard: discard }));
  assert.equal(snapshot.sources.selectedObservationCount, 1);
  assert.ok(discarded); assert.notStrictEqual(discarded.capacityWitnesses, original.capacityWitnesses);
  assert.deepEqual(discarded.capacityWitnesses, original.capacityWitnesses);
  assert.equal(JSON.stringify(source), body); await f.assertProtected();
});

test("a completed cold source authorizes only the private industry path while public snapshots remain eager", async t => {
  const f = await fixture(t), source = await f.create({ ownedSavedJsonObservations: true }).loadSources(request, readOptions);
  const body = JSON.stringify(source), keys = Reflect.ownKeys(source);
  assert.equal(mayBorrowMonthlyEvidence(source, null), false, "the marker alone cannot activate generic snapshot borrowing");
  assert.equal(mayBorrowMonthlyEvidence(source, () => {}), false);
  assert.equal(canBorrowInIndustry(source), true);
  const original = source.observations.find(row => row.runId === "r1"); let discarded;
  const discard = registerIndustryDiscard((reason, row) => { if (reason === "superseded_observation") discarded = row; });
  const snapshot = withIndustryEvidenceScope(source, source, discard,
    () => buildMonthlyReportSnapshot(request, source, generatedAt, { onDiscard: discard }));
  assert.ok(discarded); assert.notStrictEqual(discarded.capacityWitnesses, original.capacityWitnesses,
    "the public full snapshot must remain eager even inside a valid private scope");
  assert.equal(snapshot.sources.selectedObservationCount, 1);
  assert.notStrictEqual(snapshot.sources.observations[0].capacityWitnesses, source.observations.find(row => row.runId === "r2").capacityWitnesses,
    "the issued snapshot still owns its output evidence");
  discarded = null;
  const projected = withIndustryEvidenceScope(source, source, discard,
    () => buildMonthlyReportIndustryProjection(request, source, generatedAt, { onDiscard: discard }));
  assert.ok(discarded); assert.strictEqual(discarded.capacityWitnesses, original.capacityWitnesses,
    "only the private industry projection can use the completed producer's scoped authority");
  assert.equal(projected.sources.observations.length, 1);
  assert.equal(Object.hasOwn(projected.sources.observations[0], "capacityWitnesses"), false,
    "borrowed evidence does not escape the private projection");
  assert.deepEqual(projected.sources.runIds, snapshot.sources.runIds);
  assert.deepEqual(Reflect.ownKeys(source), keys); assert.equal(JSON.stringify(source), body);
  assert.equal(mayBorrowMonthlyEvidence(source, discard), false, "authority ends with the industry work callback");
  await f.assertProtected();
});

test("a verified candidate hit is branded afresh without reading history again or changing saved bytes", async t => {
  const f = await fixture(t), service = f.create({ ownedSavedJsonObservations: true, industrySourceCandidateCacheEnabled: true,
    industrySourceCandidateCacheVersion: "authored-owned-source-v1" });
  const cold = await service.loadSourcesWithCatalog(request, readOptions), before = await savedBytes(f.root);
  assert.equal(canBorrowInIndustry(cold.source), true);
  assert.equal(mayBorrowMonthlyEvidence(cold.catalog, null), false);
  const historyReads = f.counters.historyReads, recalculations = f.counters.recalculations;
  const next = await service.loadSourcesWithCatalog(request, readOptions);
  assert.notStrictEqual(next.source, cold.source); assert.equal(canBorrowInIndustry(next.source), true);
  assert.deepEqual(next.source, cold.source);
  assert.equal(f.counters.historyReads, historyReads); assert.equal(f.counters.recalculations, recalculations);
  const stats = service.sourceReadMetrics().industrySourceCandidates;
  assert.equal(stats.writes, 1); assert.equal(stats.hits, 1); assert.equal(stats.acceptedHits, 1); assert.equal(stats.semanticMisses, 0);
  assert.deepEqual(await savedBytes(f.root), before); await f.assertProtected();
});

test("a final source boundary rejection never grants authority to the captured partial result", async t => {
  const f = await fixture(t), boundaryFailure = Object.assign(new Error("authored stale source"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" });
  const capture = f.capturedProvider(async () => { throw boundaryFailure; });
  const service = f.create({ ownedSavedJsonObservations: true, preparedCatalogProvider: capture.provider });
  await assert.rejects(service.loadSources(request, readOptions), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  assert.equal(capture.captured.length, 1); assert.equal(canBorrowInIndustry(capture.captured[0]), false);
  assert.equal(f.counters.publications, 0); assert.equal(service.sourceReadStatus().active, false);
  await f.assertProtected();
});

for (const yielding of [false, true]) test(`publication ${yielding ? "yield" : "source failure"} leaves the captured source unbranded, then a fresh success can recover`, async t => {
  const f = await fixture(t), failure = Object.assign(new Error(yielding ? YIELD_CODE : "authored publication unavailable"),
    { code: yielding ? YIELD_CODE : "MONTHLY_SOURCE_UNAVAILABLE" });
  const capture = f.capturedProvider(); let fail = true;
  const service = f.create({ ownedSavedJsonObservations: true, preparedCatalogProvider: capture.provider,
    publishProductCapacityEvidence: async (_evidence, publication) => { await publication.checkpoint(); if (fail) throw failure; } });
  await assert.rejects(service.loadSources(request, readOptions), error => yielding ? error === failure : error.code === "MONTHLY_SOURCE_UNAVAILABLE");
  const rejected = capture.captured[0]; assert.ok(rejected);
  assert.equal(canBorrowInIndustry(rejected), false); assert.equal(service.sourceReadStatus().active, false);
  fail = false; const completed = await service.loadSources(request, readOptions);
  assert.notStrictEqual(completed, rejected); assert.equal(canBorrowInIndustry(completed), true);
  assert.equal(canBorrowInIndustry(rejected), false, "a later success cannot authorize an earlier rejected result");
  await f.assertProtected();
});
