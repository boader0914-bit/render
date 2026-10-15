"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createController, createCache, renderCard, calendarHtml, evaluationHtml, number, currentMonth } = require("../web/regional-outlook.js");
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
  assert.match(html, /과거 자료 모의검증 5회 · 평균 오차 10/);
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
  assert.match(html, /과거 자료 모의검증 1회 · 평균 오차 12명 · 검증 이력 부족/);
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

function evaluationFixture(key = "sancheong", extra = {}) {
  const first = { regionKey: key, issueMonth: "2026-09", targetPeriod: "2026-09", kind: "current", groupKey: "visitors", metricKey: "averageDailyVisitors", label: "일평균 방문자", unit: "명", provider: "한국관광공사", modelVersion: "model-v1", status: "compared", reasonCode: "", forecastValue: 100, actualValue: 120, difference: 20, absoluteError: 20, errorPct: 16.67, predictionRef: { resultId: "september-first", publishedAt: "2026-09-01T00:00:00Z", generatedAt: "2026-09-01T00:00:00Z", proof: "journal", coverage: "recorded" }, actualRef: { receivedAt: "2026-10-10T00:00:00Z", revised: false } };
  return { scope: { regionKey: key, month: "2026-10", months: 13 }, status: "partial", snapshot: { scope: { regionKey: key, month: "2026-10" }, resultId: "evaluation-one", generatedAt: "2026-10-16T00:00:00Z", evaluatedThrough: "2026-10-16T00:00:00Z", availableIssueMonths: ["2026-10", "2026-09"], summaryCounts: { total: 4, compared: 2, pending: 1, excluded: 1 }, rows: [
    first,
    { ...first, kind: "next", targetPeriod: "2026-10", status: "pending", reasonCode: "TARGET_MONTH_OPEN", forecastValue: 105, actualValue: null, difference: null, absoluteError: null, errorPct: null },
    { ...first, issueMonth: "2026-10", targetPeriod: "2026-10", status: "pending", reasonCode: "TARGET_MONTH_OPEN", forecastValue: 150, actualValue: null, difference: null, absoluteError: null, errorPct: null },
    { ...first, issueMonth: "2026-10", targetPeriod: "2026-11", kind: "next", groupKey: "searchTrend", metricKey: "interest", label: "검색 관심도", unit: "상대지수", status: "excluded", reasonCode: "SEARCH_NORMALIZATION_NOT_COMPARABLE", forecastValue: 99, actualValue: 12, difference: -87, absoluteError: 87, errorPct: 725 }
  ], scores: [{ groupKey: "visitors", metricKey: "averageDailyVisitors", label: "일평균 방문자", unit: "명", provider: "한국관광공사", kind: "current", modelVersion: "model-v1", sampleCount: 1, mae: 20, wapePct: 16.67 }] }, job: null, storage: {}, ...extra };
}

test("saved publication evaluation is distinct from model backtesting, folded by default and filtered by issue month", () => {
  const data = fixture("sancheong", { validation: evaluationFixture() });
  const state = { regionKey: "sancheong", snapshot: data.snapshot, validation: data.validation };
  let html = renderCard(state), panel = evaluationHtml(state);
  assert.ok(html.indexOf('class="ro-targets"') < html.indexOf('class="ro-evaluation"'));
  assert.ok(html.indexOf('class="ro-evaluation"') < html.indexOf('class="ro-groups"'));
  assert.match(panel, /^<details class="ro-evaluation" data-ro-detail="validation">/);
  assert.match(panel, /2026-10 발행 · 비교 완료 0 · 대기 1 · 제외 1/);
  assert.match(panel, /보존된 발행본 중 첫 전망/);
  assert.match(panel, /과거 자료 모의검증과 별도/);
  assert.doesNotMatch(panel, /정확도|종합 점수|정정 없음|정정없음/);
  panel = evaluationHtml({ ...state, validationIssueMonth: "2026-09" });
  assert.match(panel, /2026-09 발행 · 비교 완료 1 · 대기 1 · 제외 0/);
  assert.match(panel, /후속 공식값<\/dt><dd>120<small>명/);
  assert.match(panel, /차이 · 실제−전망<\/dt><dd>\+20/);
  assert.match(panel, /절대오차율<\/dt><dd>16\.67/);
  assert.match(panel, /2026-09 · 당시 이번 달 예상/);
  assert.match(panel, /2026-10 · 당시 다음 달 전망/);
  assert.match(panel, /지표별 누적 오차 · 전체 보존 발행월/);
  assert.match(panel, /1건 표본/);
});

