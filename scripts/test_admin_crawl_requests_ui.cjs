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


test("basic worker selection survives submit, request restore, status polling and company context", async () => {
  const ui = harness();
  ui.nodes.crawlWorkerKey.value = "web";
  ui.context.state.pendingRecrawlContext = { type: "company", companyIds: ["company-123"], source: "admin_db_detail" };
  ui.context.hasExplicitCompanyCollectionTarget = () => true;
  await ui.context.submitCrawl({ preventDefault() {} });
  const sent = JSON.parse(ui.calls.find(item => item.options?.method === "POST").options.body);
  assert.equal(sent.workerKey, "web");
  assert.equal(sent.recrawlContext.companyIds[0], "company-123");
  assert.match(ui.els.crawlStatus.textContent, /2Gweb_worker/);
  const id = sent.clientRequestId;
  const pending = JSON.parse(ui.data.get("glamping:admin:crawl-requests:test-admin"));
  assert.equal(pending.requests[0].workerKey, "web");
  ui.context.state.adminCrawlRequests = {};
  ui.context.restoreAdminCrawlRequests();
  assert.equal(ui.context.state.adminCrawlRequests[id].workerKey, "web");
  ui.context.response = url => url.startsWith("/api/crawl-requests/") ? { status: "pending" } : { active: true };
  await ui.context.pollAdminCrawlRequests();
  assert.ok(ui.calls.some(item => item.url === "/api/crawl-status?workerKey=web"));
  assert.equal(ui.calls.filter(item => item.options?.method === "POST").length, 1);
  await ui.context.finishAdminCrawlRequest(ui.context.state.adminCrawlRequests[id], { status: "complete", result: { runId: "web_glamping_20260923_230000", collectionQuality: { status: "complete" } } });
  assert.match(ui.els.crawlStatus.textContent, /2Gweb_worker.*수집을 완료/);
});

test("worker-card bridge submits through existing receipt tracking with isolated scope and day-use", async () => {
  const ui = harness();
  ui.els.crawlForm.dataset = {};
  ui.els.checkInInput = { value: "" };
  ui.els.checkOutInput = { value: "" };
  ui.els.collectionPurposeInput = { value: "basic_db" };
  ui.nodes.crawlWorkerKey.dispatchEvent = () => {};
  ui.context.Event = class { constructor(type) { this.type = type; } };
  ui.context.setDetailRankRange = value => { ui.els.crawlForm.dataset.ranks = value; };
  ui.context.currentCrawlFormPayload = () => ({
    keyword: ui.els.keywordInput.value, checkIn: ui.els.checkInInput.value, checkOut: ui.els.checkOutInput.value,
    collectionPurpose: ui.els.collectionPurposeInput.value, dayUseMode: ui.els.crawlForm.dataset.dayUseMode,
    bookingRangeDays: Number(ui.els.crawlForm.dataset.bookingRangeDays), detailRankRanges: ui.els.crawlForm.dataset.ranks
  });
  ui.context.state.pendingRecrawlContext = { type: "company", companyIds: ["unrelated-company"] };
  const receipt = await ui.context.submitCollectorCard({ workerKey: "manual", keyword: "가평글램핑", checkIn: "2026-09-24", checkOut: "2026-09-25", bookingRangeDays: 1, collectionPurpose: "revenue_detail", detailRankRanges: "1-5", dayUseMode: "lodging_only", allowRepeat: false });
  const sent = JSON.parse(ui.calls.find(item => item.options?.method === "POST").options.body);
  assert.equal(sent.workerKey, "manual");
  assert.equal(sent.keyword, "가평글램핑");
  assert.equal(sent.dayUseMode, "lodging_only");
  assert.equal(sent.bookingRangeDays, 1);
  assert.equal(sent.recrawlContext, undefined);
  assert.equal(receipt.status, "pending");
  assert.equal(ui.context.state.adminCrawlRequests[receipt.requestId].workerKey, "manual");
  assert.equal(ui.els.crawlForm.dataset.bookingDateScope, "2026-09-24|2026-09-25");
});

