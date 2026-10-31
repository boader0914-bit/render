"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { qualityReason } = require("../web/collector_controls.js");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const clone = value => JSON.parse(JSON.stringify(value));
const defaults = () => ({ keyword: "", startDate: "", endDate: "", worker: "all", quality: "all", dateMode: "all" });
const decode = value => String(value || "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `${name} exists`);
  return found;
}
function row(id, overrides = {}) {
  return { id, keyword: "가평 펜션", collectedAt: "2026-09-25T15:00:00.000Z", collectedAtSource: "recorded",
    workerKey: "web", collectionQuality: { status: "complete" }, checkIn: "2026-10-01", checkOut: "2026-10-02", bookingRangeDays: 1, ...overrides };
}
function fixture(runs = [], { actualLoadRuns = false } = {}) {
  const listeners = {}, calls = [], requests = [], detailCalls = [], diagnosticMounts = [], sideEffects = [];
  const statusNode = { innerHTML: "" }, refreshButton = { disabled: false };
  let emptyTitle = null, emptyCopy = null, emptyCollect = null;
  const root = {
    html: "", form: null, scrolled: 0, hidden: false, isConnected: true, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    closest() { return null; },
    set innerHTML(value) {
      this.html = value;
      statusNode.innerHTML = value.match(/<div\b[^>]*data-archive-read-status[^>]*>([^]*?)<\/div>/)?.[1] || "";
      refreshButton.disabled = /<button\b(?=[^>]*data-collection-archive-refresh)[^>]*\bdisabled\b/.test(value);
      const titleMatch = value.match(/<h3\b[^>]*data-archive-empty-title[^>]*>([^]*?)<\/h3>/);
      const copyMatch = value.match(/<p\b[^>]*data-archive-empty-copy[^>]*>([^]*?)<\/p>/);
      const collectMatch = value.match(/<button\b[^>]*data-archive-empty-collect[^>]*>/);
      emptyTitle = titleMatch ? { textContent: decode(titleMatch[1]) } : null;
      emptyCopy = copyMatch ? { textContent: decode(copyMatch[1]) } : null;
      emptyCollect = collectMatch ? { hidden: /\bhidden\b/.test(collectMatch[0]) } : null;
      const fields = {};
      for (const match of value.matchAll(/<input\b[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g)) fields[match[1]] = { name: match[1], value: decode(match[2]) };
      for (const match of value.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([^]*?)<\/select>/g)) {
        const options = [...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
        const selected = options.find(option => /\bselected\b/.test(option[2])) || options[0];
        fields[match[1]] = { name: match[1], value: decode(selected?.[1]) };
      }
      this.form = value.includes("data-archive-search-form") ? { fields, elements: { namedItem: name => fields[name] }, matches: selector => selector === "[data-archive-search-form]" } : null;
    },
    get innerHTML() { return this.html; },
    querySelector(selector) {
      if (selector === "[data-archive-search-form]") return this.form;
      if (selector === ".collection-archive-list-head") return { scrollIntoView: () => { this.scrolled++; } };
      if (selector === "[data-archive-read-status]") return statusNode;
      if (selector === "[data-collection-archive-refresh]") return refreshButton;
      if (selector === "[data-archive-empty-title]") return emptyTitle;
      if (selector === "[data-archive-empty-copy]") return emptyCopy;
      if (selector === "[data-archive-empty-collect]") return emptyCollect;
      return null;
    },
    querySelectorAll(selector) { return selector === "[data-collection-archive-refresh]" ? [refreshButton] : []; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }
  };
  const clock = { iso: "2026-09-25T15:00:00.000Z" };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.iso])); } static now() { return Date.parse(clock.iso); } }
  const state = { session: { authenticated: true, username: "test-admin", role: "admin" }, activeTab: "admin", adminPanelSection: "archive", runs, activeRunId: runs[0]?.id || "", data: runs[0] ? { run: runs[0], rankComparison: { available: false } } : null,
    collectionArchiveFilters: defaults(), collectionArchiveDraft: null, collectionArchivePage: 1, collectionArchiveError: "",
    collectionArchiveRead: { status: "idle", lastCheckedAt: "", error: "" }, collectionArchiveRequest: null, collectionArchiveVisible: false, collectionArchiveAppliedRead: null };
  const context = vm.createContext({ Date: FixedDate, Intl, Object, AbortController, state, document: { visibilityState: "visible", querySelector: () => null }, setStatus: message => sideEffects.push(["status", message]), renderAdminStartupReadiness: () => {}, renderB2BSearchPanel: () => {}, loadRun: (...args) => { detailCalls.push(args); throw new Error("Archive listing must not load a run"); }, loadRuns: () => { throw new Error("Archive listing must not select or load latest run"); }, els: { collectionArchive: root, runSelect: { innerHTML: "", value: state.activeRunId } },
    isAdminRole: () => context.adminAllowed !== false, escapeHtml, fmtNumber: value => String(value), placeRankComparisonSummaryHtml: () => "<p>comparison</p>",
    window: { requestAnimationFrame: fn => fn(), CollectionDiagnosticsUi: { qualityReason, mount: (element, rows) => diagnosticMounts.push({ element, runIds: rows.map(row => row.id) }) } }, fetchJson: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      requests.push({ url, options });
      assert.equal(url, "/api/runs", "Archive refresh must not request collection or analysis endpoints");
      assert.equal(options.method || "GET", "GET");
      return context.respond ? context.respond(url, options) : { runs: context.nextRuns || runs };
    } });
  const names = ["collectionArchiveDate", "collectionArchiveDay", "collectionArchiveWorker", "collectionArchiveQuality", "collectionArchiveModel", "collectionArchiveReadForm", "applyCollectionArchiveFilters", "collectionArchiveDatePreset", "collectionArchiveIsVisible", "collectionArchiveReadStatusHtml", "renderCollectionArchiveReadStatus", "syncCollectionArchiveRead", "refreshCollectionArchive", "bindCollectionArchiveEvents", "renderCollectionArchive", "analysisRunCollectedLabel", "analysisRunPeriod", "analysisRunPeriodLabel"];
  vm.runInContext(names.map(declaration).join("\n"), context);
  if (actualLoadRuns) vm.runInContext(`let loadRunRequestSequence = 0;\n${declaration("loadRuns")}`, context);
  context.bindCollectionArchiveEvents(); context.renderCollectionArchive();
  const emit = (type, target) => { const event = { target, prevented: false, preventDefault() { this.prevented = true; } }; for (const listener of listeners[type] || []) listener(event); return event; };
  const set = (name, value, event = "input") => { const field = root.form.fields[name]; field.value = value; field.closest = selector => selector === "[data-archive-search-form]" ? root.form : null; emit(event, field); };
  const click = (kind, value = "", disabled = false) => { const attr = { preset: "archiveDatePreset", page: "archivePage", reset: "archiveReset" }[kind]; const selector = { preset: "[data-archive-date-preset]", page: "[data-archive-page]", reset: "[data-archive-reset]" }[kind]; const button = { dataset: { [attr]: value }, disabled, closest: match => match === selector ? button : null }; return emit("click", button); };
  return { api: context, state, root, calls, requests, detailCalls, clock, sideEffects, refreshButton, statusHtml: () => statusNode.innerHTML || root.html, emptyTitle: () => emptyTitle?.textContent || "", emptyCollectVisible: () => Boolean(emptyCollect && !emptyCollect.hidden), diagnosticMounts, set, click, submit: () => emit("submit", root.form), visibleIds: () => [...root.html.matchAll(/data-archive-run-id="([^"]+)"/g)].map(match => decode(match[1])) };
}

