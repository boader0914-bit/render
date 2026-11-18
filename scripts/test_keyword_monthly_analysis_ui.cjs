"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const uiModule = require("../web/keyword-monthly-analysis.js");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const script = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-analysis.js"), "utf8");
const benchmarkScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-benchmark.js"), "utf8");
const dashboardScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-dashboard-model.js"), "utf8");
const catalogueScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-catalogue-cache.js"), "utf8");
const viewState = require("../web/admin-view-state.js");
const NOW = "2026-10-30T03:00:00.000Z", KEYWORD = "경남글램핑", OTHER = "경남 글램핑";
const clone = value => JSON.parse(JSON.stringify(value));
const optionsFixture = () => ({ schemaVersion: 1, status: "available", currentDay: "2026-10-30", currentMonth: "2026-10",
  keywords: [{ keyword: KEYWORD, stayMonths: ["2026-09", "2026-10", "2026-11"], collectionMonths: ["2026-09", "2026-10"] }, { keyword: OTHER, stayMonths: ["2026-10"], collectionMonths: ["2026-10"] }], diagnostics: [] });
function sourceFixture(keyword = KEYWORD) {
  const observations = [], runs = [];
  for (const [id, stayDate, collectedAt, sold, dayuseSold] of [["sep", "2026-09-20", "2026-09-20T00:00:00Z", 2, 1], ["oct", "2026-10-20", "2026-10-20T00:00:00Z", 4, 3], ["future", "2026-11-05", "2026-10-29T00:00:00Z", 3, 2]]) {
    runs.push({ id, keyword, collectedAt, collectionQuality: { status: "complete" } });
    for (const productType of ["lodging", "dayuse"]) { const count = productType === "lodging" ? sold : dayuseSold;
      observations.push({ observationId: `${id}:${productType}`, companyId: "a", runId: id, keyword, productType, stayDate, collectedAt, inventoryEvidenceVersion: 4,
        supply: 5, sold: count, publicBookings: count, phoneBookings: 0, publicRevenue: count * 100, phoneRevenue: 0, estimatedRevenue: count * 100,
        sharedDayUseExcluded: 0, explicitBlockedBookings: 0, phoneMissingPriceBookings: 0, partial: false, missing: false, unknownUnavailable: 0,
        dayUsePresence: "present", dayUseScheduleStatus: "requested", dayUseSharingStatus: "not_shared", capacityBasis: { count: 5, source: "db_correction" } }); }
  }
  return { companies: [{ companyId: "a", primaryName: `${keyword} 업체`, capacity: 5, capacitySource: "db_correction" }], runs, observations, rankObservations: [], warnings: [], sourceDiagnostics: {} };
}
function payloadFixture(selection = { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }) {
  const source = sourceFixture(selection.keyword), request = { type: "keyword", targetId: selection.keyword, month: selection.month, cutoffDate: selection.cutoffDate };
  const snapshot = buildMonthlyReportSnapshot(request, source, NOW), previous = buildMonthlyReportSnapshot(previousMonthlyReportRequest(request), source, NOW);
  snapshot.comparison = buildMonthlyComparison(snapshot, previous);
  snapshot.comparisonByProduct = { lodging: snapshot.comparison, dayuse: buildMonthlyComparison(snapshot, previous, { productType: "dayuse" }) };
  return { schemaVersion: 1, status: "available", request: selection, snapshot,
    activity: { basis: "collection_month", scope: "제공 run 집합에서 확인한 고유 회차", runInventoryComplete: false, rows: [{ month: "2026-09", runCount: 1, freshRunCount: 1, reusedRunCount: 0, failedRunCount: 0, partialRunCount: 0, unknownRunCount: 0 }, { month: "2026-10", runCount: 3, freshRunCount: 2, reusedRunCount: 0, failedRunCount: 1, partialRunCount: 0, unknownRunCount: 0 }] },
    latestAttempt: { status: "failed", observedAt: "2026-10-30T00:00:00Z", errorCode: "PROVIDER_BLOCKED" }, lastSuccessfulAttempt: { status: "complete", observedAt: "2026-10-20T00:00:00Z" },
    provenance: { materializedAt: NOW, dataThrough: "2026-10-30T00:00:00Z", inputSha256: "a".repeat(64), originalFreshnessVerified: false, observationScope: "selected_only", intermediateObservationsComplete: false }, diagnostics: [] };
}
const identityReviewFixture = (extra = {}) => ({ schemaVersion: 1, basis: "raw_unresolved_identity_rows", totalRows: 18, alreadyRepresentedRows: 10, recoveredRows: 3, unresolvedRows: 5,
  reasonCounts: { SOURCE_ID_UNKNOWN: 3, COUNTERPART_TIME_MISMATCH: 2 }, evidenceDigest: "a".repeat(64), catalogDigest: "b".repeat(64), ...extra });

class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ""; this._text = ""; this.value = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this.classList = { contains: key => this.className.split(/\s+/).includes(key) }; }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; } get textContent() { return this._text; }
  append(...values) { for (const node of values) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...values) { this._text = ""; this.children = []; this.append(...values); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  focus(settings) { this.ownerDocument.activeElement = this; this.focusOptions = settings; }
  setSelectionRange(start, end, direction = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  scrollIntoView(settings) { this.ownerDocument.scrolls.push({ node: this, settings }); }
  addEventListener(key, callback) { (this.listeners[key] ||= []).push(callback); }
  get isConnected() { let root = this; while (root.parentNode) root = root.parentNode; return root === this.ownerDocument.body; }
  getClientRects() { let node = this; while (node) { if (node.hidden || node.screenHidden) return []; node = node.parentNode; } return [{}]; }
  async fire(type) { if (type === "click" && this.disabled) return; for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {} }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join(" ");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function mockUi({ hidden = false, role = "role-admin", request: customRequest, chartMount, mobile = false, requestTimeoutMs, autoRefreshIntervalMs, autoRefreshTimeoutMs,
  setTimeout: schedule = setTimeout, clearTimeout: unschedule = clearTimeout, now = () => Date.parse(NOW), storage, session, customerView = false,
  requestAnimationFrame, cancelAnimationFrame, performance, viewport } = {}) {
  const listeners = {}, observers = [], calls = [], chartCalls = [], benchmarkCalls = [], doc = { hidden: false, scrolls: [], addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement("body"); doc.body.className = role;
  const parent = doc.createElement("div"); parent.screenHidden = hidden; doc.body.append(parent);
  async function request(url, settings) { calls.push({ url, settings }); if (customRequest) return customRequest(url, settings); const query = new URL(url, "https://local.test"); return { ok: true, status: 200, json: async () => clone(url.endsWith("/catalogue") ? optionsFixture() : payloadFixture(Object.fromEntries(query.searchParams))) }; }
  const windowListeners = {}, windowScrolls = [];
  const window = { fetch: request, setTimeout: schedule, clearTimeout: unschedule, AbortController, sessionStorage: storage,
    requestAnimationFrame, cancelAnimationFrame, performance,
    innerWidth: viewport?.width, scrollX: viewport?.x, scrollY: viewport?.y,
    addEventListener(type, fn) { (windowListeners[type] ||= new Set()).add(fn); }, removeEventListener(type, fn) { windowListeners[type]?.delete(fn); },
    scrollTo({ left, top }) { windowScrolls.push({ x: left, y: top }); this.scrollX = left; this.scrollY = top; },
    crypto: require("node:crypto").webcrypto, TextEncoder, AdminViewState: viewState, matchMedia: query => ({ matches: mobile && query.includes("767px") }), KeywordMonthlyCharts: { mount(container, config) { chartCalls.push({ container, config }); return chartMount ? chartMount(container, config) : Promise.resolve(); } } };
  class MutationObserver { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  vm.runInNewContext(benchmarkScript, { window });
  const calculateBenchmark = window.KeywordMonthlyBenchmark.buildKeywordMonthlyBenchmark;
  window.KeywordMonthlyBenchmark = { ...window.KeywordMonthlyBenchmark, buildKeywordMonthlyBenchmark(snapshot, settings) { benchmarkCalls.push({ snapshot, settings: { ...settings } }); return calculateBenchmark(snapshot, settings); } };
  vm.runInNewContext(dashboardScript, { window });
  vm.runInNewContext(catalogueScript, { window, Date });
  vm.runInNewContext(script, { window, document: doc, MutationObserver, Date, Intl, URLSearchParams, console });
  const api = window.KeywordMonthlyAnalysis, ready = session ? api.configure(session, { customerView }) : Promise.resolve(false), controller = api.mount(parent, {
    autoStart: false, fetch: request, requestTimeoutMs, autoRefreshIntervalMs, autoRefreshTimeoutMs, setTimeout: schedule, clearTimeout: unschedule, now });
  return { api, controller, ready, parent, doc, observers, listeners, calls, chartCalls, benchmarkCalls, window, windowScrolls, windowListeners,
    fireWindow(type) { for (const handler of windowListeners[type] || []) handler({ type }); },
    find(cls) { return descendants(parent).filter(node => node.className.split(/\s+/).includes(cls)); }, field(name) { return descendants(parent).find(node => node.name === name); },
    button(label) { return descendants(parent).find(node => node.tagName === "BUTTON" && node.textContent === label); }, text() { return text(parent); },
    async apply() { await this.button("저장 자료 조회").fire("click"); await settle(); } };
}

test("exact-keyword catalog exposes only observed months and preserves distinct raw spellings", () => {
  const value = uiModule.normalizeOptions(optionsFixture()); assert.deepEqual(value.keywords.map(row => row.keyword), [KEYWORD, OTHER]);
  assert.deepEqual(value.keywords[0].stayMonths, ["2026-11", "2026-10", "2026-09"]); assert(!value.keywords[0].stayMonths.includes("2026-08"));
  assert.equal(uiModule.phaseLabel("2026-11", "2026-10"), "사전 관측"); assert.equal(uiModule.phaseLabel("2026-10", "2026-10"), "누적 중");
});
test("missing observations and prices stay unknown while genuine observed zero remains zero", () => {
  assert.equal(uiModule.number(null), "—"); assert.equal(uiModule.number(undefined), "—"); assert.equal(uiModule.number("0"), "—"); assert.equal(uiModule.number(0), "0");
  assert.equal(uiModule.metricView({ coveredCompanyDays: 0, sold: 0, supply: 0, estimatedRevenue: 0 }).sold, null);
  assert.equal(uiModule.metricView({ coveredCompanyDays: 1, sold: 0, supply: 5, estimatedRevenue: null }).sold, 0);
  assert.equal(uiModule.metricView({ coveredCompanyDays: 1, sold: 0, supply: 5, estimatedRevenue: null }).estimatedRevenue, null);
  assert.equal(uiModule.metricView(null).supply, null);
});
test("view model preserves engine monthly values and separates lodging/dayuse comparisons and activity scope", () => {
  const payload = payloadFixture(), model = uiModule.buildViewModel(payload, payload.request, "2026-10");
  assert.equal(model.usable, true); assert.equal(model.summary.lodging.sold, 4); assert.equal(model.summary.dayuse.sold, 3);
  assert.equal(model.comparisons.dayuse.productType, "dayuse"); assert.equal(model.comparisons.dayuse.common.matched.current.sold, 3);
  assert.equal(model.comparisons.lodging.common.matched.current.sold, 4); assert.equal(model.runInventoryComplete, false);
  assert.equal(model.daily.find(row => row.date === "2026-10-01").lodging.sold, null);
});
test("stale, missing, verification errors, mismatched scopes and duplicate days cannot display successful metrics", () => {
  for (const status of ["missing", "stale", "needs_verification"]) { const value = payloadFixture(); value.status = status; const model = uiModule.buildViewModel(value, value.request, "2026-10"); assert.equal(model.usable, false); assert.equal(model.snapshot, null); }
  const wrong = payloadFixture(); wrong.request.keyword = OTHER; assert.equal(uiModule.buildViewModel(wrong, { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, "2026-10").usable, false);
  const duplicate = payloadFixture(); duplicate.snapshot.daily.push(duplicate.snapshot.daily[0]); assert.equal(uiModule.buildViewModel(duplicate, duplicate.request, "2026-10").status, "needs_verification");
});
test("mounted view performs only authenticated no-store GET and renders no lifecycle or collection actions", async () => {
  const ui = mockUi(); await ui.controller.open(); assert.equal(ui.calls.length, 2); assert.equal(ui.calls[0].url, "/api/keyword-monthly/catalogue");
  assert.equal(new URL(ui.calls[1].url, "https://local.test").searchParams.get("keyword"), KEYWORD);
  assert.ok(ui.calls.every(call => call.settings.method === "GET" && call.settings.credentials === "same-origin" && call.settings.cache === "no-store" && !call.settings.body));
  assert.match(ui.text(), /일별 관측 추이|업체별 월간 소계|전월 공통 표본 비교/); assert.match(ui.text(), /사본에 포함된 고유 관측 회차/); assert.match(ui.text(), /전체 시도·실패 목록은 미확인/);
  assert.match(ui.text(), /마지막 유효 관측|PROVIDER_BLOCKED/); assert.doesNotMatch(ui.text(), /초안으로 저장|리포트 발행|수집 시작|자료 보완 실행/);
  assert.equal(ui.find("kma-workspace")[0].children.length, 2); assert.equal(ui.find("kma-detail-panel")[0].children.length >= 6, true);
});
test("only catalog months can be requested and real future stay observations are labeled separately", async () => {
  const ui = mockUi(); await ui.controller.open(); ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await settle();
  assert.equal(ui.calls.length, 2); assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().draft.month, "2026-11"); await ui.apply(); assert.match(ui.text(), /사전 관측/);
  assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
  const count = ui.calls.length; ui.field("month").value = "2027-01"; await ui.field("month").fire("change"); await ui.apply(); assert.equal(ui.calls.length, count); assert.match(ui.text(), /실제 관측 숙박월을 선택/);
});
test("exact keyword and product changes keep snapshots separate and product changes never request again", async () => {
  const ui = mockUi(); await ui.controller.open(); await ui.button("데이유즈").fire("click"); assert.equal(ui.calls.length, 2); assert.equal(ui.controller.state().product, "dayuse"); assert.match(ui.text(), /예약 추정 \(회\)/);
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await settle(); assert.equal(ui.calls.length, 2); assert.equal(ui.controller.state().selection.keyword, KEYWORD); await ui.apply();
  assert.equal(new URL(ui.calls.at(-1).url, "https://local.test").searchParams.get("keyword"), OTHER); assert.match(ui.text(), /경남 글램핑 업체/);
});
test("company selection compares whole inclusive and peer means locally without extra requests", async () => {
  const value = payloadFixture(), source = sourceFixture(); source.companies.push({ companyId: "b", primaryName: "다른 업체" });
  source.observations.push(...source.observations.map(row => ({ ...row, companyId: "b", observationId: `${row.observationId}:b`, sold: 1, publicBookings: 1, phoneBookings: 0, publicRevenue: 100, phoneRevenue: 0, estimatedRevenue: 100 })));
  value.snapshot = buildMonthlyReportSnapshot({ type: "keyword", targetId: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, source, NOW);
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }) });
  await ui.controller.open(); const beforeCalls = ui.calls.length;
  const details = ui.find("kma-benchmark")[0].parentNode; details.open = true; await details.fire("toggle");
  assert.match(text(ui.find("kma-benchmark")[0]), /전체 평균에는 선택 업체를 포함/); assert.match(text(ui.find("kma-benchmark")[0]), /공급 가중/); assert.match(text(ui.find("kma-benchmark")[0]), /업체 동일가중 참고 평균/);
  assert.equal(ui.controller.state().benchmarkCompanyId, "a"); ui.field("benchmarkCompany").value = "b"; await ui.field("benchmarkCompany").fire("change");
  assert.equal(ui.controller.state().benchmarkCompanyId, "b"); assert.equal(ui.calls.length, beforeCalls);
  const bars = text(ui.find("kma-benchmark-bars")[0]); assert.match(bars, /다른 업체 20%/); assert.match(bars, /전체 표본 · 선택 업체 포함 50%/); assert.match(bars, /다른 표본 · 선택 업체 제외 80%/);
  assert.match(ui.text(), /선택 업체 − 전체 평균: -30%p/);
  await ui.button("데이유즈").fire("click"); assert.equal(ui.calls.length, beforeCalls); assert.equal(ui.controller.state().benchmarkCompanyId, "b");
  ui.api.clear(); assert.equal(ui.controller.state().benchmarkCompanyId, ""); assert.equal(ui.find("kma-benchmark").length, 0);
});
test("saved read renews catalog/cutoff and preserves month/product instead of using a stale in-page list", async () => {
  let day = "2026-10-30";
  const ui = mockUi({ request: async url => {
    if (url.endsWith("/catalogue")) return { ok: true, status: 200, json: async () => ({ ...optionsFixture(), currentDay: day, refreshStatus: { status: "available", errorCode: null, started: true, counts: { running: 0, queued: 1, deferred: 0 } } }) };
    const u = new URL(url, "https://local.test"), q = Object.fromEntries(u.searchParams); return { ok: true, status: 200, json: async () => payloadFixture(q) };
  } });
  await ui.controller.open(); await ui.button("데이유즈").fire("click"); day = "2026-10-31";
  await ui.button("저장 자료 조회").fire("click"); await settle();
  assert.equal(ui.calls.filter(x => x.url.endsWith("/catalogue")).length, 2);
  assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-31"); assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().product, "dayuse");
  assert.match(ui.text(), /현재 갱신 작업/); assert.match(ui.text(), /이전 버전 기록/);
});
test("refresh verification warning never replaces valid saved amounts with zero or starts a job", async () => {
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue")
    ? { ...optionsFixture(), refreshStatus: { status: "needs_verification", counts: null } } : payloadFixture() }) });
  await ui.controller.open(); assert.match(ui.text(), /자동 반영 확인 필요/); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /400원/);
});
test("historical failures stay visible while current-version processing is reported separately without claiming freshness", async () => {
  const status = { status: "needs_verification", started: true, initialized: true, closed: false, errorCode: null, counts: { complete: 52, needs_verification: 20, queued: 1 },
    currentVersionCounts: { queued: 1, deferred: 0, running: 0, complete: 0, needs_verification: 0 }, historicalNeedsVerification: 20,
    historicalCountsByVersion: { "keyword-monthly-refresh-v1": { queued: 0, deferred: 0, running: 0, complete: 52, needs_verification: 20 } } };
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue")
    ? { ...optionsFixture(), refreshStatus: status } : payloadFixture() }) });
  await ui.controller.open(); assert.match(ui.text(), /이전 버전 기록 · 이월 0 \/ 검수 필요 20/); assert.match(ui.text(), /현재 갱신 작업 · 처리 0 \/ 대기 1 \/ 이월 0 \/ 검수 필요 0/);
  assert.match(ui.text(), /선택 자료의 실제 반영 범위/); assert.doesNotMatch(ui.text(), /최신 반영 완료/); assert.match(ui.text(), /400원/); assert.equal(ui.calls.length, 2);
  for (const patch of [{ errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { errorCode: undefined }, { errorCode: {} }, { status: "unexpected", errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { status: "available", errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { cleanup: { status: "needs_verification" } }, { cleanup: { status: "unknown" } }, { currentVersionCounts: { needs_verification: 1 } }, { currentVersionCounts: null }, { currentVersionCounts: { running: -1 } }, { closed: true }, { started: false }, { initialized: false }]) {
    const blocked = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue")
      ? { ...optionsFixture(), refreshStatus: { ...status, ...patch } } : payloadFixture() }) });
    await blocked.controller.open(); assert.match(blocked.text(), /자동 반영 확인 필요/); assert.match(blocked.text(), /이전 버전 기록 · 이월 0 \/ 검수 필요 20/); assert.match(blocked.text(), /현재 갱신 작업/);
  }
});

function refreshHistoryFixture() {
  const counts = patch => ({ queued: 0, deferred: 0, running: 0, complete: 0, needs_verification: 0, ...patch });
  const groups = [
    ["keyword-monthly-refresh-v1", "needs_verification", "KEYWORD_MONTHLY_REFRESH_OTHER_PREPARATION_PRESENT", 15],
    ["keyword-monthly-refresh-v1", "needs_verification", "KEYWORD_MONTHLY_SOURCE_COPY_BOUND", 5],
    ["keyword-monthly-refresh-compressed-v2", "deferred", "KEYWORD_REFRESH_COLLECTION_BUSY", 6],
    ["keyword-monthly-incremental-v3", "needs_verification", "ISOLATION_SOCKET_OR_UNSAFE_STDIO", 7],
    ["keyword-monthly-incremental-v4", "needs_verification", "KEYWORD_INCREMENTAL_WORKER_LOCKED", 1]
  ].map(([version, status, reasonCode, count]) => ({ version, status, reasonCode, count, sameEventLaterCompleted: count, priorExactComplete: 0, notCovered: 0, unknown: 0 }));
  return { status: "needs_verification", started: true, initialized: true, closed: false, errorCode: null, cleanup: null,
    counts: { complete: 75, deferred: 6, needs_verification: 28 }, currentVersionCounts: { complete: 1 }, historicalNeedsVerification: 28,
    historicalCountsByVersion: { "keyword-monthly-refresh-v1": { complete: 68, needs_verification: 20 }, "keyword-monthly-refresh-compressed-v2": { deferred: 6 },
      "keyword-monthly-incremental-v3": { needs_verification: 7 }, "keyword-monthly-incremental-v4": { complete: 6, needs_verification: 1 } },
    currentVersionReasonCounts: [], historicalReview: { schemaVersion: 1, readOnly: true, currentScopeFreshnessVerified: false, originalJournalRowsChanged: false, retryAuthorized: false, invalidRows: 0, allRowsCoverage: true,
      rowsExamined: 109, historicalRows: 108, reviewedRows: 34, sameEventLaterCompleted: 34, priorExactComplete: 0, notCovered: 0, unknown: 0, groups,
      currentVersionCounts: counts({ complete: 1 }), historicalCountsByVersion: { "keyword-monthly-refresh-v1": counts({ complete: 68, needs_verification: 20 }),
        "keyword-monthly-refresh-compressed-v2": counts({ deferred: 6 }), "keyword-monthly-incremental-v3": counts({ needs_verification: 7 }),
        "keyword-monthly-incremental-v4": counts({ complete: 6, needs_verification: 1 }) } } };
}
const refreshUi = status => mockUi({ request: async url => ({ ok: true, status: 200,
  json: async () => url.endsWith("/catalogue") ? { ...optionsFixture(), refreshStatus: status } : payloadFixture() }) });

test("full journal review separates current zero pending from six historical deferrals and28 reviews", async () => {
  const status = refreshHistoryFixture(), ui = refreshUi(status); await ui.controller.open();
  assert.match(text(ui.find("kma-refresh-current")[0]), /처리 0 \/ 대기 0 \/ 이월 0 \/ 검수 필요 0/);
  assert.match(text(ui.find("kma-refresh-historical")[0]), /이월 6 \/ 검수 필요 28/);
  assert.equal(ui.find("kma-refresh-warning").length, 0); assert.equal(ui.find("kma-refresh-history")[0].tagName, "DETAILS");
  assert.match(ui.text(), /원기록을 보존하며 재실행하지 않습니다/); assert.match(ui.text(), /같은 입력의 후속 완료 기록 34/);
  assert.match(ui.text(), /같은 입력의 완료 기록과 현재 선택 자료의 최신 반영 여부는 별개/);
  for (const word of ["다른 준비 작업", "자료 복사 용량", "입출력 검증", "작업 잠금 보호", "수집 보호·예약 간격"]) assert.ok(ui.text().includes(word));
  assert.match(ui.text(), /400원/); assert.equal(ui.calls.length, 2); assert.ok(ui.calls.every(call => call.settings.method === "GET"));
  assert.doesNotMatch(ui.text(), /최신 반영 완료|34건 정상 완료로 변경/);
});

test("sparse or unavailable count metadata stays unknown instead of claiming no pending work", async () => {
  for (const patch of [{ historicalReview: null }, { historicalReview: undefined }, { historicalReview: null, currentVersionCounts: { complete: 1, queued: "0" } }]) {
    const status = { ...refreshHistoryFixture(), ...patch }, ui = refreshUi(status); await ui.controller.open();
    assert.match(text(ui.find("kma-refresh-current")[0]), /처리 미확인 \/ 대기 미확인 \/ 이월 미확인 \/ 검수 필요 미확인/);
    assert.match(ui.text(), /자동 반영 확인 필요/); assert.match(ui.text(), /이전 버전 기록/);
    assert.doesNotMatch(ui.text(), /현재 갱신 작업 · 처리 0/); assert.match(ui.text(), /확인하지 못한 건수를 0으로 표시하지 않습니다/);
  }
});

