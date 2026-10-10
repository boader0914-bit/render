"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const helpers = require("../web/collector_controls.js");
const { workerLabel, workerState, workerAvailability, scheduleConfig, keywordSchedule, collectionDates, defaultDraft, historyEntries, filterHistory, keywordLines, errorMessage, progressModel, etaRange, qualityReason, diagnosticMetrics, diagnosticDates } = helpers;
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../web/collector_controls.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const keys = ["web", "manual", "scheduled"];
test("review and provider protection affect only their own worker", () => {
  const now=Date.now(), workers=keys.map(workerKey=>({workerKey,configured:true,connected:true,workerLastSeenAt:new Date(now).toISOString(),halted:workerKey==="manual",errorCode:workerKey==="manual"?"COLLECTOR_REVIEW_HOLD":""}));
  assert.equal(workerAvailability({workers},"manual",now).ready,false);
  assert.match(workerAvailability({workers},"manual",now).reason,/보호/);
  assert.equal(workerAvailability({workers},"web",now).ready,true);
  assert.equal(workerAvailability({workers},"scheduled",now).ready,true);
  workers[2].halted=true; workers[2].errorCode="COLLECTOR_PROVIDER_BLOCKED";
  assert.equal(workerAvailability({workers},"manual",now).ready,false);
  assert.equal(workerAvailability({workers},"scheduled",now).ready,false);
  assert.equal(workerAvailability({workers},"web",now).ready,true);
});
const config = { version: 1, enabled: false, timezone: "Asia/Seoul", repeat: "once", firstDate: "2026-09-25", time: "14:00", keywords: [], collection: { dateMode: "rolling", bookingDays: 7, checkIn: null, checkOut: null, adults: 2, detailRankRanges: "1-20", productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail", dayUseMode: "inspect" }, requestPacing: null };
class Element {
  constructor(tag, registry) { this.tagName = tag.toUpperCase(); this.registry = registry; this.children = []; this.listeners = {}; this.className = ""; this.value = ""; this.dataset = {}; this.style = {}; this.type = ""; this.disabled = false; this.hidden = false; this.textContent = ""; this.checked = false; this.classList = { contains: name => this.className.split(" ").includes(name) }; }
  set id(value) { this._id = value; this.registry.set(value, this); }
  get id() { return this._id; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) { for (const callback of this.listeners[event.type] || []) callback({ ...event, target: this }); return true; }
  closest() { return this.section || null; }
  scrollIntoView() {}
  reportValidity() { return true; }
  async event(type) { if (type === "click" && this.disabled) return; await Promise.all((this.listeners[type] || []).map(callback => callback({ preventDefault() {}, target: this }))); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const text = element => descendants(element).map(item => item.textContent).filter(Boolean).join(" ");
async function until(predicate) { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error("ui_condition_not_reached"); }
async function mockUi({ configs = {}, workers, requests = [], schedulePatch = {}, drafts = {}, failedSchedules = [], failRequests = false, uncertainSubmit = false, outsideCollection = false, diagnostics = {}, diagnosticStatus = 200, diagnosticRunId } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const el = new Element(match[1], nodes); el.id = match[2]; }
  const body = new Element("body", nodes); body.className = "role-admin";
  const section = new Element("section", nodes); section.className = outsideCollection ? "" : "active"; nodes.get("collectorControlsCard").section = section;
  const navigation = { clicks: 0, click() { this.clicks++; section.className = "active"; } };
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag, nodes), querySelector: () => navigation, addEventListener() {} };
  const saved = Object.fromEntries(keys.map(key => [key, clone(configs[key] || config)])); const calls = [], submissions = [], events = [], windowListeners = {};
  const storage = new Map([["staydatalab:collector-drafts:v2", JSON.stringify(drafts)]]);
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); }, dispatchEvent(event) { events.push(event); if (event.type === "collector:submit-card") { submissions.push(clone(event.detail.input)); event.detail.resolve({ status: "pending", submissionUncertain: uncertainSubmit }); } for (const fn of windowListeners[event.type] || []) fn(event); } };
  const fetch = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method: options.method, payload }); let result;
    if (url === "/api/collector-status") result = { workers: workers || keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString(), queued: 0 })) };
    else if (url === "/api/crawl-requests") { if (failRequests) throw Error("requests_unavailable"); result = { requests }; }
    else if (/^\/api\/runs\/[^/]+\/diagnostics$/.test(url)) {
      const runId = decodeURIComponent(url.split("/")[3]);
      assert.equal(options.method, "GET");
      return { ok: diagnosticStatus === 200, status: diagnosticStatus, json: async () => ({ runId: diagnosticRunId || runId, collectionDiagnostics: diagnostics[runId] || null }) };
    }
    else {
      const [route, query] = url.split("?"), key = new URLSearchParams(query).get("workerKey"); assert.ok(keys.includes(key), "every schedule operation must select a worker");
      if (failedSchedules.includes(key)) throw Error("schedule_unavailable");
      if (route === "/api/worker-schedule" && options.method === "PUT") saved[key] = { ...saved[key], ...payload };
      else if (route === "/api/worker-schedule/enabled") saved[key].enabled = payload.enabled;
      else assert.equal(options.method, "GET");
      result = { config: clone(saved[key]), enabled: saved[key].enabled, nextRunAt: saved[key].enabled ? "2026-09-25T05:00:00Z" : null, latest: [], ...schedulePatch[key] };
    }
    return { ok: true, status: 200, json: async () => result };
  };
  class UiEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  vm.runInNewContext(source, { document, fetch, window, console, setInterval() {}, MutationObserver: class { observe() {} disconnect() {} }, Event: UiEvent, CustomEvent: UiEvent, Date, Intl, Number, String, Object, Array, Set, Map, JSON, Promise, Error, Math });
  await until(() => events.some(event => event.type === "collector:worker-availability"));
  const card = key => nodes.get("collectorWorkerStates").children.find(node => node.dataset.workerKey === key);
  const form = key => descendants(card(key)).find(el => el.tagName === "FORM");
  const input = (key, name) => nodes.get(`collector-${key}-${name}`);
  const button = (key, label) => descendants(card(key)).find(el => el.tagName === "BUTTON" && el.textContent === label);
  async function set(key, name, value) { if (typeof value === "boolean") input(key, name).checked = value; else input(key, name).value = value; await form(key).event("change"); }
  return { nodes, calls, submissions, saved, events, window, storage, card, form, input, button, set, navigation };
}

