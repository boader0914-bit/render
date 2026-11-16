"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const uiModule = require("../web/keyword-monthly-analysis.js");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const script = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-analysis.js"), "utf8");
const benchmarkScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-benchmark.js"), "utf8");
const dashboardScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-dashboard-model.js"), "utf8");
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
  focus() { this.ownerDocument.activeElement = this; }
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
function mockUi({ hidden = false, role = "role-admin", request: customRequest, chartMount, mobile = false, requestTimeoutMs, storage, session, customerView = false } = {}) {
  const listeners = {}, observers = [], calls = [], chartCalls = [], doc = { hidden: false, scrolls: [], addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement("body"); doc.body.className = role;
  const parent = doc.createElement("div"); parent.screenHidden = hidden; doc.body.append(parent);
  async function request(url, settings) { calls.push({ url, settings }); if (customRequest) return customRequest(url, settings); const query = new URL(url, "https://local.test"); return { ok: true, status: 200, json: async () => clone(url.endsWith("/options") ? optionsFixture() : payloadFixture(Object.fromEntries(query.searchParams))) }; }
  const window = { fetch: request, setTimeout, clearTimeout, AbortController, sessionStorage: storage,
    crypto: require("node:crypto").webcrypto, TextEncoder, AdminViewState: viewState, matchMedia: query => ({ matches: mobile && query.includes("767px") }), KeywordMonthlyCharts: { mount(container, config) { chartCalls.push({ container, config }); return chartMount ? chartMount(container, config) : Promise.resolve(); } } };
  class MutationObserver { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  vm.runInNewContext(benchmarkScript, { window });
  vm.runInNewContext(dashboardScript, { window });
  vm.runInNewContext(script, { window, document: doc, MutationObserver, Date, Intl, URLSearchParams, console });
  const api = window.KeywordMonthlyAnalysis, ready = session ? api.configure(session, { customerView }) : Promise.resolve(false), controller = api.mount(parent, { autoStart: false, fetch: request, requestTimeoutMs, now: () => Date.parse(NOW) });
  return { api, controller, ready, parent, doc, observers, listeners, calls, chartCalls,
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
  const ui = mockUi(); await ui.controller.open(); assert.equal(ui.calls.length, 2); assert.equal(ui.calls[0].url, "/api/keyword-monthly/options");
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
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : value }) });
  await ui.controller.open(); const beforeCalls = ui.calls.length;
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
    if (url.endsWith("/options")) return { ok: true, status: 200, json: async () => ({ ...optionsFixture(), currentDay: day, refreshStatus: { status: "available", errorCode: null, started: true, counts: { running: 0, queued: 1, deferred: 0 } } }) };
    const u = new URL(url, "https://local.test"), q = Object.fromEntries(u.searchParams); return { ok: true, status: 200, json: async () => payloadFixture(q) };
  } });
  await ui.controller.open(); await ui.button("데이유즈").fire("click"); day = "2026-10-31";
  await ui.button("저장 자료 조회").fire("click"); await settle();
  assert.equal(ui.calls.filter(x => x.url.endsWith("/options")).length, 2);
  assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-31"); assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().product, "dayuse");
  assert.match(ui.text(), /현재 갱신 작업/); assert.match(ui.text(), /이전 버전 기록/);
});
test("refresh verification warning never replaces valid saved amounts with zero or starts a job", async () => {
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options")
    ? { ...optionsFixture(), refreshStatus: { status: "needs_verification", counts: null } } : payloadFixture() }) });
  await ui.controller.open(); assert.match(ui.text(), /자동 반영 확인 필요/); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /400원/);
});
test("historical failures stay visible while current-version processing is reported separately without claiming freshness", async () => {
  const status = { status: "needs_verification", started: true, initialized: true, closed: false, errorCode: null, counts: { complete: 52, needs_verification: 20, queued: 1 },
    currentVersionCounts: { queued: 1, deferred: 0, running: 0, complete: 0, needs_verification: 0 }, historicalNeedsVerification: 20,
    historicalCountsByVersion: { "keyword-monthly-refresh-v1": { queued: 0, deferred: 0, running: 0, complete: 52, needs_verification: 20 } } };
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options")
    ? { ...optionsFixture(), refreshStatus: status } : payloadFixture() }) });
  await ui.controller.open(); assert.match(ui.text(), /이전 버전 기록 · 이월 0 \/ 검수 필요 20/); assert.match(ui.text(), /현재 갱신 작업 · 처리 0 \/ 대기 1 \/ 이월 0 \/ 검수 필요 0/);
  assert.match(ui.text(), /선택 자료의 실제 반영 범위/); assert.doesNotMatch(ui.text(), /최신 반영 완료/); assert.match(ui.text(), /400원/); assert.equal(ui.calls.length, 2);
  for (const patch of [{ errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { errorCode: undefined }, { errorCode: {} }, { status: "unexpected", errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { status: "available", errorCode: "KEYWORD_REFRESH_UNAVAILABLE" }, { cleanup: { status: "needs_verification" } }, { cleanup: { status: "unknown" } }, { currentVersionCounts: { needs_verification: 1 } }, { currentVersionCounts: null }, { currentVersionCounts: { running: -1 } }, { closed: true }, { started: false }, { initialized: false }]) {
    const blocked = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options")
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
  json: async () => url.endsWith("/options") ? { ...optionsFixture(), refreshStatus: status } : payloadFixture() }) });

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
  let status = "available"; const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : { ...payloadFixture(), status, diagnostics: [status === "stale" ? "CUTOFF_AFTER_DATA_THROUGH" : "MONTH_NOT_OBSERVED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /공개 예약/); status = "stale"; await ui.controller.refresh(); assert.match(ui.text(), /CUTOFF_AFTER_DATA_THROUGH/); assert.doesNotMatch(ui.text(), /공개 예약/); assert.equal(ui.find("kma-metric").length, 0);
  status = "missing"; await ui.controller.refresh(); assert.match(ui.text(), /조회용 저장 집계가 준비되지/); assert.equal(ui.find("kma-metric").length, 0);
});

