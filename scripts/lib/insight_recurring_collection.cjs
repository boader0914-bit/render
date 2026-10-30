'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fault, fields } = require('./insight_store.cjs');
const { insightCollectionWorkerKey } = require('./insight_preparation.cjs');

const DAY = 86400000;
const DEFAULTS = Object.freeze({ time:'14:00', bookingRangeDays:30, timezone:'Asia/Seoul', dayUseMode:'detail' });
const TERMINAL = new Set(['complete','reused','partial','blocked','failed','needs_review']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,99}$/;
const KEY = /^[A-Za-z0-9_-]{8,120}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safeCode = (value, fallback) => SAFE_CODE.test(value || '') ? value : fallback;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const addDays = (day,count) => new Date(Date.parse(`${day}T00:00:00Z`)+count*DAY).toISOString().slice(0,10);
const at = (day,time) => new Date(`${day}T${time}:00+09:00`).toISOString();
function scopeFor(day) {
  return { checkIn:day, checkOut:addDays(day,1), bookingRangeDays:30, adults:2, searchMode:'company', collectionMode:'precision',
    collectionPurpose:'revenue_detail', productMode:'all', dayUseMode:'detail', detailRankRanges:'1-1', schemaVersion:1 };
}
function scopeEqual(left,right) {
  return ['checkIn','checkOut','bookingRangeDays','adults','searchMode','collectionMode','collectionPurpose','productMode','dayUseMode','detailRankRanges']
    .every(key => left?.[key] === right?.[key]);
}
function createInsightRecurringCollection({ file, dataDir, store, catalog, collectorRequests, verifyStored, readPostprocess = null,
  findReusable = null, inspectToday = null, isBusy = async () => false, workerKey, now = () => Date.now(), intervalMs = 30000 }) {
  const configuredWorker = insightCollectionWorkerKey(workerKey);
  if (!store || typeof catalog !== 'function' || !collectorRequests || typeof verifyStored !== 'function') throw fault('RECURRING_CONFIGURATION_INVALID','정기 수집 연결 설정을 확인해 주세요.',503);
  const databaseFile = file || (dataDir && path.join(dataDir,'customer_insight','recurring_collections.sqlite'));
  if (!databaseFile) throw fault('RECURRING_STORAGE_REQUIRED','정기 수집 저장소가 필요합니다.',503);
  fs.mkdirSync(path.dirname(databaseFile),{recursive:true});
  const db = new DatabaseSync(databaseFile);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if (db.prepare('PRAGMA user_version').get().user_version > 1) { db.close(); throw fault('RECURRING_SCHEMA_NEWER','정기 수집 저장소 버전에 맞는 서버가 필요합니다.',503); }
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions(company_id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requesters(customer_id TEXT NOT NULL,company_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(customer_id,company_id));
    CREATE TABLE IF NOT EXISTS commands(owner TEXT NOT NULL,request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(owner,request_key));
    CREATE TABLE IF NOT EXISTS claims(company_id TEXT NOT NULL,observation_day TEXT NOT NULL,job_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL,PRIMARY KEY(company_id,observation_day));
    CREATE INDEX IF NOT EXISTS claims_status ON claims(json_extract(data,'$.status'));
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const stamp = () => new Date(now()).toISOString();
  const today = () => new Date(Number(new Date(now())) + 9*3600000).toISOString().slice(0,10);
  let timer = null, flight = null, closed = false, closing = null;
  const running = new Set();
  function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const result=fn(); db.exec('COMMIT'); return result; } catch(error) { db.exec('ROLLBACK'); throw error; } }
  function audit(actor,action,value) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(crypto.randomUUID(),stamp(),String(actor || 'system').slice(0,160),action,JSON.stringify(value)); }
  const read = (table,key,value) => { const row=db.prepare(`SELECT data FROM ${table} WHERE ${key}=?`).get(value); return row ? JSON.parse(row.data) : null; };
  const subscription = companyId => read('subscriptions','company_id',companyId);
  function putSubscription(value) { db.prepare('INSERT INTO subscriptions VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET data=excluded.data').run(value.companyId,JSON.stringify(value)); }
  function requesters(companyId) { return db.prepare('SELECT data FROM requesters WHERE company_id=?').all(companyId).map(row=>JSON.parse(row.data)); }
  function claim(companyId,day) { const row=db.prepare('SELECT data FROM claims WHERE company_id=? AND observation_day=?').get(companyId,day); return row?JSON.parse(row.data):null; }
  function putClaim(value) { db.prepare('UPDATE claims SET data=? WHERE company_id=? AND observation_day=?').run(JSON.stringify(value),value.companyId,value.observationDay); }
  function updateClaim(value,status,message,extra={}) {
    return tx(()=>{ const current=claim(value.companyId,value.observationDay); if(!current || current.jobId!==value.jobId)return current;
      const next={...current,status,message,...extra,updatedAt:stamp()}; putClaim(next); return next; });
  }
  function validCompanyId(value) { if(typeof value!=='string'||!/^cmp_[A-Za-z0-9_-]{1,180}$/.test(value)) throw fault('INVALID_COMPANY','업체 번호를 확인해 주세요.'); return value; }
  function authorized(customerId,companyId,throwing=true) {
    let customer; try { customer=store.get(customerId); } catch { if(throwing)throw fault('CUSTOMER_REQUIRED','활성 이용자로 로그인해 주세요.',403); return null; }
    const relations=(customer.relations||[]).filter(row=>row.companyId===companyId && row.status!=='archived' && row.status!=='cancelled');
    const valid=customer.accountStatus==='active' && relations.length===1 && relations[0].kind==='competitor' && relations[0].status==='active';
    if(!valid) { if(throwing)throw fault('RECURRING_COMPETITOR_REQUIRED','승인된 경쟁업체만 정기 수집을 요청할 수 있습니다.',403); return null; }
    return customer;
  }
  async function companyFor(companyId,{allowLegacyStoredId=false}={}) {
    const rows=await catalog();
    const found=(rows?.companies||[]).filter(row=>row.companyId===companyId);
    if(found.length!==1)throw fault('COMPANY_REVIEW_REQUIRED','업체 연결을 확인해 주세요.',409);
    const company=found[0], ids=company.placeIds;
    if(!Array.isArray(ids)||ids.length!==1||!(allowLegacyStoredId?/^\d{1,30}$/:/^[1-9]\d{0,29}$/).test(String(ids[0])))throw fault('PLACE_REVIEW_REQUIRED','단일 플레이스 번호를 먼저 검수해 주세요.',409);
    return {...company,placeIds:[String(ids[0])]};
  }
  function command(owner,key,payload) {
    if(typeof key!=='string'||!KEY.test(key))throw fault('INVALID_REQUEST_KEY','요청 번호를 확인해 주세요.');
    const fingerprint=digest(payload), old=db.prepare('SELECT fingerprint FROM commands WHERE owner=? AND request_key=?').get(owner,key);
    if(old) { if(old.fingerprint!==fingerprint)throw fault('RECURRING_REQUEST_CONFLICT','같은 요청 번호의 내용이 다릅니다.',409); return false; }
    db.prepare('INSERT INTO commands VALUES(?,?,?)').run(owner,key,fingerprint); return true;
  }
  function activeRequesters(companyId) { return requesters(companyId).filter(row=>authorized(row.customerId,companyId,false)); }
  function safeAttempt(value) { return value ? { observationDay:value.observationDay,status:value.status,startedAt:value.createdAt,updatedAt:value.updatedAt,
    runId:value.runId||null,errorCode:value.errorCode||null,message:value.message||'',reused:value.status==='reused' } : null; }
  function latest(companyId) { const row=db.prepare('SELECT data FROM claims WHERE company_id=? ORDER BY observation_day DESC LIMIT 1').get(companyId); return row?JSON.parse(row.data):null; }
  function nextRunAt(value) {
    if(value?.status!=='approved'||!value.startsOn||!activeRequesters(value.companyId).length)return null;
    let day=today(); if(day<value.startsOn)day=value.startsOn;
    if(claim(value.companyId,day))day=addDays(day,1);
    return at(day,value.time);
  }
  function publicRecord(value,requester=null) {
    const attempt=latest(value.companyId);
    return {companyId:value.companyId,companyName:value.companyName,status:value.status,message:attempt?.message||value.message||'',errorCode:attempt?.errorCode||null,
      requestedAt:requester?.requestedAt||value.requestedAt,reviewedAt:value.reviewedAt||null,reviewReason:value.reviewReason||'',time:value.time,
      startsOn:value.startsOn||null,nextRunAt:nextRunAt(value),lastCollectedAt:value.lastCollectedAt||null,lastCollectedDay:value.lastCollectedDay||null,lastRunId:value.lastRunId||null,
      bookingRangeDays:30,dayUseMode:'detail',latestAttempt:safeAttempt(attempt),shared:requester?.shared===true};
  }
  function get(customerId,companyId) {
    authorized(customerId,companyId);
    const requester=db.prepare('SELECT data FROM requesters WHERE customer_id=? AND company_id=?').get(customerId,companyId);
    const value=subscription(companyId); return requester&&value ? publicRecord(value,JSON.parse(requester.data)) : null;
  }
  function forCustomer(customerId) {
    const customer=store.get(customerId); if(customer.accountStatus!=='active')return [];
    return db.prepare('SELECT company_id FROM requesters WHERE customer_id=? ORDER BY rowid').all(customerId)
      .filter(row=>authorized(customerId,row.company_id,false)).map(row=>get(customerId,row.company_id));
  }
  function adminRecord(value) {
    const rows=requesters(value.companyId);
    return {...publicRecord(value),requestCount:rows.length,requesters:rows.map(row=>{
      let customer; try{customer=store.get(row.customerId);}catch{}
      return {customerId:row.customerId,username:customer?.username||'',requestedAt:row.requestedAt};
    })};
  }
  function adminList() { return db.prepare('SELECT data FROM subscriptions ORDER BY rowid DESC').all().map(row=>adminRecord(JSON.parse(row.data))); }
  function adminState() { return {requests:adminList(),defaults:{...DEFAULTS}}; }
  async function request(customerId,payload,actor) {
    if(typeof payload==='string') { payload={companyId:payload,...actor}; actor=customerId; }
    fields(payload,['companyId','requestKey']); const companyId=validCompanyId(payload.companyId);
    authorized(customerId,companyId); const company=await companyFor(companyId);
    return tx(()=>{
      authorized(customerId,companyId);
      if(!command(`customer:${customerId}`,payload.requestKey,{companyId}))return get(customerId,companyId);
      let value=subscription(companyId);
      if(value&&value.placeId!==company.placeIds[0])throw fault('PLACE_REVIEW_REQUIRED','승인 대상의 플레이스 연결이 변경되어 관리자 검수가 필요합니다.',409);
      if(!value) { value={companyId,companyName:company.name||companyId,placeId:company.placeIds[0],status:'pending',time:DEFAULTS.time,startsOn:null,requestedAt:stamp(),
        message:'정기 수집 승인 대기 중입니다.',lastCollectedAt:null,lastCollectedDay:null,lastRunId:null}; putSubscription(value); }
      const reapplying=value.status==='rejected';
      if(reapplying) {
        Object.assign(value,{status:'pending',requestedAt:stamp(),reviewedAt:null,reviewReason:'',message:'정기 수집 재신청 승인 대기 중입니다.'});putSubscription(value);
      }
      const old=db.prepare('SELECT data FROM requesters WHERE customer_id=? AND company_id=?').get(customerId,companyId);
      if(!old)db.prepare('INSERT INTO requesters VALUES(?,?,?)').run(customerId,companyId,JSON.stringify({customerId,companyId,requestedAt:stamp(),shared:value.status==='approved'}));
      else if(reapplying)db.prepare('UPDATE requesters SET data=? WHERE customer_id=? AND company_id=?').run(JSON.stringify({...JSON.parse(old.data),requestedAt:stamp(),shared:false}),customerId,companyId);
      audit(actor||customerId,reapplying?'recurring-reapplied':'recurring-requested',{companyId,customerId,shared:value.status==='approved'});
      return get(customerId,companyId);
    });
  }
  async function review(payload,actor) {
    fields(payload,['companyId','decision','reason','time','requestKey']); const companyId=validCompanyId(payload.companyId);
    if(!['approve','reject','pause'].includes(payload.decision))throw fault('INVALID_REVIEW_DECISION','승인·거절·일시중지를 선택해 주세요.');
    const time=payload.time===undefined?DEFAULTS.time:payload.time;
    if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw fault('INVALID_COLLECTION_TIME','한국시간 시각을 확인해 주세요.');
    if(typeof payload.reason!=='string'||!payload.reason.trim()||payload.reason.length>500||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(payload.reason))throw fault('INVALID_REVIEW_REASON','검토 사유를 1~500자로 입력해 주세요.');
    if(!actor)throw fault('ADMIN_REQUIRED','관리자 검토 권한이 필요합니다.',403);
    let company=null; if(payload.decision==='approve')company=await companyFor(companyId);
    return tx(()=>{
      const value=subscription(companyId); if(!value)throw fault('NOT_FOUND','정기 수집 요청을 찾을 수 없습니다.',404);
      if(!command('review',payload.requestKey,{companyId,decision:payload.decision,reason:payload.reason||'',time}))return adminRecord(value);
      if(payload.decision==='approve'&&!activeRequesters(companyId).length)throw fault('RECURRING_COMPETITOR_REQUIRED','활성 경쟁업체 연결이 없어 승인할 수 없습니다.',409);
      if(company&&value.placeId!==company.placeIds[0])throw fault('PLACE_REVIEW_REQUIRED','요청 이후 플레이스 번호가 변경되어 검수가 필요합니다.',409);
      const approved=payload.decision==='approve', changed=value.status!=='approved'||value.time!==time;
      Object.assign(value,{status:approved?'approved':payload.decision==='reject'?'rejected':'paused',reviewedAt:stamp(),reviewReason:(payload.reason||'').trim(),
        message:approved?'승인되었습니다. 표시된 시작일과 한국시간부터 하루 한 번 수집합니다.':payload.decision==='reject'?'관리자가 요청을 거절했습니다.':'정기 수집이 일시중지되었습니다.'});
      if(approved) { value.time=time; if(changed)value.startsOn=addDays(today(),1); }
      putSubscription(value); audit(actor,'recurring-reviewed',{companyId,decision:payload.decision,time:value.time,startsOn:value.startsOn,reason:value.reviewReason});
      return adminRecord(value);
    });
  }
  function jobFrom(value) { return {kind:value.kind||'insight_recurring_collection',jobId:value.jobId,companyId:value.companyId,observationDay:value.observationDay,
    keyword:value.keyword,placeIds:[value.placeId],scope:clone(value.scope),execution:{workerKey:value.workerKey},reused:value.reused===true}; }
  function getDayClaim(companyId,day=today()) { const value=claim(companyId,day); return value ? {companyId,observationDay:day,status:value.status,jobId:value.jobId,
    runId:value.runId||null,scope:clone(value.scope),errorCode:value.errorCode||null} : null; }
  async function inspect(companyId,scope,day,ignoreJobId=null) {
    let inspected=null;
    if(typeof inspectToday==='function') {
      let result; try{result=await inspectToday(companyId,scope,day);}catch{return {state:'review',errorCode:'COLLECTION_TODAY_STATUS_UNAVAILABLE'};}
      if(!result||!['none','reusable','busy','review'].includes(result.state))return {state:'review',errorCode:'COLLECTION_TODAY_STATUS_UNAVAILABLE'};
      if(result.state==='review')return {state:'review',errorCode:safeCode(result.errorCode,'COLLECTION_REVIEW_REQUIRED')};
      if(result.state!=='none')inspected={state:result.state,runId:result.runId||null,errorCode:safeCode(result.errorCode,'COLLECTION_REVIEW_REQUIRED')};
    }
    let jobs; try{jobs=typeof store.preparationJobs==='function'?store.preparationJobs():[];}catch{return {state:'review',errorCode:'COLLECTION_TODAY_STATUS_UNAVAILABLE'};}
    let pending=false,reusable=null;
    for(const job of jobs.filter(row=>row.companyId===companyId&&row.observationDay===day&&row.jobId!==ignoreJobId)) {
      if(['dispatching','queued','collecting'].includes(job.status)){pending=true;continue;}
      if(job.status==='ready'&&job.runId&&scopeEqual(job.scope,scope)){reusable=job.runId;continue;}
      return {state:'review',errorCode:scopeEqual(job.scope,scope)?'COLLECTION_REVIEW_REQUIRED':'COLLECTION_SCOPE_REVIEW'};
    }
    if(pending||inspected?.state==='busy')return {state:'busy',errorCode:'COLLECTION_COMPANY_BUSY'};
    if(inspected?.state==='reusable')return inspected;
    if(reusable)return {state:'reusable',runId:reusable};
    if(typeof findReusable==='function') {
      try{const reused=await findReusable(companyId,scope,day);if(reused)return {state:'reusable',runId:typeof reused==='string'?reused:reused.runId};}
      catch{return {state:'review',errorCode:'COLLECTION_REUSE_STATUS_UNAVAILABLE'};}
    }
    return {state:'none'};
  }
  function reserve({companyId,day,company,scope,jobId=crypto.randomUUID(),worker=configuredWorker,kind='insight_recurring_collection',external=false,inspection}) {
    return tx(()=>{
      const existing=claim(companyId,day); if(existing)return {value:existing,start:false};
      if(day!==today())return {value:null,start:false,state:'review',errorCode:'COLLECTION_OBSERVATION_DAY_CHANGED'};
      const value={companyId,observationDay:day,jobId,kind,keyword:company.name||companyId,placeId:String(company.placeIds[0]),scope:clone(scope),workerKey:worker,
        status:inspection?.state==='review'?'needs_review':inspection?.state==='reusable'?'verifying':'dispatching',runId:inspection?.runId||null,reused:inspection?.state==='reusable',
        errorCode:inspection?.state==='review'?inspection.errorCode||'COLLECTION_REVIEW_REQUIRED':null,
        message:inspection?.state==='review'?'오늘 같은 업체의 수집 기록을 검토해야 합니다. 추가 수집하지 않습니다.':inspection?.state==='reusable'?'당일 저장 자료의 업체·기간·반영 상태를 확인 중입니다.':'실행 전 영수증을 저장했습니다.',
        external,createdAt:stamp(),updatedAt:stamp()};
      db.prepare('INSERT INTO claims VALUES(?,?,?,?)').run(companyId,day,jobId,JSON.stringify(value)); audit('system','recurring-day-claimed',{companyId,day,jobId,scope,worker});
      return {value,start:true};
    });
  }
  async function finishVerified(value,runId,reused,receiptPostprocess=null) {
    if(typeof runId!=='string'||!/^[A-Za-z0-9_-]{1,220}$/.test(runId)) {updateClaim(value,'needs_review','저장된 수집 번호를 확인해야 합니다.',{errorCode:'RESULT_RUN_ID_MISSING'});return;}
    let postprocess;
    try { postprocess=typeof readPostprocess==='function'?await readPostprocess(runId):receiptPostprocess; }
    catch { updateClaim(value,'needs_review','업체 DB 반영 상태를 확인하지 못했습니다.',{runId,errorCode:'COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE'});return; }
    const state=postprocess?.state||postprocess?.status;
    if(['held','queued','running'].includes(state)) { updateClaim(value,'verifying','수집 결과 보관 완료 · 업체 DB 반영 중입니다.',{runId,errorCode:null,reused});return; }
    // Legacy direct collections already have scoped company/master proof but
    // predate the durable postprocess queue. Reusing that exact saved result
    // does not authorize a new crawl or certify the recurring detail profile.
    const externalLegacyReuse=value.external===true&&reused&&postprocess==null;
    if(!externalLegacyReuse&&(postprocess==null||state!=='complete')) {
      updateClaim(value,'needs_review','업체 DB 반영 완료를 확인하지 못했습니다.',{runId,errorCode:safeCode(postprocess?.errorCode||postprocess?.lastErrorCode,'COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE')});return;
    }
    let verified=false; try{verified=await verifyStored({...jobFrom(value),reused},runId);}catch{}
    if(!verified) { updateClaim(value,'needs_review','저장 결과의 업체 또는 30일 상세 수집 범위를 확인해야 합니다.',{runId,errorCode:'COLLECTION_STORED_SCOPE_MISMATCH'});return; }
    tx(()=>{
      const current=claim(value.companyId,value.observationDay); if(!current||current.jobId!==value.jobId)return;
      Object.assign(current,{status:reused?'reused':'complete',runId,reused,errorCode:null,message:'업체·기간과 결과 저장·DB 반영을 확인했습니다.',updatedAt:stamp(),completedAt:stamp()}); putClaim(current);
      const sub=subscription(value.companyId);
      if(sub&&!externalLegacyReuse&&scopeEqual(value.scope,scopeFor(value.observationDay))&&(!sub.lastCollectedDay||sub.lastCollectedDay<=value.observationDay)) {
        Object.assign(sub,{lastCollectedAt:stamp(),lastCollectedDay:value.observationDay,lastRunId:runId});putSubscription(sub);
      }
      audit('system','recurring-stored-verified',{companyId:value.companyId,day:value.observationDay,runId,reused});
    });
  }
  async function refresh(value,force=false) {
    if(!value||TERMINAL.has(value.status)||running.has(value.jobId))return;
    if((value.external||value.status==='dispatching')&&!force&&Number(new Date(now()))-Date.parse(value.createdAt)<60000)return;
    if(value.reused&&value.runId) { await finishVerified(value,value.runId,true);return; }
    let receipt; try{receipt=await collectorRequests.get(value.jobId);}catch {
      updateClaim(value,'needs_review','접수 여부가 불명확하여 자동 재수집하지 않습니다.',{errorCode:'COLLECTION_DISPATCH_UNCONFIRMED'});return;
    }
    if(receipt.status==='pending') {updateClaim(value,'collecting','수집 대기 또는 진행 중입니다. 저장 검증 후 완료됩니다.');return;}
    if(['complete','reused'].includes(receipt.status)&&receipt.result?.collectionQuality?.status==='complete'&&receipt.result.runId) {
      await finishVerified(value,receipt.result.runId,receipt.status==='reused'||receipt.result.reused===true,receipt.result.postprocess);return;
    }
    const status=['partial','blocked','failed'].includes(receipt.status)?receipt.status:'needs_review';
    updateClaim(value,status,status==='blocked'?'접근 제한으로 중단했습니다. 오늘 재시도하거나 수집기를 전환하지 않습니다.':'오늘 수집을 완료하지 못했습니다. 추가 수집 없이 기록을 검토합니다.',
      {runId:receipt.result?.runId||null,errorCode:safeCode(receipt.errorCode||receipt.result?.collectionQuality?.reason,'COLLECTION_REVIEW_REQUIRED')});
  }
  async function refreshClaim(jobId) { const value=read('claims','job_id',jobId);await refresh(value,true);return value?getDayClaim(value.companyId,value.observationDay):null; }
  async function claimExternal(job) {
    const companyId=validCompanyId(job?.companyId),day=job.observationDay;
    if(day!==today()||!date(day)||!KEY.test(job.jobId||'')||!job.scope||job.placeIds?.length!==1)throw fault('RECURRING_EXTERNAL_SCOPE_INVALID','업체·수집일·수집 범위를 확인해 주세요.',409);
    const company=await companyFor(companyId,{allowLegacyStoredId:true});
    if(company.placeIds[0]!==String(job.placeIds[0]))throw fault('PLACE_REVIEW_REQUIRED','플레이스 번호가 일치하지 않습니다.',409);
    const old=claim(companyId,day);
    if(old) {
      await refresh(old); const current=claim(companyId,day);
      if(['complete','reused'].includes(current.status)&&scopeEqual(current.scope,job.scope))return {state:'reusable',runId:current.runId};
      return {state:TERMINAL.has(current.status)?'review':'busy',errorCode:!scopeEqual(current.scope,job.scope)?'COLLECTION_SCOPE_REVIEW':current.errorCode||(TERMINAL.has(current.status)?'COLLECTION_REVIEW_REQUIRED':'COLLECTION_COMPANY_BUSY')};
    }
    let inspection=await inspect(companyId,job.scope,day,job.jobId);
    if(!/^[1-9]\d{0,29}$/.test(company.placeIds[0])&&inspection.state==='none')inspection={state:'review',errorCode:'PLACE_REVIEW_REQUIRED'};
    if(inspection.state==='busy')return inspection;
    const reserved=reserve({companyId,day,company,scope:job.scope,jobId:job.jobId,worker:insightCollectionWorkerKey(job.execution?.workerKey),kind:job.kind||'insight_preparation',external:true,inspection});
    if(!reserved.start)return {state:reserved.state||'busy',errorCode:reserved.errorCode||'COLLECTION_COMPANY_BUSY'};
    if(inspection.state==='review')return inspection;
    if(inspection.state==='reusable') {await finishVerified(reserved.value,inspection.runId,true);const checked=claim(companyId,day);return checked.status==='reused'?{state:'reusable',runId:checked.runId}:{state:'review',errorCode:checked.errorCode||'COLLECTION_REVIEW_REQUIRED'};}
    return {state:'new'};
  }
  async function dispatch(value) {
    running.add(value.jobId);
    try {
      if(value.observationDay!==today()) {
        updateClaim(value,'needs_review','한국시간 수집일이 바뀌어 전날 수집을 시작하지 않았습니다.',{errorCode:'COLLECTION_OBSERVATION_DAY_CHANGED'});return;
      }
      // One approved company must receive all requested stay dates. A zero
      // range-place limit explicitly disables the crawler's date-range path.
      const bookingRangePlaceLimit=value.scope.bookingRangeDays>1?1:0;
      await collectorRequests.submit({...value.scope,keyword:value.keyword,targetPlaceId:value.placeId,workerKey:value.workerKey,clientRequestId:value.jobId,
        sourceRole:'admin',collectionSource:'admin_search',trigger:'scheduled',scheduledCollection:true,searchRegion:'',searchScope:'',bookingRangePlaceLimit});
      updateClaim(value,'queued','정기 수집을 접수했습니다. 저장·DB 반영 확인 후 완료됩니다.',{errorCode:null});
    } catch(error) {
      const code=safeCode(error?.code,'COLLECTION_DISPATCH_UNCONFIRMED');
      updateClaim(value,/BLOCK|CAPTCHA|HALTED/.test(code)?'blocked':'needs_review','작업 접수 또는 보호 상태를 확인해야 합니다. 오늘 자동 재시도하지 않습니다.',{errorCode:code});
    } finally {running.delete(value.jobId);}
  }
  async function performTick() {
    if(closed)return;
    const open=db.prepare("SELECT data FROM claims WHERE json_extract(data,'$.status') IN ('dispatching','queued','collecting','verifying')").all().map(row=>JSON.parse(row.data));
    for(const value of open)await refresh(value);
    const day=today();
    for(const row of db.prepare('SELECT data FROM subscriptions ORDER BY rowid').all()) {
      let sub=JSON.parse(row.data);
      if(sub.status!=='approved'||!sub.startsOn||day<sub.startsOn||stamp()<at(day,sub.time)||!activeRequesters(sub.companyId).length)continue;
      if(claim(sub.companyId,day))continue;
      let company;try{company=await companyFor(sub.companyId);}catch(error){
        reserve({companyId:sub.companyId,day,company:{name:sub.companyName,placeIds:[sub.placeId]},scope:scopeFor(day),inspection:{state:'review',errorCode:safeCode(error.code,'COMPANY_REVIEW_REQUIRED')}});continue;
      }
      if(company.placeIds[0]!==sub.placeId) {reserve({companyId:sub.companyId,day,company:{name:sub.companyName,placeIds:[sub.placeId]},scope:scopeFor(day),inspection:{state:'review',errorCode:'PLACE_REVIEW_REQUIRED'}});continue;}
      const scope=scopeFor(day),inspection=await inspect(sub.companyId,scope,day);
      if(inspection.state==='busy')continue;
      let busy;try{busy=await isBusy(configuredWorker);}catch{busy=true;}
      if(inspection.state==='none'&&busy!==false)continue;
      sub=subscription(sub.companyId);
      if(today()!==day||sub.status!=='approved'||day<sub.startsOn||stamp()<at(day,sub.time)||!activeRequesters(sub.companyId).length)continue;
      const reserved=reserve({companyId:sub.companyId,day,company,scope,inspection});
      if(!reserved.start)continue;
      if(inspection.state==='reusable')await finishVerified(reserved.value,inspection.runId,true);
      else if(inspection.state==='none')await dispatch(reserved.value);
    }
  }
  function tick() { if(closed)return Promise.resolve();if(flight)return flight;flight=performTick().finally(()=>{flight=null;});return flight; }
  async function start() {if(closed)throw fault('RECURRING_CLOSED','정기 수집 저장소가 닫혔습니다.',503);if(timer)return;timer=setInterval(()=>{tick().catch(()=>{});},Math.max(1000,intervalMs));timer.unref?.();await tick();}
  async function stop() {if(timer){clearInterval(timer);timer=null;}if(flight)await flight;}
  function close() {
    if(closing)return closing;
    if(closed)return Promise.resolve();
    closed=true;if(timer){clearInterval(timer);timer=null;}
    if(!flight){db.close();closing=Promise.resolve();}
    else closing=flight.finally(()=>db.close());
    return closing;
  }
  return {request,review,forCustomer,customerState:forCustomer,get,adminList,adminState,getDayClaim,claimExternal,refreshClaim,tick,start,stop,close};
}
module.exports={createInsightRecurringCollection,scopeFor,scopeEqual};
