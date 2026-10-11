"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, renderDashboard, dailyChart, percent, money, count } = require("../web/industry-analysis.js");

const catalog = { industries: [{ id: "glamping", label: "글램핑", unitLabel: "객실/동" }, { id: "poolVilla", label: "풀빌라", unitLabel: "독채/객실" }], months: ["2026-10", "2026-09"], defaultMonth: "2026-10", defaultIndustry: "glamping", regions: [{ id: "sacheon", label: "경남 사천시", indicatorCandidate: true }] };
const summary = { companyCount: 2, observedCompanies: 1, coveredCompanyDays: 1, expectedCompanyDays: 62, coverageRate: 1 / 62, reservationRate: 0, averageBookedPrice: null, revenuePerAvailableUnitDay: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0, publicBookings: 0, phoneBookings: 0 };
const data = { request: { region: "all" }, industry: catalog.industries[0], period: { start: "2026-10-01", end: "2026-10-31", days: 31 }, summary, daily: [{ date: "2026-10-01", publicBookings: 0, phoneBookings: 0 }, { date: "2026-10-02", publicBookings: null, phoneBookings: null }], regions: [{ id: "sacheon", label: "경남 사천시", companyCount: 0, observedCompanies: 0, coveredCompanyDays: 0, expectedCompanyDays: 0, coverageRate: null, reservationRate: null }], industryComparison: { status: "insufficient", rows: [] }, quality: { warnings: ["자료 범위가 다릅니다."] }, context: { sources: [] }, companies: [] };
function state(extra = {}) { return { catalog, data: structuredClone(data), selection: { industry: "glamping", month: "2026-10", region: "all" }, tab: "overview", loading: false, error: "", ...extra }; }
function host() { const listeners = new Map(); return { innerHTML: "", addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); }, querySelector() { return { focus() {} }; }, listeners }; }

test("zero observations and missing values stay distinct in metrics and charts", () => {
  assert.equal(percent(0), "0%"); assert.equal(percent(null), "—"); assert.equal(money(0), "0원"); assert.equal(money(undefined), "—"); assert.equal(count(null), "—");
  const html = renderDashboard(state());
  assert.match(html, /추정예약률<\/span><strong>0%/);
  assert.match(html, /예약 단위당 추정금액<\/span><strong>—/);
  assert.match(html, /1 \/ 62 업체·숙박일/);
  const chart = dailyChart(data.daily);
  assert.equal((chart.match(/class="ia-zero"/g) || []).length, 1);
  assert.equal((chart.match(/class="ia-missing-mark"/g) || []).length, 1);
  assert.match(chart, /2026-10-02: 공개예약 자료 없음/);
});

test("full period coverage is distinct from same-day observation coverage", () => {
  const observed = structuredClone(data);
  observed.summary = { ...summary, coverageRate: 1, coveredCompanyDays: 62, expectedCompanyDays: 62, sameDayObservedCompanyDays: 3 };
  const html = renderDashboard(state({ data: observed }));
  assert.match(html, /숙박일 당일 확인 3 \/ 62 업체·숙박일/);
  assert.match(html, /이전에 확인한 관측값도 포함/);
  assert.match(html, /aria-label="자료 확보율"[^>]*aria-valuenow="100"/);
});

test("top twenty, regional candidates and deferred dimensions have no inactive controls", () => {
  const html = renderDashboard(state());
  assert.match(html, /네이버 플레이스 <strong>1~20위/);
  assert.match(html, /경남 사천시/);
  assert.match(html, /규모구간은 추후 업종별로 정의/);
  assert.doesNotMatch(html, /data-ia-filter="(?:scale|tier|performance)"|<option[^>]*>상위|disabled/);
  assert.equal((html.match(/data-ia-filter=/g) || []).length, 3);
});

test("unmatched industry cohorts do not render a misleading comparison table", () => {
  const html = renderDashboard(state({ tab: "industries" }));
  assert.match(html, /비교 자료 부족/);
  assert.doesNotMatch(html, /<table/);
  const regional = renderDashboard(state({ tab: "regions" }));
  assert.match(regional, /자료 없음/);
  assert.match(regional, /data-ia-region="sacheon"/);
  assert.match(regional, /<strong>—<\/strong>/);
});

test("regional indicators work without lodging observations and reject unsafe source URLs", () => {
  const missing = structuredClone(data);
  missing.request.region = "sacheon";
  missing.summary = { companyCount: 0, observedCompanies: 0, coveredCompanyDays: 0 };
  missing.context.sources = [{ label: "방문 지표", period: "202609", provider: "한국관광공사", sourceUrl: "javascript:alert(1)", rows: [{ label: "방문자", value: 0, unit: "명" }, { label: "체류", value: null, unit: "지수" }] }];
  const html = renderDashboard(state({ data: missing }));
  assert.match(html, /아직 분석할 관측 자료가 없습니다/);
  assert.match(html, /방문 지표/);
  assert.match(html, /기준 202609/);
  assert.match(html, /<strong>0<small>명/);
  assert.match(html, /체류<\/span><strong>—/);
  assert.doesNotMatch(html, /javascript:/);
});

