"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const { createIndustryAnalysisSavedReader } = require("./lib/industry_analysis_saved_reader.cjs");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { createIndustryAnalysisHttpHandler } = require("./lib/industry_analysis_http.cjs");
const { createController, renderDashboard } = require("../web/industry-analysis.js");
const NOW = new Date("2026-11-19T01:00:00Z");
const REQUEST = { industry: "glamping", month: "2026-11", region: "all", cutoffDate: "2026-11-19" };
const catalogue = { industries: [{ id: "glamping", label: "글램핑" }], regions: [{ id: "pocheon", label: "포천시" }],
  months: ["2026-11", "2026-10"], defaultMonth: "2026-11", defaultIndustry: "glamping" };
const result = request => ({ request, summary: { companyCount: 1, observedCompanies: 1, coveredCompanyDays: 1,
  expectedCompanyDays: 30, publicBookings: 0, phoneBookings: 0, reservationRate: 0, coverageRate: 1 / 30 },
  period: { monthClosed: false }, review: { schemaVersion: 1 }, sources: { regionPolicyVersion: "active-manual-region-v2" }, companies: [] });
const response = (status = "ready", extra = {}) => ({ ...result({ ...REQUEST }), storage: { status, hasSnapshot: true, stale: status !== "ready",
  calculatedAt: "2026-11-18T01:00:00Z", sourceVerification: "not_checked", checkedAt: NOW.toISOString(), ...extra } });
function host() { return { innerHTML: "", addEventListener() {}, removeEventListener() {}, querySelector() { return { focus() {} }; } }; }
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "industry-saved-menu-"));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function fixture(t, requests = [REQUEST]) {
  const dataDir = await temporary(t), store = createIndustryAnalysisStore({ dataDir, calculate: async request => result(request), now: () => NOW, autoStart: false });
  for (const request of requests) { await store.get(request); await store.drain(); }
  await store.writeOptions(catalogue, await store.optionsRevision()); await store.stop();
  return { dataDir, directory: path.join(dataDir, "industry_analysis"), queueFile: path.join(dataDir, "industry_analysis/queue.json") };
}
function noWorkStore(dataDir, counters) {
  return { ...createIndustryAnalysisSavedReader({ dataDir, now: () => NOW }), stop: async () => {} };
}

test("missing saved selectors and aggregates do not create directories, probe sources, recover or dispatch", async t => {
  const dataDir = await temporary(t), counts = { probes: 0, calculations: 0 }, store = noWorkStore(dataDir, counts);
  const selectors = await store.readSavedOptions(), saved = await store.readSaved(REQUEST, { verifySource: false });
  assert.equal(selectors.value, null); assert.equal(selectors.storage.status, "pending");
  assert.equal(saved.storage.hasSnapshot, false); assert.equal(saved.summary, undefined);
  assert.equal(saved.storage.sourceVerification, "not_checked"); assert.equal(saved.storage.sourceRevisionMatches, null);
  assert.deepEqual(counts, { probes: 0, calculations: 0 }); assert.deepEqual(await fs.readdir(dataDir), []); await store.stop();
});

test("stored menu reads preserve genuine zeros, source checks and processing jobs without writes", async t => {
  const seeded = await fixture(t), queue = JSON.parse(await fs.readFile(seeded.queueFile, "utf8"));
  queue.jobs[Object.keys(queue.jobs)[0]].status = "processing";
  const before = JSON.stringify(queue); await fs.writeFile(seeded.queueFile, before);
  const counts = { probes: 0, calculations: 0 }, store = noWorkStore(seeded.dataDir, counts);
  const selectors = await store.readSavedOptions(), saved = await store.readSaved(REQUEST, { verifySource: false });
  assert.equal(selectors.storage.status, "ready"); assert.equal(selectors.storage.sourceVerification, "not_checked");
  assert.equal(saved.storage.status, "processing"); assert.equal(saved.summary.publicBookings, 0);
  assert.equal(saved.storage.sourceRevisionMatches, null); assert.equal(saved.storage.sourceTokenMatches, null);
  assert.equal(await fs.readFile(seeded.queueFile, "utf8"), before); assert.deepEqual(counts, { probes: 0, calculations: 0 }); await store.stop();
});

