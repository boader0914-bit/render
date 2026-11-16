"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "scripts/glamping_app_server.cjs"), "utf8");
function fn(name) {
  const source = app.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(source, `Missing application function ${name}`);
  return source;
}
function navigation() {
  const constants = ["ROLE_TABS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "TAB_LABELS"];
  const extracted = constants.map(name => app.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0]);
  const names = ["roleTabs", "roleAllowsTab", "adminPrimarySectionForTab", "adminMobileSectionForTab", "adminPanelMobileTarget"];
  const state = { role: "admin", adminPanelSection: "overview" };
  const context = vm.createContext({ state, isAdminRole: () => state.role === "admin", currentRole: () => state.role });
  const api = vm.runInContext(`${extracted.concat(names.map(fn)).join("\n")}\n({roleAllowsTab,adminPrimarySectionForTab,adminMobileSectionForTab,ADMIN_MOBILE_SECTIONS,ADMIN_COMPACT_SECTIONS})`, context);
  return { state, api };
}
function fixture() {
  const calls = [], host = { id: "keywordMonthlyDashboard" };
  const state = { activeTab: "admin", adminPanelSection: "collect", adminViewsDeferred: true,
    adminBootstrapRunPending: "unrelated-old-run", adminBootstrapSummaryPending: true, data: null };
  const harmless = ["applyAnalysisRegionToDictionary", "applyRoleUi", "renderRegionAnalysisShell", "renderHeader", "closeDrawer", "syncAppHistoryState"];
  const context = { state, document: { getElementById: id => id === host.id ? host : { dataset: {} } },
    window: { KeywordMonthlyAnalysis: { show: element => calls.push(["show", element.id]), pause: element => calls.push(["pause", element.id]) },
      MonthlyReports: { show: () => calls.push(["old-report"]) } },
    els: {}, REGION_ANALYSIS_TABS: new Set(), ADMIN_COMPACT_SECTIONS: {}, isAdminRole: () => true,
    roleAllowsTab: () => true, firstRoleTab: () => "admin", adminMobileSectionForTab: () => "analysis",
    resumeAdminBootstrapReads: () => { throw Error("Unrelated bootstrap read started"); },
    reconcileAnalysisRegionSelection: () => { throw Error("Unrelated result rendering started"); },
    renderAll: () => { throw Error("Hidden full rendering started"); } };
  for (const name of harmless) context[name] = () => calls.push([name]);
  vm.createContext(context);
  vm.runInContext(`${fn("setActiveTab")}\nthis.navigate=setActiveTab`, context);
  return { context, state, calls, host };
}
test("keyword monthly is an independent administrator-only analysis destination", () => {
  const { state, api } = navigation();
  assert.equal(api.roleAllowsTab("keywordMonthly"), true);
  assert.equal(api.adminPrimarySectionForTab("keywordMonthly"), "analysis");
  assert.equal(api.adminMobileSectionForTab("keywordMonthly"), "analysis");
  assert.ok(api.ADMIN_MOBILE_SECTIONS.analysis.items.some(item => item.tab === "keywordMonthly"));
  assert.ok(api.ADMIN_COMPACT_SECTIONS.analysis.items.some(item => item.tab === "keywordMonthly"));
  state.role = "b2b";
  assert.equal(api.roleAllowsTab("keywordMonthly"), false);
  assert.match(html, /id="keywordMonthlyPanel"[^>]*data-panel="keywordMonthly"/);
  assert.ok(html.indexOf('/keyword-monthly-analysis.js') < html.indexOf('/app.js'));
  assert.ok(html.indexOf('/admin-view-state.js') < html.indexOf('/keyword-monthly-analysis.js'));
});
test("entry cannot resume an old crawl or rebuild unrelated hidden views", () => {
  const { context, state, calls } = fixture();
  context.navigate("keywordMonthly");
  assert.equal(state.activeTab, "keywordMonthly");
  assert.ok(calls.some(call => call[0] === "show"));
  assert.equal(state.adminBootstrapRunPending, "unrelated-old-run");
  assert.equal(state.adminBootstrapSummaryPending, true);
  assert.equal(state.adminViewsDeferred, true);
  assert.equal(calls.some(call => call[0] === "old-report"), false);
});
test("late renderAll responses cannot paint old data over the keyword view", () => {
  const { context, state, calls } = fixture();
  state.activeTab = "keywordMonthly";
  vm.runInContext(`${fn("renderAll")}\nrenderAll()`, context);
  assert.deepEqual(calls, [["renderHeader"]]);
});
test("leaving pauses the keyword controller and preserves the existing report destination", () => {
  const { context, state, calls } = fixture();
  state.activeTab = "keywordMonthly";
  context.navigate("monthlyReports");
  assert.ok(calls.some(call => call[0] === "pause"));
  assert.ok(calls.some(call => call[0] === "old-report"));
  assert.equal(calls.some(call => call[0] === "show"), false);
});

