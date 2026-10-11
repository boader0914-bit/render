"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const NOW = new Date("2026-10-11T00:00:00Z");
const REQUEST = { industry: "glamping", region: "all", month: "2026-09", cutoffDate: "2026-10-11" };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-store-"));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
const result = (request, sold = 1) => ({ request, summary: { sold }, period: { monthClosed: request.month < "2026-10" }, generatedAt: NOW.toISOString() });
function createStore(dataDir, extra = {}) { return createIndustryAnalysisStore({ dataDir, calculate: async request => result(request), now: () => NOW, autoStart: false, ...extra }); }

test("durable result reads do not recalculate, cutoff keys stay separate, restart reuses normal results", async t => {
  const dataDir = await directory(t); let calls = 0;
  const calculate = async request => { calls++; return result(request, request.cutoffDate === "2026-09-01" ? 0 : 4); };
  let store = createStore(dataDir, { calculate });
  const initial = await store.get(REQUEST);
  assert.equal(initial.storage.status, "queued"); assert.equal(initial.storage.hasSnapshot, false); assert.equal(initial.summary, undefined);
  await Promise.all(Array.from({ length: 20 }, () => store.get(REQUEST)));
  await store.drain(); assert.equal(calls, 1);
  const ready = await store.get(REQUEST); assert.equal(ready.storage.status, "ready"); assert.equal(ready.summary.sold, 4);
  const historic = { ...REQUEST, cutoffDate: "2026-09-01" };
  await store.get(historic); await store.drain();
  assert.equal((await store.get(historic)).summary.sold, 0, "genuine zero stays a normal persisted value");
  assert.equal((await store.get(REQUEST)).summary.sold, 4, "past cutoff cannot replace the latest condition");
  await store.stop();
  store = createStore(dataDir, { calculate: async () => { throw Error("ready reads must not touch source"); } });
  await store.bootstrap();
  assert.deepEqual(await store.get(REQUEST), ready);
  assert.equal((await store.status()).counts.queued, undefined);
});

test("refresh failure retains last normal result, GET and restart do not retry, rebuild explicitly retries once", async t => {
  const dataDir = await directory(t); let fail = false, calls = 0;
  const calculate = async request => { calls++; if (fail) throw Object.assign(Error("saved raw unavailable"), { code: "SOURCE_UNAVAILABLE" }); return result(request, 0); };
  let store = createStore(dataDir, { calculate });
  await store.get(REQUEST); await store.drain(); fail = true;
  await store.invalidate({ reason: "review_changed" });
  const stale = await store.get(REQUEST);
  assert.equal(stale.storage.stale, true); assert.equal(stale.summary.sold, 0);
  assert.notEqual(stale.storage.resultRevision, stale.storage.sourceRevision);
  await store.drain();
  const failed = await store.get(REQUEST);
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.storage.errorCode, "SOURCE_UNAVAILABLE");
  assert.equal(failed.summary.sold, 0); assert.ok(failed.storage.failedAt);
  await store.get(REQUEST); await store.stop();
  store = createStore(dataDir, { calculate });
  await store.bootstrap(); await store.drain(); assert.equal(calls, 2, "failed jobs stay failed across restart");
  fail = false;
  await Promise.all(Array.from({ length: 8 }, () => store.rebuild(REQUEST)));
  await store.drain(); assert.equal(calls, 3);
  assert.equal((await store.get(REQUEST)).storage.status, "ready");
});

test("one calculation across different conditions; invalidated in-flight generation is never published", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred();
  let active = 0, maximum = 0, calls = 0;
  const store = createStore(dataDir, { calculate: async request => {
    const call = ++calls; active++; maximum = Math.max(maximum, active);
    try { if (call === 1) { entered.resolve(); await gate.promise; } return result(request, call); } finally { active--; }
  } });
  await store.get(REQUEST);
  const draining = store.drain(); await entered.promise;
  await store.get({ ...REQUEST, month: "2026-10" });
  await store.invalidate({ months: ["2026-09"], reason: "changed_during_calculation" });
  assert.equal((await store.get(REQUEST)).storage.hasSnapshot, false);
  gate.resolve(); await draining;
  assert.equal(maximum, 1); assert.equal(calls, 3);
  assert.notEqual((await store.get(REQUEST)).summary.sold, 1);
  const final = await store.get(REQUEST);
  assert.equal(final.storage.sourceRevision, final.storage.resultRevision);
});