test("historical linkage metadata rejects inconsistent coverage and cannot claim current-scope freshness", async () => {
  for (const mutate of [review => { review.currentScopeFreshnessVerified = true; }, review => { review.sameEventLaterCompleted = 33; review.priorExactComplete = 1; },
    review => { review.rowsExamined++; }, review => { delete review.currentVersionCounts.deferred; }, review => { review.groups[0].count = -1; },
    review => { review.invalidRows = 1; }, review => { review.originalJournalRowsChanged = true; }, review => { review.retryAuthorized = true; }]) {
    const status = refreshHistoryFixture(); mutate(status.historicalReview);
    const normalized = uiModule.normalizeOptions({ ...optionsFixture(), refreshStatus: status }); assert.equal(normalized.refreshStatus.historicalReview, null);
    const ui = refreshUi(status); await ui.controller.open(); assert.doesNotMatch(ui.text(), /같은 입력의 후속 완료 기록 34/); assert.match(ui.text(), /분류 근거가 전체 원장을 포함하는지 미확인/);
  }
});

test("prior exact completions are distinct from later completions and neither overrides runtime protection", async () => {
  const status = refreshHistoryFixture(); status.historicalReview.sameEventLaterCompleted = 19; status.historicalReview.priorExactComplete = 15;
  status.historicalReview.groups[0].sameEventLaterCompleted = 0; status.historicalReview.groups[0].priorExactComplete = 15;
  const ui = refreshUi(status); await ui.controller.open(); assert.match(ui.text(), /후속 완료 기록 19 \/ 기존 완료 기록 15/);
  for (const patch of [{ errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { closed: true }, { started: false }, { initialized: false }, { cleanup: { status: "needs_verification" } }]) {
    const blocked = refreshUi({ ...status, ...patch }); await blocked.controller.open(); assert.match(blocked.text(), /자동 반영 확인 필요/);
    assert.match(blocked.text(), /현재 갱신 작업/); assert.match(blocked.text(), /이전 버전 기록 · 이월 6 \/ 검수 필요 28/); assert.match(blocked.text(), /400원/);
  }
});

test("a current verification job and its reason stay visible despite completed historical inputs", async () => {
  const status = refreshHistoryFixture(); status.historicalReview.currentVersionCounts = { queued: 0, deferred: 0, running: 0, complete: 0, needs_verification: 1 };
  status.currentVersionReasonCounts = [{ status: "needs_verification", reasonCode: "KEYWORD_INCREMENTAL_WORKER_LOCKED", count: 1 }];
  const ui = refreshUi(status); await ui.controller.open(); assert.match(text(ui.find("kma-refresh-current")[0]), /검수 필요 1/);
  assert.match(ui.text(), /자동 반영 확인 필요/); assert.match(ui.text(), /현재 검수 필요 1건 · 작업 잠금 보호로 보류/);
  assert.match(ui.text(), /같은 입력의 후속 완료 기록 34/); assert.match(ui.text(), /현재 선택 자료의 최신 반영 여부는 별개/);
});

for (const [reasonCode, label] of [
  ["KEYWORD_RECONSTRUCT_OUTSIDE_READ_DENIED", "읽기 격리 보호로 중단"],
  ["KEYWORD_INCREMENTAL_INPUTS_CHANGED", "집계 중 저장 입력이 변경되어 보류"]
]) test("current input guard reason remains human readable with raw code and protection: " + reasonCode, async () => {
  const status = refreshHistoryFixture(); status.historicalReview.currentVersionCounts = { queued: 0, deferred: 0, running: 0, complete: 0, needs_verification: 1 };
  status.currentVersionReasonCounts = [{ status: "needs_verification", reasonCode, count: 1 }];
  const ui = refreshUi(status); await ui.controller.open();
  const before = clone(ui.controller.state()), tables = () => descendants(ui.find("kma-results")[0]).filter(node => node.tagName === "TABLE").map(node => text(node)), beforeTables = tables();
  assert.ok(ui.text().includes(label)); assert.ok(ui.text().includes(reasonCode)); assert.match(text(ui.find("kma-refresh-current")[0]), /검수 필요 1/);
  assert.match(ui.text(), /자동 반영 확인 필요/); assert.match(ui.text(), /같은 입력의 후속 완료 기록 34/); assert.match(ui.text(), /400원/);
  await ui.controller.refresh(); assert.deepEqual(tables(), beforeTables);
  assert.deepEqual(clone(ui.controller.state().selection), before.selection); assert.equal(ui.controller.state().product, before.product);
  assert.equal(ui.controller.state().benchmarkCompanyId, before.benchmarkCompanyId); assert.equal(ui.controller.state().listPage, before.listPage);
  assert.ok(ui.calls.every(call => call.settings.method === "GET")); assert.ok(ui.calls.length > 2);
});

test("history classification never changes applied scope product company or calculated result tables", async () => {
  const status = refreshHistoryFixture(), ui = refreshUi(status); await ui.controller.open();
  const before = clone(ui.controller.state()), sold = uiModule.buildViewModel(payloadFixture(), payloadFixture().request, "2026-10").summary.lodging.sold;
  const tableState = () => descendants(ui.find("kma-results")[0]).filter(node => node.tagName === "TABLE").map(node => text(node));
  const tables = tableState(); await ui.controller.refresh();
  assert.deepEqual(tableState(), tables); assert.equal(ui.controller.state().benchmarkCompanyId, before.benchmarkCompanyId);
  assert.equal(ui.controller.state().listPage, before.listPage); assert.equal(ui.controller.state().product, before.product);
  assert.deepEqual(clone(ui.controller.state().selection), before.selection); assert.equal(sold, 4);
  assert.ok(ui.calls.every(call => call.settings.method === "GET"));
});
test("invalid or future cutoff produces an explanation without another request", async () => {
  const ui = mockUi(); await ui.controller.open(); for (const value of ["2026-02-30", "2026-10-31"]) { ui.field("cutoffDate").value = value; await ui.field("cutoffDate").fire("change"); await ui.apply(); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /관측 마감일은 오늘 이하/); }
});
test("missing and stale responses retain reasons and metadata, not earlier successful amounts", async () => {
  let status = "available"; const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : { ...payloadFixture(), status, diagnostics: [status === "stale" ? "CUTOFF_AFTER_DATA_THROUGH" : "MONTH_NOT_OBSERVED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /공개 예약/); status = "stale"; await ui.controller.refresh(); assert.match(ui.text(), /CUTOFF_AFTER_DATA_THROUGH/); assert.doesNotMatch(ui.text(), /공개 예약/); assert.equal(ui.find("kma-metric").length, 0);
  status = "missing"; await ui.controller.refresh(); assert.match(ui.text(), /조회용 저장 집계가 준비되지/); assert.equal(ui.find("kma-metric").length, 0);
});

test("expired preparation stays visibly historical without allowing cutoffs after its evidence", async () => {
  const catalog = optionsFixture(); catalog.status = "stale"; catalog.diagnostics = ["PROJECTION_EXPIRED", "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT"];
  const value = payloadFixture(); value.status = "stale"; value.diagnostics = ["PROJECTION_EXPIRED"];
  const model = uiModule.buildViewModel(value, value.request, "2026-10");
  assert.equal(model.usable, true); assert.equal(model.status, "stale"); assert.equal(model.historicalSnapshot, true);
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? catalog : value }) });
  await ui.controller.open(); assert.ok(ui.find("kma-metric").length > 0); assert.match(ui.text(), /과거 저장근거 · 갱신 확인 필요/);
  assert.match(ui.text(), /일부 키워드·숙박월의 저장 자료는 갱신 확인이 필요합니다/);
  assert.doesNotMatch(ui.text(), /KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT/);
  assert.match(ui.text(), /이후 수집 반영이나 현재 최신 상태를 확인한 값이 아닙니다/);
  value.diagnostics.push("CUTOFF_AFTER_DATA_THROUGH");
  await ui.controller.refresh(); assert.equal(ui.find("kma-metric").length, 0); assert.match(ui.text(), /자료 마감보다 늦습니다/);
  value.diagnostics = ["PROJECTION_EXPIRED"]; value.snapshot.request.targetId = OTHER;
  assert.equal(uiModule.buildViewModel(value, value.request, "2026-10").status, "needs_verification");
});
test("503 verification payload preserves safe failure reasons and never becomes zero", async () => {
  const ui = mockUi({ request: async url => ({ ok: url.endsWith("/catalogue"), status: url.endsWith("/catalogue") ? 200 : 503, json: async () => url.endsWith("/catalogue") ? optionsFixture() : { status: "needs_verification", request: { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, snapshot: null, diagnostics: ["KEYWORD_MONTHLY_EVIDENCE_CHANGED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /자료 검수가 필요/); assert.match(ui.text(), /KEYWORD_MONTHLY_EVIDENCE_CHANGED/); assert.equal(ui.find("kma-metric").length, 0);
});
test("authentication failure erases private choices and results and blocks later responses", async () => {
  let code = 200; const ui = mockUi({ request: async url => ({ ok: code === 200, status: code, json: async () => url.endsWith("/catalogue") ? optionsFixture() : payloadFixture() }) });
  await ui.controller.open(); code = 401; await ui.controller.refresh(); assert.equal(ui.field("keyword").value, ""); assert.equal(ui.field("month").value, ""); assert.equal(ui.controller.state().paused, true); assert.equal(ui.find("kma-metric").length, 0); assert.match(ui.text(), /관리자 로그인이 필요/);
});
test("a delayed previous keyword response cannot overwrite the newly selected keyword", async () => {
  const gate = deferred(); let count = 0;
  const ui = mockUi({ request: async url => { if (url.endsWith("/catalogue")) return { ok: true, status: 200, json: async () => optionsFixture() }; const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), current = ++count; return { ok: true, status: 200, json: async () => current === 2 ? gate.promise : payloadFixture(query) }; } });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle(); ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(payloadFixture()); await pending; assert.equal(ui.controller.state().selection.keyword, OTHER); assert.match(ui.text(), /경남 글램핑 업체/); assert.doesNotMatch(ui.text(), /경남글램핑 업체/);
});
test("pause discards in-flight responses and hidden views do not request until explicitly shown", async () => {
  const gate = deferred(); let count = 0;
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : ++count === 2 ? gate.promise : payloadFixture() }) });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle(); ui.api.pause(ui.parent); gate.resolve(payloadFixture()); await pending; assert.equal(ui.find("kma-metric").length, 0);
  const calls = ui.calls.length; await ui.controller.refresh(); assert.equal(ui.calls.length, calls); await ui.api.show(ui.parent); assert.equal(ui.find("kma-metric").length > 0, true);
  const hidden = mockUi({ hidden: true }); await hidden.controller.open(); assert.equal(hidden.calls.length, 0);
});
test("logout clear and role changes erase data and all generated content is text rather than executable markup", async () => {
  const ui = mockUi(); await ui.controller.open(); const malicious = '<img src=x onerror="bad()">';
  ui.api.clear(); assert.equal(ui.field("keyword").value, ""); assert.equal(ui.find("kma-metric").length, 0);
  await ui.controller.open(); ui.doc.body.className = "role-admin admin-user-view"; ui.observers[0].callback(); assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().paused, true);
  const forged = optionsFixture(); forged.keywords[0].keyword = malicious; const other = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? forged : payloadFixture({ keyword: malicious, month: "2026-10", cutoffDate: "2026-10-30" }) }) });
  await other.controller.open(); assert.match(other.text(), /<img src=x/); assert.equal(descendants(other.parent).some(node => node.tagName === "IMG"), false);
});

test("cutoff defaults follow actual evidence through-date and explicit selected-only reference cutoffs", () => {
  const input = optionsFixture(); input.provenance = { dataThrough: "2026-10-22T01:00:00Z" };
  let catalog = uiModule.normalizeOptions(input);
  assert.equal(uiModule.cutoffFor(catalog, KEYWORD, "2026-10"), "2026-10-22"); assert.equal(uiModule.cutoffFor(catalog, KEYWORD, "2026-11"), "2026-10-22"); assert.equal(uiModule.cutoffFor(catalog, KEYWORD, "2026-09"), "2026-09-30");
  input.keywords[0].defaultCutoffs = { "2026-09": "2026-09-22", "2026-10": "2026-10-22" }; input.keywords[0].supportedCutoffs = { ...input.keywords[0].defaultCutoffs }; catalog = uiModule.normalizeOptions(input);
  assert.equal(uiModule.cutoffFor(catalog, KEYWORD, "2026-09"), "2026-09-22"); assert.equal(catalog.keywords[0].supportedCutoffs["2026-10"], "2026-10-22");
  delete input.keywords[0].defaultCutoffs; delete input.keywords[0].supportedCutoffs;
  input.provenance.dataThrough = "2026-10-30T01:00:00Z"; input.keywords[0].provenanceByMonth = { "2026-10": { dataThrough: "2026-10-22T01:00:00Z" } };
  catalog = uiModule.normalizeOptions(input); assert.equal(uiModule.cutoffFor(catalog, KEYWORD, "2026-10"), "2026-10-22");
  assert.equal(uiModule.cutoffFor(catalog, OTHER, "2026-10"), "2026-10-30");
});

test("selected-only dates are honest fixed references and unsupported cutoffs offer an explicit supported GET", async () => {
  const observed = optionsFixture(); observed.provenance = { dataThrough: "2026-10-22T01:00:00Z", observationScope: "selected_only" };
  observed.keywords[0].defaultCutoffs = { "2026-09": "2026-09-22", "2026-10": "2026-10-22" }; observed.keywords[0].supportedCutoffs = { ...observed.keywords[0].defaultCutoffs };
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => { if (url.endsWith("/catalogue")) return observed; const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), supported = observed.keywords[0].supportedCutoffs[query.month];
    return supported && query.cutoffDate !== supported ? { status: "missing", request: query, snapshot: null, diagnostics: ["CUTOFF_NOT_RECONSTRUCTIBLE"], supportedCutoffDate: supported } : payloadFixture(query); } }) });
  await ui.controller.open(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-22"); assert.equal(ui.field("cutoffDate").readOnly, true); assert.match(ui.text(), /2026-10-22 마감만 지원/);
  ui.field("month").value = "2026-09"; await ui.field("month").fire("change"); assert.equal(ui.controller.state().selection.month, "2026-10"); await ui.apply(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-09-22");
  await ui.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-21" }); assert.match(ui.text(), /과거 상태를 재구성할 수 없습니다/); assert.equal(ui.find("kma-metric").length, 0);
  await ui.button("2026-10-22 근거로 조회").fire("click"); await settle(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-22"); assert.equal(ui.find("kma-metric").length > 0, true); assert.ok(ui.calls.every(call => call.settings.method === "GET"));
});

test("unavailable direct comparisons retain previous observations, common companies and all exclusion counts", async () => {
  const value = payloadFixture(), prior = value.snapshot.comparisonByProduct.lodging;
  prior.status = "unavailable"; prior.common.companyCount = 18; prior.common.matched.companyDays = 0;
  prior.common.matched.exclusions = { missingCorrespondingDay: 7, capacityOrSharingChanged: 4, observationTimingChanged: 9 };
  prior.common.matched.deltas.sold = null; prior.common.matched.deltas.estimatedRevenue = null;
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }) });
  await ui.controller.open(); const rendered = text(ui.find("kma-comparison")[0]), evidence = text(ui.find("kma-comparison-evidence")[0]);
  assert.match(rendered, /전월 숙박 관측 자료는 있지만 조건이 맞는 표본이 없어 직접 비교할 수 없습니다/);
  assert.match(rendered, /공통 관측 업체 18곳 · 조건 맞는 업체·일 0/); assert.doesNotMatch(rendered, /전월 관측 근거가 없습니다/);
  assert.match(evidence, /대응 숙박일 없음 7/); assert.match(evidence, /공급·공유·산정 기준 변경 4/); assert.match(evidence, /관측 선행일수 변경 9/);
  assert.doesNotMatch(rendered, /공통 조건 표본/);
  await ui.button("데이유즈").fire("click"); assert.match(text(ui.find("kma-comparison")[0]), /조건 맞는 업체·일 1/);
  assert.match(text(ui.find("kma-comparison-evidence")[0]), /대응 이용일 없음 0/); assert.equal(ui.calls.length, 2);
});

test("absent previous evidence keeps comparison counts unknown rather than inventing zero exclusions", async () => {
  const value = payloadFixture(); value.snapshot.comparisonByProduct.lodging = null; value.snapshot.comparison = null;
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }) });
  await ui.controller.open(); const rendered = text(ui.find("kma-comparison")[0]), evidence = text(ui.find("kma-comparison-evidence")[0]);
  assert.match(rendered, /확인 가능한 숙박 전월 관측 근거가 없습니다/); assert.match(rendered, /공통 관측 업체 —곳 · 조건 맞는 업체·일 —/);
  assert.match(evidence, /대응 숙박일 없음 —/); assert.match(evidence, /공급·공유·산정 기준 변경 —/); assert.match(evidence, /관측 선행일수 변경 —/);
  assert.doesNotMatch(evidence, /변경 0|없음 0/);
});

test("calendar aligns month dates by UTC date arithmetic without shifting Korean calendar weekdays", () => {
  const october = uiModule.calendarCells("2026-10", [], "lodging"), november = uiModule.calendarCells("2026-11", [], "lodging");
  assert.equal(october.length, 35); assert.deepEqual(october.slice(0, 4), [null, null, null, null]);
  assert.equal(october[4].date, "2026-10-01"); assert.equal(october[34].date, "2026-10-31");
  assert.equal(november[0].date, "2026-11-01"); assert.equal(november[29].date, "2026-11-30"); assert.deepEqual(november.slice(30), [null, null, null, null, null]);
  assert.equal(october[4].observed, false); assert.equal(october[4].reservationRate, null); assert.equal(october[4].coverageRate, null);
});

test("calendar keeps missing values gray, observed zero numeric and product selection sourced from the same daily rows", async () => {
  const value = payloadFixture(), zero = value.snapshot.daily.find(row => row.date === "2026-10-21");
  zero.lodging = { coveredCompanyDays: 1, expectedCompanyDays: 2, sold: 0, supply: 5, reservationRate: 0, coverageRate: 0.5 };
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => {
    if (url.endsWith("/catalogue")) return optionsFixture(); const selected = Object.fromEntries(new URL(url, "https://local.test").searchParams); return selected.month === "2026-10" ? value : payloadFixture(selected);
  } }) });
  await ui.controller.open(); const cell = date => ui.find("kma-calendar-cell").find(node => node.attributes["data-date"] === date);
  const valueOf = (date, cls) => descendants(cell(date)).find(node => node.className.split(/\s+/).includes(cls)).textContent;
  assert.equal(valueOf("2026-10-20", "kma-calendar-rate"), "80%"); assert.equal(valueOf("2026-10-21", "kma-calendar-rate"), "0%"); assert.equal(valueOf("2026-10-21", "kma-calendar-coverage"), "충족 50%");
  assert.equal(valueOf("2026-10-01", "kma-calendar-rate"), "—"); assert.match(cell("2026-10-01").className, /kma-calendar-missing/); assert.match(cell("2026-10-01").attributes["aria-label"], /미관측/);
  assert.equal(ui.find("kma-calendar-outside").length, 4); assert.ok(ui.find("kma-calendar-outside").every(node => node.attributes["aria-hidden"] === "true"));
  await ui.button("데이유즈").fire("click"); assert.equal(valueOf("2026-10-20", "kma-calendar-rate"), "60%"); assert.equal(valueOf("2026-10-21", "kma-calendar-rate"), "—"); assert.equal(ui.calls.length, 2);
  ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await ui.apply(); assert.match(ui.text(), /사전 관측/); assert.equal(ui.find("kma-calendar-cell")[0].attributes["data-date"], "2026-11-01");
});

function dashboardPayload(companyCount = 2, withUnknown = false) {
  const source = sourceFixture(), original = [...source.observations]; source.companies = []; source.observations = [];
  for (let index = 0; index < companyCount; index++) {
    const companyId = `company-${index}`; source.companies.push({ companyId, primaryName: `비교 업체 ${index}`, capacity: 5, capacitySource: "db_correction" });
    source.observations.push(...original.map(row => { const sold = index === 0 ? row.sold : 1; return { ...row, observationId: `${row.observationId}:${companyId}`, companyId, sold, publicBookings: sold, phoneBookings: 0, estimatedRevenue: sold * 100, publicRevenue: sold * 100, phoneRevenue: 0 }; }));
  }
  const value = payloadFixture(); value.snapshot = buildMonthlyReportSnapshot({ type: "keyword", targetId: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, source, NOW);
  if (withUnknown) value.snapshot.companies.push({ companyId: "rank-only", primaryName: "순위만 관측한 업체" });
  return value;
}
function dashboardRequest(value) { return async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }); }

test("one top-level company selector controls the dynamic heading and both charts without GET", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload()) }); await ui.controller.open(); await settle();
  const selectors = descendants(ui.parent).filter(node => node.name === "benchmarkCompany");
  assert.equal(selectors.length, 1); assert.equal(selectors[0].attributes["aria-label"], "비교할 업체");
  assert.equal(selectors[0].parentNode.parentNode.className.includes("kma-filters"), true);
  assert.equal(ui.find("kma-dashboard-title")[0].textContent, `${KEYWORD} · 2026-10 · 비교 업체 0 비교`);
  assert.equal(ui.find("kma-dashboard-metrics")[0].children.length, 4);
  assert.equal(ui.find("kma-dashboard-grid").length, 1); assert.equal(ui.find("kma-company-chart-panel").length, 1); assert.equal(ui.find("kma-flow-chart-panel").length, 1);
  const beforeRequests = ui.calls.length, beforeLine = ui.chartCalls.find(x => x.config.spec.type === "line").config;
  assert.equal(ui.chartCalls.find(x => x.config.spec.type === "horizontalStackedBar").config.rows[0].company, "● 비교 업체 0");
  assert.equal(beforeLine.rows.length, 31); assert.equal(beforeLine.rows.find(row => row.date === "2026-10-20")["비교 업체 0"], 0.8);
  ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change"); await settle();
  const afterLine = ui.chartCalls.filter(x => x.config.spec.type === "line").at(-1).config;
  assert.equal(ui.find("kma-dashboard-title")[0].textContent, `${KEYWORD} · 2026-10 · 비교 업체 1 비교`); assert.equal(ui.calls.length, beforeRequests);
  assert.equal(afterLine.rows.find(row => row.date === "2026-10-20")["비교 업체 1"], 0.2);
  const afterBar = ui.chartCalls.filter(x => x.config.spec.type === "horizontalStackedBar").at(-1).config.rows;
  assert.equal(afterBar.find(row => row.companyId === "company-1").company, "● 비교 업체 1");
  assert.equal(afterBar.find(row => row.companyId === "company-0").company, "비교 업체 0");
  assert.deepEqual(afterLine.rows.map(row => row["전체 표본 · 선택 업체 포함"]), beforeLine.rows.map(row => row["전체 표본 · 선택 업체 포함"]));
  assert.equal(ui.find("kma-company-chart").every(node => node.dataset.chartStatus === "mounted"), true);
});
test("actual chart configs preserve all companies beyond twenty, unknown roster and common percent axes", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(35, true)) }); await ui.controller.open(); await settle();
  const barCalls = ui.chartCalls.filter(x => x.config.spec.type === "horizontalStackedBar"), rows = barCalls.flatMap(x => x.config.rows);
  assert.equal(barCalls.length, 2); assert.equal(rows.length, 35); assert.equal(new Set(rows.map(row => row.companyId)).size, 35);
  assert.deepEqual(barCalls.map(x => x.config.rows.length), [30, 5]);
  for (const { config } of barCalls) {
    assert.deepEqual(clone(config.spec.x), ["공개 예약", "방막기·타채널 추정"]); assert.equal(config.spec.y, "company");
    assert.deepEqual(clone(config.spec.xDomain), [0, 1]); assert.deepEqual(clone(config.spec.colors), { "공개 예약": "#70bd9a", "방막기·타채널 추정": "#b68ade" });
    assert.equal(config.spec.showValues, true); assert.equal(config.spec.valueFormat.style, "percent");
    assert.ok(config.height >= 40 + config.rows.length * 20 && config.height <= 800);
    assert.ok(config.rows.every(row => typeof row["공개 예약"] === "number" && typeof row["방막기·타채널 추정"] === "number"));
  }
  assert.match(text(ui.find("kma-unknown-companies")[0]), /순위만 관측한 업체/);
  assert.equal(ui.field("benchmarkCompany").children.length, 36); assert.match(ui.text(), /전체 36개 업체의 저장 수치 보기/);
  const allDetails = ui.find("kma-chart-data")[0]; assert.match(text(allDetails), /순위만 관측한 업체/); assert.match(text(allDetails), /—/);
});
test("daily line keeps null date gaps and unknown selected values rather than drawing zero", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(2, true)) }); await ui.controller.open(); await settle();
  let line = ui.chartCalls.find(x => x.config.spec.type === "line").config;
  assert.equal(line.height, 340); assert.deepEqual(clone(line.spec.yDomain), [0, 1]); assert.equal(line.rows[0].date, "2026-10-01");
  assert.equal(line.rows[0]["비교 업체 0"], null); assert.equal(line.rows[0]["전체 표본 · 선택 업체 포함"], null);
  const count = ui.calls.length; ui.field("benchmarkCompany").value = "rank-only"; await ui.field("benchmarkCompany").fire("change"); await settle();
  line = ui.chartCalls.filter(x => x.config.spec.type === "line").at(-1).config;
  assert.equal(line.rows.every(row => row["순위만 관측한 업체"] === null), true);
  assert.equal(line.rows.find(row => row.date === "2026-10-20")["전체 표본 · 선택 업체 포함"], 0.5);
  assert.equal(ui.calls.length, count); assert.match(ui.text(), /미관측일은 선을 연결하거나 0으로 채우지 않습니다/);
});
test("chart adapter failure remains readable without extra request or successful chart status", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload()), chartMount: async () => { throw new Error("renderer unavailable"); } });
  await ui.controller.open(); await settle(); assert.equal(ui.calls.length, 2);
  assert.equal([...ui.find("kma-company-chart"), ...ui.find("kma-flow-chart")].every(node => node.dataset.chartStatus === "failed"), true);
  assert.match(ui.text(), /차트를 표시하지 못했습니다/); assert.match(text(ui.find("kma-chart-data")[0]), /비교 업체 0|전체 예약 추정률/);
  assert.match(ui.text(), /400원/); assert.match(ui.text(), /전월 공통 표본 비교/);
});
test("pending chart resolution cannot repaint private content after logout clear", async () => {
  const gate = deferred(), ui = mockUi({ request: dashboardRequest(dashboardPayload()), chartMount: container => gate.promise.then(() => { const node = container.ownerDocument.createElement("p"); node.textContent = "이전 업체 비공개"; container.append(node); }) });
  await ui.controller.open(); const prior = ui.chartCalls.map(x => x.container); ui.api.clear(); gate.resolve(); await settle();
  assert.equal(ui.field("benchmarkCompany").value, ""); assert.equal(ui.field("benchmarkCompany").children.length, 1);
  assert.equal(ui.find("kma-chart").length, 0); assert.doesNotMatch(ui.text(), /이전 업체 비공개|비교 업체 0/); assert.equal(prior.every(node => node.children.length === 0), true);
});
test("company choice survives a delayed saved-read reload while controls are disabled", async () => {
  const gate = deferred(), value = dashboardPayload(); let delayed = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? { ok: true, status: 200, json: async () => optionsFixture() } : delayed ? gate.promise : { ok: true, status: 200, json: async () => value } });
  await ui.controller.open(); ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change"); delayed = true;
  const refresh = ui.controller.refresh(); await settle(); assert.equal(ui.controller.state().benchmarkCompanyId, "company-1"); assert.equal(ui.field("benchmarkCompany").value, "company-1"); assert.equal(ui.field("benchmarkCompany").disabled, true);
  gate.resolve({ ok: true, status: 200, json: async () => value }); await refresh; await settle();
  assert.equal(ui.field("benchmarkCompany").value, "company-1"); assert.equal(ui.field("benchmarkCompany").disabled, false); assert.match(ui.find("kma-dashboard-title")[0].textContent, /비교 업체 1 비교/);
});

