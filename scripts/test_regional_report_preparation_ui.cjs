"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("../web/regional-report-preparation.js");
const makeContainer = () => ({ innerHTML: "", isConnected: true, addEventListener() {} });
const region = { regionKey: "kto_36_10", regionLabel: "경상남도 산청군", level: "local" };
const keys = ["visitors", "demandStrength", "resourceDemand", "diversity", "kosis", "searchTrend"];
const job = (state, status = "running", extra = {}) => ({ id: "prep-1", regionKey: state.regionKey, month: state.month, cutoffDate: state.cutoffDate,
  status, progress: { completed: status === "running" ? 1 : keys.length, total: keys.length }, steps: keys.map(key => ({ key, status: status === "running" ? "running" : "ready", dataAvailable: status !== "running", period: "202608", retrievedAt: "2026-09-27T00:00:00Z" })), ...extra });
function fixture(api) {
  const calls = [], sent = [], timers = new Map(); let id = 0;
  const controller = ui.createController({ api: async (query = "", method = "GET", body) => {
    calls.push({ query, method, body }); return api(query, method, body, controller.state);
  }, onSend: context => sent.push(context), schedule: callback => { timers.set(++id, callback); return id; }, cancel: value => timers.delete(value) });
  return { controller, calls, sent, timers, container: makeContainer(), async tick() { const [key, callback] = timers.entries().next().value; timers.delete(key); callback(); await new Promise(resolve => setImmediate(resolve)); } };
}

test("opening, polling, remounting and returning only read state; collection needs an explicit start", async () => {
  let started = false, done = false;
  const f = fixture((query, method, body, state) => {
    if (method === "POST") started = true;
    return { job: started ? job(state, done ? "complete" : "running") : null };
  });
  await f.controller.mount(f.container, region);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, "GET"); assert.equal(f.timers.size, 0);
  await f.controller.mount(makeContainer(), region);
  assert.equal(f.calls.length, 1, "ordinary dashboard rerenders must not trigger new reads or writes");
  await f.controller.start();
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(f.calls[1].body, { regionKey: region.regionKey, month: f.controller.state.month, cutoffDate: f.controller.state.cutoffDate });
  assert.equal(f.timers.size, 1);
  f.controller.pause(); assert.equal(f.timers.size, 0);
  await f.controller.mount(makeContainer(), region);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1, "returning resumes GET checks only");
  done = true; await f.tick();
  assert.equal(f.controller.state.job.status, "complete"); assert.equal(f.timers.size, 0, "terminal jobs do not poll");
  assert.match(f.controller.state.message, /6개 지표 준비/);
  assert.match(ui.renderCard(f.controller.state), /6\/6 항목 처리/);
  assert.equal(f.controller.send(), true);
  assert.deepEqual(f.sent[0], { type: "region", targetId: region.regionKey, month: f.controller.state.month, cutoffDate: f.controller.state.cutoffDate });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1, "sending a report never starts collection or publication");
});

test("double click cannot submit twice, and an uncertain response requires status verification", async () => {
  let resolveStart;
  const f = fixture((query, method, body, state) => method === "POST" ? new Promise(resolve => { resolveStart = resolve; }) : { job: null });
  await f.controller.mount(f.container, region);
  const starting = f.controller.start();
  assert.equal(await f.controller.start(), false);
  resolveStart({ job: job(f.controller.state) }); await starting;
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  f.controller.pause();
  const uncertain = fixture((query, method) => { if (method === "POST") throw new Error("연결 끊김"); return { job: null }; });
  await uncertain.controller.mount(uncertain.container, region);
  assert.equal(await uncertain.controller.start(), false);
  assert.equal(uncertain.controller.state.needsStatusCheck, true);
  assert.equal(await uncertain.controller.start(), false, "never repeat an ambiguous start before checking server state");
  assert.equal(uncertain.timers.size, 0);
  await uncertain.controller.refresh();
  assert.equal(uncertain.controller.state.needsStatusCheck, false);
});