test("rank-only companies remain visible and capacity provenance is understandable", () => {
  const rankOnly = structuredClone(data);
  rankOnly.summary = { companyCount: 2, observedCompanies: 0, coveredCompanyDays: 0, expectedCompanyDays: 62, coverageRate: 0 };
  rankOnly.companies = [{ companyId: "one", primaryName: "순위 확인 업체", capacity: 12, capacitySource: "observed_max_locked", rankEvidence: [{ keyword: "사천글램핑", rank: 3 }] }, { companyId: "two", primaryName: "검수 업체", capacity: 10, capacitySource: "db_review", rankEvidence: [], capacityBasis: { source: "db_review", label: "관리자 검수값", warnings: ["관측 수량 12실이 고정 기준 10실보다 큽니다."] } }];
  const html = renderDashboard(state({ data: rankOnly, tab: "companies" }));
  assert.match(html, /순위 확인 업체/);
  assert.match(html, /사천글램핑 <b>3위/);
  assert.match(html, /최대 관측값 고정 · 미검수/);
  assert.match(html, /관리자 검수값/);
  assert.match(html, /class="ia-capacity-warning">관측 수량 12실/);
  assert.doesNotMatch(html, /아직 분석할 관측 자료가 없습니다|observed_max_locked|db_review/);
});

test("common industry comparison remains visible when the selected industry has no observations", () => {
  const emptySelection = structuredClone(data);
  emptySelection.summary = { companyCount: 0, observedCompanies: 0, coveredCompanyDays: 0 };
  emptySelection.industryComparison = { status: "ready", commonRegionIds: ["sacheon"], commonDates: ["2026-10-01"], basis: "같은 지역과 숙박일 기준입니다.", rows: [{ id: "poolVilla", label: "풀빌라", unitLabel: "독채/객실", ...summary, comparisonStatus: "comparable" }] };
  const html = renderDashboard(state({ data: emptySelection, tab: "industries" }));
  assert.match(html, /업종별 운영 흐름/);
  assert.match(html, /공통 지역과 숙박일 기준 업종별 관측 결과/);
  assert.match(html, /풀빌라<small>판매 단위: 독채\/객실<\/small><\/th>/);
  assert.match(html, /판매 단위가 달라 수익성 순위로 해석하지 않습니다/);
  assert.match(html, /같은 지역과 숙박일 기준입니다/);
  assert.doesNotMatch(html, /아직 분석할 관측 자료가 없습니다/);
});

test("source labels, company names and evidence are escaped", () => {
  const payload = structuredClone(data);
  payload.companies = [{ ...summary, companyId: "1", primaryName: '<img src=x onerror="x">', regionLabel: "<지역>", capacity: 3, rankEvidence: [{ keyword: "<script>x</script>", rank: 1, runId: 'a" onclick="x', collectedAt: "2026-10-10T23:00:00Z" }] }];
  const html = renderDashboard(state({ data: payload, tab: "companies" }));
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-industry-open-run="a&quot; onclick=&quot;x"/);
  assert.match(html, /2026\.10\.11 수집/);
});

test("a later filter response wins even if an earlier request finishes last", async () => {
  const pending = [];
  const element = host();
  const controller = createController({ request: async url => url.endsWith("/options") ? catalog : url.includes("region=all") ? data : new Promise(resolve => pending.push({ url, resolve })) });
  await controller.mount(element);
  const first = controller.input("region", "sacheon");
  const second = controller.input("month", "2026-09");
  assert.equal(pending.length, 2);
  pending[1].resolve({ ...data, marker: "latest" }); await second;
  pending[0].resolve({ ...data, marker: "stale" }); await first;
  assert.equal(controller.state.data.marker, "latest");
  assert.equal(controller.state.selection.month, "2026-09");
  assert.equal(controller.state.loading, false);
  assert.match(pending[1].url, /month=2026-09/);
});

test("loading refresh and identical analysis requests do not create duplicate work", async () => {
  let optionsCount = 0, analysisCount = 0, resolveOptions, resolveAnalysis;
  const controller = createController({ request: url => {
    if (url.endsWith("/options")) { optionsCount++; return new Promise(resolve => { resolveOptions = resolve; }); }
    analysisCount++; return new Promise(resolve => { resolveAnalysis = resolve; });
  } });
  const element = host(), mounting = controller.mount(element);
  await Promise.all([controller.loadCatalog(), controller.loadCatalog()]);
  assert.equal(optionsCount, 1);
  assert.match(element.innerHTML, /aria-label="저장 자료 다시 조회" disabled/);
  assert.match(element.innerHTML, /첫 조회는 저장 자료를 정리하므로 몇 분 걸릴 수 있습니다/);
  resolveOptions(catalog);
  await new Promise(done => setImmediate(done));
  const duplicateOne = controller.loadData(), duplicateTwo = controller.loadData();
  assert.equal(duplicateOne, duplicateTwo, "The same in-flight condition returns the existing task");
  await Promise.all([controller.loadCatalog(), controller.loadCatalog()]);
  assert.equal(optionsCount, 1);
  assert.equal(analysisCount, 1);
  resolveAnalysis(data); await Promise.all([mounting, duplicateOne, duplicateTwo]);
  assert.equal(controller.state.loading, false);
  assert.doesNotMatch(element.innerHTML, /aria-label="저장 자료 다시 조회" disabled/);
});

