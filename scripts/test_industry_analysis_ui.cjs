"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, renderDashboard, dailyChart, percent, money, count } = require("../web/industry-analysis.js");

const catalog = { industries: [{ id: "glamping", label: "글램핑", unitLabel: "객실/동" }, { id: "poolVilla", label: "풀빌라", unitLabel: "독채/객실" }], months: ["2026-10", "2026-09"], defaultMonth: "2026-10", defaultIndustry: "glamping", regions: [{ id: "sacheon", label: "경남 사천시", indicatorCandidate: true }] };
const summary = { companyCount: 2, observedCompanies: 1, coveredCompanyDays: 1, expectedCompanyDays: 62, coverageRate: 1 / 62, reservationRate: 0, averageBookedPrice: null, revenuePerAvailableUnitDay: 0, estimatedRevenue: 0, publicRevenue: 0, phoneRevenue: 0, publicBookings: 0, phoneBookings: 0 };
const data = { request: { region: "all" }, industry: catalog.industries[0], period: { start: "2026-10-01", end: "2026-10-31", days: 31 }, summary, daily: [{ date: "2026-10-01", publicBookings: 0, phoneBookings: 0 }, { date: "2026-10-02", publicBookings: null, phoneBookings: null }], regions: [{ id: "sacheon", label: "경남 사천시", companyCount: 0, observedCompanies: 0, coveredCompanyDays: 0, expectedCompanyDays: 0, coverageRate: null, reservationRate: null }], industryComparison: { status: "insufficient", rows: [] }, quality: { warnings: ["자료 범위가 다릅니다."] }, context: { sources: [] }, companies: [] };
function state(extra = {}) { return { catalog, data: structuredClone(data), selection: { industry: "glamping", month: "2026-10", region: "all" }, tab: "overview", loading: false, error: "", ...extra }; }
function host() { const listeners = new Map(); return { innerHTML: "", addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); }, querySelector() { return { focus() {} }; }, listeners }; }
function stored(status, { hasSnapshot = true, month = "2026-10", region = "all", ...extra } = {}) {
  return { ...(hasSnapshot ? structuredClone(data) : {}), request: { industry: "glamping", month, region, cutoffDate: "2026-10-11" },
    storage: { status, hasSnapshot, stale: status !== "ready", calculatedAt: hasSnapshot ? "2026-10-10T00:00:00Z" : null, sourceRevision: "source-1", resultRevision: 1, ...extra } };
}
function scheduled() {
  const waiting = new Map(); let sequence = 0;
  return { waiting, setTimeout(callback, ms) { assert.equal(ms, 3000); const id = ++sequence; waiting.set(id, callback); return id; }, clearTimeout(id) { waiting.delete(id); },
    async tick() { const entry = waiting.entries().next().value; assert.ok(entry, "A poll must be scheduled"); waiting.delete(entry[0]); entry[1](); await new Promise(done => setImmediate(done)); } };
}

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
  assert.match(html, /href="\/admin\?adminCompany=1#admin-db-company=1"/);
  assert.doesNotMatch(html, /data-industry-open-run=/);
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
  assert.match(element.innerHTML, /추정예약률<\/span><strong>0%/, "A failed status refresh preserves the last known valid zero instead of discarding the snapshot");
  assert.match(element.innerHTML, /마지막 정상/);
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

