"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createController, renderDashboard, comparisonModel, normalRows, latestCompletedMonth } = require("../web/regional-comparison.js");
const NOW = Date.parse("2026-10-17T03:00:00Z");
const regions = ["a", "b", "c", "d", "e"].map((regionKey, index) => ({ regionKey, label: ["산청군", "사천시", "포천시", "가평군", "여수시"][index] }));
const context = extra => ({ accountKey: "admin", regionKey: "a", regionLabel: "산청군", month: "2026-09", regions, ...extra });
const host = () => ({ innerHTML: "", dataset: {}, isConnected: true, listeners: new Map(), addEventListener(name, callback) { this.listeners.set(name, callback); }, querySelector() { return null; } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const matchedScope = (regionKey, provider = "한국관광공사", extra = {}) => ({ version: "regional-data-contract-v1", provider, requestedRegionKey: regionKey,
  officialCode: ({ a: "48860", b: "48240", c: "41650", d: "41820", e: "46130" })[regionKey] || "48860",
  requestedLevel: "sigungu", requestedUnitType: "county", providerRegionCode: ({ a: "48860", b: "48240", c: "41650", d: "41820", e: "46130" })[regionKey] || "48860",
  providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none", reasonCode: "", ...extra });
function response(regionKey = "a", month = "2026-09", { value = 0, rows, unit = "명", provider = "한국관광공사", groups } = {}) {
  return { scope: { regionKey, month, months: 13 }, snapshot: { scope: { regionKey, month, months: 13 }, resultId: `${regionKey}-${month}`, generatedAt: "2026-10-16T00:00:00Z", groups: groups || [
    { key: "visitors", label: "지역 방문자", category: "tourism", provider, periodType: "M", spatialContract: matchedScope(regionKey, provider), metrics: [{ key: "visitors", label: "일평균 방문자", unit, rows: rows || [{ period: month, status: "observed", value }] }] }
  ] }, job: null };
}
function readerFixture(initial = [], fetcher = input => response(input.regionKey, input.month)) {
  const key = input => JSON.stringify([input.accountKey, input.regionKey, input.month, input.months]);
  const values = new Map(initial.map(([input, value]) => [key(input), value])), calls = [];
  return { values, calls, read: input => values.get(key(input)) || null, get: async input => { calls.push(input); const value = await fetcher(input); values.set(key(input), value); return value; } };
}
const query = extra => ({ accountKey: "admin", regionKey: "a", month: "2026-09", months: 13, ...extra });

test("regional comparison is independent of runs and reads explicit stored scopes only", async () => {
  const reader = readerFixture(), c = createController({ reader, now: () => NOW });
  await c.mount(host(), context());
  assert.equal(reader.calls.length, 1);
  assert.deepEqual(reader.calls[0], { ...query(), fetchJson: undefined, force: true });
  assert.equal(c.state.records.a.data.snapshot.resultId, "a-2026-09");
  assert.equal(latestCompletedMonth(NOW), "2026-09");
  assert.equal(latestCompletedMonth(Date.parse("2026-12-31T15:00:00Z")), "2026-12");
});

test("baseline plus three comparison regions exclude duplicates and unregistered targets", async () => {
  const reader = readerFixture(), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context());
  assert.equal(c.addTarget("a"), false); assert.equal(c.addTarget("outside"), false);
  for (const key of ["b", "c", "d"]) { assert.equal(c.addTarget(key), true); await c.refresh(); }
  assert.equal(c.addTarget("b"), false); assert.equal(c.addTarget("e"), false);
  assert.deepEqual(c.state.targets, ["b", "c", "d"]);
  assert.match(element.innerHTML, /기준 산청군/);
  assert.equal(c.removeTarget("c"), true); await c.refresh();
  assert.equal(c.state.records.c, undefined, "removed result references do not accumulate inside the controller");
  assert.equal(c.addTarget("e"), true); await c.refresh();
});

test("selected regions are checked in parallel and a failure preserves only that region's normal stored result", async () => {
  let failB = false, gates = null;
  const reader = readerFixture([], input => gates ? gates[input.regionKey].promise : failB && input.regionKey === "b" ? Promise.reject(new Error("B 저장본 확인 실패")) : response(input.regionKey, input.month));
  const c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context()); c.addTarget("b"); await c.refresh();
  const oldB = c.state.records.b.data;
  gates = { a: deferred(), b: deferred() };
  const check = c.refresh(); await tick();
  assert.deepEqual(reader.calls.slice(-2).map(call => call.regionKey), ["a", "b"], "both GETs are admitted before either settles");
  gates.a.resolve(response("a", "2026-09", { value: 7 })); gates.b.reject(new Error("B 저장본 확인 실패"));
  assert.equal(await check, false);
  assert.equal(c.state.records.a.data.snapshot.groups[0].metrics[0].rows[0].value, 7);
  assert.equal(c.state.records.b.data, oldB);
  assert.match(element.innerHTML, /B 저장본 확인 실패 · 이전 저장 결과를 표시합니다. 최신 상태 미확인/);
  assert.equal(element.dataset.rcCheckStatus, "error");
  gates = null; failB = true;
  await c.mount(element, context());
  assert.match(c.state.records.b.error, /B 저장본/);
});

test("repeated mounts during an active check do not duplicate requests or reset the selector search", async () => {
  const gate = deferred(), reader = readerFixture([], () => gate.promise), c = createController({ reader, now: () => NOW }), element = host();
  const first = c.mount(element, context()); c.updateSearch("포천");
  const second = c.mount(element, context());
  assert.equal(reader.calls.length, 1);
  gate.resolve(response()); await Promise.all([first, second]);
  assert.equal(c.state.query, "포천");
  assert.match(element.innerHTML, /data-rc-search value="포천"/);
  assert.match(element.innerHTML, />포천시<\/option>/);
  assert.doesNotMatch(element.innerHTML, />사천시<\/option>/);
});

test("late old account, month and region results cannot overwrite the current scope", async () => {
  const gate = deferred(), reader = readerFixture([], input => input.accountKey === "old" ? gate.promise : response(input.regionKey, input.month)), c = createController({ reader, now: () => NOW }), element = host();
  const old = c.mount(element, context({ accountKey: "old" })); await tick();
  await c.mount(element, context({ accountKey: "new", regionKey: "b", regionLabel: "사천시", month: "2026-08" }));
  gate.resolve(response("a")); await old;
  assert.equal(c.state.accountKey, "new"); assert.equal(c.state.month, "2026-08");
  assert.equal(c.state.records.b.data.snapshot.resultId, "b-2026-08");
  assert.equal(c.state.records.a, undefined);
  assert.match(element.innerHTML, /사천시/); assert.doesNotMatch(element.innerHTML, /a-2026-09/);
});

test("mismatched saved results never replace the last normal result, and stopping suppresses late replies", async () => {
  let wrong = false, gate = null;
  const reader = readerFixture([], input => gate ? gate.promise : response(wrong ? "other" : input.regionKey, input.month)), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context()); const normal = c.state.records.a.data;
  wrong = true; assert.equal(await c.refresh(), false);
  assert.equal(c.state.records.a.data, normal); assert.match(c.state.records.a.error, /다른 저장 결과/);
  gate = deferred(); const pending = c.refresh(); await tick();
  c.stop(); const before = element.innerHTML; gate.resolve(response("a", "2026-09", { value: 123 })); await pending;
  assert.equal(element.innerHTML, before); assert.equal(c.state.records.a.data, normal);
});

test("a month or account change cannot reuse a different cached result, and invalid future months never read", async () => {
  const reader = readerFixture([[query(), response("a")]]), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context());
  assert.equal(c.selectMonth("2026-08"), true); await c.refresh();
  assert.equal(c.state.records.a.data.snapshot.scope.month, "2026-08");
  assert.equal(c.selectMonth("2026-11"), false);
  const count = reader.calls.length;
  await c.mount(element, context({ month: "2027-01" }));
  assert.equal(reader.calls.length, count); assert.match(element.innerHTML, /기준월을 다시 선택/);
});