test("drafts default to day-use presence check and inclusive lodging dates", () => {
  assert.equal(defaultDraft().dayUseMode, "inspect");
  assert.deepEqual(collectionDates({ period: "custom", checkIn: "2026-09-24", checkOut: "2026-09-24" }), { checkIn: "2026-09-24", checkOut: "2026-09-24", bookingDays: 1 });
  assert.equal(collectionDates({ period: "7" }, Date.parse("2026-09-24T06:00:00Z")).checkOut, "2026-09-30");
  assert.throws(() => collectionDates({ period: "custom", checkIn: "2026-02-30", checkOut: "2026-03-02" }));
  assert.equal(defaultDraft(Date.parse("2026-09-24T06:00:00Z")).firstDate, "2026-09-25");
});

test("past one-time reservations show an explanation and cannot activate", async () => {
  const ui = await mockUi(); await ui.set("manual", "keywords", "경남글램핑"); await ui.set("manual", "execution", "schedule"); await ui.set("manual", "firstDate", "2000-01-01");
  assert.equal(descendants(ui.card("manual")).find(el => el.type === "submit").disabled, true);
  assert.match(text(ui.card("manual")), /예약 시각이 지났습니다/);
  assert.equal(ui.calls.filter(call => call.method === "POST").length, 0);
});

test("schedule parser carries purpose/day-use but never overrides pacing or activation", () => {
  const parsed = scheduleConfig({ ...defaultDraft(), keywords: "포천글램핑\n포천글램핑\n포천 글램핑", dateMode: "rolling", days: 7 });
  assert.deepEqual(parsed.keywords, ["포천글램핑", "포천 글램핑"]); assert.equal(parsed.collection.collectionPurpose, "basic_db"); assert.equal(parsed.collection.dayUseMode, "inspect"); assert.equal(parsed.collection.adults, 2); assert.equal(parsed.requestPacing, null); assert.equal(Object.hasOwn(parsed, "enabled"), false);
  for (const patch of [{ time: "24:00" }, { ranks: "20-1" }, { firstDate: "2026-02-30" }]) assert.throws(() => scheduleConfig({ ...defaultDraft(), keywords: "가평글램핑", dateMode: "rolling", days: 7, ...patch }));
});

