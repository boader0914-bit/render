"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),fsp=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto");
const {spawn}=require("node:child_process");
const {freePort,request,jsonPost,login,waitUntil,stopChild,executionGuard,writeMockArtifacts}=require("./test_collector_integration.cjs");
const {enrichFixture}=require("./test_worker_cards_integration.cjs");
const {scope}=require("./collection_reuse.cjs");
const ROOT=path.resolve(__dirname,".."), hash=b=>crypto.createHash("sha256").update(b).digest("hex");
const ADMIN={username:"web-recovery-fixture",password:"web-recovery-fixture-password"};
async function main(){
  const tempBase=await fsp.realpath(os.tmpdir()),temp=await fsp.mkdtemp(path.join(tempBase,"web-recovery-integration-"));let server;
  try {
    const dataDir=path.join(temp,"data"),outputsDir=path.join(dataDir,"outputs"),configDir=path.join(dataDir,"config");
    await fsp.mkdir(configDir,{recursive:true});
    const requested={keyword:"함덕펜션",workerKey:"web",trigger:"manual",scheduledCollection:false,checkIn:"2026-09-28",checkOut:"2026-09-29",adults:2,
      searchMode:"keyword",searchIntent:"keyword",searchRegion:"",searchScope:"keyword",collectionMode:"precision",collectionPurpose:"revenue_detail",productMode:"all",
      dayUseMode:"inspect",bookingRangeDays:1,bookingRangePlaceLimit:0,detailRankRanges:"1-5",sourceRole:"admin",collectionSource:"admin_search"};
    const env={CHECK_IN:requested.checkIn,CHECK_OUT:requested.checkOut,ADULTS:"2",SEARCH_MODE:"keyword",SEARCH_INTENT:"keyword",SEARCH_REGION:"함덕",SEARCH_SCOPE:"keyword",
      COLLECTION_MODE:"precision",COLLECTION_PURPOSE:"revenue_detail",PRODUCT_MODE:"all",DAY_USE_MODE:"inspect",BOOKING_RANGE_DAYS:"1",BOOKING_RANGE_PLACE_LIMIT:"0",
      DETAIL_RANK_RANGES:"1-5",SOURCE_ROLE:"admin",COLLECTION_SOURCE:"admin_search",COLLECTOR_WORKER_KEY:"web",COLLECTOR_TRIGGER:"manual",COLLECTOR_ENGINE:"operating-web-v2",
      COLLECTOR_JOB_ID:"web-recovery-fixture-job",COLLECTOR_RUN_TOKEN:"a".repeat(24),RUN_STAMP:"20260928_215831",SCHEDULED_COLLECTION:"0",
      OUTPUTS_DIR:path.join(dataDir,"collector-web/job-ABC123/outputs")};
    const createdAt=new Date(Date.now()-2000).toISOString();
    const saved=await writeMockArtifacts(env,requested.keyword,1,false);await enrichFixture(saved,env,requested.keyword);
    const runId=`local_fixture_web_${env.COLLECTOR_RUN_TOKEN}_glamping_${env.RUN_STAMP}`,sourceDir=path.join(env.OUTPUTS_DIR,runId);
    await fsp.rename(saved.runDir,sourceDir);
    const manifestFile=path.join(sourceDir,"manifest.json"),manifest=JSON.parse(await fsp.readFile(manifestFile,"utf8"));
    delete manifest.workerCollection;
    Object.assign(manifest,{outputDir:sourceDir,webCollection:true,collectorRunToken:env.COLLECTOR_RUN_TOKEN,executionHost:{role:"operating_web"},
      requestPacing:{enabled:false,pacingEnabled:false,guardEnabled:true,minIntervalMs:0,maxConcurrentRequests:null,stopped:false}});
    await fsp.writeFile(manifestFile,JSON.stringify(manifest));
    const sourceBytes=await fsp.readFile(manifestFile),finishedAt=new Date().toISOString(),requestId="web-recovery-request-0001";
    const row={version:1,requestId,workerKey:"web",trigger:"manual",keyword:requested.keyword,status:"failed",createdAt,finishedAt,
      result:null,errorCode:"COLLECTOR_SCOPE_MISMATCH",conditions:Object.fromEntries(["checkIn","checkOut","bookingRangeDays","detailRankRanges","collectionPurpose","dayUseMode"].map(k=>[k,requested[k]]))};
    await fsp.mkdir(path.join(dataDir,"history/collector-requests"),{recursive:true});
    await fsp.writeFile(path.join(dataDir,"history/collector-requests",requestId+".json"),JSON.stringify(row));
    const reuseFile=path.join(dataDir,"history/collection-reuse.json");
    await fsp.writeFile(reuseFile,JSON.stringify({version:1,entries:[{id:"web-recovery-scope",day:"2026-09-28",scope:scope(requested),workerKey:"web",trigger:"manual",status:"failed",errorCode:row.errorCode,createdAt,finishedAt}]}));
    const reuseBytes=await fsp.readFile(reuseFile,"utf8"),guard=await executionGuard(temp),port=await freePort(),base=`http://127.0.0.1:${port}`,logs=[];
    server=spawn(process.execPath,["--require",guard.guardPath,path.join(ROOT,"scripts/glamping_app_server.cjs")],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"],
      env:{...process.env,NODE_OPTIONS:"",PORT:String(port),HOST:"127.0.0.1",DATA_DIR:dataDir,OUTPUTS_DIR:outputsDir,CONFIG_DIR:configDir,
        MASTER_DB_PATH:path.join(dataDir,"master_db/test.sqlite"),MASTER_DB_WRITE_MODE:"off",SEED_OUTPUTS_FROM_REPO:"0",
        TOURISM_VISITOR_MONTHLY_SYNC_ENABLED:"0",TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED:"0",COLLECTOR_EXECUTION_MODE:"local",
        GLAMPING_ADMIN_USER:ADMIN.username,GLAMPING_ADMIN_PASSWORD:ADMIN.password}});
    server.stdout.on("data",b=>logs.push(String(b)));server.stderr.on("data",b=>logs.push(String(b)));
    await waitUntil(async()=>{if(server.exitCode!==null)throw new Error(logs.join(""));try{return (await fetch(base+"/api/health")).ok;}catch{return false;}},"fixture startup",15000);
    const cookie=await login(base,ADMIN),route="/api/collector-web-recover";
    const body={confirm:"recover-retained-web-result",requestId,retainedJobDirectory:"job-ABC123",manifestSha256:hash(sourceBytes),expected:requested};
    const call=(input=body,auth=cookie)=>request(base,route,auth,jsonPost(input));
    assert.equal((await call(body,"")).response.status,401);
    assert.equal((await call({...body,retainedJobDirectory:"../escape"})).response.status,409);
    assert.equal((await call({...body,manifestSha256:"0".repeat(64)})).response.status,409);
    for(const changed of [{dayUseMode:"detail"},{checkOut:"2026-09-30"},{searchRegion:"함덕"},{sourceRole:"b2b"},{detailRankRanges:"1-20"}]){
      assert.equal((await call({...body,expected:{...requested,...changed}})).response.status,409);
    }
    for(const mutate of [m=>{m.searchRegion="다른지역";},m=>{m.jobId="../bad";},m=>{m.searchScope="company";},m=>{m.requestPacing.stopped=true;},
      m=>{m.requestPacing.blockedCode="NAVER_CAPTCHA";},m=>{m.counts.naverScheduleFailed=1;m.counts.naverScheduleSucceeded=1;}]){
      const bad=structuredClone(manifest);mutate(bad);const bytes=Buffer.from(JSON.stringify(bad));await fsp.writeFile(manifestFile,bytes);
      assert.equal((await call({...body,manifestSha256:hash(bytes)})).response.status,409);
    }
    await fsp.writeFile(manifestFile,sourceBytes);
    assert.equal(fs.existsSync(path.join(outputsDir,runId)),false);
    const recovered=await call();assert.equal(recovered.response.status,200,JSON.stringify(recovered.body));
    assert.equal(recovered.body.ok,true);assert.equal(recovered.body.runId,runId);assert.equal(recovered.body.collectionQuality.status,"complete");
    assert.ok(recovered.body.history.appended>0);assert.equal(recovered.body.request.status,"complete");
    assert.equal(recovered.body.request.recovery.originalErrorCode,"COLLECTOR_SCOPE_MISMATCH");
    const published=JSON.parse(await fsp.readFile(path.join(outputsDir,runId,"manifest.json"),"utf8"));
    assert.equal(published.searchRegion,"");assert.equal(published.recovery.originalSearchRegion,"함덕");
    assert.equal(hash(await fsp.readFile(manifestFile)),hash(sourceBytes));assert.equal(await fsp.readFile(reuseFile,"utf8"),reuseBytes);
    assert.equal((await request(base,"/api/runs",cookie)).body.runs.filter(r=>r.id===runId).length,1);
    const companies=(await request(base,"/api/company-master/summary",cookie)).body;
    assert.ok(companies.companies.some(c=>c.companyId==="cmp_place_123456"));
    const historyFile=path.join(dataDir,"history/observations.jsonl"),history=await fsp.readFile(historyFile,"utf8");
    const repeated=await call();assert.equal(repeated.response.status,200,JSON.stringify(repeated.body));assert.equal(repeated.body.history.appended,0);
    assert.equal(await fsp.readFile(historyFile,"utf8"),history);
    assert.equal(fs.existsSync(guard.attemptsPath),false,"Recovery may not invoke provider requests or crawler processes");
    console.log("web recovery integration passed: retained result -> archive, company DB, history and recovered request; 15 invalid cases rejected; original evidence retained, repeat idempotent; no external IO or crawler");
  } finally {
    await stopChild(server);const actual=await fsp.realpath(temp);assert.equal(path.dirname(actual),tempBase);assert.ok(path.basename(actual).startsWith("web-recovery-integration-"));
    await fsp.rm(actual,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={main};