test("archive labels stored quality reasons and mounts only the visible saved result diagnostics", () => {
  const ui = fixture([row("partial", { collectionQuality: { status: "partial", reason: "product_targets_truncated" } }), row("failed", { collectionQuality: { status: "partial", reason: "booking_schedule_responses_incomplete" } }), row("unknown", { collectionQuality: { status: "partial", reason: "SECRET_RAW_ERROR" } })]);
  assert.match(ui.root.html, /상품 수 제한으로 일부 미수집/);
  assert.match(ui.root.html, /일부 예약 일정 응답 미확보/);
  assert.doesNotMatch(ui.root.html, /SECRET_RAW_ERROR|네이버 접근 제한 감지/);
  assert.deepEqual(clone(ui.diagnosticMounts.at(-1).runIds).sort(), ["failed", "partial", "unknown"]);
  assert.equal(ui.diagnosticMounts.at(-1).element, ui.root);
  assert.equal((ui.root.html.match(/data-collection-diagnostics=/g) || []).length, 3);
  assert.equal(ui.calls.length, 0, "Rendering cause placeholders must not start collection or fetch per-run details");
});

test("collection dates use inclusive KST boundaries and never folder updatedAt", () => {
  const { api } = fixture();
  const runs = [row("before", { collectedAt: "2026-09-25T14:59:59.999Z" }), row("start", { updatedAt: "2030-01-01T00:00:00Z" }), row("end", { collectedAt: "2026-09-26T14:59:59.999Z" }), row("after", { collectedAt: "2026-09-26T15:00:00Z" }), row("updated-only", { collectedAt: "", updatedAt: "2026-09-26T01:00:00Z" })];
  const result = api.collectionArchiveModel(runs, { startDate: "2026-09-26", endDate: "2026-09-26" });
  assert.deepEqual(clone(result.rows.map(run => run.id)), ["end", "start"]);
  assert.equal(api.collectionArchiveDay("2026-09-25T15:00:00Z"), "2026-09-26");
  assert.equal(api.collectionArchiveDay("not-a-date"), "");
  assert.equal(api.collectionArchiveModel(runs, { startDate: "2026-09-27" }).count, 1);
  assert.equal(api.collectionArchiveModel(runs, { endDate: "2026-09-25" }).count, 1);
});

