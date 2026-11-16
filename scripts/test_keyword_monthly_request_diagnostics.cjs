"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createKeywordMonthlyRequestDiagnostics}=require("./lib/keyword_monthly_request_diagnostics.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {createKeywordMonthlyQueryLifecycle}=require("./lib/keyword_monthly_query_lifecycle.cjs");
const {createAnalyticalWorkScheduler}=require("./lib/analytical_work_scheduler.cjs");
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function request(handler,keyword="private-keyword"){const res={headers:{},setHeader(key,value){this.headers[key]=value;}};return handler({method:"GET"},res,new URL("https://example.test/api/keyword-monthly?keyword="+keyword+"&month=2026-11"),{}).then(()=>res);}

test("concurrent shared reads retain distinct request IDs and only the owner observes the actual scheduler timing",async()=>{
  const logs=[],diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:event=>logs.push(event)}),scheduler=createAnalyticalWorkScheduler();
  const blocked=gate();let operations=0;
  const service={options:async()=>({status:"available"}),analyze:()=>scheduler.run(diagnostics.work(async()=>{operations++;await blocked.promise;return {status:"available",snapshot:{rate:null,sold:0}};}),{kind:"keyword_monthly_analysis",...diagnostics.schedulerOptions()})};
  const handler=createKeywordMonthlyHttpHandler({service,requestDiagnostics:diagnostics,requireAdmin:()=>true,send:(res,status,body)=>Object.assign(res,{status,body})});
  try{
    const first=request(handler),second=request(handler);await immediate();assert.equal(operations,1);blocked.resolve();
    const responses=await Promise.all([first,second]);assert.notEqual(responses[0].headers["X-Keyword-Monthly-Trace"],responses[1].headers["X-Keyword-Monthly-Trace"]);
    const records=diagnostics.status().recent;assert.equal(records.length,2);assert.equal(records.filter(r=>r.taskTimingObserved).length,1);assert.equal(records.filter(r=>r.task===null).length,1);
    const owner=records.find(r=>r.taskTimingObserved);assert.ok(owner.task.queueWaitMs>=0);assert.ok(owner.task.leaseMs>=0);assert.equal(owner.taskTimingObservedAfterHandler,false);assert.equal(owner.workStarted,true);assert.equal(owner.workFinished,true);assert.ok(owner.queueWaitAtStartMs>=0);
    for(const response of responses){assert.equal(response.status,200);assert.deepEqual(response.body.snapshot,{rate:null,sold:0});}
    assert.ok(!JSON.stringify({records,logs}).includes("private-keyword"));
  }finally{scheduler.close();}
});

test("late work after caller timeout remains tracked and is explicitly marked after handler completion",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),scheduler=createAnalyticalWorkScheduler(),blocked=gate();
  const lifecycle=createKeywordMonthlyQueryLifecycle({timeoutMs:5});
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({status:"available"}),analyze:()=>scheduler.run(diagnostics.work(async()=>{await blocked.promise;return {status:"missing",snapshot:null};}),{kind:"keyword_monthly_analysis",...diagnostics.schedulerOptions()})},
    requestDiagnostics:diagnostics,queryLifecycle:lifecycle,requireAdmin:()=>true,send:(res,status,body)=>Object.assign(res,{status,body})});
  const keepAlive=setTimeout(()=>{},1000);
  try{
    const response=await request(handler);assert.equal(response.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(diagnostics.status().recent[0].task,null);assert.equal(lifecycle.status().abandonedInFlight,1);
    const waiting=diagnostics.status().recent[0];assert.equal(waiting.workStarted,true);assert.equal(waiting.workFinished,false);assert.equal(waiting.workStateAtHandlerEnd,"running");assert.equal(waiting.workStartedAfterHandler,false);assert.ok(waiting.workElapsedAtHandlerEndMs>=0);assert.ok(waiting.workElapsedMs>=0);assert.ok(waiting.queueWaitAtStartMs>=0);
    blocked.resolve();await immediate();await immediate();const record=diagnostics.status().recent[0];
    assert.equal(record.responseCode,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(record.taskTimingObservedAfterHandler,true);assert.equal(record.task.outcome,"completed");assert.equal(record.workStateAtHandlerEnd,"running");assert.equal(record.workStartedAfterHandler,false);assert.equal(lifecycle.status().inFlight,0);
  }finally{clearTimeout(keepAlive);lifecycle.close();scheduler.close();}
});

