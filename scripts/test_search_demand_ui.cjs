"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const ui = require("../web/search-demand-analysis.js");
const count = value => ({ state: "number", value, raw: value, lowerBound: value, upperBoundExclusive: null });
const unknown = () => ({ state: "unknown", value: null, raw: null, lowerBound: null, upperBoundExclusive: null });
const range = () => ({ state: "range", value: null, raw: "<10", lowerBound: 0, upperBoundExclusive: 10 });
const keyword = "경남글램핑";
const fixed = { keyword, day: "2026-11-01", month: "2026-11", relatedKeyword: "", page: 1, pageSize: 20, sort: "searchVolumeDesc", search: "" };
function response(query = fixed, overrides = {}) {
  const selection = { ...fixed, ...query }, dailyKeyword = selection.relatedKeyword || selection.keyword;
  return { schemaVersion: 1, readOnly: true, selection,
    searchVolume: { status: "ready", exact: true, anchor: { keyword: selection.keyword, keywordId: "kw_fake", monthlyPc: count(1790), monthlyMobile: count(7870), total: count(9660), status: "ready" }, observedAt: "2026-11-01T07:20:51.000Z", snapshotId: "fake_snapshot", day: selection.day, stale: false },
    daily: { keyword: dailyKeyword, rows: [{ day: "2026-11-01", monthlyPc: count(1790), monthlyMobile: count(7870), total: count(9660), status: "ready" }, { day: "2026-11-02", monthlyPc: unknown(), monthlyMobile: unknown(), total: unknown(), status: "missing" }], missingDaysCount: 1 },
    trend: { keyword: selection.keyword, status: "partial", observedAt: "2026-11-01T07:21:00.000Z", startDate: "2025-11-01", endDate: "2026-10-31", series: [{ period: "2025-11-01", ratio: 70, state: "observed" }, { period: "2025-12-01", ratio: null, state: "missing" }, { period: "2026-01-01", ratio: 0, state: "observed" }], coverage: { observedMonths: 2, expectedMonths: 12 } },
    related: { status: "ready", observedAt: "2026-11-01T07:20:51.000Z", rows: [{ keyword: selection.keyword, monthlyPc: count(1790), monthlyMobile: count(7870), total: count(9660), status: "ready", isAnchor: true }, { keyword: "경남애견글램핑", monthlyPc: range(), monthlyMobile: unknown(), total: unknown(), status: "partial", conflicting: true }], total: 25, page: selection.page, pageSize: 20, totalPages: 2, counts: { returnedRows: 25, validRows: 25, uniqueRows: 25, duplicateRows: 0, conflictingKeys: 1, invalidRows: 0 } },
    history: { rows: [{ keyword: selection.keyword, provider: "searchad", day: selection.day, observedAt: "2026-11-01T07:20:51.000Z", status: "ready", counts: { returnedRows: 25, uniqueRows: 25 } }], total: 1, truncated: false },
    forecast: { status: "held", targetMonth: selection.month, value: null, reasonCode: "INCOMPLETE_TREND", modelVersion: "legacy-preserved-v1" }, ...overrides };
}
function element() {
  const listeners = {};
  return { innerHTML: "", addEventListener(name, callback) { listeners[name] = callback; },
    click(dataset) { listeners.click?.({ target: { closest() { return { dataset, disabled: false }; } } }); },
    submit(kind, fields) { let prevented = false; listeners.submit?.({ target: { dataset: { sdaForm: kind }, elements: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value }])) }, preventDefault() { prevented = true; } }); return prevented; },
    change(value) { listeners.change?.({ target: { value, matches: selector => selector === "[data-sda-cadence]" } }); }
  };
}
function fromUrl(url) {
  const params = new URL(url, "https://fixture.invalid").searchParams;
  return { ...fixed, keyword: params.get("keyword"), month: params.get("month"), day: params.get("day"), relatedKeyword: params.get("relatedKeyword") || "", page: Number(params.get("page") || 1), pageSize: Number(params.get("pageSize") || 20), sort: params.get("sort") || "searchVolumeDesc", search: params.get("search") || "" };
}
function fixture(options = {}) {
  const root = element(), calls = [];
  const fetchJson = options.fetchJson || (async url => {
    calls.push(url);
    if (url.endsWith("/catalog")) return { schemaVersion: 1, readOnly: true, keywords: [{ keyword, keywordId: "kw_fake", kind: "anchor" }, { keyword: "포천글램핑", kind: "anchor" }], scheduler: { enabled: false } };
    if (url.includes("/report?")) { const params = new URL(url, "https://fixture.invalid").searchParams; return { selection: fromUrl(url), cadence: params.get("cadence"), status: "ready", generatedAt: "2026-11-01T07:25:00.000Z" }; }
    return response(fromUrl(url));
  });
  return { root, calls, fetchJson };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("count states preserve exact zero, bounds and unknown without midpoint guesses", () => {
  assert.deepEqual(ui.countView(count(0)), { state: "number", value: 0, lowerBound: 0, upperBoundExclusive: null, label: "0" });
  assert.equal(ui.countView(range()).label, "10 미만");
  assert.equal(ui.countView(range()).value, null);
  for (const input of [null, undefined, 0, { state: "number", value: null }, { state: "number", value: "5" }, { state: "unknown", value: 0 }, { state: "range", lowerBound: 0, upperBoundExclusive: 0 }]) assert.equal(ui.countView(input).state, "unknown");
});

test("selected scope must match keyword, observation date, month and related list filters", () => {
  const selected = ui.currentSelection({ ...fixed });
  assert.equal(ui.viewModel(response(), selected).matches, true);
  for (const patch of [{ keyword: "다른키워드" }, { day: "2026-11-02" }, { month: "2026-12" }, { relatedKeyword: "다른연관어" }, { search: "다른검색" }, { sort: "keywordAsc" }, { page: 2 }]) assert.equal(ui.viewModel(response({ ...fixed, ...patch }), selected).matches, false);
});

test("an unmatched anchor is never replaced by the first related result", () => {
  const selected = ui.currentSelection(fixed), value = response();
  value.searchVolume.exact = false;
  assert.equal(ui.viewModel(value, selected).anchor, null);
  value.searchVolume.exact = true; value.searchVolume.anchor.keyword = "다른키워드";
  assert.equal(ui.viewModel(value, selected).anchor, null);
});

test("missing trend points stay null while observed zero is retained", () => {
  const model = ui.viewModel(response(), ui.currentSelection(fixed));
  assert.deepEqual(model.trend.map(row => row.value), [70, null, 0]);
  assert.equal(model.daily[1].total.state, "unknown");
});

test("a forecast requires verified state and the exact target month", () => {
  const selected = ui.currentSelection(fixed);
  for (const value of [{ status: "held", targetMonth: selected.month, value: 500 }, { status: "verified", targetMonth: "2026-12", value: 500 }, { status: "verified", targetMonth: selected.month, value: null }]) assert.equal(ui.viewModel(response(fixed, { forecast: value }), selected).forecast.value, null);
  assert.equal(ui.viewModel(response(fixed, { forecast: { status: "verified", targetMonth: selected.month, value: 0 } }), selected).forecast.value, 0);
});

test("chart gaps and range values never become zero points or connecting lines", () => {
  const model = ui.viewModel(response(), ui.currentSelection(fixed));
  const chart = ui.chartMarkup(model.trend, { trend: true });
  assert.equal((chart.match(/<circle /g) || []).length, 2);
  assert.equal((chart.match(/<polyline /g) || []).length, 0);
  const ranged = ui.chartMarkup([{ day: "2026-11-01", total: ui.countView(range()) }]);
  assert.equal((ranged.match(/<circle /g) || []).length, 0);
  assert.match(ranged, /범위값만 확인/);
  const zero = ui.chartMarkup([{ day: "2026-11-01", total: ui.countView(count(0)) }]);
  assert.equal((zero.match(/<circle /g) || []).length, 1);
});

test("initial show issues only catalog and saved analysis GET URLs", async () => {
  const f = fixture();
  await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0], "/api/search-demand/catalog");
  assert.match(f.calls[1], /^\/api\/search-demand\/analysis\?/);
  assert.ok(f.calls.every(url => !/verify|refresh|collector|crawl|kosis/.test(url)));
  assert.match(f.root.innerHTML, /9,660/);
  assert.match(f.root.innerHTML, /최근 월간 검색수/);
  assert.match(f.root.innerHTML, /0으로 바꾸지/);
});