test("selector revision changes remain usable but stale; invalid and oversized metadata are not empty normal data", async t => {
  const seeded = await fixture(t), counts = { probes: 0, calculations: 0 }, store = noWorkStore(seeded.dataDir, counts);
  const queue = JSON.parse(await fs.readFile(seeded.queueFile, "utf8")); queue.optionsRevision++;
  await fs.writeFile(seeded.queueFile, JSON.stringify(queue));
  const stale = await store.readSavedOptions(); assert.equal(stale.storage.status, "stale"); assert.deepEqual(stale.value.months, catalogue.months);
  const optionsFile = path.join(seeded.directory, "options.json");
  await fs.writeFile(optionsFile, " ".repeat(2 * 1024 * 1024 + 1));
  const oversized = await store.readSavedOptions(); assert.equal(oversized.value, null); assert.equal(oversized.storage.status, "detail_required");
  await fs.writeFile(optionsFile, "{broken");
  assert.equal((await store.readSavedOptions()).storage.status, "unavailable");
  assert.deepEqual(counts, { probes: 0, calculations: 0 }); await store.stop();
});

test("new service catalogue and saved APIs never call sources, context, runWork or the source-revision provider", async t => {
  const seeded = await fixture(t), before = await fs.readFile(seeded.queueFile), calls = [];
  const forbidden = name => async () => { calls.push(name); throw Error(name); };
  const service = createIndustryAnalysisService({ dataDir: seeded.dataDir, now: () => NOW, autoStart: true,
    sources: { options: forbidden("options"), catalog: forbidden("catalog"), loadSources: forbidden("sources") },
    readContext: forbidden("context"), runWork: forbidden("runWork"), readSourceRevision: forbidden("revision") });
  const selectors = await service.catalogue(), saved = await service.saved(REQUEST);
  assert.equal(selectors.metadataOnly, true); assert.deepEqual(selectors.months, catalogue.months);
  assert.equal(saved.summary.publicBookings, 0); assert.equal(saved.storage.sourceVerification, "not_checked");
  assert.deepEqual(calls, []); assert.deepEqual(await fs.readFile(seeded.queueFile), before); await service.stop();
});

test("saved adapter preserves the original store result identity and reads a newly replaced normal result", async t => {
  const seeded = await fixture(t), original = createIndustryAnalysisStore({ dataDir: seeded.dataDir, calculate: async request => result(request), now: () => NOW, autoStart: false });
  const normal = await original.readSaved(REQUEST), reader = createIndustryAnalysisSavedReader({ dataDir: seeded.dataDir, now: () => NOW });
  const first = await reader.readSaved(REQUEST); assert.equal(first.storage.resultVersion, normal.storage.resultVersion);
  const file = path.join(seeded.directory, "results", `${first.storage.key}.json`), saved = JSON.parse(await fs.readFile(file, "utf8"));
  saved.result.summary.publicBookings = 4; await fs.writeFile(file, JSON.stringify(saved));
  const latest = await reader.readSaved(REQUEST); assert.equal(latest.summary.publicBookings, 4);
  assert.notEqual(latest.storage.resultVersion, first.storage.resultVersion);
  assert.equal(latest.storage.resultVersion, (await original.readSaved(REQUEST)).storage.resultVersion); await original.stop();
});

test("wrong calculation version and mismatched stored conditions never expose metrics", async t => {
  const seeded = await fixture(t), reader = createIndustryAnalysisSavedReader({ dataDir: seeded.dataDir, now: () => NOW });
  const first = await reader.readSaved(REQUEST), file = path.join(seeded.directory, "results", `${first.storage.key}.json`);
  const saved = JSON.parse(await fs.readFile(file, "utf8")); saved.calculationVersion = "old-version"; await fs.writeFile(file, JSON.stringify(saved));
  const wrongVersion = await reader.readSaved(REQUEST, { allowEarlierCutoff: true });
  assert.equal(wrongVersion.storage.status, "unavailable"); assert.equal(wrongVersion.summary, undefined);
  saved.calculationVersion = "industry-analysis-v1"; saved.result.request.region = "other"; await fs.writeFile(file, JSON.stringify(saved));
  const wrongScope = await reader.readSaved(REQUEST); assert.equal(wrongScope.storage.hasSnapshot, false); assert.equal(wrongScope.summary, undefined);
});

