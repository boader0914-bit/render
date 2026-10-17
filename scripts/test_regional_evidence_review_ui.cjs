"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const ui = require("../web/regional-analysis.js");
const review = require("../web/regional-evidence-review.js");
const scope = key => ({ regionKey: key, month: "2026-09", months: 13 });
function snapshot(key = "new_county") {
  return { scope: scope(key), resultId: key + "-result", generatedAt: "2026-10-17T07:00:00Z", groups: [
    { key: "visitors", label: "지역 방문자", provider: "한국관광공사", category: "tourism", periodType: "M", metrics: [
      { key: "visitors", label: "방문자", unit: "명", periodType: "M", rows: [
        { period: "2026-08", status: "observed", value: 0, storedEvidenceVerification: { status: "pending", reasonCode: "RAW_RESPONSE_NOT_RETAINED" } },
        { period: "2026-07", status: "failed", value: 0, reasonCode: "QUOTA_EXCEEDED" },
        { period: "2026-09", status: "publication_pending", value: null, reasonCode: "PUBLICATION_PENDING" }
      ] }
    ] },
    { key: "kosis", label: "인구·산업 통계", provider: "KOSIS", category: "background", periodType: "Y", metrics: [
      { key: "industry", label: "사업체 수", unit: "개", periodType: "Y", rows: [{ period: "2024", status: "observed", value: 40 }] }
    ] },
    { key: "searchTrend", label: "검색 트렌드", provider: "네이버 데이터랩", category: "search", periodType: "M", metrics: [
      { key: "interest", label: "검색 관심도", unit: "상대지수", periodType: "M", rows: [{ period: "2026-08", status: "observed", value: 10 }] }
    ] }
  ] };
}
const state = data => ({ regionKey: data.scope.regionKey, regionLabel: "새 지역", mode: "manage", snapshot: data, openDetails: new Set(), reviewFilters: { status: "review", source: "", period: "" }, reviewLimit: 20 });
function element() {
  const body = { innerHTML: "" };
  return { innerHTML: "", isConnected: true, listeners: new Map(), body,
    addEventListener(name, fn) { this.listeners.set(name, fn); },
    querySelector(selector) { return selector === "[data-ra-review-body]" ? body : null; }
  };
}

test("management review separates real zero, failed zero and publication waiting, with details initially folded", () => {
  const data = snapshot(), frozen = JSON.stringify(data), html = ui.renderCard(state(data));
  assert.match(html, /원본 근거 검토/); assert.match(html, /이전 저장자료 기준/);
  assert.match(html, /관측값<\/dt><dd>0 명/);
  assert.match(html, /관측값<\/dt><dd>미확인<small>오류/);
  assert.doesNotMatch(html, /data-ra-detail="evidence-review" open/);
  assert.doesNotMatch(html, /data-ra-detail="review-item:[^"]+" open/);
  const rows = ui.evidenceReviewSelection(state(data));
  assert.ok(rows.filtered.every(row => row.needsReview));
  assert.ok(!rows.filtered.some(row => row.observationStatus === "publication_pending" || row.sourceKey === "searchTrend"));
  assert.equal(JSON.stringify(data), frozen);
});

test("source and exact period filters keep annual and monthly data separate without manufacturing months", () => {
  const view = state(snapshot());
  view.reviewFilters = { status: "all", source: "kosis", period: "Y:2024" };
  assert.equal(ui.evidenceReviewSelection(view).filtered.length, 1);
  assert.equal(ui.evidenceReviewSelection(view).filtered[0].period, "2024");
  view.reviewFilters.period = "M:2024";
  assert.equal(ui.evidenceReviewSelection(view).filtered.length, 0);
  view.reviewFilters = { status: "waiting", source: "visitors", period: "M:2026-09" };
  assert.equal(ui.evidenceReviewSelection(view).filtered.length, 1);
  view.reviewFilters = { status: "reference", source: "", period: "" };
  assert.equal(ui.evidenceReviewSelection(view).filtered[0].sourceKey, "searchTrend");
});

test("matching materialized review is reused; a different scope falls back to actual snapshot rows", () => {
  const data = snapshot(), expected = review.build(data); data.evidenceReview = review.pack(expected);
  assert.match(ui.evidenceReviewHtml(state(data)), /저장된 검토 목록/);
  assert.deepEqual(ui.evidenceReviewSelection(state(data)).model, expected);
  const other = structuredClone(data); other.evidenceReview.scope.regionKey = "another_region";
  assert.match(ui.evidenceReviewHtml(state(other)), /이전 저장자료 기준/);
  assert.notStrictEqual(ui.evidenceReviewSelection(state(other)).model, other.evidenceReview);
});

test("damaged materialized tuples fall back to observations without claiming a saved review", () => {
  for (const mutate of [
    items => { items[0] = null; },
    items => { items.find(item => item[3] === 0)[3] = 123; },
    items => { items[0][1] = "2088-09"; }
  ]) {
    const data = snapshot(), expected = review.build(data); data.evidenceReview = review.pack(expected);
    mutate(data.evidenceReview.items);
    const html = ui.evidenceReviewHtml(state(data));
    assert.match(html, /이전 저장자료 기준/); assert.doesNotMatch(html, /저장된 검토 목록/);
    assert.deepEqual(ui.evidenceReviewSelection(state(data)).model, expected);
  }
});