test("expired preparation stays visibly historical without allowing cutoffs after its evidence", async () => {
  const catalog = optionsFixture(); catalog.status = "stale"; catalog.diagnostics = ["PROJECTION_EXPIRED", "KEYWORD_MONTHLY_BUNDLE_STALE_PARTITIONS_PRESENT"];
  const value = payloadFixture(); value.status = "stale"; value.diagnostics = ["PROJECTION_EXPIRED"];
  const model = uiModule.buildViewModel(value, value.request, "2026-10");
  assert.equal(model.usable, true); assert.equal(model.status, "stale"); assert.equal(model.historicalSnapshot, true);
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? catalog : value }) });
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
  const ui = mockUi({ request: async url => ({ ok: url.endsWith("/options"), status: url.endsWith("/options") ? 200 : 503, json: async () => url.endsWith("/options") ? optionsFixture() : { status: "needs_verification", request: { keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-30" }, snapshot: null, diagnostics: ["KEYWORD_MONTHLY_EVIDENCE_CHANGED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /자료 검수가 필요/); assert.match(ui.text(), /KEYWORD_MONTHLY_EVIDENCE_CHANGED/); assert.equal(ui.find("kma-metric").length, 0);
});
test("authentication failure erases private choices and results and blocks later responses", async () => {
  let code = 200; const ui = mockUi({ request: async url => ({ ok: code === 200, status: code, json: async () => url.endsWith("/options") ? optionsFixture() : payloadFixture() }) });
  await ui.controller.open(); code = 401; await ui.controller.refresh(); assert.equal(ui.field("keyword").value, ""); assert.equal(ui.field("month").value, ""); assert.equal(ui.controller.state().paused, true); assert.equal(ui.find("kma-metric").length, 0); assert.match(ui.text(), /관리자 로그인이 필요/);
});
test("a delayed previous keyword response cannot overwrite the newly selected keyword", async () => {
  const gate = deferred(); let count = 0;
  const ui = mockUi({ request: async url => { if (url.endsWith("/options")) return { ok: true, status: 200, json: async () => optionsFixture() }; const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), current = ++count; return { ok: true, status: 200, json: async () => current === 2 ? gate.promise : payloadFixture(query) }; } });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle(); ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(payloadFixture()); await pending; assert.equal(ui.controller.state().selection.keyword, OTHER); assert.match(ui.text(), /경남 글램핑 업체/); assert.doesNotMatch(ui.text(), /경남글램핑 업체/);
});
test("pause discards in-flight responses and hidden views do not request until explicitly shown", async () => {
  const gate = deferred(); let count = 0;
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : ++count === 2 ? gate.promise : payloadFixture() }) });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle(); ui.api.pause(ui.parent); gate.resolve(payloadFixture()); await pending; assert.equal(ui.find("kma-metric").length, 0);
  const calls = ui.calls.length; await ui.controller.refresh(); assert.equal(ui.calls.length, calls); await ui.api.show(ui.parent); assert.equal(ui.find("kma-metric").length > 0, true);
  const hidden = mockUi({ hidden: true }); await hidden.controller.open(); assert.equal(hidden.calls.length, 0);
});
test("logout clear and role changes erase data and all generated content is text rather than executable markup", async () => {
  const ui = mockUi(); await ui.controller.open(); const malicious = '<img src=x onerror="bad()">';
  ui.api.clear(); assert.equal(ui.field("keyword").value, ""); assert.equal(ui.find("kma-metric").length, 0);
  await ui.controller.open(); ui.doc.body.className = "role-admin admin-user-view"; ui.observers[0].callback(); assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().paused, true);
  const forged = optionsFixture(); forged.keywords[0].keyword = malicious; const other = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? forged : payloadFixture({ keyword: malicious, month: "2026-10", cutoffDate: "2026-10-30" }) }) });
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
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => { if (url.endsWith("/options")) return observed; const query = Object.fromEntries(new URL(url, "https://local.test").searchParams), supported = observed.keywords[0].supportedCutoffs[query.month];
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
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : value }) });
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
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : value }) });
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
    if (url.endsWith("/options")) return optionsFixture(); const selected = Object.fromEntries(new URL(url, "https://local.test").searchParams); return selected.month === "2026-10" ? value : payloadFixture(selected);
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
function dashboardRequest(value) { return async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : value }); }

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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? { ok: true, status: 200, json: async () => optionsFixture() } : delayed ? gate.promise : { ok: true, status: 200, json: async () => value } });
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
  assert.match(text(ui.find("kma-supporting-details")[0]), /업체 동일가중 참고 평균|공급 가중/);
  assert.equal(ui.find("kma-comparison")[0].parentNode.className, "kma-detail-panel");
  assert.match(ui.text(), /출처와 채택·제외 근거|입력 근거 지문/);
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
    if (url.endsWith("/options")) return { ...optionsFixture(), currentDay: today };
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
    if (url.endsWith("/options")) return { ok: true, status: 200, json: async () => optionsFixture() };
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
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? { ...optionsFixture(), currentDay: day }
    : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)) }) });
  await ui.controller.open(); const calls = ui.calls.length; await ui.field("cutoffDate").fire("change");
  assert.equal(ui.calls.length, calls); assert.equal(ui.controller.state().cutoffMode, "auto"); assert.equal(ui.controller.state().viewState.draftCutoffMode, "explicit");
  assert.match(text(ui.find("kma-condition-summary")[0]), /입력 초안이 다릅니다/);
  await ui.apply(); assert.equal(ui.controller.state().cutoffMode, "explicit"); assert.doesNotMatch(text(ui.find("kma-condition-summary")[0]), /입력 초안이 다릅니다/);
  day = "2026-10-31"; await ui.apply(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
});