test("the independent day and forecast month survive pause and cross-keyword navigation", async () => {
  const f = fixture();
  await ui.show(f.root, { ...fixed, month: "2026-12", fetchJson: f.fetchJson });
  await ui.setSelection(f.root, { tab: "history", relatedPage: 2, device: "mobile" });
  ui.pause(f.root);
  await ui.show(f.root, { keyword: "포천글램핑" });
  const selected = ui.getSelection(f.root);
  assert.equal(selected.keyword, "포천글램핑"); assert.equal(selected.day, "2026-11-01"); assert.equal(selected.month, "2026-12");
  assert.equal(selected.tab, "history"); assert.equal(selected.device, "mobile"); assert.equal(selected.relatedPage, 1);
});

test("an explicitly selected unregistered keyword is not replaced by a catalog default", async () => {
  const f = fixture();
  await ui.show(f.root, { ...fixed, keyword: "등록외키워드", fetchJson: f.fetchJson });
  assert.equal(ui.getSelection(f.root).keyword, "등록외키워드");
  assert.match(f.calls[1], new RegExp(encodeURIComponent("등록외키워드")));
  assert.match(f.root.innerHTML, /등록 목록 외/);
});

test("tabs and device switches are local and preserve source selection", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  const before = f.calls.length;
  f.root.click({ sdaTab: "related" }); f.root.click({ sdaDevice: "mobile" });
  assert.equal(f.calls.length, before);
  assert.equal(ui.getSelection(f.root).tab, "related"); assert.equal(ui.getSelection(f.root).device, "mobile");
  assert.equal(ui.getSelection(f.root).keyword, keyword);
});

