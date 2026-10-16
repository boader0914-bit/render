"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Run the real label/coordinator functions against in-memory saved-data reads.
// This suite never starts a server, crawler, provider refresh, or live API call.
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `Missing actual function ${name}`);
  return found;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function master(count = 2) {
  return { totalCompanies: count, updatedAt: "2026-10-16T03:00:00Z",
    companies: Array.from({ length: count }, (_, index) => ({ companyId: `company-${index}` })) };
}
const functions = ["adminHomeSourceTimestamp", "adminHomeLatestRun", "adminHomeReadiness", "adminHomeBasis",
  "adminHomeFreshness", "adminHomeRecentRows", "renderAdminStartupReadiness", "renderHeader", "loadRuns",
  "companyMasterReadIsCurrent", "loadCompanyMasterSummary", "renderCompanyMasterPriorityView"];

function fixture(options = {}) {
  const state = { session: { authenticated: true, role: "admin" }, activeTab: "admin", adminPanelSection: "overview",
    runs: [], data: null, activeRunId: null, companyMaster: null, adminRunCatalogReadiness: null,
    companyMasterSummaryRead: null, companyMasterSummaryStatus: null, companyMasterBootstrapSummary: null,
    ...options };
  const calls = [], requests = [], hooks = {};
  const nodes = Object.fromEntries([".admin-home-basis strong", ".admin-home-basis small", ".admin-home-freshness-list", ".admin-home-log-list"]
    .map(selector => [selector, { textContent: "old", innerHTML: "old" }]));
  const els = { pageTitle: { textContent: "old title" }, pageSubtitle: { textContent: "old subtitle" },
    runSelect: { innerHTML: "", value: "" }, companyList: { innerHTML: "" },
    adminConsoleDashboard: { querySelector(selector) { calls.push(`label:${selector}`); return nodes[selector] || null; } } };
  const document = { title: "old document title" };
  const context = { state, els, document, console, Date, Number, Array, Object, Set, Map, Promise,
    APP_BRAND_NAME: "사분 데이터랩", loadRunRequestSequence: 0,
    REGION_ANALYSIS_TABS: new Set(["dictionary", "map", "demand", "regionCompare", "regionSources"]),
    isAdminRole: () => state.session?.role === "admin" && !state.adminUserViewMode,
    escapeHtml: value => String(value ?? "").replaceAll("<", "&lt;"), fmtNumber: value => String(value),
    compactDateTime: value => `TIME[${value}]`,
    adminConsoleMasterSource: () => ({ ...(state.data?.companyMaster || {}), ...(state.companyMaster || {}) }),
    adminHeaderView: () => [state.adminPanelSection === "database" ? "DB" : "운영 홈", "saved overview"],
    setStatus: value => calls.push(`status:${value}`),
    fetchJson: async url => { requests.push(url); return hooks.fetch ? hooks.fetch(url) : url === "/api/runs" ? { runs: [] } : master(); },
    loadRun: async id => calls.push(`full-run:${id}`),
    renderAdminConsoleDashboard: () => calls.push("home-body"),
    renderAdminDatabaseDashboard: () => calls.push("db-body"),
    renderB2BSearchPanel() {}, renderB2BEmptyPanels() {}, renderRunResultApplySummary() {},
    renderIndustryHome() {}, renderRegionHome() {}, loadRecrawlEtaEstimates: async () => {}, scheduleCompanyMasterEta() {}
  };
  vm.createContext(context);
  const api = vm.runInContext(functions.map(declaration).join("\n") + `\n({${functions.join(",")}})`, context);
  return { state, calls, requests, hooks, nodes, els, document, api };
}
function readyCatalog(f, runs = []) {
  f.state.runs = runs;
  f.state.adminRunCatalogReadiness = { session: f.state.session, status: "ready" };
}

test("initial absence stays preparing; confirmed empty remains a real zero", () => {
  const f = fixture();
  assert.equal(f.api.adminHomeReadiness(null).companyReady, false);
  assert.equal(f.api.adminHomeBasis(null), "저장 자료 확인 중");
  assert.doesNotThrow(() => f.api.adminHomeFreshness(null));
  assert.equal(f.api.adminHomeBasis(), "저장 자료 확인 중");
  assert.match(f.api.adminHomeFreshness(), /수집 기록 확인 중/);
  assert.doesNotMatch(f.api.adminHomeFreshness(), /데이터 대기|수집 전/);
  f.state.companyMaster = { totalCompanies: 0, companies: [] };
  readyCatalog(f);
  assert.equal(f.api.adminHomeBasis(f.state.companyMaster), "저장 자료 없음");
  assert.equal(f.api.adminHomeReadiness(f.state.companyMaster).empty, true);
  assert.match(f.api.adminHomeFreshness(f.state.companyMaster), /저장 결과 없음/);
});

