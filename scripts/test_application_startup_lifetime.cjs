"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),{spawnSync}=require("node:child_process");
const {createApplicationStartupLifetime}=require("./lib/application_startup_lifetime.cjs");
const schedulerFile=path.join(__dirname,"lib/analytical_work_scheduler.cjs"),helperFile=path.join(__dirname,"lib/application_startup_lifetime.cjs");
function subprocess(mode,hold){
  const script=`const http=require('node:http');const {createAnalyticalWorkScheduler}=require(${JSON.stringify(schedulerFile)});const {createApplicationStartupLifetime}=require(${JSON.stringify(helperFile)});const server=http.createServer();let release,completed=false,started=false;const gate=new Promise(resolve=>release=resolve);const s=createAnalyticalWorkScheduler(${mode==="external"?"{externalAdmission:()=>gate}":"{sampleMemory:()=>gate}"});const life=createApplicationStartupLifetime({onLog:null});if(${hold})life.begin();process.once('exit',()=>console.log(JSON.stringify({completed,started,serverListening:server.listening,queued:s.status().queuedForeground+s.status().queuedBackground})));const work=s.run(()=>{started=true;return 'ready';},{kind:'synthetic-startup',priority:${JSON.stringify(mode==="external"?"foreground":"background")}});const result=${hold}?life.phase('company_bootstrap',()=>work):work;result.then(()=>{completed=true;if(${hold})life.complete();return s.close();});const timer=setTimeout(()=>release(${mode==="external"?"{allowed:true,reasonCode:null}":"{ratio:.1,sampledAt:Date.now()}"}),30);timer.unref();`;
  const result=spawnSync(process.execPath,["--eval",script],{encoding:"utf8",timeout:3000,maxBuffer:128*1024});assert.ifError(result.error);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}
for(const mode of ["external","memory"])test("actual scheduler pending "+mode+" admission exits silently without an owner; referenced startup lifetime waits for guarded completion",()=>{
  const unowned=subprocess(mode,false);assert.equal(unowned.completed,false);assert.equal(unowned.started,false);assert.equal(unowned.serverListening,false);assert.equal(unowned.queued,1);
  const held=subprocess(mode,true);assert.equal(held.completed,true);assert.equal(held.started,true);assert.equal(held.serverListening,false);assert.equal(held.queued,0);
});
test("safe phase logging cannot reveal raw analytical fields or exceptions and does not change operation failures",async()=>{
  let callback,cleared=0,refs=0,now=0;const logs=[];
  const life=createApplicationStartupLifetime({now:()=>now,onLog:event=>logs.push(event),setIntervalImpl:fn=>{callback=fn;return {ref(){refs++;}};},clearIntervalImpl:()=>{cleared++;},heartbeatMs:1000,
    readAnalyticalStatus:()=>({active:true,activeKind:"PRIVATE_KEYWORD_OR_PATH",queuedForeground:2,queuedBackground:0,memory:{paused:false,ratio:.44,password:"PRIVATE"},maintenance:{paused:true,reasonCode:"PRIVATE_VALUE"},jobs:[{ownerToken:"PRIVATE"}]})});
  life.begin();assert.equal(refs,1);const error=Object.assign(new Error("PRIVATE error and path"),{code:"ANALYTICAL_WORK_CLOSED"});await assert.rejects(life.phase("company_bootstrap",async()=>{now=1000;callback();throw error;}),value=>value===error);
  assert.ok(logs.some(event=>event.event==="pending"));assert.ok(logs.some(event=>event.event==="phase_failed"&&event.code==="ANALYTICAL_WORK_CLOSED"));assert.ok(!JSON.stringify(logs).includes("PRIVATE"));assert.equal(logs[0].analytical.activeKind,"other");assert.equal(logs[0].analytical.maintenanceReasonCode,"ANALYTICAL_MAINTENANCE_OTHER");life.fail(error);assert.equal(cleared,1);assert.equal(life.status().terminal,"failed");
});
test("phase order, own timer cleanup and explicit readiness are preserved even when diagnostic observers fail",async()=>{
  let cleared=0;const calls=[];const life=createApplicationStartupLifetime({onLog:()=>{throw Error("observer");},setIntervalImpl:()=>({ref(){}}),clearIntervalImpl:()=>{cleared++;}});life.begin();
  for(const phase of ["seed_outputs","collector_coordination","rotation_state","company_bootstrap","monthly_selector","integrated_catalog","integrated_revision","listen"])await life.phase(phase,async()=>{calls.push(phase);assert.throws(()=>life.complete(),/APPLICATION_STARTUP_PHASE_PENDING/);});
  life.complete();life.complete();assert.equal(calls.length,8);assert.equal(cleared,1);assert.equal(life.status().phasesCompleted,8);assert.equal(life.status().terminal,"listening");assert.ok(life.status().observerErrors>0);
});
test("lifetime setup failures remain failures and clear only the timer they own",()=>{
  let cleared=0;const error=new Error("ref setup");const life=createApplicationStartupLifetime({onLog:null,setIntervalImpl:()=>({ref(){throw error;}}),clearIntervalImpl:()=>{cleared++;}});assert.throws(()=>life.begin(),value=>value===error);assert.equal(cleared,1);assert.equal(life.status().active,false);
});
