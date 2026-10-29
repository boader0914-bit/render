"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const monitor = require("../web/collection-monitor.js");
const source = fs.readFileSync(path.join(__dirname, "../web/collection-monitor.js"), "utf8");
const NOW = Date.parse("2026-10-24T00:20:00Z");
const clone = value => JSON.parse(JSON.stringify(value));
function occurrence(overrides = {}) {
  return { id: "rotation_2026-10-24_1", day: "2026-10-24", keyword: "대전글램핑", workerKey: "web",
    scheduledAt: "2026-10-24T00:00:00.000Z", status: "complete", runId: "captured_run",
    collectionQuality: { status: "complete" },
    postprocess: { runId: "captured_run", scheduleOccurrenceId: "rotation_2026-10-24_1", state: "complete", bindingVerified: true }, ...overrides };
}
function snapshot(items = [occurrence()], overrides = {}) {
  return { available: true, enabled: true, generatedAt: new Date(NOW).toISOString(), from: "2026-10-19", to: "2026-10-25", today: "2026-10-24",
    keywords: ["대전글램핑", "부산글램핑"], coverage: { days: Array.from({ length: 7 }, (_, i) => ({ day: monitor.addDays("2026-10-19", i), status: "available" })) }, items, ...overrides };
}
function freeze(value) { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test("KST midnight and Monday boundaries select the correct seven civil dates", () => {
  assert.equal(monitor.kstDay(Date.parse("2026-10-25T14:59:59.999Z")), "2026-10-25");
  assert.equal(monitor.kstDay(Date.parse("2026-10-25T15:00:00.000Z")), "2026-10-26");
  assert.equal(monitor.weekStart("2026-10-25"), "2026-10-19");
  assert.equal(monitor.weekStart("2026-10-26"), "2026-10-26");
  assert.equal(monitor.weekStart("2027-01-01"), "2026-12-28");
  assert.equal(monitor.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(monitor.validDay("2024-02-29"), true);
  for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "invalid"]) assert.equal(monitor.validDay(bad), false);
  assert.equal(monitor.time("2026-10-24T00:00:00Z"), "09:00");
  assert.equal(monitor.time(undefined), "미확인");
});

test("green requires complete collection and quality plus the exact run and saved slot DB receipt", () => {
  assert.equal(monitor.classify(occurrence()).tone, "complete");
  assert.equal(monitor.classify(occurrence({ status: "completed" })).tone, "complete");
  for (const value of [
    occurrence({ runId: null }), occurrence({ collectionQuality: undefined }), occurrence({ collectionQuality: { status: "unknown" } }),
    occurrence({ postprocess: undefined }), occurrence({ postprocess: { state: "complete", runId: "other", scheduleOccurrenceId: "rotation_2026-10-24_1" } }),
    occurrence({ postprocess: { state: "complete", runId: "captured_run", scheduleOccurrenceId: "rotation_2026-10-24_2" } }),
    occurrence({ errorCode: "COLLECTION_RESULT_UNVERIFIED" })
  ]) assert.equal(monitor.classify(value).tone, "unknown", JSON.stringify(value));
  assert.match(monitor.classify(occurrence()).note, /월집계 완료와는 별도/);
});

test("an absent slot identity must never become green", () => {
  const noSlot = occurrence({ id: undefined, postprocess: { state: "complete", runId: "captured_run" } });
  assert.equal(monitor.classify(noSlot).tone, "unknown");
});

test("a rejected binding cannot become green and another slot's DB failure cannot become red", () => {
  const rejected = occurrence({ postprocess: { state: "complete", runId: "captured_run", scheduleOccurrenceId: "rotation_2026-10-24_1", bindingVerified: false } });
  assert.equal(monitor.classify(rejected).tone, "unknown");
  for (const db of [
    { state: "failed", runId: "different_run", scheduleOccurrenceId: "rotation_2026-10-24_1" },
    { state: "failed", runId: "captured_run", scheduleOccurrenceId: "different_slot" },
    { state: "failed", runId: "captured_run", scheduleOccurrenceId: "rotation_2026-10-24_1", bindingVerified: false }
  ]) assert.equal(monitor.classify(occurrence({ postprocess: db })).tone, "unknown", JSON.stringify(db));
});

