"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const helpers = require("../web/collector_controls.js");
const { workerLabel, workerState, workerAvailability, scheduleConfig, collectionDates, defaultDraft, historyEntries, filterHistory, keywordLines, errorMessage } = helpers;
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../web/collector_controls.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const keys = ["web", "manual", "scheduled"];
const config = { version: 1, enabled: false, timezone: "Asia/Seoul", repeat: "once", firstDate: "2026-09-25", time: "14:00", keywords: [], collection: { dateMode: "rolling", bookingDays: 7, checkIn: null, checkOut: null, adults: 2, detailRankRanges: "1-20", productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail", dayUseMode: "inspect" }, requestPacing: null };
class Element {
  constructor(tag, registry) { this.tagName = tag.toUpperCase(); this.registry = registry; this.children = []; this.listeners = {}; this.className = ""; this.value = ""; this.dataset = {}; this.type = ""; this.disabled = false; this.hidden = false; this.textContent = ""; this.checked = false; this.classList = { contains: name => this.className.split(" ").includes(name) }; }
  set id(value) { this._id = value; this.registry.set(value, this); }
  get id() { return this._id; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(key, value) { this[key] = value; }
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
async function mockUi({ configs = {}, workers, requests = [], schedulePatch = {}, drafts = {}, failedSchedules = [], failRequests = false, uncertainSubmit = false } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const el = new Element(match[1], nodes); el.id = match[2]; }
  const body = new Element("body", nodes); body.className = "role-admin";
  const section = new Element("section", nodes); section.className = "active"; nodes.get("collectorControlsCard").section = section;
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag, nodes), addEventListener() {} };
  const saved = Object.fromEntries(keys.map(key => [key, clone(configs[key] || config)])); const calls = [], submissions = [], events = [], windowListeners = {};
  const storage = new Map([["staydatalab:collector-drafts:v2", JSON.stringify(drafts)]]);
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); }, dispatchEvent(event) { events.push(event); if (event.type === "collector:submit-card") { submissions.push(clone(event.detail.input)); event.detail.resolve({ status: "pending", submissionUncertain: uncertainSubmit }); } for (const fn of windowListeners[event.type] || []) fn(event); } };
  const fetch = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method: options.method, payload }); let result;
    if (url === "/api/collector-status") result = { workers: workers || keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString(), queued: 0 })) };
    else if (url === "/api/crawl-requests") { if (failRequests) throw Error("requests_unavailable"); result = { requests }; }
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
  return { nodes, calls, submissions, saved, events, window, storage, card, form, input, button, set };
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

test("three independent cards load by GET only, using approved names and default day-use", async () => {
  const ui = await mockUi(); assert.equal(ui.nodes.get("collectorWorkerStates").children.length, 3); assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.deepEqual(keys.map(workerLabel), ["2Gweb_worker", "BG worker", "AWS worker"]);
  for (const key of keys) { assert.match(text(ui.card(key)), new RegExp(workerLabel(key))); assert.equal(ui.input(key, "dayUseMode").value, "inspect"); assert.equal(ui.button(key, "지금 수집").disabled, false); }
  assert.equal(ui.calls.filter(call => call.url.startsWith("/api/worker-schedule?")).length, 3);
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
    const ui = await mockUi(); await ui.set(key, "keywords", "가평글램핑"); await ui.set(key, "execution", "schedule"); await ui.set(key, "firstDate", "2026-09-25");
    await ui.button(key, "예약 조건 저장").event("click"); await until(() => text(ui.card(key)).includes("예약 조건을 저장했습니다")); assert.equal(ui.saved[key].enabled, false); assert.equal(ui.calls.filter(call => call.method === "POST").length, 0);
    await ui.form(key).event("submit"); await until(() => ui.saved[key].enabled); const enabled = ui.calls.filter(call => call.url.startsWith("/api/worker-schedule/enabled")); assert.equal(enabled.length, 1); assert.equal(enabled[0].url, `/api/worker-schedule/enabled?workerKey=${key}`); assert.deepEqual(enabled[0].payload, { enabled: true });
    for (const other of keys.filter(other => other !== key)) assert.equal(ui.saved[other].enabled, false);
  }
});

test("provider protection blocks every start while active schedules remain pausable", async () => {
  const ui = await mockUi({ configs: { scheduled: { ...config, enabled: true } }, workers: [{ workerKey: "manual", configured: true, halted: true, errorCode: "COLLECTOR_PROVIDER_BLOCKED" }] });
  for (const key of keys) assert.equal(descendants(ui.card(key)).find(el => el.type === "submit").disabled, true);
  assert.equal(ui.button("scheduled", "예약 일시정지").disabled, false); await ui.button("scheduled", "예약 일시정지").event("click"); await until(() => !ui.saved.scheduled.enabled);
  assert.equal(ui.submissions.length, 0);
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