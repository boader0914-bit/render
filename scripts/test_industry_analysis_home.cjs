"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "web", "app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["escapeHtml", "compactSearchText", "detectLodgingCategoryKey", "analysisRunCollectedLabel", "analysisRunPeriod", "analysisRunPeriodLabel", "industryRunKeyword", "industryRunCategoryKey", "industryHomeRuns", "industryRecentRuns", "rememberIndustryAnalysisRun", "industryHomeRunRow", "renderIndustryHome", "openIndustryAnalysisRun", "changeIndustryHomeFilter"];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `${name} exists`);
  return declaration;
});
const profiles = source.match(/^const LODGING_CATEGORY_PROFILES = \{[^]*?^};/m)?.[0];
const runs = [
  { id: "pocheon-new", keyword: "포천글램핑", collectedAt: "2026-09-21T05:31:00.000Z", updatedAt: "2026-09-22T08:00:00.000Z", checkIn: "2026-09-21", checkOut: "2026-09-22", bookingRangeDays: 31, detailRankRanges: "1-20" },
  { id: "seoul-near", keyword: "서울근교글램핑", collectedAt: "2026-09-20T05:00:00.000Z", checkIn: "2026-09-20", checkOut: "2026-09-21", bookingRangeDays: 31 },
  { id: "pocheon-old", keyword: "포천글램핑", collectedAt: "2026-09-19T05:00:00.000Z", checkIn: "2026-09-19", bookingRangeDays: 7 },
  { id: "hotel", keyword: "부산호텔", collectedAt: "2026-09-18T05:00:00.000Z", checkIn: "2026-09-18", checkOut: "2026-09-19", bookingRangeDays: 1 },
  { id: "unclassified", keyword: "포천의 작은 쉼터", updatedAt: "2026-09-21T05:00:00.000Z", checkIn: "2026-09-15" }
];