test("pending, active, failed and uncertain evidence remain separate even after the scheduled time", () => {
  for (const status of ["queued", "pending", "scheduled", "planned", "waiting", "paused", "cancelled", "canceled"]) {
    assert.equal(monitor.classify(occurrence({ status }), NOW).tone, "pending", status);
  }
  assert.equal(monitor.classify(occurrence({ status: "queued" }), NOW).label, "시작 대기");
  assert.equal(monitor.classify(occurrence({ status: "running" }), NOW).tone, "running");
  for (const state of ["held", "queued", "running", "pending", "waiting"]) {
    assert.equal(monitor.classify(occurrence({ postprocess: { ...occurrence().postprocess, state } })).tone, "running", state);
  }
  for (const status of ["failed", "blocked", "partial", "missed", "interrupted", "error"]) assert.equal(monitor.classify(occurrence({ status })).tone, "issue", status);
  assert.equal(monitor.classify(occurrence({ collectionQuality: { status: "partial" } })).tone, "issue");
  assert.equal(monitor.classify(occurrence({ postprocess: { ...occurrence().postprocess, state: "failed" } })).tone, "issue");
  for (const status of [undefined, "unknown", "uncertain", "review", "not_a_status"]) assert.equal(monitor.classify(occurrence({ status })).tone, "unknown", String(status));
});

test("calculated plans and reused observations cannot claim a fresh successful collection", () => {
  const plan = monitor.classify(occurrence({ projected: true }));
  assert.equal(plan.tone, "pending"); assert.match(plan.label, /계산/); assert.match(plan.note, /확정 배정·실행 기록이 아닙니다/);
  const reused = monitor.classify(occurrence({ status: "reused" }));
  assert.equal(reused.tone, "unknown"); assert.equal(reused.label, "기존 자료 사용");
  assert.match(reused.note, /새 수집과 구별/);
});