test("processing resumes after interruption; version changes prepare new files without deleting old normal result", async t => {
  const dataDir = await directory(t);
  let store = createStore(dataDir); await store.get(REQUEST); await store.stop();
  const stateFile = path.join(dataDir, "industry_analysis", "queue.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8")); Object.values(state.jobs)[0].status = "processing";
  await fs.writeFile(stateFile, JSON.stringify(state));
  store = createStore(dataDir); await store.bootstrap(); assert.equal((await store.status()).counts.queued, 1);
  await store.drain(); await store.stop();
  const files = await fs.readdir(path.join(dataDir, "industry_analysis", "results"));
  store = createStore(dataDir, { calculationVersion: "industry-v2" });
  assert.equal((await store.get(REQUEST)).storage.hasSnapshot, false); await store.drain();
  const next = await fs.readdir(path.join(dataDir, "industry_analysis", "results"));
  assert.equal(next.length, files.length + 1); assert.ok(next.includes(files[0]));
});

test("source tokens detect offline and throttled runtime changes without hashing heavy source; failed initial result stays absent", async t => {
  const dataDir = await directory(t); let token = "a", checks = 0, date = NOW.getTime();
  const readSourceRevision = async () => { checks++; return token; };
  let store = createStore(dataDir, { now: () => new Date(date), readSourceRevision });
  await store.get(REQUEST); await store.drain();
  await Promise.all(Array.from({ length: 20 }, () => store.get(REQUEST))); assert.equal(checks, 1);
  token = "b"; date += 30001;
  const changed = await Promise.all(Array.from({ length: 12 }, () => store.get(REQUEST)));
  assert.equal(checks, 2); assert.ok(changed.every(row => row.storage.status === "queued" && row.storage.stale));
  await store.drain(); await store.stop(); token = "c";
  store = createStore(dataDir, { now: () => new Date(date), readSourceRevision }); await store.bootstrap();
  assert.equal((await store.get(REQUEST)).storage.status, "queued"); await store.drain();
  await store.stop();
  const missing = createStore(await directory(t), { calculate: async () => { throw Error("missing raw"); } });
  await missing.get(REQUEST); await missing.drain();
  const failed = await missing.get(REQUEST); assert.equal(failed.storage.status, "failed"); assert.equal(failed.summary, undefined);
});

test("fixed past cutoff refreshes month-closed state at the month boundary", async t => {
  const dataDir = await directory(t); let date = new Date("2026-09-30T00:00:00Z");
  const store = createStore(dataDir, { now: () => date, calculate: async request => ({ ...result(request), period: { monthClosed: date.toISOString().startsWith("2026-10") } }) });
  const request = { ...REQUEST, cutoffDate: "2026-09-30" };
  await store.get(request); await store.drain(); assert.equal((await store.get(request)).period.monthClosed, false);
  date = NOW;
  assert.equal((await store.get(request)).storage.status, "queued"); await store.drain();
  assert.equal((await store.get(request)).period.monthClosed, true);
});