test("keyword normalization and worker/status/date filters combine with AND", () => {
  const { api } = fixture();
  const runs = [row("match", { keyword: "ＧＡＰＹＥＯＮＧ　펜션", workerKey: "manual", collectionQuality: { status: "partial" } }), row("worker", { keyword: "gapyeong펜션", workerKey: "web", collectionQuality: { status: "partial" } }), row("quality", { keyword: "gapyeong펜션", workerKey: "manual" }), row("date", { keyword: "gapyeong펜션", workerKey: "manual", collectedAt: "2026-09-24T00:00:00Z", collectionQuality: { status: "partial" } }), row("keyword", { workerKey: "manual", collectionQuality: { status: "partial" } })];
  assert.deepEqual(clone(api.collectionArchiveModel(runs, { keyword: "gap yeong\n펜션", worker: "manual", quality: "partial", startDate: "2026-09-26", endDate: "2026-09-26" }).rows.map(run => run.id)), ["match"]);
  for (const field of ["searchKeyword", "naverKeyword", "label"]) assert.equal(api.collectionArchiveModel([row(field, { keyword: "", [field]: "경남 글램핑" })], { keyword: "경남글램핑" }).count, 1);
  for (const key of ["web", "manual", "scheduled"]) assert.equal(api.collectionArchiveWorker({ workerKey: key }).key, key);
  for (const status of ["complete", "reused", "partial", "blocked", "failed", "interrupted"]) assert.equal(api.collectionArchiveQuality({ collectionQuality: { status } }).key, status);
  for (const value of [null, "legacy", "__proto__"]) {
    assert.equal(api.collectionArchiveWorker({ workerKey: value }).key, "unknown");
    assert.equal(api.collectionArchiveQuality({ collectionQuality: { status: value } }).key, "unknown");
  }
  assert.equal(api.collectionArchiveModel([row("old", { workerKey: null, collectionQuality: null }), row("modern")], { worker: "unknown", quality: "unknown" }).count, 1);
});

test("all 47 results remain reachable through stable 20-row pages with clamps", () => {
  const { api } = fixture();
  const runs = Array.from({ length: 47 }, (_, index) => row(`run-${String(index).padStart(2, "0")}`, { collectedAt: new Date(Date.UTC(2026, 8, 26, 0, index)).toISOString() }));
  const pages = [1, 2, 3].map(page => api.collectionArchiveModel(runs, {}, page));
  assert.deepEqual(pages.map(page => page.rows.length), [20, 20, 7]);
  assert.equal(new Set(pages.flatMap(page => page.rows.map(run => run.id))).size, 47);
  assert.equal(pages[0].rows[0].id, "run-46"); assert.equal(pages[2].rows.at(-1).id, "run-00");
  assert.equal(api.collectionArchiveModel(runs, {}, 99).page, 3); assert.equal(api.collectionArchiveModel(runs, {}, -1).page, 1);
  const empty = api.collectionArchiveModel(runs, { keyword: "missing" }, 3);
  assert.equal(empty.page, 1); assert.equal(empty.start, 0); assert.equal(empty.end, 0);
});

