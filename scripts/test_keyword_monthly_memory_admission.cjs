"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createKeywordMonthlyMemoryAdmission,keywordMonthlyAllocationCheckpoint}=require("./lib/keyword_monthly_memory_admission.cjs");
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