test("weekly rows preserve day and keyword membership and never mutate stored records", () => {
  const input = freeze(snapshot([
    occurrence(), occurrence(), occurrence({ id: "rotation_2026-10-20_1", day: "2026-10-20", keyword: "부산글램핑", workerKey: "manual", scheduledAt: "2026-10-20T02:00:00Z", status: "queued", runId: null }),
    occurrence({ id: "future", day: "2026-10-26" }), occurrence({ id: null }), occurrence({ keyword: "" }), null,
    occurrence({ id: "projection", day: "2026-10-25", keyword: "부산글램핑", projected: true })
  ]));
  const before = clone(input), model = monitor.buildModel(input, {}, NOW);
  assert.deepEqual(input, before); assert.equal(model.items.length, 3); assert.equal(model.actualCount, 2); assert.equal(model.projectedCount, 1);
  assert.deepEqual(model.days, ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  assert.equal(model.rows.find(x => x.keyword === "대전글램핑").cells[5].items[0].id, "rotation_2026-10-24_1");
  assert.equal(model.rows.find(x => x.keyword === "부산글램핑").cells[1].items[0].workerKey, "manual");
  assert.equal(model.counts.complete, 1); assert.equal(model.counts.pending, 2);
  const filtered = monitor.buildModel(input, { worker: "manual", tone: "pending", query: " 부산 " }, NOW);
  assert.deepEqual(filtered.rows.map(x => x.keyword), ["부산글램핑"]); assert.equal(filtered.rows[0].cells[1].items.length, 1); assert.equal(filtered.rows[0].cells[6].items.length, 0);
  assert.deepEqual(filtered.counts, model.counts, "cards deliberately represent the entire selected week");
  assert.equal(monitor.buildModel(input, { query: "없는키워드" }, NOW).rows.length, 0);
});

test("a week with configured keywords and missing dates stays empty rather than zero-success", () => {
  const model = monitor.buildModel(snapshot([], { coverage: { days: [] } }), {}, NOW);
  assert.equal(model.rows.length, 2); assert.equal(model.items.length, 0); assert.equal(model.actualCount, 0);
  assert.ok(model.rows.every(row => row.cells.every(cell => cell.items.length === 0)));
  assert.deepEqual(model.counts, { complete: 0, pending: 0, running: 0, issue: 0, unknown: 0 });
});

class Element {
  constructor(tag, nodes) { this.tagName = tag.toUpperCase(); this.nodes = nodes; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ""; this._text = ""; this.value = ""; this.disabled = false; this.hidden = false; this.dataset = {}; this.classList = { contains: key => this.className.split(/\s+/).includes(key) }; }
  set id(value) { this._id = value; this.nodes.set(value, this); } get id() { return this._id; }
  set textContent(value) { this._text = String(value); this.children = []; } get textContent() { return this._text; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  insertBefore(node, before) { node.parentNode = this; const at = this.children.indexOf(before); if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); }
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, fn) { (this.listeners[key] ||= []).push(fn); }
  getClientRects() { return this.hidden || this.screenHidden ? [] : [{}]; }
  focus() { this.focused = true; this.nodes.activeElement = this; (this.nodes.focusCalls ||= []).push(this); }
  async fire(type) { if (type === "click" && this.disabled) return; for (const fn of this.listeners[type] || []) await fn({ type, target: this, preventDefault() {} }); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const text = node => descendants(node).map(x => x.textContent).join(" ");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function mockUi({ response = snapshot(), preview = null, role = "role-admin", request: overrideRequest, now = NOW, trackFocus = false } = {}) {
  const nodes = new Map(), body = new Element("body", nodes), parent = new Element("section", nodes), marker = new Element("div", nodes);
  body.className = role; marker.id = "collectorWorkerStates"; parent.append(marker);
  const listeners = {}, windowListeners = {}, timers = [], observers = [], calls = []; let clock = now, next = response;
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag, nodes), addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; } };
  if (trackFocus) Object.defineProperty(document, "activeElement", { get: () => nodes.activeElement });
  async function request(url, options) { calls.push({ url, options: clone(options) }); return overrideRequest ? overrideRequest(url, options) : { ok: true, status: 200, json: async () => clone(next) }; }
  const window = { fetch: request, addEventListener(type, fn) { windowListeners[type] = fn; }, removeEventListener(type) { delete windowListeners[type]; }, setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {} };
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  vm.runInNewContext(source, { window, document, MutationObserver, Intl, Date, console });
  const controller = window.CollectionMonitor.mount(parent, { now: () => clock, fetch: request, ...(preview ? { snapshot: preview } : {}) });
  await settle(); const panel = nodes.get("collectionWeeklyMonitor");
  return { nodes, body, document, panel, parent, marker, controller, timers, observers, calls, listeners, windowListeners,
    setResponse(value) { next = value; }, advance(ms) { clock += ms; },
    find(cls) { return descendants(panel).filter(x => x.className === cls); },
    button(label) { return descendants(panel).find(x => x.tagName === "BUTTON" && x.textContent === label); }
  };
}

test("mounted live monitor reads only its bounded GET and polls only a visible administrator", async () => {
  const ui = await mockUi();
  assert.equal(ui.parent.children[0], ui.panel); assert.equal(ui.parent.children[1], ui.marker);
  assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].url, "/api/collection-monitor?from=2026-10-19&to=2026-10-25");
  assert.deepEqual(ui.calls[0].options, { method: "GET", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } });
  assert.equal(ui.timers[0].ms, 15000); assert.equal(ui.find("cm-slot")[0].dataset.tone, "complete");
  ui.advance(15000); ui.document.hidden = true; ui.timers[0].fn(); await settle(); assert.equal(ui.calls.length, 1);
  ui.document.hidden = false; ui.panel.screenHidden = true; ui.timers[0].fn(); await settle(); assert.equal(ui.calls.length, 1);
  ui.panel.screenHidden = false; ui.timers[0].fn(); await settle(); assert.equal(ui.calls.length, 2);
  assert.ok(ui.calls.every(x => x.options.method === "GET" && !x.options.body));
  ui.body.className = "role-admin admin-user-view"; ui.observers[0].callback(); ui.advance(15000); ui.timers[0].fn(); await settle();
  assert.equal(ui.calls.length, 2); assert.equal(ui.find("cm-slot").length, 0);
  ui.controller.destroy(); assert.equal(ui.observers[0].disconnected, true);
});