test("hourly keyword schedules preserve order, deduplicate and remain in the execution day", () => {
  const values = { ...defaultDraft(), keywords: Array.from({ length: 7 }, (_, i) => `검수${i + 1}글램핑`).join("\n"), time: "11:00", keywordIntervalMinutes: "60", days: 7 };
  assert.equal(scheduleConfig(values).keywordIntervalMinutes, 60);
  assert.deepEqual(keywordSchedule(values).items.map(item => item.time), ["11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
  assert.deepEqual(keywordSchedule({ ...values, keywords: "가평글램핑\n가평글램핑\n포천글램핑" }).items, [{ keyword: "가평글램핑", time: "11:00" }, { keyword: "포천글램핑", time: "12:00" }]);
  for (const interval of [-1, 0.5, 1441, "invalid", ""]) assert.throws(() => scheduleConfig({ ...values, keywordIntervalMinutes: interval }), /키워드 간격/);
  assert.throws(() => scheduleConfig({ ...values, time: "18:00" }), /다음 날/);
  assert.equal(keywordSchedule({ ...values, keywords: "가평글램핑\n포천글램핑", time: "23:58", keywordIntervalMinutes: 1 }).items[1].time, "23:59");
  assert.equal(scheduleConfig({ ...values, keywords: "가평글램핑", keywordIntervalMinutes: 1440 }).keywordIntervalMinutes, 1440);
  delete values.keywordIntervalMinutes;
  assert.equal(scheduleConfig(values).keywordIntervalMinutes, 0);
  assert.equal(keywordSchedule(values).items[1].time, "앞 키워드 완료 후");
});

test("hourly reservation previews save and reload without activating or changing other workers", async () => {
  const ui = await mockUi();
  await ui.set("manual", "keywords", Array.from({ length: 7 }, (_, i) => `검수${i + 1}글램핑`).join("\n"));
  await ui.set("manual", "execution", "schedule"); await ui.set("manual", "firstDate", defaultDraft(Date.now() + 86400000).firstDate); await ui.set("manual", "time", "11:00"); await ui.set("manual", "keywordIntervalMinutes", "60");
  const table = descendants(ui.card("manual")).find(el => el.className === "collector-keyword-schedule");
  assert.equal(table.hidden, false); assert.equal(table.children[1].children.length, 7);
  assert.match(text(table), /검수1글램핑 11:00/); assert.match(text(table), /검수7글램핑 17:00/);
  assert.match(text(ui.card("manual")), /1시간 간격/); assert.match(text(ui.card("manual")), /예정 시각보다 늦어질 수 있습니다/);
  assert.ok(ui.calls.every(call => call.method === "GET"));
  const localReload = await mockUi({ drafts: JSON.parse(ui.storage.get("staydatalab:collector-drafts:v2")) });
  assert.equal(Number(localReload.input("manual", "keywordIntervalMinutes").value), 60);
  assert.equal(Number(localReload.input("scheduled", "keywordIntervalMinutes").value), 0);
  await ui.button("manual", "예약 조건 저장").event("click"); await until(() => text(ui.card("manual")).includes("예약 조건을 저장했습니다"));
  assert.equal(ui.saved.manual.keywordIntervalMinutes, 60); assert.equal(ui.saved.manual.enabled, false);
  assert.equal(ui.calls.filter(call => call.method !== "GET").length, 1);
  const savedReload = await mockUi({ configs: { manual: ui.saved.manual } });
  assert.equal(Number(savedReload.input("manual", "keywordIntervalMinutes").value), 60);
  await savedReload.set("manual", "execution", "schedule");
  assert.match(text(savedReload.card("manual")), /검수7글램핑 17:00/);
  assert.equal(ui.submissions.length, 0);
});

test("active six-hour reservations show their receipt progress instead of an expired first slot", async () => {
  const configured = { ...clone(config), enabled: true, firstDate: "2026-10-10", time: "11:00", keywordIntervalMinutes: 60, keywords: ["완료키워드", "진행키워드", "마지막키워드"] };
  const patch = { enabled: true, active: true, expired: true, nextRunAt: null, activeOccurrenceIds: ["scheduled_2026-10-10"], latest: [
    { id: "unrelated-receipt", status: "running", items: [{ keyword: "다른실행", status: "running" }] },
    { id: "scheduled_2026-10-10", status: "running", items: [{ keyword: "완료키워드", status: "complete", scheduledAt: "2026-10-10T02:00:00Z" }, { keyword: "진행키워드", status: "running", scheduledAt: "2026-10-10T07:00:00Z" }, { keyword: "마지막키워드", status: "queued", scheduledAt: "2026-10-10T08:00:00Z" }] }
  ] };
  const statusText = ui => descendants(ui.card("manual")).find(el => el.className === "collector-card-status").children[1].textContent;
  const running = await mockUi({ configs: { manual: configured }, schedulePatch: { manual: patch } });
  assert.match(statusText(running), /예약 진행 중 · 진행키워드/);
  assert.match(statusText(running), /다음 키워드 예정 .*17:00 · 마지막키워드/);
  assert.doesNotMatch(statusText(running), /예약 날짜 확인 필요|다른실행/);
  const waitingPatch = clone(patch); waitingPatch.latest[1].items[1].status = "complete";
  const waiting = await mockUi({ configs: { manual: configured }, schedulePatch: { manual: waitingPatch } });
  assert.match(statusText(waiting), /예약 진행 중 · 다음 키워드 예정 .*17:00 · 마지막키워드/);
  assert.doesNotMatch(statusText(waiting), /예약 날짜 확인 필요|진행키워드|다른실행/);
  const finished = await mockUi({ configs: { manual: configured }, schedulePatch: { manual: { ...waitingPatch, active: false, activeOccurrenceIds: [] } } });
  assert.match(statusText(finished), /예약 날짜 확인 필요/);
  for (const ui of [running, waiting, finished]) { assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0); }
});

test("next-day keyword plans block saving and activation but do not block immediate work", async () => {
  const ui = await mockUi(); await ui.set("manual", "keywords", "가평글램핑\n포천글램핑");
  await ui.set("manual", "execution", "schedule"); await ui.set("manual", "time", "23:00"); await ui.set("manual", "keywordIntervalMinutes", "60");
  assert.equal(ui.button("manual", "예약 조건 저장").disabled, true);
  assert.equal(descendants(ui.card("manual")).find(el => el.type === "submit").disabled, true);
  assert.match(text(ui.card("manual")), /마지막 키워드의 예정 시각이 다음 날/);
  const reservation = descendants(ui.card("manual")).find(el => el.className === "collector-reservation"); reservation.open = false;
  for (const callback of ui.form("manual").listeners.invalid) callback({ target: ui.input("manual", "keywordIntervalMinutes") });
  assert.equal(reservation.open, true);
  await ui.form("manual").event("submit"); await until(() => text(ui.card("manual")).includes("다음 날"));
  assert.ok(ui.calls.every(call => call.method === "GET"));
  await ui.set("manual", "keywordIntervalMinutes", "1440"); await ui.set("manual", "execution", "now");
  assert.equal(ui.input("manual", "keywordIntervalMinutes").disabled, true);
  await ui.form("manual").event("submit"); await until(() => ui.submissions.length === 2);
  assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("three independent cards load by GET only, using approved names and default day-use", async () => {
  const ui = await mockUi(); assert.equal(ui.nodes.get("collectorWorkerStates").children.length, 3); assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.deepEqual(keys.map(workerLabel), ["2Gweb_worker", "BG worker", "AWS worker"]);
  for (const key of keys) { assert.match(text(ui.card(key)), new RegExp(workerLabel(key))); assert.equal(ui.input(key, "dayUseMode").value, "inspect"); assert.equal(ui.button(key, "지금 수집").disabled, false); }
  assert.equal(ui.calls.filter(call => call.url.startsWith("/api/worker-schedule?")).length, 3);
});

test("saved reservations open as a folded summary and toggling never changes the schedule", async () => {
  const configured = { ...clone(config), enabled: true, firstDate: defaultDraft().firstDate, keywords: ["산청글램핑"], time: "13:25", repeat: "weekdays" };
  const ui = await mockUi({ configs: { scheduled: configured } });
  const reservation = descendants(ui.card("scheduled")).find(el => el.className === "collector-reservation");
  assert.equal(reservation.tagName, "DETAILS"); assert.equal(Boolean(reservation.open), false); assert.equal(reservation.hidden, false);
  const summary = reservation.children[0];
  assert.equal(summary.tagName, "SUMMARY"); assert.match(text(summary), /13:25 KST · 평일 · 월~금/);
  assert.match(text(summary), new RegExp(configured.firstDate.replace(/-/g, "\\.")));
  const before = clone(ui.saved.scheduled);
  reservation.open = true; await reservation.event("toggle"); reservation.open = false; await reservation.event("toggle");
  assert.deepEqual(ui.saved.scheduled, before); assert.ok(ui.calls.every(call => call.method === "GET"));
  await ui.set("scheduled", "time", "15:40");
  assert.match(text(summary), /15:40 KST/);
  assert.equal(ui.saved.scheduled.time, "13:25", "editing the folded form remains a local draft until explicit save");
  assert.equal(ui.input("manual", "time").value, "14:00");
});

test("invalid fields reveal their folded section and progress remains above common fields", async () => {
  const ui = await mockUi();
  await ui.set("manual", "execution", "schedule");
  const card = ui.card("manual"), form = ui.form("manual");
  const reservation = descendants(card).find(el => el.className === "collector-reservation");
  reservation.open = false;
  for (const callback of form.listeners.invalid) callback({ target: ui.input("manual", "firstDate") });
  assert.equal(reservation.open, true, "browser validation must be able to focus the invalid date inside details");
  reservation.open = false;
  for (const callback of form.listeners.change) callback({ target: ui.input("manual", "execution") });
  assert.equal(reservation.open, true, "choosing reservation mode exposes its editing controls");
  const commonIndex = form.children.findIndex(el => el.className === "collector-common-fields");
  assert.ok(commonIndex > form.children.findIndex(el => el.className === "collector-live-progress"));
  assert.ok(commonIndex > form.children.findIndex(el => el.className === "collector-card-status"));
  assert.equal(form.children.at(-1).className, "collector-card-footer");
  const footer = form.children.at(-1);
  assert.equal(footer.children[0].className, "collector-card-actions");
  assert.equal(footer.children.at(-1).className, "collector-last-result");
  await ui.set("manual", "execution", "now");
  const repeat = descendants(card).find(el => el.className === "collector-repeat-options"); repeat.open = false;
  for (const callback of form.listeners.invalid) callback({ target: ui.input("manual", "repeatReason") });
  assert.equal(repeat.open, true);
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
});

test("card drafts do not leak into other workers and survive a reload", async () => {
  const ui = await mockUi(); await ui.set("manual", "keywords", "경남글램핑"); await ui.set("manual", "period", "14"); await ui.set("scheduled", "keywords", "포천글램핑");
  assert.equal(ui.input("web", "keywords").value, ""); assert.equal(ui.input("scheduled", "period").value, "7");
  const drafts = JSON.parse(ui.storage.get("staydatalab:collector-drafts:v2")); const second = await mockUi({ drafts }); assert.equal(second.input("manual", "keywords").value, "경남글램핑"); assert.equal(second.input("manual", "period").value, "14");
});

test("immediate single day preserves tomorrow checkout transport with bookingDays one", async () => {
  const ui = await mockUi(); await ui.set("web", "keywords", "시즌글램핑"); await ui.set("web", "period", "1"); await ui.set("web", "purpose", "revenue_detail"); await ui.set("web", "dayUseMode", "lodging_only");
  await ui.form("web").event("submit"); await until(() => ui.submissions.length === 1);
  const body = ui.submissions[0]; assert.equal(body.workerKey, "web"); assert.equal(body.dayUseMode, "lodging_only"); assert.equal(body.bookingRangeDays, 1); assert.equal(Date.parse(body.checkOut) - Date.parse(body.checkIn), 86400000); assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("uncertain immediate acknowledgement stops following keywords without automatic retry", async () => {
  const ui = await mockUi({ uncertainSubmit: true }); await ui.set("manual", "keywords", "경남글램핑\n포천글램핑"); await ui.form("manual").event("submit"); await until(() => text(ui.card("manual")).includes("후속 키워드 접수를 보류")); assert.equal(ui.submissions.length, 1);
});

test("all worker reservations save without activating, then register only selected worker", async () => {
  for (const key of keys) {
    const ui = await mockUi(); await ui.set(key, "keywords", "가평글램핑"); await ui.set(key, "execution", "schedule"); await ui.set(key, "firstDate", defaultDraft().firstDate);
    await ui.button(key, "예약 조건 저장").event("click"); await until(() => text(ui.card(key)).includes("예약 조건을 저장했습니다")); assert.equal(ui.saved[key].enabled, false); assert.equal(ui.calls.filter(call => call.method === "POST").length, 0);
    await ui.form(key).event("submit"); await until(() => ui.saved[key].enabled); const enabled = ui.calls.filter(call => call.url.startsWith("/api/worker-schedule/enabled")); assert.equal(enabled.length, 1); assert.equal(enabled[0].url, `/api/worker-schedule/enabled?workerKey=${key}`); assert.deepEqual(enabled[0].payload, { enabled: true });
    for (const other of keys.filter(other => other !== key)) assert.equal(ui.saved[other].enabled, false);
  }
});

test("each provider-protected worker stops only its own card while all schedules remain pausable", async () => {
  for (const held of keys) {
    const workers = keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString(), halted: workerKey === held, errorCode: workerKey === held ? "COLLECTOR_PROVIDER_BLOCKED" : "" }));
    const ui = await mockUi({ configs: { scheduled: { ...config, enabled: true } }, workers });
    for (const key of keys) assert.equal(descendants(ui.card(key)).find(el => el.type === "submit").disabled, key === held);
    assert.match(text(ui.card(held)), /네이버 접근 제한/);
    assert.doesNotMatch(text(ui.card(held)), /모든 수집기의 새 요청/);
    const unaffected = keys.find(key => key !== held && key !== "scheduled");
    await ui.set(unaffected, "keywords", "포천글램핑"); await ui.form(unaffected).event("submit"); await until(() => ui.submissions.length === 1);
    assert.equal(ui.submissions[0].workerKey, unaffected);
    assert.equal(ui.button("scheduled", "예약 일시정지").disabled, false); await ui.button("scheduled", "예약 일시정지").event("click"); await until(() => !ui.saved.scheduled.enabled);
  }
});

test("same-day review rejection is unexecuted, not a provider block or zero collection", async () => {
  const request = { workerKey: "web", keyword: "포천글램핑", status: "failed", errorCode: "COLLECTION_REVIEW_REQUIRED", createdAt: new Date().toISOString(), durationMs: 77 };
  const ui = await mockUi({ requests: [request] });
  const history = ui.nodes.get("collectorUnifiedHistory");
  assert.equal(descendants(history).find(el => el.className === "state-badge").textContent, "재수집 검토 필요 · 미실행");
  assert.match(text(history), /당일 동일 키워드.*네이버 요청 전에/);
  assert.doesNotMatch(text(history), /접근 제한|예약 일정 성공 0|정상 응답 0|실패/);
  assert.equal(descendants(history).filter(el => el.className === "collection-diagnostics").length, 0, "known preflight rejection needs no missing-result diagnosis");
  assert.equal(ui.calls.filter(call => call.url.endsWith("/diagnostics")).length, 0);
  const progress = progressModel({ workerKey: "web", configured: true, connected: true }, request);
  assert.equal(progress.eta, "재수집 검토 필요 · 미실행"); assert.equal(progress.state, "attention"); assert.equal(progress.active, false);
  assert.match(progress.detail, /네이버 요청 전에/); assert.equal(progress.runId, null);
  assert.match(errorMessage("BookingAPITooManyRequests"), /네이버 접근 제한/);
  assert.match(text(ui.card("web")), /선택한 워커의 당일 기록.*다른 워커의 자료를 자동 재사용하지 않으며/);
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
});

test("basic collection cannot request day-use reservation detail", async () => {
  const ui = await mockUi(); await ui.set("manual", "purpose", "revenue_detail"); await ui.set("manual", "dayUseMode", "detail"); assert.equal(ui.input("manual", "dayUseMode").value, "detail"); await ui.set("manual", "purpose", "basic_db"); assert.equal(ui.input("manual", "dayUseMode").value, "inspect"); assert.equal(ui.input("manual", "dayUseMode").children.find(option => option.value === "detail").disabled, true);
});

test("schedule read failure leaves immediate ready, and preserved old configs retain detailed day-use", async () => {
  const old = clone(config); delete old.collection.dayUseMode; old.keywords = ["포천글램핑"];
  const ui = await mockUi({ configs: { scheduled: old }, failedSchedules: ["web"] }); assert.equal(ui.button("web", "지금 수집").disabled, false); assert.equal(ui.input("scheduled", "dayUseMode").value, "detail"); await ui.set("web", "execution", "schedule"); assert.equal(descendants(ui.card("web")).find(el => el.type === "submit").disabled, true);
});

test("unified history filters preserve outcomes and open retained results without collection", async () => {
  const rows = [{ workerKey: "manual", keyword: "경남글램핑", status: "complete", createdAt: "2026-09-24T05:00:00Z", result: { runId: "kept_result" } }, { workerKey: "web", keyword: "포천글램핑", status: "blocked", createdAt: "2026-09-24T06:00:00Z", errorCode: "COLLECTOR_PROVIDER_BLOCKED" }];
  const ui = await mockUi({ requests: rows }); assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /경남글램핑.*BG worker/s); assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /접근 제한/);
  ui.nodes.get("collectorHistoryWorker").value = "manual"; await ui.nodes.get("collectorHistoryWorker").event("change"); assert.doesNotMatch(text(ui.nodes.get("collectorUnifiedHistory")), /포천글램핑/);
  await descendants(ui.nodes.get("collectorUnifiedHistory")).find(el => el.textContent === "결과 보기").event("click"); assert.equal(ui.events.at(-1).detail.runId, "kept_result"); assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.equal(filterHistory(historyEntries(rows), { worker: "all", keyword: "", date: "2026-09-24", state: "attention" }).length, 1);
});

