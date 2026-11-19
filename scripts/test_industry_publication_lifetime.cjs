"use strict";
// Small synthetic publication lifetime fixtures. No real data, network, GC or application import.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createIndustryAnalysisStore } = require("./lib/industry_analysis_store.cjs");
const { createIndustryAnalysisService } = require("./lib/industry_analysis.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { createIndustrySourceRevision, industrySourceRevisionOwnedCapability } = require("./lib/industry_source_revision.cjs");
const NOW = new Date("2026-10-11T00:00:00Z");
const REQUEST = { industry: "glamping", region: "all", month: "2026-09", cutoffDate: "2026-09-30" };
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (const end = performance.now() + 1500; performance.now() < end;) { if (check()) return; await turn(); } assert.fail("bounded synthetic progress not observed"); }
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "industry-lease-check-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("industry-lease-check-")); await fs.rm(root, { recursive: true, force: true }); });
  return root;
}
const result = (request, sold = 1) => ({ request, summary: { sold }, period: { monthClosed: true }, generatedAt: NOW.toISOString() });
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const temporary = file + ".synthetic.tmp"; await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
function emptySources() { return { loadSourcesWithCatalog: async () => ({ source: { companies: [], regions: [], runs: [], observations: [], rankObservations: [], savedProductRecoveries: [], warnings: [] }, catalog: { companies: [], regions: [], runs: [], rawCompanies: new Map() } }) }; }

test("real scheduler holds the same owner through source check and result/state publication, returning no DTO",async t=>{
 const dataDir=await directory(t),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000}),entered=gate(),release=gate();let ownedCalculate=false,otherStarted=false,ownerResults=[];
 const store=createIndustryAnalysisStore({dataDir,now:()=>NOW,autoStart:false,runWork:async(op,opts)=>{const value=await scheduler.run(op,opts);ownerResults.push(value);return value;},calculate:async request=>{ownedCalculate=scheduler.status().activeKind==="industry-build";return result(request);},writeJson:async(file,value)=>{if(file.includes(path.sep+"results"+path.sep)){assert.equal(scheduler.status().activeKind,"industry-build");const permit=scheduler.acquireSavedReadPermit();assert.equal(permit.acceptsNewResponses(),false);permit.release();entered.resolve();await release.promise;}await writeJson(file,value);}});
 t.after(async()=>{release.resolve();await store.stop();await scheduler.close();});await store.get(REQUEST);const drain=store.drain();await entered.promise;const other=scheduler.run(()=>{otherStarted=true;},{priority:"background",kind:"company-month"});await turn();assert.equal(otherStarted,false);release.resolve();await drain;await other;assert.equal(ownedCalculate,true);assert.deepEqual(ownerResults,[undefined]);assert.equal((await store.get(REQUEST)).storage.status,"ready");
});

test("prepublication saved-read loan waits through producer release before atomic publication and never restarts",async t=>{
 const dataDir=await directory(t),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000}),checking=gate(),continueCheck=gate(),borrowed=gate(),finishRead=gate();let clock=NOW.getTime(),checks=0,writes=0,calculates=0;
 const store=createIndustryAnalysisStore({dataDir,now:()=>new Date(clock),autoStart:false,runWork:(op,opts)=>scheduler.run(op,opts),readSourceRevisionOwned:async()=>{if(++checks===2){checking.resolve();await continueCheck.promise;}return"same";},readSourceRevision:async()=>{if(++checks===2){checking.resolve();await continueCheck.promise;}return"same";},calculate:async request=>{calculates++;clock+=30001;return result(request);},writeJson:async(file,value)=>{if(file.includes(path.sep+"results"+path.sep)){writes++;assert.equal(scheduler.status().savedRead.active,false);}await writeJson(file,value);}});
 t.after(async()=>{continueCheck.resolve();finishRead.resolve();await store.stop();await scheduler.close();});await store.get(REQUEST);const drain=store.drain();await checking.promise;const permit=scheduler.acquireSavedReadPermit(),read=permit.run(async()=>{borrowed.resolve();await finishRead.promise;return{saved:true};});continueCheck.resolve();await borrowed.promise;assert.equal(writes,0);finishRead.resolve();assert.deepEqual(await read,{saved:true});await turn();assert.equal(writes,0,"producer completion alone must not release the loan");permit.release();await permit.waitForRelease();await drain;assert.equal(writes,1);assert.equal(calculates,1);assert.equal(scheduler.status().timing.restarted,0);
});

