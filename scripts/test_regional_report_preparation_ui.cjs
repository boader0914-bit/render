"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("../web/regional-report-preparation.js");
const makeContainer = () => ({ innerHTML: "", isConnected: true, listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; } });
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

test("preparation distinguishes an archive write failure from an API failure and keeps the report usable", async () => {
  const f = fixture((query, method, body, state) => ({ job: job(state, "partial", {
    steps: [{ key: "kosis", label: "인구·산업 통계", status: "partial", dataAvailable: true,
      errorCode: "EVIDENCE_WRITE_ERROR", period: "2024", cacheReused: true }]
  }) }));
  await f.controller.mount(f.container, region);
  assert.match(f.container.innerHTML, /응답 원본 보관 실패 · 저장된 지표 유지/);
  assert.doesNotMatch(f.container.innerHTML, /세부 원인 미분류|제공처 응답 확인 실패/);
  assert.equal(f.controller.send(), true); assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});

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
  assert.match(f.controller.state.message, /당시 보고월 자료 준비를 마쳤습니다/);
  assert.match(ui.renderCard(f.controller.state), /처리 종료 6\/6개 분야/);
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
  assert.match(f.container.innerHTML, /당시 일부 자료 확보/);
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
  for (const [status, errorCode, reason] of [["missing", "NO_DATA", "당시 해당 검색어·기간의 자료 없음"], ["failed", "QUOTA_EXCEEDED", "당시 제공처 요청 한도 도달"], ["failed", "MISSING_KEY", "당시 연결 키 미설정"]]) {
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

test("a finished failed preparation stays folded and describes that report-month attempt, not a live connection failure", async () => {
  const f = fixture((query, method, body, state) => ({ job: job(state, "failed", {
    finishedAt: "2026-10-15T11:17:00Z",
    steps: keys.map(key => ({ key, status: "failed", errorCode: "NETWORK_ERROR", dataAvailable: false }))
  }) }));
  await f.controller.mount(f.container, region);
  const summary = f.container.innerHTML.split("</summary>")[0];
  assert.match(summary, /^<details class="rrp-card"><summary>/, "old terminal work must not expand over the current management board");
  assert.match(summary, new RegExp(`보고월 ${f.controller.state.month}`));
  assert.match(summary, /보고월별 리포트 준비 이력/);
  assert.match(summary, /당시 확인 실패/);
  assert.match(summary, /처리 종료 6\/6/);
  assert.match(summary, /2026-10-15 20:17 KST/);
  assert.match(f.container.innerHTML, /실패·자료 없음·공표 대기도 처리 종료 수에 포함/);
  assert.match(f.container.innerHTML, /당시 실패는 현재 연결 상태를 뜻하지 않습니다/);
  const steps = f.container.innerHTML.split('<ul class="rrp-steps">')[1].split("</ul>")[0];
  assert.equal((steps.match(/당시 제공처 연결 실패/g) || []).length, 6);
  assert.doesNotMatch(steps, /연결 상태를 확인해 주세요|재수집|다시 수집/);
  assert.equal(f.controller.send(), false, "six ended attempts without data do not make a usable report");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  assert.equal(f.timers.size, 0);
});

test("reading preparation history preserves manual folding, while discovered or explicitly started work is shown", async () => {
  let status = "partial";
  const f = fixture((query, method, body, state) => ({ job: job(state, status) }));
  await f.controller.mount(f.container, region);
  assert.equal(f.controller.state.expanded, false);
  const disclosure = open => f.container.listeners.toggle({ target: { matches: selector => selector === "details.rrp-card", open } });
  disclosure(true);
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /^<details class="rrp-card" open>/);
  disclosure(false);
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /^<details class="rrp-card">/);
  status = "running";
  await f.controller.refresh();
  assert.match(f.container.innerHTML, /^<details class="rrp-card" open>/);
  assert.match(f.container.innerHTML, /보고월 리포트 자료 준비 중/);
  assert.match(f.container.innerHTML, /<b>처리 1\/6<\/b>/);
  assert.doesNotMatch(f.container.innerHTML, /<b>처리 종료 1\/6/);
  assert.equal(f.timers.size, 1);
  status = "complete";
  await f.tick();
  assert.match(f.container.innerHTML, /^<details class="rrp-card" open>/, "a newly finished user-visible job remains reviewable");
  assert.equal(f.timers.size, 0);
  disclosure(false);
  await f.controller.start();
  assert.match(f.container.innerHTML, /^<details class="rrp-card" open>/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
});

