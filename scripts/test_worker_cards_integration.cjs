"use strict";

// Real local HTTP boundaries, with crawler processes and outbound provider IO forbidden.
const assert = require("node:assert/strict");
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { installFixture } = require("./test_operating_web_integration.cjs");
const { workerOptions, runWorker } = require("./collector_worker.cjs");
const { freePort, request, jsonPost, login, waitUntil, stopChild, writeMockArtifacts } = require("./test_collector_integration.cjs");
const ROOT = path.resolve(__dirname, "..");
const ADMIN = { username: "cards-fixture-admin", password: "cards-fixture-password" };
const TOKENS = { manual: "cards-manual-fixture-token-123456789012345", scheduled: "cards-scheduled-fixture-token-123456789012" };
const IDS = { manual: "cards-fixture-manual", scheduled: "cards-fixture-scheduled" };
const names = { web: "2Gweb_worker", manual: "BG worker", scheduled: "AWS worker" };
const date = n => new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0,10);

async function enrichFixture(saved, env, keyword) {
  const fields={query:keyword,place_id:"123456",업체명:"카드 통합시험 글램핑",overall_rank:1,주소:"경남 산청군 시험로 1",카테고리:"글램핑",숙박유형클러스터:"글램핑",예약:"Y",
    url:"https://pcmap.place.naver.com/accommodation/123456",네이버예약사업자ID:"987654",네이버예약재고수집상태:"수집 완료",숙박확인재고수:10,숙박예약가능수:7,숙박판매완료수:3,
    예약최저가:100000,예약리스트유형:"객실 종류별 리스트",주간재고수집일수:1,주간전체수량합계:10,주간판매수량합계:3,
    dayUseMode:env.DAY_USE_MODE,dayUsePresence:env.DAY_USE_MODE==="lodging_only"?"unknown":"absent",dayUseScheduleStatus:env.DAY_USE_MODE==="detail"?"requested":"not_requested",dayUseSharingStatus:"not_applicable"};
  const cell=value=>'"'+String(value??"").replaceAll('"','""')+'"';
  await fsp.writeFile(path.join(saved.runDir,saved.csv),Object.keys(fields).map(cell).join(",")+"\n"+Object.values(fields).map(cell).join(",")+"\n");
}

function mockWorker(base, temporary, key, index) {
  const abort = new AbortController(), spawned = [], errors = [];
  const options = workerOptions({ COLLECTOR_WORKER_ENABLED:"1", COLLECTOR_ALLOW_LOCAL_HTTP:"1", COLLECTOR_SERVER_URL:base,
    COLLECTOR_WORKER_KEY:key, COLLECTOR_WORKER_ID:IDS[key], COLLECTOR_WORKER_TOKEN:TOKENS[key] }, {
    workDir:path.join(temporary, "jobs-"+key), cwd:ROOT, maxJobs:1, pollMs:20, retryMs:10, heartbeatMs:30,
    heartbeatTimeoutMs:1000, requestTimeoutMs:5000, signal:abort.signal, logger:()=>{},
    fetchImpl:(input, init)=>{ assert.equal(new URL(input).origin,base); return fetch(input,init); },
    spawnImpl:(executable,args,settings)=>{
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill=()=>{setImmediate(()=>child.emit("close",null,"SIGTERM"));return true;};
      spawned.push(settings.env);
      setImmediate(async()=>{try {
        assert.equal(executable,process.execPath); assert.equal(settings.shell,false);
        assert.equal(settings.env.COLLECTOR_WORKER_TOKEN,undefined);
        await enrichFixture(await writeMockArtifacts(settings.env,args[1],index,false),settings.env,args[1]);
        child.stdout.end();child.stderr.end();child.emit("close",0);
      } catch(error) { errors.push(error);child.emit("close",1); }});
      return child;
    }
  });
  const done=runWorker(options);done.catch(()=>{});
  return {done,spawned,errors,stop:()=>abort.abort()};
}

