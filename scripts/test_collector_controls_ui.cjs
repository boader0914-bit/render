"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { scheduleConfig, keywordLines, duplicateKeywordCount, workerState, workerQueueCount, workerAvailability, durationLabel, errorMessage } = require("../web/collector_controls.js");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../web/collector_controls.js"), "utf8");
const config = { version: 1, enabled: false, timezone: "Asia/Seoul", repeat: "daily", firstDate: "2026-09-23", time: "14:00", keywords: ["포천글램핑"],
  collection: { dateMode: "rolling", bookingDays: 31, checkIn: null, checkOut: null, adults: 2, detailRankRanges: "1-20", productMode: "all", collectionMode: "precision", collectionPurpose: "revenue_detail" }, requestPacing: null };
const values = { keywords: "포천글램핑", repeat: "daily", firstDate: "2026-09-23", time: "14:00", dateMode: "rolling", days: "31", checkIn: "", checkOut: "", adults: "2", ranks: "1-20", pacing: "inherit", interval: "200", concurrency: "2", detailConcurrency: "", queryConcurrency: "", otaConcurrency: "" };
const clone = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.className = ""; this.value = ""; this.dataset = {}; this.disabled = false; this.hidden = false; this.textContent = ""; this.checked = false; this.classList = { contains: name => this.className.split(" ").includes(name) }; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatchEvent(event) { for (const callback of this.listeners[event.type] || []) callback({ ...event, target: this }); return true; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  closest() { return this.section || null; }
  reportValidity() { return true; }
  async event(name) {
    if (name === "click" && this.disabled) return;
    await Promise.all((this.listeners[name] || []).map(callback => callback({ preventDefault() {}, target: this })));
  }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 80; attempt += 1) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error("ui_condition_not_reached");
}
async function mockUi({ initial = config, failFirstRun = false, workers, history = [], requests = [], schedulePatch = {}, failRequests = false } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new Element(match[1]);
    node.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
    node.disabled = /\sdisabled(?:\s|>)/.test(match[0]);
    nodes.set(match[2], node);
  }
  const body = new Element("body"); body.className = "role-admin";
  const section = new Element("section"); section.className = "active";
  nodes.get("collectorControlsCard").section = section;
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag), addEventListener() {} };
  let saved = clone(initial);
  const calls = [];
  const runIds = [];
  let failures = failFirstRun ? 1 : 0;
  const snapshot = () => ({ config: clone(saved), enabled: saved.enabled, nextRunAt: saved.enabled ? "2026-09-23T05:00:00Z" : null, latest: history, lastError: null, ...schedulePatch });
  const fetch = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method: options.method, payload });
    let result = {};
    if (url === "/api/collector-status") result = { workers: workers || ["manual", "scheduled"].map(workerKey => ({ workerKey, configured: true, workerLastSeenAt: new Date().toISOString(), queued: 0 })) };
    else if (url === "/api/crawl-requests") { if (failRequests) throw new Error("requests_unavailable"); result = { requests }; }
    else if (url === "/api/worker-schedule" && options.method === "GET") result = snapshot();
    else if (url === "/api/worker-schedule" && options.method === "PUT") { saved = { ...saved, ...payload }; result = clone(saved); }
    else if (url === "/api/worker-schedule/enabled") { saved.enabled = payload.enabled; result = clone(saved); }
    else if (url === "/api/worker-schedule/run-now") { runIds.push(payload.requestId); if (failures-- > 0) throw new Error("연결이 끊겼습니다."); result = { status: "queued", accepted: true }; }
    else throw new Error(`unexpected_api_${url}`);
    return { ok: true, status: url === "/api/worker-schedule/run-now" ? 202 : 200, json: async () => result };
  };
  const events = [];
  const windowListeners = {};
  const window = { addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); }, dispatchEvent(event) { events.push(event); for (const callback of windowListeners[event.type] || []) callback(event); } };
  class UiEvent { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } }
  vm.runInNewContext(source, { document, fetch, console, setInterval() {}, MutationObserver: class { observe() {} disconnect() {} }, window, Event: UiEvent, CustomEvent: UiEvent, crypto: { randomUUID: () => "test-request-uuid-0001" }, Date, Intl, Number, String, Object, Array, Set, JSON, Promise, Error, Math });
  await until(() => nodes.get("workerScheduleBadge").textContent === (schedulePatch.lastError || schedulePatch.expired ? "확인 필요" : saved.enabled ? "예약 켜짐" : "예약 꺼짐"));
  return { nodes, calls, runIds, saved: () => clone(saved), snapshot, events, window };
}
function descendants(element) { return [element, ...element.children.flatMap(descendants)]; }
function allText(element) { return descendants(element).map(item => item.textContent).filter(Boolean).join(" "); }