function fixture({ admin = true, storage = new Map(), load } = {}) {
  const state = {
    session: { username: "fixture-admin" }, runs: structuredClone(runs), activeRunId: "pocheon-new", activeTab: "industryHome",
    analysisNavigationSequence: 1, industryHomeOpenSequence: 0, industryHomeVisibleCount: 12,
    industryHomeFilters: { category: "", keyword: "", period: "" }, industryRecentRunIds: null,
    industryRecentStorageKey: "", industryHomeLoadingRunId: "", industryHomeError: ""
  };
  const dashboard = { innerHTML: "", querySelector: () => ({ focus() {} }) };
  const calls = [];
  const context = vm.createContext({
    state, els: { industryHomeDashboard: dashboard }, console, Intl, Date,
    isAdminRole: () => admin, DEFAULT_LODGING_CATEGORY_KEY: "glamping", fmtNumber: String,
    collectionPurposeProfile: () => ({ label: "상세 수집" }),
    window: { localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
    loadRun: async (runId) => {
      calls.push(`load:${runId}`);
      const result = load ? await load(runId) : { run: state.runs.find((run) => run.id === runId) };
      if (result) { state.activeRunId = runId; state.data = result; }
      return result;
    },
    setActiveTab: (tab) => { state.activeTab = tab; state.analysisNavigationSequence += 1; calls.push(`tab:${tab}`); }
  });
  const api = vm.runInContext(`${profiles}\n${declarations.join("\n")}\n({${names.join(",")}})`, context);
  return { api, state, dashboard, calls, storage };
}

async function main() {
  const basic = fixture();
  assert.equal(basic.api.analysisRunCollectedLabel(runs[0]), "2026.09.21 14:31");
  assert.equal(basic.api.analysisRunCollectedLabel({ ...runs[0], collectedAtSource: "recorded" }), "2026.09.21 14:31");
  assert.equal(basic.api.analysisRunCollectedLabel({ ...runs[0], collectedAtSource: "filesystem" }), "확인 전 (저장 시점 2026.09.21 14:31)", "A preserved directory timestamp cannot be presented as the actual collection time");
  assert.equal(basic.api.analysisRunCollectedLabel(runs[4]), "확인 전", "Filesystem update time is not substituted for the collection timestamp");
  assert.equal(basic.api.analysisRunCollectedLabel({ collectedAt: "invalid" }), "확인 전");
  assert.equal(basic.api.analysisRunPeriodLabel(runs[0]), "2026.09.21 ~ 2026.10.21 (31일)", "Rolling observation window uses bookingRangeDays, not a one-night checkOut");
  assert.equal(basic.api.analysisRunPeriodLabel(runs[3]), "2026.09.18 (1일)", "Check-out day is not counted as an additional stay day");
  assert.equal(basic.api.analysisRunPeriodLabel({ checkIn: "2026-02-30", bookingRangeDays: 31 }), "확인 전");
  assert.equal(basic.api.analysisRunPeriodLabel({ bookingRangeDays: 31 }), "확인 전", "Missing stay dates do not fall back to today");
  assert.equal(basic.api.industryRunCategoryKey(runs[4]), "unknown", "Unclassified company queries cannot silently become glamping");
  assert.equal(basic.api.industryRunCategoryKey(runs[3]), "hotelResort");
  basic.api.renderIndustryHome();
  assert.match(basic.dashboard.innerHTML, /서울근교글램핑/);
  assert.match(basic.dashboard.innerHTML, /자료 수집일 2026\.09\.21 14:31/);
  assert.match(basic.dashboard.innerHTML, /분석 대상 숙박기간 2026\.09\.21 ~ 2026\.10\.21/);
  assert.doesNotMatch(basic.dashboard.innerHTML, /이전 분석 이어보기/, "Background activeRunId does not create a previous analysis");
  assert.equal(basic.calls.length, 0, "Rendering the home cannot load an analysis or collect data");
  basic.api.changeIndustryHomeFilter("category", "glamping");
  assert.doesNotMatch(basic.dashboard.innerHTML, /data-industry-open-run="hotel"/);
  basic.api.changeIndustryHomeFilter("keyword", "포천글램핑");
  assert.doesNotMatch(basic.dashboard.innerHTML, /data-industry-open-run="seoul-near"/);
  basic.api.changeIndustryHomeFilter("period", "2026-09-19:7");
  assert.match(basic.dashboard.innerHTML, /data-industry-open-run="pocheon-old"/);
  assert.doesNotMatch(basic.dashboard.innerHTML, /data-industry-open-run="pocheon-new"/);
  basic.api.changeIndustryHomeFilter("category", "pension");
  assert.equal(basic.state.industryHomeFilters.keyword, "");
  assert.equal(basic.state.industryHomeFilters.period, "");
  assert.match(basic.dashboard.innerHTML, /선택 조건에 맞는 저장 자료가 없습니다/);
  assert.match(basic.dashboard.innerHTML, /data-industry-home-collect/);
  assert.equal(basic.calls.length, 0, "Filtering and empty states cannot trigger a crawl or report load");

  const opened = fixture();
  await opened.api.openIndustryAnalysisRun("pocheon-old");
  assert.equal(opened.state.activeTab, "report");
  assert.deepEqual(opened.calls, ["load:pocheon-old", "tab:report"]);
  assert.deepEqual(Array.from(opened.state.industryRecentRunIds), ["pocheon-old"]);
  opened.state.activeTab = "industryHome";
  opened.api.renderIndustryHome();
  assert.match(opened.dashboard.innerHTML, /이전 분석 이어보기/);
  const restored = fixture({ storage: opened.storage });
  assert.equal(restored.api.industryRecentRuns()[0].id, "pocheon-old");
  restored.state.session.username = "other-admin";
  assert.equal(restored.api.industryRecentRuns().length, 0, "Another account does not inherit the previous account's resume list");
  const missing = fixture();
  await missing.api.openIndustryAnalysisRun("removed-run");
  assert.equal(missing.calls.length, 0);

  let resolveLate;
  const late = fixture({ load: () => new Promise((resolve) => { resolveLate = resolve; }) });
  const pending = late.api.openIndustryAnalysisRun("pocheon-old");
  late.state.activeTab = "regionHome";
  late.state.analysisNavigationSequence += 1;
  late.state.activeTab = "industryHome";
  late.state.analysisNavigationSequence += 1;
  resolveLate({ run: runs[2] });
  await pending;
  assert.equal(late.state.activeTab, "industryHome", "Returning to the home during a pending load cannot be overridden by its late response");
  assert.equal(late.api.industryRecentRuns().length, 0, "A request that never opened report does not count as viewed");

  let resolveFiltered;
  const filtered = fixture({ load: () => new Promise((resolve) => { resolveFiltered = resolve; }) });
  const oldFilterRequest = filtered.api.openIndustryAnalysisRun("pocheon-old");
  filtered.api.changeIndustryHomeFilter("category", "hotelResort");
  resolveFiltered({ run: runs[2] });
  await oldFilterRequest;
  assert.equal(filtered.state.activeTab, "industryHome", "Changing conditions cancels pending automatic navigation");
  assert.equal(filtered.state.industryHomeLoadingRunId, "");

  const superseded = fixture({ load: async () => null });
  await superseded.api.openIndustryAnalysisRun("pocheon-old");
  assert.equal(superseded.state.activeTab, "industryHome", "A loadRun superseded by another request cannot open the wrong report");
  const failed = fixture({ load: async () => { throw new Error("검증용 응답 실패"); } });
  await failed.api.openIndustryAnalysisRun("pocheon-old");
  assert.match(failed.dashboard.innerHTML, /저장된 분석을 불러오지 못했습니다/);
  assert.equal(failed.api.industryRecentRuns().length, 0);
  assert.equal(failed.state.industryHomeLoadingRunId, "");

  const b2b = fixture({ admin: false });
  b2b.api.renderIndustryHome();
  b2b.api.changeIndustryHomeFilter("category", "hotelResort");
  await b2b.api.openIndustryAnalysisRun("pocheon-old");
  assert.equal(b2b.dashboard.innerHTML, "");
  assert.equal(b2b.calls.length, 0, "B2B and admin user-view cannot use admin run access");
  assert.equal(b2b.storage.size, 0);
  console.log("Industry analysis home: date provenance, full stay-period filters, actual search scopes, explicit report entry, account-separated resume, stale-response and role boundaries passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