test("missing remembered company never becomes a fallback company's selected metric or line", async () => {
  let value = dashboardPayload(2); const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : value }) });
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
    if (url.endsWith("/options")) return optionsFixture(); const query = Object.fromEntries(new URL(url, "https://local.test").searchParams);
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : failed ? htmlFailure() : jsonResponse(payloadFixture()) });
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
  const ui = mockUi({ request: async url => failed ? htmlFailure() : jsonResponse(url.endsWith("/options") ? optionsFixture() : payloadFixture()) });
  await ui.controller.open(); assert.equal(ui.calls.length, 1); assert.match(ui.text(), /HTTP 502/);
  assert.equal(ui.field("keyword").value, ""); assert.equal(ui.button("저장 자료 조회").disabled, false);
  failed = false; await ui.apply(); assert.equal(ui.calls.length, 3); assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().errorCode, "");
});

test("HTML 502 and JSON 503 preserve only the same-condition normal snapshot and safe reason codes", async () => {
  let response = null;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : jsonResponse(value, 503) });
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : jsonResponse(value, 503) });
  await ui.controller.open(); const error = ui.find("kma-error")[0].textContent;
  assert.match(error, /자료 검수가 필요/); assert.ok(error.includes(boundary)); assert.equal(error.includes(tooLong), false);
  assert.match(error, /COMPANY_EVIDENCE_UNAVAILABLE/); assert.doesNotMatch(error, /SECRET|lowercase|BAD\/path|ARRAY|\[object Object\]|MEMORY_DEFERRED/);
});

