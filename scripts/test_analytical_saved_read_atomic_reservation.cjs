// Current implementation regressions; historical before/after evidence is kept in the review artifacts.
"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createAnalyticalWorkScheduler:createScheduler}=require("./lib/analytical_work_scheduler.cjs");
const {createSourceReadScheduler}=require("./lib/source_read_scheduler.cjs");
const {runNonInterruptibleCooperativeWork:atomic}=require("./lib/cooperative_work_checkpoint.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createKeywordMonthlyMemoryAdmission}=require("./lib/keyword_monthly_memory_admission.cjs");
const originalInfo=console.info; console.info=(tag,...args)=>{if(tag!=="analytical_phase_diagnostic")originalInfo(tag,...args);};
const gate=()=>{let resolve;return {promise:new Promise(r=>{resolve=r;}),resolve:(v)=>resolve(v)};};
const turn=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let n=0;n<150;n++){if(fn())return;await turn();}assert.fail("bounded fixture did not settle");}
function clock(){let at=0;const timers=new Map();return {now:()=>at,set(ms){at=ms;},timers,setTimeoutImpl(fn,ms){const h={unref(){}};timers.set(h,{fn,at:at+ms,ms});return h;},clearTimeoutImpl:h=>timers.delete(h),async advance(ms){at+=ms;for(const [h,t]of [...timers])if(t.at<=at){timers.delete(h);t.fn();}for(let n=0;n<10;n++)await turn();}};}
function makeScheduler(c,extra={}){return createScheduler({...c,cooperativeYield:true,cooperativeCompanyMonthYield:true,sourceMetadataSavedReads:true,cooperativeMinRunMs:60000,...extra});}
async function owner(s,{kind="industry-build",priority="background",checkpoint=true,nested=false,signal,afterLoan=null}={}){
 const entered=gate(),leave=gate(),passed=gate(),finish=gate(),source=createSourceReadScheduler();let attempts=0,insideAtomic=true;
 const work=s.run(async()=>{attempts++;await atomic(async()=>{if(nested)await atomic(async()=>{entered.resolve();await leave.promise;});else{entered.resolve();await leave.promise;}});insideAtomic=false;
 if(checkpoint){const lending=source.checkpoint({kind,priority});if(afterLoan)await afterLoan();await lending;}
 passed.resolve();await finish.promise;return "owner-complete";},{kind,priority,...(signal?{signal}:{})});
 await entered.promise;return {leave,passed,finish,work,attempts:()=>attempts,insideAtomic:()=>insideAtomic};
}
function socket(){const res=new EventEmitter();res.writeHead=()=>{};res.end=()=>{};res.finish=()=>res.emit("finish");res.destroy=()=>{res.destroyed=true;res.emit("close");};return res;}
function service(s,{memory=async op=>op(),savedRead=async()=>({status:"available",snapshot:{value:null,actualZero:0}})}={}){
 let reads=0;const svc=createKeywordMonthlySavedReadService({saved:{options:async()=>({}),readPrepared:async()=>{reads++;return savedRead();},analyze:async()=>assert.fail("no fallback")},runWork:(op,opts)=>s.run(op,opts),acquirePermit:()=>s.acquireSavedReadPermit(),assertReadAdmission:async()=>{},runMemoryAdmission:memory});
 return {svc,reads:()=>reads,read(res,identity="same-scope",afterRead=async()=>{}){return svc.withResponse(identity,res,async()=>{const lifecycle=svc.lifecycleOptions();try{return await svc.withProducer(async()=>{const result=await svc.readPrepared({});await afterRead();return result;});}finally{lifecycle.onOperationSettled();}});}};
}
for(const kind of ["industry-build","company-month","keyword_monthly_refresh","source-options","source-catalog","verified-company-catalog"]){
 test(kind+": short nested atomic work queues but only a depth-zero checkpoint lends",async()=>{
  const c=clock(),s=makeScheduler(c),bg=await owner(s,{kind,nested:true}),permit=s.acquireSavedReadPermit();let reads=0;
  const ready=permit.run(()=>{reads++;assert.equal(bg.insideAtomic(),false);return {value:null,actualZero:0};});await turn();assert.equal(reads,0);assert.equal(s.status().savedRead.active,false);assert.equal(s.status().savedRead.checkpointPending,true);
  await c.advance(200);assert.equal(reads,0);bg.leave.resolve();assert.deepEqual(await ready,{value:null,actualZero:0});assert.equal(reads,1);assert.equal(s.status().savedRead.active,true);assert.equal(s.status().activeKind,kind);
  let passed=false;bg.passed.promise.then(()=>{passed=true;});await turn();assert.equal(passed,false);permit.release();await permit.waitForRelease();await bg.passed.promise;bg.finish.resolve();await bg.work;assert.equal(bg.attempts(),1);assert.equal(s.status().timing.restarted,0);await s.close();assert.equal(c.timers.size,0);
 });
}
test("the first reservation deadline includes atomic waiting and is never reset at run",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s),permit=s.acquireSavedReadPermit();c.set(1499);let reads=0;const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="checkpoint_expired");
 assert.ok([...c.timers.values()].some(t=>t.ms===1));await c.advance(1);await rejected;assert.equal(reads,0);assert.equal(s.status().queuedCheckpointReads,0);assert.equal(s.status().savedRead.checkpointPending,false);permit.release();bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();assert.equal(c.timers.size,0);
});
test("a delayed timer cannot authorize a checkpoint at the absolute deadline",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s),permit=s.acquireSavedReadPermit();let reads=0;const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="checkpoint_expired");
 c.set(1500);bg.leave.resolve();await rejected;assert.equal(reads,0);permit.release();await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();assert.equal(c.timers.size,0);
});
test("an over-budget atomic section expires without allocating or aborting its owner",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s),permit=s.acquireSavedReadPermit();let reads=0;const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});await c.advance(1500);await rejected;
 assert.equal(reads,0);assert.equal(bg.insideAtomic(),true);assert.equal(s.status().savedRead.checkpointPending,false);assert.equal(s.status().queuedCheckpointReads,0);permit.release();bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();assert.equal(await bg.work,"owner-complete");assert.equal(bg.attempts(),1);await s.close();
});
test("an owner ending before its checkpoint cannot hand a reservation to an idle or replacement owner",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s,{checkpoint:false}),permit=s.acquireSavedReadPermit();let reads=0;const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="owner_changed");
 const replacement=s.run(()=>{assert.equal(reads,0);return "replacement";},{kind:"industry-build",priority:"background"});bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();await bg.work;await rejected;permit.release();assert.equal(await replacement,"replacement");assert.equal(reads,0);await s.close();assert.equal(c.timers.size,0);
});
test("canceling a queued reservation removes it and leaves atomic owner progress intact",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s),permit=s.acquireSavedReadPermit();let reads=0;const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"});permit.release();await rejected;assert.equal(s.status().queuedCheckpointReads,0);assert.equal(reads,0);bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();await bg.work;assert.equal(bg.attempts(),1);await s.close();
});
test("maintenance and already-in-flight external checks still refuse reservation immediately",async()=>{
 const c=clock(),checking=gate();let count=0;const s=makeScheduler(c,{externalAdmission:()=>++count===1?{allowed:true}:count===2?checking.promise:{allowed:true}}),bg=await owner(s);await c.advance(1000);assert.equal(s.status().maintenance.checking,true);
 assert.throws(()=>s.acquireSavedReadPermit(),e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="external_checking");assert.equal(s.status().savedRead.checkpointPending,false);checking.resolve({allowed:false,reasonCode:"SYNTHETIC_HOLD"});await until(()=>s.status().maintenance.paused);
 assert.throws(()=>s.acquireSavedReadPermit(),e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="maintenance");await c.advance(1000);await until(()=>!s.status().maintenance.paused);bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();
});
test("noneligible, foreground and disabled cooperative owners still cannot queue inside atomic work",async()=>{
 for(const opts of [{kind:"company-bootstrap",priority:"background"},{kind:"company-month-repair",priority:"foreground"},{kind:"industry-build",priority:"foreground"},{kind:"company-month",priority:"background",disable:true}]){
  const c=clock(),s=makeScheduler(c,opts.disable?{cooperativeCompanyMonthYield:false}:{}),bg=await owner(s,opts);assert.throws(()=>s.acquireSavedReadPermit(),e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY");assert.equal(s.status().savedRead.checkpointPending,false);bg.leave.resolve();await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();
 }
});
test("memory is sampled after atomic waiting and the unchanged 65/55 two-low-sample guard still refuses allocation",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s);let ratio=.3;const memory=createKeywordMonthlyMemoryAdmission({now:c.now,sampleMemory:()=>({ratio,sampledAt:c.now()})});const m=service(s,{memory:memory.run}),res=socket();const request=m.read(res);const rejected=assert.rejects(request,e=>e.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED"&&e.readGuard.reason==="high_watermark");await until(()=>s.status().savedRead.checkpointPending);ratio=.66;bg.leave.resolve();await rejected;assert.equal(m.reads(),0);await bg.passed.promise;bg.finish.resolve();await bg.work;
 assert.equal(memory.status().highWatermark,.65);assert.equal(memory.status().lowWatermark,.55);assert.equal(memory.status().resumeSamples,2);ratio=.54;await assert.rejects(memory.run(()=>assert.fail("first low cannot allocate")),e=>e.readGuard.reason==="low_watermark_recovery_pending");assert.equal(memory.status().lowSamples,1);assert.equal(await memory.run(()=>"second-low"),"second-low");await s.close();
});
test("after atomic waiting, real service response holders and producer cleanup fence a sibling publication",async()=>{
 const c=clock(),s=makeScheduler(c),reading=gate(),readEntered=gate(),encoding=gate(),encodingEntered=gate();let publicationEntered=false;
 const bg=await owner(s,{afterLoan:async()=>{await readEntered.promise;await atomic(async()=>{publicationEntered=true;assert.equal(s.status().savedRead.active,false);});}});
 const m=service(s,{savedRead:async()=>{readEntered.resolve();await reading.promise;return {status:"available",snapshot:{value:null,actualZero:0}};}}),first=socket(),second=socket();
 const firstDone=m.read(first,"same-scope",async()=>{encodingEntered.resolve();await encoding.promise;});await until(()=>s.status().savedRead.checkpointPending);assert.equal(m.reads(),0);bg.leave.resolve();await readEntered.promise;
 const secondDone=m.svc.withResponse("same-scope",second,async()=>{await reading.promise;return "shared-holder";});reading.resolve();await encodingEntered.promise;await secondDone;assert.equal(publicationEntered,false);assert.equal(m.svc.status().producers,1);
 first.finish();encoding.resolve();await firstDone;await turn();assert.equal(m.svc.status().producers,0);assert.equal(publicationEntered,false);assert.equal(s.status().savedRead.active,true);second.finish();await bg.passed.promise;assert.equal(publicationEntered,true);assert.equal(s.status().savedRead.active,false);assert.equal(m.svc.status().responseOwners,0);bg.finish.resolve();await bg.work;assert.equal(m.reads(),1);assert.equal(bg.attempts(),1);await s.close();
});

