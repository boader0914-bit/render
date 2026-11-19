"use strict";
const rawTest=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createAnalyticalWorkScheduler:createScheduler}=require("./lib/analytical_work_scheduler.cjs");
const {createSourceReadScheduler}=require("./lib/source_read_scheduler.cjs");
const {runNonInterruptibleCooperativeWork}=require("./lib/cooperative_work_checkpoint.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {createKeywordMonthlyResponseBudget}=require("./lib/keyword_monthly_response_budget.cjs");
const {createKeywordMonthlyQueryLifecycle}=require("./lib/keyword_monthly_query_lifecycle.cjs");
const {createKeywordMonthlyMemoryAdmission}=require("./lib/keyword_monthly_memory_admission.cjs");
const {createKeywordMonthlyRequestDiagnostics}=require("./lib/keyword_monthly_request_diagnostics.cjs");
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let n=0;n<100;n++){if(fn())return;await turn();}assert.fail("bounded synthetic progress did not settle");}
// The saved DTO owns the same checkpoint-to-final-response lifetime under both
// explicitly enabled owners. Keep all admission and cancellation cases shared.
for(const ownerKind of ["industry-build","company-month","keyword_monthly_refresh"]){
const test=(name,...args)=>rawTest(`${ownerKind}: ${name}`,...args);
const createAnalyticalWorkScheduler=options=>createScheduler({cooperativeCompanyMonthYield:ownerKind==="company-month",...options});
const scope={kind:ownerKind,priority:"background"};
function clock(){let at=0;const timers=new Map();return {now:()=>at,set(ms){at=ms;},jump(ms){at+=ms;},setTimeoutImpl(fn,ms){const h={unref(){}};timers.set(h,{fn,due:at+ms,ms});return h;},clearTimeoutImpl:h=>timers.delete(h),
  async advance(ms){at+=ms;for(const [h,t]of [...timers])if(t.due<=at){timers.delete(h);t.fn();}for(let n=0;n<8;n++)await turn();},timers};}
function response(){const res=new EventEmitter();res.setHeader=()=>{};res.writeHead=status=>{res.status=status;};res.end=value=>{res.body=value;res.writableEnded=true;};res.finish=()=>res.emit("finish");res.destroy=()=>{res.destroyed=true;res.emit("close");};return res;}
const body=res=>Buffer.isBuffer(res.body)?JSON.parse(res.body):res.body;
async function industry(scheduler,{atomic=false,checkpoint=true}={}){
  const entered=gate(),proceed=gate(),resumed=gate(),finish=gate(),source=createSourceReadScheduler();let attempts=0;
  const operation=async()=>{attempts++;entered.resolve();await proceed.promise;if(checkpoint)await source.checkpoint(scope);resumed.resolve();await finish.promise;return "industry-complete";};
  const done=scheduler.run(()=>atomic?runNonInterruptibleCooperativeWork(operation):operation(),scope);
  await entered.promise;return {proceed,resumed,finish,done,attempts:()=>attempts};
}
function system({saved={},memory=async op=>op(),admission=async()=>{},schedulerOptions={},diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),queryTimeout=20000,budgetBytes=32*1024*1024}={}){
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true,cooperativeMinRunMs:60000,...schedulerOptions}),calls={prepared:0,options:0,legacy:0};
  const actual={options:async()=>{calls.options++;return {status:"available",keywords:[]};},readPrepared:async()=>{calls.prepared++;return {status:"available",snapshot:{value:null,actualZero:0}};},
    analyze:async()=>{calls.legacy++;return {status:"available",snapshot:{legacy:true}};},...saved};
  const service=createKeywordMonthlySavedReadService({saved:actual,runWork:(op,options)=>scheduler.run(op,options),acquirePermit:()=>scheduler.acquireSavedReadPermit(),assertReadAdmission:admission,runMemoryAdmission:memory,diagnostics});
  const budget=createKeywordMonthlyResponseBudget({maxResponseBytes:budgetBytes,maxReservedBytes:budgetBytes*2});
  const lifecycle=createKeywordMonthlyQueryLifecycle({timeoutMs:queryTimeout});
  const handler=createKeywordMonthlyHttpHandler({service,queryLifecycle:lifecycle,responseBudget:budget,requestDiagnostics:diagnostics,requireAdmin:()=>true,send:(res,status,value)=>{res.writeHead(status);res.end(value);}});
  const request=(route="data",keyword="synthetic",headers={})=>{const req=new EventEmitter(),res=response();req.method="GET";req.headers=headers;const url=new URL(route==="options"?"/api/keyword-monthly/options":route==="version"?"/api/keyword-monthly/version":`/api/keyword-monthly?keyword=${keyword}&month=2026-11`,"https://example.test");return {req,res,done:handler(req,res,url,{})};};
  return {scheduler,service,budget,lifecycle,calls,request};
}

