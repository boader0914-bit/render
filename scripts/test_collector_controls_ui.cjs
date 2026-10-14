"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const helpers = require("../web/collector_controls.js");
const { workerLabel, workerState, workerAvailability, scheduleConfig, keywordSchedule, collectionDates, defaultDraft, historyEntries, filterHistory, keywordLines, errorMessage, progressModel, etaRange, qualityReason, diagnosticMetrics, diagnosticDates } = helpers;
const { normalizeQuery, normalizedRow } = require("./lib/collection_history.cjs");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../web/collector_controls.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const keys = ["web", "manual", "scheduled"];
test("startup failure labels distinguish execution identity from connection and artifact errors", () => {
  assert.match(errorMessage("COLLECTOR_ROLE_MISMATCH"), /수집기 역할과 실행 조건.*시작하지 못/);
  assert.match(errorMessage("COLLECTOR_RUN_TOKEN_INVALID"), /수집 실행 식별값 형식/);
  assert.doesNotMatch(errorMessage("COLLECTOR_RUN_TOKEN_INVALID"), /연결 설정/);
  assert.match(errorMessage("COLLECTOR_CRAWL_FAILED"), /프로세스.*결과를 확보하지 못/);
  assert.doesNotMatch(errorMessage("COLLECTOR_ROLE_MISMATCH"), /네이버 접근 제한|결과 검증/);
  assert.match(errorMessage("COLLECTOR_PROVIDER_BLOCKED"), /네이버 접근 제한/);
  assert.match(errorMessage("COLLECTOR_ARTIFACT_INVALID"), /결과 검증/);
});
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
  focus() { this.registry.focused = this; }
  reportValidity() { return true; }
  async event(type) { if (type === "click" && this.disabled) return; await Promise.all((this.listeners[type] || []).map(callback => callback({ preventDefault() {}, target: this }))); }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const text = element => descendants(element).map(item => item.textContent).filter(Boolean).join(" ");