test("safe server errorCode values explain resource holds and leave unknown reasons as verification", async () => {
  for (const [code, label] of [["KEYWORD_MONTHLY_MEMORY_DEFERRED", /메모리 보호/], ["KEYWORD_MONTHLY_MEMORY_UNAVAILABLE", /메모리 상태를 확인하지 못/],
    ["KEYWORD_MONTHLY_QUERY_TIMEOUT", /조회 대기 시간이 초과/], ["KEYWORD_MONTHLY_QUERY_BUSY", /진행 중인 조회/],
    ["KEYWORD_MONTHLY_RESPONSE_BUSY", /진행 중인 조회/], ["KEYWORD_MONTHLY_RESPONSE_TOO_LARGE", /응답 크기가 한도/],
    ["KEYWORD_MONTHLY_EVIDENCE_CHANGED", /자료 검수가 필요/]]) {
    const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : jsonResponse({ errorCode: code }, 503) });
    await ui.controller.open(); const error = ui.find("kma-error")[0].textContent;
    assert.match(error, label, code); assert.ok(error.includes(code)); assert.match(error, /HTTP 503/);
    assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_HTTP_503");
  }
});

test("HTML 503 keeps a generic HTTP failure without parsing or inventing a resource reason", async () => {
  let response = null, bodyReads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
  await ui.controller.open(); response = { ...htmlFailure(503), json: async () => { bodyReads++; throw Error("SECRET_HTML_BODY"); } };
  await ui.controller.refresh(); const error = ui.find("kma-error")[0].textContent;
  assert.equal(bodyReads, 0); assert.match(error, /HTTP 503.*KEYWORD_MONTHLY_HTTP_503/); assert.doesNotMatch(error, /SECRET|메모리|포화|조회 대기/);
  assert.equal(ui.controller.state().showingStored, true); assert.match(ui.text(), /400원/);
});

test("a top-level resource hold retains the same applied scope draft company page product and last valid data", async () => {
  const value = dashboardPayload(43); let failed = false;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : failed ? jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, 503) : jsonResponse(value) });
  await ui.controller.open(); ui.field("companySearch").value = "비교"; await ui.field("companySearch").fire("input");
  await ui.button("다음 업체").fire("click"); await ui.find("kma-company-row")[5].fire("click"); await ui.button("데이유즈").fire("click");
  const before = clone(ui.controller.state()); failed = true; await ui.controller.refresh(); const after = clone(ui.controller.state());
  for (const key of ["selection", "draft", "applied", "benchmarkCompanyId", "listQuery", "listPage", "product", "expanded"]) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.showingStored, true); assert.equal(after.benchmarkCompanyId, "company-25"); assert.equal(after.listPage, 2);
  assert.ok(ui.find("kma-metric").length > 0); assert.match(ui.text(), /메모리 보호/); assert.match(ui.text(), /같은 조회 조건의 마지막 정상 저장 자료/);
});

