'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {createInsightRecurringCollection,scopeFor}=require('./lib/insight_recurring_collection.cjs');

function fixture(t,overrides={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-recurring-'));
  const clock={value:Date.parse('2026-10-26T02:00:00Z')};
  const customers={a:{customerId:'a',username:'alpha',accountStatus:'active',relations:[{companyId:'cmp_place_101',kind:'competitor',status:'active'}]},
    b:{customerId:'b',username:'beta',accountStatus:'active',relations:[{companyId:'cmp_place_101',kind:'competitor',status:'active'}]}};
  const companies=[{companyId:'cmp_place_101',name:'테스트글램핑',placeIds:['101']}];
  const prep=[],submitted=[],receipts=new Map(),checks=[];
  const store={get:id=>{if(!customers[id])throw new Error('missing');return customers[id];},preparationJobs:()=>prep};
  let postprocess={state:'complete'},verified=true;
  const options={file:path.join(dir,'recurring.sqlite'),store,catalog:async()=>({companies}),workerKey:'manual',now:()=>clock.value,
    collectorRequests:{submit:async payload=>{submitted.push(payload);receipts.set(payload.clientRequestId,{status:'pending'});return {status:'pending'};},
      get:async id=>{if(!receipts.has(id))throw Object.assign(new Error('missing'),{code:'COLLECTION_REQUEST_NOT_FOUND'});return receipts.get(id);}},
    verifyStored:async(job,runId)=>{checks.push({job,runId});return verified;},readPostprocess:async()=>postprocess,
    isBusy:async()=>false,...overrides};
  const instances=[]; const create=()=>{const value=createInsightRecurringCollection(options);instances.push(value);return value;};
  const service=create();
  t.after(async()=>{for(const value of instances)await value.close();fs.rmSync(dir,{recursive:true,force:true});});
  const request=(customerId='a',requestKey=`request_${customerId}_0001`)=>service.request(customerId,{companyId:'cmp_place_101',requestKey},customerId);
  const review=(decision='approve',extra={})=>service.review({companyId:'cmp_place_101',decision,reason:'검토 완료',requestKey:`review_${decision}_0001`,...extra},'administrator');
  const due=()=>{clock.value=Date.parse('2026-10-27T05:00:00Z');};
  const complete=(runId='run_test_001')=>{const payload=submitted.at(-1);receipts.set(payload.clientRequestId,{status:'complete',result:{runId,collectionQuality:{status:'complete'},postprocess:{state:'complete'}}});return payload;};
  return {service,create,options,clock,customers,companies,prep,submitted,receipts,checks,request,review,due,complete,
    setPostprocess:value=>{postprocess=value;},setVerified:value=>{verified=value;}};
}
test('고객 GET은 전역 승인이 있어도 신청을 만들지 않는다',async t=>{
  const f=fixture(t);assert.equal(f.service.get('a','cmp_place_101'),null);await f.request();await f.review();
  assert.equal(f.service.get('b','cmp_place_101'),null);assert.deepEqual(f.service.forCustomer('b'),[]);assert.equal(f.submitted.length,0);
});
test('승인 전에는 수집하지 않고 기본 승인 시작일은 내일 14시다',async t=>{
  const f=fixture(t);const pending=await f.request();assert.equal(pending.status,'pending');await f.service.tick();assert.equal(f.submitted.length,0);
  const approved=await f.review();assert.equal(approved.startsOn,'2026-10-27');assert.equal(approved.nextRunAt,'2026-10-27T05:00:00.000Z');
  assert.equal(approved.time,'14:00');assert.equal(approved.dayUseMode,'detail');assert.equal(approved.bookingRangeDays,30);
  await f.service.tick();assert.equal(f.submitted.length,0);f.clock.value=Date.parse('2026-10-27T04:59:59Z');await f.service.tick();assert.equal(f.submitted.length,0);
  f.due();await f.service.tick();assert.equal(f.submitted.length,1);
});
test('정기 수집은 단일 플레이스 당일 포함 30일 상세 데이유즈와 지정 워커로 실행한다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();
  const payload=f.submitted[0];assert.deepEqual(Object.fromEntries(Object.keys(scopeFor('2026-10-27')).map(key=>[key,payload[key]])),scopeFor('2026-10-27'));
  assert.equal(payload.targetPlaceId,'101');assert.equal(payload.keyword,'테스트글램핑');assert.equal(payload.workerKey,'manual');
  assert.equal(payload.trigger,'scheduled');assert.equal(payload.scheduledCollection,true);assert.equal(payload.searchRegion,'');assert.equal(payload.searchScope,'');
  const claim=f.service.getDayClaim('cmp_place_101');assert.equal(claim.jobId,payload.clientRequestId);assert.equal(claim.status,'queued');
});
test('다수 고객 같은 회사는 전역 주기를 공유하며 하루 한 번만 실행한다',async t=>{
  const f=fixture(t);await f.request();await f.review();const shared=await f.request('b');assert.equal(shared.shared,true);assert.equal(shared.status,'approved');
  assert.equal(f.service.adminList()[0].requestCount,2);f.due();await Promise.all([f.service.tick(),f.service.tick()]);assert.equal(f.submitted.length,1);
  f.complete();await f.service.tick();await f.service.tick();assert.equal(f.submitted.length,1);
  assert.equal(f.service.get('a','cmp_place_101').lastRunId,'run_test_001');assert.equal(f.service.get('b','cmp_place_101').lastRunId,'run_test_001');
});
test('요청·검토 키는 멱등이고 같은 키의 다른 명령은 충돌한다',async t=>{
  const f=fixture(t);await f.request();await f.request();assert.equal(f.service.adminList()[0].requestCount,1);
  await f.review();await f.review();
  await assert.rejects(f.service.review({companyId:'cmp_place_101',decision:'pause',reason:'검토 완료',requestKey:'review_approve_0001'},'administrator'),{code:'RECURRING_REQUEST_CONFLICT'});
  assert.equal(f.service.get('a','cmp_place_101').status,'approved');
});
for(const kind of ['own','pending','archived','disabled','conflict'])test(`활성 경쟁업체 관계만 요청 허용: ${kind}`,async t=>{
  const f=fixture(t);const c=f.customers.a;
  if(kind==='own')c.relations[0].kind='own';else if(kind==='disabled')c.accountStatus='disabled';else if(kind==='conflict')c.relations.push({...c.relations[0],kind:'own'});else c.relations[0].status=kind;
  await assert.rejects(f.request(),{code:'RECURRING_COMPETITOR_REQUIRED'});assert.equal(f.service.adminList().length,0);
});
test('관계 해제·계정 중지 후 승인이나 수집하지 않는다',async t=>{
  const f=fixture(t);await f.request();f.customers.a.relations[0].status='archived';await assert.rejects(f.review(),{code:'RECURRING_COMPETITOR_REQUIRED'});
  f.customers.a.relations[0].status='active';await f.review('approve',{requestKey:'review_approve_new_0001'});f.customers.a.accountStatus='disabled';f.due();await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.adminList()[0].nextRunAt,null,'활성 요청자가 없으면 실행 예정으로 표시하지 않는다');
  assert.deepEqual(f.service.forCustomer('a'),[]);
});
for(const placeIds of [[],['101','102'],['0'],['-1'],['abc']])test(`식별자가 확정되지 않은 회사는 신청하지 않는다: ${JSON.stringify(placeIds)}`,async t=>{
  const f=fixture(t);f.companies[0].placeIds=placeIds;await assert.rejects(f.request(),{code:'PLACE_REVIEW_REQUIRED'});assert.equal(f.service.adminList().length,0);
});
test('승인 후 플레이스가 바뀌면 자동 대상을 바꾸지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.companies[0].placeIds=['102'];f.due();await f.service.tick();
  assert.equal(f.submitted.length,0);assert.equal(f.service.getDayClaim('cmp_place_101').errorCode,'PLACE_REVIEW_REQUIRED');
});
test('일시중지·거절은 일정만 바꾸고 즉시 수집이나 자동 재승인하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();await f.review('pause');f.due();await f.service.tick();assert.equal(f.submitted.length,0);
  await f.request('b');assert.equal(f.service.get('b','cmp_place_101').status,'paused');await f.review('reject');assert.equal(f.service.get('a','cmp_place_101').status,'rejected');
  assert.equal(f.service.get('a','cmp_place_101').nextRunAt,null);
});
test('저장·후처리·업체범위 검증 전에는 마지막 정상 수집일을 갱신하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();f.complete();f.setPostprocess({state:'running'});await f.service.tick();
  let state=f.service.get('a','cmp_place_101');assert.equal(state.lastCollectedAt,null);assert.equal(state.latestAttempt.status,'verifying');
  f.setPostprocess({state:'complete'});await f.service.tick();state=f.service.get('a','cmp_place_101');assert.equal(state.latestAttempt.status,'complete');assert.equal(state.lastCollectedDay,'2026-10-27');assert.equal(f.checks.length,1);
  assert.equal(f.checks[0].job.kind,'insight_recurring_collection');assert.deepEqual(f.checks[0].job.placeIds,['101']);
});
for(const reason of ['verify','postprocess_failed','postprocess_missing','postprocess_unknown'])test(`완료 응답만으로 성공 승격하지 않는다: ${reason}`,async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();f.complete();
  if(reason==='verify')f.setVerified(false);else f.setPostprocess(reason==='postprocess_missing'?null:{state:reason==='postprocess_failed'?'failed':'unknown'});
  await f.service.tick();const state=f.service.get('a','cmp_place_101');assert.equal(state.lastCollectedAt,null);assert.equal(state.latestAttempt.status,'needs_review');
  await f.service.tick();assert.equal(f.submitted.length,1);
});
for(const status of ['partial','blocked','failed','interrupted'])test(`같은 날 실패·차단은 재시도하거나 워커를 전환하지 않는다: ${status}`,async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();f.receipts.set(f.submitted[0].clientRequestId,{status,errorCode:'NAVER_RATE_LIMITED'});
  await f.service.tick();await f.service.tick();assert.equal(f.submitted.length,1);const state=f.service.get('a','cmp_place_101');assert.equal(state.lastCollectedAt,null);
  assert.equal(state.latestAttempt.status,status==='interrupted'?'needs_review':status);assert.equal(state.latestAttempt.errorCode,'NAVER_RATE_LIMITED');
});
test('보호 preflight의 거절을 유지하고 같은 날 다시 접수하지 않는다',async t=>{
  let calls=0;const f=fixture(t,{collectorRequests:{submit:async()=>{calls++;throw Object.assign(new Error('protected'),{code:'COLLECTOR_PROVIDER_BLOCKED'});},get:async()=>{throw new Error('none');}}});
  await f.request();await f.review();f.due();await f.service.tick();await f.service.tick();assert.equal(calls,1);assert.equal(f.service.getDayClaim('cmp_place_101').status,'blocked');
});
test('같은 날 완전 자료 재사용도 저장 검증 후에만 완료한다',async t=>{
  const f=fixture(t,{inspectToday:async()=>({state:'reusable',runId:'keyword_run_001'})});await f.request();await f.review();f.due();await f.service.tick();
  assert.equal(f.submitted.length,0);assert.equal(f.checks.length,1);assert.equal(f.checks[0].job.reused,true);
  assert.equal(f.service.get('a','cmp_place_101').lastRunId,'keyword_run_001');assert.equal(f.service.getDayClaim('cmp_place_101').status,'reused');
});
test('부분·다른조건·검사 불명 상태는 기존 재사용 가능 자료보다 우선하여 보류한다',async t=>{
  const f=fixture(t,{inspectToday:async()=>({state:'review',errorCode:'COLLECTION_SCOPE_REVIEW'}),findReusable:async()=>{throw new Error('must not run');}});
  await f.request();await f.review();f.due();await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.getDayClaim('cmp_place_101').status,'needs_review');
});
test('검사 오류를 자료 없음으로 간주하지 않는다',async t=>{
  const f=fixture(t,{inspectToday:async()=>{throw new Error('private failure');}});await f.request();await f.review();f.due();await f.service.tick();assert.equal(f.submitted.length,0);
  assert.equal(f.service.getDayClaim('cmp_place_101').errorCode,'COLLECTION_TODAY_STATUS_UNAVAILABLE');assert.ok(!JSON.stringify(f.service.adminState()).includes('private failure'));
});
test('같은 회사의 진행중 수동 작업은 완료까지 기다리고 당일 재사용한다',async t=>{
  let current={state:'busy'};const f=fixture(t,{inspectToday:async()=>current});await f.request();await f.review();f.due();await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.getDayClaim('cmp_place_101'),null);
  current={state:'reusable',runId:'manual_run_001'};await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.get('a','cmp_place_101').lastRunId,'manual_run_001');
});
test('기존 준비작업의 회사·당일 기록으로도 추가 요청을 막는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();f.prep.push({jobId:'earlier_preparation',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:{...scopeFor('2026-10-27'),dayUseMode:'inspect'},status:'ready',runId:'old_run'});
  await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.getDayClaim('cmp_place_101').errorCode,'COLLECTION_SCOPE_REVIEW');
});
test('수집기 사용중·상태 불명은 접수하지 않고 나중에 같은 지정 수집기를 사용한다',async t=>{
  let busy=true;const f=fixture(t,{isBusy:async()=>busy});await f.request();await f.review();f.due();await f.service.tick();assert.equal(f.submitted.length,0);
  busy={unknown:true};await f.service.tick();assert.equal(f.submitted.length,0);busy=false;await f.service.tick();assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].workerKey,'manual');
});
test('재시작 뒤 접수 불명인 영수증은 재실행하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();f.receipts.clear();f.clock.value+=61000;const second=f.create();await second.tick();
  assert.equal(f.submitted.length,1);assert.equal(second.getDayClaim('cmp_place_101').status,'needs_review');await second.tick();assert.equal(f.submitted.length,1);
});
test('여러 프로세스용 저장소 인스턴스도 회사·날짜 유니크 영수증을 공유한다',async t=>{
  const f=fixture(t);await f.request();await f.review();const second=f.create();f.due();await Promise.all([f.service.tick(),second.tick()]);assert.equal(f.submitted.length,1);
  assert.equal(f.service.getDayClaim('cmp_place_101').jobId,second.getDayClaim('cmp_place_101').jobId);
});
test('놓친 과거 수집일은 소급 실행하지 않고 오늘 한 번만 실행한다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.clock.value=Date.parse('2026-10-30T05:00:00Z');await f.service.tick();assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].checkIn,'2026-10-30');
  assert.equal(f.service.getDayClaim('cmp_place_101','2026-10-27'),null);
});
test('외부 수동 요청도 원자적 회사·날짜 영수증을 먼저 확보한다',async t=>{
  const f=fixture(t);f.due();const job={jobId:'external_job_0001',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),placeIds:['101'],execution:{workerKey:'manual'}};
  const [first,second]=await Promise.all([f.service.claimExternal(job),f.service.claimExternal({...job,jobId:'external_job_0002'})]);
  assert.equal([first,second].filter(row=>row.state==='new').length,1);assert.equal([first,second].filter(row=>row.state==='busy').length,1);
  assert.equal(f.service.getDayClaim('cmp_place_101').jobId,'external_job_0001');assert.equal(f.submitted.length,0);
  f.receipts.set(job.jobId,{status:'complete',result:{runId:'external_run',collectionQuality:{status:'complete'},postprocess:{state:'complete'}}});
  await f.service.refreshClaim(job.jobId);assert.equal(f.service.getDayClaim('cmp_place_101').status,'complete');
  assert.deepEqual(await f.service.claimExternal({...job,jobId:'external_job_0003'}),{state:'reusable',runId:'external_run'});
});
test('수동으로 다른 범위를 수집한 날에는 정기 상세30일을 추가 실행하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();const job={jobId:'external_scope_0001',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:{...scopeFor('2026-10-27'),bookingRangeDays:14},placeIds:['101'],execution:{workerKey:'web'}};
  assert.equal((await f.service.claimExternal(job)).state,'new');f.receipts.set(job.jobId,{status:'failed',errorCode:'COLLECTION_FAILED'});await f.service.refreshClaim(job.jobId);
  await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.get('a','cmp_place_101').lastCollectedAt,null);
});
test('외부 접수 불명은 영수증을 보존하며 오늘 재실행하지 않는다',async t=>{
  const f=fixture(t);f.due();const job={jobId:'external_unknown_001',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),placeIds:['101'],execution:{workerKey:'manual'}};
  await f.service.claimExternal(job);await f.service.refreshClaim(job.jobId);assert.equal(f.service.getDayClaim('cmp_place_101').status,'needs_review');
  assert.equal((await f.service.claimExternal({...job,jobId:'external_unknown_002'})).state,'review');
});
test('고객 응답은 다른 고객 식별정보와 내부 실행정보를 노출하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.request('b');await f.review();f.due();await f.service.tick();
  const serialized=JSON.stringify(f.service.get('a','cmp_place_101'));assert.ok(!serialized.includes('beta'));assert.ok(!serialized.includes('requesters'));
  assert.ok(!serialized.includes('workerKey'));assert.ok(!serialized.includes(f.submitted[0].clientRequestId));
  assert.deepEqual(f.service.adminState().defaults,{time:'14:00',bookingRangeDays:30,timezone:'Asia/Seoul',dayUseMode:'detail'});
});
test('한국시간 날짜 경계와 반복 start/stop에서도 일정이 중복되지 않는다',async t=>{
  const f=fixture(t);f.clock.value=Date.parse('2026-10-26T15:01:00Z');await f.request();const approved=await f.review();assert.equal(approved.startsOn,'2026-10-28');
  f.clock.value=Date.parse('2026-10-28T05:00:00Z');await Promise.all([f.service.start(),f.service.start()]);await f.service.stop();assert.equal(f.submitted.length,1);
});
test('거절 뒤 새 요청 번호로 재신청하면 승인 대기로 돌아가고 옛 요청 재전송은 상태를 바꾸지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review('reject');const previous=f.service.get('a','cmp_place_101').requestedAt;
  f.clock.value+=60000;await f.request();assert.equal(f.service.get('a','cmp_place_101').status,'rejected');
  await f.request('a','request_a_reapply_0001');const state=f.service.get('a','cmp_place_101');assert.equal(state.status,'pending');assert.ok(state.requestedAt>previous);
  assert.equal(state.reviewReason,'');assert.equal(state.reviewedAt,null);assert.equal(f.service.adminList()[0].requestCount,1);assert.equal(f.submitted.length,0);
});
for(const reason of [undefined,'','   ','x'.repeat(501)])test(`승인·거절·중지 사유는 필수다: ${String(reason).slice(0,20)}`,async t=>{
  const f=fixture(t);await f.request();await assert.rejects(f.review('approve',{reason}),{code:'INVALID_REVIEW_REASON'});assert.equal(f.service.get('a','cmp_place_101').status,'pending');
});
test('첫 정상 준비 이력 뒤에 실패 이력이 있어도 재사용으로 승격하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();f.prep.push(
    {jobId:'normal_before',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),status:'ready',runId:'normal_run'},
    {jobId:'failed_after',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),status:'failed'});
  await f.service.tick();assert.equal(f.submitted.length,0);assert.equal(f.service.get('a','cmp_place_101').lastCollectedAt,null);assert.equal(f.service.getDayClaim('cmp_place_101').status,'needs_review');
});
test('재사용 후보가 있어도 같은 회사의 준비 작업 실패는 우선 보류한다',async t=>{
  const f=fixture(t,{inspectToday:async()=>({state:'reusable',runId:'candidate_run'})});await f.request();await f.review();f.due();
  f.prep.push({jobId:'failed_after',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),status:'blocked'});
  await f.service.tick();assert.equal(f.checks.length,0);assert.equal(f.service.getDayClaim('cmp_place_101').status,'needs_review');
});
test('14일 외부 수집 성공은 30일 상세 정기 수집의 마지막 검증일로 승격하지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();const job={jobId:'external_short_0001',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:{...scopeFor('2026-10-27'),bookingRangeDays:14},placeIds:['101'],execution:{workerKey:'manual'}};
  await f.service.claimExternal(job);f.receipts.set(job.jobId,{status:'complete',result:{runId:'short_run',collectionQuality:{status:'complete'},postprocess:{state:'complete'}}});await f.service.refreshClaim(job.jobId);
  assert.equal(f.service.getDayClaim('cmp_place_101').status,'complete');assert.equal(f.service.get('a','cmp_place_101').lastCollectedAt,null);await f.service.tick();assert.equal(f.submitted.length,0);
});
test('비동기 카탈로그 조회 중 자정이 지나면 전날 정기 수집 영수증이나 요청을 만들지 않는다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();f.options.catalog=async()=>({companies:f.companies});
  const second=f.create();f.clock.value=Date.parse('2026-10-27T14:59:59Z');
  f.options.catalog=async()=>{f.clock.value=Date.parse('2026-10-27T15:00:01Z');return {companies:f.companies};};
  const delayed=f.create();await delayed.tick();assert.equal(f.submitted.length,0);assert.equal(second.getDayClaim('cmp_place_101','2026-10-27'),null);
});
test('외부 요청의 비동기 검사가 자정을 넘으면 전날 영수증을 확보하지 않는다',async t=>{
  const f=fixture(t);f.due();f.options.catalog=async()=>{f.clock.value=Date.parse('2026-10-27T15:00:01Z');return {companies:f.companies};};const second=f.create();
  const result=await second.claimExternal({jobId:'external_midnight_01',companyId:'cmp_place_101',observationDay:'2026-10-27',scope:scopeFor('2026-10-27'),placeIds:['101'],execution:{workerKey:'manual'}});
  assert.equal(result.state,'review');assert.equal(result.errorCode,'COLLECTION_OBSERVATION_DAY_CHANGED');assert.equal(second.getDayClaim('cmp_place_101','2026-10-27'),null);assert.equal(f.submitted.length,0);
});
test('수집 번호 없는 재사용 후보는 완료 자료로 만들지 않는다',async t=>{
  const f=fixture(t,{inspectToday:async()=>({state:'reusable'})});await f.request();await f.review();f.due();await f.service.tick();
  assert.equal(f.service.getDayClaim('cmp_place_101').status,'needs_review');assert.equal(f.service.get('a','cmp_place_101').lastCollectedAt,null);
});
test('대기 작업이 없으면 close 호출 즉시 SQLite 핸들을 닫는다',async t=>{
  const f=fixture(t);await f.request();const promise=f.service.close();fs.renameSync(f.options.file,f.options.file+'.closed');await promise;
});
test('과거 영수증을 보존하고 상태 인덱스로 활성 영수증만 찾는 저장소를 재개한다',async t=>{
  const f=fixture(t);await f.request();await f.review();f.due();await f.service.tick();f.complete();await f.service.tick();
  const db=new DatabaseSync(f.options.file);const original=db.prepare('SELECT data FROM claims').get().data;
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT data FROM claims WHERE json_extract(data,'$.status') IN ('dispatching','queued','collecting','verifying')").all();
  assert.ok(plan.some(row=>row.detail.includes('claims_status')));assert.equal(db.prepare("SELECT count(*) AS n FROM claims WHERE json_extract(data,'$.status') IN ('dispatching','queued','collecting','verifying')").get().n,0);
  db.close();const second=f.create();await second.tick();const check=new DatabaseSync(f.options.file);assert.equal(check.prepare('SELECT data FROM claims').get().data,original);check.close();assert.equal(f.submitted.length,1);
});