test("owned fresh check rejects changed generation while an external check waits and publishes only its replacement",async t=>{
 const dataDir=await directory(t),outputsDir=path.join(dataDir,"outputs"),master=path.join(dataDir,"company_master/companies.json"),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000}),entered=gate(),proceed=gate(),{createIndustrySourceRevision}=require("./lib/industry_source_revision.cjs");await fs.mkdir(path.dirname(master),{recursive:true});await fs.mkdir(outputsDir);await fs.writeFile(master,JSON.stringify({companies:{},marker:"one"}));let clock=NOW.getTime(),calculates=0,writes=[];const actual=createIndustrySourceRevision({dataDir,outputsDir,runWork:(op,opts)=>scheduler.run(op,opts)}),read=()=>actual.periodRevisions();
 const store=createIndustryAnalysisStore({dataDir,now:()=>new Date(clock),autoStart:false,runWork:(op,opts)=>scheduler.run(op,opts),readSourceRevision:read,readSourceRevisionOwned:read,calculate:async request=>{const value=++calculates;clock+=30001;if(value===1){entered.resolve();await proceed.promise;}return result(request,value);},writeJson:async(file,value)=>{if(file.includes(path.sep+"results"+path.sep))writes.push(value.result.summary.sold);await writeJson(file,value);}});t.after(async()=>{proceed.resolve();await store.stop();await scheduler.close();});await store.get(REQUEST);const drain=store.drain();await entered.promise;await fs.writeFile(master,JSON.stringify({companies:{},marker:"two"}));const external=store.get(REQUEST);await until(()=>scheduler.status().queuedBackground===1);proceed.resolve();await drain;await external;assert.equal(calculates,2);assert.deepEqual(writes,[2]);const value=await store.get(REQUEST);assert.equal(value.summary.sold,2);assert.equal(value.storage.sourceRevision,value.storage.resultRevision);
});

test("trusted owned verification failure preserves the prior normal result and records the same safe error",async t=>{
 const dataDir=await directory(t),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000}),entered=gate(),proceed=gate();let clock=NOW.getTime(),calculates=0,fail=false;const read=()=>scheduler.run(()=>"same",{priority:"background",kind:"industry-source-revision"});
 const store=createIndustryAnalysisStore({dataDir,now:()=>new Date(clock),autoStart:false,runWork:(op,opts)=>scheduler.run(op,opts),readSourceRevision:read,readSourceRevisionOwned:async()=>{if(fail)throw Object.assign(Error("synthetic private source failure"),{code:"SOURCE_UNAVAILABLE"});return read();},calculate:async request=>{const value=++calculates;if(value===2){clock+=30001;entered.resolve();await proceed.promise;}return result(request,value);}});t.after(async()=>{proceed.resolve();await store.stop();await scheduler.close();});await store.get(REQUEST);await store.drain();const files=await fs.readdir(path.join(dataDir,"industry_analysis/results")),file=path.join(dataDir,"industry_analysis/results",files[0]),before=await fs.readFile(file);await store.rebuild(REQUEST);const drain=store.drain();await entered.promise;fail=true;const external=store.get(REQUEST);await until(()=>scheduler.status().queuedBackground===1);proceed.resolve();await drain;await external;assert.ok(before.equals(await fs.readFile(file)));const value=await store.get(REQUEST);assert.equal(value.summary.sold,1);assert.equal(value.storage.errorCode,"SOURCE_UNAVAILABLE");
});


test("legacy custom service source adapters retain old detached-calculator behavior and unsafe direct-store ownership is rejected",async t=>{
 assert.throws(()=>createIndustryAnalysisStore({dataDir:"fixture",calculate:async()=>{},runWork:op=>op(),readSourceRevision:async()=>"legacy"}),/owner-aware/);
 {const dataDir=await directory(t),calls=[],service=createIndustryAnalysisService({dataDir,sources:emptySources(),readSourceRevision:async()=>"legacy",now:()=>NOW,autoStart:false,runWork:async(op,opts)=>{calls.push(opts);return op();}});await service.analyze(REQUEST);await service.drain();assert.equal(calls.filter(row=>row.kind==="industry-build").length,1);assert.equal(calls.find(row=>row.kind==="industry-build").detached,true);await service.stop();}
});

test("real cooperative yield or a translated inner error during owned revision never poisons durable source state",async t=>{
 const {cooperativeWorkCheckpoint,setCooperativeWorkPhase}=require("./lib/cooperative_work_checkpoint.cjs");
 for(const translated of[false,true]){const dataDir=await directory(t),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:0,cooperativeMinProgress:1}),entered=gate(),proceed=gate();let clock=NOW.getTime(),calculates=0,ownedChecks=0,peer;
 const read=()=>scheduler.run(()=>"same",{priority:"background",kind:"industry-source-revision"});
 const store=createIndustryAnalysisStore({dataDir,now:()=>new Date(clock),autoStart:false,runWork:(op,opts)=>scheduler.run(op,opts),readSourceRevision:read,readSourceRevisionOwned:async()=>{if(++ownedChecks===1){peer=scheduler.run(()=>"foreground-complete",{priority:"foreground",kind:"foreground-check",detached:true});setCooperativeWorkPhase(70);try{cooperativeWorkCheckpoint();}catch(error){if(translated)throw Object.assign(Error("private translated yield"),{code:"SOURCE_UNAVAILABLE"});throw error;}}return read();},calculate:async request=>{const n=++calculates;clock+=30001;if(n===1){entered.resolve();await proceed.promise;}return result(request,n);}});
 t.after(async()=>{proceed.resolve();await store.stop();await scheduler.close();});await store.get(REQUEST);const drain=store.drain();await entered.promise;const external=store.get(REQUEST);await until(()=>scheduler.status().queuedBackground===1);proceed.resolve();await drain;await external;if(peer)assert.equal(await peer,"foreground-complete");const value=await store.get(REQUEST);assert.equal(calculates,2);assert.equal(value.summary.sold,2);assert.equal(value.storage.status,"ready");assert.equal(value.storage.errorCode,null);assert.equal(scheduler.status().timing.restarted,1);assert.equal((await store.status()).errorCode,null);
 }
});