test("legacy filesystem timestamps remain visible but excluded from known-date searches", () => {
  const runs = [row("known"), row("legacy", { collectedAtSource: "filesystem", collectedAt: "2030-01-01T00:00:00Z" }), row("missing", { collectedAt: "" }), row("other", { keyword: "부산", collectedAt: "" })];
  const { api } = fixture(runs);
  const all = api.collectionArchiveModel(runs, { keyword: "가평" });
  assert.equal(all.rows[0].id, "known"); assert.equal(all.unknownDateCount, 2);
  const range = api.collectionArchiveModel(runs, { keyword: "가평", startDate: "2026-01-01", endDate: "2031-01-01" });
  assert.equal(range.count, 1); assert.equal(range.unknownDateCount, 2);
  const unknown = api.collectionArchiveModel(runs, { keyword: "가평", dateMode: "unknown", startDate: "2026-01-01", endDate: "2031-01-01" });
  assert.deepEqual(clone(unknown.rows.map(run => run.id)).sort(), ["legacy", "missing"]);
});

test("invalid or reversed dates retain applied results and expose an error", () => {
  const ui = fixture([row("keep"), row("other", { keyword: "부산" })]);
  ui.api.applyCollectionArchiveFilters({ keyword: "가평" });
  for (const patch of [{ startDate: "2026-02-30" }, { startDate: "2026-09-27", endDate: "2026-09-26" }]) {
    ui.api.applyCollectionArchiveFilters({ keyword: "부산", ...patch });
    assert.equal(ui.state.collectionArchiveFilters.keyword, "가평"); assert.equal(ui.state.collectionArchiveDraft.keyword, "부산");
    assert.deepEqual(ui.visibleIds(), ["keep"]); assert.match(ui.root.html, /role="alert"/); assert.match(ui.root.html, /이전 검색 결과를 유지/);
  }
  assert.equal(ui.api.collectionArchiveDate("2024-02-29"), "2024-02-29"); assert.equal(ui.api.collectionArchiveDate("2026-02-29"), "");
});

test("stay periods remain separate from collection time including one day and 31 days", () => {
  const { api } = fixture();
  assert.equal(api.analysisRunPeriodLabel(row("single")), "2026.10.01 (1일)");
  assert.equal(api.analysisRunPeriodLabel(row("month", { bookingRangeDays: 31, checkOut: "2026-10-31" })), "2026.10.01 ~ 2026.10.31 (31일)");
  assert.equal(api.analysisRunPeriodLabel(row("bad", { checkIn: "2026-02-30" })), "확인 전");
  assert.deepEqual(clone(api.collectionArchiveDatePreset("today", new Date("2026-09-25T15:00:00Z"))), { startDate: "2026-09-26", endDate: "2026-09-26", dateMode: "range" });
  assert.equal(api.collectionArchiveDatePreset("week", new Date("2026-10-01T00:00:00Z")).startDate, "2026-09-25");
  assert.equal(api.collectionArchiveDatePreset("month", new Date("2026-09-25T15:00:00Z")).startDate, "2026-09-01");
});

test("form, presets, pagination and reset preserve drafts and only apply on search", () => {
  const runs = Array.from({ length: 45 }, (_, index) => row(`run-${index}`, { keyword: index === 0 ? "부산" : "가평 펜션" }));
  const ui = fixture(runs);
  ui.set("keyword", "가평"); assert.equal(ui.state.collectionArchiveFilters.keyword, "");
  ui.click("page", "2"); assert.equal(ui.state.collectionArchivePage, 2); assert.equal(ui.root.form.fields.keyword.value, "가평");
  const event = ui.submit(); assert.equal(event.prevented, true); assert.equal(ui.state.collectionArchivePage, 1); assert.equal(ui.state.collectionArchiveFilters.keyword, "가평");
  ui.click("page", "2", true); assert.equal(ui.state.collectionArchivePage, 1);
  ui.click("page", "3"); assert.equal(ui.state.collectionArchivePage, 3); assert.equal(ui.visibleIds().length, 4); assert.ok(ui.root.scrolled > 0);
  ui.click("preset", "unknown"); assert.equal(ui.state.collectionArchiveFilters.dateMode, "unknown"); assert.equal(ui.visibleIds().length, 0);
  ui.set("startDate", "2026-09-26", "change"); assert.equal(ui.state.collectionArchiveDraft.dateMode, "range"); ui.submit(); assert.ok(ui.visibleIds().length);
  ui.click("preset", "week"); assert.equal(ui.state.collectionArchiveFilters.keyword, "가평"); assert.equal(ui.state.collectionArchiveFilters.startDate, "2026-09-20");
  ui.click("reset"); assert.deepEqual(clone(ui.state.collectionArchiveFilters), defaults()); assert.equal(ui.state.collectionArchivePage, 1); assert.equal(ui.state.collectionArchiveError, "");
  assert.equal(ui.calls.length, 0, "Search and paging must use stored results without any request");
});

