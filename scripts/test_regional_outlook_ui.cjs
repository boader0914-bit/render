"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, createCache, renderCard, calendarHtml, number, currentMonth } = require("../web/regional-outlook.js");
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = () => Date.parse("2026-10-16T00:00:00Z");
const host = () => ({ innerHTML: "", isConnected: true, listeners: new Map(), addEventListener(name, listener) { this.listeners.set(name, listener); } });
function fixture(key = "sancheong", extra = {}) {
  return { status: "ready", scope: { regionKey: key, month: "2026-10", months: 13 }, snapshot: { resultId: `${key}-one`, scope: { regionKey: key }, asOfMonth: "2026-10", asOfDate: "2026-10-16", generatedAt: "2026-10-16T00:00:00Z", targets: [{ period: "2026-10", kind: "current", label: "이번 달 예상", calendar: { status: "ready", weekendDays: 9, holidayDays: 3, longestRunDays: 3, longBreaks: [{ start: "2026-10-03", end: "2026-10-05", days: 3, names: ["개천절", "대체공휴일"] }] } }, { period: "2026-11", kind: "next", label: "다음 달 전망", calendar: { status: "missing", weekendDays: 9, holidayDays: null, longestRunDays: null, longBreaks: [] } }], metrics: [{ key: "visitors:average", groupKey: "visitors", groupLabel: "지역 방문자", label: "일평균 방문자", unit: "명", latestPeriod: "2026-08", latestValue: 1200, availableMonths: 13, provider: "한국관광공사", forecasts: [{ period: "2026-10", status: "forecast", value: 0, validation: { status: "validated", folds: 5, mae: 10, wapePct: 5 }, holiday: { adjustmentApplied: true, adjustment: 5 } }, { period: "2026-11", status: "unavailable", value: 0, reasonCode: "STALE_SOURCE", holiday: { adjustmentApplied: false } }] }] }, job: null, storage: {}, ...extra };
}
function timers() { let i = 0; const pending = new Map(); return { pending, schedule(fn, ms) { assert.equal(ms, 3000); const id = ++i; pending.set(id, fn); return id; }, cancel(id) { pending.delete(id); } }; }

test("normal zero forecast stays numeric while unavailable zero never becomes a prediction", () => {
  assert.equal(number(0), "0"); assert.equal(number(null), "—");
  const data = fixture(); const html = renderCard({ regionLabel: "산청군", regionKey: "sancheong", targetMonth: "2026-10", snapshot: data.snapshot });
  assert.match(html, /이번 달 예상/); assert.match(html, /다음 달 전망/);
  assert.match(html, /<strong>0<span>명<\/span>/);
  assert.match(html, /최근 자료가 오래되어 전망 보류/);
  assert.match(html, /과거 5회 검증 · 평균 오차 10/);
  assert.match(html, /연휴 영향 \+5명 반영/);
  assert.doesNotMatch(html, /종합 점수|예약률 예상|95% 신뢰/);
  assert.doesNotMatch(html, /class="ro-group"[^>]* open/);
});

test("holiday source gaps are shown separately from known weekends and genuine holiday zero", () => {
  const unknown = calendarHtml({ status: "missing", weekendDays: 8, holidayDays: null, longestRunDays: null, longBreaks: [] }, "2026-11");
  assert.match(unknown, /주말<\/dt><dd>8일/);
  assert.match(unknown, /공휴일<\/dt><dd>미확인/);
  assert.match(unknown, /공휴일 자료 일부·미확인/);
  assert.doesNotMatch(unknown, /공휴일<\/dt><dd>0일/);
  const ready = calendarHtml({ status: "ready", weekendDays: 8, holidayDays: 0, longestRunDays: 2, longBreaks: [] }, "2026-11");
  assert.match(ready, /공휴일<\/dt><dd>0일/);
  const html = renderCard({ regionKey: "sancheong", snapshot: fixture().snapshot });
  assert.match(html, /2026-10-03 ~ 2026-10-05/); assert.match(html, /개천절, 대체공휴일/);
});

