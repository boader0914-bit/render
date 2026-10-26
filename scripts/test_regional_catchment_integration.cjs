"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { createReader, createMarketReader, createController: createScopedController } = require("../web/regional-catchment.js");
const { buildRegionalMarketSnapshot } = require("./lib/regional_market.cjs");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["renderRegionalCatchmentHost", "rememberSavedRegionalCatchmentFocus", "stopSavedRegionalCatchment", "syncSavedRegionalCatchment", "renderLocationDictionary"];
const declarations = names.map(name => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0]; assert.ok(declaration, `Missing actual ${name}`); return declaration;
}).join("\n");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const region = key => ({ regionKey: key, name: key, fullName: key, level: "local", active: true, providerMappings: {} });
const result = key => ({ scope: { regionKey: key }, status: "missing", configuration: null, snapshot: null, datasets: [], job: null, storage: {}, sourceCatalog: [] });

function fixture(fetchResult = async key => result(key), { mode = "address_radius" } = {}) {
  const reader = createReader(), marketReader = createMarketReader(), controllers = new Map(), calls = { get: [], addresses: [], mounts: [], stops: [], clears: [] };
  const state = { session: { role: "admin", username: "admin-a" }, activeTab: "dictionary", dictionaryDetailTab: "basic", selectedRegion: region("sancheong"), dictionary: { cards: [], regionGroups: [] } };
  const document = { body: {}, activeElement: null }; document.activeElement = document.body;
  function newHost(regionKey, parent) {
    const slots = { "[data-rc-results]": { innerHTML: "" }, "[data-rc-editor-slot]": { innerHTML: "", querySelectorAll: () => [] }, "[data-rc-message]": { textContent: "" } };
    const panel = () => { const contents = { "[data-rm-results]": { innerHTML: "", querySelectorAll: () => [] } }; return { dataset: {}, innerHTML: "", isConnected: true, addEventListener() {}, querySelector: key => contents[key] || null }; };
    if (mode !== "address_radius") {
      slots['[data-rc-mode-panel="administrative_region"]'] = panel();
      slots['[data-rc-mode-panel="address_radius"]'] = panel();
    }
    const node = { dataset: { regionKey }, isConnected: true, innerHTML: "", listeners: {}, children: new Set(), slots,
      addEventListener(name, listener) { this.listeners[name] = listener; }, querySelector: key => slots[key] || null, querySelectorAll: () => [], contains(field) { return this.children.has(field); },
      replaceWith(other) { this.isConnected = false; parent.current = other; other.isConnected = true; } };
    return node;
  }
  const dictionaryResult = { current: null, markup: "", querySelector() { return this.current; },
    get innerHTML() { return this.markup; }, set innerHTML(value) {
      this.markup = value; const old = this.current;
      if (old) { old.isConnected = false; if (old.contains(document.activeElement)) document.activeElement = document.body; }
      const key = value.match(/data-regional-catchment data-region-key="([^"]+)"/)?.[1]; this.current = key ? newHost(key, this) : null;
    } };
  const els = { dictionaryResult, dictionarySearchInput: { value: "" }, dictionarySearchStatus: {}, dictionaryCount: {} };
  const api = { mount(host, context) {
    calls.mounts.push(host); let controller = controllers.get(host);
    if (!controller) { controller = createScopedController({ mode, reader, marketReader, afterPaint: fn => fn() }); controllers.set(host, controller); }
    return controller.mount(host, context);
  }, stop(host) { calls.stops.push(host); controllers.get(host)?.stop(); }, clear(accountKey) { calls.clears.push(accountKey); for (const controller of controllers.values()) controller.stop(); reader.clear(accountKey); marketReader.clear(accountKey); } };
  let context;
  context = vm.createContext({ state, els, document, window: { RegionalCatchment: api }, queueMicrotask, console, Number,
    savedRegionalCatchmentHost: null, savedRegionalCatchmentHostScope: null, savedRegionalCatchmentLogoutPending: false, savedRegionalCatchmentFocus: null,
    isAdminRole: () => state.session.role === "admin", selectedAnalysisRegion: () => state.selectedRegion, analysisRegionLabel: item => item.name,
    locationProfileActiveTab: () => state.dictionaryDetailTab, escapeHtml: value => String(value ?? "").replaceAll('"', "&quot;"), fmtNumber: String,
    administrativeProvinceEntries: () => [], dictionaryProvinceEntries: () => [], administrativeRegionEntries: () => [],
    renderLocationCardRequestQueue: () => "", renderDictionaryQuickButtons() {}, dictionaryStoredCardForRegion: () => ({ regionKey: state.selectedRegion?.regionKey }),
    administrativeRegionForKey: () => null, administrativeRegionForLocationCard: () => state.selectedRegion,
    administrativeProvinceForRegion: item => item, renderAdministrativeProvinceProfile: () => "<div>광역 기본자료</div>",
    renderAdministrativeRegionProfile: item => context.renderRegionalCatchmentHost(item), renderAdministrativeRegionChoices: () => "<div>동일 지역명 선택</div>",
    renderMissingLocationCandidate: () => "<div>원장 연결 필요</div>", renderLocationGroupDictionary() { dictionaryResult.innerHTML = "<div>그룹 선택</div>"; },
    locationProfileSubjectForRegion: item => ({ regionKey: item.regionKey }), dictionaryProvinceForCard: () => "", locationProfileAlias: () => ({}),
    tourismRegionForLocation: () => ({}), locationClusterCodes: () => [], locationClusterMeta: () => ({}), locationRuntimeStats: () => ({}), adjustedLocationScoreModel: () => ({}),
    regionAnalysisEmptyHtml: () => "<div>지역 미선택</div>",
    renderObservedLocationProfile(...args) { return context.renderRegionalCatchmentHost(args.at(-1).administrativeRegion); },
    fetchJson: async url => {
      const parsed = new URL(url, "https://local");
      if (parsed.pathname.endsWith("/addresses")) { calls.addresses.push(url); return { addresses: [] }; }
      calls.get.push(url); return fetchResult(parsed.searchParams.get("regionKey"));
    }
  });
  vm.runInContext(declarations, context);
  const getController = node => controllers.get(node);
  const makeField = (node, value = "편집 중인 기준점", start = 2, end = 4) => {
    const field = { name: "label", value, selectionStart: start, selectionEnd: end, selectionDirection: "forward",
      focus() { document.activeElement = this; }, setSelectionRange(a, b, direction) { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = direction; } };
    node.children.add(field); document.activeElement = field; node.listeners.input({ target: field }); return field;
  };
  return { state, document, els, calls, context, reader, getController, makeField, async render(match) { context.renderLocationDictionary(match); await tick(); return dictionaryResult.current; } };
}