test("queued and processing snapshots poll lightly until ready, without manufacturing zero metrics", async () => {
  const clock = scheduled(), calls = [], results = [stored("queued", { hasSnapshot: false }), stored("processing", { hasSnapshot: false }), stored("ready")];
  const element = host(), controller = createController({ ...clock, request: async (url, options) => { calls.push({ url, options }); return url.endsWith("/options") ? catalog : results.shift(); } });
  await controller.mount(element);
  assert.equal(controller.state.data, null);
  assert.match(element.innerHTML, /집계 대기/);
  assert.doesNotMatch(element.innerHTML, /추정예약률<\/span><strong>0%|관측 추정매출 소계/);
  assert.equal(clock.waiting.size, 1);
  await clock.tick();
  assert.match(element.innerHTML, /저장 자료를 집계하고 있습니다/);
  assert.equal(clock.waiting.size, 1);
  await clock.tick();
  assert.equal(clock.waiting.size, 0);
  assert.match(element.innerHTML, /집계 완료/);
  assert.match(element.innerHTML, /관측 확보율과 다릅니다/);
  assert.match(element.innerHTML, /마지막 정상 집계/);
  assert.ok(element.innerHTML.includes(new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date("2026-10-10T00:00:00Z"))));
  assert.match(element.innerHTML, /관측 기준일 <b>2026.10.11/);
  assert.equal(calls.filter(call => call.url.endsWith("/options")).length, 1, "Polling does not reload the catalog");
  assert.ok(calls.every(call => call.options?.method !== "POST"), "Status polling cannot request a rebuild");
  controller.destroy();
});

function reviewData() {
  const result = stored("ready");
  result.review = { schemaVersion: 1, scope: "selected_industry_region_top20", companyCount: 2, expectedCompanyDays: 6, observedCompanyDays: 4, missingCompanyDays: 2,
    daily: [
      { date: "2026-10-01", expectedCompanies: 2, observedCompanies: 2, missingCompanies: 0, excludedCompanies: 0, partialCompanies: 0, priceUnavailableCompanies: 0 },
      { date: "2026-10-02", expectedCompanies: 2, observedCompanies: 1, missingCompanies: 1, excludedCompanies: 0, partialCompanies: 0, priceUnavailableCompanies: 0 },
      { date: "2026-10-03", expectedCompanies: 2, observedCompanies: 1, missingCompanies: 1, excludedCompanies: 1, partialCompanies: 0, priceUnavailableCompanies: 0 }
    ], reasonsSummary: [{ code: "no_saved_observation", label: "저장 관측 자료 없음", companyDays: 1, companies: 1, type: "inventory" }, { code: "provider_blocked", label: "접근 제한으로 미확인", companyDays: 1, companies: 1, type: "latest_attempt" }],
    companies: [
      { companyId: "central-good", primaryName: "가 정상업체", regionLabel: "경남 사천시", observedDays: 3, missingDays: 0, priceUnavailableDays: 0, dates: [1, 2, 3].map(day => ({ date: `2026-10-0${day}`, status: "observed", reasons: [], runId: "good-run", collectedAt: "2026-10-01T02:00:00Z", reservationEligible: true, priceEligible: true, reservationCount: 1, observedZero: false })) },
      { companyId: "central-review", placeId: "not-a-central-id", primaryName: "나 검토업체", regionLabel: "경남 사천시", observedDays: 1, missingDays: 2, priceUnavailableDays: 0, dates: [
        { date: "2026-10-01", status: "observed", reasons: [], runId: "kept-run", collectedAt: "2026-10-01T01:15:00Z", reservationEligible: true, priceEligible: true, reservationCount: 0, observedZero: true, latestAttemptStatus: "excluded", latestAttemptRunId: "blocked-run", latestAttemptCollectedAt: "2026-10-01T04:30:00Z", latestAttemptReasons: [{ code: "provider_blocked", label: "접근 제한으로 미확인" }] },
        { date: "2026-10-02", status: "missing", reasons: [{ code: "no_saved_observation", label: "저장 관측 자료 없음" }], runId: null, collectedAt: null, reservationEligible: false, priceEligible: false, reservationCount: null, observedZero: false },
        { date: "2026-10-03", status: "excluded", reasons: [{ code: "incomplete_inventory", label: "상품 범위 확인 필요" }], runId: "partial-run", collectedAt: "2026-10-03T03:00:00Z", reservationEligible: false, priceEligible: false, reservationCount: null, observedZero: false }
      ] }
    ] };
  return result;
}