test("related search and pagination read the full saved list without a fixed result count", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  f.root.click({ sdaTab: "related" });
  assert.match(f.root.innerHTML, /검색 결과 25개/); assert.doesNotMatch(f.root.innerHTML, /861/);
  assert.equal(f.root.submit("related", { search: "애견", sort: "keywordAsc" }), true);
  await flush();
  assert.equal(ui.getSelection(f.root).relatedQuery, "애견");
  assert.match(f.calls.at(-1), /sort=keywordAsc/);
  f.root.click({ sdaPage: "2" }); await flush();
  assert.equal(ui.getSelection(f.root).relatedPage, 2);
  assert.match(f.calls.at(-1), /page=2/);
});

test("selecting a related word reads its saved history while preserving the anchor", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  f.root.click({ sdaRelated: "경남애견글램핑" }); await flush();
  assert.equal(ui.getSelection(f.root).keyword, keyword);
  assert.equal(ui.getSelection(f.root).relatedKeyword, "경남애견글램핑");
  assert.match(f.root.innerHTML, /경남애견글램핑 관측 이력/);
  assert.ok(f.calls.every(url => url.startsWith("/api/search-demand/")));
});

test("failed reads retain the old observation and explicitly mark the new read as unverified", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  await ui.show(f.root, { fetchJson: async () => { throw Error("private-provider-secret"); } });
  assert.match(f.root.innerHTML, /저장 자료를 읽지 못했습니다/);
  assert.match(f.root.innerHTML, /이번 조회 성공을 뜻하지 않습니다/);
  assert.match(f.root.innerHTML, /9,660/);
  assert.doesNotMatch(f.root.innerHTML, /private-provider-secret/);
});