test("new-month evidence keeps closed-month saved results unchanged, including across restart", async t => {
  const dataDir = await directory(t), calls = { "2026-09": 0, "2026-10": 0 };
  let checks = 0, revision = { globalToken: "shared-v1", months: { "2026-09": "sep-v1", "2026-10": "oct-v1" } };
  const readSourceRevision = async () => { checks++; return structuredClone(revision); };
  const calculate = async request => result(request, ++calls[request.month]);
  const closed = { ...REQUEST, cutoffDate: "2026-09-30" }, live = { ...REQUEST, month: "2026-10" };
  let store = createStore(dataDir, { calculate, readSourceRevision });
  await store.get(closed); await store.get(live); await store.drain();
  const saved = await store.get(closed);
  assert.equal(saved.storage.monthClosed, true); assert.equal(saved.storage.reusePolicy, "closed_month");
  assert.equal((await store.get(live)).storage.reusePolicy, "live_month");
  revision.months["2026-10"] = "oct-v2";
  await store.notifySourceChanged({ reason: "run_saved" });
  await store.notifySourceChanged({ reason: "observations_saved" });
  assert.equal(checks, 1, "source writers record a durable dirty mark without a full input scan");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "industry_analysis", "queue.json"), "utf8"));
  assert.equal(state.sourceCheckPending, true);
  await store.drain();
  assert.deepEqual(calls, { "2026-09": 1, "2026-10": 2 });
  assert.deepEqual(await store.get(closed), saved, "new-month collection neither requeues nor relabels the closed result");
  await store.stop(); revision.months["2026-10"] = "oct-v3";
  store = createStore(dataDir, { calculate, readSourceRevision });
  await store.bootstrap();
  assert.deepEqual(await store.get(closed), saved, "offline changes to another month cannot rebuild a closed month");
  await store.drain(); assert.deepEqual(calls, { "2026-09": 1, "2026-10": 3 });
  revision.months["2026-09"] = "sep-recovered";
  await store.notifySourceChanged({ reason: "run_recovered" }); await store.drain();
  assert.equal((await store.get(closed)).summary.sold, 2, "recovered evidence for the closed month still refreshes it");
  revision.globalToken = "shared-review-v2";
  await store.notifySourceChanged({ reason: "company_saved" }); await store.drain();
  assert.deepEqual(calls, { "2026-09": 3, "2026-10": 4 });
  const revisionDirectories = await fs.readdir(path.join(dataDir, "industry_analysis", "revisions"));
  assert.equal(revisionDirectories.length, 1, "only corrected closed-month results retain previous versions");
  const versions = await fs.readdir(path.join(dataDir, "industry_analysis", "revisions", revisionDirectories[0]));
  assert.equal(versions.length, 2);
  const firstVersion = JSON.parse(await fs.readFile(path.join(dataDir, "industry_analysis", "revisions", revisionDirectories[0], versions[0]), "utf8"));
  assert.ok([1, 2].includes(firstVersion.result.summary.sold));
  await store.stop();
});

test("a source event during calculation cannot publish the affected month's old generation", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred();
  let token = "before", calls = 0;
  const store = createStore(dataDir, { readSourceRevision: async () => ({ globalToken: "global", months: { "2026-09": token } }),
    calculate: async request => { const call = ++calls; if (call === 1) { entered.resolve(); await gate.promise; } return result(request, call); } });
  await store.get(REQUEST); const draining = store.drain(); await entered.promise;
  token = "after"; await store.notifySourceChanged({ reason: "observations_saved" }); gate.resolve(); await draining;
  assert.equal(calls, 2); assert.equal((await store.get(REQUEST)).summary.sold, 2);
  await store.stop();
});

test("rolling-cutoff legacy files stay preserved and obsolete jobs cannot recreate duplicate closed-month work", async t => {
  const dataDir = await directory(t); let calls = 0;
  const calculate = async request => { calls++; return result(request); };
  let store = createStore(dataDir, { calculate, readSourceRevision: async () => "legacy-token" });
  await store.get(REQUEST); await store.drain(); await store.stop();
  const resultDir = path.join(dataDir, "industry_analysis", "results");
  const [originalFile] = await fs.readdir(resultDir), original = await fs.readFile(path.join(resultDir, originalFile));
  store = createStore(dataDir, { calculate, normalizeStoredRequest: request => ({ ...request, cutoffDate: "2026-09-30" }),
    readSourceRevision: async () => ({ globalToken: "scoped-version", months: { "2026-09": "stable" } }) });
  await store.bootstrap(); await store.drain();
  assert.equal(calls, 1, "retired rolling-cutoff jobs are not scheduled during migration");
  const request = { ...REQUEST, cutoffDate: "2026-09-30" };
  await store.get(request); await store.drain();
  assert.equal(calls, 2); assert.equal((await store.get(request)).storage.status, "ready");
  assert.deepEqual(await fs.readFile(path.join(resultDir, originalFile)), original);
  assert.equal((await fs.readdir(resultDir)).length, 2, "migration leaves original snapshots on disk");
  await store.notifySourceChanged(); await store.drain(); assert.equal(calls, 2);
  await store.stop();
});

