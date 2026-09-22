"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const master = require("../web/data/region_master.json");
const directory = require("../web/data/tourism_forecast_regions.json");
const region = name => master.units.find(item => item.active && item.name === name);
const pocheon = region("포천시");
const wonju = region("원주시");
const start = app.indexOf("function tourismForecastRegionKey(");
const end = app.indexOf("const SPECIAL_DAY_KINDS", start);
assert.ok(start > 0 && end > start);
function payload(areaCd = "41", signguCd = "41650", name = "포천 산정호수") {
  const mapped = directory.regions.find(item => item.areaCd === areaCd && item.signguCd === signguCd);
  const series = Array.from({ length: 30 }, (_, index) => ({ date: new Date(Date.UTC(2026, 8, 20 + index)).toISOString().slice(0, 10), value: index === 0 ? 0 : 100 - index }));
  return { status: "ready", region: mapped, source: { name: "공식 출처", url: "https://www.data.go.kr/data/15128555/openapi.do" }, collectedAt: "2026-09-21T01:00:00Z", stale: false,
    destinations: [{ id: `${areaCd}:${signguCd}:${name}`, name, ...mapped, startDate: series[0].date, endDate: series.at(-1).date, series, complete: true, upcomingDayCount: 29, providerLagDays: 1 }], errors: [] };
}
function card() {
  return { innerHTML: "", listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; }, querySelectorAll() { return []; }, contains(target) { return target?.attached === true; } };
}
function harness(fetch = async () => payload()) {
  const calls = [], navigations = [];
  const state = { tourismForecastSettings: { configured: true, source: {}, regions: directory.regions, cachedRegions: [] }, tourismForecastData: {}, tourismForecastAreaCd: "", tourismForecastSignguCd: "", tourismForecastDestinationId: "", tourismForecastQuery: "", tourismForecastLoading: false, tourismForecastError: "", tourismForecastExpanded: false, tourismForecastAnalysisRegion: null, tourismForecastViews: {}, tourismForecastRequests: {}, tourismForecastRefreshRegionKey: "", tourismForecastConnectionMessage: "" };
  const context = vm.createContext({ state, els: { tourismForecastAdminCard: card(), tourismForecastConnectionCard: card() }, document: { activeElement: null, getElementById: () => null }, isAdminRole: () => true, escapeHtml: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"), fmtNumber: String, compactDateTime: String, specialDaysOfficialUrl: source => source.url || "", renderAdminIntegrationRegistry() {}, setActiveTab: tab => navigations.push(tab), fetchJson: async (url, options) => { calls.push({ url, options }); return fetch(url, options); } });
  vm.runInContext(app.slice(start, end), context);
  const eventStart = app.indexOf('els.tourismForecastAdminCard?.addEventListener("submit"');
  const eventEnd = app.indexOf('els.specialDaysAdminCard?.addEventListener("click"', eventStart);
  assert.ok(eventStart > 0 && eventEnd > eventStart);
  vm.runInContext(app.slice(eventStart, eventEnd), context);
  return { context, state, calls, navigations, main: context.els.tourismForecastAdminCard, settings: context.els.tourismForecastConnectionCard };
}

test("official master mapping requires one exact provider code and never substitutes a similarly named district", () => {
  const f = harness();
  assert.equal(f.context.tourismForecastMappedRegion(pocheon).signguCd, "41650");
  assert.equal(f.context.tourismForecastMappedRegion(wonju).areaCd, "51");
  assert.equal(f.context.tourismForecastMappedRegion(region("세종특별자치시")).signguCd, "36110");
  assert.equal(f.context.tourismForecastMappedRegion(region("수원시")), null, "Do not substitute a general district for the whole city");
  assert.equal(f.context.tourismForecastMappedRegion(region("경기도")), null);
  assert.equal(f.context.tourismForecastMappedRegion({ ...pocheon, active: false }), null);
  assert.equal(f.context.tourismForecastMappedRegion({ ...pocheon, providerMappings: { kto: { ktoSggCd: "51130" } } }), null);
  assert.equal(f.context.tourismForecastMappedRegion({ name: "포천시", regionKey: "looks-like-pocheon" }), null);
  f.context.syncTourismForecastToAnalysisRegion(region("수원시"));
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "");
  assert.match(f.main.innerHTML, /선택 지역 자료 없음/);
  assert.equal(f.calls.length, 0);
});

test("analysis-region changes and repeated renders preserve each region's destination, query and disclosure without fetching", () => {
  const f = harness();
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const first = payload();
  f.context.rememberTourismForecastData(first, "41:41650");
  f.state.tourismForecastDestinationId = first.destinations[0].id;
  f.state.tourismForecastQuery = "산정";
  f.state.tourismForecastExpanded = true;
  f.context.syncTourismForecastToAnalysisRegion(wonju);
  assert.equal(f.state.tourismForecastDestinationId, "");
  assert.equal(f.state.tourismForecastQuery, "");
  const second = payload("51", "51130", "간현관광지");
  f.context.rememberTourismForecastData(second, "51:51130");
  f.state.tourismForecastDestinationId = second.destinations[0].id;
  f.state.tourismForecastQuery = "간현";
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.equal(f.state.tourismForecastDestinationId, first.destinations[0].id);
  assert.equal(f.state.tourismForecastQuery, "산정");
  assert.equal(f.state.tourismForecastExpanded, true);
  f.context.renderTourismForecastAdminCard();
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.equal(f.state.tourismForecastExpanded, true, "Leaving and returning to the tab does not collapse the selected region");
  f.context.syncTourismForecastToAnalysisRegion(wonju);
  assert.equal(f.state.tourismForecastDestinationId, second.destinations[0].id);
  assert.equal(f.state.tourismForecastQuery, "간현");
  assert.equal(f.calls.length, 0);
});

test("forecast chart lives in the analysis card; settings contain connection controls and an explicit saved-region refresh", () => {
  const f = harness();
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const data = payload();
  f.context.rememberTourismForecastData(data, "41:41650");
  f.state.tourismForecastDestinationId = data.destinations[0].id;
  f.context.renderTourismForecastAdminCard();
  assert.match(f.main.innerHTML, /경기도 포천시/);
  assert.doesNotMatch(f.main.innerHTML, /id="tourismForecastArea"|id="tourismForecastDistrict"/);
  assert.equal((f.main.innerHTML.match(/class="tourism-forecast-point"/g) || []).length, 30);
  assert.match(f.main.innerHTML, /2026-09-20.*예측지수 0/);
  assert.match(f.main.innerHTML, /오늘 포함 29일 남음/);
  assert.doesNotMatch(f.settings.innerHTML, /<svg|관광지 검색|data-tourism-forecast-place/);
  assert.match(f.settings.innerHTML, /연결 설정됨|마지막 저장 갱신/);
  assert.match(f.settings.innerHTML, /id="tourismForecastRefreshRegion"/);
  assert.match(f.settings.innerHTML, /갱신 대상 지역 선택/);
  assert.match(f.settings.innerHTML, /data-tourism-forecast-action="refresh-saved" disabled/);
  f.settings.listeners.change({ target: { id: "tourismForecastRefreshRegion", value: "41:41650" } });
  assert.match(f.settings.innerHTML, /경기도 포천시 자료 새로 확인/);
  f.settings.listeners.click({ target: { closest: () => ({ dataset: { tourismForecastAction: "open-demand" } }) } });
  assert.deepEqual(f.navigations, ["demand"]);
  assert.equal(f.calls.length, 0);
});

test("a late result from the previous region cannot clear the active region's selection or search", async () => {
  let resolve;
  const f = harness(() => new Promise(done => { resolve = done; }));
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const pending = f.context.loadTourismForecastRegion();
  assert.equal(f.state.tourismForecastLoading, true);
  f.context.syncTourismForecastToAnalysisRegion(wonju);
  assert.equal(f.state.tourismForecastLoading, false, "An old region request does not block the new region's controls");
  const active = payload("51", "51130", "간현관광지");
  f.context.rememberTourismForecastData(active, "51:51130");
  f.state.tourismForecastDestinationId = active.destinations[0].id;
  f.state.tourismForecastQuery = "간현";
  f.state.tourismForecastExpanded = true;
  f.context.rememberTourismForecastView();
  resolve(payload());
  await pending;
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "51:51130");
  assert.equal(f.state.tourismForecastDestinationId, active.destinations[0].id);
  assert.equal(f.state.tourismForecastQuery, "간현");
  assert.equal(f.state.tourismForecastExpanded, true);
  assert.equal(f.state.tourismForecastData["41:41650"].region.signguCd, "41650");
  assert.doesNotMatch(f.main.innerHTML, /포천 산정호수/);
});

