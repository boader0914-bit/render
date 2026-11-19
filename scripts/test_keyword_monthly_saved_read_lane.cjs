"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createAnalyticalWorkScheduler}=require("./lib/analytical_work_scheduler.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {createKeywordMonthlyQueryLifecycle}=require("./lib/keyword_monthly_query_lifecycle.cjs");
const {createKeywordMonthlyMemoryAdmission}=require("./lib/keyword_monthly_memory_admission.cjs");
const {createKeywordMonthlyRequestDiagnostics}=require("./lib/keyword_monthly_request_diagnostics.cjs");
const {runNonInterruptibleCooperativeWork}=require("./lib/cooperative_work_checkpoint.cjs");
const gate=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.fail("synthetic progress did not settle");}
const body=res=>Buffer.isBuffer(res.body)?JSON.parse(res.body):res.body;
function response(){const res=new EventEmitter();res.headers={};res.setHeader=(key,value)=>{res.headers[key]=value;};res.writeHead=status=>{res.status=status;};res.end=value=>{res.body=value;res.writableEnded=true;};res.finish=()=>res.emit("finish");res.destroy=()=>{res.destroyed=true;res.emit("close");};return res;}
function system({saved,admission=async()=>{},memory=async operation=>operation(),queryLifecycle=createKeywordMonthlyQueryLifecycle(),requestDiagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null})}={}){
  const scheduler=createAnalyticalWorkScheduler(),calls={options:0,prepared:0,legacy:0};
  const actual={options:async()=>{calls.options++;return {status:"available",keywords:[]};},
    readPrepared:async()=>{calls.prepared++;return {status:"available",snapshot:{rate:null,sold:0},provenance:{inputSha256:"a".repeat(64)}};},
    analyze:async()=>{calls.legacy++;return {status:"available",snapshot:{legacy:true}};},...saved};
  const service=createKeywordMonthlySavedReadService({saved:actual,runWork:(operation,options)=>scheduler.run(operation,options),acquirePermit:()=>scheduler.acquireSavedReadPermit(),assertReadAdmission:admission,runMemoryAdmission:memory,diagnostics:requestDiagnostics});
  const handler=createKeywordMonthlyHttpHandler({service,queryLifecycle,requestDiagnostics,requireAdmin:()=>true,send:(res,status,value)=>{res.writeHead(status);res.end(value);}});
  const request=(keyword="synthetic",route="data",res=response(),headers={})=>{const req=new EventEmitter();req.method="GET";req.headers=headers;const url=new URL(route==="options"?"/api/keyword-monthly/options":"/api/keyword-monthly?keyword="+keyword+"&month=2026-11","https://example.test");const done=handler(req,res,url,{});return {req,res,done};};
  const background=async()=>{const entered=gate(),child=gate(),final=gate();const done=scheduler.run(async()=>{entered.resolve();await scheduler.withSavedReadWindow(()=>child.promise);final.resolve();},{kind:"keyword_monthly_refresh",priority:"background"});await entered.promise;await until(()=>scheduler.status().savedRead.childWaitWindowOpen);return {child,final,done};};
  return {scheduler,service,calls,request,background,queryLifecycle};
}

test("idle saved permit reports busy, blocks new global dispatch atomically and forbids nested graph work",async()=>{
  const scheduler=createAnalyticalWorkScheduler();const permit=scheduler.acquireSavedReadPermit();let globalStarted=false;
  assert.equal(scheduler.status().active,true);assert.equal(scheduler.status().activeKind,"keyword_monthly_saved_read");
  const queued=scheduler.run(()=>{globalStarted=true;},{kind:"industry-build"});await tick();assert.equal(globalStarted,false);
  await permit.run(async()=>{await assert.rejects(scheduler.run(()=>{},{}),{code:"KEYWORD_MONTHLY_SAVED_READ_NESTED_WORK"});await assert.rejects(scheduler.runCheckpointRead(()=>{}),{code:"KEYWORD_MONTHLY_SAVED_READ_NESTED_WORK"});});
  permit.release();await queued;assert.equal(globalStarted,true);await scheduler.close();
});