test("chart containers are connected before the actual adapter mount call", async () => {
  const connections = [], ui = mockUi({ request: dashboardRequest(dashboardPayload()), chartMount: async container => { connections.push(container.isConnected); } });
  await ui.controller.open(); await settle(); assert.equal(connections.length, 2); assert.deepEqual(connections, [true, true]);
});

test("real pinned Data checkedPayload accepts every emitted chart config and rejects wrong schema", async () => {
  const runtimeFile = path.join(__dirname, "../web/vendor/data-charts-1.2.1/data-analytics-plugin/1.2.1/charts/runtime.js");
  const runtime = await import(`data:text/javascript;base64,${fs.readFileSync(runtimeFile).toString("base64")}`);
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(35, true)) }); await ui.controller.open(); await settle();
  assert.equal(runtime.chartApiVersion, 3); assert.equal(typeof runtime.checkedPayload, "function");
  for (const { config } of ui.chartCalls) assert.doesNotThrow(() => runtime.checkedPayload(clone(config)));
  const bar = clone(ui.chartCalls.find(x => x.config.spec.type === "horizontalStackedBar").config);
  assert.throws(() => runtime.checkedPayload({ ...bar, spec: { ...bar.spec, type: "HorizontalStackedBar" } }));
  assert.throws(() => runtime.checkedPayload({ ...bar, spec: { ...bar.spec, colors: ["#70bd9a", "#b68ade"] } }));
});

test("supporting tables stay accessible in collapsed details while prior comparison remains visible", async () => {
  const ui = mockUi(); await ui.controller.open(); await settle();
  assert.equal(ui.find("kma-supporting-details").length, 6);
  assert.equal(ui.find("kma-supporting-details").every(node => node.tagName === "DETAILS" && !node.open), true);
  const benchmark = ui.find("kma-supporting-details")[0];
  assert.match(text(benchmark), /업체 선택 · 전체 평균 비교|전체 평균에는 선택 업체를 포함/);
  assert.equal(ui.find("kma-benchmark-bars").length, 0);
  benchmark.open = true; await benchmark.fire("toggle"); assert.match(text(benchmark), /업체 동일가중 참고 평균|공급 가중/);
  assert.equal(ui.find("kma-comparison")[0].parentNode.className, "kma-detail-panel");
  assert.match(ui.text(), /출처와 채택·제외 근거|입력 근거 지문/);
});

const BENCHMARK_DETAIL_KEY = "support:업체 선택 · 전체 평균 비교";
test("closed benchmark defers its extra monthly calculation and builds only once on first open", async t => {
  const value = dashboardPayload(), ui = mockUi({ request: dashboardRequest(value) }); t.after(() => ui.controller.destroy());
  await ui.controller.open(); await settle();
  const block = ui.find("kma-benchmark")[0], details = block.parentNode;
  assert.equal(details.open, false); assert.equal(ui.find("kma-benchmark-bars").length, 0);
  assert.equal(ui.benchmarkCalls.filter(row => row.snapshot === value.snapshot).length, 1, "dashboard remains eager; supporting benchmark does not run");
  assert.match(text(block), /전체 평균에는 선택 업체를 포함/);
  assert.equal(ui.find("kma-dashboard-metrics")[0].children.length, 4); assert.equal(ui.chartCalls.length, 2);
  assert.match(ui.text(), /입력 근거 지문/); assert.ok(ui.find("kma-identity-review").length);
  const requests = ui.calls.length, chartCalls = ui.chartCalls.length;
  details.open = true; await details.fire("toggle");
  assert.equal(ui.benchmarkCalls.filter(row => row.snapshot === value.snapshot).length, 2);
  assert.equal(ui.find("kma-benchmark-bars").length, 1); assert.match(text(block), /업체 동일가중 참고 평균|동일 관측일/);
  const contents = block.children.slice(), count = ui.benchmarkCalls.length;
  details.open = false; await details.fire("toggle"); details.open = true; await details.fire("toggle");
  assert.equal(ui.benchmarkCalls.length, count); assert.deepEqual(block.children, contents);
  assert.equal(ui.calls.length, requests); assert.equal(ui.chartCalls.length, chartCalls);
});

test("restored open benchmark immediately follows the current company product and refreshed snapshot", async t => {
  let value = dashboardPayload(2), ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }) });
  t.after(() => ui.controller.destroy());
  await ui.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30", expanded: { [BENCHMARK_DETAIL_KEY]: true } });
  assert.equal(ui.find("kma-benchmark")[0].parentNode.open, true); assert.equal(ui.find("kma-benchmark-bars").length, 1);
  assert.equal(ui.benchmarkCalls.filter(row => row.snapshot === value.snapshot).length, 2);
  const requests = ui.calls.length;
  ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change");
  assert.match(text(ui.find("kma-benchmark-bars")[0]), /비교 업체 1 20%/);
  await ui.button("데이유즈").fire("click");
  assert.equal(ui.find("kma-benchmark")[0].parentNode.open, true);
  assert.deepEqual(ui.benchmarkCalls.at(-1).settings, { productType: "dayuse", companyId: "company-1" });
  assert.equal(ui.calls.length, requests);
  const prior = ui.find("kma-benchmark")[0]; value = dashboardPayload(1); await ui.controller.refresh();
  assert.notEqual(ui.find("kma-benchmark")[0], prior); assert.equal(ui.find("kma-benchmark")[0].parentNode.open, true);
  assert.match(text(ui.find("kma-benchmark")[0]), /선택 업체를 이 범위에서 확보하지 못해/);
  assert.equal(ui.find("kma-benchmark-bars").length, 0, "missing selected identity never substitutes another company");
});

test("late benchmark toggles cannot build or change expansion after another render or private clear", async t => {
  for (const action of ["company", "product", "refresh", "pause", "clear", "destroy", "auth", "hidden", "inactive"]) await t.test(action, async () => {
    const value = dashboardPayload(2), ui = mockUi({ request: dashboardRequest(value) });
    await ui.controller.open(); const stale = ui.find("kma-benchmark")[0], details = stale.parentNode;
    if (action === "company") { ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change"); }
    else if (action === "product") await ui.button("데이유즈").fire("click");
    else if (action === "refresh") await ui.controller.refresh();
    else if (action === "pause") ui.controller.pause();
    else if (action === "clear") ui.api.clear();
    else if (action === "destroy") ui.controller.destroy();
    else if (action === "auth") ui.doc.body.className = "role-customer";
    else if (action === "hidden") ui.doc.hidden = true;
    else ui.parent.screenHidden = true;
    const count = ui.benchmarkCalls.length, requests = ui.calls.length, expanded = clone(ui.controller.state().expanded);
    details.open = true; await details.fire("toggle");
    assert.equal(ui.benchmarkCalls.length, count); assert.equal(ui.calls.length, requests);
    assert.equal(descendants(stale).some(node => node.className.includes("kma-benchmark-bars")), false);
    assert.deepEqual(clone(ui.controller.state().expanded), expanded);
    ui.controller.destroy();
  });
});

test("a benchmark opened just before hiding resumes once on visible return without rerendering or requesting", async t => {
  for (const kind of ["document", "body"]) await t.test(kind, async () => {
    const value = dashboardPayload(2), ui = mockUi({ request: dashboardRequest(value) });
    t.after(() => ui.controller.destroy()); await ui.controller.open(); await settle();
    const block = ui.find("kma-benchmark")[0], details = block.parentNode, metrics = ui.find("kma-dashboard-metrics")[0];
    const charts = ui.chartCalls.map(row => row.container), requests = ui.calls.length, calculations = ui.benchmarkCalls.length;
    details.open = true;
    if (kind === "document") ui.doc.hidden = true; else ui.parent.screenHidden = true;
    await details.fire("toggle");
    assert.equal(ui.benchmarkCalls.length, calculations); assert.equal(ui.controller.state().expanded[BENCHMARK_DETAIL_KEY], undefined);
    if (kind === "document") { ui.doc.hidden = false; await ui.listeners.visibilitychange(); }
    else { ui.parent.screenHidden = false; ui.observers[0].callback(); }
    assert.equal(ui.controller.state().expanded[BENCHMARK_DETAIL_KEY], true);
    assert.equal(ui.benchmarkCalls.length, calculations + 1); assert.equal(ui.find("kma-benchmark-bars").length, 1);
    assert.equal(ui.find("kma-benchmark")[0], block); assert.equal(ui.find("kma-dashboard-metrics")[0], metrics);
    assert.deepEqual(ui.chartCalls.map(row => row.container), charts); assert.equal(ui.calls.length, requests);
    if (kind === "document") await ui.listeners.visibilitychange(); else ui.observers[0].callback();
    assert.equal(ui.benchmarkCalls.length, calculations + 1); assert.equal(ui.calls.length, requests);
  });
});

test("visibility recovery discards the old benchmark after a private clear or a new current render", async t => {
  for (const kind of ["clear", "company"]) await t.test(kind, async () => {
    const ui = mockUi({ request: dashboardRequest(dashboardPayload(2)) }); t.after(() => ui.controller.destroy());
    await ui.controller.open(); const prior = ui.find("kma-benchmark")[0]; prior.parentNode.open = true;
    ui.doc.hidden = true; await prior.parentNode.fire("toggle");
    if (kind === "clear") ui.api.clear();
    else { ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change"); }
    const count = ui.benchmarkCalls.length, requests = ui.calls.length;
    ui.doc.hidden = false; await ui.listeners.visibilitychange();
    assert.equal(descendants(prior).some(node => node.className.includes("kma-benchmark-bars")), false);
    assert.equal(ui.benchmarkCalls.length, count); assert.equal(ui.calls.length, requests);
    assert.notEqual(ui.controller.state().expanded[BENCHMARK_DETAIL_KEY], true);
  });
});

test("first benchmark open preserves unknown quantities and observed zero instead of inventing values", async t => {
  const value = dashboardPayload(2, true), ui = mockUi({ request: dashboardRequest(value) }); t.after(() => ui.controller.destroy());
  await ui.controller.open(); ui.field("benchmarkCompany").value = "rank-only"; await ui.field("benchmarkCompany").fire("change");
  const details = ui.find("kma-benchmark")[0].parentNode; details.open = true; await details.fire("toggle");
  const selected = ui.find("kma-benchmark-selected")[0]; assert.match(text(selected), /순위만 관측한 업체 — 미확인/);
  assert.equal(descendants(selected).some(node => node.tagName === "METER"), false);
  assert.match(text(ui.find("kma-benchmark")[0]), /차이를 0으로 만들지 않습니다/);
  assert.equal(ui.calls.length, 2);
  const zeroSource = sourceFixture(); zeroSource.observations = zeroSource.observations.map(row => ({ ...row, sold: 0, publicBookings: 0, phoneBookings: 0, publicRevenue: 0, phoneRevenue: 0, estimatedRevenue: 0 }));
  const zero = payloadFixture(); zero.snapshot = buildMonthlyReportSnapshot(zero.snapshot.request, zeroSource, NOW);
  const zeroUi = mockUi({ request: dashboardRequest(zero) }); t.after(() => zeroUi.controller.destroy()); await zeroUi.controller.open();
  const zeroDetails = zeroUi.find("kma-benchmark")[0].parentNode; zeroDetails.open = true; await zeroDetails.fire("toggle");
  assert.match(text(zeroUi.find("kma-benchmark-selected")[0]), /0%/);
  assert.equal(descendants(zeroUi.find("kma-benchmark-selected")[0]).find(node => node.tagName === "METER").value, 0);
});

test("local company search and twenty-row pages never narrow the whole charts or their population", async () => {
  const value = dashboardPayload(43, true), ui = mockUi({ request: dashboardRequest(value) }); await ui.controller.open(); await settle();
  const requests = ui.calls.length, chartCalls = ui.chartCalls.length;
  const whole = clone(ui.chartCalls.find(row => row.config.spec.type === "line").config.rows.map(row => row["전체 표본 · 선택 업체 포함"]));
  assert.equal(ui.find("kma-company-row").length, 20); assert.match(text(ui.find("kma-company-list-count")[0]), /전체 44곳.*1\/3페이지/);
  await ui.button("다음 업체").fire("click"); assert.equal(ui.controller.state().listPage, 2); assert.equal(ui.find("kma-company-row")[0].dataset.companyId, "company-20");
  await ui.find("kma-company-row")[5].fire("click"); await settle();
  assert.equal(ui.controller.state().benchmarkCompanyId, "company-25"); assert.equal(ui.controller.state().mobileView, "detail");
  assert.match(ui.find("kma-dashboard-title")[0].textContent, /2026-10 · 비교 업체 25 비교/);
  const afterSelection = ui.chartCalls.filter(row => row.config.spec.type === "line").at(-1).config;
  assert.deepEqual(clone(afterSelection.rows.map(row => row["전체 표본 · 선택 업체 포함"])), whole);
  const beforeSearch = ui.chartCalls.length; ui.field("companySearch").value = "순위만"; await ui.field("companySearch").fire("input");
  assert.equal(ui.find("kma-company-row").length, 1); assert.match(text(ui.find("kma-company-row")[0]), /순위만 관측한 업체 — 수량 미관측/);
  assert.equal(ui.controller.state().benchmarkCompanyId, "company-25"); assert.equal(ui.controller.state().listPage, 1); assert.equal(ui.chartCalls.length, beforeSearch);
  ui.field("companySearch").value = "없는 업체"; await ui.field("companySearch").fire("input");
  assert.equal(ui.find("kma-company-row").length, 0); assert.match(ui.text(), /선택 업체와 전체 평균은 유지/); assert.equal(ui.calls.length, requests);
  assert.equal(ui.chartCalls.filter(row => row.config.spec.type === "horizontalStackedBar").slice(-2).flatMap(row => row.config.rows).length, 43);
  assert.ok(chartCalls > 0); assert.equal(value.snapshot.companies.length, 44);
});

test("open and pause preserve explicit cutoff product company list page and supporting disclosures", async () => {
  let today = "2026-10-30";
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => {
    if (url.endsWith("/catalogue")) return { ...optionsFixture(), currentDay: today };
    const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), value = dashboardPayload(43);
    value.request = query; value.snapshot.request.cutoffDate = query.cutoffDate; return value;
  } }) });
  await ui.controller.open(); ui.field("cutoffDate").value = "2026-10-25"; await ui.field("cutoffDate").fire("change"); await ui.apply();
  await ui.button("데이유즈").fire("click"); ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input"); await ui.button("다음 업체").fire("click");
  await ui.find("kma-company-row")[5].fire("click"); const evidence = ui.find("kma-supporting-details")[0]; evidence.open = true; await evidence.fire("toggle");
  const selection = clone(ui.api.getSelection(ui.parent)); ui.api.pause(ui.parent); today = "2026-10-31"; await ui.api.show(ui.parent, selection); await settle();
  const state = ui.controller.state(); assert.equal(state.cutoffMode, "explicit"); assert.equal(state.selection.cutoffDate, "2026-10-25"); assert.equal(state.product, "dayuse");
  assert.equal(state.benchmarkCompanyId, "company-25"); assert.equal(state.listQuery, "비교"); assert.equal(state.listPage, 2); assert.equal(ui.find("kma-supporting-details")[0].open, true);
  await ui.apply(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-25"); assert.equal(ui.controller.state().listPage, 2);
  assert.equal(ui.field("cutoffDate").value, "2026-10-25"); assert.ok(ui.calls.every(row => row.settings.method === "GET"));
});

test("an unapplied cutoff draft survives a delayed read and same-context menu round trip", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => {
    if (url.endsWith("/catalogue")) return { ok: true, status: 200, json: async () => optionsFixture() };
    const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), count = ++reads;
    return { ok: true, status: 200, json: async () => count === 2 ? gate.promise : payloadFixture(query) };
  } });
  await ui.controller.open(); const saved = clone(ui.api.getSelection(ui.parent)), pending = ui.controller.refresh(); await settle();
  ui.field("cutoffDate").value = "2026-10-25"; await ui.field("cutoffDate").fire("input"); const calls = ui.calls.length;
  gate.resolve(payloadFixture()); await pending; await settle();
  assert.equal(ui.calls.length, calls); assert.equal(ui.field("cutoffDate").value, "2026-10-25"); assert.equal(ui.controller.state().applied.cutoffDate, "2026-10-30");
  assert.equal(ui.controller.state().draft.cutoffDate, "2026-10-25"); assert.match(text(ui.find("kma-condition-summary")[0]), /마감 2026-10-30.*입력 초안이 다릅니다/);
  ui.api.pause(ui.parent); await ui.api.show(ui.parent, saved);
  assert.equal(ui.field("cutoffDate").value, "2026-10-25"); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
  await ui.apply(); assert.equal(ui.controller.state().applied.cutoffDate, "2026-10-25"); assert.equal(ui.controller.state().cutoffMode, "explicit");
});

test("explicitly choosing the same cutoff marks an unapplied mode change and does not follow a newer automatic cutoff", async () => {
  let day = "2026-10-30";
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? { ...optionsFixture(), currentDay: day }
    : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)) }) });
  await ui.controller.open(); const calls = ui.calls.length; await ui.field("cutoffDate").fire("change");
  assert.equal(ui.calls.length, calls); assert.equal(ui.controller.state().cutoffMode, "auto"); assert.equal(ui.controller.state().viewState.draftCutoffMode, "explicit");
  assert.match(text(ui.find("kma-condition-summary")[0]), /입력 초안이 다릅니다/);
  await ui.apply(); assert.equal(ui.controller.state().cutoffMode, "explicit"); assert.doesNotMatch(text(ui.find("kma-condition-summary")[0]), /입력 초안이 다릅니다/);
  day = "2026-10-31"; await ui.apply(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
});

test("missing remembered company never becomes a fallback company's selected metric or line", async () => {
  let value = dashboardPayload(2); const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/catalogue") ? optionsFixture() : value }) });
  await ui.controller.open(); ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change");
  value = dashboardPayload(1); await ui.controller.refresh(); await settle();
  assert.equal(ui.controller.state().benchmarkCompanyId, "company-1"); assert.equal(ui.field("benchmarkCompany").value, "company-1");
  assert.match(ui.find("kma-dashboard-title")[0].textContent, /선택 업체 미확보/); assert.doesNotMatch(ui.find("kma-dashboard-title")[0].textContent, /비교 업체 0 비교/);
  assert.match(ui.text(), /다른 업체의 수치로 대체하지 않습니다/);
  const line = ui.chartCalls.filter(row => row.config.spec.type === "line").at(-1).config;
  assert.equal(line.rows.every(row => row["선택 업체"] === null), true); assert.equal(line.rows.find(row => row.date === "2026-10-20")["전체 표본 · 선택 업체 포함"], 0.8);
  const bars = ui.chartCalls.filter(row => row.config.spec.type === "horizontalStackedBar").at(-1).config.rows;
  assert.equal(bars.length, 1); assert.equal(bars[0].company, "비교 업체 0"); assert.equal(bars[0].selected, false);
});

test("same-keyword new month carries company identity and returning scope restores list choices", async () => {
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => {
    if (url.endsWith("/catalogue")) return optionsFixture(); const query = Object.fromEntries(new URL(url, "https://local.test").searchParams);
    return query.month === "2026-10" ? dashboardPayload(43) : payloadFixture(query);
  } }) });
  await ui.controller.open(); await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click");
  ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); const beforeApply = ui.calls.length;
  assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().draft.month, "2026-11"); assert.equal(ui.calls.length, beforeApply);
  await ui.apply(); assert.equal(ui.controller.state().benchmarkCompanyId, "company-25"); assert.match(ui.text(), /선택 업체 미확보/);
  ui.field("month").value = "2026-10"; await ui.field("month").fire("change"); await ui.apply();
  assert.equal(ui.controller.state().benchmarkCompanyId, "company-25"); assert.equal(ui.controller.state().listPage, 2);
  assert.match(ui.find("kma-dashboard-title")[0].textContent, /2026-10 · 비교 업체 25 비교/);
});

test("mobile list return focuses the selected row or search fallback while retaining list state", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(43)), mobile: true }); await ui.controller.open();
  await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click");
  assert.equal(ui.doc.scrolls.at(-1).node.className, "kma-detail-panel"); assert.equal(ui.doc.scrolls.at(-1).settings.block, "start");
  await ui.button("업체 목록으로").fire("click"); assert.equal(ui.controller.state().mobileView, "list"); assert.equal(ui.doc.activeElement.dataset.companyId, "company-25");
  assert.equal(ui.doc.scrolls.at(-1).node.dataset.companyId, "company-25"); assert.equal(ui.doc.scrolls.at(-1).settings.block, "center");
  ui.field("benchmarkCompany").value = "company-0"; await ui.field("benchmarkCompany").fire("change");
  await ui.button("업체 목록으로").fire("click"); assert.equal(ui.controller.state().listPage, 2); assert.equal(ui.doc.activeElement.name, "companySearch");
  assert.equal(ui.find("kma-workspace")[0].dataset.kmaMobileView, "list");
  assert.equal(ui.doc.scrolls.at(-1).node.name, "companySearch");
});

test("desktop company selection and list return preserve document scroll position", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(2)) }); await ui.controller.open();
  await ui.find("kma-company-row")[1].fire("click"); await ui.button("업체 목록으로").fire("click");
  assert.equal(ui.doc.scrolls.length, 0); assert.equal(ui.controller.state().benchmarkCompanyId, "company-1");
});

test("permission loss clears the common helper selection scopes drafts and disclosures", async () => {
  const ui = mockUi({ request: dashboardRequest(dashboardPayload(43)) }); await ui.controller.open();
  ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input"); await ui.button("다음 업체").fire("click"); await ui.button("데이유즈").fire("click");
  const evidence = ui.find("kma-supporting-details")[0]; evidence.open = true; await evidence.fire("toggle");
  ui.field("cutoffDate").value = "2026-10-25"; await ui.field("cutoffDate").fire("input");
  ui.doc.body.className = "role-admin admin-user-view"; ui.observers[0].callback();
  const state = clone(ui.controller.state()); assert.equal(state.paused, true); assert.equal(state.product, "lodging"); assert.equal(state.listQuery, ""); assert.equal(state.listPage, 1);
  assert.deepEqual(state.expanded, {}); assert.deepEqual(state.viewState.scopes, []); assert.deepEqual(state.draft, { keyword: "", month: "", cutoffDate: "" });
  assert.doesNotMatch(JSON.stringify(state.viewState), /경남|company-|비교/); assert.equal(ui.find("kma-workspace").length, 0);
});

const jsonResponse = (value, status = 200) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: name => name.toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null }, json: async () => clone(value) });
const htmlFailure = (status = 502) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: () => "text/html; charset=utf-8" }, json: async () => { throw new Error("HTML_FAILURE_BODY_MUST_NOT_BE_PARSED"); } });

