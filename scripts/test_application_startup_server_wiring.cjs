"use strict";
// Execute the actual readiness chain with synthetic adapters and a real local
// listening socket. No application collectors, provider calls or saved data.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),http=require("node:http");
const {createApplicationStartupLifetime}=require("./lib/application_startup_lifetime.cjs");
const source=fs.readFileSync(path.join(__dirname,"glamping_app_server.cjs"),"utf8").replace(/\r\n/g,"\n");
const entry=source.lastIndexOf('\napplicationStartup.phase("seed_outputs"'),startup=source.slice(entry);
assert.ok(entry>0&&startup.includes("server.listen(PORT, HOST"));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,{port=0,coordination=Promise.resolve()}={}){
  const server=http.createServer(),logs=[],calls=[];let ownTimer=null,cleared=0;
  const life=createApplicationStartupLifetime({onLog:event=>logs.push(event),setIntervalImpl:(callback,ms)=>{ownTimer=setInterval(callback,ms);return ownTimer;},clearIntervalImpl:timer=>{assert.equal(timer,ownTimer);clearInterval(timer);cleared++;}});
  life.begin("module_initialization");
  t.after(async()=>{life.fail(Object.assign(new Error(),{code:"SYNTHETIC_TEST_CLEANUP"}));if(server.listening)await new Promise(resolve=>server.close(resolve));});
  const context={Promise,Object,Number,Math,Date,Buffer,PORT:port,HOST:"127.0.0.1",process:{env:{}},console:{log(){},warn(){},error(){}},applicationStartup:life,
    seedOutputsFromRepo:async()=>{calls.push("seed");},collectorBrokerReady:coordination,
    collectionRotationScheduler:{status:async()=>{calls.push("coordination");},start:async()=>{calls.push("rotation-start");}},
    companyBootstrapStore:{get:async()=>{calls.push("company-bootstrap");return {cacheStatus:"synthetic",data:{totalCompanies:1},json:Buffer.from("[]"),gzip:Buffer.from("synthetic")};}},
    monthlyReportSources:{options:async()=>{calls.push("selectors");return {selectorCache:{storage:"synthetic"}};}},
    companyIntegratedCatalog:{prepare:async()=>{calls.push("catalog");},status:()=>({status:"synthetic"})},
    readCompanyIntegratedRevision:Object.assign(async()=>{}, {prepare:async()=>{calls.push("revision");}}),runAnalyticalWork:async operation=>operation(),server,
    companyIntegratedDb:{bootstrap:async()=>{assert.equal(server.listening,true);calls.push("company-background");}},industryAnalysisService:{bootstrap:async()=>{assert.equal(server.listening,true);calls.push("industry-background");}},
    searchDemandScheduler:{start(){}},insightIntegration:null,regionalMarketMissingWeekly:{start(){}},regionalMarketBootstrap:{start(){}},dailyKeywordCollectionScheduler:{start:async()=>({enabled:false})},keywordWorkerSchedulers:{},
    releaseCommittedCollectionPostprocess:async()=>{},collectionPostprocessQueue:{start:async()=>{}},keywordMonthlyRefreshIntegration:{start:async()=>{}},
    tourismVisitorMonthlyScheduler:{start:()=>({enabled:false})},tourismDemandStrengthBackfillScheduler:{start:()=>({enabled:false})},masterDbDualWriteQueue:{mode:"off"},setInterval:()=>({unref(){}})};
  const completed=vm.runInNewContext(startup,context);return {server,life,logs,calls,completed,getTimer:()=>ownTimer,cleared:()=>cleared};
}

test("earliest startup milestone precedes application imports and guarded readiness uses the original work order",async t=>{
  assert.ok(source.indexOf('applicationStartup.begin("module_initialization")')<source.indexOf('const fs = require("node:fs")'));
  const f=await fixture(t);assert.equal(f.getTimer().hasRef(),true);await f.completed;
  assert.equal(f.server.listening,true);assert.ok(f.server.address().port>0);assert.equal(f.server.listenerCount("error"),0);assert.equal(f.life.status().terminal,"listening");assert.equal(f.cleared(),1);assert.equal(f.getTimer()._destroyed,true);
  assert.deepEqual(f.logs.filter(event=>event.event==="phase_start").map(event=>event.phase),["seed_outputs","collector_coordination","rotation_state","company_bootstrap","monthly_selector","integrated_catalog","integrated_revision","listen"]);
  assert.equal(f.logs[0].phase,"module_initialization");assert.deepEqual(f.calls.slice(0,6),["seed","coordination","company-bootstrap","selectors","catalog","revision"]);assert.ok(f.calls.includes("company-background")&&f.calls.includes("industry-background"));
});

test("actual EADDRINUSE rejects readiness, clears the lifetime and never starts aggregate adapters",async t=>{
  const occupied=http.createServer();await new Promise(resolve=>occupied.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>occupied.close(resolve)));
  const f=await fixture(t,{port:occupied.address().port});await assert.rejects(f.completed,{code:"EADDRINUSE"});
  assert.equal(f.server.listening,false);assert.equal(f.life.status().terminal,"failed");assert.equal(f.cleared(),1);assert.equal(f.getTimer()._destroyed,true);assert.ok(!f.calls.includes("company-background"));
  assert.ok(f.logs.some(event=>event.event==="phase_failed"&&event.phase==="listen"&&event.code==="EADDRINUSE"));
});

test("critical coordination failure preserves the original rejection and cannot falsely report readiness",async t=>{
  let reject;const coordination=new Promise((_resolve,fail)=>{reject=fail;}),f=await fixture(t,{coordination});const outcome=f.completed.then(value=>({value}),error=>({error}));await tick();
  assert.equal(f.life.status().phase,"collector_coordination");assert.equal(f.server.listening,false);const error=Object.assign(new Error("private coordination details"),{code:"COORDINATION_SYNTHETIC_FAILURE"});reject(error);
  assert.equal((await outcome).error,error);assert.equal(f.life.status().terminal,"failed");assert.equal(f.cleared(),1);assert.deepEqual(f.calls,["seed"]);assert.ok(!JSON.stringify(f.logs).includes("private coordination"));
});
