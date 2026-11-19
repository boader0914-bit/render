"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const {createKeywordMonthlyMemoryAdmission,keywordMonthlyAllocationCheckpoint}=require("./lib/keyword_monthly_memory_admission.cjs");
const {MEMORY_COMPONENT_FIELDS}=require("./lib/keyword_monthly_guard_diagnostics.cjs");
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(ratios){let calls=0;const guard=createKeywordMonthlyMemoryAdmission({now:()=>1000,sampleMemory:()=>({ratio:ratios[Math.min(calls++,ratios.length-1)],sampledAt:1000})});return {guard,calls:()=>calls};}
test("high pressure rejects before allocation without starting work or waiting",async()=>{
  const {guard}=fixture([0.8]);let allocated=false;
  await assert.rejects(guard.run(()=>{allocated=true;}),e=>e.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED"&&e.deferred===true&&e.statusCode===503);
  assert.equal(allocated,false);assert.equal(guard.status().admitted,0);assert.equal(guard.status().deferred,1);
});
test("allocation boundaries recheck pressure before decoding and before either month's snapshot",async()=>{
  const {guard,calls}=fixture([0.2,0.3,0.7]);const reached=[];
  await assert.rejects(guard.run(async()=>{
    await keywordMonthlyAllocationCheckpoint("keyword_projection_read");reached.push("decoded");
    await keywordMonthlyAllocationCheckpoint("keyword_snapshot_current");reached.push("snapshot");
  }),e=>e.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED");
  assert.deepEqual(reached,["decoded"]);assert.equal(calls(),3);assert.equal(guard.status().checkpoints,2);
});
test("low-water hysteresis requires two low observations and does not silently reset on middle pressure",async()=>{
  const {guard}=fixture([0.8,0.6,0.5,0.5]);let calls=0;
  for(let i=0;i<3;i++)await assert.rejects(guard.run(()=>++calls),e=>e.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED");
  assert.equal(await guard.run(()=>++calls),1);assert.equal(guard.status().paused,false);assert.equal(guard.status().lowSamples,0);
});
test("missing invalid stale future and failed samples fail closed without private error text",async()=>{
  for(const read of [()=>null,()=>({ratio:NaN,sampledAt:1000}),()=>({ratio:0.2,sampledAt:-10001}),()=>({ratio:0.2,sampledAt:3000}),()=>{throw Error("private host paths and secrets");}]){
    const guard=createKeywordMonthlyMemoryAdmission({now:()=>1000,sampleMemory:read});
    await assert.rejects(guard.run(()=>assert.fail("unsafe admission")),e=>e.code==="KEYWORD_MONTHLY_MEMORY_UNAVAILABLE");
    assert.equal(guard.status().ratio,null);assert.equal(guard.status().sampledAt,null);assert.equal(guard.status().paused,true);
    assert.ok(!JSON.stringify(guard.status()).includes("private"));
  }
});
test("small index phase is not sampled as a large allocation and there is no effect outside the owned read",async()=>{
  const {guard,calls}=fixture([0.2]);
  await keywordMonthlyAllocationCheckpoint("keyword_snapshot_current");assert.equal(calls(),0);
  assert.equal(await guard.run(async()=>{await keywordMonthlyAllocationCheckpoint("keyword_index_read");return 17;}),17);
  assert.equal(calls(),1);
});
test("same guard reenters its owner but a different guard enforces its own memory policy",async()=>{
  const a=fixture([0.2]),b=fixture([0.9]);
  assert.equal(await a.guard.run(()=>a.guard.run(()=>5)),5);assert.equal(a.calls(),2);
  await assert.rejects(a.guard.run(()=>b.guard.run(()=>assert.fail("different guard bypassed"))),e=>e.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED");
  assert.equal(b.calls(),1);
});
test("completed inherited async contexts cannot sample a released owner and a later read is admitted afresh",async()=>{
  const {guard,calls}=fixture([0.2]);let release,late;
  const gate=new Promise(resolve=>{release=resolve;});
  await guard.run(()=>{late=gate.then(async()=>{await keywordMonthlyAllocationCheckpoint("keyword_compare");return guard.run(()=>8);});return 1;});
  release();assert.equal(await late,8);assert.equal(calls(),2);
});
test("operation failures and falsy rejection reasons are preserved while cleanup releases context",async()=>{
  const {guard,calls}=fixture([0.2]);
  for(const reason of [undefined,false,new Error("original")]){
    await guard.run(()=>Promise.reject(reason)).then(()=>assert.fail("unexpected success"),error=>assert.equal(error,reason));
    await keywordMonthlyAllocationCheckpoint("keyword_projection_read");
  }
  await flush();assert.equal(calls(),3);
});
test("a .71 denial preserves separate heap/live numeric axes without changing the authoritative admission ratio",async()=>{
  for(const highAxis of ["heap","live"]){let samples=0;
    const components={heapUsedBytes:highAxis==="heap"?710:300,heapLimitBytes:1000,heapRatio:highAxis==="heap"?.71:.3,
      liveAllocationRatio:highAxis==="live"?.71:.4,estimatedLiveBytes:highAxis==="live"?1420:800,limitBytes:2000,rssBytes:1600};
    const guard=createKeywordMonthlyMemoryAdmission({now:()=>1000,sampleMemory:()=>{samples++;return{ratio:.71,sampledAt:1000,...components,cgroupEvents:"private secret",owner:"private path",externalBytes:999};}});
    let failure;await guard.run(()=>assert.fail("high pressure allocation")).catch(error=>{failure=error;});
    assert.equal(failure.code,"KEYWORD_MONTHLY_MEMORY_DEFERRED");assert.equal(failure.readGuard.reason,"high_watermark");assert.equal(failure.readGuard.memory.ratio,.71);
    for(const key of MEMORY_COMPONENT_FIELDS)assert.equal(failure.readGuard.memory[key],components[key]);
    assert.equal(samples,1);assert.equal(guard.status().highWatermark,.65);assert.equal(guard.status().lowWatermark,.55);assert.equal(guard.status().resumeSamples,2);
    const snapshot=guard.status();snapshot.heapUsedBytes=0;assert.equal(guard.status().heapUsedBytes,components.heapUsedBytes);assert.ok(Object.isFrozen(failure.readGuard.memory));
    assert.equal(JSON.stringify({status:guard.status(),readGuard:failure.readGuard}).includes("private"),false);assert.equal(Object.hasOwn(guard.status(),"externalBytes"),false);
  }
});
test("invalid or stale samples clear all retained components and do not mutate an earlier denial snapshot",async()=>{
  for(const invalid of [{ratio:NaN,sampledAt:1000},{ratio:.2,sampledAt:-10001},null]){
    let calls=0;const guard=createKeywordMonthlyMemoryAdmission({now:()=>1000,sampleMemory:()=>++calls===1?{ratio:.71,sampledAt:1000,heapRatio:.71,heapUsedBytes:710,heapLimitBytes:1000,rssBytes:1600}:invalid});
    let first;await guard.run(()=>{}).catch(error=>{first=error;});
    await assert.rejects(guard.run(()=>assert.fail("invalid sample")),error=>{assert.equal(error.code,"KEYWORD_MONTHLY_MEMORY_UNAVAILABLE");for(const key of MEMORY_COMPONENT_FIELDS)assert.equal(error.readGuard.memory[key],null);return true;});
    for(const key of MEMORY_COMPONENT_FIELDS)assert.equal(guard.status()[key],null);assert.equal(first.readGuard.memory.heapRatio,.71);assert.equal(first.readGuard.memory.rssBytes,1600);assert.equal(calls,2);
  }
});
test("optional diagnostic getters cannot mutate validated admission ratio, timestamps or hysteresis decisions",async()=>{
  for(const throws of [false,true]){
    let calls=0;const sample={ratio:.71,sampledAt:1000};Object.defineProperty(sample,"heapRatio",{get(){sample.ratio=.1;sample.sampledAt=-100000;if(throws)throw Error("private diagnostic getter");return .71;}});
    const guard=createKeywordMonthlyMemoryAdmission({now:()=>1000,sampleMemory:()=>{calls++;return sample;}});
    await assert.rejects(guard.run(()=>assert.fail("diagnostic getter changed admission")),error=>error.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED"&&error.readGuard.reason==="high_watermark"&&error.readGuard.memory.ratio===.71&&error.readGuard.memory.sampledAt===1000);
    assert.equal(calls,1);assert.equal(guard.status().ratio,.71);assert.equal(guard.status().sampledAt,1000);assert.equal(guard.status().lowSamples,0);assert.equal(guard.status().paused,true);
    assert.equal(guard.status().heapRatio,throws?null:.71);assert.equal(JSON.stringify(guard.status()).includes("private"),false);
  }
});
test("default adapter reads the existing sample details once and status queries never sample or inspect them again",async()=>{
  const source=fs.readFileSync(path.join(__dirname,"lib/keyword_monthly_memory_admission.cjs"),"utf8"),module={exports:{}};let samples=0,detailReads=0,throwDetails=false;
  const sampler={sample(){samples++;return{ratio:.71,sampledAt:1000};},status(){detailReads++;if(throwDetails)throw Error("private detail error");return{sampledAt:1000,heapRatio:.71,heapUsedBytes:710,heapLimitBytes:1000,liveAllocationRatio:.4,estimatedLiveBytes:800,limitBytes:2000,rssBytes:1600,cgroupEvents:"private event body"};}};
  vm.runInNewContext(source,{module,require:id=>id==="./analytical_memory.cjs"?{createAnalyticalMemorySampler:()=>sampler}:id==="./keyword_monthly_guard_diagnostics.cjs"?require("./lib/keyword_monthly_guard_diagnostics.cjs"):require(id)});
  const guard=module.exports.createKeywordMonthlyMemoryAdmission({now:()=>1000});await assert.rejects(guard.run(()=>assert.fail("high pressure")),error=>error.readGuard.memory.heapRatio===.71);
  for(let i=0;i<20;i++){guard.status();module.exports.readKeywordMonthlyMemoryAdmissionState();}assert.equal(samples,1);assert.equal(detailReads,1);
  throwDetails=true;const withoutDetails=module.exports.createKeywordMonthlyMemoryAdmission({now:()=>1000});await assert.rejects(withoutDetails.run(()=>assert.fail("observer failure bypassed ratio")),error=>error.code==="KEYWORD_MONTHLY_MEMORY_DEFERRED"&&error.readGuard.memory.ratio===.71);
  assert.equal(samples,2);assert.equal(detailReads,2);assert.equal(JSON.stringify(guard.status()).includes("private"),false);
});