test("HTML 502 on the first data read shows a controlled failure and manual retry reuses preserved choices", async () => {
  let failed = true;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : failed ? htmlFailure() : jsonResponse(payloadFixture()) });
  await ui.controller.open();
  assert.match(ui.text(), /HTTP 502/); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_502");
  assert.doesNotMatch(ui.text(), /Unexpected token|SyntaxError|HTML_FAILURE_BODY|<!doctype/i);
  assert.equal(ui.field("keyword").value, KEYWORD); assert.equal(ui.field("month").value, "2026-10"); assert.equal(ui.find("kma-metric").length, 0);
  const before = ui.calls.length; ui.observers[0].callback(); ui.listeners.visibilitychange(); await settle(); assert.equal(ui.calls.length, before, "failure never starts an observer/visibility retry loop");
  failed = false; await ui.apply();
  assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().errorCode, ""); assert.equal(ui.calls.length, before + 2);
  assert.ok(ui.calls.every(row => row.settings.method === "GET"));
});

test("a failed initial catalog leaves an enabled manual read action and does not require unavailable selections", async () => {
  let failed = true;
  const ui = mockUi({ request: async url => failed ? htmlFailure() : jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payloadFixture()) });
  await ui.controller.open(); assert.equal(ui.calls.length, 1); assert.match(ui.text(), /HTTP 502/);
  assert.equal(ui.field("keyword").value, ""); assert.equal(ui.button("저장 자료 조회").disabled, false);
  failed = false; await ui.apply(); assert.equal(ui.calls.length, 3); assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().errorCode, "");
});

test("HTML 502 and JSON 503 preserve only the same-condition normal snapshot and safe reason codes", async () => {
  let response = null;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
  await ui.controller.open(); response = htmlFailure(); await ui.controller.refresh();
  assert.match(ui.text(), /400원/); assert.match(ui.text(), /같은 조회 조건의 마지막 정상 저장 자료/); assert.match(ui.text(), /최신 반영 완료를 뜻하지 않습니다/);
  assert.equal(ui.controller.state().showingStored, true); assert.equal(ui.field("keyword").value, KEYWORD);
  response = jsonResponse({ status: "needs_verification", diagnostics: [{ code: "ANALYTICAL_MEMORY_BUSY" }, { code: "<private-error>" }], message: "SECRET_INTERNAL_DETAIL" }, 503);
  await ui.controller.refresh();
  assert.match(ui.text(), /HTTP 503.*ANALYTICAL_MEMORY_BUSY/); assert.doesNotMatch(ui.text(), /SECRET_INTERNAL_DETAIL|private-error/);
  assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503"); assert.match(ui.text(), /400원/);
  response = null; await ui.controller.refresh(); assert.equal(ui.controller.state().showingStored, false); assert.equal(ui.controller.state().errorCode, "");
});

test("503 displays bounded distinct top-level reason codes before diagnostics without exposing raw errors", async () => {
  const value = { code: "KEYWORD_MONTHLY_MEMORY_DEFERRED", errorCode: "KEYWORD_MONTHLY_QUERY_TIMEOUT", error: "SECRET_RAW_ERROR",
    message: "SECRET_RAW_MESSAGE", stack: "/var/data/SECRET_INTERNAL_PATH", diagnostics: ["KEYWORD_MONTHLY_MEMORY_DEFERRED",
      { code: "KEYWORD_MONTHLY_RESPONSE_BUSY", message: "SECRET_DIAGNOSTIC_MESSAGE" }, { code: "KEYWORD_MONTHLY_RESPONSE_TOO_LARGE" },
      { code: "KEYWORD_MONTHLY_EVIDENCE_CHANGED" }, { code: "<script>SECRET_HTML</script>" }] };
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : jsonResponse(value, 503) });
  await ui.controller.open();
  const error = ui.find("kma-error")[0].textContent;
  assert.match(error, /메모리 보호/); assert.match(error, /HTTP 503/);
  assert.match(error, /KEYWORD_MONTHLY_HTTP_503.*KEYWORD_MONTHLY_MEMORY_DEFERRED.*KEYWORD_MONTHLY_QUERY_TIMEOUT.*KEYWORD_MONTHLY_RESPONSE_BUSY.*KEYWORD_MONTHLY_RESPONSE_TOO_LARGE/);
  for (const code of [value.code, value.errorCode, "KEYWORD_MONTHLY_RESPONSE_BUSY", "KEYWORD_MONTHLY_RESPONSE_TOO_LARGE"]) assert.equal(error.split(code).length - 1, 1);
  assert.doesNotMatch(error, /SECRET_|script|\/var\/data|KEYWORD_MONTHLY_EVIDENCE_CHANGED/);
  assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503"); assert.equal(ui.find("kma-metric").length, 0);
});

test("reason codes reject malformed or overlong values and retain a safe 100-character code", async () => {
  const boundary = "KEYWORD_MONTHLY_" + "X".repeat(100 - "KEYWORD_MONTHLY_".length), tooLong = boundary + "Y";
  const value = { code: { code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, errorCode: "KEYWORD_MONTHLY_BAD\nSECRET_CONTROL",
    error: "SECRET_ERROR", diagnostics: [tooLong, "keyword_monthly_lowercase", "KEYWORD_MONTHLY_BAD/path", "KEYWORD_MONTHLY_BAD:SECRET",
      { code: ["KEYWORD_MONTHLY_ARRAY"] }, { error: "SECRET_NO_CODE" }, boundary, { code: "COMPANY_EVIDENCE_UNAVAILABLE" }] };
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : jsonResponse(value, 503) });
  await ui.controller.open(); const error = ui.find("kma-error")[0].textContent;
  assert.match(error, /자료 검수가 필요/); assert.ok(error.includes(boundary)); assert.equal(error.includes(tooLong), false);
  assert.match(error, /COMPANY_EVIDENCE_UNAVAILABLE/); assert.doesNotMatch(error, /SECRET|lowercase|BAD\/path|ARRAY|\[object Object\]|MEMORY_DEFERRED/);
});

test("safe server errorCode values explain resource holds and leave unknown reasons as verification", async () => {
  for (const [code, label] of [["KEYWORD_MONTHLY_MEMORY_DEFERRED", /메모리 보호/], ["KEYWORD_MONTHLY_MEMORY_UNAVAILABLE", /메모리 상태를 확인하지 못/],
    ["KEYWORD_MONTHLY_QUERY_TIMEOUT", /조회 대기 시간이 초과/], ["KEYWORD_MONTHLY_QUERY_BUSY", /진행 중인 조회/],
    ["KEYWORD_MONTHLY_RESPONSE_BUSY", /진행 중인 조회/], ["KEYWORD_MONTHLY_RESPONSE_TOO_LARGE", /응답 크기가 한도/],
    ["KEYWORD_MONTHLY_EVIDENCE_CHANGED", /자료 검수가 필요/]]) {
    const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : jsonResponse({ errorCode: code }, 503) });
    await ui.controller.open(); const error = ui.find("kma-error")[0].textContent;
    assert.match(error, label, code); assert.ok(error.includes(code)); assert.match(error, /HTTP 503/);
    assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503");
  }
});

test("HTML 503 keeps a generic HTTP failure without parsing or inventing a resource reason", async () => {
  let response = null, bodyReads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
  await ui.controller.open(); response = { ...htmlFailure(503), json: async () => { bodyReads++; throw Error("SECRET_HTML_BODY"); } };
  await ui.controller.refresh(); const error = ui.find("kma-error")[0].textContent;
  assert.equal(bodyReads, 0); assert.match(error, /HTTP 503.*KEYWORD_MONTHLY_HTTP_503/); assert.doesNotMatch(error, /SECRET|메모리|포화|조회 대기/);
  assert.equal(ui.controller.state().showingStored, true); assert.match(ui.text(), /400원/);
});

test("a top-level resource hold retains the same applied scope draft company page product and last valid data", async () => {
  const value = dashboardPayload(43); let failed = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : failed ? jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, 503) : jsonResponse(value) });
  await ui.controller.open(); ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input");
  await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click"); await ui.button("데이유즈").fire("click");
  const before = clone(ui.controller.state()); failed = true; await ui.controller.refresh(); const after = clone(ui.controller.state());
  for (const key of ["selection", "draft", "applied", "benchmarkCompanyId", "listQuery", "listPage", "product", "expanded"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.showingStored, true); assert.equal(after.benchmarkCompanyId, "company-25"); assert.equal(after.listPage, 2);
  assert.ok(ui.find("kma-metric").length > 0); assert.match(ui.text(), /메모리 보호/); assert.match(ui.text(), /같은 조회 조건의 마지막 정상 저장 자료/);
});

test("a late 503 reason cannot replace a newer result and auth errors clear before reason parsing", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise
    : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle();
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, 503)); await pending;
  assert.equal(ui.controller.state().selection.keyword, OTHER); assert.equal(ui.controller.state().errorCode, ""); assert.doesNotMatch(ui.text(), /메모리 보호|MEMORY_DEFERRED/);
  for (const status of [401, 403]) {
    let auth = false, parsed = 0;
    const next = mockUi({ request: async url => auth ? { ...jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, status), json: async () => { parsed++; throw Error("SECRET_AUTH_BODY"); } }
      : jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payloadFixture()) });
    await next.controller.open(); auth = true; await next.controller.refresh();
    assert.equal(parsed, 0); assert.equal(next.controller.state().paused, true); assert.equal(next.field("keyword").value, "");
    assert.equal(next.controller.state().errorCode, "KEYWORD_MONTHLY_AUTH_REQUIRED"); assert.doesNotMatch(next.text(), /MEMORY_DEFERRED|SECRET_AUTH_BODY/);
  }
});

test("invalid JSON, unexpected content type and network exceptions never expose parser or transport messages", async () => {
  let response = null;
  const ui = mockUi({ request: async url => {
    if (url.endsWith("/catalogue")) return jsonResponse(optionsFixture());
    if (response === "network") throw new Error("SECRET_NETWORK_MESSAGE");
    return response || jsonResponse(payloadFixture());
  } });
  await ui.controller.open();
  response = { ...jsonResponse(null), json: async () => { throw new SyntaxError("Unexpected token < SECRET_PARSE_MESSAGE"); } };
  await ui.controller.refresh(); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_INVALID_JSON"); assert.match(ui.text(), /400원/);
  response = htmlFailure(200); await ui.controller.refresh(); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_RESPONSE_NOT_JSON");
  response = "network"; await ui.controller.refresh(); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_NETWORK_ERROR");
  assert.doesNotMatch(ui.text(), /SECRET_|Unexpected token|SyntaxError/); assert.match(ui.text(), /400원/);
});

test("a failed new period never displays the former period and returning to its exact scope may show the saved result", async () => {
  let failed = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : failed ? htmlFailure() : jsonResponse(payloadFixture()) });
  await ui.controller.open(); failed = true;
  ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await ui.apply();
  assert.equal(ui.controller.state().selection.month, "2026-11"); assert.equal(ui.controller.state().showingStored, false);
  assert.equal(ui.find("kma-metric").length, 0); assert.doesNotMatch(ui.text(), /400원/);
  ui.field("month").value = "2026-10"; await ui.field("month").fire("change"); await ui.apply();
  assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().showingStored, true); assert.match(ui.text(), /400원/);
});

test("same-scope refresh and repeated submit share the running GET without aborting and restarting it", async () => {
  const gate = deferred(); let pending = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : pending ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); pending = true;
  const first = ui.controller.refresh(); await settle(); const before = ui.calls.length, signal = ui.calls.at(-1).settings.signal;
  const second = ui.controller.refresh(); await ui.button("저장 자료 조회").fire("click"); await settle();
  assert.equal(ui.calls.length, before); assert.equal(signal.aborted, false); assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().showingStored, true);
  gate.resolve(jsonResponse(payloadFixture())); await Promise.all([first, second]); await settle();
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, false);
});

test("menu reentry immediately restores its exact saved result while the fresh options request is pending or fails", async () => {
  const gate = deferred(); let delayed = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? delayed ? gate.promise : jsonResponse(optionsFixture()) : jsonResponse(payloadFixture()) });
  await ui.controller.open(); const selection = clone(ui.controller.state().selection); ui.controller.pause(); assert.equal(ui.find("kma-metric").length, 0);
  delayed = true; const reopening = ui.controller.open(selection); await settle();
  assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().loading, true); assert.equal(ui.controller.state().showingStored, true);
  gate.resolve(htmlFailure()); await reopening;
  assert.equal(ui.controller.state().loading, false); assert.match(ui.text(), /HTTP 502/); assert.match(ui.text(), /400원/);
  assert.equal(ui.field("month").value, "2026-10");
});

test("timeout finishes the UI even if fetch ignores abort and its late response cannot replace a later manual retry", async () => {
  const gate = deferred(); let delayed = false;
  const ui = mockUi({ requestTimeoutMs: 20, request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : delayed ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); delayed = true; await ui.controller.refresh();
  assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_TIMEOUT");
  assert.equal(ui.calls.at(-1).settings.signal.aborted, true); assert.match(ui.text(), /400원/);
  const before = ui.calls.length; await settle(); assert.equal(ui.calls.length, before);
  delayed = false; await ui.controller.refresh(); gate.resolve(htmlFailure()); await settle();
  assert.equal(ui.controller.state().errorCode, ""); assert.equal(ui.controller.state().showingStored, false); assert.match(ui.text(), /400원/);
});

test("an expired authentication or redirected login clears retained data and choices before body parsing", async () => {
  for (const auth of [{ ...htmlFailure(401), ok: false }, { ...htmlFailure(200), redirected: true, url: "https://local.test/login?expired=1" }]) {
    let response = null;
    const ui = mockUi({ request: async url => response || jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payloadFixture()) });
    await ui.controller.open(); response = auth; await ui.controller.refresh();
    assert.equal(ui.controller.state().paused, true); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_AUTH_REQUIRED");
    assert.equal(ui.field("keyword").value, ""); assert.equal(ui.field("month").value, ""); assert.equal(ui.find("kma-metric").length, 0); assert.doesNotMatch(ui.text(), /400원/);
    response = htmlFailure(); await ui.controller.open(); assert.equal(ui.controller.state().showingStored, false); assert.equal(ui.find("kma-metric").length, 0);
  }
});

test("an obsolete authentication response cannot clear a newer successful keyword selection", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle();
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(htmlFailure(401)); await old;
  assert.equal(ui.controller.state().paused, false); assert.equal(ui.controller.state().selection.keyword, OTHER); assert.match(ui.text(), /경남 글램핑 업체/);
});

test("an authoritative missing response invalidates that scope's retained result rather than resurrecting it after a transport failure", async () => {
  let response = null;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
  await ui.controller.open(); response = jsonResponse({ ...payloadFixture(), status: "missing", snapshot: null, diagnostics: ["MONTH_NOT_OBSERVED"] });
  await ui.controller.refresh(); assert.equal(ui.find("kma-metric").length, 0);
  response = htmlFailure(); await ui.controller.refresh(); assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().showingStored, false);
});

test("an explicit cutoff without a mode does not join an in-flight automatic-cutoff read", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle(); const before = ui.calls.length, oldSignal = ui.calls.at(-1).settings.signal;
  await ui.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-29" });
  assert.ok(ui.calls.length > before); assert.equal(oldSignal.aborted, true);
  assert.equal(ui.controller.state().cutoffMode, "explicit"); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-29");
  gate.resolve(jsonResponse(payloadFixture())); await old;
  assert.equal(ui.controller.state().applied.cutoffDate, "2026-10-29"); assert.match(text(ui.find("kma-condition-summary")[0]), /2026-10-29.*사용자 선택/);
});

test("joining the same data read applies product company list and disclosure context without another request", async () => {
  const gate = deferred(); let waiting = false;
  const value = dashboardPayload(43), ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : waiting ? gate.promise : jsonResponse(value) });
  await ui.controller.open(); waiting = true; const reading = ui.controller.refresh(); await settle(); const before = ui.calls.length;
  const joined = ui.controller.open({ ...ui.controller.state().selection, product: "dayuse", benchmarkCompanyId: "company-25", listQuery: "비교", listPage: 2, mobileView: "detail", expanded: { "support:자료 충족도와 최근 수집 상태": true } });
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().product, "dayuse"); assert.equal(ui.controller.state().benchmarkCompanyId, "company-25");
  assert.equal(ui.controller.state().listQuery, "비교"); assert.equal(ui.controller.state().listPage, 2); assert.equal(ui.controller.state().mobileView, "detail");
  gate.resolve(jsonResponse(value)); await Promise.all([reading, joined]);
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().product, "dayuse"); assert.equal(ui.controller.state().benchmarkCompanyId, "company-25");
  assert.equal(ui.controller.state().expanded["support:자료 충족도와 최근 수집 상태"], true);
});

test("a joined local view context survives the older pending options response", async () => {
  const gate = deferred(); let waiting = false;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? waiting ? gate.promise : jsonResponse(optionsFixture()) : jsonResponse(dashboardPayload(3)) });
  await ui.controller.open(); waiting = true;
  const selection = clone(ui.controller.state().selection), first = ui.controller.open({ ...selection, product: "lodging", benchmarkCompanyId: "company-0" }); await settle();
  const before = ui.calls.length, joined = ui.controller.open({ ...selection, product: "dayuse", benchmarkCompanyId: "company-1", listQuery: "비교" });
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().product, "dayuse");
  gate.resolve(jsonResponse(optionsFixture())); await Promise.all([first, joined]);
  assert.equal(ui.calls.length, before + 1); assert.equal(ui.controller.state().product, "dayuse");
  assert.equal(ui.controller.state().benchmarkCompanyId, "company-1"); assert.equal(ui.controller.state().listQuery, "비교");
});

test("returning from document hiding resumes one canceled revalidation even when a normal payload is retained", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle(); const before = ui.calls.length;
  ui.doc.hidden = true; ui.listeners.visibilitychange(); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, true);
  ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle();
  assert.equal(ui.calls.length, before + 1); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, false);
  ui.listeners.visibilitychange(); ui.observers[0].callback(); await settle(); assert.equal(ui.calls.length, before + 1);
  gate.resolve(htmlFailure()); await old; assert.equal(ui.controller.state().errorCode, ""); assert.match(ui.text(), /400원/);
});

test("a resumed visibility read that fails does not become an automatic retry loop", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++reads === 1 ? jsonResponse(payloadFixture()) : reads === 2 ? gate.promise : htmlFailure() });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle();
  ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle();
  assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_502"); const before = ui.calls.length;
  for (let i = 0; i < 3; i++) { ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); ui.observers[0].callback(); }
  await settle(); assert.equal(ui.calls.length, before); assert.match(ui.text(), /400원/);
  gate.resolve(jsonResponse(payloadFixture())); await old;
});

test("visibility resume preserves an interrupted options refresh so automatic cutoff advances with the new catalog", async () => {
  const gate = deferred(); let optionsReads = 0, day = "2026-10-30";
  const ui = mockUi({ request: async url => {
    if (url.endsWith("/catalogue")) return ++optionsReads === 2 ? gate.promise : jsonResponse({ ...optionsFixture(), currentDay: day });
    return jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)));
  } });
  await ui.controller.open(); await ui.button("데이유즈").fire("click"); day = "2026-10-31";
  const old = ui.controller.open(clone(ui.controller.state().selection)); await settle();
  ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle();
  assert.equal(optionsReads, 3); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-31");
  assert.equal(ui.controller.state().cutoffMode, "auto"); assert.equal(ui.controller.state().product, "dayuse");
  assert.equal(new URL(ui.calls.at(-1).url, "https://local.test").searchParams.get("cutoffDate"), "2026-10-31");
  const before = ui.calls.length; gate.resolve(jsonResponse({ ...optionsFixture(), currentDay: "2026-10-30" })); await old;
  ui.listeners.visibilitychange(); await settle(); assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-31");
});

function memorySelectionStorage() {
  const entries = new Map();
  return { entries, getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, String(value)); }, removeItem(key) { entries.delete(key); } };
}
const SELECTION_KEY = "staydatalab:keyword-monthly-selection:v1";
const selectorFixture = () => ({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30", cutoffMode: "explicit", product: "dayuse",
  companyId: "company-25", listQuery: "비교", listPage: 2, mobileView: "detail", expanded: { "chart:daily": true } });
const liveSession = (patch = {}) => ({ authenticated: true, role: "admin", username: "private-admin-name", memberId: "member-private",
  sessionCreatedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), ...patch });
const selectionDigest = async value => require("node:crypto").createHash("sha256").update(value).digest("hex");

test("optional reload position is bounded selection metadata and rejects malformed persisted shapes", async () => {
  const session = liveSession(), storage = memorySelectionStorage(), store = uiModule.createSelectionStorage({ storage, digest: selectionDigest });
  await store.configure(session);
  const position = { x: 0.5, y: 418, viewportWidth: 1280 }, selection = { ...selectorFixture(), scroll: position };
  assert.equal(store.write(selection), true); assert.deepEqual(store.read(), selection);
  position.y = 999; assert.equal(store.read().scroll.y, 418);
  const valid = JSON.parse(storage.getItem(SELECTION_KEY));
  for (const scroll of [null, [], {}, { x: 0, y: 1 }, { x: 0, y: 1, viewportWidth: 1280, revenue: 1 },
    { x: "0", y: 1, viewportWidth: 1280 }, { x: 0, y: -1, viewportWidth: 1280 }, { x: 0, y: 1000001, viewportWidth: 1280 },
    { x: 0, y: 1, viewportWidth: 0 }, { x: 0, y: 1, viewportWidth: "1280" }]) {
    assert.equal(store.write({ ...selectorFixture(), scroll }), false);
    storage.setItem(SELECTION_KEY, JSON.stringify({ ...valid, selection: { ...valid.selection, scroll } }));
    assert.equal(store.read(), null); assert.equal(storage.getItem(SELECTION_KEY), null);
  }
  for (const number of [NaN, Infinity, -Infinity]) assert.equal(store.write({ ...selectorFixture(), scroll: { x: 0, y: number, viewportWidth: 1280 } }), false);
  assert.equal(store.write({ ...selectorFixture(), scroll: { x: 1000000, y: 1000000, viewportWidth: 1000000 } }), true);
  assert.equal(store.write(selectorFixture()), true); assert.deepEqual(store.read(), selectorFixture(), "old selection schema remains readable without a position");
});

