"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const declaration = name => {
  const code = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(code, `Missing actual function ${name}`);
  return code;
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const company = (id = "one") => ({ companyId: id, primaryName: id, detailLoaded: false });

function detailFixture() {
  const state = { session: { authenticated: true, role: "admin" }, companyMaster: { representation: "bootstrap", companies: [company()] },
    activeTab: "admin", adminPanelSection: "database", adminDbSelectedCompanyId: "one" };
  const requests = [], renders = [], hooks = {};
  const context = { state, console, Promise, String, Error,
    isAdminRole: () => state.session.role === "admin" && !state.adminUserViewMode,
    adminDbRefreshSelectedDetail: () => false,
    renderAdminDatabaseDashboard: () => renders.push(state.adminDbSelectedCompanyId),
    fetchJson: async url => { requests.push(url); return hooks.fetch ? hooks.fetch(url) : { company: { ...company(), inventory: { snapshots: [{ runId: "history-one" }] } } }; } };
  vm.createContext(context);
  const api = vm.runInContext(declaration("loadAdminDbCompanyDetail") + "\n({loadAdminDbCompanyDetail})", context);
  return { state, requests, renders, hooks, api };
}

test("only the selected company detail is hydrated and shared by concurrent consumers", async () => {
  const f = detailFixture(), response = deferred();
  f.state.companyMaster.companies.push(company("two"));
  f.hooks.fetch = () => response.promise;
  const one = f.api.loadAdminDbCompanyDetail("one"), same = f.api.loadAdminDbCompanyDetail("one");
  assert.deepEqual(f.requests, ["/api/company-master/detail?companyId=one"]);
  assert.equal(f.state.companyMaster.companies[1].detailLoaded, false);
  response.resolve({ company: { ...company(), manualCorrection: { lodgingBasisTotal: 16 }, inventory: { snapshots: [{ runId: "old" }] } } });
  const values = await Promise.all([one, same]);
  assert.equal(values[0], values[1]);
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
  assert.equal(f.state.companyMaster.companies[0].manualCorrection.lodgingBasisTotal, 16);
  assert.equal((await f.api.loadAdminDbCompanyDetail("one")), values[0]);
  assert.equal(f.requests.length, 1, "same session and same saved row reuses the successful detail");
});

test("detail errors remain errors and a later explicit selection can retry", async () => {
  const f = detailFixture();
  f.hooks.fetch = async () => { throw new Error("saved detail unavailable"); };
  assert.equal(await f.api.loadAdminDbCompanyDetail("one"), null);
  assert.match(f.state.adminDbCompanyDetails.one.error, /unavailable/);
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, false);
  f.hooks.fetch = async () => ({ company: company() });
  assert.ok(await f.api.loadAdminDbCompanyDetail("one"));
  assert.equal(f.requests.length, 2);
  assert.equal(f.state.companyMaster.companies[0].detailLoaded, true);
});

test("a late detail cannot replace a newer correction or a newer master revision", async () => {
  for (const changeMaster of [false, true]) {
    const f = detailFixture(), response = deferred();
    f.hooks.fetch = () => response.promise;
    const pending = f.api.loadAdminDbCompanyDetail("one");
    const corrected = { ...company(), manualCorrection: { lodgingBasisTotal: 16 } };
    if (changeMaster) f.state.companyMaster = { companies: [corrected] };
    else f.state.companyMaster.companies[0] = corrected;
    response.resolve({ company: { ...company(), manualCorrection: { lodgingBasisTotal: 17 } } });
    assert.equal(await pending, null);
    assert.equal(f.state.companyMaster.companies[0], corrected);
    assert.equal(f.state.adminDbCompanyDetails.one, undefined);
  }
});

test("a source revision or correction changed on an existing row invalidates its pending detail", async () => {
  for (const alter of [state => { state.companyMaster.sourceRevision = "newer-source"; },
    state => { state.companyMaster.companies[0].manualCorrection = { lodgingBasisTotal: 16 }; }]) {
    const f = detailFixture(), response = deferred();
    f.hooks.fetch = () => response.promise;
    const pending = f.api.loadAdminDbCompanyDetail("one");
    alter(f.state);
    response.resolve({ company: { ...company(), manualCorrection: { lodgingBasisTotal: 17 } } });
    assert.equal(await pending, null);
    assert.equal(f.state.adminDbCompanyDetails.one, undefined);
  }
});