test("review retains coverage and source times while distinguishing observed zero, gaps and latest failed attempts", () => {
  const html = renderDashboard(state({ data: reviewData(), tab: "review" }));
  assert.match(html, /마지막 정상 집계/); assert.match(html, /1 \/ 62 업체·숙박일/);
  assert.match(html, /data-ia-review-date="2026-10-02"[^>]*aria-label="[^" ]* · 관측 1 \/ 2업체 · 미확인 1업체/);
  assert.ok(html.indexOf('data-ia-review-company="central-review"') < html.indexOf('data-ia-review-company="central-good"'), "Companies with problems precede alphabetically earlier healthy companies");
  assert.match(html, /data-tone="observed">관측 0/); assert.match(html, /data-tone="missing">자료 없음/); assert.match(html, /data-tone="attention">집계 제외/);
  assert.match(html, /예약 0/); assert.match(html, /예약 수 미확인/);
  assert.match(html, /이 날짜는 이전의 정상 관측 자료를 사용합니다/);
  assert.match(html, /data-industry-open-run="kept-run"/); assert.match(html, /data-industry-open-run="blocked-run"/);
  for (const instant of ["2026-10-01T01:15:00Z", "2026-10-01T04:30:00Z"]) assert.ok(html.includes(new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date(instant))));
  assert.match(html, /href="\/admin\?adminCompany=central-review#admin-db-company=central-review"/);
  assert.doesNotMatch(html, /not-a-central-id/);
  assert.match(html, /<details class="ia-review-date"[^>]*data-review-date="2026-10-01"[^>]* open>/);
});

test("legacy or unsupported review snapshots explicitly lack evidence instead of inventing normal days", () => {
  for (const review of [undefined, { schemaVersion: 2, companies: [], daily: [] }, { schemaVersion: 1, companies: [] }]) {
    const html = renderDashboard(state({ data: { ...stored("ready"), review }, tab: "review" }));
    assert.match(html, /날짜별 검토 근거가 없습니다/); assert.match(html, /정상이나 0으로 판단하지 않습니다/);
    assert.match(html, /마지막 정상 집계/); assert.doesNotMatch(html, /data-ia-review-date=|data-tone="observed"/);
  }
});

test("saved-dataset source warnings remain separate from selected-scope warnings and escape HTML", () => {
  const result = stored("ready");
  result.quality = { warnings: ["선택 업종의 관측 범위 확인 필요"], scope: "selected_industry_region_top20", sourceWarningsScope: "saved_dataset",
    sourceWarnings: ["업체 고유번호 미확정으로 일부 자료 제외", "플레이스번호 중복 확인 필요", '<img src=x onerror="unsafe"> <script>unsafe</script>', null] };
  for (const tab of ["overview", "review"]) {
    const html = renderDashboard(state({ data: result, tab }));
    const overall = html.match(/<details class="ia-disclosure ia-source-warnings">[\s\S]*?<\/details>/)?.[0];
    assert.ok(overall, "Source warnings have their own initially collapsed disclosure");
    assert.match(overall, /저장 자료 전체 참고 <span>3건/);
    assert.match(overall, /현재 선택한 업종·지역의 표본 밖/);
    assert.match(overall, /업체 고유번호 미확정/); assert.match(overall, /플레이스번호 중복/);
    assert.match(overall, /&lt;img src=x onerror=&quot;unsafe&quot;&gt; &lt;script&gt;unsafe&lt;\/script&gt;/);
    assert.doesNotMatch(overall, /<img|<script|선택 업종의 관측 범위/);
    const selected = html.match(/<details class="ia-disclosure"><summary>자료 해석 시 확인할 점[\s\S]*?<\/details>/)?.[0];
    assert.match(selected, /선택 업종의 관측 범위 확인 필요/);
    assert.doesNotMatch(selected, /업체 고유번호 미확정|플레이스번호 중복/);
  }
});