test("ETA preview preserves selected worker and day-use scope and separates cached estimates", () => {
  const start=source.indexOf("function currentCrawlFormPayload()"), end=source.indexOf("function selectedCrawlSpeedPresetKey(",start);
  const planStart=source.indexOf("function crawlEstimatePayloadFromPlan("), planEnd=source.indexOf("function crawlEtaForPlan(",planStart);
  const form={dataset:{dayUseMode:"inspect"}}, ctx={
    selection:"manual", state:{}, els:{crawlForm:form,keywordInput:{value:"경남글램핑"},checkInInput:{value:"2026-09-24"},checkOutInput:{value:"2026-09-30"},searchModeInput:{value:"keyword"},collectionPurposeInput:{value:"revenue_detail"},detailRankRangesInput:{value:"1-20"}},
    document:{getElementById:()=>form}, activeKeyword:()=>"경남글램핑", selectedAdminCrawlWorkerKey:()=>ctx.selection,
    regionalLodgingSearchIntent:()=>({kind:"typed_lodging",region:"경남",scope:"lodging_type:글램핑",label:"글램핑"}),correctedSearchMode:()=>"keyword",
    normalizeCrawlFormPurpose:value=>value, collectionPurposeProfile:()=>({defaultRange:"1-20",collectWeeklyRange:true}),collectionPurposeDefaultRange:()=>"1-20",rankRangeCountFromText:()=>20,rankRangePlaceLimitFromText:()=>20
  };
  vm.runInNewContext(source.slice(start,end)+source.slice(planStart,planEnd),ctx);
  const keys=new Set();
  for(const worker of ["web","manual","scheduled"]) for(const dayUseMode of ["inspect","lodging_only","detail"]) {
    ctx.selection=worker; form.dataset.dayUseMode=dayUseMode;
    const payload=ctx.currentCrawlFormPayload(), preview=ctx.crawlEstimatePayloadFromPlan(payload);
    assert.equal(payload.workerKey,worker); assert.equal(preview.workerKey,worker); assert.equal(preview.dayUseMode,dayUseMode);
    keys.add(ctx.crawlEtaKey(preview));
  }
  assert.equal(keys.size,9,"worker or day-use changes must never reuse a mismatched ETA cache entry");
  const explicit=ctx.crawlEstimatePayloadFromPlan({workerKey:"web",dayUseMode:"lodging_only"});
  assert.equal(explicit.workerKey,"web"); assert.equal(explicit.dayUseMode,"lodging_only");
});