test("switching back to an in-flight condition reuses its request and ignores stale responses", async () => {
  const pending = [];
  const controller = createController({ request: async url => url.endsWith("/options") ? catalog : new Promise(resolve => pending.push({ url, resolve })) });
  const mounting = controller.mount(host());
  await new Promise(done => setImmediate(done));
  const previousMonth = controller.input("month", "2026-09");
  const currentMonth = controller.input("month", "2026-10");
  assert.equal(pending.length, 2, "A to B to A requires only the two distinct pending requests");
  pending[1].resolve({ ...data, marker: "september" }); await previousMonth;
  assert.equal(controller.state.data, null);
  assert.equal(controller.state.loading, true);
  pending[0].resolve({ ...data, marker: "october" }); await Promise.all([mounting, currentMonth]);
  assert.equal(controller.state.data.marker, "october");
  assert.equal(controller.state.selection.month, "2026-10");
  assert.equal(controller.state.loading, false);
});

test("network failures, non-JSON 503 and provider errors remain clear errors instead of zero data", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    { label: "network", response: async () => { throw new TypeError("Failed to fetch"); }, message: /서버에 연결하지 못했습니다/ },
    { label: "html503", response: async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError("Unexpected token < in JSON"); } }), message: /서버가 일시적으로 응답하지 않습니다/ },
    { label: "json503", response: async () => ({ ok: false, status: 503, json: async () => ({ error: "저장 자료 준비 중입니다." }) }), message: /저장 자료 준비 중입니다/ },
    { label: "providerError200", response: async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "관측 자료를 확인할 수 없습니다." } }) }), message: /관측 자료를 확인할 수 없습니다/ }
  ];
  try {
    for (const item of cases) {
      globalThis.fetch = async url => url.endsWith("/options") ? { ok: true, status: 200, json: async () => catalog } : item.response();
      const element = host(), controller = createController();
      await controller.mount(element);
      assert.match(controller.state.error, item.message, item.label);
      assert.match(element.innerHTML, /role="alert"/, item.label);
      assert.doesNotMatch(element.innerHTML, /아직 분석할 관측 자료가 없습니다|Failed to fetch|Unexpected token|추정예약률<\/span><strong>0%/, item.label);
      assert.equal(controller.state.loading, false, item.label);
      assert.equal(controller.state.data, null, item.label);
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => data });
      await controller.loadData();
      assert.equal(controller.state.error, "", "A completed failed request is removed so an explicit retry can succeed");
      assert.deepEqual(controller.state.data, data);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("failure, empty and loading are explicit; refreshing preserves choices", async () => {
  const element = host(); let fail = false;
  const controller = createController({ request: async url => { if (fail) throw new Error("API 연결 실패"); return url.endsWith("/options") ? catalog : data; } });
  await controller.mount(element);
  await controller.input("month", "2026-09");
  await controller.loadCatalog();
  assert.equal(controller.state.selection.month, "2026-09");
  fail = true; await controller.loadCatalog();
  assert.match(element.innerHTML, /role="alert"/); assert.match(element.innerHTML, /API 연결 실패/);
  assert.doesNotMatch(element.innerHTML, /추정예약률<\/span><strong>0%/);
  assert.match(renderDashboard(state({ loading: true })), /role="status"/);
  assert.match(renderDashboard(state({ data: null })), /아직 분석할 관측 자료가 없습니다/);
});

test("no month does not fetch observations, and revoked authorization suppresses late responses", async () => {
  const calls = [], element = host();
  const empty = createController({ request: async url => { calls.push(url); return { ...catalog, months: [], defaultMonth: "" }; } });
  await empty.mount(element);
  assert.deepEqual(calls, ["/api/industry-analysis/options"]);
  let authorized = true, resolve;
  const guardedHost = host();
  const controller = createController({ isAuthorized: () => authorized, request: async url => url.endsWith("/options") ? catalog : new Promise(done => { resolve = done; }) });
  const mounting = controller.mount(guardedHost);
  await new Promise(done => setImmediate(done));
  authorized = false; guardedHost.innerHTML = "logged out";
  resolve(data); await mounting;
  assert.equal(guardedHost.innerHTML, "logged out");
  assert.equal(controller.state.data, null);
  controller.destroy(); assert.equal(guardedHost.listeners.size, 0);
});
