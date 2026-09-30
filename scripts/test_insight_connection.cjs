'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createInsightStore } = require('./lib/insight_store.cjs');
const { createInsightHttp } = require('./lib/insight_http.cjs');
const { createInsightPreparation } = require('./lib/insight_preparation.cjs');
const { createConnectedServer, configuration } = require('../customer-portal/connected-server.cjs');
const companies = Array.from({length:6}, (_,i) => ({companyId:`cmp_${i}`,name:`검수 숙소 ${i}`,address:'경남 산청군 검수주소',rooms:16,dayUse:'unknown',facilities:'',version:'v1',placeIds:[String(i+100)],regionKey:'r1'}));
const catalog = {companies,regions:[{id:'r1',label:'경남 산청군',level:'local'},{id:'r2',label:'경기 가평군',level:'local'}]};
function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-connection-test-'));
  let store=createInsightStore({file:path.join(dir,'data.sqlite')});
  t.after(()=>store.close());
  const a=store.ensure({memberId:'member-a',username:'review-a',role:'b2b',status:'active'});
  const b=store.ensure({memberId:'member-b',username:'review-b',role:'b2b',status:'active'});
  const cmd=(customerId,action,payload,key=randomUUID())=>({revision:store.get(customerId).revision,requestKey:key,action,payload});
  return {dir,store,a,b,cmd,reopen(){store.close();store=createInsightStore({file:path.join(dir,'data.sqlite')});return store;}};
}
test('customer configuration and hashed sessions survive restart; legacy member mapping stays unique',t=>{
  const x=setup(t);x.store.update(x.a.customerId,x.cmd(x.a.customerId,'add-company',{kind:'own',companyId:'cmp_0'}),catalog);
  const token=x.store.session(x.a.customerId);const reopened=x.reopen();
  assert.equal(reopened.authenticate(token).relations.length,1);
  assert.equal(reopened.ensure({memberId:'member-a',username:'review-a',role:'b2b'}).customerId,x.a.customerId);
  assert.equal(fs.readFileSync(path.join(x.dir,'data.sqlite')).includes(Buffer.from(token)),false);
});
test('unknown/admin roles cannot become Insight customers',t=>{
  const {store}=setup(t);for(const role of ['admin','owner',null])assert.throws(()=>store.ensure({memberId:'x',role}),{code:'CUSTOMER_REQUIRED'});
});
test('three competitor slots, duplicate own target, and stale concurrent commands are enforced transactionally',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  const stale=cmd(cid,'add-company',{kind:'competitor',companyId:'cmp_1'});
  store.update(cid,cmd(cid,'add-company',{kind:'competitor',companyId:'cmp_0'}),catalog);
  assert.throws(()=>store.update(cid,stale,catalog),{code:'STALE_REVISION'});
  for(const n of [1,2])store.update(cid,cmd(cid,'add-company',{kind:'competitor',companyId:`cmp_${n}`}),catalog);
  assert.throws(()=>store.update(cid,cmd(cid,'add-company',{kind:'competitor',companyId:'cmp_3'}),catalog),{code:'COMPETITOR_LIMIT'});
  assert.throws(()=>store.update(cid,cmd(cid,'add-company',{kind:'own',companyId:'cmp_0'}),catalog),{code:'DUPLICATE_COMPANY'});
  assert.equal(store.get(cid).relations.length,3);
});
test('idempotency replays the same change and rejects changed payloads',t=>{
  const {store,a,cmd}=setup(t),c=cmd(a.customerId,'add-company',{kind:'own',companyId:'cmp_0'});
  store.update(a.customerId,c,catalog);store.update(a.customerId,c,catalog);
  assert.equal(store.get(a.customerId).relations.length,1);
  assert.throws(()=>store.update(a.customerId,{...c,payload:{kind:'own',companyId:'cmp_1'}},catalog),{code:'REQUEST_CONFLICT'});
});
test('limit reductions require explicit retained targets and never delete history',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  for(const n of [0,1,2])store.update(cid,cmd(cid,'add-company',{kind:'competitor',companyId:`cmp_${n}`}),catalog);
  const payload={competitorLimit:1,interestRegionLimit:0,reason:'검수 한도 변경'};
  assert.throws(()=>store.adminUpdate(cid,cmd(cid,'entitlements',payload),'admin'),{code:'KEEP_SELECTION_REQUIRED'});
  const keep=store.get(cid).relations[1].relationId;
  store.adminUpdate(cid,cmd(cid,'entitlements',{...payload,keepCompetitorRelationIds:[keep]}),'admin');
  assert.equal(store.get(cid).relations.length,3);assert.equal(store.get(cid).relations.filter(r=>r.status==='active').length,1);
  assert.equal(store.get(cid).relations.find(r=>r.status==='active').relationId,keep);
  assert.ok(store.history(cid).some(r=>r.action==='entitlements'));
});
test('personal notes, corrections, and withdrawn requests remain tenant scoped',t=>{
  const {store,a,b,cmd}=setup(t);
  for(const c of [a,b])store.update(c.customerId,cmd(c.customerId,'add-company',{kind:'competitor',companyId:'cmp_0'}),catalog);
  store.update(a.customerId,cmd(a.customerId,'settings',{companyId:'cmp_0',nickname:'내 별칭',note:'개인 메모'}),catalog);
  assert.deepEqual(store.get(b.customerId).settings,{});
  const correction=cmd(a.customerId,'correction',{companyId:'cmp_0',baseVersion:'v1',proposed:{rooms:61},reason:'확인한 객실 수'});
  store.correct(a.customerId,correction,companies[0]);const request=store.corrections(a.customerId)[0];
  store.correct(a.customerId,cmd(a.customerId,'correction',correction.payload),companies[0]);
  assert.equal(store.corrections(a.customerId).length,1,'identical pending request is retained');
  assert.equal(companies[0].rooms,16);assert.equal(store.corrections(b.customerId).length,0);
  assert.throws(()=>store.correct(b.customerId,cmd(b.customerId,'withdraw-correction',{requestId:request.requestId})),{code:'NOT_FOUND'});
  store.correct(a.customerId,cmd(a.customerId,'withdraw-correction',{requestId:request.requestId}));
  assert.equal(store.corrections(a.customerId)[0].status,'withdrawn');
});
test('pending correction is version checked; admin can certify only an actual matching central edit',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  store.update(cid,cmd(cid,'add-company',{kind:'own',companyId:'cmp_0'}),catalog);
  const p={companyId:'cmp_0',baseVersion:'old',proposed:{rooms:17},reason:'확인 근거'};
  assert.throws(()=>store.correct(cid,cmd(cid,'correction',p),companies[0]),{code:'STALE_COMPANY'});
  store.correct(cid,cmd(cid,'correction',{...p,baseVersion:'v1'}),companies[0]);const r=store.corrections(cid)[0];
  assert.throws(()=>store.reviewCorrection(r.requestId,'verified','확인','admin',companies[0]),{code:'CENTRAL_EDIT_REQUIRED'});
  store.reviewCorrection(r.requestId,'verified','DB 확인','admin',{...companies[0],rooms:17,version:'v2'});
  assert.equal(store.corrections(cid)[0].status,'verified');
});
test('registration and preparations do not trigger collection; daily duplicate receipt is reused',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  store.update(cid,cmd(cid,'add-company',{kind:'competitor',companyId:'cmp_0'}),catalog);
  for(let i=0;i<3;i++)store.preparation(cid,cmd(cid,'prepare-data',{companyId:'cmp_0'}),companies[0]);
  assert.equal(store.requests(cid).length,1);assert.equal(store.requests(cid)[0].status,'needs_review');
  assert.throws(()=>store.preparation(cid,cmd(cid,'prepare-data',{companyId:'cmp_0',workerKey:'web'}),companies[0]),{code:'INVALID_FIELDS'});
});
test('disabled customers lose all sessions and cannot mutate with stale in-memory identity',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId,token=store.session(cid);
  store.adminUpdate(cid,cmd(cid,'account-status',{status:'disabled',reason:'이용 중지'}),'admin');
  assert.throws(()=>store.authenticate(token),{code:'LOGIN_REQUIRED'});
  assert.throws(()=>store.update(cid,cmd(cid,'onboarding',{businessStatus:'planning'}),catalog),{code:'ACCOUNT_DISABLED'});
});
test('more than thirty changes remain available with no silent history truncation',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  for(let i=0;i<40;i++)store.update(cid,cmd(cid,'onboarding',{businessStatus:'planning',projectName:`계획 ${i}`}),catalog);
  assert.equal(store.history(cid).length,41);
});
test('interest regions respect actual local identifiers and verified own region avoids duplicate slot',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  store.update(cid,cmd(cid,'add-company',{kind:'own',companyId:'cmp_0'}),catalog);
  store.adminUpdate(cid,cmd(cid,'property-review',{relationId:store.get(cid).relations[0].relationId,decision:'approve',reason:'운영자 확인'}),'admin');
  assert.throws(()=>store.update(cid,cmd(cid,'add-region',{regionKey:'r1'}),catalog),{code:'DUPLICATE_REGION'});
  store.update(cid,cmd(cid,'add-region',{regionKey:'r2'}),catalog);
  assert.equal(store.get(cid).regions.length,1);
});
test('approving a property releases its already registered interest-region slot without deleting history',t=>{
  const {store,a,cmd}=setup(t),cid=a.customerId;
  store.update(cid,cmd(cid,'add-region',{regionKey:'r1'}),catalog);
  store.update(cid,cmd(cid,'add-company',{kind:'own',companyId:'cmp_0'}),catalog);
  store.adminUpdate(cid,cmd(cid,'property-review',{relationId:store.get(cid).relations[0].relationId,decision:'approve',reason:'확인'}),'admin',catalog);
  assert.equal(store.get(cid).regions[0].status,'archived');
  store.update(cid,cmd(cid,'add-region',{regionKey:'r2'}),catalog);
  assert.equal(store.get(cid).regions.filter(row=>row.status==='active').length,1);
});
async function listen(server) { await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); return `http://127.0.0.1:${server.address().port}`; }
test('HTTP browser-to-BFF-to-DataLab flow keeps tokens private and rejects CSRF, cross-customer IDs, and admin paths',async t=>{
  const {store}=setup(t), serviceToken=randomUUID(), disabled=new Set();
  const integration=createInsightHttp({store,serviceToken,catalog:async()=>catalog,authenticateMember:async(name,password)=>password==='fixture-password'?{memberId:`member-${name}`,username:name,role:name==='admin'?'admin':'b2b',status:'active'}:null,memberActive:async id=>!disabled.has(id),requireAdmin:()=>false});
  const backendServer=http.createServer((req,res)=>integration.internal(req,res,new URL(req.url,'http://test')).catch(()=>{res.writeHead(500);res.end();}));
  const backend=await listen(backendServer);t.after(()=>{backendServer.closeAllConnections();backendServer.close();});
  let origin;const bff=createConnectedServer({origin:'http://127.0.0.1:1',backend,serviceToken});
  // Reserve a port, then instantiate the BFF with the exact allowed origin.
  origin=await listen(bff);await new Promise(resolve=>bff.close(resolve));
  const front=createConnectedServer({origin,backend,serviceToken});await new Promise(resolve=>front.listen(Number(new URL(origin).port),'127.0.0.1',resolve));t.after(()=>{front.closeAllConnections();front.close();});
  const request=(route,opts={})=>fetch(`${origin}/api/customer/v1${route}`,opts);
  let response=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({username:'a',password:'fixture-password'})});assert.equal(response.status,403);
  response=await request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'a',password:'fixture-password'})});
  assert.equal(response.status,200);const cookie=response.headers.get('set-cookie').split(';')[0];assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  const data=await response.json();assert.equal(data.token,undefined);assert.equal(JSON.stringify(data).includes(serviceToken),false);
  response=await request('/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify({})});assert.equal(response.status,403);
  const command={revision:data.customer.revision,requestKey:randomUUID(),action:'add-company',payload:{kind:'competitor',companyId:'cmp_0'}};
  response=await request('/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':data.csrfToken},body:JSON.stringify(command)});assert.equal(response.status,200);
  response=await fetch(`${origin}/api/admin/insight-customers`);assert.equal(response.status,404);
  response=await fetch(`${backend}/api/insight/v1/me`);assert.equal(response.status,401);
  response=await request('/catalog/companies?q=검수',{headers:{Cookie:cookie}});assert.equal(response.status,200);const candidates=await response.json();assert.equal(candidates.results[0].rooms,undefined);
  disabled.add(data.customer.memberId);response=await request('/me',{headers:{Cookie:cookie}});assert.equal(response.status,403);
});
test('BFF configuration rejects external plaintext backends and credentials in URLs',()=>{
  const token=randomUUID();
  for(const target of ['http://staydatalab.kr','https://user:secret@staydatalab.kr','https://staydatalab.kr/admin'])assert.throws(()=>configuration({INSIGHT_SERVICE_TOKEN:token,INSIGHT_DATALAB_ORIGIN:target}));
  assert.equal(configuration({INSIGHT_SERVICE_TOKEN:token}).backend,'http://127.0.0.1:57950');
});
test('AWS preparation shares identical company work between customers and validates central storage before ready',async t=>{
  const {store,a,b,cmd}=setup(t);let submits=0;const receipts=new Map();let stored=false;
  const bridge=createInsightPreparation({store,catalog:async()=>catalog,collectorRequests:{submit:async p=>{submits++;receipts.set(p.clientRequestId,{status:'pending'});assert.equal(p.workerKey,'scheduled');assert.equal(p.searchMode,'company');},get:async id=>receipts.get(id)},verifyStored:async()=>stored});
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  for(const c of [a,b]){
    store.update(c.customerId,cmd(c.customerId,'add-company',{kind:'competitor',companyId:'cmp_0'}),catalog);
    store.preparation(c.customerId,cmd(c.customerId,'prepare-data',{companyId:'cmp_0'}),companies[0]);
    await bridge.dispatch(c.customerId,{requestId:store.requests(c.customerId)[0].requestId,checkIn:today,bookingRangeDays:1},'admin');
  }
  assert.equal(submits,1);const job=store.preparationJobs()[0];
  receipts.set(job.jobId,{status:'complete',result:{runId:'test_run',collectionQuality:{status:'complete'}}});
  await bridge.refresh(a.customerId);assert.equal(store.requests(a.customerId)[0].status,'needs_review');
  stored=true;await bridge.refresh(b.customerId);assert.equal(store.requests(a.customerId)[0].status,'ready');assert.equal(store.requests(b.customerId)[0].status,'ready');
});
test('ambiguous dispatch and provider block never cause a new job or worker failover',async t=>{
  const {store,a,cmd}=setup(t);let submits=0;let receipt;
  const bridge=createInsightPreparation({store,catalog:async()=>catalog,collectorRequests:{submit:async()=>{submits++;throw new Error('transport failure');},get:async()=>{if(!receipt)throw new Error('not found');return receipt;}},verifyStored:async()=>false});
  store.update(a.customerId,cmd(a.customerId,'add-company',{kind:'competitor',companyId:'cmp_0'}),catalog);
  store.preparation(a.customerId,cmd(a.customerId,'prepare-data',{companyId:'cmp_0'}),companies[0]);
  const p={requestId:store.requests(a.customerId)[0].requestId,checkIn:new Date(Date.now()+9*3600000).toISOString().slice(0,10),bookingRangeDays:1};
  await bridge.dispatch(a.customerId,p,'admin');await bridge.dispatch(a.customerId,p,'admin');assert.equal(submits,1);
  receipt={status:'blocked',errorCode:'NAVER_BLOCKED'};await bridge.refresh(a.customerId);
  assert.equal(store.requests(a.customerId)[0].status,'blocked');await bridge.dispatch(a.customerId,p,'admin');assert.equal(submits,1);
});