test("a late response after pause cannot overwrite the visible saved view", async () => {
  const root = element(); let finish;
  const pending = ui.show(root, { ...fixed, fetchJson: url => url.endsWith("/catalog") ? Promise.resolve({ keywords: [{ keyword }] }) : new Promise(resolve => { finish = resolve; }) });
  await flush(); ui.pause(root); const before = root.innerHTML;
  finish(response()); await pending;
  assert.equal(root.innerHTML, before);
  assert.doesNotMatch(root.innerHTML, /9,660/);
});

test("a late response for a different selection cannot paint its data under a new keyword", async () => {
  const root = element(); let finish;
  const pending = ui.show(root, { ...fixed, fetchJson: url => url.endsWith("/catalog") ? Promise.resolve({ keywords: [{ keyword }] }) : new Promise(resolve => { finish = resolve; }) });
  await flush(); await ui.setSelection(root, { keyword: "포천글램핑" });
  finish(response()); await pending;
  assert.match(root.innerHTML, /포천글램핑/); assert.doesNotMatch(root.innerHTML, /9,660/);
});

test("cross-navigation passes the keyword and separate dates without changing them", async () => {
  const f = fixture(); let passed;
  await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson, onOpenKeywordMonthly: value => { passed = value; } });
  const before = ui.getSelection(f.root);
  f.root.click({ sdaMonthly: "" });
  assert.deepEqual(passed, { keyword, month: fixed.month, day: fixed.day });
  assert.deepEqual(ui.getSelection(f.root), before);
});

test("report reads and CSV exports preserve selection and use authenticated saved GET paths", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  f.root.click({ sdaTab: "forecast" });
  assert.match(f.root.innerHTML, /href="\/api\/search-demand\/report\?/);
  assert.match(f.root.innerHTML, /format=csv/);
  f.root.change("monthly"); f.root.click({ sdaReport: "" }); await flush();
  assert.match(f.calls.at(-1), /cadence=monthly/); assert.match(f.calls.at(-1), /format=json/);
  assert.match(f.root.innerHTML, /보고 주기/);
});

test("provider raw text, credential-like fields and keyword markup are never rendered as HTML", async () => {
  const root = element(), dangerous = '<img src=x onerror="private-key">';
  await ui.show(root, { keyword: dangerous, day: fixed.day, month: fixed.month, fetchJson: async url => url.endsWith("/catalog") ? { keywords: [{ keyword: dangerous }] } : response({ ...fixed, keyword: dangerous }, { secret: "private-credential", rawBody: "provider-full-body", forecast: { status: "held", reason: "<script>private-provider</script>" } }) });
  assert.doesNotMatch(root.innerHTML, /<img src=x|<script>|private-credential|provider-full-body|private-provider/);
  assert.match(root.innerHTML, /&lt;img/);
});

