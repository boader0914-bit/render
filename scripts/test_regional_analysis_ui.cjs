"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createController, createCache, createSavedResults, savedResults, latestCompletedMonth, renderCard, jobHtml, number } = require("../web/regional-analysis.js");
const { buildRegionalIndicatorManagement } = require("./lib/regional_indicator_management.cjs");
const host = () => ({ innerHTML: "", isConnected: true, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
const response = (key = "sancheong", extra = {}) => ({ status: "ready", scope: { regionKey: key, month: latestCompletedMonth(), months: 13 }, snapshot: { resultId: `${key}-1`, scope: { regionKey: key, month: latestCompletedMonth(), months: 13 }, generatedAt: "2026-10-15T06:00:00Z", groups: [] }, job: null, policy: { enabled: false, hour: 9, minute: 0, intervalHours: 24 }, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function scheduled() {
  let sequence = 0; const pending = new Map();
  return { pending, schedule(fn, ms) { assert.equal(ms, 3000); const id = ++sequence; pending.set(id, fn); return id; }, cancel(id) { pending.delete(id); } };
}

test("zero, errors and unpublished months remain distinct; annual KOSIS has no 13 month denominator", () => {
  assert.equal(number(0), "0"); assert.equal(number(null), "—");
  const data = response().snapshot;
  data.groups = [{ key: "visitors", label: "지역 방문자", status: "partial", latestPeriod: "2026-08", availableMonths: 12, expectedMonths: 13, metrics: [{ key: "count", label: "방문자", unit: "명", rows: [{ period: "2026-09", status: "publication_pending", value: 0 }, { period: "2026-08", status: "observed", value: 0 }, { period: "2026-07", status: "failed", value: 0 }, { period: "2026-06", status: "blocked", value: 0 }, { period: "2026-05", status: "partial", value: 0 }] }] }, { key: "kosis", label: "인구·산업 통계", availableMonths: 1, expectedMonths: 13, status: "ready", latestPeriod: "2024", metrics: [] }];
  const html = renderCard({ regionKey: "sancheong", regionLabel: "산청군", mode: "summary", snapshot: data });
  assert.match(html, /12\/13개월 확보/);
  assert.match(html, /<strong>0<small>명/);
  assert.match(html, /2026-09<\/th><td>—<\/td><td>공표 대기/);
  assert.match(html, /2026-07<\/th><td>—<\/td><td>확인 실패/);
  assert.match(html, /2026-06<\/th><td>—<\/td><td>접근 제한/);
  assert.match(html, /2026-05<\/th><td>—<\/td><td>일부 자료/);
  assert.doesNotMatch(html, /1\/13개월 확보/);
  assert.match(html, /월간·연간 기준기간 확인/);
  assert.match(html, /이 화면의 수치는 공식 관측자료이며 예상값과 구별됩니다/);
  assert.match(html, /지역분석의 수요 전망에서 확인/);
});

test("untrusted group values are escaped and details start folded", () => {
  const snapshot = response().snapshot;
  snapshot.groups = [{ key: 'bad" onclick="x', label: "<script>alert(1)</script>", status: 'bad"', errorCode: "AUTH_ERROR<script>", metrics: [] }];
  const html = renderCard({ regionKey: "one", regionLabel: "<img src=x>", mode: "sources", snapshot });
  assert.doesNotMatch(html, /<script|<img|class="ra-group"[^>]* open/);
  assert.match(html, /&lt;script&gt;/);
});

test("processed count is not reported as successful count", () => {
  const html = jobHtml({ status: "partial", progress: { completed: 6, total: 6 }, steps: [{ status: "ready" }, { status: "complete" }, { status: "partial" }, { status: "failed" }, { status: "failed" }, { status: "interrupted" }] });
  assert.match(html, /6\/6 항목 처리/);
  assert.match(html, /완료 2 · 일부 1 · 실패·중단 3/);
  assert.doesNotMatch(html, /6개.*성공|완료 6/);
  assert.match(jobHtml({ status: "completed" }), /처리 완료/);
  assert.match(jobHtml({ status: "superseded" }), /새 자료로 다시 정리/);
});

test("repeated mounts and concurrent surfaces reuse one stored GET and partition accounts", async () => {
  const cache = createCache(); let calls = 0;
  const fetchJson = async () => { calls++; await tick(); return response(); };
  const one = createController({ cache, fetchJson }), two = createController({ cache, fetchJson });
  await Promise.all([one.mount(host(), { regionKey: "sancheong", accountKey: "first" }), two.mount(host(), { regionKey: "sancheong", accountKey: "first", mode: "sources" })]);
  assert.equal(calls, 1);
  await one.mount(host(), { regionKey: "sancheong", accountKey: "first" });
  assert.equal(calls, 1);
  await one.mount(host(), { regionKey: "sancheong", accountKey: "second" });
  assert.equal(calls, 2);
});

test("a late previous-region response cannot overwrite the selected region", async () => {
  let resolveOld;
  const fetchJson = async url => url.includes("old") ? new Promise(resolve => { resolveOld = resolve; }) : response("new");
  const controller = createController({ cache: createCache(), fetchJson }), element = host();
  const first = controller.mount(element, { regionKey: "old", regionLabel: "이전 지역" });
  await tick();
  await controller.mount(element, { regionKey: "new", regionLabel: "새 지역" });
  resolveOld(response("old")); await first;
  assert.equal(controller.state.snapshot.scope.regionKey, "new");
  assert.match(element.innerHTML, /새 지역/);
  assert.doesNotMatch(element.innerHTML, /이전 지역/);
});

test("failed or foreign refresh preserves last good snapshot", async () => {
  let mode = "ready";
  const fetchJson = async () => { if (mode === "fail") throw new Error("응답 지연"); return response(mode === "foreign" ? "foreign" : "sancheong"); };
  const controller = createController({ cache: createCache(), fetchJson }), element = host();
  await controller.mount(element, { regionKey: "sancheong" });
  mode = "fail"; assert.equal(await controller.refresh(true), false);
  assert.equal(controller.state.snapshot.resultId, "sancheong-1");
  assert.match(element.innerHTML, /마지막 정상 저장 결과/);
  mode = "foreign"; assert.equal(await controller.refresh(true), false);
  assert.equal(controller.state.snapshot.resultId, "sancheong-1");
  assert.match(element.innerHTML, /선택 지역과 다른 (저장 결과|조회 조건)/);
});

test("source refresh failures and storage errors remain visible beside retained normal data", async () => {
  const payload = response(); payload.storage = { errorCode: "REGIONAL_RESULT_INVALID" };
  payload.snapshot.groups = [{ key: "visitors", label: "지역 방문자", status: "ready", stale: true, refresh: { errorCode: "QUOTA_EXCEEDED" }, metrics: [] }];
  const controller = createController({ cache: createCache(), fetchJson: async () => payload }), element = host();
  await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(controller.state.snapshot.resultId, "sancheong-1");
  assert.match(element.innerHTML, /저장 자료 확인 필요/);
  assert.match(element.innerHTML, /이전 자료 표시/);
  assert.match(element.innerHTML, /제공처 요청 한도/);
  assert.match(element.innerHTML, /마지막 정상 저장 결과/);
  const job = { status: "completed", resultId: "current" };
  const text = jobHtml(job, { resultId: "current", summary: { total: 6, ready: 0, partial: 0, failed: 0, missing: 6 } });
  assert.match(text, /6개 항목 처리/); assert.match(text, /자료 확보 0/); assert.match(text, /공표 대기 6/);
  assert.doesNotMatch(text, /6.*성공/);
});

test("Korea month rollover partitions cache and clears an explicitly empty new-period result", async () => {
  let clock = Date.parse("2026-10-31T14:59:00Z"), gets = 0;
  const october = response(); october.scope = { regionKey: "sancheong", month: "2026-09", months: 13 }; october.snapshot.scope.month = "2026-09";
  const november = response("sancheong", { scope: { regionKey: "sancheong", month: "2026-10", months: 13 }, snapshot: null });
  const controller = createController({ now: () => clock, cache: createCache(), fetchJson: async () => { gets++; return gets === 1 ? october : november; } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(controller.state.snapshot.scope.month, "2026-09");
  clock = Date.parse("2026-10-31T15:00:00Z");
  await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(gets, 2); assert.equal(controller.state.snapshot, null); assert.equal(controller.state.scopeMonth, "2026-10");
  assert.match(element.innerHTML, /저장된 분석이 없습니다/);
});

test("only active jobs poll and stopped or hidden screens do not poll", async () => {
  const timers = scheduled(); let shown = true, calls = 0;
  const controller = createController({ cache: createCache(), ...timers, isVisible: () => shown, fetchJson: async () => { calls++; return response("sancheong", { job: { regionKey: "sancheong", status: "running" } }); } });
  await controller.mount(host(), { regionKey: "sancheong" });
  assert.equal(timers.pending.size, 1);
  shown = false;
  const task = [...timers.pending.values()][0]; timers.pending.clear(); task(); await tick();
  assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
  shown = true; await controller.refresh(true); assert.equal(timers.pending.size, 1);
  controller.stop(); assert.equal(timers.pending.size, 0);
  assert.equal(await controller.refresh(true), false);
});

test("mount is read-only and explicit build or refresh sends different collection intent", async () => {
  const calls = [], timers = scheduled();
  const controller = createController({ cache: createCache(), ...timers, fetchJson: async (url, options) => { calls.push({ url, options }); return options ? { job: { regionKey: "sancheong", status: "queued" } } : response(); } });
  await controller.mount(host(), { regionKey: "sancheong", mode: "manage" });
  assert.equal(calls.length, 1); assert.equal(calls[0].options, undefined);
  assert.match(calls[0].url, /months=13/);
  assert.equal(controller.state.policy.enabled, false);
  await controller.start(false);
  assert.equal(JSON.parse(calls[1].options.body).collectMissing, false);
  assert.equal(await controller.start(true), false);
  controller.state.job = null;
  await controller.start(true);
  assert.equal(JSON.parse(calls[2].options.body).collectMissing, true);
  controller.stop();
});

test("lost POST response requires a status check before another submission", async () => {
  let posts = 0;
  const controller = createController({ cache: createCache(), fetchJson: async (_url, options) => { if (options) { posts++; throw new Error("연결 단절"); } return response(); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong", mode: "manage" });
  assert.equal(await controller.start(true), false);
  assert.match(element.innerHTML, /data-ra-action="refresh" disabled/);
  assert.equal(await controller.start(true), false); assert.equal(posts, 1);
  await controller.refresh(true);
  await controller.start(false); assert.equal(posts, 2);
});

test("rerendering retains an in-flight submission and returning checks actual server state", async () => {
  const cache = createCache(), timers = scheduled(); let resolvePost, gets = 0, posts = 0;
  const fetchJson = async (_url, options) => {
    if (options) { posts++; return new Promise(resolve => { resolvePost = resolve; }); }
    gets++; return response();
  };
  const controller = createController({ cache, fetchJson, ...timers }), element = host();
  await controller.mount(element, { regionKey: "sancheong", mode: "manage" });
  const pending = controller.start(true); await tick();
  await controller.mount(element, { regionKey: "sancheong", mode: "manage" });
  assert.equal(controller.state.starting, true); assert.equal(gets, 1); assert.equal(posts, 1);
  controller.stop();
  const returning = createController({ cache, fetchJson, ...timers });
  await returning.mount(host(), { regionKey: "sancheong", mode: "manage" });
  assert.equal(gets, 2, "A pending mutation invalidates the cached status on return");
  resolvePost({ job: { status: "queued", regionKey: "sancheong" } }); await pending;
  assert.equal(controller.state.starting, false);
  returning.stop();
});

test("policy is saved only on explicit action and keeps draft separate from current setting", async () => {
  const calls = [];
  const controller = createController({ cache: createCache(), fetchJson: async (url, options) => { calls.push({ url, options }); return options ? { policy: JSON.parse(options.body) } : response(); } });
  await controller.mount(host(), { regionKey: "sancheong", mode: "manage" });
  controller.updateDraft("enabled", true); controller.updateDraft("time", "15:30"); controller.updateDraft("intervalHours", "24");
  assert.equal(calls.length, 1); assert.equal(controller.state.policy.enabled, false);
  await controller.savePolicy();
  assert.match(calls[1].url, /\/policy$/);
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, { regionKey: "sancheong", months: 13, enabled: true, hour: 15, minute: 30, intervalHours: 24 });
  await tick();
});

test("cache clearing prevents an old session response from repopulating entries", async () => {
  let resolve; const cache = createCache();
  const pending = cache.get("old-account", () => new Promise(done => { resolve = done; }));
  await tick(); cache.clear(); resolve(response()); await pending;
  assert.equal(cache.read("old-account"), null);
});

test("existing five regional menus stay intact and saved UI hooks are loaded", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../web/index.html"), "utf8");
  const app = fs.readFileSync(path.resolve(__dirname, "../web/app.js"), "utf8");
  assert.match(html, /href="\/regional-analysis.css"/); assert.match(html, /src="\/regional-analysis.js"/);
  assert.match(html, /id="regionalAnalysisSummary"/); assert.match(html, /id="regionalAnalysisSources"/);
  const nav = html.match(/<nav class="region-analysis-mobile-tabs"[\s\S]*?<\/nav>/)?.[0];
  assert.deepEqual([...nav.matchAll(/data-region-analysis-tab="([^"]+)"/g)].map(match => match[1]), ["dictionary", "map", "demand", "regionCompare", "regionSources"]);
  assert.match(app, /data-regional-analysis-manage/); assert.match(app, /window\.RegionalAnalysis\?\.mount/);
  assert.match(app, /window\.RegionalAnalysis\?\.clear\(\)/);
});

function managedFixture() {
  const scope = { regionKey: "sancheong", month: "2026-09", months: 13 };
  const series = (end, value) => Array.from({ length: 13 }, (_, index) => ({
    period: new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5)) - 13 + index, 1)).toISOString().slice(0, 7),
    value, status: "observed", retrievedAt: "2026-10-14T00:00:00Z"
  }));
  const payload = response();
  payload.scope = scope;
  payload.snapshot.scope = scope;
  payload.snapshot.generatedAt = "2026-10-16T00:00:00Z";
  payload.snapshot.groups = [
    { key: "visitors", label: "지역 방문자", category: "tourism", periodType: "M", status: "ready", provider: "한국관광공사",
      latestPeriod: "2026-08", latestRequestedPeriod: "2026-09", latestRequestedStatus: "publication_pending", latestRequestedErrorCode: "PUBLICATION_PENDING",
      metrics: [{ key: "daily", label: "일평균 방문자", unit: "명", rows: series("2026-08", 0) }] },
    { key: "searchTrend", label: "검색 트렌드", category: "search", periodType: "M", status: "partial", provider: "네이버 데이터랩",
      metrics: [{ key: "interest", label: "검색 관심도", unit: "상대지수", rows: series("2026-09", 20).map(row => row.period === "2026-07" ? { ...row, status: "failed", value: 0, errorCode: "TIMEOUT" } : row) }] },
    { key: "kosis", label: "인구·산업 통계", category: "background", periodType: "mixed", status: "partial", latestPeriod: "2024", provider: "KOSIS",
      metrics: [{ key: "businesses", label: "사업체", periodType: "Y", unit: "개", rows: [{ period: "2024", value: 0, status: "observed", retrievedAt: "2026-10-12T00:00:00Z" }] },
        { key: "employees", label: "종사자", periodType: "Y", unit: "명", rows: [{ period: "2024", value: 0, status: "missing" }] }] }
  ];
  payload.policy = { enabled: true, hour: 9, minute: 0, intervalHours: 24, nextRunAt: "2026-10-17T00:00:00Z", lastRunAt: "2026-10-15T01:00:00Z" };
  const provider = { id: "provider-1", sequence: 1, scope, collectMissing: true, status: "failed", startedAt: "2026-10-15T03:00:00Z", finishedAt: "2026-10-15T03:05:00Z", networkAttempted: true, errorCode: "QUOTA_EXCEEDED" };
  payload.job = { id: "local-2", sequence: 2, scope, collectMissing: false, status: "completed", startedAt: "2026-10-16T00:00:00Z", finishedAt: "2026-10-16T00:00:01Z" };
  payload.management = buildRegionalIndicatorManagement({ ...payload, refreshHistory: [provider], now: new Date("2026-10-16T00:00:00Z") });
  return payload;
}
function managementHtml(payload, extra = {}) {
  return renderCard({ ...payload, regionKey: "sancheong", regionLabel: "산청군", mode: "manage", openGroups: new Set(), openDetails: new Set(), nowMs: Date.parse("2026-10-16T00:00:00Z"), ...extra });
}

test("management separates full latest-normal windows from a missing requested month and annual background", () => {
  const payload = managedFixture(), html = managementHtml(payload);
  assert.match(html, /최근 13개월 확보<\/span><strong>1<small>\/2개 지표/);
  assert.match(html, /확인 필요<\/span><strong>2<small>개 지표/);
  assert.match(html, /13\/13개월/);
  assert.match(html, /2026-09 자료 미확보/);
  assert.match(html, /아직 공표되지 않은 자료/);
  assert.match(html, /PUBLICATION_PENDING/);
  assert.match(html, /지역 기초자료/);
  const kosis = html.slice(html.indexOf('data-ra-group="kosis"'));
  assert.match(kosis, /1\/2개 항목/);
  assert.doesNotMatch(kosis.slice(0, kosis.indexOf('<details class="ra-method"')), /13개월|\/13/);
  assert.match(html, /<td>0<\/td><td>정상 자료/);
  assert.match(html, /2026-07<\/th><td>—<\/td><td>확인 실패<\/td><td>제공처 응답 지연/);
});

test("last provider failure stays visible after a later local rebuild; times have separate meanings", () => {
  const html = managementHtml(managedFixture());
  assert.match(html, /지역 자료 관리 갱신 시도/);
  assert.match(html, /is-failed">확인 실패<\/span>2026-10-15 12:00 KST/);
  assert.match(html, /외부 자료 요청 있음/);
  assert.match(html, /원자료 최근 확인<\/dt><dd>2026-10-14 09:00 KST/);
  assert.match(html, /결과 정리<\/dt><dd>2026-10-16 09:00 KST/);
  assert.match(html, /다음 예약 · 한국시간<\/dt><dd>2026-10-17 09:00 KST/);
  assert.doesNotMatch(html, /2026-10-15 10:00 KST|지표별 예약/);
});

test("management omits completed rebuild totals while retaining failures and other mode job summaries", () => {
  const payload = managedFixture();
  for (const status of ["completed", "unchanged", "superseded"]) {
    payload.job = { ...payload.job, status };
    assert.doesNotMatch(managementHtml(payload), /class="ra-job"/);
  }
  payload.job = { ...payload.job, status: "failed", errorCode: "NETWORK_ERROR" };
  assert.match(managementHtml(payload), /class="ra-job"/);
  payload.job = { ...payload.job, status: "completed" };
  assert.match(renderCard({ ...payload, regionKey: "sancheong", regionLabel: "산청군", mode: "summary" }), /class="ra-job"/);
});

test("validation gaps override a normal-looking raw value and duplicate periods appear once", () => {
  const payload = managedFixture(), metric = payload.snapshot.groups[1].metrics[0];
  metric.rows.push({ ...metric.rows.find(row => row.period === "2026-09"), value: 99 });
  payload.management = buildRegionalIndicatorManagement({ ...payload, now: new Date("2026-10-16T00:00:00Z") });
  const html = managementHtml(payload);
  assert.match(html, /2026-09<\/th><td>—<\/td><td>확인 실패<\/td><td>응답 형식 확인 필요/);
  assert.doesNotMatch(html, /<td>99<\/td>/);
  const search = html.slice(html.indexOf('data-ra-group="searchTrend"'), html.indexOf('data-ra-group="kosis"'));
  assert.equal((search.match(/2026-09<\/th>/g) || []).length, 1);
});

test("unrecorded missing reasons are not described as publication pending or normal zero", () => {
  const payload = managedFixture();
  payload.snapshot.groups[0].latestRequestedStatus = "missing";
  payload.snapshot.groups[0].latestRequestedErrorCode = "";
  payload.management = buildRegionalIndicatorManagement({ ...payload, now: new Date("2026-10-16T00:00:00Z") });
  const html = managementHtml(payload);
  const visitors = html.slice(html.indexOf('data-ra-group="visitors"'), html.indexOf('data-ra-group="searchTrend"'));
  assert.match(visitors, /미확보 사유 미확인/);
  assert.doesNotMatch(visitors, /아직 공표되지 않은 자료/);
});

test("management gaps absent from raw rows still appear in the monthly detail table", () => {
  const payload = managedFixture(), metric = payload.snapshot.groups[1].metrics[0];
  metric.rows = metric.rows.filter(row => row.period !== "2026-06");
  payload.management = buildRegionalIndicatorManagement({ ...payload, now: new Date("2026-10-16T00:00:00Z") });
  const html = managementHtml(payload);
  const search = html.slice(html.indexOf('data-ra-group="searchTrend"'), html.indexOf('data-ra-group="kosis"'));
  assert.match(search, /2026-06<\/th><td>—<\/td><td>자료 없음<\/td><td>미확보 사유 미확인/);
});

test("past reservation, no previous attempt, and cached provider checks remain distinct", () => {
  const payload = managedFixture();
  payload.management.refresh.schedule.status = "due";
  payload.management.refresh.schedule.nextRunAt = "2026-10-15T00:00:00Z";
  payload.management.refresh.lastProvider = { status: "never", startedAt: null, finishedAt: null, networkAttempted: null };
  let html = managementHtml(payload);
  assert.match(html, /예정 시각 지남 · 상태 확인 필요/);
  assert.match(html, /실행 기록 없음/);
  assert.doesNotMatch(html, /외부 요청 여부 미기록/);
  payload.management.refresh.lastProvider = { status: "completed", startedAt: "2026-10-16T00:00:00Z", networkAttempted: false };
  html = managementHtml(payload);
  assert.match(html, /외부 요청 없이 저장자료 사용/);
  assert.doesNotMatch(html, /외부 자료 요청 있음/);
});

test("old responses keep the controls and visible limitations without inventing refresh attempts", () => {
  const payload = managedFixture(); delete payload.management;
  payload.job = { status: "completed", collectMissing: false, startedAt: "2026-10-16T00:00:00Z" };
  const html = managementHtml(payload);
  assert.match(html, /관리 상세 정보가 없는 이전 저장자료/);
  assert.match(html, /실행 기록 없음/);
  assert.match(html, /data-ra-action="build"/);
  assert.match(html, /data-ra-action="refresh"/);
  assert.match(html, /data-ra-policy-form/);
  assert.match(html, /data-ra-detail="policy"><summary>/);
});

test("management scope is validated and disclosure state survives read-only status checks", async () => {
  let payload = managedFixture();
  const controller = createController({ cache: createCache(), fetchJson: async () => payload }), element = host();
  await controller.mount(element, { regionKey: "sancheong", mode: "manage" });
  element.listeners.get("toggle")({ target: { dataset: { raDetail: "policy" }, open: true } });
  element.listeners.get("toggle")({ target: { dataset: { raDetail: "metric:visitors:daily" }, open: true } });
  await controller.refresh(true);
  assert.match(element.innerHTML, /data-ra-detail="policy" open/);
  assert.match(element.innerHTML, /data-ra-detail="metric:visitors:daily" open/);
  payload = { ...payload, management: { ...payload.management, scope: { ...payload.scope, regionKey: "foreign" } } };
  assert.equal(await controller.refresh(true), false);
  assert.match(element.innerHTML, /선택 지역과 다른 관리 정보/);
  assert.equal(controller.state.management.scope.regionKey, "sancheong");
});

test("a stale flag alone does not claim a failed provider refresh", () => {
  const payload = managedFixture();
  payload.snapshot.groups[0].stale = true;
  const html = renderCard({ snapshot: payload.snapshot, mode: "summary", regionKey: "sancheong" });
  assert.match(html, /최신 자료인지 확인이 필요합니다/);
  assert.doesNotMatch(html, /최근 갱신을 완료하지 못해/);
});

test("legacy regional values stay visible with a folded scope warning instead of claiming verified administrative coverage", () => {
  const snapshot = response().snapshot;
  snapshot.groups = [{ key: "visitors", label: "지역 방문자", provider: "한국관광공사", periodType: "M", status: "ready",
    metrics: [{ key: "count", label: "방문자", unit: "명", rows: [{ period: "2026-08", status: "observed", value: 0 }] }] }];
  const html = renderCard({ regionKey: "sancheong", regionLabel: "산청군", mode: "summary", snapshot });
  assert.match(html, /지역 범위 확인 필요/); assert.match(html, /<strong>0<small>명/);
  assert.match(html, /class="ra-contract" data-ra-detail="scope:visitors">/);
  assert.doesNotMatch(html, /data-ra-detail="scope:visitors" open/);
  for (const label of ["공통 기준 · 출처·지역 범위", "실제 범위", "기준기간", "수집 상태"]) assert.ok(html.includes(label));
  assert.equal(snapshot.groups[0].metrics[0].rows[0].value, 0);
});

test("stored original evidence and unavailable-original reasons appear only inside existing criteria", () => {
  const snapshot = response().snapshot;
  const spatialContract = { version: "regional-data-contract-v1", provider: "한국관광공사", requestedRegionKey: "sancheong", officialCode: "4886000000",
    requestedLevel: "sigungu", requestedUnitType: "county", providerRegionCode: "48860", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none",
    storedProvenance: { version: "stored-tourism-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "visitor-202608-abcdef0123456789", sha256: "a".repeat(64), period: "2026-08", verifiedAt: "2026-10-17T08:00:00Z", checks: ["hash", "region"] } };
  const point = { period: "2026-08", status: "observed", value: 0, spatialContract };
  snapshot.groups = [{ key: "visitors", label: "지역 방문자", provider: "한국관광공사", periodType: "M", status: "ready", spatialContract,
    metrics: [{ key: "count", label: "방문자", unit: "명", rows: [point] }] }];
  let html = renderCard({ regionKey: "sancheong", snapshot });
  assert.match(html, /보관 원본 재검증/); assert.match(html, /visitor-202608-abcdef0123456789/);
  assert.doesNotMatch(html, /data-ra-detail="scope:visitors" open/);
  point.spatialContract = { ...spatialContract, status: "scope_unverified", evidence: "unverified" };
  point.storedEvidenceVerification = { status: "pending", reasonCode: "RAW_RESPONSE_NOT_RETAINED", secret: "do-not-render" };
  html = renderCard({ regionKey: "sancheong", snapshot });
  assert.match(html, /보관 근거 미확인/); assert.match(html, /응답 원본이 없어/); assert.doesNotMatch(html, /do-not-render|보관 원본 재검증/);
});

test("region scope evidence honors row overrides and remains visible in management without copied contracts", () => {
  const snapshot = response().snapshot;
  const contract = { version: "regional-data-contract-v1", provider: "한국관광공사", requestedRegionKey: "sancheong", officialCode: "4886000000",
    requestedLevel: "sigungu", requestedUnitType: "county", providerRegionCode: "48860", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none" };
  snapshot.groups = [{ key: "visitors", label: "지역 방문자", provider: "한국관광공사", periodType: "M", status: "ready", spatialContract: contract,
    metrics: [{ key: "count", label: "방문자", unit: "명", rows: [{ period: "2026-08", status: "observed", value: 0, spatialContract: { ...contract, status: "scope_unverified", evidence: "unverified" } }] }] }];
  const state = { regionKey: "sancheong", regionLabel: "산청군", mode: "summary", snapshot, openDetails: new Set(["scope:visitors"]) };
  let html = renderCard(state);
  assert.match(html, /지역 범위 확인 필요/); assert.doesNotMatch(html, /시·군·구 기준 · 범위 일치/);
  assert.match(html, /data-ra-detail="scope:visitors" open/);
  snapshot.groups[0].metrics[0].rows[0].spatialContract = { ...contract };
  state.mode = "manage";
  state.management = { schemaVersion: 1, groups: [{ key: "visitors", label: "지역 방문자", status: "ready", metrics: [] }], refresh: {}, result: {} };
  html = renderCard(state);
  assert.match(html, /시·군·구 기준 · 범위 일치/); assert.match(html, /제공 지역 48860/);
  assert.match(html, /제공 응답에서 확인/); assert.match(html, /data-ra-detail="scope:visitors" open/);
  snapshot.groups[0].metrics[0].rows[0].spatialContract = { ...contract, status: "response_mismatch", reasonCode: "RESPONSE_REGION_MISMATCH" };
  html = renderCard(state); assert.match(html, /요청 지역과 응답 범위 다름/);
});

test("keyword scope, annual periods and untrusted provenance remain distinct in regional evidence", () => {
  const snapshot = response().snapshot;
  const bad = '<img src=x onerror="bad()">';
  snapshot.groups = [
    { key: "searchTrend", label: "검색 관심도", provider: "네이버 데이터랩", category: "search", periodType: "M", metrics: [{ key: "interest", unit: "상대지수", rows: [{ period: "2026-09", status: "observed", value: 0 }] }] },
    { key: "kosis", label: "산업", provider: "KOSIS", category: "background", metrics: [{ key: "workers", label: bad, unit: "명", periodType: "Y", rows: [{ period: "2024", status: "observed", value: 9 }] }] }
  ];
  const html = renderCard({ regionKey: "sancheong", regionLabel: "산청군", snapshot });
  assert.match(html, /키워드 기준 · 지역 직접 비교 제외/); assert.match(html, /키워드 검색 범위/);
  assert.match(html, /2024<small>연간 자료/); assert.doesNotMatch(html, /<img|onerror="bad/); assert.match(html, /&lt;img/);
  const fs = require("node:fs"), path = require("node:path"), css = fs.readFileSync(path.join(__dirname, "../web/regional-analysis.css"), "utf8");
  assert.match(css, /\.ra-contract[^}]*var\(--ra-border\)/); assert.match(css, /\.ra-contract small[^}]*overflow-wrap:anywhere/);
});