test("closed-month revision backup failures keep the original result and retry resumes safely", async t => {
  const dataDir = await directory(t); let value = 4, failArchive = false;
  const writeJson = async (file, data) => {
    if (failArchive && file.includes(`${path.sep}revisions${path.sep}`)) throw Object.assign(Error("disk unavailable"), { code: "EACCES" });
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(data));
  };
  const store = createStore(dataDir, { writeJson, calculate: async request => result(request, value) });
  await store.get(REQUEST); await store.drain();
  const resultsDir = path.join(dataDir, "industry_analysis", "results"), [filename] = await fs.readdir(resultsDir);
  const original = await fs.readFile(path.join(resultsDir, filename));
  value = 5; failArchive = true; await store.invalidate({ months: ["2026-09"], reason: "capacity_review" }); await store.drain();
  const failed = await store.get(REQUEST);
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.storage.errorCode, "EACCES"); assert.equal(failed.summary.sold, 4);
  assert.deepEqual(await fs.readFile(path.join(resultsDir, filename)), original);
  failArchive = false; await store.rebuild(REQUEST); await store.drain();
  assert.equal((await store.get(REQUEST)).summary.sold, 5); await store.stop();
});

test("source verification failure after calculation cannot overwrite a last normal closed-month result", async t => {
  const dataDir = await directory(t); let date = NOW.getTime(), calls = 0, failCheck = false;
  const store = createStore(dataDir, { now: () => new Date(date),
    readSourceRevision: async () => { if (failCheck) throw Object.assign(Error("saved inputs unavailable"), { code: "INDUSTRY_INPUT_UNAVAILABLE" }); return "source"; },
    calculate: async request => { if (++calls === 2) { failCheck = true; date += 30001; } return result(request, calls); } });
  await store.get(REQUEST); await store.drain();
  const resultDir = path.join(dataDir, "industry_analysis", "results"), [filename] = await fs.readdir(resultDir);
  const saved = await fs.readFile(path.join(resultDir, filename));
  await store.invalidate({ months: ["2026-09"] }); await store.drain();
  const failed = await store.get(REQUEST);
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.summary.sold, 1);
  assert.equal(failed.storage.errorCode, "INDUSTRY_INPUT_UNAVAILABLE");
  assert.deepEqual(await fs.readFile(path.join(resultDir, filename)), saved);
  await store.stop();
});

test("a concurrent input write keeps the normal result and automatically recovers without a manual rebuild", async t => {
  const dataDir = await directory(t); let source = "before", race = false, calls = 0;
  const store = createStore(dataDir, { autoStart: true,
    readSourceRevision: async () => { if (race) throw Object.assign(Error("source still saving"), { code: "INDUSTRY_SOURCE_CHANGED" });
      return { globalToken: "shared", months: { "2026-09": source } }; },
    calculate: async request => result(request, ++calls) });
  await store.get(REQUEST); await store.drain();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  race = true; source = "after"; await store.notifySourceChanged();
  const checking = await store.get(REQUEST);
  assert.equal(checking.storage.status, "queued"); assert.equal(checking.storage.sourceCheckPending, true);
  assert.equal(checking.storage.errorCode, null); assert.equal(checking.summary.sold, 1);
  await store.drain(); assert.equal(calls, 1, "unverified input never overwrites the normal file or starts a busy loop");
  race = false; t.mock.timers.tick(1500); await store.drain();
  const ready = await store.get(REQUEST);
  assert.equal(ready.storage.status, "ready"); assert.equal(ready.summary.sold, 2);
  assert.equal(ready.storage.sourceCheckPending, false); await store.stop();
});