test("untrusted labels, notes and holiday names cannot inject markup", () => {
  const data = fixture(); data.snapshot.notes = ["<script>alert(1)</script>"];
  data.snapshot.metrics[0].label = '<img src=x onerror="alert(1)">';
  data.snapshot.targets[0].calendar.longBreaks[0].names = ["<svg/onload=x>"];
  const html = renderCard({ regionLabel: "<img src=x>", snapshot: data.snapshot });
  assert.doesNotMatch(html, /<script|<img|<svg/); assert.match(html, /&lt;script&gt;/);
});

test("month summaries include search interest instead of duplicate visitor measures", () => {
  const snapshot = fixture().snapshot;
  const make = (groupKey, metricKey, label) => ({ ...snapshot.metrics[0], groupKey, metricKey, key: `${groupKey}:${metricKey}`, label });
  snapshot.metrics = [make("visitors", "visitorDays", "방문자 누계"), make("visitors", "averageDailyVisitors", "일평균 방문자"), make("demandStrength", "stayOverall", "체류 지수"), make("demandStrength", "spendOverall", "소비 지수"), make("searchTrend", "interest", "검색 관심도")];
  const html = renderCard({ regionKey: "sancheong", snapshot });
  const summaries = [...html.matchAll(/<dl class="ro-target-values">([\s\S]*?)<\/dl>/g)].map(match => match[1]);
  assert.equal(summaries.length, 2);
  for (const summary of summaries) {
    assert.deepEqual([...summary.matchAll(/<dt>([^<]+)<\/dt>/g)].map(match => match[1]), ["일평균 방문자", "체류 지수", "소비 지수", "검색 관심도"]);
    assert.doesNotMatch(summary, /방문자 누계/);
  }
});

test("engine missing-history and holiday reason codes have understandable Korean messages", () => {
  for (const [reasonCode, expected] of [["NO_OBSERVATIONS", "정상 관측 자료 없음"], ["RECENT_OBSERVATIONS_MISSING", "최근 연속 관측 자료 부족"]]) {
    const snapshot = fixture().snapshot; Object.assign(snapshot.metrics[0].forecasts[0], { status: "unavailable", value: null, reasonCode });
    assert.ok(renderCard({ regionKey: "sancheong", snapshot }).includes(expected));
  }
  for (const [reasonCode, expected] of [["HOLIDAY_HISTORY_INSUFFICIENT", "연휴 영향을 검증할 이력 부족"], ["HOLIDAY_CONTEXT_ONLY", "연휴 일정 참고"], ["HOLIDAY_EFFECT_NOT_VALIDATED", "연휴 영향의 검증 기준 미충족"], ["HOLIDAY_CALENDAR_UNAVAILABLE", "공휴일 자료 미확인"]]) {
    const snapshot = fixture().snapshot; snapshot.metrics[0].forecasts[0].holiday = { adjustmentApplied: false, reasonCode };
    assert.ok(renderCard({ regionKey: "sancheong", snapshot }).includes(expected));
  }
});

test("partial source refresh remains visible alongside a reused normal forecast", () => {
  const html = renderCard({ regionKey: "sancheong", snapshot: fixture().snapshot, job: { status: "completed", refreshDiagnostics: { status: "partial", steps: [{ key: "visitors", status: "failed", errorCode: "TIMEOUT" }, { key: "searchTrend", status: "complete" }], calendars: [{ year: 2027, status: "missing", errorCode: "NO_DATA" }, { year: 2026, status: "error" }] } } });
  assert.match(html, /일부 자료 갱신을 완료하지 못했습니다. 저장된 자료로 계산했습니다/);
  assert.match(html, /지역 방문자 · TIMEOUT/); assert.match(html, /공휴일 자료 · 2027년 · NO_DATA/); assert.match(html, /공휴일 자료 · 2026년 · SOURCE_REFRESH_INCOMPLETE/);
  assert.match(html, /45|1,200/); assert.doesNotMatch(html, /검색 트렌드 · SOURCE_REFRESH_INCOMPLETE/);
  const unsafe = renderCard({ regionKey: "sancheong", job: { refreshDiagnostics: { status: "partial", steps: [{ key: "visitors", status: "failed", errorCode: '<script>token=secret</script>' }] } } });
  assert.doesNotMatch(unsafe, /<script|token=secret/); assert.match(unsafe, /SOURCE_REFRESH_INCOMPLETE/);
});