test("read errors, freshness and broker failures remain distinguishable", async () => {
  const ui = await mockUi({ failRequests: true }); assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /읽지 못했습니다/); assert.equal(ui.button("manual", "지금 수집").disabled, false);
  assert.equal(workerState({ workerKey: "web", configured: true, connected: true, ready: false }), "실행 확인 필요");
  assert.equal(workerAvailability({ workers: [{ workerKey: "manual", configured: true, workerLastSeenAt: "2000-01-01T00:00:00Z" }] }, "manual").ready, false);
  assert.match(errorMessage("COLLECTOR_DUPLICATE_PATH"), /상세 파일 목록/); assert.deepEqual(keywordLines("Ａ\nA\n포천 글램핑\n포천글램핑"), ["A", "포천 글램핑", "포천글램핑"]);
});

test("partial quality reasons distinguish unqueried products, response failures and quantity review", () => {
  assert.equal(qualityReason({ status: "partial", reason: "product_targets_truncated" }), "상품 수 제한으로 일부 미수집");
  assert.match(qualityReason({ reason: "booking_schedule_responses_incomplete" }), /응답 미확보/);
  assert.match(qualityReason({ reason: "inventory_review_required" }), /수량 검토/);
  assert.match(qualityReason({ reason: "naver_schedule_blocked" }), /접근 제한/);
  assert.equal(qualityReason({ status: "partial", reason: "https://secret.example/token=never-show" }), "세부 원인 기록 확인 필요");
  assert.doesNotMatch(errorMessage("COLLECTOR_PROVIDER_CONNECTION_FAILED"), /접근 제한/);
  const rows = historyEntries([{ keyword: "전남글램핑", result: { runId: "partial", collectionQuality: { status: "partial", reason: "product_targets_truncated", counts: { naverScheduleFailed: 0 } } } }]);
  assert.equal(rows[0].collectionQuality.reason, "product_targets_truncated");
  assert.equal(rows[0].collectionQuality.counts.naverScheduleFailed, 0);
  assert.match(progressModel({ workerKey: "web", connected: true }, { ...rows[0], status: "partial" }).detail, /상품 수 제한/);
});

