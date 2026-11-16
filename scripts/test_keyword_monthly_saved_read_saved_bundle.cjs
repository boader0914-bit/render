"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {buildKeywordMonthlyProjection,createKeywordMonthlyAnalysis}=require("./lib/keyword_monthly_analysis.cjs");
const {publishKeywordMonthlyBundle,createKeywordMonthlyBundleAnalysis,loadBundle}=require("./lib/keyword_monthly_bundle.cjs");
const {createKeywordMonthlySavedReadService}=require("./lib/keyword_monthly_saved_read_service.cjs");
const {createAnalyticalWorkScheduler}=require("./lib/analytical_work_scheduler.cjs");
const {createKeywordMonthlyHttpHandler}=require("./lib/keyword_monthly_http.cjs");
const {createSourceReadScheduler}=require("./lib/source_read_scheduler.cjs");
const NOW="2026-11-16T00:00:00.000Z",KEYWORD="가상검수글램핑",QUERY={keyword:KEYWORD,month:"2026-10",cutoffDate:"2026-10-20"};
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"saved-lane-bundle-"));t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("saved-lane-bundle-"));await fs.rm(root,{recursive:true,force:true});});
  const observations=["2026-09","2026-10"].map((month,index)=>({observationId:"r-"+month,companyId:"cmp_fixture",runId:"r-"+month,keyword:KEYWORD,productType:"lodging",stayDate:month+"-20",collectedAt:month+"-20T01:00:00.000Z",inventoryEvidenceVersion:4,
    supply:5,sold:index+1,publicBookings:index+1,phoneBookings:0,publicRevenue:(index+1)*100,phoneRevenue:0,estimatedRevenue:(index+1)*100,sharedDayUseExcluded:0,explicitBlockedBookings:0,phoneMissingPriceBookings:0,partial:false,missing:false,dayUsePresence:"absent",dayUseSharingStatus:"not_shared",capacityBasis:{count:5,source:"db_correction"}}));
  const source={companies:[{companyId:"cmp_fixture",primaryName:"가상 업체",capacity:5,capacitySource:"db_correction"}],runs:observations.map(row=>({id:row.runId,keyword:KEYWORD,collectedAt:row.collectedAt,collectionQuality:{status:"complete"}})),observations,rankObservations:[],savedProductRecoveries:[],warnings:[],sourceDiagnostics:{}};
  const projection=path.join(root,"source"),output=path.join(root,"bundle");await buildKeywordMonthlyProjection({source,sourceFingerprint:hash(JSON.stringify(source)),outputDir:projection,now:()=>NOW});
  await publishKeywordMonthlyBundle({inputs:[{directory:projection}],outputDir:output,now:NOW,prepareResults:true});return {root,projection,output,bundle:await loadBundle(output)};
}
function http(saved,scheduler){
  const service=createKeywordMonthlySavedReadService({saved,runWork:(op,opts)=>scheduler.run(op,opts),acquirePermit:()=>scheduler.acquireSavedReadPermit(),assertReadAdmission:async()=>{},runMemoryAdmission:async op=>op()});
  const handler=createKeywordMonthlyHttpHandler({service,requireAdmin:()=>true,send:(res,status,body)=>Object.assign(res,{status,body})});
  return {service,async read(options=false){const res={setHeader(){}};await handler({method:"GET"},res,new URL(options?"https://example.test/api/keyword-monthly/options":"https://example.test/api/keyword-monthly?"+new URLSearchParams(QUERY)),{});return res;}};
}

test("real saved DTO and metadata equal the old calculator while an isolated child waits, without projection bodies, providers or writes",async t=>{
  const f=await fixture(t),expected=await createKeywordMonthlyAnalysis({projectionDir:f.projection,now:()=>NOW}).analyze(QUERY),scheduler=createAnalyticalWorkScheduler();
  let endChild,opened;const entered=new Promise(resolve=>{opened=resolve;}),child=new Promise(resolve=>{endChild=resolve;});
  const background=scheduler.run(()=>scheduler.withSavedReadWindow(async()=>{opened();await child;}),{kind:"keyword_monthly_refresh",priority:"background"});await entered;
  const readFiles=[],oldOpen=fs.open,oldWrite=fs.writeFile,oldFetch=globalThis.fetch;let legacy=0;
  const saved=createKeywordMonthlyBundleAnalysis({projectionDir:f.output,now:()=>NOW,runLegacyAnalysis:()=>{legacy++;throw Error("legacy must remain outside saved capability");}});
  fs.open=async function(file,...args){readFiles.push(String(file));assert.ok(!String(file).includes(path.sep+"projections"+path.sep));return oldOpen.call(this,file,...args);};
  fs.writeFile=async()=>{throw Error("saved query wrote a file");};globalThis.fetch=()=>{throw Error("saved query called provider");};
  try{const api=http(saved,scheduler),options=await api.read(true),result=await api.read();assert.equal(options.status,200);assert.equal(result.status,200);assert.deepEqual(result.body.snapshot,expected.snapshot);assert.equal(result.body.provenance.inputSha256,expected.provenance.inputSha256);assert.equal(result.body.snapshot.summary.lodging.sold,2);assert.equal(result.body.snapshot.summary.dayuse.sold,null);assert.equal(legacy,0);assert.ok(readFiles.some(file=>file.includes(path.sep+"results"+path.sep)&&/\.json(?:\.gz)?$/.test(file)));}
  finally{fs.open=oldOpen;fs.writeFile=oldWrite;globalThis.fetch=oldFetch;endChild();await background;await scheduler.close();}
});

