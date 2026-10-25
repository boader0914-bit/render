"use strict";

// Execute the actual application render/hydration functions and the actual
// integrated-view controller. The small replace-on-write DOM below models node
// identity, detach/replace, visibility and events; it does not claim browser
// paint timing. No provider, crawler, real HTTP request or saved data is used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { buildMonthlyReportSnapshot } = require("./lib/monthly_reports.cjs");

const appSource = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const integratedSource = fs.readFileSync(path.join(__dirname, "../web/company-integrated.js"), "utf8");
const appFunctions = ["adminDbIntegratedContainerHtml", "adminDbIntegratedContextCurrent", "adminDbReplaceBoardHtml", "adminDbRefreshSelectedDetail", "adminDbIntegratedDisplayForDetail", "syncCompanyIntegratedPanel",
  "renderAdminDatabaseDashboard", "adminDbMetricSummaryHtml", "adminDbSelectedDetailPanel", "loadAdminDbCompanyDetail", "handleAdminDbReviewToggle",
  "activateAdminDbCompanyDetail", "openAdminDbCompanyReview", "resumeAdminDbCompanyDetailAfterReturn"];
const declaration = name => {
  const found = appSource.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `Missing actual application function ${name}`);
  return found;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const decode = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

class Element {
  constructor(tag = "div", attrs = {}, doc = null, text = "") {
    this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.ownerDocument = doc;
    this.children = []; this.parentNode = null; this.listeners = new Map(); this.rawText = text;
    this.dataset = new Proxy({}, {
      get: (_, name) => this.attrs["data-" + String(name).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())],
      set: (_, name, value) => { this.attrs["data-" + String(name).replace(/[A-Z]/g, letter => "-" + letter.toLowerCase())] = String(value); return true; }
    });
    this.classList = { contains: value => (this.attrs.class || "").split(/\s+/).includes(value),
      add: value => { this.attrs.class = [...new Set((this.attrs.class || "").split(/\s+/).filter(Boolean).concat(value))].join(" "); },
      remove: value => { this.attrs.class = (this.attrs.class || "").split(/\s+/).filter(name => name !== value).join(" "); } };
  }
  get isConnected() { return this === this.ownerDocument?.body || Boolean(this.parentNode?.isConnected); }
  get parentElement() { return this.parentNode; }
  get hidden() { return Object.hasOwn(this.attrs, "hidden"); }
  set hidden(value) { if (value) this.attrs.hidden = ""; else delete this.attrs.hidden; }
  get value() { return this._value ?? this.attrs.value ?? ""; }
  set value(value) { this._value = String(value); }
  get innerHTML() { return this.children.map(child => child.outerHTML).join(""); }
  set innerHTML(html) {
    if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    const stack = [this], voidTags = new Set(["input", "br", "hr", "img", "meta", "link", "area", "source", "wbr"]);
    for (const token of String(html).match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || []) {
      if (token.startsWith("<!--")) continue;
      if (token.startsWith("</")) { if (stack.length > 1) stack.pop(); continue; }
      if (!token.startsWith("<")) { stack.at(-1).appendChild(new Element("#text", {}, this.ownerDocument, token)); continue; }
      const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
      const attrs = {};
      for (const match of token.slice(tag.length + 1, -1).matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[match[1]] = decode(match[2] ?? match[3] ?? match[4] ?? "");
      const node = new Element(tag, attrs, this.ownerDocument); stack.at(-1).appendChild(node);
      if (!voidTags.has(tag) && !/\/>$/.test(token)) stack.push(node);
    }
  }
  get outerHTML() {
    if (this.tagName === "#TEXT") return this.rawText;
    return `<${this.tagName.toLowerCase()}${Object.entries(this.attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join("")}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  get textContent() { return this.tagName === "#TEXT" ? decode(this.rawText) : this.children.map(child => child.textContent).join(""); }
  appendChild(node) { node.remove(); node.parentNode = this; this.children.push(node); return node; }
  remove() { if (!this.parentNode) return; if (this.contains(this.ownerDocument?.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body; const siblings = this.parentNode.children, index = siblings.indexOf(this); if (index >= 0) siblings.splice(index, 1); this.parentNode = null; }
  replaceWith(node) { const parent = this.parentNode; if (!parent) return; node.remove(); const index = parent.children.indexOf(this); parent.children.splice(index, 1, node); node.parentNode = parent; this.parentNode = null; }
  replaceChild(node, previous) { previous.replaceWith(node); return previous; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  matches(selector) {
    if (selector.includes(",")) return selector.split(",").some(part => this.matches(part.trim()));
    const tag = selector.match(/^[\w-]+/)?.[0]; if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (!Object.hasOwn(this.attrs, match[1]) || (match[2] !== undefined && this.attrs[match[1]] !== match[2])) return false;
    }
    for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
    const id = selector.match(/#([\w-]+)/)?.[1]; if (id && this.attrs.id !== id) return false;
    return this.tagName !== "#TEXT";
  }
  querySelectorAll(selector) { const result = []; for (const child of this.children) { if (child.matches(selector)) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  getClientRects() { return this.isConnected && !this.closest("[hidden]") ? [{}] : []; }
  getBoundingClientRect() { return { width: this.getClientRects().length ? 100 : 0, height: this.getClientRects().length ? 100 : 0 }; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  focus(options) { this.ownerDocument.activeElement = this; this.lastFocusOptions = options; }
  scrollIntoView() {}
}

function integratedEnvelope(id, month = "2026-09", observation = {}) {
  const date = month + "-03", run = { id: `${id}-${month}`, keyword: "[모의] 지역글램핑", collectedAt: `${month}-01T08:00:00Z`, collectionQuality: { status: "complete" } };
  const snapshot = buildMonthlyReportSnapshot({ type: "company", targetId: id, month, cutoffDate: month + "-30" }, {
    companies: [{ companyId: id, primaryName: `[모의] ${id}`, capacity: 16 }], runs: [run], observations: [{
      companyKey: id, runId: run.id, collectedAt: run.collectedAt, stayDate: date, productType: "lodging", inventoryEvidenceVersion: 4,
      supply: 16, sold: 5, publicBookings: 3, phoneBookings: 2, publicRevenue: 600000, phoneRevenue: 400000, estimatedRevenue: 1000000,
      phonePricedBookings: 2, phoneMissingPriceBookings: 0, sharedDayUseExcluded: 0, partial: false, missing: false, unknownUnavailable: 0,
      ...observation
    }]
  }, "2026-10-01T00:00:00Z");
  return { companyId: id, status: "ready", selectedMonth: month, calculatedAt: "2026-10-01T00:00:00Z", snapshot,
    roomBasis: { capacity: 16, source: "db_review", label: "관리자 검수값", warnings: [] },
    months: [{ month: "2026-09" }, { month: "2026-08" }], failedAttempts: [], keywords: [] };
}

function fixture() {
  const companies = ["a", "b"].map(companyId => ({ companyId, primaryName: `[모의] ${companyId}`, detailLoaded: false }));
  const state = { session: { authenticated: true, role: "admin" }, activeTab: "admin", adminPanelSection: "database",
    adminDbViewMode: "review", adminDbSelectedCompanyId: "a", adminDbFilters: {}, companyMaster: { sourceRevision: "fixture-v1", representation: "bootstrap", companies } };
  const document = { visibilityState: "visible", hidden: false, createElement: tag => new Element(tag, {}, document) };
  document.body = new Element("body", {}, document); document.activeElement = document.body;
  const board = new Element("div", { id: "adminDatabaseDashboard" }, document); document.body.appendChild(board);
  document.querySelector = selector => document.body.querySelector(selector); document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const frames = new Map(), timers = new Map(), integratedRequests = [], detailRequests = [], controllers = [], transition = [], filterCalls = [];
  let nextFrame = 0, nextTimer = 0;
  const window = { document, URLSearchParams, AbortController, Promise, console, scrollX: 0, scrollY: 0,
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    AdminTransitionTiming: {}, scrollTo() {}, location: { pathname: "/admin", search: "", hash: "" } };
  const context = { window, document, state, els: { adminDatabaseDashboard: board }, console, URLSearchParams, AbortController, Promise,
    getComputedStyle: window.getComputedStyle, isAdminRole: () => state.session?.authenticated !== false && state.session?.role === "admin" && !state.adminUserViewMode,
    adminConsoleMasterSource: () => state.companyMaster, adminDbViewMode: () => state.adminDbViewMode,
    adminDbFilterState: master => { filterCalls.push(master); const rows = master.companies.map(company => ({ company, metrics: {} })); return { rows, filteredRows: rows, filters: {} }; },
    adminDbClassifyCompany: () => ({}), adminDbCompanyProfile: () => ({}),
    adminDbGroupedRows: () => [], adminDbCompanyIdFromRoute: () => "", adminDbMasterHasRows: () => true,
    captureAdminDbSearchInput: () => null, restoreAdminDbSearchInput() {}, escapeHtml: escape, fmtNumber: String, fmtWon: String,
    adminDbMetricCard: () => "", adminDbCompanySearchShellHtml: () => "", adminDbUserViewBridgeHtml: () => "",
    adminDbSelectedRow: rows => rows.find(row => row.company.companyId === state.adminDbSelectedCompanyId) || rows[0],
    adminDbAuditBoard: () => "", adminDbWorkPanel: () => "", adminDbCollectionPanel: () => "",
    bindAdminDbCompanySelectButtons() {}, applyPendingCompanyEdit() {}, hideAdminRegionManagement() {},
    beginAdminScreenTransition() { return {}; }, finishAdminScreenTransition: status => transition.push(status),
    resetAdminDbSearchDraft() {}, setAdminDbCompanyRoute() {}, restoreAdminDbInlineSearchViewport() {},
    adminDbRequiredCheckChannels: () => [], adminDbDetailPayload: id => state.adminDbCompanyDetails?.[id] || {},
    adminDbCompanyFixedProfile: company => ({ primaryName: company.primaryName }), adminDbCumulativeDashboardModel: () => ({}),
    adminDbAdminProfilePanel: () => "", adminDbQuickCorrectionPanel: () => "", adminDbChannelExposurePanel: () => "",
    adminDbConfirmCollectPlanHtml: () => "", adminDbRecheckOutcomeHtml: () => "", adminDbSelectedNextAction: () => ({}),
    companyReviewActionsHtml: () => "", adminDbCompanyMaintenanceHtml: () => "", adminDbInlineCollectionHtml: () => "",
    adminDbSelectedOverviewCardsHtml: row => `<div data-company-integrated data-company-id="${escape(row.company.companyId)}" data-company-name="${escape(row.company.primaryName)}"></div><div data-loaded-detail>검수 자료</div>`,
    compactDateTime: String,
    fetchJson(url) { assert.match(url, /^\/api\/company-master\/detail\?/); const request = { url, ...deferred() }; detailRequests.push(request); return request.promise; }
  };
  window.fetch = async (url, options) => {
    assert.match(url, /^\/api\/company-master\/integrated\?/);
    const params = new URLSearchParams(url.split("?")[1]);
    const request = { url, companyId: params.get("companyId"), month: params.get("month") || "2026-09", signal: options.signal, ...deferred() };
    integratedRequests.push(request);
    const body = await request.promise; return { ok: true, status: 200, json: async () => body };
  };
  vm.createContext(context); vm.runInContext(integratedSource, context);
  const actualShow = window.CompanyIntegrated.show;
  window.CompanyIntegrated.show = (container, input) => { const controller = actualShow(container, input); controllers.push(controller); return controller; };
  vm.runInContext(appFunctions.map(declaration).join("\n"), context);
  context.renderAdminConsoleDashboard = () => context.renderAdminDatabaseDashboard();
  const api = {
    state, context, document, board, frames, timers, integratedRequests, detailRequests, controllers, transition, filterCalls,
    render: () => context.renderAdminDatabaseDashboard(), selected: () => board.querySelector("[data-company-integrated]"),
    async frame() { const batch = [...frames]; frames.clear(); for (const [, callback] of batch) callback(nextFrame * 16); await settle(); },
    async respondIntegrated(index = integratedRequests.length - 1, observation = {}) { const request = integratedRequests[index]; request.resolve(integratedEnvelope(request.companyId, request.month, observation)); await settle(); },
    async respondDetail(index = detailRequests.length - 1, extra = {}) { const request = detailRequests[index]; const id = new URLSearchParams(request.url.split("?")[1]).get("companyId"); request.resolve({ company: { companyId: id, primaryName: `[모의] ${id}`, ...extra } }); await settle(); },
    choose(id) { state.adminDbRouteCompanyId = id; state.adminDbSelectedCompanyId = id; this.render(); },
    async shown() { await this.respondIntegrated(); await this.frame(); await this.frame(); await settle(); }
  };
  return api;
}

test("an observed integrated card is displayed before the selected company starts its heavy detail GET", async () => {
  const f = fixture(); f.render(); await settle();
  assert.equal(f.integratedRequests.length, 1);
  assert.equal(f.detailRequests.length, 0, "detail must not compete with the saved integrated result");
  await f.respondIntegrated();
  assert.match(f.selected().textContent, /예약/); assert.match(f.selected().textContent, /매출/);
  assert.equal(f.detailRequests.length, 0, "DOM update alone does not prove first display");
  await f.frame(); assert.equal(f.detailRequests.length, 0, "one animation frame is insufficient");
  await f.frame(); assert.equal(f.detailRequests.length, 1);
  assert.equal(f.transition.at(-1), "ready", "first-card readiness does not wait for the larger detail endpoint");
  assert.match(f.selected().textContent, /100만원/);
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
  assert.match(f.selected().textContent, /예약/); assert.match(f.selected().textContent, /매출/);
});

test("collapsed review support performs no hidden bulk work and expands its original tools only for the current company context", async () => {
  const f = fixture(), built = [];
  for (const [name, marker] of [["adminDbAuditBoard", "audit"], ["adminDbWorkPanel", "work"], ["adminDbCollectionPanel", "collection"]]) {
    f.context[name] = rows => { built.push([marker, rows.map(row => row.company.companyId)]); return `<button data-support-tool="${marker}">${marker}</button>${marker === "work" ? '<textarea data-company-review-note="a"></textarea>' : ""}`; };
  }
  f.render(); await settle(); assert.deepEqual(built, [], "closed tools cannot delay the saved company month");
  await f.shown(); const selected = f.selected(), controller = f.controllers[0], support = f.board.querySelector(".admin-db-review-support"), body = support.querySelector(".admin-db-review-support-body");
  assert.equal(body.innerHTML.trim(), ""); support.open = false; f.context.handleAdminDbReviewToggle({ target: support }); assert.deepEqual(built, []);
  support.open = true; f.context.handleAdminDbReviewToggle({ target: support });
  assert.deepEqual(built.map(row => row[0]), ["audit", "work", "collection"]); assert.ok(built.every(row => row[1].join(",") === "a,b"));
  assert.equal(body.querySelectorAll("[data-support-tool]").length, 3); assert.equal(f.selected(), selected); assert.equal(f.controllers[0], controller); assert.equal(f.integratedRequests.length, 1);
  const note = body.querySelector("[data-company-review-note]"); note.value = "아직 저장하지 않은 검토 메모";
  const filters = f.filterCalls.length; support.open = false; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(f.filterCalls.length, filters);
  support.open = true; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(f.filterCalls.length, filters); assert.equal(built.length, 3);
  assert.equal(body.querySelector("[data-company-review-note]"), note, "reopening the same support preserves the exact unsaved input node"); assert.equal(note.value, "아직 저장하지 않은 검토 메모");
  const session = f.state.session; f.state.session = { ...session }; support.open = true; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(built.length, 3, "another session cannot expand the old context");
  f.state.session = session; const master = f.state.companyMaster; f.state.companyMaster = { ...master }; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(built.length, 3, "a replaced master cannot reuse old support tools");
  f.state.companyMaster = master; f.state.adminDbSelectedCompanyId = "b"; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(built.length, 3);
  f.state.adminDbSelectedCompanyId = "a"; f.state.activeTab = "monthlyReports"; f.context.handleAdminDbReviewToggle({ target: support }); assert.equal(built.length, 3);
});

test("a 543-company master opens only the exact review target before the saved month, then searches and expands the full master", async () => {
  const f = fixture(), classified = [], profiled = [], searched = [], listed = [], grouped = [];
  for (let index = 2; index < 543; index++) f.state.companyMaster.companies.push({ companyId: `company-${index}`, primaryName: `업체 ${index}`, detailLoaded: false });
  const master = f.state.companyMaster;
  f.context.adminDbClassifyCompany = company => { classified.push(company.companyId); return {}; };
  f.context.adminDbCompanyProfile = company => { profiled.push(company.companyId); return {}; };
  f.context.adminDbGroupedRows = rows => { grouped.push(rows.length); return []; };
  f.context.adminDbRows = input => { assert.equal(input, master); searched.push(input.companies.length); return input.companies.map(company => ({ company })); };
  f.context.adminDbSearchDraft = () => ({ context: "review:a", generation: 1, value: f.state.testSearch || "", closed: false });
  f.context.compactSearchText = value => String(value).trim();
  f.context.adminDbAutocompleteSuggestions = (rows, query) => rows.filter(row => row.company.primaryName.includes(query));
  f.context.adminDbCompanyDetailUrl = id => `/admin?adminCompany=${id}`;
  vm.runInContext(["adminDbCompanySearchShellHtml", "adminDbCompanyAutocompleteHtml"].map(declaration).join("\n"), f.context);
  f.context.adminDbMetricCard = (label, value) => `<strong>${label}:${value}</strong>`;
  f.render(); await settle();
  assert.equal(f.state.companyMaster, master); assert.equal(master.companies.length, 543);
  assert.deepEqual(classified, ["a"]); assert.deepEqual(profiled, ["a"]);
  assert.equal(f.filterCalls.length, 0); assert.deepEqual(grouped, []); assert.deepEqual(searched, []);
  assert.equal(f.integratedRequests.length, 1); assert.equal(f.integratedRequests[0].companyId, "a");
  assert.match(f.board.textContent, /543개 업체/);
  assert.equal(f.detailRequests.length, 0);
  await f.shown(); const selected = f.selected(), controller = f.controllers[0];
  f.state.testSearch = "업체 542"; f.render(); await settle();
  assert.deepEqual(searched, [543]);
  assert.equal(f.board.querySelector('[data-admin-db-company-select="company-542"]')?.textContent.includes("업체 542"), true);
  assert.equal(f.selected(), selected); assert.equal(f.controllers.at(-1), controller); assert.equal(f.integratedRequests.length, 1);
  const support = f.board.querySelector(".admin-db-review-support"); support.open = true; f.context.handleAdminDbReviewToggle({ target: support });
  assert.equal(f.filterCalls.length, 1); assert.equal(f.filterCalls[0], master);
  assert.match(support.textContent, /전체 업체:543/); assert.equal(f.selected(), selected); assert.equal(f.integratedRequests.length, 1);
  f.state.adminDbViewMode = "list"; f.state.testSearch = "";
  f.context.adminDbCompanyExplorerHtml = value => { listed.push(value.rows.length); return "<div>전체 목록</div>"; };
  f.render(); assert.deepEqual(listed, [543]); assert.equal(f.filterCalls.length, 2); assert.deepEqual(grouped, [543, 543]);
  assert.equal(master.companies.length, 543); assert.equal(master.companies.every(company => company.detailLoaded === false), true);
});

test("an unknown review target never shows another company or starts its saved/detail requests", async () => {
  const f = fixture(); f.state.adminDbSelectedCompanyId = "not-in-master"; f.state.adminDbRouteCompanyId = "not-in-master";
  f.render(); await settle();
  assert.equal(f.selected(), null); assert.equal(f.integratedRequests.length, 0); assert.equal(f.detailRequests.length, 0);
  assert.equal(f.filterCalls.length, 0); assert.match(f.board.textContent, /선택한 업체를 찾을 수 없습니다/);
  assert.equal(f.board.querySelector('[role="alert"]')?.textContent.includes("현재 업체 DB"), true);
  assert.equal(f.state.adminDbSelectedCompanyId, "not-in-master"); assert.equal(f.state.companyMaster.companies.length, 2);
});

test("restoring a company route establishes its exact target before one DB render from either tab or section", async () => {
  for (const tab of ["admin", "report"]) {
    const f = fixture(), profiles = []; let renders = 0;
    f.state.activeTab = tab; f.state.adminPanelSection = "overview"; f.state.adminDbViewMode = "list"; f.state.adminDbSelectedCompanyId = "b";
    f.context.adminDbCompanyIdFromRoute = () => "a";
    f.context.adminDbCompanyProfile = company => { profiles.push(company.companyId); return {}; };
    const render = () => { renders++; f.context.renderAdminDatabaseDashboard(); };
    f.context.renderAdminConsoleDashboard = render;
    f.context.setActiveTab = target => { f.state.activeTab = target; f.state.analysisNavigationSequence = (f.state.analysisNavigationSequence || 0) + 1; render(); };
    f.context.setAdminPanelSection = section => { const previous = f.state.adminPanelSection; f.state.adminPanelSection = section; if (previous !== section) render(); };
    vm.runInContext(declaration("handleAdminDbCompanyHash"), f.context);
    assert.equal(f.context.handleAdminDbCompanyHash(), true); await settle();
    assert.equal(renders, 1); assert.deepEqual(profiles, ["a"]); assert.equal(f.filterCalls.length, 0);
    assert.equal(f.integratedRequests.length, 1); assert.equal(f.integratedRequests[0].companyId, "a");
    assert.equal(f.detailRequests.length, 0); assert.equal(f.state.companyMaster.companies.length, 2);
  }
});

test("selected route state without a current controller is repaired once, while valid, missing and legacy views never loop", async () => {
  const f = fixture(); let renders = 0;
  f.context.adminDbCompanyIdFromRoute = () => "a";
  f.context.setAdminPanelSection = section => { f.state.adminPanelSection = section; };
  f.context.renderAdminConsoleDashboard = () => { renders++; f.context.renderAdminDatabaseDashboard(); };
  vm.runInContext(declaration("handleAdminDbCompanyHash"), f.context);
  assert.equal(f.state.adminDbViewMode, "review"); assert.equal(f.state.adminDbSelectedCompanyId, "a");
  assert.equal(f.state.adminDbIntegratedPanelContext, undefined, "the old selected-only race has no actual controller yet");
  assert.equal(f.context.handleAdminDbCompanyHash(), true); await settle();
  assert.equal(renders, 1); assert.equal(f.integratedRequests.length, 1); assert.equal(f.detailRequests.length, 0);
  const selected = f.selected(), controller = f.controllers[0];
  for (let index = 0; index < 20; index++) assert.equal(f.context.handleAdminDbCompanyHash(), true);
  assert.equal(renders, 1); assert.equal(f.integratedRequests.length, 1); assert.equal(f.selected(), selected); assert.equal(f.controllers.at(-1), controller);
  f.state.companyMaster = { ...f.state.companyMaster, sourceRevision: "target-removed", companies: [f.state.companyMaster.companies[1]] };
  assert.equal(f.context.handleAdminDbCompanyHash(), true); await settle();
  assert.equal(renders, 2); assert.match(f.board.textContent, /선택한 업체를 찾을 수 없습니다/);
  const savedRequests = f.integratedRequests.length, detailRequests = f.detailRequests.length;
  for (let index = 0; index < 20; index++) assert.equal(f.context.handleAdminDbCompanyHash(), true);
  assert.equal(renders, 2); assert.equal(f.integratedRequests.length, savedRequests); assert.equal(f.detailRequests.length, detailRequests);
  assert.equal(detailRequests, 0, "a known missing exact target never starts a different or unknown company read");
  f.context.window.CompanyIntegrated = undefined;
  for (let index = 0; index < 20; index++) assert.equal(f.context.handleAdminDbCompanyHash(), true);
  assert.equal(renders, 2); assert.equal(f.integratedRequests.length, savedRequests); assert.equal(f.detailRequests.length, 0);
});

test("an unchanged freshly checked bootstrap preserves the hydrated row and current integrated controller", async () => {
  const f = fixture(); f.state.companyMaster.representation = "bootstrap";
  f.render(); await settle(); await f.shown(); await f.respondDetail();
  const master = f.state.companyMaster, company = master.companies[0], selected = f.selected(), controller = f.controllers[0];
  const requests = f.integratedRequests.length;
  vm.runInContext(["companyMasterReadIsCurrent", "loadCompanyMasterSummary"].map(declaration).join("\n"), f.context);
  f.context.renderAdminStartupReadiness = () => {};
  f.context.loadRecrawlEtaEstimates = async () => {};
  f.context.fetchJson = async () => ({ ...master, companies: master.companies.map(row => ({ companyId: row.companyId, primaryName: row.primaryName, detailLoaded: false })) });
  assert.equal(await f.context.loadCompanyMasterSummary({ force: true }), true);
  assert.equal(f.state.companyMaster, master); assert.equal(master.companies[0], company); assert.equal(company.detailLoaded, true);
  f.render(); assert.equal(f.selected(), selected); assert.equal(f.controllers.at(-1), controller); assert.equal(f.integratedRequests.length, requests);
  f.context.fetchJson = async () => ({ ...master, sourceRevision: "fixture-v2", companies: master.companies.map(row => ({ companyId: row.companyId, primaryName: row.primaryName, detailLoaded: false })) });
  assert.equal(await f.context.loadCompanyMasterSummary({ force: true }), true);
  assert.notEqual(f.state.companyMaster, master); assert.equal(f.state.companyMaster.sourceRevision, "fixture-v2");
  f.render(); await settle(); assert.notEqual(f.selected(), selected); assert.equal(f.integratedRequests.length, requests + 1);
});

test("detail hydration preserves the integrated DOM, controller, selected month and successful request", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const node = f.selected(), controller = f.controllers.at(-1);
  const august = controller.load("2026-08"); await f.respondIntegrated(); await august;
  await f.frame(); await f.frame();
  const requestsBefore = f.integratedRequests.length;
  const monthInput = node.querySelector("[data-ci-month]"); monthInput.focus();
  await f.respondDetail();
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
  assert.equal(f.selected(), node, "the saved integrated card is moved, not recreated");
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(f.integratedRequests.length, requestsBefore, "hydration does not reload the same integrated data");
  assert.equal(f.document.activeElement, monthInput, "the previously focused month input is restored after detach/replace");
  assert.equal(monthInput.lastFocusOptions?.preventScroll, true);
  assert.match(node.textContent, /100만원/);
  f.render(); await settle();
  assert.equal(f.selected(), node); assert.equal(f.integratedRequests.length, requestsBefore);
});

test("changing the month during first load or first paint follows the newest display and starts detail exactly once", async () => {
  for (const phase of ["before-response", "between-frames"]) {
    const f = fixture(); f.render(); await settle();
    const controller = f.state.adminDbIntegratedPanelContext.controller;
    if (phase === "between-frames") { await f.respondIntegrated(0); await f.frame(); }
    const august = controller.load("2026-08"); await settle();
    assert.equal(f.integratedRequests.length, 2); assert.equal(f.detailRequests.length, 0);
    assert.equal(f.integratedRequests[0].signal.aborted, true);
    if (phase === "before-response") await f.respondIntegrated(0);
    assert.equal(f.detailRequests.length, 0, "the superseded September result cannot unlock detail");
    await f.respondIntegrated(1); await august;
    await f.frame(); assert.equal(f.detailRequests.length, 0, phase);
    await f.frame(); assert.equal(f.detailRequests.length, 1, phase);
    assert.equal(controller.state.month, "2026-08");
    assert.equal(controller.state.envelope.selectedMonth, "2026-08");
    await f.respondDetail();
    assert.equal(f.integratedRequests.length, 2); assert.equal(f.detailRequests.length, 1);
    assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  }
});

test("both direct selection entry points use the integrated first-display barrier", async () => {
  for (const method of ["activateAdminDbCompanyDetail", "openAdminDbCompanyReview"]) {
    const f = fixture(); f.context[method]("a", { scroll: false, updateRoute: false }); await settle();
    assert.equal(f.detailRequests.length, 0, method);
    assert.equal(f.integratedRequests.length, 1, method);
    await f.respondIntegrated(); await f.frame(); assert.equal(f.detailRequests.length, 0, method);
    await f.frame(); assert.equal(f.detailRequests.length, 1, method);
  }
});

test("a company switch before first display cannot start or hydrate the abandoned company", async () => {
  const f = fixture(); f.render(); await settle(); const abandoned = f.selected();
  f.choose("b"); await settle();
  assert.equal(abandoned.isConnected, false); assert.equal(f.integratedRequests[0].signal.aborted, true);
  assert.equal(f.integratedRequests.length, 2); assert.equal(f.detailRequests.length, 0);
  await f.respondIntegrated(0); await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 0, "late company A cannot unlock company B's detail");
  await f.respondIntegrated(1); await f.frame(); await f.frame();
  assert.deepEqual(f.detailRequests.map(row => row.url), ["/api/company-master/detail?companyId=b"]);
  await f.respondDetail(); assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
  assert.equal(f.state.companyMaster.companies[1].detailLoaded, true);
});

test("hidden or replaced sessions cannot unlock a pending detail or retain a previous controller", async () => {
  for (const change of [f => { f.document.visibilityState = "hidden"; }, f => { f.board.hidden = true; },
    f => { f.state.session = { authenticated: true, role: "admin", marker: "new-session" }; },
    f => { f.state.activeTab = "home"; f.context.syncCompanyIntegratedPanel(); }]) {
    const f = fixture(); f.render(); await settle(); await f.respondIntegrated(); await f.frame();
    change(f); await f.frame(); await settle();
    assert.equal(f.detailRequests.length, 0);
    assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
  }
});

test("a temporarily hidden document defers detail once and resumes from the retained integrated card on return", async () => {
  const f = fixture(); f.render(); await settle(); await f.respondIntegrated(); await f.frame();
  const node = f.selected(); f.document.visibilityState = "hidden";
  await f.frame(); await settle();
  assert.equal(f.detailRequests.length, 0); assert.equal(f.state.adminDbCompanyDetailLoading.a, undefined);
  assert.equal(f.integratedRequests.length, 1, "hiding never starts an automatic retry loop");
  f.document.visibilityState = "visible"; f.context.resumeAdminDbCompanyDetailAfterReturn(); await settle();
  await f.frame(); await f.frame();
  assert.equal(f.selected(), node); assert.equal(f.integratedRequests.length, 1);
  assert.equal(f.detailRequests.length, 1);
});

test("a previously displayed card cannot unlock a forced detail GET after the document becomes hidden", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  assert.equal(f.detailRequests.length, 1);
  f.document.visibilityState = "hidden";
  void f.context.loadAdminDbCompanyDetail("a", { force: true }); await settle();
  assert.equal(f.detailRequests.length, 1, "the old successful display ticket is no longer evidence that the card is visible");
});

test("an integrated error can display honestly and a later hidden detail error cannot overwrite another selection", async () => {
  const f = fixture(); f.render(); await settle();
  f.integratedRequests[0].reject(new Error("저장 통합자료 읽기 오류")); await settle();
  assert.match(f.selected().textContent, /저장 통합자료 읽기 오류/);
  await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 1, "displayed error releases the barrier without fabricating a zero result");
  f.choose("b"); await settle(); const currentNode = f.selected();
  f.detailRequests[0].reject(new Error("late company A detail failure")); await settle();
  assert.equal(f.selected(), currentNode); assert.equal(f.state.adminDbSelectedCompanyId, "b");
  assert.doesNotMatch(f.board.textContent, /late company A/);
});

test("a correction or source revision arriving during detail load wins and invalidates the old saved card context", async () => {
  for (const correction of [false, true]) {
    const f = fixture(); f.render(); await settle(); await f.shown();
    const original = f.state.companyMaster.companies[0], oldNode = f.selected();
    if (correction) original.manualCorrection = { lodgingBasisTotal: 16 };
    else f.state.companyMaster.sourceRevision = "fixture-v2";
    await f.respondDetail(0, { manualCorrection: { lodgingBasisTotal: 17 } });
    assert.equal(f.state.companyMaster.companies[0], original);
    assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
    if (correction) assert.equal(original.manualCorrection.lodgingBasisTotal, 16);
    assert.equal(f.state.adminDbCompanyDetails?.a, undefined);
    if (!correction) assert.notEqual(f.selected(), oldNode, "a changed source must not retain a previous revision's integrated view");
  }
});

test("a forced correction refresh disposes the old card and waits for the corrected saved result before its new detail GET", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const oldNode = f.selected(), oldController = f.state.adminDbIntegratedPanelContext.controller;
  const company = f.state.companyMaster.companies[0];
  company.manualCorrection = { lodgingBasisTotal: 16 }; company.manualCorrectionRevision = 2;
  const refreshed = f.context.loadAdminDbCompanyDetail("a", { force: true }); await settle();
  assert.notEqual(f.selected(), oldNode); assert.equal(oldNode.isConnected, false);
  assert.notEqual(f.state.adminDbIntegratedPanelContext.controller, oldController);
  assert.equal(f.integratedRequests.length, 2); assert.equal(f.detailRequests.length, 1);
  await f.respondDetail(0, { manualCorrection: { lodgingBasisTotal: 17 } });
  assert.equal(f.state.companyMaster.companies[0], company);
  assert.equal(company.manualCorrection.lodgingBasisTotal, 16);
  await f.respondIntegrated(1); await f.frame(); assert.equal(f.detailRequests.length, 1);
  await f.frame(); assert.equal(f.detailRequests.length, 2);
  await f.respondDetail(1, { manualCorrection: { lodgingBasisTotal: 16 }, manualCorrectionRevision: 2 }); await refreshed;
  assert.equal(f.state.companyMaster.companies[0].manualCorrection.lodgingBasisTotal, 16);
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
});

test("a detail response arriving during a different month request preserves that request and its eventual numbers", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const node = f.selected(), controller = f.controllers.at(-1);
  const august = controller.load("2026-08"); await settle();
  assert.equal(controller.state.month, "2026-08");
  assert.equal(controller.state.loading, true);
  assert.equal(f.detailRequests.length, 1);
  await f.respondDetail(0, { products: [{ id: "not-a-monthly-total", capacity: 99 }] });
  assert.equal(f.selected(), node, "detail hydration cannot replace the month controller while its GET is in flight");
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(controller.state.loading, true);
  assert.equal(f.integratedRequests.length, 2);
  assert.equal(f.integratedRequests[1].signal.aborted, false, "detail hydration does not abort the selected month's request");
  await f.respondIntegrated(1, { sold: 7, publicBookings: 5, phoneBookings: 2,
    publicRevenue: 1000000, phoneRevenue: 400000, estimatedRevenue: 1400000 }); await august;
  const snapshot = JSON.stringify(controller.state.envelope.snapshot);
  assert.equal(controller.state.envelope.snapshot.summary.lodging.sold, 7);
  assert.equal(controller.state.envelope.snapshot.summary.lodging.estimatedRevenue, 1400000);
  assert.match(node.textContent, /140만원/);
  f.render(); await settle();
  assert.equal(f.selected(), node);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  assert.equal(f.integratedRequests.length, 2, "product fields cannot trigger another integrated GET");
});

test("detail success cannot reset the month, tab, table view, selected date or rendered integrated figures", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const node = f.selected(), controller = f.controllers.at(-1);
  const august = controller.load("2026-08");
  await f.respondIntegrated(1, { sold: 9, publicBookings: 6, phoneBookings: 3, phonePricedBookings: 3,
    publicRevenue: 1200000, phoneRevenue: 600000, estimatedRevenue: 1800000 }); await august;
  controller.selectTab("analysis");
  controller.state.view = "table";
  for (const listener of node.listeners.get("click") || []) listener({ target: new Element("button", { "data-ci-date": "2026-08-03" }, f.document) });
  const before = node.innerHTML, snapshot = JSON.stringify(controller.state.envelope.snapshot);
  assert.match(before, /180만원/);
  await f.respondDetail(0, { products: [{ id: "room", quantity: 99 }], recentObservations: [{ sold: 999 }] });
  assert.equal(f.selected(), node);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(controller.state.tab, "analysis");
  assert.equal(controller.state.view, "table");
  assert.equal(controller.state.selectedDate, "2026-08-03");
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  assert.equal(node.innerHTML, before, "company fields cannot replace the server's saved integrated figures");
});

test("a detail failure retains a selected month's last successful card and never fabricates zeroes", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const node = f.selected(), controller = f.controllers.at(-1);
  const snapshot = JSON.stringify(controller.state.envelope.snapshot), before = node.innerHTML;
  f.detailRequests[0].reject(new Error("상품·상세이력 조회 지연")); await settle();
  assert.equal(f.selected(), node);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(controller.state.month, "2026-09");
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  assert.equal(node.innerHTML, before);
  assert.equal(controller.state.envelope.snapshot.summary.lodging.sold, 5);
  assert.equal(controller.state.envelope.snapshot.summary.lodging.estimatedRevenue, 1000000);
  assert.match(f.state.adminDbCompanyDetails.a.error, /상품·상세이력 조회 지연/);
  assert.equal(f.integratedRequests.length, 1);
});

test("a late detail success for a previously selected company cannot hydrate or redraw another company's card", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  f.choose("b"); await settle();
  await f.respondIntegrated(1, { sold: 8, publicBookings: 6, phoneBookings: 2,
    publicRevenue: 1200000, phoneRevenue: 400000, estimatedRevenue: 1600000 });
  await f.frame(); await f.frame();
  const node = f.selected(), controller = f.state.adminDbIntegratedPanelContext.controller;
  const before = node.innerHTML;
  assert.equal(f.detailRequests.length, 2);
  await f.respondDetail(0, { products: [{ id: "old-company-room", quantity: 99 }] });
  assert.equal(f.state.adminDbSelectedCompanyId, "b");
  assert.equal(f.selected(), node);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(node.innerHTML, before);
  assert.equal(controller.state.envelope.companyId, "b");
  assert.equal(controller.state.envelope.snapshot.summary.lodging.sold, 8);
  assert.equal(f.state.companyMaster.companies[1].detailLoaded, false);
  assert.equal(f.state.adminDbCompanyDetails?.b, undefined);
});

test("detail arrival updates only the selected panel and preserves search, sibling nodes and the integrated card", async () => {
  for (const fails of [false, true]) {
    const f = fixture(); f.render(); await settle(); await f.shown();
    const panel = f.board.querySelector("[data-admin-db-selected-company]"), node = f.selected();
    const controller = f.state.adminDbIntegratedPanelContext.controller;
    const search = new Element("input", { id: "outside-detail-search" }, f.document);
    search.value = "월명 글램핑"; search.selectionStart = 2; search.selectionEnd = 4; search.focus();
    const sibling = new Element("aside", { "data-unrelated-summary": "" }, f.document);
    sibling.innerHTML = "선택 패널 밖의 기존 요약";
    f.board.appendChild(search); f.board.appendChild(sibling);
    search.focus();
    const integratedHtml = node.innerHTML, snapshot = JSON.stringify(controller.state.envelope.snapshot);
    const filterCount = f.filterCalls.length;
    if (fails) { f.detailRequests[0].reject(new Error("상세 자료 읽기 지연")); await settle(); }
    else await f.respondDetail(0, { products: [{ id: "room", quantity: 99 }] });
    assert.equal(f.board.querySelector("[data-admin-db-selected-company]"), panel, "the selected section itself retains identity");
    assert.equal(f.board.querySelector("#outside-detail-search"), search);
    assert.equal(f.board.querySelector("[data-unrelated-summary]"), sibling);
    assert.equal(search.value, "월명 글램핑");
    assert.equal(search.selectionStart, 2); assert.equal(search.selectionEnd, 4);
    assert.equal(f.document.activeElement, search, "a user searching outside the detail panel keeps focus");
    assert.equal(f.filterCalls.length, filterCount, "detail hydration does not refilter every stored company");
    assert.equal(f.selected(), node);
    assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
    assert.equal(controller.state.month, "2026-09");
    assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
    assert.equal(node.innerHTML, integratedHtml);
  }
});

test("a forced detail refresh keeps the surrounding UI during both loading and hydration", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown(); await f.respondDetail();
  const panel = f.board.querySelector("[data-admin-db-selected-company]"), node = f.selected();
  const search = new Element("input", { id: "retained-search" }, f.document);
  search.value = "선택 월 유지"; f.board.appendChild(search); search.focus();
  const filterCount = f.filterCalls.length, before = node.innerHTML;
  const refresh = f.context.loadAdminDbCompanyDetail("a", { force: true }); await settle();
  assert.equal(f.board.querySelector("#retained-search"), search);
  assert.equal(f.board.querySelector("[data-admin-db-selected-company]"), panel);
  assert.equal(f.selected(), node); assert.equal(node.innerHTML, before);
  assert.equal(f.document.activeElement, search);
  assert.equal(f.filterCalls.length, filterCount);
  await f.respondDetail(1); await refresh;
  assert.equal(f.board.querySelector("#retained-search"), search);
  assert.equal(f.selected(), node); assert.equal(node.innerHTML, before);
  assert.equal(f.document.activeElement, search);
  assert.equal(f.filterCalls.length, filterCount);
});

test("a replaced bootstrap master retries stale detail once while preserving the newest selected month and figures", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const oldCompany = f.state.companyMaster.companies[0];
  const august = f.state.adminDbIntegratedPanelContext.controller.load("2026-08");
  await f.respondIntegrated(1); await august; await f.frame(); await f.frame();
  const oldMaster = f.state.companyMaster;
  f.state.companyMaster = { ...oldMaster, companies: oldMaster.companies.map(row => ({ ...row })) };
  f.render(); await settle();
  await f.respondIntegrated(2, { sold: 7, publicBookings: 5, phoneBookings: 2,
    publicRevenue: 1000000, phoneRevenue: 400000, estimatedRevenue: 1400000 });
  await f.frame(); await f.frame();
  const company = f.state.companyMaster.companies[0], node = f.selected();
  const controller = f.state.adminDbIntegratedPanelContext.controller;
  const before = node.innerHTML, snapshot = JSON.stringify(controller.state.envelope.snapshot);
  assert.notEqual(company, oldCompany);
  assert.equal(f.detailRequests.length, 1, "a master refresh shares the original in-flight GET until it drains");
  await f.respondDetail(0, { marker: "old-context", manualCorrection: { lodgingBasisTotal: 99 } });
  assert.equal(f.detailRequests.length, 2, "the stale response schedules exactly one fresh context GET");
  assert.equal(f.state.companyMaster.companies[0], company);
  assert.equal(company.detailLoaded, false);
  assert.equal(company.manualCorrection, undefined);
  assert.equal(f.selected(), node); assert.equal(node.innerHTML, before);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  assert.equal(f.integratedRequests.length, 3, "detail retry reuses the already displayed month");
  await f.respondDetail(1, { marker: "fresh-context" });
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
  assert.equal(f.state.companyMaster.companies[0].marker, "fresh-context");
  assert.equal(f.selected(), node); assert.equal(node.innerHTML, before);
  assert.equal(controller.state.month, "2026-08");
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  assert.equal(f.detailRequests.length, 2);
});

test("consecutive master replacements stop after one automatic detail retry and show an explicit retry action", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const replace = () => { const old = f.state.companyMaster;
    f.state.companyMaster = { ...old, companies: old.companies.map(row => ({ ...row })) }; f.render(); };
  replace(); await settle(); await f.respondIntegrated(); await f.frame(); await f.frame();
  await f.respondDetail(0, { marker: "first-stale" });
  assert.equal(f.detailRequests.length, 2);
  replace(); await settle(); await f.respondIntegrated(); await f.frame(); await f.frame();
  const node = f.selected(), controller = f.state.adminDbIntegratedPanelContext.controller;
  const snapshot = JSON.stringify(controller.state.envelope.snapshot);
  await f.respondDetail(1, { marker: "second-stale" });
  assert.equal(f.detailRequests.length, 2, "repeated source replacement cannot create an automatic request loop");
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
  assert.equal(f.state.companyMaster.companies[0].marker, undefined);
  assert.match(f.state.adminDbCompanyDetails.a.error, /다시 갱신/);
  assert.match(f.board.textContent, /다시 불러오기/);
  assert.equal(f.selected(), node);
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
});

test("a stale detail cannot retry after selection, session, role or app view boundaries change", async () => {
  for (const leave of [f => { f.state.adminDbSelectedCompanyId = "b"; },
    f => { f.state.session = { ...f.state.session, marker: "new-session" }; },
    f => { f.state.session.authenticated = false; }, f => { f.state.session.role = "b2b"; },
    f => { f.state.activeTab = "home"; }, f => { f.state.adminPanelSection = "overview"; },
    f => { f.state.adminDbViewMode = "list"; }]) {
    const f = fixture(); f.render(); await settle(); await f.shown();
    const old = f.state.companyMaster;
    f.state.companyMaster = { ...old, companies: old.companies.map(row => ({ ...row })) };
    f.context.renderAdminConsoleDashboard = () => {};
    f.context.adminDbCompanyExplorerHtml = () => "";
    leave(f);
    await f.respondDetail(0, { marker: "stale-context" });
    await f.frame(); await f.frame(); await settle();
    assert.equal(f.detailRequests.length, 1);
    assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
    assert.equal(f.state.companyMaster.companies[0].marker, undefined);
    assert.equal(f.state.adminDbCompanyDetails?.a, undefined);
  }
});

test("a master refresh in a background browser tab resumes one fresh detail after the retained card becomes visible", async () => {
  const f = fixture(); f.render(); await settle(); await f.shown();
  const old = f.state.companyMaster;
  f.state.companyMaster = { ...old, companies: old.companies.map(row => ({ ...row })) };
  f.render(); await settle(); await f.respondIntegrated(); await f.frame(); await f.frame();
  const node = f.selected(), controller = f.state.adminDbIntegratedPanelContext.controller;
  const snapshot = JSON.stringify(controller.state.envelope.snapshot);
  f.document.visibilityState = "hidden";
  await f.respondDetail(0, { marker: "stale-context" });
  assert.equal(f.detailRequests.length, 1, "background hydration continues to respect the visible-card barrier");
  assert.equal(f.state.adminDbCompanyDetailLoading.a, undefined);
  assert.equal(f.state.adminDbCompanyDetails?.a, undefined);
  f.document.visibilityState = "visible";
  f.context.resumeAdminDbCompanyDetailAfterReturn(); await settle(); await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 2, "returning to the tab resumes the latest company's detail once");
  assert.equal(f.selected(), node);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(JSON.stringify(controller.state.envelope.snapshot), snapshot);
  await f.respondDetail(1, { marker: "fresh-context" });
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
  assert.equal(f.state.companyMaster.companies[0].marker, "fresh-context");
  assert.equal(f.detailRequests.length, 2);
});

test("a master refresh before first card display follows the current display and sends only one detail GET", async () => {
  const f = fixture(); f.render(); await settle();
  assert.equal(f.integratedRequests.length, 1); assert.equal(f.detailRequests.length, 0);
  const old = f.state.companyMaster;
  f.state.companyMaster = { ...old, companies: old.companies.map(row => ({ ...row })) };
  f.render(); await settle();
  assert.equal(f.integratedRequests.length, 2);
  assert.equal(f.integratedRequests[0].signal.aborted, true);
  assert.equal(f.detailRequests.length, 0);
  await f.respondIntegrated(0); await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 0, "the abandoned card cannot release a heavy detail read");
  await f.respondIntegrated(1); await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 1);
  const node = f.selected(), controller = f.state.adminDbIntegratedPanelContext.controller;
  const before = node.innerHTML;
  await f.respondDetail(0, { marker: "fresh-context" });
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
  assert.equal(f.state.companyMaster.companies[0].marker, "fresh-context");
  assert.equal(f.selected(), node); assert.equal(node.innerHTML, before);
  assert.equal(f.state.adminDbIntegratedPanelContext.controller, controller);
  assert.equal(f.detailRequests.length, 1);
});

test("a second master replacement before the retry's first display renders its explicit retry error", async () => {
  const f = fixture(); f.render(); await settle();
  const replace = () => { const old = f.state.companyMaster;
    f.state.companyMaster = { ...old, companies: old.companies.map(row => ({ ...row })) }; f.render(); };
  replace(); await settle();
  assert.equal(f.integratedRequests.length, 2);
  assert.equal(f.detailRequests.length, 0);
  assert.equal(f.state.adminDbCompanyDetailLoading.a, true);
  replace(); await settle();
  assert.equal(f.integratedRequests.length, 3);
  assert.equal(f.detailRequests.length, 0);
  assert.equal(f.state.adminDbCompanyDetailLoading.a, undefined);
  assert.match(f.state.adminDbCompanyDetails.a.error, /다시 갱신/);
  assert.match(f.board.textContent, /다시 갱신/);
  assert.match(f.board.textContent, /다시 불러오기/);
  assert.doesNotMatch(f.board.textContent, /상품·상세이력 준비 중/);
  await f.respondIntegrated(2); await f.frame(); await f.frame();
  assert.equal(f.detailRequests.length, 0, "the retry action is explicit after the single automatic attempt is spent");
  assert.match(f.board.textContent, /다시 불러오기/);
});
