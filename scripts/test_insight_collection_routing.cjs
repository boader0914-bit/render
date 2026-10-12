'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightPreparation,insightCollectionWorkerKey}=require('./lib/insight_preparation.cjs');
const {createInsightIntegration}=require('./lib/insight_integration.cjs');
const {csrf}=require('./lib/insight_http.cjs');
const clock=Date.parse('2026-10-12T01:00:00Z'),today='2026-10-12';
const companies=['a','b'].map(id=>({companyId:'cmp_'+id,name:'검수 숙소 '+id,placeIds:[id]})),catalog={companies,regions:[]};
function fixture(t){
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'insight-routing-')),'data.sqlite');
  let store=createInsightStore({file,now:()=>clock});
  t.after(()=>store.close());
  const command=(cid,action,payload)=>({revision:store.get(cid).revision,requestKey:randomUUID(),action,payload});
  function customer(id){const c=store.ensure({memberId:id,username:id,role:'b2b'});for(const company of companies)store.update(c.customerId,command(c.customerId,'add-company',{kind:'competitor',companyId:company.companyId}),catalog);return c.customerId;}
  function request(cid,index=0){store.preparation(cid,command(cid,'prepare-data',{companyId:companies[index].companyId}),companies[index]);return {requestId:store.requests(cid).find(r=>r.companyId===companies[index].companyId).requestId,checkIn:today,bookingRangeDays:30,dayUseMode:'inspect'};}
  return {file,get store(){return store;},customer,request,reopen(){store.close();store=createInsightStore({file,now:()=>clock});}};
}
function bridge(f,workerKey,submit,get=async()=>({status:'pending'}),findReusable=null){return createInsightPreparation({store:f.store,catalog:async()=>catalog,workerKey,collectorRequests:{submit,get},verifyStored:async()=>true,findReusable,now:()=>clock});}