test("search-demand round trip restores the full monthly context only for the same exact keyword", () => {
  const { context, state } = fixture();
  const monthly = { keyword: "경남글램핑", month: "2026-10", cutoffDate: "2026-10-30", product: "dayuse", benchmarkCompanyId: "company_b", listPage: 2, listQuery: "글램핑", expanded: { "chart:daily": true } };
  let incomingKeyword = monthly.keyword, returned;
  context.fetchJson = async () => ({});
  context.window.KeywordMonthlyAnalysis.getSelection = () => ({ ...monthly });
  context.window.KeywordMonthlyAnalysis.show = (_host, value) => { returned = value; };
  context.window.SearchDemandAnalysis = { pause() {}, show() {}, getSelection: () => ({ keyword: incomingKeyword }) };
  state.activeTab = "keywordMonthly";
  context.navigate("searchDemand");
  context.navigate("keywordMonthly");
  assert.deepEqual(JSON.parse(JSON.stringify(returned)), monthly);
  context.navigate("searchDemand");
  incomingKeyword = "경남 글램핑";
  context.navigate("keywordMonthly");
  assert.deepEqual(JSON.parse(JSON.stringify(returned)), { keyword: "경남 글램핑" });
});

test("keyword view suppresses hidden KOSIS status, region reads and late paints", async () => {
  const state = { activeTab: "keywordMonthly" };
  const context = vm.createContext({ state });
  const api = vm.runInContext(["renderKosisRegionPanel", "renderKosisAdminCard", "renderKosisViews", "loadKosisStatus", "loadKosisRegion"].map(fn).join("\n") + "\n({renderKosisRegionPanel,renderKosisAdminCard,renderKosisViews,loadKosisStatus,loadKosisRegion})", context);
  assert.equal(api.renderKosisRegionPanel({ regionKey: "test" }), "");
  api.renderKosisAdminCard();
  api.renderKosisViews();
  await api.loadKosisStatus();
  await api.loadKosisRegion("test", { refresh: true });
});