function inlineReadyUi() {
  const ui = harness(), c = ui.context, forms = {}, frames = [], submissions = [], readiness = [];
  const company = { companyId: "cmp-synthetic", primaryName: "합성 업체" }, plan = { keyword: "합성 업체", checkIn: "2026-11-17", checkOut: "2026-11-18", range: "1-5", searchMode: "company", collectionPurpose: "revenue_detail" };
  let admin = true, currentPlan = plan;
  Object.assign(c.state, { session: { authenticated: true, role: "admin", username: "synthetic-admin" }, activeTab: "admin", adminPanelSection: "database", adminDbSelectedCompanyId: company.companyId, analysisNavigationSequence: 1, adminDbSearchRenderRevision: 1 });
  ui.nodes.crawlWorkerHint = { dataset: { ready: "false" }, textContent: "수집기 상태 미확인" }; ui.submit.disabled = true;
  for (const key of ["checkInInput", "checkOutInput", "collectionPurposeInput", "collectionModeInput", "productModeInput", "detailRankRangesInput"]) ui.els[key] = { value: key.includes("Purpose") ? "basic_db" : "" };
  ui.els.crawlForm.dataset = {}; ui.els.crawlForm.addEventListener = (type, callback) => { (forms[type] ||= []).push(callback); };
  ui.els.crawlForm.requestSubmit = () => { submissions.push(c.submitCrawl({ preventDefault() {} })); };
  c.isAdminRole = () => admin; c.window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  c.window.dispatchEvent = event => { ui.events.push(event); if (event.type === "collector:ensure-ready") readiness.push(event.detail); };
  c.companyMasterSource = () => ({ companies: [company] }); c.companyDecisionQueueProfile = () => ({}); c.companyNeedsCorrection = () => ({});
  c.companyQueueRecrawlPlan = () => ({ ...currentPlan }); c.applyRecrawlRangeOverride = value => value; c.crawlEtaForPlan = () => ({ estimatedTotalSeconds: 60 });
  c.crawlEtaKey = () => "synthetic-key"; c.companyCollectionTargetNames = () => ["합성 업체"]; c.activeKeyword = () => "initial-keyword";
  c.crawlEtaShortText = () => "1분"; c.collectionPurposeProfile = () => ({ label: "상세" }); c.renderCrawlReadinessPreview = () => {}; c.syncCollectionModeInputs = () => {};
  c.focusAdminCrawlProgress = () => { throw Error("inline must not change the current DB screen"); }; c.correctedSearchMode = (keyword, mode) => mode;
  c.setDetailRankRange = value => { ui.els.detailRankRangesInput.value = value; }; c.renderAdminConsoleDashboard = () => { c.state.adminDbSearchRenderRevision++; button.isConnected = false; };
  c.currentCrawlFormPayload = () => ({ keyword: ui.els.keywordInput.value, checkIn: ui.els.checkInInput.value, checkOut: ui.els.checkOutInput.value,
    collectionPurpose: ui.els.collectionPurposeInput.value, searchMode: ui.els.searchModeInput.value, detailRankRanges: ui.els.detailRankRangesInput.value, workerKey: ui.nodes.crawlWorkerKey.value });
  c.recrawlContextMatchesPayload = (context, payload) => context?.companyIds?.[0] === company.companyId && context.keyword === payload.keyword && context.checkIn === payload.checkIn && context.checkOut === payload.checkOut;
  const declarations = ["queueRecrawlShouldAutoStart", "startQueueRecrawlIfRequested", "adminCrawlReadinessEditRevision", "ensureAdminCollectorReady", "applyQueueRecrawlSetting"]
    .map(name => { const d = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0]; assert.ok(d, name); return d; });
  vm.runInContext(declarations.join("\n"), c);
  const button = { dataset: { queueRecrawlCompany: company.companyId, queueRecrawlSource: "admin_db_detail", queueRecrawlAutostart: "1" }, textContent: "확인 수집", isConnected: true };
  const ready = (index = readiness.length - 1, value = null) => { ui.nodes.crawlWorkerHint.dataset.ready = "true"; c.syncAdminCrawlSubmitAvailability(); const r = readiness[index]; r.resolve(value === null ? { ready: true, workerKey: r.workerKey } : value); };
  return { ...ui, button, company, plan, readiness, frames, submissions, ready, setAdmin(value) { admin = value; }, changePlan(value) { currentPlan = { ...currentPlan, ...value }; },
    edit(type = "input") { for (const listener of forms[type] || []) listener(); }, async frame() { for (const callback of frames.splice(0)) callback(); await Promise.all(submissions); },
    posts() { return ui.calls.filter(call => call.url === "/api/crawl?async=1"); } };
}

test("DB inline first use awaits fresh readiness before interpreting an unknown disabled submit as busy", async () => {
  const ui = inlineReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button);
  assert.equal(ui.readiness.length, 1); assert.equal(ui.posts().length, 0); assert.equal(ui.frames.length, 0); assert.equal(ui.context.state.pendingRecrawlContext, undefined);
  assert.equal(ui.readiness[0].workerKey, "scheduled"); ui.ready(); await pending; assert.equal(ui.frames.length, 1); assert.equal(ui.context.state.adminDbInlineCollect.status, "preparing");
  await ui.frame(); assert.equal(ui.posts().length, 1, "the existing synthetic receipt submission is invoked only after readiness");
  const body = JSON.parse(ui.posts()[0].options.body); assert.equal(body.keyword, ui.plan.keyword); assert.equal(body.workerKey, "scheduled"); assert.equal(ui.context.state.adminPanelSection, "database");
});

test("DB readiness rejection, missing listener timeout and late success never submit or create preparing state", async () => {
  for (const mode of ["reject", "timeout"]) {
    const ui = inlineReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); assert.equal(ui.readiness.length, 1);
    if (mode === "reject") ui.readiness[0].reject(Object.assign(Error("DO_NOT_PRINT_PRIVATE"), { code: "COLLECTOR_HALTED" }));
    else { const timer = ui.timers.find(timer => timer.delay === 10000); assert.ok(timer); timer.fn(); }
    await pending; ui.ready(); await ui.frame(); assert.equal(ui.posts().length, 0); assert.equal(ui.context.state.adminDbInlineCollect, undefined); assert.equal(ui.context.state.pendingRecrawlContext, undefined);
    assert.match(ui.els.crawlStatus.textContent, /수집하지 않았습니다/); assert.doesNotMatch(ui.els.crawlStatus.textContent, /DO_NOT_PRINT_PRIVATE/);
  }
});