test("preview shows stored evidence without requests and missing dates are explicitly unknown", async () => {
  const unsafe = "<img src=x onerror=bad()>";
  const saved = snapshot([occurrence({ keyword: unsafe })], { keywords: [unsafe], coverage: { days: [] } });
  const ui = await mockUi({ preview: saved });
  assert.equal(ui.calls.length, 0); assert.equal(ui.timers.length, 0); assert.equal(ui.button("‹").disabled, true); assert.equal(ui.button("›").disabled, true);
  assert.match(text(ui.panel), /자동 갱신하지 않습니다/); assert.match(text(ui.panel), /기록 미확인/); assert.match(text(ui.panel), /월집계 완료와 별도/);
  assert.ok(text(ui.panel).includes(unsafe)); assert.equal(descendants(ui.panel).some(x => x.tagName === "IMG"), false);
});

test("HTTP authentication failure clears old slots and details instead of retaining green", async () => {
  let status = 200;
  const ui = await mockUi({ request: async () => ({ ok: status === 200, status, json: async () => snapshot() }) });
  await ui.find("cm-slot")[0].fire("click"); assert.equal(ui.find("cm-detail")[0].hidden, false);
  status = 401; await ui.controller.refresh();
  assert.equal(ui.find("cm-slot").length, 0); assert.equal(ui.find("cm-detail")[0].hidden, true); assert.match(text(ui.panel), /관리자 로그인이 필요/);
});

test("logout clears private text and discards an already pending JSON response", async () => {
  const gate = deferred(); let reads = 0;
  const ui = await mockUi({ request: async () => ({ ok: true, status: 200, json: async () => ++reads === 1 ? snapshot() : gate.promise }) });
  const pending = ui.controller.refresh(); await settle();
  ui.body.className = ""; ui.observers[0].callback(); assert.equal(ui.find("cm-slot").length, 0); assert.doesNotMatch(text(ui.panel), /대전글램핑/);
  gate.resolve(snapshot([occurrence({ keyword: "늦게도착한비공개키워드" })])); await pending;
  assert.doesNotMatch(text(ui.panel), /늦게도착한비공개키워드|대전글램핑/); assert.equal(ui.find("cm-slot").length, 0);
});

test("a mismatched response period cannot overwrite the selected weekly evidence", async () => {
  const ui = await mockUi(); ui.setResponse(snapshot([occurrence({ keyword: "다른주비공개자료" })], { from: "2026-10-26", to: "2026-11-01" }));
  await ui.controller.refresh(); assert.match(text(ui.panel), /응답의 조회 기간이 달라/); assert.doesNotMatch(text(ui.panel), /다른주비공개자료/);
  assert.ok(text(ui.panel).includes("대전글램핑"));
});

test("selected details refresh to the same slot's new failure state together with its chip", async () => {
  const ui = await mockUi({ response: snapshot([occurrence({ status: "running" })]) });
  await ui.find("cm-slot")[0].fire("click"); assert.equal(ui.find("cm-detail-state")[0].dataset.tone, "running");
  const focusedBefore = ui.nodes.focusCalls.length;
  ui.setResponse(snapshot([occurrence({ status: "failed", errorCode: "PROVIDER_BLOCKED" })])); await ui.controller.refresh();
  assert.equal(ui.find("cm-slot")[0].dataset.tone, "issue");
  assert.equal(ui.find("cm-detail-state")[0].dataset.tone, "issue"); assert.match(text(ui.find("cm-detail")[0]), /PROVIDER_BLOCKED/);
  assert.equal(ui.nodes.focusCalls.length, focusedBefore, "background refresh must not move the user's keyboard focus");
});