const visibleText = element => element.hidden ? "" : [element.textContent, ...element.children.map(visibleText)].filter(Boolean).join(" ");
async function until(predicate) { for (let i = 0; i < 120; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error("ui_condition_not_reached"); }
function historyFixture(queryString, records) {
  const q = normalizeQuery(new URLSearchParams(queryString), Date.now()), counts = { pending: 0, complete: 0, failed: 0, partial: 0, review: 0 }, groups = new Map();
  const filtered = records.filter(row => row.date && row.date >= q.from && row.date <= q.to && (q.worker === "all" || row.workerKey === q.worker) && (!q.keyword || row.keyword.toLowerCase().includes(q.keyword.toLowerCase())) && (q.state === "all" || row.state === q.state || q.state === "attention" && ["failed", "partial", "review"].includes(row.state))).sort((a, b) => b.stamp.localeCompare(a.stamp));
  function grouping(date) {
    let key = date, startDate = date, endDate = date, label = date;
    if (q.groupBy === "year") { key = date.slice(0, 4); startDate = `${key}-01-01`; endDate = `${key}-12-31`; label = `${key}년`; }
    if (q.groupBy === "month") { key = date.slice(0, 7); startDate = `${key}-01`; endDate = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5)), 0)).toISOString().slice(0, 10); label = `${key.slice(0, 4)}년 ${Number(key.slice(5))}월`; }
    if (q.groupBy === "week") { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); key = startDate = d.toISOString().slice(0, 10); d.setUTCDate(d.getUTCDate() + 6); endDate = d.toISOString().slice(0, 10); label = `${startDate} ~ ${endDate}`; }
    return { key, label, startDate: startDate < q.from ? q.from : startDate, endDate: endDate > q.to ? q.to : endDate };
  }
  for (const row of filtered) { counts[row.state]++; const g = grouping(row.date); if (!groups.has(g.key)) groups.set(g.key, { ...g, count: 0, counts: { pending: 0, complete: 0, failed: 0, partial: 0, review: 0 }, latest: row }); const group = groups.get(g.key); group.count++; group.counts[row.state]++; }
  const result = { from: q.from, to: q.to, groupBy: q.groupBy, timezone: "Asia/Seoul", summary: { total: filtered.length, counts, latest: filtered[0] || null, latestTerminal: filtered.find(row => row.state !== "pending") || null, unknownDateCount: records.filter(row => !row.date).length }, groups: [...groups.values()].sort((a, b) => b.key.localeCompare(a.key)), warnings: [], sources: {}, updatedAt: new Date().toISOString() };
  if (q.groupKey) { const rows = filtered.filter(row => grouping(row.date).key === q.groupKey); Object.assign(result, { groupKey: q.groupKey, rows: rows.slice(q.offset, q.offset + q.limit), totalRows: rows.length, offset: q.offset, limit: q.limit, hasMore: q.offset + q.limit < rows.length, nextOffset: q.offset + q.limit < rows.length ? q.offset + q.limit : null }); }
  return result;
}
async function mockUi({ configs = {}, workers, requests = [], schedulePatch = {}, drafts = {}, failedSchedules = [], failRequests = false, failStatus = false, failHistory = false, historyFetch, historyRecords, historyPreferences, expandHistory = true, uncertainSubmit = false, outsideCollection = false, diagnostics = {}, diagnosticStatus = 200, diagnosticRunId } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) { const el = new Element(match[1], nodes); el.id = match[2]; }
  const body = new Element("body", nodes); body.className = "role-admin";
  const section = new Element("section", nodes); section.className = outsideCollection ? "" : "active"; nodes.get("collectorControlsCard").section = section;
  const navigation = { clicks: 0, click() { this.clicks++; section.className = "active"; } };
  const document = { body, hidden: false, getElementById: id => nodes.get(id), createElement: tag => new Element(tag, nodes), querySelector: () => navigation, addEventListener() {} };
  const saved = Object.fromEntries(keys.map(key => [key, clone(configs[key] || config)])); const calls = [], submissions = [], events = [], windowListeners = {};
  const records = historyRecords || historyEntries(requests.map(row => ({ createdAt: new Date().toISOString(), ...row })), schedulePatch).map((row, index) => normalizedRow(row, { id: `record_${index}`, source: "requests", workerKey: row.workerKey, trigger: row.trigger }));
  // Existing worker/diagnostic tests start with explicit expanded preferences.
  // Dedicated period tests opt out and verify the product's folded defaults.
  const expanded = expandHistory ? [...new Set(records.filter(row => row.date).map(row => `month:${row.date.slice(0, 7)}`))].map(key => [key, true]) : [];
  const storage = new Map([["staydatalab:collector-drafts:v2", JSON.stringify(drafts)], ["staydatalab:collector-history-periods:v1", JSON.stringify(historyPreferences || { expanded })]]);
  const window = { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, addEventListener(name, callback) { (windowListeners[name] ||= []).push(callback); }, dispatchEvent(event) { events.push(event); if (event.type === "collector:submit-card") { submissions.push(clone(event.detail.input)); event.detail.resolve({ status: "pending", submissionUncertain: uncertainSubmit }); } for (const fn of windowListeners[event.type] || []) fn(event); } };
  const fetch = async (url, options) => {
    const payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method: options.method, payload }); let result;
    if (url === "/api/collector-status") { if (typeof failStatus === "function" ? failStatus() : failStatus) throw Error("status_unavailable"); result = { workers: workers || keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString(), queued: 0 })) }; }
    else if (url === "/api/crawl-requests") { if (failRequests) throw Error("requests_unavailable"); result = { requests }; }
    else if (url.startsWith("/api/collection-history?")) { assert.equal(options.method, "GET"); if (typeof failHistory === "function" ? failHistory(url) : failHistory) throw Error("history_unavailable"); result = historyFetch ? await historyFetch(url, records) : historyFixture(url.split("?")[1], records); }
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
  const observers = [];
  vm.runInNewContext(source, { document, fetch, window, console, setInterval() {}, MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} disconnect() {} }, Event: UiEvent, CustomEvent: UiEvent, Date, Intl, Number, String, Object, Array, Set, Map, JSON, Promise, Error, Math, URLSearchParams });
  const initial = { hiddenCards:nodes.get("collectorWorkerStates").children.map(card => card.hidden), executionChoices:nodes.get("crawlWorkerKey").children.map(option => option.value) };
  await until(() => events.some(event => event.type === "collector:worker-availability"));
  await until(() => nodes.get("collectorHistoryFilteredCount").textContent || nodes.get("collectorHistoryReadError").textContent);
  if (expandHistory && records.length) await until(() => descendants(nodes.get("collectorUnifiedHistory")).filter(el => el.className === "collector-history-row").length >= Math.min(records.filter(row => row.date).length, 50));
  const card = key => nodes.get("collectorWorkerStates").children.find(node => node.dataset.workerKey === key);
  const form = key => descendants(card(key)).find(el => el.tagName === "FORM");
  const input = (key, name) => nodes.get(`collector-${key}-${name}`);
  const button = (key, label) => descendants(card(key)).find(el => el.tagName === "BUTTON" && el.textContent === label);
  async function set(key, name, value) { if (typeof value === "boolean") input(key, name).checked = value; else input(key, name).value = value; await form(key).event("change"); }
  const searchHistory = async () => { await nodes.get("collectorHistoryForm").event("submit"); await until(() => nodes.get("collectorHistoryQueryNotice").hidden || nodes.get("collectorHistoryQueryNotice").dataset.tone === "warning"); await until(() => !descendants(nodes.get("collectorUnifiedHistory")).some(el => el.className.includes("collector-history-more") && el.disabled)); };
  return { nodes, calls, submissions, saved, events, window, storage, card, form, input, button, set, navigation, initial, records, searchHistory, observers, body };
}

test("drafts default to day-use presence check and inclusive lodging dates", () => {
  assert.equal(defaultDraft().dayUseMode, "inspect");
  assert.deepEqual(collectionDates({ period: "custom", checkIn: "2026-09-24", checkOut: "2026-09-24" }), { checkIn: "2026-09-24", checkOut: "2026-09-24", bookingDays: 1 });
  assert.equal(collectionDates({ period: "7" }, Date.parse("2026-09-24T06:00:00Z")).checkOut, "2026-09-30");
  assert.throws(() => collectionDates({ period: "custom", checkIn: "2026-02-30", checkOut: "2026-03-02" }));
  assert.equal(defaultDraft(Date.parse("2026-09-24T06:00:00Z")).firstDate, "2026-09-25");
});

