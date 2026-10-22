'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises');
const path = require('node:path'), os = require('node:os'), http = require('node:http'), { randomUUID } = require('node:crypto');
const { createInsightStore } = require('./lib/insight_store.cjs');
const { createInsightPreparation } = require('./lib/insight_preparation.cjs');
const { createInsightIntegration } = require('./lib/insight_integration.cjs');
const { csrf } = require('./lib/insight_http.cjs');
const CLOCK = Date.parse('2026-10-20T00:00:00Z'), TODAY = '2026-10-20', RUN = 'fixture_glamping_20261020_090000';
const company = { companyId:'cmp_postprocess', name:'업체 DB 반영 검수 숙소', placeIds:['123456789'], rooms:16, version:'fixture' };
const catalog = { companies:[company], regions:[] };
async function removeTemporary(directory) {
  const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('insight-postprocess-')); await fsp.rm(resolved,{recursive:true,force:true});
}
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'insight-postprocess-')), file = path.join(directory,'data.sqlite');
  let store = createInsightStore({file,now:()=>CLOCK}), current = options.current, readError = options.readError, verified = options.verified !== false;
  const calls = { submit:0, verify:0, postprocess:[] };
  const receipt = options.receipt || {status:'complete',result:{runId:RUN,collectionQuality:{status:'complete'},...(options.fallback ? {postprocess:options.fallback} : {})}};
  const originalReceipt = JSON.stringify(receipt);
  t.after(async()=>{store.close();await removeTemporary(directory);});
  const customer = store.ensure({memberId:'fixture',username:'fixture',role:'b2b'});
  const command = (action,payload)=>({revision:store.get(customer.customerId).revision,requestKey:randomUUID(),action,payload});
  store.update(customer.customerId,command('add-company',{kind:'competitor',companyId:company.companyId}),catalog);
  store.preparation(customer.customerId,command('prepare-data',{companyId:company.companyId}),company);
  const payload = {requestId:store.requests(customer.customerId)[0].requestId,checkIn:TODAY,bookingRangeDays:30,dayUseMode:'inspect'};
  const dependencies = () => ({store,catalog:async()=>catalog,workerKey:'manual',now:()=>CLOCK,
    collectorRequests:{submit:async()=>{calls.submit++;},get:async()=>receipt},
    verifyStored:async(job,runId)=>{calls.verify++;assert.equal(runId,RUN);assert.equal(job.companyId,company.companyId);return verified;},
    ...(options.noDependency ? {} : {readPostprocess:async runId=>{calls.postprocess.push(runId);if(readError)throw readError;return current;}})});
  let bridge = createInsightPreparation(dependencies());
  return {payload,receipt,calls,customer,get store(){return store;},get bridge(){return bridge;},
    dispatch:()=>bridge.dispatch(customer.customerId,payload,'fixture'), refresh:()=>bridge.refresh(customer.customerId),
    row:()=>store.requests(customer.customerId)[0], setCurrent:value=>{current=value;},setError:value=>{readError=value;},setVerified:value=>{verified=value;},
    assertReceiptPreserved:()=>assert.equal(JSON.stringify(receipt),originalReceipt),
    reopen(){store.close();store=createInsightStore({file,now:()=>CLOCK});bridge=createInsightPreparation(dependencies());}};
}

for (const state of ['held','queued','running']) test(`complete archive with ${state} DB work stays collecting until current derivation completes`,async t=>{
  const f=fixture(t,{current:{state}});await f.dispatch();await f.refresh();
  assert.equal(f.row().status,'collecting');assert.equal(f.row().runId,RUN);assert.match(f.row().message,/수집 결과 보관 완료.*업체 DB 반영 중/);
  assert.doesNotMatch(f.row().message,/범위.*일치|수집.*실패/);assert.equal(f.calls.verify,0);assert.deepEqual(f.calls.postprocess,[RUN]);
  f.setCurrent({state:'complete'});await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.verify,1);
  await f.refresh();assert.equal(f.calls.verify,1);assert.equal(f.calls.submit,1);f.assertReceiptPreserved();
});

