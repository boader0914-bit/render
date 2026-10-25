"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
const { cooperativeWorkCheckpoint } = require("./lib/cooperative_work_checkpoint.cjs");
const NOW = new Date("2026-10-24T00:00:00Z");
const REQUEST = { industry: "glamping", region: "all", month: "2026-09", cutoffDate: "2026-09-30" };
const gate = () => { let release; return { promise: new Promise(resolve => { release = resolve; }), release: () => release() }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function bounded(promise, label) { let timeout; try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(label)), 10000); })]); } finally { clearTimeout(timeout); } }
const resultOnly = ({ storage, ...result }) => result;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "industry-cooperative-integration-"));
  const companyFile = path.join(directory, "company_master", "companies.json"), historyFile = path.join(directory, "history", "observations.jsonl"), regionFile = path.join(directory, "regions.json");
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const runs = ["r1", "r2"].map((id, index) => ({ id, keyword: "포천글램핑", collectedAt: `2026-09-${20 + index}T00:00:00Z`, collectedAtSource: "manifest", searchMode: "keyword", collectionQuality: { status: "complete" }, checkIn: `2026-09-${20 + index}`, bookingRangeDays: 11 }));
  const companies = Object.fromEntries(["a", "b"].map((id, index) => [id, { companyId: id, primaryName: `검수 ${id} 글램핑`, addresses: ["경기도 포천시 모의 주소"], lodgingTypes: ["글램핑"], placeIds: [id], runIds: runs.map(run => run.id), manualCorrection: { active: true, lodgingBasisTotal: 10 + index }, keywords: { "포천글램핑": { keyword: "포천글램핑", runs: runs.map(run => ({ runId: run.id, rank: index + 1, collectedAt: run.collectedAt })) } } }]));
  const history = Object.values(companies).map(company => ({ companyId: company.companyId, companyKey: company.companyId, runId: "r1", productType: "lodging", stayDate: "2026-09-22", collectedAt: runs[0].collectedAt, inventoryEvidenceVersion: 5, supply: 6, sold: 1, publicBookings: 1, phoneBookings: 0, estimatedRevenue: null, missingPrice: true }));
  await fs.writeFile(companyFile, JSON.stringify({ companies })); await fs.writeFile(historyFile, history.map(row => JSON.stringify(row)).join("\n") + "\n");
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ active: true, selectable: true, level: "local", regionKey: "pocheon", fullName: "경기도 포천시" }] }));
  const schedulers = [], services = [], releaseAll = [];
  t.after(async () => { for (const release of releaseAll) release(); for (const service of services) await service.stop(); for (const scheduler of schedulers) await scheduler.close(); const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith("industry-cooperative-integration-")); await fs.rm(target, { recursive: true, force: true }); });
  const revision = async () => crypto.createHash("sha256").update(await fs.readFile(companyFile)).update(await fs.readFile(historyFile)).digest("hex");
  function pipeline(name, { interrupt = false, durable = true, duringPublication = null } = {}) {
    const scheduler = createAnalyticalWorkScheduler({ cooperativeYield: true }), entered = gate(), continueRun = gate(), foregroundRelease = gate(); schedulers.push(scheduler); releaseAll.push(continueRun.release, foregroundRelease.release);
    const loads = [], publications = [], events = [], weakGraphs = []; let armed = interrupt, activeSourceScopes = 0;
    const recalculate = createMonthlyCompanyRecalculation({ cacheDirectory: path.join(directory, name, "run_rows"), cacheVersion: "cooperative-integration-v1", projectCorrectionCompany: compactMonthlyCapacityCompany, useSourceReadValidationBoundary: true, recalculateAllInventory: true,
      loadRun: async (id, options) => {
        loads.push(id); events.push(`load:${id}`); assert.equal(options.skipHistory, true); assert.equal(options.skipCompanyMaster, true); assert.equal(options.skipProductCapacityStore, true);
        if (armed && id === "r2") { armed = false; entered.release(); await continueRun.promise; }
        const run = runs.find(run => run.id === id);
        return { run, availability: { items: ["a", "b"].map((placeId, index) => ({ placeId, weeklyProductDetails: [22, 23].map(day => ({ bizItemId: `room-${placeId}`, name: `숙박 ${placeId}`, saleType: "숙박", date: `2026-09-${day}`, stock: 10 + index, bookingCount: day === 23 ? 0 : index + (id === "r2" ? 2 : 1), occupiedBookingCount: 0, price: day === 23 ? null : 100000, open: true })) })) } };
      }, companyProductAvailabilityMatch: (company, item) => company.placeIds.includes(item.placeId),
      applyCompanyManualCorrection: (item, company) => ({ ...item, supply: company.manualCorrection.lodgingBasisTotal, inventoryEvidence: { version: 5 } }),
      buildHistoryObservations: value => value.availability.items.flatMap(item => item.weeklyProductDetails.map(detail => ({ productType: "lodging", stayDate: detail.date, inventoryEvidenceVersion: 5, supply: item.supply, sold: detail.bookingCount, publicBookings: detail.bookingCount, phoneBookings: 0, estimatedRevenue: detail.price === null ? null : detail.price * detail.bookingCount, publicRevenue: detail.price === null ? null : detail.price * detail.bookingCount, phoneRevenue: 0, missingPrice: detail.price === null }))) });
    const sources = createMonthlyReportSources({ dataDir: directory, regionMasterFile: regionFile, listRuns: async () => runs, now: () => NOW, readRevision: revision, projectCapacityCompany: compactMonthlyCapacityCompany, useSourceReadValidationBoundary: true, shareFrozenCatalogMetadata: true,
      capacityForCompany: company => company.manualCorrection.lodgingBasisTotal,
      recalculateCompanyObservations: async (request, data, options) => { weakGraphs.push(new WeakRef(data)); return recalculate(request, data, options); },
      publishProductCapacityEvidence: async (evidence, publication) => { await publication.assertCurrent(); if (duringPublication) await duringPublication(); publications.push({ evidence: structuredClone(evidence), revision: publication.sourceRevision }); events.push("published"); },
      readContext: async () => ({ sources: [], networkAttempted: false }),
      runWork: (operation, options) => scheduler.run(operation, options) });
    const trackedSources = { ...sources, loadSourcesWithCatalog: async (...args) => { activeSourceScopes++; events.push("source-enter"); try { return await sources.loadSourcesWithCatalog(...args); } finally { activeSourceScopes--; events.push("source-exit"); } } };
    const service = createIndustryAnalysisService({ sources: trackedSources, now: () => NOW, dataDir: durable ? directory : null, autoStart: false, readSourceRevision: revision, runWork: (operation, options) => scheduler.run(operation, options) }); services.push(service);
    return { service, scheduler, sources, recalculate, entered, continueRun, foregroundRelease, loads, publications, events, weakGraphs, activeScopes: () => activeSourceScopes };
  }
  const resultPath = async () => { const dir = path.join(directory, "industry_analysis", "results"); return path.join(dir, (await fs.readdir(dir)).find(name => /^[a-f0-9]{64}\.json$/.test(name))); };
  return { directory, companyFile, historyFile, companies, runs, history, pipeline, resultPath };
}