test("diagnostic counts retain zero versus missing and never multiply product counts by stay days", () => {
  const labels = diagnosticMetrics({ naverBookingStockSucceeded: 20, naverBookingStockChecked: 20, naverScheduleSucceeded: 100, naverScheduleRequested: 100, naverScheduleFailed: 0, naverScheduleBlocked: null, productEligible: 62, productQueried: 40, productTruncated: 22 });
  assert.match(labels.join(" "), /업체 응답 성공 20 \/ 확인 20/);
  assert.match(labels.join(" "), /실패 0 · 차단 미기록/);
  assert.match(labels.join(" "), /대상 상품 62개 · 조회 40개 · 수 제한으로 미조회 22개/);
  assert.equal(diagnosticDates(["2026-09-29", "2026-09-27", "2026-09-28", "2026-09-27"]), "2026-09-27 ~ 2026-09-29 (3일)");
  assert.equal(diagnosticDates(["2026-09-27", "2026-09-29", "2026-09-30"]), "2026-09-27, 2026-09-29, 2026-09-30");
  assert.equal(diagnosticDates(["2026-02-30", "2026-09-27T01:00:00Z"]), "세부 기록 없음");
});

test("history diagnostics load only on expansion, preserve safe detail and reuse the same stored response", async () => {
  const quality = { status: "partial", reason: "product_targets_truncated", counts: { naverBookingStockChecked: 20, naverBookingStockSucceeded: 20, naverScheduleRequested: 100, naverScheduleSucceeded: 100, naverScheduleFailed: 0, naverScheduleBlocked: 0 } };
  const diagnostic = { ...quality, summary: "상품 수 제한으로 일부 상세 조회 제외 · 확인 대상 업체 1곳", observedZeroScheduleCount: 2, failedZeroScheduleCount: 0, counts: { ...quality.counts, productEligible: 62, productQueried: 40, productTruncated: 22 },
    issues: [{ code: "PRODUCT_TARGETS_TRUNCATED", phase: "product_list", label: "상품 수 제한으로 상세 조회 제외", message: "상품 수 제한으로 상세 조회 제외", companyName: "대상 글램핑", productName: "", expectedCount: 62, queriedCount: 40, affectedCount: 22, countUnit: "products", detailStatus: "recorded", dates: ["2026-09-27", "2026-09-28", "2026-09-29"], rawError: "SECRET_TOKEN", requestedAt: "2026-09-27T01:00:00Z" }] };
  const ui = await mockUi({ requests: [{ workerKey: "manual", keyword: "전남글램핑", status: "partial", result: { runId: "partial_run", collectionQuality: quality } }], diagnostics: { partial_run: diagnostic } });
  const history = ui.nodes.get("collectorUnifiedHistory");
  assert.match(text(history), /상품 수 제한으로 일부 미수집/);
  assert.equal(ui.calls.filter(call => call.url.endsWith("/diagnostics")).length, 0);
  let card = descendants(history).find(el => el.className === "collection-diagnostics");
  card.open = true; await card.event("toggle");
  assert.match(text(card), /대상 62개 상품 · 조회 40개 · 수 제한으로 미조회 22개/);
  assert.match(text(card), /상품별 이름은 미기록/);
  assert.match(text(card), /2026-09-27 ~ 2026-09-29 \(3일\)/);
  assert.match(text(card), /정상 응답 2건 · 오류가 동반된 0 0건/);
  assert.match(text(card), /실패 0 · 차단 0/);
  assert.doesNotMatch(text(card), /SECRET_TOKEN|T01:00:00Z|HTTP|차단 감지/);
  assert.equal(descendants(card).filter(el => el.textContent === diagnostic.issues[0].label).length, 1);
  card.open = false; await card.event("toggle"); card.open = true; await card.event("toggle");
  await ui.nodes.get("collectorHistoryWorker").event("change");
  card = descendants(history).find(el => el.className === "collection-diagnostics");
  await until(() => text(card).includes("미조회 22개"));
  assert.equal(card.open, true);
  assert.equal(ui.calls.filter(call => call.url.endsWith("/diagnostics")).length, 1);
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
});

