"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const ID = "cmp_place_123", NOW = new Date("2026-10-25T00:00:00Z");
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10000); })]); } finally { clearTimeout(timer); } }

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-month-cooperative-")), companyFile = path.join(root, "company_master", "companies.json"), historyFile = path.join(root, "history", "observations.jsonl"), regionFile = path.join(root, "regions.json");
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const company = { companyId: ID, primaryName: "시험 글램핑", lodgingTypes: ["글램핑"], addresses: ["경기도 포천시 시험 주소"], placeIds: ["123"], runIds: ["aug", "sep"], manualCorrection: { lodgingBasisTotal: 16 } };
  const runs = ["08", "09"].map((month, index) => ({ id: index ? "sep" : "aug", keyword: "포천글램핑", collectedAt: `2026-${month}-20T00:00:00Z`, collectedAtSource: "manifest", collectionQuality: { status: "complete" }, checkIn: `2026-${month}-22`, bookingRangeDays: 1 }));
  await fs.writeFile(companyFile, JSON.stringify({ companies: { [ID]: company } }));
  for (const run of runs) { const folder = path.join(root, "outputs", run.id); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, "manifest.json"), JSON.stringify(run)); }
  await fs.writeFile(historyFile, runs.map(run => JSON.stringify({ companyId: ID, companyKey: ID, runId: run.id, keyword: run.keyword, collectedAt: run.collectedAt, stayDate: run.checkIn, productType: "lodging", inventoryEvidenceVersion: 5, supply: 16, sold: 1, publicBookings: 1, phoneBookings: 0, publicRevenue: 100000, phoneRevenue: 0, estimatedRevenue: 100000 })).join("\n") + "\n");
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", fullName: "경기도 포천시" }] }));
  const revision = async () => { const hash = crypto.createHash("sha256").update(await fs.readFile(companyFile)).update(await fs.readFile(historyFile)); for (const run of runs) hash.update(await fs.readFile(path.join(root, "outputs", run.id, "manifest.json"))); return hash.digest("hex"); };
  const store = createProductCapacityStore({ dataDir: root }), services = [], schedulers = [], gates = [];
  const newGate = () => { const value = gate(); gates.push(value); return value; };
  t.after(async () => { for (const value of gates) value.resolve(); for (const service of services) await service.stop(); for (const scheduler of schedulers) await scheduler.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("company-month-cooperative-")); await fs.rm(root, { recursive: true, force: true }); });
  function pipeline(name, { candidates = false, companyYield = false, dataDir = root } = {}) {
    const scheduler = createAnalyticalWorkScheduler({ cooperativeCompanyMonthYield: companyYield, cooperativeMinRunMs: 0 }); schedulers.push(scheduler);
    const hooks = {}, counters = { sourceOwners: 0, publications: 0, history: {}, recalculations: {} }, weak = [];
    const recalculate = createMonthlyCompanyRecalculation({ recalculateAllInventory: true, useSourceReadValidationBoundary: true, projectCorrectionCompany: compactMonthlyCapacityCompany, cacheDirectory: path.join(root, name, "run_rows"), cacheVersion: "company-replay-v1",
      readPersistedProductCapacityEvidence: (companies, options) => store.readForCompanies(companies, options),
      loadRun: async id => { const run = runs.find(value => value.id === id); return { run, availability: { items: [{ placeId: "123", weeklyProductDetails: [{ bizItemId: "room", date: run.checkIn, saleType: "숙박", name: "숙박", stock: 16, bookingCount: 2, occupiedBookingCount: 0, open: true, price: 100000 }] }] } }; },
      companyProductAvailabilityMatch: (current, item) => current.placeIds.includes(item.placeId), applyCompanyManualCorrection: (item, current) => ({ ...item, total: current.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 5 } }),
      buildHistoryObservations: value => value.availability.items.flatMap(item => item.weeklyProductDetails.map(row => ({ stayDate: row.date, productType: "lodging", inventoryEvidenceVersion: 5, supply: item.total, sold: row.bookingCount, publicBookings: row.bookingCount, phoneBookings: 0, estimatedRevenue: row.price * row.bookingCount, publicRevenue: row.price * row.bookingCount, phoneRevenue: 0 }))) });
    const sources = createMonthlyReportSources({ dataDir: root, regionMasterFile: regionFile, listRuns: async () => runs, readRevision: revision, projectCapacityCompany: compactMonthlyCapacityCompany, useSourceReadValidationBoundary: true, shareFrozenCatalogMetadata: true,
      companySourceCandidateCacheEnabled: candidates, industrySourceCandidateCacheVersion: "company-integration-source-v1", capacityForCompany: current => current.manualCorrection.lodgingBasisTotal,
      readPersistedProductCapacityEvidence: (companies, options) => store.readForCompanies(companies, options),
      observationIndex: { ensure: async () => ({ generation: await revision(), malformedHistoryLines: 0 }), listMonths: async () => ["2026-08", "2026-09"],
        readHeaders: async (request, consume) => { for (const line of (await fs.readFile(historyFile, "utf8")).trim().split("\n")) { const row = JSON.parse(line); if (row.stayDate.startsWith(request.month)) consume({ companyId: row.companyId, companyKey: row.companyKey, month: request.month }); } },
        readRows: async (request, consume) => { counters.history[request.month] = (counters.history[request.month] || 0) + 1; for (const line of (await fs.readFile(historyFile, "utf8")).trim().split("\n")) consume(JSON.parse(line)); } },
      recalculateCompanyObservations: async (request, data, options) => { weak.push(new WeakRef(data)); counters.recalculations[request.month] = (counters.recalculations[request.month] || 0) + 1; return recalculate(request, data, options); },
      publishProductCapacityEvidence: async (evidence, context) => { if (hooks.publication) await hooks.publication(); await context.checkpoint(); await store.publish(evidence, context); counters.publications++; },
      readContext: async () => ({ sources: [], networkAttempted: false }), now: () => NOW, runWork: (operation, options) => scheduler.run(operation, options) });
    const service = createCompanyIntegratedDb({ dataDir, autoStart: false, now: () => NOW, readRevision: revision,
      catalog: sources.catalog, listTargets: async () => [{ companyId: ID, months: ["2026-09"] }],
      loadSources: async (...args) => { counters.sourceOwners++; try { return await sources.loadSources(...args); } finally { counters.sourceOwners--; } },
      runWork: (operation, options) => scheduler.run(operation, options) }); services.push(service);
    return { service, scheduler, sources, counters, hooks, weak };
  }
  const monthFile = path.join(root, "company_integrated", crypto.createHash("sha256").update(ID).digest("hex"), "2026-09.json");
  async function seed() { const cold = pipeline("seed"); await cold.service.queueCompany(ID, { months: ["2026-09"] }); const state = await cold.service.drain(); assert.equal(state.jobs[0].status, "idle", JSON.stringify(state)); const before = await fs.readFile(monthFile); await cold.service.stop(); await fs.appendFile(historyFile, JSON.stringify({ companyId: ID, companyKey: ID, runId: "sep", keyword: "포천글램핑", collectedAt: runs[1].collectedAt, stayDate: "2026-09-29", productType: "lodging", inventoryEvidenceVersion: 5, supply: 16, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }) + "\n"); return before; }
  return { root, company, companyFile, historyFile, revision, monthFile, seed, pipeline, newGate, store };
}

