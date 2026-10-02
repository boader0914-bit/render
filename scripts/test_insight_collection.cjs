'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightHttp,csrf}=require('./lib/insight_http.cjs');
const {createInsightPreparation}=require('./lib/insight_preparation.cjs');
const {projectCollection}=require('./lib/insight_collection_results.cjs');
const {createConnectedServer}=require('../customer-portal/connected-server.cjs');
const {createInsightAdminStore}=require('./lib/insight_admin_store.cjs');
const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
const company={companyId:'cmp_100',name:'가상 검수 글램핑',rooms:16,roomCountSource:'db_manual_correction',version:'v1',placeIds:['100']};
const catalog={companies:[company],regions:[]};
function evidence(){return {run:{id:'fixture_run',checkIn:today,bookingRangeDays:1,dayUseMode:'detail',collectedAt:new Date().toISOString(),collectionQuality:{status:'partial'}},snapshot:{daily:[{date:today,productType:'lodging',total:16,available:10,publicBookings:2,phoneBookings:4,publicRevenue:200000,phoneRevenue:400000}]},rows:[{observation:{key:'id:1',bizItemId:'1',name:'A동',productType:'lodging',total:16,available:10,bookingCount:2,price:100000},source:{date:today,stock:16,bookingCount:2}}],originalRows:[],issues:[]};}
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-collection-'));const store=createInsightStore({file:path.join(dir,'data.sqlite')});t.after(()=>store.close());const c=store.ensure({memberId:'fixture',username:'fixture',role:'b2b'});const cmd=(action,payload)=>({revision:store.get(c.customerId).revision,requestKey:randomUUID(),action,payload});store.update(c.customerId,cmd('add-company',{kind:'competitor',companyId:company.companyId}),catalog);return {store,c,cmd,dir};}
test('normal zero survives; failed zero and unrequested day-use remain unknown; no private fields escape',()=>{
  const e=evidence();e.rows.push({observation:{key:'id:2',name:'정상 0',productType:'lodging',total:0,available:0,bookingCount:0,price:null},source:{stock:0}}, {observation:{key:'id:3',name:'오류 0',productType:'lodging',total:0,available:0,bookingCount:0},source:{stock:0,collectionFailed:true,collectionErrorCode:'TIMEOUT'}}, {observation:{key:'id:4',name:'데이유즈',productType:'dayuse',total:3,bookingCount:0},source:{stock:3}});
  e.run.dayUseMode='inspect';e.run.secret='secret';e.rows[0].source.privateNote='secret';
  const r=projectCollection(company,e);assert.equal(r.rooms,16);assert.equal(r.products[1].days[0].publicBookings,0);assert.equal(r.products[2].days[0].total,null);assert.equal(r.products[2].days[0].status,'error');assert.equal(r.products[3].days[0].total,null);assert.equal(r.products[3].days[0].status,'not_requested');assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('closed sales remain unconfirmed and no public booking is inferred from stock difference',()=>{
  const e=evidence();delete e.rows[0].observation.bookingCount;e.rows[0].source.open=false;const r=projectCollection(company,e);assert.equal(r.products[0].days[0].publicBookings,null);assert.equal(r.products[0].days[0].saleStatus,'closure_unconfirmed');
});
test('no 40-product or 40-room cap is added to customer results',()=>{const e=evidence();e.rows=Array.from({length:65},(_,i)=>({observation:{key:'id:'+i,name:'동'+i,productType:'lodging',total:1},source:{stock:1,date:today}}));const r=projectCollection({...company,rooms:65},e);assert.equal(r.productCount,65);assert.equal(r.rooms,65);});
test('product proposals retain source, target date and history; failed responses cannot be corrected as observed stock',t=>{
  const {store,c,cmd}=setup(t),r=projectCollection(company,evidence());const payload={companyId:company.companyId,baseVersion:r.version,target:{runId:r.runId,productKey:r.products[0].key,date:today},proposed:{total:15},reason:'현장 확인'};
  store.correct(c.customerId,cmd('product-correction',payload),company,r);assert.equal(store.corrections(c.customerId)[0].baseValues.total,16);assert.equal(company.rooms,16);
  assert.throws(()=>store.correct(c.customerId,cmd('product-correction',{...payload,baseVersion:'old'}),company,r),{code:'STALE_COMPANY'});
  const row=store.corrections(c.customerId)[0];assert.throws(()=>store.reviewCorrection(row.requestId,'verified','DB 확인','admin',company,r),{code:'CENTRAL_EDIT_REQUIRED'});
  r.products[0].days[0].total=15;store.reviewCorrection(row.requestId,'verified','DB 일치 확인','admin',company,r);assert.equal(store.corrections(c.customerId)[0].status,'verified');
  r.products[0].days[0].status='error';assert.throws(()=>store.correct(c.customerId,cmd('product-correction',payload),company,r),{code:'RESPONSE_REQUIRED'});
});
test('same-day stored company result is reused without a worker request, including the second customer',async t=>{
  const {store,c,cmd}=setup(t);let submits=0;
  const bridge=createInsightPreparation({store,catalog:async()=>catalog,collectorRequests:{submit:async()=>submits++,get:async()=>{throw Error('unused');}},verifyStored:async()=>true,findReusable:async(id,scope,day)=>{assert.equal(id,company.companyId);assert.equal(day,today);return 'regional_keyword_result';}});
  const payload={companyId:company.companyId,checkIn:today,bookingRangeDays:1,dayUseMode:'inspect'};
  store.preparation(c.customerId,cmd('collect',payload),company);
  await bridge.dispatch(c.customerId,{requestId:store.requests(c.customerId)[0].requestId,...payloadWithoutCompany(payload)},'fixture');
  const second=store.ensure({memberId:'second',username:'second',role:'b2b'});const c2=(action,p)=>({revision:store.get(second.customerId).revision,requestKey:randomUUID(),action,payload:p});store.update(second.customerId,c2('add-company',{kind:'competitor',companyId:company.companyId}),catalog);store.preparation(second.customerId,c2('collect',payload),company);
  await bridge.dispatch(second.customerId,{requestId:store.requests(second.customerId)[0].requestId,...payloadWithoutCompany(payload)},'fixture');
  assert.equal(submits,0);assert.equal(store.requests(second.customerId)[0].runId,'regional_keyword_result');assert.equal(store.requests(second.customerId)[0].status,'ready');
});
function payloadWithoutCompany(p){return {checkIn:p.checkIn,bookingRangeDays:p.bookingRangeDays,dayUseMode:p.dayUseMode};}
test('partial artifacts and error reasons persist; a blocked collector is never automatically retried',async t=>{
  const {store,c,cmd}=setup(t);let submits=0;const bridge=createInsightPreparation({store,catalog:async()=>catalog,collectorRequests:{submit:async()=>submits++,get:async()=>({status:'partial',result:{runId:'partial_run',collectionQuality:{reason:'booking_failed'}}})},verifyStored:async()=>false});
  store.preparation(c.customerId,cmd('prepare-data',{companyId:company.companyId}),company);const p={requestId:store.requests(c.customerId)[0].requestId,checkIn:today,bookingRangeDays:1};await bridge.dispatch(c.customerId,p,'fixture');await bridge.refresh(c.customerId);await bridge.dispatch(c.customerId,p,'fixture');const r=store.requests(c.customerId)[0];assert.equal(submits,1);assert.equal(r.runId,'partial_run');assert.equal(r.errorCode,'booking_failed');assert.equal(r.status,'partial');
});
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
test('real HTTP/BFF collects only registered identities, rejects forged worker/run IDs, and supports administrator customer view',async t=>{
  const {store,c,dir}=setup(t);let submits=0;const adminStore=createInsightAdminStore({file:path.join(dir,'admins.sqlite')});t.after(()=>adminStore.close());
  const serviceToken=randomUUID(),token=store.session(c.customerId);
  const bridge=createInsightPreparation({store,catalog:async()=>catalog,collectorRequests:{submit:async p=>{submits++;assert.equal(p.workerKey,'scheduled');assert.equal(p.keyword,company.name);},get:async()=>({status:'pending'})},verifyStored:async()=>true});
  const handlers=createInsightHttp({store,adminStore,serviceToken,catalog:async()=>catalog,authenticateMember:async()=>({memberId:'fixture',username:'fixture',role:'b2b'}),memberActive:async()=>true,requireAdmin:()=>false,preparationBridge:bridge,collectionResults:{read:async()=>projectCollection(company,evidence())}});
  const back=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://test')));const backend=await listen(back);t.after(()=>{back.closeAllConnections();back.close();});
  const reserve=http.createServer();const origin=await listen(reserve);await new Promise(r=>reserve.close(r));const front=createConnectedServer({origin,backend,serviceToken});await new Promise(r=>front.listen(Number(new URL(origin).port),'127.0.0.1',r));t.after(()=>{front.closeAllConnections();front.close();});
  const cookie='insight_local_session='+token;
  const request=(tail,body)=>fetch(origin+'/api/customer/v1'+tail,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf(token)},...(body?{body:JSON.stringify(body)}:{})});
  let response=await request('/companies/cmp_other/collection');assert.equal(response.status,404);
  response=await request('/companies/cmp_100/collection?runId=secret');assert.equal(response.status,400);
  const send=payload=>request('/commands',{revision:store.get(c.customerId).revision,requestKey:randomUUID(),action:'collect',payload});
  const payload={companyId:company.companyId,checkIn:today,bookingRangeDays:1,dayUseMode:'inspect'};
  response=await send({...payload,workerKey:'web'});assert.equal(response.status,400);assert.equal(submits,0);
  response=await send({...payload,bookingRangeDays:60});assert.equal(response.status,400);assert.equal(store.requests(c.customerId).length,0);
  response=await send(payload);assert.equal(response.status,200);response=await send(payload);assert.equal(response.status,200);assert.equal(submits,1);
  response=await request('/companies/cmp_100/collection');const data=await response.json();assert.equal(data.previousResult,true);assert.equal(data.request.status,'collecting');assert.equal(data.result.rooms,16);
  response=await fetch(origin+'/api/insight-admin/v1/customer-view/companies/cmp_100/collection');assert.equal(response.status,401,'admin route is whitelisted but authenticated');
  const account=adminStore.reserve('fixture-admin','test');await adminStore.activate(account.adminId,'FixtureAdmin2026!','FixtureAdmin2026!','test');
  const auth=await adminStore.login('fixture-admin','FixtureAdmin2026!');
  const ar=(route,body)=>fetch(origin+'/api/insight-admin/v1'+route,{method:body?'POST':'GET',headers:{Cookie:'insight_local_admin='+auth.token,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf(auth.token)},...(body?{body:JSON.stringify(body)}:{})});
  response=await ar('/customer-view/start',{});const preview=await response.json();
  response=await ar('/customer-view/commands',{revision:preview.customer.revision,requestKey:randomUUID(),action:'add-company',payload:{kind:'own',companyId:company.companyId}});assert.equal(response.status,200);
  response=await ar('/customer-view/companies/cmp_100/collection');assert.equal(response.status,200);assert.equal((await response.json()).result.companyId,company.companyId);
  response=await ar('/customer-view/companies/cmp_other/collection');assert.equal(response.status,404);
  response=await request('/commands');assert.equal(response.status,404);
});