test("an exact source checkpoint lends a saved-only token without restarting or concurrently advancing its owner",async()=>{
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;
  assert.equal(scheduler.status().savedRead.active,false);assert.equal(scheduler.status().savedRead.checkpointPending,true);
  const ready=permit.run(async()=>{reads++;await assert.rejects(scheduler.run(()=>assert.fail("nested graph")),{code:"KEYWORD_MONTHLY_SAVED_READ_NESTED_WORK"});
    await assert.rejects(scheduler.runCheckpointRead(()=>assert.fail("recursive loan")),{code:"KEYWORD_MONTHLY_SAVED_READ_NESTED_WORK"});return {value:null,zero:0};});
  await turn();assert.equal(reads,0);bg.proceed.resolve();assert.deepEqual(await ready,{value:null,zero:0});
  let resumed=false;bg.resumed.promise.then(()=>{resumed=true;});await turn();assert.equal(resumed,false);assert.equal(scheduler.status().activeCheckpointReadKind,"keyword-monthly-saved-read");
  permit.release();await permit.waitForRelease();await bg.resumed.promise;assert.equal(resumed,true);bg.finish.resolve();await bg.done;
  assert.equal(bg.attempts(),1);assert.equal(scheduler.status().timing.restarted,0);assert.equal(scheduler.status().timing.checkpointReadCompleted,1);await scheduler.close();
});

test("options and prepared data borrow successive safe checkpoints of the same background calculation",async()=>{
  const s=system(),source=createSourceReadScheduler(),entered=gate(),boundaries=[gate(),gate()],passed=[gate(),gate()];let attempts=0;
  const work=s.scheduler.run(async()=>{attempts++;entered.resolve();for(let n=0;n<2;n++){await boundaries[n].promise;await source.checkpoint(scope);passed[n].resolve();}return "complete";},scope);
  await entered.promise;
  for(const [n,route] of ["options","data"].entries()){
    const r=s.request(route,"synthetic",route==="data"?{"x-keyword-monthly-prepared-only":"1"}:{});
    await until(()=>s.scheduler.status().savedRead.checkpointPending);boundaries[n].resolve();await until(()=>r.res.body);
    assert.equal(r.res.status,200);assert.equal(s.scheduler.status().activeKind,ownerKind);assert.equal(s.scheduler.status().savedRead.active,true);
    if(route==="data"){assert.equal(body(r.res).snapshot.value,null);assert.equal(body(r.res).snapshot.actualZero,0);}
    r.res.finish();await r.done;await passed[n].promise;
  }
  assert.equal(await work,"complete");assert.equal(attempts,1);assert.equal(s.calls.options,1);assert.equal(s.calls.prepared,1);assert.equal(s.calls.legacy,0);
  assert.equal(s.scheduler.status().timing.restarted,0);await s.scheduler.close();
});

test("two shared HTTP sockets retain the loan until the final response budget really releases",async()=>{
  const read=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"available",snapshot:{value:null,actualZero:0}};}}}),bg=await industry(s.scheduler);
  let resumed=false;bg.resumed.promise.then(()=>{resumed=true;assert.equal(s.budget.status().reservedBytes,0);assert.equal(s.service.status().producers,0);assert.equal(s.service.status().responseOperations,0);});
  const first=s.request(),second=s.request();await until(()=>s.scheduler.status().savedRead.checkpointPending);bg.proceed.resolve();await until(()=>s.calls.prepared===1);read.resolve();await until(()=>first.res.body&&second.res.body);
  assert.deepEqual(body(first.res),body(second.res));assert.equal(body(first.res).snapshot.value,null);assert.equal(body(first.res).snapshot.actualZero,0);
  assert.equal(s.budget.status().maxResponseBytes,32*1024*1024);assert.equal(s.budget.status().maxReservedBytes,64*1024*1024);
  first.res.finish();await first.done;await turn();assert.equal(resumed,false);assert.equal(s.scheduler.status().savedRead.active,true);
  const other=s.request("data","other");await other.done;assert.equal(body(other.res).code,"KEYWORD_MONTHLY_QUERY_BUSY");assert.equal(s.calls.prepared,1);
  second.res.finish();await second.done;await bg.resumed.promise;bg.finish.resolve();await bg.done;assert.equal(s.calls.legacy,0);await s.scheduler.close();
});