test("refresh only GETs the catalogue and preserves active analysis, filters and unsaved draft", async () => {
  const ui = fixture([row("active"), row("other")]);
  ui.api.applyCollectionArchiveFilters({ keyword: "가평" }); ui.set("keyword", "아직 적용 안 함");
  const analysis = ui.state.data; ui.api.nextRuns = [row("new"), row("other")];
  await ui.api.refreshCollectionArchive();
  assert.deepEqual(ui.calls, [{ url: "/api/runs", method: "GET" }]); assert.equal(ui.state.activeRunId, "active"); assert.equal(ui.state.data, analysis);
  assert.equal(ui.state.collectionArchiveFilters.keyword, "가평"); assert.equal(ui.state.collectionArchiveDraft.keyword, "아직 적용 안 함"); assert.equal(ui.root.form.fields.keyword.value, "아직 적용 안 함");
  assert.deepEqual(ui.visibleIds(), ["other", "new"]); assert.match(ui.root.html, /열람 중인 결과/);
});

test("render shows explicit unknown metadata, separate stay dates and escaped stored text", () => {
  const ui = fixture([row("unsafe\"id", { keyword: '<img src=x onerror="bad()">', workerKey: null, collectionQuality: null, collectedAtSource: "filesystem" })]);
  assert.match(ui.root.html, /수집일 미확인/); assert.match(ui.root.html, /수집기 미확인/); assert.match(ui.root.html, /상태 미확인/);
  assert.match(ui.root.html, /2026\.10\.01 \(1일\)/); assert.match(ui.root.html, /2026\.09\.26 00:00 저장/);
  assert.doesNotMatch(ui.root.html, /<img src=x/); assert.match(ui.root.html, /&lt;img/); assert.deepEqual(ui.visibleIds(), ['unsafe"id']);
  ui.api.applyCollectionArchiveFilters({ startDate: "2026-09-26", endDate: "2026-09-26" }); assert.match(ui.root.html, /1건은 날짜 검색에서 제외/);
  const empty = fixture(); assert.match(empty.root.html, /저장 목록을 아직 확인하지 못했습니다/);
  assert.doesNotMatch(empty.root.html, /저장된 수집 결과가 없습니다|data-open-collection-run/);
});

function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }

test("entering the visible archive automatically reads one saved catalogue and leaves the selected analysis untouched", async () => {
  const ui = fixture([row("active")]), pending = deferred(), analysis = ui.state.data;
  ui.api.respond = () => pending.promise;
  assert.equal(ui.calls.length, 0, "A render alone must not read or collect anything");
  ui.api.syncCollectionArchiveRead();
  await Promise.resolve();
  assert.deepEqual(ui.calls, [{ url: "/api/runs", method: "GET" }]);
  assert.equal(ui.state.collectionArchiveRead.status, "loading");
  assert.equal(ui.state.activeRunId, "active"); assert.equal(ui.state.data, analysis);
  assert.match(ui.statusHtml(), /확인 중|조회 중|불러오는 중|확인하고 있습니다/);
  const complete = ui.api.refreshCollectionArchive();
  pending.resolve({ runs: [row("new"), row("active")] }); await complete;
  assert.equal(ui.calls.length, 1); assert.deepEqual(ui.visibleIds(), ["new", "active"]);
  assert.equal(ui.state.activeRunId, "active"); assert.equal(ui.state.data, analysis);
  assert.equal(ui.state.collectionArchiveRead.status, "ready"); assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, ui.clock.iso);
  assert.match(ui.statusHtml(), /마지막 (성공 )?확인|최근 확인/);
  assert.equal(ui.requests[0].options.method || "GET", "GET");
});