test("module has no provider endpoint, POST action, polling or automatic collection call", () => {
  const source = fs.readFileSync(path.join(__dirname, "../web/search-demand-analysis.js"), "utf8");
  assert.doesNotMatch(source, /https:\/\/api\.searchad|https:\/\/naverapihub|method:\s*["']POST|setInterval\(/);
  assert.match(source, /method: "GET", credentials: "same-origin", cache: "no-store"/);
});

test("day and week comparisons use fractions correctly and never invent zero-base percentages", async () => {
  const root = element();
  await ui.show(root, { ...fixed, fetchJson: async url => url.endsWith("/catalog") ? { keywords: [{ keyword }] } : response(fixed, { comparisons: { day: { status: "available", absolute: 100, percent: .25 }, week: { status: "zero_base", absolute: 50, percent: null } } }) });
  assert.match(root.innerHTML, /\+100회 · \+25%/);
  assert.match(root.innerHTML, /\+50회 · 증감률 미확인/);
  assert.doesNotMatch(root.innerHTML, /Infinity|NaN/);
});

test("verified preview calculations are distinct from published forecasts", async () => {
  const root = element();
  await ui.show(root, { ...fixed, fetchJson: async url => url.endsWith("/catalog") ? { keywords: [{ keyword }] } : response(fixed, { forecast: { status: "verified", value: 1234, targetMonth: fixed.month, preview: true, published: false, modelVersion: "legacy-preserved-v1", calculatedAt: "2026-11-01T07:21:00.000Z" } }) });
  assert.match(root.innerHTML, /1,234/);
  assert.match(root.innerHTML, /미발행 계산/);
  assert.doesNotMatch(root.innerHTML, /저장된 발행 전망/);
  root.click({ sdaTab: "forecast" });
  assert.match(root.innerHTML, /조회가 발행을 실행하지 않음/);
});

test("job history keeps unrecorded request counts unknown and excludes other keywords", async () => {
  const root = element();
  await ui.show(root, { ...fixed, fetchJson: async url => url.endsWith("/catalog") ? { keywords: [{ keyword }] } : response(fixed, { jobHistory: { status: "ready", truncated: true, items: [{ keyword, provider: "searchad", period: fixed.day, status: "running", scheduledAt: "2026-11-01T00:30:00.000Z", startedAt: "2026-11-01T00:30:01.000Z", finishedAt: null, requestCount: null, lastRequestCount: null, ownerToken: "private-job-token" }, { keyword: "다른키워드", period: "private-other-job", requestCount: 9999 }] } }) });
  root.click({ sdaTab: "history" });
  assert.match(root.innerHTML, /검색 API 작업 이력/);
  assert.match(root.innerHTML, /미확인 \/ 미확인/);
  assert.match(root.innerHTML, /일부만 조회/);
  assert.doesNotMatch(root.innerHTML, /private-job-token|private-other-job|9,999/);
});

test("reports show their scope, representative observation and incomplete rows without summing days", async () => {
  const f = fixture();
  const fetchJson = async url => {
    if (!url.includes("/report?")) return f.fetchJson(url);
    const query = new URL(url, "https://fixture.invalid").searchParams;
    assert.deepEqual([...query.keys()].sort(), ["cadence", "day", "format", "keyword", "month"]);
    return { cadence: query.get("cadence"), selection: fromUrl(url), status: "available", generatedAt: "2026-11-01T07:30:00.000Z", scope: { from: fixed.day, to: fixed.day }, summary: { known: 1, ranged: 1, missing: 1, representative: { day: fixed.day, total: count(9660) } }, rows: [{ day: fixed.day, keyword, monthlyPc: range(), monthlyMobile: unknown(), total: unknown(), status: "partial", isAnchor: true }] };
  };
  await ui.show(f.root, { ...fixed, fetchJson });
  f.root.click({ sdaTab: "forecast" }); f.root.click({ sdaReport: "" }); await flush();
  assert.match(f.root.innerHTML, /저장 자료 있음/);
  assert.match(f.root.innerHTML, /대표 관측/);
  assert.match(f.root.innerHTML, /10 미만/);
  assert.match(f.root.innerHTML, /반복 조회한 월간 검색량을 합산하지/);
});

test("clearing a private view removes data and prevents its late request from repainting", async () => {
  const root = element(); let finish;
  const pending = ui.show(root, { ...fixed, fetchJson: url => url.endsWith("/catalog") ? Promise.resolve({ keywords: [{ keyword }] }) : new Promise(resolve => { finish = resolve; }) });
  await flush(); ui.clear(root);
  assert.equal(root.innerHTML, "");
  assert.equal(ui.getSelection(root).keyword, "");
  finish(response()); await pending;
  assert.equal(root.innerHTML, "");
  assert.equal(ui.getSelection(root).keyword, "");
});

test("global clear resets all instances and subsequent show reuses one listener binding", async () => {
  const one = fixture(), two = fixture();
  await ui.show(one.root, { ...fixed, fetchJson: one.fetchJson });
  await ui.show(two.root, { ...fixed, fetchJson: two.fetchJson });
  ui.clear();
  assert.equal(one.root.innerHTML, ""); assert.equal(two.root.innerHTML, "");
  assert.equal(ui.getSelection(one.root).keyword, "");
  await ui.show(one.root, { ...fixed, fetchJson: one.fetchJson });
  const before = one.calls.length;
  one.root.click({ sdaRefresh: "" }); await flush();
  assert.equal(one.calls.length - before, 2);
});

test("authorization failures clear prior keyword data rather than retaining a private stale view", async () => {
  const f = fixture(); await ui.show(f.root, { ...fixed, fetchJson: f.fetchJson });
  await ui.show(f.root, { fetchJson: async () => { throw Object.assign(Error("private-auth-text"), { status: 403 }); } });
  assert.equal(ui.getSelection(f.root).keyword, "");
  assert.doesNotMatch(f.root.innerHTML, /9,660|경남글램핑|private-auth-text/);
  assert.match(f.root.innerHTML, /저장 자료를 읽지 못했습니다/);
});

test("empty trend and empty volume charts render a no-data state without indexing a nonexistent point", () => {
  for (const rows of [[], null, undefined, [null, {}, { period: null }]]) {
    const markup = ui.chartMarkup(rows, { trend: true });
    assert.match(markup, /저장된 유효 관측 없음/);
    assert.doesNotMatch(markup, /<circle |NaN|undefined/);
  }
});

test("the actual store and service payload with the copied base observation renders all four UI tabs", async t => {
  const { createSearchDemandStore } = require("./lib/search_demand_store.cjs");
  const { createSearchDemandService } = require("./lib/search_demand_service.cjs");
  const { normalizeSearchAdSnapshot } = require("./lib/search_demand_model.cjs");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "search-demand-ui-service-"));
  t.after(async () => { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fsp.rm(temp, { recursive: true, force: true }); });
  const instant = "2026-11-01T07:20:52.668Z", store = createSearchDemandStore({ rootDir: path.join(temp, "store"), clock: () => new Date(instant) });
  const service = createSearchDemandService({ store, readRegisteredKeywords: async () => [keyword], clock: () => new Date(instant) });
  const root = element(), paths = []; let lastReport = Promise.resolve();
  const fetchJson = async url => {
    paths.push(url);
    const parsed = new URL(url, "https://fixture.invalid");
    if (parsed.pathname === "/api/search-demand/catalog") return JSON.parse(JSON.stringify(await service.catalog()));
    const input = Object.fromEntries(parsed.searchParams);
    for (const key of ["page", "pageSize"]) if (input[key]) input[key] = Number(input[key]);
    if (parsed.pathname === "/api/search-demand/analysis") return JSON.parse(JSON.stringify(await service.analyze(input)));
    if (parsed.pathname === "/api/search-demand/report") { lastReport = service.report(input); return JSON.parse(JSON.stringify(await lastReport)); }
    throw Error("Unexpected local service path");
  };
  await ui.show(root, { ...fixed, fetchJson });
  assert.match(root.innerHTML, /저장된 유효 관측 없음/);
  assert.doesNotMatch(root.innerHTML, /9,660/);
  // Reproduce only the permitted numeric observation from the copied receipt.
  // No live account, provider request, preserved raw response, or trend is used.
  await store.saveSnapshot(normalizeSearchAdSnapshot({ keyword, observedAt: "2026-11-01T07:20:51.668Z", scopeId: "local-ui-realcopy-fixture", keywordList: [{ relKeyword: keyword, monthlyPcQcCnt: 1790, monthlyMobileQcCnt: 7870 }] }));
  await ui.show(root, { fetchJson });
  assert.match(root.innerHTML, /9,660/);
  assert.match(root.innerHTML, /저장된 유효 관측 없음/);
  assert.match(root.innerHTML, /미계산/);
  assert.doesNotMatch(root.innerHTML, /NaN|undefined|861행/);
  for (const tab of ["related", "forecast", "history", "overview"]) assert.doesNotThrow(() => root.click({ sdaTab: tab }));
  root.click({ sdaTab: "forecast" }); root.click({ sdaReport: "" }); await lastReport; await flush();
  assert.match(root.innerHTML, /리포트 관측 자료/);
  assert.match(root.innerHTML, /9,660/);
  assert.ok(paths.every(url => url.startsWith("/api/search-demand/")));
});

