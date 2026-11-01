"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, ".."), app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8"), server = fs.readFileSync(path.join(root, "scripts/glamping_app_server.cjs"), "utf8");
const fn = (text, name) => { const source = text.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, "m"))?.[0]; assert.ok(source, name); return source.replace(/\r\n/g,"\n"); };
const baseline = file => execFileSync("git", ["show", "2947bf5e54e82e4719f56a627db973907b597294:" + file], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString("utf8");

test("search demand is a separate administrator-only industry analysis destination", () => {
  const names = ["ROLE_TABS", "ADMIN_MOBILE_SECTIONS", "ADMIN_COMPACT_SECTIONS", "ADMIN_PANEL_MOBILE_TARGETS", "TAB_LABELS"];
  const constants = names.map(name => app.match(new RegExp(`^const ${name} = \\{[^]*?^\\};`, "m"))?.[0]);
  assert.ok(constants.every(Boolean));
  const state = { role: "admin" }, context = vm.createContext({ state, currentRole:()=>state.role, isAdminRole:()=>state.role==="admin" });
  const api = vm.runInContext(constants.join("\n") + "\n" + ["roleTabs","roleAllowsTab","adminPrimarySectionForTab","adminMobileSectionForTab","adminPanelMobileTarget"].map(n=>fn(app,n)).join("\n") + "\n({roleAllowsTab,adminPrimarySectionForTab,adminMobileSectionForTab,ADMIN_MOBILE_SECTIONS,ADMIN_COMPACT_SECTIONS})",context);
  assert.equal(api.roleAllowsTab("searchDemand"),true); assert.equal(api.adminPrimarySectionForTab("searchDemand"),"analysis"); assert.equal(api.adminMobileSectionForTab("searchDemand"),"analysis");
  assert.ok(api.ADMIN_MOBILE_SECTIONS.analysis.items.some(x=>x.tab==="searchDemand")); assert.ok(api.ADMIN_COMPACT_SECTIONS.analysis.items.some(x=>x.tab==="searchDemand"));
  state.role="b2b"; assert.equal(api.roleAllowsTab("searchDemand"),false);
  assert.match(html,/id="searchDemandPanel"[^>]*data-panel="searchDemand"/); assert.ok(html.indexOf('/search-demand-analysis.js')<html.indexOf('/app.js'));
});

function navigation() {
  const calls=[],state={activeTab:"keywordMonthly",adminViewsDeferred:true,adminBootstrapRunPending:"old-run",adminBootstrapSummaryPending:true};
  const saved={keyword:"경남글램핑",month:"2026-09",cutoffDate:"2026-09-25"}, selected={keyword:"경남글램핑",month:"2026-11",day:"2026-11-01"};
  const context={state,document:{getElementById:id=>({id,dataset:{}})},window:{
    KeywordMonthlyAnalysis:{getSelection:()=>saved,pause:()=>calls.push(["monthlyPause"]),show:(host,input)=>calls.push(["monthlyShow",input])},
    SearchDemandAnalysis:{getSelection:()=>selected,pause:()=>calls.push(["searchPause"]),show:(host,input)=>calls.push(["searchShow",input])}},
    isAdminRole:()=>true,roleAllowsTab:()=>true,firstRoleTab:()=>"admin",adminMobileSectionForTab:()=>"analysis",REGION_ANALYSIS_TABS:new Set(),ADMIN_COMPACT_SECTIONS:{},els:{},
    fetchJson:()=>{throw Error("Unexpected source read");},renderAll:()=>{throw Error("Unexpected hidden full render");},resumeAdminBootstrapReads:()=>{throw Error("Unexpected original run read");}};
  for(const name of ["applyAnalysisRegionToDictionary","syncAppHistoryState","applyRoleUi","renderRegionAnalysisShell","renderHeader","closeDrawer"])context[name]=()=>{};
  vm.createContext(context);vm.runInContext(fn(app,"setActiveTab")+"\nthis.navigate=setActiveTab",context);
  return{context,state,calls,saved,selected};
}

test("monthly/search round trip preserves the keyword and original stay-month/cutoff without loading a run",()=>{
  const f=navigation();f.context.navigate("searchDemand");
  const search=f.calls.find(x=>x[0]==="searchShow")[1];assert.equal(search.keyword,"경남글램핑");assert.equal(search.month,undefined);assert.equal(search.day,undefined);
  assert.equal(f.state.adminViewsDeferred,true);assert.equal(f.state.adminBootstrapRunPending,"old-run");
  f.context.navigate("keywordMonthly");const monthly=f.calls.find(x=>x[0]==="monthlyShow")[1];
  assert.deepEqual(JSON.parse(JSON.stringify(monthly)),f.saved);assert.notEqual(monthly.month,f.selected.month);assert.notEqual(monthly.cutoffDate,f.selected.day);
});

test("a late global render cannot overwrite the isolated search demand view",()=>{
  const state={activeTab:"searchDemand"},calls=[];
  const context=vm.createContext({state,isAdminRole:()=>true,renderHeader:()=>calls.push("header")});
  vm.runInContext(fn(app,"renderAll")+"\nrenderAll()",context);assert.deepEqual(calls,["header"]);assert.equal(state.adminViewsDeferred,true);
});

test("application startup requires the approved search policy even when a legacy flag is set",()=>{
  assert.match(server,/enabled: process\.env\.SEARCH_DEMAND_ENABLED === "true"/);
  assert.match(server,/getEnabled: \(\) => searchDemandActivation\.read\(\)/);
  assert.match(server,/createSearchDemandActivation\(\{ rootDir: searchDemandRoot \}\)/);
  assert.match(server,/readKeys: readTrafficKeys/);assert.match(server,/searchDemandScheduler\.start\(\)/);
  assert.ok(server.indexOf('handleSearchDemand(req, res, reqUrl, session)')<server.indexOf('handleKeywordMonthly(req, res, reqUrl, session)'));
  assert.match(app,/window\.SearchDemandAnalysis\?\.clear\(\)/);
});

test("existing lodging collection, limits, guards, original monthly implementation and demand formulas are preserved",()=>{
  const oldApp=baseline("web/app.js"), oldServer=baseline("scripts/glamping_app_server.cjs");
  for(const name of ["demandNextMonthProjection","demandThreeMonthProjection","demandTrafficAggregate","demandTrendSource","demandTrendStats","demandSeasonalTrendEntryForMonth","averageTrendValue"])assert.equal(fn(app,name),fn(oldApp,name),name);
  for(const name of ["collectSearchAdMetric","collectDatalabTrend","metricNumber","enrichRegionsWithTraffic","loadRun"])assert.equal(fn(server,name),fn(oldServer,name),name);
  const files=["scripts/collection_rotation_scheduler.cjs","scripts/daily_keyword_collection_scheduler.cjs","scripts/keyword_worker_scheduler.cjs","scripts/collector_broker.cjs","scripts/collector_dispatch.cjs","scripts/operating_web_collector.cjs","scripts/gyeongnam_glamping_crawl.cjs","scripts/lib/keyword_monthly_analysis.cjs","scripts/lib/keyword_monthly_refresh.cjs","scripts/lib/naver_datalab_connection.cjs"];
  const hash=text=>createHash("sha256").update(text.replace(/\r\n/g,"\n")).digest("hex");
  for(const file of files)assert.equal(hash(fs.readFileSync(path.join(root,file),"utf8")),hash(baseline(file)),file);
});
