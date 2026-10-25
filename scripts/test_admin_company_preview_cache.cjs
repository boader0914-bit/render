"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { create } = require("../web/admin-company-preview-cache.js");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const integrated = fs.readFileSync(path.join(__dirname, "../web/company-integrated.js"), "utf8");
const declaration = name => app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))[0];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  let time = Date.parse("2026-10-25T00:00:00Z");
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const cache = create({ storage, now: () => time });
  const session = { authenticated: true, username: "admin-fixture", role: "admin", sessionCreatedAt: "2026-10-24T23:00:00Z", expiresAt: "2026-10-25T12:00:00Z" };
  const context = { companyId: "company-one", companyName: "[모의] 업체", sourceRevision: "source-one", correctionRevision: 7, updatedAt: "2026-10-24T23:00:00Z", isCurrent: () => true };
  const envelope = { companyId: context.companyId, selectedMonth: "2026-10", status: "ready", calculatedAt: "2026-10-24T23:30:00Z",
    freshness: { selectedMonthVerified: true }, snapshot: { request: { type: "company", targetId: context.companyId, month: "2026-10" },
      target: { type: "company", id: context.companyId }, summary: { lodging: { sold: 0, estimatedRevenue: null, missingPriceBookings: 1 } },
      daily: [{ date: "2026-10-01", lodging: { sold: 0, estimatedRevenue: 0 } }, { date: "2026-10-02", lodging: { sold: null, estimatedRevenue: null } }] } };
  cache.configure(session);
  return { cache, values, storage, session, context, envelope, advance: value => { time += value; }, time: () => time };
}
test("only an exact fresh admin session restores one bounded read-only company and month", () => {
  const f = fixture(), before = JSON.stringify(f.envelope);
  assert.equal(f.cache.write(f.context, f.envelope), true);
  const saved = f.cache.read("company-one");
  assert.equal(saved.company.detailLoaded, false);
  assert.deepEqual(Object.keys(saved.company).sort(), ["companyId", "detailLoaded", "manualCorrectionRevision", "primaryName", "updatedAt"].sort());
  assert.equal(saved.envelope.freshness.savedPreview, true); assert.equal(saved.envelope.freshness.selectedMonthVerified, false);
  assert.equal(saved.envelope.freshness.browserPreview, true);
  assert.equal(saved.envelope.snapshot.summary.lodging.estimatedRevenue, null);
  assert.equal(saved.envelope.snapshot.daily[0].lodging.sold, 0); assert.equal(saved.envelope.snapshot.daily[1].lodging.sold, null);
  assert.equal(JSON.stringify(f.envelope), before);
  assert.equal(f.cache.read("company-other"), null); assert.equal(f.cache.read("company-one", "2026-09"), null);
  assert.equal(f.cache.read("company-one", "", { ...f.context, sourceRevision: "new" }), null);
  assert.equal(f.cache.read("company-one", "", { ...f.context, correctionRevision: 8 }), null);
  assert.equal(f.values.size, 1);
});
test("rolling expiry preserves the fixed login identity but different login, role and customer view erase it", () => {
  for (const change of [{ username: "other" }, { role: "b2b" }, { authenticated: false }, { sessionCreatedAt: "2026-10-24T23:01:00Z" }]) {
    const f = fixture(); f.cache.write(f.context, f.envelope);
    f.cache.configure({ ...f.session, expiresAt: "2026-10-25T13:00:00Z" }); assert.ok(f.cache.read("company-one"));
    f.cache.configure({ ...f.session, ...change }); assert.equal(f.cache.read("company-one"), null); assert.equal(f.values.size, 0);
  }
  const f = fixture(); f.cache.write(f.context, f.envelope); f.cache.configure(f.session, { customerView: true });
  assert.equal(f.cache.read("company-one"), null); assert.equal(f.values.size, 0);
});
test("expiry, clock reversal, TTL and default-calendar rollover cannot reuse a saved default", () => {
  for (const delta of [31 * 60 * 1000, -1, 13 * 60 * 60 * 1000]) {
    const f = fixture(); f.cache.write(f.context, f.envelope); f.advance(delta); assert.equal(f.cache.read("company-one"), null);
  }
  const f = fixture(); f.advance(Date.parse("2026-10-31T14:59:00Z") - f.time());
  f.cache.configure({ ...f.session, expiresAt: "2026-11-01T12:00:00Z" }); f.cache.write(f.context, f.envelope); f.advance(2 * 60 * 1000);
  assert.equal(f.cache.read("company-one"), null, "a new KST month does not inherit the old default month");
});
test("explicit historical months never seed the empty default key and the alias survives only matching normal responses", () => {
  const f = fixture(), historical = structuredClone(f.envelope);
  historical.selectedMonth = historical.snapshot.request.month = "2026-09";
  assert.equal(f.cache.write(f.context, historical, "2026-09"), true);
  assert.equal(f.cache.read("company-one"), null); assert.ok(f.cache.read("company-one", "2026-09"));
  assert.equal(f.cache.write(f.context, historical, "2026-10"), false);
  assert.equal(f.cache.write(f.context, f.envelope, ""), true); assert.ok(f.cache.read("company-one", ""));
});
test("failed, wrong-scope, stale-context and oversized envelopes never overwrite a normal saved value", () => {
  const f = fixture(); f.cache.write(f.context, f.envelope); const before = [...f.values.values()][0];
  for (const mutate of [e => { e.status = "failed"; }, e => { e.freshness.savedPreview = true; }, e => { e.snapshot.target.id = "other"; },
    e => { e.snapshot.request.month = "2026-09"; }, e => { e.freshness.selectedMonthVerificationError = "source_error"; },
    e => { e.snapshot.padding = "x".repeat(1500000); }]) {
    const e = structuredClone(f.envelope); mutate(e); assert.equal(f.cache.write(f.context, e), false); assert.equal([...f.values.values()][0], before);
  }
  assert.equal(f.cache.write({ ...f.context, isCurrent: () => false }, f.envelope), false);
  f.advance(13 * 60 * 60 * 1000); assert.equal(f.cache.write(f.context, f.envelope), false); assert.equal(f.values.size, 0);
});
test("only the real monthly DTO shape with lodging summary and daily array is cacheable on write and restore", () => {
  for (const mutate of [snapshot => { delete snapshot.summary.lodging; }, snapshot => { snapshot.summary.lodging = null; },
    snapshot => { snapshot.summary.lodging = []; }, snapshot => { delete snapshot.daily; }, snapshot => { snapshot.daily = {}; }]) {
    const f = fixture(), invalid = structuredClone(f.envelope); mutate(invalid.snapshot);
    assert.equal(f.cache.write(f.context, invalid), false);
    assert.equal(f.cache.write(f.context, f.envelope), true);
    const key = [...f.values.keys()][0], stored = JSON.parse(f.values.get(key)); mutate(stored.envelope.snapshot);
    f.values.set(key, JSON.stringify(stored)); assert.equal(f.cache.read(f.context.companyId), null);
  }
});
test("corrupt and quota-denied storage are cache misses; blocked storage getter cannot prevent app scripts", () => {
  const f = fixture(); f.cache.write(f.context, f.envelope); const key = [...f.values.keys()][0];
  f.values.set(key, "{"); assert.equal(f.cache.read("company-one"), null); assert.equal(f.values.size, 0);
  f.values.set(key, "x".repeat(1500001)); assert.equal(f.cache.read("company-one"), null);
  const denied = create({ storage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); }, removeItem() {} }, now: f.time });
  denied.configure(f.session); assert.equal(denied.read("company-one"), null); assert.equal(denied.write(f.context, f.envelope), false);
  const window = {}; Object.defineProperty(window, "sessionStorage", { get() { throw new Error("blocked"); } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../web/admin-company-preview-cache.js"), "utf8"), { window });
  assert.equal(typeof window.AdminCompanyPreviewCache.read, "function");
});