test("form parser preserves defaults, exact keyword meaning, and omits activation", () => {
  const parsed = scheduleConfig({ ...values, keywords: " 포천글램핑\n포천글램핑\n포천 글램핑\nＡ글램핑\nA글램핑 " });
  assert.deepEqual(parsed.keywords, ["포천글램핑", "포천 글램핑", "A글램핑"]);
  assert.equal(Object.hasOwn(parsed, "enabled"), false);
  assert.equal(parsed.requestPacing, null);
  assert.equal(parsed.collection.bookingDays, 31);
  assert.deepEqual(keywordLines("a\r\nb\r\na"), ["a", "b"]);
});

test("fixed inclusive dates preserve worker defaults even with obsolete form values", () => {
  const parsed = scheduleConfig({ ...values, dateMode: "fixed", checkIn: "2026-09-23", checkOut: "2026-09-23", adults: "6", pacing: "paced", detailConcurrency: "1" });
  assert.equal(parsed.collection.bookingDays, 1);
  assert.equal(parsed.collection.adults, 2);
  assert.equal(parsed.requestPacing, null);
  for (const patch of [{ days: "32" }, { firstDate: "2026-02-30" }, { time: "24:00" }, { ranks: "20-1" }, { ranks: "0-20" }]) assert.throws(() => scheduleConfig({ ...values, ...patch }));
});

test("worker state distinguishes configuration, protection, real job and queue", () => {
  const now = Date.parse("2026-09-23T05:00:00Z");
  const live = { configured: true, workerLastSeenAt: "2026-09-23T04:59:30Z" };
  assert.equal(workerState({ configured: false }), "연결 설정 전");
  assert.equal(workerState({ configured: true, halted: true }), "보호 중");
  assert.equal(workerState({ ...live, activeJobId: "one" }, now), "작업 중");
  assert.equal(workerState({ ...live, queued: 1 }, now), "작업 대기");
  assert.equal(workerState({ configured: true }), "연결 확인 필요");
  assert.equal(workerState(live, now + 91000), "연결 갱신 지연");
  assert.equal(workerState({ ...live, activeJobId: "uncertain" }, now + 91000), "연결 갱신 지연");
  assert.equal(workerQueueCount({ queued: 1, crawl: { queueLength: 2 }, waitingCount: 3 }), 3);
  assert.equal(workerQueueCount({ queued: 2, crawl: { queueLength: 2 } }), 2);
});

test("page load performs only read APIs and renders disabled schedule", async () => {
  const ui = await mockUi();
  assert.ok(ui.calls.length >= 2);
  assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.equal(ui.nodes.get("workerScheduleEnable").textContent, "예약 켜기");
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, false);
  assert.equal(ui.nodes.get("workerScheduleKeywords").value, "포천글램핑");
});

test("saving conditions is separate from enabling and immediate run", async () => {
  const ui = await mockUi();
  ui.nodes.get("workerScheduleKeywords").value = "가평글램핑\n포천글램핑\n가평글램핑";
  await ui.nodes.get("workerScheduleForm").event("input");
  assert.equal(ui.nodes.get("workerScheduleEnable").disabled, true);
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, true);
  await ui.nodes.get("workerScheduleForm").event("submit");
  await until(() => ui.nodes.get("workerScheduleStatus").textContent.startsWith("조건을 저장"));
  const writes = ui.calls.filter(call => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, "PUT");
  assert.equal(Object.hasOwn(writes[0].payload, "enabled"), false);
  assert.deepEqual(writes[0].payload.keywords, ["가평글램핑", "포천글램핑"]);
  assert.equal(ui.saved().enabled, false);
  assert.match(ui.nodes.get("workerScheduleStatus").textContent, /중복 키워드 1개/);
});

test("unconfigured, stale, and provider-protected workers prevent start but keep settings editable", async () => {
  const current = new Date().toISOString();
  for (const patch of [{ configured: false }, { workerLastSeenAt: "2000-01-01T00:00:00Z" }, { halted: true, errorCode: "COLLECTOR_PROVIDER_BLOCKED" }]) {
    const ui = await mockUi({ workers: [{ workerKey: "scheduled", configured: true, workerLastSeenAt: current, ...patch }] });
    assert.equal(ui.nodes.get("workerScheduleEnable").disabled, true);
    assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, true);
    assert.equal(ui.nodes.get("workerScheduleSave").disabled, false);
    assert.ok(ui.nodes.get("workerScheduleSaveHint").textContent.length > 5);
    await ui.nodes.get("workerScheduleRunNow").event("click");
    assert.equal(ui.runIds.length, 0);
  }
  const allBlocked = workerAvailability({ workers: [{ workerKey: "manual", configured: true, workerLastSeenAt: current, halted: true, errorCode: "COLLECTOR_PROVIDER_BLOCKED" }, { workerKey: "scheduled", configured: true, workerLastSeenAt: current }] }, "scheduled");
  assert.equal(allBlocked.ready, false);
  assert.match(allBlocked.reason, /두 수집기/);
});