test("changing region clears the old open failure history before the next saved response arrives", async () => {
  let finishNext;
  const f = fixture((query, method, body, state) => query.includes(region.regionKey)
    ? { job: job(state, "failed", { finishedAt: "2026-09-01T00:00:00Z", steps: [{ key: "visitors", status: "failed", errorCode: "AUTH_ERROR" }] }) }
    : new Promise(resolve => { finishNext = resolve; }));
  await f.controller.mount(f.container, region);
  f.controller.state.expanded = true;
  const pending = f.controller.mount(makeContainer(), { ...region, regionKey: "kto_31_1", regionLabel: "가평군" });
  assert.equal(f.controller.state.job, null);
  assert.equal(f.controller.state.expanded, false);
  const waiting = ui.renderCard(f.controller.state);
  assert.match(waiting, /가평군/);
  assert.doesNotMatch(waiting, /산청|당시 확인 실패|인증·이용 권한 확인 실패|2026-09-01/);
  finishNext({ job: null }); await pending;
  assert.equal(f.controller.send(), false);
  assert.match(ui.renderCard(f.controller.state), /준비 기록 없음/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});

test("an earlier report-month response cannot replace the selected month or send its old report conditions", async () => {
  let finishEarlier, oldRequestMonth;
  const f = fixture((query, method, body, state) => {
    if (!oldRequestMonth) { oldRequestMonth = state.month; return new Promise(resolve => { finishEarlier = resolve; }); }
    return { job: job(state, "partial") };
  });
  const initial = f.controller.mount(f.container, region);
  const oldState = { ...f.controller.state };
  // Changing scope after an in-flight read is supported through the controller's normal input guard;
  // stop the view first so that the old pending read no longer owns the loading state.
  f.controller.pause();
  f.controller.input("month", "2026-08");
  await f.controller.mount(makeContainer(), region);
  finishEarlier({ job: job(oldState, "failed") }); await initial;
  assert.equal(f.controller.state.month, "2026-08");
  assert.equal(f.controller.state.job.month, "2026-08");
  assert.doesNotMatch(ui.renderCard(f.controller.state), /당시 확인 실패/);
  assert.equal(f.controller.send(), true);
  assert.deepEqual(f.sent[0], { type: "region", targetId: region.regionKey, month: "2026-08", cutoffDate: "2026-08-31" });
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});

test("attempt end time and original cutoff stay distinct from source receipts and a changed form cutoff", async () => {
  const f = fixture((query, method, body, state) => ({ job: job(state, "partial", {
    cutoffDate: "2026-08-31", finishedAt: "2026-10-15T11:17:00Z",
    steps: [{ key: "visitors", status: "partial", dataAvailable: true, period: "202608", retrievedAt: "2026-09-01T00:00:00Z" }]
  }) }));
  await f.controller.mount(f.container, region);
  f.controller.input("cutoffDate", "2026-10-01");
  const html = f.container.innerHTML;
  assert.match(html, /처리 종료 2026-10-15 20:17 KST/);
  assert.match(html, /이 기록의 관측 마감일 <strong>2026-08-31<\/strong>/);
  assert.match(html, /data-rrp-field="cutoffDate" value="2026-10-01"/);
  assert.match(html, /원자료 확인<\/small><time datetime="2026-09-01T00:00:00Z">2026-09-01 09:00 KST/);
  assert.match(html, /원자료 확인<\/small><time>미기록<\/time>/);
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
});