test("a deadline behind another lease records no start and cannot mislabel queue wait as saved-data work",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null}),scheduler=createAnalyticalWorkScheduler(),blocked=gate();
  const busy=scheduler.run(()=>blocked.promise,{kind:"synthetic_existing_owner"});await immediate();
  const lifecycle=createKeywordMonthlyQueryLifecycle({timeoutMs:5});
  const handler=createKeywordMonthlyHttpHandler({service:{options:async()=>({status:"available"}),analyze:()=>scheduler.run(diagnostics.work(async()=>({status:"missing",snapshot:null})),{kind:"keyword_monthly_analysis",...diagnostics.schedulerOptions()})},
    requestDiagnostics:diagnostics,queryLifecycle:lifecycle,requireAdmin:()=>true,send:(res,status,body)=>Object.assign(res,{status,body})});
  const keepAlive=setTimeout(()=>{},1000);
  try{
    const response=await request(handler);assert.equal(response.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");
    const queued=diagnostics.status().recent[0];assert.equal(queued.workStarted,false);assert.equal(queued.workElapsedMs,null);assert.equal(queued.workElapsedAtHandlerEndMs,null);assert.equal(queued.workStateAtHandlerEnd,"not_observed");assert.equal(queued.queueWaitAtStartMs,null);assert.equal(queued.taskTimingObserved,false);
    blocked.resolve();await busy;await immediate();await immediate();
    const completed=diagnostics.status().recent[0];assert.equal(completed.workStarted,true);assert.equal(completed.workFinished,true);assert.equal(completed.workStartedAfterHandler,true);assert.equal(completed.workStateAtHandlerEnd,"not_observed");assert.equal(completed.workElapsedAtHandlerEndMs,null);assert.ok(completed.queueWaitAtStartMs>=0);assert.equal(completed.taskTimingObservedAfterHandler,true);
  }finally{clearTimeout(keepAlive);lifecycle.close();scheduler.close();}
});

test("safe fixed fields, bounded retention/logs, caller mutation and observer failure cannot expose source data or fail a request",async()=>{
  let now=0;const logs=[];const diagnostics=createKeywordMonthlyRequestDiagnostics({now:()=>now++,maxRecords:2,maxEventsPerWindow:1,onLog:event=>{logs.push(event);throw new Error("private observer path");}});
  for(let index=0;index<3;index++)await diagnostics.run("options",async()=>{
    await diagnostics.measure("read",async()=>42);
    diagnostics.schedulerOptions().onTaskTiming({outcome:"completed",queueWaitMs:4,leaseMs:8,busyWaitMs:3,memoryWaitMs:0,samplingWaitMs:0,otherWaitMs:1,errorCode:"private /secret",url:"private",input:{token:"private"}});
    const res={setHeader(){throw new Error("header failure");}};diagnostics.response(res,200,"private /token");
  });
  const observed=diagnostics.status();assert.equal(observed.recent.length,2);assert.equal(logs.length,1);assert.ok(observed.droppedLogs>=2);assert.ok(observed.observerErrors>=1);
  assert.equal(observed.recent[0].responseCode,null);assert.equal(observed.recent[0].task.errorCode,null);
  assert.ok(!JSON.stringify({observed,logs}).includes("private"));
  observed.recent[0].phases.read=999999;observed.recent[0].task.queueWaitMs=999999;assert.notEqual(diagnostics.status().recent[0].phases.read,999999);assert.equal(diagnostics.status().recent[0].task.queueWaitMs,4);
  await assert.rejects(diagnostics.run("private-keyword",()=>{}),TypeError);
});

test("unavailable diagnostic clock or rejected logger does not change the original operation result",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({now:()=>{throw new Error("clock");},onLog:()=>Promise.reject(new Error("logger"))});
  const result=await diagnostics.run("data",()=>diagnostics.measure("read",async()=>({rate:null,sold:0})));
  assert.deepEqual(result,{rate:null,sold:0});assert.equal(diagnostics.status().recent[0].elapsedMs,null);assert.equal(diagnostics.status().recent[0].task,null);
});