test("selected details expose the monitor DB error code as well as the older lastErrorCode shape", async () => {
  for (const codeField of ["errorCode", "lastErrorCode"]) {
    const item = occurrence({ postprocess: { ...occurrence().postprocess, state: "failed", [codeField]: "COLLECTION_POSTPROCESS_LOCKED" } });
    const ui = await mockUi({ response: snapshot([item]) }); await ui.find("cm-slot")[0].fire("click");
    assert.match(text(ui.find("cm-detail")[0]), /COLLECTION_POSTPROCESS_LOCKED/, codeField);
  }
});

const MIXED_NOW = Date.parse("2026-10-30T01:00:00Z");
const MIXED_KEYWORDS = ["대전글램핑", "서울근교글램핑", "경주글램핑", "여수글램핑", "가평글램핑", "포천글램핑"];
function dailyRows(day, count, { projected = false, planKind = "regular", status = "queued", conditions = { bookingRangeDays: 21, detailRankRanges: "1-20" } } = {}) {
  return Array.from({ length: count }, (_, index) => occurrence({ id: `rotation_${day}_${index + 1}`, day, index,
    keyword: MIXED_KEYWORDS[index], workerKey: index % 2 ? "manual" : "web", scheduledAt: `${day}T${String(index * 2).padStart(2, "0")}:00:00.000Z`,
    status, runId: null, postprocess: undefined, collectionQuality: undefined, projected, source: projected ? "projection" : "stored_rotation", planKind, conditions }));
}
function mixedSnapshot(overrides = {}) {
  return snapshot([...dailyRows("2026-10-27", 4), ...dailyRows("2026-10-28", 6, { planKind: "one_day_trial" }), ...dailyRows("2026-10-30", 6, { projected: true })],
    { from: "2026-10-26", to: "2026-11-01", today: "2026-10-30", generatedAt: new Date(MIXED_NOW).toISOString(), keywords: MIXED_KEYWORDS,
      currentPlan: { source: "saved_config", dailySlots: 6, bookingDays: 21, detailRankRanges: "1-20" }, coverage: { days: [
        { day: "2026-10-26", status: "not_started", count: 0, dailySlots: null },
        { day: "2026-10-27", status: "saved", count: 4, dailySlots: 4, planKind: "regular" },
        { day: "2026-10-28", status: "saved", count: 6, dailySlots: 6, planKind: "one_day_trial" },
        { day: "2026-10-29", status: "missing", count: null, dailySlots: null },
        { day: "2026-10-30", status: "projected", count: 6, dailySlots: 6, planKind: "regular" },
        { day: "2026-10-31", status: "saved", count: 0, dailySlots: null },
        { day: "2026-11-01", status: "missing", count: null, dailySlots: null }
      ] }, ...overrides });
}
const dateInput = ui => ui.find("cm-date-nav")[0].children[1];

test("selected-day model preserves stored four, stored trial six and projected six without client-generated slots", () => {
  const input = freeze(mixedSnapshot()), before = structuredClone(input);
  for (const [day, count, projected, kind] of [["2026-10-27", 4, false, "regular"], ["2026-10-28", 6, false, "one_day_trial"], ["2026-10-30", 6, true, "regular"]]) {
    const model = monitor.buildModel(input, { day }, MIXED_NOW);
    assert.equal(model.dayItems.length, count); assert.equal(model.visibleDayItems.length, count);
    assert.ok(model.dayItems.every(item => item.projected === projected && item.planKind === kind));
  }
  const missing = monitor.buildModel(input, { day: "2026-10-29" }, MIXED_NOW);
  assert.equal(missing.dayItems.length, 0); assert.equal(missing.dayCoverage.status, "missing");
  assert.equal(missing.items.length, 16); assert.equal(missing.actualCount, 10); assert.equal(missing.projectedCount, 6); assert.equal(missing.coverageIncomplete, true);
  assert.deepEqual(input, before);
});