test("mounts are read only and same account region month shares one GET", async () => {
  const calls = [], cache = createCache();
  const fetchJson = async (url, options) => { calls.push({ url, options }); await tick(); return fixture(); };
  const one = createController({ cache, fetchJson, now }), two = createController({ cache, fetchJson, now });
  await Promise.all([one.mount(host(), { regionKey: "sancheong", accountKey: "user" }), two.mount(host(), { regionKey: "sancheong", accountKey: "user" })]);
  assert.equal(calls.length, 1); assert.equal(calls[0].options, undefined); assert.match(calls[0].url, /^\/api\/regional-outlook\?.*months=13/);
  await one.mount(host(), { regionKey: "sancheong", accountKey: "user" }); assert.equal(calls.length, 1);
  await one.mount(host(), { regionKey: "sancheong", accountKey: "other" }); assert.equal(calls.length, 2);
});

test("late earlier region cannot overwrite current regional outlook", async () => {
  let resolveOld;
  const fetchJson = async url => url.includes("old") ? new Promise(resolve => { resolveOld = resolve; }) : fixture("new");
  const controller = createController({ cache: createCache(), fetchJson, now }), element = host();
  const old = controller.mount(element, { regionKey: "old", regionLabel: "이전 지역" }); await tick();
  await controller.mount(element, { regionKey: "new", regionLabel: "새 지역" }); resolveOld(fixture("old")); await old;
  assert.equal(controller.state.snapshot.scope.regionKey, "new"); assert.match(element.innerHTML, /새 지역/); assert.doesNotMatch(element.innerHTML, /이전 지역/);
});

test("Korea month rollover clears last month's values instead of reusing a previous target", async () => {
  let clock = Date.parse("2026-10-31T14:59:59Z"), gets = 0;
  assert.equal(currentMonth(clock), "2026-10"); assert.equal(currentMonth(clock + 1000), "2026-11");
  const controller = createController({ cache: createCache(), now: () => clock, fetchJson: async () => { gets++; return gets === 1 ? fixture() : { status: "missing", scope: { regionKey: "sancheong", month: "2026-11" }, snapshot: null, job: null }; } }), element = host();
  await controller.mount(element, { regionKey: "sancheong" }); assert.ok(controller.state.snapshot);
  clock += 1000; await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(gets, 2); assert.equal(controller.state.snapshot, null); assert.match(element.innerHTML, /저장된 전망이 없습니다/);
});

test("foreign or failed GET keeps last saved result with visible warning", async () => {
  let mode = "normal";
  const controller = createController({ cache: createCache(), now, fetchJson: async () => { if (mode === "failed") throw new Error("응답 지연"); return fixture(mode === "foreign" ? "foreign" : "sancheong"); } }), element = host();
  await controller.mount(element, { regionKey: "sancheong" });
  mode = "foreign"; assert.equal(await controller.refresh(true), false); assert.equal(controller.state.snapshot.resultId, "sancheong-one"); assert.match(element.innerHTML, /선택 지역과 다른 전망 자료/);
  mode = "failed"; assert.equal(await controller.refresh(true), false); assert.match(element.innerHTML, /마지막 정상 저장 결과/);
});

test("explicit outlook calculation is cache-only and unknown submission requires status check", async () => {
  let posts = 0, fail = true; const calls = [];
  const controller = createController({ cache: createCache(), now, ...timers(), fetchJson: async (url, options) => { calls.push({ url, options }); if (options) { posts++; if (fail) throw new Error("연결 단절"); return { job: { regionKey: "sancheong", status: "queued" } }; } return fixture(); } }), element = host();
  await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(await controller.start(), false); assert.equal(await controller.start(), false); assert.equal(posts, 1);
  assert.match(element.innerHTML, /상태 확인으로 실행 여부를 확인/);
  assert.match(element.innerHTML, /data-ro-action="build" disabled/);
  await controller.refresh(true); fail = false; assert.equal(await controller.start(), true);
  assert.deepEqual(JSON.parse(calls.find(call => call.options).options.body), { regionKey: "sancheong", months: 13, collectMissing: false });
  assert.equal(await controller.start(), false); controller.stop();
});

