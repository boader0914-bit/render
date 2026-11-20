"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{EventEmitter}=require("node:events");
const {createKeywordMonthlyRequestDiagnostics}=require("./lib/keyword_monthly_request_diagnostics.cjs");
const {createKeywordMonthlyQueryLifecycle}=require("./lib/keyword_monthly_query_lifecycle.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {measureKeywordMonthlyMetadata}=require("./lib/keyword_monthly_metadata_diagnostics.cjs");
const {withKeywordMonthlyGuardDiagnostic}=require("./lib/keyword_monthly_guard_diagnostics.cjs");
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function gate(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fakeClock(){let at=0;const timers=new Map();return {now:()=>at,setTimeoutImpl:(callback,ms)=>{const timer={unref(){}};timers.set(timer,{callback,at:at+ms});return timer;},clearTimeoutImpl:timer=>timers.delete(timer),
  advance(ms){at+=ms;for(const [timer,item]of[...timers])if(item.at<=at){timers.delete(timer);item.callback();}}};}
function pair(){const req=new EventEmitter(),res=new EventEmitter();req.method="GET";req.headers={};res.headers={};res.setHeader=(key,value)=>{res.headers[key]=value;};return {req,res};}
function fixture({catalogue,version=async()=>({status:"available"}),guard=async()=>{},memory=operation=>operation(),onLog=null,maxEventsPerWindow=60}={}){
  const clock=fakeClock(),logs=[],diagnostics=createKeywordMonthlyRequestDiagnostics({now:clock.now,onLog:onLog||((value)=>logs.push(value)),maxEventsPerWindow});
  const statusLifecycle=createKeywordMonthlyQueryLifecycle({...clock,maxInFlight:1,timeoutMs:5000});let calls=0;
  const service=createKeywordMonthlySavedReadService({saved:{options:async()=>({}),readPrepared:async()=>({}),analyze:async()=>({}),version:()=>version(clock),catalogue:async()=>{calls++;return catalogue(clock);}},
    runWork:()=>assert.fail("metadata must not enter financial scheduler"),acquirePermit:()=>assert.fail("metadata must not borrow a financial allocation"),assertReadAdmission:()=>guard(clock),
    runMemoryAdmission:operation=>memory(operation,clock),diagnostics});
  const handler=createKeywordMonthlyHttpHandler({service,statusLifecycle,requestDiagnostics:diagnostics,requireAdmin:()=>true,
    readRefreshStatus:async()=>({status:"complete"}),send:(res,status,body)=>{res.status=status;res.body=body;res.writableEnded=true;}});
  const request=(value=pair(),path="catalogue")=>({pair:value,promise:handler(value.req,value.res,new URL("https://fixture.test/api/keyword-monthly/"+path),{})});
  return {clock,logs,diagnostics,statusLifecycle,request,calls:()=>calls};
}

test("one actual catalogue owner and shared waiter retain late end, exact phases and the original HTTP timeout",async()=>{
  const blocked=gate(),f=fixture({guard:async clock=>clock.advance(2),memory:async(operation,clock)=>{clock.advance(3);return operation();},catalogue:async clock=>{
    await measureKeywordMonthlyMetadata("catalogue_open",async()=>{clock.advance(11);await blocked.promise;clock.advance(7);});
    await measureKeywordMonthlyMetadata("catalogue_project",()=>clock.advance(4));await measureKeywordMonthlyMetadata("catalogue_revalidate",()=>clock.advance(9));
    return {status:"available",metadataOnly:true,keywords:[]};
  }});
  const first=f.request(),second=f.request();await tick();assert.equal(f.calls(),1);f.clock.advance(6000);await Promise.all([first.promise,second.promise]);
  assert.equal(f.statusLifecycle.status().abandonedInFlight,1);assert.equal(first.pair.res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(second.pair.res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");
  assert.equal(first.pair.res.body.statusQueryDiagnostics.timeoutMs,5000);assert.equal(first.pair.res.body.statusQueryDiagnostics.abandonedInFlight,1);
  const during=f.diagnostics.status().recent,owner=during.find(row=>row.lifecycleRole==="owner"),waiter=during.find(row=>row.lifecycleRole==="waiter");
  assert.equal(owner.metadataStarted,true);assert.equal(owner.metadataFinished,false);assert.equal(owner.lifecycleWaiterOutcome,"timed_out");assert.equal(waiter.metadataStarted,false);assert.equal(waiter.workStarted,false);
  const blockedStatus=f.request(pair(),"refresh-status");await blockedStatus.promise;assert.equal(blockedStatus.pair.res.body.code,"KEYWORD_MONTHLY_QUERY_BUSY");
  assert.equal(blockedStatus.pair.res.body.statusQueryDiagnostics.abandonedInFlight,1,"status metadata is visible even when this same status lane is full");
  blocked.resolve();await tick();await tick();assert.equal(f.statusLifecycle.status().inFlight,0);
  const after=f.diagnostics.status().recent.find(row=>row.traceId===owner.traceId);
  assert.equal(after.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(after.metadataFinished,true);assert.equal(after.metadataFinishedAfterHandler,true);assert.equal(after.metadataOutcome,"failed");
  assert.equal(after.metadataErrorCode,"KEYWORD_MONTHLY_QUERY_ABORTED");assert.equal(after.metadataResultStatus,null);assert.equal(after.metadataResultCode,null);
  assert.equal(after.lifecycleOperationFinished,true);assert.equal(after.phases.memory_admission,3,"memory timing excludes admitted filesystem work");
  assert.equal(after.phases.conversion_guard,4);assert.equal(after.phaseCounts.conversion_guard,2);assert.equal(after.phases.catalogue_project,4);assert.equal(after.phases.catalogue_revalidate,9);
  assert.ok(after.phases.catalogue_open>=6000);assert.equal(after.phaseCounts.catalogue_open,1);assert.equal(f.calls(),1);
  const late=f.logs.filter(row=>row.event==="metadata_end"||row.event==="metadata_operation_settled");assert.equal(late.length,2);assert.ok(late.every(row=>row.traceId===owner.traceId));
  assert.equal(late.find(row=>row.event==="metadata_operation_settled").lifecycleOperationFinished,true);
  const status=f.request(pair(),"refresh-status");await status.promise;assert.equal(status.pair.res.status,200);assert.equal(status.pair.res.body.statusQueryDiagnostics.timeoutMs,5000);assert.ok(status.pair.res.body.statusResponseDiagnostics.maxResponseBytes<=2*1024*1024);
});

test("late original guard reason stays sanitized and distinct from an already returned timeout",async()=>{
  const blocked=gate(),f=fixture({catalogue:()=>measureKeywordMonthlyMetadata("catalogue_open",()=>blocked.promise)});
  const running=f.request();await tick();f.clock.advance(5000);await running.promise;
  const original=withKeywordMonthlyGuardDiagnostic(Object.assign(Error("private-cookie /secret/company"),{code:"KEYWORD_MONTHLY_ANALYTICAL_BUSY"}),
    {component:"scheduler",reason:"ineligible_owner",activeKind:"industry-build",observedAt:1,flags:{atomicWork:false},ownerToken:"private-owner",keyword:"private-keyword"});
  blocked.reject(original);await tick();await tick();const record=f.diagnostics.status().recent[0];
  assert.equal(record.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(record.readGuard,null);assert.equal(record.metadataOutcome,"failed");assert.equal(record.metadataErrorCode,"KEYWORD_MONTHLY_ANALYTICAL_BUSY");
  assert.equal(record.metadataReadGuard.component,"scheduler");assert.equal(record.metadataReadGuard.reason,"ineligible_owner");assert.equal(record.metadataReadGuard.activeKind,"industry-build");
  assert.equal(record.metadataFinishedAfterHandler,true);assert.ok(!JSON.stringify({logs:f.logs,status:f.diagnostics.status()}).includes("private"));
  record.metadataReadGuard.reason="changed";record.phaseCounts.catalogue_open=999;assert.equal(f.diagnostics.status().recent[0].metadataReadGuard.reason,"ineligible_owner");assert.equal(f.diagnostics.status().recent[0].phaseCounts.catalogue_open,1);
});

test("metadata cancellation cannot adopt a late returned verification refusal as a completed result",async()=>{
  const blocked=gate(),refusal=withKeywordMonthlyGuardDiagnostic({status:"needs_verification",diagnostics:["private-cookie /secret/company","KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"],keywords:[]},
    {component:"scheduler",reason:"ineligible_owner",activeKind:"industry-build",observedAt:1,ownerToken:"private-owner",keyword:"private-keyword"});
  const f=fixture({catalogue:async()=>{await blocked.promise;return refusal;}}),owner=f.request(),waiter=f.request();await tick();
  f.clock.advance(5000);await Promise.all([owner.promise,waiter.promise]);blocked.resolve();await tick();await tick();
  const records=f.diagnostics.status().recent,actual=records.find(row=>row.lifecycleRole==="owner"),shared=records.find(row=>row.lifecycleRole==="waiter");
  assert.equal(actual.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(actual.metadataOutcome,"failed");assert.equal(actual.metadataErrorCode,"KEYWORD_MONTHLY_QUERY_ABORTED");
  assert.equal(actual.metadataResultStatus,null);assert.equal(actual.metadataResultCode,null);
  assert.equal(actual.metadataReadGuard,null);assert.equal(actual.readGuard,null);
  assert.equal(actual.metadataFinishedAfterHandler,true);assert.equal(shared.metadataResultStatus,null);assert.equal(shared.metadataResultCode,null);assert.equal(shared.metadataReadGuard,null);
  const late=f.logs.filter(row=>row.event==="metadata_end"||row.event==="metadata_operation_settled");assert.equal(late.length,2);
  assert.ok(late.every(row=>row.traceId===actual.traceId&&row.metadataErrorCode==="KEYWORD_MONTHLY_QUERY_ABORTED"));
  assert.ok(!JSON.stringify({records,logs:f.logs}).includes("private"));
});

test("shared version reads record late canceled cleanup without adopting completion or verification values",async()=>{
  for(const refused of [false,true]){
    let reads=0;const blocked=gate(),value=refused?{status:"needs_verification",revision:null,diagnostics:["KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"]}
      :{status:"available",revision:"a".repeat(64),originalFreshnessVerified:false};
    const f=fixture({guard:()=>assert.fail("version cannot enter conversion guard"),memory:()=>assert.fail("version cannot claim graph memory"),version:async clock=>{
      reads++;await measureKeywordMonthlyMetadata("version_open",async()=>{clock.advance(2);await blocked.promise;});
      await measureKeywordMonthlyMetadata("version_revalidate",()=>clock.advance(3));return value;
    }}),first=f.request(pair(),"version"),second=f.request(pair(),"version");await tick();assert.equal(reads,1);
    f.clock.advance(5000);await Promise.all([first.promise,second.promise]);assert.equal(first.pair.res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(second.pair.res.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");
    assert.equal(f.statusLifecycle.status().abandonedInFlight,1);blocked.resolve();await tick();await tick();
    const records=f.diagnostics.status().recent,owner=records.find(row=>row.lifecycleRole==="owner"),waiter=records.find(row=>row.lifecycleRole==="waiter");
    assert.equal(owner.route,"version");assert.equal(owner.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(owner.metadataOutcome,"failed");assert.equal(owner.metadataErrorCode,"KEYWORD_MONTHLY_QUERY_ABORTED");assert.equal(owner.metadataFinishedAfterHandler,true);
    assert.equal(owner.lifecycleOperationFinished,true);assert.equal(owner.metadataResultStatus,null);assert.equal(owner.metadataResultCode,null);
    assert.equal(owner.phaseCounts.version_open,1);assert.equal(owner.phaseCounts.version_revalidate,1);assert.ok(owner.phases.version_open>=5000);assert.equal(owner.phases.version_revalidate,3);
    assert.equal(owner.workStarted,false);assert.equal(owner.task,null);assert.equal(waiter.metadataStarted,false);assert.equal(waiter.metadataResultStatus,null);assert.equal(f.statusLifecycle.status().inFlight,0);
    const late=f.logs.filter(row=>row.event==="metadata_end"||row.event==="metadata_operation_settled");assert.equal(late.length,2);assert.ok(late.every(row=>row.traceId===owner.traceId));
  }
});

test("a late version rejection retains its safe cause while observer failures cannot change returned version values",async()=>{
  const blocked=gate(),failure=withKeywordMonthlyGuardDiagnostic(Object.assign(Error("private path"),{code:"KEYWORD_MONTHLY_MEMORY_DEFERRED"}),
    {component:"memory",reason:"high_watermark",observedAt:1,memory:{ratio:.7,paused:true}}),f=fixture({version:()=>blocked.promise}),request=f.request(pair(),"version");
  await tick();f.clock.advance(5000);await request.promise;blocked.reject(failure);await tick();await tick();
  const record=f.diagnostics.status().recent[0];assert.equal(record.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(record.metadataOutcome,"failed");assert.equal(record.metadataErrorCode,failure.code);
  assert.equal(record.metadataReadGuard.reason,"high_watermark");assert.equal(record.metadataResultStatus,null);assert.equal(record.metadataResultCode,null);assert.equal(record.lifecycleOperationFinished,true);
  assert.ok(!JSON.stringify({logs:f.logs,status:f.diagnostics.status()}).includes("private"));
  const diagnostics=createKeywordMonthlyRequestDiagnostics({now:()=>{throw Error("private clock");},onLog:()=>Promise.reject(Error("private logger"))}),returned={status:"available",revision:"b".repeat(64)};
  const service=createKeywordMonthlySavedReadService({saved:{options:async()=>{},readPrepared:async()=>{},analyze:async()=>{},version:async()=>returned},diagnostics,
    runWork:()=>assert.fail("version work"),acquirePermit:()=>assert.fail("version permit"),assertReadAdmission:()=>assert.fail("version admission")});
  assert.equal(await diagnostics.run("version",()=>service.version()),returned);await tick();assert.equal(diagnostics.status().recent[0].metadataResultStatus,"available");
  for(const reason of [false,0,null,undefined]){
    const failureService=createKeywordMonthlySavedReadService({saved:{options:async()=>{},readPrepared:async()=>{},analyze:async()=>{},version:()=>Promise.reject(reason)},diagnostics,
      runWork:()=>assert.fail("version work"),acquirePermit:()=>assert.fail("version permit"),assertReadAdmission:()=>assert.fail("version admission")});
    await diagnostics.run("version",()=>failureService.version()).then(()=>assert.fail("rejection became success"),error=>assert.equal(error,reason));
  }
});

test("result observation is bounded and getter failures never alter the original returned value",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),hostile={};
  for(const key of ["status","code","diagnostics","readGuard"])Object.defineProperty(hostile,key,{get(){throw Error("private getter");}});
  assert.equal(await diagnostics.run("catalogue",()=>diagnostics.metadata(async()=>hostile)()),hostile);
  let record=diagnostics.status().recent[0];assert.equal(record.metadataOutcome,"completed");assert.equal(record.metadataResultStatus,null);assert.equal(record.metadataResultCode,null);assert.equal(record.metadataReadGuard,null);
  assert.ok(diagnostics.status().observerErrors>=3);
  let beyond=0;const values=Array.from({length:33},()=>"private payload");Object.defineProperty(values,32,{get(){beyond++;throw Error("beyond observation bound");}});
  const unknown={status:"private-status",code:"private-code",diagnostics:values};
  assert.equal(await diagnostics.run("catalogue",()=>diagnostics.metadata(async()=>unknown)()),unknown);
  record=diagnostics.status().recent.at(-1);assert.equal(record.metadataResultStatus,null);assert.equal(record.metadataResultCode,null);assert.equal(beyond,0);
  assert.ok(!JSON.stringify(diagnostics.status()).includes("private"));
});

test("memory denial and conversion denial preserve the denial with no catalogue read or financial permit",async()=>{
  for(const scope of ["memory","conversion"]){
    const denied=withKeywordMonthlyGuardDiagnostic(Object.assign(Error("private denial"),{code:scope==="memory"?"KEYWORD_MONTHLY_MEMORY_DEFERRED":"KEYWORD_MONTHLY_ANALYTICAL_BUSY"}),
      scope==="memory"?{component:"memory",reason:"high_watermark",activeKind:null,memory:{ratio:0.7,paused:true},observedAt:1}:{component:"scheduler",reason:"ineligible_owner",activeKind:"company-month",observedAt:1});
    const f=fixture({catalogue:()=>assert.fail("guarded catalogue"),...(scope==="memory"?{memory:()=>{throw denied;}}:{guard:()=>{throw denied;}})});
    const request=f.request();await request.promise;assert.equal(request.pair.res.body.code,denied.code);assert.equal(f.calls(),0);
    const record=f.diagnostics.status().recent[0];assert.equal(record.readGuard.reason,denied.readGuard.reason);assert.equal(record.metadataReadGuard.component,denied.readGuard.component);
    assert.equal(record.metadataOutcome,"failed");assert.equal(record.metadataFinishedAfterHandler,false);
    assert.equal(record.phaseCounts.conversion_guard,1);if(scope==="memory")assert.equal(record.phaseCounts.memory_admission,1);
  }
});

test("diagnostic logger/clock failures and lifecycle observer failures cannot change successful or falsy operation outcomes",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({now:()=>{throw Error("private clock");},onLog:()=>Promise.reject(Error("private logger"))});
  for(const reason of [undefined,null,false,0]){let rejected=false;await diagnostics.run("catalogue",()=>diagnostics.metadata(()=>Promise.reject(reason))()).then(()=>assert.fail("falsy rejection became success"),error=>{rejected=true;assert.equal(error,reason);});assert.equal(rejected,true);}
  const lifecycle=createKeywordMonthlyQueryLifecycle();const observed=()=>{throw Error("private observer");};
  assert.equal(await lifecycle.run("private identity",()=>42,{onLifecycleObservation:observed}),42);assert.ok(lifecycle.status().counters.observerErrors>=3);assert.equal(lifecycle.status().inFlight,0);
  assert.equal((await diagnostics.run("catalogue",()=>diagnostics.metadata(async()=>23)())),23);await tick();
  assert.ok(!JSON.stringify({status:diagnostics.status(),lifecycle:lifecycle.status()}).includes("private"));
});

test("metadata trace retention and emission remain bounded, including after the caller has ended",async()=>{
  let at=0;const logs=[],diagnostics=createKeywordMonthlyRequestDiagnostics({now:()=>++at,maxRecords:1,maxEventsPerWindow:1,onLog:value=>logs.push(value)});
  const blocked=gate(),first=diagnostics.run("catalogue",async()=>{const pending=diagnostics.metadata(()=>blocked.promise)();return pending;});
  await tick();await diagnostics.run("version",()=>1);blocked.resolve(3);assert.equal(await first,3);
  await diagnostics.run("catalogue",()=>diagnostics.metadata(async()=>5)());const status=diagnostics.status();
  assert.equal(status.recent.length,1);assert.equal(logs.length,1);assert.ok(status.droppedLogs>=3);assert.equal(status.metadataStarted,2);assert.equal(status.metadataFinished,2);
  await assert.rejects(diagnostics.measure("private-keyword",()=>1),TypeError);
});