test("a real company-month job yields current and previous sources, preserves its last normal month, and completes after repeated foreground reads", { timeout: 20000 }, async t => {
  const f = await fixture(t), previous = await f.seed(), p = f.pipeline("yielding", { candidates: true, companyYield: true });
  const boundaries = [1, 1, 2].map(stage => ({ stage, entered: f.newGate(), resume: f.newGate() })); let next = 0, settled = false;
  p.hooks.publication = async () => { const boundary = boundaries[next]; if (boundary && p.scheduler.status().cooperative.activeStageIndex === boundary.stage) { next++; boundary.entered.resolve(); await boundary.resume.promise; } };
  await p.service.queueCompany(ID, { months: ["2026-09"] }); const running = p.service.drain().then(value => { settled = true; return value; }); const waits = [];
  for (const boundary of boundaries) {
    await bounded(boundary.entered.promise, "company source did not reach publication boundary"); const queued = performance.now();
    const foreground = p.scheduler.run(async () => {
      waits.push(performance.now() - queued); assert.equal(p.counters.sourceOwners, 0); assert.equal(p.sources.sourceReadStatus().active, false); assert.equal(settled, false);
      assert.deepEqual(await fs.readFile(f.monthFile), previous, "an interrupted calculation cannot overwrite the last normal company month");
      const visible = await p.service.get(ID, { month: "2026-09" }); assert.equal(visible.status, "refreshing"); assert.ok(visible.snapshot); assert.notEqual(visible.freshness.revisionCheckStatus, "verified");
      const state = await p.service.status(); assert.equal(state.jobs[0].status, "processing"); assert.equal(state.jobs[0].errorCode, null);
      if (typeof global.gc === "function") { global.gc(); await turn(); global.gc(); assert.ok(p.weak.every(ref => ref.deref() === undefined), "source catalog heaps release before foreground starts"); }
    }, { priority: "foreground", kind: "company-month-proof-read", detached: true });
    boundary.resume.resolve(); await bounded(foreground, "foreground waited for the repeated company prefix");
  }
  await bounded(running, "foreground requests starved the company month"); const final = await p.service.get(ID, { month: "2026-09" });
  assert.equal(final.status, "ready"); assert.equal(final.snapshot.daily.find(row => row.date === "2026-09-29").lodging.sold, 0);
  assert.notDeepEqual(await fs.readFile(f.monthFile), previous); assert.ok(waits.every(value => value < 2000));
  assert.deepEqual(p.counters.history, { "2026-09": 1, "2026-08": 1 }); assert.deepEqual(p.counters.recalculations, { "2026-09": 1, "2026-08": 1 });
  assert.ok(p.sources.sourceReadMetrics().companySourceCandidates.acceptedHits >= 2); assert.equal(p.scheduler.status().timing.failed, 0); assert.ok(p.scheduler.status().timing.yielded >= 3);
  const cold = f.pipeline("comparison", { dataDir: path.join(f.root, "cold-current") }); await cold.service.queueCompany(ID, { months: ["2026-09"] }); await cold.service.drain();
  assert.deepEqual(final.snapshot, (await cold.service.get(ID, { month: "2026-09" })).snapshot);
  t.diagnostic(JSON.stringify({ foregroundWaitMs: waits.map(value => Math.round(value)), sourcePrefixReads: p.counters.history, acceptedCandidateHits: p.sources.sourceReadMetrics().companySourceCandidates.acceptedHits, yields: p.scheduler.status().timing.yielded }));
});

