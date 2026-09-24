"use strict";
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {serialExecutor}=require('./collection_reuse.cjs');
const ID=/^[a-zA-Z0-9_-]{8,120}$/;
const STATES=new Set(['pending','complete','partial','blocked','failed','interrupted','reused']);
function fault(code,message,statusCode=409){return Object.assign(new Error(message),{code,statusCode});}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
function publicRow(row){
 const {requestId,workerKey,trigger,keyword,status,createdAt,finishedAt,errorCode,message}=row;
 const source=row.result;
 const result=source?{runId:source.runId,collectionQuality:source.collectionQuality?{status:source.collectionQuality.status}:null,reused:source.reused===true,workerKey:source.workerKey,trigger:source.trigger}:null;
 return {requestId,workerKey,trigger,keyword,status,createdAt,finishedAt,result,errorCode,message,...(row.conditions?{conditions:row.conditions}:{}),...(row.failurePhase?{failurePhase:row.failurePhase}:{}),...(row.brokerErrorCode?{brokerErrorCode:row.brokerErrorCode}:{}),...(row.recovery?{recovery:row.recovery}:{})};
}
function safeFailure(error){
 const code=/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.code||'')?error.code:'COLLECTION_FAILED';
 const status=/BLOCK|CAPTCHA/.test(code)?'blocked':/CANCEL|INTERRUPT|SHUTDOWN|PAUSED/.test(code)?'interrupted':'failed';
 const known={COLLECTION_SCOPE_BUSY:'같은 키워드의 수집이 진행 중입니다. 완료 후 범위를 확인하세요.',COLLECTION_SCOPE_REVIEW:'오늘 자료와 요청 범위가 다릅니다. 재수집 사유를 확인하세요.',COLLECTION_REVIEW_REQUIRED:'오늘 미완료 기록이 있습니다. 기록과 재수집 사유를 확인하세요.'};
 const diagnostics={};
 if(['file_upload','final_validation'].includes(error?.failurePhase)) diagnostics.failurePhase=error.failurePhase;
 if(require('./collector_worker.cjs').BROKER_FAILURE_CODES.has(error?.brokerErrorCode)) diagnostics.brokerErrorCode=error.brokerErrorCode;
 return {status,errorCode:code,...diagnostics,message:known[code]||(diagnostics.failurePhase==='final_validation'?'수집 결과의 최종 저장 검증에 실패했습니다. 보존 자료와 상세 오류를 확인하세요.':status==='blocked'?'접근 제한으로 중단했습니다. 정상 자료로 반영하지 않았습니다.':status==='interrupted'?'수집이 중단되었습니다. 자동으로 다시 실행하지 않습니다.':'수집을 완료하지 못했습니다. 워커 상태와 실행 기록을 확인하세요.')};
}
function createCollectorRequests({dataDir,run,preflight=async()=>{},now=()=>new Date()}){
 const dir=path.join(dataDir,'history','collector-requests');const lock=serialExecutor();const rows=new Map();let ready;
 const stamp=()=>new Date(now()).toISOString();
 async function write(row){await fs.mkdir(dir,{recursive:true});const file=path.join(dir,`${row.requestId}.json`),tmp=`${file}.${crypto.randomUUID()}.tmp`;await fs.writeFile(tmp,JSON.stringify(row),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}
 async function initialize(){
  ready ||= (async()=>{await fs.mkdir(dir,{recursive:true});
   for(const name of await fs.readdir(dir)){if(!name.endsWith('.json')||!ID.test(name.slice(0,-5)))continue;
    let row;try{row=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));}catch{throw fault('COLLECTION_RECEIPT_UNREADABLE','수집 요청 기록을 확인해야 합니다.');}
    if(row.version!==1||row.requestId!==name.slice(0,-5)||!STATES.has(row.status)||!['manual','scheduled','web'].includes(row.workerKey))throw fault('COLLECTION_RECEIPT_INVALID','수집 요청 기록을 확인해야 합니다.');
    if(row.status==='pending'){Object.assign(row,{status:'interrupted',finishedAt:stamp(),errorCode:'COLLECTOR_RESTART_INTERRUPTED',message:'서버 재시작으로 결과 확인이 중단되었습니다. 기존 수집 기록을 확인하세요.'});await write(row);}
    rows.set(row.requestId,row);
   }
  })();return ready;
 }
 async function finish(row,values){const next={...row,...values,finishedAt:stamp()};await write(next);Object.assign(row,next);}
 async function execute(row,payload){
  try{
   const value=await run(payload);const quality=value?.collectionQuality;
   const state=quality?.status;
   const runId=typeof value?.runId==='string'&&/^[a-zA-Z0-9_-]{1,220}$/.test(value.runId)?value.runId:null;
   const status=['complete','partial','blocked','failed'].includes(state)&&runId?(state==='complete'&&value.reused?'reused':state):'failed';
   const result={runId,collectionQuality:quality?{status:quality.status}:null,reused:value?.reused===true,workerKey:value?.workerKey||row.workerKey,trigger:value?.trigger||'manual'};
   const message={complete:'수집과 결과 검증을 완료했습니다.',reused:'조건에 맞는 당일 자료를 사용했습니다.',partial:'일부 자료가 누락되었습니다. 정상 자료로 반영하지 않았습니다.',blocked:'접근 제한으로 중단했습니다. 정상 자료로 반영하지 않았습니다.',failed:'수집을 완료하지 못했습니다. 결과와 워커 상태를 확인하세요.'}[status];
   await lock(()=>finish(row,{status,result,message,errorCode:status==='failed'&&!runId?'RESULT_RUN_ID_MISSING':null}));
  }catch(error){try{await lock(()=>finish(row,safeFailure(error)));}catch{Object.assign(row,{status:'interrupted',errorCode:'COLLECTOR_RECEIPT_WRITE_FAILED',message:'최종 상태 저장을 확인하지 못했습니다. 기존 결과를 확인하세요.',finishedAt:stamp()});}}
 }
 async function submit(payload){const accepted=await lock(async()=>{
  await initialize();const requestId=payload.clientRequestId;
  if(!ID.test(requestId||''))throw fault('COLLECTION_REQUEST_ID_INVALID','요청 번호를 확인하세요.',400);
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  if(rows.has(requestId)){const old=rows.get(requestId);if(old.fingerprint!==fingerprint)throw fault('COLLECTION_REQUEST_CONFLICT','같은 요청 번호의 수집 조건이 다릅니다.');return {row:old};}
  await preflight(payload);
  const row={version:1,requestId,fingerprint,workerKey:payload.workerKey||'manual',trigger:'manual',keyword:String(payload.keyword||'').slice(0,160),status:'pending',createdAt:stamp(),finishedAt:null,result:null,errorCode:null,message:'수집 요청을 접수했습니다. 실제 실행 상태는 워커 카드에서 확인하세요.'};
  row.conditions=Object.fromEntries(['checkIn','checkOut','bookingRangeDays','detailRankRanges','collectionPurpose','dayUseMode'].filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]));
  await write(row);rows.set(requestId,row);
  // The durable receipt precedes execution, and every rejection has a terminal handler.
  return {row,start:true};
 });if(accepted.start)setImmediate(()=>execute(accepted.row,payload));return publicRow(accepted.row);}
 async function get(id){await initialize();if(!ID.test(id||'')||!rows.has(id))throw fault('COLLECTION_REQUEST_NOT_FOUND','수집 요청을 찾지 못했습니다.',404);return publicRow(rows.get(id));}
 async function list(){await initialize();return [...rows.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50).map(publicRow);}
 async function recover(id,value){return lock(async()=>{
  await initialize();const row=rows.get(id);
  if(!row)throw fault('COLLECTION_REQUEST_NOT_FOUND','수집 요청을 찾지 못했습니다.',404);
  if(value?.collectionQuality?.status!=='complete'||!value.runId||value.workerKey!==row.workerKey||value.keyword!==row.keyword||!value.recovery?.jobId)throw fault('COLLECTION_RECOVERY_MISMATCH','복구 결과의 조건을 확인하세요.');
  if(row.status==='complete'&&row.recovery?.jobId===value.recovery.jobId&&row.result?.runId===value.runId)return publicRow(row);
  if(row.status!=='failed'||row.errorCode!=='COLLECTOR_UPLOAD_FAILED')throw fault('COLLECTION_RECOVERY_NOT_ELIGIBLE','복구 가능한 실패 요청이 아닙니다.');
  const next={...row,status:'complete',errorCode:null,message:'보존된 수집 결과를 검증해 복구했습니다.',result:{runId:value.runId,collectionQuality:{status:'complete'},workerKey:row.workerKey,trigger:row.trigger,reused:false},recovery:{jobId:value.recovery.jobId,recoveredAt:stamp(),originalStatus:row.status,originalErrorCode:row.errorCode,originalFinishedAt:row.finishedAt}};
  await write(next);Object.assign(row,next);return publicRow(row);
 });}
 return {submit,get,list,recover};
}
module.exports={createCollectorRequests};