test("expanded review companies show the shared verified or observed capacity basis without edit controls", () => {
  for (const [capacity, capacitySource, capacityBasis, expected] of [
    [12, "db_review", { source: "db_review" }, /객실·사이트 기준 <b>12개<\/b> · 관리자 검수값/],
    [10, "observed_max_locked", null, /객실·사이트 기준 <b>10개<\/b> · 최대 관측값 고정 · 미검수/],
    [null, "unknown", null, /객실·사이트 기준 <b>확인 전<\/b> · 객실 기준 확인 필요/]
  ]) {
    const result = reviewData(); Object.assign(result.review.companies[1], { capacity, capacitySource, capacityBasis });
    const html = renderDashboard(state({ data: result, tab: "review" }));
    assert.match(html, expected);
    assert.doesNotMatch(html, /data-(?:capacity-edit|admin-db-edit)|객실 기준 수정/);
  }
});

test("review filters, date selection and Korean text input only narrow saved results", async () => {
  const calls = [], element = host(), controller = createController({ request: async url => { calls.push(url); return url.endsWith("/options") ? catalog : reviewData(); } });
  await controller.mount(element); controller.selectTab("review");
  controller.reviewInput("issue", "latest");
  assert.match(element.innerHTML, /data-ia-review-company="central-review"/); assert.doesNotMatch(element.innerHTML, /data-ia-review-company="central-good"/);
  assert.match(element.innerHTML, /data-review-date="2026-10-01"/); assert.doesNotMatch(element.innerHTML, /data-review-date="2026-10-02"/);
  controller.reviewInput("issue", "missing"); controller.reviewInput("date", "2026-10-01");
  assert.match(element.innerHTML, /조건에 맞는 업체가 없습니다/);
  controller.reviewInput("date", "2026-10-02");
  assert.match(element.innerHTML, /data-ia-review-date="2026-10-02" aria-pressed="true"/);
  const target = { dataset: { iaReviewFilter: "company" }, value: "검토업체", selectionStart: 4, selectionEnd: 4 };
  element.listeners.get("input")({ target, isComposing: true }); assert.equal(controller.state.reviewFilters.company, "");
  element.listeners.get("compositionend")({ target, isComposing: false }); assert.equal(controller.state.reviewFilters.company, "검토업체");
  assert.match(element.innerHTML, /data-ia-review-company="central-review"/);
  assert.equal(calls.length, 2, "All review interactions use the loaded snapshot without requests");
  element.listeners.get("click")({ target: { closest: () => ({ dataset: { iaReviewReset: "" } }) } });
  assert.deepEqual(controller.state.reviewFilters, { company: "", issue: "all", date: "" });
  controller.reviewInput("company", "없는 업체"); assert.match(element.innerHTML, /조건에 맞는 업체가 없습니다/);
  await controller.input("month", "2026-09"); assert.deepEqual(controller.state.reviewFilters, { company: "", issue: "all", date: "" });
  controller.destroy(); assert.equal(element.listeners.size, 0);
});