test("closed sockets and a timed-out caller cannot release an ignored underlying prepared read",async()=>{
  const read=gate(),s=system({queryTimeout:5,saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"available",snapshot:{}};}}}),bg=await industry(s.scheduler),r=s.request();
  await until(()=>s.scheduler.status().savedRead.checkpointPending);bg.proceed.resolve();await until(()=>s.calls.prepared===1);r.res.destroy();await r.done;await turn();
  assert.equal(s.scheduler.status().savedRead.active,true);assert.equal(s.service.status().operationPending,1);assert.equal(s.budget.status().reservedBytes,0);
  read.resolve();await bg.resumed.promise;assert.equal(s.service.status().active,false);bg.finish.resolve();await bg.done;await s.scheduler.close();
});

test("a closed socket during asynchronous encoding keeps the actual producer and budget inside the paused checkpoint",async()=>{
  const encoding=gate(),entered=gate(),base=createKeywordMonthlyRequestDiagnostics({onLog:null});
  const diagnostics={...base,measure:async(phase,op)=>{if(phase==="serialize"){entered.resolve();await encoding.promise;}return base.measure(phase,op);}};
  const s=system({diagnostics}),bg=await industry(s.scheduler),r=s.request();await until(()=>s.scheduler.status().savedRead.checkpointPending);bg.proceed.resolve();await entered.promise;
  r.res.destroy();await r.done;await turn();assert.equal(s.service.status().producers,1);assert.equal(s.scheduler.status().savedRead.active,true);assert.ok(s.budget.status().reservedBytes>0);
  encoding.resolve();await bg.resumed.promise;assert.equal(s.budget.status().reservedBytes,0);bg.finish.resolve();await bg.done;await s.scheduler.close();
});

test("not_prepared releases and settles its loan before queuing legacy work and cannot deadlock its background owner",async()=>{
  let fallback=false;const s=system({saved:{readPrepared:async()=>({preparedResult:{status:"not_prepared"}}),analyze:async()=>{fallback=true;assert.equal(s.scheduler.status().activeCheckpointReadKind,null);assert.equal(s.scheduler.status().savedRead.active,false);return {status:"available",snapshot:{legacy:true}};}}});
  const bg=await industry(s.scheduler),r=s.request();await until(()=>s.scheduler.status().savedRead.checkpointPending);bg.proceed.resolve();await bg.resumed.promise;
  await until(()=>s.service.status().fallback===1);assert.equal(fallback,false);assert.equal(s.service.status().active,true);assert.equal(s.scheduler.status().savedRead.active,false);
  bg.finish.resolve();await bg.done;await until(()=>r.res.body);assert.equal(fallback,true);assert.equal(body(r.res).snapshot.legacy,true);r.res.finish();await r.done;await s.scheduler.close();
});

test("the admission deadline is exactly bounded and removes only a queued loan without restarting its owner",async()=>{
  const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;
  const ready=permit.run(()=>{reads++;return {};});const rejection=assert.rejects(ready,error=>error.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&error.readGuard?.reason==="checkpoint_expired");
  assert.ok([...c.timers.values()].some(t=>t.ms===1500));await c.advance(1499);assert.equal(scheduler.status().queuedCheckpointReads,1);await c.advance(1);await rejection;
  assert.equal(scheduler.status().queuedCheckpointReads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);assert.equal(reads,0);
  permit.release();bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;assert.equal(bg.attempts(),1);await scheduler.close();
});

test("wrong owners, foreground work, noncooperative work and atomic publication refuse this capability",async()=>{
  for(const [kind,priority,cooperativeYield,cooperativeCompanyMonthYield]of [["company-bootstrap","background",true,true],["company-job-prepare","background",true,true],
    ["company-month-repair","foreground",true,true],["company-month","foreground",true,true],["company-month","background",true,false],
    ["industry-build","foreground",true,true],["industry-build","background",false,true]]){
    const scheduler=createAnalyticalWorkScheduler({cooperativeYield,cooperativeCompanyMonthYield}),entered=gate(),finish=gate(),done=scheduler.run(async()=>{entered.resolve();await finish.promise;},{kind,priority});await entered.promise;
    assert.throws(()=>scheduler.acquireSavedReadPermit(),error=>error.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&error.readGuard?.reason==="ineligible_owner");finish.resolve();await done;await scheduler.close();
  }
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),bg=await industry(scheduler,{atomic:true});assert.throws(()=>scheduler.acquireSavedReadPermit(),error=>error.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&error.readGuard?.reason==="atomic_work"&&error.readGuard.flags.atomicWork===true);
  bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;await assert.rejects(scheduler.runCheckpointRead(()=>{}, {kind:"keyword-monthly-saved-read"}),TypeError);await scheduler.close();
});