test("queue and result write failures retain normal files and explicit retry recovers when disk writes resume", async t => {
  const dataDir = await directory(t); let failQueue = false, failResult = false, sold = 1;
  const writeJson = async (file, value) => {
    if ((failQueue && path.basename(file) === "queue.json") || (failResult && path.basename(path.dirname(file)) === "results")) throw Object.assign(Error("mock disk full"), { code: "ENOSPC" });
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value));
  };
  const store = createStore(dataDir, { writeJson, calculate: async request => result(request, sold) });
  await store.get(REQUEST); await store.drain();
  failQueue = true; sold = 2;
  const failed = await store.rebuild(REQUEST);
  assert.equal(failed.storage.status, "failed"); assert.equal(failed.storage.errorCode, "ENOSPC"); assert.equal(failed.summary.sold, 1);
  assert.equal((await store.get(REQUEST)).summary.sold, 1);
  failQueue = false; await store.rebuild(REQUEST); await store.drain(); assert.equal((await store.get(REQUEST)).summary.sold, 2);
  failResult = true; sold = 3; await store.rebuild(REQUEST); await store.drain();
  assert.equal((await store.get(REQUEST)).storage.status, "failed"); assert.equal((await store.get(REQUEST)).summary.sold, 2);
  failResult = false; await store.rebuild(REQUEST); await store.drain(); assert.equal((await store.get(REQUEST)).summary.sold, 3);
});

test("corrupt result or queue metadata never masquerades as normal and can be explicitly rebuilt", async t => {
  const dataDir = await directory(t); let store = createStore(dataDir);
  await store.get(REQUEST); await store.drain();
  const resultDirectory = path.join(dataDir, "industry_analysis", "results");
  const resultFile = path.join(resultDirectory, (await fs.readdir(resultDirectory))[0]);
  await fs.writeFile(resultFile, "{broken");
  let response = await store.get(REQUEST); assert.equal(response.storage.status, "failed"); assert.equal(response.summary, undefined);
  assert.equal((await store.rebuild(REQUEST)).storage.status, "queued"); await store.drain();
  assert.equal((await store.get(REQUEST)).storage.status, "ready");
  const malformed = JSON.parse(await fs.readFile(resultFile, "utf8")); malformed.result.request.month = "2026-10";
  await fs.writeFile(resultFile, JSON.stringify(malformed));
  assert.equal((await store.get(REQUEST)).storage.errorCode, "INDUSTRY_RESULT_INVALID");
  await store.rebuild(REQUEST); await store.drain();
  const otherRequest = { ...REQUEST, cutoffDate: "2026-09-01" };
  await store.get(otherRequest); await store.drain(); await store.stop();
  await fs.writeFile(path.join(dataDir, "industry_analysis", "queue.json"), "{broken");
  store = createStore(dataDir);
  response = await store.get(REQUEST);
  assert.equal(response.storage.status, "failed"); assert.equal(response.storage.hasSnapshot, true); assert.equal(response.summary.sold, 1);
  const previousRevision = response.storage.resultRevision;
  await store.rebuild(REQUEST); await store.drain();
  response = await store.get(REQUEST); assert.equal(response.storage.status, "ready");
  assert.notEqual(response.storage.resultRevision, previousRevision, "recovered queue has a new revision namespace");
  const other = await store.get(otherRequest);
  assert.equal(other.storage.status, "queued"); assert.equal(other.storage.stale, true);
  assert.notEqual(other.storage.resultRevision, other.storage.sourceRevision, "rebuilding one condition never marks another old result current after queue recovery");
});

test("event invalidation durably marks work without repeated source-token scans", async t => {
  const dataDir = await directory(t); let scans = 0, calculations = 0;
  const store = createStore(dataDir, { readSourceRevision: async () => { scans++; return "same"; }, calculate: async request => { calculations++; return result(request); } });
  await store.get(REQUEST); await store.drain();
  await Promise.all(["company_saved", "observations_saved", "run_saved"].map(reason => store.invalidate({ reason })));
  assert.equal(scans, 1); assert.equal(calculations, 1);
  await store.drain(); assert.equal(calculations, 2);
});

