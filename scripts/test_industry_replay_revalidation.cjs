"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { createProductCapacityStore } = require("./lib/product_capacity_store.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const NOW = new Date("2026-10-24T00:00:00Z"), REQUEST = { industry: "glamping", region: "all", month: "2026-09", cutoffDate: "2026-09-30" };
const gate = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: () => resolve() }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
const resultOnly = ({ storage, ...result }) => result;
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10000); })]); } finally { clearTimeout(timer); } }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "industry-replay-revalidation-")), companyFile = path.join(directory, "company_master", "companies.json"), historyFile = path.join(directory, "history", "observations.jsonl"), regionFile = path.join(directory, "region.json");
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const runs = ["r1", "r2"].map((id, index) => ({ id, keyword: "포천글램핑", collectedAt: `2026-09-${20 + index}T00:00:00Z`, collectedAtSource: "manifest", searchMode: "keyword", collectionQuality: { status: "complete" }, checkIn: "2026-09-20", bookingRangeDays: 11 }));
  for (const run of runs) { const folder = path.join(directory, "outputs", run.id); await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, "manifest.json"), JSON.stringify(run)); }
  const companies = ["a", "b", "c", "d"].map((id, index) => ({ companyId: id, primaryName: `${id} 검수 글램핑`, lodgingTypes: ["글램핑"], addresses: ["경기도 포천시 모의 주소"], placeIds: [id], runIds: runs.map(row => row.id), manualCorrection: { lodgingBasisTotal: 10 + index }, keywords: { "포천글램핑": { keyword: "포천글램핑", runs: runs.map(run => ({ runId: run.id, rank: index + 1, collectedAt: run.collectedAt })) } } }));
  await fs.writeFile(companyFile, JSON.stringify({ companies: Object.fromEntries(companies.map(company => [company.companyId, company])) }));
  await fs.writeFile(historyFile, companies.map(company => JSON.stringify({ companyId: company.companyId, companyKey: company.companyId, runId: "r1", productType: "lodging", stayDate: "2026-09-22", collectedAt: runs[0].collectedAt, inventoryEvidenceVersion: 5, supply: 6, sold: 1, publicBookings: 1, phoneBookings: 0, estimatedRevenue: null, missingPrice: true })).join("\n") + "\n");
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", fullName: "경기도 포천시" }] }));
  const originalRevision = async () => { const digest = crypto.createHash("sha256").update(await fs.readFile(companyFile)).update(await fs.readFile(historyFile)); for (const run of runs) digest.update(await fs.readFile(path.join(directory, "outputs", run.id, "manifest.json"))); return digest.digest("hex"); };
  const store = createProductCapacityStore({ dataDir: directory }), services = [], schedulers = [], gates = [];
  t.after(async () => { for (const item of gates) item.resolve(); for (const service of services) await service.stop(); for (const scheduler of schedulers) await scheduler.close(); const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("industry-replay-revalidation-")); await fs.rm(target, { recursive: true, force: true }); });
  function newGate() { const item = gate(); gates.push(item); return item; }
  const witnessFiles = () => fs.readdir(store.directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  function pipeline(name, { candidates, publishReal = true, durable = true } = {}) {
    const scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true }), hooks = {}; schedulers.push(scheduler);
    const counters = { historyReads: 0, recalculations: 0, recoveryReads: 0, witnessReads: 0, publicationAttempts: 0, publicationSuccesses: 0, sourceScopes: 0 }, loaded = [], weakGraphs = [];
    const readPersisted = async (values, options) => { counters.witnessReads++; if (hooks.witness) await hooks.witness(counters.witnessReads); return store.readForCompanies(values, options); };
    const recalculate = createMonthlyCompanyRecalculation({ recalculateAllInventory: true, useSourceReadValidationBoundary: true, projectCorrectionCompany: compactMonthlyCapacityCompany, cacheDirectory: path.join(directory, name, "run_rows"), cacheVersion: "replay-test-v1", readPersistedProductCapacityEvidence: readPersisted,
      loadRun: async (id, options) => { loaded.push(id); assert.equal(options.skipCompanyMaster, true); assert.equal(options.skipHistory, true); return { run: runs.find(row => row.id === id), availability: { items: companies.map((company, index) => ({ placeId: company.companyId, weeklyProductDetails: [22, 23].map(day => ({ bizItemId: `room-${company.companyId}`, saleType: "숙박", name: "숙박", date: `2026-09-${day}`, stock: 10 + index, bookingCount: day === 23 ? 0 : 1 + index, occupiedBookingCount: 0, open: true, price: day === 23 ? null : 100000 })) })) } }; },
      companyProductAvailabilityMatch: (company, item) => company.placeIds.includes(item.placeId), applyCompanyManualCorrection: (item, company) => ({ ...item, total: company.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 5 } }),
      buildHistoryObservations: value => value.availability.items.flatMap(item => item.weeklyProductDetails.map(row => ({ stayDate: row.date, productType: "lodging", inventoryEvidenceVersion: 5, supply: item.total, sold: row.bookingCount, publicBookings: row.bookingCount, phoneBookings: 0, estimatedRevenue: row.price === null ? null : row.price * row.bookingCount, publicRevenue: row.price === null ? null : row.price * row.bookingCount, phoneRevenue: 0, missingPrice: row.price === null }))) });
    const sources = createMonthlyReportSources({ dataDir: directory, regionMasterFile: regionFile, listRuns: async () => runs, readRevision: originalRevision, projectCapacityCompany: compactMonthlyCapacityCompany, useSourceReadValidationBoundary: true, shareFrozenCatalogMetadata: true, capacityForCompany: company => company.manualCorrection.lodgingBasisTotal,
      industrySourceCandidateCacheEnabled: candidates, industrySourceCandidateCacheVersion: "replay-test-candidate-v1", readPersistedProductCapacityEvidence: readPersisted,
      runProductCapacityVerification: async operation => { const sourceRevision = await originalRevision(); return store.withDescriptorVerificationScope({ sourceRevision, assertCurrent: async () => { if (await originalRevision() !== sourceRevision) throw Object.assign(Error("changed"), { code: "MONTHLY_COMPANY_SOURCE_CHANGED" }); } }, operation); },
      observationIndex: { ensure: async () => ({ generation: await originalRevision(), malformedHistoryLines: 0 }), listMonths: async () => ["2026-09"], readRows: async (request, consume) => { counters.historyReads++; for (const line of (await fs.readFile(historyFile, "utf8")).trim().split("\n")) consume(JSON.parse(line)); } },
      recalculateCompanyObservations: async (request, data, options) => { counters.recalculations++; weakGraphs.push(new WeakRef(data)); return recalculate(request, data, options); },
      readSavedProductRecoveries: async (request, data, { checkpoint, productCapacityEvidence }) => { counters.recoveryReads++; for (let part = 0; part < 4; part++) { await delay(25); await checkpoint(); } return { observations: [], warnings: [], productCapacityEvidence }; },
      publishProductCapacityEvidence: async (evidence, context) => { counters.publicationAttempts++; if (publishReal) await store.publish(evidence, { ...context, checkpoint: async () => { if (hooks.publication) await hooks.publication(); return context.checkpoint(); } }); counters.publicationSuccesses++; },
      readContext: async () => ({ sources: [], networkAttempted: false }), now: () => NOW, runWork: (operation, options) => scheduler.run(operation, options) });
    const tracked = { ...sources, loadSourcesWithCatalog: async (...args) => { counters.sourceScopes++; try { return await sources.loadSourcesWithCatalog(...args); } finally { counters.sourceScopes--; } } };
    const service = createIndustryAnalysisService({ sources: tracked, now: () => NOW, dataDir: durable ? directory : null, autoStart: false, readSourceRevision: originalRevision, runWork: (operation, options) => scheduler.run(operation, options) }); services.push(service);
    return { service, scheduler, sources, counters, loaded, hooks, weakGraphs };
  }
  return { directory, companyFile, historyFile, companies, runs, store, pipeline, newGate, witnessFiles };
}