function controllerFixture({ failStatus = 0 } = {}) {
  const f = fixture(); f.cache.write(f.context, f.envelope);
  const frames = [], timers = new Map(), response = deferred(), requests = [], latest = [], writes = [], hooks = {};
  const cache = { ...f.cache, write(...args) { writes.push(args); return f.cache.write(...args); } };
  const window = { AdminCompanyPreviewCache: cache, document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setTimeout(fn) { const key = Symbol(); timers.set(key, fn); return key; }, clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { frames.push(fn); return fn; }, cancelAnimationFrame() {} };
  const container = { innerHTML: "", dataset: {}, isConnected: true, addEventListener() {}, removeEventListener() {}, closest() { return null; }, getClientRects() { return [{}]; } };
  vm.runInNewContext(integrated, { window, AbortController, URLSearchParams, console, setTimeout });
  const controller = window.CompanyIntegrated.createController(container, { fetchData: async (companyId, month, signal, options) => {
    requests.push({ companyId, month, options }); const result = hooks.fetch ? await hooks.fetch(companyId, month, options) : await response.promise;
    if (failStatus) throw Object.assign(new Error("read error"), { status: failStatus }); return result;
  }, navigationTiming: { markNavigationLatestReady(value) { latest.push(value); return true; } } });
  return { ...f, window, controller, container, frames, timers, response, requests, latest, writes, hooks,
    async frame() { for (const fn of frames.splice(0)) fn(); await settle(); } };
}
test("actual controller renders cached saved data without a saved API call, then makes one exact normal month check", async () => {
  const f = controllerFixture(); await f.controller.open({ companyId: f.context.companyId, previewCacheContext: f.context });
  assert.equal(f.requests.length, 0); assert.equal(f.controller.state.month, "2026-10"); assert.match(f.container.innerHTML, /저장 자료 · 최신 확인 중/);
  assert.equal(f.container.dataset.ciInitialPreviewSource, "session");
  assert.equal(f.latest.length, 0); await f.frame(); await f.frame();
  const checked = f.controller.whenSourceChecked(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].month, "2026-10"); assert.equal(f.requests[0].options.savedPreview, undefined);
  f.response.resolve(f.envelope); await settle(); assert.equal(f.latest.length, 0);
  await f.frame(); assert.equal(f.latest.length, 0); await f.frame();
  assert.equal((await checked).status, "ready"); assert.equal(f.latest.length, 1);
  assert.equal(f.writes[0][2], "", "the initial default alias is retained while the normal request checks its exact displayed month");
  assert.ok(f.cache.read(f.context.companyId, "")); f.controller.dispose();
});
test("in-progress polling and same-month explicit retry retain the default alias, but manual historical selection does not", async () => {
  const f = controllerFixture(); await f.controller.open({ companyId: f.context.companyId, previewCacheContext: f.context });
  await f.frame(); await f.frame(); const checked = f.controller.whenSourceChecked(); await settle();
  const updating = structuredClone(f.envelope); updating.status = "refreshing";
  f.response.resolve(updating); await settle(); await f.frame(); await f.frame(); assert.equal((await checked).status, "refreshing");
  f.hooks.fetch = async () => f.envelope;
  const poll = [...f.timers.values()][0]; f.timers.clear(); poll(); await settle(); await f.frame(); await f.frame();
  assert.ok(f.cache.read(f.context.companyId, "")); assert.equal(f.writes.at(-1)[2], "");
  await f.controller.load(); assert.ok(f.cache.read(f.context.companyId, "")); assert.equal(f.writes.at(-1)[2], "");
  f.hooks.fetch = async (_id, month) => { const value = structuredClone(f.envelope); value.selectedMonth = value.snapshot.request.month = month; return value; };
  await f.controller.load("2026-09");
  // A saved-view response cannot overwrite the verified cache. Its subsequent
  // exact normal request can write only the explicitly selected historical key.
  await f.controller.load(); assert.equal(f.cache.read(f.context.companyId, ""), null);
  assert.ok(f.cache.read(f.context.companyId, "2026-09")); f.controller.dispose();
});
test("401/403 remove browser-restored private figures; source errors retain saved nulls and real zeros", async () => {
  for (const status of [401, 403, 503]) {
    const f = controllerFixture({ failStatus: status }); await f.controller.open({ companyId: f.context.companyId, previewCacheContext: f.context });
    await f.frame(); await f.frame(); const checked = f.controller.whenSourceChecked(); await settle(); f.response.resolve(f.envelope); await settle();
    await f.frame(); await f.frame(); assert.equal((await checked).status, "error");
    if (status === 503) { assert.ok(f.controller.state.envelope.snapshot); assert.ok(f.cache.read(f.context.companyId)); }
    else { assert.equal(f.controller.state.envelope.snapshot, undefined); assert.equal(f.values.size, 0); }
    assert.equal(f.latest.length, 0); f.controller.dispose();
  }
});
test("a later normal-value authentication failure revokes future browser previews without rewriting the existing normal value", async () => {
  const f = controllerFixture(); await f.controller.open({ companyId: f.context.companyId, previewCacheContext: f.context });
  await f.frame(); await f.frame(); const checked = f.controller.whenSourceChecked(); await settle(); f.response.resolve(f.envelope);
  await settle(); await f.frame(); await f.frame(); await checked;
  f.hooks.fetch = async () => { throw Object.assign(new Error("session expired"), { status: 401 }); };
  await f.controller.load(); assert.equal(f.values.size, 0); assert.equal(f.cache.read(f.context.companyId), null);
  assert.equal(f.controller.state.envelope.snapshot.summary.lodging.estimatedRevenue, null); f.controller.dispose();
});
test("the preview surface never presents a partial roster or company edit, review and collection controls", () => {
  const f = fixture(), preview = { browserCompanyPreview: true, companies: [{ companyId: "company-one", primaryName: "[모의] 업체" }] };
  const state = { session: f.session, companyMaster: preview, activeTab: "admin", adminPanelSection: "database", adminDbSelectedCompanyId: "company-one" };
  let html = "", route = "company-one";
  const context = { state, els: { adminDatabaseDashboard: {}, adminConsoleDashboard: {} }, window: {},
    isAdminRole: () => true, hideAdminRegionManagement() {}, adminDbCompanyIdFromRoute: () => route,
    escapeHtml: String, adminDbIntegratedContainerHtml: company => `<div data-company-integrated data-company-id="${company.companyId}"></div>`,
    adminDbReplaceBoardHtml: value => { html = value; }, syncCompanyIntegratedPanel() {} };
  vm.createContext(context); vm.runInContext(declaration("renderAdminDatabaseDashboard") + "\n" + declaration("renderAdminConsoleDashboard"), context);
  context.renderAdminDatabaseDashboard(preview); assert.match(html, /저장 자료 · 업체 정보 확인 중/); assert.match(html, /data-company-integrated/);
  assert.doesNotMatch(html, /<button|<form|<input|data-company-review|수집하기|전체 업체/);
  route = ""; context.renderAdminDatabaseDashboard(preview); assert.doesNotMatch(html, /data-company-integrated|1개 업체/);
  state.adminPanelSection = "overview"; context.renderAdminConsoleDashboard(preview);
  assert.match(context.els.adminConsoleDashboard.innerHTML, /업체 기본자료를 확인/); assert.doesNotMatch(context.els.adminConsoleDashboard.innerHTML, /1개|수집/);
});
test("canonical same-source handoff keeps the live master identity while restoring the complete roster", async () => {
  const f = fixture(); f.cache.write(f.context, f.envelope);
  const preview = f.cache.read("company-one"), requests = [], clears = [], invalidations = [], renders = [];
  const old = { representation: "bootstrap", browserCompanyPreview: true, sourceRevision: preview.sourceRevision, companies: [preview.company] };
  const fresh = { representation: "bootstrap", sourceRevision: old.sourceRevision, totalCompanies: 544,
    companies: [{ ...preview.company }, { companyId: "company-two" }], adminRegionalOperations: { regions: [{ id: "region" }] } };
  const state = { session: f.session, companyMaster: old };
  const context = { state, Promise, Number, String, Object, Array,
    window: { AdminCompanyPreviewCache: { clear: () => clears.push(1) }, AdminTransitionTiming: { invalidateNavigationLatest: code => invalidations.push(code) } },
    isAdminRole: () => state.session.role === "admin", fetchJson: async url => { requests.push(url); return fresh; },
    renderAdminStartupReadiness() {}, renderCompanyMasterPriorityView: () => renders.push(state.companyMaster), scheduleCompanyMasterEta() {} };
  vm.createContext(context); vm.runInContext(declaration("companyMasterReadIsCurrent") + "\n" + declaration("loadCompanyMasterSummary"), context);
  assert.equal(await context.loadCompanyMasterSummary({ bootstrap: true, deferPriorityRender: () => true }), true);
  assert.equal(state.companyMaster, old); assert.equal(old.browserCompanyPreview, undefined); assert.equal(old.companies.length, 2);
  assert.equal(old.totalCompanies, 544); assert.equal(old.adminRegionalOperations.regions.length, 1);
  assert.equal(renders.length, 1); assert.equal(clears.length, 0); assert.equal(invalidations.length, 0);
  assert.deepEqual(requests, ["/api/company-master/bootstrap"]);
});
test("canonical deletion, source or correction changes discard the preview and invalidate its latest claim", async () => {
  for (const change of [value => { value.companies = []; }, value => { value.sourceRevision = "new-source"; },
    value => { value.companies[0].manualCorrectionRevision = 8; }, value => { value.companies[0].mergedIntoCompanyId = "other"; }]) {
    const f = fixture(); f.cache.write(f.context, f.envelope);
    const preview = f.cache.read("company-one"), clears = [], invalidations = [];
    const old = { representation: "bootstrap", browserCompanyPreview: true, sourceRevision: preview.sourceRevision, companies: [preview.company] };
    const fresh = { representation: "bootstrap", sourceRevision: old.sourceRevision, companies: [{ ...preview.company }] }; change(fresh);
    const state = { session: f.session, companyMaster: old }, context = { state, Promise, Number, String, Object, Array,
      window: { AdminCompanyPreviewCache: { clear: () => clears.push(1) }, AdminTransitionTiming: { invalidateNavigationLatest: code => invalidations.push(code) } },
      isAdminRole: () => true, fetchJson: async () => fresh, renderAdminStartupReadiness() {}, renderCompanyMasterPriorityView() {}, scheduleCompanyMasterEta() {} };
    vm.createContext(context); vm.runInContext(declaration("companyMasterReadIsCurrent") + "\n" + declaration("loadCompanyMasterSummary"), context);
    await context.loadCompanyMasterSummary({ bootstrap: true });
    assert.equal(state.companyMaster, fresh); assert.equal(clears.length, 1); assert.equal(invalidations[0], "CANONICAL_COMPANY_CHANGED");
  }
});