test("actual zero is a real observation while pending or incomparable rows never display numeric errors", () => {
  const validation = evaluationFixture();
  Object.assign(validation.snapshot.rows[0], { actualValue: 0, forecastValue: 10, difference: -10, absoluteError: 10, errorPct: null, percentageReasonCode: "ZERO_ACTUAL_DENOMINATOR" });
  let panel = evaluationHtml({ regionKey: "sancheong", validation, validationIssueMonth: "2026-09" });
  assert.match(panel, /후속 공식값<\/dt><dd>0<small>명/);
  assert.match(panel, /차이 · 실제−전망<\/dt><dd>-10/);
  assert.match(panel, /산출 안 함 · 실제값 0/);
  panel = evaluationHtml({ regionKey: "sancheong", validation, validationIssueMonth: "2026-10" });
  assert.match(panel, /대상월이 아직 끝나지 않았습니다/);
  assert.match(panel, /정규화 기준이 달라 검색지수를 비교할 수 없습니다/);
  assert.doesNotMatch(panel, /차이 · 실제−전망|<dt>절대오차|725|<dd>12<|<dd>99</);
  assert.match(panel, /후속 공식값<\/dt><dd>미확인/);
});

test("no saved evaluation and failed cache calculation keep truthful wait or retained-result messages", () => {
  const empty = evaluationHtml({ regionKey: "sancheong", validation: { scope: { regionKey: "sancheong" }, snapshot: null } });
  assert.match(empty, /공식 실측 발표 후 검증합니다/);
  assert.match(empty, /data-ro-action="validate">저장자료로 검증/);
  assert.doesNotMatch(empty, /0%|100%|정확도/);
  const validation = evaluationFixture(); validation.job = { status: "failed" }; validation.storage.errorCode = "REGIONAL_STORE_UNAVAILABLE";
  const failed = evaluationHtml({ regionKey: "sancheong", validation });
  assert.match(failed, /최근 검증 계산을 완료하지 못했습니다/);
  assert.match(failed, /마지막 정상 검증 결과/);
  assert.match(failed, /evaluation-one/);
});