test("repeated foreground arrivals during phase-70 replay reuse a complete source candidate and still finish normal industry output", { timeout: 20000 }, async t => {
  const f = await fixture(t), cold = f.pipeline("cold", { candidates: false, publishReal: false }); await cold.service.analyze(REQUEST); await bounded(cold.service.drain(), "cold comparison did not finish"); const expected = await cold.service.readSaved(REQUEST); assert.equal(expected.storage.status, "ready"); await cold.service.stop();
  const resultDirectory = path.join(f.directory, "industry_analysis", "results"), resultFile = path.join(resultDirectory, (await fs.readdir(resultDirectory)).find(name => name.endsWith(".json"))), originalNormal = await fs.readFile(resultFile);
  const p = f.pipeline("adversarial", { candidates: true }), firstBoundary = f.newGate(), firstResume = f.newGate(), replay = Array.from({ length: 4 }, () => ({ entered: f.newGate(), resume: f.newGate() }));
  let pausedFirst = false, industrySettled = false;
  p.hooks.publication = async () => { if (!pausedFirst && (await f.witnessFiles()).length === 1) { pausedFirst = true; firstBoundary.resolve(); await firstResume.promise; } };
  p.hooks.witness = async count => { if (count > 1 && replay[count - 2]) { const stage = replay[count - 2]; stage.entered.resolve(); await stage.resume.promise; } };
  await p.service.rebuild(REQUEST); const industry = p.service.drain().then(value => { industrySettled = true; return value; });
  const waits = [], committed = [];
  function enqueueForeground() {
    const entered = f.newGate(), resume = f.newGate(), queuedAt = performance.now(); let failure;
    const work = p.scheduler.run(async () => {
      waits.push(performance.now() - queuedAt); assert.equal(p.counters.sourceScopes, 0); assert.equal(p.sources.sourceReadStatus().active, false); assert.equal(f.store.stats().activeVerificationScopes, 0); assert.equal(f.store.stats().retainedVerificationDescriptors, 0);
      const count = (await f.witnessFiles()).length; committed.push(count); assert.ok(count >= 1 && count <= 4); const current = JSON.parse(await fs.readFile(resultFile)); assert.deepEqual(current.result, resultOnly(expected), "no partially rebuilt source may replace the normal report");
      if (p.counters.publicationSuccesses === 0) { assert.equal(industrySettled, false); assert.deepEqual(await fs.readFile(resultFile), originalNormal); const saved = await p.service.readSaved(REQUEST); assert.equal(saved.storage.hasSnapshot, true); assert.notEqual(saved.storage.status, "ready"); }
      if (typeof global.gc === "function") { global.gc(); await turn(); global.gc(); assert.ok(p.weakGraphs.every(ref => ref.deref() === undefined)); }
      entered.resolve(); await resume.promise;
    }, { priority: "foreground", kind: "company-month", detached: true });
    work.catch(error => { failure = error; entered.resolve(); });
    return { work, entered, resume, error: () => failure };
  }
  await bounded(firstBoundary.promise, "first publication did not reach a file boundary"); const first = enqueueForeground(); await delay(270); firstResume.resolve(); await bounded(first.entered.promise, "first foreground did not enter"); if (first.error()) throw first.error(); first.resume.resolve(); await first.work;
  for (const stage of replay) {
    const entered = await bounded(Promise.race([stage.entered.promise.then(() => true), industry.then(() => false)]), "source replay stalled"); if (!entered) break;
    const fg = enqueueForeground(); await delay(270); stage.resume.resolve(); await bounded(fg.entered.promise, "foreground waited through the old source prefix"); if (fg.error()) throw fg.error(); fg.resume.resolve(); await fg.work;
    if (p.counters.publicationSuccesses > 0) break;
  }
  await bounded(industry, "continuous foreground requests starved the industry job"); const final = await p.service.readSaved(REQUEST); assert.equal(final.storage.status, "ready", JSON.stringify(final.storage)); assert.deepEqual(resultOnly(final), resultOnly(expected)); assert.ok(waits.length >= 3); assert.ok(waits.every(ms => ms < 2000), JSON.stringify(waits)); assert.ok(committed.every((count, i) => i === 0 || count > committed[i - 1]), "each foreground interval must follow durable forward progress instead of prefix-only replay");
  assert.equal(p.counters.historyReads, 1); assert.equal(p.counters.recalculations, 1); assert.equal(p.counters.recoveryReads, 1); assert.deepEqual(p.loaded, ["r1", "r2"]); assert.equal(p.counters.publicationSuccesses, 1); assert.ok(p.sources.sourceReadMetrics().industrySourceCandidates.hits >= 2); assert.equal(p.scheduler.status().timing.failed, 0); assert.equal((await f.store.readForCompanies(f.companies)).warnings.length, 0);
  t.diagnostic(JSON.stringify({ foregroundWaitMs: waits.map(ms => Math.round(ms)), committedCompaniesAtForeground: committed, sourcePrefixReads: p.counters.historyReads, candidateHits: p.sources.sourceReadMetrics().industrySourceCandidates.hits, publicationAttempts: p.counters.publicationAttempts }));
});