test("a late 503 reason cannot replace a newer result and auth errors clear before reason parsing", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise
    : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle();
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, 503)); await pending;
  assert.equal(ui.controller.state().selection.keyword, OTHER); assert.equal(ui.controller.state().errorCode, ""); assert.doesNotMatch(ui.text(), /메모리 보호|MEMORY_DEFERRED/);
  for (const status of [401, 403]) {
    let auth = false, parsed = 0;
    const next = mockUi({ request: async url => auth ? { ...jsonResponse({ code: "KEYWORD_MONTHLY_MEMORY_DEFERRED" }, status), json: async () => { parsed++; throw Error("SECRET_AUTH_BODY"); } }
      : jsonResponse(url.endsWith("/options") ? optionsFixture() : payloadFixture()) });
    await next.controller.open(); auth = true; await next.controller.refresh();
    assert.equal(parsed, 0); assert.equal(next.controller.state().paused, true); assert.equal(next.field("keyword").value, "");
    assert.equal(next.controller.state().errorCode, "KEYWORD_MONTHLY_AUTH_REQUIRED"); assert.doesNotMatch(next.text(), /MEMORY_DEFERRED|SECRET_AUTH_BODY/);
  }
});

test("invalid JSON, unexpected content type and network exceptions never expose parser or transport messages", async () => {
  let response = null;
  const ui = mockUi({ request: async url => {
    if (url.endsWith("/options")) return jsonResponse(optionsFixture());
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : failed ? htmlFailure() : jsonResponse(payloadFixture()) });
  await ui.controller.open(); failed = true;
  ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await ui.apply();
  assert.equal(ui.controller.state().selection.month, "2026-11"); assert.equal(ui.controller.state().showingStored, false);
  assert.equal(ui.find("kma-metric").length, 0); assert.doesNotMatch(ui.text(), /400원/);
  ui.field("month").value = "2026-10"; await ui.field("month").fire("change"); await ui.apply();
  assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().showingStored, true); assert.match(ui.text(), /400원/);
});

test("same-scope refresh and repeated submit share the running GET without aborting and restarting it", async () => {
  const gate = deferred(); let pending = false;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : pending ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); pending = true;
  const first = ui.controller.refresh(); await settle(); const before = ui.calls.length, signal = ui.calls.at(-1).settings.signal;
  const second = ui.controller.refresh(); await ui.button("저장 자료 조회").fire("click"); await settle();
  assert.equal(ui.calls.length, before); assert.equal(signal.aborted, false); assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().showingStored, true);
  gate.resolve(jsonResponse(payloadFixture())); await Promise.all([first, second]); await settle();
  assert.equal(ui.calls.length, before); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, false);
});

test("menu reentry immediately restores its exact saved result while the fresh options request is pending or fails", async () => {
  const gate = deferred(); let delayed = false;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? delayed ? gate.promise : jsonResponse(optionsFixture()) : jsonResponse(payloadFixture()) });
  await ui.controller.open(); const selection = clone(ui.controller.state().selection); ui.controller.pause(); assert.equal(ui.find("kma-metric").length, 0);
  delayed = true; const reopening = ui.controller.open(selection); await settle();
  assert.match(ui.text(), /400원/); assert.equal(ui.controller.state().loading, true); assert.equal(ui.controller.state().showingStored, true);
  gate.resolve(htmlFailure()); await reopening;
  assert.equal(ui.controller.state().loading, false); assert.match(ui.text(), /HTTP 502/); assert.match(ui.text(), /400원/);
  assert.equal(ui.field("month").value, "2026-10");
});

test("timeout finishes the UI even if fetch ignores abort and its late response cannot replace a later manual retry", async () => {
  const gate = deferred(); let delayed = false;
  const ui = mockUi({ requestTimeoutMs: 20, request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : delayed ? gate.promise : jsonResponse(payloadFixture()) });
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
    const ui = mockUi({ request: async url => response || jsonResponse(url.endsWith("/options") ? optionsFixture() : payloadFixture()) });
    await ui.controller.open(); response = auth; await ui.controller.refresh();
    assert.equal(ui.controller.state().paused, true); assert.equal(ui.controller.state().errorCode, "KEYWORD_MONTHLY_AUTH_REQUIRED");
    assert.equal(ui.field("keyword").value, ""); assert.equal(ui.field("month").value, ""); assert.equal(ui.find("kma-metric").length, 0); assert.doesNotMatch(ui.text(), /400원/);
    response = htmlFailure(); await ui.controller.open(); assert.equal(ui.controller.state().showingStored, false); assert.equal(ui.find("kma-metric").length, 0);
  }
});