test("responses from an earlier region are ignored and mismatched server results fail closed", async () => {
  let finishOld;
  const f = fixture((query, method, body, state) => query.includes(region.regionKey)
    ? new Promise(resolve => { finishOld = resolve; }) : { job: job(state, "complete") });
  const oldRequest = f.controller.mount(f.container, region);
  const other = { regionKey: "kto_31_1", regionLabel: "경기도 가평군", level: "local" };
  await f.controller.mount(makeContainer(), other);
  finishOld({ job: { ...job(f.controller.state, "complete"), regionKey: region.regionKey } }); await oldRequest;
  assert.equal(f.controller.state.regionKey, other.regionKey);
  assert.equal(f.controller.state.job.regionKey, other.regionKey);
  assert.equal(f.controller.send(), true); assert.equal(f.sent[0].targetId, other.regionKey);
  const wrong = fixture((query, method, body, state) => ({ job: { ...job(state, "complete"), regionKey: "different" } }));
  await wrong.controller.mount(wrong.container, region);
  assert.match(wrong.controller.state.error, /다른 준비 결과/);
  assert.equal(wrong.controller.send(), false); assert.equal(wrong.timers.size, 0);
  assert.equal(await wrong.controller.start(), false, "unverified initial status cannot start a new collection");
});

test("polling failure stops repetition and permits only an explicit status recheck", async () => {
  let fail = false;
  const f = fixture((query, method, body, state) => { if (fail) throw new Error("조회 실패"); return { job: job(state) }; });
  await f.controller.mount(f.container, region);
  assert.equal(f.timers.size, 1);
  fail = true; await f.tick();
  assert.equal(f.timers.size, 0); assert.equal(f.controller.state.needsStatusCheck, true);
  assert.equal(await f.controller.start(), false);
  fail = false; await f.controller.refresh();
  assert.equal(f.timers.size, 1); assert.equal(f.controller.state.needsStatusCheck, false);
  f.controller.pause();
});

test("current-month publication wait is a neutral partial result and keeps KOSIS vintage", async () => {
  const f = fixture((query, method, body, state) => ({ job: job(state, "partial", {
    steps: keys.map(key => key === "kosis" ? { key, label: "인구·산업 통계", status: "ready", dataAvailable: true,
      periods: [{ key: "population", label: "인구", period: "202608", periodType: "M", retrievedAt: "2026-09-26T00:00:00Z" }, { key: "industry", label: "산업", period: "2024", periodType: "Y", retrievedAt: "2026-09-26T00:00:00Z" }] }
      : { key, status: "publication_pending", requestedPeriod: "202609", dataAvailable: false })
  }) }));
  await f.controller.mount(f.container, region);
  assert.equal(f.controller.state.error, ""); assert.equal(f.controller.send(), true);
  assert.match(f.container.innerHTML, /일부 자료 준비/);
  assert.match(f.container.innerHTML, /공표 대기/);
  assert.match(f.container.innerHTML, /기준 2026\.08 · 2024/);
  assert.match(f.container.innerHTML, /<details class="rrp-period-details"><summary>지표별 기준기간/);
  assert.match(f.container.innerHTML, /<dt>산업<\/dt><dd>2024<\/dd>/);
  assert.doesNotMatch(f.container.innerHTML, /rrp-live is-error/);
  assert.equal(f.timers.size, 0);
});

test("search connection distinguishes saved keys, response evidence and a newer failure without making provider calls", async () => {
  let connection = { configured: true, lastCheckedAt: "", lastSuccessAt: "", errorCode: "" };
  const f = fixture(() => ({ job: null, searchTrendConnection: connection }));
  await f.controller.mount(f.container, region);
  assert.match(f.container.innerHTML, /키 설정됨 · 응답 확인 전/);
  assert.doesNotMatch(f.container.innerHTML, /응답 확인됨/);
  connection = { configured: true, lastCheckedAt: "2026-09-27T00:00:00Z", lastSuccessAt: "2026-09-27T00:00:00Z", errorCode: "" };
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /응답 확인됨 · 2026-09-27 09:00 KST/);
  connection = { ...connection, lastCheckedAt: "2026-09-27T01:00:00Z", errorCode: "AUTH_ERROR" };
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /최근 응답 확인 실패/);
  assert.match(f.container.innerHTML, /연결 키 또는 이용 권한을 확인/);
  assert.match(f.container.innerHTML, /이전 응답 확인: 2026-09-27 09:00 KST/);
  assert.doesNotMatch(f.container.innerHTML, /응답 확인됨/);
  connection = { configured: false, lastCheckedAt: "", lastSuccessAt: "", errorCode: "MISSING_KEY" };
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /키 설정 필요/);
  assert.ok(f.calls.every(call => call.method === "GET" && call.query.startsWith("?regionKey=")), "connection display only reads preparation state");
  assert.equal(f.timers.size, 0);
  const legacy = fixture(() => ({ job: null }));
  await legacy.controller.mount(legacy.container, region);
  assert.equal(legacy.controller.state.error, "");
  assert.match(legacy.container.innerHTML, /연결 확인 전/);
});