test("only the exact owned background refresh grants child-window or reserved host-checkpoint capabilities",async()=>{
  const scheduler=createAnalyticalWorkScheduler();
  await assert.rejects(scheduler.withSavedReadWindow(()=>{}),{code:"KEYWORD_MONTHLY_SAVED_READ_WINDOW_INVALID"});
  for(const [kind,priority] of [["industry-build","background"],["keyword_monthly_refresh","foreground"]])await scheduler.run(async()=>{
    assert.throws(()=>scheduler.acquireSavedReadPermit(),{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});await assert.rejects(scheduler.withSavedReadWindow(()=>{}),{code:"KEYWORD_MONTHLY_SAVED_READ_WINDOW_INVALID"});
  },{kind,priority});
  await scheduler.run(async()=>{
    const before=scheduler.acquireSavedReadPermit();assert.equal(scheduler.status().savedRead.checkpointPending,true);before.release();
    await scheduler.withSavedReadWindow(async()=>{const permit=scheduler.acquireSavedReadPermit();await permit.run(async()=>42);permit.release();});
    const after=scheduler.acquireSavedReadPermit();assert.equal(scheduler.status().savedRead.checkpointPending,true);after.release();
  },{kind:"keyword_monthly_refresh",priority:"background"});await scheduler.close();
});

test("prepared options and data complete while a background child waits; two shared slow sockets retain the single graph",async()=>{
  const read=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"available",snapshot:{rate:null,sold:0}};}}});
  const background=await s.background(),first=s.request(),second=s.request();await until(()=>s.calls.prepared===1);read.resolve();await until(()=>first.res.body&&second.res.body);
  assert.equal(s.service.status().responseOwners,2);assert.equal(s.scheduler.status().savedRead.active,true);assert.equal(s.queryLifecycle.status().counters.shared,1);
  assert.deepEqual(body(first.res),body(second.res));assert.equal(body(first.res).snapshot.rate,null);assert.equal(s.calls.legacy,0);
  background.child.resolve();await tick();assert.equal(s.scheduler.status().savedRead.childWaitWindowDraining,true);
  const refused=s.request();await refused.done;assert.equal(body(refused.res).code,"KEYWORD_MONTHLY_ANALYTICAL_BUSY");assert.equal(s.calls.prepared,1);
  let final=false;background.final.promise.then(()=>{final=true;});first.res.finish();await first.done;await tick();assert.equal(final,false);assert.equal(s.scheduler.status().savedRead.active,true);
  second.res.finish();await second.done;await background.done;assert.equal(final,true);assert.equal(s.service.status().active,false);
  const options=s.request("synthetic","options");await until(()=>options.res.body);assert.equal(options.res.status,200);options.res.finish();await options.done;await s.scheduler.close();
});

test("a different identity cannot allocate a second saved graph while any original response remains",async()=>{
  const s=system(),first=s.request();await until(()=>first.res.body);const second=s.request("other");await second.done;
  assert.equal(body(second.res).code,"KEYWORD_MONTHLY_QUERY_BUSY");assert.equal(s.calls.prepared,1);first.res.finish();await first.done;
  const after=s.request("other");await until(()=>after.res.body);assert.equal(after.res.status,200);after.res.finish();await after.done;assert.equal(s.calls.prepared,2);await s.scheduler.close();
});

test("caller timeout and disconnect cannot release the ignored underlying saved operation",async()=>{
  const read=gate(),s=system({queryLifecycle:createKeywordMonthlyQueryLifecycle({timeoutMs:5}),saved:{readPrepared:async()=>{await read.promise;return {status:"available",snapshot:{}};}}});
  const background=await s.background(),request=s.request();await until(()=>s.service.status().permitActive);request.res.destroy();await request.done;
  background.child.resolve();await tick();assert.equal(s.scheduler.status().savedRead.active,true);assert.equal(s.service.status().operationPending,1);
  read.resolve();await until(()=>s.service.status().active===false);await background.done;assert.equal(s.queryLifecycle.status().inFlight,0);await s.scheduler.close();
});