test("external preparation is requested only by its explicit action, never by a read", async () => {
  const posts = [], clock = timers();
  const controller = createController({ cache: createCache(), now, ...clock, fetchJson: async (_url, options) => { if (options) { posts.push(JSON.parse(options.body)); return { job: { status: "queued", scope: { regionKey: "sancheong" } } }; } return fixture(); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" }); assert.equal(posts.length, 0);
  assert.match(element.innerHTML, /data-ro-action="refresh"/);
  assert.equal(await controller.start(true), true); assert.deepEqual(posts, [{ regionKey: "sancheong", months: 13, collectMissing: true }]);
  controller.stop();
});

test("a short validation history is named even when an estimated value is available", () => {
  const snapshot = fixture().snapshot;
  snapshot.metrics[0].forecasts[0].validation = { status: "insufficient_validation", folds: 1, mae: 12, wapePct: null };
  snapshot.metrics[0].forecasts[0].method = "seasonal_naive";
  const html = renderCard({ regionKey: "sancheong", snapshot });
  assert.match(html, /과거 1회 검증 · 평균 오차 12명 · 검증 이력 부족/);
  assert.match(html, /산출 방법 · 전년 같은 달 기준/);
});

test("the actual forecast engine contract displays official holiday context and model output", () => {
  const { buildRegionalOutlook } = require("./lib/regional_outlook.cjs");
  const history = Array.from({ length: 13 }, (_, index) => ({ period: new Date(Date.UTC(2025, 7 + index, 1)).toISOString().slice(0, 7), value: 100 + index, status: "observed" }));
  const result = buildRegionalOutlook({ asOfDate: "2026-10-16", snapshot: { scope: { regionKey: "sancheong" }, groups: [{ key: "visitors", label: "지역 방문자", category: "tourism", periodType: "M", provider: "한국관광공사", metrics: [{ key: "average", label: "일평균 방문자", unit: "명", rows: history }] }] }, calendar: { months: [{ period: "2026-10", status: "ready", coverageComplete: true, daysInMonth: 31, holidayDays: 3, weekendDays: 9, holidayOrWeekendDays: 10, longBreakDays: 6, longestRunDays: 3, longBreaks: [{ start: "2026-10-03", end: "2026-10-05", days: 3, overlapDays: 3, names: ["개천절"], boundaryComplete: true }] }, { period: "2026-11", status: "missing", daysInMonth: 30, weekendDays: 9 }] } });
  const html = renderCard({ regionKey: "sancheong", regionLabel: "산청군", snapshot: result });
  assert.match(html, /최장 연속 휴일<\/dt><dd>3일/); assert.match(html, /개천절/);
  assert.match(html, /연휴 영향을 검증할 이력 부족/);
  assert.match(html, /전년 같은 달 기준|최근 관측 수준/);
  assert.match(html, /최근 확정 2026-08 · 13개월 확보/);
});

test("only active calculation polls and stop clears timers", async () => {
  const clock = timers(); let gets = 0, shown = true;
  const controller = createController({ cache: createCache(), now, ...clock, isVisible: () => shown, fetchJson: async () => { gets++; return fixture("sancheong", { job: { status: "running", scope: { regionKey: "sancheong" } } }); } });
  await controller.mount(host(), { regionKey: "sancheong" }); assert.equal(clock.pending.size, 1);
  shown = false; const task = [...clock.pending.values()][0]; clock.pending.clear(); task(); await tick(); assert.equal(gets, 1); assert.equal(clock.pending.size, 0);
  shown = true; await controller.refresh(true); assert.equal(clock.pending.size, 1); controller.stop(); assert.equal(clock.pending.size, 0); assert.equal(await controller.refresh(true), false);
});

test("logout invalidation prevents late old account response repopulation", async () => {
  let finish; const cache = createCache(), pending = cache.get("old", () => new Promise(resolve => { finish = resolve; }));
  await tick(); cache.clear(); finish(fixture()); await pending; assert.equal(cache.read("old"), null);
});