test("an owner that finishes before reaching its checkpoint cannot transfer the loan to a later owner",async()=>{
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),bg=await industry(scheduler,{checkpoint:false}),permit=scheduler.acquireSavedReadPermit();let reads=0;
  const ready=permit.run(()=>{reads++;return {};});const rejection=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;await rejection;
  assert.equal(reads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);permit.release();await scheduler.close();
});

test("memory pressure arriving after reservation is sampled at the actual checkpoint before allocating a saved graph",async()=>{
  let ratio=.3;const memory=createKeywordMonthlyMemoryAdmission({sampleMemory:()=>({ratio,sampledAt:Date.now()})}),s=system({memory:memory.run}),bg=await industry(s.scheduler),r=s.request();
  await until(()=>s.scheduler.status().savedRead.checkpointPending);ratio=.66;bg.proceed.resolve();await r.done;assert.equal(body(r.res).code,"KEYWORD_MONTHLY_MEMORY_DEFERRED");assert.equal(s.calls.prepared,0);
  assert.equal(body(r.res).readGuard.reason,"high_watermark");assert.equal(body(r.res).readGuard.memory.ratio,.66);assert.equal(body(r.res).readGuard.memory.paused,true);
  await bg.resumed.promise;assert.equal(s.service.status().active,false);bg.finish.resolve();await bg.done;await s.scheduler.close();
});

test("maintenance that appears between reservation and decode fails closed while leaving the background owner intact",async()=>{
  let held=false;const s=system({admission:async()=>{if(held)throw Object.assign(new Error(),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE"});}}),bg=await industry(s.scheduler),r=s.request();
  await until(()=>s.scheduler.status().savedRead.checkpointPending);held=true;bg.proceed.resolve();await r.done;assert.equal(body(r.res).code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(s.calls.prepared,0);
  await bg.resumed.promise;bg.finish.resolve();await bg.done;assert.equal(bg.attempts(),1);await s.scheduler.close();
});

test("closing cancels a queued loan and an active loan still drains its ignored work before shutdown settles",async()=>{
  for(const active of [false,true]){
    const read=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"available",snapshot:{}};}}}),bg=await industry(s.scheduler),r=s.request();
    await until(()=>s.scheduler.status().savedRead.checkpointPending);if(active){bg.proceed.resolve();await until(()=>s.calls.prepared===1);}
    let closed=false;const closing=s.scheduler.close().then(()=>{closed=true;});r.res.destroy();await r.done;await turn();assert.equal(closed,false);
    if(active){assert.equal(s.scheduler.status().savedRead.active,true);read.resolve();}else{assert.equal(s.calls.prepared,0);bg.proceed.resolve();}
    await bg.resumed.promise;bg.finish.resolve();await bg.done;await closing;assert.equal(s.service.status().active,false);assert.equal(s.scheduler.status().savedRead.checkpointPending,false);
  }
});

test("the existing encoded response bound rejects an oversized prepared DTO before resuming the background owner",async()=>{
  const s=system({budgetBytes:128,saved:{readPrepared:async()=>({status:"available",snapshot:{text:"x".repeat(1024)}})}}),bg=await industry(s.scheduler),r=s.request();
  await until(()=>s.scheduler.status().savedRead.checkpointPending);bg.proceed.resolve();await r.done;assert.equal(body(r.res).code,"KEYWORD_MONTHLY_RESPONSE_TOO_LARGE");await bg.resumed.promise;
  assert.equal(s.budget.status().reservedBytes,0);assert.equal(s.service.status().active,false);bg.finish.resolve();await bg.done;await s.scheduler.close();
});