for (const mutation of ["correction", "history"]) test(`a completed source candidate cannot conceal a new ${mutation} revision or certify the old industry result`, { timeout: 20000 }, async t => {
  const f = await fixture(t), p = f.pipeline("original", { candidates: true }); await p.service.analyze(REQUEST); await bounded(p.service.drain(), "original revision did not finish"); const original = await p.service.readSaved(REQUEST); assert.equal(original.storage.status, "ready"); assert.equal(p.counters.historyReads, 1);
  const resultDirectory = path.join(f.directory, "industry_analysis", "results"), resultFile = path.join(resultDirectory, (await fs.readdir(resultDirectory)).find(name => name.endsWith(".json"))), priorNormal = await fs.readFile(resultFile), before = { ...p.counters }, candidateHits = p.sources.sourceReadMetrics().industrySourceCandidates.hits;
  if (mutation === "correction") { f.companies[0].manualCorrection.lodgingBasisTotal = 8; await fs.writeFile(f.companyFile, JSON.stringify({ companies: Object.fromEntries(f.companies.map(company => [company.companyId, company])) })); }
  else await fs.appendFile(f.historyFile, JSON.stringify({ companyId: "d", companyKey: "d", runId: "r1", productType: "lodging", stayDate: "2026-09-29", collectedAt: f.runs[0].collectedAt, inventoryEvidenceVersion: 5, supply: 13, sold: 0, publicBookings: 0, phoneBookings: 0, estimatedRevenue: null, missingPrice: true }) + "\n");
  const stale = await p.service.readSaved(REQUEST); assert.equal(stale.storage.hasSnapshot, true); assert.equal(stale.storage.sourceTokenMatches, false); assert.equal(stale.storage.sourceRevisionMatches, false); assert.deepEqual(await fs.readFile(resultFile), priorNormal);
  const expected = f.pipeline("cold-current-revision", { candidates: false, publishReal: false, durable: false }), cold = await bounded(expected.service.analyze(REQUEST), "cold changed-revision comparison did not finish");
  await p.service.notifySourceChanged({ reason: "fixture_revision_change" }); await p.service.rebuild(REQUEST); await bounded(p.service.drain(), "changed revision did not rebuild");
  const final = await p.service.readSaved(REQUEST); assert.equal(final.storage.status, "ready", JSON.stringify(final.storage)); assert.equal(final.storage.sourceRevisionMatches, true); assert.deepEqual(resultOnly(final), cold); assert.equal(p.counters.historyReads, before.historyReads + 1); assert.equal(p.counters.recalculations, before.recalculations + 1); assert.equal(p.counters.recoveryReads, before.recoveryReads + 1); assert.equal(p.sources.sourceReadMetrics().industrySourceCandidates.hits, candidateHits, "a different original revision must miss the completed source candidate");
  if (mutation === "correction") assert.equal(final.companies.find(company => company.companyId === "a").capacity, 8);
  else assert.equal(final.review.companies.find(company => company.companyId === "d").dates.find(row => row.date === "2026-09-29").observedZero, true);
});
