"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fixture, POCHEON, SANCHEONG } = require("./test_region_analysis_navigation.cjs");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const names = ["regionHomeMatchingRegions", "regionHomeOptionsHtml", "regionHomeSavedRuns", "regionHomeAvailabilityHtml", "updateRegionHomeDraft", "openRegionHomeAnalysis", "renderRegionHome", "analysisRunCollectedLabel", "analysisRunPeriod", "analysisRunPeriodLabel"];
const declarations = names.map((name) => {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(declaration, `Missing actual function ${name}`);
  return declaration;
}).join("\n");
const GYEONGNAM_GOSEONG = "kr_admin_4882000000";
const GANGWON_GOSEONG = "kr_admin_5182000000";
const RETIRED_GOSEONG = "kr_admin_4282000000";
const detailTabs = ["dictionary", "map", "demand", "regionCompare", "regionSources"];

function homeFixture(options) {
  const f = fixture(options);
  f.state.activeTab = "regionHome";
  f.state.regionHomeQuery = "";
  f.state.regionHomeCandidateKey = "";
  f.state.lastRegionAnalysisTab = "dictionary";
  const fields = Object.fromEntries(["#regionHomeSelect", "[data-region-home-preview]", "[data-region-home-submit]"].map((selector) => [selector, { innerHTML: "", disabled: false }]));
  f.els.regionHomeDashboard = { innerHTML: "", querySelector: (selector) => fields[selector] || null };
  f.context.TAB_LABELS = { dictionary: "지역 현황", map: "지역 지도", demand: "수요 전망", regionCompare: "지역 비교", regionSources: "자료·출처" };
  const api = vm.runInContext(`${declarations}\n({ ${names.join(", ")} })`, f.context);
  return { ...f, home: api, fields };
}