test("observation, DB update and aggregate creation timestamps have distinct sources", () => {
  const f = fixture();
  const stored = master();
  assert.equal(f.api.adminHomeBasis(stored), "업체 DB 갱신 TIME[2026-10-16T03:00:00Z]");
  assert.equal(f.api.adminHomeBasis({ adminRegionalOperations: { generatedAt: "2026-10-17T02:00:00Z" } }), "지역 집계 작성 TIME[2026-10-17T02:00:00Z]");
  assert.equal(f.api.adminHomeBasis({ generatedAt: "2026-10-17T04:00:00Z" }), "기본자료 작성 TIME[2026-10-17T04:00:00Z]");
  readyCatalog(f, [{ id: "latest", completedAt: "bad-date", collectedAt: "2026-10-15T03:00:00Z" }]);
  assert.equal(f.api.adminHomeBasis(stored), "최근 수집 기준 TIME[2026-10-15T03:00:00Z]");
  assert.doesNotMatch(f.api.adminHomeBasis({ updatedAt: "bad-date", generatedAt: "also bad" }), /bad-date|also bad/);
});

test("selected result keeps its own older observation basis ahead of newer metadata and aggregates", () => {
  const f = fixture({ data: { run: { id: "selected", collectedAt: "2026-09-20T03:00:00Z" } }, activeRunId: "selected" });
  readyCatalog(f, [{ id: "latest", completedAt: "2026-10-16T03:00:00Z" }]);
  assert.equal(f.api.adminHomeBasis(master()), "선택 결과 기준 TIME[2026-09-20T03:00:00Z]");
  assert.match(f.api.adminHomeFreshness(master()), /선택 결과 준비/);
});

test("saved result metadata is ready without downloading the selected result's histories", async () => {
  const f = fixture({ companyMaster: master(), adminPanelSection: "database" });
  f.hooks.fetch = async () => ({ runs: [{ id: "saved", collectedAt: "2026-10-15T03:00:00Z" }] });
  await f.api.loadRuns(true, { bootstrap: true });
  assert.deepEqual(f.requests, ["/api/runs"]);
  assert.ok(!f.calls.some(call => /full-run|db-body|home-body/.test(call)));
  assert.equal(f.state.data, null);
  assert.equal(f.state.adminBootstrapRunPending, "saved");
  assert.match(f.api.adminHomeFreshness(f.state.companyMaster), /저장 결과 준비/);
  assert.match(f.els.pageSubtitle.textContent, /최근 수집 기준/);
});

test("refreshing saved data and failed refresh retain evidence and distinct readiness", async () => {
  const original = master(), f = fixture({ companyMaster: original }), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ preserveOnError: true, bootstrap: true });
  assert.match(f.api.adminHomeBasis(original), /갱신 중/);
  assert.match(f.api.adminHomeFreshness(original), /저장자료 사용 · 갱신 중/);
  gate.reject(new Error("unavailable"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, original);
  assert.match(f.api.adminHomeBasis(original), /최신 상태 미확인/);
  assert.match(f.api.adminHomeFreshness(original), /저장자료 사용 · 갱신 실패/);
  assert.equal(f.api.adminHomeReadiness(original).empty, false);
});

test("first company failure is an error, while a successful retry can establish real zero", async () => {
  const f = fixture();
  f.hooks.fetch = async () => { throw new Error("unavailable"); };
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), false);
  assert.equal(f.api.adminHomeBasis(f.state.companyMaster), "저장 자료 확인 실패");
  f.hooks.fetch = async () => ({ companies: [], totalCompanies: 0 });
  assert.equal(await f.api.loadCompanyMasterSummary({ bootstrap: true }), true);
  readyCatalog(f);
  assert.equal(f.api.adminHomeBasis(f.state.companyMaster), "저장 자료 없음");
});

test("metadata failure is not reported as an empty saved catalog", async () => {
  const f = fixture({ companyMaster: master() });
  f.hooks.fetch = async () => { throw new Error("metadata unavailable"); };
  await assert.rejects(f.api.loadRuns(true, { bootstrap: true }), /metadata unavailable/);
  assert.equal(f.state.adminRunCatalogReadiness.status, "error");
  assert.match(f.api.adminHomeRecentRows(f.state.companyMaster), /확인하지 못했습니다/);
  assert.doesNotMatch(f.api.adminHomeRecentRows(f.state.companyMaster), /최근 운영 기록이 없습니다/);
  assert.match(f.api.adminHomeFreshness(f.state.companyMaster), /수집 기록 확인 실패/);
});