test("late administrator detail success and failure cannot cross session, role or customer-view boundaries", async () => {
  for (const alter of [state => { state.session = { ...state.session, marker: "new" }; },
    state => { state.session.role = "b2b"; }, state => { state.adminUserViewMode = true; }, state => { state.session.authenticated = false; }]) {
    for (const fail of [false, true]) {
      const f = detailFixture(), response = deferred(), original = f.state.companyMaster.companies[0];
      f.hooks.fetch = () => response.promise;
      const pending = f.api.loadAdminDbCompanyDetail("one");
      alter(f.state);
      if (fail) response.reject(new Error("late error")); else response.resolve({ company: company() });
      assert.equal(await pending, null);
      assert.equal(f.state.companyMaster.companies[0], original);
      assert.equal(f.state.adminDbCompanyDetails.one, undefined);
    }
  }
});

test("a newer forced detail request wins and an unexpected company id is never hydrated", async () => {
  const f = detailFixture(), old = deferred(), fresh = deferred();
  f.hooks.fetch = () => f.requests.length === 1 ? old.promise : fresh.promise;
  const earlier = f.api.loadAdminDbCompanyDetail("one"), latest = f.api.loadAdminDbCompanyDetail("one", { force: true });
  fresh.resolve({ company: { ...company(), marker: "newer" } });
  await latest;
  old.resolve({ company: { ...company(), marker: "older" } });
  assert.equal(await earlier, null);
  assert.equal(f.state.companyMaster.companies[0].marker, "newer");
  f.hooks.fetch = async () => ({ company: company("different") });
  assert.equal(await f.api.loadAdminDbCompanyDetail("one", { force: true }), null);
  assert.match(f.state.adminDbCompanyDetails.one.error, /일치하지 않습니다/);
  assert.equal(f.state.companyMaster.companies[0].marker, "newer");
});

test("a company switch cannot make an older selection repaint the new company", async () => {
  const f = detailFixture(), response = deferred();
  f.state.companyMaster.companies.push(company("two"));
  f.hooks.fetch = () => response.promise;
  const pending = f.api.loadAdminDbCompanyDetail("one");
  f.state.adminDbSelectedCompanyId = "two";
  response.resolve({ company: company() }); await pending;
  assert.deepEqual(f.renders, ["one"]);
  assert.equal(f.state.adminDbSelectedCompanyId, "two");
});

test("unhydrated detail and failures render an honest loading or retry surface without editable forms", () => {
  const state = { adminDbCompanyDetails: {}, adminDbSelectedCompanyId: "one", adminDbCompanyDetailLoading: {} };
  const context = { state, adminDbSelectedRow: rows => rows[0], escapeHtml: value => String(value) };
  vm.createContext(context);
  const render = vm.runInContext(declaration("adminDbIntegratedContainerHtml") + "\n" + declaration("adminDbSelectedDetailPanel") + "\nadminDbSelectedDetailPanel", context);
  const row = { company: company() };
  const waiting = render([row]);
  assert.match(waiting, /상품·상세이력 준비 중/);
  assert.match(waiting, /data-company-integrated/);
  assert.doesNotMatch(waiting, /<input|<form|0객실/);
  state.adminDbCompanyDetails.one = { error: "자료 연결 오류" };
  const failed = render([row]);
  assert.match(failed, /자료 연결 오류/);
  assert.match(failed, /다시 불러오기/);
  assert.doesNotMatch(failed, /<input|<form|0객실/);
});

test("DB row computations reuse stable saved data and invalidate on row, run or regional changes", () => {
  const state = { data: null }, calls = [];
  const context = { state, adminDbClassifyCompany: () => ({}), adminDbCompanyProfile: company => { calls.push(company.companyId); return { category: {} }; },
    compactSearchText: value => value, adminDbFlattenText: () => "search" };
  vm.createContext(context);
  const rows = vm.runInContext(declaration("adminDbRows") + "\nadminDbRows", context);
  const master = { companies: [company()], adminRegionalOperations: { regions: [] } };
  rows(master); rows({ ...master });
  assert.equal(calls.length, 1);
  master.companies[0] = { ...company(), detailLoaded: true };
  rows(master); assert.equal(calls.length, 2);
  state.data = { run: { id: "changed-run" } };
  rows(master); assert.equal(calls.length, 3);
  master.adminRegionalOperations = { regions: [{}] };
  rows(master); assert.equal(calls.length, 4);
});