test("production prepared reads own the existing analytical lease until the full query resolves", async () => {
  const declaration = serverSource.match(/^const keywordMonthlyAnalysis = Object\.freeze\(\{[^]*?^\}\);/m)?.[0];
  assert.ok(declaration); let leased = false; const calls = [];
  const context = vm.createContext({ keywordMonthlyPreparedAnalysis: {
    async options() { assert.equal(leased, true); await new Promise(resolve => setImmediate(resolve)); return "options"; },
    async analyze(input) { assert.equal(leased, true); await new Promise(resolve => setImmediate(resolve)); assert.equal(leased, true); return input; }
  }, async runAnalyticalWork(operation, options) { assert.equal(leased, false); leased = true; calls.push(options.kind); try { return await operation(); } finally { leased = false; } } });
  const service = vm.runInContext(declaration + "\nkeywordMonthlyAnalysis", context);
  assert.equal(await service.options(), "options"); assert.equal(leased, false);
  const query = { keyword: "가평글램핑", month: "2026-10" }; assert.equal(await service.analyze(query), query); assert.equal(leased, false);
  assert.deepEqual(calls, ["keyword_monthly_options", "keyword_monthly_analysis"]);
});
test("Git-normalized collection, pacing, protection and held runtime sources remain at approved release", () => {
  // This release adds only bounded identity-review metadata to monthly reports.
  // Undo exact approved bytes, then compare the entire remaining file with the
  // original calculator. A broad function removal or new whole-file hash would
  // silently exempt unrelated arithmetic changes from this protection.
  const identityMetadataDeclaration = String.raw`const IDENTITY_REVIEW_FIELDS = ["schemaVersion", "basis", "totalRows", "alreadyRepresentedRows", "recoveredRows", "unresolvedRows", "reasonCounts", "evidenceDigest", "catalogDigest"];
const IDENTITY_REVIEW_MAX_ROWS = 100000000;
function normalizeMonthlyReportIdentityReview(value) {
  const invalid = () => fail("MONTHLY_REPORT_IDENTITY_REVIEW_INVALID", "업체 연결 검토 근거를 확인하지 못했습니다.", 503);
  try {
    const object = v => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
    const own = (v, keys) => object(v) && Reflect.ownKeys(v).length === keys.length
      && keys.every(key => Object.hasOwn(v, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(v, key), "value"));
    const count = v => Number.isSafeInteger(v) && v >= 0 && v <= IDENTITY_REVIEW_MAX_ROWS;
    if (!own(value, IDENTITY_REVIEW_FIELDS) || value.schemaVersion !== 1 || value.basis !== "raw_unresolved_identity_rows"
      || !["totalRows", "alreadyRepresentedRows", "recoveredRows", "unresolvedRows"].every(key => count(value[key]))
      || value.alreadyRepresentedRows + value.recoveredRows + value.unresolvedRows !== value.totalRows
      || !["evidenceDigest", "catalogDigest"].every(key => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key]))
      || !object(value.reasonCounts) || Reflect.ownKeys(value.reasonCounts).length > 64) throw invalid();
    let totalReasons = 0;
    const reasons = {};
    for (const key of Reflect.ownKeys(value.reasonCounts)) {
      const field = Object.getOwnPropertyDescriptor(value.reasonCounts, key);
      if (typeof key !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(key)
        || /(?:password|cookie|authorization|secret|token|private|guest|customer|contact|address|account|kosis)/i.test(key)
        || !Object.hasOwn(field, "value") || !count(field.value) || field.value === 0) throw invalid();
      reasons[key] = field.value; totalReasons += field.value;
    }
    if (totalReasons !== value.unresolvedRows) throw invalid();
    return { schemaVersion: 1, basis: value.basis, totalRows: value.totalRows, alreadyRepresentedRows: value.alreadyRepresentedRows,
      recoveredRows: value.recoveredRows, unresolvedRows: value.unresolvedRows, reasonCounts: reasons, evidenceDigest: value.evidenceDigest, catalogDigest: value.catalogDigest };
  } catch (error) { if (error?.code === "MONTHLY_REPORT_IDENTITY_REVIEW_INVALID") throw error; throw invalid(); }
}
`;
  function restoreApprovedMonthlyMetadata(text) {
    let source = text.replace(/\r\n/g, "\n");
    const replaceOnce = (approved, original) => {
      assert.equal(source.split(approved).length, 2, "Approved monthly metadata span must occur exactly once");
      source = source.replace(approved, original);
    };
    replaceOnce(identityMetadataDeclaration, "");
    replaceOnce('  const identityReview = Object.hasOwn(source || {}, "identityReview") ? normalizeMonthlyReportIdentityReview(source.identityReview) : undefined;\n', "");
    replaceOnce('    globalDiagnostics: source?.globalDiagnostics ? clone(source.globalDiagnostics) : null,\n    ...(identityReview === undefined ? {} : { identityReview })\n',
      '    globalDiagnostics: source?.globalDiagnostics ? clone(source.globalDiagnostics) : null\n');
    replaceOnce('      digest: crypto.createHash("sha256").update(JSON.stringify(identityReview === undefined ? cleanSelected : { observations: cleanSelected, identityReview })).digest("hex")\n',
      '      digest: crypto.createHash("sha256").update(JSON.stringify(cleanSelected)).digest("hex")\n');
    replaceOnce('module.exports = { createMonthlyReportService, buildMonthlyReportSnapshot: buildSnapshot, monthlyReportKeywordMembership, normalizeMonthlyReportIdentityReview };\n',
      'module.exports = { createMonthlyReportService, buildMonthlyReportSnapshot: buildSnapshot, monthlyReportKeywordMembership };\n');
    return source;
  }
  const protectedFiles = ["scripts/collection_rotation_scheduler.cjs", "scripts/daily_keyword_collection_scheduler.cjs",
    "scripts/keyword_worker_scheduler.cjs", "scripts/collector_broker.cjs", "scripts/collector_dispatch.cjs",
    "scripts/operating_web_collector.cjs", "scripts/collector_worker.cjs", "scripts/lib/kosis.cjs", "scripts/lib/regional_market_bootstrap.cjs",
    "scripts/lib/regional_market_missing_weekly.cjs", "scripts/naver_request_pacing.cjs", "scripts/collector_requests.cjs",
    // The separately versioned derived refresh queue changes in this release;
    // its history preservation/admission/deduplication have dedicated tests.
    "scripts/lib/monthly_reports.cjs",
    "web/keyword-monthly-dashboard-model.js", "web/keyword-monthly-benchmark.js"];
  for (const file of protectedFiles) {
    const baseline = execFileSync("git", ["show", `e9cf9b61cf2f9123edb5db40b2520d467cfc0e0b:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const normalizedHash = bytes => createHash("sha256").update(bytes.toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
    const current = fs.readFileSync(path.join(root, file));
    if (file === "scripts/lib/monthly_reports.cjs") {
      const source = current.toString("utf8").replace(/\r\n/g, "\n");
      assert.equal(normalizedHash(restoreApprovedMonthlyMetadata(source)), normalizedHash(baseline), file);
      // Prove the allowance neither hides a count-formula mutation nor accepts
      // an unreviewed change inside the permitted metadata declaration itself.
      assert.ok(source.includes("const sold = number(row.sold);"));
      assert.notEqual(normalizedHash(restoreApprovedMonthlyMetadata(source.replace("const sold = number(row.sold);", "const sold = 0;"))), normalizedHash(baseline));
      assert.throws(() => restoreApprovedMonthlyMetadata(source.replace("const IDENTITY_REVIEW_MAX_ROWS = 100000000;", "const IDENTITY_REVIEW_MAX_ROWS = 100000001;")), /must occur exactly once/);
    } else assert.equal(normalizedHash(current), normalizedHash(baseline), file);
  }
});