test("tourism comparison uses the latest shared normal month and keeps genuine zeros", () => {
  const records = [
    { label: "A", data: response("a", "2026-09", { rows: [{ period: "2026-08", status: "observed", value: 0 }, { period: "2026-09", status: "publication_pending", value: 0 }] }) },
    { label: "B", data: response("b", "2026-09", { rows: [{ period: "2026-08", status: "observed", value: 12 }, { period: "2026-09", status: "failed", value: 0 }] }) }
  ];
  const [row] = comparisonModel(records);
  assert.equal(row.commonPeriod, "2026-08"); assert.deepEqual(row.cells.map(cell => cell.value), [0, 12]);
  assert.equal(row.unit, "명"); assert.equal(row.provider, "한국관광공사");
  assert.deepEqual(normalRows({ rows: [{ period: "2026-09", status: "partial", value: 0 }, { period: "2026-08", status: "observed", value: 0 }] }).map(row => row.value), [0]);
  assert.deepEqual(normalRows({ rows: [{ period: "2026-09", status: "observed", value: 2 }, { period: "2026-09", status: "failed", value: 0 }] }), [], "duplicate periods cannot choose an arbitrary observation");
});

test("different periods, units and sources cannot manufacture comparable values", () => {
  for (const other of [response("b", "2026-09", { rows: [{ period: "2026-07", value: 7, status: "observed" }] }), response("b", "2026-09", { unit: "지수" }), response("b", "2026-09", { provider: "다른 출처" })]) {
    const [row] = comparisonModel([{ label: "A", data: response("a", "2026-09", { value: 4 }) }, { label: "B", data: other }]);
    assert.equal(row.commonPeriod, ""); assert.deepEqual(row.cells.map(cell => cell.value), [null, null]);
  }
});