test("all socket closes during asynchronous serialization retain the producer until it really settles",async()=>{
  const serialize=gate(),entered=gate(),base=createKeywordMonthlyRequestDiagnostics({onLog:null});
  const diagnostics={...base,measure:async(phase,operation)=>{if(phase==="serialize"){entered.resolve();await serialize.promise;}return base.measure(phase,operation);}};
  const s=system({requestDiagnostics:diagnostics}),background=await s.background(),request=s.request();await entered.promise;
  assert.equal(s.service.status().operationPending,0);assert.equal(s.service.status().producers,1);request.res.destroy();await request.done;background.child.resolve();await tick();
  assert.equal(s.scheduler.status().savedRead.childWaitWindowDraining,true);assert.equal(s.scheduler.status().savedRead.active,true);
  serialize.resolve();await until(()=>s.service.status().producers===0);await background.done;assert.equal(s.service.status().active,false);await s.scheduler.close();
});

test("explicit not_prepared releases only the permit before exclusive fallback and cannot deadlock a closing child window",async()=>{
  let fallbackLease=false;
  const s=system({saved:{readPrepared:async()=>({status:"missing",snapshot:null,preparedResult:{status:"not_prepared"}}),analyze:async()=>{
    fallbackLease=s.scheduler.status().activeKind==="keyword_monthly_analysis";assert.equal(s.scheduler.status().savedRead.active,false);return {status:"available",snapshot:{legacy:true}};
  }}}),background=await s.background(),request=s.request();await until(()=>s.service.status().fallback===1);
  assert.equal(s.service.status().active,true);assert.equal(s.service.status().permitActive,false);assert.equal(s.scheduler.status().activeKind,"keyword_monthly_refresh");
  background.child.resolve();await background.done;await until(()=>request.res.body);assert.equal(fallbackLease,true);assert.equal(body(request.res).snapshot.legacy,true);
  const refused=s.request("other");await refused.done;assert.equal(body(refused.res).code,"KEYWORD_MONTHLY_QUERY_BUSY");
  request.res.finish();await request.done;assert.equal(s.service.status().active,false);await s.scheduler.close();
});

test("65/55 memory hysteresis and unavailable samples defer before any saved allocation",async()=>{
  let ratio=.66;const memory=createKeywordMonthlyMemoryAdmission({sampleMemory:()=>({ratio,sampledAt:Date.now()})});const s=system({memory:memory.run});
  const first=s.request();await first.done;assert.equal(body(first.res).code,"KEYWORD_MONTHLY_MEMORY_DEFERRED");assert.equal(s.calls.prepared,0);
  ratio=.54;const lowOnce=s.request();await lowOnce.done;assert.equal(body(lowOnce.res).code,"KEYWORD_MONTHLY_MEMORY_DEFERRED");assert.equal(s.calls.prepared,0);
  const recovered=s.request();await until(()=>recovered.res.body);assert.equal(recovered.res.status,200);recovered.res.finish();await recovered.done;assert.equal(s.calls.prepared,1);
  ratio=NaN;const unknown=s.request();await unknown.done;assert.equal(body(unknown.res).code,"KEYWORD_MONTHLY_MEMORY_UNAVAILABLE");assert.equal(s.calls.prepared,1);await s.scheduler.close();
});