function main() {
  const f = homeFixture();
  f.api.setAnalysisRegion(POCHEON, { render: false, history: false });
  const beforeDraft = JSON.stringify([f.state.analysisRegionSelection, f.state.activeRunId, f.state.data]);
  f.state.regionHomeQuery = "산청";
  f.state.regionHomeCandidateKey = SANCHEONG;
  f.home.updateRegionHomeDraft();
  assert.equal(JSON.stringify([f.state.analysisRegionSelection, f.state.activeRunId, f.state.data]), beforeDraft, "Drafting a different region cannot change the shared region or loaded collection");
  assert.equal(f.state.activeTab, "regionHome");
  assert.equal(f.fields["[data-region-home-submit]"].disabled, false);
  assert.match(f.fields["[data-region-home-preview]"].innerHTML, /산청군/);
  f.state.regionHomeQuery = "해당하지 않는 지역";
  f.home.updateRegionHomeDraft();
  assert.equal(f.state.regionHomeCandidateKey, "");
  assert.equal(f.fields["[data-region-home-submit]"].disabled, true);
  assert.equal(JSON.stringify([f.state.analysisRegionSelection, f.state.activeRunId, f.state.data]), beforeDraft);

  assert.deepEqual(Array.from(f.home.regionHomeMatchingRegions("고성"), (region) => region.regionKey).sort(), [GYEONGNAM_GOSEONG, GANGWON_GOSEONG].sort(), "Same-name counties remain separate and retired Gangwon codes are excluded");
  assert.deepEqual(Array.from(f.home.regionHomeMatchingRegions("경남 고성"), (region) => region.regionKey), [GYEONGNAM_GOSEONG]);
  assert.deepEqual(Array.from(f.home.regionHomeMatchingRegions("강원 고성"), (region) => region.regionKey), [GANGWON_GOSEONG]);
  assert.ok(f.home.regionHomeMatchingRegions("").every((region) => region.active && region.selectable));
  f.state.regionHomeQuery = "고성";
  const options = f.home.regionHomeOptionsHtml();
  assert.match(options, /경상남도 고성군/);
  assert.match(options, /강원특별자치도 고성군/);
  assert.doesNotMatch(options, new RegExp(RETIRED_GOSEONG));

  for (const tab of detailTabs) {
    f.state.lastRegionAnalysisTab = tab;
    assert.equal(f.home.openRegionHomeAnalysis(SANCHEONG, true), true);
    assert.equal(f.state.activeTab, tab, `Resume returns to ${tab}`);
    assert.equal(f.state.analysisRegionSelection.regionKey, SANCHEONG);
    assert.equal(f.state.analysisRegionSelection.explicit, true);
    assert.equal(f.state.activeRunId, "run-pocheon", "Opening a region does not auto-load or rerun a collection");
  }
  f.state.lastRegionAnalysisTab = "admin";
  assert.equal(f.home.openRegionHomeAnalysis(POCHEON, true), true);
  assert.equal(f.state.activeTab, "dictionary", "Invalid resume destinations fall back to regional overview");
  f.state.lastRegionAnalysisTab = "demand";
  assert.equal(f.home.openRegionHomeAnalysis(SANCHEONG, false), true);
  assert.equal(f.state.activeTab, "dictionary", "A fresh explicit selection starts at regional overview");
  const selectedBeforeBad = JSON.stringify([f.state.analysisRegionSelection, f.state.activeTab, f.state.activeRunId]);
  for (const key of ["", "not-a-region", RETIRED_GOSEONG]) assert.equal(f.home.openRegionHomeAnalysis(key), false);
  assert.equal(JSON.stringify([f.state.analysisRegionSelection, f.state.activeTab, f.state.activeRunId]), selectedBeforeBad);
  assert.equal(f.calls.fetch.length, 0, "Home navigation does not collect or request stored runs automatically");

  const dates = homeFixture();
  dates.state.runs = [
    { id: "san-new", keyword: "산청글램핑", collectedAt: "2026-09-21T05:00:00Z", checkIn: "2026-09-21", bookingRangeDays: 31 },
    { id: "po-real", keyword: "포천글램핑", collectedAt: "2026-09-18T05:12:00Z", checkIn: "2026-09-18", bookingRangeDays: 31 },
    { id: "ambiguous", keyword: "고성글램핑", collectedAt: "2026-09-21T06:00:00Z" },
    { id: "gyeongnam", keyword: "경남고성글램핑", collectedAt: "2026-09-17T05:00:00Z" },
    { id: "gangwon", keyword: "강원고성글램핑" },
    { id: "broad", keyword: "서울근교글램핑" }
  ];
  assert.deepEqual(Array.from(dates.home.regionHomeSavedRuns(dates.api.analysisRegionForKey(POCHEON)), (run) => run.id), ["po-real"]);
  assert.deepEqual(Array.from(dates.home.regionHomeSavedRuns(dates.api.analysisRegionForKey(GYEONGNAM_GOSEONG)), (run) => run.id), ["gyeongnam"]);
  const availability = dates.home.regionHomeAvailabilityHtml(dates.api.analysisRegionForKey(POCHEON));
  assert.match(availability, /2026\.09\.18 14:12/);
  assert.doesNotMatch(availability, /2026\.09\.21|산청|2026\.09\.17/);
  assert.match(availability, /관광 자료 갱신일.*자료·출처에서 항목별 확인/);
  const unknownDates = dates.home.regionHomeAvailabilityHtml(dates.api.analysisRegionForKey(GANGWON_GOSEONG));
  assert.match(unknownDates, /마지막 숙박 수집일<\/dt><dd>확인 전/);
  assert.doesNotMatch(unknownDates, /\d{4}\.\d{2}\.\d{2}/);
  const noSavedRegion = dates.home.regionHomeMatchingRegions("여수시")[0];
  assert.ok(noSavedRegion, "Use an actual selectable region without a saved run");
  const emptyDates = dates.home.regionHomeAvailabilityHtml(noSavedRegion);
  assert.match(emptyDates, /저장된 숙박 수집<\/dt><dd>아직 없음/);
  assert.match(emptyDates, /마지막 숙박 수집일<\/dt><dd>자료 없음/);
  assert.doesNotMatch(emptyDates, /\d{4}\.\d{2}\.\d{2}/);

  dates.api.reconcileAnalysisRegionSelection();
  assert.equal(dates.state.analysisRegionSelection.explicit, false);
  dates.home.renderRegionHome();
  assert.doesNotMatch(dates.els.regionHomeDashboard.innerHTML, /aria-label="이전 지역 분석 이어보기"/, "An inferred collection region is not presented as a manually selected analysis to resume");
  assert.match(dates.els.regionHomeDashboard.innerHTML, /자료 수집일 2026\.09\.18 14:12/);
  assert.match(dates.els.regionHomeDashboard.innerHTML, /대상 숙박기간 2026\.09\.18 ~ 2026\.10\.18 \(31일\)/);
  assert.doesNotMatch(dates.els.regionHomeDashboard.innerHTML, /서울근교글램핑/);
  dates.api.setAnalysisRegion(POCHEON, { explicit: true, history: false, render: false });
  dates.state.lastRegionAnalysisTab = "demand";
  dates.home.renderRegionHome();
  assert.match(dates.els.regionHomeDashboard.innerHTML, /aria-label="이전 지역 분석 이어보기"/);
  assert.match(dates.els.regionHomeDashboard.innerHTML, /수요 전망에서 이어서 확인/);
  assert.match(dates.els.regionHomeDashboard.innerHTML, /data-region-home-open="kr_gyeonggi_pocheon" data-region-home-resume/);

  const member = homeFixture({ role: "b2b" });
  const beforeMember = JSON.stringify(member.state);
  assert.equal(member.home.openRegionHomeAnalysis(POCHEON), false);
  member.home.updateRegionHomeDraft();
  assert.equal(JSON.stringify(member.state), beforeMember);
  member.els.regionHomeDashboard.innerHTML = "administrative content";
  member.home.renderRegionHome();
  assert.equal(member.els.regionHomeDashboard.innerHTML, "");
  assert.equal(member.calls.fetch.length, 0);
  console.log("Region analysis home: independent draft, explicit selection, five-view resume, bad/retired/role guards, qualified counties, region-isolated saved dates and inferred-selection distinction passed");
}

main();
