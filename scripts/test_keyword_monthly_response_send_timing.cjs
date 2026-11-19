"use strict";
// Tiny isolated module tests. No app, HTTP socket, provider, original data or
// analytical work is started; dependencies are small deterministic doubles.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const read=(arm,file)=>fs.readFileSync(path.join(__dirname,"lib",file),"utf8");
function diagnostics({now,onLog=null}={}){
 const module={exports:{}};vm.runInNewContext(read("candidate","keyword_monthly_request_diagnostics.cjs"),{module,
  require(name){if(["node:async_hooks","node:crypto"].includes(name))return require(name);
   if(name==="./keyword_monthly_guard_diagnostics.cjs")return{keywordMonthlyGuardDiagnosticFromError:()=>null};
   if(name==="./keyword_monthly_metadata_diagnostics.cjs")return{METADATA_PHASES:["conversion_guard","memory_admission","catalogue_open","catalogue_project","catalogue_revalidate","version_open","version_revalidate"],withKeywordMonthlyMetadataMeasure:(_,op)=>op()};
   assert.fail("unapproved diagnostic dependency");},console:{info(){assert.fail("unexpected logger");}}});
 return module.exports.createKeywordMonthlyRequestDiagnostics({now,onLog});
}
function httpFactory(arm,state){const module={exports:{}};
 const lifecycle=()=>({run:async(_,op)=>op(),status:()=>({inFlight:0,waitingCallers:0})});
 const budget=()=>({run:async(_,op)=>{await op({maxResponseBytes:65536,nativeResponse:true});return true;}});
 const dependencies={
  "./analytical_phase_runtime.cjs":{getAnalyticalPhaseDiagnostics:()=>({status:()=>({})})},
  "./keyword_monthly_query_lifecycle.cjs":{createKeywordMonthlyQueryLifecycle:lifecycle},
  "./keyword_monthly_response_budget.cjs":{createKeywordMonthlyResponseBudget:budget},
  "./bounded_company_response.cjs":{boundedJsonBuffer:body=>{state.at+=3;return Buffer.from(JSON.stringify(body));}},
  "./keyword_monthly_memory_admission.cjs":{runKeywordMonthlyMemoryAdmission:op=>op()},
  "./keyword_monthly_prepared_results.cjs":{KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS:{responseBytes:65536}},
  "./keyword_monthly_http_read_admission.cjs":{createKeywordMonthlyHttpReadAdmission:()=>async()=>{state.at+=2;}},
  "./keyword_monthly_request_diagnostics.cjs":{createKeywordMonthlyRequestDiagnostics:()=>assert.fail("explicit diagnostics required")},
  "./keyword_monthly_guard_diagnostics.cjs":{keywordMonthlyGuardDiagnosticFromError:()=>null}
 };
 vm.runInNewContext(read(arm,"keyword_monthly_http.cjs"),{module,AbortController,Buffer,require:name=>{assert.ok(Object.hasOwn(dependencies,name),name);return dependencies[name];}});
 return module.exports.createKeywordMonthlyHttpHandler;
}
function fixture({arm="candidate",failure=false,method="GET",route="/api/keyword-monthly/catalogue",legacy=false,throwSend=null,clockFails=false,logFails=false}={}){
 const state={at:0,sends:[],logs:[]};const d=diagnostics({now:()=>{if(clockFails)throw Error("PRIVATE_CLOCK");return state.at;},onLog:value=>{state.logs.push(value);if(logFails)throw Error("PRIVATE_LOG");}});
 const selected=legacy?Object.fromEntries(Object.entries(d).filter(([key])=>key!=="measureSync")):d;
 const sentinel={status:"available",readOnly:true,networkAttempted:false,private:"PRIVATE_BODY",snapshot:{rate:null,sold:0}};
 const service={options:async()=>sentinel,analyze:async()=>sentinel,catalogue:async()=>{state.at+=4;if(failure)throw Object.assign(Error("PRIVATE_ERROR"),{code:"KEYWORD_MONTHLY_MEMORY_DEFERRED"});return sentinel;}};
 const handler=httpFactory(arm,state)({service,requestDiagnostics:selected,requireAdmin:()=>true,
  send:(res,status,body)=>{state.sends.push({status,body,headers:{...res.headers}});state.at+=7;if(throwSend)throw throwSend;res.headersSent=true;return state.sends.length;}});
 const req={method,headers:{}},res={headers:{},setHeader(name,value){this.headers[name]=value;}};
 return{state,d,handler,req,res,sentinel,run:()=>handler(req,res,new URL("https://fixture.invalid"+route),{})};
}
test("a failed catalogue503 times the actual plain-object send without inventing serialize or wire-finish timing",async()=>{
 const f=fixture({failure:true});await f.run();const r=f.d.status().recent[0];
 assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0].status,503);assert.equal(f.state.sends[0].body.code,"KEYWORD_MONTHLY_MEMORY_DEFERRED");
 assert.equal(r.phases.admission,2);assert.equal(r.phases.read,4);assert.equal(r.phases.response_send,7);assert.equal(r.phaseCounts.response_send,1);assert.equal(r.elapsedMs,13);
 assert.equal(Object.hasOwn(r.phases,"serialize"),false);assert.equal(r.sendInvoked,true);assert.equal(r.handlerFinished,true);
 assert.doesNotMatch(f.state.sends[0].headers["Server-Timing"],/response_send/);assert.doesNotMatch(JSON.stringify({r,logs:f.state.logs}),/PRIVATE|fixture\.invalid|keyword=/);
});
test("native success keeps bounded JSON serialization and send invocation as separate completed phases",async()=>{
 const f=fixture();await f.run();const r=f.d.status().recent[0],sent=f.state.sends[0];assert.equal(sent.status,200);assert.ok(Buffer.isBuffer(sent.body));
 assert.equal(r.phases.serialize,3);assert.equal(r.phases.response_send,7);assert.equal(r.phases.read,4);assert.equal(r.phases.conversion_guard,2);assert.equal(r.elapsedMs,18);
 assert.match(sent.headers["Server-Timing"],/serialize;dur=3/);assert.doesNotMatch(sent.headers["Server-Timing"],/response_send/);
 assert.deepEqual(JSON.parse(sent.body.toString()),f.sentinel);assert.doesNotMatch(JSON.stringify({r,logs:f.state.logs}),/PRIVATE_BODY/);
});
test("405404400 and503 fallback sends preserve status/body and measure the synchronous invocation",async()=>{
 for(const config of[{method:"POST",status:405},{route:"/api/keyword-monthly/unknown",status:404},{route:"/api/keyword-monthly/catalogue?unexpected=1",status:400},{failure:true,status:503}]){
  const before=fixture({...config,legacy:true}),after=fixture(config);await before.run();await after.run();assert.equal(after.state.sends[0].status,config.status);
  assert.deepEqual(JSON.parse(JSON.stringify(after.state.sends[0].body)),JSON.parse(JSON.stringify(before.state.sends[0].body)));assert.equal(after.state.at,before.state.at);
  assert.equal(after.d.status().recent[0].phases.response_send,7);assert.equal(before.d.status().recent[0].phases.response_send,undefined);
 }
});
test("measureSync returns exact values/thenables synchronously and does not swallow a thrown value",async()=>{
 let at=0,thenCalls=0;const d=diagnostics({now:()=>at}),thenable={then(){thenCalls++;}};
 await d.run("data",()=>{for(const value of[undefined,null,false,0,42,thenable])assert.equal(d.measureSync("response_send",()=>{at+=1;return value;}),value);
  const original={private:"PRIVATE_THROW"};let caught=false;try{d.measureSync("response_send",()=>{at+=3;throw original;});}catch(e){assert.equal(e,original);caught=true;}assert.equal(caught,true);return true;});
 assert.equal(thenCalls,0);assert.equal(d.status().recent[0].phases.response_send,9);assert.equal(d.status().recent[0].phaseCounts.response_send,7);
 assert.doesNotMatch(JSON.stringify(d.status()),/PRIVATE_THROW/);for(const phase of["PRIVATE_PHASE","read","serialize"])assert.throws(()=>d.measureSync(phase,()=>0),{name:"TypeError"});
});
test("custom diagnostics without measureSync still call send exactly as before",async()=>{
 for(const failure of[false,true]){const f=fixture({legacy:true,failure});await f.run();assert.equal(f.state.sends.length,1);assert.equal(f.d.status().recent[0].phases.response_send,undefined);assert.ok(f.d.status().recent[0].elapsedMs>=7);}
});
test("send exceptions keep the same existing catch/reply behavior and preserve the original throw",async()=>{
 const original=Error("PRIVATE_SEND_EXCEPTION");for(const arm of["baseline","candidate"]){const f=fixture({arm,legacy:arm==="baseline",throwSend:original});await assert.rejects(f.run(),e=>e===original);assert.equal(f.state.sends.length,2);
  const r=f.d.status().recent[0];assert.equal(r.elapsedMs,25);if(arm==="candidate"){assert.equal(r.phases.response_send,14);assert.equal(r.phaseCounts.response_send,2);}assert.doesNotMatch(JSON.stringify(f.d.status()),/PRIVATE_SEND_EXCEPTION/);}
});
test("unavailable clocks and failed observers cannot change the send or expose exception text",async()=>{
 for(const options of[{clockFails:true},{logFails:true}]){const f=fixture(options);await f.run();assert.equal(f.state.sends.length,1);assert.equal(f.state.sends[0].status,200);assert.doesNotMatch(JSON.stringify(f.d.status()),/PRIVATE/);
  if(options.clockFails)assert.equal(f.d.status().recent[0].elapsedMs,null);else assert.ok(f.d.status().observerErrors>0);}
});
