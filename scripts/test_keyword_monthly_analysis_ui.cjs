"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const uiModule = require("../web/keyword-monthly-analysis.js");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const script = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-analysis.js"), "utf8");
const benchmarkScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-benchmark.js"), "utf8");
const dashboardScript = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-dashboard-model.js"), "utf8");
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

class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ""; this._text = ""; this.value = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this.classList = { contains: key => this.className.split(/\s+/).includes(key) }; }
  set textContent(value) { this._text = String(value ?? ""); this.children = []; } get textContent() { return this._text; }
  append(...values) { for (const node of values) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...values) { this._text = ""; this.children = []; this.append(...values); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, callback) { (this.listeners[key] ||= []).push(callback); }
  get isConnected() { let root = this; while (root.parentNode) root = root.parentNode; return root === this.ownerDocument.body; }
  getClientRects() { let node = this; while (node) { if (node.hidden || node.screenHidden) return []; node = node.parentNode; } return [{}]; }
  async fire(type) { if (type === "click" && this.disabled) return; for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {} }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join(" ");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function mockUi({ hidden = false, role = "role-admin", request: customRequest, chartMount } = {}) {
  const listeners = {}, observers = [], calls = [], chartCalls = [], doc = { hidden: false, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement("body"); doc.body.className = role;
  const parent = doc.createElement("div"); parent.screenHidden = hidden; doc.body.append(parent);
  async function request(url, settings) { calls.push({ url, settings }); if (customRequest) return customRequest(url, settings); const query = new URL(url, "https://local.test"); return { ok: true, status: 200, json: async () => clone(url.endsWith("/options") ? optionsFixture() : payloadFixture(Object.fromEntries(query.searchParams))) }; }
  const window = { fetch: request, KeywordMonthlyCharts: { mount(container, config) { chartCalls.push({ container, config }); return chartMount ? chartMount(container, config) : Promise.resolve(); } } };
  class MutationObserver { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  vm.runInNewContext(benchmarkScript, { window });
  vm.runInNewContext(dashboardScript, { window });
  vm.runInNewContext(script, { window, document: doc, MutationObserver, Date, Intl, URLSearchParams, console });
  const api = window.KeywordMonthlyAnalysis, controller = api.mount(parent, { autoStart: false, fetch: request, now: () => Date.parse(NOW) });
  return { api, controller, parent, doc, observers, listeners, calls, chartCalls,
    find(cls) { return descendants(parent).filter(node => node.className.split(/\s+/).includes(cls)); }, field(name) { return descendants(parent).find(node => node.name === name); },
    button(label) { return descendants(parent).find(node => node.tagName === "BUTTON" && node.textContent === label); }, text() { return text(parent); } };
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
  assert.equal(ui.find("kma-results")[0].children.length >= 6, true);
});
test("only catalog months can be requested and real future stay observations are labeled separately", async () => {
  const ui = mockUi(); await ui.controller.open(); ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await settle(); assert.match(ui.text(), /사전 관측/);
  assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-30");
  const count = ui.calls.length; ui.field("month").value = "2027-01"; await ui.field("month").fire("change"); await settle(); assert.equal(ui.calls.length, count); assert.match(ui.text(), /실제 관측 숙박월을 선택/);
});
test("exact keyword and product changes keep snapshots separate and product changes never request again", async () => {
  const ui = mockUi(); await ui.controller.open(); await ui.button("데이유즈").fire("click"); assert.equal(ui.calls.length, 2); assert.equal(ui.controller.state().product, "dayuse"); assert.match(ui.text(), /예약 추정 \(회\)/);
  ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await settle();
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
    if (url.endsWith("/options")) return { ok: true, status: 200, json: async () => ({ ...optionsFixture(), currentDay: day, refreshStatus: { status: "available", started: true, counts: { running: 0, queued: 1, deferred: 0 } } }) };
    const u = new URL(url, "https://local.test"), q = Object.fromEntries(u.searchParams); return { ok: true, status: 200, json: async () => payloadFixture(q) };
  } });
  await ui.controller.open(); await ui.button("데이유즈").fire("click"); day = "2026-10-31";
  await ui.button("저장 자료 조회").fire("click"); await settle();
  assert.equal(ui.calls.filter(x => x.url.endsWith("/options")).length, 2);
  assert.equal(ui.controller.state().selection.cutoffDate, "2026-10-31"); assert.equal(ui.controller.state().selection.month, "2026-10"); assert.equal(ui.controller.state().product, "dayuse");
  assert.match(ui.text(), /수집·DB 반영 완료 후 자동 갱신/);
});
test("refresh verification warning never replaces valid saved amounts with zero or starts a job", async () => {
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options")
    ? { ...optionsFixture(), refreshStatus: { status: "needs_verification", counts: null } } : payloadFixture() }) });
  await ui.controller.open(); assert.match(ui.text(), /자동 반영 확인 필요/); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /400원/);
});
test("invalid or future cutoff produces an explanation without another request", async () => {
  const ui = mockUi(); await ui.controller.open(); for (const value of ["2026-02-30", "2026-10-31"]) { ui.field("cutoffDate").value = value; await ui.field("cutoffDate").fire("change"); await settle(); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /관측 마감일은 오늘 이하/); }
});
test("missing and stale responses retain reasons and metadata, not earlier successful amounts", async () => {
  let status = "available"; const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : { ...payloadFixture(), status, diagnostics: [status === "stale" ? "CUTOFF_AFTER_DATA_THROUGH" : "MONTH_NOT_OBSERVED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /공개 예약/); status = "stale"; await ui.controller.refresh(); assert.match(ui.text(), /CUTOFF_AFTER_DATA_THROUGH/); assert.doesNotMatch(ui.text(), /공개 예약/); assert.equal(ui.find("kma-metric").length, 0);
  status = "missing"; await ui.controller.refresh(); assert.match(ui.text(), /조회용 저장 집계가 준비되지/); assert.equal(ui.find("kma-metric").length, 0);
});

test("expired preparation stays visibly historical without allowing cutoffs after its evidence", async () => {
  const catalog = optionsFixture(); catalog.status = "stale"; catalog.diagnostics = ["PROJECTION_EXPIRED"];
  const value = payloadFixture(); value.status = "stale"; value.diagnostics = ["PROJECTION_EXPIRED"];
  const model = uiModule.buildViewModel(value, value.request, "2026-10");
  assert.equal(model.usable, true); assert.equal(model.status, "stale"); assert.equal(model.historicalSnapshot, true);
  const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? catalog : value }) });
  await ui.controller.open(); assert.ok(ui.find("kma-metric").length > 0); assert.match(ui.text(), /과거 저장근거 · 갱신 확인 필요/);
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
  await ui.controller.open(); const pending = ui.controller.refresh(); await settle(); ui.field("keyword").value = OTHER; await ui.field("keyword").fire("change"); await settle();
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
  ui.field("month").value = "2026-09"; await ui.field("month").fire("change"); await settle(); assert.equal(ui.controller.state().selection.cutoffDate, "2026-09-22");
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
  ui.field("month").value = "2026-11"; await ui.field("month").fire("change"); await settle(); assert.match(ui.text(), /사전 관측/); assert.equal(ui.find("kma-calendar-cell")[0].attributes["data-date"], "2026-11-01");
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
  assert.equal(ui.find("kma-dashboard-title")[0].textContent, `${KEYWORD} · 비교 업체 0 비교`);
  assert.equal(ui.find("kma-dashboard-metrics")[0].children.length, 4);
  assert.equal(ui.find("kma-dashboard-grid").length, 1); assert.equal(ui.find("kma-company-chart-panel").length, 1); assert.equal(ui.find("kma-flow-chart-panel").length, 1);
  const beforeRequests = ui.calls.length, beforeLine = ui.chartCalls.find(x => x.config.spec.type === "line").config;
  assert.equal(ui.chartCalls.find(x => x.config.spec.type === "horizontalStackedBar").config.rows[0].company, "● 비교 업체 0");
  assert.equal(beforeLine.rows.length, 31); assert.equal(beforeLine.rows.find(row => row.date === "2026-10-20")["비교 업체 0"], 0.8);
  ui.field("benchmarkCompany").value = "company-1"; await ui.field("benchmarkCompany").fire("change"); await settle();
  const afterLine = ui.chartCalls.filter(x => x.config.spec.type === "line").at(-1).config;
  assert.equal(ui.find("kma-dashboard-title")[0].textContent, `${KEYWORD} · 비교 업체 1 비교`); assert.equal(ui.calls.length, beforeRequests);
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
  assert.equal(ui.find("kma-supporting-details").length, 5);
  assert.equal(ui.find("kma-supporting-details").every(node => node.tagName === "DETAILS" && !node.open), true);
  assert.match(text(ui.find("kma-supporting-details")[0]), /업체 동일가중 참고 평균|공급 가중/);
  assert.equal(ui.find("kma-comparison")[0].parentNode.className, "kma-results");
  assert.match(ui.text(), /출처와 채택·제외 근거|입력 근거 지문/);
});