test("malformed successful metadata response remains an error rather than real zero", async () => {
  const f = fixture({ companyMaster: master() });
  f.hooks.fetch = async () => ({ status: "ok" });
  await assert.rejects(f.api.loadRuns(true, { bootstrap: true }), /응답을 확인하지 못했습니다/);
  assert.equal(f.state.adminRunCatalogReadiness.status, "error");
  assert.equal(f.api.adminHomeReadiness(f.state.companyMaster).empty, false);
});

test("metadata labels update on visible home without rebuilding its body or DB search", () => {
  const f = fixture({ companyMaster: master() });
  readyCatalog(f, [{ id: "saved", label: "saved keyword", collectedAt: "2026-10-15T03:00:00Z" }]);
  f.api.renderAdminStartupReadiness();
  assert.equal(f.els.pageTitle.textContent, "운영 홈");
  assert.match(f.nodes[".admin-home-basis strong"].textContent, /최근 수집 기준/);
  assert.equal(f.nodes[".admin-home-basis small"].textContent, "saved keyword");
  assert.match(f.nodes[".admin-home-freshness-list"].innerHTML, /저장 결과 준비/);
  assert.ok(!f.calls.includes("home-body") && !f.calls.includes("db-body"));
});

test("late metadata does not reset another analysis screen's header or title", async () => {
  const f = fixture({ companyMaster: master() }), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadRuns(true, { bootstrap: true });
  f.state.activeTab = "monthlyReports";
  f.document.title = "월간 리포트";
  f.els.pageTitle.textContent = "월간 리포트";
  gate.resolve({ runs: [{ id: "saved" }] });
  await pending;
  assert.equal(f.document.title, "월간 리포트");
  assert.equal(f.els.pageTitle.textContent, "월간 리포트");
  assert.ok(!f.calls.some(call => /full-run|db-body|home-body/.test(call)));
});

test("newer catalog read wins; late old response cannot replace its metadata or status", async () => {
  const f = fixture({ companyMaster: master() }), old = deferred(), latest = deferred();
  f.hooks.fetch = () => f.requests.length === 1 ? old.promise : latest.promise;
  const first = f.api.loadRuns(true, { bootstrap: true });
  const second = f.api.loadRuns(true, { bootstrap: true });
  latest.resolve({ runs: [{ id: "newer" }] }); await second;
  old.resolve({ runs: [{ id: "older" }] }); await first;
  assert.equal(f.state.runs[0].id, "newer");
  assert.equal(f.state.adminRunCatalogReadiness.status, "ready");
  assert.equal(f.state.adminBootstrapRunPending, "newer");
});

test("changed session and customer view block administrator readiness updates", async () => {
  const f = fixture({ companyMaster: master() }), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadRuns(true, { bootstrap: true });
  f.state.session = { authenticated: true, role: "admin" };
  const oldTitle = f.els.pageTitle.textContent;
  gate.resolve({ runs: [{ id: "late-other-session" }] }); await pending;
  assert.equal(f.state.runs.length, 0);
  f.state.adminUserViewMode = true;
  f.api.renderAdminStartupReadiness();
  assert.equal(f.els.pageTitle.textContent, oldTitle);
  const requests = f.requests.length;
  await f.api.loadRuns(true, { bootstrap: true });
  assert.equal(f.requests.length, requests);
  assert.equal(f.state.adminRunCatalogReadiness, null);
});

test("a late company failure cannot label a newer administrator correction as failed", async () => {
  const f = fixture({ companyMaster: master() }), gate = deferred();
  f.hooks.fetch = () => gate.promise;
  const pending = f.api.loadCompanyMasterSummary({ preserveOnError: true, bootstrap: true });
  const corrected = { ...master(), updatedAt: "2026-10-17T03:00:00Z" };
  f.state.companyMaster = corrected;
  gate.reject(new Error("late unavailable"));
  assert.equal(await pending, false);
  assert.equal(f.state.companyMaster, corrected);
  assert.equal(f.api.adminHomeReadiness(corrected).failed, false);
  assert.doesNotMatch(f.api.adminHomeBasis(corrected), /갱신 중|미확인/);
});