test("pending snapshot polling preserves review search focus and defers screen replacement during Korean composition", async () => {
  const clock = scheduled(), element = host(), document = { activeElement: null };
  let search, html = "", renders = 0;
  element.ownerDocument = document; element.contains = target => target === search;
  element.querySelector = selector => selector === '[data-ia-review-filter="company"]' ? search : { focus() {} };
  Object.defineProperty(element, "innerHTML", { get: () => html, set(value) {
    html = value; renders++; if (document.activeElement === search) document.activeElement = null;
    search = { dataset: { iaReviewFilter: "company" }, value: value.match(/data-ia-review-filter="company" value="([^"]*)"/)?.[1] || "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
      focus() { document.activeElement = this; }, setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  } });
  const responses = ["queued", "processing", "ready"].map(status => { const result = reviewData(); result.storage.status = status; return result; });
  const controller = createController({ ...clock, request: async url => url.endsWith("/options") ? catalog : responses.shift() });
  await controller.mount(element); controller.selectTab("review");
  search.focus(); search.value = "검토"; search.setSelectionRange(1, 2, "backward");
  element.listeners.get("input")({ target: search, isComposing: false });
  await clock.tick();
  assert.equal(document.activeElement, search); assert.equal(search.value, "검토");
  assert.deepEqual([search.selectionStart, search.selectionEnd, search.selectionDirection], [1, 2, "backward"]);
  const composing = search, beforeHtml = html, beforeRenders = renders;
  composing.value = "검토업체"; composing.setSelectionRange(4, 4, "none");
  element.listeners.get("compositionstart")({ target: composing });
  element.listeners.get("input")({ target: composing, isComposing: true });
  await clock.tick();
  assert.equal(controller.state.storage.status, "ready", "The newest response is accepted while the DOM waits for composition");
  assert.equal(renders, beforeRenders); assert.equal(html, beforeHtml);
  assert.equal(document.activeElement, composing); assert.equal(composing.value, "검토업체");
  element.listeners.get("compositionend")({ target: composing });
  assert.equal(controller.state.reviewFilters.company, "검토업체");
  assert.equal(document.activeElement, search); assert.equal(search.value, "검토업체");
  assert.deepEqual([search.selectionStart, search.selectionEnd], [4, 4]);
  assert.match(html, /집계 완료/); assert.match(html, /data-ia-review-company="central-review"/);
  controller.destroy(); assert.equal(element.listeners.size, 0);
});

test("review pagination and folding avoid rendering every company date at once", async () => {
  const result = reviewData(); result.review.companies = Array.from({ length: 45 }, (_, index) => ({ ...result.review.companies[0], companyId: `company-${index}`, primaryName: `업체 ${String(index).padStart(2, "0")}` }));
  const calls = [], element = host(), controller = createController({ request: async url => { calls.push(url); return url.endsWith("/options") ? catalog : result; } });
  await controller.mount(element); controller.selectTab("review");
  assert.equal((element.innerHTML.match(/class="ia-review-company"/g) || []).length, 20);
  assert.equal((element.innerHTML.match(/class="ia-review-date"/g) || []).length, 0);
  element.listeners.get("click")({ target: { closest: () => ({ dataset: { iaReviewPage: "1" } }) } });
  assert.equal(controller.state.reviewPage, 1); assert.match(element.innerHTML, /업체 20/); assert.doesNotMatch(element.innerHTML, /업체 00/);
  element.listeners.get("toggle")({ target: { dataset: { iaReviewCompany: "company-20", iaReviewExpanded: "false" }, open: true } });
  assert.equal((element.innerHTML.match(/class="ia-review-date"/g) || []).length, 3);
  element.listeners.get("toggle")({ target: { dataset: { iaReviewDay: "company-20:2026-10-01", iaReviewExpanded: "false" }, open: true } });
  controller.render(); assert.match(element.innerHTML, /data-ia-review-day="company-20:2026-10-01"[^>]* open>/);
  assert.equal(calls.length, 2);
  controller.destroy();
});

test("review labels and source links escape content and never substitute provider IDs for missing company IDs", () => {
  const result = reviewData(), row = result.review.companies[1];
  row.companyId = ""; row.primaryName = '<img src=x onerror="x">'; row.placeId = "provider-only";
  row.dates[0].runId = 'saved" onclick="x'; row.dates[0].latestAttemptReasons[0].label = "<script>unsafe</script>";
  const html = renderDashboard(state({ data: result, tab: "review" }));
  assert.doesNotMatch(html, /<img|<script|adminCompany=provider-only/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;unsafe/);
  assert.match(html, /data-industry-open-run="saved&quot; onclick=&quot;x"/);
  assert.match(html, /업체 DB 연결 정보 없음/);
});