test("consecutive source events wait for quiet time and coalesce before automatic calculation", async t => {
  const dataDir = await directory(t); let calls = 0;
  const store = createStore(dataDir, { autoStart: true, calculate: async request => { calls++; return result(request); } });
  await store.get(REQUEST); await store.drain(); assert.equal(calls, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await store.invalidate({ reason: "master_saved" }); t.mock.timers.tick(1000);
  await store.get(REQUEST); assert.equal(calls, 1);
  await store.invalidate({ reason: "history_saved" }); t.mock.timers.tick(1000);
  await store.get(REQUEST); assert.equal(calls, 1, "new source writes restart the quiet period");
  t.mock.timers.tick(500); await store.drain(); assert.equal(calls, 2);
  await store.stop();
});

const REGIONS = [{ id: "pocheon", label: "경기도 포천시", level: "local" }, { id: "kr_gyeongnam_sacheon", label: "경상남도 사천시", level: "local" }];
function savedFixture(month, multiplier = 1) {
  const collectedAt = `${month}-01T00:00:00Z`;
  const companies = ["zero", "priced", "rankOnly", "failed", "outside"].map(companyId => ({ companyId, primaryName: companyId, capacity: 10, capacitySource: "db_review", capacityBasis: { source: "db_review", revision: 2 } }));
  const observation = (companyId, extra = {}) => ({ companyId, runId: "r1", collectedAt, stayDate: `${month}-01`, productType: "lodging", inventoryEvidenceVersion: 4,
    supply: 10, sold: 2, publicBookings: 1, phoneBookings: 1, publicRevenue: 100 * multiplier, phoneRevenue: 100 * multiplier, estimatedRevenue: 200 * multiplier, ...extra });
  const source = { companies, regions: REGIONS,
    runs: [{ id: "r1", keyword: "포천글램핑", collectedAt, searchMode: "keyword", collectionQuality: { status: "complete" } }],
    rankObservations: companies.map(company => ({ companyId: company.companyId, runId: "r1", collectedAt, rank: company.companyId === "outside" ? 21 : 1 })),
    observations: [observation("zero", { sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }),
      observation("priced"), observation("failed", { failed: true }), observation("outside")]
  };
  const catalog = { companies, regions: REGIONS, runs: source.runs, rawCompanies: new Map(companies.map(company => [company.companyId,
    { lodgingTypes: company.companyId === "priced" ? ["글램핑", "펜션"] : ["글램핑"], addresses: [REGIONS[company.companyId === "priced" ? 1 : 0].label + " 모의로"] }])) };
  return { source, catalog };
}
function sourceAdapter(overrides = {}) {
  return { loadSourcesWithCatalog: async request => savedFixture(request.month),
    options: async () => ({ regions: REGIONS, months: ["2026-10", "2026-09"], defaultMonth: "2026-10", today: "2026-10-11" }),
    catalog: async () => savedFixture("2026-10").catalog, ...overrides };
}

test("closed-month defaults use the same month-end file on later days and restart, earlier cutoffs stay separate", async t => {
  const dataDir = await directory(t); let date = NOW, reads = 0;
  const sources = sourceAdapter({ options: async () => ({ regions: REGIONS, months: ["2026-09"], defaultMonth: "2026-09" }),
    catalog: async () => savedFixture("2026-09").catalog,
    loadSourcesWithCatalog: async request => { reads++; return savedFixture(request.month); } });
  const create = () => createIndustryAnalysisService({ dataDir, sources, now: () => date, autoStart: false });
  let service = create(); await service.bootstrap(); await service.drain();
  const saved = await service.analyze({ month: "2026-09" });
  assert.equal(saved.request.cutoffDate, "2026-09-30"); assert.equal(saved.storage.monthClosed, true);
  date = new Date("2026-10-12T00:00:00Z");
  assert.deepEqual(await service.analyze({ month: "2026-09" }), saved);
  assert.deepEqual(await service.analyze({ month: "2026-09", cutoffDate: "2026-10-11" }), saved);
  await service.stop(); service = create(); await service.bootstrap(); await service.drain();
  assert.deepEqual(await service.analyze({ month: "2026-09" }), saved); assert.equal(reads, 1);
  await service.analyze({ month: "2026-09", cutoffDate: "2026-09-15" }); await service.drain();
  assert.equal((await service.analyze({ month: "2026-09", cutoffDate: "2026-09-15" })).request.cutoffDate, "2026-09-15");
  const files = await fs.readdir(path.join(dataDir, "industry_analysis", "results"));
  assert.equal(files.length, 2, "later query dates do not accumulate duplicate closed-month files");
  await service.stop();
});

test("persisted September and October results equal existing calculation in every field, including zero and missing", async t => {
  const dataDir = await directory(t), sources = sourceAdapter();
  const immediate = createIndustryAnalysisService({ sources, now: () => NOW });
  const persistent = createIndustryAnalysisService({ dataDir, sources, now: () => NOW, autoStart: false });
  for (const month of ["2026-09", "2026-10"]) for (const region of ["all", "pocheon", "kr_gyeongnam_sacheon"]) for (const industry of ["glamping", "pension"]) {
    const request = { ...REQUEST, month, region, industry };
    await persistent.analyze(request); await persistent.drain();
    const { storage, ...actual } = await persistent.analyze(request);
    assert.equal(storage.status, "ready"); assert.deepEqual(actual, await immediate.analyze(request), `${month}/${region}/${industry}`);
    if (region === "all" && industry === "glamping") {
      assert.equal(actual.companies.find(row => row.companyId === "zero").sold, 0);
      assert.equal(actual.companies.find(row => row.companyId === "rankOnly").sold, null);
      assert.equal(actual.companies.find(row => row.companyId === "failed").sold, null);
      assert.ok(!actual.companies.some(row => row.companyId === "outside"));
    }
  }
});

test("source invalidation clears completed 30-second cache and blocks old pending cache publication", async t => {
  const dataDir = await directory(t), entered = deferred(), gate = deferred(); let reads = 0, multiplier = 1;
  const sources = sourceAdapter({ options: async () => ({ regions: REGIONS, months: ["2026-09"], defaultMonth: "2026-09", today: "2026-10-11" }),
    catalog: async () => savedFixture("2026-09").catalog, loadSourcesWithCatalog: async request => {
    const fixture = savedFixture(request.month, multiplier); reads++;
    if (reads === 1) { entered.resolve(); await gate.promise; } return fixture;
  } });
  const service = createIndustryAnalysisService({ dataDir, sources, now: () => NOW, autoStart: false });
  await service.analyze(REQUEST); const draining = service.drain(); await entered.promise;
  multiplier = 2; await service.invalidate({ reason: "new_saved_observation" }); gate.resolve(); await draining;
  assert.equal(reads, 2);
  assert.equal((await service.analyze(REQUEST)).summary.estimatedRevenue, 400);
  multiplier = 3; await service.invalidate({ months: ["2026-09"] }); await service.drain();
  assert.equal(reads, 3, "still-warm completed sources are discarded on revision change");
  assert.equal((await service.analyze(REQUEST)).summary.estimatedRevenue, 600);
});

test("persisted options and bootstrap reuse ready results; regional context refresh does not recalculate lodging", async t => {
  const dataDir = await directory(t); let sourceReads = 0, catalogReads = 0, contextValue = 1;
  const sources = sourceAdapter({ loadSourcesWithCatalog: async request => { sourceReads++; return savedFixture(request.month); },
    catalog: async () => { catalogReads++; return savedFixture("2026-10").catalog; } });
  const create = () => createIndustryAnalysisService({ dataDir, sources, now: () => NOW, autoStart: false,
    readContext: async () => ({ sources: [{ value: contextValue }], networkAttempted: false }) });
  let service = create(); await service.bootstrap(); await service.drain();
  assert.equal(sourceReads, 1); assert.equal(catalogReads, 1);
  await service.options(); assert.equal(catalogReads, 1);
  await service.analyze({ ...REQUEST, month: "2026-10", region: "pocheon" }); await service.drain();
  assert.equal(sourceReads, 1, "same-period region views share the bounded source cache");
  contextValue = 2;
  assert.equal((await service.analyze({ ...REQUEST, month: "2026-10", region: "pocheon" })).context.sources[0].value, 2);
  assert.equal(sourceReads, 1); await service.stop();
  service = create(); await service.bootstrap(); await service.drain();
  assert.equal(sourceReads, 1); assert.equal(catalogReads, 1, "restart reads saved selectors instead of a full catalog");
});

test("source changes discover and prepare a new latest month after the dirty mark, and invalid regions never become jobs", async t => {
  const dataDir = await directory(t); let latest = "2026-09", catalogReads = 0;
  const sources = sourceAdapter({ options: async () => ({ regions: REGIONS, months: [latest], defaultMonth: latest, today: "2026-10-11" }),
    catalog: async () => { catalogReads++; return savedFixture(latest).catalog; } });
  const service = createIndustryAnalysisService({ dataDir, sources, now: () => NOW, autoStart: false });
  await service.bootstrap(); await service.drain(); assert.equal(catalogReads, 1);
  latest = "2026-10";
  await service.invalidate({ reason: "new_month_saved" });
  assert.equal(catalogReads, 1, "dirty marking does not read the catalog in the source writer's call");
  await service.drain();
  assert.equal((await service.analyze({ ...REQUEST, month: "2026-10" })).storage.status, "ready");
  const stateFile = path.join(dataDir, "industry_analysis", "queue.json"), before = await fs.readFile(stateFile, "utf8");
  await assert.rejects(service.analyze({ ...REQUEST, region: "not-a-region" }), error => error.code === "invalid_region");
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
  await service.stop();
});

test("damaged selector metadata rebuilds without losing normal snapshots", async t => {
  const dataDir = await directory(t); let catalogReads = 0;
  const service = createIndustryAnalysisService({ dataDir, now: () => NOW, autoStart: false,
    sources: sourceAdapter({ catalog: async () => { catalogReads++; return savedFixture("2026-10").catalog; } }) });
  await service.bootstrap(); await service.drain();
  const request = { ...REQUEST, month: "2026-10" }, before = await service.analyze(request);
  await fs.writeFile(path.join(dataDir, "industry_analysis", "options.json"), "{broken");
  assert.equal((await service.options()).defaultMonth, "2026-10"); assert.equal(catalogReads, 2);
  assert.deepEqual(await service.analyze(request), before);
  await service.stop();
});

test("recovering a damaged queue cannot accept previous-epoch selector metadata as current", async t => {
  const dataDir = await directory(t); let latest = "2026-09", catalogReads = 0;
  const sources = sourceAdapter({ options: async () => ({ regions: REGIONS, months: [latest], defaultMonth: latest, today: "2026-10-11" }),
    catalog: async () => { catalogReads++; return savedFixture(latest).catalog; } });
  const create = () => createIndustryAnalysisService({ dataDir, sources, now: () => NOW, autoStart: false });
  let service = create(); await service.bootstrap(); await service.drain(); await service.stop();
  const optionsFile = path.join(dataDir, "industry_analysis", "options.json");
  const previousOptions = JSON.parse(await fs.readFile(optionsFile, "utf8"));
  latest = "2026-10";
  await fs.writeFile(path.join(dataDir, "industry_analysis", "queue.json"), "{damaged");
  service = create();
  assert.equal((await service.options()).defaultMonth, "2026-10"); assert.equal(catalogReads, 2);
  const replacement = JSON.parse(await fs.readFile(optionsFile, "utf8"));
  assert.notEqual(replacement.revision, previousOptions.revision);
  const previousResult = await service.analyze(REQUEST);
  assert.equal(previousResult.storage.status, "failed"); assert.equal(previousResult.storage.hasSnapshot, true);
  assert.equal(previousResult.summary.sold, 2, "new selector metadata does not hide or silently promote the old normal result");
  await service.stop();
});
