"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Real search/render/event code, a replace-on-write DOM and delayed animation
// frames reproduce background refresh races without a crawler or external API.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["adminDbSearchContext", "resetAdminDbSearchDraft", "adminDbSearchDraft", "saveAdminDbSearchDraft",
  "captureAdminDbSearchInput", "adminDbSearchRestoreIsCurrent", "restoreAdminDbSearchInput", "restoreAdminSearchInput",
  "adminDbCompanySearchShellHtml", "adminDbCompanyAutocompleteHtml", "refreshAdminDbAutocomplete", "closeAdminDbAutocomplete",
  "commitAdminDbQueryRender", "adminDbIntegratedContextCurrent", "adminDbReplaceBoardHtml", "renderAdminDatabaseDashboard", "adminDbQueryUsesInlineAutocomplete"];
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `Missing production function ${name}`);
  return found;
}
function eventBody(type) {
  const start = source.indexOf(`  document.addEventListener("${type}", (event) => {`);
  assert.ok(start >= 0, `Missing ${type} handler`);
  const bodyStart = source.indexOf("\n", start) + 1;
  const end = source.indexOf("\n  });", bodyStart);
  assert.ok(end > bodyStart);
  return `function handle_${type}(event) {\n${source.slice(bodyStart, end)}\n}`;
}
function escape(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function unescape(value) { return value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"); }
function attributes(tag) { return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], unescape(match[2] ?? "")])); }

