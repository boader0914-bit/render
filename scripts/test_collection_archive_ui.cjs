"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
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
function fixture(runs = []) {
  const listeners = {}, calls = [];
  const root = {
    html: "", form: null, scrolled: 0,
    set innerHTML(value) {
      this.html = value;
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
    querySelector(selector) { return selector === "[data-archive-search-form]" ? this.form : selector === ".collection-archive-list-head" ? { scrollIntoView: () => { this.scrolled++; } } : null; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); }
  };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ["2026-09-25T15:00:00.000Z"])); } }
  const state = { runs, activeRunId: runs[0]?.id || "", data: runs[0] ? { run: runs[0], rankComparison: { available: false } } : null,
    collectionArchiveFilters: defaults(), collectionArchiveDraft: null, collectionArchivePage: 1, collectionArchiveError: "" };
  const context = vm.createContext({ Date: FixedDate, Intl, Object, state, els: { collectionArchive: root, runSelect: { innerHTML: "", value: state.activeRunId } },
    isAdminRole: () => true, escapeHtml, fmtNumber: value => String(value), placeRankComparisonSummaryHtml: () => "<p>comparison</p>",
    window: { requestAnimationFrame: fn => fn() }, fetchJson: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      assert.equal(url, "/api/runs", "Archive refresh must not request collection or analysis endpoints");
      assert.equal(options.method || "GET", "GET");
      return { runs: context.nextRuns || runs };
    } });
  const names = ["collectionArchiveDate", "collectionArchiveDay", "collectionArchiveWorker", "collectionArchiveQuality", "collectionArchiveModel", "collectionArchiveReadForm", "applyCollectionArchiveFilters", "collectionArchiveDatePreset", "refreshCollectionArchive", "bindCollectionArchiveEvents", "renderCollectionArchive", "analysisRunCollectedLabel", "analysisRunPeriod", "analysisRunPeriodLabel"];
  vm.runInContext(names.map(declaration).join("\n"), context);
  context.bindCollectionArchiveEvents(); context.renderCollectionArchive();
  const emit = (type, target) => { const event = { target, prevented: false, preventDefault() { this.prevented = true; } }; for (const listener of listeners[type] || []) listener(event); return event; };
  const set = (name, value, event = "input") => { const field = root.form.fields[name]; field.value = value; field.closest = selector => selector === "[data-archive-search-form]" ? root.form : null; emit(event, field); };
  const click = (kind, value = "", disabled = false) => { const attr = { preset: "archiveDatePreset", page: "archivePage", reset: "archiveReset" }[kind]; const selector = { preset: "[data-archive-date-preset]", page: "[data-archive-page]", reset: "[data-archive-reset]" }[kind]; const button = { dataset: { [attr]: value }, disabled, closest: match => match === selector ? button : null }; return emit("click", button); };
  return { api: context, state, root, calls, set, click, submit: () => emit("submit", root.form), visibleIds: () => [...root.html.matchAll(/data-archive-run-id="([^"]+)"/g)].map(match => decode(match[1])) };
}

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
  const empty = fixture(); assert.match(empty.root.html, /저장된 수집 결과가 없습니다/);
});
