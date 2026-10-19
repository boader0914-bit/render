"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ui = require("../web/company-integrated.js");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");

function envelope() {
  const companyId = "company-integrated-ui-fixture";
  const runs = [
    { id: "early", keyword: "경남글램핑", collectedAt: "2026-08-31T08:00:00Z", collectionQuality: { status: "complete" } },
    { id: "latest", keyword: "산청글램핑", collectedAt: "2026-09-01T06:00:00Z", collectionQuality: { status: "complete" } },
    { id: "failed", keyword: "산청글램핑", collectedAt: "2026-09-01T07:00:00Z", collectionQuality: { status: "failed" } },
    { id: "legacy", keyword: "경남글램핑", collectedAt: "2026-09-01T05:00:00Z", collectionQuality: { status: "unknown" } }
  ];
  const row = (runId, date, publicBookings, phoneBookings, extra = {}) => ({
    companyKey: companyId, companyName: "[모의] 숲 숙소", runId, keyword: runs.find(run => run.id === runId).keyword,
    collectedAt: runs.find(run => run.id === runId).collectedAt, stayDate: date, productType: "lodging", inventoryEvidenceVersion: 4,
    supply: 16, sold: publicBookings + phoneBookings, publicBookings, phoneBookings,
    publicRevenue: publicBookings * 200000, phoneRevenue: phoneBookings * 200000,
    estimatedRevenue: (publicBookings + phoneBookings) * 200000, phonePricedBookings: phoneBookings,
    phoneMissingPriceBookings: 0, phoneFallbackRevenue: 0, phoneFallbackBookings: 0, sharedDayUseExcluded: 0,
    partial: false, missing: false, unknownUnavailable: 0, ...extra
  });
  const snapshot = buildMonthlyReportSnapshot({ type: "company", targetId: companyId, month: "2026-09", cutoffDate: "2026-09-30" }, {
    companies: [{ companyId, primaryName: "[모의] 숲 숙소", capacity: 16, capacitySource: "manual" }], runs,
    observations: [row("early", "2026-09-01", 3, 1), row("latest", "2026-09-01", 4, 1),
      row("failed", "2026-09-01", 0, 0), row("latest", "2026-09-02", 0, 0),
      row("latest", "2026-09-03", 0, 0, { missing: true }), row("legacy", "2026-09-04", 16, 0)]
  }, "2026-10-01T00:00:00Z");
  return { companyId, status: "ready", selectedMonth: "2026-09", calculatedAt: "2026-10-01T00:00:00Z", calculationVersion: "fixture-1",
    months: [{ month: "2026-09" }, { month: "2026-08" }], roomBasis: { capacity: 16, source: "manual", label: "관리자 검수값", warnings: [] },
    snapshot, failedAttempts: [{ date: "2026-09-01", runId: "failed", collectedAt: runs[2].collectedAt, status: "failed", reason: "run_failed" }],
    keywords: [{ keyword: "경남글램핑", runs: [{ runId: "early", collectedAt: runs[0].collectedAt, rank: 4, status: "complete" }] },
      { keyword: "산청글램핑", runs: [{ runId: "latest", collectedAt: runs[1].collectedAt, rank: 1, status: "complete" }] }] };
}
const view = (model, tab = "settlement", extras = {}) => ui.render(model, { tab, view: "calendar", selectedDate: "", error: "", loading: false, ...extras });
function container() {
  const listeners = new Map();
  return { innerHTML: "", isConnected: true, listeners, focused: "", hidden: false,
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    querySelector(selector) { return { focus: () => { this.focused = selector; } }; }, closest() { return this.hidden ? {} : null; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function animationFrames() {
  let id = 0;
  const callbacks = new Map();
  return {
    requestAnimationFrame(fn) { callbacks.set(++id, fn); return id; },
    cancelAnimationFrame(key) { callbacks.delete(key); },
    frame() { const batch = [...callbacks.values()]; callbacks.clear(); for (const fn of batch) fn(); },
    get size() { return callbacks.size; }
  };
}

test("actual monthly calculation retains fixed capacity and valid latest values across keywords and later failure", () => {
  const payload = envelope(), before = JSON.stringify(payload), model = ui.buildViewModel(payload);
  assert.equal(model.capacity, 16);
  assert.equal(model.rows.length, 30);
  assert.equal(model.rows[0].sold, 5);
  assert.equal(model.rows[0].estimatedRevenue, 1000000);
  assert.equal(model.rows[0].source.runId, "latest");
  assert.equal(model.summary.sold, 5, "earlier snapshots and failed zero are never summed by the UI");
  assert.equal(model.rows[0].lag, 0);
  assert.equal(model.rows[1].lag, 1);
  assert.equal(model.rows[1].observed, true);
  assert.equal(model.rows[1].sold, 0, "genuine zero stays a valid observation");
  assert.equal(model.rows[2].observed, false);
  assert.equal(model.rows[2].sold, null, "missing observation never becomes zero");
  assert.equal(model.rows[3].observed, false, "unknown legacy quality remains excluded");
  assert.equal(JSON.stringify(payload), before, "view model cannot mutate monthly report or original observations");
});

test("calendar and graph expose one purple day, distinguish real zero, and show source and gap information", () => {
  const model = ui.buildViewModel(envelope()), markup = view(model);
  assert.equal((markup.match(/ci-day-other/g) || []).length, 1);
  assert.equal((markup.match(/class="ci-other-bar"/g) || []).length, 1);
  assert.equal((markup.match(/class="ci-zero-dot"/g) || []).length, 1);
  assert.equal((markup.match(/class="ci-gap-bar"/g) || []).length, 28);
  assert.match(markup, /1일 전 관측/);
  assert.match(markup, /100만원/);
  assert.match(view(model, "settlement", { selectedDate: "2026-09-01" }), /data-archive-run-id="latest"/);
  assert.match(view(model, "settlement", { selectedDate: "2026-09-04" }), /과거 수집의 정상 응답 여부 미확인/);
  assert.match(view(model, "review"), /최근 수집 실패·제한/);
  assert.match(view(model, "history"), /경남글램핑[^]*산청글램핑/);
  assert.match(view(model, "history"), /data-archive-run-id="early"/);
  assert.match(markup, /data-monthly-report-month="2026-09"/);
});

test("empty data cannot display synthetic revenue or timing averages, and source text is escaped", () => {
  const model = ui.buildViewModel({ companyId: "a", selectedMonth: "2024-02", status: "ready", snapshot: { summary: { lodging: {} }, daily: [], insights: {} },
    keywords: [{ keyword: '<img src=x onerror="alert(1)">', runs: [{ id: 'bad" onclick="alert(1)', rank: 2 }] }] });
  assert.equal(model.rows.length, 29);
  assert.equal(model.capacity, null);
  assert.ok(model.rows.every(row => row.sold === null));
  assert.match(view(model, "analysis"), /산출할 비교 자료 없음/);
  assert.doesNotMatch(view(model, "analysis"), /숙박 0~0일 전/);
  const history = view(model, "history");
  assert.doesNotMatch(history, /<img/);
  assert.match(history, /&lt;img/);
  assert.doesNotMatch(history, / onclick="alert/);
});

test("pending/ready states never poll; refreshing polls once and stops on ready", async () => {
  for (const status of ["pending", "ready", "failed"]) {
    const c = container(), timers = [];
    const controller = ui.createController(c, { fetchData: async () => ({ ...envelope(), status }), setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} });
    await controller.open({ companyId: envelope().companyId }); assert.equal(timers.length, 0); controller.dispose();
  }
  const c = container(), timers = [], calls = []; let answer = { ...envelope(), status: "refreshing" };
  const controller = ui.createController(c, { fetchData: async (...args) => { calls.push(args); return answer; }, setTimeout(fn, ms) { assert.equal(ms, 3000); timers.push(fn); return timers.length; }, clearTimeout() {} });
  await controller.open({ companyId: answer.companyId });
  assert.equal(timers.length, 1); assert.match(c.innerHTML, /통합 중/);
  answer = envelope(); timers[0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2); assert.equal(timers.length, 1); assert.match(c.innerHTML, /갱신 완료/);
  controller.dispose(); assert.equal(c.listeners.size, 0);
});

test("a slower previous month cannot replace the newer selection; dispose aborts and ignores late responses", async () => {
  const c = container(), calls = [], cancelled = [];
  const controller = ui.createController(c, { fetchData: (id, month, signal) => { const d = deferred(); calls.push({ id, month, signal, ...d }); return d.promise; }, clearTimeout(id) { cancelled.push(id); } });
  const a = controller.open({ companyId: "race-company", month: "2026-09" });
  const b = controller.load("2026-08");
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve({ ...envelope(), companyId: "race-company", selectedMonth: "2026-08" }); await b;
  calls[0].resolve({ ...envelope(), companyId: "race-company", selectedMonth: "2026-09" }); await a;
  assert.equal(controller.state.month, "2026-08");
  const pending = controller.load("2026-07"), htmlBefore = c.innerHTML;
  controller.dispose(); assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve({ ...envelope(), companyId: "race-company", selectedMonth: "2026-07" }); await pending;
  assert.equal(c.innerHTML, htmlBefore); assert.equal(c.listeners.size, 0);
});

test("tab switching is local and keyboard access does not issue additional API calls", async () => {
  const c = container(), payload = envelope(); let calls = 0;
  const controller = ui.createController(c, { fetchData: async () => { calls += 1; return payload; } });
  await controller.open({ companyId: payload.companyId });
  controller.selectTab("history"); assert.equal(calls, 1); assert.equal(controller.state.tab, "history");
  let prevented = false;
  c.listeners.get("keydown")({ target: { matches: () => true }, key: "ArrowRight", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(controller.state.tab, "review"); assert.equal(calls, 1);
  assert.equal(c.focused, '[data-ci-tab="review"]'); controller.dispose();
});

test("changed company and mismatched response never show another company's totals", async () => {
  const c = container(); let response = envelope();
  const controller = ui.createController(c, { fetchData: async () => response });
  await controller.open({ companyId: response.companyId });
  response = { ...envelope(), companyId: "wrong-company" };
  await controller.open({ companyId: "new-company" });
  assert.equal(controller.state.envelope.snapshot, undefined);
  assert.match(controller.state.error, /업체가 일치하지/);
  assert.doesNotMatch(c.innerHTML, /100만원/); controller.dispose();
});

test("authentication failure preserves previously loaded values without converting them to zero", async () => {
  const c = container(); let fail = false;
  const controller = ui.createController(c, { fetchData: async () => { if (fail) throw new Error("관리자 로그인이 필요합니다."); return envelope(); } });
  await controller.open({ companyId: envelope().companyId }); fail = true; await controller.load();
  assert.match(c.innerHTML, /관리자 로그인이 필요/); assert.match(c.innerHTML, /기존 저장 자료/);
  assert.equal(ui.buildViewModel(controller.state.envelope).summary.sold, 5); controller.dispose();
});

test("same-context open coalesces an in-flight and completed response while explicit load still refreshes", async () => {
  const c = container(), first = deferred(), calls = [], frames = animationFrames();
  const controller = ui.createController(c, { ...frames, fetchData(id, month, signal) { calls.push({ id, month, signal }); return calls.length === 1 ? first.promise : Promise.resolve(envelope()); } });
  const context = { companyId: envelope().companyId };
  const a = controller.open(context), b = controller.open(context);
  assert.equal(a, b); assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  first.resolve(envelope()); await a;
  const html = c.innerHTML, displayed = controller.whenDisplayed();
  frames.frame(); frames.frame(); assert.equal((await displayed).status, "displayed");
  await controller.open(context);
  assert.equal(calls.length, 1, "the canonical selected month must not cause a second default-month request");
  assert.equal(c.innerHTML, html, "a completed coalesced response must not replace its DOM");
  assert.equal(controller.whenDisplayed(), displayed);
  await controller.load(); assert.equal(calls.length, 2, "manual refresh remains a fresh request"); controller.dispose();
});

test("display completion waits for the final data DOM and two animation frames", async () => {
  const c = container(), answer = deferred(), frames = animationFrames();
  const controller = ui.createController(c, { ...frames, fetchData: () => answer.promise });
  const opening = controller.open({ companyId: envelope().companyId, month: "2026-09" });
  let settled = false; const displayed = controller.whenDisplayed().then(value => { settled = true; return value; });
  assert.equal(frames.size, 0, "the loading placeholder is not the completed data card");
  frames.frame(); await Promise.resolve(); assert.equal(settled, false);
  answer.resolve(envelope()); await opening;
  assert.match(c.innerHTML, /100만원/); assert.equal(settled, false);
  frames.frame(); await Promise.resolve(); assert.equal(settled, false);
  frames.frame();
  assert.deepEqual(await displayed, { status: "displayed", companyId: envelope().companyId, month: "2026-09", loadStatus: "ready" });
  controller.dispose();
});

test("pending, refreshing, failed and request errors all finish display without pretending the data is ready", async () => {
  for (const status of ["pending", "refreshing", "updating", "failed", "error"]) {
    const c = container(), frames = animationFrames();
    const controller = ui.createController(c, { ...frames, setTimeout() { return 1; }, clearTimeout() {}, fetchData: async () => { if (status === "error") throw new Error("관리자 로그인이 필요합니다."); return { ...envelope(), status }; } });
    await controller.open({ companyId: envelope().companyId });
    const displayed = controller.whenDisplayed(); frames.frame(); frames.frame();
    const result = await displayed;
    assert.equal(result.status, "displayed"); assert.equal(result.loadStatus, status === "updating" ? "refreshing" : status);
    if (status === "error") { assert.match(c.innerHTML, /관리자 로그인이 필요/); assert.doesNotMatch(c.innerHTML, /100만원/); }
    controller.dispose();
  }
});

test("company/month changes settle previous display tickets immediately and ignore stale draws", async () => {
  const c = container(), calls = [], frames = animationFrames();
  const controller = ui.createController(c, { ...frames, fetchData(id, month, signal) { const pending = deferred(); calls.push({ id, month, signal, ...pending }); return pending.promise; } });
  const a = controller.open({ companyId: "switch-a", month: "2026-09" }), aDisplay = controller.whenDisplayed();
  const b = controller.load("2026-08"), bDisplay = controller.whenDisplayed();
  assert.equal((await aDisplay).status, "superseded"); assert.equal(calls[0].signal.aborted, true);
  const d = controller.open({ companyId: "switch-b", month: "2026-07" }), dDisplay = controller.whenDisplayed();
  assert.equal((await bDisplay).status, "superseded"); assert.equal(calls[1].signal.aborted, true);
  calls[2].resolve({ ...envelope(), companyId: "switch-b", selectedMonth: "2026-07" }); await d;
  calls[0].resolve({ ...envelope(), companyId: "switch-a" }); calls[1].resolve({ ...envelope(), companyId: "switch-a", selectedMonth: "2026-08" }); await Promise.all([a, b]);
  frames.frame(); frames.frame();
  assert.deepEqual(await dDisplay, { status: "displayed", companyId: "switch-b", month: "2026-07", loadStatus: "ready" });
  const loading = controller.load("2026-06"), disposed = controller.whenDisplayed(); controller.dispose();
  assert.equal((await disposed).status, "disposed"); assert.equal((await controller.whenDisplayed()).status, "disposed");
  calls[3].resolve({ ...envelope(), companyId: "switch-b", selectedMonth: "2026-06" }); await loading;
});

test("hidden response tickets finish and become visible again without fetching the same data", async () => {
  const c = container(), answer = deferred(), frames = animationFrames(); let count = 0;
  const controller = ui.createController(c, { ...frames, fetchData: () => { count += 1; return answer.promise; } });
  const context = { companyId: envelope().companyId, month: "2026-09" };
  const loading = controller.open(context), firstDisplay = controller.whenDisplayed();
  c.hidden = true; assert.equal(controller.whenDisplayed(), firstDisplay);
  assert.equal((await firstDisplay).status, "hidden");
  answer.resolve(envelope()); await loading; assert.equal(frames.size, 0);
  c.hidden = false; await controller.open(context);
  const visibleDisplay = controller.whenDisplayed(); assert.notEqual(visibleDisplay, firstDisplay);
  frames.frame(); frames.frame(); assert.equal((await visibleDisplay).status, "displayed");
  assert.equal(count, 1); controller.dispose();
});

test("a DOM redraw during display restarts the two-frame barrier without settling a stale DOM generation", async () => {
  const c = container(), frames = animationFrames();
  const controller = ui.createController(c, { ...frames, fetchData: async () => envelope() });
  await controller.open({ companyId: envelope().companyId }); let settled = false;
  const displayed = controller.whenDisplayed().then(value => { settled = true; return value; });
  frames.frame(); controller.selectTab("review"); frames.frame(); await Promise.resolve();
  assert.equal(settled, false); assert.match(c.innerHTML, /합산에서 제외한 자료/);
  frames.frame(); assert.equal((await displayed).status, "displayed"); controller.dispose();
});

test("a past displayed result cannot authorize work while that same card is hidden", async () => {
  const c = container(), frames = animationFrames(); let calls = 0;
  const controller = ui.createController(c, { ...frames, fetchData: async () => { calls += 1; return envelope(); } });
  const context = { companyId: envelope().companyId };
  await controller.open(context); const displayed = controller.whenDisplayed(); frames.frame(); frames.frame();
  assert.equal((await displayed).status, "displayed");
  c.hidden = true; const hidden = controller.whenDisplayed(); assert.notEqual(hidden, displayed); assert.equal((await hidden).status, "hidden");
  c.hidden = false; await controller.open(context); const returned = controller.whenDisplayed();
  frames.frame(); frames.frame(); assert.equal((await returned).status, "displayed"); assert.equal(calls, 1); controller.dispose();
});

test("a later local DOM redraw gets its own two-frame display result without another API call", async () => {
  const c = container(), frames = animationFrames(); let calls = 0;
  const controller = ui.createController(c, { ...frames, fetchData: async () => { calls += 1; return envelope(); } });
  await controller.open({ companyId: envelope().companyId });
  const before = controller.whenDisplayed(); frames.frame(); frames.frame(); await before;
  controller.selectTab("analysis"); const after = controller.whenDisplayed(); assert.notEqual(after, before);
  let settled = false; after.then(() => { settled = true; }); frames.frame(); await Promise.resolve(); assert.equal(settled, false);
  frames.frame(); assert.equal((await after).status, "displayed"); assert.equal(calls, 1); controller.dispose();
});

test("visibility and removal observers release a display waiter even before the network completes", async () => {
  const previousDocument = globalThis.document, events = new Map(), answer = deferred(), frames = animationFrames(); let notify, disconnected = false;
  globalThis.document = { documentElement: {}, visibilityState: "visible", addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); } };
  const c = container();
  class Observer { constructor(callback) { notify = callback; } observe() {} disconnect() { disconnected = true; } }
  const controller = ui.createController(c, { ...frames, MutationObserver: Observer, fetchData: () => answer.promise });
  try {
    const loading = controller.open({ companyId: envelope().companyId }), displayed = controller.whenDisplayed();
    c.isConnected = false; notify(); assert.equal((await displayed).status, "hidden");
    c.isConnected = true; const reopened = controller.open({ companyId: envelope().companyId }), reopenedDisplay = controller.whenDisplayed();
    globalThis.document.visibilityState = "hidden"; events.get("visibilitychange")();
    assert.equal((await reopenedDisplay).status, "hidden");
    answer.resolve(envelope()); await Promise.all([loading, reopened]);
  } finally { answer.resolve(envelope()); controller.dispose(); globalThis.document = previousDocument; }
  assert.equal(disconnected, true); assert.equal(events.size, 0);
});

test("animation scheduling failures fall back to asynchronous turns and do not leave display pending", async () => {
  const c = container();
  const controller = ui.createController(c, { requestAnimationFrame() { throw new Error("surface unavailable"); }, fetchData: async () => envelope() });
  await controller.open({ companyId: envelope().companyId });
  const result = await controller.whenDisplayed(); assert.equal(result.status, "displayed"); controller.dispose();
});

test("a polling timer paused in a hidden document resumes once on return without an immediate refetch", async () => {
  const previousDocument = globalThis.document, events = new Map(), timers = new Map(), frames = animationFrames();
  let nextTimer = 0, calls = 0, notify;
  globalThis.document = { documentElement: {}, visibilityState: "visible", addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); } };
  class Observer { constructor(callback) { notify = callback; } observe() {} disconnect() {} }
  const c = container(), context = { companyId: envelope().companyId };
  const controller = ui.createController(c, { ...frames, MutationObserver: Observer,
    fetchData: async () => { calls += 1; return { ...envelope(), status: calls === 1 ? "updating" : "ready" }; },
    setTimeout(fn, ms) { assert.equal(ms, 3000); timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: key => timers.delete(key) });
  try {
    await controller.open(context); assert.equal(calls, 1); assert.equal(timers.size, 1);
    globalThis.document.visibilityState = "hidden"; events.get("visibilitychange")();
    const [timerId, callback] = [...timers][0]; timers.delete(timerId); callback();
    assert.equal(calls, 1); assert.equal(timers.size, 0, "hidden timer must not retry or reschedule");
    globalThis.document.visibilityState = "visible"; events.get("visibilitychange")(); notify();
    await controller.open(context); controller.whenDisplayed();
    assert.equal(calls, 1, "returning/showing coalesced data must not refetch immediately");
    assert.equal(timers.size, 1, "visibility, DOM observer and repeated show share one poll timer");
    const [resumedId, resumed] = [...timers][0]; timers.delete(resumedId); resumed();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(timers.size, 0, "ready response stops polling");
  } finally { controller.dispose(); globalThis.document = previousDocument; }
});

test("an in-progress response arriving hidden starts one delayed poll when its card becomes visible", async () => {
  for (const status of ["refreshing", "updating", "pending", "ready", "failed"]) {
    const c = container(), timers = new Map(), frames = animationFrames(), answer = deferred(); let count = 0, nextTimer = 0;
    c.hidden = true;
    const context = { companyId: envelope().companyId };
    const controller = ui.createController(c, { ...frames, fetchData: () => { count += 1; return answer.promise; },
      setTimeout(fn, ms) { assert.equal(ms, 3000); timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: key => timers.delete(key) });
    try {
      const opening = controller.open(context); answer.resolve({ ...envelope(), status }); await opening;
      assert.equal(timers.size, 0, status + " must not poll while hidden");
      c.hidden = false; await controller.open(context); controller.whenDisplayed(); await controller.open(context);
      assert.equal(count, 1, "show must reuse the response that arrived hidden");
      assert.equal(timers.size, ["refreshing", "updating"].includes(status) ? 1 : 0, "only actual in-progress work resumes");
    } finally { controller.dispose(); }
  }
});

test("a failed refresh does not restart polling its previous in-progress envelope on visibility checks", async () => {
  const c = container(), timers = new Map(), frames = animationFrames(); let calls = 0, nextTimer = 0;
  const context = { companyId: envelope().companyId };
  const controller = ui.createController(c, { ...frames, fetchData: async () => { calls += 1; if (calls > 1) throw new Error("관리자 로그인이 필요합니다."); return { ...envelope(), status: "refreshing" }; },
    setTimeout(fn, ms) { assert.equal(ms, 3000); timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: key => timers.delete(key) });
  try {
    await controller.open(context); assert.equal(timers.size, 1);
    const [id, poll] = [...timers][0]; timers.delete(id); poll(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2); assert.equal(timers.size, 0); assert.match(controller.state.error, /로그인/);
    c.hidden = true; controller.whenDisplayed(); c.hidden = false; await controller.open(context); controller.whenDisplayed();
    assert.equal(calls, 2); assert.equal(timers.size, 0, "an error must not become an automatic retry loop");
  } finally { controller.dispose(); }
});