test("legacy failures show absent details without inventing block reasons or zero successes", async () => {
  const ui = await mockUi({ requests: [{ workerKey: "manual", keyword: "충남글램핑", status: "partial", result: { runId: "legacy", collectionQuality: { status: "partial" } } }], diagnostics: { legacy: { status: "partial", summary: "일부 업체의 예약 상세 미확보", counts: {}, issues: [{ label: "예약 응답 미확보", companyName: "업체 가", productName: "상품 나", httpStatus: 503, dates: ["2026-09-27"], detailStatus: "unrecorded", message: "세부 응답 원인은 기록되지 않았습니다." }] } } });
  const card = descendants(ui.nodes.get("collectorUnifiedHistory")).find(el => el.className === "collection-diagnostics");
  card.open = true; await card.event("toggle");
  assert.match(text(card), /업체 응답 성공 미기록 \/ 확인 미기록/);
  assert.match(text(card), /세부 기록 없음 · 개별 응답 원인을 확정할 수 없습니다/);
  assert.match(text(card), /응답 상태 HTTP 503/);
  assert.doesNotMatch(text(card), /접근 제한 감지|세부 응답 원인은 기록되지 않았습니다/);
  const unavailable = await mockUi({ requests: [{ workerKey: "web", keyword: "저장 안 된 실패", status: "failed" }] });
  const emptyCard = descendants(unavailable.nodes.get("collectorUnifiedHistory")).find(el => el.className === "collection-diagnostics"); emptyCard.open = true; await emptyCard.event("toggle");
  assert.match(text(emptyCard), /세부 기록 없음/);
  assert.equal(unavailable.calls.filter(call => call.url.endsWith("/diagnostics")).length, 0);
});

