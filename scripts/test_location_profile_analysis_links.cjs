"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8").replace(/\r\n/g, "\n");
const master = JSON.parse(fs.readFileSync(path.join(__dirname, "../web/data/region_master.json"), "utf8"));
const names = ["regionMasterUnits", "analysisRegionForKey", "selectedAnalysisRegion", "analysisRunRegion", "locationProfileKeywordKey", "industryRunKeyword", "industryHomeRuns", "locationProfileIndustryRuns", "locationProfileSelectedIndustryRun", "openDictionaryIndustry", "openDictionaryDemand"];
const declarations = names.map((name) => {
  const code = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0];
  assert.ok(code, name);
  return code;
}).join("\n");
const GAPYEONG = "kr_gyeonggi_gapyeong";
const calls = [];
const state = { regionMaster: master, session: { role: "admin" }, analysisRegionSelection: { regionKey: GAPYEONG }, runs: [
  { id: "other", keyword: "포천글램핑", collectedAt: "2026-09-22T03:00:00Z" },
  { id: "old", keyword: "가평 글램핑", collectedAt: "2026-09-20T03:00:00Z" },
  { id: "pension", keyword: "가평펜션", collectedAt: "2026-09-22T01:00:00Z" },
  { id: "glamping", keyword: "가평글램핑", collectedAt: "2026-09-21T03:00:00Z" },
  { id: "ambiguous", keyword: "고성글램핑", collectedAt: "2026-09-22T02:00:00Z" },
  { id: "broad", keyword: "서울근교글램핑", collectedAt: "2026-09-22T02:00:00Z" }
] };
const context = vm.createContext({ state, console, isAdminRole: () => state.session.role === "admin", activeKeyword: () => "가평펜션",
  setActiveTab: (tab) => calls.push(["tab", tab]),
  openIndustryAnalysisRun: async (id) => calls.push(["run", id]) });
const api = vm.runInContext(`${declarations}\n({${names.join(",")}})`, context);
async function main() {
  assert.deepEqual(Array.from(api.locationProfileIndustryRuns(GAPYEONG), (run) => run.id), ["pension", "glamping"], "Offer latest saved run per keyword for this exact region, regardless of currently active industry");
  assert.equal(api.locationProfileIndustryRuns("kr_gyeongnam_goseong").length, 0, "Ambiguous names do not link another region");
  assert.equal(api.locationProfileSelectedIndustryRun(GAPYEONG).id, "pension");
  state.locationProfileIndustrySelections = { [GAPYEONG]: "glamping" };
  assert.equal(api.locationProfileSelectedIndustryRun(GAPYEONG).id, "glamping", "An asynchronous profile repaint preserves the user's industry choice");
  assert.equal(api.locationProfileSelectedIndustryRun("kr_gyeonggi_pocheon").id, "other", "A remembered choice cannot leak into another region");
  state.locationProfileIndustrySelections[GAPYEONG] = "deleted-run";
  assert.equal(api.locationProfileSelectedIndustryRun(GAPYEONG).id, "pension", "A removed result falls back to an available choice");
  await api.openDictionaryIndustry("glamping", GAPYEONG);
  assert.deepEqual(calls.splice(0), [["tab", "industryHome"], ["run", "glamping"]]);
  assert.equal(state.industryHomeFilters.keyword, "가평글램핑");
  await api.openDictionaryIndustry("pension", GAPYEONG);
  assert.deepEqual(calls.splice(0), [["tab", "industryHome"], ["run", "pension"]]);
  await api.openDictionaryIndustry("other", GAPYEONG);
  assert.equal(calls.length, 0, "Forged or stale run selections cannot open another region");
  state.analysisRegionSelection.regionKey = "kr_gyeonggi_pocheon";
  await api.openDictionaryIndustry("pension", GAPYEONG);
  assert.equal(calls.length, 0, "A stale card cannot redirect a changed region");
  state.analysisRegionSelection.regionKey = GAPYEONG;
  state.session.role = "b2b";
  await api.openDictionaryIndustry("pension", GAPYEONG);
  assert.equal(calls.length, 0, "Admin saved-run access remains restricted");
  state.session.role = "admin";
  api.openDictionaryDemand();
  assert.deepEqual(calls.splice(0), [["tab", "demand"]], "Demand navigation requires no strength observations or provider call");
  console.log("Regional profile links: latest per-industry saved results, exact-region boundaries, stale cards, admin access, and ungated demand navigation passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