for (const state of ['failed','unavailable']) test(`${state} DB processing is a review reason, never a failed collection or a scope mismatch`,async t=>{
  const f=fixture(t,{current:{state,lastErrorCode:'COLLECTION_POSTPROCESS_HISTORY_FAILED'}});await f.dispatch();await f.refresh();
  assert.equal(f.row().status,'needs_review');assert.equal(f.row().runId,RUN);assert.match(f.row().message,/수집 결과는 보관.*업체 DB 반영/);
  assert.doesNotMatch(f.row().message,/범위.*일치/);assert.equal(f.calls.verify,0);assert.equal(f.row().errorCode,'COLLECTION_POSTPROCESS_HISTORY_FAILED');
  f.setCurrent({state:'queued'});await f.refresh();assert.equal(f.row().status,'collecting');assert.equal(f.row().errorCode,null);
  f.setCurrent({state:'complete'});await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.row().errorCode,null);
  assert.equal(f.calls.submit,1);f.assertReceiptPreserved();
});

test('an unexpected postprocess read exception is safely unavailable and does not call stored-scope verification',async t=>{
  const f=fixture(t,{readError:Error('private /var/data/path bearer secret')});await f.dispatch();await f.refresh();
  assert.equal(f.row().status,'needs_review');assert.equal(f.row().errorCode,'COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE');
  assert.match(f.row().message,/업체 DB 반영 상태/);assert.equal(JSON.stringify(f.row()).includes('bearer secret'),false);assert.equal(f.calls.verify,0);
  f.setError(null);f.setCurrent({status:'complete'});await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.verify,1);
});

test('an unknown queue state is unavailable and an unsafe queue error string never escapes',async t=>{
  const f=fixture(t,{current:{state:'unknown',errorCode:'private path secret'}});await f.dispatch();await f.refresh();
  assert.equal(f.row().status,'needs_review');assert.equal(f.row().errorCode,'COLLECTION_POSTPROCESS_STATUS_UNAVAILABLE');assert.equal(f.calls.verify,0);
  assert.equal(JSON.stringify(f.row()).includes('private path secret'),false);
});

test('a missing durable row retains the failed enqueue receipt instead of misreporting company scope',async t=>{
  const f=fixture(t,{current:null,fallback:{state:'failed',errorCode:'COLLECTION_POSTPROCESS_PERSIST_FAILED'}});await f.dispatch();await f.refresh();
  assert.equal(f.row().status,'needs_review');assert.equal(f.row().errorCode,'COLLECTION_POSTPROCESS_PERSIST_FAILED');assert.match(f.row().message,/업체 DB 반영을 완료하지 못/);
  assert.equal(f.calls.verify,0);assert.equal(f.receipt.status,'complete');f.assertReceiptPreserved();
});

test('current complete or missing legacy queue rows do not stay stuck on an old receipt snapshot',async t=>{
  for (const current of [null,{state:'complete'}]) {
    const f=fixture(t,{current,fallback:{state:'queued'}});await f.dispatch();await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.verify,1);
  }
  const f=fixture(t,{current:{state:'complete'},fallback:{state:'failed',errorCode:'COLLECTION_POSTPROCESS_PERSIST_FAILED'}});
  await f.dispatch();await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.verify,1);
});

test('without the optional reader, persisted request snapshots preserve pending and failure semantics',async t=>{
  for (const [state,expected] of [['held','collecting'],['queued','collecting'],['running','collecting'],['failed','needs_review'],['unavailable','needs_review'],['complete','ready']]) {
    const f=fixture(t,{noDependency:true,fallback:{state}});await f.dispatch();await f.refresh();
    assert.equal(f.row().status,expected);assert.equal(f.calls.verify,state==='complete'?1:0);assert.equal(f.calls.submit,1);
  }
  const f=fixture(t,{noDependency:true});await f.dispatch();await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.verify,1);
});

test('completed DB processing still requires the original company and date-range verification',async t=>{
  const f=fixture(t,{current:{state:'running'},verified:false});await f.dispatch();await f.refresh();assert.equal(f.row().status,'collecting');assert.equal(f.calls.verify,0);
  f.setCurrent({state:'complete'});await f.refresh();assert.equal(f.row().status,'needs_review');assert.match(f.row().message,/업체 또는 조회 범위가 일치/);
  assert.equal(f.calls.verify,1);assert.equal(f.calls.submit,1);
});