test("issue-month selection and disclosures are local reads and survive ordinary status rerenders", async () => {
  let gets = 0;
  const controller = createController({ cache: createCache(), now, fetchJson: async (_url, options) => { assert.equal(options, undefined); gets++; return fixture("sancheong", { validation: evaluationFixture() }); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong", accountKey: "one" });
  assert.equal(controller.selectIssueMonth("2026-09"), true);
  assert.equal(controller.selectIssueMonth("2025-01"), false);
  element.listeners.get("toggle")({ target: { dataset: { roDetail: "validation" }, open: true } });
  await controller.refresh(true);
  assert.equal(gets, 2);
  assert.equal(controller.state.validationIssueMonth, "2026-09");
  assert.match(element.innerHTML, /data-ro-detail="validation" open/);
  assert.match(element.innerHTML, /2026-09 발행 · 비교 완료 1/);
});

test("explicit evaluation requests only a cache-only verification and prevents duplicate or competing submissions", async () => {
  const calls = [], clock = timers(); let finish;
  const controller = createController({ cache: createCache(), now, ...clock, fetchJson: async (url, options) => { calls.push({ url, options }); return options ? new Promise(resolve => { finish = resolve; }) : fixture("sancheong", { validation: evaluationFixture() }); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  const pending = controller.startValidation();
  assert.equal(await controller.startValidation(), false); assert.equal(await controller.start(true), false);
  assert.match(element.innerHTML, /data-ro-action="validate" disabled/);
  finish(evaluationFixture("sancheong", { job: { status: "queued", scope: { regionKey: "sancheong", month: "2026-10" } } }));
  assert.equal(await pending, true);
  const post = calls.find(call => call.options);
  assert.equal(post.url, "/api/regional-outlook/validation/refresh");
  assert.deepEqual(JSON.parse(post.options.body), { regionKey: "sancheong", months: 13, month: "2026-10" });
  assert.equal(calls.filter(call => call.options).length, 1);
  assert.equal(clock.pending.size, 1);
  controller.stop(); assert.equal(clock.pending.size, 0);
});

test("lost evaluation submission response keeps the last comparison and requires a GET before another POST", async () => {
  let posts = 0;
  const controller = createController({ cache: createCache(), now, fetchJson: async (_url, options) => { if (options) { posts++; throw new Error("응답 단절"); } return fixture("sancheong", { validation: evaluationFixture() }); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  assert.equal(await controller.startValidation(), false);
  assert.equal(controller.state.validation.snapshot.resultId, "evaluation-one");
  assert.equal(await controller.startValidation(), false); assert.equal(await controller.start(false), false);
  assert.equal(posts, 1);
  assert.match(element.innerHTML, /상태 확인으로 실행 여부를 확인/);
  assert.match(element.innerHTML, /data-ro-action="build" disabled/);
  await controller.refresh(true); assert.equal(controller.state.validationNeedsStatusCheck, false);
});

test("validation active work and publication receipt pending both poll saved status without external requests", async () => {
  for (const mode of ["job", "publication"]) {
    const clock = timers(); let gets = 0;
    const validation = evaluationFixture("sancheong", mode === "job" ? { job: { status: "running", scope: { regionKey: "sancheong", month: "2026-10" } } } : { publicationPending: true });
    const controller = createController({ cache: createCache(), now, ...clock, fetchJson: async (_url, options) => { assert.equal(options, undefined); gets++; return fixture("sancheong", { validation: gets === 1 ? validation : evaluationFixture() }); } });
    const element = host(); await controller.mount(element, { regionKey: "sancheong" });
    assert.equal(clock.pending.size, 1);
    assert.match(element.innerHTML, /저장자료 검증 중/);
    assert.equal(await controller.startValidation(), false);
    const poll = [...clock.pending.values()][0]; clock.pending.clear(); poll(); await tick();
    assert.equal(gets, 2); assert.equal(clock.pending.size, 0);
  }
});

test("foreign verification scope is rejected atomically without overwriting saved outlook or validation", async () => {
  let foreign = false;
  const controller = createController({ cache: createCache(), now, fetchJson: async () => fixture("sancheong", { validation: evaluationFixture(foreign ? "other" : "sancheong") }) });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  foreign = true;
  assert.equal(await controller.refresh(true), false);
  assert.equal(controller.state.snapshot.resultId, "sancheong-one");
  assert.equal(controller.state.validation.scope.regionKey, "sancheong");
  assert.match(element.innerHTML, /선택 지역과 다른 전망 검증 자료/);
});

test("a late old account or region validation submission cannot repopulate the new view", async () => {
  let finish;
  const controller = createController({ cache: createCache(), now, fetchJson: async (url, options) => options ? new Promise(resolve => { finish = resolve; }) : fixture(url.includes("other") ? "other" : "sancheong", { validation: evaluationFixture(url.includes("other") ? "other" : "sancheong") }) });
  const element = host(); await controller.mount(element, { regionKey: "sancheong", accountKey: "old" });
  const pending = controller.startValidation();
  await controller.mount(element, { regionKey: "other", accountKey: "new" });
  finish(evaluationFixture("sancheong", { job: { status: "queued", scope: { regionKey: "sancheong", month: "2026-10" } } }));
  assert.equal(await pending, false);
  assert.equal(controller.state.validation.scope.regionKey, "other");
  assert.equal(controller.state.validationStarting, false);
  assert.equal(controller.state.validationOpen, false);
});

test("verification rejects a foreign evaluation month and Korea month rollover requires the new scope", async () => {
  let clock = Date.parse("2026-10-31T14:59:59Z"), posts = 0, wrongMonth = false;
  const controller = createController({ cache: createCache(), now: () => clock, fetchJson: async (_url, options) => { if (options) posts++; const validation = evaluationFixture(); if (wrongMonth) validation.scope.month = "2026-09"; return fixture("sancheong", { validation }); } });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  wrongMonth = true; assert.equal(await controller.refresh(true), false);
  assert.equal(controller.state.validation.scope.month, "2026-10");
  assert.match(element.innerHTML, /선택 기준월과 다른 전망 검증 자료/);
  clock += 1000; assert.equal(await controller.startValidation(), false); assert.equal(posts, 0);
  assert.match(element.innerHTML, /기준월이 바뀌었습니다/);
});

test("evaluation labels and provenance are escaped; unknown values do not render executable or precise-looking errors", () => {
  const validation = evaluationFixture();
  Object.assign(validation.snapshot.rows[0], { label: '<img onerror="bad">', provider: "<script>bad</script>", modelVersion: '<svg onload="bad">' });
  validation.snapshot.rows[0].predictionRef.resultId = '<img src="bad">';
  const panel = evaluationHtml({ regionKey: "sancheong", validation, validationIssueMonth: "2026-09" });
  assert.doesNotMatch(panel, /<script|<img|<svg/);
  assert.match(panel, /&lt;img/);
});

test("the actual evaluation engine output renders publication evidence and an official zero without generalizing one sample", () => {
  const { buildRegionalOutlookEvaluation } = require("./lib/regional_outlook_evaluation.cjs");
  const prediction = { resultId: "issued-september", generatedAt: "2026-09-10T00:00:00Z", asOfDate: "2026-09-10", asOfMonth: "2026-09", modelVersion: "model-v1", scope: { regionKey: "sancheong", month: "2026-09" }, sourceScope: { regionKey: "sancheong", month: "2026-08" }, publication: { status: "published", publishedAt: "2026-09-10T00:00:00Z", proof: "journal", coverage: "recorded" }, metrics: [{ key: "visitors:averageDailyVisitors", groupKey: "visitors", metricKey: "averageDailyVisitors", unit: "명", provider: "한국관광공사", latestPeriod: "2026-08", forecasts: [{ period: "2026-09", kind: "current", status: "forecast", value: 10 }, { period: "2026-10", kind: "next", status: "forecast", value: 20 }] }] };
  const observed = { builtAt: "2026-10-10T00:00:00Z", scope: { regionKey: "sancheong", month: "2026-09" }, groups: [{ key: "visitors", periodType: "M", provider: "한국관광공사", metrics: [{ key: "averageDailyVisitors", unit: "명", rows: [{ period: "2026-09", value: 0, status: "observed", retrievedAt: "2026-10-10T00:00:00Z" }] }] }] };
  const snapshot = buildRegionalOutlookEvaluation({ forecastSnapshots: [prediction], observationSnapshots: [observed], asOfAt: "2026-10-16T00:00:00Z" });
  const panel = evaluationHtml({ regionKey: "sancheong", validation: { snapshot } });
  assert.match(panel, /2026-09 발행 · 비교 완료 1 · 대기 1 · 제외 0/);
  assert.match(panel, /후속 공식값<\/dt><dd>0<small>명/);
  assert.match(panel, /산출 안 함 · 실제값 0/);
  assert.match(panel, /1건 표본/);
  assert.match(panel, /평균 절대오차 10명 · 가중 절대오차율 산출 안 함/);
  assert.match(panel, /issued-september/);
  assert.doesNotMatch(panel, /정확도|정정 없음|정정없음/);
});

test("opening evaluation during an initial GET survives the response and month selection before native toggle arrives", async () => {
  let finish;
  const controller = createController({ cache: createCache(), now, fetchJson: () => new Promise(resolve => { finish = resolve; }) });
  const element = host(), mounting = controller.mount(element, { regionKey: "sancheong" });
  await tick();
  const oldDetails = { dataset: { roDetail: "validation" }, open: false, isConnected: true };
  const summary = { parentElement: oldDetails };
  element.listeners.get("click")({ target: { closest: selector => selector === "summary" ? summary : null } });
  assert.equal(controller.state.validationOpen, true, "click intent is retained before the asynchronous native toggle");
  finish(fixture("sancheong", { validation: evaluationFixture() })); await mounting;
  assert.match(element.innerHTML, /data-ro-detail="validation" open/);
  // The initial element was replaced by the response render. A delayed event
  // from that old closed element must not undo the new visible state.
  oldDetails.isConnected = false;
  element.listeners.get("toggle")({ target: oldDetails });
  element.listeners.get("change")({ target: { dataset: { roField: "issueMonth" }, value: "2026-09" } });
  assert.equal(controller.state.validationIssueMonth, "2026-09");
  assert.match(element.innerHTML, /data-ro-detail="validation" open/);
  assert.match(element.innerHTML, /2026-09 발행 · 비교 완료 1/);
});

test("score disclosure keeps immediate open and close intent across rerenders without preventing native toggling", async () => {
  const controller = createController({ cache: createCache(), now, fetchJson: async () => fixture("sancheong", { validation: evaluationFixture() }) });
  const element = host(); await controller.mount(element, { regionKey: "sancheong" });
  const click = (open, defaultPrevented = false) => element.listeners.get("click")({ defaultPrevented, target: { closest: selector => selector === "summary" ? { parentElement: { dataset: { roDetail: "scores" }, open, isConnected: true } } : null } });
  click(false); await controller.refresh(true);
  assert.equal(controller.state.validationScoresOpen, true);
  assert.match(element.innerHTML, /data-ro-detail="scores" open/);
  click(true); controller.selectIssueMonth("2026-09");
  assert.equal(controller.state.validationScoresOpen, false);
  assert.doesNotMatch(element.innerHTML, /data-ro-detail="scores" open/);
  click(false, true); controller.render();
  assert.equal(controller.state.validationScoresOpen, false, "a prevented native action must not change disclosure intent");
  element.listeners.get("toggle")({ target: { dataset: { roDetail: "scores" }, open: true, isConnected: true } });
  assert.equal(controller.state.validationScoresOpen, true, "native state remains the follow-up authority");
});