test("closed-month ready snapshots show durable reuse and preserve partial observation coverage and dates", () => {
  const closed = stored("ready", { month: "2026-09", monthClosed: true, reusePolicy: "closed_month" });
  closed.request.cutoffDate = "2026-09-30";
  closed.period = { start: "2026-09-01", end: "2026-09-30", days: 30, monthClosed: true };
  const html = renderDashboard(state({ data: closed, selection: { industry: "glamping", month: "2026-09", region: "all" } }));
  assert.match(html, /마감월 저장 집계/);
  assert.match(html, /저장된 결과를 조회합니다\. 객실 검수·자료 보완 시 갱신됩니다\./);
  assert.match(html, /마지막 정상 집계/);
  assert.ok(html.includes(new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(new Date("2026-10-10T00:00:00Z"))));
  assert.match(html, /관측 기준일 <b>2026.09.30/);
  assert.match(html, /1 \/ 62 업체·숙박일/);
  assert.match(html, /미관측일은 0으로 계산하지 않습니다/);
  assert.doesNotMatch(html, /data-ia-action="rebuild"|관측 확보 완료/);
});

test("closed-month pending and failed states retain their status instead of appearing as a saved ready result", () => {
  for (const [status, label] of [["queued", "집계 대기"], ["processing", "집계 중"], ["failed", "최근 집계 실패"]]) {
    const html = renderDashboard(state({ data: stored(status, { monthClosed: true, reusePolicy: "closed_month" }) }));
    assert.ok(html.includes(label), status);
    assert.doesNotMatch(html, /마감월 저장 집계|저장된 결과를 조회합니다/, status);
    assert.match(html, /마지막 정상 집계를 표시합니다/, status);
  }
  assert.match(renderDashboard(state({ data: stored("ready", { monthClosed: false, reusePolicy: "live_month" }) })), /집계 완료는 저장 자료의 계산이 끝났다는 뜻이며, 관측 확보율과 다릅니다/);
});

test("same-condition refresh preserves the last successful snapshot and a failed rebuild remains terminal", async () => {
  const clock = scheduled(); let response = () => stored("ready"), resolveRefresh;
  const element = host(), controller = createController({ ...clock, request: async url => url.endsWith("/options") ? catalog : response() });
  await controller.mount(element);
  response = () => new Promise(resolve => { resolveRefresh = resolve; });
  const refresh = controller.loadData();
  assert.match(element.innerHTML, /추정예약률<\/span><strong>0%/);
  assert.match(element.innerHTML, /상태 확인 중/);
  resolveRefresh(stored("processing")); await refresh;
  assert.match(element.innerHTML, /마지막 정상 집계를 표시/);
  response = () => stored("failed"); await clock.tick();
  assert.equal(clock.waiting.size, 0);
  assert.match(element.innerHTML, /최근 집계 실패/);
  assert.match(element.innerHTML, /추정예약률<\/span><strong>0%/);
  assert.match(element.innerHTML, /data-ia-action="rebuild"/);
  response = () => { throw new Error("연결 실패"); }; await controller.loadData();
  assert.match(element.innerHTML, /role="alert"/);
  assert.match(element.innerHTML, /추정예약률<\/span><strong>0%/);
  assert.equal(clock.waiting.size, 0);
  controller.destroy();
});

test("changing conditions clears old metrics and pending or failed without a snapshot never looks like zero", async () => {
  const clock = scheduled(); let resolveChanged;
  const element = host(), controller = createController({ ...clock, request: async url => url.endsWith("/options") ? catalog : url.includes("month=2026-10") ? stored("processing") : new Promise(resolve => { resolveChanged = resolve; }) });
  await controller.mount(element);
  assert.equal(clock.waiting.size, 1);
  const change = controller.input("month", "2026-09");
  assert.equal(clock.waiting.size, 0);
  assert.equal(controller.state.data, null);
  assert.doesNotMatch(element.innerHTML, /추정예약률<\/span><strong>0%/);
  resolveChanged(stored("pending", { hasSnapshot: false, month: "2026-09" })); await change;
  assert.match(element.innerHTML, /저장 집계 준비 대기/);
  assert.equal(clock.waiting.size, 0);
  const failed = renderDashboard(state({ data: null, storage: stored("failed", { hasSnapshot: false }).storage }));
  assert.match(failed, /저장 집계를 준비하지 못했습니다/);
  assert.doesNotMatch(failed, /추정예약률<\/span><strong>0%/);
  controller.destroy();
});