test("annual background data and search normalization are separated from comparable monthly tourism", async () => {
  const groups = [
    { key: "kosis", label: "인구·산업", category: "background", provider: "KOSIS", spatialContract: matchedScope("a", "KOSIS"), metrics: [{ key: "workers", label: "종사자", periodType: "Y", unit: "명", rows: [{ period: "2024", value: 100, status: "observed" }] }] },
    { key: "searchTrend", label: "검색 트렌드", category: "search", provider: "네이버 데이터랩", keyword: "산청글램핑", sourceBatchId: "batch-a", normalizationPeriod: "2025-09-01 ~ 2026-09-30", metrics: [{ key: "interest", label: "상대 관심도", unit: "상대지수", rows: [{ period: "2026-09", value: 0, status: "observed" }, { period: "2026-08", value: 0, status: "missing" }] }] }
  ];
  const reader = readerFixture([], input => response(input.regionKey, input.month, { groups })), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context());
  assert.equal(comparisonModel([{ label: "A", data: response("a", "2026-09", { groups }) }]).length, 0);
  assert.equal(comparisonModel([{ label: "A", data: response("a", "2026-09", { groups }) }], "search")[0].reasonCode, "KEYWORD_SCOPE");
  assert.equal(comparisonModel([{ label: "A", data: response("a", "2026-09", { groups }) }], "background")[0].commonPeriod, "2024");
  assert.match(element.innerHTML, /인구·산업 기초자료/); assert.match(element.innerHTML, /연간 값을 월별로 나누거나/);
  assert.match(element.innerHTML, /정규화 기간 2025-09-01 ~ 2026-09-30/); assert.match(element.innerHTML, /자료 묶음 batch-a/);
  assert.match(element.innerHTML, /지역별 고저 순위나 증감 비교는 하지 않으며/);
  assert.match(element.innerHTML, /<b>0<\/b>/); assert.match(element.innerHTML, /<b>미확인<\/b>/);
});

test("cached actual results paint before the background check and complete display timing after two frames only", async () => {
  let clock = NOW;
  const frames = [], displayed = [], gate = deferred(), reader = readerFixture([[query(), response()]], () => gate.promise), element = host();
  element.dataset.rcEntryStartedAt = String(clock - 120);
  const c = createController({ reader, now: () => clock, requestFrame: callback => frames.push(callback) });
  const pending = c.mount(element, context({ onDisplay: value => displayed.push(value) }));
  assert.match(element.innerHTML, /a-2026-09/); assert.equal(element.dataset.rcDisplayStatus, "waiting");
  assert.equal(element.dataset.rcCheckStatus, "checking"); assert.equal(element.dataset.rcEntryStartedAt, undefined);
  frames.shift()(); clock += 10; assert.equal(element.dataset.rcDisplayMs, undefined);
  frames.shift()(); assert.equal(element.dataset.rcDisplayMs, "130"); assert.equal(element.dataset.rcDisplayStatus, "ready");
  assert.equal(element.dataset.rcDisplaySource, "cache"); assert.equal(element.dataset.rcDisplayResultIds, "a-2026-09");
  assert.equal(displayed.length, 1); assert.equal(element.dataset.rcCheckMs, undefined);
  gate.resolve(response()); clock += 30; await pending;
  assert.equal(element.dataset.rcDisplayMs, "130"); assert.equal(element.dataset.rcCheckStatus, "checked");
  assert.equal(element.dataset.rcCheckMs, "40"); assert.equal(displayed.length, 1);
});

test("loading text and empty or failed results never become a ready display sample", async () => {
  const frames = [], gate = deferred(), reader = readerFixture([], () => gate.promise), element = host(), c = createController({ reader, now: () => NOW, requestFrame: callback => frames.push(callback) });
  const pending = c.mount(element, context());
  while (frames.length) frames.shift()();
  assert.equal(element.dataset.rcDisplayStatus, "waiting"); assert.equal(element.dataset.rcDisplayMs, undefined);
  gate.resolve({ scope: { regionKey: "a", month: "2026-09", months: 13 }, snapshot: null }); await pending;
  while (frames.length) frames.shift()();
  assert.equal(element.dataset.rcDisplayStatus, "missing"); assert.notEqual(element.dataset.rcDisplayStatus, "ready");
  assert.doesNotMatch(element.innerHTML, /<strong>0<\/strong>/);
});

test("untrusted labels, source IDs and search strings are escaped and controls never offer provider collection", async () => {
  const bad = '<img src=x onerror="bad()">', reader = readerFixture([], input => { const value = response(input.regionKey, input.month); value.snapshot.resultId = bad; value.snapshot.groups[0].metrics[0].label = bad; return value; });
  const c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context({ regionLabel: bad, regions: [{ regionKey: "a", label: bad }] })); c.updateSearch(bad); c.render();
  assert.match(element.innerHTML, /&lt;img/); assert.doesNotMatch(element.innerHTML, /<img|onerror="bad/);
  assert.doesNotMatch(element.innerHTML, /data-rc-action="(?:collect|build|refresh|publish)"/);
  assert.ok(reader.calls.every(call => !call.method && !call.body));
});