test("DB readiness requires the exact computed worker result rather than a boolean or an unrelated capability", async () => {
  for (const value of [true, {}, { ready: false, workerKey: "scheduled" }, { ready: true, workerKey: "manual" }, { ready: true, workerKey: "scheduled", private: "DO_NOT_PRINT" }]) {
    const ui = inlineReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); ui.ready(0, value); await pending; await ui.frame(); assert.equal(ui.posts().length, 0);
  }
});

test("authentication, DB selection, navigation, range and user edits invalidate an outstanding inline readiness intent", async () => {
  for (const change of [ui => ui.setAdmin(false), ui => { ui.context.state.session = { ...ui.context.state.session }; }, ui => { ui.context.state.adminUserViewMode = true; },
    ui => { ui.context.state.adminDbSelectedCompanyId = "another-company"; }, ui => { ui.context.state.analysisNavigationSequence++; }, ui => { ui.context.state.adminDbSearchRenderRevision++; },
    ui => { ui.nodes.crawlWorkerKey.value = "manual"; }, ui => { ui.button.dataset.queueRecrawlRange = "1-20"; }, ui => { ui.button.isConnected = false; },
    ui => { ui.els.keywordInput.value = "new input"; }, ui => ui.edit(), ui => ui.edit("change"), ui => ui.changePlan({ checkIn: "2026-11-18" })]) {
    const ui = inlineReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); change(ui); ui.ready(); await pending; await ui.frame(); assert.equal(ui.posts().length, 0); assert.equal(ui.context.state.pendingRecrawlContext, undefined);
  }
});

test("real collection busy and protection-disabled state remain blocks before and after readiness", async () => {
  for (const before of [{ adminCrawlSubmitting: true }, { adminDbInlineCollect: { status: "running" } }]) {
    const ui = inlineReadyUi(); Object.assign(ui.context.state, before); await ui.context.applyQueueRecrawlSetting(ui.button); assert.equal(ui.readiness.length, 0); assert.equal(ui.posts().length, 0);
  }
  for (const mode of ["busy", "inline", "disabled"]) {
    const ui = inlineReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); ui.ready();
    if (mode === "busy") ui.context.state.adminCrawlSubmitting = true; if (mode === "inline") ui.context.state.adminDbInlineCollect = { status: "running" }; if (mode === "disabled") ui.submit.disabled = true;
    await pending; await ui.frame(); assert.equal(ui.posts().length, 0); assert.equal(ui.context.state.pendingRecrawlContext, undefined);
  }
});

test("only the newest inline intent may prepare and the next real frame rechecks user selection", async () => {
  const ui = inlineReadyUi(), first = ui.context.applyQueueRecrawlSetting(ui.button), second = ui.context.applyQueueRecrawlSetting(ui.button);
  assert.equal(ui.readiness.length, 2); ui.ready(0); ui.ready(1); await Promise.all([first, second]); assert.equal(ui.frames.length, 1); await ui.frame(); assert.equal(ui.posts().length, 1);
  for (const change of [ui => { ui.context.state.adminDbSelectedCompanyId = "another-company"; }, ui => ui.edit(), ui => ui.setAdmin(false),
    ui => { ui.context.state.analysisNavigationSequence++; }, ui => { ui.context.state.pendingRecrawlContext = null; }]) {
    const other = inlineReadyUi(), pending = other.context.applyQueueRecrawlSetting(other.button); other.ready(); await pending; change(other); await other.frame(); assert.equal(other.posts().length, 0);
    assert.equal(other.context.state.adminDbInlineCollect, null, "cancel only this still-unsubmitted preparing owner, so later retries are not falsely busy");
  }
});

test("non-inline recrawl preparation retains its immediate manual navigation without a hidden readiness request", async () => {
  const ui = inlineReadyUi(); ui.button.dataset.queueRecrawlSource = "decision_queue"; ui.button.dataset.queueRecrawlAutostart = "0"; ui.button.textContent = "설정";
  let navigated = 0; ui.context.focusAdminCrawlProgress = () => { navigated++; }; await ui.context.applyQueueRecrawlSetting(ui.button);
  assert.equal(navigated, 1); assert.equal(ui.readiness.length, 0); assert.equal(ui.frames.length, 0); assert.equal(ui.posts().length, 0);
});

