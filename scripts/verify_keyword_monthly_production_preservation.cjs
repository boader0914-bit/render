"use strict";
// One-shot saved-state reader. No application imports, environment/credentials,
// provider/API calls, app startup, scheduler initialization or explicit writes.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), cp = require("node:child_process");
const ROOT = "/var/data", SOURCE = "/opt/render/project/src";
const MAX = { db: 64*1024*1024, shm: 1024*1024, json: 2*1024*1024, broker: 8*1024*1024, result: 256*1024, durable: 128*1024, output: 192*1024 };
const SLOT = new Set(["queued","waiting","running","complete","reused","partial","failed","blocked","missed","paused","uncertain"]);
const BROKER = new Set(["queued","leased","committing","completed","failed","cancelled","interrupted"]);
const PP = new Set(["held","queued","running","complete","failed"]);
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), {code}); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const fp = stat => [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs,stat.nlink].join(":");
const ident = stat => [stat.dev,stat.ino].join(":");
const dayValid = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value+"T00:00:00Z")) && new Date(value+"T00:00:00Z").toISOString().slice(0,10) === value;
const time = value => { if (value === null || value === undefined) return null; need(typeof value === "string" && value.length <= 40 && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),"TIME_INVALID"); return new Date(value).toISOString(); };
const code = value => { if(value === null || value === undefined || value === "")return null; need(typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(value),"CODE_INVALID"); return value; };
const keyword = value => { need(typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value),"KEYWORD_INVALID"); return value; };
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function checked(file, maximum) {
  need(path.isAbsolute(file) && path.resolve(file) === file,"UNSAFE_PATH");
  let current = path.parse(file).root; const parents=[];
  for(const part of file.split(path.sep).filter(Boolean).slice(0,-1)) {
    current=path.join(current,part); const stat=fs.lstatSync(current);
    need(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(current)===current,"UNSAFE_PARENT"); parents.push({file:current,identity:ident(stat)});
  }
  const stat=fs.lstatSync(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&count(stat.size)&&stat.size<=maximum&&fs.realpathSync(file)===file,"UNSAFE_OR_OVERSIZE_FILE");
  return {file,maximum,stat,parents};
}
function stable(record, shm=false) {
  const after=checked(record.file,record.maximum);
  need(shm?ident(record.stat)===ident(after.stat):fp(record.stat)===fp(after.stat),shm?"SHM_IDENTITY_CHANGED":"EVIDENCE_CHANGED_DURING_READ");
  for(const parent of record.parents) { const stat=fs.lstatSync(parent.file); need(stat.isDirectory()&&!stat.isSymbolicLink()&&ident(stat)===parent.identity&&fs.realpathSync(parent.file)===parent.file,"EVIDENCE_CHANGED_DURING_READ"); }
}
function read(file, maximum, parse=true) {
  const record=checked(file,maximum); need(fs.constants.O_NOFOLLOW>0,"NOFOLLOW_UNAVAILABLE");
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW); let raw;
  try { need(fp(fs.fstatSync(fd))===fp(record.stat),"EVIDENCE_CHANGED_DURING_READ"); const buffer=Buffer.alloc(record.stat.size+1); let n=0;
    while(n<buffer.length) {const k=fs.readSync(fd,buffer,n,buffer.length-n,n);if(!k)break;n+=k;}
    need(n===record.stat.size&&fp(fs.fstatSync(fd))===fp(record.stat),"EVIDENCE_CHANGED_DURING_READ"); raw=buffer.subarray(0,n);
  }finally{fs.closeSync(fd);} stable(record);
  let data=null;if(parse){try{data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));}catch{need(false,"JSON_INVALID");}}
  return {...record,bytes:raw.length,sha256:hash(raw),data};
}
function fileSummary(record) {return {path:path.relative(ROOT,record.file),bytes:record.bytes,sha256:record.sha256,modifiedAt:new Date(record.stat.mtimeMs).toISOString()};}
function jsonText(value) {need(typeof value==="string"&&Buffer.byteLength(value)<=MAX.result,"SQL_JSON_BOUNDS");try{const data=JSON.parse(value);need(object(data),"SQL_JSON_INVALID");return data;}catch{need(false,"SQL_JSON_INVALID");}}
function configSummary(v) {
  need(exact(v,["version","enabled","timezone","firstDate","time","keywordIntervalMinutes","keywords","workers","collection"]),"CONFIG_UNKNOWN_FIELDS");
  need(v.version===1&&typeof v.enabled==="boolean"&&v.timezone==="Asia/Seoul"&&dayValid(v.firstDate)&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.time||"")&&count(v.keywordIntervalMinutes)&&v.keywordIntervalMinutes>0&&v.keywordIntervalMinutes<=1440,"CONFIG_INVALID");
  need(Array.isArray(v.keywords)&&v.keywords.length>0&&v.keywords.length<=100&&new Set(v.keywords).size===v.keywords.length,"CONFIG_KEYWORDS_INVALID");v.keywords.forEach(keyword);
  need(Array.isArray(v.workers)&&v.workers.length>0&&v.workers.length<=2&&new Set(v.workers.map(x=>x.workerKey)).size===v.workers.length,"CONFIG_WORKERS_INVALID");
  for(const w of v.workers)need(exact(w,["workerKey","dailyLimit"])&&["web","manual"].includes(w.workerKey)&&count(w.dailyLimit)&&w.dailyLimit>0&&w.dailyLimit<=100,"CONFIG_WORKERS_INVALID");
  const c=v.collection;need(exact(c,["bookingDays","collectionMode","collectionPurpose","detailRankRanges","productMode","dayUseMode"])&&count(c.bookingDays)&&c.bookingDays>=1&&c.bookingDays<=31&&c.collectionMode==="precision"&&["basic_db","revenue_detail"].includes(c.collectionPurpose)&&c.productMode==="all"&&["inspect","lodging_only","detail"].includes(c.dayUseMode)&&typeof c.detailRankRanges==="string"&&c.detailRankRanges.length<=150&&/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(c.detailRankRanges),"CONFIG_COLLECTION_INVALID");
  return {version:v.version,enabled:v.enabled,timezone:v.timezone,firstDate:v.firstDate,time:v.time,keywordIntervalMinutes:v.keywordIntervalMinutes,keywords:[...v.keywords],workers:v.workers.map(w=>({workerKey:w.workerKey,dailyLimit:w.dailyLimit})),collection:{bookingDays:c.bookingDays,collectionMode:c.collectionMode,collectionPurpose:c.collectionPurpose,detailRankRanges:c.detailRankRanges,productMode:c.productMode,dayUseMode:c.dayUseMode}};
}
function holdSummary(value,day) {
  if(value===null||value===undefined)return {reviewHoldPresent:false,reviewHoldActive:false,holdThrough:null};
  need(object(value)&&dayValid(value.holdThrough),"REVIEW_HOLD_INVALID");
  return {reviewHoldPresent:true,reviewHoldActive:day<=value.holdThrough,holdThrough:value.holdThrough};
}
function guardSummary(v,day) {
  need(Object.hasOwn(v,"halted")&&(v.halted===null||object(v.halted)),"GUARD_INVALID");
  if(v.halted!==null)need(code(v.halted.code)!==null&&time(v.halted.at)!==null,"GUARD_INVALID");
  return {halted:Boolean(v.halted),haltCode:code(v.halted?.code),haltedAt:time(v.halted?.at),...holdSummary(v.reviewHold,day)};
}
function brokerSummary(v,day) {
  need(object(v)&&v.version===1&&Array.isArray(v.jobs)&&v.jobs.length<=10000,"BROKER_LEDGER_INVALID");
  const counts=Object.fromEntries([...BROKER].map(s=>[s,0])),seen=new Set(),jobs=[];
  for(const j of v.jobs) {
    need(object(j)&&/^collector_[a-f0-9-]{36}$/.test(j.id||"")&&!seen.has(j.id)&&BROKER.has(j.status),"BROKER_JOB_INVALID");seen.add(j.id);counts[j.status]++;
    need(j.leaseHash===null||j.leaseHash===undefined||typeof j.leaseHash==="string"&&/^[a-f0-9]{64}$/.test(j.leaseHash),"BROKER_LEASE_METADATA_INVALID");
    const leaseOutstanding=Boolean(j.leaseHash&&!j.leaseReleasedAt); // Secret hash is NEVER returned.
    jobs.push({id:j.id,status:j.status,leaseOutstanding,createdAt:time(j.createdAt),updatedAt:time(j.updatedAt),finishedAt:time(j.finishedAt),leaseReleasedAt:time(j.leaseReleasedAt),errorCode:code(j.errorCode)});
  }
  const pending=jobs.filter(j=>["queued","leased","committing"].includes(j.status)||j.leaseOutstanding);
  return {version:1,jobCount:jobs.length,statusCounts:counts,pendingCount:pending.length,pending:pending.slice(0,32),pendingTruncated:pending.length>32,jobMetadataSha256:hash(JSON.stringify(jobs)),workerLastSeenAt:time(v.workerLastSeenAt),...guardSummary(v,day)};
}
function ppFields(v) {
  need(object(v)&&RUN.test(v.runId||""),"POSTPROCESS_RECORD_INVALID");const status=v.status??v.state;
  need(PP.has(status)&&!(v.status!==undefined&&v.state!==undefined&&v.status!==v.state),"POSTPROCESS_STATE_INVALID");
  const slot=v.scheduleOccurrenceId??v.context?.scheduleOccurrenceId??null;
  need(slot===null||typeof slot==="string"&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,239}$/.test(slot),"POSTPROCESS_SLOT_INVALID");
  return {runId:v.runId,scheduleOccurrenceId:slot,status,createdAt:time(v.createdAt),updatedAt:time(v.updatedAt),finishedAt:time(v.finishedAt)};
}
function queueSummary(v) {
  need(object(v)&&v.version===1&&count(v.sequence)&&object(v.jobs)&&Object.keys(v.jobs).length<=2048,"POSTPROCESS_QUEUE_INVALID");
  const rows=Object.entries(v.jobs).map(([id,value])=>{const row=ppFields(value);need(row.runId===id,"POSTPROCESS_QUEUE_BINDING_INVALID");return row;}).sort((a,b)=>a.runId.localeCompare(b.runId));
  const counts=Object.fromEntries([...PP].map(s=>[s,rows.filter(r=>r.status===s).length]));const active=rows.filter(r=>["queued","running","held"].includes(r.status));
  return {version:v.version,sequence:v.sequence,jobCount:rows.length,statusCounts:counts,activeCount:active.length,active:active.slice(0,32),activeTruncated:active.length>32,metadataSha256:hash(JSON.stringify(rows))};
}
function webSummary(v,day) {
  need(object(v)&&v.version===1&&Object.hasOwn(v,"active")&&(v.active===null||object(v.active)),"WEB_STATE_INVALID");let active=null;
  if(v.active!==null){need(object(v.active)&&RUN.test(v.active.jobId||"")&&time(v.active.startedAt)!==null,"WEB_ACTIVE_INVALID");active={jobId:v.active.jobId,startedAt:time(v.active.startedAt)};}
  return {version:v.version,active,lastFinishedAt:time(v.lastFinishedAt),lastInterruptedJobId:v.lastInterruptedJobId==null?null:(need(RUN.test(v.lastInterruptedJobId),"WEB_JOB_INVALID"),v.lastInterruptedJobId),...guardSummary(v,day)};
}
function safeResult(value) {
  if(value===null)return {runId:null,status:null,quality:null};const v=jsonText(value),runId=v.runId??null,status=v.status??null,quality=v.collectionQuality?.status??null;
  need(runId===null||RUN.test(runId),"RESULT_RUN_INVALID");need(status===null||SLOT.has(status),"RESULT_STATUS_INVALID");need(quality===null||["complete","partial","failed","blocked","unknown","needs_verification"].includes(quality),"RESULT_QUALITY_INVALID");return {runId,status,quality};
}
function slotSummary(row, includeResult=false) {
  need(dayValid(row.day)&&count(row.slot_index)&&row.slot_index<100&&row.id===`rotation_${row.day}_${row.slot_index+1}`&&["web","manual"].includes(row.worker_key)&&SLOT.has(row.status),"SLOT_IDENTITY_INVALID");
  need(row.result_bytes===null||count(row.result_bytes),"RESULT_LENGTH_INVALID");need(row.receipt_bytes===null||count(row.receipt_bytes),"RECEIPT_LENGTH_INVALID");
  const item={id:row.id,day:row.day,index:row.slot_index,workerKey:row.worker_key,keyword:keyword(row.keyword),scheduledAt:time(row.scheduled_at),status:row.status,startedAt:time(row.started_at),finishedAt:time(row.finished_at),errorCode:code(row.error_code),resultBytes:row.result_bytes,receiptBytes:row.receipt_bytes};
  need(item.scheduledAt!==null,"SCHEDULE_MISSING");if(includeResult)item.result=safeResult(row.result_json);return item;
}
function idleSummary(today,allSlots,brokers,web,queue,now=Date.now()) {
  const reasons=[];const active=allSlots.filter(r=>["running","uncertain"].includes(r.status));
  if(active.length)reasons.push("ROTATION_ACTIVE_OR_UNCERTAIN");if(brokers.some(b=>b.pendingCount>0))reasons.push("BROKER_PENDING_OR_LEASE_OUTSTANDING");if(web.active)reasons.push("WEB_COLLECTOR_ACTIVE");if(queue.activeCount>0)reasons.push("POSTPROCESS_QUEUED_RUNNING_OR_HELD");
  const started=today.filter(r=>r.startedAt!==null);if(started.some(r=>!r.collectionAndPostprocessComplete))reasons.push("TODAY_STARTED_NOT_VERIFIED_COMPLETE");
  if(allSlots.some(r=>["queued","waiting"].includes(r.status)&&Date.parse(r.scheduledAt)<=now))reasons.push("DUE_ROTATION_SLOT_PENDING");
  if(today.some(r=>r.startedAt===null&&(!["queued","waiting"].includes(r.status)||Date.parse(r.scheduledAt)<=now||r.finishedAt!==null||r.result?.runId!=null||r.result?.status!=null||r.result?.quality!=null)))reasons.push("UNSTARTED_TODAY_SLOT_NOT_CLEAN_FUTURE_QUEUE");
  const guardActive=[...brokers,web].some(x=>x.halted||x.reviewHoldActive);if(guardActive)reasons.push("PROTECTION_ACTIVE");
  return {status:reasons.length?"not_verified_idle":"saved_receipts_idle",idle:reasons.length===0,reasons,activeRotationSlots:active.slice(0,32),activeRotationSlotsTruncated:active.length>32,todayStarted:started.length,todayStartedVerifiedComplete:started.filter(x=>x.collectionAndPostprocessComplete).length,guardActive,liveWorkerReadinessVerified:false};
}
function runtimeSummary() {
  // Read kernel's numeric/status fields only. No environ or cmdline reads.
  const sourceHead=cp.execFileSync("git",["rev-parse","HEAD"],{cwd:SOURCE,encoding:"utf8",timeout:3000,maxBuffer:256}).trim();need(/^[a-f0-9]{40}$/.test(sourceHead),"SOURCE_HEAD_INVALID");
  const candidates=[],failures=[];const names=fs.readdirSync("/proc");need(names.length<=32768,"PROC_DIRECTORY_BOUNDS");
  for(const name of names){if(!/^[1-9]\d{0,8}$/.test(name)||Number(name)===process.pid)continue;
    try{const executable=fs.readlinkSync(`/proc/${name}/exe`);if(path.basename(executable)!=="node")continue;
      // readlink inspects this intentional proc link; it never follows it to read data.
      if(fs.readlinkSync(`/proc/${name}/cwd`)!==SOURCE)continue;
      need(candidates.length<32,"NODE_PROCESS_BOUNDS");const a=procText(`/proc/${name}/stat`,4096),status=procText(`/proc/${name}/status`,16384),b=procText(`/proc/${name}/stat`,4096);
      const parse=s=>s.slice(s.lastIndexOf(") ")+2).trim().split(/\s+/),aa=parse(a),bb=parse(b);need(aa.length>=22&&bb.length>=22&&aa[19]===bb[19]&&/^\d+$/.test(aa[19]),"PROC_IDENTITY_CHANGED");
      const rss=/^VmRSS:\s+(\d+)\s+kB$/m.exec(status),ppid=/^PPid:\s+(\d+)$/m.exec(status);need(rss&&ppid&&count(Number(rss[1]))&&count(Number(ppid[1])),"PROC_STATUS_INVALID");
      candidates.push({pid:Number(name),ppid:Number(ppid[1]),executableBasename:"node",cwdMatchesSource:true,startTicks:aa[19],rssBytes:Number(rss[1])*1024,exactWebScriptVerified:false});
    }catch(e){if(["ENOENT","ESRCH","EACCES","EPERM"].includes(e.code)){failures.push({pid:Number(name),code:e.code});continue;}throw e;}
  }
  const sourcePaths=["scripts/collection_rotation_scheduler.cjs","scripts/daily_keyword_collection_scheduler.cjs","scripts/keyword_worker_scheduler.cjs","scripts/collector_broker.cjs","scripts/collector_dispatch.cjs","scripts/collector_worker.cjs","scripts/operating_web_collector.cjs","scripts/lib/collection_postprocess_queue.cjs","scripts/lib/kosis.cjs","scripts/lib/regional_market_bootstrap.cjs","scripts/lib/regional_market_bootstrap_inputs.cjs","scripts/lib/regional_market_missing_weekly.cjs","scripts/lib/regional_market_missing.cjs","web/collector_controls.js","web/collection_rotation_controls.js","web/collection-monitor.js","scripts/naver_request_pacing.cjs"];
  const sourceReads=sourcePaths.map(relative=>{const r=read(path.join(SOURCE,relative),2*1024*1024,false);return {r,summary:{path:relative,bytes:r.bytes,sha256:r.sha256}};});for(const {r} of sourceReads)stable(r);
  return {sourceHead,nodeVersion:process.version,readerPid:process.pid,readerRssBytes:process.memoryUsage().rss,nodeProcesses:candidates,probeFailures:failures.slice(0,16),probeFailuresTruncated:failures.length>16,protectedSourceFiles:sourceReads.map(x=>x.summary),protectedSourceFileCount:sourceReads.length,runningProcessCommitVerified:false,serviceIdentity:{expectedName:"glamping-datalab-v2",expectedRenderServiceId:"srv-da9q6don74is738t7id0",observedCwd:process.cwd(),renderServiceIdRead:false,requiresCentralRenderShellContextBinding:true}};
}
function procText(file,max){need(/^\/proc\/[1-9]\d{0,8}\/(?:comm|stat|status)$/.test(file),"PROC_PATH_INVALID");const s=fs.lstatSync(file);need(s.isFile()&&!s.isSymbolicLink(),"PROC_PATH_INVALID");const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const b=Buffer.alloc(max+1);const n=fs.readSync(fd,b,0,b.length,0);need(n<=max,"PROC_READ_BOUNDS");return new TextDecoder("utf-8",{fatal:true}).decode(b.subarray(0,n));}finally{fs.closeSync(fd);}}
function run() {
  let db=null,transaction=false;
  try{
    need(process.platform==="linux"&&process.cwd()===SOURCE,"WRONG_CENTRAL_SHELL_CONTEXT");const beganAt=new Date().toISOString(),day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),reads=[];
    const saved=(relative,max=MAX.json)=>{need(!path.isAbsolute(relative)&&!relative.split("/").includes(".."),"UNSAFE_RELATIVE_PATH");const r=read(path.join(ROOT,relative),max);reads.push(r);return r;};
    const files=["config/daily_keyword_collection.json","config/keyword-worker-schedule-manual.json","config/keyword-worker-schedule-web.json"].map(p=>saved(p));
    const brokerReads=["collector/jobs.json","collector-scheduled/jobs.json"].map(p=>saved(p,MAX.broker)),brokers=brokerReads.map(r=>({...brokerSummary(r.data,day),ledger:fileSummary(r)}));
    const webRead=saved("collector-web/state.json"),web={...webSummary(webRead.data,day),ledger:fileSummary(webRead)};
    const queueRead=saved("history/collection_postprocess/queue.json"),queue={...queueSummary(queueRead.data),ledger:fileSummary(queueRead)};
    const bootstrap=saved("regional_market_bootstrap/state.json"),weekly=saved("regional_market_missing/weekly-policy.json");
    need(bootstrap.data?.schemaVersion===1&&object(bootstrap.data.policy)&&typeof bootstrap.data.policy.enabled==="boolean"&&weekly.data?.schemaVersion===1&&typeof weekly.data.enabled==="boolean","KOSIS_POLICY_INVALID");
    const kosis={bootstrapEnabled:bootstrap.data.policy.enabled,bootstrapPhase:code(bootstrap.data.policy.phase),bootstrapConfiguredAt:time(bootstrap.data.policy.configuredAt),bootstrapErrorCode:code(bootstrap.data.policy.errorCode),weeklyEnabled:weekly.data.enabled,weeklyConfiguredAt:time(weekly.data.configuredAt),weeklyDispatchStatus:code(weekly.data.dispatchStatus),pauseRetained:bootstrap.data.policy.enabled===false&&weekly.data.enabled===false,files:[fileSummary(bootstrap),fileSummary(weekly)]};
    const database=path.join(ROOT,"config/collection-rotation.sqlite"),dbRecord=checked(database,MAX.db),walRecord=checked(database+"-wal",MAX.db),shmRecord=checked(database+"-shm",MAX.shm);
    const {DatabaseSync}=require("node:sqlite");db=new DatabaseSync(database,{readOnly:true});db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN");transaction=true;
    need(db.prepare("PRAGMA query_only").get().query_only===1,"QUERY_ONLY_NOT_CONFIRMED");
    const state=db.prepare("SELECT version,revision,cursor,plan_state,reason,updated_at,CASE WHEN length(CAST(config_json AS BLOB))<=262144 THEN config_json END AS config_json FROM rotation_state WHERE id=1").get();need(state&&state.version===1&&count(state.revision)&&count(state.cursor),"ROTATION_STATE_INVALID");const config=configSummary(jsonText(state.config_json));
    need(state.cursor<config.keywords.length,"CURSOR_INVALID");
    const rows=db.prepare("SELECT id,day,slot_index,worker_key,keyword,scheduled_at,status,started_at,finished_at,error_code,length(CAST(result_json AS BLOB)) AS result_bytes,length(CAST(receipt_json AS BLOB)) AS receipt_bytes FROM rotation_slots ORDER BY day,slot_index LIMIT 2001").all();need(rows.length<=2000,"ROTATION_SLOT_BOUNDS");const slots=rows.map(r=>slotSummary(r));need(new Set(slots.map(x=>x.id)).size===slots.length,"SLOT_DUPLICATE");
    const dayFootprint=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(config_json AS BLOB))),0) AS bytes FROM rotation_days").get();need(dayFootprint.count<=400&&dayFootprint.bytes<=2*1024*1024,"ROTATION_DAY_BOUNDS");
    const dayRows=db.prepare("SELECT day,revision,cursor_start,cursor_next,created_at,CASE WHEN length(CAST(config_json AS BLOB))<=262144 THEN config_json END AS config_json FROM rotation_days ORDER BY day LIMIT 401").all();need(dayRows.length===dayFootprint.count,"ROTATION_DAY_BOUNDS");
    const days=dayRows.map(r=>{need(dayValid(r.day)&&count(r.revision)&&count(r.cursor_start)&&count(r.cursor_next),"DAY_INVALID");const c=configSummary(jsonText(r.config_json));return {day:r.day,revision:r.revision,cursorStart:r.cursor_start,cursorNext:r.cursor_next,createdAt:time(r.created_at),configSha256:hash(r.config_json),config:c};});
    const trialFootprint=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(workers_json AS BLOB))),0) AS bytes FROM rotation_one_day_trials").get();need(trialFootprint.count<=100&&trialFootprint.bytes<=2*1024*1024,"TRIAL_BOUNDS");
    const trialRows=db.prepare("SELECT trial_id,day,base_revision,base_plan_hash,created_at,cancelled_at,allocated_at,CASE WHEN length(CAST(workers_json AS BLOB))<=262144 THEN workers_json END AS workers_json FROM rotation_one_day_trials ORDER BY day,trial_id LIMIT 101").all();need(trialRows.length===trialFootprint.count,"TRIAL_BOUNDS");
    const trials=trialRows.map(r=>{need(UUID.test(r.trial_id||"")&&dayValid(r.day)&&count(r.base_revision)&&/^[a-f0-9]{64}$/.test(r.base_plan_hash||"")&&typeof r.workers_json==="string","TRIAL_INVALID");return {trialId:r.trial_id,day:r.day,baseRevision:r.base_revision,basePlanHash:r.base_plan_hash,workersSha256:hash(r.workers_json),createdAt:time(r.created_at),cancelledAt:time(r.cancelled_at),allocatedAt:time(r.allocated_at)};});
    const events=db.prepare("SELECT COUNT(*) AS count,MAX(id) AS lastId,MAX(at) AS lastAt FROM rotation_events").get();need(count(events.count)&&(events.lastId===null||count(events.lastId)),"EVENT_COUNT_INVALID");events.lastAt=time(events.lastAt);
    const todayFootprint=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS bytes,COALESCE(MAX(length(CAST(result_json AS BLOB))),0) AS maximum FROM rotation_slots WHERE day=?").get(day);need(todayFootprint.count<=100&&todayFootprint.maximum<=MAX.result&&todayFootprint.bytes<=2*1024*1024,"TODAY_RESULT_BOUNDS");
    const todayRows=db.prepare("SELECT id,day,slot_index,worker_key,keyword,scheduled_at,status,started_at,finished_at,error_code,length(CAST(result_json AS BLOB)) AS result_bytes,length(CAST(receipt_json AS BLOB)) AS receipt_bytes,CASE WHEN result_json IS NULL THEN NULL WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result_json FROM rotation_slots WHERE day=? ORDER BY slot_index LIMIT 101").all(day);need(todayRows.length===todayFootprint.count,"TODAY_ROWS_CHANGED");
    const today=todayRows.map(r=>{const item=slotSummary(r,true);let durable=null,complete=false;
      if(item.startedAt&&item.result.runId){let receipt;try{receipt=saved(`history/collection_postprocess/runs/${hash(item.result.runId)}.json`,MAX.durable);}catch(e){if(e.code!=="ENOENT")throw e;}
        if(receipt){need(receipt.data?.version===1,"DURABLE_VERSION_INVALID");durable=ppFields(receipt.data);need(durable.runId===item.result.runId&&durable.scheduleOccurrenceId===item.id,"DURABLE_BINDING_MISMATCH");complete=durable.status==="complete"&&durable.finishedAt!==null&&item.finishedAt!==null&&Date.parse(item.startedAt)<=Date.parse(item.finishedAt)&&Date.parse(durable.finishedAt)>=Date.parse(item.finishedAt)&&Date.parse(durable.finishedAt)<=Date.now();}
      }
      return {...item,postprocess:durable,postprocessReceiptMissing:Boolean(item.startedAt&&item.result.runId&&!durable),collectionAndPostprocessComplete:Boolean(item.startedAt&&item.status==="complete"&&item.result.status==="complete"&&item.result.quality==="complete"&&complete)};
    });
    db.exec("COMMIT");transaction=false;db.close();db=null;
    stable(dbRecord);stable(walRecord);stable(shmRecord,true);for(const r of reads)stable(r);
    const runtime=runtimeSummary();stable(dbRecord);stable(walRecord);stable(shmRecord,true);for(const r of reads)stable(r);
    const historic=slots.filter(x=>x.day<day),historicDays=days.filter(x=>x.day<day),allocation=x=>({id:x.id,day:x.day,index:x.index,workerKey:x.workerKey,keyword:x.keyword,scheduledAt:x.scheduledAt});
    const statusCounts=Object.fromEntries([...SLOT].map(s=>[s,slots.filter(x=>x.status===s).length]));
    const output={schemaVersion:1,status:"read_verified",beganAt,observedAt:new Date().toISOString(),day,runtime,
      rotation:{state:{version:state.version,revision:state.revision,cursor:state.cursor,planState:code(state.plan_state),reason:code(state.reason),updatedAt:time(state.updated_at),config,configRawSha256:hash(state.config_json)},slotCount:slots.length,dayCount:days.length,statusCounts,events,allocationSha256:hash(JSON.stringify(slots.map(allocation))),executionMetadataSha256:hash(JSON.stringify(slots)),today:{allocated:days.some(x=>x.day===day),items:today,dayMetadata:days.filter(x=>x.day===day),allocationSha256:hash(JSON.stringify(today.map(allocation)))},future:{slotCount:slots.filter(x=>x.day>day).length,allocationSha256:hash(JSON.stringify(slots.filter(x=>x.day>day).map(allocation)))},historical:{beforeDay:day,slotCount:historic.length,dayCount:historicDays.length,allocationSha256:hash(JSON.stringify(historic.map(allocation))),executionMetadataSha256:hash(JSON.stringify(historic)),daySnapshotsSha256:hash(JSON.stringify(historicDays))},trials:{count:trials.length,sha256:hash(JSON.stringify(trials)),items:trials},database:{bytes:dbRecord.stat.size,walBytes:walRecord.stat.size,shmBytes:shmRecord.stat.size,dbAndWalStable:true,existingShmIdentityStable:true}},
      individualSchedules:files.map(fileSummary),brokers,webCollector:web,postprocess:queue,kosis,idle:idleSummary(today,slots,brokers,web,queue),explicitApplicationWrites:0,explicitSqlMutations:0,apiCalls:0,providerCalls:0,appStarted:false,
      comparisonGuidance:{expectedStable:["rotation.state.configRawSha256","individualSchedules[*].sha256","rotation.today.allocationSha256","rotation.historical.*Sha256","rotation.trials.sha256","broker/web guard flags","kosis pause flags and policy hashes"],mayAdvanceNaturally:["rotation.state.cursor/updatedAt","rotation.executionMetadataSha256/statusCounts/events","today execution and durable postprocess","broker workerLastSeenAt/job statuses","queue sequence/statuses","runtime PID/startTicks/RSS/HEAD after deployment"],mustCompareSameKstDay:true},
      limitations:["Saved state and receipts only; no live worker readiness, in-memory crawl queue absence, provider quota or original row audit.","Historical execution hashes cover whitelisted metadata and result/receipt byte lengths, not their full bodies.","Separate saved JSON files are stable across this read but are not a jointly atomic OS snapshot.","SQLite is readOnly/query_only; it may update existing SHM read marks. Filesystem/syscall writes zero is not claimed.","Proc cwd/exe are inspected by readlink only. Node candidates include other Node work in the same checkout; no exact app PID binding is claimed. Source Git HEAD is not proof of the commit loaded by a running PID; bind to Render deployment evidence.","Render service ID is expected context, not read from environment. Bind this receipt to the authenticated central web Shell.","No original rows, credentials, lease hashes, command lines, environment values or customer contact data are returned."]};
    const text=JSON.stringify(output);need(Buffer.byteLength(text)<=MAX.output,"OUTPUT_BOUNDS");console.log("MONTHLY_RELEASE_PRESERVATION "+text);return output;
  }catch(error){if(transaction){try{db?.exec("ROLLBACK");}catch{}}try{db?.close();}catch{}const output={schemaVersion:1,status:"unknown",observedAt:new Date().toISOString(),code:typeof error.code==="string"&&/^[A-Z0-9_]{1,100}$/.test(error.code)?error.code:"PRESERVATION_READ_UNAVAILABLE",explicitApplicationWrites:0,explicitSqlMutations:0,apiCalls:0,providerCalls:0,appStarted:false};console.log("MONTHLY_RELEASE_PRESERVATION "+JSON.stringify(output));process.exitCode=1;return output;}
}
module.exports={configSummary,holdSummary,brokerSummary,queueSummary,webSummary,safeResult,slotSummary,idleSummary,checked,stable,read,run};
if(require.main===module)run();
