"use strict";
// Execute the actual readiness chain with synthetic adapters and a real local
// listening socket. No application collectors, provider calls or saved data.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),http=require("node:http");
const {createApplicationStartupLifetime}=require("./lib/application_startup_lifetime.cjs");
const source=fs.readFileSync(path.join(__dirname,"glamping_app_server.cjs"),"utf8").replace(/\r\n/g,"\n");
const entry=source.lastIndexOf('\napplicationStartup.phase("seed_outputs"'),startup=source.slice(entry);
assert.ok(entry>0&&startup.includes("server.listen(PORT, HOST"));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const POLICY_SHA="7eb899d12bb6becb3be52290b482c79a58f3a89cb22c294e3189828dd593cf6a";
async function fixture(t,{port=0,coordination=Promise.resolve(),retire=null,loggerError=false,platform="linux",dataDir="/var/data",codeRoot="/opt/render/project/src"}={}){
  const server=http.createServer(),logs=[],calls=[],retirementLogs=[],retirementInputs=[];let ownTimer=null,cleared=0;
  const life=createApplicationStartupLifetime({onLog:event=>logs.push(event),setIntervalImpl:(callback,ms)=>{ownTimer=setInterval(callback,ms);return ownTimer;},clearIntervalImpl:timer=>{assert.equal(timer,ownTimer);clearInterval(timer);cleared++;}});
  life.begin("module_initialization");
  t.after(async()=>{life.fail(Object.assign(new Error(),{code:"SYNTHETIC_TEST_CLEANUP"}));if(server.listening)await new Promise(resolve=>server.close(resolve));});
  const context={Promise,Object,Number,Math,Date,Buffer,PORT:port,HOST:"127.0.0.1",process:{platform,env:{}},console:{log(){},warn(){},error(){},info:(event,value)=>{if(loggerError)throw Error("synthetic logger failure");retirementLogs.push({event,...JSON.parse(value)});}},applicationStartup:life,
    fsp:{lstat:async()=>({uid:0,gid:0,mode:0o755,isDirectory:()=>true,isSymbolicLink:()=>false}),realpath:async file=>file},
    path:path.posix,DATA_DIR:dataDir,ROOT:codeRoot,runFixedB3BootRetirement:async input=>{
      retirementInputs.push(JSON.parse(JSON.stringify(input)));
      assert.deepEqual(JSON.parse(JSON.stringify(input)),{dataDir:"/var/data",codeRoot:"/opt/render/project/src",policyPath:"/opt/render/project/src/config/reviewed-b3-maintenance-retirement-20261116.json",policySha256:POLICY_SHA});
      return retire?retire(input,calls):{status:"not_target",policySha256:POLICY_SHA,completionReceiptSha256:null,actualCommitRuntimeAudit:{source:"git_metadata",available:false,commit:null},runtimeDeploymentId:null};
    },
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
  const completed=vm.runInNewContext(startup,context);return {server,life,logs,calls,retirementLogs,retirementInputs,completed,getTimer:()=>ownTimer,cleared:()=>cleared};
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

test("actual reviewed retirement hook completes before company preparation and reports only coordination metadata changed",async t=>{
  const f=await fixture(t,{retire:async(_input,calls)=>{calls.push("reviewed-retirement");return {status:"archived",auditRoot:"/synthetic/private-audit",policySha256:POLICY_SHA,completionReceiptSha256:"a".repeat(64),actualCommitRuntimeAudit:{source:"git_metadata",available:false,commit:null},privateProof:"must not be logged"};}});await f.completed;
  assert.deepEqual(f.calls.slice(0,4),["seed","coordination","reviewed-retirement","company-bootstrap"]);assert.equal(f.server.listening,true);
  const log=f.retirementLogs.find(row=>row.event==="application_startup_b3_retirement");assert.equal(log.status,"archived");assert.equal(log.coordinationMetadataChanged,true);assert.equal(log.runtimeDeploymentId,null);assert.ok(!JSON.stringify(log).includes("must not be logged"));
});

test("NEEDS_READBACK from actual retirement blocks company preparation, listen and aggregate adapters without swallowing the original failure",async t=>{
  const error=Object.assign(new Error("private audit details"),{code:"B3_ARCHIVE_NEEDS_READBACK",mutationState:"rename_attempted_uncertain"});
  const f=await fixture(t,{retire:async()=>{throw error;}});await assert.rejects(f.completed,value=>value===error);
  assert.deepEqual(f.calls,["seed","coordination"]);assert.equal(f.server.listening,false);assert.equal(f.life.status().terminal,"failed");assert.equal(f.cleared(),1);assert.ok(!JSON.stringify(f.logs).includes("private audit"));assert.ok(!f.retirementLogs.some(row=>row.event==="application_startup_b3_retirement"));
});

test("a new current guard not_target keeps the normal guarded startup path and does not claim a coordination mutation",async t=>{
  const f=await fixture(t,{retire:async(_input,calls)=>{calls.push("new-guard-preserved");return {status:"not_target",policySha256:POLICY_SHA,completionReceiptSha256:null,actualCommitRuntimeAudit:{source:"git_metadata",available:false,commit:null}};}});await f.completed;
  assert.ok(f.calls.indexOf("new-guard-preserved")<f.calls.indexOf("company-bootstrap"));assert.ok(f.calls.includes("company-background"));
  const log=f.retirementLogs.find(row=>row.event==="application_startup_b3_retirement");assert.equal(log.status,"not_target");assert.equal(log.coordinationMetadataChanged,false);assert.equal(f.life.status().terminal,"listening");
});

test("a retirement logger failure cannot suppress verified success or bypass the remaining startup guards",async t=>{
  const f=await fixture(t,{loggerError:true});await f.completed;assert.equal(f.server.listening,true);assert.ok(f.calls.includes("company-bootstrap")&&f.calls.includes("revision"));assert.equal(f.life.status().terminal,"listening");
});

test("Windows and nonmatching local or service paths skip retirement explicitly and preserve normal startup",async t=>{
  for(const runtime of [{platform:"win32",dataDir:"C:/synthetic/data",codeRoot:"C:/synthetic/code"},{platform:"win32"},{dataDir:"/synthetic/other-data"},{codeRoot:"/synthetic/other-code"}]){
    const f=await fixture(t,{...runtime,retire:async()=>{assert.fail("nonmatching runtime must not invoke retirement");}});await f.completed;
    assert.equal(f.retirementInputs.length,0);assert.equal(f.server.listening,true);assert.ok(f.calls.includes("company-bootstrap")&&f.calls.includes("revision"));assert.equal(f.life.status().terminal,"listening");
    const log=f.retirementLogs.find(row=>row.event==="application_startup_b3_retirement");assert.deepEqual(log,{event:"application_startup_b3_retirement",status:"not_applicable_runtime",retirementAttempted:false,coordinationMetadataChanged:false});
  }
});

test("actual parent diagnostic reads only ten fixed directory metadata paths and cannot interrupt the unchanged critical check",async()=>{
  const begin=source.indexOf("// Fixed read-only B3 parent metadata;"),end=source.indexOf("// End fixed read-only B3 parent metadata;",begin),block=source.slice(begin,end);assert.ok(begin>0&&end>begin);
  const expected=["/","/opt","/opt/render","/opt/render/project","/opt/render/project/src","/opt/render/project/src/config","/opt/render/project/src/scripts","/opt/render/project/src/scripts/lib","/var","/var/data"];
  for(const fails of [false,true]){const paths=[],logs=[];let critical=0;const context={fsp:{lstat:async file=>{paths.push(file);if(fails&&file==="/opt")throw Error("private filesystem details");return {uid:0,gid:1000,mode:0o2775,isDirectory:()=>true,isSymbolicLink:()=>false,privateValue:"never output"};},realpath:async file=>file},console:{info:(event,json)=>{if(fails)throw Error("private logger");logs.push({event,...JSON.parse(json)});}},critical:()=>{critical++;}};
    await vm.runInNewContext("(async()=>{"+block+";critical();})()",context);assert.deepEqual(paths,expected);assert.equal(critical,1);
    if(!fails){assert.equal(logs.length,1);assert.equal(logs[0].readOnly,true);assert.equal(logs[0].parents.length,10);assert.deepEqual(Object.keys(logs[0].parents[0]),["path","uid","gid","mode","isDir","symlink","realpathEqual"]);assert.ok(!JSON.stringify(logs).includes("never output"));}
  }
});
