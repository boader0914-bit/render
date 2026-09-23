"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const start = source.indexOf("function adminCrawlStorageKey()");
const end = source.indexOf("function setDefaultDates()", start);
assert.ok(start >= 0 && end > start);

function harness() {
  const data = new Map();
  const nodes = { crawlWorkerKey: { value: "scheduled", disabled: false }, crawlAllowRepeat: { checked: false }, crawlRepeatReason: { value: "" } };
  const submit = { disabled: false };
  const events = [], calls = [], timers = [], statuses = [], progress = [];
  const els = { crawlForm: { querySelector: () => submit }, keywordInput: { value: "포천글램핑" }, searchModeInput: { value: "keyword" }, crawlStatus: { textContent: "" } };
  const context = {
    state: { session: { username: "test-admin" } }, els,
    document: { getElementById: id => nodes[id] },
    window: { localStorage: { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }, dispatchEvent: event => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {},
    crypto: { randomUUID: () => `test-request-${calls.length.toString().padStart(6, "0")}` },
    fetchJson: async (url, options) => { calls.push({ url, options }); return context.response(url, options); },
    response: () => ({ status: "pending" }),
    isAdminRole: () => true, setStatus: value => statuses.push(value), setCrawlProgress: (...args) => progress.push(args),
    loadRuns: async () => { calls.push({ url: "loadRuns" }); }, loadAdminDbCompanyDetail: async () => {}, renderAdminConsoleDashboard() {},
    setAdminDbDetailFlash() {}, crawlStageFallbacks: () => [], ensureCrawlControls() {},
    regionalLodgingSearchIntent: () => ({}), hasExplicitCompanyCollectionTarget: () => false, syncBroadLodgingPurposePolicy() {},
    correctedSearchMode: () => "keyword", currentCrawlFormPayload: () => ({ keyword: "포천글램핑", collectionPurpose: "revenue_detail" }),
    recrawlContextMatchesPayload: () => false, crawlPreviewMeta: () => ({}), revealActiveCrawlProgressOnMobile() {},
    Date, Math, JSON, Object, Array, Number, String, Boolean, encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, data, nodes, submit, events, calls, timers, statuses, progress, els };
}

test("final receipt requires complete quality and a run ID before claiming success", () => {
  const { context: c } = harness();
  for (const status of ["partial", "blocked", "failed", "interrupted"]) {
    const result = c.adminCrawlRequestOutcome({ status, result: { runId: "run", collectionQuality: { status } } });
    assert.equal(result.success, false);
    assert.doesNotMatch(result.message, /수집을 완료/);
  }
  assert.equal(c.adminCrawlRequestOutcome({ status: "complete", result: { runId: "run" } }).success, false);
  assert.equal(c.adminCrawlRequestOutcome({ status: "complete", result: { runId: "run", collectionQuality: { status: "partial" } } }).success, false);
  assert.equal(c.adminCrawlRequestOutcome({ status: "reused", result: { runId: "run", collectionQuality: { status: "complete" } } }).success, true);
});

test("accepted collection frees the worker selector and sends its selected role through async API", async () => {
  const ui = harness();
  await ui.context.submitCrawl({ preventDefault() {} });
  const call = ui.calls.find(item => item.url.startsWith("/api/crawl?"));
  assert.equal(call.url, "/api/crawl?async=1");
  const payload = JSON.parse(call.options.body);
  assert.equal(payload.workerKey, "scheduled");
  assert.match(payload.clientRequestId, /^[a-zA-Z0-9_-]{8,120}$/);
  assert.equal(ui.submit.disabled, false);
  assert.equal(ui.nodes.crawlWorkerKey.disabled, false);
  assert.equal(Object.values(ui.context.state.adminCrawlRequests)[0].status, "pending");
  assert.match(ui.els.crawlStatus.textContent, /접수했습니다/);
  assert.ok(ui.events.some(event => event.type === "collector:requests-changed"));
});

test("scope or protection 409 is a rejected request, never a claim that existing work will finish", async () => {
  const ui = harness();
  ui.context.response = () => { const error = new Error("당일 범위가 다릅니다."); error.status = 409; throw error; };
  await ui.context.submitCrawl({ preventDefault() {} });
  assert.equal(Object.values(ui.context.state.adminCrawlRequests)[0].status, "failed");
  assert.doesNotMatch(ui.els.crawlStatus.textContent, /자동으로 갱신|수집 대기 중|수집을 완료/);
  assert.match(ui.els.crawlStatus.textContent, /당일 범위가 다릅니다/);
});

test("offline or protected worker readiness prevents submitting until another ready worker is selected", async () => {
  const ui = harness();
  ui.nodes.crawlWorkerHint = { dataset: { ready: "false" }, textContent: "선택한 워커의 연결 확인이 필요합니다." };
  ui.context.syncAdminCrawlSubmitAvailability();
  assert.equal(ui.submit.disabled, true);
  await ui.context.submitCrawl({ preventDefault() {} });
  assert.equal(ui.calls.length, 0);
  assert.match(ui.els.crawlStatus.textContent, /연결 확인/);
  ui.nodes.crawlWorkerHint.dataset.ready = "true";
  ui.context.syncAdminCrawlSubmitAvailability();
  assert.equal(ui.submit.disabled, false);
  await ui.context.submitCrawl({ preventDefault() {} });
  assert.equal(ui.calls.filter(call => call.options?.method === "POST").length, 1);
  assert.equal(ui.submit.disabled, false);
});

test("lost acceptance response is checked by the same ID without resubmitting", async () => {
  const ui = harness();
  ui.context.response = () => { throw new Error("connection lost"); };
  await ui.context.submitCrawl({ preventDefault() {} });
  const request = Object.values(ui.context.state.adminCrawlRequests)[0];
  ui.context.response = url => url.startsWith("/api/crawl-requests/") ? { status: "pending" } : { active: false };
  await ui.context.pollAdminCrawlRequests();
  assert.ok(ui.calls.some(call => call.url === `/api/crawl-requests/${request.requestId}`));
  assert.equal(ui.calls.filter(call => call.options?.method === "POST").length, 1);
  assert.equal(request.status, "pending");
});

test("browser restore checks stored pending IDs and 404 does not cause another collection", async () => {
  const ui = harness();
  ui.data.set("glamping:admin:crawl-requests:test-admin", JSON.stringify({ version: 1, requests: [{ requestId: "request-restored-123", workerKey: "manual", keyword: "가평글램핑", status: "pending" }] }));
  ui.context.restoreAdminCrawlRequests();
  ui.context.response = () => { const error = new Error("missing"); error.status = 404; throw error; };
  await ui.context.pollAdminCrawlRequests();
  assert.equal(ui.context.state.adminCrawlRequests["request-restored-123"].status, "interrupted");
  assert.equal(ui.calls.filter(call => call.options?.method === "POST").length, 0);
  assert.match(ui.els.crawlStatus.textContent, /자동으로 다시 실행하지 않습니다/);
});

test("two independent requests retain their own worker and a partial result does not refresh normal data", async () => {
  const ui = harness();
  ui.context.state.adminCrawlRequests = {
    one: { requestId: "request-one-123", workerKey: "manual", keyword: "경남글램핑", status: "pending" },
    two: { requestId: "request-two-123", workerKey: "scheduled", keyword: "포천글램핑", status: "pending" }
  };
  ui.context.response = url => url.endsWith("request-one-123") ? { status: "partial", result: { runId: "partial", collectionQuality: { status: "partial" } } } : url.startsWith("/api/crawl-requests/") ? { status: "pending" } : { active: true };
  await ui.context.pollAdminCrawlRequests();
  assert.equal(ui.context.state.adminCrawlRequests.one.status, "partial");
  assert.equal(ui.context.state.adminCrawlRequests.two.status, "pending");
  assert.equal(ui.calls.filter(call => call.url === "loadRuns").length, 0);
  const persisted = JSON.parse(ui.data.get("glamping:admin:crawl-requests:test-admin"));
  assert.equal(persisted.requests.length, 1);
  assert.equal(persisted.requests[0].workerKey, "scheduled");
});

test("completed collection keeps the current screen until the user explicitly opens its result", async () => {
  const ui = harness();
  const navigation = [];
  ui.context.state.activeTab = "admin";
  ui.context.setActiveTab = tab => { navigation.push(tab); };
  ui.context.loadRun = async runId => { ui.calls.push({ url: "loadRun", runId }); };
  await ui.context.finishAdminCrawlRequest({ workerKey: "manual", keyword: "포천글램핑" }, { status: "complete", result: { runId: "pocheon_glamping_20260923_090000", collectionQuality: { status: "complete" } } });
  assert.equal(navigation.length, 0);
  assert.equal(ui.calls.some(call => call.url === "loadRun"), false);
  await ui.context.openAdminCrawlResult({ detail: { runId: "pocheon_glamping_20260923_090000" } });
  assert.equal(ui.calls.find(call => call.url === "loadRun").runId, "pocheon_glamping_20260923_090000");
  assert.deepEqual(navigation, ["rank"]);
  navigation.length = 0;
  ui.context.loadRun = async () => { throw new Error("자료 조회 실패"); };
  await ui.context.openAdminCrawlResult({ detail: { runId: "pocheon_glamping_20260923_090000" } });
  assert.equal(navigation.length, 0);
  assert.match(ui.els.crawlStatus.textContent, /결과 조회 실패/);
});

test("company review collection refreshes that company only on verified completion without navigation", async () => {
  for (const status of ["complete", "partial", "blocked"]) {
    const ui = harness();
    const navigation = [], details = [];
    ui.context.state.activeTab = "admin";
    ui.context.state.adminDbSelectedCompanyId = "another-company";
    ui.context.setActiveTab = tab => navigation.push(tab);
    ui.context.loadAdminDbCompanyDetail = async (id, options) => details.push({ id, force: options.force });
    await ui.context.finishAdminCrawlRequest({ workerKey: "manual", keyword: "검수업체", createdAt: 1, recrawlContext: { type: "company", companyIds: ["company-123"], source: "admin_db_detail" } }, { status, result: { runId: "pocheon_glamping_20260923_090000", collectionQuality: { status } } });
    assert.equal(navigation.length, 0);
    assert.equal(ui.context.state.activeTab, "admin");
    assert.equal(ui.context.state.adminDbSelectedCompanyId, "another-company");
    assert.deepEqual(details, status === "complete" ? [{ id: "company-123", force: true }] : []);
    assert.equal(ui.context.state.adminDbInlineCollect.status, status === "complete" ? "complete" : "error");
  }
});
