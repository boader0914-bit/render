"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const declaration = source.match(/^async function pollCrawlStatusUntilIdle\([^]*?^}/m)?.[0];
assert.ok(declaration, "the regression executes the actual crawl-status observer");

function fixture() {
  const state = { adminCrawlRequests: {}, adminDbSelectedCompanyId: "selected-company", data: { saved: true } };
  const calls = { requests: [], runs: [], polls: [], requestPolls: [], progress: [], status: [], details: [], renders: 0, clears: 0 };
  const statuses = [];
  const els = { crawlStatus: { textContent: "previous result" } };
  const context = {
    state, els, Date,
    clearCrawlStatusTimer: () => calls.clears++,
    scheduleAdminCrawlRequestPoll: delay => calls.requestPolls.push(delay),
    selectedAdminCrawlWorkerKey: () => "web",
    fetchJson: async url => { calls.requests.push(url); const value = statuses.shift(); if (value instanceof Error) throw value; assert.ok(value); return value; },
    recrawlContextStatusText: () => "",
    isAdminRole: () => true,
    renderAdminConsoleDashboard: () => calls.renders++,
    setCrawlProgress: (...args) => calls.progress.push(args),
    setStatus: value => calls.status.push(value),
    scheduleCrawlStatusPoll: (...args) => calls.polls.push(args),
    loadRuns: async (...args) => calls.runs.push(args),
    loadAdminDbCompanyDetail: async (...args) => calls.details.push(args),
    setActiveTab: value => { state.activeTab = value; },
    setAdminPanelSection: value => { state.adminPanelSection = value; }
  };
  vm.createContext(context);
  const poll = vm.runInContext(`${declaration}\npollCrawlStatusUntilIdle`, context);
  return { state, calls, statuses, els, poll };
}

test("the initial idle observer does not reload results or replace saved company data", async () => {
  const f = fixture(), saved = f.state.data;
  f.statuses.push({ active: false });
  await f.poll(false);
  assert.equal(f.calls.requests.length, 1);
  assert.deepEqual(f.calls.runs, []);
  assert.deepEqual(f.calls.details, []);
  assert.equal(f.state.data, saved);
  assert.equal(f.els.crawlStatus.textContent, "previous result");
  assert.equal(f.calls.clears, 1);
});

test("an active observation keeps its completion watch and refreshes results once on idle", async () => {
  const f = fixture();
  f.statuses.push({ active: true, currentStage: { label: "상품 확인", detail: "확인 중" }, remainingSeconds: 70 });
  await f.poll(false);
  assert.deepEqual(f.calls.runs, []);
  assert.deepEqual(f.calls.polls, [[10000, true]]);
  f.statuses.push({ active: false });
  await f.poll(f.calls.polls[0][1]);
  assert.deepEqual(f.calls.runs, [[true]]);
  assert.match(f.els.crawlStatus.textContent, /수집 성공 여부/);
  assert.equal(f.calls.polls.length, 1);
});

test("an inline running collection refreshes its result and selected detail even on an idle first poll", async () => {
  const f = fixture();
  f.state.adminDbInlineCollect = { companyId: "selected-company", status: "running", startedAt: 123 };
  f.statuses.push({ active: false });
  await f.poll(false);
  assert.deepEqual(f.calls.runs, [[true]]);
  assert.equal(f.calls.details.length, 1);
  assert.equal(f.calls.details[0][0], "selected-company");
  assert.equal(f.calls.details[0][1].force, true);
  assert.equal(f.state.adminDbInlineCollect.status, "review");
  assert.equal(f.state.adminDbSelectedCompanyId, "selected-company");
  assert.equal(f.state.adminDbViewMode, "review");
  assert.equal(f.state.activeTab, "admin");
  assert.equal(f.state.adminPanelSection, "database");
});

test("pending request tracking delegates before the worker status or result APIs", async () => {
  const f = fixture();
  f.state.adminCrawlRequests = { "pending-request": { status: "pending" } };
  await f.poll(false);
  assert.deepEqual(f.calls.requestPolls, [0]);
  assert.deepEqual(f.calls.requests, []);
  assert.deepEqual(f.calls.runs, []);
  assert.equal(f.calls.progress.length, 0);
});

test("a status failure remains an error and never treats the saved result as an empty completion", async () => {
  const f = fixture(), saved = f.state.data;
  f.statuses.push(new Error("connection unavailable"));
  await f.poll(true);
  assert.match(f.els.crawlStatus.textContent, /수집 상태 확인 실패: connection unavailable/);
  assert.deepEqual(f.calls.runs, []);
  assert.equal(f.calls.progress.length, 0);
  assert.equal(f.calls.status.length, 0);
  assert.equal(f.state.data, saved);
});