test("earlier cutoff fallback uses only the same month, industry and region and never future or failed keys", async t => {
  const seeded = await fixture(t, [
    { ...REQUEST, cutoffDate: "2026-11-15" }, { ...REQUEST, cutoffDate: "2026-11-18" },
    { ...REQUEST, cutoffDate: "2026-11-20" }, { ...REQUEST, cutoffDate: "2026-11-18", region: "other" },
    { ...REQUEST, cutoffDate: "2026-11-18", industry: "pension" },
    { ...REQUEST, month: "2026-10", cutoffDate: "2026-10-31" }
  ]);
  const queue = JSON.parse(await fs.readFile(seeded.queueFile, "utf8"));
  const newest = Object.values(queue.jobs).find(job => job.request.cutoffDate === "2026-11-18" && job.request.region === "all" && job.request.industry === "glamping");
  newest.status = "failed"; await fs.writeFile(seeded.queueFile, JSON.stringify(queue));
  const counts = { probes: 0, calculations: 0 }, store = noWorkStore(seeded.dataDir, counts);
  const exact = await store.readSaved(REQUEST, { verifySource: false }); assert.equal(exact.storage.hasSnapshot, false);
  const older = await store.readSaved(REQUEST, { verifySource: false, allowEarlierCutoff: true });
  assert.equal(older.request.cutoffDate, "2026-11-15"); assert.equal(older.storage.requestedCutoffDate, "2026-11-19");
  assert.equal(older.storage.fallback, true); assert.equal(older.storage.status, "stale"); assert.equal(older.storage.sourceVerification, "not_checked");
  assert.equal(older.request.region, "all"); assert.equal(older.summary.publicBookings, 0);
  assert.deepEqual(counts, { probes: 0, calculations: 0 }); await store.stop();
});

test("new HTTP read endpoints preserve admin authority and validate routes without invoking old preparation APIs", async () => {
  const calls = [], service = Object.fromEntries(["catalogue", "saved", "options", "analyze"].map(name => [name, async value => { calls.push([name, value]); return { name }; }]));
  const handler = createIndustryAnalysisHttpHandler({ service, requireAdmin(session, req, res) { if (!session?.admin) { res.status = 403; return false; } return true; },
    send(res, status, value) { res.status = status; res.value = value; }, parseJsonBody: async () => ({}) });
  async function request(route, admin = true, method = "GET") { const res = {}; await handler({ method, headers: {} }, res, new URL(route, "https://local"), { admin }); return res; }
  for (const route of ["/catalogue", "/saved?month=2026-11"]) {
    assert.equal((await request("/api/industry-analysis" + route, false)).status, 403);
    assert.equal((await request("/api/industry-analysis" + route, true, "POST")).status, 405);
  }
  assert.equal((await request("/api/industry-analysis/catalogue?month=2026-11")).status, 400);
  assert.equal((await request("/api/industry-analysis/saved?month=2026-11&month=2026-10")).status, 400);
  assert.equal((await request("/api/industry-analysis/saved?unknown=1")).status, 400);
  assert.equal((await request("/api/industry-analysis/catalogue")).value.name, "catalogue");
  assert.equal((await request("/api/industry-analysis/saved?month=2026-11")).value.name, "saved");
  assert.deepEqual(calls.map(row => row[0]), ["catalogue", "saved"]);
  // Existing routes remain public contracts for explicit preparation.
  assert.equal((await request("/api/industry-analysis/options")).value.name, "options");
  assert.equal((await request("/api/industry-analysis?month=2026-11")).value.name, "analyze");
});

test("menu entry, returning, filter changes and polling use only catalogue and saved reads", async () => {
  const calls = [], timers = new Map(); let sequence = 0, processing = true;
  const controller = createController({ request: async url => { calls.push(url); return url.endsWith("/catalogue") ? catalogue
    : { ...response(processing ? "processing" : "ready"), request: Object.fromEntries(new URL(url, "https://local").searchParams) }; },
    setTimeout(callback) { const id = ++sequence; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } });
  const element = host(); await controller.mount(element); assert.equal(timers.size, 1);
  const timer = timers.values().next().value; processing = false; timer(); await new Promise(resolve => setImmediate(resolve));
  await controller.input("month", "2026-10"); controller.pause(); await controller.mount(element);
  assert.ok(calls[0].endsWith("/catalogue")); assert.ok(calls.slice(1).every(url => url.includes("/saved?")));
  assert.doesNotMatch(calls.join("\n"), /\/options|\/industry-analysis\?/); controller.destroy();
});

test("missing stored selectors show prepare instead of zero and only an explicit action starts original preparation", async () => {
  const calls = [], controller = createController({ request: async url => { calls.push(url);
    if (url.endsWith("/catalogue")) return { ...catalogue, months: [], defaultMonth: "", catalogue: { status: "pending", hasSnapshot: false, sourceVerification: "not_checked" } };
    if (url.endsWith("/options")) return catalogue;
    return response(); } });
  const element = host(); await controller.mount(element);
  assert.deepEqual(calls, ["/api/industry-analysis/catalogue"]); assert.match(element.innerHTML, /저장 자료 준비 필요/);
  assert.match(element.innerHTML, /data-ia-action="prepare"/); assert.doesNotMatch(element.innerHTML, /추정예약률<\/span><strong>0%/);
  await controller.prepare(); assert.equal(calls[1], "/api/industry-analysis/options"); assert.match(calls[2], /^\/api\/industry-analysis\?/);
  assert.equal(controller.state.data.summary.publicBookings, 0); controller.destroy();
});

