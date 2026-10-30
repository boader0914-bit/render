"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const uiModule = require("../web/keyword-monthly-analysis.js");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");
const { buildMonthlyComparison, previousMonthlyReportRequest } = require("./lib/monthly_report_comparison.cjs");
const script = fs.readFileSync(path.join(__dirname, "../web/keyword-monthly-analysis.js"), "utf8");
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
  getClientRects() { let node = this; while (node) { if (node.hidden || node.screenHidden) return []; node = node.parentNode; } return [{}]; }
  async fire(type) { if (type === "click" && this.disabled) return; for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {} }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(item => item.textContent).join(" ");
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
function mockUi({ hidden = false, role = "role-admin", request: customRequest } = {}) {
  const listeners = {}, observers = [], calls = [], doc = { hidden: false, addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  doc.createElement = tag => new Element(tag, doc); doc.body = doc.createElement("body"); doc.body.className = role;
  const parent = doc.createElement("div"); parent.screenHidden = hidden; doc.body.append(parent);
  async function request(url, settings) { calls.push({ url, settings }); if (customRequest) return customRequest(url, settings); const query = new URL(url, "https://local.test"); return { ok: true, status: 200, json: async () => clone(url.endsWith("/options") ? optionsFixture() : payloadFixture(Object.fromEntries(query.searchParams))) }; }
  const window = { fetch: request };
  class MutationObserver { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  vm.runInNewContext(script, { window, document: doc, MutationObserver, Date, Intl, URLSearchParams, console });
  const api = window.KeywordMonthlyAnalysis, controller = api.mount(parent, { autoStart: false, fetch: request, now: () => Date.parse(NOW) });
  return { api, controller, parent, doc, observers, listeners, calls,
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
test("invalid or future cutoff produces an explanation without another request", async () => {
  const ui = mockUi(); await ui.controller.open(); for (const value of ["2026-02-30", "2026-10-31"]) { ui.field("cutoffDate").value = value; await ui.field("cutoffDate").fire("change"); await settle(); assert.equal(ui.calls.length, 2); assert.match(ui.text(), /관측 마감일은 오늘 이하/); }
});
test("missing and stale responses retain reasons and metadata, not earlier successful amounts", async () => {
  let status = "available"; const ui = mockUi({ request: async url => ({ ok: true, status: 200, json: async () => url.endsWith("/options") ? optionsFixture() : { ...payloadFixture(), status, diagnostics: [status === "stale" ? "CUTOFF_AFTER_DATA_THROUGH" : "MONTH_NOT_OBSERVED"] } }) });
  await ui.controller.open(); assert.match(ui.text(), /공개 예약/); status = "stale"; await ui.controller.refresh(); assert.match(ui.text(), /CUTOFF_AFTER_DATA_THROUGH/); assert.doesNotMatch(ui.text(), /공개 예약/); assert.equal(ui.find("kma-metric").length, 0);
  status = "missing"; await ui.controller.refresh(); assert.match(ui.text(), /조회용 저장 집계가 준비되지/); assert.equal(ui.find("kma-metric").length, 0);
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