test('restart and redispatch inspect the same pending derivation and never submit a second collection',async t=>{
  const f=fixture(t,{current:{state:'queued'}});await f.dispatch();await f.refresh();const jobId=f.row().jobId;
  f.reopen();f.setCurrent({state:'running'});await f.dispatch();assert.equal(f.row().jobId,jobId);assert.equal(f.row().status,'collecting');assert.equal(f.calls.submit,1);
  f.setCurrent({state:'complete'});await f.refresh();assert.equal(f.row().status,'ready');assert.equal(f.calls.submit,1);
});

for (const status of ['partial','blocked','failed']) test(`${status} collection receipts do not become DB-waiting or trigger verification`,async t=>{
  const f=fixture(t,{current:{state:'running'},receipt:{status,result:{runId:RUN,collectionQuality:{status,reason:'fixture_collection_reason'}}}});
  await f.dispatch();await f.refresh();assert.equal(f.row().status,status);assert.equal(f.calls.postprocess.length,0);assert.equal(f.calls.verify,0);
});

test('the authenticated integration injects current postprocess state before checking stored company scope',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'insight-postprocess-')),token=randomUUID(),day=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  let current={state:'queued'},reads=0,verifications=0,submits=0,server;
  const raw={companyId:company.companyId,primaryName:company.name,placeIds:company.placeIds,addresses:['가상 주소']};
  const app=createInsightIntegration({dataDir:directory,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:token,INSIGHT_COLLECTION_WORKER_KEY:'manual'},
    readCatalog:async()=>({regions:[],companies:[{companyId:raw.companyId,primaryName:raw.primaryName,placeIds:raw.placeIds}],rawCompanies:new Map([[raw.companyId,raw]])}),
    readMembers:async()=>({members:[{memberId:'fixture',role:'b2b'}]}),requireAdmin:()=>false,
    collectorRequests:{submit:async()=>{submits++;},get:async()=>({status:'complete',result:{runId:RUN,collectionQuality:{status:'complete'}}})},
    readPostprocess:async runId=>{assert.equal(runId,RUN);reads++;return current;},verifyStored:async()=>{verifications++;return true;},readEvidence:async()=>null});
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}app.store.close();app.adminStore.close();await removeTemporary(directory);});
  const customer=app.store.ensure({memberId:'fixture',username:'fixture',role:'b2b'}),session=app.store.session(customer.customerId);
  server=http.createServer((req,res)=>app.internal(req,res,new URL(req.url,'http://fixture.test')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  const headers={Authorization:'Bearer '+token,'X-Insight-Session':session,'X-CSRF-Token':csrf(session),'Content-Type':'application/json'};
  const command=async(action,payload)=>fetch(base+'/api/insight/v1/commands',{method:'POST',headers,body:JSON.stringify({revision:app.store.get(customer.customerId).revision,requestKey:randomUUID(),action,payload}),signal:AbortSignal.timeout(5000)});
  assert.equal((await command('add-company',{kind:'competitor',companyId:company.companyId})).status,200);
  const response=await command('collect',{companyId:company.companyId,checkIn:day,bookingRangeDays:30,dayUseMode:'inspect'});assert.equal(response.status,200);
  const pending=await response.json();assert.equal(pending.preparations[0].status,'collecting');assert.match(pending.preparations[0].message,/업체 DB 반영 중/);
  assert.ok(reads>0);assert.equal(verifications,0);assert.equal(submits,1);
  current={state:'complete'};
  const refreshed=await fetch(base+'/api/insight/v1/me',{headers,signal:AbortSignal.timeout(5000)});assert.equal(refreshed.status,200);
  assert.equal((await refreshed.json()).preparations[0].status,'collecting','bootstrap returns the last verified state before refreshing in the background');
  const verified=await fetch(base+`/api/insight/v1/companies/${company.companyId}/collection`,{headers,signal:AbortSignal.timeout(5000)});assert.equal(verified.status,200);
  assert.equal((await verified.json()).request.status,'ready');assert.equal(verifications,1);assert.equal(submits,1);
  const latest=await fetch(base+'/api/insight/v1/me',{headers,signal:AbortSignal.timeout(5000)});assert.equal(latest.status,200);
  assert.equal((await latest.json()).preparations[0].status,'ready');assert.equal(verifications,1);assert.equal(submits,1);
});