test("actual dictionary rerenders retain the same live host, input nodes/cursor and completed GET", async () => {
  const f = fixture(); const host = await f.render(); const field = f.makeField(host);
  const editor = host.slots["[data-rc-editor-slot]"].innerHTML;
  assert.equal(f.calls.get.length, 1);
  assert.equal(f.calls.addresses.length, 1);
  f.context.renderLocationDictionary(); f.context.renderLocationDictionary(); await tick();
  assert.equal(f.els.dictionaryResult.current, host); assert.equal(host.isConnected, true);
  assert.equal(f.document.activeElement, field); assert.equal(field.selectionStart, 2); assert.equal(field.selectionEnd, 4);
  assert.equal(f.getController(host).state.draft.label, "편집 중인 기준점"); assert.equal(host.slots["[data-rc-editor-slot]"].innerHTML, editor);
  assert.equal(f.calls.get.length, 1, "same-scope redraws must not revalidate or create another controller");
  assert.equal(f.calls.addresses.length, 1, "same-scope redraws must not repeat the read-only address query");
});

test("startup rerenders during the first GET retain the edited point until the response arrives", async () => {
  const pending = deferred(), f = fixture(() => pending.promise); const host = await f.render(); const field = f.makeField(host, "조회 중 작성한 기준점", 1, 1);
  await f.render(); assert.equal(f.els.dictionaryResult.current, host); assert.equal(f.calls.get.length, 1);
  pending.resolve(result("sancheong")); await tick();
  assert.equal(f.getController(host).state.draft.label, "조회 중 작성한 기준점"); assert.equal(f.document.activeElement, field); assert.equal(field.selectionStart, 1);
});

