"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ui = require("../web/monthly-reports.js");
const appSource = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const metric = { supply: 10, sold: 3, publicBookings: 2, phoneBookings: 1, estimatedRevenue: 300000, publicRevenue: 200000, phoneRevenue: 100000, reservationRate: .3, coverageRate: .5, partial: true, revenuePartial: true, knownPartialRevenue: 25000 };
const snapshot = { request: { type: "company", month: "2026-08", targetId: "c1", cutoffDate: "2026-08-31" }, target: { id: "c1", label: "테스트 숙소", type: "company" }, period: { start: "2026-08-01", end: "2026-08-31", cutoffDate: "2026-08-31" }, summary: { lodging: metric, dayuse: { ...metric, estimatedRevenue: 40000 } }, daily: [{ date: "2026-08-01", lodging: metric, dayuse: metric }], companies: [], quality: { coverageRate: .5, coveredCompanyDays: 1, expectedCompanyDays: 2, missingCompanyDays: 1, discardedObservationCount: 1, warnings: ["일부 날짜 자료가 없습니다."] }, sources: { runs: [{ id: "run-1", keyword: "가평펜션", collectedAt: "2026-08-31T01:00:00Z", selectedObservationCount: 1, observationCount: 2 }] }, definitions: { estimatedRevenue: "객실별 수량과 관측 가격의 곱" }, previewToken: "preview-fixed-token" };
function fixture() {
  const container = { innerHTML: "", addEventListener() {}, querySelector() { return null; } };
  const calls = [];
  let saved;
  let nextFailure = null;
  const api = async (url, method = "GET", body) => {
    calls.push({ url, method, body: structuredClone(body) });
    if (nextFailure) { const error = nextFailure; nextFailure = null; throw error; }
    if (url === "/options") return { companies: [{ id: "c1", label: "테스트 숙소" }], keywords: [], regions: [], months: ["2026-08"], defaultMonth: "2026-08" };
    if (url === "/preview") return structuredClone(snapshot);
    if (url === "" && method === "GET") return { reports: saved ? [structuredClone(saved)] : [] };
    if (url === "" && method === "POST") { saved = { id: "mr_1", revision: 1, version: 1, status: "draft", ...body, snapshot: structuredClone(snapshot) }; return structuredClone(saved); }
    if (method === "PATCH") { assert.equal(body.revision, saved.revision); saved = { ...saved, ...body, revision: saved.revision + 1 }; return structuredClone(saved); }
    if (url.endsWith("/publish")) { assert.equal(body.acknowledgeQuality, true); assert.equal(body.revision, saved.revision); assert.equal(saved.status, "review"); saved = { ...saved, status: "published", revision: saved.revision + 1 }; return structuredClone(saved); }
    if (url.endsWith("/revise")) { saved = { ...saved, id: "mr_2", status: "draft", version: 2, revision: 1, supersedesId: "mr_1" }; return structuredClone(saved); }
    if (url.endsWith("/rebuild")) { assert.equal(body.revision, saved.revision); saved = { ...saved, status: "draft", revision: saved.revision + 1, snapshot: { ...structuredClone(snapshot), quality: { ...snapshot.quality, coveredCompanyDays: 2, coverageRate: 1 } } }; return structuredClone(saved); }
    if (url === "/mr_1" || url === "/mr_2") return structuredClone(saved);
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  const controller = ui.createController(container, api);
  return { controller, container, calls, fail(error) { nextFailure = error; } };
}
test("monthly reports have independent admin-only desktop and mobile navigation", () => {
  const constants = ["ROLE_TABS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "TAB_LABELS"];
  const names = ["roleTabs", "roleAllowsTab", "adminPrimarySectionForTab", "adminMobileSectionForTab", "adminPanelMobileTarget"];
  const extracted = constants.map((name) => appSource.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0]).concat(names.map((name) => appSource.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0]));
  assert.ok(extracted.every(Boolean));
  const state = { role: "admin", adminPanelSection: "overview" };
  const context = vm.createContext({ state, isAdminRole: () => state.role === "admin", currentRole: () => state.role });
  const nav = vm.runInContext(`${extracted.join("\n")}\n({roleAllowsTab,adminPrimarySectionForTab,adminMobileSectionForTab,ADMIN_MOBILE_SECTIONS,ADMIN_COMPACT_SECTIONS})`, context);
  assert.equal(nav.roleAllowsTab("monthlyReports"), true);
  assert.equal(nav.adminPrimarySectionForTab("monthlyReports"), "reports");
  assert.equal(nav.adminPrimarySectionForTab("report"), "analysis");
  assert.equal(nav.adminMobileSectionForTab("monthlyReports"), "more");
  assert.equal(nav.ADMIN_MOBILE_SECTIONS.reports.target, "monthlyReports");
  assert.ok(nav.ADMIN_COMPACT_SECTIONS.more.items.some((item) => item.tab === "monthlyReports"));
  state.role = "b2b";
  assert.equal(nav.roleAllowsTab("monthlyReports"), false);
  assert.match(html, /data-admin-primary="region"[^]*?data-admin-primary="reports"[^]*?data-admin-primary="members"/);
  assert.ok(html.indexOf('/monthly-reports.js') < html.indexOf('/app.js'));
});
test("cutoff defaults use the month end, capped at the current Korea day", () => {
  assert.equal(ui.defaultCutoff("2026-08", "2026-09-26"), "2026-08-31");
  assert.equal(ui.defaultCutoff("2026-09", "2026-09-26"), "2026-09-26");
  assert.equal(ui.defaultCutoff("2024-02", "2026-09-26"), "2024-02-29");
});
test("preview token freezes saved numbers and form edits invalidate the preview", async () => {
  const { controller: c, calls } = fixture();
  await c.open({ type: "company", targetId: "c1" });
  await c.action("preview");
  assert.equal(c.state.previewToken, snapshot.previewToken);
  c.input("month", "2026-07");
  assert.equal(c.state.preview, null);
  await c.action("save");
  assert.match(c.state.error, /미리보기/);
  assert.equal(calls.filter((call) => call.url === "" && call.method === "POST").length, 0);
  c.input("month", "2026-08");
  await c.action("preview");
  await c.action("save");
  const save = calls.find((call) => call.url === "" && call.method === "POST");
  assert.equal(save.body.previewToken, "preview-fixed-token");
  assert.equal(save.body.cutoffDate, "2026-08-31");
  assert.equal(Object.hasOwn(save.body, "snapshot"), false);
  assert.equal(c.state.report.status, "draft");
});
test("draft to review to explicit publish and new revision preserve lifecycle and snapshots", async () => {
  const { controller: c, container, calls } = fixture();
  await c.open({ type: "company", targetId: "c1" });
  await c.action("preview"); await c.action("save");
  const fixedSnapshot = structuredClone(c.state.report.snapshot);
  c.input("qualityAck", true); await c.action("publish");
  assert.equal(calls.some((call) => call.url.endsWith("/publish")), false);
  await c.action("review");
  assert.equal(c.state.report.status, "review");
  assert.equal(c.state.acknowledged, false);
  await c.action("publish"); assert.equal(c.state.report.status, "review");
  c.input("title", "검토한 리포트"); c.input("notes", "메모 <script>unsafe</script>");
  c.input("qualityAck", true); await c.action("publish");
  assert.match(c.state.error, /먼저 저장/);
  await c.action("update"); assert.equal(c.state.acknowledged, false);
  assert.deepEqual(c.state.report.snapshot, fixedSnapshot);
  c.input("qualityAck", true); await c.action("publish");
  assert.equal(c.state.report.status, "published");
  assert.match(container.innerHTML, /href="\/api\/monthly-reports\/mr_1\/pdf"/);
  assert.doesNotMatch(container.innerHTML, /name="qualityAck"|name="notes"/);
  assert.match(container.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  await c.action("update"); assert.match(c.state.error, /새 수정본/);
  await c.action("revise");
  assert.equal(c.state.report.status, "draft"); assert.equal(c.state.report.version, 2);
  assert.deepEqual(c.state.report.snapshot, fixedSnapshot);
  await c.action("review"); c.input("qualityAck", true);
  await c.action("rebuild");
  assert.equal(c.state.report.status, "draft");
  assert.equal(c.state.acknowledged, false);
  assert.equal(c.state.report.snapshot.quality.coverageRate, 1);
  assert.equal(fixedSnapshot.quality.coverageRate, .5);
});
test("errors keep editable work and are announced; status filtering does not mutate reports", async () => {
  const f = fixture(); const c = f.controller;
  await c.open({ type: "company", targetId: "c1" }); await c.action("preview"); await c.action("save");
  c.input("notes", "아직 저장하지 못한 검토 메모");
  f.fail(new Error("동시 수정 충돌 <unsafe>")); await c.action("update");
  assert.equal(c.state.notes, "아직 저장하지 못한 검토 메모");
  assert.match(f.container.innerHTML, /role="alert"[^>]*>동시 수정 충돌 &lt;unsafe&gt;/);
  const callCount = f.calls.length;
  await c.action("filter", "published");
  assert.equal(f.calls.length, callCount);
  assert.match(f.container.innerHTML, /저장된 리포트가 없습니다/);
  assert.equal(c.state.report.status, "draft");
});
test("snapshot and metadata escape data, distinguish unknown from zero and show independent subtotals", () => {
  const dangerous = '<img src=x onerror="alert(1)">';
  const markup = ui.renderSnapshot({ ...structuredClone(snapshot), target: { label: dangerous }, quality: { ...snapshot.quality, warnings: [dangerous], globalWarnings: [`전체 DB 참고 경고 ${dangerous}`] }, companies: [{ companyId: dangerous, primaryName: dangerous, daily: [] }], context: { sources: [{ label: dangerous, sourceUrl: "javascript:alert(1)", rows: [{ label: dangerous, value: 0, unit: "명" }] }], warnings: [dangerous] }, definitions: { estimatedRevenue: dangerous } });
  assert.doesNotMatch(markup, /<img|href="javascript:/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /출처와 산식[^]*aria-label="전체 DB 참고"[^]*본 리포트의 품질 판단과 별도[^]*전체 DB 참고 경고 &lt;img/);
  assert.ok(markup.indexOf("전체 DB 참고 경고") > markup.indexOf("출처와 산식"));
  assert.match(markup, /mr-public/); assert.match(markup, /mr-phone/);
  assert.match(markup, /25,000원/); assert.match(markup, /합산하지 않은 별도 소계/);
  assert.match(markup, /300,000원/); assert.match(markup, /40,000원/);
  assert.match(ui.renderSnapshot({ summary: { lodging: { estimatedRevenue: null }, dayuse: { estimatedRevenue: 0 } } }), /확인 불가/);
  assert.match(ui.renderSnapshot({ summary: { dayuse: { estimatedRevenue: 0 } } }), /0원/);
  assert.match(ui.renderSnapshot({ period: { monthClosed: false } }), /중간 집계/);
  const list = ui.renderList([{ id: dangerous, title: dangerous, status: "draft", month: "2026-08", targetId: dangerous }], "all");
  assert.doesNotMatch(list, /<img/);
  assert.equal(ui.canPublish({ status: "review" }, true), true);
  assert.equal(ui.canPublish({ status: "draft" }, true), false);
  assert.equal(ui.canPublish({ status: "published" }, true), false);
  assert.equal(ui.canPublish({ status: "review" }, false), false);
});
test("quantities, capacity and freshness distinguish monthly observation totals from rooms and final sales", () => {
  const markup = ui.renderSnapshot({ ...structuredClone(snapshot),
    companies: [{ companyId: "c1", primaryName: "테스트 숙소", capacity: 10, capacitySource: "DB 검토값", daily: snapshot.daily }],
    quality: { ...snapshot.quality, coverageRate: 1, discardedObservationCount: 40, discardedByReason: { superseded_observation: 32, duplicate_observation: 2, post_stay_observation: 3, missing_quantity: 3 }, sameDayObservedCompanyDays: 0, staleDays: 31, minObservationLeadTimeDays: 1, maxObservationLeadTimeDays: 31, medianObservationLeadTimeDays: 16 },
    context: { sources: [{ label: "연간 공공 자료", period: "2025", referenceOnly: true, rows: [] }] }
  });
  assert.match(markup, /공개 예약<\/span><strong>2실·박/);
  assert.match(markup, /방막기 추정<\/span><strong>1실·박/);
  assert.match(markup, /공개 예약<\/span><strong>2회/);
  assert.match(markup, /예약 추정 \/ 공급 합계 \(실·박\)/);
  assert.match(markup, /일자별 객실 수를 합한 값/);
  assert.match(markup, /공급 \(실\)/);
  assert.match(markup, /객실 규모 10실/);
  assert.match(markup, /관측 예약 추정률/);
  assert.match(markup, /중복·이전 관측 34건/);
  assert.match(markup, /시점 기준 제외 3건/);
  assert.match(markup, /근거·품질 등 기준 미충족 3건/);
  assert.match(markup, /숙박 당일 관측 0 · 사전 관측 31 업체·숙박일/);
  assert.match(markup, /최종 예약 상태나 실제 매출을 뜻하지 않습니다/);
  assert.match(markup, /출처별 기준기간/);
  assert.doesNotMatch(markup, /저장된 동월 기준|공개 판매 상태에서 계산한 추정치|공개 예약 추정<\/span>/);
  const missingCapacity = ui.renderSnapshot({ companies: [{ companyId: "missing", capacity: null }] });
  assert.doesNotMatch(missingCapacity, /객실 규모 0실/);
});