test("selection storage keeps only bounded view inputs behind an opaque authenticated session scope", async () => {
  const storage = memorySelectionStorage(), store = uiModule.createSelectionStorage({ storage, digest: selectionDigest }), session = liveSession();
  assert.equal(store.write(selectorFixture()), false); assert.equal(store.read(), null);
  assert.equal(await store.configure(session), true);
  assert.equal(store.write({ ...selectorFixture(), snapshot: { revenue: 999999 }, token: "must-not-persist", customer: "must-not-persist" }), true);
  const raw = storage.getItem(SELECTION_KEY), saved = JSON.parse(raw);
  assert.ok(raw.length < 12 * 1024); assert.match(saved.scope, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(raw, /private-admin-name|member-private|must-not-persist|snapshot|revenue|token|customer/);
  assert.deepEqual(store.read(), selectorFixture()); const changed = store.read(); changed.expanded["chart:daily"] = false;
  assert.equal(store.read().expanded["chart:daily"], true);
  assert.equal(store.matches(session), true); assert.equal(store.matches({ ...session, username: "same-member-name-changed" }), true);
  assert.equal(await store.configure({ ...session, expiresAt: new Date(Date.now() + 7200000).toISOString() }), true);
  assert.deepEqual(store.read(), selectorFixture());
});

test("another account or a newly created session for the same account cannot restore the previous selection", async () => {
  for (const patch of [{ memberId: "different-member" }, { sessionCreatedAt: new Date(Date.now()).toISOString() }, { role: "b2b" }, { authenticated: false }]) {
    const storage = memorySelectionStorage(), session = liveSession(), original = uiModule.createSelectionStorage({ storage, digest: selectionDigest });
    await original.configure(session); original.write(selectorFixture());
    const restored = uiModule.createSelectionStorage({ storage, digest: selectionDigest }); await restored.configure({ ...session, ...patch });
    assert.equal(restored.read(), null); assert.equal(storage.getItem(SELECTION_KEY), null);
  }
  const storage = memorySelectionStorage(), session = liveSession(), original = uiModule.createSelectionStorage({ storage, digest: selectionDigest });
  await original.configure(session); original.write(selectorFixture()); await original.configure(session, { customerView: true });
  assert.equal(original.read(), null); assert.equal(storage.entries.size, 0);
});

test("expiry revoke and superseded asynchronous authentication cannot resurrect stored selections", async () => {
  let now = Date.parse(NOW), session = { ...liveSession(), sessionCreatedAt: NOW, expiresAt: new Date(now + 100).toISOString() };
  const storage = memorySelectionStorage(), store = uiModule.createSelectionStorage({ storage, now: () => now, digest: selectionDigest });
  await store.configure(session); store.write(selectorFixture()); now += 101;
  assert.equal(store.read(), null); assert.equal(store.write(selectorFixture()), false); assert.equal(storage.entries.size, 0);
  const gate = deferred(), racing = uiModule.createSelectionStorage({ storage, digest: () => gate.promise });
  const old = racing.configure(liveSession()); racing.revoke(); gate.resolve("a".repeat(64));
  assert.equal(await old, false); assert.equal(racing.write(selectorFixture()), false); assert.equal(storage.entries.size, 0);
});

test("invalid oversized future foreign or hostile persisted inputs are cache misses without throwing", async () => {
  const goodStorage = memorySelectionStorage(), session = liveSession(), original = uiModule.createSelectionStorage({ storage: goodStorage, digest: selectionDigest });
  await original.configure(session); original.write(selectorFixture()); const good = JSON.parse(goodStorage.getItem(SELECTION_KEY));
  const invalid = ["{broken", "x".repeat(12 * 1024 + 1), JSON.stringify({ ...good, schema: 2 }), JSON.stringify({ ...good, scope: "b".repeat(64) }),
    JSON.stringify({ ...good, storedAt: Date.now() + 60000 }), JSON.stringify({ ...good, storedAt: Date.now() - 13 * 3600000 }),
    JSON.stringify({ ...good, snapshot: {} }), JSON.stringify({ ...good, selection: { ...good.selection, month: "2026-13" } }),
    JSON.stringify({ ...good, selection: { ...good.selection, cutoffDate: "2026-02-30" } }),
    JSON.stringify({ ...good, selection: { ...good.selection, product: "__proto__" } }),
    JSON.stringify({ ...good, selection: { ...good.selection, companyId: "<script>" } }),
    JSON.stringify({ ...good, selection: { ...good.selection, listQuery: "x".repeat(201) } }),
    JSON.stringify({ ...good, selection: { ...good.selection, listPage: 10001 } }),
    JSON.stringify({ ...good, selection: { ...good.selection, expanded: { "constructor": true } } }),
    JSON.stringify({ ...good, selection: JSON.parse(JSON.stringify(good.selection).slice(0, -1) + ',"__proto__":{"polluted":true}}') })];
  for (const raw of invalid) {
    const storage = memorySelectionStorage(); storage.setItem(SELECTION_KEY, raw);
    const store = uiModule.createSelectionStorage({ storage, digest: selectionDigest }); await store.configure(session);
    assert.equal(store.read(), null); assert.equal(storage.entries.size, 0); assert.equal({}.polluted, undefined);
  }
});

test("storage denial and unavailable cryptography preserve ordinary GET behavior without persisting", async () => {
  const storage = { getItem() { throw Error("disabled"); }, setItem() { throw Error("disabled"); }, removeItem() { throw Error("disabled"); } };
  const store = uiModule.createSelectionStorage({ storage, digest: selectionDigest }); await store.configure(liveSession());
  assert.equal(store.read(), null); assert.equal(store.write(selectorFixture()), false);
  const unsupported = uiModule.createSelectionStorage({ storage: memorySelectionStorage(), digest: async () => { throw Error("unavailable"); } });
  assert.equal(await unsupported.configure(liveSession()), false); assert.equal(unsupported.write(selectorFixture()), false);
  const ui = mockUi({ storage, session: liveSession() }); await ui.ready; await ui.controller.open();
  assert.equal(ui.calls.length, 2); assert.ok(ui.find("kma-metric").length > 0);
});

test("a stalled scope digest stops waiting promptly without later enabling persistence", async () => {
  const storage = memorySelectionStorage(), gate = deferred(), store = uiModule.createSelectionStorage({ storage, digest: () => gate.promise, digestTimeoutMs: 10 });
  assert.equal(await store.configure(liveSession()), false); assert.equal(store.write(selectorFixture()), false);
  gate.resolve("a".repeat(64)); await settle(); assert.equal(store.write(selectorFixture()), false); assert.equal(storage.entries.size, 0);
});

test("a full reload restores applied keyword month product company list and disclosure inputs then revalidates through GET", async () => {
  const storage = memorySelectionStorage(), session = liveSession(), request = dashboardRequest(dashboardPayload(43));
  const first = mockUi({ storage, session, request }); await first.ready;
  await first.controller.open({ ...selectorFixture(), benchmarkCompanyId: "company-25" });
  const before = clone(first.controller.state().selection);
  first.field("cutoffDate").value = "2026-10-25"; await first.field("cutoffDate").fire("input");
  // The unsaved draft is not promoted to the applied condition by reload.
  assert.equal(first.controller.state().draft.cutoffDate, "2026-10-25"); first.controller.destroy();
  const again = mockUi({ storage, session, request }); await again.ready; await again.controller.open();
  const after = clone(again.controller.state().selection);
  assert.deepEqual(after, before); assert.equal(again.controller.state().draft.cutoffDate, "2026-10-30");
  assert.equal(again.calls.length, 2); assert.ok(again.calls[0].url.endsWith("/catalogue"));
  assert.equal(new URL(again.calls[1].url, "https://local.test").searchParams.get("month"), "2026-10");
  assert.match(again.find("kma-dashboard-title")[0].textContent, /비교 업체 25/);
  const raw = storage.getItem(SELECTION_KEY); assert.doesNotMatch(raw, /snapshot|sources|summary|estimatedRevenue/);
});

test("explicit navigation context overrides remembered inputs rather than carrying another scope's company or product", async () => {
  const storage = memorySelectionStorage(), session = liveSession();
  const first = mockUi({ storage, session }); await first.ready; await first.controller.open(); await first.button("데이유즈").fire("click"); first.controller.destroy();
  const again = mockUi({ storage, session }); await again.ready;
  await again.controller.open({ keyword: OTHER, month: "2026-10", product: "lodging" });
  assert.equal(again.controller.state().selection.keyword, OTHER); assert.equal(again.controller.state().selection.month, "2026-10");
  assert.equal(again.controller.state().product, "lodging"); assert.match(again.text(), /경남 글램핑 업체/);
});

test("remembered scopes and fixed cutoffs are checked against fresh options before any detail read", async () => {
  const session = liveSession();
  for (const invalidScope of [false, true]) {
    const storage = memorySelectionStorage(), first = mockUi({ storage, session }); await first.ready;
    await first.controller.open({ keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-20", cutoffMode: "explicit" }); first.controller.destroy();
    const again = mockUi({ storage, session, request: async url => {
      const catalog = optionsFixture();
      if (invalidScope) catalog.keywords = catalog.keywords.filter(x => x.keyword !== KEYWORD);
      else catalog.keywords[0].supportedCutoffs = { "2026-09": "2026-09-30", "2026-10": "2026-10-30", "2026-11": "2026-10-30" };
      return jsonResponse(url.endsWith("/catalogue") ? catalog : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)));
    } });
    await again.ready; await again.controller.open();
    const q = new URL(again.calls[1].url, "https://local.test").searchParams;
    assert.equal(q.get("keyword"), invalidScope ? OTHER : KEYWORD); assert.equal(q.get("cutoffDate"), invalidScope ? "2026-10-30" : "2026-09-30");
    assert.match(again.text(), invalidScope ? /현재 저장 목록에 없어 기본 조건/ : /관측 마감일을 현재 저장 근거에 맞춰 조정/);
  }
});

test("a remembered unavailable company remains explicitly missing and is not switched to another company", async () => {
  const storage = memorySelectionStorage(), session = liveSession(), first = mockUi({ storage, session, request: dashboardRequest(dashboardPayload(43)) });
  await first.ready; await first.controller.open({ ...selectorFixture(), companyId: "company-25" }); first.controller.destroy();
  const again = mockUi({ storage, session, request: dashboardRequest(dashboardPayload(2)) }); await again.ready; await again.controller.open();
  assert.equal(again.controller.state().benchmarkCompanyId, "company-25"); assert.match(again.text(), /선택 업체 미확보/);
  assert.doesNotMatch(text(again.find("kma-dashboard-metrics")[0]), /비교 업체 0 예약 추정률/);
});

test("a failed first options read keeps restored-input validation for a manual retry", async () => {
  const storage = memorySelectionStorage(), session = liveSession(), first = mockUi({ storage, session }); await first.ready;
  await first.controller.open({ keyword: KEYWORD, month: "2026-09", cutoffDate: "2026-09-20", cutoffMode: "explicit" }); first.controller.destroy();
  let fail = true;
  const again = mockUi({ storage, session, request: async url => {
    if (url.endsWith("/catalogue")) {
      if (fail) return htmlFailure(502);
      const catalog = optionsFixture(); catalog.keywords[0].supportedCutoffs = { "2026-09": "2026-09-30" }; return jsonResponse(catalog);
    }
    return jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)));
  } });
  await again.ready; await again.controller.open(); assert.equal(again.calls.length, 1); assert.match(again.text(), /HTTP 502/);
  fail = false; await again.apply();
  assert.equal(new URL(again.calls.at(-1).url, "https://local.test").searchParams.get("cutoffDate"), "2026-09-30");
  assert.match(again.text(), /관측 마감일을 현재 저장 근거에 맞춰 조정/); assert.equal(again.controller.state().selection.month, "2026-09");
});

test("401, role loss and explicit logout erase persisted selections before a new page can restore them", async () => {
  for (const action of ["401", "403", "role", "logout", "account", "session"]) {
    const storage = memorySelectionStorage(), session = liveSession(); let code = 200;
    const ui = mockUi({ storage, session, request: async url => code === 200 ? jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) : htmlFailure(code) });
    await ui.ready; await ui.controller.open(); await ui.button("데이유즈").fire("click"); assert.ok(storage.getItem(SELECTION_KEY));
    if (action === "401" || action === "403") { code = Number(action); await ui.controller.refresh(); }
    else if (action === "role") { ui.doc.body.className = "role-b2b"; ui.observers[0].callback(); }
    else if (action === "logout") ui.api.clear();
    else await ui.api.configure({ ...session, ...(action === "account" ? { memberId: "another-member" } : { sessionCreatedAt: new Date(Date.now()).toISOString() }) });
    assert.equal(storage.getItem(SELECTION_KEY), null); assert.equal(ui.controller.state().benchmarkCompanyId, "");
    assert.equal(ui.find("kma-metric").length, 0);
  }
});

test("verified session configuration is awaited before role UI and failed session loading revokes it", async () => {
  const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const load = app.match(/^async function loadSession\(\) \{[^]*?^\}/m)?.[0]; assert.ok(load);
  const gate = deferred(), calls = [], session = liveSession(), state = {};
  const context = { state, fetchJson: async () => session, adminUserViewRequested: () => false, location: { pathname: "/admin" },
    window: { AdminCompanyPreviewCache: { configure: value => calls.push(["preview", value]) },
      KeywordMonthlyAnalysis: { configure(value, flags) { calls.push(["selection", value, flags]); return gate.promise; } } },
    applyRoleUi() { calls.push(["roles"]); } };
  vm.createContext(context); vm.runInContext(`${load}\nthis.load=loadSession`, context);
  const pending = context.load(); await settle();
  assert.equal(calls.some(x => x[0] === "roles"), false);
  const configured = calls.find(x => x[0] === "selection"); assert.equal(configured[1].sessionCreatedAt, session.sessionCreatedAt);
  assert.equal(configured[1].memberId, session.memberId); assert.equal(configured[1].role, "admin"); assert.equal(configured[2].customerView, false);
  gate.resolve(true); await pending; assert.equal(calls.at(-1)[0], "roles");
  calls.length = 0; const denied = Error("SESSION_DENIED"); context.fetchJson = async () => { throw denied; };
  await assert.rejects(context.load(), error => error === denied);
  assert.ok(calls.some(x => x[0] === "selection" && x[1] === null));
});

test("identity review is initially folded, uses observation units and expands without GET or aggregate changes", async () => {
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = identityReviewFixture(); const originalSummary = clone(payload.snapshot.summary);
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payload) }); await ui.controller.open();
  const block = ui.find("kma-identity-review")[0], details = block.parentNode;
  assert.equal(details.tagName, "DETAILS"); assert.equal(details.open, false); assert.equal(block.attributes["data-identity-review-status"], "ready");
  assert.equal(ui.find("kma-identity-count").length, 3); assert.match(text(block), /기존 관측자료에 반영.*10건.*업체번호 연결 보완.*3건.*연결 확인 필요.*5건/);
  assert.match(text(block), /관측기록/); assert.match(text(block), /객실수·예약수·월 합산건수와 다릅니다/);
  assert.match(text(block), /원본 업체번호 연결 근거 없음.*3건/); assert.match(text(block), /대응 관측시각 불일치.*2건/);
  const before = ui.calls.length; details.open = true; await details.fire("toggle"); assert.equal(ui.calls.length, before);
  assert.deepEqual(payload.snapshot.summary, originalSummary); assert.equal(ui.controller.state().selection.keyword, KEYWORD);
});
test("historical review absence remains unclassified instead of displaying three normal zero counts", async () => {
  const payload = payloadFixture(); payload.snapshot.quality.sourceDiagnostics = { unmatchedCompanyRows: 3710 };
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payload) }); await ui.controller.open();
  const block = ui.find("kma-identity-review")[0]; assert.equal(block.attributes["data-identity-review-status"], "legacy");
  assert.match(text(block), /세부 분류 전.*3,710건/); assert.equal(ui.find("kma-identity-count").length, 0); assert.match(text(block), /0건으로 표시하지 않습니다/);
});
test("actual3710 already represented classification is not shown as reservations or final monthly adoption", async () => {
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = identityReviewFixture({ totalRows: 3710, alreadyRepresentedRows: 3710, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} });
  payload.snapshot.summary.lodging.revenuePartial = true; payload.snapshot.quality.warnings = ["가격 미확인 근거는 유지합니다."];
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payload) }); await ui.controller.open();
  const block = ui.find("kma-identity-review")[0]; assert.match(text(block), /기존 관측자료에 반영.*3,710건/); assert.match(text(block), /월 최종값은 최신 유효 관측 기준으로 선택합니다/);
  assert.match(text(block), /업체번호 연결 보완.*0건.*연결 확인 필요.*0건/); assert.doesNotMatch(text(block), /3,710실|3,710원|월 최종합계에 모두/);
  assert.match(ui.text(), /가격 확인 부분 소계/); assert.match(ui.text(), /가격 미확인 근거는 유지합니다/);
});
test("a genuine zero identity review is visible and malformed review values stay unknown", async () => {
  const zero = identityReviewFixture({ totalRows: 0, alreadyRepresentedRows: 0, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} });
  assert.equal(uiModule.identityReviewView(zero).status, "ready");
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = zero;
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payload) }); await ui.controller.open();
  assert.equal(ui.find("kma-identity-count").length, 3); assert.ok(ui.find("kma-identity-count").every(item => /0건/.test(text(item))));
  for (const invalid of [null, { ...zero, totalRows: 1 }, { ...zero, privateToken: "unsafe" }, { ...zero, reasonCounts: { SOURCE_ID_UNKNOWN: 0 } }, { ...zero, totalRows: 100000001 }]) assert.equal(uiModule.identityReviewView(invalid).status, "invalid");
  payload.snapshot.quality.identityReview = { ...zero, totalRows: 99 }; await ui.controller.refresh();
  const block = ui.find("kma-identity-review")[0]; assert.equal(block.attributes["data-identity-review-status"], "invalid"); assert.equal(ui.find("kma-identity-count").length, 0); assert.match(text(block), /미확인을 0건으로 바꾸지 않습니다/);
});