test("late errors stay with their requested region", async () => {
  let reject;
  const f = harness(() => new Promise((_done, fail) => { reject = fail; }));
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const pending = f.context.loadTourismForecastRegion();
  f.context.syncTourismForecastToAnalysisRegion(wonju);
  reject(new Error("연결 실패"));
  await pending;
  assert.equal(f.state.tourismForecastError, "");
  assert.match(f.state.tourismForecastViews["41:41650"].error, /연결 실패/);
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.match(f.state.tourismForecastError, /연결 실패/);
});

test("explicit refresh of a saved region does not change the current analysis region or issue a second GET", async () => {
  const f = harness(async (_url, options) => {
    const body = JSON.parse(options.body);
    return payload(body.areaCd, body.signguCd, "간현관광지");
  });
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const current = payload();
  f.context.rememberTourismForecastData(current, "41:41650");
  f.state.tourismForecastDestinationId = current.destinations[0].id;
  f.state.tourismForecastQuery = "산정";
  const target = directory.regions.find(item => item.signguCd === "51130");
  await f.context.loadTourismForecastRegion(true, target);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/settings/tourism-forecast/refresh");
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { areaCd: "51", signguCd: "51130" });
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "41:41650");
  assert.equal(f.state.tourismForecastAnalysisRegion.regionKey, pocheon.regionKey);
  assert.equal(f.state.tourismForecastDestinationId, current.destinations[0].id);
  assert.equal(f.state.tourismForecastQuery, "산정");
  assert.match(f.state.tourismForecastConnectionMessage, /강원특별자치도 원주시.*갱신 완료/);
});

