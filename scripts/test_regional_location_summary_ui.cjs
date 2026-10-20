"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const RegionalLocationSummary = require("../web/regional-location-summary.js");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const functions = ["escapeHtml", "fmtNumber", "finiteNumber", "locationProfileCoverageModel", "renderLocationProfileCoverage",
  "locationProfileSavedRegionalModel", "locationSavedRegionalPeriodLabel", "locationSavedRegionalEndpointLabel", "locationSavedRegionalSummaryAttributes",
  "renderLocationSavedRegionalSummaryCards", "syncLocationSavedRegionalSummary", "markLocationSavedRegionalSummaryDisplay", "renderLocationProfileSummaryCard", "syncSavedRegionalAnalysis"];
function declaration(name) {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(found, `the regression must execute the actual ${name} implementation`);
  return found;
}
const scope = { regionKey: "summary-region-a", month: "2026-09", months: 13 };
const accountKey = "summary-admin";
const spatial = extra => ({ version: "regional-data-contract-v1", requestedRegionKey: scope.regionKey, officialCode: "12345", requestedLevel: "sigungu", requestedUnitType: "county",
  provider: "한국관광공사", providerRegionCode: "12345", providedLevel: "sigungu", scopeKind: "administrative", status: "matched", evidence: "response", aggregation: "none", ...extra });
const monthly = (key, { end = "2026-08", value = 10, status = "observed", pending = false } = {}) => ({ key, unit: "지수", periodType: "M",
  rows: Array.from({ length: 13 }, (_, index) => ({ period: new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5)) - 13 + index, 1)).toISOString().slice(0, 7), status, value: status === "observed" ? value : null,
    spatialContract: spatial(pending ? { status: "scope_unverified", evidence: "unverified" } : {}),
    storedEvidenceVerification: pending ? { status: "pending", reasonCode: "TOURISM_ORIGINAL_RESPONSE_NOT_STORED" } : undefined })) });