// An injected clock exercises the production timer lifetime without sleeping
// thirty seconds or leaving recurring work alive after each isolated test.
function automaticClock() {
  let instant = Date.now(), nextId = 0;
  const tasks = new Map();
  return {
    now: () => instant,
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, at: instant + Math.max(0, Number(delay) || 0) }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    nextDelay() { return tasks.size ? Math.min(...[...tasks.values()].map(task => task.at - instant)) : null; },
    async advance(milliseconds) {
      const target = instant + milliseconds;
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 1000, "Automatic timer rescheduled without a bounded delay");
        const entry = [...tasks.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!entry) break;
        instant = entry[1].at; tasks.delete(entry[0]); entry[1].callback(); await settle();
      }
      instant = target; await settle();
    }
  };
}
const AUTO_A = "a".repeat(64), AUTO_B = "b".repeat(64), AUTO_C = "c".repeat(64);
function automaticVersion(revision, currentDay = "2026-10-30") {
  return { schemaVersion: 1, status: "available", revision, generation: revision.slice(0, 32), publishedAt: NOW, currentDay,
    readOnly: true, networkAttempted: false, originalFreshnessVerified: false };
}
function automaticOptions(revision, day = "2026-10-30") {
  const catalog = optionsFixture(); catalog.currentDay = day;
  catalog.provenance = { currentPointerSha256: revision };
  catalog.bundle = { generation: revision.slice(0, 32) };
  for (const row of catalog.keywords) row.defaultCutoffs = { "2026-09": "2026-09-30", "2026-10": day, "2026-11": day };
  return catalog;
}
function automaticPayload(revision, selection = { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, companies = 3) {
  const value = selection.keyword === KEYWORD && selection.month === "2026-10" ? dashboardPayload(companies) : payloadFixture(selection);
  value.request = { ...selection };
  value.snapshot.request = { type: "keyword", targetId: selection.keyword, month: selection.month, cutoffDate: selection.cutoffDate };
  value.resultId = revision;
  value.provenance = { ...value.provenance, dataThrough: `${selection.cutoffDate}T00:00:00Z`, currentPointerSha256: revision };
  value.bundle = { generation: revision.slice(0, 32) };
  return value;
}
async function automaticUi(t, { handle, interval = 250, timeout = 1000, companies = 3, frames = null,
  primeInitialVersion = true, waitForOpen = true } = {}) {
  const clock = automaticClock(), source = { revision: AUTO_A, day: "2026-10-30", optionsRevision: null, payloadRevision: null }, counts = { version: 0, options: 0, data: 0 };
  let openingInitial = true; const marks = [], timeOrigin = clock.now();
  const ui = mockUi({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    requestAnimationFrame: frames?.request, cancelAnimationFrame: frames?.cancel,
    performance: { now: () => clock.now() - timeOrigin, timeOrigin, getEntriesByType: () => [{ type: "reload" }], mark: name => marks.push({ name, at: clock.now() - timeOrigin }) },
    autoRefreshIntervalMs: interval, autoRefreshTimeoutMs: timeout, session: liveSession(), request: async (url, settings) => {
      const kind = url.endsWith("/version") ? "version" : url.endsWith("/catalogue") ? "options" : "data"; counts[kind]++;
      const selection = Object.fromEntries(new URL(url, "https://local.test").searchParams);
      // Recurring-refresh tests begin after one real, healthy initial version
      // GET. Initial failure/frame tests opt out and exercise that first GET.
      if (openingInitial && primeInitialVersion && kind === "version") return jsonResponse(automaticVersion(source.revision, source.day));
      const overridden = handle ? await handle({ kind, url, settings, selection, source, counts, clock }) : undefined;
      if (overridden !== undefined) return overridden;
      return jsonResponse(kind === "version" ? automaticVersion(source.revision, source.day)
        : kind === "options" ? automaticOptions(source.optionsRevision || source.revision, source.day)
          : automaticPayload(source.payloadRevision || source.revision, selection, companies));
    } });
  t.after(() => ui.controller.destroy()); await ui.ready; const opening = ui.controller.open(); if (waitForOpen) await opening; await settle(); openingInitial = false;
  return { ...ui, clock, source, counts, marks, opening };
}
const automaticVisibleState = ui => {
  const state = clone(ui.controller.state());
  return Object.fromEntries(["selection", "draft", "applied", "cutoffMode", "product", "benchmarkCompanyId", "listQuery", "listPage", "mobileView", "expanded", "loading", "status", "errorCode"].map(key => [key, state[key]]));
};

function automaticFrames() {
  let next = 0; const tasks = new Map();
  return {
    request(callback) { const id = ++next; tasks.set(id, callback); return id; },
    cancel(id) { tasks.delete(id); },
    pending: () => tasks.size,
    async step() { const current = [...tasks.values()]; tasks.clear(); for (const callback of current) callback(); await settle(); }
  };
}

test("first real version follows normal DOM while two real frames remain an independent observation", async t => {
  const frames = automaticFrames(), gate = deferred();
  const ui = await automaticUi(t, { frames, interval: 30000, primeInitialVersion: false, waitForOpen: false,
    handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
  let opened = false; ui.opening.then(() => { opened = true; });
  const panel = ui.find("keyword-monthly-analysis")[0];
  assert.deepEqual(ui.counts, { version: 1, options: 1, data: 1 }); assert.equal(opened, false);
  assert.equal(panel.dataset.displayedPointerSha256, AUTO_A); assert.equal(panel.dataset.displayedKeyword, KEYWORD);
  assert.equal(panel.dataset.displayedStayMonth, "2026-10"); assert.equal(panel.dataset.displayedCutoffDate, "2026-10-30");
  assert.equal(panel.dataset.firstRenderMs, "0"); assert.equal(panel.dataset.navigationType, "reload");
  assert.equal(Number(panel.dataset.performanceTimeOrigin), ui.clock.now()); assert.equal(frames.pending(), 1);
  await ui.clock.advance(16); await frames.step(); assert.equal(ui.counts.version, 1); assert.equal(frames.pending(), 1);
  await ui.clock.advance(16); await frames.step(); assert.equal(ui.counts.version, 1); assert.equal(opened, false);
  assert.equal(panel.dataset.firstFramesMs, "32"); assert.equal(panel.dataset.firstVersionStartMs, "0");
  assert.equal(panel.dataset.firstVersionOutcome, "running"); assert.equal(ui.controller.state().automatic.checking, true);
  const reentered = ui.controller.open(); await settle();
  assert.deepEqual(ui.counts, { version: 1, options: 1, data: 1 }, "Same-scope reentry shares the initial cycle");
  for (const observer of ui.observers) observer.callback(); ui.listeners.visibilitychange(); await settle();
  assert.equal(ui.counts.version, 1);
  await ui.clock.advance(7); gate.resolve(jsonResponse(automaticVersion(AUTO_A))); await Promise.all([ui.opening, reentered]);
  assert.equal(opened, true); assert.equal(panel.dataset.firstVersionCompleteMs, "39");
  assert.equal(panel.dataset.firstVersionOutcome, "complete"); assert.equal(ui.clock.nextDelay(), 30000);
  assert.deepEqual(ui.marks.map(x => x.name), ["first-normal-render", "first-version-start", "first-version-settled"].map(x => "staydatalab:keyword-monthly:" + x));
  await ui.clock.advance(29999); assert.equal(ui.counts.version, 1);
  await ui.clock.advance(1); assert.equal(ui.counts.version, 2); assert.equal(ui.counts.data, 1);
});

test("first version detects a newer publication then stages sequential prepared-only reads after the displayed result", async t => {
  const frames = automaticFrames(), gate = deferred();
  const ui = await automaticUi(t, { frames, primeInitialVersion: false, waitForOpen: false,
    handle: ({ kind, source }) => {
      if (kind === "version") { source.revision = AUTO_B; return jsonResponse(automaticVersion(AUTO_B)); }
      if (kind === "data" && source.revision === AUTO_B) return gate.promise;
    } });
  const panel = ui.find("keyword-monthly-analysis")[0], before = automaticVisibleState(ui);
  await frames.step(); await frames.step();
  assert.deepEqual(ui.counts, { version: 1, options: 2, data: 2 });
  assert.deepEqual(ui.calls.map(c => c.url.endsWith("/catalogue") ? "options" : c.url.endsWith("/version") ? "version" : "data"), ["options", "data", "version", "options", "data"]);
  assert.equal(panel.dataset.displayedPointerSha256, AUTO_A); assert.deepEqual(automaticVisibleState(ui), before);
  assert.equal(ui.calls.at(-1).settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
  gate.resolve(jsonResponse(automaticPayload(AUTO_B))); await ui.opening;
  assert.equal(panel.dataset.displayedPointerSha256, AUTO_B); assert.equal(ui.controller.state().automatic.initial.outcome, "complete");
  assert.equal(ui.controller.state().automatic.revision, AUTO_B); assert.equal(ui.clock.nextDelay(), 250);
});

test("a first version protection failure settles open while preserving normal data and the existing bounded backoff", async t => {
  let held = true;
  const ui = await automaticUi(t, { interval: 30000, primeInitialVersion: false,
    handle: ({ kind }) => kind === "version" && held ? jsonResponse({ code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY" }, 503) : undefined });
  assert.deepEqual(ui.counts, { version: 1, options: 1, data: 1 });
  assert.equal(ui.controller.state().automatic.initial.outcome, "failed"); assert.equal(ui.controller.state().automatic.failureCount, 1);
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_A);
  assert.equal(ui.controller.state().status, "available"); assert.equal(ui.controller.state().showingStored, true);
  assert.equal(ui.clock.nextDelay(), 60000);
  for (const observer of ui.observers) observer.callback(); ui.listeners.visibilitychange(); await settle();
  await ui.clock.advance(59999); assert.equal(ui.counts.version, 1);
  held = false; await ui.clock.advance(1); assert.equal(ui.counts.version, 2);
  assert.equal(ui.controller.state().automatic.failureCount, 0); assert.equal(ui.clock.nextDelay(), 30000);
});

test("the first immediate version waits for a genuinely usable result rather than an initial missing response", async t => {
  let ready = false; const frames = automaticFrames();
  const ui = await automaticUi(t, { frames, interval: 30000, primeInitialVersion: false,
    handle: ({ kind, source, selection }) => kind === "data" && !ready ? jsonResponse({ ...automaticPayload(source.revision, selection), status: "missing", snapshot: null }) : undefined });
  const panel = ui.find("keyword-monthly-analysis")[0];
  assert.equal(ui.counts.version, 0); assert.equal(frames.pending(), 0); assert.equal(panel.dataset.displayedPointerSha256, undefined);
  ready = true; const retry = ui.controller.refresh(); await settle();
  assert.equal(panel.dataset.displayedPointerSha256, AUTO_A); assert.equal(ui.counts.version, 1);
  await frames.step(); await frames.step(); await retry;
  assert.equal(ui.counts.version, 1); assert.equal(ui.controller.state().automatic.initial.outcome, "complete");
});

test("cancelling initial frame observation never delays version completion or adds hidden requests", async t => {
  for (const action of ["hidden", "clear", "pause", "destroy"]) {
    const frames = automaticFrames(), ui = await automaticUi(t, { frames, primeInitialVersion: false, waitForOpen: false });
    await frames.step();
    if (action === "hidden") { ui.doc.hidden = true; ui.listeners.visibilitychange(); }
    else if (action === "clear") ui.api.clear(); else ui.controller[action]();
    await ui.opening; await frames.step(); await ui.clock.advance(60000);
    assert.equal(ui.counts.version, 1, action); assert.equal(frames.pending(), 0, action);
    if (action !== "hidden") assert.equal(ui.find("keyword-monthly-analysis")[0]?.dataset.displayedPointerSha256, undefined, action);
  }
});

test("a late initial version cannot overwrite a newer manual scope or clear its successful state", async t => {
  for (const late of [jsonResponse(automaticVersion(AUTO_B)), jsonResponse({}, 403)]) {
    const frames = automaticFrames(), gate = deferred();
    const ui = await automaticUi(t, { frames, primeInitialVersion: false, waitForOpen: false,
      handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
    await frames.step(); await frames.step(); assert.equal(ui.counts.version, 1);
    ui.source.revision = AUTO_C;
    await ui.controller.open({ keyword: OTHER, month: "2026-10", cutoffDate: "2026-10-30", cutoffMode: "explicit" });
    await ui.opening; const latest = automaticVisibleState(ui);
    gate.resolve(late); await settle();
    assert.deepEqual(automaticVisibleState(ui), latest); assert.equal(ui.controller.state().selection.keyword, OTHER);
    const panel = ui.find("keyword-monthly-analysis")[0];
    assert.equal(panel.dataset.displayedPointerSha256, AUTO_C); assert.equal(panel.dataset.displayedKeyword, OTHER);
    assert.equal(ui.controller.state().paused, false); assert.equal(ui.counts.version, 1);
  }
});

test("an unavailable animation-frame API never invents paint completion or loops initial version requests", async t => {
  const ui = await automaticUi(t, { frames: { request() { throw Error("UNAVAILABLE_FRAME"); }, cancel() {} }, primeInitialVersion: false });
  assert.equal(ui.counts.version, 1); assert.equal(ui.controller.state().automatic.initial.framesCompletedAt, null);
  assert.equal(ui.controller.state().automatic.initial.outcome, "complete");
  await ui.clock.advance(249); assert.equal(ui.counts.version, 1);
});

test("an initial version authentication failure clears displayed markers before reading any private body", async t => {
  let bodyReads = 0;
  const ui = await automaticUi(t, { primeInitialVersion: false,
    handle: ({ kind }) => kind === "version" ? { ok: false, status: 403, json: async () => { bodyReads++; return { private: "UNREAD" }; } } : undefined });
  const panel = ui.find("keyword-monthly-analysis")[0];
  assert.equal(bodyReads, 0); assert.equal(ui.controller.state().paused, true);
  assert.equal(panel.dataset.displayedPointerSha256, undefined); assert.equal(panel.dataset.displayedKeyword, undefined);
  assert.equal(panel.dataset.firstRenderMs, undefined); assert.equal(panel.dataset.firstVersionStartMs, undefined);
  assert.equal(ui.find("kma-metric").length, 0); const before = ui.calls.length;
  await ui.clock.advance(60000); assert.equal(ui.calls.length, before);
});

test("visibility does not rerun a completed initial version or invent cancelled frame completion", async t => {
  const frames = automaticFrames(), ui = await automaticUi(t, { frames, primeInitialVersion: false, waitForOpen: false });
  await frames.step(); ui.doc.hidden = true; ui.listeners.visibilitychange(); await ui.opening;
  assert.equal(ui.counts.version, 1); assert.equal(frames.pending(), 0);
  ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle();
  await frames.step(); await frames.step(); await settle();
  assert.deepEqual(ui.counts, { version: 1, options: 1, data: 1 });
  assert.equal(ui.controller.state().automatic.initial.outcome, "complete");
  for (const observer of ui.observers) observer.callback(); await settle(); assert.equal(ui.counts.version, 1);
  assert.equal(ui.controller.state().automatic.initial.framesCompletedAt, null);
});

test("a throttled animation frame cannot hold the real initial version or the boot promise", async t => {
  const frames = automaticFrames(), ui = await automaticUi(t, { frames, interval: 30000, primeInitialVersion: false });
  const panel = ui.find("keyword-monthly-analysis")[0];
  assert.equal(ui.counts.version, 1); assert.equal(panel.dataset.firstVersionOutcome, "complete");
  assert.equal(panel.dataset.firstFramesMs, undefined); assert.equal(frames.pending(), 1);
  await ui.clock.advance(1700); assert.equal(ui.counts.version, 1, "The normal thirty-second interval remains unchanged");
  await frames.step(); await frames.step();
  assert.equal(Number(panel.dataset.firstFramesMs), 1700); assert.ok(Number(panel.dataset.firstVersionCompleteMs) < 1700);
});

const CATALOGUE_KEY = "staydatalab:keyword-monthly-catalogue:v1";
const cacheContext = () => ({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30", cutoffMode: "explicit" });
function cachePayload(revision, selection = cacheContext(), companies = 3) {
  return { ...automaticPayload(revision, selection, companies), readOnly: true, networkAttempted: false, preparedResult: { status: "ready", sourceRevalidated: false } };
}
function cacheOptions(revision) {
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10), value = automaticOptions(revision, today);
  value.readOnly = true; value.networkAttempted = false; value.provenance.originalFreshnessVerified = false;
  for (const row of value.keywords) {
    row.supportedCutoffs = Object.fromEntries(row.stayMonths.map(month => [month, month === "2026-09" ? "2026-09-30" : month === "2026-10" ? "2026-10-30" : today]));
    row.defaultCutoffs = { ...row.supportedCutoffs };
    row.provenanceByMonth = Object.fromEntries(Object.entries(row.supportedCutoffs).map(([month, cutoff]) => [month, { dataThrough: cutoff + "T00:00:00Z" }]));
  }
  return value;
}
function cacheUi(t, { storage, session, handle, revision = AUTO_A, clock = null, interval, viewport, frames, performance, companies = 3 } = {}) {
  const source = { revision }, counts = { options: 0, data: 0, version: 0, status: 0 }; let ui;
  ui = mockUi({ storage, session, now: clock?.now || Date.now, setTimeout: clock?.setTimeout || setTimeout,
    clearTimeout: clock?.clearTimeout || clearTimeout, autoRefreshIntervalMs: interval, viewport, performance,
    requestAnimationFrame: frames?.request, cancelAnimationFrame: frames?.cancel, request: async (url, settings) => {
    const kind = url.endsWith("/refresh-status") ? "status" : url.endsWith("/version") ? "version" : url.endsWith("/catalogue") ? "options" : "data";
    counts[kind]++; const selection = Object.fromEntries(new URL(url, "https://local.test").searchParams);
    const custom = await handle?.({ kind, settings, counts, selection, source, ui }); if (custom !== undefined) return custom;
    return jsonResponse(kind === "options" ? cacheOptions(source.revision) : kind === "version" ? automaticVersion(source.revision, new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10))
      : kind === "status" ? { status: "available", started: true, initialized: true, closed: false, errorCode: null, cleanup: { status: "complete" }, counts: { running: 0, queued: 0, deferred: 0, needs_verification: 0, complete: 0 } }
        : cachePayload(source.revision, selection, companies));
  } });
  t.after(() => ui.controller.destroy()); return { ...ui, source, counts };
}
async function warmedCatalogue(t) {
  const storage = memorySelectionStorage(), session = liveSession(), warm = cacheUi(t, { storage, session });
  await warm.ready; await warm.controller.open(cacheContext());
  for (let wait = 0; wait < 100 && !storage.getItem(uiModule.RESULT_KEY); wait++) await new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.ok(storage.getItem(CATALOGUE_KEY)); warm.controller.destroy();
  // These cases isolate the smaller metadata-only cache; result-cache behavior
  // is covered separately below.
  storage.removeItem(uiModule.RESULT_KEY);
  return { storage, session };
}

async function savedReloadPosition(t, { cache = true } = {}) {
  const storage = memorySelectionStorage(), session = liveSession(), ui = cacheUi(t, { storage, session, viewport: { width: 1280, x: 0, y: 0 } });
  await ui.ready; await ui.controller.open(cacheContext());
  for (let wait = 0; wait < 100 && !storage.getItem(uiModule.RESULT_KEY); wait++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(storage.getItem(SELECTION_KEY)).selection.scroll, undefined, "ordinary rendering does not invent a position");
  ui.window.scrollX = 12; ui.window.scrollY = 418; ui.fireWindow("pagehide");
  const selection = JSON.parse(storage.getItem(SELECTION_KEY)).selection;
  assert.deepEqual(selection.scroll, { x: 12, y: 418, viewportWidth: 1280 });
  assert.doesNotMatch(storage.getItem(SELECTION_KEY), /snapshot|estimatedRevenue|private-admin-name|member-private|token|price|rooms/);
  ui.controller.destroy();
  assert.equal(ui.windowListeners.pagehide.size, 0); assert.equal(ui.windowListeners.wheel.size, 0);
  if (!cache) storage.removeItem(CATALOGUE_KEY);
  storage.removeItem(uiModule.RESULT_KEY); // These original cases isolate metadata/cold restoration.
  return { storage, session, selection };
}

test("F5 pagehide records the active normal panel after visibility hidden but excludes an inactive screen", async t => {
  const storage = memorySelectionStorage(), session = liveSession(), ui = cacheUi(t, { storage, session, viewport: { width: 1280, x: 0, y: 0 } });
  await ui.ready; await ui.controller.open(cacheContext());
  ui.doc.hidden = true; ui.listeners.visibilitychange();
  ui.window.scrollX = 0; ui.window.scrollY = 418; ui.fireWindow("pagehide");
  assert.deepEqual(JSON.parse(storage.getItem(SELECTION_KEY)).selection.scroll, { x: 0, y: 418, viewportWidth: 1280 });
  ui.parent.screenHidden = true; ui.window.scrollY = 12; ui.fireWindow("pagehide");
  assert.equal(JSON.parse(storage.getItem(SELECTION_KEY)).selection.scroll.y, 418, "an inactive panel cannot replace the last actual position");
});

for (const cache of [false, true]) test(`same-auth ${cache ? "cached" : "cold"} F5 restores the complete selection once after normal DOM and before its real frames`, async t => {
  const saved = await savedReloadPosition(t, { cache }), data = deferred(), frames = automaticFrames();
  const ui = cacheUi(t, { ...saved, frames, viewport: { width: 1280, x: 0, y: 29 },
    handle: ({ kind }) => kind === "data" ? data.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await settle();
  assert.equal(ui.windowScrolls.length, 0); assert.equal(ui.find("kma-dashboard-metrics").length, 0);
  data.resolve(jsonResponse(cachePayload(AUTO_A))); await opening; await settle();
  assert.deepEqual(ui.windowScrolls, [{ x: 12, y: 418 }]);
  assert.ok(ui.find("kma-dashboard-metrics").length); assert.equal(frames.pending(), 1);
  const panel = ui.find("keyword-monthly-analysis")[0]; assert.equal(panel.dataset.firstFramesMs, undefined);
  assert.equal(panel.dataset.firstVersionOutcome, "complete");
  assert.equal(ui.counts.options, cache ? 0 : 1);
  await frames.step(); await frames.step(); assert.ok(panel.dataset.firstFramesMs !== undefined);
  await ui.button("데이유즈").fire("click"); await ui.controller.refresh();
  assert.equal(ui.windowScrolls.length, 1, "later renders and completed reads never repeat a scroll jump");
});

test("reload position cannot cross fresh authentication, viewport width, or explicit navigation", async t => {
  for (const mode of ["new-auth", "viewport", "explicit"]) {
    const saved = await savedReloadPosition(t), ui = cacheUi(t, { ...saved,
      session: mode === "new-auth" ? { ...saved.session, sessionCreatedAt: new Date(Date.now()).toISOString() } : saved.session,
      viewport: { width: mode === "viewport" ? 390 : 1280, x: 0, y: 29 } });
    await ui.ready; await ui.controller.open(mode === "explicit" ? { ...cacheContext(), keyword: OTHER } : undefined);
    assert.equal(ui.windowScrolls.length, 0, mode);
    assert.ok(ui.find("kma-dashboard-metrics").length);
  }
});

test("wheel touch key and pointer intent before or during initial GET cancel the one-shot reload movement", async t => {
  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) for (const beforeOpen of [false, true]) {
    const saved = await savedReloadPosition(t), gate = deferred(), ui = cacheUi(t, { ...saved, viewport: { width: 1280, x: 0, y: 29 },
      handle: ({ kind }) => kind === "data" ? gate.promise : undefined });
    await ui.ready;
    if (beforeOpen) ui.fireWindow(type);
    const opening = ui.controller.open(); await settle();
    if (!beforeOpen) ui.fireWindow(type);
    gate.resolve(jsonResponse(cachePayload(AUTO_A))); await opening;
    assert.equal(ui.windowScrolls.length, 0, `${type}, beforeOpen=${beforeOpen}`);
  }
});

test("a changed viewport cancels restoration even when it returns to the old width before data arrives", async t => {
  const saved = await savedReloadPosition(t), gate = deferred(), ui = cacheUi(t, { ...saved, viewport: { width: 1280, x: 0, y: 29 },
    handle: ({ kind }) => kind === "data" ? gate.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await settle();
  ui.window.innerWidth = 390; ui.fireWindow("resize"); ui.window.innerWidth = 1280; ui.fireWindow("resize");
  gate.resolve(jsonResponse(cachePayload(AUTO_A))); await opening; assert.equal(ui.windowScrolls.length, 0);
});

test("late old-scope data and logout cannot move the replacement view or resurrect persisted scroll", async t => {
  for (const mode of ["new-scope", "logout"]) {
    const saved = await savedReloadPosition(t), gate = deferred(), ui = cacheUi(t, { ...saved, viewport: { width: 1280, x: 0, y: 29 },
      handle: ({ kind, selection }) => kind === "data" && selection.keyword === KEYWORD ? gate.promise : undefined });
    await ui.ready; const opening = ui.controller.open(); await settle();
    if (mode === "logout") ui.api.clear();
    else await ui.controller.open({ ...cacheContext(), keyword: OTHER });
    gate.resolve(jsonResponse(cachePayload(AUTO_A))); await opening; await settle();
    assert.equal(ui.windowScrolls.length, 0, mode);
    ui.fireWindow("pagehide");
    if (mode === "logout") assert.equal(saved.storage.getItem(SELECTION_KEY), null);
    else assert.equal(ui.controller.state().selection.keyword, OTHER);
  }
});

test("failed or adjusted initial scopes never restore a position from a different usable report", async t => {
  for (const mode of ["failed", "adjusted-cutoff"]) {
    const saved = await savedReloadPosition(t, { cache: false }), ui = cacheUi(t, { ...saved, viewport: { width: 1280, x: 0, y: 29 },
      handle: ({ kind }) => {
        if (mode === "failed" && kind === "data") return htmlFailure(503);
        if (mode === "adjusted-cutoff" && kind === "options") { const value = cacheOptions(AUTO_A); value.keywords[0].supportedCutoffs["2026-10"] = "2026-10-29"; value.keywords[0].defaultCutoffs["2026-10"] = "2026-10-29"; return jsonResponse(value); }
      } });
    await ui.ready; await ui.controller.open(); assert.equal(ui.windowScrolls.length, 0, mode);
    ui.window.scrollY = 5; ui.fireWindow("pagehide");
    const currentSelection = JSON.parse(saved.storage.getItem(SELECTION_KEY))?.selection;
    if (mode === "failed") assert.notDeepEqual(currentSelection?.scroll, { x: 0, y: 5, viewportWidth: 1280 });
    else assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-29");
  }
});

test("same-session reload verifies a cached catalogue beside prepared-only data and refreshes live protection after first version", async t => {
  const warm = await warmedCatalogue(t), version = deferred(), data = deferred(), status = deferred();
  const ui = cacheUi(t, { ...warm, handle: ({ kind, counts }) => kind === "version" && counts.version === 1 ? version.promise : kind === "data" ? data.promise : kind === "status" ? status.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await settle();
  assert.deepEqual(ui.counts, { options: 0, data: 1, version: 1, status: 0 });
  assert.equal(ui.calls.find(c => new URL(c.url, "https://local.test").pathname === "/api/keyword-monthly").settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
  version.resolve(jsonResponse(automaticVersion(AUTO_A, cacheOptions(AUTO_A).currentDay))); await settle();
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, undefined);
  data.resolve(jsonResponse(cachePayload(AUTO_A))); await opening; await settle();
  const panel = ui.find("keyword-monthly-analysis")[0];
  assert.equal(panel.dataset.displayedPointerSha256, AUTO_A); assert.equal(panel.dataset.catalogueSource, "session_metadata_verified_by_version");
  assert.equal(ui.counts.version, 2); assert.equal(ui.counts.status, 1); assert.equal(ui.counts.options, 0);
  assert.equal(panel.dataset.firstVersionOutcome, "complete"); assert.match(ui.text(), /갱신·보호 상태는 운영 서버에서 확인 중/);
  const diagnostic = clone(ui.controller.state().requestDiagnostic);
  const metricsNode = ui.find("kma-dashboard-metrics")[0], search = ui.field("companySearch"), chartCount = ui.chartCalls.length;
  assert.ok(metricsNode);
  search.focus(); search.setSelectionRange(1, 1);
  status.resolve(jsonResponse({ status: "available", started: true, initialized: true, closed: false, errorCode: null, counts: { running: 0, queued: 0, deferred: 0, needs_verification: 0, complete: 0 }, cleanup: { status: "complete" } })); await settle();
  assert.doesNotMatch(ui.text(), /갱신·보호 상태는 운영 서버에서 확인 중/); assert.match(ui.text(), /현재 갱신 작업/);
  assert.deepEqual(clone(ui.controller.state().requestDiagnostic), diagnostic);
  assert.equal(ui.find("kma-dashboard-metrics")[0], metricsNode); assert.equal(ui.field("companySearch"), search);
  assert.equal(ui.chartCalls.length, chartCount); assert.equal(ui.doc.activeElement, search); assert.equal(search.selectionStart, 1);
  const persisted = warm.storage.getItem(CATALOGUE_KEY); assert.doesNotMatch(persisted, /private-admin|member-private|refreshStatus|snapshot|estimatedRevenue|companies|identityReview/);
});

test("changed publication waits for both speculative reads to settle before the single sequential options fallback", async t => {
  const warm = await warmedCatalogue(t), data = deferred();
  const ui = cacheUi(t, { ...warm, revision: AUTO_B, handle: ({ kind, counts }) => kind === "data" && counts.data === 1 ? data.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await settle();
  assert.deepEqual(ui.counts, { options: 0, data: 1, version: 1, status: 0 });
  data.resolve(jsonResponse(cachePayload(AUTO_A))); await opening;
  assert.deepEqual(ui.counts, { options: 1, data: 2, version: 2, status: 0 });
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_B);
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.catalogueSource, "server_catalogue");
  const reads = ui.calls.filter(c => new URL(c.url, "https://local.test").pathname === "/api/keyword-monthly");
  assert.equal(reads[0].settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
  assert.equal(Object.hasOwn(reads[1].settings.headers, "X-Keyword-Monthly-Prepared-Only"), false);
});

test("cache-hit data or version protection errors do not fan out into options retries", async t => {
  for (const blocked of ["data", "version"]) {
    const warm = await warmedCatalogue(t), ui = cacheUi(t, { ...warm, handle: ({ kind }) => kind === blocked ? jsonResponse({ code: "KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE" }, 503) : undefined });
    await ui.ready; await ui.controller.open();
    assert.deepEqual(ui.counts, { options: 0, data: 1, version: 1, status: 0 });
    assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503"); assert.equal(ui.find("kma-metric").length, 0);
    assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, undefined);
    assert.equal(warm.storage.getItem(CATALOGUE_KEY), null);
  }
});

test("a cache validation authentication failure clears persistence before an obsolete data body can be adopted", async t => {
  const warm = await warmedCatalogue(t), gate = deferred(); let reads = 0;
  const ui = cacheUi(t, { ...warm, handle: ({ kind }) => kind === "version" ? { ok: false, status: 403, json: async () => { reads++; return {}; } } : kind === "data" ? gate.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await settle();
  assert.equal(ui.controller.state().paused, true); assert.equal(reads, 0); assert.equal(warm.storage.getItem(CATALOGUE_KEY), null);
  gate.resolve(jsonResponse(cachePayload(AUTO_A))); await opening;
  assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.counts.options, 0);
});

test("logout without a mounted controller still removes the session metadata cache", async t => {
  const warm = await warmedCatalogue(t), ui = cacheUi(t, warm); await ui.ready;
  ui.controller.destroy(); assert.ok(warm.storage.getItem(CATALOGUE_KEY)); ui.api.clear();
  assert.equal(warm.storage.getItem(CATALOGUE_KEY), null); assert.equal(warm.storage.getItem(SELECTION_KEY), null);
});

test("another fresh login cannot reuse the preceding login catalogue even for the same account", async t => {
  const warm = await warmedCatalogue(t), session = { ...warm.session, sessionCreatedAt: new Date(Date.parse(warm.session.sessionCreatedAt) + 1).toISOString() };
  const ui = cacheUi(t, { storage: warm.storage, session }); await ui.ready; await ui.controller.open(cacheContext());
  assert.equal(ui.counts.options, 1); assert.equal(ui.counts.data, 1); assert.equal(ui.calls.filter(c => c.settings.headers["X-Keyword-Monthly-Prepared-Only"] === "1").length, 0);
});

test("unknown version, mismatched pointer or a missing prepared capability discards the cache and falls back once", async t => {
  for (const corrupt of ["version", "data", "capability"]) {
    const warm = await warmedCatalogue(t), ui = cacheUi(t, { ...warm, handle: ({ kind, counts }) => {
      if (kind === "version" && counts.version === 1 && corrupt === "version") return jsonResponse({ status: "unknown" });
      if (kind === "data" && counts.data === 1 && corrupt !== "version") return jsonResponse(corrupt === "data" ? cachePayload(AUTO_B) : { ...cachePayload(AUTO_A), preparedResult: undefined });
    } });
    await ui.ready; await ui.controller.open();
    assert.equal(ui.counts.options, 1); assert.equal(ui.counts.data, 2); assert.equal(ui.counts.version, 2);
    assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.catalogueSource, "server_catalogue");
    assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_A);
  }
});

test("a tampered cached cutoff is prepared-only and cannot trigger a legacy read before live options restore it", async t => {
  const warm = await warmedCatalogue(t), entry = JSON.parse(warm.storage.getItem(CATALOGUE_KEY)), selection = JSON.parse(warm.storage.getItem(SELECTION_KEY));
  entry.metadata.keywords.find(row => row.keyword === KEYWORD).supportedCutoffs["2026-10"] = "2026-10-31";
  selection.selection.cutoffMode = "auto"; warm.storage.setItem(CATALOGUE_KEY, JSON.stringify(entry)); warm.storage.setItem(SELECTION_KEY, JSON.stringify(selection));
  const ui = cacheUi(t, { ...warm, handle: ({ kind, settings, selection }) => {
    if (kind === "data" && selection.cutoffDate === "2026-10-31") {
      assert.equal(settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
      return jsonResponse({ status: "missing", snapshot: null, request: selection, preparedResult: { status: "not_prepared" } });
    }
  } });
  await ui.ready; await ui.controller.open();
  assert.equal(ui.counts.options, 1); assert.equal(ui.counts.data, 2); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
  const reads = ui.calls.filter(c => new URL(c.url, "https://local.test").pathname === "/api/keyword-monthly");
  assert.equal(new URL(reads[1].url, "https://local.test").searchParams.get("cutoffDate"), "2026-10-30");
});

test("unavailable background protection status remains visible without undoing verified cached data or retrying", async t => {
  const warm = await warmedCatalogue(t), ui = cacheUi(t, { ...warm, handle: ({ kind }) => kind === "status" ? jsonResponse({}, 503) : undefined });
  await ui.ready; await ui.controller.open(); await settle();
  assert.equal(ui.counts.options, 0); assert.equal(ui.counts.status, 1); assert.equal(ui.counts.data, 1);
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_A);
  assert.equal(ui.controller.state().automatic.initial.outcome, "complete"); assert.equal(ui.controller.state().errorCode, "");
  assert.match(ui.text(), /갱신·보호 상태를 확인하지 못했습니다/);
});

test("an observed partial catalogue removes an older complete metadata cache even when the pointer is unchanged", async t => {
  const storage = memorySelectionStorage(), session = liveSession(); let partial = false;
  const ui = cacheUi(t, { storage, session, handle: ({ kind }) => {
    if (kind === "options" && partial) { const value = cacheOptions(AUTO_A); value.diagnostics = ["KEYWORD_MONTHLY_PARTITION_UNAVAILABLE"]; return jsonResponse(value); }
  } });
  await ui.ready; await ui.controller.open(cacheContext()); assert.ok(storage.getItem(CATALOGUE_KEY));
  partial = true; await ui.controller.open(cacheContext());
  assert.equal(storage.getItem(CATALOGUE_KEY), null); assert.match(ui.text(), /저장 자료 목록 확인사항/);
});

test("hiding a pending cached-status read ends checking truthfully without retries or late status adoption", async t => {
  const warm = await warmedCatalogue(t), clock = automaticClock(), gate = deferred(); let signal;
  const ui = cacheUi(t, { ...warm, clock, interval: 250, handle: ({ kind, settings }) => {
    if (kind === "status") { signal = settings.signal; return gate.promise; }
  } });
  await ui.ready; await ui.controller.open(); await settle();
  const metrics = ui.find("kma-dashboard-metrics")[0], charts = ui.chartCalls.length;
  assert.ok(metrics); assert.equal(ui.counts.status, 1); assert.equal(signal.aborted, false);
  assert.match(ui.text(), /갱신·보호 상태는 운영 서버에서 확인 중/);
  ui.doc.hidden = true; ui.listeners.visibilitychange();
  assert.equal(signal.aborted, true); assert.doesNotMatch(ui.text(), /갱신·보호 상태는 운영 서버에서 확인 중/);
  assert.match(ui.text(), /갱신·보호 상태를 확인하지 못했습니다/);
  ui.doc.hidden = false; ui.listeners.visibilitychange(); await clock.advance(500);
  assert.equal(ui.counts.version, 4); assert.equal(ui.counts.status, 1, "Cancellation never creates a retry loop");
  gate.resolve(jsonResponse({ status: "available", errorCode: null, started: true })); await settle();
  assert.match(ui.text(), /갱신·보호 상태를 확인하지 못했습니다/);
  assert.equal(ui.find("kma-dashboard-metrics")[0], metrics); assert.equal(ui.chartCalls.length, charts);
  await ui.controller.open(cacheContext());
  assert.doesNotMatch(ui.text(), /갱신·보호 상태를 확인하지 못했습니다/);
  assert.equal(ui.counts.options, 1, "An explicit live-options retry restores the ordinary status contract");
});

test("automatic prepared refresh polls only a lightweight version when the published pointer is unchanged", async t => {
  const ui = await automaticUi(t), baseline = automaticVisibleState(ui), charts = ui.chartCalls.length;
  assert.deepEqual(ui.counts, { version: 1, options: 1, data: 1 });
  await ui.clock.advance(249); assert.equal(ui.counts.version, 1);
  await ui.clock.advance(1); assert.deepEqual(ui.counts, { version: 2, options: 1, data: 1 });
  await ui.clock.advance(500); assert.deepEqual(ui.counts, { version: 4, options: 1, data: 1 });
  assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(ui.chartCalls.length, charts);
  assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().automatic.failureCount, 0);
  assert.ok(ui.calls.every(call => call.settings.method === "GET" && call.settings.credentials === "same-origin" && call.settings.cache === "no-store" && !call.settings.body));
});

test("automatic prepared refresh sends the prepared-only header solely on its staged data GET", async t => {
  const ui = await automaticUi(t), header = "X-Keyword-Monthly-Prepared-Only";
  assert.ok(ui.calls.every(call => !Object.hasOwn(call.settings.headers, header)), "Initial manual options and data retain their existing contract");
  ui.source.revision = AUTO_B; await ui.clock.advance(250);
  assert.equal(ui.controller.state().automatic.revision, AUTO_B);
  const preparedCalls = ui.calls.filter(call => Object.hasOwn(call.settings.headers, header));
  assert.equal(preparedCalls.length, 1); assert.equal(preparedCalls[0].settings.headers[header], "1");
  assert.equal(new URL(preparedCalls[0].url, "https://local.test").pathname, "/api/keyword-monthly");
  assert.equal(preparedCalls[0].settings.method, "GET"); assert.equal(preparedCalls[0].settings.body, undefined);
  for (const call of ui.calls.filter(call => /\/(?:version|options)$/.test(call.url))) assert.equal(Object.hasOwn(call.settings.headers, header), false);
  const before = ui.calls.length; await ui.controller.refresh();
  assert.equal(ui.calls.length, before + 1); assert.equal(Object.hasOwn(ui.calls.at(-1).settings.headers, header), false, "An explicit manual read may use the ordinary GET contract");
  assert.equal(ui.calls.filter(call => Object.hasOwn(call.settings.headers, header)).length, 1);
});

test("automatic prepared refresh watches initial missing or503 results without claiming stored normal data", async t => {
  for (const initialFailure of ["missing", "503"]) {
    let ready = false;
    const ui = await automaticUi(t, { handle: ({ kind, source, selection }) => {
      if (kind !== "data" || ready) return;
      return initialFailure === "503" ? jsonResponse({ code: "KEYWORD_MONTHLY_PREPARED_UNAVAILABLE", status: "needs_verification", snapshot: null }, 503)
        : jsonResponse({ ...automaticPayload(source.revision, selection), status: "missing", snapshot: null, diagnostics: ["KEYWORD_MONTHLY_SCOPE_NOT_PREPARED"] });
    } });
    const selection = clone(ui.controller.state().selection);
    assert.ok(selection.keyword); assert.ok(ui.controller.state().applied); assert.equal(ui.controller.state().automatic.revision, null);
    assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().showingStored, false);
    ui.source.revision = AUTO_B;
    for (const [delay, failureCount, nextDelay] of [[250, 1, 500], [500, 2, 1000]]) {
      await ui.clock.advance(delay);
      assert.equal(ui.controller.state().automatic.revision, null, "A missing result's provenance is not an applied normal revision");
      assert.equal(ui.controller.state().automatic.failureCount, failureCount); assert.equal(ui.clock.nextDelay(), nextDelay);
      assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().showingStored, false);
      assert.deepEqual(clone(ui.controller.state().selection), selection);
      assert.doesNotMatch(text(ui.find("kma-auto-status")[0]), /기존 저장 자료를 유지|기존 저장 자료를 표시/);
    }
    assert.deepEqual(ui.counts, { version: 2, options: 3, data: 3 });
    ready = true; await ui.clock.advance(1000);
    assert.equal(ui.controller.state().automatic.revision, AUTO_B); assert.equal(ui.controller.state().automatic.failureCount, 0);
    assert.equal(ui.controller.state().automatic.errorCode, ""); assert.equal(ui.controller.state().errorCode, "");
    assert.equal(ui.controller.state().status, "available"); assert.ok(ui.find("kma-metric").length > 0);
    const applied = ui.controller.state().selection;
    for (const key of ["keyword", "month", "cutoffDate", "cutoffMode", "product"]) assert.equal(applied[key], selection[key], key);
    assert.equal(ui.clock.nextDelay(), 250);
    assert.deepEqual(ui.counts, { version: 4, options: 4, data: 4 });
  }
});

test("automatic prepared refresh stages a new normal pointer then preserves live choices drafts and disclosures", async t => {
  const gate = deferred(); let staged = false;
  const ui = await automaticUi(t, { companies: 43, handle: ({ kind, source, selection }) => {
    if (kind === "data" && source.revision === AUTO_B) { staged = true; return gate.promise; }
  } });
  ui.source.revision = AUTO_B; await ui.clock.advance(250); assert.equal(staged, true);
  assert.equal(ui.controller.state().automatic.checking, true); assert.equal(ui.controller.state().automatic.revision, AUTO_A);
  assert.equal(ui.controller.state().loading, false);
  await ui.button("데이유즈").fire("click"); ui.field("benchmarkCompany").value = "company-25"; await ui.field("benchmarkCompany").fire("change");
  const search = ui.field("companySearch"); assert.ok(search); search.value = "비교"; await search.fire("input");
  const next = ui.button("다음 업체"); assert.ok(next); await next.fire("click");
  const details = ui.find("kma-support-details")[0] || descendants(ui.parent).find(node => node.tagName === "DETAILS");
  assert.ok(details); details.open = true; await details.fire("toggle");
  ui.field("cutoffDate").value = "2026-10-25"; await ui.field("cutoffDate").fire("input");
  const state = automaticVisibleState(ui), beforeRequests = ui.calls.length;
  gate.resolve(jsonResponse(automaticPayload(AUTO_B, clone(ui.controller.state().applied), 43))); await settle();
  assert.equal(ui.controller.state().automatic.revision, AUTO_B); assert.equal(ui.controller.state().automatic.checking, false);
  assert.deepEqual(automaticVisibleState(ui), state); assert.equal(ui.calls.length, beforeRequests);
  assert.equal(ui.controller.state().product, "dayuse"); assert.equal(ui.controller.state().benchmarkCompanyId, "company-25");
  assert.equal(ui.controller.state().draft.cutoffDate, "2026-10-25"); assert.ok(Object.values(ui.controller.state().expanded).includes(true));
});

test("automatic prepared refresh advances automatic cutoff but leaves an explicit cutoff fixed", async t => {
  const automatic = await automaticUi(t), explicit = await automaticUi(t);
  await explicit.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-29", cutoffMode: "explicit" });
  for (const ui of [automatic, explicit]) { ui.source.revision = AUTO_B; ui.source.day = "2026-10-31"; await ui.clock.advance(250); }
  assert.equal(automatic.controller.state().selection.cutoffDate, "2026-10-31"); assert.equal(automatic.controller.state().cutoffMode, "auto");
  assert.equal(explicit.controller.state().selection.cutoffDate, "2026-10-29"); assert.equal(explicit.controller.state().cutoffMode, "explicit");
  assert.equal(explicit.controller.state().automatic.revision, AUTO_B);
});

test("automatic prepared refresh rejects mismatched option and payload revisions without changing normal state", async t => {
  for (const mismatched of ["options", "data"]) {
    const ui = await automaticUi(t), baseline = automaticVisibleState(ui), heading = text(ui.find("kma-dashboard-metrics")[0]);
    ui.source.revision = AUTO_B; ui.source[mismatched === "options" ? "optionsRevision" : "payloadRevision"] = AUTO_C;
    await ui.clock.advance(250);
    assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(text(ui.find("kma-dashboard-metrics")[0]), heading);
    assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().automatic.failureCount, 1);
    assert.ok(ui.controller.state().automatic.errorCode); assert.ok(ui.find("kma-auto-status").some(node => !node.hidden));
  }
});

test("automatic prepared refresh keeps last good data for HTTP malformed missing stale and mismatched new results", async t => {
  const failures = [
    () => htmlFailure(502), () => jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, 503),
    () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => { throw Error("PRIVATE_PARSE_DETAIL"); } }),
    () => jsonResponse({ ...automaticPayload(AUTO_B), status: "missing", snapshot: null }),
    () => jsonResponse({ ...automaticPayload(AUTO_B), status: "stale", diagnostics: ["PROJECTION_EXPIRED"] }),
    () => jsonResponse(automaticPayload(AUTO_B, { keyword: OTHER, month: "2026-10", cutoffDate: "2026-10-30" })),
    () => { const value = automaticPayload(AUTO_B); value.snapshot.daily.push(value.snapshot.daily[0]); return jsonResponse(value); }
  ];
  for (const response of failures) {
    const ui = await automaticUi(t, { handle: ({ kind, source }) => kind === "data" && source.revision === AUTO_B ? response() : undefined });
    const baseline = automaticVisibleState(ui), normal = text(ui.find("kma-dashboard-metrics")[0]); ui.source.revision = AUTO_B;
    await ui.clock.advance(250);
    assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(text(ui.find("kma-dashboard-metrics")[0]), normal);
    assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().automatic.failureCount, 1);
    assert.doesNotMatch(ui.text(), /PRIVATE_PARSE_DETAIL/);
  }
});

test("automatic prepared refresh refuses an unavailable selected scope or explicit cutoff without switching defaults", async t => {
  for (const changed of ["scope", "cutoff"]) {
    const ui = await automaticUi(t, { handle: ({ kind, source }) => {
      if (kind !== "options" || source.revision !== AUTO_B) return;
      const catalog = automaticOptions(AUTO_B);
      if (changed === "scope") catalog.keywords = catalog.keywords.filter(row => row.keyword !== KEYWORD);
      else catalog.keywords[0].supportedCutoffs = { "2026-10": "2026-10-30" };
      return jsonResponse(catalog);
    } });
    if (changed === "cutoff") await ui.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-29", cutoffMode: "explicit" });
    const baseline = automaticVisibleState(ui), dataReads = ui.counts.data; ui.source.revision = AUTO_B; await ui.clock.advance(250);
    assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(ui.counts.data, dataReads);
    assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.ok(ui.controller.state().automatic.errorCode);
  }
});

test("automatic prepared refresh cancels on manual scope changes and ignores an obsolete failed or unauthorized response", async t => {
  for (const response of [htmlFailure(503), htmlFailure(401)]) {
    const gate = deferred(); let signal;
    const ui = await automaticUi(t, { handle: ({ kind, source, settings }) => {
      if (kind === "data" && source.revision === AUTO_B) { signal = settings.signal; return gate.promise; }
    } });
    ui.source.revision = AUTO_B; await ui.clock.advance(250); assert.ok(signal); assert.equal(signal.aborted, false);
    ui.source.revision = AUTO_C;
    await ui.controller.open({ keyword: OTHER, month: "2026-10", cutoffDate: "2026-10-30", cutoffMode: "explicit" });
    assert.equal(signal.aborted, true); gate.resolve(response); await settle();
    assert.equal(ui.controller.state().selection.keyword, OTHER); assert.equal(ui.controller.state().paused, false);
    assert.equal(ui.controller.state().errorCode, ""); assert.equal(ui.controller.state().automatic.errorCode, "");
    assert.match(ui.text(), /경남 글램핑 업체/);
  }
});

test("automatic prepared refresh remains one flight during slow checks and repeated visibility events", async t => {
  const gate = deferred(); let signal;
  const ui = await automaticUi(t, { timeout: 5000, handle: ({ kind, settings }) => {
    if (kind === "version") { signal = settings.signal; return gate.promise; }
  } });
  await ui.clock.advance(250); assert.equal(ui.counts.version, 2); assert.equal(ui.controller.state().automatic.checking, true);
  for (let index = 0; index < 3; index++) ui.listeners.visibilitychange();
  await ui.clock.advance(1000); assert.equal(ui.counts.version, 2); assert.equal(signal.aborted, false);
  gate.resolve(jsonResponse(automaticVersion(AUTO_A))); await settle(); assert.equal(ui.controller.state().automatic.checking, false);
  assert.equal(ui.clock.nextDelay(), 250);
});

test("automatic prepared refresh stops hidden inactive destroyed and revoked controllers including late responses", async t => {
  for (const action of ["hidden", "inactive", "paused", "role", "customer", "clear", "destroy"]) {
    const gate = deferred(); let signal;
    const ui = await automaticUi(t, { handle: ({ kind, settings }) => {
      if (kind === "version") { signal = settings.signal; return gate.promise; }
    } });
    await ui.clock.advance(250); assert.ok(signal);
    if (action === "hidden") { ui.doc.hidden = true; ui.listeners.visibilitychange(); }
    else if (action === "inactive") { ui.parent.screenHidden = true; ui.listeners.visibilitychange(); }
    else if (action === "paused") ui.controller.pause();
    else if (action === "role" || action === "customer") { ui.doc.body.className = action === "role" ? "role-b2b" : "role-admin admin-user-view"; ui.observers[0].callback(); }
    else if (action === "clear") ui.api.clear(); else ui.controller.destroy();
    assert.equal(signal.aborted, true, action); const before = ui.calls.length;
    gate.resolve(jsonResponse(automaticVersion(AUTO_B))); await ui.clock.advance(10000);
    assert.equal(ui.calls.length, before, action); assert.equal(ui.controller.state().automatic.checking, false, action);
    if (["role", "customer", "clear", "destroy"].includes(action)) assert.equal(ui.find("kma-metric").length, 0, action);
  }
});

test("automatic prepared refresh erases private data before parsing authoritative authentication failures", async t => {
  for (const status of [401, 403, "redirect"]) {
    let bodyReads = 0;
    const ui = await automaticUi(t, { handle: ({ kind }) => kind === "version" ? {
      ...htmlFailure(status === "redirect" ? 200 : status), ...(status === "redirect" ? { redirected: true, url: "https://local.test/login?expired=1" } : {}),
      json: async () => { bodyReads++; throw Error("PRIVATE_AUTH_BODY"); }
    } : undefined });
    await ui.clock.advance(250); assert.equal(bodyReads, 0); assert.equal(ui.controller.state().paused, true);
    assert.equal(ui.controller.state().selection.keyword, ""); assert.equal(ui.find("kma-metric").length, 0);
    const before = ui.calls.length; await ui.clock.advance(10000); assert.equal(ui.calls.length, before);
  }
});

test("automatic prepared refresh backs off boundedly then resets after recovery without visibility retry bypass", async t => {
  let failing = true;
  const ui = await automaticUi(t, { handle: ({ kind }) => kind === "version" && failing ? htmlFailure(503) : undefined });
  await ui.clock.advance(250); assert.equal(ui.controller.state().automatic.failureCount, 1); assert.equal(ui.clock.nextDelay(), 500);
  const before = ui.counts.version;
  for (let index = 0; index < 3; index++) { ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); }
  await settle(); assert.equal(ui.counts.version, before); assert.equal(ui.clock.nextDelay(), 500);
  let delay = 500;
  for (let count = 2; count <= 13; count++) {
    await ui.clock.advance(delay); delay = Math.min(300000, 250 * 2 ** count);
    assert.equal(ui.controller.state().automatic.failureCount, count); assert.equal(ui.clock.nextDelay(), delay);
  }
  failing = false; await ui.clock.advance(delay);
  assert.equal(ui.controller.state().automatic.failureCount, 0); assert.equal(ui.controller.state().automatic.errorCode, ""); assert.equal(ui.clock.nextDelay(), 250);
});

test("automatic prepared refresh times out an abort-ignoring version read without accepting its late publication", async t => {
  const gate = deferred(); let signal;
  const ui = await automaticUi(t, { timeout: 100, handle: ({ kind, settings }) => {
    if (kind === "version") { signal = settings.signal; return gate.promise; }
  } });
  await ui.clock.advance(250); await ui.clock.advance(100);
  assert.equal(signal.aborted, true); assert.equal(ui.controller.state().automatic.checking, false);
  assert.equal(ui.controller.state().automatic.failureCount, 1); assert.ok(ui.controller.state().automatic.errorCode);
  const before = ui.calls.length; gate.resolve(jsonResponse(automaticVersion(AUTO_B))); await settle();
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().loading, false);
});

test("automatic prepared refresh restores the active company search and caret after replacing result DOM", async t => {
  const ui = await automaticUi(t, { companies: 43 }), search = ui.field("companySearch");
  search.value = "비교 업체 2"; await search.fire("input"); search.focus(); search.setSelectionRange(2, 5, "backward");
  const baseline = automaticVisibleState(ui); ui.source.revision = AUTO_B; await ui.clock.advance(250);
  const restored = ui.field("companySearch"); assert.notEqual(restored, search, "The new result really replaced the search element");
  assert.equal(ui.controller.state().automatic.revision, AUTO_B); assert.deepEqual(automaticVisibleState(ui), baseline);
  assert.equal(ui.doc.activeElement, restored); assert.equal(restored.value, "비교 업체 2");
  assert.deepEqual([restored.selectionStart, restored.selectionEnd, restored.selectionDirection], [2, 5, "backward"]);
  assert.equal(restored.focusOptions?.preventScroll, true); assert.equal(ui.doc.scrolls.length, 0);
});

test("automatic prepared refresh defers publication during Korean IME composition then applies after composition ends", async t => {
  const ui = await automaticUi(t), search = ui.field("companySearch");
  search.focus(); await search.fire("compositionstart"); search.value = "비"; await search.fire("input"); search.setSelectionRange(1, 1);
  const baseline = automaticVisibleState(ui); ui.source.revision = AUTO_B; await ui.clock.advance(250);
  assert.equal(ui.field("companySearch"), search, "An active composition must keep its existing DOM input");
  assert.equal(ui.doc.activeElement, search); assert.deepEqual(automaticVisibleState(ui), baseline);
  assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().automatic.failureCount, 0);
  assert.equal(ui.controller.state().automatic.errorCode, ""); assert.equal(ui.controller.state().automatic.checking, false);
  assert.match(text(ui.find("kma-auto-status")[0]), /입력 중/); assert.equal(ui.clock.nextDelay(), 250);
  assert.deepEqual(ui.counts, { version: 2, options: 2, data: 2 });
  await search.fire("compositionend"); search.value = "비교"; await search.fire("input"); search.setSelectionRange(2, 2);
  await ui.clock.advance(249); assert.equal(ui.controller.state().automatic.revision, AUTO_A);
  await ui.clock.advance(1);
  assert.equal(ui.controller.state().automatic.revision, AUTO_B); assert.equal(ui.controller.state().automatic.failureCount, 0);
  assert.equal(ui.controller.state().listQuery, "비교"); assert.notEqual(ui.field("companySearch"), search);
  assert.equal(ui.doc.activeElement, ui.field("companySearch")); assert.deepEqual([ui.doc.activeElement.selectionStart, ui.doc.activeElement.selectionEnd], [2, 2]);
  assert.deepEqual(ui.counts, { version: 3, options: 3, data: 3 });
});

test("automatic prepared refresh rejects malformed or unverified version metadata without reading a financial result", async t => {
  for (const patch of [{ schemaVersion: 2 }, { status: "needs_verification" }, { revision: "invalid" }, { generation: "invalid" },
    { publishedAt: "invalid" }, { currentDay: "2026-02-30" }, { readOnly: false }, { networkAttempted: true }, { originalFreshnessVerified: true }]) {
    const ui = await automaticUi(t, { handle: ({ kind }) => kind === "version" ? jsonResponse({ ...automaticVersion(AUTO_B), ...patch }) : undefined });
    const baseline = automaticVisibleState(ui); await ui.clock.advance(250);
    assert.deepEqual(ui.counts, { version: 2, options: 1, data: 1 }); assert.deepEqual(automaticVisibleState(ui), baseline);
    assert.equal(ui.controller.state().automatic.revision, AUTO_A); assert.equal(ui.controller.state().automatic.failureCount, 1);
  }
});
test("unknown safe reason codes remain bounded readable text without markup execution", async () => {
  const review = identityReviewFixture({ reasonCounts: { FUTURE_LINK_REASON: 5 } });
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = review;
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : payload) }); await ui.controller.open();
  assert.match(text(ui.find("kma-identity-review")[0]), /기타 연결 근거 확인 · FUTURE_LINK_REASON.*5건/);
  assert.equal(uiModule.identityReviewView({ ...review, reasonCounts: { '<img src=x onerror="unsafe">': 5 } }).status, "invalid");
});
test("identity review disclosure survives F5 with the same applied company/month/product and no extra requests", async () => {
  const storage = memorySelectionStorage(), session = liveSession();
  const request = async url => { if (url.endsWith("/catalogue")) return jsonResponse(optionsFixture()); const q = new URL(url, "https://local.test"), payload = payloadFixture(Object.fromEntries(q.searchParams)); payload.snapshot.quality.identityReview = identityReviewFixture(); return jsonResponse(payload); };
  const first = mockUi({ storage, session, request }); await first.ready; await first.controller.open();
  first.field("benchmarkCompany").value = "a"; await first.field("benchmarkCompany").fire("change");
  const block = first.find("kma-identity-review")[0]; block.parentNode.open = true; await block.parentNode.fire("toggle");
  const before = clone(first.controller.state().selection); assert.equal(first.calls.length, 2); first.controller.destroy();
  const again = mockUi({ storage, session, request }); await again.ready; await again.controller.open();
  assert.deepEqual(clone(again.controller.state().selection), before); assert.equal(again.find("kma-identity-review")[0].parentNode.open, true); assert.equal(again.calls.length, 2);
});