for (const mutation of ["review", "history"]) test(`a ${mutation} edit during a yielded company job cannot publish a mixed old-month ready proof`, { timeout: 20000 }, async t => {
  const f = await fixture(t), previous = await f.seed(), p = f.pipeline("changed", { candidates: true, companyYield: true }), entered = f.newGate(), resume = f.newGate(); let held = false;
  p.hooks.publication = async () => { if (!held) { held = true; entered.resolve(); await resume.promise; } };
  await p.service.queueCompany(ID, { months: ["2026-09"] }); const running = p.service.drain(); await bounded(entered.promise, "company did not reach original boundary");
  const foreground = p.scheduler.run(async () => {
    if (mutation === "review") { f.company.manualCorrection.lodgingBasisTotal = 8; await fs.writeFile(f.companyFile, JSON.stringify({ companies: { [ID]: f.company } })); }
    else await fs.appendFile(f.historyFile, JSON.stringify({ companyId: ID, companyKey: ID, runId: "sep", keyword: "포천글램핑", collectedAt: "2026-09-20T00:00:00Z", stayDate: "2026-09-30", productType: "lodging", inventoryEvidenceVersion: 5, supply: 16, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }) + "\n");
    assert.deepEqual(await fs.readFile(f.monthFile), previous); const visible = await p.service.get(ID, { month: "2026-09" });
    assert.notEqual(visible.status, "ready"); assert.notEqual(visible.freshness.revisionCheckStatus, "verified");
  }, { kind: "company-review-change", detached: true });
  resume.resolve(); await foreground; await bounded(running, "changed company source did not settle");
  let final = await p.service.get(ID, { month: "2026-09" });
  if (final.status !== "ready") { assert.deepEqual(await fs.readFile(f.monthFile), previous); await p.service.queueCompany(ID, { months: ["2026-09"], reason: "fresh-review-generation" }); await bounded(p.service.drain(), "fresh generation did not settle"); final = await p.service.get(ID, { month: "2026-09" }); }
  assert.equal(final.status, "ready"); assert.equal(final.roomBasis.capacity, mutation === "review" ? 8 : 16); assert.equal(final.snapshot.companies[0].capacity, mutation === "review" ? 8 : 16);
  if (mutation === "history") assert.equal(final.snapshot.daily.find(row => row.date === "2026-09-30").lodging.sold, 0);
  assert.ok(p.scheduler.status().timing.progressRevisionResets >= 1); assert.equal((await p.service.status()).jobs[0].status, "idle");
});