test("responsive comparison uses theme tokens, scrollable tables and complete wrapping provenance", () => {
  const css = fs.readFileSync(path.join(__dirname, "../web/regional-comparison.css"), "utf8");
  for (const token of ["--text-primary", "--text-secondary", "--surface-card", "--surface-control", "--border-subtle"]) assert.ok(css.includes(token), token);
  assert.match(css, /\.rc-table-wrap\s*\{[^}]*overflow-x:auto/);
  assert.match(css, /\.rc-evidence p\s*\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /@media \(max-width:560px\)/);
  assert.doesNotMatch(css, /text-overflow:ellipsis/, "saved result IDs remain readable in full");
});

test("a saved response's storage error cannot be described as a successful fresh confirmation", async () => {
  const reader = readerFixture([], input => ({ ...response(input.regionKey, input.month), storage: { errorCode: "READ_FAILED" } }));
  const c = createController({ reader, now: () => NOW }), element = host();
  assert.equal(await c.mount(element, context()), false);
  assert.ok(c.state.records.a.data.snapshot);
  assert.match(element.innerHTML, /이전 저장 결과를 표시합니다. 최신 상태 미확인/);
  assert.equal(element.dataset.rcCheckStatus, "error");
});

test("in-flight confirmation preserves search focus and selection and waits for Korean composition before repainting", async () => {
  const document = { activeElement: null }; let input = null, markup = "";
  const element = host(); element.ownerDocument = document; element.contains = value => value === input;
  Object.defineProperty(element, "innerHTML", { get: () => markup, set: value => {
    markup = value; if (document.activeElement === input) document.activeElement = null;
    input = { value: value.match(/data-rc-search value="([^"]*)"/)?.[1] || "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
      matches: selector => selector === "[data-rc-search]", focus() { document.activeElement = this; }, setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; } };
  } });
  element.querySelector = selector => selector === "[data-rc-search]" ? input : null;
  let gate = null;
  const reader = readerFixture([], scope => gate ? gate.promise : response(scope.regionKey, scope.month)), c = createController({ reader, now: () => NOW });
  await c.mount(element, context());
  input.value = "산청 초안"; input.focus(); input.setSelectionRange(1, 3, "backward");
  element.listeners.get("input")({ currentTarget: element, target: input });
  gate = deferred(); const checking = c.refresh();
  assert.equal(input.value, "산청 초안"); assert.equal(document.activeElement, input);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 3, "backward"]);
  element.listeners.get("compositionstart")({ currentTarget: element, target: input });
  const composingInput = input, before = element.innerHTML;
  input.value = "산청 초안 수정"; input.setSelectionRange(7, 7, "none");
  element.listeners.get("input")({ currentTarget: element, target: input });
  gate.resolve(response()); await checking;
  assert.equal(element.innerHTML, before, "a network result cannot replace the DOM while composing");
  assert.equal(document.activeElement, composingInput);
  element.listeners.get("compositionend")({ currentTarget: element, target: composingInput });
  assert.equal(c.state.query, "산청 초안 수정"); assert.equal(input.value, "산청 초안 수정");
  assert.equal(document.activeElement, input); assert.deepEqual([input.selectionStart, input.selectionEnd], [7, 7]);
});

test("comparison and summary surfaces share the real stored-result reader without duplicate cold GETs", async () => {
  const analysis = require("../web/regional-analysis.js"), reader = analysis.createSavedResults({ cache: analysis.createCache({ now: () => NOW }), now: () => NOW });
  const calls = [], gate = deferred();
  const fetchJson = async (url, options) => { calls.push({ url, options }); return gate.promise; };
  const c = createController({ reader, now: () => NOW }), element = host();
  const comparing = c.mount(element, context({ fetchJson }));
  const summary = reader.get({ ...query(), fetchJson });
  await tick(); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url, "http://local");
  assert.equal(url.pathname, "/api/regional-analysis");
  assert.equal(url.searchParams.get("month"), "2026-09"); assert.equal(url.searchParams.get("months"), "13");
  assert.equal(calls[0].options, undefined, "read-only reader never posts a refresh");
  gate.resolve(response()); await Promise.all([comparing, summary]);
  assert.equal(reader.read(query()), c.state.records.a.data);
});

test("newly registered labels and removed targets update on mount without resetting a search draft", async () => {
  const reader = readerFixture(), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context()); c.addTarget("b"); await c.refresh();
  c.updateSearch("새 지역");
  const changed = [{ regionKey: "a", label: "기준지역 새 이름" }, { regionKey: "e", label: "새 지역" }];
  await c.mount(element, context({ regionLabel: "기준지역 새 이름", regions: changed }));
  assert.deepEqual(c.state.targets, []); assert.equal(c.state.records.b, undefined);
  assert.equal(c.state.query, "새 지역");
  assert.match(element.innerHTML, /기준지역 새 이름/); assert.match(element.innerHTML, /value="e">새 지역<\/option>/);
  assert.doesNotMatch(element.innerHTML, /data-rc-remove="b"/);
});