test("pause, hidden views and revoked roles stop polling and suppress late replies; resuming reads status", async () => {
  const clock = scheduled(); let visible = true, authorized = true, calls = 0, reply = () => stored("processing", { hasSnapshot: false }), resolveLate;
  const element = host(), controller = createController({ ...clock, isVisible: () => visible, isAuthorized: () => authorized, request: async url => { if (url.endsWith("/options")) return catalog; calls++; return reply(); } });
  await controller.mount(element); assert.equal(clock.waiting.size, 1);
  controller.pause(); assert.equal(clock.waiting.size, 0);
  await controller.loadData(); assert.equal(calls, 1);
  await controller.mount(element); assert.equal(calls, 2); assert.equal(clock.waiting.size, 1);
  visible = false; await clock.tick(); assert.equal(calls, 2); assert.equal(clock.waiting.size, 0);
  visible = true; await controller.mount(element); assert.equal(calls, 3);
  authorized = false; await clock.tick(); assert.equal(calls, 3); assert.equal(clock.waiting.size, 0);
  authorized = true; reply = () => new Promise(resolve => { resolveLate = resolve; });
  const resume = controller.mount(element);
  controller.pause(); resolveLate(stored("ready")); await resume;
  assert.equal(controller.state.data, null);
  assert.equal(clock.waiting.size, 0);
  controller.destroy(); assert.equal(element.listeners.size, 0);
});

test("rebuild requires an explicit failed-state action, guards duplicates and checks unknown outcomes before retry", async () => {
  const clock = scheduled(), calls = []; let rejectPost, resolvePost;
  const element = host(), controller = createController({ ...clock, request: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/options")) return catalog;
    if (options?.method === "POST") return new Promise((resolve, reject) => { resolvePost = resolve; rejectPost = reject; });
    return stored("failed", { hasSnapshot: false });
  } });
  await controller.mount(element);
  assert.equal(clock.waiting.size, 0);
  const attempt = controller.rebuild(); await controller.rebuild();
  assert.equal(calls.filter(call => call.options?.method === "POST").length, 1);
  const posted = calls.find(call => call.options?.method === "POST");
  assert.equal(posted.url, "/api/industry-analysis/rebuild");
  assert.deepEqual(posted.options.body, { industry: "glamping", month: "2026-10", region: "all", cutoffDate: "2026-10-11" });
  rejectPost(new Error("연결 끊김")); await attempt;
  assert.equal(controller.state.rebuildNeedsCheck, true);
  await controller.rebuild(); assert.equal(calls.filter(call => call.options?.method === "POST").length, 1);
  assert.equal(clock.waiting.size, 0, "An unknown POST outcome must not retry automatically");
  await controller.loadData(); assert.equal(controller.state.rebuildNeedsCheck, false);
  const retry = controller.rebuild(); resolvePost(stored("queued", { hasSnapshot: false })); await retry;
  assert.equal(clock.waiting.size, 1);
  await controller.rebuild(); assert.equal(calls.filter(call => call.options?.method === "POST").length, 2, "A queued rebuild cannot be resubmitted");
  assert.match(element.innerHTML, /집계 대기/);
  controller.destroy();
});

test("mismatched stored snapshot conditions cannot replace a valid selected snapshot", async () => {
  let wrong = false;
  const element = host(), controller = createController({ request: async url => url.endsWith("/options") ? catalog : stored("ready", wrong ? { month: "2026-09" } : {}) });
  await controller.mount(element); wrong = true; await controller.loadData();
  assert.match(controller.state.error, /조건이 일치하지 않습니다/);
  assert.equal(controller.state.data.request.month, "2026-10");
  assert.match(element.innerHTML, /마지막 정상 집계를 표시합니다/);
  controller.destroy();
});