for (const mutation of [null, "correction", "history"]) test(`industry reconstruction yields all source ownership before a foreground read${mutation ? ` and rejects old ${mutation} revisions` : " without publishing partial work"}`, { timeout: 20000 }, async t => {
  const f = await fixture(t), seed = f.pipeline("seed"); await seed.service.analyze(REQUEST); await bounded(seed.service.drain(), "seed industry result did not finish");
  const previous = await seed.service.readSaved(REQUEST); assert.equal(previous.storage.status, "ready", JSON.stringify(previous.storage)); assert.ok(previous.summary.coveredCompanyDays > 0); assert.equal(seed.publications.length, 1); await seed.service.stop();
  const resultFile = await f.resultPath(), before = await fs.readFile(resultFile), pipeline = f.pipeline("interrupted", { interrupt: true });
  await pipeline.service.rebuild(REQUEST); let settled = false;
  const industry = pipeline.service.drain().then(value => { settled = true; return value; }); await bounded(pipeline.entered.promise, "industry did not reach the second saved run");
  const foregroundEntered = gate();
  const foreground = pipeline.scheduler.run(async () => {
    pipeline.events.push("foreground-enter");
    assert.equal(pipeline.activeScopes(), 0, "the rejected source graph's finally must run before foreground starts"); assert.equal(pipeline.sources.sourceReadStatus().active, false, "the serial source slot must be released before foreground starts");
    assert.equal(pipeline.sources.sourceReadMetrics().companyCatalog.retainedFullCompanies, 0); assert.equal(settled, false, "the original industry promise must stay pending through its transparent retry"); assert.equal(pipeline.publications.length, 0, "a yielded attempt must never publish product capacities"); assert.deepEqual(await fs.readFile(resultFile), before, "the last normal industry file must remain byte-identical during the yield");
    if (typeof global.gc === "function") { global.gc(); await turn(); global.gc(); assert.ok(pipeline.weakGraphs.every(ref => ref.deref() === undefined), "no rejected source graph may remain reachable when foreground owns the heap"); }
    if (mutation === "correction") { f.companies.a.manualCorrection.lodgingBasisTotal = 8; await fs.writeFile(f.companyFile, JSON.stringify({ companies: f.companies })); }
    if (mutation === "history") { await fs.appendFile(f.historyFile, JSON.stringify({ ...f.history[1], stayDate: "2026-09-29", supply: 11, sold: 0, publicBookings: 0 }) + "\n"); }
    if (mutation) { await pipeline.service.notifySourceChanged({ reason: "fixture_source_edit" }); const stale = await pipeline.service.readSaved(REQUEST); assert.equal(stale.storage.hasSnapshot, true); assert.equal(stale.storage.sourceTokenMatches, false); assert.equal(stale.storage.sourceRevisionMatches, false, "the prior normal result cannot remain certified after a source/correction edit"); assert.deepEqual(await fs.readFile(resultFile), before); }
    foregroundEntered.release(); await pipeline.foregroundRelease.promise;
    return "foreground-result";
  }, { priority: "foreground", kind: "company-month", detached: true });
  // Exercise production defaults (250 ms / one new checkpoint), rather than
  // weakening the cooperative progress fence solely for this integration test.
  assert.equal(pipeline.scheduler.status().cooperative.minRunMs, 250); await new Promise(resolve => setTimeout(resolve, 270)); pipeline.continueRun.release();
  await bounded(foregroundEntered.promise, "foreground was not admitted after cooperative cleanup"); assert.equal(settled, false); assert.equal(pipeline.scheduler.status().queuedBackground, 1); assert.equal(pipeline.publications.length, 0);
  pipeline.foregroundRelease.release(); assert.equal(await bounded(foreground, "foreground did not finish"), "foreground-result"); await bounded(industry, "industry did not finish after resuming");
  const final = await pipeline.service.readSaved(REQUEST); assert.equal(final.storage.status, "ready", JSON.stringify(final.storage)); assert.equal(final.storage.sourceRevisionMatches, true); assert.equal(pipeline.activeScopes(), 0); assert.equal(pipeline.sources.sourceReadStatus().active, false);
  const timing = pipeline.scheduler.status().timing; assert.equal(timing.yielded, 1); assert.equal(timing.failed, 0); assert.ok(timing.restarted >= 1); assert.ok(pipeline.publications.length >= 1);
  assert.equal(pipeline.publications.length, pipeline.events.filter(event => event === "source-exit").length - 1, "each complete source publishes once; the one rejected attempt publishes nothing");
  assert.ok(pipeline.publications.every(row => row.evidence.length > 0 && new Set(row.evidence.map(item => item.runId)).size === 2), "only evidence from a fully reconstructed run set may publish");
  const reviewed = final.review.companies.find(company => company.companyId === "a"); assert.equal(reviewed.dates.find(row => row.date === "2026-09-23").observedZero, true); assert.equal(reviewed.dates.find(row => row.date === "2026-09-23").reservationCount, 0); assert.equal(reviewed.dates.find(row => row.date === "2026-09-24").reservationCount, null, "an observation gap cannot become a real zero after retry");
  if (!mutation) { assert.equal(pipeline.publications.length, 1); assert.deepEqual(pipeline.loads, ["r1", "r2", "r2"], "the completed first-run compact unit is reused but the incomplete second unit is rebuilt"); assert.ok(pipeline.recalculate.stats().industryRunRowCacheHits >= 1); assert.deepEqual(resultOnly(final), resultOnly(previous)); }
  else { assert.ok(pipeline.loads.filter(id => id === "r1").length >= 2, "a revision change must rebuild the compact unit completed before the yield"); const expected = f.pipeline("uninterrupted-current", { durable: false }); assert.deepEqual(resultOnly(final), await bounded(expected.service.analyze(REQUEST), "uninterrupted current-revision comparison did not finish")); if (mutation === "correction") assert.equal(final.companies.find(company => company.companyId === "a").capacity, 8); }
  assert.ok(pipeline.events.indexOf("source-exit") < pipeline.events.indexOf("foreground-enter")); assert.ok(pipeline.events.indexOf("published") > pipeline.events.indexOf("foreground-enter"));
});