test('server worker setting allows only known keys and retains the legacy scheduled default',()=>{
  assert.equal(insightCollectionWorkerKey(undefined),'scheduled');
  for(const key of ['web','manual','scheduled'])assert.equal(insightCollectionWorkerKey(key),key);
  for(const key of ['',null,'BG worker','aws','../../worker',false])assert.throws(()=>insightCollectionWorkerKey(key),{code:'INSIGHT_COLLECTION_WORKER_INVALID',statusCode:503});
});
test('BG dispatch freezes execution outside data scope and announces the actual worker',async t=>{
  const f=fixture(t),cid=f.customer('a'),p=f.request(cid);let sent;
  await bridge(f,'manual',async value=>{sent=value;}).dispatch(cid,p,'admin');
  const job=f.store.preparationJobs()[0];
  assert.equal(sent.workerKey,'manual');assert.deepEqual(job.execution,{workerKey:'manual'});
  assert.equal(Object.hasOwn(job.scope,'workerKey'),false);assert.equal(Object.hasOwn(job.scope,'execution'),false);
  assert.equal(job.scope.bookingRangeDays,30);assert.equal(job.scope.adults,2);assert.equal(job.scope.collectionPurpose,'revenue_detail');assert.equal(job.scope.dayUseMode,'inspect');
  assert.equal(sent.clientRequestId,job.jobId);assert.equal(sent.sourceRole,'admin');assert.equal(sent.scheduledCollection,false);
  assert.match(f.store.requests(cid)[0].message,/BG worker/);
  assert.equal(f.store.history(cid).find(row=>row.action==='preparation-dispatch').data.execution.workerKey,'manual');
  f.store.updatePreparationJob(job.jobId,'collecting','상태 갱신',{execution:{workerKey:'web'}});
  assert.deepEqual(f.store.preparationJobs()[0].execution,{workerKey:'manual'},'result updates cannot retarget an existing job');
});
test('a forged worker option is rejected before reservation and cannot alter the selected worker',async t=>{
  const f=fixture(t),cid=f.customer('a'),p=f.request(cid);let submits=0;
  const b=bridge(f,'manual',async()=>submits++);
  await assert.rejects(b.dispatch(cid,{...p,workerKey:'web'},'admin'),{code:'INVALID_FIELDS'});
  assert.equal(submits,0);assert.equal(f.store.preparationJobs().length,0);
  await b.dispatch(cid,p,'admin');assert.equal(submits,1);assert.equal(f.store.preparationJobs()[0].execution.workerKey,'manual');
});
test('stored same-day data is reusable across execution settings without changing comparison scope',async t=>{
  const f=fixture(t),cid=f.customer('a'),p=f.request(cid);let submits=0,reuseScope;
  await bridge(f,'manual',async()=>submits++,undefined,async(id,scope,day)=>{assert.equal(id,companies[0].companyId);assert.equal(day,today);reuseScope=scope;return 'same_day_result';}).dispatch(cid,p,'admin');
  assert.equal(submits,0);assert.equal(Object.hasOwn(reuseScope,'workerKey'),false);
  assert.equal(f.store.requests(cid)[0].status,'ready');assert.equal(f.store.requests(cid)[0].runId,'same_day_result');
  await bridge(f,'web',async()=>submits++).dispatch(cid,p,'admin');
  assert.equal(submits,0);assert.equal(f.store.preparationJobs().length,1);assert.equal(f.store.preparationJobs()[0].execution.workerKey,'manual');
});
test('setting changes, a second customer and restart share the durable job without dispatch replay',async t=>{
  const f=fixture(t),a=f.customer('a'),p=f.request(a);let submits=0;const receipts=[];
  const submit=async value=>{submits++;assert.equal(value.workerKey,'scheduled');};
  await bridge(f,undefined,submit).dispatch(a,p,'admin');
  const first=f.store.preparationJobs()[0],b=f.customer('b'),p2=f.request(b);
  f.reopen();
  const next=bridge(f,'manual',submit,async id=>{receipts.push(id);return {status:'pending'};});
  await next.dispatch(a,p,'admin');await next.dispatch(b,p2,'admin');await next.refresh(a);
  assert.equal(submits,1);assert.equal(f.store.preparationJobs().length,1);
  const saved=f.store.preparationJobs()[0];assert.equal(saved.jobId,first.jobId);assert.deepEqual(saved.execution,{workerKey:'scheduled'});assert.deepEqual(saved.scope,first.scope);assert.equal(saved.createdAt,first.createdAt);
  assert.ok(receipts.length>=2);assert.ok(receipts.every(id=>id===first.jobId));
  assert.equal(f.store.requests(a)[0].jobId,f.store.requests(b)[0].jobId);
  const p3=f.request(b,1);let newTarget;
  await bridge(f,'manual',async value=>{newTarget=value;}).dispatch(b,p3,'admin');
  assert.equal(newTarget.workerKey,'manual');assert.equal(f.store.preparationJobs().length,2);
});
test('a legacy in-flight job without execution metadata is inspected by its original receipt and never rewritten or replayed',async t=>{
  const f=fixture(t),cid=f.customer('a'),p=f.request(cid);let submits=0;
  await bridge(f,undefined,async()=>submits++).dispatch(cid,p,'admin');
  const original=f.store.preparationJobs()[0],legacy={...original};delete legacy.execution;legacy.status='dispatching';
  const db=new DatabaseSync(f.file);db.prepare('UPDATE preparation_jobs SET data=? WHERE id=?').run(JSON.stringify(legacy),legacy.jobId);db.close();f.reopen();
  await bridge(f,'manual',async()=>submits++,async id=>{assert.equal(id,legacy.jobId);throw new Error('receipt unavailable');}).dispatch(cid,p,'admin');
  const saved=f.store.preparationJobs()[0];assert.equal(submits,1);assert.equal(saved.jobId,original.jobId);assert.equal(Object.hasOwn(saved,'execution'),false);assert.equal(saved.status,'needs_review');
  f.store.updatePreparationJob(saved.jobId,'needs_review','기록 확인',{execution:{workerKey:'manual'}});
  assert.equal(Object.hasOwn(f.store.preparationJobs()[0],'execution'),false,'legacy inspection preserves its original execution metadata');
});
test('ambiguous or blocked jobs are not moved to a different worker after a configuration change',async t=>{
  for(const code of ['TRANSPORT_FAILURE','COLLECTOR_PROVIDER_BLOCKED','COLLECTOR_WORKER_RETIRED']){
    const f=fixture(t),cid=f.customer(code),p=f.request(cid);let submits=0;
    await bridge(f,'manual',async()=>{submits++;throw Object.assign(new Error('fixture'),{code});},async()=>{throw Error('no receipt');}).dispatch(cid,p,'admin');
    await bridge(f,'web',async()=>submits++,async()=>{throw Error('no receipt');}).dispatch(cid,p,'admin');
    assert.equal(submits,1);assert.equal(f.store.preparationJobs().length,1);assert.equal(f.store.preparationJobs()[0].execution.workerKey,'manual');
    assert.equal(f.store.requests(cid)[0].status,code==='COLLECTOR_PROVIDER_BLOCKED'?'blocked':'needs_review');
    if(code==='COLLECTOR_WORKER_RETIRED')assert.match(f.store.requests(cid)[0].message,/인사이트 서버로 전환/);
  }
});
test('integration injects the server environment choice into authenticated collection commands',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-routing-integration-')),token=randomUUID(),day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);let sent;
  const raw={companyId:'cmp_live',primaryName:'환경설정 검수 숙소',addresses:['가상주소'],placeIds:['100']};
  const config={dataDir:dir,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:token,INSIGHT_COLLECTION_WORKER_KEY:'manual'},readCatalog:async()=>({regions:[],companies:[{companyId:raw.companyId,primaryName:raw.primaryName,placeIds:raw.placeIds}],rawCompanies:new Map([[raw.companyId,raw]])}),readMembers:async()=>({members:[{memberId:'user',role:'b2b'}]}),requireAdmin:()=>false,collectorRequests:{submit:async value=>{sent=value;},get:async()=>({status:'pending'})},verifyStored:async()=>true,readEvidence:async()=>null};
  const app=createInsightIntegration(config);t.after(()=>{app.store.close();app.adminStore.close();});
  const c=app.store.ensure({memberId:'user',username:'user',role:'b2b'}),session=app.store.session(c.customerId);
  const server=http.createServer((req,res)=>app.internal(req,res,new URL(req.url,'http://test')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const command=async(action,payload)=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/commands`,{method:'POST',headers:{Authorization:'Bearer '+token,'X-Insight-Session':session,'X-CSRF-Token':csrf(session),'Content-Type':'application/json'},body:JSON.stringify({revision:app.store.get(c.customerId).revision,requestKey:randomUUID(),action,payload})});
  assert.equal((await command('add-company',{kind:'competitor',companyId:raw.companyId})).status,200);
  const response=await command('collect',{companyId:raw.companyId,checkIn:day,bookingRangeDays:30,dayUseMode:'inspect'});assert.equal(response.status,200);
  assert.equal(sent.workerKey,'manual');assert.equal(sent.keyword,raw.primaryName);assert.equal(sent.bookingRangeDays,30);
  const data=await response.json();assert.equal(data.collectionAllowance.remaining,0);assert.equal(data.preparations[0].status,'collecting');
});
test('invalid integration worker setting fails before creating customer storage',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-routing-invalid-'));
  assert.throws(()=>createInsightIntegration({dataDir:dir,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:randomUUID(),INSIGHT_COLLECTION_WORKER_KEY:'unknown'}}),{code:'INSIGHT_COLLECTION_WORKER_INVALID'});
  assert.equal(fs.existsSync(path.join(dir,'customer_insight')),false);
});
