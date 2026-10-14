"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const names = [
  "historyOpsSource", "historyOpsSelectionState", "historyOpsRunKeyword", "historyOpsBrowseModel", "historyOpsRunTime",
  "historyOpsRunOptionLabel", "selectHistoryOpsRun", "ensureHistoryOpsSelection", "historyOpsReadFilterForm", "applyHistoryOpsFilters",
  "selectHistoryOpsKeyword", "refreshHistoryOpsCatalog", "historyOpsFilterControls", "historyOpsCountText", "historyOpsRateText",
  "historyOpsCompanyId", "historyOpsSavedCompanyRows", "historyOpsSavedResultHtml", "openHistoryOpsCompanyDb", "bindHistoryOpsEvents", "historyOpsCard",
  "historyOpsTimeline", "historyOpsKeywordRows", "historyOpsComparison", "historyOpsCompanyTrends", "renderHistoryOps",
  "companyKey", "collectionArchiveDay", "collectionArchiveDate", "collectionArchiveWorker", "collectionArchiveQuality",
  "activeKeyword", "adminDbCompanyHash", "adminDbCompanyDetailUrl", "adminDbCompanyUseNativeLink", "effectiveDetailRankRange"
];
const declarations = names.map(name => {
  const fn = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(fn, `Missing actual function ${name}`);
  return fn;
}).join("\n");

function element() {
  return { innerHTML: "", textContent: "", value: "", listeners: {}, querySelector: () => null,
    contains: () => false, addEventListener(type, handler) { this.listeners[type] = handler; } };
}

function sampleRun(id, keyword, collectedAt, extra = {}) {
  return { id, keyword, collectedAt, collectedAtSource: "manifest", workerKey: "web", collectionQuality: { status: "complete" },
    collectionMode: "precision", detailRankRanges: "1-5", checkIn: "2026-10-14", bookingRangeDays: 14, ...extra };
}

function samplePayload(run, extra = {}) {
  return { run, historyView: { readOnly: true, source: "stored_outputs", sourceRunId: run.id },
    availability: { items: [{ name: `${run.keyword} 업체`, rank: 1, inventoryCapacityBaseline: { companyId: `cmp_${run.id}` } }] },
    ranking: { items: [{ name: `${run.keyword} 업체`, rank: 1, inventoryCapacityBaseline: { companyId: `cmp_${run.id}` } }] },
    collectionDiagnostics: { reasonLabel: "수집 결과 검증 완료", counts: { naverScheduleRequested: 61, naverScheduleSucceeded: 61, naverScheduleFailed: 0, naverScheduleBlocked: 0 }, issues: [] }, ...extra };
}