test("coverage saved, projected, not_started and missing are distinct, including saved snapshots with no slots", () => {
  const source = mixedSnapshot();
  for (const [day, expected] of [["2026-10-26", "시작 전"], ["2026-10-27", "—"], ["2026-10-28", "—"], ["2026-10-29", "기록 미확인"], ["2026-10-30", "—"], ["2026-10-31", "배정 확인 필요"]]) {
    assert.equal(monitor.cellPlaceholder(source, day), expected, day);
  }
  assert.equal(monitor.cellPlaceholder(source, "2026-10-29", true), "—");
  assert.equal(monitor.cellPlaceholder(source, "2026-12-01"), "기록 미확인");
});

test("current six-per-day setting comes only from saved_config metadata and never from a six-slot trial", async () => {
  const ui = await mockUi({ response: mixedSnapshot(), now: MIXED_NOW });
  assert.match(text(ui.find("cm-connection")[0]), /설정 6회\/일/);
  ui.setResponse(mixedSnapshot({ currentPlan: undefined })); await ui.controller.refresh();
  assert.doesNotMatch(text(ui.find("cm-connection")[0]), /6회/);
  ui.setResponse(mixedSnapshot({ currentPlan: { source: "estimate", dailySlots: 6 } })); await ui.controller.refresh();
  assert.doesNotMatch(text(ui.find("cm-connection")[0]), /6회/);
  ui.setResponse(mixedSnapshot({ enabled: false, reason: "PROTECTION_HOLD", planState: "paused" })); await ui.controller.refresh();
  assert.match(text(ui.find("cm-connection")[0]), /실행 조건 확인 필요/); assert.match(text(ui.panel), /PROTECTION_HOLD/);
});

test("day cards and date controls display actual four, trial six, computed six, missing and before-start evidence", async () => {
  const ui = await mockUi({ response: mixedSnapshot(), now: MIXED_NOW });
  assert.equal(ui.find("cm-day-card").length, 6); assert.match(text(ui.find("cm-day-heading")[0]), /계산 예정 6회/);
  assert.ok(ui.find("cm-day-card").every(card => text(card).includes("예정(계산)")));
  await ui.find("cm-day-card")[0].fire("click"); assert.equal(ui.find("cm-detail")[0].hidden, false);
  dateInput(ui).value = "2026-10-27"; await dateInput(ui).fire("change"); assert.equal(ui.find("cm-day-card").length, 4); assert.match(text(ui.find("cm-day-heading")[0]), /저장 4회/);
  assert.equal(ui.find("cm-detail")[0].hidden, true, "date navigation clears the previous selection's details");
  dateInput(ui).value = "2026-10-28"; await dateInput(ui).fire("change"); assert.equal(ui.find("cm-day-card").length, 6); assert.ok(ui.find("cm-day-card").every(card => text(card).includes("1일 시험")));
  dateInput(ui).value = "2026-10-29"; await dateInput(ui).fire("change"); assert.equal(ui.find("cm-day-card").length, 0); assert.match(text(ui.find("cm-day-section")[0]), /배정 기록을 확인하지 못했습니다/);
  dateInput(ui).value = "2026-10-31"; await dateInput(ui).fire("change"); assert.equal(ui.find("cm-day-card").length, 0); assert.match(text(ui.find("cm-day-section")[0]), /저장 기록은 있으나 배정 항목을 확인하지 못했습니다/);
  dateInput(ui).value = "2026-10-26"; await dateInput(ui).fire("change"); assert.match(text(ui.find("cm-day-heading")[0]), /시작 전/);
  assert.equal(ui.calls.length, 1, "same-week navigation is presentation-only");
});

