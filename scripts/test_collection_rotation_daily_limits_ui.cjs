"use strict";
const assert=require("node:assert/strict"),{test}=require("node:test");
const {regularSixReady,regularSixInput}=require("../web/collection_rotation_controls.js");
const fixture=()=>({enabled:true,active:false,reason:null,revision:2,config:{time:"09:00",keywordIntervalMinutes:120,keywords:Array.from({length:13},(_,i)=>`검증${i}`),workers:[{workerKey:"web",dailyLimit:2},{workerKey:"manual",dailyLimit:2}]}});
test("regular six control submits only current revision and worker limits",()=>{
 const current=fixture(),before=JSON.stringify(current),body=regularSixInput(current);
 assert.equal(regularSixReady(current),true);
 assert.deepEqual(body,{expectedRevision:2,workers:[{workerKey:"web",dailyLimit:3},{workerKey:"manual",dailyLimit:3}]});
 assert.equal(Object.hasOwn(body,"enabled"),false);assert.equal(Object.hasOwn(body,"config"),false);assert.equal(JSON.stringify(current),before);
});
test("regular six control never resumes stopped, protected, active, stale or incompatible plans",()=>{
 for(const change of [{enabled:false},{active:true},{reason:"ROTATION_PROVIDER_BLOCKED"},{revision:0}]){const state={...fixture(),...change};assert.equal(regularSixReady(state),false);assert.throws(()=>regularSixInput(state));}
 for(const change of [{time:"10:00"},{keywordIntervalMinutes:60},{workers:[{workerKey:"web",dailyLimit:3},{workerKey:"manual",dailyLimit:3}]},{workers:[{workerKey:"manual",dailyLimit:2},{workerKey:"web",dailyLimit:2}]}]){const state=fixture();Object.assign(state.config,change);assert.equal(regularSixReady(state),false);assert.throws(()=>regularSixInput(state));}
});