function fixture({ runs, role = "admin", fetcher } = {}) {
  runs ||= [sampleRun("busan-2", "부산글램핑", "2026-10-14T06:30:00Z"), sampleRun("busan-1", "부산글램핑", "2026-10-14T01:30:00Z", { workerKey: "manual" }),
    sampleRun("busan-old", "부산글램핑", "2026-09-20T01:30:00Z"), sampleRun("gyeongnam-1", "경남글램핑", "2026-10-13T23:30:00Z")];
  const keywords = [...new Set(runs.map(run => run.keyword))].map(keyword => ({ keyword, keywordKey: keyword.replace(/\s+/g, ""),
    observations: 300, companyCount: 5, runCount: 3, sold: 150, supply: 300, saleRate: .5, latestCollectedDate: "2026-10-14", firstCollectedDate: "2026-09-20",
    comparison: { saleRateDelta: .1, previousDate: "2026-10-13", latestDate: "2026-10-14" }, timeline: [{ collectedDate: "2026-10-13", companyCount: 5, runCount: 2, saleRate: .4 }, { collectedDate: "2026-10-14", companyCount: 5, runCount: 1, saleRate: .5 }], companyTrends: [] }));
  const originalData = { run: { id: "global-current", keyword: "부산글램핑" }, availability: { items: [{ name: "전역 원본 업체" }] } };
  const state = { session: { role }, runs, activeTab: "historyOps", data: originalData, activeRunId: "global-current",
    historyOps: { keywords, overall: { keywordCount: keywords.length, observationCount: 600, runCount: 4, companyCount: 10 } },
    companyMaster: { companies: [] }, historyOpsSelection: null, historyOpsFilterDraft: null, historyOpsCatalogLoading: false, historyOpsCatalogError: "" };
  const els = { historyOpsDashboard: element(), historyOpsState: element(), keywordInput: element() };
  const calls = [];
  const navigationCalls = [];
  const context = vm.createContext({ state, els, document: { activeElement: null }, console, Date, Map, Set, Intl, encodeURIComponent,
    historyOpsSelectionRequestSequence: 0, historyOpsCatalogRequestSequence: 0,
    isAdminRole: () => state.session.role === "admin", fetchJson: async url => {
      calls.push(url);
      if (fetcher) return fetcher(url, state);
      if (url === "/api/runs") return { runs: state.runs };
      if (url === "/api/history/summary") return state.historyOps;
      assert.ok(url.startsWith("/api/history/runs/"), `Unexpected non-readonly URL ${url}`);
      const run = state.runs.find(row => row.id === decodeURIComponent(url.split("/").at(-1)));
      assert.ok(run);
      return samplePayload(run);
    }, loadRun() { throw new Error("Global result loading is forbidden while browsing history"); },
    syncAppHistoryState(push) { navigationCalls.push(["save-current", push]); },
    setActiveTab(tab, options) { navigationCalls.push(["tab", tab, options]); state.activeTab = tab; },
    setAdminPanelSection(section) { navigationCalls.push(["section", section]); state.adminPanelSection = section; },
    activateAdminDbCompanyDetail(companyId) { navigationCalls.push(["company", companyId]); state.adminDbSelectedCompanyId = companyId; return true; },
    escapeHtml: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    fmtNumber: value => Number(value).toLocaleString("ko-KR"), fmtRate: value => `${Math.round(value * 100)}%`,
    formatSignedRate: value => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%p`,
    dateRangeLabel: run => `${run.checkIn || "미확인"} · ${run.bookingRangeDays || "미확인"}일`
  });
  const api = vm.runInContext(`${declarations}\n({ ${names.join(", ")} })`, context);
  return { state, els, calls, navigationCalls, context, api, originalData };
}

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

async function runTests() {
  const f = fixture();
  await f.api.ensureHistoryOpsSelection();
  assert.equal(f.state.historyOpsSelection.runId, "busan-2");
  assert.equal(f.calls[0], "/api/history/runs/busan-2");
  assert.equal(f.state.data, f.originalData);
  assert.equal(f.state.activeRunId, "global-current");
  assert.equal(f.api.historyOpsBrowseModel().runs.length, 3, "Two observations of the same date remain distinct selectable runs");
  assert.notEqual(f.api.historyOpsRunOptionLabel(f.state.runs[0]), f.api.historyOpsRunOptionLabel(f.state.runs[1]));
  await f.api.selectHistoryOpsRun("busan-1");
  assert.match(f.els.historyOpsDashboard.innerHTML, /BG worker/);
  assert.match(f.els.historyOpsDashboard.innerHTML, /cmp_busan-1/);
  assert.doesNotMatch(f.els.historyOpsDashboard.innerHTML, /전역 원본 업체|data-open-company|collection-quality-feedback/);
  assert.match(f.els.historyOpsDashboard.innerHTML, /최근 10개 관측일/);
  assert.match(f.els.historyOpsDashboard.innerHTML, /키워드 전체 누적 자료/);
  assert.doesNotMatch(f.els.historyOpsDashboard.innerHTML, /data-history-ops-companies open/);
  f.api.bindHistoryOpsEvents();
  f.els.historyOpsDashboard.listeners.toggle({ target: { matches: () => true, open: true } });
  f.api.renderHistoryOps();
  assert.match(f.els.historyOpsDashboard.innerHTML, /data-history-ops-companies open/);
  assert.equal(f.api.historyOpsSavedCompanyRows({ availability: { items: [{ companyId: "cmp_1", placeId: "123", name: "A" }] }, ranking: { items: [{ placeId: "123", name: "A" }] } }).length, 1, "Place and company aliases refer to one facility");
  assert.equal(f.api.historyOpsSavedCompanyRows({ availability: { items: [{ companyId: "cmp_1", placeId: "123", name: "같은이름" }] }, ranking: { items: [{ placeId: "456", name: "같은이름" }] } }).length, 2, "Distinct stable IDs remain distinct even with the same name");
  assert.equal(f.api.historyOpsCountText(null), "미확인");
  assert.equal(f.api.historyOpsCountText(0), "0");
  assert.equal(f.api.historyOpsRateText(null), "미확인");
  assert.equal(f.api.historyOpsRateText(0), "0%");

  const many = fixture({ runs: Array.from({ length: 32 }, (_, i) => sampleRun(`run-${i}`, `키워드${i}`, "2026-10-14T06:00:00Z")) });
  await many.api.ensureHistoryOpsSelection();
  assert.equal(many.api.historyOpsBrowseModel().keywords.length, 32);
  assert.equal((many.els.historyOpsDashboard.innerHTML.match(/data-history-ops-keyword="/g) || []).length, 32, "No eight-keyword truncation");
  await many.api.selectHistoryOpsKeyword("키워드31");
  assert.equal(many.state.historyOpsSelection.runId, "run-31");
  const aggregateMissing = fixture();
  aggregateMissing.state.historyOps = { error: "보관 이력 조회 실패", keywords: [], overall: {} };
  await aggregateMissing.api.ensureHistoryOpsSelection();
  assert.equal(aggregateMissing.api.historyOpsBrowseModel().selectedKeyword.observations, null);
  assert.match(aggregateMissing.els.historyOpsDashboard.innerHTML, /누적 자료 조회 실패/);
  assert.match(aggregateMissing.els.historyOpsDashboard.innerHTML, /미확인건 관측/);
  aggregateMissing.state.companyMaster.companies = [{ companyId: "cmp_old", primaryName: "이름변경후" }];
  assert.match(aggregateMissing.api.historyOpsCompanyTrends({ companyTrends: [{ companyKey: "cmp_old", companyName: "변경전이름", runCount: 2, observations: 20, latest: { saleRate: null }, saleRate: .5 }] }), /adminCompany=cmp_old/);
  assert.match(aggregateMissing.api.historyOpsCompanyTrends({ companyTrends: [{ companyKey: "cmp_old", companyName: "변경전이름", latest: { saleRate: null }, saleRate: .5 }] }), /<em>미확인<\/em>/);

  await f.api.applyHistoryOpsFilters({ query: "경남 글램핑", startDate: "2026-10-14", endDate: "2026-10-14" });
  assert.equal(f.state.historyOpsSelection.keywordKey, "경남글램핑");
  assert.equal(f.state.historyOpsSelection.runId, "gyeongnam-1", "KST collection day, not UTC day");
  const acceptedData = f.state.historyOpsSelection.data;
  await f.api.applyHistoryOpsFilters({ startDate: "2026-10-15", endDate: "2026-10-14" });
  assert.match(f.state.historyOpsSelection.filterError, /범위/);
  assert.equal(f.state.historyOpsSelection.data, acceptedData, "Invalid range keeps the last accepted detail separate from filter error");
  const callsBeforeEmpty = f.calls.length;
  await f.api.applyHistoryOpsFilters({ query: "검색결과없는키워드" });
  assert.equal(f.state.historyOpsSelection.runId, "");
  assert.equal(f.state.historyOpsSelection.data, null);
  assert.equal(f.calls.length, callsBeforeEmpty, "Empty matches never silently fetch the latest run");
  assert.match(f.els.historyOpsDashboard.innerHTML, /검색한 키워드 없음/);

  const unknown = fixture({ runs: [sampleRun("legacy", "부산글램핑", "2026-10-14T01:00:00Z", { collectedAtSource: "filesystem" })] });
  await unknown.api.ensureHistoryOpsSelection();
  assert.equal(unknown.api.historyOpsBrowseModel().runs.length, 1);
  await unknown.api.applyHistoryOpsFilters({ startDate: "2026-10-14" });
  assert.equal(unknown.api.historyOpsBrowseModel().runs.length, 0, "Filesystem time cannot prove the actual observation date");

  const failures = fixture({ fetcher: async url => {
    const run = sampleRun(url.split("/").at(-1), "부산글램핑", "2026-10-14T01:00:00Z", { collectionQuality: { status: "failed" } });
    return samplePayload(run, { availability: { items: [] }, ranking: { items: [] }, collectionDiagnostics: { reasonLabel: "네이버 검색 요청량 제한", counts: {}, issues: [{ label: "HTTP200 요청량 제한", httpStatus: 200 }] } });
  } });
  await failures.api.ensureHistoryOpsSelection();
  assert.match(failures.els.historyOpsDashboard.innerHTML, /실패/);
  assert.match(failures.els.historyOpsDashboard.innerHTML, /HTTP200 요청량 제한/);
  assert.match(failures.els.historyOpsDashboard.innerHTML, /오류 미확인 · 차단 미확인/);
  assert.match(failures.els.historyOpsDashboard.innerHTML, /정상 0건으로 단정할 수 없습니다/);

  const missing = fixture({ fetcher: async () => { throw new Error("저장 결과 없음"); } });
  await missing.api.ensureHistoryOpsSelection();
  assert.equal(missing.state.historyOpsSelection.data, null);
  assert.match(missing.els.historyOpsDashboard.innerHTML, /상세 자료 미확인/);
  assert.doesNotMatch(missing.els.historyOpsDashboard.innerHTML, /예약 일정 응답/);
  const mismatch = fixture({ fetcher: async () => samplePayload(sampleRun("wrong", "부산글램핑", "2026-10-14T01:00:00Z")) });
  await mismatch.api.ensureHistoryOpsSelection();
  assert.equal(mismatch.state.historyOpsSelection.data, null);
  assert.match(mismatch.state.historyOpsSelection.error, /일치하지/);

  const oldRequest = deferred(), newRequest = deferred();
  const racing = fixture({ fetcher: url => url.endsWith("busan-2") ? oldRequest.promise : newRequest.promise });
  const initial = racing.api.ensureHistoryOpsSelection();
  const subsequent = racing.api.selectHistoryOpsRun("busan-1");
  newRequest.resolve(samplePayload(racing.state.runs[1]));
  await subsequent;
  oldRequest.resolve(samplePayload(racing.state.runs[0]));
  await initial;
  assert.equal(racing.state.historyOpsSelection.runId, "busan-1");
  assert.equal(racing.state.historyOpsSelection.data.run.id, "busan-1", "Stale responses never overwrite a later selection");
  assert.equal(racing.state.data, racing.originalData);

  const waiting = deferred();
  const cleared = fixture({ fetcher: () => waiting.promise });
  const pending = cleared.api.ensureHistoryOpsSelection();
  await cleared.api.applyHistoryOpsFilters({ query: "없음" });
  waiting.resolve(samplePayload(cleared.state.runs[0]));
  await pending;
  assert.equal(cleared.state.historyOpsSelection.data, null);
  assert.equal(cleared.state.historyOpsSelection.runId, "");

  const removed = fixture();
  await removed.api.ensureHistoryOpsSelection();
  removed.state.runs = removed.state.runs.filter(run => run.id !== "busan-2");
  const priorRequests = removed.calls.length;
  await removed.api.ensureHistoryOpsSelection();
  assert.equal(removed.state.historyOpsSelection.runId, "busan-2");
  assert.equal(removed.state.historyOpsSelection.data, null);
  assert.equal(removed.calls.length, priorRequests, "A disappeared selected result never falls back to the latest remaining run");
  assert.match(removed.els.historyOpsDashboard.innerHTML, /<option value="" selected>수집 결과를 다시 선택하세요<\/option>/);

  const laterCatalogue = fixture({ runs: [] });
  await laterCatalogue.api.ensureHistoryOpsSelection();
  assert.equal(laterCatalogue.state.historyOpsSelection.initialized, false);
  laterCatalogue.state.runs = [sampleRun("later", "후속키워드", "2026-10-14T01:00:00Z")];
  await laterCatalogue.api.ensureHistoryOpsSelection();
  assert.equal(laterCatalogue.state.historyOpsSelection.runId, "later", "A delayed initial catalogue can initialize without global result data");

  const focus = fixture();
  await focus.api.ensureHistoryOpsSelection();
  let focusedAgain = false, restoredRange;
  const active = { name: "query", selectionStart: 2, selectionEnd: 4, closest: () => true };
  focus.context.document.activeElement = active;
  focus.state.historyOpsFilterDraft = { query: "미완성 입력", startDate: "", endDate: "" };
  focus.els.historyOpsDashboard.contains = node => node === active;
  const replacement = { type: "search", focus() { focusedAgain = true; }, setSelectionRange(a, b) { restoredRange = [a, b]; } };
  focus.els.historyOpsDashboard.querySelector = () => ({ elements: { namedItem: () => replacement } });
  focus.api.renderHistoryOps();
  assert.match(focus.els.historyOpsDashboard.innerHTML, /value="미완성 입력"/);
  assert.equal(focusedAgain, true);
  assert.deepEqual(restoredRange, [2, 4]);

  const noCurrent = fixture();
  noCurrent.state.data = null;
  noCurrent.state.activeRunId = null;
  await noCurrent.api.ensureHistoryOpsSelection();
  assert.equal(noCurrent.state.historyOpsSelection.runId, "busan-2");
  assert.equal(noCurrent.state.data, null);
  const denied = fixture({ role: "member" });
  await denied.api.selectHistoryOpsRun("busan-2");
  assert.equal(denied.calls.length, 0);
  const linked = fixture();
  await linked.api.ensureHistoryOpsSelection();
  await linked.api.applyHistoryOpsFilters({ query: "부산", startDate: "2026-09-01", endDate: "2026-09-30" });
  const selectedHistory = linked.state.historyOpsSelection;
  const retainedSelection = JSON.stringify(selectedHistory);
  const retainedData = linked.state.data;
  const link = { tagName: "A", getAttribute(name) { return name === "data-history-ops-company-db" ? "cmp_place_244049" : ""; } };
  assert.match(linked.els.historyOpsDashboard.innerHTML, /data-history-ops-company-db=/, "Saved company links carry stable DB IDs");
  const nativeEvents = [{ button: 0, ctrlKey: true }, { button: 0, metaKey: true }, { button: 0, shiftKey: true },
    { button: 0, altKey: true }, { button: 1 }, { button: 2 }, { button: 0, defaultPrevented: true }];
  for (const flags of nativeEvents) {
    assert.equal(linked.api.openHistoryOpsCompanyDb({ ...flags, preventDefault() { assert.fail("Native links must retain their default action"); } }, link), false);
  }
  const newTabLink = { tagName: "A", getAttribute(name) { return name === "target" ? "_blank" : "cmp_place_244049"; } };
  assert.equal(linked.api.openHistoryOpsCompanyDb({ button: 0, preventDefault() { assert.fail("Explicit new tab links stay native"); } }, newTabLink), false);
  assert.equal(linked.navigationCalls.length, 0);
  let prevented = false, stopped = false;
  assert.equal(linked.api.openHistoryOpsCompanyDb({ button: 0, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } }, link), true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(JSON.stringify(linked.navigationCalls), JSON.stringify([["save-current", false], ["tab", "admin", { fromHistory: true }], ["section", "database"], ["company", "cmp_place_244049"]]), "Existing navigation helper receives the exact stable ID and preserves one Back entry");
  assert.equal(linked.state.historyOpsSelection, selectedHistory);
  assert.equal(JSON.stringify(linked.state.historyOpsSelection), retainedSelection, "Company navigation preserves selected keyword, dates, saved run and detail");
  assert.equal(linked.state.data, retainedData);
  assert.equal(linked.state.activeRunId, "global-current");
  assert.equal(linked.state.adminDbSelectedCompanyId, "cmp_place_244049");
  assert.equal(linked.api.openHistoryOpsCompanyDb({ button: 0 }, { tagName: "A", getAttribute: () => "" }), false, "Unlinked cards cannot open an arbitrary company");
  console.log("History selection: all keywords, distinct saved runs, KST/date filters, readonly isolation, error/zero distinction, stale response protection and typing focus passed");
}

if (require.main === module) runTests().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, names, declarations, sampleRun, samplePayload, runTests };