test("keyword, worker and tone filters apply to selected-day cards and weekly cells together", async () => {
  const rows = dailyRows("2026-10-30", 6); rows[0].status = "failed";
  const ui = await mockUi({ response: mixedSnapshot({ items: rows }), now: MIXED_NOW });
  const bar = ui.find("cm-filters")[0], query = bar.children[0].children[1], worker = bar.children[1].children[1], tone = bar.children[2].children[1];
  worker.value = "manual"; await worker.fire("change"); assert.equal(ui.find("cm-day-card").length, 3); assert.equal(ui.find("cm-slot").length, 3);
  query.value = " 서울근교 "; await query.fire("input"); assert.equal(ui.find("cm-day-card").length, 1); assert.equal(ui.find("cm-slot").length, 1);
  query.value = "없는검색어"; await query.fire("input"); assert.equal(ui.find("cm-day-card").length, 0); assert.equal(ui.find("cm-slot").length, 0);
  query.value = ""; await query.fire("input"); worker.value = ""; await worker.fire("change"); tone.value = "issue"; await tone.fire("change");
  assert.equal(ui.find("cm-day-card").length, 1); assert.equal(ui.find("cm-slot").length, 1); assert.equal(ui.find("cm-day-card")[0].dataset.tone, "issue"); assert.equal(ui.calls.length, 1);
});

test("details use slot conditions including bookingRangeDays and do not claim unbound DB completion", async () => {
  const item = occurrence({ conditions: { bookingRangeDays: 21, detailRankRanges: "1-20" }, postprocess: { ...occurrence().postprocess, scheduleOccurrenceId: "other_slot", finishedAt: "2026-10-24T00:10:00Z" } });
  const ui = await mockUi({ response: snapshot([item]) }); await ui.find("cm-day-card")[0].fire("click");
  assert.match(text(ui.find("cm-detail")[0]), /21일/); assert.match(text(ui.find("cm-detail")[0]), /1–20위/); assert.match(text(ui.find("cm-detail")[0]), /기록 연결 미확인/);
  assert.equal(ui.find("cm-day-card")[0].dataset.tone, "unknown");
  assert.equal(monitor.conditionDays({}), "미확인"); assert.equal(monitor.conditionDays({ conditions: { bookingDays: 0 } }), "미확인");
  assert.equal(monitor.conditionRanks({ conditions: { detailRankRanges: "bad" } }), "미확인");
});

test("projected detail never promotes inherited run or DB fields into actual completion evidence", async () => {
  const ui = await mockUi({ response: snapshot([occurrence({ projected: true, source: "projection", startedAt: "2026-10-24T00:01:00Z", finishedAt: "2026-10-24T00:02:00Z" })]) });
  await ui.find("cm-day-card")[0].fire("click"); const content = text(ui.find("cm-detail")[0]);
  assert.match(content, /예정\(계산\)/); assert.match(content, /실제 기록 미확인/); assert.match(content, /계산 식별자/);
  assert.doesNotMatch(content, /captured_run|정상 완료/); assert.equal(ui.find("cm-day-card")[0].dataset.tone, "pending");
});

test("authentication failure clears day cards and filters, stops automatic retries, and permits an explicit reread", async () => {
  let status = 200;
  const ui = await mockUi({ request: async () => ({ ok: status === 200, status, json: async () => snapshot() }) });
  const query = ui.find("cm-filters")[0].children[0].children[1]; query.value = "대전"; await query.fire("input");
  await ui.find("cm-day-card")[0].fire("click"); status = 403; await ui.controller.refresh();
  assert.equal(ui.find("cm-day-card").length, 0); assert.equal(ui.find("cm-slot").length, 0); assert.equal(ui.find("cm-detail")[0].hidden, true); assert.equal(query.value, "");
  const reads = ui.calls.length; ui.advance(15000); ui.timers[0].fn(); await settle(); assert.equal(ui.calls.length, reads);
  status = 200; await ui.button("새로고침").fire("click"); await settle(); assert.equal(ui.find("cm-day-card").length, 1);
});