test("late arrival of the provider directory maps the remembered analysis region without fetching a forecast", async () => {
  const f = harness(async () => ({ configured: true, regions: directory.regions, cachedRegions: [] }));
  f.state.tourismForecastSettings = null;
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "");
  await f.context.loadTourismForecastStatus();
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "41:41650");
  assert.deepEqual(f.calls.map(call => call.url), ["/api/settings/tourism-forecast"]);
});

test("search/disclosure events persist per region and detached disclosure events cannot overwrite the next region", () => {
  const f = harness();
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  f.main.listeners.input({ target: { id: "tourismForecastQuery", value: "산정" } });
  f.main.listeners.toggle({ target: { matches: () => true, open: true, attached: true } });
  assert.equal(f.state.tourismForecastViews["41:41650"].query, "산정");
  assert.equal(f.state.tourismForecastViews["41:41650"].expanded, true);
  f.context.syncTourismForecastToAnalysisRegion(wonju);
  f.main.listeners.toggle({ target: { matches: () => true, open: true, attached: false } });
  assert.equal(f.state.tourismForecastExpanded, false);
  f.context.syncTourismForecastToAnalysisRegion(null);
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "");
  assert.equal(f.state.tourismForecastDestinationId, "");
  assert.equal(f.calls.length, 0);
});