test("only the factory's private WeakMap brand grants owned revision capability; public method labels cannot spoof it",async t=>{
 const {createIndustrySourceRevision,industrySourceRevisionOwnedCapability:get}=require("./lib/industry_source_revision.cjs"),fake=async()=>"legacy";fake.periodRevisions=async()=>"legacy";fake.periodRevisionsOwned=async()=>assert.fail("untrusted public method must not execute");assert.equal(get(fake),null);assert.equal(get(null),null);
 const dataDir=await directory(t),real=createIndustrySourceRevision({dataDir,outputsDir:path.join(dataDir,"outputs")}),cap=get(real);assert.equal(typeof cap,"function");real.periodRevisions=()=>assert.fail("replacement label is not registered");assert.equal(get(real),cap);
 const calls=[],service=createIndustryAnalysisService({dataDir,sources:emptySources(),readSourceRevision:fake,now:()=>NOW,autoStart:false,runWork:async(op,opts)=>{calls.push(opts);return op();}});await service.analyze(REQUEST);await service.drain();assert.equal(calls.filter(row=>row.kind==="industry-build").length,1);await service.stop();
});


test("owned postcheck never joins an external token created during its initialization await",async t=>{
 const Module=require("node:module"),native=require("node:fs"),{createIndustrySourceRevision}=require("./lib/industry_source_revision.cjs");
 {const dataDir=await directory(t),outputsDir=path.join(dataDir,"outputs"),master=path.join(dataDir,"company_master/companies.json"),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000}),escape=gate(),hookExited=gate(),externalResource=new (require("node:async_hooks").AsyncResource)("artifact-external-request");await fs.mkdir(path.dirname(master),{recursive:true});await fs.mkdir(outputsDir);await fs.writeFile(master,JSON.stringify({companies:{},updatedAt:"one"}));let clock=NOW.getTime(),lastRevision,calculateDone=false,hooked=false,external,ownerFinished=false,externalFinished=false;
 const actual=createIndustrySourceRevision({dataDir,outputsDir,runWork:(op,opts)=>scheduler.run(op,opts)}),read=()=>{const p=actual.periodRevisions().then(value=>{lastRevision=value;return value;});return calculateDone?Promise.race([p,escape.promise]):p;};let store;
 const hook=async()=>{if(calculateDone&&!hooked&&scheduler.status().activeKind==="industry-build"){hooked=true;external=externalResource.runInAsyncScope(()=>store.get(REQUEST)).then(value=>{externalFinished=true;return value;});await until(()=>scheduler.status().queuedBackground===1);hookExited.resolve();}};
 const file=require.resolve("./lib/industry_analysis_store.cjs"),m=new Module(file,module),req=Module.createRequire(file);m.require=id=>id==="artifact-test-init-hook"?hook:req(id);const source=native.readFileSync(file,"utf8");assert.equal(source.split("  async function init() {").length,2);m._compile(source.replace("  async function init() {","  async function init() { await require(\"artifact-test-init-hook\")();"),file);
 store=m.exports.createIndustryAnalysisStore({dataDir,now:()=>new Date(clock),autoStart:false,runWork:(op,opts)=>scheduler.run(op,opts),readSourceRevision:read,readSourceRevisionOwned:read,calculate:async request=>{await fs.writeFile(master,JSON.stringify({companies:{},updatedAt:"two"}));clock+=30001;calculateDone=true;return result(request,0);}});t.after(async()=>{escape.resolve(lastRevision);await store.stop();await scheduler.close();externalResource.emitDestroy();});await store.get(REQUEST);const drain=store.drain().then(()=>{ownerFinished=true;});await hookExited.promise;
 await until(()=>ownerFinished&&externalFinished);
 await drain;await external;assert.equal(hooked,true);assert.equal((await store.get(REQUEST)).storage.hasSnapshot,true);await store.stop();await scheduler.close();}
});
