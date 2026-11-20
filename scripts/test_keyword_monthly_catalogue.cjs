"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {EventEmitter}=require("node:events");
const {buildKeywordMonthlyProjection}=require("./lib/keyword_monthly_analysis.cjs");
const {publishKeywordMonthlyBundle,createKeywordMonthlyBundleAnalysis,loadBundle}=require("./lib/keyword_monthly_bundle.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {createAnalyticalWorkScheduler}=require("./lib/analytical_work_scheduler.cjs");
const {createKeywordMonthlyRequestDiagnostics}=require("./lib/keyword_monthly_request_diagnostics.cjs");
const NOW="2026-11-18T00:00:00.000Z",KEYWORD="가상 목록 검수",QUERY={keyword:KEYWORD,month:"2026-10",cutoffDate:"2026-10-20"};
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
async function fixture(t,{prepareResults=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"monthly-catalogue-"));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("monthly-catalogue-"));await fs.rm(root,{recursive:true,force:true});});
  const observations=["2026-09","2026-10"].map(month=>({observationId:month,companyId:"cmp_fixture",runId:month,keyword:KEYWORD,productType:"lodging",stayDate:month+"-20",collectedAt:month+"-20T01:00:00.000Z",inventoryEvidenceVersion:4,
    supply:5,sold:2,publicBookings:2,phoneBookings:0,publicRevenue:200,phoneRevenue:0,estimatedRevenue:200,sharedDayUseExcluded:0,explicitBlockedBookings:0,phoneMissingPriceBookings:0,partial:false,missing:false,
    dayUsePresence:"absent",dayUseSharingStatus:"not_shared",capacityBasis:{count:5,source:"db_correction"}}));
  const source={companies:[{companyId:"cmp_fixture",primaryName:"가상 업체",capacity:5,capacitySource:"db_correction"}],runs:observations.map(row=>({id:row.runId,keyword:KEYWORD,collectedAt:row.collectedAt,collectionQuality:{status:"complete"}})),observations,rankObservations:[],savedProductRecoveries:[],warnings:[],sourceDiagnostics:{}};
  const projection=path.join(root,"source"),output=path.join(root,"bundle");
  await buildKeywordMonthlyProjection({source,sourceFingerprint:sha(JSON.stringify(source)),outputDir:projection,now:()=>NOW});
  await publishKeywordMonthlyBundle({inputs:[{directory:projection}],outputDir:output,now:NOW,prepareResults});
  return {root,projection,output,bundle:await loadBundle(output),saved:createKeywordMonthlyBundleAnalysis({projectionDir:output,now:()=>NOW})};
}
function service(saved,scheduler,{admission=async()=>{},memory=operation=>operation()}={}){
  return createKeywordMonthlySavedReadService({saved,runWork:(op,opts)=>scheduler.run(op,opts),acquirePermit:()=>scheduler.acquireSavedReadPermit(),assertReadAdmission:admission,runMemoryAdmission:memory});
}
function http(saved,{authorized=true,readAdmission=null,native=false}={}){
  const handler=createKeywordMonthlyHttpHandler({service:saved,requireAdmin:(_session,_req,res)=>{if(authorized)return true;res.status=403;return false;},readAdmission,
    send:(res,status,body)=>{res.status=status;res.body=body;if(native){res.writableEnded=true;res.emit("finish");}}});
  return async(url="/api/keyword-monthly/catalogue",method="GET")=>{
    const req=new EventEmitter(),res=native?new EventEmitter():{};req.method=method;req.headers={};res.headers={};res.setHeader=(k,v)=>{res.headers[k]=v;};
    if(native){res.writeHead=()=>{};res.end=()=>{};}
    await handler(req,res,new URL(url,"https://example.test"),{});return res;
  };
}
test("catalogue reads only bounded pointer/catalog metadata and declares no financial or freshness validation",async t=>{
  const f=await fixture(t),opened=[],original=fs.open,oldFetch=globalThis.fetch;
  fs.open=async function(file,...args){opened.push(String(file));assert.ok(["current.json","catalog.json"].includes(path.basename(String(file))));return original.call(this,file,...args);};
  globalThis.fetch=()=>{throw Error("provider forbidden");};
  try{
    const result=await f.saved.catalogue();assert.equal(result.status,"available");assert.equal(result.metadataOnly,true);assert.equal(result.financialResultValidated,false);
    assert.equal(result.provenance.originalFreshnessVerified,false);assert.equal(result.provenance.currentPointerSha256,f.bundle.pointerRead.sha256);assert.equal(result.provenance.bundleSha256,f.bundle.catalogRead.sha256);
    assert.deepEqual(result.keywords[0].stayMonths,["2026-09","2026-10"]);assert.equal(result.keywords[0].defaultCutoffs[QUERY.month],QUERY.cutoffDate);assert.equal(result.keywords[0].supportedCutoffs[QUERY.month],QUERY.cutoffDate);
    assert.deepEqual(result.keywords[0].inventoryStayMonths,[]);assert.equal(result.keywords[0].availabilityByMonth[QUERY.month],"declared");assert.equal(Object.hasOwn(result,"snapshot"),false);
    assert.equal(opened.filter(file=>path.basename(file)==="catalog.json").length,2);assert.equal(opened.filter(file=>path.basename(file)==="current.json").length,3);
  }finally{fs.open=original;globalThis.fetch=oldFetch;}
});
test("catalogue stays available under an ineligible heavy owner while old financial and options permits remain protected",async t=>{
  const f=await fixture(t),scheduler=createAnalyticalWorkScheduler();let finish,entered;
  const ready=new Promise(resolve=>{entered=resolve;}),end=new Promise(resolve=>{finish=resolve;});
  const active=scheduler.run(async()=>{entered();await end;},{kind:"source-options",priority:"foreground"});await ready;
  try{
    const api=http(service(f.saved,scheduler)),catalogue=await api();assert.equal(catalogue.status,200);assert.equal(catalogue.body.metadataOnly,true);
    const old=await api("/api/keyword-monthly/options");assert.equal(old.status,503);assert.equal(old.body.code,"KEYWORD_MONTHLY_ANALYTICAL_BUSY");assert.equal(scheduler.status().activeKind,"source-options");assert.equal(scheduler.status().savedRead.active,false);
  }finally{finish();await active;await scheduler.close();}
});
test("catalogue missing/legacy generations never fall back to source or legacy analysis",async t=>{
  const f=await fixture(t,{prepareResults:false});let legacy=0;
  const saved=createKeywordMonthlyBundleAnalysis({projectionDir:f.output,now:()=>NOW,runLegacyAnalysis:()=>{legacy++;throw Error("legacy forbidden");}});
  const held=await saved.catalogue();assert.equal(held.status,"needs_verification");assert.deepEqual(held.keywords,[]);assert.ok(held.diagnostics.includes("KEYWORD_MONTHLY_CATALOGUE_NOT_PREPARED"));
  const missing=createKeywordMonthlyBundleAnalysis({projectionDir:path.join(f.root,"missing"),now:()=>NOW,runLegacyAnalysis:()=>{legacy++;}});assert.equal((await missing.catalogue()).status,"needs_verification");assert.equal(legacy,0);
});
test("catalogue pointer or catalog corruption and hardlinks remain unavailable",async t=>{
  for(const kind of ["pointer","catalog","hardlink"]){
    const f=await fixture(t),file=kind==="pointer"?path.join(f.output,"current.json"):path.join(f.bundle.generationDir,"catalog.json");
    if(kind==="hardlink")await fs.link(file,path.join(f.root,"linked.json"));else await fs.writeFile(file,"{}");
    const result=await f.saved.catalogue();assert.equal(result.status,"needs_verification");assert.deepEqual(result.keywords,[]);assert.equal(result.financialResultValidated,false);
  }
});
test("pointer changes during the final catalog read discard the selector instead of mixing generations",async t=>{
  const f=await fixture(t),original=fs.open;let reads=0;
  fs.open=async function(file,...args){if(path.basename(String(file))==="catalog.json"&&++reads===2)await fs.writeFile(path.join(f.output,"current.json"),JSON.stringify({...f.bundle.pointer,publishedAt:"2026-11-18T00:00:01.000Z"}));return original.call(this,file,...args);};
  try{const result=await f.saved.catalogue();assert.equal(result.status,"needs_verification");assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"));}finally{fs.open=original;}
});
test("declared selector never claims corrupted financial result is verified; strict read still rejects it",async t=>{
  const f=await fixture(t),descriptor=f.bundle.catalog.preparedResults.find(row=>row.month===QUERY.month);
  await fs.writeFile(path.join(f.bundle.generationDir,"results",descriptor.sha256+".json"+(descriptor.encoding==="gzip"?".gz":"")),"{}");
  const metadata=await f.saved.catalogue();assert.equal(metadata.status,"available");assert.equal(metadata.financialResultValidated,false);
  const financial=await f.saved.readPrepared(QUERY);assert.equal(financial.status,"needs_verification");assert.equal(financial.snapshot,null);
});
test("catalogue requires the current calculation fingerprint without changing it",async t=>{
  const f=await fixture(t),catalog={...f.bundle.catalog,preparedResults:f.bundle.catalog.preparedResults.map(row=>({...row,calculationFingerprint:"0".repeat(64)}))},bytes=Buffer.from(JSON.stringify(catalog));
  await fs.writeFile(path.join(f.bundle.generationDir,"catalog.json"),bytes);await fs.writeFile(path.join(f.output,"current.json"),JSON.stringify({...f.bundle.pointer,catalogSha256:sha(bytes),catalogBytes:bytes.length}));
  const result=await f.saved.catalogue();assert.equal(result.status,"needs_verification");assert.ok(result.diagnostics.includes("KEYWORD_MONTHLY_RESULT_CALCULATION_CHANGED"));
});
test("memory and conversion holds stop catalogue reads before any saved operation",async()=>{
  let reads=0;const saved={options:async()=>{},readPrepared:async()=>{},analyze:async()=>{},catalogue:async()=>{reads++;return {status:"available"};}};
  for(const kind of ["memory","conversion"]){
    const scheduler=createAnalyticalWorkScheduler(),guard=Object.assign(Error("blocked"),{code:kind==="memory"?"KEYWORD_MONTHLY_MEMORY_DEFERRED":"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE",statusCode:503});
    const svc=service(saved,scheduler,{...(kind==="memory"?{memory:async()=>{throw guard;}}:{admission:async()=>{throw guard;}})});
    const result=await http(svc)();assert.equal(result.status,503);assert.equal(result.body.code,guard.code);await scheduler.close();
  }
  assert.equal(reads,0);
});
test("HTTP catalogue keeps admin GET-only authority, query rejection, no-store and bounded native responses",async()=>{
  let reads=0;const svc={options:async()=>{},analyze:async()=>{},catalogue:async()=>{reads++;return {status:"available",metadataOnly:true,keywords:[]};}};
  const denied=await http(svc,{authorized:false})();assert.equal(denied.status,403);assert.equal(reads,0);assert.equal(denied.headers["Cache-Control"],"private, no-store");assert.equal(denied.headers.Vary,"Cookie");
  const api=http(svc);assert.equal((await api("/api/keyword-monthly/catalogue","POST")).status,405);assert.equal((await api("/api/keyword-monthly/catalogue?keyword=no")).status,400);assert.equal(reads,0);
  const normal=await http(svc,{native:true})();assert.equal(normal.status,200);assert.ok(Buffer.isBuffer(normal.body));assert.equal(JSON.parse(normal.body).metadataOnly,true);
  const oversize=await http({...svc,catalogue:async()=>({status:"available",text:"x".repeat(2*1024*1024)})},{native:true})();assert.equal(oversize.status,503);assert.equal(oversize.body.code,"KEYWORD_MONTHLY_RESPONSE_TOO_LARGE");
});
test("conversion admission is rechecked after catalogue serialization before sending",async()=>{
  let checks=0;const svc={options:async()=>{},analyze:async()=>{},catalogue:async()=>({status:"available",metadataOnly:true,keywords:[]})};
  const result=await http(svc,{readAdmission:async()=>++checks===1?{allowed:true,reasonCode:null}:{allowed:false,reasonCode:"KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE"}})();
  assert.equal(result.status,503);assert.equal(result.body.code,"KEYWORD_MONTHLY_PREPARED_CONVERSION_ACTIVE");assert.equal(checks,2);
});
test("catalogue coalesces one bounded metadata flight and queues the next metadata producer until real settlement",async()=>{
  let calls=0,versionCalls=0,release,entered;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const svc={options:async()=>{},analyze:async()=>{},version:async()=>{versionCalls++;return {status:"available"};},catalogue:async()=>{calls++;entered();await gate;return {status:"available",metadataOnly:true,keywords:[]};}};
  const api=http(svc),first=api(),second=api();await started;
  let otherSettled=false;const other=api("/api/keyword-monthly/version").then(value=>{otherSettled=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(otherSettled,false);assert.equal(versionCalls,0);
  release();const results=await Promise.all([first,second,other]);assert.equal(calls,1);assert.equal(versionCalls,1);assert.deepEqual(results.map(row=>row.status),[200,200,200]);
});

test("actual strict catalogue reads expose bounded metadata phases without financial work or extra file opens",async t=>{
  const f=await fixture(t),logs=[],diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:value=>logs.push(value)}),scheduler=createAnalyticalWorkScheduler();
  const svc=createKeywordMonthlySavedReadService({saved:f.saved,runWork:()=>assert.fail("metadata analytical work"),acquirePermit:()=>assert.fail("metadata graph permit"),
    assertReadAdmission:async()=>{},runMemoryAdmission:operation=>operation(),diagnostics});
  try{
    const value=await diagnostics.run("catalogue",()=>svc.catalogue());assert.equal(value.status,"available");
    const record=diagnostics.status().recent[0];assert.equal(record.metadataStarted,true);assert.equal(record.metadataFinished,true);assert.equal(record.metadataOutcome,"completed");
    assert.equal(record.workStarted,false);assert.equal(record.task,null);assert.equal(record.phaseCounts.conversion_guard,3);assert.equal(record.phaseCounts.memory_admission,1);
    for(const phase of ["catalogue_open","catalogue_project","catalogue_revalidate"]){assert.equal(record.phaseCounts[phase],1);assert.ok(record.phases[phase]>=0);}
    assert.equal(logs.filter(row=>row.event==="metadata_start").length,1);assert.equal(logs.filter(row=>row.event==="metadata_end").length,1);
    assert.ok(!JSON.stringify({record,logs}).includes(KEYWORD));assert.ok(!JSON.stringify({record,logs}).includes(f.root));
  }finally{await scheduler.close();}
});

test("actual unknown file errors returned as verification refusals retain a safe metadata result code",async t=>{
  const f=await fixture(t),logs=[],diagnostics=createKeywordMonthlyRequestDiagnostics({onLog:value=>logs.push(value)}),original=fs.open;
  const svc=createKeywordMonthlySavedReadService({saved:f.saved,runWork:()=>assert.fail("metadata analytical work"),acquirePermit:()=>assert.fail("metadata graph permit"),
    assertReadAdmission:async()=>{},runMemoryAdmission:operation=>operation(),diagnostics});
  fs.open=async function(file,...args){if(String(file)===path.join(f.output,"current.json"))throw Object.assign(Error("private path and keyword"),{code:"EIO"});return original.call(this,file,...args);};
  try{
    const result=await diagnostics.run("catalogue",()=>svc.catalogue());assert.equal(result.status,"needs_verification");assert.deepEqual(result.diagnostics,["KEYWORD_MONTHLY_BUNDLE_UNAVAILABLE"]);
    const record=diagnostics.status().recent[0];assert.equal(record.metadataOutcome,"completed");assert.equal(record.metadataErrorCode,null);
    assert.equal(record.metadataResultStatus,"needs_verification");assert.equal(record.metadataResultCode,"KEYWORD_MONTHLY_BUNDLE_UNAVAILABLE");assert.equal(record.metadataReadGuard,null);
    assert.equal(logs.find(row=>row.event==="metadata_end").metadataResultCode,"KEYWORD_MONTHLY_BUNDLE_UNAVAILABLE");
    assert.ok(!JSON.stringify({record,logs}).includes("private"));assert.ok(!JSON.stringify({record,logs}).includes(f.root));
  }finally{fs.open=original;}
});