function payload({ resultId = "summary-result-one", missing = false, zero = false, mixed = false, pending = false } = {}) {
  return { scope: { ...scope }, status: missing ? "missing" : "ready", snapshot: { scope: { ...scope }, status: missing ? "missing" : "ready", resultId,
    generatedAt: "2026-10-19T00:00:00Z", groups: [{ key: "demandStrength", provider: "한국관광공사", periodType: "M", metrics: [
      monthly("stayOverall", { value: zero ? 0 : 10, status: missing ? "missing" : "observed", pending }),
      monthly("spendOverall", { end: mixed ? "2026-07" : "2026-08", value: 20, status: missing ? "missing" : "observed", pending })
    ] }] }, job: null };
}
const view = (result, extra = {}) => ({ regionKey: scope.regionKey, month: scope.month, accountKey, result, loading: false, error: "", displaySequence: 3, ...extra });
function grid(regionKey = scope.regionKey) {
  let html = "untouched grid", writes = 0;
  const element = { dataset: { locationSavedSummary: regionKey, locationSavedResultId: "", locationSavedMonth: scope.month },
    get innerHTML() { return html; }, set innerHTML(value) { html = value; writes++; }, get writes() { return writes; },
    removeAttribute(name) { const key = name.replace(/^data-/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()); delete this.dataset[key]; } };
  return element;
}
function fixture({ cached } = {}) {
  const summaryGrid = grid(), otherGrid = grid("summary-region-b");
  const period = { dataset: { locationSavedPeriod: scope.regionKey }, textContent: "untouched period" };
  const endpoint = { dataset: { locationSavedEndpoint: scope.regionKey }, textContent: "untouched endpoint" };
  const otherLabel = { dataset: { locationSavedPeriod: "summary-region-b" }, textContent: "other period" };
  const dropdown = { value: scope.regionKey, innerHTML: "retained region options" }, search = { value: "입력 중인 검색어", selectionStart: 3, selectionEnd: 3 };
  const calls = { cacheReads: [], mounts: [], forbidden: [] };
  const state = { session: { username: accountKey, role: "admin" }, activeTab: "dictionary", analysisRegionSelection: { regionKey: scope.regionKey, explicit: true },
    locationSavedRegionalView: null, locationSavedRegionalDisplay: null, locationProfiles: { retained: { status: "ready" } }, data: { retainedRun: true } };
  const dictionaryResult = { get innerHTML() { return "full dictionary DOM"; }, set innerHTML(_value) { throw Error("callback must not replace the dictionary DOM"); },
    querySelectorAll(selector) {
      if (selector === "[data-location-saved-summary]") return [summaryGrid, otherGrid];
      if (selector === "[data-location-saved-period], [data-location-saved-endpoint]") return [period, endpoint, otherLabel];
      throw Error(`unexpected DOM selector: ${selector}`);
    } };
  const forbidden = name => () => { calls.forbidden.push(name); throw Error(`${name} is forbidden during a summary callback`); };
  const summaryHost = { dataset: {}, innerHTML: "flow host" };
  const context = { state, els: { dictionaryResult, analysisRegionSelect: dropdown, dictionarySearchInput: search },
    isAdminRole: () => state.session.role === "admin",
    selectedAnalysisRegion: () => ({ regionKey: state.analysisRegionSelection.regionKey, level: "local", name: "선택 지역" }),
    analysisRegionLabel: region => region.name,
    fetchJson: forbidden("fetchJson"), ensureLocationProfile: forbidden("ensureLocationProfile"), renderLocationDictionary: forbidden("renderLocationDictionary"), renderAll: forbidden("renderAll"), loadRun: forbidden("loadRun"),
    document: { getElementById(id) { assert.equal(id, "regionalAnalysisSummary"); return summaryHost; } },
    window: { RegionalLocationSummary, RegionalAnalysis: { latestCompletedMonth: () => scope.month,
      savedResults: { read(input) { calls.cacheReads.push(input); return cached; } }, mount(host, options) { calls.mounts.push({ host, options }); }, stop: forbidden("stop") } } };
  vm.createContext(context);
  const api = vm.runInContext(`${functions.map(declaration).join("\n")}\n({${functions.join(",")}})`, context);
  return { api, state, calls, summaryGrid, otherGrid, period, endpoint, otherLabel, dropdown, search, summaryHost };
}
const modelFor = (f, result, extra = {}) => f.api.locationProfileSavedRegionalModel(scope.regionKey, view(result, extra));
const measurement = extra => ({ regionKey: scope.regionKey, month: scope.month, accountKey, resultId: "summary-result-one", status: "ready", milliseconds: 87, source: "server", sequence: 3, ...extra });

test("unqueried/loading summaries have no invented zero coverage; loaded missing observations are explicitly 0/13", () => {
  const f = fixture();
  const initial = f.api.renderLocationSavedRegionalSummaryCards(modelFor(f, undefined));
  assert.match(initial, /미조회/); assert.match(initial, /확보월수 확인 전/); assert.doesNotMatch(initial, /0\/13|관측 없음|수치 확보<\/span>/);
  const loading = f.api.renderLocationSavedRegionalSummaryCards(modelFor(f, undefined, { loading: true }));
  assert.match(loading, /확인 중/); assert.doesNotMatch(loading, /0\/13/);
  const missing = f.api.renderLocationSavedRegionalSummaryCards(modelFor(f, payload({ missing: true })));
  assert.match(missing, /자료 미확보/); assert.match(missing, /0\/13/); assert.match(missing, /data-location-metric-value=""/);
  assert.equal(f.api.locationSavedRegionalEndpointLabel(modelFor(f, undefined)), "공통 저장 결과 확인 전");
  assert.equal(f.api.locationSavedRegionalPeriodLabel(modelFor(f, payload({ missing: true }))), "정상 관측 기준월 미확보");
});