test("active schedule can always be paused when connection, expiry, or history requires attention", async () => {
  const ui = await mockUi({ initial: { ...config, enabled: true }, workers: [{ workerKey: "scheduled", configured: false }], schedulePatch: { expired: true, lastError: "KEYWORD_SCHEDULE_STATE_INVALID" } });
  assert.equal(ui.nodes.get("workerScheduleEnable").disabled, false);
  assert.equal(ui.nodes.get("workerScheduleEnable").textContent, "예약 일시정지");
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, true);
  await ui.nodes.get("workerScheduleEnable").event("click");
  assert.equal(ui.saved().enabled, false);
  assert.deepEqual(ui.calls.filter(call => call.method === "POST").map(call => call.payload), [{ enabled: false }]);
  assert.match(ui.nodes.get("workerScheduleStatus").textContent, /실행 중인 작업은 마무리.*대기 중인 예약과 나머지 키워드는 중단/);
  assert.match(ui.nodes.get("workerScheduleStatus").textContent, /즉시수집 요청과 함께 처리하는 작업은 유지/);
});

test("expired dates block activation and valid disabled dates preview the next run", async () => {
  const expired = await mockUi({ schedulePatch: { expired: true, expiryReason: "KEYWORD_SCHEDULE_DATE_EXPIRED" } });
  assert.equal(expired.nodes.get("workerScheduleEnable").disabled, true);
  assert.equal(expired.nodes.get("workerScheduleRunNow").disabled, true);
  assert.match(expired.nodes.get("workerScheduleNext").textContent, /날짜가 지난/);
  const preview = await mockUi({ schedulePatch: { previewNextRunAt: "2026-09-24T05:00:00Z" } });
  assert.match(preview.nodes.get("workerScheduleNext").textContent, /켜면.*9.*24/);
});

test("a passed one-time schedule can run immediately while its observation dates remain valid", async () => {
  const ui = await mockUi({ initial: { ...config, repeat: "once" }, schedulePatch: { expired: true, expiryReason: "KEYWORD_SCHEDULE_TIME_EXPIRED" } });
  assert.equal(ui.nodes.get("workerScheduleEnable").disabled, true);
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, false);
  assert.match(ui.nodes.get("workerScheduleNext").textContent, /예약 시각이 지났습니다.*지금 수집은 가능/);
  assert.match(ui.nodes.get("workerScheduleSaveHint").textContent, /실행일과 시각을 수정/);
  await ui.nodes.get("workerScheduleRunNow").event("click");
  assert.equal(ui.runIds.length, 1);
  assert.equal(ui.saved().enabled, false);
});

test("worker cards show actual job, elapsed and distinct queue count and link to the correct controls", async () => {
  const ui = await mockUi({ workers: [{ workerKey: "scheduled", configured: true, workerLastSeenAt: new Date().toISOString(), waitingCount: 3, queued: 1, crawl: { active: true, activeJob: { keyword: "포천글램핑" }, elapsedSeconds: 75, queueLength: 2 } }] });
  const cards = ui.nodes.get("collectorWorkerStates").children;
  const scheduled = cards.find(card => card.dataset.workerKey === "scheduled");
  assert.match(allText(scheduled), /대기 3건/);
  assert.match(allText(scheduled), /현재 작업: 포천글램핑 · 1분 15초 경과/);
  await descendants(scheduled).find(item => item.textContent === "예약 설정").event("click");
  assert.equal(ui.nodes.get("crawlWorkerKey").value, "scheduled");
  assert.equal(ui.nodes.get("workerScheduleDetails").open, true);
  assert.equal(ui.nodes.get("crawlWorkerScheduleShortcut").hidden, false);
  assert.equal(ui.nodes.get("crawlWorkerHint").dataset.ready, "true");
  assert.equal(scheduled.dataset.selected, "true");
  assert.equal(ui.events.at(-1).type, "collector:worker-availability");
});