test("diagnostic read errors require explicit retry and mismatched runs never display", async () => {
  const request = { workerKey: "manual", keyword: "경주글램핑", status: "partial", result: { runId: "run_requested", collectionQuality: { status: "partial" } } };
  const ui = await mockUi({ requests: [request], diagnosticStatus: 403 });
  const history = ui.nodes.get("collectorUnifiedHistory");
  let card = descendants(history).find(el => el.className === "collection-diagnostics"); card.open = true; await card.event("toggle");
  assert.match(text(card), /관리자 로그인을 확인/);
  await ui.nodes.get("collectorHistoryWorker").event("change");
  card = descendants(history).find(el => el.className === "collection-diagnostics"); await until(() => text(card).includes("다시 확인"));
  assert.equal(ui.calls.filter(call => call.url.endsWith("/diagnostics")).length, 1);
  await descendants(card).find(el => el.textContent === "다시 확인").event("click");
  assert.equal(ui.calls.filter(call => call.url.endsWith("/diagnostics")).length, 2);
  const wrong = await mockUi({ requests: [request], diagnosticRunId: "other_run", diagnostics: { run_requested: { summary: "OTHER COMPANY SECRET" } } });
  const wrongCard = descendants(wrong.nodes.get("collectorUnifiedHistory")).find(el => el.className === "collection-diagnostics"); wrongCard.open = true; await wrongCard.event("toggle");
  assert.match(text(wrongCard), /결과 번호가 일치하지/); assert.doesNotMatch(text(wrongCard), /OTHER COMPANY/);
});