function automaticReadyUi(sourceName = "admin_db_decision") {
  const ui = inlineReadyUi(); ui.button.dataset.queueRecrawlSource = sourceName;
  Object.assign(ui.context.state, { activeTab: "rank", adminPanelSection: "overview", adminDbSelectedCompanyId: "origin-company" });
  ui.navigations = 0; ui.context.focusAdminCrawlProgress = () => {
    ui.navigations++; Object.assign(ui.context.state, { activeTab: "admin", adminPanelSection: "collect" }); ui.context.state.analysisNavigationSequence++;
  };
  return ui;
}

test("every explicit automatic confirm-collection source waits for fresh readiness before navigation and its original receipt POST", async () => {
  for (const sourceName of ["admin_db_decision", "admin_db", "admin_region_audit_queue", "admin_confirm_collect", "decision_queue"]) {
    const ui = automaticReadyUi(sourceName); if (sourceName === "decision_queue") ui.button.dataset.queueRecrawlAutostart = "0";
    const pending = ui.context.applyQueueRecrawlSetting(ui.button);
    assert.equal(ui.readiness.length, 1, sourceName); assert.equal(ui.navigations, 0); assert.equal(ui.frames.length, 0); assert.equal(ui.posts().length, 0);
    ui.ready(); await pending; assert.equal(ui.navigations, 1); assert.equal(ui.frames.length, 1); assert.equal(ui.context.state.adminDbInlineCollect, undefined);
    await ui.frame(); assert.equal(ui.posts().length, 1, sourceName);
    const body = JSON.parse(ui.posts()[0].options.body); assert.equal(body.keyword, ui.plan.keyword); assert.equal(body.recrawlContext.companyIds[0], ui.company.companyId);
    assert.equal(ui.context.state.adminPanelSection, "collect");
  }
});

test("automatic confirmation yields to newer authentication, navigation, selection, plan or input while waiting", async () => {
  for (const change of [ui => ui.setAdmin(false), ui => { ui.context.state.session = { ...ui.context.state.session }; },
    ui => { ui.context.state.analysisNavigationSequence++; }, ui => { ui.context.state.activeTab = "reports"; },
    ui => { ui.context.state.adminDbSelectedCompanyId = "new-origin"; }, ui => ui.edit(), ui => { ui.els.checkInInput.value = "2026-11-20"; },
    ui => ui.changePlan({ checkOut: "2026-11-20" }), ui => { ui.button.dataset.queueRecrawlRange = "1-20"; }]) {
    const ui = automaticReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); change(ui); ui.ready(); await pending; await ui.frame();
    assert.equal(ui.navigations, 0); assert.equal(ui.posts().length, 0); assert.equal(ui.context.state.pendingRecrawlContext, undefined);
  }
});

test("automatic confirmation timeout or protection rejection never navigates, retries or submits late", async () => {
  for (const mode of ["timeout", "reject", "busy"]) {
    const ui = automaticReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button);
    if (mode === "timeout") ui.timers.find(timer => timer.delay === 10000).fn();
    else if (mode === "reject") ui.readiness[0].reject(Object.assign(Error("protected"), { code: "COLLECTOR_REVIEW_HOLD" }));
    else { ui.ready(); ui.context.state.adminCrawlSubmitting = true; }
    await pending; if (mode !== "busy") ui.ready(); await ui.frame();
    assert.equal(ui.navigations, 0); assert.equal(ui.posts().length, 0); assert.equal(ui.readiness.length, 1);
  }
});

test("automatic confirmation rebinds only its own navigation and still yields before the next frame or to manual setup", async () => {
  for (const change of [ui => { ui.context.state.analysisNavigationSequence++; }, ui => { ui.context.state.adminDbSelectedCompanyId = "new-view-company"; }, ui => ui.edit(), ui => ui.setAdmin(false)]) {
    const ui = automaticReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button); ui.ready(); await pending; assert.equal(ui.navigations, 1);
    change(ui); await ui.frame(); assert.equal(ui.posts().length, 0); assert.equal(ui.context.state.pendingRecrawlContext, null);
  }
  const ui = automaticReadyUi(), pending = ui.context.applyQueueRecrawlSetting(ui.button), manual = { ...ui.button, dataset: { ...ui.button.dataset, queueRecrawlAutostart: "0" }, textContent: "설정 적용" };
  await ui.context.applyQueueRecrawlSetting(manual); assert.equal(ui.readiness.length, 1, "manual setup does not issue another readiness GET");
  ui.ready(); await pending; await ui.frame(); assert.equal(ui.navigations, 1, "the older automatic intent cannot navigate a second time"); assert.equal(ui.posts().length, 0);
});