test("failed saved refresh retains the same normal snapshot; visible freshness and earlier-cutoff labels stay honest", async () => {
  let fail = false;
  const controller = createController({ request: async url => url.endsWith("/catalogue") ? catalogue : fail
    ? { request: REQUEST, storage: { status: "unavailable", hasSnapshot: false, errorCode: "INDUSTRY_STORE_UNAVAILABLE" } }
    : response("stale", { fallback: true, requestedCutoffDate: "2026-11-19" }) });
  const element = host(); await controller.mount(element); const original = controller.state.data;
  assert.match(element.innerHTML, /요청일.*이전 마지막 정상 저장본/); assert.match(element.innerHTML, /최신 원본 미확인/);
  fail = true; await controller.loadData(); assert.equal(controller.state.data, original); assert.match(element.innerHTML, /마지막 정상 집계/);
  const html = renderDashboard({ catalog: catalogue, selection: { industry: "glamping", month: "2026-11", region: "all" }, data: response(), storage: response().storage, tab: "overview" });
  assert.match(html, /최신 원본의 변경 여부는 이번 조회에서 검사하지 않았습니다/); controller.destroy();
});

test("catalogue inspection failure preserves the last matching normal choices and metrics", async () => {
  let fail = false;
  const controller = createController({ request: async url => url.endsWith("/catalogue") ? fail
    ? { ...catalogue, months: [], catalogue: { status: "unavailable", hasSnapshot: false } } : catalogue : response() });
  const element = host(); await controller.mount(element); const data = controller.state.data;
  fail = true; await controller.loadCatalog(); assert.equal(controller.state.data, data); assert.equal(controller.state.selection.month, "2026-11");
  assert.match(element.innerHTML, /조건 목록을 확인하지 못했습니다/); assert.match(element.innerHTML, /마지막 정상 집계/); controller.destroy();
});

test("hardlinked result files and linked ancestors are rejected before financial data is exposed", async t => {
  const seeded = await fixture(t), reader = createIndustryAnalysisSavedReader({ dataDir: seeded.dataDir, now: () => NOW });
  const normal = await reader.readSaved(REQUEST), file = path.join(seeded.directory, "results", `${normal.storage.key}.json`), extraLink = path.join(seeded.directory, "linked-result.json");
  await fs.link(file, extraLink);
  const hardlink = await reader.readSaved(REQUEST); assert.equal(hardlink.storage.status, "unavailable"); assert.equal(hardlink.summary, undefined);
  await fs.unlink(extraLink);
  const actual = path.join(seeded.dataDir, "actual-industry"); await fs.rename(seeded.directory, actual);
  await fs.symlink(actual, seeded.directory, process.platform === "win32" ? "junction" : "dir");
  const ancestor = await reader.readSavedOptions(); assert.equal(ancestor.storage.status, "unavailable"); assert.equal(ancestor.value, null);
});

test("a replaced result path cannot pass opened-handle and post-path validation", async t => {
  const seeded = await fixture(t), reader = createIndustryAnalysisSavedReader({ dataDir: seeded.dataDir, now: () => NOW });
  const normal = await reader.readSaved(REQUEST), file = path.join(seeded.directory, "results", `${normal.storage.key}.json`), original = fs.open;
  let replaced = false;
  fs.open = async function (target, ...options) {
    const handle = await original.call(fs, target, ...options);
    if (path.resolve(target) === path.resolve(file) && !replaced) {
      replaced = true; const bytes = await fs.readFile(file); await fs.rename(file, file + ".previous"); await fs.writeFile(file, bytes);
    }
    return handle;
  };
  try { const swapped = await reader.readSaved(REQUEST); assert.equal(swapped.storage.status, "unavailable"); assert.equal(swapped.summary, undefined); }
  finally { fs.open = original; }
  assert.equal(replaced, true);
});

test("large result or queue files require explicit detail access and never allocate their financial graphs", async t => {
  const seeded = await fixture(t), reader = createIndustryAnalysisSavedReader({ dataDir: seeded.dataDir, now: () => NOW });
  const normal = await reader.readSaved(REQUEST), file = path.join(seeded.directory, "results", `${normal.storage.key}.json`);
  await fs.writeFile(file, " ".repeat(2 * 1024 * 1024 + 1));
  const large = await reader.readSaved(REQUEST); assert.equal(large.storage.status, "detail_required"); assert.equal(large.summary, undefined);
  await fs.writeFile(seeded.queueFile, " ".repeat(2 * 1024 * 1024 + 1));
  const queue = await reader.readSavedOptions(); assert.equal(queue.storage.status, "detail_required"); assert.equal(queue.value, null);
  const html = renderDashboard({ catalog: catalogue, data: null, storage: large.storage, selection: { ...REQUEST }, tab: "overview" });
  assert.match(html, /상세 조회 필요/); assert.match(html, /상세 자료 조회·준비/); assert.doesNotMatch(html, /추정예약률<\/span><strong>0%/);
});