test("an obsolete authentication response cannot clear a newer successful keyword selection", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle();
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await ui.apply();
  gate.resolve(htmlFailure(401)); await old;
  assert.equal(ui.controller.state().paused, false); assert.equal(ui.controller.state().selection.keyword, OTHER); assert.match(ui.text(), /경남 글램핑 업체/);
});

test("an authoritative missing response invalidates that scope's retained result rather than resurrecting it after a transport failure", async () => {
  let response = null;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : response || jsonResponse(payloadFixture()) });
  await ui.controller.open(); response = jsonResponse({ ...payloadFixture(), status: "missing", snapshot: null, diagnostics: ["MONTH_NOT_OBSERVED"] });
  await ui.controller.refresh(); assert.equal(ui.find("kma-metric").length, 0);
  response = htmlFailure(); await ui.controller.refresh(); assert.equal(ui.find("kma-metric").length, 0); assert.equal(ui.controller.state().showingStored, false);
});

test("an explicit cutoff without a mode does not join an in-flight automatic-cutoff read", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle(); const before = ui.calls.length, oldSignal = ui.calls.at(-1).settings.signal;
  await ui.controller.open({ keyword: KEYWORD, month: "2026-10", cutoffDate: "2026-10-29" });
  assert.ok(ui.calls.length > before); assert.equal(oldSignal.aborted, true);
  assert.equal(ui.controller.state().cutoffMode, "explicit"); assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-29");
  gate.resolve(jsonResponse(payloadFixture())); await old;
  assert.equal(ui.controller.state().applied.cutoffDate, "2026-10-29"); assert.match(text(ui.find("kma-condition-summary")[0]), /2026-10-29.*사용자 선택/);
});

test("joining the same data read applies product company list and disclosure context without another request", async () => {
  const gate = deferred(); let waiting = false;
  const value = dashboardPayload(43), ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : waiting ? gate.promise : jsonResponse(value) });
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? waiting ? gate.promise : jsonResponse(optionsFixture()) : jsonResponse(dashboardPayload(3)) });
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
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : ++reads === 2 ? gate.promise : jsonResponse(payloadFixture()) });
  await ui.controller.open(); const old = ui.controller.refresh(); await settle(); const before = ui.calls.length;
  ui.doc.hidden = true; ui.listeners.visibilitychange(); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, true);
  ui.doc.hidden = false; ui.listeners.visibilitychange(); await settle();
  assert.equal(ui.calls.length, before + 1); assert.equal(ui.controller.state().loading, false); assert.equal(ui.controller.state().showingStored, false);
  ui.listeners.visibilitychange(); ui.observers[0].callback(); await settle(); assert.equal(ui.calls.length, before + 1);
  gate.resolve(htmlFailure()); await old; assert.equal(ui.controller.state().errorCode, ""); assert.match(ui.text(), /400원/);
});