test("forecast calculation provenance and held evaluation use the actual stored model fields", async () => {
  const root = element(), id = "sd_" + "a".repeat(64), windowId = "tw_" + "b".repeat(64);
  const forecast = { keyword, status: "verified", targetMonth: fixed.month, value: 500, inputVolume: 1000, factor: .5, basePeriod: "2026-10", seasonalPeriod: "2025-11", method: "seasonal_ratio", modelVersion: "legacy-demand-ratio-v1", sourceSnapshotIds: [id], trendWindowId: windowId, calculatedAt: "2026-11-01T07:20:52.668Z", published: true };
  await ui.show(root, { ...fixed, fetchJson: async url => url.endsWith("/catalog") ? { keywords: [{ keyword }] } : response(fixed, { forecast, forecastHistory: { rows: [forecast], total: 1, truncated: false }, evaluation: { status: "held", reasonCode: "COMPARABLE_CALENDAR_OBSERVATION_UNAVAILABLE" } }) });
  root.click({ sdaTab: "forecast" });
  assert.match(root.innerHTML, /2025-11 트렌드 지수 ÷ 2026-10 트렌드 지수/);
  assert.match(root.innerHTML, /입력 검색량 관측/);
  assert.match(root.innerHTML, /전망 발행 이력/);
  assert.match(root.innerHTML, /같은 기간 정의의 사후 실측이 없어 정확도 평가를 보류/);
  assert.ok(root.innerHTML.includes(id)); assert.ok(root.innerHTML.includes(windowId));
  assert.doesNotMatch(root.innerHTML, /미발행 계산/);
});