test("real zero uses canonical numeric and display values, not the missing fallback", () => {
  const f = fixture(), html = f.api.renderLocationSavedRegionalSummaryCards(modelFor(f, payload({ zero: true })));
  assert.match(html, /data-location-metric-key="stayOverall" data-location-metric-period="2026-08" data-location-metric-value="0"/);
  assert.match(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " "), /0 지수/); assert.match(html, /13\/13/);
});

test("the real mount context wires saved callbacks and accepted state changes update only the matching grid and labels", () => {
  const f = fixture(), before = { dropdown: { ...f.dropdown }, search: { ...f.search }, profiles: f.state.locationProfiles, data: f.state.data, selection: f.state.analysisRegionSelection };
  f.api.syncSavedRegionalAnalysis();
  assert.equal(f.calls.mounts.length, 1); const mount = f.calls.mounts[0];
  assert.equal(mount.host, f.summaryHost); assert.equal(mount.options.onStateChange, f.api.syncLocationSavedRegionalSummary); assert.equal(mount.options.onDisplay, f.api.markLocationSavedRegionalSummaryDisplay);
  const accepted = view(payload()); mount.options.onStateChange(accepted);
  assert.equal(f.state.locationSavedRegionalView, accepted); assert.equal(f.summaryGrid.writes, 1); assert.equal(f.summaryGrid.dataset.locationSavedResultId, "summary-result-one");
  assert.equal(f.otherGrid.writes, 0); assert.equal(f.otherLabel.textContent, "other period");
  assert.match(f.period.textContent, /2026-08/); assert.match(f.endpoint.textContent, /공통 저장 결과/);
  assert.deepEqual(f.dropdown, before.dropdown); assert.deepEqual(f.search, before.search); assert.equal(f.state.locationProfiles, before.profiles); assert.equal(f.state.data, before.data); assert.equal(f.state.analysisRegionSelection, before.selection);
  assert.deepEqual(f.calls.forbidden, []); assert.deepEqual(f.calls.cacheReads, []);
});

test("late callbacks for a different region, account, role or screen do not change the selected summary", () => {
  const f = fixture();
  for (const invalid of [view(payload(), { regionKey: "summary-region-b" }), view(payload(), { accountKey: "other-admin" })]) {
    f.api.syncLocationSavedRegionalSummary(invalid); f.api.markLocationSavedRegionalSummaryDisplay(measurement(invalid));
    assert.equal(f.summaryGrid.writes, 0); assert.equal(f.state.locationSavedRegionalView, null); assert.equal(f.state.locationSavedRegionalDisplay, null);
  }
  f.state.activeTab = "regionCompare"; f.api.syncLocationSavedRegionalSummary(view(payload()));
  f.state.activeTab = "dictionary"; f.state.session.role = "b2b"; f.api.syncLocationSavedRegionalSummary(view(payload()));
  assert.equal(f.summaryGrid.writes, 0); assert.deepEqual(f.calls.forbidden, []);
});

test("stored display measurements are not attributed to another month, result or account", () => {
  const f = fixture(), model = modelFor(f, payload());
  f.api.syncLocationSavedRegionalSummary(view(payload()));
  const pending = () => assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, undefined);
  for (const change of [{ month: "2026-08" }, { resultId: "another-result" }, { accountKey: "another-admin" }]) {
    f.api.markLocationSavedRegionalSummaryDisplay(measurement(change)); pending();
    const attributes = f.api.locationSavedRegionalSummaryAttributes(model);
    assert.match(attributes, /data-location-saved-display-status="pending"/); assert.doesNotMatch(attributes, /data-location-saved-display-ms=/);
  }
  f.api.markLocationSavedRegionalSummaryDisplay(measurement());
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, "87"); assert.equal(f.summaryGrid.dataset.locationSavedDisplaySequence, "3");
  assert.match(f.api.locationSavedRegionalSummaryAttributes(model), /data-location-saved-display-ms="87"/);
});