test("date navigation issues a bounded next-week GET and discards a delayed previous-week JSON response", async () => {
  const gate = deferred(); let reads = 0;
  const nextWeek = snapshot([occurrence({ id: "rotation_2026-10-26_1", day: "2026-10-26", keyword: "새주글램핑", scheduledAt: "2026-10-26T00:00:00Z", status: "queued", runId: null })], { from: "2026-10-26", to: "2026-11-01", keywords: ["새주글램핑"] });
  const ui = await mockUi({ request: async url => { const number = ++reads; return { ok: true, status: 200, json: async () => number === 2 ? gate.promise : url.includes("from=2026-10-26") ? nextWeek : snapshot() }; } });
  const oldRead = ui.controller.refresh(); await settle(); dateInput(ui).value = "2026-10-26"; await dateInput(ui).fire("change"); await settle();
  assert.equal(ui.calls.at(-1).url, "/api/collection-monitor?from=2026-10-26&to=2026-11-01"); assert.match(text(ui.panel), /새주글램핑/);
  gate.resolve(snapshot([occurrence({ keyword: "늦은이전주글램핑" })])); await oldRead;
  assert.doesNotMatch(text(ui.panel), /늦은이전주글램핑/); assert.match(text(ui.panel), /새주글램핑/);
});

test("invalid date input does not query or manufacture a selected day's schedule", async () => {
  const ui = await mockUi(); dateInput(ui).value = "2026-02-30"; await dateInput(ui).fire("change");
  assert.equal(ui.calls.length, 1); assert.equal(dateInput(ui).value, "2026-10-24"); assert.equal(ui.find("cm-date-error")[0].hidden, false); assert.equal(ui.find("cm-day-card").length, 1);
});

test("visible refresh preserves keyboard focus on the same day card and detail close button", async () => {
  const ui = await mockUi({ trackFocus: true }), original = ui.find("cm-day-card")[0]; original.focus(); const key = original.dataset.monitorFocus;
  await ui.controller.refresh(); assert.equal(ui.document.activeElement.dataset.monitorFocus, key); assert.notEqual(ui.document.activeElement, original);
  await ui.find("cm-day-card")[0].fire("click"); const close = descendants(ui.find("cm-detail")[0]).find(node => node.dataset.monitorFocus === "detail-close"); close.focus();
  await ui.controller.refresh(); assert.equal(ui.document.activeElement.dataset.monitorFocus, "detail-close"); assert.notEqual(ui.document.activeElement, close);
  await ui.document.activeElement.fire("click"); assert.equal(ui.find("cm-detail")[0].hidden, true); assert.ok(ui.find("cm-day-card").every(card => card.attributes["aria-pressed"] === "false"));
});

test("rotation change refreshes current-plan metadata immediately only for a visible administrator and detaches on destroy", async () => {
  const gate = deferred(); let reads = 0;
  const four = mixedSnapshot({ currentPlan: { source: "saved_config", dailySlots: 4 } }), six = mixedSnapshot();
  const ui = await mockUi({ now: MIXED_NOW, request: async () => { const number = ++reads; return { ok: true, status: 200, json: async () => number === 1 ? four : number === 2 ? gate.promise : six }; } });
  assert.match(text(ui.find("cm-connection")[0]), /설정 4회\/일/);
  const pending = ui.controller.refresh(); await settle(); ui.windowListeners["collector:rotation-changed"](); gate.resolve(four); await pending; await settle();
  assert.equal(ui.calls.length, 3, "a change during an outstanding read queues one fresh read"); assert.match(text(ui.find("cm-connection")[0]), /설정 6회\/일/);
  ui.document.hidden = true; ui.windowListeners["collector:rotation-changed"](); await settle(); assert.equal(ui.calls.length, 3);
  ui.document.hidden = false; ui.body.className = "role-admin admin-user-view"; ui.windowListeners["collector:rotation-changed"](); await settle(); assert.equal(ui.calls.length, 3);
  ui.controller.destroy(); assert.equal(ui.windowListeners["collector:rotation-changed"], undefined);
  assert.ok(ui.calls.every(call => call.options.method === "GET" && !call.options.body));
});