test("another canonical region stops the old controller and never restores its focus or late response", async () => {
  const pending = deferred(), f = fixture(key => key === "sancheong" ? pending.promise : Promise.resolve(result(key)));
  const old = await f.render(), field = f.makeField(old); f.state.selectedRegion = region("sacheon");
  const next = await f.render(); assert.notEqual(next, old); assert.ok(f.calls.stops.includes(old));
  assert.notEqual(f.document.activeElement, field); assert.equal(next.dataset.rcRegion, "sacheon");
  pending.resolve(result("sancheong")); await tick(); assert.equal(f.els.dictionaryResult.current, next); assert.equal(next.dataset.rcRegion, "sacheon"); assert.equal(f.calls.get.length, 2);
});

test("account changes clear only the previous account cache and start with a fresh form", async () => {
  const f = fixture(); const old = await f.render(); f.makeField(old, "이전 관리자의 미저장 지점");
  f.state.session.username = "admin-b"; const next = await f.render();
  assert.notEqual(next, old); assert.deepEqual(f.calls.clears, ["admin-a"]); assert.equal(f.reader.read({ accountKey: "admin-a", regionKey: "sancheong" }), null);
  assert.equal(f.getController(next).state.draft.label, ""); assert.equal(f.calls.get.length, 2);
});

test("all early-return and inactive-panel routes stop the detached host without an extra GET", async () => {
  const cases = [
    f => { f.state.dictionary = null; }, f => { f.state.selectedRegion = null; },
    f => ({ group: { sido: "경남" } }), f => ({ ambiguousRegions: [region("a"), region("b")] }),
    f => { f.context.dictionaryStoredCardForRegion = () => null; f.state.selectedRegion = { ...region("gyeongnam"), level: "broad" }; },
    f => { f.state.dictionaryDetailTab = "tourism"; }, f => { f.state.activeTab = "map"; }, f => { f.state.session.role = "b2b"; }
  ];
  for (const change of cases) {
    const f = fixture(), old = await f.render(); const match = change(f); await f.render(match);
    assert.ok(f.calls.stops.includes(old)); assert.equal(f.calls.get.length, 1);
  }
});

test("a queued render cannot remount after logout has started", async () => {
  const f = fixture(), old = await f.render(); f.context.renderLocationDictionary();
  f.context.stopSavedRegionalCatchment({ logout: true }); await tick();
  assert.ok(f.calls.stops.includes(old)); assert.equal(f.calls.get.length, 1); assert.equal(f.context.savedRegionalCatchmentHost, null);
});

test("actual dictionary defaults to administrative saved metrics without requesting an address or radius", async () => {
  const f = fixture(async key => buildRegionalMarketSnapshot({ region: { ...region(key), officialCode: key === "jinju" ? "48170" : "48860", unitType: "county" },
    scope: { regionKey: key, month: "2026-09", months: 13 }, now: () => new Date("2026-10-22T10:00:00Z") }), { mode: "administrative_region" });
  const node = await f.render();
  assert.equal(f.getController(node).mode, "administrative_region"); assert.equal(node.dataset.rcRegion, "sancheong");
  assert.deepEqual(f.calls.get, ["/api/regional-market?regionKey=sancheong"]); assert.equal(f.calls.addresses.length, 0);
  const panel = node.slots['[data-rc-mode-panel="administrative_region"]'];
  assert.match(panel.innerHTML, /행정구역 기본 분석/); assert.doesNotMatch(panel.innerHTML, /중심점|name="address"/);
  assert.match(panel.querySelector("[data-rm-results]").innerHTML, /확보범위 0\/6개 지표/);
  assert.match(panel.querySelector("[data-rm-results]").innerHTML, /방문객 출발지·외부 유입 · 자료 미확보/);
  await f.render(); assert.equal(f.els.dictionaryResult.current, node); assert.equal(f.calls.get.length, 1);
  f.state.selectedRegion = region("jinju"); const next = await f.render();
  assert.notEqual(next, node); assert.equal(f.getController(next).state.result.scope.regionKey, "jinju");
  assert.deepEqual(f.calls.get, ["/api/regional-market?regionKey=sancheong", "/api/regional-market?regionKey=jinju"]); assert.equal(f.calls.addresses.length, 0);
});