test("maintenance before claim and after prepared read fails closed without sending the saved payload",async()=>{
  for(const mode of ["before","after"]){let held=mode==="before";const s=system({admission:async()=>{if(held)throw Object.assign(new Error("private marker"),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE"});},saved:{readPrepared:async()=>{s.calls.prepared++;held=true;return {status:"available",snapshot:{privatePayload:true}};}}});
    const request=s.request();await request.done;assert.equal(body(request.res).code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(body(request.res).snapshot,null);assert.equal(s.calls.prepared,mode==="before"?0:1);assert.equal(s.service.status().active,false);await s.scheduler.close();}
});

test("destroyed responses and lifecycle rejection before operation cannot leave untracked work or permits",async()=>{
  const s=system(),destroyed=response();destroyed.destroy();const request=s.request("synthetic","data",destroyed);await request.done;assert.equal(s.calls.prepared,0);assert.equal(s.service.status().cohorts,0);assert.equal(s.scheduler.status().savedRead.active,false);
  s.queryLifecycle.close();const closed=s.request();await closed.done;assert.equal(body(closed.res).code,"KEYWORD_MONTHLY_QUERY_CLOSED");assert.equal(s.service.status().cohorts,0);assert.equal(s.calls.prepared,0);await s.scheduler.close();
});

test("a maintenance marker created during the final asynchronous memory sample is checked before sending the saved payload",async()=>{
  let held=false,samples=0;const s=system({admission:async()=>{if(held)throw Object.assign(new Error(),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE"});},memory:async operation=>{const result=await operation();if(++samples===2)held=true;return result;}});
  const request=s.request();await until(()=>request.res.body);assert.equal(request.res.status,503);assert.equal(body(request.res).code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(body(request.res).snapshot,null);await request.done;assert.equal(s.service.status().active,false);await s.scheduler.close();
});

test("shutdown refuses new capabilities and waits for the original running permit to be released",async()=>{
  const scheduler=createAnalyticalWorkScheduler(),permit=scheduler.acquireSavedReadPermit(),read=gate();const work=permit.run(()=>read.promise);await tick();
  const closing=scheduler.close();let closed=false;closing.then(()=>{closed=true;});assert.equal(scheduler.status().active,true);assert.throws(()=>scheduler.acquireSavedReadPermit(),{code:"ANALYTICAL_WORK_CLOSED"});assert.throws(()=>permit.release(),{code:"KEYWORD_MONTHLY_SAVED_READ_PERMIT_ACTIVE"});await tick();assert.equal(closed,false);
  read.resolve();await work;permit.release();await closing;assert.equal(closed,true);
});

test("saved methods require a response owner and may not escape to nested global legacy work",async()=>{
  const s=system({saved:{readPrepared:()=>s.scheduler.run(()=>({status:"available"}),{kind:"forbidden_legacy"})}});
  await assert.rejects(s.service.options(),{code:"KEYWORD_MONTHLY_SAVED_READ_CONTEXT_REQUIRED"});const request=s.request();await request.done;assert.equal(body(request.res).code,"KEYWORD_MONTHLY_SAVED_READ_NESTED_WORK");assert.equal(s.service.status().active,false);await s.scheduler.close();
});


test("automatic prepared-only shared HTTP reads stay in the saved child window and never fall back on a missing preparation",{timeout:3000},async()=>{
  const read=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;await read.promise;return {status:"missing",snapshot:null,preparedResult:{status:"not_prepared"}};}}});
  const background=await s.background(),headers={"x-keyword-monthly-prepared-only":"1"};
  const first=s.request("synthetic","data",response(),headers),second=s.request("synthetic","data",response(),headers);
  await until(()=>s.calls.prepared===1);assert.equal(s.queryLifecycle.status().inFlight,1);assert.equal(s.queryLifecycle.status().counters.shared,1);
  read.resolve();await until(()=>first.res.body&&second.res.body);
  for(const request of [first,second]){assert.equal(body(request.res).preparedResult.status,"not_prepared");assert.equal(body(request.res).snapshot,null);request.res.finish();}
  await Promise.all([first.done,second.done]);assert.equal(s.calls.legacy,0);assert.equal(s.service.status().fallback,0);assert.equal(s.service.status().cohorts,0);
  assert.equal(s.scheduler.status().activeKind,"keyword_monthly_refresh");assert.equal(s.scheduler.status().savedRead.childWaitWindowOpen,true);
  background.child.resolve();await background.done;await s.scheduler.close();
});

test("manual and automatic modes of the same query never share a legacy calculation or a saved-flight identity",{timeout:3000},async()=>{
  const manualStarted=gate(),manualFinish=gate(),s=system({saved:{readPrepared:async()=>{s.calls.prepared++;return {preparedResult:{status:"not_prepared"}};},
    analyze:async()=>{s.calls.legacy++;manualStarted.resolve();await manualFinish.promise;return {status:"available",snapshot:{manual:true}};}}});
  const manual=s.request();await manualStarted.promise;
  const automatic=s.request("synthetic","data",response(),{"x-keyword-monthly-prepared-only":"1"});await until(()=>automatic.res.body);
  assert.equal(body(automatic.res).code,"KEYWORD_MONTHLY_QUERY_BUSY");assert.equal(s.calls.legacy,1);assert.equal(s.calls.prepared,1);
  assert.equal(s.queryLifecycle.status().counters.shared,0);assert.equal(s.queryLifecycle.status().inFlight,1);automatic.res.finish();await automatic.done;
  manualFinish.resolve();await until(()=>manual.res.body);assert.equal(body(manual.res).snapshot.manual,true);manual.res.finish();await manual.done;
  assert.equal(s.service.status().cohorts,0);await s.scheduler.close();
});

test("a pending host loan drains before entering the child window, whose direct permit and atomic exit stay exclusive",{timeout:5000},async()=>{
  const s=system(),entered=gate(),open=gate(),child=gate(),atomic=gate(),finish=gate();let childEntered=false,atomicEntered=false,attempts=0;
  const work=s.scheduler.run(async()=>{
    attempts++;entered.resolve();await open.promise;
    await s.scheduler.withSavedReadWindow(async()=>{childEntered=true;await child.promise;});
    await runNonInterruptibleCooperativeWork(async()=>{atomicEntered=true;atomic.resolve();await finish.promise;});
  },{kind:"keyword_monthly_refresh",priority:"background"});await entered.promise;
  assert.equal(s.scheduler.status().cooperative.activeEligible,false,"refresh never gains replay/yield authority");
  assert.equal(s.scheduler.status().savedRead.loanOnlyOwner,true);
  const host=s.request("host","data",response(),{"x-keyword-monthly-prepared-only":"1"});await until(()=>s.scheduler.status().savedRead.checkpointPending);
  open.resolve();await until(()=>host.res.body);assert.equal(host.res.status,200);assert.equal(childEntered,false);assert.equal(atomicEntered,false);
  host.res.finish();await host.done;await until(()=>s.scheduler.status().savedRead.childWaitWindowOpen);
  const checkpointCount=s.scheduler.status().timing.checkpointReadStarted,direct=s.request("child","data",response(),{"x-keyword-monthly-prepared-only":"1"});
  await until(()=>direct.res.body);assert.equal(direct.res.status,200);assert.equal(s.scheduler.status().timing.checkpointReadStarted,checkpointCount,"child permits do not wait for a nonexistent host checkpoint");
  child.resolve();await until(()=>s.scheduler.status().savedRead.childWaitWindowDraining);assert.equal(atomicEntered,false);
  const draining=s.request("child","data",response(),{"x-keyword-monthly-prepared-only":"1"});await draining.done;assert.equal(body(draining.res).readGuard.reason,"response_window_closed");
  direct.res.finish();await direct.done;await atomic.promise;
  const rejected=s.request("atomic");await rejected.done;assert.equal(body(rejected.res).readGuard.reason,"atomic_work");assert.equal(body(rejected.res).readGuard.flags.atomicWork,true);
  finish.resolve();await work;assert.equal(attempts,1);assert.equal(s.scheduler.status().timing.restarted,0);assert.equal(s.scheduler.status().savedRead.active,false);await s.scheduler.close();
});