test("pointer publication during prepared decode still rejects the result without fallback source calculation",async t=>{
  const f=await fixture(t),scheduler=createAnalyticalWorkScheduler();let mutated=false,legacy=0;
  const saved=createKeywordMonthlyBundleAnalysis({projectionDir:f.output,now:()=>NOW,runLegacyAnalysis:()=>{legacy++;throw Error("forbidden fallback");},measure:async(phase,_metadata,operation)=>{const result=await operation();if(phase==="keyword_prepared_result_parse"&&!mutated){mutated=true;await fs.writeFile(path.join(f.output,"current.json"),JSON.stringify({...f.bundle.pointer,publishedAt:"2026-11-16T00:00:01.000Z"}));}return result;}});
  try{const result=await http(saved,scheduler).read();assert.equal(result.status,503);assert.equal(result.body.status,"needs_verification");assert.ok(result.body.diagnostics.includes("KEYWORD_MONTHLY_BUNDLE_CHANGED_DURING_READ"));assert.equal(legacy,0);assert.equal(scheduler.status().savedRead.active,false);}finally{await scheduler.close();}
});

test("corrupt prepared bytes and changed source-index SHA remain failures inside the strict lane",async t=>{
  for(const kind of ["result","index"]){const f=await fixture(t),scheduler=createAnalyticalWorkScheduler();let legacy=0;
    const descriptor=f.bundle.catalog.preparedResults.find(row=>row.month===QUERY.month);
    const file=kind==="result"?path.join(f.bundle.generationDir,"results",descriptor.sha256+".json"+(descriptor.encoding==="gzip"?".gz":"")):path.join(f.bundle.generationDir,"partitions",f.bundle.catalog.partitions[0].key,"index.json");
    assert.ok(path.resolve(file).startsWith(path.resolve(f.root)+path.sep));
    await fs.writeFile(file,"{}");const saved=createKeywordMonthlyBundleAnalysis({projectionDir:f.output,now:()=>NOW,runLegacyAnalysis:()=>{legacy++;throw Error("forbidden fallback");}});
    try{const result=await http(saved,scheduler).read();assert.equal(result.status,503);assert.equal(result.body.status,"needs_verification");assert.equal(legacy,0);assert.equal(scheduler.status().savedRead.active,false);}finally{await scheduler.close();}
  }
});

test("actual prepared DTO, generation and source SHA guards remain intact inside the industry checkpoint loan",async t=>{
  for(const mode of ["unchanged","pointer","result","index"]){
    const f=await fixture(t),scheduler=createAnalyticalWorkScheduler({cooperativeYield:true}),source=createSourceReadScheduler();let proceed,finish,entered;
    const ready=new Promise(resolve=>{entered=resolve;}),checkpoint=new Promise(resolve=>{proceed=resolve;}),ending=new Promise(resolve=>{finish=resolve;});
    const background=scheduler.run(async()=>{entered();await checkpoint;await source.checkpoint({priority:"background"});await ending;},{kind:"industry-build",priority:"background"});await ready;
    if(["result","index"].includes(mode)){
      const descriptor=f.bundle.catalog.preparedResults.find(row=>row.month===QUERY.month),file=mode==="result"?path.join(f.bundle.generationDir,"results",descriptor.sha256+".json"+(descriptor.encoding==="gzip"?".gz":"")):path.join(f.bundle.generationDir,"partitions",f.bundle.catalog.partitions[0].key,"index.json");
      assert.ok(path.resolve(file).startsWith(path.resolve(f.root)+path.sep));await fs.writeFile(file,"{}");
    }
    let legacy=0,mutated=false;const saved=createKeywordMonthlyBundleAnalysis({projectionDir:f.output,now:()=>NOW,runLegacyAnalysis:()=>{legacy++;throw Error("forbidden fallback");},
      measure:async(phase,_metadata,operation)=>{const result=await operation();if(mode==="pointer"&&phase==="keyword_prepared_result_parse"&&!mutated){mutated=true;await fs.writeFile(path.join(f.output,"current.json"),JSON.stringify({...f.bundle.pointer,publishedAt:"2026-11-16T00:00:01.000Z"}));}return result;}});
    const api=http(saved,scheduler),oldFetch=globalThis.fetch,oldOpen=fs.open,oldWrite=fs.writeFile;
    globalThis.fetch=()=>{throw Error("saved loan called provider");};fs.open=async function(file,...args){assert.ok(!String(file).includes(path.sep+"projections"+path.sep));return oldOpen.call(this,file,...args);};
    if(mode==="unchanged")fs.writeFile=async()=>{throw Error("saved loan wrote a file");};
    try{
      const pending=api.read();for(let n=0;n<100&&!scheduler.status().savedRead.checkpointPending;n++)await new Promise(resolve=>setImmediate(resolve));assert.equal(scheduler.status().savedRead.checkpointPending,true);proceed();
      const result=await pending;assert.equal(result.status,mode==="unchanged"?200:503);assert.equal(legacy,0);
      if(mode==="unchanged"){assert.equal(result.body.snapshot.summary.lodging.sold,2);assert.equal(result.body.snapshot.summary.dayuse.sold,null);}
      else assert.equal(result.body.status,"needs_verification");
      assert.equal(scheduler.status().savedRead.active,false);assert.equal(scheduler.status().timing.checkpointReadCompleted,1);
    }finally{fs.open=oldOpen;fs.writeFile=oldWrite;globalThis.fetch=oldFetch;proceed();finish();await background;await scheduler.close();}
  }
});