test("external checking that begins after reservation still refuses at the actual checkpoint",async()=>{
 const c=clock(),checking=gate();let count=0;const s=makeScheduler(c,{externalAdmission:()=>++count===1?{allowed:true}:count===2?checking.promise:{allowed:true}}),bg=await owner(s),permit=s.acquireSavedReadPermit();let reads=0;
 const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="external_checking");await c.advance(1000);assert.equal(s.status().maintenance.checking,true);bg.leave.resolve();await rejected;assert.equal(reads,0);permit.release();checking.resolve({allowed:true});await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();
});

test("owner cancellation while atomic is queued forbids allocation at the later checkpoint",async()=>{
 const c=clock(),s=makeScheduler(c),cancel=new AbortController(),bg=await owner(s,{signal:cancel.signal}),permit=s.acquireSavedReadPermit();let reads=0;
 const ready=permit.run(()=>{reads++;return {};});const rejected=assert.rejects(ready,e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="owner_aborted");cancel.abort();bg.leave.resolve();await rejected;assert.equal(reads,0);assert.equal(s.status().savedRead.active,false);assert.equal(s.status().savedRead.checkpointPending,false);permit.release();await permit.waitForRelease().catch(()=>{});await bg.passed.promise;bg.finish.resolve();await bg.work;await s.close();assert.equal(c.timers.size,0);
});

test("a second response during atomic pending is safely refused without releasing the first reservation",async()=>{
 const c=clock(),s=makeScheduler(c),bg=await owner(s),m=service(s),first=socket(),second=socket();const firstDone=m.read(first);await until(()=>s.status().savedRead.checkpointPending);
 await assert.rejects(m.svc.withResponse("same-scope",second,()=>assert.fail("pending atomic join must not run")),e=>e.code==="KEYWORD_MONTHLY_ANALYTICAL_BUSY"&&e.readGuard.reason==="response_window_closed");
 assert.equal(m.reads(),0);assert.equal(m.svc.status().responseOwners,1);assert.equal(s.status().savedRead.checkpointPending,true);bg.leave.resolve();assert.deepEqual(await firstDone,{status:"available",snapshot:{value:null,actualZero:0}});assert.equal(m.reads(),1);assert.equal(s.status().savedRead.active,true);first.finish();await bg.passed.promise;assert.equal(m.svc.status().responseOwners,0);assert.equal(m.svc.status().producers,0);bg.finish.resolve();await bg.work;await s.close();assert.equal(c.timers.size,0);
});

test.after(()=>{console.info=originalInfo;});
