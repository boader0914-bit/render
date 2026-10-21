"use strict";

// Small synthetic, local fixtures. These are scheduling/preservation checks,
// not a production timing or large-memory benchmark. No provider is contacted.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { performance } = require("node:perf_hooks"), { AsyncLocalStorage } = require("node:async_hooks");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createMonthlyReportSources } = require("./lib/monthly_report_sources.cjs");
const { createMonthlyReportService } = require("./lib/monthly_reports.cjs");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");
const { createCompanyIntegratedCatalog } = require("./lib/company_integrated_catalog.cjs");
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function flush() { for (let index = 0; index < 4; index++) await turn(); }
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const NOW = () => new Date("2026-10-21T00:00:00.000Z");
const IDS = ["synthetic-company-a", "synthetic-company-b"];

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "background-memory-integration-"));
  const companyFile = path.join(directory, "company_master", "companies.json"), historyFile = path.join(directory, "history", "observations.jsonl");
  const regionFile = path.join(directory, "regions.json"), events = [], pauses = [], owners = new AsyncLocalStorage();
  const control = { ratio: 0.1, active: 0, peak: 0, sourceReads: 0, catalogReads: 0, pauseSource: null, onOwnerEnd: null };
  const scheduler = createAnalyticalWorkScheduler({ foregroundBurst: 2, sampleIntervalMs: 5, maxSampleAgeMs: 100,
    sampleMemory: async () => ({ ratio: control.ratio }) });
  const runWork = (operation, options = {}) => scheduler.run(async info => {
    const inherited = owners.getStore();
    if (inherited?.live) return operation(info);
    const owner = { live: true, kind: options.kind || "analysis" };
    control.active++; control.peak = Math.max(control.peak, control.active); events.push(`start:${owner.kind}`);
    try { return await owners.run(owner, () => operation(info)); }
    finally { owner.live = false; control.active--; events.push(`end:${owner.kind}`); control.onOwnerEnd?.(owner.kind); }
  }, options);
  const runs = ["2026-08", "2026-09", "2026-10"].map(month => ({ id: `synthetic-${month}`, keyword: "모의글램핑", collectedAt: `${month}-01T03:00:00Z`,
    collectedAtSource: "manifest", searchMode: "keyword", checkIn: `${month}-01`, bookingRangeDays: 21, collectionQuality: { status: "complete" } }));
  const companies = Object.fromEntries(IDS.map((companyId, index) => [companyId, { companyId, primaryName: `모의 글램핑 ${index}`,
    addresses: ["모의도 모의시 모의로 1"], placeIds: [String(100 + index)], runIds: runs.map(run => run.id),
    keywords: { synthetic: { keyword: "모의글램핑", runs: runs.map(run => ({ runId: run.id, collectedAt: run.collectedAt, rank: index + 1 })) } } }]));
  await fs.mkdir(path.dirname(companyFile), { recursive: true }); await fs.mkdir(path.dirname(historyFile), { recursive: true });
  const masterText = JSON.stringify({ companies }); await fs.writeFile(companyFile, masterText);
  await fs.writeFile(regionFile, JSON.stringify({ units: [{ regionKey: "synthetic-region", name: "모의시", fullName: "모의도 모의시", active: true, selectable: true, level: "local" }] }));
  const rows = sold => runs.flatMap(run => IDS.map(companyId => ({ companyId, companyKey: companyId, runId: run.id, keyword: run.keyword,
    collectedAt: run.collectedAt, stayDate: run.collectedAt.slice(0, 7) + "-03", productType: "lodging", inventoryEvidenceVersion: 4,
    supply: 16, sold, publicBookings: sold, phoneBookings: 0, publicRevenue: sold * 100000, phoneRevenue: 0, estimatedRevenue: sold * 100000,
    partial: false, missing: false, unknownUnavailable: 0, phoneMissingPriceBookings: 0, sharedDayUseExcluded: 0, capacityBasis: { count: 16, source: "manual_review" } })));
  const writeRows = sold => fs.writeFile(historyFile, rows(sold).map(JSON.stringify).join("\n") + "\n"); await writeRows(2);
  const originalHistory = await fs.readFile(historyFile, "utf8");
  const sources = createMonthlyReportSources({ dataDir: directory, regionMasterFile: regionFile, listRuns: async () => runs,
    capacityForCompany: () => 16, prepareCompanies: async value => { control.catalogReads++; return value; }, now: NOW, runWork });
  const compact = createCompanyIntegratedCatalog({ dataDir: directory, catalog: sources.catalog, readRevision: async () => "synthetic-stable-metadata", now: NOW });
  await compact.prepare();
  const loadSources = async (request, options) => {
    control.sourceReads++; events.push(`source:${request.targetId}:${request.month}`);
    const value = await sources.loadSources(request, options);
    const pause = control.pauseSource?.(request);
    if (pause) { pause.entered.resolve(); await pause.release.promise; }
    return value;
  };
  const db = createCompanyIntegratedDb({ dataDir: directory, catalog: compact.catalog, loadSources, now: NOW, runWork,
    listTargets: async ({ companyIds } = {}) => IDS.filter(id => !companyIds || companyIds.includes(id)).map(companyId => ({ companyId, months: ["2026-09", "2026-10"] })) });
  const reports = createMonthlyReportService({ dataDir: path.join(directory, "reports"), loadSources, now: NOW, runWork });
  const pause = () => { const result = { entered: gate(), release: gate() }; pauses.push(result); return result; };
  t.after(async () => {
    for (const pending of pauses) pending.release.resolve();
    await scheduler.close(); await db.stop();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("background-memory-integration-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const monthFile = (id, month) => path.join(directory, "company_integrated", digest(id), `${month}.json`);
  const sourceUnchanged = async () => { assert.equal(await fs.readFile(companyFile, "utf8"), masterText); assert.equal(await fs.readFile(historyFile, "utf8"), originalHistory); };
  const seed = async () => { await db.queueCompany(IDS[0], { months: ["2026-09", "2026-10"] }); await db.drain(); };
  events.length = 0; control.active = 0; control.peak = 0; control.catalogReads = 0;
  return { directory, companyFile, historyFile, masterText, originalHistory, events, control, scheduler, runWork, sources, compact, db, reports, pause, monthFile, writeRows, sourceUnchanged, seed };
}

test("real company month materialization and a report share the entire lease and yield between months", { timeout: 10000 }, async t => {
  const f = await fixture(t), paused = f.pause(); let once = true;
  f.control.pauseSource = request => { if (once && request.targetId === IDS[0] && request.month === "2026-09") { once = false; return paused; } return null; };
  await f.db.queueCompany(IDS[0], { months: ["2026-09", "2026-10"] }); await paused.entered.promise;
  const preview = f.reports.preview({ type: "company", targetId: IDS[1], month: "2026-09", cutoffDate: "2026-09-30" });
  const catalog = f.sources.catalog(); await flush();
  assert.equal(f.control.active, 1); assert.equal(f.scheduler.status().activeKind, "company-month");
  assert.ok(f.scheduler.status().queuedForeground >= 1); paused.release.resolve();
  const [report] = await Promise.all([preview, catalog, f.db.drain()]);
  assert.equal(f.control.peak, 1, "source reads and both-month calculations own one common lifetime");
  const monthStarts = f.events.map((value, index) => value === "start:company-month" ? index : -1).filter(index => index !== -1);
  const reportStart = f.events.indexOf("start:monthly-report-build");
  assert.equal(monthStarts.length, 2); assert.ok(reportStart > monthStarts[0] && reportStart < monthStarts[1], f.events.join("\n"));
  const card = await f.db.get(IDS[0], { month: "2026-09" });
  assert.equal(card.selectedMonth, "2026-09"); assert.equal(card.snapshot.summary.lodging.sold, 2);
  assert.equal(report.summary.lodging.sold, 2); await f.sourceUnchanged();
});

test("memory-paused materialization does not block a saved company card or change its selected month and values", { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.seed(); const before = await f.db.get(IDS[0], { month: "2026-09" });
  const stored = await fs.readFile(f.monthFile(IDS[0], "2026-09"), "utf8"), reads = f.control.sourceReads;
  f.control.ratio = 0.9; await f.scheduler.checkpointPressure();
  await f.db.queueCompany(IDS[0], { months: ["2026-09"] }); await flush();
  const started = performance.now(), card = await f.db.get(IDS[0], { month: "2026-09" }), elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `small saved-card integration took ${elapsed}ms`);
  assert.equal(card.selectedMonth, before.selectedMonth); assert.deepEqual(card.snapshot.summary, before.snapshot.summary);
  assert.equal(card.calculatedAt, before.calculatedAt); assert.equal(f.control.sourceReads, reads);
  assert.equal(f.scheduler.status().memory.paused, true); assert.equal(f.scheduler.status().active, false);
  assert.equal(await fs.readFile(f.monthFile(IDS[0], "2026-09"), "utf8"), stored);
  f.control.ratio = 0.1; await f.scheduler.checkpointPressure(); await f.scheduler.checkpointPressure();
  await new Promise(resolve => setTimeout(resolve, 15)); await f.db.drain();
  assert.equal((await f.db.status()).counts.idle, 1); await f.sourceUnchanged();
});

test("generation supersession and a real malformed source keep the previous normal month intact", { timeout: 10000 }, async t => {
  const f = await fixture(t); await f.seed(); const filename = f.monthFile(IDS[0], "2026-09"), prior = await fs.readFile(filename, "utf8");
  const older = f.pause(), newer = f.pause(); let count = 0;
  f.control.pauseSource = request => request.targetId === IDS[0] && request.month === "2026-09" ? (++count === 1 ? older : count === 2 ? newer : null) : null;
  await f.writeRows(3); await f.db.queueCompany(IDS[0], { months: ["2026-09"] }); await older.entered.promise;
  await f.writeRows(5); await f.db.queueCompany(IDS[0], { months: ["2026-09"] }); older.release.resolve(); await newer.entered.promise;
  assert.equal(await fs.readFile(filename, "utf8"), prior, "the older generation cannot replace the saved card");
  newer.release.resolve(); await f.db.drain(); f.control.pauseSource = null;
  const refreshed = await f.db.get(IDS[0], { month: "2026-09" }); assert.equal(refreshed.snapshot.summary.lodging.sold, 5);
  const good = await fs.readFile(filename, "utf8");
  await fs.writeFile(f.companyFile, "{broken source"); await f.db.queueCompany(IDS[0], { months: ["2026-09"] }); await f.db.drain();
  assert.equal((await f.db.status()).counts.failed, 1); assert.equal(await fs.readFile(filename, "utf8"), good, "source parse errors must preserve the last normal result");
  await fs.writeFile(f.companyFile, f.masterText); await fs.writeFile(f.historyFile, f.originalHistory); await f.sourceUnchanged();
});

test("deferProcessing fire-and-forget dispatch cannot start a company lease inside source ingestion", { timeout: 10000 }, async t => {
  const f = await fixture(t), paused = f.pause(); let readsAtRelease;
  const ingestion = f.runWork(() => f.db.deferProcessing(async () => {
    await f.db.queueCompany(IDS[0], { months: ["2026-09", "2026-10"] });
    await f.db.queueCompany(IDS[1], { months: ["2026-09"] });
    readsAtRelease = f.control.sourceReads; paused.entered.resolve(); await paused.release.promise;
  }), { priority: "foreground", kind: "source-ingestion" });
  await paused.entered.promise; await flush(); assert.equal(f.control.sourceReads, readsAtRelease);
  const waitingRead = f.runWork(() => 17, { priority: "foreground", kind: "saved-view" });
  paused.release.resolve(); await ingestion; assert.equal(await waitingRead, 17); await f.db.drain();
  const finish = f.events.indexOf("end:source-ingestion"), company = f.events.indexOf("start:company-job-prepare");
  assert.ok(finish !== -1 && company > finish, f.events.join("\n")); assert.equal(f.control.peak, 1);
  assert.equal((await f.db.status()).counts.idle, 2); await f.sourceUnchanged();
});

test("a catalog queued before an outer materialization cannot deadlock its nested catalog read", { timeout: 10000 }, async t => {
  const f = await fixture(t), paused = f.pause();
  const blocker = f.runWork(async () => { paused.entered.resolve(); await paused.release.promise; }, { kind: "initial-ingestion" }); await paused.entered.promise;
  const queuedCatalog = f.sources.catalog({ priority: "background" });
  const outer = f.runWork(async () => {
    const catalog = await f.sources.catalog();
    const source = await f.sources.loadSources({ type: "company", targetId: IDS[0], month: "2026-09", cutoffDate: "2026-09-30" });
    assert.equal(catalog.companies.length, 2); return source.observations;
  }, { kind: "company-materialize" });
  await flush(); paused.release.resolve(); const [, , rows] = await Promise.all([blocker, queuedCatalog, outer]);
  assert.ok(rows.some(row => row.companyId === IDS[0])); assert.equal(f.control.peak, 1);
  const outerStart = f.events.indexOf("start:company-materialize"), catalogStart = f.events.indexOf("start:source-catalog");
  assert.ok(outerStart < catalogStart, "foreground materialization passes a queued background catalog while safely reentering its own reader");
  await f.sourceUnchanged();
});