test("adding an unprepared region keeps each existing latest value as an explicitly non-comparable reference", async () => {
  const reader = readerFixture([], scope => scope.regionKey === "b" ? { scope: { regionKey: "b", month: scope.month, months: 13 }, snapshot: null } : response(scope.regionKey, scope.month));
  const c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context()); c.addTarget("b"); await c.refresh();
  assert.match(element.innerHTML, /공통 기간 미확인 · 기간 다름 또는 자료 부족/);
  assert.match(element.innerHTML, /<strong>미확인<\/strong>[^]*?공통월 직접비교 불가 · 지역 최근값 <b>0<\/b> 명<br>기준 2026-09/);
  assert.match(element.innerHTML, /지역 최근값 <b>미확인<\/b> 단위 미확인/);
  assert.equal(c.state.records.a.data.snapshot.groups[0].metrics[0].rows[0].value, 0);
  assert.equal(c.state.records.b.data.snapshot, null);
});

test("saved group staleness and provider-refresh failures are visible beside otherwise normal cells", async () => {
  const data = response(); data.snapshot.groups[0].stale = true; data.snapshot.groups[0].refreshedStatus = "failed";
  const reader = readerFixture([], () => data), c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context());
  assert.match(element.innerHTML, /<strong>0<\/strong>/);
  assert.match(element.innerHTML, /이전 자료 · 최신 여부 확인 필요/);
  assert.match(element.innerHTML, /최근 지표 갱신 실패 · 보존된 정상값/);
  assert.equal(c.state.records.a.error, "", "provider refresh state is distinct from a failed saved-result GET");
  assert.equal(element.dataset.rcCheckStatus, "checked");
  data.snapshot.groups[0].refreshedStatus = ""; await c.refresh();
  assert.doesNotMatch(element.innerHTML, /최근 지표 갱신 실패/);
  assert.match(element.innerHTML, /이전 자료 · 최신 여부 확인 필요/);
  data.snapshot.groups[0].lastRefreshErrorCode = "TIMEOUT"; await c.refresh();
  assert.match(element.innerHTML, /최근 지표 갱신 실패 · 보존된 정상값/);
});

test("automatic months roll forward, explicit past months persist, and another account starts with its own default", async () => {
  let clock = NOW;
  const reader = readerFixture(), c = createController({ reader, now: () => clock }), element = host(), scope = context(); delete scope.month;
  await c.mount(element, scope); assert.equal(c.state.month, "2026-09"); assert.equal(c.state.monthExplicit, false);
  clock = Date.parse("2026-11-01T00:00:00Z"); c.stop(); await c.mount(element, scope);
  assert.equal(c.state.month, "2026-10"); assert.equal(c.state.records.a.data.snapshot.scope.month, "2026-10");
  assert.equal(c.selectMonth("2026-08"), true); await c.refresh(); assert.equal(c.state.monthExplicit, true);
  clock = Date.parse("2026-12-01T00:00:00Z"); c.stop(); await c.mount(element, scope);
  assert.equal(c.state.month, "2026-08", "a deliberately selected historical month does not roll forward");
  c.stop(); await c.mount(element, { ...scope, accountKey: "other" });
  assert.equal(c.state.month, "2026-11"); assert.equal(c.state.monthExplicit, false);
  await c.mount(element, { ...scope, accountKey: "other", month: "2026-07" });
  assert.equal(c.state.month, "2026-07"); assert.equal(c.state.monthExplicit, true, "an explicit new context is kept for that account");
});

test("same active scope reuses fresh results, while stale results, explicit checks and new entries confirm again", async () => {
  let fresh = true;
  const reader = readerFixture(); reader.fresh = input => fresh && Boolean(reader.read(input));
  const c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context()); assert.equal(reader.calls.length, 1); assert.equal(reader.calls[0].force, true);
  const shown = element.innerHTML;
  await c.mount(element, context()); await c.mount(element, context());
  assert.equal(reader.calls.length, 1, "an unchanged active screen's rerender does not force GET past the shared 60-second cache");
  assert.equal(element.innerHTML, shown);
  fresh = false; await c.mount(element, context());
  assert.equal(reader.calls.length, 2); assert.equal(reader.calls.at(-1).force, false, "stale data use the reader's normal freshness check");
  fresh = true; await c.refresh();
  assert.equal(reader.calls.length, 3); assert.equal(reader.calls.at(-1).force, true);
  element.dataset.rcEntryStartedAt = String(NOW); await c.mount(element, context());
  assert.equal(reader.calls.length, 4); assert.equal(reader.calls.at(-1).force, true, "a new visible entry confirms even a fresh stored result");
  c.stop(); await c.mount(element, context());
  assert.equal(reader.calls.length, 5); assert.equal(reader.calls.at(-1).force, true, "returning to a paused screen is a new entry");
});

