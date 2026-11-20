"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { getAnalyticalPhaseDiagnostics } = require("./lib/analytical_phase_runtime.cjs");
const { runWithCooperativeWork } = require("./lib/cooperative_work_checkpoint.cjs");
const request = { type: "industry", targetId: "__industry_all__", month: "2026-09", cutoffDate: "2026-09-26" };
const copy = x => JSON.parse(JSON.stringify(x)), hash = x => crypto.createHash("sha256").update(x).digest("hex");
const run = (id, day, status = "complete") => ({ id, keyword: "모의글램핑", checkIn: "2026-09-01", bookingRangeDays: 30,
  collectedAt: `2026-09-${day}T00:00:00Z`, collectedAtSource: "manifest", collectionQuality: { status } });
function fixtureData() {
  const runs = [run("r1", "01"), run("r2", "02", "partial")], companies = ["a", "b"].map((companyId, i) => ({ companyId, primaryName: "모의 " + companyId,
    placeIds: [String(10 + i)], lodgingTypes: ["glamping"], addresses: ["경기도 포천시 모의로"], runIds: ["r1", "r2"],
    manualCorrection: { active: true, lodgingBasisTotal: i ? 8 : 16 }, duplicateNotes: i ? [] : [{ mergedCompanyId: "old-a" }],
    keywords: { k: { keyword: "모의글램핑", runs: runs.map(r => ({ runId: r.id, rank: i + 1, collectedAt: r.collectedAt, opaqueRankMetadata: { retained: true } })) } },
    inventory: { latest: { runId: "r1", collectedAt: runs[0].collectedAt, productSnapshot: { inventoryEvidenceVersion: 4, daily: [{
      stayDate: "2026-09-03", productType: "lodging", total: 99, sold: 98, inventoryEvidenceVersion: 4, originalFallback: true }] } } } }));
  const stored = Object.fromEntries(runs.map(r => [r.id, { run: copy(r), availability: { items: companies.map((c, i) => ({ placeId: c.placeIds[0],
    inventoryEvidence: { version: 4 }, dates: ["2026-09-03", "2026-09-04", "2026-10-01"], total: 99, sold: i ? null : 3,
    estimatedRevenue: r.id === "r2" ? null : 900000, partial: r.id === "r2", missing: Boolean(i), queryAttempted: !i,
    observationStatus: i ? "unobserved" : "observed", rawMetadata: { immutable: true } })) } }]));
  return { runs, companies, stored };
}
function dependencies(f, hooks = {}) {
  return { loadRun: async id => f.stored[id], companyProductAvailabilityMatch: (c, item) => c.placeIds.includes(item.placeId),
    applyCompanyManualCorrection: (item, c) => ({ ...item, total: c.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 4 } }),
    buildHistoryObservations: data => data.availability.items.flatMap(item => item.dates.map(stayDate => ({ ...item, companyKey: item.companyId, stayDate,
      productType: "lodging", supply: item.total, publicBookings: item.missing ? null : 1, phoneBookings: item.missing ? null : 2, inventoryEvidenceVersion: 4 }))),
    recalculateAllInventory: true, projectCorrectionCompany: compactMonthlyCapacityCompany,
    readProductCapacityEvidence: async () => [{ companyId: "a", productId: "p", productType: "lodging", count: 2, collectedAt: "2026-09-01T00:00:00Z", source: "saved_recovery" }],
    readPersistedProductCapacityEvidence: async () => ({ evidence: [{ companyId: "a", productId: "p", productType: "lodging", count: 4, collectedAt: "2026-09-02T00:00:00Z" }], warnings: [] }), ...hooks };
}
function catalog(f) { return { rawCompanies: new Map(f.companies.map(c => [c.companyId, c])), companies: f.companies.map(c => ({ companyId: c.companyId })), runs: f.runs }; }
function metadata(rows) { return Object.fromEntries(["persistedProductCapacityInput", "productCapacityEvidence", "productCapacityWarnings", "productCapacityEvidenceRevision"].map(k => [k, rows[k]])); }
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-source-stream-"));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); await fs.rm(root, { recursive: true, force: true }); }); return root;
}
async function adapterFixture(t, { cached = false, stream = false, hooks = {}, recalcHooks = {}, dataTransform = null } = {}) {
  const root = await temporary(t), f = fixtureData(), masterFile = path.join(root, "company_master", "companies.json"), historyFile = path.join(root, "history", "observations.jsonl");
  if (dataTransform) dataTransform(f);
  await fs.mkdir(path.dirname(masterFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(masterFile, JSON.stringify({ companies: Object.fromEntries(f.companies.map(c => [c.companyId, c])) }));
  const history = [{ companyKey: "old-a", runId: "r1", stayDate: "2026-09-03", productType: "lodging", supply: 12, sold: 2, inventoryEvidenceVersion: 4 },
    { companyKey: "b", runId: "r2", stayDate: "2026-09-04", productType: "lodging", supply: null, missing: true, queryAttempted: false },
    { companyKey: "unknown-company", runId: "r1", stayDate: "2026-09-04", productType: "lodging", supply: 5 }];
  await fs.writeFile(historyFile, history.map(JSON.stringify).join("\n") + "\n");
  const recalc = createMonthlyCompanyRecalculation(dependencies(f, { ...(cached ? { cacheDirectory: path.join(root, "run-cache"), useSourceReadValidationBoundary: true } : {}), ...recalcHooks }));
  let publications = 0;
  const service = createMonthlyReportSources({ dataDir: root, regionMasterFile: path.join(root, "region.json"), listRuns: async () => copy(f.runs),
    capacityForCompany: c => c.manualCorrection.lodgingBasisTotal, recalculateCompanyObservations: recalc, streamIndustryObservations: stream,
    ...(cached ? { readRevision: async () => "fixture-revision", projectCapacityCompany: compactMonthlyCapacityCompany, useSourceReadValidationBoundary: true } : {}),
    readSavedProductRecoveries: async (r, data, options) => ({ observations: [], warnings: ["모의 복구 경고 유지"], productCapacityEvidence: options.productCapacityEvidence }),
    publishProductCapacityEvidence: async () => { publications++; }, ...hooks });
  const originals = async () => hash(JSON.stringify([await fs.readFile(masterFile, "utf8"), await fs.readFile(historyFile, "utf8"), f]));
  return { f, recalc, service, root, originals, publications: () => publications };
}

test("industry-only consumer releases result[] while preserving exact row order, metadata, checkpoints and immutable inputs", async () => {
  const f = fixtureData(), before = JSON.stringify(f), data = catalog(f), witness = { companyId: "a", productId: "p", productType: "lodging", count: 2,
    collectedAt: "2026-09-01T00:00:00Z", source: "saved_recovery" }, persisted = { evidence: [], warnings: [] };
  const recalc = createMonthlyCompanyRecalculation(dependencies(f, { readProductCapacityEvidence: async () => [witness], readPersistedProductCapacityEvidence: async () => persisted })); let baselineChecks = 0, streamChecks = 0;
  const baseline = await recalc(request, data, { checkpoint: async () => { baselineChecks++; } }), received = [];
  const streamed = await recalc.consumeIndustryObservations(request, data, { checkpoint: async () => { streamChecks++; }, onObservation: row => { received.push(row); } });
  assert.equal(streamed.length, 0, "no second complete result array is retained"); assert.equal(streamed.streamedObservationCount, baseline.length);
  assert.deepEqual(received, baseline); assert.deepEqual(metadata(streamed), metadata(baseline)); assert.equal(streamChecks, baselineChecks);
  assert.equal(streamed.productCapacityEvidence[0], witness); assert.equal(baseline.productCapacityEvidence[0], witness);
  assert.equal(streamed.persistedProductCapacityInput.evidence, persisted.evidence); assert.equal(streamed.productCapacityWarnings, persisted.warnings);
  assert.equal(JSON.stringify(f), before); assert.equal(received[0].supply, 16); assert.ok(received.some(r => r.partial && r.estimatedRevenue === null));
  assert.ok(received.some(r => r.missing && r.sold === null && r.publicBookings === null && r.queryAttempted === false));
  assert.equal(Object.keys(streamed).length, 0, "only non-enumerable final evidence is returned");
});
test("the existing function keeps full arrays and rejects industry-only method for public scopes", async () => {
  const f = fixtureData(), recalc = createMonthlyCompanyRecalculation(dependencies(f)), data = catalog(f);
  for (const type of ["company", "region", "keyword"]) {
    assert.throws(() => recalc.consumeIndustryObservations({ ...request, type }, data, { onObservation() {} }), TypeError);
  }
  assert.throws(() => recalc.consumeIndustryObservations(request, data, {}), TypeError);
  assert.ok((await recalc(request, data)).length > 0);
});
test("producer waits for observer promises and propagates observer errors without a successful result", async () => {
  const f = fixtureData(), recalc = createMonthlyCompanyRecalculation(dependencies(f)), data = catalog(f); let called = 0;
  const result = await recalc.consumeIndustryObservations(request, data, { onObservation: async () => { await Promise.resolve(); called++; } });
  assert.equal(result.streamedObservationCount, called); assert.ok(called > 0);
  const failure = new Error("private observer failed");
  await assert.rejects(recalc.consumeIndustryObservations(request, data, { onObservation() { throw failure; } }), e => e === failure);
});
for (const cached of [false, true]) test(`whole source JSON and Map order match with duplicate/partial/missing/correction evidence; cached=${cached}`, async t => {
  const a = await adapterFixture(t, { cached }), b = await adapterFixture(t, { cached, stream: true }), beforeA = await a.originals(), beforeB = await b.originals();
  for (let read = 0; read < 2; read++) {
    const baseline = await a.service.loadSourcesWithCatalog(request), streamed = await b.service.loadSourcesWithCatalog(request);
    assert.equal(JSON.stringify(streamed.source), JSON.stringify(baseline.source));
    assert.deepEqual([...streamed.catalog.rawCompanies.keys()], [...baseline.catalog.rawCompanies.keys()]);
    assert.deepEqual(streamed.source.observations.map(r => [r.companyId, r.runId, r.stayDate]), baseline.source.observations.map(r => [r.companyId, r.runId, r.stayDate]));
    assert.ok(streamed.source.observations.some(r => r.partial)); assert.ok(streamed.source.observations.some(r => r.missing && r.queryAttempted === false));
    assert.equal(streamed.source.observations[0].companyId, "a", "replacing an old alias row keeps its original Map position");
  }
  assert.equal(await a.originals(), beforeA); assert.equal(await b.originals(), beforeB);
  if (cached) assert.ok(b.recalc.stats().industryRunRowCacheHits > 0);
});
test("same-timestamp saved runs preserve exact correction, capacity-witness lineage and final evidence references", async t => {
  const dataTransform = f => {
    f.runs.reverse();
    for (const r of f.runs) { r.collectedAt = "2026-09-02T00:00:00Z"; f.stored[r.id].run.collectedAt = r.collectedAt; }
    for (const c of f.companies) for (const r of c.keywords.k.runs) r.collectedAt = "2026-09-02T00:00:00Z";
    for (const [id, stored] of Object.entries(f.stored)) for (const item of stored.availability.items) item.weeklyProductDetails = [{
      bizItemId: "p", name: "모의 객실", saleType: "숙박", date: "2026-09-03", stock: id === "r1" ? 5 : 7,
      bookingCount: 0, occupiedBookingCount: 0, price: 100000, open: true }];
  };
  const published = [[], []], originalEvidence = [{ companyId: "a", productId: "p", productType: "lodging", count: 2,
    collectedAt: "2026-09-01T00:00:00Z", source: "saved_recovery", runId: "before" }];
  const adapters = [];
  for (let i = 0; i < 2; i++) adapters.push(await adapterFixture(t, { cached: true, stream: Boolean(i), dataTransform,
    recalcHooks: { readProductCapacityEvidence: async () => copy(originalEvidence) }, hooks: {
      projectObservation: (row, company) => ({ ...row, appliedCompanyCapacity: company.manualCorrection.lodgingBasisTotal,
        capacityLineage: row.inventoryCapacityBaseline?.lodgingProducts?.p || null }),
      publishProductCapacityEvidence: async evidence => { published[i].push(evidence); }
    } }));
  const baseline = await adapters[0].service.loadSources(request), streamed = await adapters[1].service.loadSources(request);
  assert.equal(JSON.stringify(streamed), JSON.stringify(baseline)); assert.deepEqual(published[1], published[0]);
  const rows = streamed.observations.filter(row => row.companyId === "a" && row.stayDate === "2026-09-03");
  assert.deepEqual(rows.map(row => [row.runId, row.capacityLineage.count, row.capacityLineage.runId]), [["r1", 5, "r1"], ["r2", 7, "r2"]]);
  assert.ok(rows.every(row => row.appliedCompanyCapacity === 16));
  assert.deepEqual(published[1][0].filter(row => row.companyId === "a" && ["r1", "r2"].includes(row.runId)).map(row => [row.runId, row.count]), [["r1", 5], ["r2", 7]]);
  assert.deepEqual(originalEvidence, [{ companyId: "a", productId: "p", productType: "lodging", count: 2,
    collectedAt: "2026-09-01T00:00:00Z", source: "saved_recovery", runId: "before" }]);
});
test("stream option defaults off and non-industry source reads never invoke the new method", async t => {
  let legacy = 0, streamed = 0; const fake = async () => { legacy++; return []; }; fake.consumeIndustryObservations = async () => { streamed++; throw Error("unexpected streaming"); };
  const a = await adapterFixture(t, { hooks: { recalculateCompanyObservations: fake } }); await a.service.loadSources(request); assert.equal(legacy, 1); assert.equal(streamed, 0);
  const b = await adapterFixture(t, { stream: true, hooks: { recalculateCompanyObservations: fake } });
  for (const [type, targetId] of [["company", "a"], ["region", "not-mapped"], ["keyword", "모의글램핑"]]) await b.service.loadSources({ ...request, type, targetId });
  assert.equal(legacy, 4); assert.equal(streamed, 0);
});
test("more than 256 emitted rows preserve every post-production cooperative checkpoint and identical duplicate winners", async t => {
  const manyRows = data => data.availability.items.flatMap(item => Array.from({ length: 300 }, (_, i) => ({ ...item,
    companyKey: item.companyId, stayDate: "2026-09-" + String(3 + i % 2).padStart(2, "0"), productType: "lodging", inventoryEvidenceVersion: 4,
    supply: item.total, sequence: i })));
  const a = await adapterFixture(t, { recalcHooks: { buildHistoryObservations: manyRows } }), b = await adapterFixture(t, { stream: true, recalcHooks: { buildHistoryObservations: manyRows } });
  async function read(service) {
    let phase = 0; const checkpoints = {};
    const owner = { enabled: true, isCurrent: () => true, yieldRequested: false, nonInterruptibleDepth: 0,
      setPhase: p => { phase = p; }, setRevision() {}, checkpoint: () => { checkpoints[phase] = (checkpoints[phase] || 0) + 1; }, shouldYield: () => false };
    const value = await runWithCooperativeWork(owner, () => service.loadSources(request, { priority: "background" })); return { value, checkpoints };
  }
  const baseline = await read(a.service), streamed = await read(b.service);
  assert.equal(JSON.stringify(streamed.value), JSON.stringify(baseline.value));
  assert.deepEqual(streamed.checkpoints, baseline.checkpoints); assert.equal(streamed.checkpoints[43], 5, "1200 emitted rows keep indices0,256,512,768,1024 checkpoints after production");
});
test("source rejects a retained observer after return, invalid rows, missing count and producer failure without publication", async t => {
  let retained;
  const fake = async () => []; fake.consumeIndustryObservations = async (r, data, { onObservation }) => { retained = onObservation; const rows = []; Object.defineProperty(rows, "streamedObservationCount", { value: 0 }); return rows; };
  const a = await adapterFixture(t, { stream: true, hooks: { recalculateCompanyObservations: fake } }); await a.service.loadSources(request);
  assert.throws(() => retained({}), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
  for (const operation of [async (r, d, o) => { o.onObservation(null); }, async () => [], async (r, d, o) => {
    o.onObservation({ companyKey: "a", stayDate: "2026-09-03", runId: "r1", productType: "lodging", supply: 16 }); throw Error("source failed after one row");
  }]) {
    const broken = async () => []; broken.consumeIndustryObservations = operation;
    const b = await adapterFixture(t, { stream: true, cached: true, hooks: { recalculateCompanyObservations: broken } });
    await assert.rejects(b.service.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); assert.equal(b.publications(), 0);
  }
});
test("final fresh source assertion still rejects a changed revision after streamed rows", async t => {
  let revision = "revision-before";
  const a = await adapterFixture(t, { cached: true, stream: true, hooks: { readRevision: async () => revision, projectObservation: row => {
    if (row.readOnlyRecalculated) revision = "revision-after"; return row;
  } } });
  await assert.rejects(a.service.loadSources(request), { code: "MONTHLY_SOURCE_UNAVAILABLE" }); assert.equal(a.publications(), 0);
});
test("source phase diagnostics record bounded memory boundaries without task metadata and preserve result JSON", async t => {
  const a = await adapterFixture(t, { stream: true }), phases = getAnalyticalPhaseDiagnostics();
  const result = await phases.run("industry-stream-fixture", () => a.service.loadSources(request));
  assert.ok(result.observations.length > 0);
  const record = phases.status().records.findLast(row => row.kind === "industry-stream-fixture");
  for (const phase of ["source_history", "source_recalculation", "source_saved_recovery"]) {
    const row = record.phases.find(p => p.phase === phase); assert.equal(row.status, "completed"); assert.deepEqual(row.metadata, {});
  }
});
test("invalid streaming opt-ins fail during factory creation", () => {
  const base = { dataDir: "unused-fixture", regionMasterFile: "unused-region", listRuns: async () => [] };
  for (const streamIndustryObservations of [null, "true", true]) assert.throws(() => createMonthlyReportSources({ ...base, streamIndustryObservations }), TypeError);
});