test("request diagnostics keep the existing twenty-second deadline and contain no request identity or response text", async () => {
  const ui = mockUi(); await ui.controller.open(); const diagnostic = clone(ui.controller.state().requestDiagnostic);
  assert.equal(diagnostic.kind, "data"); assert.equal(diagnostic.stage, "body"); assert.equal(diagnostic.outcome, "complete"); assert.equal(diagnostic.deadlineMs, 20000);
  assert.equal(diagnostic.httpStatus, 200); assert.equal(diagnostic.headersReceived, true); assert.equal(diagnostic.bodyDecoded, true); assert.equal(diagnostic.code, null); assert.deepEqual(diagnostic.details, []);
  assert.ok(Number.isSafeInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0); assert.doesNotMatch(JSON.stringify(diagnostic), /\/api|keyword|company|경남|token|cookie|secret|payload/i);
  assert.equal(ui.find("kma-query-diagnostic")[0].hidden, true); ui.controller.destroy();
});

for (const kind of ["options", "data", "body"]) test(`an actual request deadline identifies ${kind} waiting while preserving the same saved values`, async () => {
  const gate = deferred(); let waiting = false;
  const ui = mockUi({ requestTimeoutMs: 15, request: async url => {
    const options = url.endsWith("/catalogue"), value = options ? optionsFixture() : payloadFixture();
    if (waiting && kind === "options" && options || waiting && kind === "data" && !options) return gate.promise;
    if (waiting && kind === "body" && !options) return { ...jsonResponse(value), json: async () => gate.promise };
    return jsonResponse(value);
  } });
  await ui.controller.open(); const selection = clone(ui.controller.state().selection); waiting = true;
  await (kind === "options" ? ui.controller.open(selection) : ui.controller.refresh());
  const state = ui.controller.state(), diagnostic = clone(state.requestDiagnostic), node = ui.find("kma-query-diagnostic")[0];
  assert.equal(state.errorCode, "KEYWORD_MONTHLY_TIMEOUT"); assert.equal(state.showingStored, true); assert.equal(state.loading, false); assert.match(ui.text(), /400원/); assert.deepEqual(clone(state.selection), selection);
  assert.equal(diagnostic.kind, kind === "options" ? "options" : "data"); assert.equal(diagnostic.stage, kind); assert.equal(diagnostic.outcome, "timed_out"); assert.equal(diagnostic.code, "KEYWORD_MONTHLY_TIMEOUT");
  assert.equal(diagnostic.deadlineMs, 15); assert.ok(Number.isSafeInteger(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 10 && diagnostic.elapsedMs < 5000);
  assert.equal(diagnostic.headersReceived, kind === "body"); assert.equal(diagnostic.bodyDecoded, false); assert.equal(diagnostic.httpStatus, kind === "body" ? 200 : null); assert.equal(node.hidden, false);
  assert.equal(node.dataset.requestStage, kind); assert.equal(node.dataset.deadlineMs, "15"); assert.match(node.textContent, kind === "body" ? /본문 수신·해석.*HTTP 200.*JSON 수신 미완료/ : /응답 대기.*HTTP 응답 미수신/);
  assert.equal(ui.calls.at(-1).settings.signal.aborted, true); const calls = ui.calls.length;
  gate.resolve(kind === "body" ? payloadFixture() : jsonResponse(kind === "options" ? optionsFixture() : payloadFixture())); await settle();
  assert.equal(ui.calls.length, calls); assert.deepEqual(clone(ui.controller.state().requestDiagnostic), diagnostic); ui.controller.destroy();
});

for (const code of ["KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE", "KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED"]) for (const kind of ["options", "data"]) test(`${kind} ${code} explains the protection without altering the saved view or retrying`, async () => {
  const value = dashboardPayload(43); let held = false;
  const ui = mockUi({ request: async url => held && (url.endsWith("/catalogue") ? kind === "options" : kind === "data")
    ? jsonResponse({ code, message: "SECRET_RAW_FAILURE", diagnostics: ["KEYWORD_MONTHLY_MEMORY_DEFERRED", "<private>"], ownerToken: "SECRET_OWNER", path: "/var/data/SECRET" }, 503)
    : jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : value) });
  await ui.controller.open(); ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input"); await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click"); await ui.button("데이유즈").fire("click");
  ui.field("cutoffDate").value = "2026-10-29"; await ui.field("cutoffDate").fire("input"); const before = clone(ui.controller.state()); held = true;
  await (kind === "options" ? ui.controller.open(clone(before.selection)) : ui.controller.refresh()); const after = clone(ui.controller.state()), diagnostic = after.requestDiagnostic;
  for (const key of ["selection", "draft", "applied", "benchmarkCompanyId", "listQuery", "listPage", "product", "expanded"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.showingStored, true); assert.equal(after.benchmarkCompanyId, "company-25"); assert.equal(after.listPage, 2); assert.ok(ui.find("kma-metric").length > 0);
  assert.equal(diagnostic.kind, kind); assert.equal(diagnostic.stage, "body"); assert.equal(diagnostic.outcome, "failed"); assert.equal(diagnostic.httpStatus, 503); assert.equal(diagnostic.bodyDecoded, true); assert.ok(diagnostic.details.includes(code));
  assert.match(ui.find("kma-error")[0].textContent, /저장 집계 변환 작업/); assert.ok(ui.find("kma-error")[0].textContent.includes(code)); assert.doesNotMatch(ui.text(), /SECRET|private|\/var\/data/); assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|private|\/var\/data|ownerToken/);
  const count = ui.calls.length; ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle(); assert.equal(ui.calls.length, count); ui.controller.destroy();
});