test("search step keeps the server criterion and actual partial range, never an unrelated active run keyword", async () => {
  const f = fixture((query, method, body, state) => ({ job: job(state, "partial", {
    searchKeyword: "산청글램핑",
    steps: keys.map(key => key === "searchTrend" ? { key, status: "partial", keyword: "산청글램핑", partialMonth: true,
      startDate: "2026-09-01", endDate: "2026-09-26", dataAvailable: true, retrievedAt: "2026-09-27T00:00:00Z" }
      : { key, status: "publication_pending", requestedPeriod: "202609", dataAvailable: false })
  }) }));
  await f.controller.mount(f.container, region);
  assert.match(f.container.innerHTML, /기준 검색어: 산청글램핑/);
  assert.match(f.container.innerHTML, /기준 2026-09-01 ~ 2026-09-26/);
  assert.match(f.container.innerHTML, /월 마감 전 자료 · 전날까지의 일부 기간/);
  assert.match(f.container.innerHTML, /0–100의 상대 관심도이며 절대 검색량이 아닙니다/);
  assert.match(f.container.innerHTML, /검색어·조회기간이 다른 지수를 합산하거나 직접 비교하지 않습니다/);
  assert.match(f.container.innerHTML, /<progress max="6" value="6"/);
  assert.equal(f.controller.send(), true, "a partial but observed search series is usable with its period caveat");
  assert.equal(f.timers.size, 0);
  assert.doesNotMatch(f.container.innerHTML, /data-rrp-field="keyword"|rrp-live is-error/);
  const source = fs.readFileSync(path.join(__dirname, "../web/regional-report-preparation.js"), "utf8");
  const isolated = vm.createContext({ module: { exports: {} }, state: { run: { keyword: "다른지역펜션" }, currentKeyword: "다른지역펜션" } });
  vm.runInContext(source, isolated);
  const noCriterion = isolated.module.exports.renderCard({ ...f.controller.state, job: job(f.controller.state, "complete"), currentRun: { keyword: "다른지역펜션" } });
  assert.match(noCriterion, /기준 검색어: 자료 준비 후 확인/);
  assert.match(noCriterion, /지역명\+글램핑 기준으로 조회하며, 구 단위는 상위 지역명도 포함/);
  assert.doesNotMatch(noCriterion, /다른지역펜션/);
  const fallbackCriterion = ui.renderCard({ ...f.controller.state, job: { ...job(f.controller.state, "complete"), searchKeyword: "산청글램핑" } });
  assert.match(fallbackCriterion, /기준 검색어: 산청글램핑/);
});

test("missing and failed search evidence keep an explicit cause and cannot become usable zero data", () => {
  const state = { ...region, month: "2026-08", cutoffDate: "2026-08-31", expanded: true };
  for (const [status, errorCode, reason] of [["missing", "NO_DATA", "해당 검색어·기간의 자료가 없습니다"], ["failed", "QUOTA_EXCEEDED", "요청 한도에 도달"], ["failed", "MISSING_KEY", "연결 키를 설정"]]) {
    const renderedState = { ...state, job: job(state, "partial", { steps: [{ key: "searchTrend", status, errorCode, dataAvailable: false, keyword: '<img src=x onerror="bad">' }] }) };
    const html = ui.renderCard(renderedState);
    assert.match(html, new RegExp(reason));
    assert.match(html, /기준 검색어: &lt;img src=x onerror=&quot;bad&quot;&gt;/);
    assert.doesNotMatch(html, /<img/);
    assert.equal(ui.canSend(renderedState), false);
  }
});

