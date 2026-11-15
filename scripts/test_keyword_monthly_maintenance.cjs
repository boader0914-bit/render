"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const M=require("./lib/keyword_monthly_maintenance.cjs"),{createAnalyticalWorkScheduler}=require("./lib/analytical_work_scheduler.cjs");
const turn=()=>new Promise(r=>setImmediate(r)),flush=async()=>{for(let i=0;i<6;i++)await turn();};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),"keyword-maintenance-test-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,"keyword_monthly_incremental"),{mode:0o700});return {root,file:path.join(root,"keyword_monthly_incremental",M.MAINTENANCE_FILE)};}
const lease=root=>M.acquirePreparedConversionLease({dataDir:root,mode:"stage",operationId:crypto.randomUUID(),contextSha256:"a".repeat(64)});
test("explicit conversion owns one private marker and release does not alter any source",async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.root,"original.json"),"unchanged");assert.equal((await M.readPreparedConversionAdmission({dataDir:f.root})).allowed,true);
 const l=await lease(f.root);assert.deepEqual(await M.readPreparedConversionAdmission({dataDir:f.root}),{allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"});
 await assert.rejects(lease(f.root),{code:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"});await l.release();await l.release();assert.equal((await M.readPreparedConversionAdmission({dataDir:f.root})).allowed,true);assert.equal(await fs.readFile(path.join(f.root,"original.json"),"utf8"),"unchanged");
});
test("an old marker remains held; malformed or replaced markers are never reclaimed",async t=>{
 const f=await fixture(t),l=await lease(f.root),row=JSON.parse(await fs.readFile(f.file,"utf8"));row.createdAt="2020-01-01T00:00:00.000Z";await fs.writeFile(f.file,JSON.stringify(row));
 assert.equal((await M.readPreparedConversionAdmission({dataDir:f.root})).reasonCode,"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE");await assert.rejects(l.release(),{code:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED"});
 const malformed="private unknown marker";await fs.writeFile(f.file,malformed);const result=await M.readPreparedConversionAdmission({dataDir:f.root});assert.deepEqual(result,{allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED"});assert.ok(!JSON.stringify(result).includes(malformed));assert.equal(await fs.readFile(f.file,"utf8"),malformed);
});
test("a hardlinked or redirected marker holds admission rather than following it",async t=>{
 const f=await fixture(t);await lease(f.root);await fs.link(f.file,path.join(f.root,"marker-evidence"));assert.equal((await M.readPreparedConversionAdmission({dataDir:f.root})).reasonCode,"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED");
});
function clock(){let now=0,seq=0;const timers=new Map();return {now:()=>now,setTimeoutImpl(fn,ms){const h={id:++seq,unref(){}};timers.set(h,{fn,at:now+ms});return h;},clearTimeoutImpl:h=>timers.delete(h),async advance(ms){now+=ms;for(const[h,v]of[...timers])if(v.at<=now){timers.delete(h);v.fn();}await flush();},timers:()=>timers.size};}
test("maintenance holds new foreground and background allocation then resumes normal single ownership",async()=>{
 const c=clock();let hold=true,invoked=0;const s=createAnalyticalWorkScheduler({...c,externalAdmission:async()=>({allowed:!hold,reasonCode:hold?"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE":null})});
 const tasks=[s.run(()=>{invoked++;return "fg";}),s.run(()=>{invoked++;return "bg";},{priority:"background"})];await flush();assert.equal(invoked,0);assert.equal(s.status().maintenance.paused,true);assert.equal(s.status().active,false);
 await c.advance(1000);assert.equal(invoked,0);hold=false;await c.advance(1000);assert.deepEqual(await Promise.all(tasks),["fg","bg"]);assert.equal(invoked,2);await s.close();assert.equal(c.timers(),0);
});
test("an admission timeout retains unfinished ownership and discards its late allow",async()=>{
 const c=clock();let resolve,calls=0,ran=false;const pending=new Promise(r=>resolve=r);const s=createAnalyticalWorkScheduler({...c,externalAdmissionTimeoutMs:50,externalAdmission:()=>{calls++;return calls===1?pending:{allowed:false};}});
 const job=s.run(()=>{ran=true;});const rejected=assert.rejects(job,{code:"ANALYTICAL_WORK_CLOSED"});await flush();await c.advance(50);assert.equal(s.status().maintenance.checking,true);await c.advance(10000);assert.equal(calls,1);assert.equal(ran,false);resolve({allowed:true});await flush();assert.equal(ran,false);assert.equal(s.status().maintenance.paused,true);await c.advance(1000);assert.equal(calls,2);assert.equal(ran,false);await s.close();await rejected;assert.equal(c.timers(),0);
});
test("shutdown clears pending admission and no late callback launches a task",async()=>{
 const c=clock();let resolve,ran=false;const s=createAnalyticalWorkScheduler({...c,externalAdmission:()=>new Promise(r=>resolve=r)}),job=s.run(()=>{ran=true;});const rejected=assert.rejects(job,{code:"ANALYTICAL_WORK_CLOSED"});await flush();assert.equal(c.timers(),1);await s.close();await rejected;assert.equal(c.timers(),0);resolve({allowed:true});await flush();assert.equal(ran,false);assert.equal(s.status().maintenance.checking,false);
});