test("HTML hides compatibility form, loads workspace once and supports retained DB recrawl bridge", () => {
  assert.match(html, /id="crawlForm" hidden aria-hidden="true"/); assert.doesNotMatch(html, /id="workerScheduleForm"/); assert.match(html, /collector-controls\.css/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
  for (const match of source.matchAll(/byId\("([^"]+)"\)/g)) assert.ok(ids.includes(match[1]), `missing_html_id_${match[1]}`);
  assert.match(app, /collector:submit-card/); assert.match(app, /collectorCardSubmissionQueue\.then/); assert.match(app, /collector:prepare-card/); assert.match(app, /request\.submissionUncertain = true/);
});

test("new day-use presence never turns unqueried detail into an absent-product sales pitch", () => {
  const start = app.indexOf("function companyDayUseAbsentForProposal(");
  const end = app.indexOf("function companyReviewContextFromButton(", start);
  const context = {};
  vm.runInNewContext(app.slice(start, end), context);
  for (const presence of ["present", "unknown"]) {
    const company = { inventory: { latest: { salesSignal: { dayUsePresence: presence, dayUseMissing: true, dayUseObserved: false } } }, salesTarget: { signals: { dayUseMissing: true }, priorityTags: ["캠프닉 추가"] } };
    assert.equal(context.companyDayUseAbsentForProposal(company, true), false);
    assert.equal(context.companySalesAction(company).label, "상품 재정리");
  }
  const absent = { inventory: { latest: { salesSignal: { dayUsePresence: "absent", dayUseMissing: true } } }, salesTarget: { signals: { dayUseMissing: true } } };
  assert.equal(context.companySalesAction(absent).label, "캠프닉 추가");
  assert.equal(context.companySalesAction({ salesTarget: { signals: { dayUseMissing: true } } }).label, "캠프닉 추가");
  assert.equal(context.companySalesAction({ salesTarget: { signals: { dayUseMissing: false } } }).label, "상품 재정리");
  assert.ok(!/if \(signals\.dayUseMissing\s*\|\|/.test(app));
});

function progressWorker(now = Date.now(), patch = {}) {
  return { workerKey: "manual", configured: true, ready: true, workerLastSeenAt: new Date(now - 1000).toISOString(), activeJobId: "test-job", crawl: { active: true, elapsedSeconds: 120, remainingSeconds: 300, estimatedTotalSeconds: 420, estimatedProgress: 91, estimatedCompleteAt: new Date(now + 300000).toISOString(), stageSource: "runtime", currentStage: { key: "inventory" }, lastProgressAt: new Date(now - 1000).toISOString(), activeJob: { keyword: "경남글램핑" }, progress: { version: 1, source: "actual", phase: "inventory", completedPlaces: 12, totalPlaces: 20, currentPlaceName: "검수용 숙소", receivedAt: new Date(now - 1000).toISOString() }, ...patch } };
}

test("ETA uses an explicitly approximate range while actual counts ignore time-based percentages", () => {
  const now = Date.parse("2026-09-24T10:00:00Z"), worker = progressWorker(now), model = progressModel(worker, null, now, now);
  assert.equal(etaRange(300), "약 4~6분"); assert.equal(etaRange(299), "약 4~6분"); assert.equal(etaRange(0), "응답 확인 중");
  assert.equal(model.percent, 60); assert.equal(model.countText, "12 / 20곳 처리"); assert.equal(model.eta, "약 4~6분"); assert.equal(model.animated, true); assert.equal(model.phase, 1);
  assert.match(model.detail, /실패한 업체가 포함/);
  const unknown = progressModel(progressWorker(now, {progress: null}), null, now, now); assert.equal(unknown.percent, null); assert.equal(unknown.countText, "처리 수량 확인 중");
});

test("100 percent of places processed is still saving until a verified terminal receipt", () => {
  const now = Date.now(), worker = progressWorker(now); worker.crawl.progress.completedPlaces = 20; worker.crawl.currentStage.key = "uploading";
  let model = progressModel(worker, {status:"complete",runId:"earlier-result"}, now, now);
  assert.equal(model.percent, 100); assert.equal(model.state, "running"); assert.equal(model.phase, 2); assert.equal(model.runId, null); assert.doesNotMatch(model.eta, /완료/);
  const inactive = {...worker,activeJobId:null,crawl:{active:false}};
  model = progressModel(inactive, {status:"complete",result:{runId:"validated-run",collectionQuality:{status:"complete"}}}, now, now);
  assert.equal(model.state, "complete"); assert.equal(model.animated, false); assert.equal(model.eta, "저장·검증 완료");
  model = progressModel(inactive, {status:"complete",result:{runId:"unchecked-run"}}, now, now);
  assert.equal(model.state,"attention"); assert.equal(model.eta,"정상 저장 확인 필요"); assert.equal(model.runId,null);
});

test("stale responses, no new progress, zero ETA, block and cancellation stop movement", () => {
  const now = Date.now(), base = progressWorker(now);
  for (const [worker, receivedAt, expected] of [
    [{...base, workerLastSeenAt:new Date(now - 100000).toISOString()}, now, "연결 확인 필요"],
    [base, now - 31000, "연결 확인 필요"],
    [{...base,crawl:{...base.crawl,lastProgressAt:new Date(now - 100000).toISOString(),progress:{...base.crawl.progress,receivedAt:new Date(now - 100000).toISOString()}}},now,"응답 확인 중"],
    [{...base,crawl:{...base.crawl,remainingSeconds:0}},now,"예상보다 지연"],
    [{...base,halted:true,errorCode:"COLLECTOR_PROVIDER_BLOCKED"},now,"수집 중단"],
    [{...base,crawl:{...base.crawl,cancelling:true}},now,"중단 처리 중"]
  ]) { const model=progressModel(worker,null,now,receivedAt); assert.equal(model.animated,false); assert.equal(model.eta,expected); assert.equal(model.completeAt,""); }
});

test("estimated stages and invalid counters never become measured progress", () => {
  const now=Date.now(), worker=progressWorker(now,{stageSource:"estimate",progress:null});
  assert.equal(progressModel(worker,null,now,now).phase,-1);
  for (const patch of [{completedPlaces:21},{completedPlaces:-1},{totalPlaces:0},{source:"estimate"},{completedPlaces:12.5}]) {
    const sample=progressWorker(now); sample.crawl.progress={...sample.crawl.progress,...patch}; assert.equal(progressModel(sample,null,now,now).percent,null);
  }
});

test("worker card exposes measured meter and collapsed summary with accessible stage status", async () => {
  const ui=await mockUi({workers:[progressWorker()]}); const card=ui.card("manual");
  const panel=descendants(card).find(el=>el.className==="collector-live-progress"), meter=descendants(card).find(el=>el.className==="collector-actual-meter");
  assert.equal(panel.hidden,false); assert.equal(panel.dataset.animated,"true"); assert.equal(meter["aria-valuenow"],"12"); assert.equal(meter["aria-valuemax"],"20"); assert.equal(meter.children[0].style.width,"60%");
  assert.match(text(panel),/약 4~6분/); assert.doesNotMatch(text(panel),/91%/);
  const summary=descendants(card).find(el=>el.className==="collector-summary-progress"); assert.match(summary.textContent,/경남글램핑.*약 4~6분/); assert.equal(summary.hidden,false);
  assert.ok(descendants(panel).some(el=>el["aria-live"]==="polite"));
});

test("compact monitor follows the existing collection navigation without issuing collection requests", async () => {
  const worker=progressWorker(), ui=await mockUi({workers:[worker],outsideCollection:true}); const monitor=ui.nodes.get("collectorCompactProgress");
  assert.equal(monitor.hidden,false); assert.match(text(monitor),/BG worker.*경남글램핑.*약 4~6분/);
  const focusedButton=descendants(monitor).find(el=>el.className==="collector-compact-row");
  worker.crawl.remainingSeconds=120; await ui.nodes.get("collectorRefresh").event("click");
  assert.equal(descendants(monitor).find(el=>el.className==="collector-compact-row"),focusedButton,"status refresh must preserve keyboard focus identity");
  assert.match(text(monitor),/약 2~3분/);
  await focusedButton.event("click"); assert.equal(ui.navigation.clicks,1); assert.ok(ui.calls.every(call=>call.method==="GET")); assert.equal(ui.submissions.length,0);
});

test("worker cards send and restore the selected company search mode", async () => {
  const ui=await mockUi();
  for(const key of keys) {
    assert.equal(ui.input(key,"searchMode").value,"keyword");
    await ui.set(key,"keywords","제주바블"); await ui.set(key,"searchMode","company");
    await ui.form(key).event("submit");
    await until(()=>ui.submissions.some(row=>row.workerKey===key));
    assert.equal(ui.submissions.find(row=>row.workerKey===key).searchMode,"company");
  }
  const configured={...config,keywords:["제주바블"],collection:{...config.collection,searchMode:"company"}};
  const restored=await mockUi({configs:{web:configured}});
  assert.equal(restored.input("web","searchMode").value,"company");
  assert.equal(scheduleConfig({...defaultDraft(),keywords:"제주바블",searchMode:"company",days:7}).collection.searchMode,"company");
  assert.match(qualityReason({reason:"collection_execution_failed",failure:{code:"NAVER_SEARCH_STATE_MISSING",phase:"naver_main",httpStatus:200}}),/첫 검색.*업체 목록.*HTTP 200/);
});

test("app submission keeps company mode instead of silently changing it to keyword", async () => {
  const start=app.indexOf("async function submitCollectorCard(input) {");
  const end=app.indexOf("function setDefaultDates()",start);
  let submitted;
  const controls=new Map(); const input=()=>({value:"",checked:false,dispatchEvent(){}});
  const els={keywordInput:input(),checkInInput:input(),checkOutInput:input(),searchModeInput:input(),collectionPurposeInput:input(),crawlForm:{dataset:{}}};
  const context={isAdminRole:()=>true,state:{adminCrawlSubmitting:false,pendingRecrawlContext:null},currentCrawlFormPayload:()=>({keyword:"",checkIn:"",checkOut:""}),document:{getElementById(id){if(!controls.has(id))controls.set(id,input());return controls.get(id);}},els,correctedSearchMode:(_keyword,mode)=>mode,Event:class{},setDetailRankRange(){},submitCrawl:async()=>{submitted=els.searchModeInput.value;return{status:"pending"};}};
  const submit=vm.runInNewContext(`${app.slice(start,end)};submitCollectorCard`,context);
  await submit({keyword:"제주바블",searchMode:"company",workerKey:"web",checkIn:"2026-09-30",checkOut:"2026-10-01"});
  assert.equal(submitted,"company");
  await submit({keyword:"조천 숙소",searchMode:"keyword",workerKey:"web",checkIn:"2026-09-30",checkOut:"2026-10-01"});
  assert.equal(submitted,"keyword");
});
