"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const helpers = require("../web/collection_rotation_controls.js");
const { defaultConfig, planDays } = require("./collection_rotation_scheduler.cjs");
const source = fs.readFileSync(path.join(__dirname, "../web/collection_rotation_controls.js"), "utf8");
const now = Date.parse("2026-10-15T02:00:00Z");
const clone = value => JSON.parse(JSON.stringify(value));
const draft = () => ({ ...helpers.defaultDraft(now), keywords: helpers.POLICY_KEYWORDS.join("\n"), bookingDays: "31" });
test("rotation editor preserves the scheduler contract without request speed or people controls", () => {
  const config = helpers.configFromDraft(draft());
  assert.deepEqual(config.workers, [{ workerKey: "web", dailyLimit: 2 }, { workerKey: "manual", dailyLimit: 2 }]);
  assert.equal(config.collection.bookingDays, 31); assert.equal(config.enabled, false);
  assert.equal(config.collection.dayUseMode, "inspect"); assert.equal(config.collection.collectionMode, "precision");
  assert.equal(config.keywordIntervalMinutes, 120); assert.equal(config.firstDate, "2026-10-16");
  assert.equal(Object.hasOwn(config, "requestPacing"), false); assert.equal(Object.hasOwn(config.collection, "adults"), false);
  assert.deepEqual(helpers.configFromDraft(helpers.draftFromConfig(config, now)), config);
  assert.doesNotThrow(() => planDays(config));
});
test("invalid and duplicated allocations fail before HTTP and observation days are explicit", () => {
  assert.throws(() => helpers.configFromDraft({ ...draft(), keywords: "경남글램핑\n경남글램핑" }), /같은 키워드/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), keywords: "경남글램핑\n대구글램핑" }), /배정 수/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), bookingDays: "" }), /1~31일/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), keywordIntervalMinutes: "0" }), /시작 시각/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), time: "23:00" }), /시작 시각/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), firstDate: "2026-02-30" }), /시작일/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), ranks: "0-20" }), /상세 순위/);
  assert.throws(() => helpers.configFromDraft({ ...draft(), purpose: "basic_db", dayUseMode: "detail" }), /상세수집/);
  assert.doesNotThrow(() => helpers.configFromDraft({ ...draft(), web: false, manualLimit: "2" }));
});
class Element {
  constructor(tag, registry) { this.tagName = tag.toUpperCase(); this.registry = registry; this.children = []; this.listeners = {}; this.attributes = {}; this.className = ""; this.value = ""; this.type = ""; this.disabled = false; this.hidden = false; this.checked = false; this.textContent = ""; this.dataset = {}; this.style = {}; this.classList = { contains: key => this.className.split(" ").includes(key) }; }
  set id(value) { this._id = value; this.registry.set(value, this); } get id() { return this._id; }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  insertBefore(child, before) { child.parentNode = this; const index = this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  removeEventListener() {}
  querySelector(selector) { return selector.startsWith("#") ? this.registry.get(selector.slice(1)) : null; }
  async event(type) { if (type === "click" && this.disabled) return; await Promise.all((this.listeners[type] || []).map(callback => callback({ type, target: this, preventDefault() {} }))); }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const allText = node => descendants(node).map(el => el.textContent).join(" ");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let index = 0; index < 100; index++) { if (predicate()) return; await tick(); } throw new Error("UI condition not reached"); }
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function mockUi({ saved = true, previewGate, readFailure = false, trialSupported = false, trialPreviewGate, trialWriteGate, trialFailure } = {}) {
  const nodes = new Map(), body = new Element("body", nodes), parent = new Element("section", nodes), workers = new Element("div", nodes);
  body.className = "role-admin"; parent.id = "collectorControlsCard"; workers.id = "collectorWorkerStates"; parent.append(workers);
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag, nodes), addEventListener() {}, removeEventListener() {} };
  const config = defaultConfig(new Date(now)); config.firstDate = "2026-10-16"; let state = { config, enabled: false, revision: saved ? 1 : 0, planState: "disabled", cursor: 0, nextKeyword: "경남글램핑", todayItems: [], upcomingItems: planDays(config).items, nextRunAt: null };
  if (trialSupported) { config.enabled = true; Object.assign(state, { enabled: true, planState: "scheduled", basePlanHash: "a".repeat(64), oneDayTrials: [], oneDayTrial: null }); }
  const calls = [], events = [], timers = [], observers = [];
  async function fetch(url, options) {
    const method = options.method, payload = options.body === undefined ? undefined : JSON.parse(options.body); calls.push({ url, method, payload });
    let result;
    if (method === "GET") { if (readFailure) return { ok: false, status: 401, json: async () => ({ error: "AUTH_REQUIRED" }) }; result = clone(state); }
    else if (url.endsWith("/trial/preview")) {
      if (trialPreviewGate) await trialPreviewGate.promise;
      if (trialFailure?.preview) return { ok: false, status: 409, json: async () => ({ code: trialFailure.preview }) };
      const trialConfig = { ...state.config, workers: state.config.workers.map(worker => ({ ...worker, dailyLimit: 3 })) };
      const trial = planDays(trialConfig, { startDate: payload.day, days: 1, cursor: state.cursor });
      const returnDay = new Date(Date.parse(payload.day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
      result = { day: payload.day, baseRevision: state.revision, basePlanHash: state.basePlanHash, baseDailySlots: 4, trialDailySlots: 6, returnDay, items: trial.items,
        nextDayItems: planDays(state.config, { startDate: returnDay, days: 1, cursor: trial.nextCursor }).items, configUnchanged: true };
    }
    else if (url.endsWith("/trial/cancel")) {
      if (trialFailure?.cancel) return { ok: false, status: 409, json: async () => ({ code: trialFailure.cancel }) };
      state.oneDayTrial = { ...state.oneDayTrial, status: "cancelled", cancelledAt: new Date(now).toISOString() }; state.oneDayTrials = [state.oneDayTrial]; result = state;
    }
    else if (url.endsWith("/trial")) {
      if (trialWriteGate) await trialWriteGate.promise;
      if (trialFailure?.register) return { ok: false, status: 409, json: async () => ({ code: trialFailure.register }) };
      state.oneDayTrial = { trialId: "trial-local-test", day: payload.day, baseRevision: state.revision, basePlanHash: state.basePlanHash, baseDailySlots: 4, trialDailySlots: 6,
        returnDay: new Date(Date.parse(payload.day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10), status: "armed", createdAt: new Date(now).toISOString(), cancelledAt: null };
      state.oneDayTrials = [state.oneDayTrial]; result = state;
    }
    else if (url.endsWith("/preview")) { if (previewGate) await previewGate.promise; result = planDays(payload.config, { days: payload.days }); }
    else if (method === "PUT") { state = { ...state, config: payload, enabled: false, revision: state.revision + 1, upcomingItems: planDays(payload).items }; result = state; }
    else if (url.endsWith("/enabled")) { state.enabled = payload.enabled; state.config.enabled = payload.enabled; state.planState = payload.enabled ? "scheduled" : "paused"; result = state; }
    else throw new Error("Unexpected API");
    return { ok: true, status: 200, json: async () => clone(result) };
  }
  const window = { fetch, localStorage: { getItem() { return null; }, setItem() {} }, dispatchEvent(event) { events.push(event); }, addEventListener() {}, setInterval(callback) { timers.push(callback); return timers.length; }, clearInterval() {} };
  class MutationObserver { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} }
  const context = vm.createContext({ window, document, MutationObserver, CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, console, Intl,
    Date: class extends Date { static now() { return now; } }, Set, Object, Array, Number, String, Promise });
  vm.runInContext(source, context);
  await until(() => calls.length && nodes.get("collectionRotationPanel")); for (let index = 0; index < 6; index++) await tick();
  const panel = nodes.get("collectionRotationPanel"), button = label => descendants(panel).find(el => el.tagName === "BUTTON" && el.textContent === label), input = name => nodes.get(`rotation_${name}`);
  async function change(name, value) { const el = input(name); if (el.type === "checkbox") el.checked = value; else el.value = value; await el.event("input"); }
  return { nodes, body, parent, workers, panel, button, input, change, calls, events, observers, timers, get state() { return state; } };
}
const tableRows = ui => descendants(ui.panel).filter(el => el.tagName === "TR" && el.parentNode?.tagName === "TBODY");
const postprocessNodes = row => descendants(row).filter(el => ["collector-postprocess-status", "collector-worker-alert"].includes(el.className));

test("today's saved results show DB preparation separately beside future slots and prefer current duplicate records", async () => {
  const ui = await mockUi(), states = ["held", "queued", "running", "complete", "failed", "unavailable"];
  const expected = ["업체 DB 반영 대기", "업체 DB 반영 대기", "업체 DB 반영 중", "업체 DB 반영 완료", "업체 DB 반영 실패 · 수집 결과 보관됨", "업체 DB 반영 상태 확인 필요"];
  ui.state.todayItems = states.map((state, index) => ({ id: `rotation_2026-10-15_${index + 1}`, day: "2026-10-15", workerKey: "manual", keyword: `DB시험${index}`,
    scheduledAt: `2026-10-15T${String(index + 1).padStart(2, "0")}:00:00Z`, startedAt: "2026-10-15T01:01:00Z", status: "complete", runId: `db_result_${index}`,
    postprocess: { state, attempts: 2, maxAttempts: 3, updatedAt: "2026-10-15T01:02:00Z", lastErrorCode: "COLLECTION_POSTPROCESS_HISTORY_FAILED" } }));
  const future = { id: "rotation_2026-10-16_1", day: "2026-10-16", workerKey: "web", keyword: "미래배정", scheduledAt: "2026-10-16T00:00:00Z", status: "scheduled" };
  ui.state.upcomingItems = [future, { ...clone(ui.state.todayItems[0]), status: "running", postprocess: { state: "running" } }];
  const original = clone({ todayItems: ui.state.todayItems, upcomingItems: ui.state.upcomingItems }), before = ui.calls.length;
  await ui.button("상태 새로고침").event("click");
  const rows = tableRows(ui); assert.equal(rows.length, 7);
  for (let index = 0; index < states.length; index++) {
    assert.match(allText(rows[index]), new RegExp(`DB시험${index}`));
    assert.equal(descendants(rows[index]).find(el => el.className === "rotation-row-state").textContent, "새 수집 완료");
    const status = postprocessNodes(rows[index])[0]; assert.equal(status.textContent, expected[index]);
    assert.equal(status.className, states[index] === "failed" ? "collector-worker-alert" : "collector-postprocess-status");
    assert.match(status.title, /DB 반영 시도 2\/3/); assert.match(status.title, /COLLECTION_POSTPROCESS_HISTORY_FAILED/);
    assert.ok(descendants(rows[index]).some(el => el.tagName === "BUTTON" && el.textContent === "결과 보기"));
  }
  assert.match(allText(rows[6]), /미래배정/); assert.equal(postprocessNodes(rows[6]).length, 0);
  assert.equal(descendants(rows[6]).find(el => el.className === "rotation-row-state").textContent, "예정");
  assert.deepEqual(clone({ todayItems: ui.state.todayItems, upcomingItems: ui.state.upcomingItems }), original);
  assert.deepEqual(ui.calls.slice(before).map(call => call.method), ["GET"]);
  await descendants(rows[4]).find(el => el.tagName === "BUTTON" && el.textContent === "결과 보기").event("click");
  assert.equal(ui.events.at(-1).type, "collector:open-result"); assert.equal(ui.events.at(-1).detail.runId, "db_result_4");
});

test("legacy and unknown DB states remain distinct and stored text is assigned without HTML", async () => {
  const ui = await mockUi(), unsafe = '<img src=x onerror="bad()">';
  ui.state.upcomingItems = [];
  ui.state.todayItems = [undefined, { state: "unknown", lastErrorCode: unsafe }, { state: "__proto__" }].map((postprocess, index) => ({
    id: `legacy_${index}`, day: "2026-10-15", keyword: index === 1 ? unsafe : `기록${index}`, workerKey: "manual", status: index === 0 ? "partial" : "complete", postprocess
  }));
  await ui.button("상태 새로고침").event("click");
  const rows = tableRows(ui); assert.equal(rows.length, 3); assert.equal(postprocessNodes(rows[0]).length, 0);
  assert.equal(descendants(rows[0]).find(el => el.className === "rotation-row-state").textContent, "일부 완료");
  for (const row of rows.slice(1)) assert.equal(postprocessNodes(row)[0].textContent, "업체 DB 반영 상태 확인 필요");
  assert.equal(descendants(rows[1]).find(el => el.className === "rotation-keyword").textContent, unsafe);
  assert.equal(postprocessNodes(rows[1])[0].title, unsafe); assert.equal(descendants(ui.panel).some(el => el.tagName === "IMG"), false);
  assert.doesNotMatch(allText(ui.panel), /업체 DB 반영 완료/);
});

test("status refresh preserves an edited draft and selected start while previews exclude persisted results", async () => {
  const ui = await mockUi();
  ui.state.todayItems = [{ id: "rotation_2026-10-15_1", day: "2026-10-15", scheduledAt: "2026-10-15T01:00:00Z", keyword: "오늘완료자료", workerKey: "manual", status: "complete", postprocess: { state: "queued" } }];
  await ui.change("bookingDays", "14"); await ui.change("startKeyword", "부산글램핑"); ui.panel.open = true;
  const before = ui.calls.length, timers = ui.timers.length;
  for (let index = 0; index < 3; index++) await ui.button("상태 새로고침").event("click");
  assert.deepEqual(ui.calls.slice(before).map(call => call.method), ["GET", "GET", "GET"]); assert.equal(ui.timers.length, timers);
  assert.equal(ui.input("bookingDays").value, "14"); assert.equal(ui.input("startKeyword").value, "부산글램핑");
  assert.equal(ui.button("순환예약 시작").disabled, true); assert.equal(ui.panel.open, true); assert.match(allText(ui.panel), /오늘완료자료/);
  await ui.button("배정표 미리보기").event("click");
  assert.match(allText(ui.panel), /편집안 · 향후 7일 미리보기/); assert.doesNotMatch(allText(ui.panel), /오늘완료자료|업체 DB 반영 대기/);
  assert.equal(ui.calls.at(-1).url, "/api/collection-rotation/preview"); assert.equal(ui.calls.at(-1).method, "POST");
  assert.equal(ui.calls.at(-1).payload.config.collection.bookingDays, 14); assert.equal(ui.calls.at(-1).payload.startKeyword, "부산글램핑");
  assert.equal(ui.state.enabled, false); assert.equal(ui.events.length, 0);
});

test("opening the card reads only, folds by default, and inserts before independent worker cards", async () => {
  const ui = await mockUi({ saved: false });
  assert.deepEqual(ui.calls.map(call => call.method), ["GET"]); assert.equal(ui.panel.open, false); assert.equal(ui.parent.children[0], ui.panel); assert.equal(ui.parent.children[1], ui.workers);
  assert.equal(ui.button("순환예약 시작").disabled, true); assert.equal(ui.button("조건 저장").disabled, false);
  assert.equal(ui.input("bookingDays").value, "31"); assert.equal(ui.input("firstDate").value, "2026-10-16");
  assert.equal(ui.nodes.has("rotation_adults"), false); assert.equal(ui.nodes.has("rotation_requestPacing"), false);
});
test("preview, save, start and pause are separate explicit mutations", async () => {
  const ui = await mockUi();
  await ui.button("배정표 미리보기").event("click");
  assert.equal(ui.calls.filter(call => call.method === "POST").length, 1); assert.equal(ui.calls.at(-1).url, "/api/collection-rotation/preview"); assert.equal(ui.state.enabled, false);
  assert.match(allText(ui.panel), /편집안 · 향후 7일 미리보기/); assert.match(allText(ui.panel), /실제 예약은 아닙니다/);
  await ui.change("bookingDays", "14"); assert.equal(ui.button("순환예약 시작").disabled, true);
  await ui.button("조건 저장").event("click"); assert.equal(ui.calls.find(call => call.method === "PUT").payload.collection.bookingDays, 14); assert.equal(ui.state.enabled, false);
  assert.equal(ui.button("순환예약 시작").disabled, false);
  await ui.button("순환예약 시작").event("click"); assert.equal(ui.state.enabled, true); assert.equal(ui.input("keywords").disabled, true); assert.equal(ui.button("일시정지").disabled, false);
  await ui.button("일시정지").event("click"); assert.equal(ui.state.enabled, false); assert.equal(ui.input("keywords").disabled, false);
  assert.deepEqual(ui.calls.filter(call => call.url.endsWith("/enabled")).map(call => call.payload), [{ enabled: true }, { enabled: false }]);
  assert.equal(ui.calls.some(call => /reset-halt|\/api\/crawl$|worker-schedule/.test(call.url)), false);
});
test("late preview after a draft edit is not rendered as the current plan", async () => {
  const gate = deferred(), ui = await mockUi({ previewGate: gate });
  const pending = ui.button("배정표 미리보기").event("click"); await until(() => ui.calls.some(call => call.url.endsWith("/preview")));
  await ui.change("ranks", "1-5"); gate.resolve(); await pending;
  assert.doesNotMatch(allText(ui.panel), /편집안 · 향후 7일 미리보기/); assert.match(allText(ui.panel), /배정표 확인 필요/);
  assert.equal(ui.button("순환예약 시작").disabled, true);
});
test("authentication read failure disables reservation writes and logout removes stored data", async () => {
  const failed = await mockUi({ readFailure: true });
  assert.equal(failed.button("조건 저장").disabled, true); assert.equal(failed.button("순환예약 시작").disabled, true); assert.match(allText(failed.panel), /관리자 로그인이 필요/);
  const ui = await mockUi(); assert.match(allText(ui.panel), /경남글램핑/);
  ui.body.className = ""; ui.observers[0].callback(); assert.equal(ui.input("keywords").value, ""); assert.doesNotMatch(allText(ui.panel), /다음 순환 위치 · 경남글램핑/); assert.equal(ui.button("조건 저장").disabled, true);
});
test("same-day reused result remains distinct from a new collection and actual start is explicit", () => {
  assert.equal(helpers.planLabel({ config: {}, enabled: false, active: true }), "일시정지 · 진행 작업 마무리 중");
  assert.match(helpers.reasonText("COLLECTION_ROTATION_INDIVIDUAL_ACTIVE"), /개별 예약/);
  assert.match(helpers.reasonText("COLLECTOR_PROVIDER_BLOCKED"), /접근 제한/);
  assert.match(helpers.reasonText("ROTATION_UNRESOLVED_EXECUTION"), /자동으로 다시 수집하지/);
});

test("one-day trial preview shows six then four without editing or disabling the saved four-slot plan", async () => {
  const ui = await mockUi({ trialSupported: true }), original = clone(ui.state.config);
  assert.equal(ui.input("trialDay").value, "2026-10-16");
  assert.equal(ui.button("하루 시험 등록").disabled, true);
  await ui.button("시험 배정표 미리보기").event("click");
  const request = ui.calls.at(-1);
  assert.equal(request.url, "/api/collection-rotation/trial/preview");
  assert.deepEqual(request.payload, { day: "2026-10-16", expectedRevision: 1, expectedPlanHash: "a".repeat(64) });
  const trial = ui.nodes.get("rotationOneDayTrial"), tables = descendants(trial).filter(el => el.tagName === "TBODY");
  assert.deepEqual(tables.map(table => table.children.length), [6, 4]);
  assert.match(allText(trial), /2026-10-16 하루 6회 → 2026-10-17부터 기본 4회/);
  assert.equal(ui.input("webLimit").value, "2"); assert.equal(ui.input("manualLimit").value, "2");
  assert.deepEqual(ui.state.config, original); assert.equal(ui.state.enabled, true);
  assert.equal(ui.button("하루 시험 등록").disabled, false);
  assert.equal(ui.calls.some(call => call.method === "PUT" || call.url.endsWith("/enabled")), false);
});

test("one-day registration suppresses duplicate clicks and preserves baseline config and cursor", async () => {
  const gate = deferred(), ui = await mockUi({ trialSupported: true, trialWriteGate: gate });
  const original = clone({ config: ui.state.config, cursor: ui.state.cursor, revision: ui.state.revision });
  await ui.button("시험 배정표 미리보기").event("click");
  const pending = ui.button("하루 시험 등록").event("click");
  await until(() => ui.calls.some(call => call.url === "/api/collection-rotation/trial"));
  await ui.button("하루 시험 등록").event("click"); gate.resolve(); await pending;
  assert.equal(ui.calls.filter(call => call.url === "/api/collection-rotation/trial").length, 1);
  assert.equal(ui.state.oneDayTrial.status, "armed");
  assert.deepEqual(clone({ config: ui.state.config, cursor: ui.state.cursor, revision: ui.state.revision }), original);
  assert.match(allText(ui.nodes.get("rotationOneDayTrial")), /등록됨 · 아직 미배정/);
  assert.equal(ui.button("미배정 시험 취소").disabled, false); assert.equal(ui.button("하루 시험 등록").disabled, true);
  assert.equal(ui.calls.some(call => /\/enabled$|reset-halt|\/api\/crawl$/.test(call.url)), false);
});

test("cancelling a future unallocated trial keeps a protective pause and existing base plan intact", async () => {
  const ui = await mockUi({ trialSupported: true });
  await ui.button("시험 배정표 미리보기").event("click"); await ui.button("하루 시험 등록").event("click");
  ui.state.enabled = false; ui.state.config.enabled = false; ui.state.reason = "COLLECTOR_PROVIDER_BLOCKED"; ui.state.planState = "paused";
  await ui.button("상태 새로고침").event("click");
  const original = clone({ config: ui.state.config, cursor: ui.state.cursor, reason: ui.state.reason }), before = ui.calls.length;
  assert.equal(ui.button("미배정 시험 취소").disabled, false);
  await ui.button("미배정 시험 취소").event("click");
  const request = ui.calls.slice(before).find(call => call.method === "POST");
  assert.equal(request.url, "/api/collection-rotation/trial/cancel");
  assert.deepEqual(request.payload, { trialId: "trial-local-test", expectedRevision: 1, expectedPlanHash: "a".repeat(64) });
  assert.equal(ui.state.oneDayTrial.status, "cancelled"); assert.equal(ui.state.enabled, false);
  assert.deepEqual(clone({ config: ui.state.config, cursor: ui.state.cursor, reason: ui.state.reason }), original);
  assert.match(allText(ui.panel), /접근 제한/);
  assert.equal(ui.calls.slice(before).some(call => /\/enabled$|reset-halt|\/api\/crawl$/.test(call.url)), false);
});

test("draft edits, day changes and base revision changes invalidate only the trial preview", async () => {
  const ui = await mockUi({ trialSupported: true });
  await ui.button("시험 배정표 미리보기").event("click");
  ui.state.enabled = false; ui.state.config.enabled = false; await ui.button("상태 새로고침").event("click");
  await ui.change("bookingDays", "14"); await ui.change("startKeyword", "부산글램핑");
  await ui.button("상태 새로고침").event("click");
  assert.equal(ui.input("bookingDays").value, "14"); assert.equal(ui.input("startKeyword").value, "부산글램핑");
  assert.equal(ui.button("하루 시험 등록").disabled, true); assert.equal(ui.button("시험 배정표 미리보기").disabled, true);
  assert.equal(descendants(ui.nodes.get("rotationOneDayTrial")).filter(el => el.tagName === "TABLE").length, 0);
  const clean = await mockUi({ trialSupported: true });
  await clean.button("시험 배정표 미리보기").event("click"); await clean.change("trialDay", "2026-10-17");
  assert.equal(clean.button("하루 시험 등록").disabled, true); assert.equal(clean.input("webLimit").value, "2");
  await clean.button("시험 배정표 미리보기").event("click"); clean.state.revision++; clean.state.basePlanHash = "b".repeat(64);
  await clean.button("상태 새로고침").event("click");
  assert.equal(clean.button("하루 시험 등록").disabled, true);
  assert.equal(descendants(clean.nodes.get("rotationOneDayTrial")).filter(el => el.tagName === "TABLE").length, 0);
});

test("trial failures keep saved state visible and require a fresh read and preview before a new write", async () => {
  const ui = await mockUi({ trialSupported: true, trialFailure: { register: "ROTATION_TRIAL_PLAN_CHANGED" } });
  const before = clone(ui.state);
  await ui.button("시험 배정표 미리보기").event("click"); await ui.button("하루 시험 등록").event("click");
  assert.deepEqual(ui.state, before); assert.match(allText(ui.nodes.get("rotationOneDayTrial")), /기본 조건이 변경됐습니다/);
  assert.equal(ui.button("하루 시험 등록").disabled, true); assert.equal(ui.button("시험 배정표 미리보기").disabled, true);
  await ui.button("상태 새로고침").event("click");
  assert.equal(ui.button("시험 배정표 미리보기").disabled, false); assert.equal(ui.button("하루 시험 등록").disabled, true);
  assert.match(allText(ui.nodes.get("rotationOneDayTrial")), /기본 조건이 변경됐습니다/);
});

test("unsupported, unauthenticated and same-day trial states cannot register or reveal a stale preview", async () => {
  const unsupported = await mockUi(); assert.equal(unsupported.button("시험 배정표 미리보기").disabled, true);
  const failed = await mockUi({ readFailure: true, trialSupported: true }); assert.equal(failed.button("하루 시험 등록").disabled, true);
  const ui = await mockUi({ trialSupported: true }); await ui.change("trialDay", "2026-10-15");
  assert.equal(ui.button("시험 배정표 미리보기").disabled, true);
  await ui.change("trialDay", "2026-10-16"); await ui.button("시험 배정표 미리보기").event("click");
  ui.body.className = ""; ui.observers[0].callback();
  assert.equal(ui.nodes.get("rotationOneDayTrial").hidden, true);
  assert.equal(ui.button("하루 시험 등록").disabled, true); assert.equal(ui.button("미배정 시험 취소").disabled, true);
  assert.equal(descendants(ui.nodes.get("rotationOneDayTrial")).filter(el => el.tagName === "TABLE").length, 0);
  assert.doesNotMatch(allText(ui.nodes.get("rotationOneDayTrial")), /경남글램핑|2026-10-16 하루 6회/);
});

test("late trial preview cannot replace a newer date or an edited base draft", async () => {
  const gate = deferred(), ui = await mockUi({ trialSupported: true, trialPreviewGate: gate });
  const pending = ui.button("시험 배정표 미리보기").event("click");
  await until(() => ui.calls.some(call => call.url.endsWith("/trial/preview")));
  await ui.change("trialDay", "2026-10-17"); gate.resolve(); await pending;
  assert.equal(ui.button("하루 시험 등록").disabled, true);
  assert.equal(descendants(ui.nodes.get("rotationOneDayTrial")).filter(el => el.tagName === "TABLE").length, 0);
});

test("a future trial needing verification can be cancelled while allocated and past trials stay immutable", async () => {
  const ui = await mockUi({ trialSupported: true });
  await ui.button("시험 배정표 미리보기").event("click"); await ui.button("하루 시험 등록").event("click");
  ui.state.oneDayTrial.status = "needs_verification"; ui.state.enabled = false; ui.state.config.enabled = false;
  ui.state.reason = "ROTATION_TRIAL_PLAN_CHANGED"; ui.state.basePlanHash = "b".repeat(64); ui.state.revision++;
  await ui.button("상태 새로고침").event("click");
  assert.equal(ui.button("미배정 시험 취소").disabled, false);
  await ui.button("미배정 시험 취소").event("click");
  assert.equal(ui.state.oneDayTrial.status, "cancelled"); assert.equal(ui.state.enabled, false);
  assert.equal(ui.state.reason, "ROTATION_TRIAL_PLAN_CHANGED");
  ui.state.oneDayTrial.status = "allocated"; await ui.button("상태 새로고침").event("click");
  assert.equal(ui.button("미배정 시험 취소").disabled, true);
  ui.state.oneDayTrial.status = "armed"; ui.state.oneDayTrial.day = "2026-10-15"; await ui.button("상태 새로고침").event("click");
  assert.equal(ui.button("미배정 시험 취소").disabled, true);
});

test("a past allocated trial remains visible without blocking a later one-day preview", async () => {
  const ui = await mockUi({ trialSupported: true });
  ui.state.oneDayTrial = { trialId: "old-trial", day: "2026-10-14", returnDay: "2026-10-15", status: "allocated" };
  ui.state.oneDayTrials = [ui.state.oneDayTrial]; await ui.button("상태 새로고침").event("click");
  assert.match(allText(ui.nodes.get("rotationOneDayTrial")), /2026-10-14 · 배정 확정/);
  assert.equal(ui.button("미배정 시험 취소").disabled, true); assert.equal(ui.button("시험 배정표 미리보기").disabled, false);
  await ui.button("시험 배정표 미리보기").event("click");
  assert.equal(ui.button("하루 시험 등록").disabled, false);
});