test("obsolete failure diagnostics cannot replace a newer successful selection and authentication clears diagnostics", async () => {
  const gate = deferred(); let dataReads = 0, auth = false;
  const ui = mockUi({ request: async url => auth ? htmlFailure(401) : url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : ++dataReads === 2 ? gate.promise : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle(); ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  const latest = clone(ui.controller.state().requestDiagnostic); gate.resolve(jsonResponse({ code: "KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE" }, 503)); await old;
  assert.equal(ui.controller.state().selection.keyword, OTHER); assert.equal(ui.controller.state().errorCode, ""); assert.deepEqual(clone(ui.controller.state().requestDiagnostic), latest); assert.equal(ui.find("kma-query-diagnostic")[0].hidden, true);
  auth = true; await ui.controller.refresh(); assert.equal(ui.controller.state().requestDiagnostic, null); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_AUTH_REQUIRED"); assert.equal(ui.find("kma-query-diagnostic")[0].textContent, ""); assert.equal(ui.find("kma-query-diagnostic")[0].dataset.requestStage, ""); ui.controller.destroy();
});

test("invalid submitted conditions replace an earlier timeout code and clear its diagnostic without another GET", async () => {
  const gate = deferred(); let waiting = false;
  const ui = mockUi({ requestTimeoutMs: 15, request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : waiting ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); waiting = true; await ui.controller.refresh(); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_TIMEOUT"); const count = ui.calls.length;
  ui.field("month").value = "2027-01"; await ui.field("month").fire("change"); await ui.apply(); assert.equal(ui.calls.length, count); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_SELECTION_INVALID"); assert.equal(ui.controller.state().requestDiagnostic, null); assert.match(ui.find("kma-error")[0].textContent, /실제 관측 숙박월/); assert.equal(ui.find("kma-query-diagnostic")[0].hidden, true);
  gate.resolve(jsonResponse(payloadFixture())); await settle(); ui.controller.destroy();
});

test("only the bounded opaque trace header is retained and raw timing or response headers are never copied", async () => {
  for (const candidate of [null, "", "A".repeat(24), "a".repeat(25), "SECRET_RAW_HEADER", "a".repeat(24)]) {
    const ui = mockUi({ request: async url => url.endsWith("/catalogue") ? jsonResponse(optionsFixture()) : { ...jsonResponse({ code: "KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE" }, 503),
      headers: { get(name) { return name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "x-keyword-monthly-trace" ? candidate : "SECRET_RAW_TIMING_OR_HEADER"; } } } });
    await ui.controller.open(); const diagnostic = clone(ui.controller.state().requestDiagnostic), valid = candidate === "a".repeat(24);
    assert.equal(diagnostic.traceId, valid ? candidate : null); assert.equal(ui.find("kma-query-diagnostic")[0].dataset.traceId, valid ? candidate : ""); assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|server-timing|"headers"|"timing"/i);
    ui.controller.clear(); assert.equal(ui.controller.state().requestDiagnostic, null); assert.equal(ui.find("kma-query-diagnostic")[0].dataset.traceId, ""); ui.controller.destroy();
  }
});

for (const kind of ["options", "data"]) test(`${kind} analytical protection preserves the exact saved view and requires an explicit retry`, async () => {
  const code = "KEYWORD_MONTHLY_ANALYTICAL_BUSY", value = dashboardPayload(43); let held = false;
  const ui = mockUi({ request: async url => held && (url.endsWith("/catalogue") ? kind === "options" : kind === "data")
    ? jsonResponse({ code, activeKind: "SECRET_INTERNAL_OWNER", message: "SECRET_RAW_FAILURE" }, 503) : jsonResponse(url.endsWith("/catalogue") ? optionsFixture() : value) });
  await ui.controller.open(); ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input"); await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click"); await ui.button("데이유즈").fire("click");
  ui.field("cutoffDate").value = "2026-10-29"; await ui.field("cutoffDate").fire("input"); const before = clone(ui.controller.state()); held = true;
  await (kind === "options" ? ui.controller.open(clone(before.selection)) : ui.controller.refresh()); const after = clone(ui.controller.state());
  for (const key of ["selection", "draft", "applied", "benchmarkCompanyId", "listQuery", "listPage", "product", "expanded"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.showingStored, true); assert.equal(after.errorCode, "KEYWORD_MONTHLY_HTTP_503"); assert.equal(after.requestDiagnostic.kind, kind); assert.equal(after.requestDiagnostic.outcome, "failed"); assert.equal(after.requestDiagnostic.httpStatus, 503); assert.equal(after.requestDiagnostic.deadlineMs, 20000); assert.ok(after.requestDiagnostic.details.includes(code));
  assert.match(ui.find("kma-error")[0].textContent, /대형 분석 작업의 보호 단계/); assert.match(ui.find("kma-error")[0].textContent, /기존 저장 자료를 유지/); assert.doesNotMatch(ui.text(), /SECRET|INTERNAL_OWNER/); assert.doesNotMatch(JSON.stringify(after.requestDiagnostic), /SECRET|activeKind/);
  const calls = ui.calls.length; ui.doc.hidden = true; ui.listeners.visibilitychange(); ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle(); assert.equal(ui.calls.length, calls);
  held = false; await ui.controller.open(clone(before.selection)); const restored = clone(ui.controller.state()); assert.equal(restored.errorCode, ""); assert.equal(restored.showingStored, false); assert.equal(restored.requestDiagnostic.outcome, "complete");
  for (const key of ["selection", "draft", "applied", "benchmarkCompanyId", "listQuery", "listPage", "product", "expanded"]) assert.deepEqual(restored[key], before[key], key); assert.equal(ui.find("kma-query-diagnostic")[0].hidden, true); ui.controller.destroy();
});

test("merged automatic version timeout diagnoses its own bounded controller and deadline without changing financial values", async t => {
  const gate = deferred(); const ui = await automaticUi(t, { timeout: 100, handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
  const baseline = automaticVisibleState(ui); await ui.clock.advance(250); await ui.clock.advance(100);
  const value = clone(ui.controller.state().requestDiagnostic);
  assert.equal(value.kind, "version"); assert.equal(value.stage, "version"); assert.equal(value.deadlineMs, 100); assert.equal(value.outcome, "timed_out");
  assert.equal(value.headersReceived, false); assert.equal(value.httpStatus, null); assert.match(ui.find("kma-query-diagnostic")[0].textContent, /저장 버전.*제한 0.1초/);
  assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(ui.controller.state().automatic.revision, AUTO_A);
  gate.resolve(jsonResponse(automaticVersion(AUTO_B))); await settle(); assert.deepEqual(clone(ui.controller.state().requestDiagnostic), value);
});

test("merged automatic prepared-only503 preserves the saved view and records only safe data protection diagnostics", async t => {
  const ui = await automaticUi(t, { handle: ({ kind, source }) => kind === "data" && source.revision === AUTO_B ? { ...jsonResponse({ code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY", message: "SECRET_SERVER_BODY" }, 503),
    headers: { get: name => name.toLowerCase() === "content-type" ? "application/json" : name.toLowerCase() === "x-keyword-monthly-trace" ? "a".repeat(24) : "SECRET_HEADER" } } : undefined });
  const baseline = automaticVisibleState(ui); ui.source.revision = AUTO_B; await ui.clock.advance(250);
  const state = ui.controller.state(), diagnostic = clone(state.requestDiagnostic);
  assert.deepEqual(automaticVisibleState(ui), baseline); assert.equal(state.automatic.revision, AUTO_A); assert.equal(state.showingStored, true);
  assert.equal(diagnostic.kind, "data"); assert.equal(diagnostic.stage, "body"); assert.equal(diagnostic.deadlineMs, 20000); assert.equal(diagnostic.httpStatus, 503);
  assert.equal(diagnostic.outcome, "failed"); assert.equal(diagnostic.traceId, "a".repeat(24)); assert.ok(diagnostic.details.includes("KEYWORD_MONTHLY_ANALYTICAL_BUSY"));
  assert.equal(ui.calls.at(-1).settings.headers["X-Keyword-Monthly-Prepared-Only"], "1"); assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|\/api|"keyword"|"company"/i);
});

test("merged late automatic failure cannot overwrite a newer manual request diagnostic", async t => {
  const gate = deferred(); const ui = await automaticUi(t, { handle: ({ kind, source }) => kind === "data" && source.revision === AUTO_B ? gate.promise : undefined });
  ui.source.revision = AUTO_B; await ui.clock.advance(250); ui.source.revision = AUTO_C;
  await ui.controller.open({ keyword: OTHER, month: "2026-10", cutoffDate: "2026-10-30", cutoffMode: "explicit" }); const latest = clone(ui.controller.state().requestDiagnostic);
  gate.resolve(jsonResponse({ code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY", message: "SECRET_OLD_ERROR" }, 503)); await settle();
  assert.deepEqual(clone(ui.controller.state().requestDiagnostic), latest); assert.equal(latest.outcome, "complete"); assert.equal(ui.controller.state().selection.keyword, OTHER);
  assert.equal(ui.controller.state().errorCode, ""); assert.doesNotMatch(ui.text(), /SECRET_OLD_ERROR/);
});

test("merged healthy version checks retain a manual failure diagnostic until its explicit financial retry succeeds", async t => {
  let held = false; const ui = await automaticUi(t, { handle: ({ kind }) => held && kind === "data" ? jsonResponse({ code: "KEYWORD_MONTHLY_ANALYTICAL_BUSY" }, 503) : undefined });
  held = true; await ui.controller.refresh(); const failed = clone(ui.controller.state().requestDiagnostic); await ui.clock.advance(250);
  assert.deepEqual(clone(ui.controller.state().requestDiagnostic), failed); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503");
  assert.deepEqual(ui.counts, { version: 2, options: 1, data: 2 }); assert.equal(ui.find("kma-query-diagnostic")[0].hidden, false);
  held = false; await ui.controller.refresh(); assert.equal(ui.controller.state().errorCode, ""); assert.equal(ui.controller.state().requestDiagnostic.outcome, "complete");
  assert.equal(ui.find("kma-query-diagnostic")[0].hidden, true);
});

async function warmLastGoodResult(t, { partial = false, companies = 30 } = {}) {
  const storage = memorySelectionStorage(), session = liveSession(), ui = cacheUi(t, { storage, session, companies,
    handle: ({ kind }) => {
      if (kind === "options" && partial) return jsonResponse({ ...cacheOptions(AUTO_A), status: "stale", diagnostics: ["KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT"] });
    } });
  await ui.ready; await ui.controller.open({ ...selectorFixture(), benchmarkCompanyId: "company-25" });
  for (let wait = 0; wait < 1000 && !storage.getItem(uiModule.RESULT_KEY); wait++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(storage.getItem(uiModule.RESULT_KEY)); const selection = clone(ui.controller.state().selection), metrics = ui.find("kma-dashboard-metrics").map(text);
  ui.controller.destroy(); return { storage, session, selection, metrics, companies };
}
async function untilUi(predicate) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("expected bounded asynchronous UI state");
}
test("same-session F5 displays a verified saved result before the live version finishes without claiming latest completion", async t => {
  const saved = await warmLastGoodResult(t), gate = deferred(), ui = cacheUi(t, { ...saved, handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await untilUi(() => ui.counts.version === 1);
  assert.deepEqual(clone(ui.controller.state().selection), saved.selection); assert.deepEqual(ui.find("kma-dashboard-metrics").map(text), saved.metrics);
  assert.equal(ui.controller.state().showingStored, true); assert.equal(ui.controller.state().automatic.initial.outcome, "running");
  assert.equal(ui.counts.options, 0); assert.equal(ui.counts.data, 0); assert.match(ui.text(), /마지막 정상 저장 자료를 표시하며 최신 상태를 확인/);
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.catalogueSource, "session_last_good_pending_version");
  gate.resolve(jsonResponse(automaticVersion(AUTO_A, cacheOptions(AUTO_A).currentDay))); await opening;
  assert.equal(ui.controller.state().automatic.initial.outcome, "complete"); assert.equal(ui.controller.state().showingStored, false);
  assert.deepEqual(ui.find("kma-dashboard-metrics").map(text), saved.metrics); assert.match(ui.text(), /같은 저장 버전을 확인/);
});
test("502 and503 version failure after F5 keep saved values and choices unconfirmed without an options retry", async t => {
  for (const status of [502, 503]) {
    const saved = await warmLastGoodResult(t), ui = cacheUi(t, { ...saved, handle: ({ kind }) => kind === "version" ? htmlFailure(status) : undefined });
    await ui.ready; await ui.controller.open();
    assert.deepEqual(clone(ui.controller.state().selection), saved.selection); assert.deepEqual(ui.find("kma-dashboard-metrics").map(text), saved.metrics);
    assert.equal(ui.controller.state().automatic.initial.outcome, "failed"); assert.equal(ui.controller.state().showingStored, true);
    assert.match(ui.text(), /최신 확인을 완료하지 못했습니다/); assert.equal(ui.counts.options, 0); assert.equal(ui.counts.data, 0); assert.equal(ui.counts.version, 1);
    assert.ok(saved.storage.getItem(uiModule.RESULT_KEY));
  }
});
test("changed publication stages a new prepared result after the saved initial display and keeps company search product and page", async t => {
  const saved = await warmLastGoodResult(t), gate = deferred(), ui = cacheUi(t, { ...saved, revision: AUTO_B,
    handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await untilUi(() => ui.counts.version === 1);
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_A);
  gate.resolve(jsonResponse(automaticVersion(AUTO_B, cacheOptions(AUTO_B).currentDay))); await opening;
  assert.equal(ui.find("keyword-monthly-analysis")[0].dataset.displayedPointerSha256, AUTO_B);
  assert.equal(ui.counts.options, 1); assert.equal(ui.counts.data, 1);
  assert.equal(ui.calls.find(call => new URL(call.url, "https://local.test").pathname === "/api/keyword-monthly").settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
  assert.deepEqual(clone(ui.controller.state().selection), saved.selection); assert.equal(ui.controller.state().automatic.initial.outcome, "complete");
});
test("a partial catalogue can retain a normal selected result without caching or replaying stale protection counts", async t => {
  const saved = await warmLastGoodResult(t, { partial: true }); assert.equal(saved.storage.getItem(CATALOGUE_KEY), null);
  const gate = deferred(), ui = cacheUi(t, { ...saved, handle: ({ kind }) => kind === "version" ? gate.promise : undefined });
  await ui.ready; const opening = ui.controller.open(); await untilUi(() => ui.counts.version === 1);
  assert.deepEqual(ui.find("kma-dashboard-metrics").map(text), saved.metrics); assert.equal(ui.counts.options, 0);
  assert.match(ui.text(), /갱신·보호 상태는 운영 서버에서 확인 중/); assert.doesNotMatch(ui.text(), /현재 갱신 작업/);
  gate.resolve(jsonResponse(automaticVersion(AUTO_A, cacheOptions(AUTO_A).currentDay))); await opening;
});
test("an authoritative401 after cached F5 immediately removes the saved financial result and session persistence", async t => {
  const saved = await warmLastGoodResult(t), ui = cacheUi(t, { ...saved, handle: ({ kind }) => kind === "version" ? htmlFailure(401) : undefined });
  await ui.ready; await ui.controller.open(); assert.equal(ui.find("kma-dashboard-metrics").length, 0); assert.equal(ui.controller.state().paused, true);
  assert.equal(saved.storage.getItem(uiModule.RESULT_KEY), null); assert.equal(saved.storage.getItem(SELECTION_KEY), null);
});
test("the new catalogue contract sends prepared-only on initial data and never needs strict legacy options", async t => {
  const ui = cacheUi(t, { session: liveSession(), storage: memorySelectionStorage(), handle: ({ kind }) => kind === "options"
    ? jsonResponse({ ...cacheOptions(AUTO_A), metadataOnly: true, financialResultValidated: false }) : undefined });
  await ui.ready; await ui.controller.open(cacheContext());
  assert.ok(ui.calls.some(call => call.url === "/api/keyword-monthly/catalogue")); assert.ok(ui.calls.every(call => call.url !== "/api/keyword-monthly/options"));
  const data = ui.calls.find(call => new URL(call.url, "https://local.test").pathname === "/api/keyword-monthly");
  assert.equal(data.settings.headers["X-Keyword-Monthly-Prepared-Only"], "1");
});
test("oversize or denied result storage keeps normal metrics and explains that F5 needs a server read", async t => {
  for (const mode of ["oversize", "quota"]) {
    const storage = memorySelectionStorage();
    if (mode === "quota") { const save = storage.setItem.bind(storage); storage.setItem = (key, value) => { if (key === uiModule.RESULT_KEY) throw Error("quota"); save(key, value); }; }
    const ui = cacheUi(t, { storage, session: liveSession(), companies: mode === "oversize" ? 43 : 3 });
    await ui.ready; await ui.controller.open(cacheContext());
    await untilUi(() => ui.find("keyword-monthly-analysis")[0].dataset.reloadCacheState === "unavailable");
    assert.ok(ui.find("kma-dashboard-metrics").length); assert.equal(ui.controller.state().errorCode, "");
    assert.equal(ui.controller.state().automatic.initial.outcome, "complete"); assert.equal(storage.getItem(uiModule.RESULT_KEY), null);
    assert.match(ui.text(), /현재 자료는 유지하며 새로고침하면 서버에서 다시 확인/);
  }
});
test("an authoritative unusable manual response invalidates the same stored scope before another F5", async t => {
  const saved = await warmLastGoodResult(t); let missing = false;
  const ui = cacheUi(t, { ...saved, handle: ({ kind, selection }) => missing && kind === "data"
    ? jsonResponse({ schemaVersion: 1, status: "missing", request: selection, snapshot: null, diagnostics: ["KEYWORD_MONTHLY_SCOPE_NOT_PREPARED"] }) : undefined });
  await ui.ready; await ui.controller.open(); assert.ok(saved.storage.getItem(uiModule.RESULT_KEY));
  missing = true; await ui.controller.refresh(); assert.equal(saved.storage.getItem(uiModule.RESULT_KEY), null); assert.equal(ui.find("kma-dashboard-metrics").length, 0);
  ui.controller.destroy();
  const again = cacheUi(t, { ...saved, handle: ({ kind, selection }) => kind === "data"
    ? jsonResponse({ schemaVersion: 1, status: "missing", request: selection, snapshot: null }) : undefined });
  await again.ready; await again.controller.open(); assert.equal(again.find("kma-dashboard-metrics").length, 0);
  assert.notEqual(again.find("keyword-monthly-analysis")[0].dataset.catalogueSource, "session_last_good_pending_version");
});
test("a missing selected scope invalidates its older disk cache even when memory holds another uncacheable scope", async t => {
  const saved = await warmLastGoodResult(t); let missing = false;
  const ui = cacheUi(t, { ...saved, handle: ({ kind, selection }) => {
    if (kind !== "data") return undefined;
    if (selection.keyword === OTHER) { const value = cachePayload(AUTO_A, selection); value.snapshot.uncacheablePadding = "x".repeat(32769); return jsonResponse(value); }
    if (missing && selection.keyword === KEYWORD) return jsonResponse({ schemaVersion: 1, status: "missing", request: selection, snapshot: null });
  } });
  await ui.ready; await ui.controller.open(); const originalCache = saved.storage.getItem(uiModule.RESULT_KEY);
  await ui.controller.open({ ...cacheContext(), keyword: OTHER });
  await untilUi(() => ui.find("keyword-monthly-analysis")[0].dataset.reloadCacheState === "unavailable");
  assert.equal(ui.controller.state().selection.keyword, OTHER); assert.equal(ui.controller.state().status, "available");
  assert.equal(saved.storage.getItem(uiModule.RESULT_KEY), originalCache, "uncacheable A must not erase cached B");
  missing = true; await ui.controller.open(cacheContext());
  assert.equal(ui.controller.state().selection.keyword, KEYWORD); assert.equal(ui.find("kma-dashboard-metrics").length, 0);
  assert.equal(saved.storage.getItem(uiModule.RESULT_KEY), null, "authoritative missing B invalidates B although lastGood memory was A");
  ui.controller.destroy();
  const again = cacheUi(t, { ...saved, handle: ({ kind, selection }) => kind === "data"
    ? jsonResponse({ schemaVersion: 1, status: "missing", request: selection, snapshot: null }) : undefined });
  await again.ready; await again.controller.open(); assert.equal(again.find("kma-dashboard-metrics").length, 0);
});
