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
