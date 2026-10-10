"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { createCompanyIntegratedDb } = require("./lib/company_integrated_db.cjs");

const ID = "cmp_place_35644668";
const clone = value => JSON.parse(JSON.stringify(value));
const run = (id, keyword, status = "complete") => ({ id, keyword, collectedAt: "2026-09-01T03:00:00Z", collectionQuality: { status } });
const observation = (overrides = {}) => ({ companyId: ID, companyKey: ID, runId: "gyeongnam", keyword: "경남글램핑",
  collectedAt: "2026-09-01T03:00:00Z", stayDate: "2026-09-03", productType: "lodging", inventoryEvidenceVersion: 4,
  supply: 16, sold: 2, publicBookings: 2, phoneBookings: 0, publicRevenue: 200000, phoneRevenue: 0, estimatedRevenue: 200000,
  partial: false, missing: false, unknownUnavailable: 0, phoneMissingPriceBookings: 0,
  sharedDayUseExcluded: 0, capacityBasis: { count: 16, source: "manual_review" }, ...overrides });

async function testReadPriority(root) {
  const dataDir = path.join(root, "read-priority"), queueFile = path.join(dataDir, "company_integrated", "queue.json");
  const companies = ["a", "b", "c", "d", "e", "f"].map(companyId => ({ companyId, primaryName: companyId, capacity: 16 }));
  let markEntered, release, pause = true;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const order = [];
  const options = { dataDir, autoStart: false, now: () => new Date("2026-10-10T00:00:00Z"),
    catalog: async () => ({ companies, runs: [] }),
    listTargets: async ({ companyIds } = {}) => companies.filter(company => !companyIds || companyIds.includes(company.companyId)).map(company => ({ companyId: company.companyId, months: ["2026-09"] })),
    loadSources: async request => {
      if (request.month === "2026-09") {
        order.push(request.targetId);
        if (pause) { pause = false; markEntered(); await wait; }
      }
      return { companies, observations: [], runs: [] };
    } };
  let service = createCompanyIntegratedDb(options);
  try {
    await service.bootstrap();
    const running = service.drain(); await entered;
    const processingBefore = (await service.status()).jobs.find(job => job.companyId === "a");
    await service.get("a", { month: "2026-09" });
    assert.deepEqual((await service.status()).jobs.find(job => job.companyId === "a"), processingBefore, "a read cannot restart or invalidate the company currently processing");
    const queuedGeneration = (await service.status()).jobs.find(job => job.companyId === "e").generation;
    await service.get("e", { month: "2026-09" });
    const priorityQueue = await fs.readFile(queueFile, "utf8");
    await service.get("e", { month: "2026-09" });
    assert.equal(await fs.readFile(queueFile, "utf8"), priorityQueue, "polling an already prioritized company does not rewrite the queue");
    assert.equal((await service.status()).jobs.find(job => job.companyId === "e").generation, queuedGeneration, "priority changes no source generation");
    await service.get("d", { month: "2026-09" });
    release(); await running;
    assert.deepEqual(order, ["a", "e", "b", "d", "c", "f"], "first request goes next, then priority and FIFO alternate without starving bootstrap");
    assert.equal((await service.status()).counts.idle, 6);

    order.length = 0;
    await service.queueCompany("a", { months: ["2026-09"] });
    await service.queueCompany("b", { months: ["2026-09"] });
    const beforeFreshRead = await fs.readFile(queueFile, "utf8");
    await service.get("b", { month: "2026-09" });
    assert.equal(await fs.readFile(queueFile, "utf8"), beforeFreshRead, "a current cached month does not acquire read priority");
    await service.drain();
    assert.deepEqual(order, ["a", "b"]);

    // Queue work in a new order, request an uncached month already included in
    // that job, then restart. Both fair FIFO order and one-shot priority persist.
    order.length = 0;
    await service.queueCompany("c", { months: ["2026-09", "2026-10"] });
    await service.queueCompany("a", { months: ["2026-09", "2026-10"] });
    await service.queueCompany("f", { months: ["2026-09", "2026-10"] });
    await service.get("f", { month: "2026-10" });
    await service.stop();
    service = createCompanyIntegratedDb(options);
    await service.drain();
    assert.deepEqual(order, ["f", "f", "c", "c", "a", "a"], "read priority and oldest waiting order survive restart; each company's September source also supplies October comparison");
  } finally { release(); await service.stop(); }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "company-integrated-db-"));
  const companyDirectory = path.join(root, "company_integrated", crypto.createHash("sha256").update(ID).digest("hex"));
  const monthFile = month => path.join(companyDirectory, `${month}.json`);
  let now = new Date("2026-10-10T00:00:00Z"), failRead = false, pauseRead = null, reads = 0;
  const company = { companyId: ID, primaryName: "월명글램핑", capacity: 16, capacitySource: "DB 검수값 16실", keywords: ["경남글램핑", "산청글램핑"] };
  const raw = { companyId: ID, manualCorrection: { roomCount: 16, revision: 1 }, keywords: {
    a: { keyword: "경남글램핑", runs: [{ runId: "gyeongnam", rank: 4, collectedAt: "2026-09-01T03:00:00Z" }] },
    b: { keyword: "산청글램핑", runs: [{ runId: "sancheong", rank: 2, collectedAt: "2026-09-02T03:00:00Z" }] }
  } };
  let sources = { companies: [company, { companyId: "another-company", primaryName: "월명글램핑", capacity: 100 }],
    runs: [run("gyeongnam", "경남글램핑"), run("sancheong", "산청글램핑"), run("blocked", "경남글램핑", "blocked"), run("legacy", "경남글램핑", "unknown")],
    observations: [observation(), observation({ runId: "sancheong", keyword: "산청글램핑", collectedAt: "2026-09-02T03:00:00Z", sold: 3, publicBookings: 3, publicRevenue: 300000, estimatedRevenue: 300000 }),
      observation({ runId: "blocked", collectedAt: "2026-09-03T03:00:00Z", sold: 0, publicBookings: 0, publicRevenue: 0, estimatedRevenue: 0 }),
      observation({ stayDate: "2026-09-04", sold: 0, publicBookings: 0, publicRevenue: 0, estimatedRevenue: 0 }),
      observation({ stayDate: "2026-09-05", missing: true, sold: 0, publicBookings: 0, publicRevenue: 0, estimatedRevenue: 0 }),
      observation({ stayDate: "2026-09-06", runId: "legacy" }),
      observation({ stayDate: "2026-07-02", collectedAt: "2026-07-01T03:00:00Z" }),
      observation({ stayDate: "2026-11-02", collectedAt: "2026-10-01T03:00:00Z" }),
      observation({ companyId: "another-company", companyKey: "another-company", sold: 16, publicBookings: 16, publicRevenue: 1600000, estimatedRevenue: 1600000 })],
    rankObservations: [{ companyId: ID, runId: "gyeongnam", keyword: "경남글램핑", collectedAt: "2026-09-01T03:00:00Z", rank: 4 },
      { companyId: ID, runId: "sancheong", keyword: "산청글램핑", collectedAt: "2026-09-02T03:00:00Z", rank: 2 }],
    context: { sources: [], networkAttempted: false }, sourceDiagnostics: {} };
  const catalog = async () => ({ companies: [clone(company)], rawCompanies: new Map([[ID, clone(raw)]]), runs: clone(sources.runs) });
  const listTargets = async ({ companyIds, runId } = {}) => {
    if (companyIds && !companyIds.includes(ID)) return [];
    const rows = sources.observations.filter(row => row.companyId === ID && (!runId || row.runId === runId));
    return [{ companyId: ID, months: [...new Set(rows.map(row => row.stayDate.slice(0, 7)))] }];
  };
  const loadSources = async request => {
    reads++;
    if (failRead) throw Object.assign(new Error("never expose this internal detail"), { code: "MONTHLY_SOURCE_UNAVAILABLE" });
    const value = clone({ ...sources, companies: [company, ...sources.companies.filter(item => item.companyId !== ID)] });
    if (pauseRead && request.month === "2026-09") { const pause = pauseRead; pauseRead = null; pause.entered(); await pause.wait; }
    return value;
  };
  const make = options => createCompanyIntegratedDb({ dataDir: root, catalog, loadSources, listTargets, now: () => now, autoStart: false, ...options });
  let service = make();
  try {
    await service.bootstrap();
    await service.drain();
    let view = await service.get(ID, { month: "2026-09" });
    assert.equal(view.status, "ready");
    assert.equal(view.snapshot.summary.lodging.sold, 3, "cross-keyword observations pick latest valid once; a blocked zero never replaces it");
    assert.equal(view.snapshot.daily[2].lodging.sold, 3);
    assert.equal(view.snapshot.daily[3].lodging.sold, 0, "normal zero remains zero");
    assert.equal(view.snapshot.daily[4].lodging.sold, null, "missing zero remains missing");
    assert.equal(view.snapshot.daily[5].lodging.sold, null, "unknown legacy run never auto-promotes");
    assert.equal(view.roomBasis.capacity, 16);
    assert.equal(view.roomBasis.source, "DB 검수값 16실");
    assert.equal(view.snapshot.companies.length, 1, "same display name does not combine company IDs");
    assert.equal(view.latestAttempts.find(row => row.date === "2026-09-03").runId, "blocked");
    assert.equal(view.latestAttempts.find(row => row.date === "2026-09-03").lastValidRunId, "sancheong");
    assert.equal(view.failedAttempts.find(row => row.date === "2026-09-03").reason, "run_blocked");
    assert.ok(!view.failedAttempts.some(row => row.date === "2026-09-06"), "unknown historical evidence is excluded, not misreported as a newly observed failure");
    assert.deepEqual(view.keywords.map(row => row.keyword), ["경남글램핑", "산청글램핑"]);
    assert.deepEqual(view.months.map(row => row.month), ["2026-11", "2026-09", "2026-07"], "bootstrap includes earliest and future stay months");
    assert.equal((await service.get(ID)).selectedMonth, "2026-09", "future booking month is not the default when earlier data exists");
    assert.ok(view.snapshot.comparison, "materialized and monthly preview share comparison logic");

    const frozen = await fs.readFile(monthFile("2026-09"), "utf8");
    now = new Date("2026-10-11T00:00:00Z");
    await service.bootstrap(); await service.drain();
    assert.equal(await fs.readFile(monthFile("2026-09"), "utf8"), frozen, "unchanged historical inputs skip recalculation and rewriting across restart/bootstrap");

    raw.manualCorrection.revision++;
    await service.queueCompany(ID, { reason: "correction" }); await service.drain();
    assert.notEqual(await fs.readFile(monthFile("2026-09"), "utf8"), frozen, "even a correction revision without changed quantity invalidates source digest");
    const correctionSnapshot = await fs.readFile(monthFile("2026-09"), "utf8");

    failRead = true;
    await service.queueCompany(ID, { months: ["2026-09"] }); await service.drain();
    view = await service.get(ID, { month: "2026-09" });
    assert.equal(view.status, "failed"); assert.equal(view.errorCode, "MONTHLY_SOURCE_UNAVAILABLE");
    assert.equal(view.snapshot.summary.lodging.sold, 3);
    assert.equal(await fs.readFile(monthFile("2026-09"), "utf8"), correctionSnapshot, "source read error cannot destroy last valid snapshot");
    assert.ok(!JSON.stringify(view).includes("never expose"));
    await service.stop();
    failRead = false;
    service = make(); await service.drain();
    assert.equal((await service.get(ID, { month: "2026-09" })).status, "ready", "persisted failed task is retried once after restart");

    let markEntered, release;
    const entered = new Promise(resolve => { markEntered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    pauseRead = { entered: markEntered, wait };
    sources.observations.push(observation({ runId: "sancheong", collectedAt: "2026-09-02T04:00:00Z", sold: 4, publicBookings: 4, publicRevenue: 400000, estimatedRevenue: 400000 }));
    await service.queueCompany(ID, { months: ["2026-09"] });
    const running = service.drain(); await entered;
    sources.observations.push(observation({ runId: "sancheong", collectedAt: "2026-09-02T05:00:00Z", sold: 5, publicBookings: 5, publicRevenue: 500000, estimatedRevenue: 500000 }));
    await service.queueCompany(ID, { months: ["2026-09"], reason: "newer_generation" });
    release(); await running;
    assert.equal((await service.get(ID, { month: "2026-09" })).snapshot.summary.lodging.sold, 5, "change queued during materialization cannot be lost or overwritten by earlier generation");

    const beforeReadOnly = await fs.readFile(monthFile("2026-09"), "utf8");
    const earlier = await service.get(ID, { month: "2026-09", cutoffDate: "2026-09-01" });
    assert.equal(earlier.snapshot.summary.lodging.sold, 2);
    assert.equal(await fs.readFile(monthFile("2026-09"), "utf8"), beforeReadOnly, "custom cutoff never overwrites current view");
    await assert.rejects(service.get(ID, { month: "../../private" }), error => error.code === "invalid_month");
    await assert.rejects(service.get(ID, { cutoffDate: "2026-12-01" }), error => error.code === "invalid_cutoff");
    await assert.rejects(service.get("deleted-company"), error => error.code === "company_not_found");
    raw.mergedIntoCompanyId = "another-company";
    await assert.rejects(service.get(ID), error => error.code === "company_not_found");
    delete raw.mergedIntoCompanyId;

    const queued = await service.queueRun({ runId: "sancheong" });
    assert.equal(queued.queued, 1); await service.drain();
    await service.queueCompany(ID, { months: ["2026-09"] }); await service.stop();
    const queueFile = path.join(root, "company_integrated", "queue.json");
    const queue = JSON.parse(await fs.readFile(queueFile, "utf8")); queue.jobs[ID].status = "processing";
    await fs.writeFile(queueFile, JSON.stringify(queue));
    service = make(); await service.drain();
    assert.equal((await service.status()).counts.idle, 1, "interrupted processing resumes after restart");

    const missing = await service.get(ID, { month: "2026-08" });
    assert.equal(missing.status, "refreshing"); assert.equal(missing.snapshot, null);
    await service.drain();
    assert.equal((await service.get(ID, { month: "2026-08" })).snapshot.summary.lodging.sold, null, "on-demand absent month gets a missing-data view, never fake zero");

    raw._integratedCapacity = { capacity: 16, source: "observed_locked", label: "최대 관측 16실 고정", revision: 2,
      observedMaximum: 17, warnings: ["새 관측 17실은 기준 16실과 다릅니다. 관리자 확인이 필요합니다."] };
    await service.queueCompany(ID, { months: ["2026-09"] }); await service.drain();
    view = await service.get(ID, { month: "2026-09" });
    assert.equal(view.roomBasis.source, "observed_locked", "synthetic calculation correction is never labeled as an administrator review");
    assert.equal(view.roomBasis.observedMaximum, 17);
    assert.ok(view.snapshot.quality.warnings.some(value => value.includes("새 관측 17실")));
    assert.equal(view.snapshot.companies[0].capacity, 16);
    await service.queueCompany(ID, { months: ["2026-08"] });
    assert.deepEqual((await service.status()).jobs.find(job => job.companyId === ID).months, ["2026-08", "2026-09"], "prior month updates invalidate a cached following month comparison");
    await service.drain();

    await service.stop();
    service = make({ calculationVersion: "company-integrated-v2-test" });
    assert.equal((await service.get(ID, { month: "2026-09" })).status, "refreshing", "a changed algorithm version queues cached data for recalculation");
    await service.drain();
    assert.equal((await service.get(ID, { month: "2026-09" })).calculationVersion, "company-integrated-v2-test");

    const emptyService = make({ dataDir: path.join(root, "empty-company"), listTargets: async () => [],
      loadSources: async () => ({ companies: [company], observations: [], runs: [] }) });
    assert.equal((await emptyService.get(ID, { month: "2026-09" })).status, "refreshing");
    await emptyService.drain();
    assert.equal((await emptyService.get(ID, { month: "2026-09" })).status, "ready", "a registered company without any inventory does not stay pending forever");
    assert.equal((await emptyService.get(ID, { month: "2026-09" })).snapshot.summary.lodging.sold, null);
    await emptyService.stop();

    const closingService = make({ dataDir: path.join(root, "month-closing") });
    now = new Date("2026-09-30T00:00:00Z");
    await closingService.queueCompany(ID, { months: ["2026-09"] }); await closingService.drain();
    assert.equal((await closingService.get(ID, { month: "2026-09" })).snapshot.period.monthClosed, false);
    now = new Date("2026-10-01T00:00:00Z");
    assert.equal((await closingService.get(ID, { month: "2026-09" })).status, "refreshing", "last-day cutoff unchanged still refreshes month-closed status");
    await closingService.drain();
    assert.equal((await closingService.get(ID, { month: "2026-09" })).snapshot.period.monthClosed, true);
    await closingService.stop();

    const beforeRestricted = reads;
    const beforeRestrictedJobs = JSON.stringify((await service.status()).jobs);
    await assert.rejects(service.get(ID, { month: "2099-12", knownMonthsOnly: true }), error => error.code === "MONTH_NOT_OBSERVED" && error.statusCode === 400);
    assert.equal(reads, beforeRestricted, "unknown customer month never reads calculation sources");
    assert.equal(JSON.stringify((await service.status()).jobs), beforeRestrictedJobs, "unknown customer month never queues or changes a job");
    assert.ok((await service.get(ID, { month: "2026-11", knownMonthsOnly: true })).snapshot, "observed future stay month remains available");
    const freshRestricted = make({ dataDir: path.join(root, "restricted-initial") });
    assert.equal((await freshRestricted.get(ID, { month: "2026-07", knownMonthsOnly: true })).status, "refreshing", "uncached full-history month is allowed before bootstrap");
    await freshRestricted.drain(); await freshRestricted.stop();
    const currentRestricted = make({ dataDir: path.join(root, "restricted-current"), listTargets: async () => [],
      loadSources: async () => ({ companies: [company], observations: [], runs: [] }) });
    assert.equal((await currentRestricted.get(ID, { month: "2026-10", knownMonthsOnly: true })).status, "refreshing", "newly registered company can initialize current month without observations");
    await currentRestricted.drain(); await currentRestricted.stop();
    await testReadPriority(root);
    console.log(`company integrated DB tests passed (${reads} source reads)`);
  } finally {
    await service.stop();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("company-integrated-db-")) throw new Error("unexpected test directory");
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