test("a foreground request arriving inside product-capacity publication cannot split or repeat that verified publication", { timeout: 10000 }, async t => {
  const f = await fixture(t); let foreground, foregroundStarted = false;
  const p = f.pipeline("publication-fence", { duringPublication: async () => {
    foreground = p.scheduler.run(() => { foregroundStarted = true; assert.equal(p.activeScopes(), 0); assert.equal(p.sources.sourceReadStatus().active, false); return "foreground-after-publication"; }, { priority: "foreground", kind: "company-month", detached: true });
    // Simulate a publisher which itself awaits storage/checkpoints after its
    // caller has validated a complete source. Its irreversible unit is fenced.
    await new Promise(resolve => setTimeout(resolve, 270)); cooperativeWorkCheckpoint(); await turn(); assert.equal(foregroundStarted, false);
  } });
  await p.service.analyze(REQUEST); await bounded(p.service.drain(), "publication did not finish"); assert.equal(await bounded(foreground, "foreground did not follow publication"), "foreground-after-publication");
  const saved = await p.service.readSaved(REQUEST); assert.equal(saved.storage.status, "ready"); assert.equal(p.publications.length, 1); assert.ok(p.publications[0].evidence.length > 0); assert.equal(p.scheduler.status().timing.yielded, 0); assert.deepEqual(p.loads, ["r1", "r2"]);
});