test("a newly accepted result clears timing from the prior result while waiting for its own paint", () => {
  const f = fixture(); f.api.syncLocationSavedRegionalSummary(view(payload())); f.api.markLocationSavedRegionalSummaryDisplay(measurement());
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, "87");
  f.api.syncLocationSavedRegionalSummary(view(payload({ resultId: "summary-result-two" })));
  assert.equal(f.summaryGrid.dataset.locationSavedResultId, "summary-result-two"); assert.equal(f.summaryGrid.dataset.locationSavedDisplayStatus, "pending");
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, undefined, "the old duration must not remain attached to the new result");
  assert.equal(f.summaryGrid.dataset.locationSavedDisplaySource, undefined); assert.equal(f.summaryGrid.dataset.locationSavedDisplaySequence, undefined);
});

test("same-result shell reentry invalidates the prior receipt before dictionary markup reconstruction", () => {
  const result = payload(), f = fixture({ cached: result });
  f.api.syncSavedRegionalAnalysis();
  const callbacks = f.calls.mounts[0].options;
  callbacks.onStateChange(view(result, { displaySequence: 1 }));
  callbacks.onDisplay(measurement({ sequence: 1, milliseconds: 87 }));
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, "87");
  assert.match(f.api.locationSavedRegionalSummaryAttributes(f.api.locationProfileSavedRegionalModel(scope.regionKey)), /data-location-saved-display-sequence="1"/);

  // The common shell mounts before renderLocationDictionary reconstructs its
  // summary attributes. Its new entry may reuse the identical saved result.
  callbacks.onStateChange(view(result, { displaySequence: 2 }));
  assert.equal(f.state.locationSavedRegionalView.displaySequence, 2); assert.equal(f.state.locationSavedRegionalDisplay, null);
  assert.equal(f.summaryGrid.dataset.locationSavedResultId, "summary-result-one");
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayStatus, "pending");
  for (const key of ["locationSavedDisplayMs", "locationSavedDisplaySource", "locationSavedDisplaySequence"]) assert.equal(f.summaryGrid.dataset[key], undefined);
  const attributesForReconstruction = () => f.api.locationSavedRegionalSummaryAttributes(f.api.locationProfileSavedRegionalModel(scope.regionKey));
  assert.match(attributesForReconstruction(), /data-location-saved-display-status="pending"/);
  assert.doesNotMatch(attributesForReconstruction(), /data-location-saved-display-ms=/);

  callbacks.onDisplay(measurement({ sequence: 1, milliseconds: 87 }));
  assert.equal(f.state.locationSavedRegionalDisplay, null); assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, undefined);
  assert.doesNotMatch(attributesForReconstruction(), /data-location-saved-display-ms=/);

  callbacks.onDisplay(measurement({ sequence: 2, milliseconds: 129, source: "cache" }));
  assert.equal(f.summaryGrid.dataset.locationSavedDisplayStatus, "ready"); assert.equal(f.summaryGrid.dataset.locationSavedDisplayMs, "129");
  assert.equal(f.summaryGrid.dataset.locationSavedDisplaySequence, "2");
  assert.match(attributesForReconstruction(), /data-location-saved-display-ms="129"/); assert.match(attributesForReconstruction(), /data-location-saved-display-source="cache"/);
  assert.deepEqual(f.calls.forbidden, []);
});

test("per-metric official months and pending latest proof stay visible without a full-window verification claim", () => {
  const f = fixture(), model = modelFor(f, payload({ mixed: true, pending: true })), html = f.api.renderLocationSavedRegionalSummaryCards(model);
  assert.match(html, /data-location-metric-key="stayOverall" data-location-metric-period="2026-08" data-location-metric-value="10"/);
  assert.match(html, /data-location-metric-key="spendOverall" data-location-metric-period="2026-07" data-location-metric-value="20"/);
  assert.match(html, /최신월 범위·원본 근거 확인 필요/); assert.match(html, /수치 확보/); assert.match(html, /원본 근거 확보율과 별도/); assert.doesNotMatch(html, /원본검증완료|공통 완전월/);
  assert.equal(f.api.locationSavedRegionalPeriodLabel(model), "최근 정상월 2026-07 · 2026-08 · 지표별 기준");
});