async function main() {
  const tempBase=await fsp.realpath(os.tmpdir()), temporary=await fsp.mkdtemp(path.join(tempBase,"worker-cards-integration-"));
  const workers=[];let server;
  try {
    const dataDir=path.join(temporary,"data"), outputsDir=path.join(dataDir,"outputs"), configDir=path.join(dataDir,"config");
    await fsp.mkdir(configDir,{recursive:true});
    const attempts=path.join(temporary,"forbidden.log"),events=path.join(temporary,"events.jsonl"),preload=path.join(temporary,"preload.cjs");
    await fsp.writeFile(preload,`(${installFixture.toString()})(${JSON.stringify({root:ROOT,attempts,events,richRows:true})});\n`);
    const port=await freePort(),base=`http://127.0.0.1:${port}`,logs=[];
    server=spawn(process.execPath,["--require",preload,path.join(ROOT,"scripts/glamping_app_server.cjs")],{
      cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{...process.env,NODE_OPTIONS:"",PORT:String(port),HOST:"127.0.0.1",
        DATA_DIR:dataDir,OUTPUTS_DIR:outputsDir,CONFIG_DIR:configDir,MASTER_DB_PATH:path.join(dataDir,"master_db/test.sqlite"),
        MASTER_DB_WRITE_MODE:"off",SEED_OUTPUTS_FROM_REPO:"0",TOURISM_VISITOR_MONTHLY_SYNC_ENABLED:"0",TOURISM_DEMAND_STRENGTH_BACKFILL_ENABLED:"0",
        COLLECTOR_EXECUTION_MODE:"worker",COLLECTOR_WORKER_ID:IDS.manual,COLLECTOR_WORKER_TOKEN:TOKENS.manual,
        COLLECTOR_SCHEDULED_WORKER_ID:IDS.scheduled,COLLECTOR_SCHEDULED_WORKER_TOKEN:TOKENS.scheduled,
        GLAMPING_ADMIN_USER:ADMIN.username,GLAMPING_ADMIN_PASSWORD:ADMIN.password,GLAMPING_B2B_ENABLED:"0"}});
    server.stdout.on("data",b=>logs.push(String(b)));server.stderr.on("data",b=>logs.push(String(b)));
    await waitUntil(async()=>{if(server.exitCode!==null)throw Error(logs.join(""));try{return(await fetch(base+"/api/health")).ok;}catch{return false;}},"fixture startup",15000);
    const cookie=await login(base,ADMIN);
    const status=()=>request(base,"/api/collector-status",cookie);
    const initial=(await status()).body;
    for(const key of Object.keys(names)) {
      const worker=initial.workers.find(w=>w.workerKey===key);
      assert.equal(worker.name,names[key]);assert.equal(worker.resultDestination.archive,"/api/runs");
    }
    assert.equal((await request(base,"/api/worker-schedule?workerKey=invalid",cookie)).response.status,400);
    assert.equal((await request(base,"/api/worker-schedule?workerKey=web")).response.status,401);
    const keywords={web:"가평글램핑",manual:"포천글램핑",scheduled:"경남글램핑"};
    const modes={web:"inspect",manual:"lodging_only",scheduled:"detail"};
    for(const key of Object.keys(names)) {
      const route="/api/worker-schedule?workerKey="+key;
      const initialSchedule=(await request(base,route,cookie)).body;
      assert.equal(initialSchedule.workerKey,key);assert.equal(initialSchedule.enabled,false);
      assert.equal(initialSchedule.config.collection.dayUseMode,"inspect");
      const config={...initialSchedule.config,keywords:[keywords[key]],firstDate:date(1),time:"23:59",
        collection:{...initialSchedule.config.collection,bookingDays:1,detailRankRanges:"1-5",dayUseMode:modes[key]}};
      const saved=await request(base,route,cookie,{...jsonPost(config),method:"PUT"});
      assert.equal(saved.response.status,200,JSON.stringify(saved.body));assert.equal(saved.body.enabled,false);
      assert.equal((await request(base,route,cookie,{...jsonPost({...config,collection:{...config.collection,dayUseMode:"bad"}}),method:"PUT"})).response.status,400);
    }
    for(const key of Object.keys(names)) {
      const saved=(await request(base,"/api/worker-schedule?workerKey="+key,cookie)).body;
      assert.deepEqual(saved.config.keywords,[keywords[key]]);assert.equal(saved.config.collection.dayUseMode,modes[key]);
    }
    console.log("PASS three named worker cards keep independent disabled schedules and collection modes");
    for(const key of Object.keys(names)) {
      let worker;
      if(key!=="web") {
        worker=mockWorker(base,temporary,key,key==="manual"?4:5);workers.push(worker);
        await waitUntil(async()=>Boolean((await status()).body.workers.find(w=>w.workerKey===key).workerLastSeenAt),"worker connected");
      }
      const route="/api/worker-schedule/run-now?workerKey="+key;
      const start=await request(base,route,cookie,jsonPost({requestId:"cards_run_"+key}));
      assert.equal(start.response.status,202,JSON.stringify(start.body));
      let terminal;
      await waitUntil(async()=>{
        const s=(await request(base,"/api/worker-schedule?workerKey="+key,cookie)).body;
        terminal=s.latest.find(row=>row.id===start.body.id);
        return terminal && !["queued","running"].includes(terminal.status);
      },key+" result",20000);
      assert.equal(terminal.status,"complete",JSON.stringify({terminal,logs,errors:worker?.errors}));
      const runId=terminal.items[0].runId;assert.ok(runId);
      const manifest=JSON.parse(await fsp.readFile(path.join(outputsDir,runId,"manifest.json"),"utf8"));
      assert.equal(manifest.workerKey,key);assert.equal(manifest.dayUseMode,modes[key]);
      assert.equal(manifest.trigger,"manual");
      assert.equal((await request(base,"/api/runs/"+runId,cookie)).response.status,200);
      const summary=(await request(base,"/api/company-master/summary",cookie)).body;
      const masterPath=path.join(dataDir,"company_master/companies.json");
      const master=fs.existsSync(masterPath)?JSON.parse(await fsp.readFile(masterPath,"utf8")):null;
      assert.ok(Object.values(master?.companies||{}).some(company=>company.lastRunId===runId),JSON.stringify({reason:"result connected to central company DB",runId,summaryKeys:Object.keys(summary),masterKeys:master&&Object.keys(master),logs:logs.slice(-8)},null,2));
      const again=await request(base,route,cookie,jsonPost({requestId:"cards_run_"+key}));
      assert.equal(again.body.id,start.body.id,"repeated request does not create another run");
      assert.equal((await request(base,"/api/worker-schedule?workerKey="+key,cookie)).body.enabled,false);
      if(worker) {await worker.done;assert.equal(worker.spawned.length,1);assert.equal(worker.spawned[0].DAY_USE_MODE,modes[key]);assert.deepEqual(worker.errors,[]);}
    }
    const runs=(await request(base,"/api/runs",cookie)).body;
    assert.equal((Array.isArray(runs)?runs:runs.runs).length,3);
    assert.ok(!fs.existsSync(attempts),fs.existsSync(attempts)?await fsp.readFile(attempts,"utf8"):"");
    console.log("PASS web/BG/AWS labeled collectors publish validated results to one central archive and company DB without provider calls");
  } finally {
    for(const worker of workers)worker.stop();await Promise.allSettled(workers.map(w=>w.done));await stopChild(server);
    const actual=await fsp.realpath(temporary),relative=path.relative(tempBase,actual);
    assert.equal(path.isAbsolute(relative),false);assert.equal(relative.startsWith(".."),false);assert.equal(path.dirname(relative),".");
    assert.ok(path.basename(relative).startsWith("worker-cards-integration-"));await fsp.rm(actual,{recursive:true,force:true});
  }
}
if(require.main===module)main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
module.exports={enrichFixture};
