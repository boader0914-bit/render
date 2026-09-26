"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const start = app.indexOf("function kosisStatusLabel(");
const end = app.indexOf("function tourismForecastRegionKey(", start);
assert.ok(start > 0 && end > start);
const regions = [
  { regionKey: "kr_gyeonggi_pocheon", name: "포천시", fullName: "경기도 포천시", active: true, selectable: true },
  { regionKey: "kr_gyeonggi_gapyeong", name: "가평군", fullName: "경기도 가평군", active: true, selectable: true }
];

function payload(regionKey = regions[0].regionKey, value = 123) {
  return { configured: true, status: "ready", region: { regionKey, name: "지역" }, networkAttempted: false, datasets: [{ key: "population", label: "주민등록인구", status: "ready", periodType: "M", period: "202608", tableId: "DT_POP", sourceUrl: "https://kosis.kr/statHtml/statHtml.do?tblId=DT_POP", rows: [{ key: "population", label: "인구", period: "202608", value, unit: "명", status: "observed" }] }] };
}

function harness(fetch = async url => url === "/api/settings/kosis" ? { configured: true, cachedRegionCount: 0, datasets: [] } : payload()) {
  const calls = [], renders = [];
  const state = { activeTab: "dictionary", kosisSettings: { configured: true, cachedRegionCount: 0, datasets: [] }, kosisStatusLoading: false, kosisStatusError: "", kosisRegions: {}, kosisRegionRequests: {}, kosisRegionErrors: {}, kosisRefreshRegionKey: "", selected: null, dictionary: { cards: [{ regionKey: regions[0].regionKey, indexes: { population: 65 } }] } };
  const context = vm.createContext({ state, URL, els: { kosisAdminCard: { innerHTML: "" } }, isAdminRole: () => true, regionMasterUnits: () => regions, selectedAnalysisRegion: () => state.selected, escapeHtml: value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"), fmtNumber: String, compactDateTime: String, renderAdminIntegrationRegistry() {}, renderLocationDictionary() { renders.push(state.selected?.regionKey); }, renderRegionSources() {}, fetchJson: async (url, options) => { calls.push({ url, options }); return fetch(url, options); } });
  vm.runInContext(app.slice(start, end), context);
  return { context, state, calls, renders, card: context.els.kosisAdminCard };
}

test("public observed zero is distinct from missing, suppressed and invalid values", () => {
  const f = harness();
  assert.equal(f.context.kosisObservedRow({ status: "observed", value: 0 }), true);
  for (const row of [{ status: "missing", value: null }, { status: "suppressed", value: null }, { status: "error", value: 0 }, { status: "observed", value: "" }, { status: "observed", value: NaN }]) assert.equal(f.context.kosisObservedRow(row), false);
  const dataset = payload().datasets[0];
  dataset.rows = [{ label: "영", value: 0, status: "observed", unit: "명" }, { label: "누락", value: null, status: "missing", unit: "명" }, { label: "비공개", value: null, status: "suppressed", unit: "명" }];
  const rendered = f.context.renderKosisDataset(dataset);
  assert.match(rendered, /<dd>0<small>명/);
  assert.match(rendered, /자료 없음/);
  assert.match(rendered, /비공개 값/);
});

test("different publication frequencies stay explicit and historic rows are folded", () => {
  const f = harness();
  const dataset = payload().datasets[0];
  dataset.rows.push({ label: "인구", period: "202607", value: 98, unit: "명", status: "observed" });
  const rendered = f.context.renderKosisDataset(dataset);
  assert.match(rendered, /기준 2026년 8월/);
  assert.doesNotMatch(rendered.split('<details')[0], />98</);
  assert.match(rendered, /<details.*이전 기간 1개 관측 보기/);
  assert.equal(f.context.kosisPeriodLabel("2024", "Y"), "2024년");
  assert.equal(f.context.kosisOfficialSourceUrl("https://evil.invalid/?key=abc"), "");
});

test("normal region viewing reads cache once and never sends an upstream refresh", async () => {
  const f = harness();
  await f.context.loadKosisRegion(regions[0].regionKey);
  await f.context.loadKosisRegion(regions[0].regionKey);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /^\/api\/kosis\/region\?regionKey=/);
  assert.equal(f.calls[0].options, undefined);
  assert.equal(f.state.dictionary.cards[0].indexes.population, 65, "Official evidence must not rewrite internal reference scores");
});

test("a late response stays keyed to its requested region and does not redraw the new selected region", async () => {
  let resolveOld;
  const f = harness(() => new Promise(resolve => { resolveOld = resolve; }));
  f.state.selected = regions[0];
  // Avoid the independent settings-card view initiating a second request.
  f.state.kosisRefreshRegionKey = regions[0].regionKey;
  const old = f.context.loadKosisRegion(regions[0].regionKey);
  f.state.selected = regions[1];
  resolveOld(payload(regions[0].regionKey));
  await old;
  assert.equal(f.state.kosisRegions[regions[0].regionKey].region.regionKey, regions[0].regionKey);
  assert.equal(f.state.kosisRegions[regions[1].regionKey], undefined);
  assert.deepEqual(f.renders, []);
});

test("a mismatched response cannot replace a valid cached region", async () => {
  const f = harness(() => payload(regions[1].regionKey));
  f.state.kosisRegions[regions[0].regionKey] = payload(regions[0].regionKey, 456);
  await f.context.loadKosisRegion(regions[0].regionKey, { force: true });
  assert.equal(f.state.kosisRegions[regions[0].regionKey].datasets[0].rows[0].value, 456);
  assert.match(f.state.kosisRegionErrors[regions[0].regionKey], /지역이 달라/);
});

test("explicit refresh uses POST and a failed refresh preserves earlier evidence", async () => {
  const f = harness((url) => url === "/api/settings/kosis" ? { configured: true, cachedRegionCount: 1, status: "stale" } : { ...payload(), status: "error", datasets: [] });
  f.state.kosisRegions[regions[0].regionKey] = payload(regions[0].regionKey, 456);
  await f.context.loadKosisRegion(regions[0].regionKey, { refresh: true });
  assert.equal(f.calls[0].url, "/api/settings/kosis/refresh");
  assert.equal(f.calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { regionKey: regions[0].regionKey });
  assert.equal(f.state.kosisRegions[regions[0].regionKey].datasets[0].rows[0].value, 456);
  assert.match(f.state.kosisRegionErrors[regions[0].regionKey], /새 자료/);
  f.state.kosisSettings.configured = false;
  const count = f.calls.length;
  await f.context.loadKosisRegion(regions[1].regionKey, { refresh: true });
  assert.equal(f.calls.length, count);
});

test("configuration alone is not a verified connection and the admin card has no key input", () => {
  const f = harness();
  assert.equal(f.context.adminKosisIntegrationRow().status, "configured");
  f.context.renderKosisAdminCard();
  assert.match(f.card.innerHTML, /KOSIS_API_KEY/);
  assert.match(f.card.innerHTML, /공공데이터포털 공통키와 별도/);
  assert.doesNotMatch(f.card.innerHTML, /<input|<form/);
  f.state.kosisSettings.cachedRegionCount = 1;
  assert.equal(f.context.adminKosisIntegrationRow().status, "connected");
  f.state.kosisSettings.status = "stale";
  assert.equal(f.context.adminKosisIntegrationRow().status, "missing");
  assert.ok(html.includes('id="kosisAdminCard"'));
  assert.ok(app.includes('if (integration.key === "kosis") return adminKosisIntegrationRow(integration);'));
});

test("primary four statistics stay in business order when provider order changes; age totals are not added to bands", () => {
  const f = harness();
  const keys = ["age_population", "manufacturing_employment", "employment", "population", "manufacturing_establishments", "households", "establishments"];
  const datasets = keys.map(key => ({ ...payload().datasets[0], key, label: key }));
  const ages = datasets[0];
  ages.rows = [{ key: "all_ages", label: "전체 연령", value: 100, unit: "명", status: "observed", period: "202608" }, ...Array.from({ length: 21 }, (_, index) => ({ key: `age_${index}`, label: `연령 ${index}`, value: index, unit: "명", status: "observed", period: "202608" }))];
  const groups = f.context.kosisDatasetGroups(datasets);
  assert.equal(groups.primary.map(item => item.key).join(","), "population,households,establishments,employment");
  assert.equal(groups.additional.map(item => item.key).join(","), "age_population,manufacturing_employment,manufacturing_establishments");
  f.state.kosisRegions[regions[0].regionKey] = { ...payload(), datasets };
  const rendered = f.context.renderKosisRegionPanel(regions[0], { load: false });
  const primary = rendered.split('<details class="kosis-detail"><summary>추가 통계')[0];
  assert.doesNotMatch(primary, /data-kosis-dataset="age_population"/);
  assert.match(primary, /data-kosis-dataset="employment"/);
  const ageHtml = f.context.renderKosisDataset(ages);
  assert.match(ageHtml, /전체 연령<\/dt><dd>100<small>명/);
  assert.match(ageHtml, /세부 통계 16개 더 보기/);
  assert.equal(ages.rows[0].value, 100);
});