test("automatic entry, repeated renders and overlapping manual refresh share one in-flight GET", async () => {
  const ui = fixture([row("keep")]), pending = deferred(); ui.api.respond = () => pending.promise;
  ui.api.syncCollectionArchiveRead();
  const first = ui.api.refreshCollectionArchive(), second = ui.api.refreshCollectionArchive();
  ui.api.syncCollectionArchiveRead(); ui.api.renderCollectionArchive(); ui.api.syncCollectionArchiveRead();
  await Promise.resolve();
  assert.equal(first, second, "Manual refreshes must join the same pending promise");
  assert.equal(ui.calls.length, 1); assert.equal(ui.refreshButton.disabled, true);
  pending.resolve({ runs: [row("keep"), row("saved-new")] }); await first;
  assert.equal(ui.calls.length, 1); assert.equal(ui.refreshButton.disabled, false);
  ui.api.syncCollectionArchiveRead(); assert.equal(ui.calls.length, 1, "Remaining in the same visible archive must not create polling");
});

test("a successful refresh preserves applied filters, latest unsubmitted input and the reachable page", async () => {
  const runs = Array.from({ length: 47 }, (_, index) => row('same-' + index, { keyword: index === 0 ? "부산" : "가평 펜션" }));
  const ui = fixture(runs), pending = deferred();
  ui.api.applyCollectionArchiveFilters({ keyword: "가평", worker: "web", quality: "complete", startDate: "2026-09-26", endDate: "2026-09-26", dateMode: "range" }); ui.click("page", "2");
  const filters = clone(ui.state.collectionArchiveFilters), selected = ui.state.activeRunId, analysis = ui.state.data;
  ui.api.respond = () => pending.promise; const request = ui.api.refreshCollectionArchive();
  ui.set("keyword", "입력 중인 다른 검색어"); ui.set("startDate", "2026-09-20", "change");
  const draft = clone(ui.state.collectionArchiveDraft);
  pending.resolve({ runs: [...runs, row("new-match")] }); await request;
  assert.deepEqual(clone(ui.state.collectionArchiveFilters), filters); assert.deepEqual(clone(ui.state.collectionArchiveDraft), draft);
  assert.equal(ui.state.collectionArchivePage, 2); assert.equal(ui.root.form.fields.keyword.value, "입력 중인 다른 검색어"); assert.equal(ui.root.form.fields.startDate.value, "2026-09-20");
  assert.equal(ui.visibleIds().length, 20); assert.equal(ui.state.activeRunId, selected); assert.equal(ui.state.data, analysis);
  assert.equal(ui.calls.length, 1);
});

test("a failed catalogue read retains old rows, last successful time, draft and filters while exposing a fixed failure state", async () => {
  const ui = fixture([row("keep"), row("other")]); await ui.api.refreshCollectionArchive();
  const checked = ui.state.collectionArchiveRead.lastCheckedAt, savedRuns = ui.state.runs, analysis = ui.state.data;
  ui.api.applyCollectionArchiveFilters({ keyword: "가평" }); ui.set("keyword", "아직 검색하지 않은 글");
  const filters = clone(ui.state.collectionArchiveFilters), draft = clone(ui.state.collectionArchiveDraft);
  ui.clock.iso = "2026-09-25T15:01:00.000Z"; ui.api.respond = async () => { throw new Error("PRIVATE_NETWORK_ERROR_WITH_SECRET"); };
  await assert.doesNotReject(ui.api.refreshCollectionArchive());
  assert.equal(ui.state.runs, savedRuns); assert.equal(ui.state.data, analysis); assert.deepEqual(ui.visibleIds(), ["other", "keep"]);
  assert.equal(ui.state.collectionArchiveRead.status, "error"); assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, checked);
  assert.ok(ui.state.collectionArchiveRead.error); assert.match(ui.statusHtml(), /실패|확인하지 못|불러오지 못/); assert.match(ui.statusHtml(), /기존|이전/);
  assert.doesNotMatch(ui.statusHtml(), /PRIVATE_NETWORK_ERROR_WITH_SECRET/);
  assert.deepEqual(clone(ui.state.collectionArchiveFilters), filters); assert.deepEqual(clone(ui.state.collectionArchiveDraft), draft); assert.equal(ui.root.form.fields.keyword.value, draft.keyword);
});