test("filters, more rows and folded details do not send requests; refresh preserves them and the policy draft", async () => {
  const data = snapshot();
  data.groups[0].metrics = Array.from({ length: 26 }, (_, index) => ({ key: "metric" + index, label: "관측 " + index, unit: "명", periodType: "M", rows: [{ period: "2026-08", status: "observed", value: index }] }));
  const calls = [], payload = { scope: data.scope, snapshot: data, job: null, policy: { enabled: false, hour: 9, minute: 0, intervalHours: 24 } };
  const controller = ui.createController({ cache: ui.createCache(), fetchJson: async (url, options) => { calls.push({ url, options }); return structuredClone(payload); } });
  const host = element(); await controller.mount(host, { ...data.scope, month: "2026-09", mode: "manage" });
  assert.equal(calls.length, 1); assert.equal(ui.evidenceReviewSelection(controller.state).visible.length, 20);
  host.listeners.get("change")({ target: { dataset: { raReviewFilter: "source" }, value: "visitors" } });
  host.listeners.get("toggle")({ target: { dataset: { raDetail: "evidence-review" }, open: true } });
  controller.updateDraft("time", "11:30");
  host.listeners.get("click")({ target: { closest: () => ({ dataset: { raAction: "review-more" }, disabled: false }) } });
  assert.equal(calls.length, 1); assert.equal(controller.state.reviewLimit, 40);
  assert.equal(ui.evidenceReviewSelection(controller.state).visible.length, 26);
  await controller.refresh(true);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.options?.method));
  assert.equal(controller.state.reviewFilters.source, "visitors"); assert.equal(controller.state.reviewLimit, 40);
  assert.ok(controller.state.openDetails.has("evidence-review"));
  assert.equal(controller.state.policyDraft.hour, 11); assert.equal(controller.state.policyDraft.minute, 30);
  controller.stop();
});

test("a new region resets the previous filters and cannot show a foreign stored review", async () => {
  const controller = ui.createController({ cache: ui.createCache(), fetchJson: async url => {
    const key = new URL(url, "http://local").searchParams.get("regionKey"), data = snapshot(key);
    return { scope: data.scope, snapshot: data, job: null };
  } });
  const host = element(); await controller.mount(host, { regionKey: "first", month: "2026-09", mode: "manage" });
  controller.state.reviewFilters = { source: "kosis", period: "Y:2024", status: "all" };
  controller.state.reviewLimit = 80; controller.state.openDetails.add("evidence-review");
  await controller.mount(host, { regionKey: "second", month: "2026-09", mode: "manage" });
  assert.deepEqual(controller.state.reviewFilters, { status: "review", source: "", period: "" });
  assert.equal(controller.state.reviewLimit, 20); assert.equal(controller.state.openDetails.size, 0);
  assert.equal(ui.evidenceReviewSelection(controller.state).model.scope.regionKey, "second"); controller.stop();
});

test("review assets load before the management UI and unsafe labels cannot inject markup", () => {
  const index = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
  assert.ok(index.indexOf('/regional-data-contract.js') < index.indexOf('/regional-evidence-review.js'));
  assert.ok(index.indexOf('/regional-evidence-review.js') < index.indexOf('/regional-analysis.js'));
  const data = snapshot(); data.groups[0].label = '<img src=x onerror="alert(1)">';
  data.groups[0].metrics[0].label = '<script>alert(1)</script>';
  const html = ui.evidenceReviewHtml(state(data));
  assert.doesNotMatch(html, /<img|<script|onerror=/); assert.match(html, /원본 근거 검토/);
});

test("an unprepared region keeps unknown periods and frequencies explicit instead of inventing a monthly observation", () => {
  const data = snapshot();
  data.groups = [{ key: "unknown_source", label: "새 자료", metrics: [{ key: "unknown_metric", rows: [] }] }];
  const html = ui.evidenceReviewHtml({ ...state(data), openDetails: new Set(["evidence-review"]) });
  assert.match(html, /기준기간 미확인/); assert.match(html, /주기 미확인/);
  assert.doesNotMatch(html, /기준기간 미확인년|value="unknown:"> · 월간/);
  assert.equal(ui.evidenceReviewSelection(state(data)).filtered[0].value, null);
});

test("suppression keeps the same exact recorded reason in the new review and the existing management detail", () => {
  const data = snapshot();
  data.groups = [{ key: "kosis", label: "인구·산업 통계", provider: "KOSIS", category: "background", periodType: "Y", metrics: [
    { key: "count", label: "사업체 수", unit: "개", periodType: "Y", rows: [{ period: "2024", status: "suppressed", value: null, reasonCode: "SUPPRESSED", reasonEvidence: "recorded" }] }
  ] }];
  const { buildRegionalIndicatorManagement } = require("./lib/regional_indicator_management.cjs");
  const html = ui.renderCard({ ...state(data), management: buildRegionalIndicatorManagement({ snapshot: data, scope: data.scope }) });
  assert.match(html, /비공개/); assert.match(html, /제공기관 비공개 자료/);
  assert.doesNotMatch(html, /확인 코드 SUPPRESSED/);
  assert.equal(ui.evidenceReviewSelection(state(data)).filtered[0].value, null);
});