test("the shared memory guard denies before filesystem allocation and the saved lane coalesces only one scope", async t => {
  const dataDir = await temporary(t), unavailable = Object.assign(Error("guard"), { code: "KEYWORD_MONTHLY_MEMORY_DEFERRED", statusCode: 503 });
  const denied = createIndustryAnalysisSavedReader({ dataDir, now: () => NOW, runMemoryAdmission: async () => { throw unavailable; } });
  await assert.rejects(denied.readSaved(REQUEST), error => error === unavailable);
  assert.deepEqual(await fs.readdir(dataDir), []);
  let resume, first = true;
  const gate = new Promise(resolve => { resume = resolve; });
  const reader = createIndustryAnalysisSavedReader({ dataDir, now: () => NOW, runMemoryAdmission: async operation => { if (first) { first = false; await gate; } return operation(); } });
  const a = reader.readSaved(REQUEST), same = reader.readSaved(REQUEST); assert.equal(a, same);
  await assert.rejects(reader.readSaved({ ...REQUEST, region: "other" }), { code: "INDUSTRY_SAVED_READ_BUSY" });
  resume(); assert.equal((await a).storage.hasSnapshot, false);
  assert.equal((await reader.readSaved({ ...REQUEST, region: "other" })).storage.hasSnapshot, false);
});

test("new HTTP responses reserve at most two bounded sockets and reject oversized or memory-denied responses", async () => {
  let reads = 0;
  const handler = createIndustryAnalysisHttpHandler({ service: { saved: async () => { reads++; return response(); } }, requireAdmin: () => true,
    runMemoryAdmission: async operation => operation(), send(res, status, value) { res.status = status; res.value = value; if (status !== 200) res.emit("finish"); } });
  function socket() { const value = new EventEmitter(); value.writeHead = () => {}; value.end = () => {}; return value; }
  const req = { method: "GET", headers: {} }, url = new URL("https://local/api/industry-analysis/saved?month=2026-11"), a = socket(), b = socket(), c = socket();
  const first = handler(req, a, url, {}), second = handler(req, b, url, {});
  await new Promise(resolve => setImmediate(resolve)); await handler(req, c, url, {});
  assert.equal(c.status, 503); assert.equal(reads, 2); assert.ok(Buffer.isBuffer(a.value)); assert.ok(a.value.length <= 2 * 1024 * 1024);
  a.emit("finish"); b.emit("finish"); await Promise.all([first, second]);
  const largeHandler = createIndustryAnalysisHttpHandler({ service: { saved: async () => ({ huge: "x".repeat(2 * 1024 * 1024) }) }, requireAdmin: () => true,
    runMemoryAdmission: async operation => operation(), send(res, status, value) { res.status = status; res.value = value; } });
  const oversized = {}; await largeHandler(req, oversized, url, {}); assert.equal(oversized.status, 503); assert.equal(oversized.value.huge, undefined);
  const deniedHandler = createIndustryAnalysisHttpHandler({ service: { saved: async () => { throw Error("must not read"); } }, requireAdmin: () => true,
    runMemoryAdmission: async () => { throw Object.assign(Error("memory"), { statusCode: 503, code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }); },
    send(res, status, value) { res.status = status; res.value = value; } });
  const memory = {}; await deniedHandler(req, memory, url, {}); assert.equal(memory.status, 503); assert.equal(memory.value.summary, undefined);
});

test("explicit retry of a failed current cutoff uses its requested date rather than the earlier displayed snapshot", async () => {
  let posted;
  const older = response("failed", { fallback: true, requestedCutoffDate: "2026-11-19" }); older.request.cutoffDate = "2026-11-15";
  const controller = createController({ request: async (url, options) => {
    if (url.endsWith("/catalogue")) return catalogue;
    if (options?.method === "POST") { posted = options.body; return response("ready"); }
    return older;
  } });
  await controller.mount(host()); await controller.rebuild();
  assert.equal(posted.cutoffDate, "2026-11-19"); assert.equal(posted.month, REQUEST.month); assert.equal(posted.region, REQUEST.region);
  controller.destroy();
});