test("invalid catalogue envelopes are a read failure rather than an empty successful archive", async () => {
  for (const response of [null, {}, { runs: null }, { runs: {} }, { runs: "not-an-array" }]) {
    const ui = fixture([row("keep")]), savedRuns = ui.state.runs; ui.api.respond = async () => response;
    await assert.doesNotReject(ui.api.refreshCollectionArchive());
    assert.equal(ui.state.runs, savedRuns); assert.equal(ui.state.collectionArchiveRead.status, "error"); assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, "");
    assert.deepEqual(ui.visibleIds(), ["keep"]); assert.equal(ui.calls.length, 1);
  }
});

test("an empty valid catalogue completes without selecting a different run or starting collection", async () => {
  const ui = fixture([row("active")]), analysis = ui.state.data; ui.api.respond = async () => ({ runs: [] });
  await ui.api.refreshCollectionArchive();
  assert.deepEqual(clone(ui.state.runs), []); assert.equal(ui.state.activeRunId, "active"); assert.equal(ui.state.data, analysis);
  assert.equal(ui.state.collectionArchiveRead.status, "ready"); assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, ui.clock.iso);
  assert.match(ui.root.html, /저장된 수집 결과가 없습니다/); assert.match(ui.root.html, /마지막 (성공 )?확인|최근 확인/);
  assert.deepEqual(ui.calls, [{ url: "/api/runs", method: "GET" }]);
});

test("leaving the archive aborts and invalidates a late response, then re-entry performs one fresh read", async () => {
  const ui = fixture([row("keep")]), old = deferred(), fresh = deferred(), saved = ui.state.runs;
  let attempt = 0; ui.api.respond = () => ++attempt === 1 ? old.promise : fresh.promise;
  ui.api.syncCollectionArchiveRead(); const oldDone = ui.api.refreshCollectionArchive();
  await Promise.resolve();
  const signal = ui.requests[0].options.signal; assert.ok(signal, "The catalogue fetch must be cancellable");
  ui.state.adminPanelSection = "files"; ui.api.syncCollectionArchiveRead(); assert.equal(signal.aborted, true);
  ui.state.adminPanelSection = "archive"; ui.api.syncCollectionArchiveRead(); const freshDone = ui.api.refreshCollectionArchive();
  await Promise.resolve();
  assert.equal(ui.calls.length, 2); old.resolve({ runs: [row("obsolete")] }); await oldDone;
  assert.equal(ui.state.runs, saved); assert.equal(ui.state.collectionArchiveRead.status, "loading");
  fresh.resolve({ runs: [row("fresh")] }); await freshDone;
  assert.deepEqual(ui.visibleIds(), ["fresh"]); assert.equal(ui.state.collectionArchiveRead.status, "ready");
});

test("a response from a previous administrator session cannot overwrite a new session's archive", async () => {
  const ui = fixture([row("keep")]), pending = deferred(), saved = ui.state.runs; ui.api.respond = () => pending.promise;
  const request = ui.api.refreshCollectionArchive();
  ui.state.session = { authenticated: true, username: "another-admin", role: "admin" };
  pending.resolve({ runs: [row("wrong-account-late")] }); await request;
  assert.equal(ui.state.runs, saved); assert.deepEqual(ui.visibleIds(), ["keep"]); assert.notEqual(ui.state.collectionArchiveRead.status, "ready");
  assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, "");
});

test("invisible or non-administrator archive entry never requests catalogue or provider data", () => {
  const ui = fixture([row("keep")]);
  ui.state.adminPanelSection = "overview"; ui.api.syncCollectionArchiveRead();
  ui.state.adminPanelSection = "archive"; ui.api.adminAllowed = false; ui.api.syncCollectionArchiveRead();
  ui.api.adminAllowed = true; ui.state.activeTab = "keywordMonthly"; ui.api.syncCollectionArchiveRead();
  assert.equal(ui.calls.length, 0); assert.equal(ui.state.activeRunId, "keep");
});