test("a resumed visibility read that fails does not become an automatic retry loop", async () => {
  const gate = deferred(); let reads = 0;
  const ui = mockUi({ request: async url => url.endsWith("/options") ? jsonResponse(optionsFixture()) : ++reads === 1 ? jsonResponse(payloadFixture()) : reads === 2 ? gate.promise : htmlFailure() });
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
    if (url.endsWith("/options")) return ++optionsReads === 2 ? gate.promise : jsonResponse({ ...optionsFixture(), currentDay: day });
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
  assert.equal(again.calls.length, 2); assert.ok(again.calls[0].url.endsWith("/options"));
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
      return jsonResponse(url.endsWith("/options") ? catalog : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams)));
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
    if (url.endsWith("/options")) {
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
    const ui = mockUi({ storage, session, request: async url => code === 200 ? jsonResponse(url.endsWith("/options") ? optionsFixture() : payloadFixture(Object.fromEntries(new URL(url, "https://local.test").searchParams))) : htmlFailure(code) });
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
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/options") ? optionsFixture() : payload) }); await ui.controller.open();
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
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/options") ? optionsFixture() : payload) }); await ui.controller.open();
  const block = ui.find("kma-identity-review")[0]; assert.equal(block.attributes["data-identity-review-status"], "legacy");
  assert.match(text(block), /세부 분류 전.*3,710건/); assert.equal(ui.find("kma-identity-count").length, 0); assert.match(text(block), /0건으로 표시하지 않습니다/);
});
test("actual3710 already represented classification is not shown as reservations or final monthly adoption", async () => {
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = identityReviewFixture({ totalRows: 3710, alreadyRepresentedRows: 3710, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} });
  payload.snapshot.summary.lodging.revenuePartial = true; payload.snapshot.quality.warnings = ["가격 미확인 근거는 유지합니다."];
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/options") ? optionsFixture() : payload) }); await ui.controller.open();
  const block = ui.find("kma-identity-review")[0]; assert.match(text(block), /기존 관측자료에 반영.*3,710건/); assert.match(text(block), /월 최종값은 최신 유효 관측 기준으로 선택합니다/);
  assert.match(text(block), /업체번호 연결 보완.*0건.*연결 확인 필요.*0건/); assert.doesNotMatch(text(block), /3,710실|3,710원|월 최종합계에 모두/);
  assert.match(ui.text(), /가격 확인 부분 소계/); assert.match(ui.text(), /가격 미확인 근거는 유지합니다/);
});
test("a genuine zero identity review is visible and malformed review values stay unknown", async () => {
  const zero = identityReviewFixture({ totalRows: 0, alreadyRepresentedRows: 0, recoveredRows: 0, unresolvedRows: 0, reasonCounts: {} });
  assert.equal(uiModule.identityReviewView(zero).status, "ready");
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = zero;
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/options") ? optionsFixture() : payload) }); await ui.controller.open();
  assert.equal(ui.find("kma-identity-count").length, 3); assert.ok(ui.find("kma-identity-count").every(item => /0건/.test(text(item))));
  for (const invalid of [null, { ...zero, totalRows: 1 }, { ...zero, privateToken: "unsafe" }, { ...zero, reasonCounts: { SOURCE_ID_UNKNOWN: 0 } }, { ...zero, totalRows: 100000001 }]) assert.equal(uiModule.identityReviewView(invalid).status, "invalid");
  payload.snapshot.quality.identityReview = { ...zero, totalRows: 99 }; await ui.controller.refresh();
  const block = ui.find("kma-identity-review")[0]; assert.equal(block.attributes["data-identity-review-status"], "invalid"); assert.equal(ui.find("kma-identity-count").length, 0); assert.match(text(block), /미확인을 0건으로 바꾸지 않습니다/);
});
test("unknown safe reason codes remain bounded readable text without markup execution", async () => {
  const review = identityReviewFixture({ reasonCounts: { FUTURE_LINK_REASON: 5 } });
  const payload = payloadFixture(); payload.snapshot.quality.identityReview = review;
  const ui = mockUi({ request: async url => jsonResponse(url.endsWith("/options") ? optionsFixture() : payload) }); await ui.controller.open();
  assert.match(text(ui.find("kma-identity-review")[0]), /기타 연결 근거 확인 · FUTURE_LINK_REASON.*5건/);
  assert.equal(uiModule.identityReviewView({ ...review, reasonCounts: { '<img src=x onerror="unsafe">': 5 } }).status, "invalid");
});
test("identity review disclosure survives F5 with the same applied company/month/product and no extra requests", async () => {
  const storage = memorySelectionStorage(), session = liveSession();
  const request = async url => { if (url.endsWith("/options")) return jsonResponse(optionsFixture()); const q = new URL(url, "https://local.test"), payload = payloadFixture(Object.fromEntries(q.searchParams)); payload.snapshot.quality.identityReview = identityReviewFixture(); return jsonResponse(payload); };
  const first = mockUi({ storage, session, request }); await first.ready; await first.controller.open();
  first.field("benchmarkCompany").value = "a"; await first.field("benchmarkCompany").fire("change");
  const block = first.find("kma-identity-review")[0]; block.parentNode.open = true; await block.parentNode.fire("toggle");
  const before = clone(first.controller.state().selection); assert.equal(first.calls.length, 2); first.controller.destroy();
  const again = mockUi({ storage, session, request }); await again.ready; await again.controller.open();
  assert.deepEqual(clone(again.controller.state().selection), before); assert.equal(again.find("kma-identity-review")[0].parentNode.open, true); assert.equal(again.calls.length, 2);
});
