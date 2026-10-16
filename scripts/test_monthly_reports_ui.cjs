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
function fixture({ generation, options } = {}) {
  const container = { innerHTML: "", addEventListener() {}, querySelector() { return null; } };
  const calls = [];
  let saved;
  let nextFailure = null;
  const api = async (url, method = "GET", body) => {
    calls.push({ url, method, body: structuredClone(body) });
    if (nextFailure) { const error = nextFailure; nextFailure = null; throw error; }
    if (url === "/options") return structuredClone(typeof options === "function" ? options() : options || { companies: [{ id: "c1", label: "테스트 숙소" }], keywords: [], regions: [{ id: "kr_gyeongnam_sancheong", label: "경상남도 산청군" }], months: ["2026-08"], defaultMonth: "2026-08" });
    if (url === "/preview") return structuredClone(generation ? { ...snapshot, generation } : snapshot);
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
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("DOM timing identifies each completed preview, never a pending or failed request as ready", async () => {
  const f = fixture(); f.container.dataset = { mrEntryStartedAt: String(Date.now() - 20) };
  await f.controller.open();
  assert.equal(f.container.dataset.mrEntryStatus, "ready");
  assert.ok(Number(f.container.dataset.mrEntryMs) >= 20);
  assert.equal(f.container.dataset.mrEntryStartedAt, undefined);
  f.controller.input("targetId", "c1");
  await f.controller.action("preview");
  const previous = Number(f.container.dataset.mrPreviewSequence);
  assert.equal(f.container.dataset.mrPreviewStatus, "ready");
  assert.ok(Number.isFinite(Number(f.container.dataset.mrPreviewMs)));
  f.fail(new Error("response unavailable"));
  await f.controller.action("preview");
  assert.equal(f.container.dataset.mrPreviewStatus, "error");
  assert.ok(Number(f.container.dataset.mrPreviewSequence) > previous);
  assert.deepEqual(f.calls.filter(row => row.url === "/preview").map(row => row.body), [snapshot.request, snapshot.request]);
});

test("paint timing waits two frames and an older completion cannot replace newer diagnostics", async () => {
  const frames = [], context = vm.createContext({ module: { exports: {} }, requestAnimationFrame: callback => frames.push(callback) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/monthly-reports.js"), "utf8"), context);
  const container = { innerHTML: "", dataset: {}, addEventListener() {}, querySelector() { return null; } };
  const next = deferred(); let calls = 0;
  const controller = context.module.exports.createController(container, async url => {
    if (url === "/options") return { companies: [{ id: "c1", label: "test" }], defaultMonth: "2026-08" };
    if (url === "/preview") return snapshot;
    if (++calls === 2) return next.promise;
    return { reports: [] };
  });
  await controller.open();
  assert.equal(container.dataset.mrEntryStatus, "pending");
  assert.equal(container.dataset.mrEntryMs, undefined);
  frames.shift()();
  assert.equal(container.dataset.mrEntryStatus, "pending");
  frames.shift()();
  assert.equal(container.dataset.mrEntryStatus, "ready");
  const previous = container.dataset.mrEntrySequence;
  const opening = controller.open();
  assert.equal(container.dataset.mrEntryStatus, "pending");
  next.resolve({ reports: [] }); await opening;
  const oldFrame = frames.shift();
  controller.input("targetId", "c1"); await controller.action("preview");
  oldFrame(); frames.shift()(); frames.shift()();
  assert.equal(container.dataset.mrEntryStatus, "pending", "old entry callback is not a new completed measurement");
  assert.equal(container.dataset.mrEntrySequence, previous);
  frames.shift()();
  assert.equal(container.dataset.mrPreviewStatus, "ready");
  assert.ok(Number(container.dataset.mrPreviewSequence) > Number(previous));
  await controller.action("preview");
  controller.input("month", "2026-07");
  while (frames.length) frames.shift()();
  assert.equal(controller.state.preview, null);
  assert.equal(container.dataset.mrPreviewStatus, "invalidated", "a changed condition cannot inherit the old preview's paint completion");
  assert.equal(container.dataset.mrPreviewSequence, undefined);
  assert.equal(container.dataset.mrPreviewMs, undefined);
});
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

test("number and Korea date formatters are reused without changing unknown, zero or rendered values", () => {
  const constructors = { number: 0, date: 0 };
  const context = vm.createContext({ module: { exports: {} }, Intl: {
    NumberFormat: function (...args) { constructors.number++; return new Intl.NumberFormat(...args); },
    DateTimeFormat: function (...args) { constructors.date++; return new Intl.DateTimeFormat(...args); }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/monthly-reports.js"), "utf8"), context);
  const formatted = context.module.exports;
  const data = { ...structuredClone(snapshot), summary: { lodging: { ...metric, estimatedRevenue: null, publicRevenue: 0, phoneRevenue: 1234567.89 }, dayuse: { ...metric, estimatedRevenue: 0 } } };
  assert.equal(formatted.renderSnapshot(data), ui.renderSnapshot(data));
  assert.equal(formatted.renderSnapshot(data), ui.renderSnapshot(data));
  assert.equal(formatted.defaultCutoff("2024-02", "2026-09-26"), "2024-02-29");
  formatted.createController({ innerHTML: "", addEventListener() {} }, async () => ({}));
  assert.deepEqual(constructors, { number: 1, date: 2 }, "rendering must not construct Intl formatters per value or repeated render");
});

test("busy and list-only renders reuse one snapshot body but accepted API snapshots are rendered again", async () => {
  const container = { innerHTML: "", addEventListener() {}, querySelector() { return null; } };
  let qualityReads = 0, currentQuality = structuredClone(snapshot.quality);
  const savedSnapshot = { ...structuredClone(snapshot), get quality() { qualityReads++; return currentQuality; } };
  const report = { id: "mr_fixed", title: "발행본", status: "published", snapshot: savedSnapshot };
  const c = ui.createController(container, async url => {
    if (url === "/options") return { defaultMonth: "2026-08", companies: [{ id: "c1", label: "테스트 숙소" }] };
    if (url === "/preview") return { snapshot: savedSnapshot, previewToken: "fixed" };
    if (url === "/mr_fixed") return report;
    return { reports: [] };
  });
  await c.open({ type: "company", targetId: "c1" });
  await c.action("preview");
  assert.equal(qualityReads, 1);
  const before = container.innerHTML.match(/<div class="mr-snapshot">[^]*<\/section><\/div><\/div>$/)?.[0];
  assert.ok(before, "the comparison must contain the rendered snapshot body");
  await c.action("refresh");
  await c.action("filter", "draft");
  assert.equal(qualityReads, 1, "busy start/end and list filters must not regenerate the unchanged snapshot");
  assert.equal(container.innerHTML.match(/<div class="mr-snapshot">[^]*<\/section><\/div><\/div>$/)?.[0], before);
  currentQuality = { ...currentQuality, missingCompanyDays: 77 };
  await c.action("preview");
  assert.equal(qualityReads, 2, "a new API response invalidates the memo even if an adapter reuses its object reference");
  assert.match(container.innerHTML, /미확인 77 업체·숙박일/);
  await c.action("open", "mr_fixed");
  assert.equal(qualityReads, 3);
  await c.action("refresh");
  assert.equal(qualityReads, 3, "published snapshot display also reuses its unchanged body");
  assert.equal(report.status, "published");
  assert.equal(c.state.report.snapshot, savedSnapshot, "memoization must not replace or modify saved data");
  assert.doesNotMatch(container.innerHTML, /name="notes"/);
});

test("selector markup reuse preserves selection and invalidates on search, type, target or verified options", async () => {
  const select = { innerHTML: "" };
  const container = { innerHTML: "", addEventListener() {}, querySelector() { return select; } };
  let labelReads = 0, label = "처음 업체";
  const option = { id: "c1", get label() { labelReads++; return label; } };
  const options = { defaultMonth: "2026-08", companies: [option], keywords: [{ id: "keyword", label: "경남글램핑" }] };
  const c = ui.createController(container, async url => url === "/options" ? options : { reports: [] });
  await c.open({ type: "company", targetId: "c1" });
  assert.equal(labelReads, 1);
  await c.action("refresh"); await c.action("filter", "draft");
  assert.equal(labelReads, 1, "unchanged busy/list renders reuse the selector markup");
  c.input("targetSearch", "NO MATCH");
  assert.match(select.innerHTML, /value="c1" selected>처음 업체/);
  assert.equal(labelReads, 2, "selected target remains visible even if it does not match search");
  c.input("targetSearch", "no match");
  assert.equal(labelReads, 2, "equivalent normalized searches have identical selector semantics");
  c.input("targetId", "missing");
  assert.equal(labelReads, 3);
  assert.doesNotMatch(container.innerHTML, /value="c1"/);
  c.input("type", "keyword");
  assert.match(container.innerHTML, /value="keyword">경남글램핑/);
  c.input("type", "company"); c.input("targetId", "c1");
  label = "API에서 수정된 업체";
  const previousReads = labelReads;
  await c.open();
  assert.ok(labelReads > previousReads, "every successfully verified response refreshes options even if the adapter reuses its object");
  assert.match(container.innerHTML, /value="c1" selected>API에서 수정된 업체/);
  assert.equal(c.state.form.targetId, "c1");
  assert.equal(c.state.options.companies[0], option, "selector caching leaves source options unchanged");
});

test("oversized snapshot markup is rendered accurately without retaining a large memo entry", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  let reads = 0;
  const largeQuality = { warnings: ["검토 근거 ".repeat(200000)] };
  const large = { ...structuredClone(snapshot), get quality() { reads++; return largeQuality; } };
  const c = ui.createController(container, async url => url === "/options"
    ? { defaultMonth: "2026-08", companies: [{ id: "c1", label: "업체" }] }
    : url === "/preview" ? { snapshot: large } : { reports: [] });
  await c.open({ type: "company", targetId: "c1" }); await c.action("preview");
  assert.equal(reads, 1);
  await c.action("filter", "draft");
  assert.equal(reads, 2, "an oversized snapshot cannot remain in the controller's markup cache");
  assert.match(container.innerHTML, /검토 근거/);
});

test("a reused calculation is identified without changing the approval payload or published view", async () => {
  const { controller: c, container, calls } = fixture({ generation: { cacheStatus: "reused", storage: "saved", calculatedAt: "2026-10-16T01:00:00Z", timings: { totalMs: 125 } } });
  await c.open({ type: "company", targetId: "c1" });
  await c.action("preview");
  assert.match(container.innerHTML, /저장 집계 재사용/);
  assert.match(container.innerHTML, /자료 확인 0\.1초/);
  await c.action("save");
  assert.equal(calls.find(call => call.url === "" && call.method === "POST").body.generation, undefined);
  assert.doesNotMatch(container.innerHTML, /mr-generation/);
  c.input("targetId", "another-company");
  assert.equal(c.state.generation, null);
});

test("selector cache status is shown by the conditions without claiming failed storage was reused", async () => {
  const options = { companies: [{ id: "c1", label: "테스트 숙소" }], keywords: [], regions: [], months: ["2026-08"], defaultMonth: "2026-08", selectorCache: { status: "reused", storage: "saved", calculatedAt: "2026-10-16T01:00:00Z", checkedAt: "2026-10-16T01:10:00Z", timings: { totalMs: 125 } } };
  const { controller: c, container } = fixture({ options: () => options });
  await c.open();
  assert.match(container.innerHTML, /<p class="mr-generation mr-selector-note">저장 선택 목록 재사용 · 확인 0\.1초<\/p><\/section>/);
  assert.ok(container.innerHTML.indexOf("mr-selector-note") < container.innerHTML.indexOf("mr-workspace"));
  options.selectorCache = { status: "reused", storage: "failed", timings: { totalMs: 1 } };
  await c.open();
  assert.match(container.innerHTML, /선택 목록 확인 · 목록 저장 안 됨 · 확인 0\.1초 미만/);
  assert.doesNotMatch(container.innerHTML, /저장 선택 목록 재사용/);
  options.selectorCache = { status: "calculated", storage: "saved", timings: { totalMs: null } };
  await c.open();
  assert.match(container.innerHTML, /mr-selector-note">선택 목록 갱신<\/p>/);
  assert.doesNotMatch(container.innerHTML, /확인 0(?:\.0)?초/);
});

test("reopening checks saved options while retaining selections and clears only a removed target's preview", async () => {
  const options = { companies: [{ id: "c1", label: "테스트 숙소" }], keywords: [], regions: [], months: ["2026-08"], defaultMonth: "2026-08" };
  const { controller: c, container, calls } = fixture({ options: () => options });
  await c.open({ type: "company", targetId: "c1" });
  c.input("month", "2026-07"); c.input("cutoffDate", "2026-07-26"); c.input("targetSearch", "테스트");
  await c.action("preview");
  const previousForm = { ...c.state.form }, previousPreview = c.state.preview;
  options.companies[0].label = "수정한 테스트 숙소";
  options.companies.push({ id: "c2", label: "새 업체" });
  options.months.unshift("2026-09"); options.defaultMonth = "2026-09";
  await c.open();
  assert.deepEqual(c.state.form, previousForm, "new server defaults must not replace a user's selected period");
  assert.equal(c.state.search, "테스트");
  assert.equal(c.state.preview, previousPreview);
  assert.equal(c.state.previewToken, snapshot.previewToken);
  assert.equal(c.state.options.companies.length, 2);
  assert.equal(c.state.options.months[0], "2026-09");
  assert.match(container.innerHTML, /수정한 테스트 숙소/);
  options.companies = [{ id: "c2", label: "병합된 업체" }];
  await c.open();
  assert.equal(calls.filter(call => call.url === "/options").length, 3);
  assert.deepEqual(c.state.form, { ...previousForm, targetId: "" });
  assert.equal(c.state.search, "테스트");
  assert.equal(c.state.preview, null);
  assert.equal(c.state.previewRequest, null);
  assert.equal(c.state.previewToken, null);
  assert.match(container.innerHTML, /선택했던 대상이 목록에서 변경되었습니다/);
  const saves = calls.filter(call => call.method === "POST").length;
  await c.action("save");
  assert.equal(calls.filter(call => call.method === "POST").length, saves, "a removed target cannot save its previous preview");
});

test("failed options verification does not certify an old cached list or permit a new preview", async () => {
  const options = { companies: [{ id: "c1", label: "테스트 숙소" }], months: ["2026-08"], defaultMonth: "2026-08", selectorCache: { status: "reused", storage: "saved", timings: { totalMs: 10 } } };
  const { controller: c, container, calls, fail } = fixture({ options });
  await c.open({ type: "company", targetId: "c1" });
  fail(new Error("선택 목록 변경 확인 실패"));
  await c.open();
  assert.equal(c.state.optionsVerified, false);
  assert.equal(c.state.form.targetId, "c1", "failed verification must not invent deletion");
  assert.match(container.innerHTML, /role="alert"[^>]*>선택 목록 변경 확인 실패/);
  assert.match(container.innerHTML, /선택 목록을 확인하지 못했습니다/);
  assert.doesNotMatch(container.innerHTML, /저장 선택 목록 재사용/);
  assert.match(container.innerHTML, /type="submit" disabled>미리보기 만들기/);
  await c.action("preview");
  assert.equal(calls.filter(call => call.url === "/preview").length, 0);
  await c.open();
  assert.equal(c.state.optionsVerified, true);
  assert.match(container.innerHTML, /저장 선택 목록 재사용/);
});

test("opening starts independent selector and report-list reads together and applies only their settled results", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  const options = deferred(), reports = deferred(), calls = [];
  const c = ui.createController(container, url => {
    calls.push(url);
    return url === "/options" ? options.promise : reports.promise;
  });
  const pending = c.open({ type: "company", targetId: "c1" });
  assert.deepEqual(calls, ["/options", ""], "the list must not wait for selector verification");
  reports.resolve({ reports: [{ id: "mr_parallel", title: "저장 리포트", status: "draft" }] });
  await Promise.resolve();
  assert.equal(c.state.optionsVerified, false);
  assert.deepEqual(c.state.reports, [], "one response must not partially update an unfinished open");
  assert.ok(c.state.busy);
  options.resolve({ defaultMonth: "2026-08", companies: [{ id: "c1", label: "테스트 숙소" }] });
  await pending;
  assert.equal(c.state.optionsVerified, true);
  assert.equal(c.state.reports[0].id, "mr_parallel");
  assert.equal(c.state.form.targetId, "c1");
  assert.equal(c.state.error, "");
  assert.equal(c.state.busy, "");
});

test("a selector failure drains the report read before releasing busy and never verifies stale options", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  const options = deferred(), reports = deferred();
  let gated = false, previews = 0;
  const c = ui.createController(container, async url => {
    if (url === "/options") return gated ? options.promise : { defaultMonth: "2026-08", companies: [{ id: "c1", label: "이전 숙소" }] };
    if (url === "/preview") { previews++; return structuredClone(snapshot); }
    return gated ? reports.promise : { reports: [{ id: "mr_old", title: "이전 리포트" }] };
  });
  await c.open({ type: "company", targetId: "c1" });
  gated = true;
  const pending = c.open();
  options.reject(new Error("선택 목록 확인 실패"));
  await Promise.resolve();
  assert.ok(c.state.busy, "the unfinished list read must keep the operation busy");
  await c.action("preview");
  assert.equal(previews, 0);
  assert.equal(c.state.reports[0].id, "mr_old");
  reports.resolve({ reports: [{ id: "mr_new", title: "확인된 리포트" }] });
  await pending;
  assert.equal(c.state.busy, "");
  assert.equal(c.state.reports[0].id, "mr_new");
  assert.equal(c.state.optionsVerified, false);
  assert.equal(c.state.form.targetId, "c1", "failed verification is not evidence of target removal");
  assert.match(c.state.error, /선택 목록 확인 실패/);
  assert.match(container.innerHTML, /선택 목록을 확인하지 못했습니다/);
  await c.action("preview");
  assert.equal(previews, 0);
});

test("a report-list failure retains the previous list while applying successfully verified selector changes", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  let failList = false;
  const c = ui.createController(container, async url => {
    if (url === "/options") return { defaultMonth: "2026-08", companies: [{ id: "c1", label: failList ? "수정된 숙소" : "기존 숙소" }] };
    if (failList) throw new Error("저장 리포트 목록 확인 실패");
    return { reports: [{ id: "mr_existing", title: "이전 확인 리포트" }] };
  });
  await c.open({ type: "company", targetId: "c1" });
  c.input("month", "2026-07");
  failList = true;
  await c.open();
  assert.equal(c.state.optionsVerified, true);
  assert.equal(c.state.options.companies[0].label, "수정된 숙소");
  assert.equal(c.state.form.month, "2026-07");
  assert.equal(c.state.reports[0].id, "mr_existing", "failure cannot turn an existing list into an empty list");
  assert.match(c.state.error, /저장 리포트 목록 확인 실패/);
  assert.equal(c.state.message, "");
  assert.equal(c.state.busy, "");
});

test("both failed open reads are observed and reported without inventing empty saved data", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  const c = ui.createController(container, url => {
    throw new Error(url === "/options" ? "선택 목록 오류" : "저장 목록 오류");
  });
  await c.open();
  assert.match(c.state.error, /선택 목록 오류.*저장 목록 오류/);
  assert.equal(c.state.optionsVerified, false);
  assert.equal(c.state.busy, "");
});

test("a new handoff waits for both old reads and cannot be overwritten by their later responses", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  const options = deferred(), reports = deferred(), calls = [];
  let latest = false;
  const c = ui.createController(container, url => {
    calls.push(url);
    if (!latest) return url === "/options" ? options.promise : reports.promise;
    return Promise.resolve(url === "/options"
      ? { defaultMonth: "2026-08", regions: [{ id: "pocheon", label: "포천시" }] }
      : { reports: [{ id: "mr_latest", title: "최신 목록" }] });
  });
  const oldOpen = c.open({ type: "company", targetId: "removed" });
  const context = { type: "region", targetId: "pocheon", month: "2026-08", cutoffDate: "2026-08-26" };
  const newOpen = c.open(context);
  options.reject(new Error("이전 화면 선택 목록 오류"));
  await Promise.resolve();
  assert.equal(calls.length, 2, "new work cannot race an unfinished old list response");
  assert.ok(c.state.busy);
  latest = true;
  reports.resolve({ reports: [{ id: "mr_stale", title: "이전 화면 목록" }] });
  await Promise.all([oldOpen, newOpen]);
  assert.deepEqual(calls, ["/options", "", "/options", ""]);
  assert.deepEqual(c.state.form, context);
  assert.equal(c.state.reports[0].id, "mr_latest");
  assert.equal(c.state.optionsVerified, true);
  assert.equal(c.state.error, "");
  assert.equal(c.state.preview, null);
  assert.equal(c.state.busy, "");
});

test("pending work shows a live indicator and disables duplicate requests without inventing progress", async () => {
  const container = { innerHTML: "", addEventListener() {}, querySelector() { return null; } };
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const c = ui.createController(container, async url => {
    calls++;
    if (url === "/options") { await waiting; return { companies: [], months: ["2026-09"] }; }
    return { reports: [] };
  });
  const pending = c.open();
  assert.match(container.innerHTML, /aria-busy="true"/);
  assert.match(container.innerHTML, /mr-loading/);
  assert.doesNotMatch(container.innerHTML, /남은 시간|진행률/);
  await c.action("preview");
  assert.equal(calls, 2, "another action cannot submit while the two independent reads are pending");
  release(); await pending;
  assert.equal(c.state.busyStartedAt, 0);
  assert.doesNotMatch(container.innerHTML, /class="mr-loading"/);
});

test("region DB handoff preserves the explicit month and cutoff and invalidates other previews", async () => {
  const { controller: c, calls, container } = fixture();
  await c.open({ type: "company", targetId: "c1" });
  await c.action("preview");
  const context = { type: "region", targetId: "kr_gyeongnam_sancheong", month: "2026-07", cutoffDate: "2026-07-26" };
  await c.open(context);
  assert.deepEqual(c.state.form, context);
  assert.equal(c.state.preview, null);
  assert.equal(c.state.previewToken, null);
  assert.equal(c.state.report, null);
  assert.match(container.innerHTML, /지역 DB에서 선택한 지역/);
  assert.equal(calls.filter(call => call.method === "POST").length, 1, "handoff never collects, previews or publishes automatically");
  await c.action("preview");
  assert.deepEqual(calls.at(-1).body, context);
  await c.open({ ...context, month: "2026-06", cutoffDate: "2026-06-30" });
  assert.equal(c.state.form.month, "2026-06");
  await c.open({ type: "region", targetId: context.targetId, month: "2024-02" });
  assert.equal(c.state.form.cutoffDate, "2024-02-29", "changing month without a cutoff resets it to that month's end");
});

test("invalid regional handoff never silently selects another region or retains a stale preview", async () => {
  const { controller: c, calls } = fixture();
  const context = { type: "region", targetId: "kr_gyeongnam_sancheong", month: "2026-07", cutoffDate: "2026-07-26" };
  await c.open(context); await c.action("preview");
  await c.open({ ...context, targetId: "missing-region" });
  assert.equal(c.state.form.targetId, "");
  assert.equal(c.state.preview, null);
  assert.match(c.state.error, /지역을 리포트 목록에서 찾지 못했습니다/);
  await c.open({ ...context, month: "2099-12" });
  assert.equal(c.state.form.month, "");
  assert.match(c.state.error, /대상 월/);
  await c.open({ ...context, cutoffDate: "2026-02-30" });
  assert.equal(c.state.form.cutoffDate, "");
  assert.match(c.state.error, /관측 마감일/);
  assert.ok(calls.every(call => !/collect|crawl|publish/.test(call.url)));
});

test("latest region handoff waits for an in-flight preview and cannot be replaced by its old result", async () => {
  const container = { innerHTML: "", addEventListener() {} };
  let release;
  const c = ui.createController(container, async url => {
    if (url === "/options") return { defaultMonth: "2026-08", companies: [{ id: "c1", label: "숙소" }], regions: [{ id: "sancheong", label: "산청군" }, { id: "pocheon", label: "포천시" }] };
    if (url === "/preview") { await new Promise(resolve => { release = resolve; }); return structuredClone(snapshot); }
    if (url === "") return { reports: [] };
    throw new Error(url);
  });
  await c.open({ type: "company", targetId: "c1" });
  const preview = c.action("preview");
  const first = c.open({ type: "region", targetId: "sancheong", month: "2026-07", cutoffDate: "2026-07-31" });
  const latest = { type: "region", targetId: "pocheon", month: "2026-08", cutoffDate: "2026-08-26" };
  const last = c.open(latest);
  release();
  await Promise.all([preview, first, last]);
  assert.deepEqual(c.state.form, latest);
  assert.equal(c.state.preview, null);
  assert.equal(c.state.previewToken, null);
  assert.equal(c.state.busy, "");
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

test("keyword market sections keep observation months, matched comparisons and price bases explicit", () => {
  const current = { ...metric, companyCount: 2, coveredCompanyDays: 2, expectedCompanyDays: 3 };
  const previous = { ...current, estimatedRevenue: 200000, sold: 2 };
  const market = { ...structuredClone(snapshot), request: { ...snapshot.request, type: "keyword" }, target: { id: "경남글램핑", label: "경남글램핑", type: "keyword" },
    comparison: { previousMonth: "2026-07", currentMonth: "2026-08", status: "limited", all: { current, previous }, common: { companyCount: 2, current, previous, matched: { companyCount: 1, companyDays: 1, excludedCompanyDays: 2, current, previous, deltas: { sold: 1, estimatedRevenue: 100000, reservationRatePoints: 10, estimatedRevenueRate: .5 } } }, newlyObservedCompanyIds: ["new"], noLongerObservedCompanyIds: ["old"], warnings: ["관측 표본은 시장 전체가 아닙니다."] },
    ranks: { rows: [{ companyId: "c1", companyName: "테스트 숙소", keyword: "경남글램핑", firstRank: 5, lastRank: 3, rankImprovement: 2, observations: 3, firstCollectedAt: "2026-08-02T01:00:00Z", lastCollectedAt: "2026-08-28T01:00:00Z" }] },
    insights: { schemaVersion: 1,
      overview: { companyCount: 2, knownCapacityCompanyCount: 1, totalRooms: 10, capacityComplete: false, collectionDateCount: 5, publicBookingShare: 2 / 3, blockedBookingShare: 1 / 3 },
      pickup: { lodging: { comparableIntervals: 2, baselinePublicBookings: 1, baselineBlockedBookings: 2, rejectedByReason: { capacity_changed: 1 }, offsettingChannelChangeIntervals: 1, includesPartialRuns: true, public: { status: "ready", increase: 2, decrease: 1, net: 1, leadTime: { averageDays: 6, medianDays: 6, averageMinDays: 5, averageMaxDays: 7, intervalCrossingPickup: 1, bins: [{ label: "4~7일 전", pickup: 2, share: 1 }] } }, blocked: { status: "no_increase", increase: 0, decrease: 0, net: 0 } } },
      pace: { lodging: [{ leadDays: 7, ...metric, coveredCompanyDays: 1, expectedCompanyDays: 2 }] },
      weekdays: { lodging: [{ dayOfWeek: 1, label: "월", ...metric, coveredCompanyDays: 1, expectedCompanyDays: 2 }] },
      pricing: { lodging: { pricedCompanyDays: 1, expectedCompanyDays: 2, pricedSupply: 10, pricedSold: 3, estimatedPerSoldUnit: 100000, estimatedPerSupplyUnit: 30000, priceCoverageRate: .5, excludedPriceCompanyDays: 1, containsFallbackPrice: true, companyDistribution: { companyCount: 2, medianUnitPrice: 150000, minUnitPrice: 100000, maxUnitPrice: 200000, bands: [{ label: "10~20만원 미만", companyCount: 1 }, { label: "20~30만원 미만", companyCount: 1 }] } } },
      rankVisibility: { rows: [{ companyId: "c1", companyName: "테스트 숙소", keyword: "경남글램핑", observedDays: 3, meanRank: 4, bestRank: 3, worstRank: 5, top3ObservedShare: 1 / 3, top10ObservedShare: 1 }] },
      geography: { rows: [{ regionKey: "gyeongnam", regionLabel: "경상남도", companyCount: 2, lodging: metric }] }, calendarGroups: { status: "partial", classifiedDays: 30, missingYears: [2027], sourceYears: [{ year: 2026, status: "ready", updatedAt: "2026-01-02T01:00:00Z" }, { year: 2027, status: "missing" }], rows: [{ key: "holiday", label: "공휴일", calendarDays: 3, lodging: metric, dayuse: metric }, { key: "unclassified", label: "달력 근거 미확인", calendarDays: 1, lodging: { estimatedRevenue: null } }] }, definitions: { pickup: "반복 관측 증가 기준" }
    }
  };
  const markup = ui.renderSnapshot(market);
  const sectionOrder = ["summary", "comparison", "ranks", "timing", "pricing", "context"].map((key) => markup.indexOf(`data-mr-section="${key}"`));
  assert.ok(sectionOrder.every((position, index) => position >= 0 && (!index || sectionOrder[index - 1] < position)));
  assert.match(markup, /시장 요약/);
  assert.match(markup, /객실 기준 총량<\/dt><dd>10실/);
  assert.match(markup, /기준값 있는 업체 1 \/ 2곳 · 일부 업체 소계/);
  assert.match(markup, /title="숙박월 이전 관측 포함">분석에 사용한 수집일<\/dt><dd>5일/);
  assert.match(markup, /DB 보정값을 우선하고, 없으면 최대 관측 추정값/);
  assert.match(markup, /공개 예약 비중<\/dt><dd>66\.7%/);
  assert.match(markup, /업체별 단가 중간값<\/dt><dd>150,000원/);
  assert.match(markup, /meter min="0" max="2" value="1" aria-label="10~20만원 미만 2곳 중 1곳"/);
  assert.match(markup, /순위의 관측월/);
  assert.match(markup, /숙박일 기준 예약·매출과 시간 기준이 다릅니다/);
  assert.match(markup, /지역 전체 숙박시장의 합계가 아닙니다/);
  assert.match(markup, /동일 조건으로 비교한 변화/);
  assert.match(markup, /\+10%p/);
  assert.match(markup, /\+50%/);
  assert.match(markup, /개업·폐업을 뜻하지 않습니다/);
  assert.match(markup, /관측되지 않은 날은 분모에서 제외/);
  assert.match(markup, /수집 간격을 고려한 평균 범위 5~7일 전/);
  assert.match(markup, /구간 경계를 넘은 수량 1실·박/);
  assert.match(markup, /최초 관측 공개 예약 1실·박 · 방막기 추정 2실·박/);
  assert.match(markup, /채널 분류 변화일 수 있습니다/);
  assert.match(markup, /두 행의 차이를 예약 증가량으로 해석하지 않습니다/);
  assert.match(markup, /감소는 취소 확정 건수가 아닙니다/);
  assert.match(markup, /실제 결제 객단가가 아닙니다/);
  assert.match(markup, /다른 관측일의 보완 가격 포함/);
  assert.match(markup, /관측 업체의 지역 구성/);
  assert.match(markup, /공휴일·전날·그 외 날짜 비교/);
  assert.match(markup, /2027년 달력 근거가 없어 해당 날짜는 미확인/);
  assert.match(markup, /달력 근거 미확인<\/th><td>1일/);
  assert.match(markup, /반복 관측 증가 기준/);
  assert.match(markup, /mr-pickup-card mr-public/);
  assert.match(markup, /mr-pickup-card mr-phone/);
});

test("missing insight evidence stays unknown and untrusted new insight strings are escaped", () => {
  const dangerous = '<svg onload="bad()">';
  const markup = ui.renderSnapshot({ ...snapshot,
    comparison: { status: "unavailable", previousMonth: "2026-07", common: { matched: { companyDays: null, deltas: { estimatedRevenue: 999999 } } }, warnings: [dangerous] },
    insights: { pickup: { lodging: { public: { status: "insufficient", increase: null, decrease: null, net: null }, blocked: { status: "insufficient" } } }, pace: { lodging: [{ leadDays: 14, supply: null, sold: null, publicBookings: null, phoneBookings: null, reservationRate: null, coverageRate: 0, coveredCompanyDays: 0, expectedCompanyDays: 31 }] }, weekdays: { lodging: [{ label: dangerous, estimatedRevenue: null }] }, pricing: { lodging: { priceCoverageRate: 0, pricedCompanyDays: 0, expectedCompanyDays: 31, pricedSold: null, pricedSupply: null, estimatedPerSoldUnit: null, estimatedPerSupplyUnit: null } }, rankVisibility: { rows: [{ companyName: dangerous, keyword: dangerous, meanRank: null }] }, geography: { rows: [{ regionLabel: dangerous, companyCount: 1, lodging: { estimatedRevenue: null } }] }, definitions: { timing: dangerous } }
  });
  assert.doesNotMatch(markup, /<svg|999,999원|동일 조건으로 비교한 변화/);
  assert.match(markup, /&lt;svg/);
  assert.match(markup, /이전 월 자료가 부족합니다/);
  assert.match(markup, /예약 시점을 추정할 수 없습니다/);
  assert.match(markup, /14일 전<\/th><td>0 \/ 31<\/td><td class="mr-public">확인 불가/);
  assert.match(markup, /예약 추정 1실·박당 금액<\/dt><dd>확인 불가/);
  assert.doesNotMatch(markup, /예약 추정 1실·박당 금액<\/dt><dd>0원/);
  const legacy = ui.renderSnapshot(snapshot);
  assert.match(legacy, /이 저장본에 요일별 분석 자료가 없습니다/);
  assert.match(legacy, /가까운 날짜의 값으로 채우지 않습니다/);
  const noPrices = ui.renderSnapshot({ ...snapshot, insights: { overview: { companyCount: 1, knownCapacityCompanyCount: 0, totalRooms: null, capacityComplete: false, collectionDateCount: 0, publicBookingShare: null, blockedBookingShare: null }, pricing: { lodging: { companyDistribution: { companyCount: 0, medianUnitPrice: null, bands: [] } } } } });
  assert.match(noPrices, /객실 기준 총량<\/dt><dd>확인 불가/);
  assert.match(noPrices, /공개 예약 비중<\/dt><dd>확인 불가/);
  assert.match(noPrices, /업체별 단가를 계산할 가격 근거가 없습니다/);
  assert.doesNotMatch(noPrices, /<meter|업체별 단가 중간값<\/dt><dd>0원/);
});

test("keyword preview titles use search market language and unsupported dates cannot save a stale preview", async () => {
  assert.equal(ui.reportTitle({ month: "2026-08", type: "keyword" }, { label: "경남글램핑" }), "2026년 8월 경남글램핑 검색시장 리포트");
  assert.equal(ui.reportTitle({ month: "2026-08", type: "company" }, { label: "테스트 숙소" }), "2026년 8월 테스트 숙소 월간 리포트");
  const f = fixture();
  await f.controller.open({ type: "keyword", targetId: "경남글램핑" });
  await f.controller.action("preview");
  assert.match(f.controller.state.title, /^2026년 8월 .* 검색시장 리포트$/);
  f.controller.input("month", "1900-01");
  f.fail(new Error("지원하지 않는 연도입니다. 저장 자료가 있는 월을 선택해 주세요."));
  await f.controller.action("preview");
  assert.equal(f.controller.state.preview, null);
  assert.match(f.container.innerHTML, /role="alert"[^>]*>지원하지 않는 연도/);
  await f.controller.action("save");
  assert.equal(f.calls.filter((call) => call.url === "" && call.method === "POST").length, 0);
  assert.ok(f.calls.every((call) => !/collect|crawl|provider/.test(call.url)));
});

function outlookEvaluationFixture() {
  const row = { label: "지역 방문자", metricKey: "visitors", provider: "한국관광공사", unit: "명", targetPeriod: "2026-08", issueMonth: "2026-07", kind: "next", modelVersion: "model-v1", forecastValue: 100,
    status: "compared", reasonCode: "", reasonLabel: "", actualValue: 0, difference: -100, absoluteError: 100, errorPct: null,
    predictionRef: { resultId: "published-forecast-1", generatedAt: "2026-07-01T01:00:00Z", publishedAt: "2026-07-01T02:00:00Z", proof: "journal", coverage: "recorded" },
    actualRef: { period: "2026-08", receivedAt: "2026-10-01T01:00:00Z", sourceFingerprint: "official-observation-1", receiptEvidence: "source_timestamp" } };
  return { schemaVersion: 1, reportMonth: "2026-08", cutoffDate: "2026-08-31", asOfAt: "2026-10-16T00:00:00Z", selectionBasis: "target_month", temporalBasis: "saved_evaluation_at_report_creation", networkAttempted: false,
    regions: [{ regionKey: "test-region", regionLabel: "테스트군", status: "ready", summaryCounts: { total: 2, compared: 1, pending: 1, excluded: 0 }, reasonCounts: [{ code: "OFFICIAL_PUBLICATION_PENDING", label: "공식자료 공표를 기다리고 있습니다.", count: 1 }],
      source: { resultId: "evaluation-1", generatedAt: "2026-10-15T01:00:00Z", evaluatedThrough: "2026-10-15T01:00:00Z" },
      rows: [row, { ...row, label: "소비 지수", status: "pending", reasonCode: "OFFICIAL_PUBLICATION_PENDING", reasonLabel: "공식자료 공표를 기다리고 있습니다.", actualValue: null, difference: null, absoluteError: null, errorPct: null, actualRef: null }] }], warnings: [] };
}

test("stored outlook evaluation is folded, target-month scoped and independent from reservation cutoff", () => {
  const evaluations = outlookEvaluationFixture();
  const before = JSON.stringify(evaluations);
  const markup = ui.renderSnapshot({ ...snapshot, context: { outlookEvaluations: evaluations } });
  assert.match(markup, /<details class="mr-fold mr-report-section" data-mr-section="outlook-evaluations"><summary>지역 전망 검증/);
  assert.match(markup, /작성 시점에 저장된 사후 검증 · 예약 관측 마감과 별도/);
  assert.match(markup, /예약 관측 마감 2026-08-31 · 사후 검증 자료 확인/);
  assert.match(markup, /대상월 2026-08 · 발행월 2026-07 · 당시 다음 달 전망/);
  assert.match(markup, /비교 완료 <strong>1<\/strong>/);
  assert.match(markup, /공식자료 대기 <strong>1<\/strong>/);
  assert.match(markup, /공식자료 공표를 기다리고 있습니다\./);
  assert.match(markup, /evaluation-1/);
  assert.match(markup, /published-forecast-1/);
  assert.match(markup, /official-observation-1/);
  assert.match(markup, /한국관광공사/);
  assert.match(markup, /과거 자료 모의검증과 구분/);
  assert.match(markup, /발행본은 새 자료가 생겨도 바뀌지 않습니다/);
  assert.equal(JSON.stringify(evaluations), before);
  assert.doesNotMatch(ui.renderSnapshot(snapshot), /data-mr-section="outlook-evaluations"/, "legacy snapshots retain their original sections");
});

test("outlook pending and missing never render fake zero actuals or errors, while observed zero stays valid", () => {
  const evaluations = outlookEvaluationFixture();
  Object.assign(evaluations.regions[0].rows[1], { actualValue: 0, absoluteError: 0, errorPct: 0 });
  const markup = ui.renderSnapshot({ context: { outlookEvaluations: evaluations } });
  const compared = markup.match(/<article class="mr-outlook-row">[^]*?<\/article>/)[0];
  assert.match(compared, /후속 공식값<\/dt><dd>0명/);
  assert.match(compared, /산출 안 함 · 실제값 0/);
  const pending = markup.match(/<article class="mr-outlook-row">[^]*?<\/article>/g)[1];
  assert.match(pending, /후속 공식값<\/dt><dd>미확인/);
  assert.doesNotMatch(pending, /절대오차|<dd>0명|0%/);
  evaluations.regions = [{ regionKey: "absent", regionLabel: "누락 지역", status: "missing", summaryCounts: null, rows: [], reasonLabel: "저장된 검증 결과가 없습니다." }];
  const absent = ui.renderSnapshot({ context: { outlookEvaluations: evaluations } });
  assert.match(absent, /비교 완료 <strong>확인 불가/);
  assert.doesNotMatch(absent, /비교 완료 <strong>0|정확도 <strong>100/);
  assert.match(absent, /저장된 검증 결과가 없습니다/);
});

test("outlook source strings and reason labels are escaped and do not introduce live actions", () => {
  const evaluations = outlookEvaluationFixture(), dangerous = '<img src=x onerror="bad()">';
  const region = evaluations.regions[0];
  region.regionLabel = dangerous; region.reasonLabel = dangerous; region.reasonCounts[0].label = dangerous;
  region.rows[0].predictionRef.resultId = dangerous; region.rows[0].actualRef.sourceFingerprint = dangerous;
  region.rows[0].provider = dangerous; region.rows[1].reasonLabel = dangerous;
  const markup = ui.renderSnapshot({ context: { outlookEvaluations: evaluations } });
  const outlook = markup.slice(markup.indexOf('data-mr-section="outlook-evaluations"'));
  assert.doesNotMatch(outlook, /<img|onerror="bad|data-mr-action="(?:collect|validate|refresh|build)"/);
  assert.match(outlook, /&lt;img/);
});