test("a fresh saved cache is not a new server confirmation and preserves the actual GET time", async () => {
  let clock = NOW;
  const analysis = require("../web/regional-analysis.js"), reader = analysis.createSavedResults({ cache: analysis.createCache({ now: () => clock }), now: () => clock });
  const calls = [], fetchJson = async url => { calls.push(url); return response(); };
  const c = createController({ reader, now: () => clock }), element = host();
  await c.mount(element, context({ fetchJson }));
  const actualCheckedAt = new Date(clock).toISOString();
  assert.equal(c.state.records.a.checkedAt, actualCheckedAt);
  assert.equal(element.dataset.rcCheckSource, "server");
  clock += 5000; await c.refresh(false);
  assert.equal(calls.length, 1, "fresh cache reuse does not send another saved-result GET");
  assert.equal(c.state.records.a.source, "cache"); assert.equal(c.state.records.a.checkedAt, actualCheckedAt);
  assert.equal(c.state.checkedAt, actualCheckedAt); assert.equal(element.dataset.rcCheckAt, actualCheckedAt);
  assert.equal(element.dataset.rcCheckStatus, "cached"); assert.equal(element.dataset.rcCheckSource, "cache");
  assert.match(element.innerHTML, /캐시 재사용 · 새 서버 확인 없음/);
  assert.match(element.innerHTML, /최근 서버 확인 2026-10-17 12:00 KST/);
});

test("mixed regional checks separate a newly checked region from another region's fresh cache", async () => {
  let clock = NOW;
  const analysis = require("../web/regional-analysis.js"), reader = analysis.createSavedResults({ cache: analysis.createCache({ now: () => clock }), now: () => clock });
  const calls = [], fetchJson = async url => { const regionKey = new URL(url, "http://local").searchParams.get("regionKey"); calls.push(regionKey); return response(regionKey); };
  const c = createController({ reader, now: () => clock }), element = host();
  await c.mount(element, context({ fetchJson })); c.addTarget("b"); await c.refresh();
  const oldA = c.state.records.a.checkedAt, oldB = c.state.records.b.checkedAt, initialCount = calls.length;
  clock += 65000; reader.invalidate(query({ regionKey: "b" }));
  // Another surface just checked A, so only B needs a GET in this comparison refresh.
  await reader.get({ ...query(), fetchJson, force: true });
  const freshA = reader.info(query()).checkedAt;
  clock += 5000; await c.refresh(false);
  assert.deepEqual(calls.slice(initialCount), ["a", "b"]);
  assert.equal(c.state.records.a.source, "cache"); assert.equal(c.state.records.b.source, "server");
  assert.equal(c.state.records.a.checkedAt, new Date(freshA).toISOString());
  assert.notEqual(c.state.records.a.checkedAt, oldA); assert.notEqual(c.state.records.b.checkedAt, oldB);
  assert.equal(c.state.records.b.checkedAt, new Date(clock).toISOString());
  assert.equal(element.dataset.rcCheckStatus, "mixed"); assert.equal(element.dataset.rcCheckSource, "mixed");
  assert.match(element.innerHTML, /일부 지역 서버 확인 · 나머지 캐시 재사용/);
  assert.match(element.innerHTML, /최근 서버 확인 2026-10-17 12:01 KST/);
  const lastB = c.state.records.b.checkedAt;
  clock += 1000; await c.refresh(false);
  assert.equal(calls.length, initialCount + 2); assert.equal(element.dataset.rcCheckStatus, "cached");
  assert.equal(c.state.records.b.checkedAt, lastB, "cache-only confirmation cannot advance either region's last GET timestamp");
});

test("joining a concurrent forced GET is a server check even when its clock timestamp matches a fresh cache", async () => {
  const analysis = require("../web/regional-analysis.js"), reader = analysis.createSavedResults({ cache: analysis.createCache({ now: () => NOW }), now: () => NOW });
  let count = 0, gate = null;
  const fetchJson = async () => { count++; return gate ? gate.promise : response(); }, c = createController({ reader, now: () => NOW }), element = host();
  await c.mount(element, context({ fetchJson }));
  gate = deferred(); const summaryCheck = reader.get({ ...query(), fetchJson, force: true }); await tick();
  const checking = c.refresh(false); await tick(); assert.equal(count, 2, "comparison joins the existing GET");
  gate.resolve(response("a", "2026-09", { value: 19 })); await Promise.all([summaryCheck, checking]);
  assert.equal(c.state.records.a.source, "server"); assert.equal(element.dataset.rcCheckStatus, "checked");
  assert.equal(element.dataset.rcCheckSource, "server"); assert.equal(c.state.records.a.checkedAt, new Date(NOW).toISOString());
  assert.equal(c.state.records.a.data.snapshot.groups[0].metrics[0].rows[0].value, 19);
});