test("an old region response cannot overwrite the new region search connection evidence", async () => {
  let finishOld;
  const f = fixture(query => query.includes(region.regionKey) ? new Promise(resolve => { finishOld = resolve; })
    : { job: null, searchTrendConnection: { configured: true, lastSuccessAt: "2026-09-27T00:00:00Z", errorCode: "" } });
  const pending = f.controller.mount(f.container, region);
  await f.controller.mount(f.container, { ...region, regionKey: "kto_31_1", regionLabel: "가평군" });
  finishOld({ job: null, searchTrendConnection: { configured: false, errorCode: "MISSING_KEY" } });
  await pending;
  assert.equal(f.controller.state.searchTrendConnection.configured, true);
  assert.match(f.container.innerHTML, /응답 확인됨/);
  assert.doesNotMatch(f.container.innerHTML, /키 설정 필요/);
});

test("broad and unresolved regions cannot collect; invalid conditions cannot be sent", async () => {
  const f = fixture(() => ({ job: null }));
  await f.controller.mount(f.container, { regionKey: "gyeongnam", regionLabel: "경상남도", level: "broad" });
  assert.equal(await f.controller.start(), false); assert.equal(f.calls.length, 0);
  await f.controller.mount(makeContainer(), { regionKey: "", regionLabel: "연결 대기", level: "" });
  assert.equal(await f.controller.start(), false); assert.equal(f.calls.length, 0);
  await f.controller.mount(makeContainer(), region);
  f.controller.input("cutoffDate", "2099-01-01"); assert.equal(await f.controller.start(), false);
  f.controller.input("cutoffDate", "2026-02-30"); assert.equal(await f.controller.start(), false);
  assert.equal(f.calls.length, 1);
  assert.equal(ui.defaultMonth("2026-01-03"), "2025-12");
  assert.equal(ui.defaultCutoff("2024-02", "2026-09-27"), "2024-02-29");
  assert.equal(ui.defaultCutoff("2026-09", "2026-09-27"), "2026-09-27");
});

test("safe rendering includes accessible progress, explicit region, mobile and theme styles", () => {
  const value = ui.renderCard({ regionKey: "x", regionLabel: '<img onerror="bad">', level: "local", month: "2026-08", cutoffDate: "2026-08-31", expanded: true, job: null });
  assert.match(value, /&lt;img onerror=&quot;bad&quot;&gt;/); assert.doesNotMatch(value, /<img/);
  assert.match(value, /<progress[^>]+aria-label=/); assert.match(value, /aria-live="polite"/);
  const css = fs.readFileSync(path.join(__dirname, "../web/regional-report-preparation.css"), "utf8");
  assert.match(css, /data-theme-resolved="dark"/); assert.match(css, /max-width: 600px/); assert.match(css, /prefers-reduced-motion/);
  const theme = fs.readFileSync(path.join(__dirname, "../web/admin-theme.css"), "utf8");
  assert.match(theme, /#adminRegionAnalysisDashboard :is\(\s*\.admin-region-detail-panel,[^]*?background: var\(--surface-card\) !important/);
});

test("region DB maps its own selected region exactly, independent from the analysis selection", () => {
  const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
  const fn = source.match(/^function adminReportPreparationRegion\([^]*?^}/m)?.[0];
  assert.ok(fn);
  const units = [{ regionKey: "kto_sancheong", management: "gyeongnam:산청", level: "local", active: true, selectable: true },
    { regionKey: "kto_gapyeong", management: "gyeonggi:가평", level: "local", active: true, selectable: true }];
  const context = vm.createContext({ state: { adminSelectedRegionKey: "gyeongnam:산청" }, regionMasterUnits: () => units,
    administrativeRegionForKey: key => units.find(unit => unit.regionKey === key), adminManagementRegionIdentity: unit => ({ regionKey: unit.management }) });
  const resolve = vm.runInContext(`${fn}\nadminReportPreparationRegion`, context);
  assert.equal(resolve().regionKey, "kto_sancheong");
  assert.equal(resolve({ regionKey: "gyeonggi:가평" }).regionKey, "kto_gapyeong");
  assert.equal(resolve({ regionKey: "unknown" }), null);
  units.push({ ...units[0], regionKey: "duplicate" });
  assert.equal(resolve(), null, "ambiguous management mappings must not silently pick a region");
  assert.match(source, /monthlyReportShortcut\.dataset\.monthlyReportTarget \|\| \(type === "region"/);
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  assert.ok(html.indexOf("/regional-report-preparation.js") < html.indexOf("/app.js"));
});