test("an initially empty archive stays unconfirmed while loading or failed and only confirms an empty successful catalogue", async () => {
  const ui = fixture(), pending = deferred(); ui.api.respond = () => pending.promise;
  assert.match(ui.emptyTitle(), /아직 확인하지 못/); assert.equal(ui.emptyCollectVisible(), false);
  const request = ui.api.refreshCollectionArchive(); await Promise.resolve();
  assert.equal(ui.state.collectionArchiveRead.status, "loading");
  assert.match(ui.emptyTitle(), /확인하고 있습니다/); assert.equal(ui.emptyCollectVisible(), false);
  assert.match(ui.statusHtml(), /확인 중|확인하고 있습니다/);
  pending.reject(new Error("NETWORK_DOWN")); await request;
  assert.equal(ui.state.collectionArchiveRead.status, "error");
  assert.match(ui.emptyTitle(), /아직 확인하지 못/); assert.equal(ui.emptyCollectVisible(), false);
  assert.match(ui.statusHtml(), /확인하지 못했습니다/);
  ui.api.respond = async () => ({ runs: [] }); await ui.api.refreshCollectionArchive();
  assert.equal(ui.state.collectionArchiveRead.status, "ready");
  assert.match(ui.emptyTitle(), /저장된 수집 결과가 없습니다/); assert.equal(ui.emptyCollectVisible(), true);
});

test("a previously confirmed empty catalogue is not presented as a fresh empty result during a failed recheck", async () => {
  const ui = fixture(); await ui.api.refreshCollectionArchive();
  assert.match(ui.emptyTitle(), /저장된 수집 결과가 없습니다/); assert.equal(ui.emptyCollectVisible(), true);
  const checkedAt = ui.state.collectionArchiveRead.lastCheckedAt, pending = deferred();
  ui.api.respond = () => pending.promise;
  const request = ui.api.refreshCollectionArchive(); await Promise.resolve();
  assert.equal(ui.state.collectionArchiveRead.status, "loading");
  assert.match(ui.emptyTitle(), /확인하고 있습니다/); assert.equal(ui.emptyCollectVisible(), false);
  pending.reject(new Error("NETWORK_DOWN")); await request;
  assert.equal(ui.state.collectionArchiveRead.status, "error");
  assert.equal(ui.state.collectionArchiveRead.lastCheckedAt, checkedAt);
  assert.match(ui.emptyTitle(), /아직 확인하지 못/); assert.equal(ui.emptyCollectVisible(), false);
});

test("a completed archive read prevents the actual startup loadRuns late catalogue from overwriting newer saved rows", async () => {
  const ui = fixture([row("selected")], { actualLoadRuns: true });
  const startup = deferred(), archive = deferred(), analysis = ui.state.data;
  let attempt = 0; ui.api.respond = () => ++attempt === 1 ? startup.promise : archive.promise;
  const bootstrap = ui.api.loadRuns(true, { bootstrap: true });
  const request = ui.api.refreshCollectionArchive(); await Promise.resolve();
  assert.deepEqual(ui.calls, [{ url: "/api/runs", method: "GET" }, { url: "/api/runs", method: "GET" }]);
  archive.resolve({ runs: [row("newly-saved"), row("selected")] }); await request;
  const appliedRows = ui.state.runs, appliedRead = ui.state.collectionArchiveAppliedRead;
  assert.ok(appliedRead); assert.equal(ui.state.activeRunId, "selected"); assert.equal(ui.state.data, analysis);
  // Keep archive visible: even selectLatest from an older load must not select or hydrate another run.
  startup.resolve({ runs: [row("obsolete-startup-only")] }); await bootstrap;
  assert.equal(ui.state.runs, appliedRows); assert.equal(ui.state.collectionArchiveAppliedRead, appliedRead);
  assert.deepEqual(clone(ui.state.runs.map(run => run.id)), ["newly-saved", "selected"]);
  assert.equal(ui.state.activeRunId, "selected"); assert.equal(ui.state.data, analysis);
  assert.equal(ui.api.els.runSelect.value, "selected"); assert.equal(ui.detailCalls.length, 0);
  assert.equal(ui.state.adminRunCatalogReadiness.status, "ready");
  assert.equal(ui.calls.length, 2, "Neither catalogue read may trigger a run detail or provider request");
});