test("cache reuse and failed saved checks never invent an unknown actual server timestamp", async () => {
  let clock = NOW, fresh = false, fail = false;
  const reader = readerFixture([], () => fail ? Promise.reject(new Error("서버 확인 실패")) : response());
  reader.info = () => ({ checkedAt: null }); reader.fresh = () => fresh;
  const originalGet = reader.get;
  reader.get = input => !input.force && fresh ? Promise.resolve(reader.read(input)) : originalGet(input);
  const c = createController({ reader, now: () => clock }), element = host();
  await c.mount(element, context());
  assert.equal(c.state.records.a.checkedAt, ""); assert.equal(element.dataset.rcCheckAt, undefined);
  fresh = true; clock += 1000; await c.refresh(false);
  assert.equal(element.dataset.rcCheckStatus, "cached"); assert.equal(c.state.checkedAt, "");
  assert.match(element.innerHTML, /최근 서버 확인 기록 없음/);
  fail = true; clock += 1000; await c.refresh();
  assert.equal(element.dataset.rcCheckStatus, "error"); assert.equal(c.state.records.a.checkedAt, "");
  assert.equal(element.dataset.rcCheckAt, undefined); assert.ok(c.state.records.a.data.snapshot);
});

test("legacy spatial scope preserves normal values as references without manufacturing directly comparable zeros", async () => {
  const a = response("a"), b = response("b", "2026-09", { value: 19 });
  delete a.snapshot.groups[0].spatialContract; delete b.snapshot.groups[0].spatialContract;
  const [row] = comparisonModel([{ data: a }, { data: b }]);
  assert.equal(row.commonPeriod, ""); assert.equal(row.reasonCode, "SCOPE_UNVERIFIED");
  assert.deepEqual(row.cells.map(cell => cell.value), [null, null]); assert.deepEqual(row.cells.map(cell => cell.latestValue), [0, 19]);
  const c = createController({ reader: readerFixture([], () => a), now: () => NOW }), element = host();
  await c.mount(element, context());
  assert.match(element.innerHTML, /지역 범위 확인 필요/);
  assert.match(element.innerHTML, /<strong>미확인<\/strong>/); assert.match(element.innerHTML, /범위 미확인 참고값 <b>0<\/b>/);
  assert.equal(c.state.records.a.data, a); assert.equal(a.snapshot.groups[0].metrics[0].rows[0].value, 0);
});

test("spatial mismatch, unverified evidence and unsupported contracts block direct comparison", () => {
  for (const change of [
    { status: "mapping_pending" }, { status: "mapping_missing" }, { status: "response_mismatch" }, { status: "scope_unverified" },
    { requestedRegionKey: "other" }, { version: "unsupported" }, { evidence: "unverified" }, { aggregation: "sum" },
    { providedLevel: "sido" }, { requestedUnitType: "general_district" }
  ]) {
    const a = response("a"), b = response("b", "2026-09", { value: 20 });
    Object.assign(b.snapshot.groups[0].spatialContract, change);
    const [row] = comparisonModel([{ data: a }, { data: b }]);
    assert.equal(row.commonPeriod, "", JSON.stringify(change)); assert.deepEqual(row.cells.map(cell => cell.value), [null, null]);
    assert.deepEqual(row.cells.map(cell => cell.latestValue), [0, 20]);
  }
  const a = response("a"), b = response("b");
  Object.assign(b.snapshot.groups[0].spatialContract, { requestedLevel: "sido", providedLevel: "sido" });
  assert.equal(comparisonModel([{ data: a }, { data: b }])[0].reasonCode, "LEVEL_MISMATCH");
  Object.assign(b.snapshot.groups[0].spatialContract, matchedScope("b", "한국관광공사", { providerRegionCode: "48860" }));
  assert.equal(comparisonModel([{ data: a }, { data: b }])[0].commonPeriod, "", "different region keys cannot certify the same provider area as two local markets");
});

test("common period selection validates each row's contract before falling back to an older verified month", () => {
  const data = ["a", "b"].map(key => response(key, "2026-09", { rows: [
    { period: "2026-08", value: key === "a" ? 0 : 12, status: "observed", spatialContract: matchedScope(key) },
    { period: "2026-09", value: 90, status: "observed", spatialContract: matchedScope(key, "한국관광공사", { status: "scope_unverified", evidence: "unverified" }) }
  ] }));
  let [row] = comparisonModel(data.map(data => ({ data })));
  assert.equal(row.commonPeriod, "2026-08"); assert.equal(row.newerPeriodExcluded, true); assert.deepEqual(row.cells.map(cell => cell.value), [0, 12]);
  assert.equal(row.excludedPeriod, "2026-09"); assert.equal(row.excludedReason, "지역 범위 확인 필요");
  for (const value of data) value.snapshot.groups[0].metrics[0].rows[0].spatialContract = {};
  [row] = comparisonModel(data.map(data => ({ data })));
  assert.equal(row.commonPeriod, ""); assert.deepEqual(row.cells.map(cell => cell.latestValue), [90, 90]);
  assert.equal(row.reasonCode, "SCOPE_UNVERIFIED", "explicit legacy row contracts cannot inherit a matched metric or group contract");
});