function fixture({ mode = "list", companyId = "" } = {}) {
  const state = { session: { authenticated: true, role: "admin" }, activeTab: "admin", adminPanelSection: "database",
    adminDbViewMode: mode, adminDbSelectedCompanyId: companyId, adminDbFilters: { query: "", province: "all", region: "all" },
    companyMaster: { companies: [{ companyId: "a", primaryName: "월명글램핑" }] }, adminDbCompanyDetails: {}, adminDbCompanyDetailLoading: {} };
  const frames = [], calls = [], scrolls = [];
  const document = { body: { isConnected: true }, activeElement: null };
  document.activeElement = document.body;
  let input = null, autocomplete = null, markup = "", writes = 0;
  const shell = { contains: node => node === input || node?.option,
    querySelector: selector => selector === "[data-admin-db-query]" ? input : null,
    querySelectorAll: () => [] };
  const wrap = { querySelector: () => autocomplete };
  function setAutocomplete(html) {
    const tag = html.match(/<div[^>]*id="adminDbAutocomplete"[^>]*>/)?.[0];
    autocomplete = tag ? { attrs: attributes(tag), remove() { autocomplete = null; }, setAttribute(name, value) { this.attrs[name] = String(value); } } : null;
  }
  const board = { querySelector: selector => selector === "[data-admin-db-query]" ? input : null, querySelectorAll: () => [],
    get innerHTML() { return markup; }, set innerHTML(html) {
      writes++; markup = html;
      if (input) { input.isConnected = false; if (document.activeElement === input) document.activeElement = document.body; }
      const tag = html.match(/<input[^>]*data-admin-db-query[^>]*>/)?.[0];
      if (!tag) { input = null; autocomplete = null; return; }
      const attrs = attributes(tag);
      input = { value: attrs.value || "", isConnected: true, attrs, selectionStart: 0, selectionEnd: 0, selectionDirection: "none", scrollLeft: 0,
        dataset: { adminDbSearchContext: attrs["data-admin-db-search-context"], adminDbSearchGeneration: attrs["data-admin-db-search-generation"] },
        closest(selector) { if (selector === "[data-admin-db-query]") return this;
          if (selector === ".admin-db-company-query-wrap") return wrap;
          if (selector === ".admin-db-company-search-shell") return shell;
          if (selector === "[data-admin-db-persistent-search]" && state.adminDbViewMode === "review") return shell;
          return null; },
        setAttribute(name, value) { this.attrs[name] = String(value); }, getAttribute(name) { return this.attrs[name] ?? null; },
        focus() { document.activeElement = this; },
        setSelectionRange(start, end, direction = "none") { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
        insertAdjacentHTML(_position, html) { setAutocomplete(html); } };
      setAutocomplete(html);
    } };
  document.querySelector = selector => selector === "[data-admin-db-query]" ? input : null;
  document.querySelectorAll = selector => selector === "[data-admin-db-query]" ? (input ? [input] : []) : selector === ".admin-db-autocomplete" ? (autocomplete ? [autocomplete] : []) : [];
  const context = { state, document, els: { adminDatabaseDashboard: board }, console, Promise, Array, Object, Number, JSON,
    window: { requestAnimationFrame: fn => frames.push(fn), scrollX: 35, scrollY: 610,
      scrollTo: point => scrolls.push(point), AdminTransitionTiming: null },
    isAdminRole: () => state.session?.role === "admin" && state.session.authenticated !== false,
    adminDbViewMode: () => state.adminDbViewMode,
    adminConsoleMasterSource: () => state.companyMaster,
    adminDbFilterState: master => ({ rows: master.companies.map(company => ({ company, metrics: {} })), filteredRows: [], filters: state.adminDbFilters }),
    adminDbGroupedRows: () => [], adminDbCompanyIdFromRoute: () => "", adminDbMasterHasRows: () => true,
    adminDbRows: master => master.companies.map(company => ({ company })), compactSearchText: value => String(value).trim(),
    adminDbClassifyCompany: () => ({}), adminDbCompanyProfile: () => ({}),
    adminDbAutocompleteSuggestions: rows => rows, adminDbCompanyDetailUrl: id => `/admin?company=${id}`, escapeHtml: escape,
    fmtNumber: String, fmtWon: String, adminDbMetricCard: () => "", adminDbCompanyExplorerFiltersHtml: () => "",
    adminDbUserViewBridgeHtml: () => "", adminDbSelectedRow: () => null, adminDbSelectedDetailPanel: () => "",
    adminDbAuditBoard: () => "", adminDbWorkPanel: () => "", adminDbCollectionPanel: () => "",
    adminDbRegionWorkspaceHtml: () => "", adminRegionalDatabasePanel: () => "", bindAdminDbCompanySelectButtons() {},
    applyPendingCompanyEdit() {}, hideAdminRegionManagement() {}, renderAdminRegionAnalysisDashboard() {},
    handleAppOverlayKeydown: () => false, openFirstAdminDbAutocompleteOption: () => calls.push("select-first"),
    setActiveTab: () => {}, finishAdminScreenTransition() {},
    fetchJson() { throw new Error("Search/render regression must not call APIs"); } };
  vm.createContext(context);
  vm.runInContext(names.map(declaration).join("\n") + ["compositionstart", "compositionend", "input", "keydown"].map(eventBody).join("\n"), context);
  context.adminDbCompanyExplorerHtml = value => context.adminDbCompanySearchShellHtml(value);
  context.renderAdminConsoleDashboard = () => context.renderAdminDatabaseDashboard();
  context.clearAdminDbCompanyHash = () => context.resetAdminDbSearchDraft();
  return { state, context, board, calls, scrolls, frames, document, render: () => context.renderAdminDatabaseDashboard(),
    input: () => input, autocomplete: () => autocomplete, writes: () => writes,
    flush() { while (frames.length) frames.shift()(); },
    type(value, options = {}) { input.value = value; context.handle_input({ target: input, isComposing: Boolean(options.composing) }); },
    key(key, options = {}) { context.handle_keydown({ target: input, key, preventDefault() { calls.push(`prevent:${key}`); }, ...options }); } };
}

test("an uncommitted search survives the actual DB background repaint without filtering the list", () => {
  const f = fixture(); f.render(); f.input().focus(); f.type("월명");
  f.input().setSelectionRange(1, 2, "backward"); f.input().scrollLeft = 18;
  const old = f.input(); f.state.companyMaster = { ...f.state.companyMaster, updatedAt: "new" };
  f.render();
  assert.notEqual(f.input(), old, "fixture replaces the old input just like innerHTML");
  assert.equal(f.input().value, "월명"); assert.equal(f.state.adminDbFilters.query, "");
  f.flush();
  assert.equal(f.document.activeElement, f.input());
  assert.deepEqual([f.input().selectionStart, f.input().selectionEnd, f.input().selectionDirection, f.input().scrollLeft], [1, 2, "backward", 18]);
  assert.equal(f.scrolls.at(-1).top, 610); assert.equal(f.scrolls.at(-1).left, 35);
});

test("review search retains its separate uncommitted value rather than forcing the compact field blank", () => {
  const f = fixture({ mode: "review", companyId: "a" }); f.render(); f.type("다른 업체"); f.render();
  assert.equal(f.input().value, "다른 업체"); assert.equal(f.state.adminDbFilters.query, "");
  f.state.adminDbSelectedCompanyId = "b"; f.render(); assert.equal(f.input().value, "");
  f.state.adminDbViewMode = "list"; f.render(); assert.equal(f.input().value, "");
});

test("several initial responses before one animation frame retain the original focus and caret", () => {
  const f = fixture(); f.render(); f.input().focus(); f.type("모의 업체 1"); f.input().setSelectionRange(5, 6);
  f.render(); f.render(); f.render();
  assert.equal(f.document.activeElement, f.document.body, "innerHTML temporarily removes focus before the frame");
  f.flush();
  assert.equal(f.document.activeElement, f.input()); assert.equal(f.input().value, "모의 업체 1");
  assert.deepEqual([f.input().selectionStart, f.input().selectionEnd], [5, 6]);
  assert.equal(f.state.adminDbSearchPendingRestore, null);
});

test("Escape closes suggestions and a later background repaint keeps them closed", () => {
  const f = fixture(); f.render(); f.type("월"); f.key("Escape"); f.render(); f.flush();
  assert.equal(f.input().value, "월"); assert.equal(f.state.adminDbFilters.query, "");
  assert.equal(f.input().getAttribute("aria-expanded"), "false");
  assert.ok(Object.hasOwn(f.autocomplete().attrs, "hidden"));
});

test("Enter commits a list query, while review Enter keeps the existing select-first policy", () => {
  const f = fixture(); f.render(); f.type("월명"); f.key("Enter"); f.flush();
  assert.equal(f.state.adminDbFilters.query, "월명"); assert.equal(f.input().value, "월명");
  f.state.adminDbViewMode = "review"; f.state.adminDbSelectedCompanyId = "a"; f.render(); f.type("다른"); f.key("Enter");
  assert.ok(f.calls.includes("select-first")); assert.equal(f.state.adminDbFilters.query, "월명");
});

test("Korean composition defers DB replacement and flushes the newest data only after composition ends", () => {
  const f = fixture(); f.render(); f.input().focus();
  f.context.handle_compositionstart({ target: f.input() }); f.type("월ㅁ", { composing: true });
  const composing = f.input(), writes = f.writes(); f.render();
  assert.equal(f.input(), composing); assert.equal(f.writes(), writes); assert.ok(f.state.adminDbSearchDeferredRender);
  f.key("Enter", { isComposing: true }); assert.equal(f.state.adminDbFilters.query, "");
  f.key("Enter", { keyCode: 229 }); assert.equal(f.state.adminDbFilters.query, "");
  composing.value = "월명"; f.context.handle_compositionend({ target: composing }); f.flush();
  assert.notEqual(f.input(), composing); assert.equal(f.input().value, "월명");
  assert.equal(f.state.adminDbSearchDeferredRender, null); assert.equal(f.state.adminDbQueryComposing, false);
});

test("composition ending on an obsolete menu cannot repaint or steal focus", () => {
  const f = fixture(); f.render(); f.input().focus(); f.context.handle_compositionstart({ target: f.input() });
  f.type("월", { composing: true }); f.render(); const writes = f.writes(), old = f.input();
  f.state.adminPanelSection = "overview"; f.context.handle_compositionend({ target: old }); f.flush();
  assert.equal(f.writes(), writes); assert.equal(f.state.adminDbSearchDeferredRender, null);
});

for (const stale of ["session", "menu", "company", "new-input", "focus"]) {
  test(`queued input restoration yields to a later ${stale} change`, () => {
    const f = fixture(); f.render(); f.input().focus(); f.type("월"); f.render();
    if (stale === "session") f.state.session = { authenticated: true, role: "admin" };
    if (stale === "menu") f.state.adminPanelSection = "overview";
    if (stale === "company") { f.state.adminDbViewMode = "review"; f.state.adminDbSelectedCompanyId = "b"; }
    if (stale === "new-input") { f.type("새 검색"); f.input().setSelectionRange(3, 3); }
    const nextFocus = { isConnected: true }; if (stale === "focus") f.document.activeElement = nextFocus;
    f.flush();
    if (stale === "new-input") { assert.equal(f.input().value, "새 검색"); assert.equal(f.input().selectionStart, 3); }
    else assert.notEqual(f.document.activeElement, f.input());
    assert.equal(f.scrolls.length, 0);
  });
}

test("query commit restoration cannot overwrite newer typing or focus a hidden DB after navigation", () => {
  const f = fixture(); f.render(); f.type("월"); f.key("Enter"); f.type("월명글램핑"); f.flush();
  assert.equal(f.input().value, "월명글램핑"); assert.equal(f.state.adminDbFilters.query, "월");
  f.key("Enter"); f.document.activeElement = f.document.body; f.state.adminPanelSection = "overview"; f.flush();
  assert.equal(f.document.activeElement, f.document.body);
});

test("explicit reset and session change discard draft and pending composition", () => {
  const f = fixture(); f.render(); f.type("월"); f.context.handle_compositionstart({ target: f.input() }); f.render();
  f.context.resetAdminDbSearchDraft(); f.render(); assert.equal(f.input().value, "");
  assert.equal(f.state.adminDbQueryComposing, false); assert.equal(f.state.adminDbSearchDeferredRender, null);
  f.type("다른"); f.state.session = { authenticated: true, role: "admin" }; f.render(); assert.equal(f.input().value, "");
});

test("changing region starts a fresh search context", () => {
  const f = fixture(); f.render(); f.type("월명"); f.state.adminDbFilters.province = "gyeongnam"; f.render();
  assert.equal(f.input().value, ""); assert.equal(f.state.adminDbFilters.query, "");
});

test("all direct resets and logout invalidate pending draft restoration", () => {
  for (const selector of ["data-admin-db-clear", "data-admin-db-company-province", "data-admin-db-company-region", "data-admin-db-quality-filter", "data-admin-db-clear-selection", "data-admin-db-province-card", "data-admin-db-region-card"]) {
    const marker = selector === "data-admin-db-clear" || selector === "data-admin-db-clear-selection"
      ? `if (event.target.closest("[${selector}]")) {` : `if (${({ "data-admin-db-company-province": "adminDbCompanyProvince", "data-admin-db-company-region": "adminDbCompanyRegion", "data-admin-db-quality-filter": "adminDbQualityFilter", "data-admin-db-province-card": "adminDbProvinceCard", "data-admin-db-region-card": "adminDbRegionCard" })[selector]}) {`;
    const start = source.indexOf(marker); assert.ok(start >= 0, marker);
    assert.match(source.slice(start, start + 130), /resetAdminDbSearchDraft\(\)/, selector);
  }
  assert.match(declaration("logout"), /^async function logout\(\) \{\s+resetAdminDbSearchDraft\(\);/);
});