test("another async branch of the same background owner cannot pass its checkpoint while the saved loan is held",async()=>{
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),source=createSourceReadScheduler(),entered=gate(),proceed=gate(),borrowed=gate();let siblingPassed=false;
  const work=scheduler.run(async()=>{entered.resolve();await proceed.promise;const lender=source.checkpoint(scope);await borrowed.promise;
    const sibling=source.checkpoint(scope).then(()=>{siblingPassed=true;});await Promise.all([lender,sibling]);return "complete";},scope);
  await entered.promise;const permit=scheduler.acquireSavedReadPermit(),ready=permit.run(()=>{borrowed.resolve();return {};});proceed.resolve();await ready;await turn();await turn();assert.equal(siblingPassed,false);
  permit.release();await permit.waitForRelease();assert.equal(await work,"complete");assert.equal(siblingPassed,true);await scheduler.close();
});

test("a sibling atomic publication waits for the borrowed saved response to release before entering",async()=>{
  const scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),source=createSourceReadScheduler(),entered=gate(),proceed=gate(),borrowed=gate();let atomicEntered=false;
  const work=scheduler.run(async()=>{entered.resolve();await proceed.promise;const lender=source.checkpoint(scope);await borrowed.promise;
    const publication=runNonInterruptibleCooperativeWork(async()=>{assert.equal(scheduler.status().savedRead.active,false);atomicEntered=true;});
    await Promise.all([lender,publication]);return "complete";},scope);
  await entered.promise;const permit=scheduler.acquireSavedReadPermit(),ready=permit.run(()=>{borrowed.resolve();return {};});proceed.resolve();await ready;
  await turn();assert.equal(atomicEntered,false);permit.release();await permit.waitForRelease();assert.equal(await work,"complete");assert.equal(atomicEntered,true);await scheduler.close();
});

test("the admission clock never releases a started loan or its ignored operation",async()=>{
  const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),reading=gate(),entered=gate(),permit=scheduler.acquireSavedReadPermit();let resumed=false;
  bg.resumed.promise.then(()=>{resumed=true;});const ready=permit.run(async()=>{entered.resolve();await reading.promise;return {};});bg.proceed.resolve();await entered.promise;
  await c.advance(10000);assert.equal(scheduler.status().savedRead.active,true);assert.equal(resumed,false);assert.throws(()=>permit.release(),{code:"KEYWORD_MONTHLY_SAVED_READ_PERMIT_ACTIVE"});
  reading.resolve();await ready;await c.advance(10000);assert.equal(resumed,false);permit.release();await permit.waitForRelease();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();assert.equal(c.timers.size,0);
});

test("maintenance found while a loan is queued prevents admission and the deadline removes the unused callback",async()=>{
  const c=clock();let held=false,reads=0;const scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true,externalAdmission:()=>({allowed:!held,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"})}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();
  const ready=permit.run(()=>{reads++;return {};});const rejection=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});held=true;await c.advance(1000);assert.equal(scheduler.status().maintenance.paused,true);
  await c.advance(500);await rejection;assert.equal(reads,0);assert.equal(scheduler.status().queuedCheckpointReads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);permit.release();
  held=false;await c.advance(1000);bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;assert.equal(bg.attempts(),1);await scheduler.close();assert.equal(c.timers.size,0);
});


test("automatic prepared-only responses borrow the source checkpoint through the final response and never calculate a missing preparation",{timeout:5000},async()=>{
  const read=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"missing",snapshot:null,preparedResult:{status:"not_prepared"}};}}}),bg=await industry(s.scheduler);
  const headers={"x-keyword-monthly-prepared-only":"1"},first=s.request("data","synthetic",headers),second=s.request("data","synthetic",headers);
  await until(()=>s.scheduler.status().savedRead.checkpointPending);assert.equal(s.calls.prepared,0);bg.proceed.resolve();await until(()=>s.calls.prepared===1);
  assert.equal(s.scheduler.status().activeCheckpointReadKind,"keyword-monthly-saved-read");assert.equal(s.scheduler.status().active,true);
  read.resolve();await until(()=>first.res.body&&second.res.body);
  for(const r of [first,second]){assert.equal(body(r.res).preparedResult.status,"not_prepared");assert.equal(body(r.res).snapshot,null);}
  assert.equal(s.calls.legacy,0);assert.equal(s.service.status().fallback,0);assert.equal(s.lifecycle.status().counters.shared,1);
  first.res.finish();await first.done;await turn();assert.equal(s.scheduler.status().savedRead.active,true);assert.ok(s.budget.status().reservedBytes>0);
  second.res.finish();await second.done;await bg.resumed.promise;assert.equal(s.budget.status().reservedBytes,0);assert.equal(s.service.status().responseOperations,0);
  assert.equal(s.service.status().producers,0);assert.equal(s.service.status().active,false);bg.finish.resolve();await bg.done;assert.equal(bg.attempts(),1);await s.scheduler.close();
});