test("annual and monthly contracts remain separate and a period's format must agree with its declared frequency", () => {
  const groups = key => [{ key: "kosis", provider: "KOSIS", category: "background", spatialContract: matchedScope(key, "KOSIS"), metrics: [
    { key: "population", label: "인구", periodType: "M", unit: "명", rows: [{ period: "2026-08", status: "observed", value: 0 }] },
    { key: "workers", label: "종사자", periodType: "Y", unit: "명", rows: [{ period: "2024", status: "observed", value: 5 }] }
  ] }];
  const data = ["a", "b"].map(key => response(key, "2026-09", { groups: groups(key) }));
  let rows = comparisonModel(data.map(data => ({ data })), "background");
  assert.deepEqual(rows.map(row => [row.periodType, row.commonPeriod]), [["M", "2026-08"], ["Y", "2024"]]);
  const html = renderDashboard({ regionKey: "a", regionLabel: "A", month: "2026-09", maxMonth: "2026-09", regions, targets: ["b"], records: { a: { data: data[0] }, b: { data: data[1] } }, open: new Set(), query: "", candidate: "" });
  assert.match(html, /인구·산업 월간 기초자료 · 공통 기준월/); assert.match(html, /인구·산업 연간 기초자료 · 공통 기준연도/);
  data[1].snapshot.groups[0].metrics[1].periodType = "M";
  rows = comparisonModel(data.map(data => ({ data })), "background");
  assert.equal(rows[1].commonPeriod, ""); assert.equal(rows[1].reasonCode, "PERIOD_TYPE_MISMATCH");
  data[0].snapshot.groups[0].metrics[1].periodType = "M";
  assert.equal(comparisonModel(data.map(data => ({ data })), "background")[1].commonPeriod, "", "a year-shaped row cannot become a monthly observation");
});

test("comparison evidence keeps disclosure state and loads shared rules before either regional screen", async () => {
  const c = createController({ reader: readerFixture(), now: () => NOW }), element = host();
  await c.mount(element, context());
  const key = element.innerHTML.match(/class="rc-evidence rc-contract" data-rc-detail="([^"]+)"/)[1];
  assert.doesNotMatch(element.innerHTML, new RegExp(`data-rc-detail="${key}" open`));
  element.listeners.get("toggle")({ currentTarget: element, target: { dataset: { rcDetail: key }, open: true } });
  await c.refresh(); assert.ok(element.innerHTML.includes(`data-rc-detail="${key}" open`));
  for (const label of ["공통 기준 확인", "실제 범위", "수집 상태", "제공 지역 코드", "제공 응답에서 확인"]) assert.ok(element.innerHTML.includes(label));
  const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  assert.ok(html.indexOf('/regional-data-contract.js') < html.indexOf('/regional-analysis.js'));
  assert.ok(html.indexOf('/regional-analysis.js') < html.indexOf('/regional-comparison.js'));
  const css = fs.readFileSync(path.join(__dirname, "../web/regional-comparison.css"), "utf8");
  assert.match(css, /\.rc-contract :is\(dt,dd\)[^}]*overflow-wrap:anywhere/);
});

test("comparison shows the chosen month's original reference rather than the latest month's proof", () => {
  const data = ["a", "b"].map(key => response(key, "2026-09", { rows: [
    { period: "2026-08", status: "observed", value: 0, spatialContract: { ...matchedScope(key), storedProvenance: {
      version: "stored-tourism-spatial-evidence-v1", sourceKind: "stored_raw_response", evidenceId: "visitor-202608-abcdef0123456789", sha256: "a".repeat(64), period: "2026-08", verifiedAt: "2026-10-17T08:00:00Z", checks: ["hash", "values"] } } },
    { period: "2026-09", status: "observed", value: 3, spatialContract: { ...matchedScope(key), status: "scope_unverified", evidence: "unverified" }, storedEvidenceVerification: { status: "pending", reasonCode: "RAW_RESPONSE_NOT_RETAINED" } }
  ] }));
  const row = comparisonModel(data.map(data => ({ data })))[0];
  assert.equal(row.commonPeriod, "2026-08"); assert.deepEqual(row.cells.map(c => c.value), [0, 0]);
  const html = renderDashboard({ regionKey: "a", regionLabel: "A", month: "2026-09", maxMonth: "2026-09", regions, targets: ["b"], records: { a: { data: data[0] }, b: { data: data[1] } }, open: new Set(), query: "", candidate: "" });
  assert.match(html, /보관 원본 재검증/); assert.match(html, /visitor-202608-abcdef0123456789/);
  assert.match(html, /원본 번호·기간/); assert.doesNotMatch(html, /보관 근거 미확인/);
});