test("admin cards unhide after rendering and clear their content for other roles", () => {
  const f = harness();
  f.main.hidden = true;
  f.settings.hidden = true;
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.equal(f.main.hidden, false);
  assert.equal(f.settings.hidden, false);
  assert.match(f.main.innerHTML, /관광지 불러오기/);
  f.context.isAdminRole = () => false;
  f.context.renderTourismForecastAdminCard();
  assert.equal(f.main.hidden, true);
  assert.equal(f.settings.hidden, true);
  assert.equal(f.main.innerHTML, "");
  assert.equal(f.settings.innerHTML, "");
});

test("status refresh failure is visible even when a previously configured connection is retained", async () => {
  const f = harness(async () => { throw new Error("상태 조회 실패"); });
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  await f.context.loadTourismForecastStatus();
  assert.equal(f.state.tourismForecastSettings.configured, true);
  assert.match(f.settings.innerHTML, /관광지 전망 상태 확인 실패/);
  assert.match(f.settings.innerHTML, /연결 확인 실패/);
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "41:41650");
  assert.equal(f.calls.length, 1);
  f.state.tourismForecastSettings = null;
  await f.context.loadTourismForecastStatus();
  assert.match(f.main.innerHTML, /연결 상태 다시 확인/);
  assert.equal(f.calls.length, 2);
});

test("unqueried screen, absent stored forecast and unknown connection never imply automatic work", () => {
  const f = harness();
  f.context.syncTourismForecastToAnalysisRegion(region("가평군"));
  assert.equal(f.context.tourismForecastSelectedRegionKey(), "41:41820");
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "저장 자료 없음");
  assert.match(f.main.innerHTML, /관광지 불러오기/);
  assert.match(f.main.innerHTML, /지역 변경만으로 자동 조회하지 않습니다/);
  f.state.tourismForecastSettings.cachedRegions.push({ areaCd: "41", signguCd: "41820", collectedAt: "2026-09-21T01:00:00Z" });
  f.context.renderTourismForecastAdminCard();
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "미조회");
  assert.match(f.main.innerHTML, /서버에 저장 자료가 있지만 이 화면에서는 아직 불러오지 않았습니다/);
  f.state.tourismForecastSettings = null;
  f.context.syncTourismForecastToAnalysisRegion(region("가평군"));
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "연결 미확인");
  assert.equal(f.calls.length, 0);
});

test("loading appears only during an explicit forecast request and failure stays distinct from no data", async () => {
  let reject;
  const f = harness(() => new Promise((_, fail) => { reject = fail; }));
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  assert.notEqual(f.context.adminTourismForecastIntegrationRow().statusLabel, "조회 중");
  const pending = f.context.loadTourismForecastRegion();
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "조회 중");
  assert.equal(f.calls.length, 1);
  reject(new Error("응답 확인 실패"));
  await pending;
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "조회 실패");
  assert.equal(f.state.tourismForecastLoading, false);
  assert.equal(f.calls.length, 1);
  f.state.tourismForecastError = "";
  f.context.rememberTourismForecastData({ ...payload(), status: "no_data", destinations: [] }, "41:41650");
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "제공 자료 없음");
});

test("connection status requests show real progress, do not duplicate, and never fetch a forecast", async () => {
  let resolve;
  const f = harness(() => new Promise(done => { resolve = done; }));
  f.state.tourismForecastSettings = null;
  f.context.syncTourismForecastToAnalysisRegion(pocheon);
  const pending = f.context.loadTourismForecastStatus();
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "연결 확인 중");
  await f.context.loadTourismForecastStatus();
  await f.context.loadTourismForecastRegion();
  assert.equal(f.calls.length, 1);
  resolve({ configured: true, regions: directory.regions, cachedRegions: [] });
  await pending;
  assert.equal(f.state.tourismForecastStatusLoading, false);
  assert.equal(f.context.adminTourismForecastIntegrationRow().statusLabel, "저장 자료 없음");
  assert.deepEqual(f.calls.map(call => call.url), ["/api/settings/tourism-forecast"]);
});