test("converted worker is absent from execution cards and choices while historical AWS results remain readable", async () => {
  const now = Date.now(), retirementReason = "인사이트 서버로 전환되어 신규 수집과 예약을 받지 않습니다.";
  const workers = keys.map(workerKey => ({ workerKey, configured: workerKey !== "scheduled", connected: true, ready: true, workerLastSeenAt: new Date(now).toISOString(), halted: workerKey === "scheduled", retired: workerKey === "scheduled", retirementReason }));
  const retiredWorker = workers[2];
  assert.equal(workerState(retiredWorker, now), "인사이트 서버로 전환", "conversion must outrank stale connection and old protection flags");
  assert.equal(workerAvailability({ workers }, "scheduled", now).retired, true);
  assert.equal(workerAvailability({ workers }, "scheduled", now).ready, false);
  assert.equal(workerAvailability({ workers }, "scheduled", now).reason, retirementReason);
  assert.match(errorMessage("COLLECTOR_WORKER_RETIRED"), /이전 수집 결과/);
  const ui = await mockUi({ workers, configs: { scheduled: { ...clone(config), enabled: true, keywords: ["포천글램핑"] } },
    schedulePatch: { scheduled: { retired: true, retirementReason, enabled: false, storedEnabled: true, nextRunAt: null } },
    requests: [{ workerKey: "scheduled", keyword: "이전 포천글램핑", status: "complete", createdAt: "2026-09-24T05:00:00Z", result: { runId: "previous_aws_result" } },
      { workerKey: "scheduled", keyword: "종료된 접근제한", status: "failed", errorCode: "COLLECTOR_PROVIDER_BLOCKED", createdAt: new Date(now).toISOString() }] });
  const card = ui.card("scheduled"), status = descendants(card).find(el => el.className === "collector-card-status");
  assert.ok(ui.initial.hiddenCards.every(Boolean), "no execution card flashes before server identity is confirmed"); assert.deepEqual(ui.initial.executionChoices, []);
  assert.equal(card.hidden,true); assert.equal(ui.nodes.get("collectorWorkerStates").dataset.workerCount,"2");
  assert.doesNotMatch(visibleText(ui.nodes.get("collectorWorkerStates")), /AWS worker|인사이트 서버로 전환|전환됨/);
  assert.deepEqual(ui.nodes.get("crawlWorkerKey").children.map(option => option.value), ["manual","web"]);
  assert.doesNotMatch(/<select id="crawlWorkerKey"[\s\S]*?<\/select>/.exec(html)[0], /scheduled|AWS worker/);
  assert.match(/<select id="collectorHistoryWorker"[\s\S]*?<\/select>/.exec(html)[0], /scheduled.*AWS worker/);
  assert.equal(card.dataset.state, "retired"); assert.equal(card.dataset.retired, "true");
  assert.match(text(status), /인사이트 서버로 전환/); assert.doesNotMatch(text(status), /연결 확인|보호 중|예약 켜짐|대기 0건/);
  assert.equal(descendants(card).find(el => el.className === "state-badge").textContent, "전환됨");
  for (const name of Object.keys(defaultDraft())) assert.equal(ui.input("scheduled", name).disabled, true);
  assert.equal(descendants(card).find(el => el.className === "collector-common-fields").hidden, true);
  assert.equal(descendants(card).find(el => el.className === "collector-card-actions").hidden, true);
  assert.equal(descendants(card).find(el => el.className === "collector-reservation").hidden, true);
  assert.equal(descendants(card).find(el => el.className === "collector-live-progress").hidden, true, "old blocked receipt is not a current conversion error");
  await ui.form("scheduled").event("submit");
  assert.equal(ui.submissions.length, 0); assert.ok(ui.calls.every(call => call.method === "GET"));
  for (const key of ["web", "manual"]) assert.equal(ui.button(key, "지금 수집").disabled, false, "conversion does not affect remaining workers");
  ui.nodes.get("collectorHistoryWorker").value = "scheduled"; await ui.searchHistory();
  assert.equal(ui.nodes.get("collectorHistoryWorker").value, "scheduled");
  assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /이전 포천글램핑.*AWS worker/s);
  await descendants(ui.nodes.get("collectorUnifiedHistory")).find(el => el.textContent === "결과 보기").event("click");
  assert.equal(ui.events.at(-1).type, "collector:open-result"); assert.equal(ui.events.at(-1).detail.runId, "previous_aws_result");
  assert.ok(ui.calls.every(call => call.method === "GET"));
  const css = fs.readFileSync(path.join(__dirname, "../web/collector-controls.css"), "utf8");
  assert.match(css, /\.collector-worker-card\[hidden\] \{ display: none !important/);
  assert.match(css, /\.collector-worker-grid\[data-worker-count="2"\] \{ grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 1200px\) \{ \.collector-worker-grid, \.collector-worker-grid\[data-worker-count\] \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /collector-retired-history/);
});

test("schedule retirement also blocks active drafts and survives a later status read failure", async () => {
  let unreadable = false;
  const workers = keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString() }));
  const ui = await mockUi({ workers, failStatus: () => unreadable,
    schedulePatch: { scheduled: { retired: true, retirementReason: "인사이트 서버로 전환", enabled: false, nextRunAt: null } },
    drafts: { scheduled: { ...defaultDraft(), keywords: "경남글램핑", execution: "schedule" } } });
  assert.equal(descendants(ui.card("scheduled")).find(el => el.type === "submit").disabled, true);
  assert.equal(ui.button("scheduled", "예약 조건 저장").disabled, true);
  await ui.form("scheduled").event("submit");
  await ui.button("scheduled", "예약 조건 저장").event("click");
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
  unreadable = true;
  const initialAvailabilityEvents = ui.events.filter(event => event.type === "collector:worker-availability").length;
  await ui.nodes.get("collectorRefresh").event("click");
  await until(() => ui.events.filter(event => event.type === "collector:worker-availability").length > initialAvailabilityEvents);
  assert.equal(ui.card("scheduled").dataset.state, "retired");
  ui.nodes.get("crawlWorkerKey").value = "scheduled"; await ui.nodes.get("crawlWorkerKey").event("change");
  assert.equal(ui.card("scheduled").hidden,true);
  assert.equal(ui.nodes.get("crawlWorkerKey").value,"manual"); assert.equal(ui.events.at(-1).detail.workerKey,"manual"); assert.equal(ui.events.at(-1).detail.ready, false);
  assert.doesNotMatch(ui.nodes.get("crawlWorkerHint").textContent, /AWS worker|인사이트 서버로 전환/);
  assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("last known worker conversion remains hidden when both status and schedule are unreadable", async () => {
  let unreadable = false;
  const workers = keys.map(workerKey => ({ workerKey, configured: true, connected: true, ready: true, workerLastSeenAt: new Date().toISOString(), retired: workerKey === "scheduled" }));
  const ui = await mockUi({ workers, failStatus: () => unreadable, failedSchedules: ["scheduled"] });
  assert.equal(ui.card("scheduled").dataset.state, "retired");
  assert.equal(ui.card("scheduled").hidden,true);
  unreadable = true; await ui.nodes.get("collectorRefresh").event("click");
  assert.equal(ui.card("scheduled").dataset.state, "retired");
  assert.equal(descendants(ui.card("scheduled")).find(el => el.className === "collector-control-status").hidden, true, "retirement is not rendered as a red missing-connection error");
  assert.equal(descendants(ui.card("scheduled")).find(el => el.type === "submit").disabled, true);
  await ui.form("scheduled").event("submit");
  assert.equal(ui.submissions.length, 0); assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("a retired lane cannot return from old drafts, DB preparation or incomplete later metadata", async () => {
  let unreadable = false;
  const workers=keys.map(workerKey=>({workerKey,configured:true,connected:true,ready:true,workerLastSeenAt:new Date().toISOString()}));
  const schedulePatch={scheduled:{retired:true,retirementReason:"인사이트 서버로 전환",enabled:false,nextRunAt:null}};
  const ui=await mockUi({workers,failStatus:()=>unreadable,schedulePatch,drafts:{scheduled:{...defaultDraft(),keywords:"이전 예약업체",execution:"schedule"}}});
  const draftBefore=ui.storage.get("staydatalab:collector-drafts:v2"),retired=ui.card("scheduled");retired.open=false;
  ui.window.dispatchEvent({type:"collector:prepare-card",detail:{workerKey:"scheduled",keyword:"새 업체",checkIn:"2026-10-13",checkOut:"2026-10-14",bookingRangeDays:1}});
  assert.equal(retired.hidden,true);assert.equal(retired.open,false);assert.equal(ui.input("scheduled","keywords").value,"이전 예약업체");assert.equal(ui.storage.get("staydatalab:collector-drafts:v2"),draftBefore);
  unreadable=true;delete schedulePatch.scheduled;await ui.nodes.get("collectorRefresh").event("click");
  assert.equal(retired.hidden,true,"known retirement survives a legacy metadata response");
  assert.deepEqual(ui.nodes.get("crawlWorkerKey").children.map(option=>option.value),["manual","web"]);
  assert.equal(ui.submissions.length,0);assert.ok(ui.calls.every(call=>call.method==="GET"));
});

test("retired stale active reports never appear in current progress or compact task guidance", async () => {
  const workers=keys.map(workerKey=>({workerKey,configured:true,connected:true,ready:true,workerLastSeenAt:new Date().toISOString(),...(workerKey==="scheduled"?{retired:true,activeJobId:"previous_job",crawl:{active:true,activeJob:{keyword:"이전 작업"}}}:{})}));
  const ui=await mockUi({workers,outsideCollection:true,requests:[{workerKey:"scheduled",keyword:"이전 작업",status:"pending",createdAt:new Date().toISOString()}]});
  assert.equal(ui.card("scheduled").hidden,true);assert.equal(descendants(ui.card("scheduled")).find(el=>el.className==="collector-live-progress").hidden,true);
  assert.equal(ui.nodes.get("collectorCompactProgress").hidden,true);assert.match(text(ui.nodes.get("collectorUnifiedHistory")),/이전 작업.*AWS worker/s);
  assert.equal(ui.submissions.length,0);assert.ok(ui.calls.every(call=>call.method==="GET"));
});

test("no selectable worker fails closed even when only schedule metadata records retirement", async () => {
  const workers=keys.map(workerKey=>({workerKey,configured:true,connected:true,ready:true,workerLastSeenAt:new Date().toISOString()}));
  const schedulePatch=Object.fromEntries(keys.map(key=>[key,{retired:true,enabled:false,nextRunAt:null}]));
  const ui=await mockUi({workers,schedulePatch});
  assert.ok(keys.every(key=>ui.card(key).hidden));assert.equal(ui.nodes.get("collectorWorkerStates").dataset.workerCount,"0");
  assert.deepEqual(ui.nodes.get("crawlWorkerKey").children,[]);assert.equal(ui.nodes.get("crawlWorkerKey").value,"");
  assert.equal(ui.events.at(-1).detail.ready,false);assert.equal(ui.nodes.get("crawlWorkerHint").dataset.ready,"false");
  assert.match(ui.nodes.get("crawlWorkerHint").textContent,/실행 가능한 수집기/);assert.doesNotMatch(ui.nodes.get("crawlWorkerHint").textContent,/BG worker|AWS worker|2Gweb_worker/);
  ui.nodes.get("crawlWorkerKey").value="manual";await ui.nodes.get("crawlWorkerKey").event("change");
  assert.equal(ui.nodes.get("crawlWorkerKey").value,"");assert.equal(ui.events.at(-1).detail.ready,false);
  assert.equal(ui.submissions.length,0);assert.ok(ui.calls.every(call=>call.method==="GET"));
});

test("surviving web and BG cards still keep independent drafts and submit their own worker", async () => {
  const workers=keys.map(workerKey=>({workerKey,configured:true,connected:true,ready:true,workerLastSeenAt:new Date().toISOString(),retired:workerKey==="scheduled"}));
  const ui=await mockUi({workers});
  await ui.set("web","keywords","웹 검수 키워드");await ui.set("manual","keywords","BG 검수 키워드");
  await ui.form("web").event("submit");await until(()=>ui.submissions.length===1);
  await ui.form("manual").event("submit");await until(()=>ui.submissions.length===2);
  assert.deepEqual(ui.submissions.map(row=>[row.workerKey,row.keyword]),[["web","웹 검수 키워드"],["manual","BG 검수 키워드"]]);
  assert.equal(ui.input("web","keywords").value,"웹 검수 키워드");assert.equal(ui.input("manual","keywords").value,"BG 검수 키워드");assert.equal(ui.card("scheduled").hidden,true);
  assert.ok(ui.calls.every(call=>call.method==="GET"));
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
  assert.doesNotMatch(text(history), /접근 제한|예약 일정 성공 0|정상 응답 0|실패·중단 [1-9]/);
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
  ui.nodes.get("collectorHistoryWorker").value = "manual"; await ui.searchHistory(); assert.doesNotMatch(text(ui.nodes.get("collectorUnifiedHistory")), /포천글램핑/);
  await descendants(ui.nodes.get("collectorUnifiedHistory")).find(el => el.textContent === "결과 보기").event("click"); assert.equal(ui.events.at(-1).detail.runId, "kept_result"); assert.ok(ui.calls.every(call => call.method === "GET"));
  assert.equal(filterHistory(historyEntries(rows), { worker: "all", keyword: "", date: "2026-09-24", state: "attention" }).length, 1);
});

test("read errors, freshness and broker failures remain distinguishable", async () => {
  const ui = await mockUi({ failRequests: true, failHistory: true, expandHistory: false }); assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /읽지 못했습니다/); assert.equal(ui.button("manual", "지금 수집").disabled, false);
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
  await ui.searchHistory();
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
  await ui.searchHistory();
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

function periodNode(ui, key) { return descendants(ui.nodes.get("collectorUnifiedHistory")).find(el => el.className === "collector-history-period" && el.dataset.groupKey === key); }
async function expandPeriod(ui, key) { const period = periodNode(ui, key); assert.ok(period); period.open = true; await period.event("toggle"); return period; }
const historyCalls = ui => ui.calls.filter(call => call.url.startsWith("/api/collection-history?"));
const defer = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };

test("history defaults to folded months, reads only summaries and applies draft filters on Search", async () => {
  const ui = await mockUi({ expandHistory: false, requests: [{ keyword: "경남글램핑", workerKey: "manual", status: "complete", result: { runId: "kept" } }] });
  const initial = historyCalls(ui), params = new URLSearchParams(initial[0].url.split("?")[1]);
  assert.equal(params.get("groupBy"), "month"); assert.equal(params.get("from"), `${helpers.defaultHistoryQuery().to.slice(0, 4)}-01-01`); assert.equal(params.get("to"), helpers.defaultHistoryQuery().to);
  assert.equal(ui.nodes.get("collectorHistoryContent").hidden, true); assert.equal(initial.length, 1); assert.equal(params.has("groupKey"), false);
  assert.ok(descendants(ui.nodes.get("collectorUnifiedHistory")).filter(el => el.className === "collector-history-period").every(el => !el.open));
  ui.nodes.get("collectorHistoryKeyword").value = "경남"; await ui.nodes.get("collectorHistoryKeyword").event("input"); ui.nodes.get("collectorHistoryWorker").value = "manual"; await ui.nodes.get("collectorHistoryWorker").event("change");
  assert.equal(historyCalls(ui).length, 1, "editing a keyword/date/filter never queries intermediate drafts");
  await ui.searchHistory(); assert.equal(new URLSearchParams(historyCalls(ui).at(-1).url.split("?")[1]).get("keyword"), "경남");
  assert.equal(ui.submissions.length, 0); assert.ok(ui.calls.every(call => call.method === "GET"));
});

test("invalid date drafts preserve the last visible periods and make no request", async () => {
  const ui = await mockUi({ expandHistory: false, requests: [{ keyword: "보존 자료", status: "failed", workerKey: "web" }] });
  const container = ui.nodes.get("collectorUnifiedHistory"), period = container.children[0], before = historyCalls(ui).length;
  for (const [from, to] of [["2026-02-30", "2026-03-01"], ["2026-10-20", "2026-10-01"], ["", "2026-10-01"]]) {
    ui.nodes.get("collectorHistoryFrom").value = from; ui.nodes.get("collectorHistoryTo").value = to; await ui.searchHistory();
    assert.equal(historyCalls(ui).length, before); assert.equal(container.children[0], period); assert.match(ui.nodes.get("collectorHistoryQueryNotice").textContent, /이전 조회 결과를 유지/);
  }
  assert.throws(() => helpers.historyQuery({ from: "2000-01-01", to: "2011-01-01" }));
});

test("weekly view displays Monday to Sunday expansion across a year boundary without overwriting drafts", async () => {
  const request = { keyword: "연도 경계", workerKey: "manual", status: "complete", result: { runId: "year_boundary" }, createdAt: "2025-12-31T16:00:00Z" };
  const ui = await mockUi({ expandHistory: false, requests: [request] });
  ui.nodes.get("collectorHistoryFrom").value = "2026-01-01"; ui.nodes.get("collectorHistoryTo").value = "2026-01-02"; ui.nodes.get("collectorHistoryGroupBy").value = "week";
  await ui.nodes.get("collectorHistoryGroupBy").event("change");
  assert.match(ui.nodes.get("collectorHistoryFilteredCount").textContent, /2025-12-29 ~ 2026-01-04.*주간.*확장/);
  assert.equal(ui.nodes.get("collectorHistoryFrom").value, "2026-01-01"); assert.ok(periodNode(ui, "2025-12-29"));
  for (const [unit, key] of [["year", "2026"], ["month", "2026-01"], ["day", "2026-01-01"]]) { ui.nodes.get("collectorHistoryGroupBy").value = unit; await ui.nodes.get("collectorHistoryGroupBy").event("change"); assert.ok(periodNode(ui, key)); }
});

test("period records load on expansion with server pagination and only UI choices persist", async () => {
  const requests = Array.from({ length: 73 }, (_, i) => ({ requestId: `page_${i}`, keyword: `페이지 ${i}`, workerKey: "manual", createdAt: "2026-09-25T05:00:00Z", status: "complete", result: { runId: `result_${i}` } }));
  const ui = await mockUi({ requests, expandHistory: false }); assert.equal(historyCalls(ui).length, 1);
  let period = await expandPeriod(ui, "2026-09"); assert.equal(descendants(period).filter(el => el.className === "collector-history-row").length, 50);
  const more = descendants(period).find(el => el.className.includes("collector-history-more")); await more.event("click");
  assert.equal(descendants(period).filter(el => el.className === "collector-history-row").length, 73);
  assert.deepEqual(historyCalls(ui).filter(call => call.url.includes("groupKey")).map(call => Number(new URLSearchParams(call.url.split("?")[1]).get("offset"))), [0, 50]);
  period.open = false; await period.event("toggle"); period.open = true; await period.event("toggle"); assert.equal(historyCalls(ui).length, 3);
  const stored = JSON.parse(ui.storage.get("staydatalab:collector-history-periods:v1"));
  assert.deepEqual(Object.keys(stored.query).sort(), ["from", "groupBy", "to"]); assert.ok(stored.expanded.some(([key, open]) => key === "month:2026-09" && open)); assert.doesNotMatch(JSON.stringify(stored), /페이지|result_|rows|manual/);
  const restored = await mockUi({ requests, expandHistory: false, historyPreferences: stored }); await until(() => text(restored.nodes.get("collectorUnifiedHistory")).includes("페이지")); assert.equal(periodNode(restored, "2026-09").open, true);
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
});

test("history read failure preserves exact last-good period nodes and never disables a worker", async () => {
  let broken = false;
  const ui = await mockUi({ requests: [{ keyword: "정상 자료", workerKey: "manual", status: "complete", result: { runId: "good" } }], failHistory: () => broken });
  const period = ui.nodes.get("collectorUnifiedHistory").children[0], row = descendants(period).find(el => el.className === "collector-history-row"); broken = true;
  await ui.searchHistory(); assert.equal(ui.nodes.get("collectorUnifiedHistory").children[0], period); assert.equal(descendants(period).find(el => el.className === "collector-history-row"), row); assert.match(ui.nodes.get("collectorHistoryReadError").textContent, /마지막 정상 조회 결과/); assert.equal(ui.button("manual", "지금 수집").disabled, false);
  broken = false; await ui.searchHistory(); assert.equal(ui.nodes.get("collectorHistoryReadError").hidden, true); assert.equal(ui.nodes.get("collectorUnifiedHistory").children[0], period, "unchanged revalidation must keep keyboard and details identity");
});

test("failed next page preserves earlier rows and explicit retry appends once", async () => {
  let broken = true;
  const requests = Array.from({ length: 61 }, (_, i) => ({ keyword: `보존 ${i}`, workerKey: "manual", status: "complete", result: { runId: `saved_${i}` } }));
  const ui = await mockUi({ requests, expandHistory: false, failHistory: url => broken && new URLSearchParams(url.split("?")[1]).get("offset") === "50" });
  const period = await expandPeriod(ui, helpers.defaultHistoryQuery().to.slice(0, 7)); await descendants(period).find(el => el.className.includes("collector-history-more")).event("click");
  assert.equal(descendants(period).filter(el => el.className === "collector-history-row").length, 50); assert.match(text(period), /마지막 조회 결과를 유지/);
  broken = false; await descendants(period).find(el => el.textContent === "다시 확인").event("click"); assert.equal(descendants(period).filter(el => el.className === "collector-history-row").length, 61);
});

test("header warning selects the current range, opens the failed period and issues GET only", async () => {
  const ui = await mockUi({ expandHistory: false, requests: [{ keyword: "실패 키워드", workerKey: "manual", status: "failed", errorCode: "NAVER_SEARCH_STATE_MISSING", createdAt: "2026-09-24T05:00:00Z" }] });
  await ui.nodes.get("collectorHistoryFailed").event("click"); await until(() => text(ui.nodes.get("collectorUnifiedHistory")).includes("실패 키워드"));
  assert.equal(ui.nodes.get("collectorHistoryContent").hidden, false); assert.equal(ui.nodes.get("collectorHistoryState").value, "failed"); assert.equal(periodNode(ui, "2026-09").open, true); assert.equal(ui.nodes.get("collectorHistoryFrom").value, `${helpers.defaultHistoryQuery().to.slice(0, 4)}-01-01`);
  assert.ok(ui.calls.every(call => call.method === "GET")); assert.equal(ui.submissions.length, 0);
});

test("unknown source/date and historical unexecuted reservations never become BG or live progress", async () => {
  const now = new Date().toISOString(), day = helpers.defaultHistoryQuery().to;
  const historyRecords = [
    { id: "saved", keyword: "보관함 전용", workerKey: "unknown", source: "outputs", trigger: "unknown", status: "complete", state: "complete", runId: "saved_only", stamp: now, date: day, dateBasis: "saved", dateBasisLabel: "저장일" },
    { id: "pending", keyword: "옛 예약", workerKey: "manual", trigger: "scheduled", status: "pending", state: "pending", stamp: now, date: day, dateBasis: "scheduled", dateBasisLabel: "예정일" },
    { id: "unknown", keyword: "시각 없음", workerKey: "unknown", status: "unknown", state: "review", stamp: null, date: null, dateBasis: "unknown" }
  ];
  const ui = await mockUi({ historyRecords, expandHistory: false, historyFetch: (url, records) => ({ ...historyFixture(url.split("?")[1], records), warnings: [{ code: "source_unreadable", label: "일부 저장소 확인 불가", count: 7 }] }) });
  const period = await expandPeriod(ui, day.slice(0, 7)); assert.match(text(period), /보관함 전용.*수집기 미확인 · 저장 결과 · 저장일/s); assert.match(text(period), /미실행 · 예약 기록/); assert.doesNotMatch(ui.nodes.get("collectorHistoryLatest").textContent, /옛 예약/);
  assert.match(ui.nodes.get("collectorHistoryReadError").textContent, /저장 기록 확인.*7건/); assert.equal(ui.nodes.get("collectorHistoryFailed").hidden, true); assert.match(ui.nodes.get("collectorHistorySources").textContent, /시각 미확인 1건.*제외/);
  assert.equal(helpers.historyOutcomeLabel({ status: "complete", state: "failed", collectionQuality: { status: "failed" } }), "실패 · 결과 검증 확인"); assert.match(helpers.historyOutcomeLabel({ status: "failed", state: "review", errorCode: "COLLECTION_SCOPE_REVIEW" }), /검토 필요 · 미실행/);
});

test("A to B to A shares pending GET but applies the latest A response only", async () => {
  const pending = new Map(), requests = [{ keyword: "Alpha", workerKey: "manual", status: "complete", result: { runId: "alpha" } }, { keyword: "Beta", workerKey: "web", status: "complete", result: { runId: "beta" } }];
  const ui = await mockUi({ requests, expandHistory: false, historyFetch: (url, records) => { const q = new URLSearchParams(url.split("?")[1]); if (!q.get("keyword")) return historyFixture(q.toString(), records); if (!pending.has(q.get("keyword"))) pending.set(q.get("keyword"), { ...defer(), result: historyFixture(q.toString(), records) }); return pending.get(q.get("keyword")).promise; } });
  ui.nodes.get("collectorHistoryKeyword").value = "Alpha"; const a1 = ui.nodes.get("collectorHistoryForm").event("submit"); await until(() => pending.has("Alpha"));
  ui.nodes.get("collectorHistoryKeyword").value = "Beta"; const b = ui.nodes.get("collectorHistoryForm").event("submit"); await until(() => pending.has("Beta"));
  ui.nodes.get("collectorHistoryKeyword").value = "Alpha"; const a2 = ui.nodes.get("collectorHistoryForm").event("submit");
  pending.get("Beta").resolve(pending.get("Beta").result); await b; assert.doesNotMatch(ui.nodes.get("collectorHistoryLatest").textContent, /Beta/);
  pending.get("Alpha").resolve(pending.get("Alpha").result); await Promise.all([a1, a2]); assert.match(ui.nodes.get("collectorHistoryLatest").textContent, /Alpha/);
  assert.equal(historyCalls(ui).filter(call => new URLSearchParams(call.url.split("?")[1]).get("keyword") === "Alpha").length, 1);
});

test("late period rows cannot overwrite a different search, and duplicate toggles share one GET", async () => {
  const hold = defer(), requests = [{ keyword: "Alpha", workerKey: "manual", status: "complete", result: { runId: "alpha" } }, { keyword: "Beta", workerKey: "web", status: "complete", result: { runId: "beta" } }];
  const ui = await mockUi({ requests, expandHistory: false, historyFetch: (url, records) => { const q = new URLSearchParams(url.split("?")[1]); return q.has("groupKey") && !q.get("keyword") ? hold.promise : historyFixture(q.toString(), records); } });
  const period = periodNode(ui, helpers.defaultHistoryQuery().to.slice(0, 7)); period.open = true; const first = period.event("toggle"), second = period.event("toggle"); await until(() => historyCalls(ui).some(call => call.url.includes("groupKey")));
  ui.nodes.get("collectorHistoryKeyword").value = "Beta"; await ui.searchHistory(); await until(() => text(ui.nodes.get("collectorUnifiedHistory")).includes("Beta"));
  const oldCall = historyCalls(ui).find(call => call.url.includes("groupKey") && !new URLSearchParams(call.url.split("?")[1]).get("keyword")); hold.resolve(historyFixture(oldCall.url.split("?")[1], ui.records)); await Promise.all([first, second]);
  assert.doesNotMatch(text(ui.nodes.get("collectorUnifiedHistory")), /Alpha/); assert.equal(historyCalls(ui).filter(call => call.url === oldCall.url).length, 1);
});

test("a changed summary starts a new period generation and discards its earlier late rows", async () => {
  const old = defer(); let groupCalls = 0, refreshed = false;
  const requests = [{ keyword: "최신 자료", workerKey: "manual", status: "complete", result: { runId: "latest" } }];
  const ui = await mockUi({ requests, expandHistory: false, historyFetch: (url, records) => { const result = historyFixture(url.split("?")[1], records); if (url.includes("groupKey")) { if (++groupCalls === 1) return old.promise; return result; } if (refreshed) result.summary.unknownDateCount = 1; return result; } });
  const firstPeriod = periodNode(ui, helpers.defaultHistoryQuery().to.slice(0, 7)); firstPeriod.open = true; const first = firstPeriod.event("toggle"); await until(() => groupCalls === 1); refreshed = true; await ui.nodes.get("collectorRefresh").event("click"); await until(() => groupCalls === 2 && text(ui.nodes.get("collectorUnifiedHistory")).includes("최신 자료"));
  const call = historyCalls(ui).find(item => item.url.includes("groupKey")), stale = historyFixture(call.url.split("?")[1], ui.records); stale.rows[0].keyword = "이전 응답"; old.resolve(stale); await first;
  assert.doesNotMatch(text(ui.nodes.get("collectorUnifiedHistory")), /이전 응답/); assert.match(text(ui.nodes.get("collectorUnifiedHistory")), /최신 자료/);
});

test("logout clears retained rows and rejects a late history response", async () => {
  const hold = defer(); let delayed = false;
  const ui = await mockUi({ requests: [{ keyword: "관리자 전용", workerKey: "manual", status: "complete", result: { runId: "private" } }], historyFetch: (url, records) => delayed ? hold.promise : historyFixture(url.split("?")[1], records) });
  delayed = true; const task = ui.nodes.get("collectorHistoryForm").event("submit"); const call = historyCalls(ui).at(-1);
  ui.body.className = ""; for (const observer of ui.observers) observer();
  hold.resolve(historyFixture(call.url.split("?")[1], ui.records)); await task;
  assert.doesNotMatch(text(ui.nodes.get("collectorUnifiedHistory")), /관리자 전용/); assert.equal(ui.nodes.get("collectorHistoryCount").textContent, "기간 기록 확인 전");
});
