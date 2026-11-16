"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createKeywordMonthlyHttpReadAdmission } = require("./lib/keyword_monthly_http_read_admission.cjs");
const { createKeywordMonthlyHttpHandler } = require("./lib/keyword_monthly_http.cjs");
const { createKeywordMonthlyQueryLifecycle } = require("./lib/keyword_monthly_query_lifecycle.cjs");
const { createAnalyticalWorkScheduler } = require("./lib/analytical_work_scheduler.cjs");
const { acquirePreparedConversionLease, readPreparedConversionAdmission, MAINTENANCE_FILE } = require("./lib/keyword_monthly_maintenance.cjs");
const { createKeywordMonthlyRequestDiagnostics } = require("./lib/keyword_monthly_request_diagnostics.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const url = route => new URL(route,"https://example.test");
const optionsRoute = "/api/keyword-monthly/options", dataRoute = "/api/keyword-monthly?keyword=synthetic&month=2026-11";
function http(overrides = {}) {
  const calls = [];
  const handler = createKeywordMonthlyHttpHandler({ service: { options: async()=>{calls.push("options");return {status:"available",keywords:[]};}, analyze:async()=>{calls.push("data");return {status:"missing",snapshot:null};} },
    requireAdmin:()=>true, send:(res,status,body)=>Object.assign(res,{status,body}), ...overrides });
  return { calls, run: async(route,method="GET")=>{const res={headers:{},setHeader(key,value){this.headers[key]=value;}};await handler({method},res,url(route),{});return res;} };
}

test("prepared-conversion preflight admits only verified absence and fails closed within its fixed deadline",async()=>{
  await createKeywordMonthlyHttpReadAdmission()();
  await createKeywordMonthlyHttpReadAdmission({readAdmission:async()=>({allowed:true,reasonCode:null})})();
  for (const result of [null,{}, {allowed:true,reasonCode:"unexpected"},{allowed:false,reasonCode:"unknown"}]) {
    await assert.rejects(createKeywordMonthlyHttpReadAdmission({readAdmission:async()=>result})(),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED"});
  }
  await assert.rejects(createKeywordMonthlyHttpReadAdmission({readAdmission:async()=>{throw new Error("private path /secret/token");}})(),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED"});
  await assert.rejects(createKeywordMonthlyHttpReadAdmission({readAdmission:()=>new Promise(()=>{}),timeoutMs:5})(),{code:"KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED"});
  assert.throws(()=>createKeywordMonthlyHttpReadAdmission({timeoutMs:1501}),TypeError);
});

test("actual valid and malformed maintenance markers remain byte-identical after fast deferred GETs",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"monthly-http-admission-"));
  const directory=path.join(root,"keyword_monthly_incremental");await fs.mkdir(directory,{mode:0o700});
  try {
    const lease=await acquirePreparedConversionLease({dataDir:root,mode:"stage",operationId:crypto.randomUUID(),contextSha256:"a".repeat(64)});
    const file=path.join(directory,MAINTENANCE_FILE), before=await fs.readFile(file), beforeStat=await fs.stat(file);
    let lifecycleCalls=0;
    const f=http({readAdmission:()=>readPreparedConversionAdmission({dataDir:root}),queryLifecycle:{run(){lifecycleCalls++;throw new Error("must not queue");}}});
    for(const route of [optionsRoute,dataRoute]) {const result=await f.run(route);assert.equal(result.status,503);assert.equal(result.body.code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(result.body.snapshot,null);assert.equal(result.body.networkAttempted,false);}
    assert.deepEqual(f.calls,[]);assert.equal(lifecycleCalls,0);
    assert.equal(hash(await fs.readFile(file)),hash(before));assert.equal((await fs.stat(file)).mtimeMs,beforeStat.mtimeMs);
    await lease.release();
    await fs.writeFile(file,"malformed private owner token",{flag:"wx",mode:0o600});
    const malformed=await fs.readFile(file);
    const denied=await f.run(optionsRoute);assert.equal(denied.body.code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_UNVERIFIED");
    assert.equal(hash(await fs.readFile(file)),hash(malformed));assert.ok(!JSON.stringify(denied).includes("private owner"));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("auth, method, invalid query and diagnostic routes do not touch maintenance admission or analytical work",async()=>{
  let reads=0,statusReads=0;
  const f=http({readAdmission:async()=>{reads++;return {allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"};},readRefreshStatus:async()=>{statusReads++;return {status:"available",readOnly:true};}});
  assert.equal((await f.run(optionsRoute,"POST")).status,405);
  assert.equal((await f.run(optionsRoute+"?force=1")).status,400);
  assert.equal((await f.run(dataRoute+"&force=1")).status,400);
  assert.equal((await f.run("/api/keyword-monthly/unknown")).status,404);
  assert.equal((await f.run("/api/keyword-monthly/refresh-status")).status,200);
  const denied=http({readAdmission:async()=>{reads++;},requireAdmin:()=>false});await denied.run(optionsRoute);
  assert.equal(reads,0);assert.equal(statusReads,1);assert.deepEqual(f.calls,[]);
});

test("new marker after preflight still blocks the original scheduler, without starting stored work",async()=>{
  let admitted=false,operationCalls=0;
  const scheduler=createAnalyticalWorkScheduler({externalAdmission:async()=>({allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"}),sampleIntervalMs:1000});
  const lifecycle=createKeywordMonthlyQueryLifecycle({timeoutMs:5});
  const f=http({readAdmission:async()=>{admitted=true;return {allowed:true,reasonCode:null};},queryLifecycle:lifecycle,
    service:{options:()=>scheduler.run(()=>{operationCalls++;return {status:"available"};},{kind:"keyword_monthly_options"}),analyze:async()=>({status:"missing"})}});
  const keepAlive=setTimeout(()=>{},1000);
  try{const result=await f.run(optionsRoute);assert.equal(admitted,true);assert.equal(result.status,503);assert.equal(result.body.code,"KEYWORD_MONTHLY_QUERY_TIMEOUT");assert.equal(operationCalls,0);assert.equal(scheduler.status().maintenance.paused,true);}
  finally{clearTimeout(keepAlive);lifecycle.close();scheduler.close();}
});

test("clear admission preserves complete response values, nulls and source metadata",async()=>{
  const payload={status:"available",snapshot:{rate:null,sold:0,companyId:"cmp_synthetic",selection:"cmp_synthetic",page:3},provenance:{inputSha256:"a".repeat(64),generation:"synthetic"}};
  const f=http({readAdmission:async()=>({allowed:true,reasonCode:null}),service:{options:async()=>payload,analyze:async()=>payload}});
  for(const route of [optionsRoute,dataRoute]){const result=await f.run(route);assert.equal(result.status,200);assert.deepEqual(result.body,payload);assert.equal(result.headers["Cache-Control"],"private, no-store");assert.match(result.headers["X-Keyword-Monthly-Trace"],/^[a-f0-9]{24}$/);}
});

test("each caller checks a new marker before joining any previously unfinished shared flight",async()=>{
  let active=false,release,started;
  const entered=new Promise(resolve=>{started=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const lifecycle=createKeywordMonthlyQueryLifecycle(),diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null});
  const f=http({queryLifecycle:lifecycle,requestDiagnostics:diagnostics,
    readAdmission:async()=>active?{allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"}:{allowed:true,reasonCode:null},
    service:{options:async()=>{started();await blocked;return {status:"available",keywords:[]};},analyze:async()=>({status:"missing"})}});
  const first=f.run(optionsRoute);await entered;active=true;
  const second=await f.run(optionsRoute);assert.equal(second.body.code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");
  assert.equal(lifecycle.status().counters.started,1);assert.equal(lifecycle.status().counters.shared,0);
  release();assert.equal((await first).status,200);assert.equal(lifecycle.status().inFlight,0);lifecycle.close();
});

test("fast maintenance failure diagnostics expose no queue timing or raw marker fields",async()=>{
  const diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:null});
  const f=http({readAdmission:async()=>({allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE",token:"never-expose",pid:12345}),requestDiagnostics:diagnostics});
  const result=await f.run(dataRoute), observed=diagnostics.status();
  assert.equal(result.body.code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(observed.recent[0].route,"data");assert.equal(observed.recent[0].taskTimingObserved,false);assert.equal(observed.recent[0].task,null);assert.equal(observed.recent[0].responseStatus,503);
  for(const forbidden of ["never-expose","12345","synthetic","keyword=","pid","token"])assert.ok(!JSON.stringify(observed).includes(forbidden));
});
