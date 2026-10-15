"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createController, createCache, renderCard, jobHtml, number } = require("../web/regional-analysis.js");
const host = () => ({ innerHTML: "", isConnected: true, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
const response = (key = "sancheong", extra = {}) => ({ status: "ready", snapshot: { resultId: `${key}-1`, scope: { regionKey: key, months: 13 }, generatedAt: "2026-10-15T06:00:00Z", groups: [] }, job: null, policy: { enabled: false, hour: 9, minute: 0, intervalHours: 24 }, ...extra });
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
  assert.match(html, /2026-06<\/th><td>—<\/td><td>확인 필요/);
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
  assert.match(element.innerHTML, /선택 지역과 다른 저장 결과/);
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
  const october = response(); october.scope = { regionKey: "sancheong", month: "2026-09" }; october.snapshot.scope.month = "2026-09";
  const november = response("sancheong", { scope: { regionKey: "sancheong", month: "2026-10" }, snapshot: null });
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