test("history links open retained results without exposing identifiers or recrawling", async () => {
  const ui = await mockUi({ history: [{ trigger: "scheduled", status: "partial", startedAt: "2026-09-23T05:00:00Z", finishedAt: "2026-09-23T05:01:10Z", items: [{ keyword: "포천글램핑", status: "partial", runId: "retained_result", errorCode: "RESULT_QUALITY_UNKNOWN", startedAt: "2026-09-23T05:00:00Z", endedAt: "2026-09-23T05:01:10Z" }] }], requests: [{ workerKey: "manual", keyword: "가평글램핑", status: "complete", createdAt: "2026-09-23T05:00:00Z", finishedAt: "2026-09-23T05:02:00Z", result: { runId: "manual_result" } }] });
  assert.match(allText(ui.nodes.get("workerScheduleHistory")), /1분 10초/);
  assert.match(allText(ui.nodes.get("workerScheduleHistory")), /결과 검증/);
  assert.doesNotMatch(allText(ui.nodes.get("workerScheduleHistory")), /retained_result|RESULT_QUALITY_UNKNOWN/);
  assert.match(allText(ui.nodes.get("collectorRequestHistory")), /수동워커.*가평글램핑.*2분 0초/);
  await descendants(ui.nodes.get("workerScheduleHistory")).find(item => item.textContent === "결과 보기").event("click");
  assert.equal(ui.events.at(-1).type, "collector:open-result");
  assert.equal(ui.events.at(-1).detail.runId, "retained_result");
  assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("request-history read failure does not disable healthy collector and schedule controls", async () => {
  const ui = await mockUi({ failRequests: true });
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, false);
  assert.equal(ui.nodes.get("workerScheduleEnable").disabled, false);
  assert.match(allText(ui.nodes.get("collectorRequestHistory")), /읽지 못했습니다/);
});

test("user-facing helpers preserve keyword meaning and distinguish failed requests from valid data", () => {
  assert.deepEqual(keywordLines(" A글램핑\na글램핑\n포천  글램핑\n포천 글램핑\n포천글램핑"), ["A글램핑", "포천  글램핑", "포천 글램핑", "포천글램핑"]);
  assert.deepEqual(scheduleConfig({ ...values, keywords: "포천  글램핑\n포천 글램핑\n 포천  글램핑 " }).keywords, ["포천  글램핑", "포천 글램핑"]);
  assert.equal(duplicateKeywordCount("포천  글램핑\n포천 글램핑"), 0);
  assert.throws(() => scheduleConfig({ ...values, keywords: "포천\t글램핑" }), /키워드/);
  assert.equal(duplicateKeywordCount("a\nＡ\n a\n\n"), 2);
  assert.equal(durationLabel({ createdAt: "2026-09-23T05:00:00Z", finishedAt: "2026-09-23T06:02:10Z" }), "1시간 2분");
  assert.match(errorMessage("COLLECTOR_PROVIDER_BLOCKED"), /접근 제한/);
  assert.doesNotMatch(errorMessage("UNFAMILIAR_FAILURE_CODE"), /UNFAMILIAR/);
});

test("immediate button sends explicit request ID without changing saved activation or future occurrence", async () => {
  const ui = await mockUi({ initial: { ...config, enabled: true } });
  const before = ui.snapshot();
  await ui.nodes.get("workerScheduleRunNow").event("click");
  assert.equal(ui.saved().enabled, true);
  assert.equal(ui.snapshot().nextRunAt, before.nextRunAt);
  const writes = ui.calls.filter(call => call.method !== "GET");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "/api/worker-schedule/run-now");
  assert.deepEqual(writes[0].payload, { requestId: "test-request-uuid-0001" });
  assert.equal(ui.nodes.get("workerScheduleRunNow").disabled, false);
  assert.match(ui.nodes.get("workerScheduleStatus").textContent, /대기/);
});

test("uncertain manual API failure preserves request ID for explicit user retry", async () => {
  const ui = await mockUi({ failFirstRun: true });
  await ui.nodes.get("workerScheduleRunNow").event("click");
  assert.equal(ui.runIds.length, 1);
  assert.equal(ui.nodes.get("workerScheduleStatus").dataset.tone, "error");
  await ui.nodes.get("workerScheduleRunNow").event("click");
  assert.equal(ui.runIds.length, 2);
  assert.equal(ui.runIds[0], ui.runIds[1]);
});

test("HTML loads isolated scripts and styles and all script IDs exist", () => {
  assert.match(html, /href="\/collector-controls\.css"/);
  assert.match(html, /src="\/collector_controls\.js"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of source.matchAll(/byId\("([^"]+)"\)/g)) assert.ok(ids.includes(match[1]), `missing_html_id_${match[1]}`);
});