test("report request subtotals keep scheduled-job scope separate from actual period calls", async () => {
  const f = fixture();
  const fetchJson = async url => {
    if (!url.includes("/report?")) return f.fetchJson(url);
    return { selection: fromUrl(url), cadence: "daily", status: "available", requestMetrics: { countBasis: "cumulative_attempts_of_jobs_grouped_by_scheduled_period", knownRequestCountSubtotal: 4, knownJobCount: 3, unknownJobCount: 1, completeCoverage: false, actualPeriodRequestCount: null, actualPeriodRequestCountStatus: "unverified_no_per_attempt_counter_history" }, jobHistory: { truncated: true }, rows: [] };
  };
  await ui.show(f.root, { ...fixed, fetchJson });
  f.root.click({ sdaTab: "forecast" }); f.root.click({ sdaReport: "" }); await flush();
  assert.match(f.root.innerHTML, /보고기간 예정 작업의 누적 요청 소계<\/dt><dd>4건/);
  assert.match(f.root.innerHTML, /요청 계수 확인 \/ 미확인 작업<\/dt><dd>3 \/ 1/);
  assert.match(f.root.innerHTML, /일부 · 미확인 범위 있음/);
  assert.match(f.root.innerHTML, /기간 내 실제 호출 총량 미확인\(월간 재시도가 다른 날짜에 걸칠 수 있음\)/);
  assert.doesNotMatch(f.root.innerHTML, /기간 내 실제 호출 총량 4건/);
});

test("an unrecorded job subtotal is not rendered as zero requests", async () => {
  const f = fixture();
  const fetchJson = async url => !url.includes("/report?") ? f.fetchJson(url) : { selection: fromUrl(url), cadence: "daily", status: "missing", requestMetrics: { countBasis: "cumulative_attempts_of_jobs_grouped_by_scheduled_period", knownRequestCountSubtotal: null, knownJobCount: 0, unknownJobCount: 1, completeCoverage: false, actualPeriodRequestCount: null }, rows: [] };
  await ui.show(f.root, { ...fixed, fetchJson });
  f.root.click({ sdaTab: "forecast" }); f.root.click({ sdaReport: "" }); await flush();
  assert.match(f.root.innerHTML, /보고기간 예정 작업의 누적 요청 소계<\/dt><dd>미확인/);
  assert.doesNotMatch(f.root.innerHTML, /보고기간 예정 작업의 누적 요청 소계<\/dt><dd>0건/);
});