test("pointer-only version notifications bypass both a queued and an active background loan without joining the saved graph",{timeout:5000},async()=>{
  let versions=0;const read=gate(),s=system({saved:{version:async()=>{versions++;return {status:"available",revision:"a".repeat(64),originalFreshnessVerified:false};},
    readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"available",snapshot:{value:null,actualZero:0}};}}}),bg=await industry(s.scheduler);
  const automatic=s.request("data","synthetic",{"x-keyword-monthly-prepared-only":"1"});await until(()=>s.scheduler.status().savedRead.checkpointPending);
  for(const active of [false,true]){
    if(active){bg.proceed.resolve();await until(()=>s.calls.prepared===1);}
    const before=s.service.status().started,version=s.request("version");await until(()=>version.res.body);
    assert.equal(body(version.res).revision,"a".repeat(64));assert.equal(body(version.res).originalFreshnessVerified,false);version.res.finish();await version.done;
    assert.equal(s.service.status().started,before);assert.equal(s.calls.prepared,active?1:0);assert.equal(s.scheduler.status().active,true);
    assert.equal(s.scheduler.status().savedRead.active,active);assert.equal(s.scheduler.status().savedRead.checkpointPending,!active);
  }
  assert.equal(versions,2);read.resolve();await until(()=>automatic.res.body);assert.equal(body(automatic.res).snapshot.value,null);
  automatic.res.finish();await automatic.done;await bg.resumed.promise;bg.finish.resolve();await bg.done;assert.equal(s.calls.legacy,0);await s.scheduler.close();

});

test("absolute admission expiry rejects a late checkpoint even when the event loop has not executed its timer callback",async()=>{
  for(const elapsed of [1500,2000]){
    const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;
    const ready=permit.run(()=>{reads++;return {};});const rejection=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});
    c.jump(elapsed);assert.equal(c.timers.size,1,"the deadline callback has deliberately not run");assert.equal(permit.acceptsNewResponses(),false);bg.proceed.resolve();await rejection;
    assert.equal(reads,0);assert.equal(scheduler.status().savedRead.active,false);assert.equal(scheduler.status().savedRead.checkpointPending,false);assert.equal(scheduler.status().queuedCheckpointReads,0);
    permit.release();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();assert.equal(c.timers.size,0);
  }
});

test("a loan admitted before the absolute deadline remains owned after the clock passes it",async()=>{
  const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let resumed=false;
  bg.resumed.promise.then(()=>{resumed=true;});const ready=permit.run(()=>({saved:true}));c.jump(1499);bg.proceed.resolve();assert.deepEqual(await ready,{saved:true});
  c.jump(2000);assert.equal(permit.acceptsNewResponses(),true);assert.equal(scheduler.status().savedRead.active,true);assert.equal(resumed,false);assert.equal(c.timers.size,0);
  permit.release();await permit.waitForRelease();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();
});

test("holding a reservation past its absolute deadline cannot later start or enqueue a loan",async()=>{
  const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;c.jump(2000);
  await assert.rejects(permit.run(()=>{reads++;}),{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});assert.equal(reads,0);assert.equal(c.timers.size,0);assert.equal(scheduler.status().queuedCheckpointReads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);
  permit.release();bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();
});

test("an invalid or retreating admission clock fails closed instead of becoming a zero-duration success",async()=>{
  for(const invalid of [NaN,-1]){
    const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;c.set(invalid);
    await assert.rejects(permit.run(()=>{reads++;}),{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});assert.equal(reads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);
    c.set(0);permit.release();bg.proceed.resolve();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();
  }
});

test("an invalid observed queue clock cannot reopen the same reservation after time recovers",async()=>{
  for(const invalid of [NaN,499]){
    const c=clock(),scheduler=createAnalyticalWorkScheduler({...c,cooperativeYield:true}),bg=await industry(scheduler),permit=scheduler.acquireSavedReadPermit();let reads=0;
    const ready=permit.run(()=>{reads++;return {};});const rejection=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});c.set(500);assert.equal(permit.acceptsNewResponses(),true);
    c.set(invalid);assert.equal(permit.acceptsNewResponses(),false);c.set(500);bg.proceed.resolve();await rejection;assert.equal(reads,0);assert.equal(scheduler.status().savedRead.checkpointPending,false);
    permit.release();await bg.resumed.promise;bg.finish.resolve();await bg.done;await scheduler.close();
  }
});
}
