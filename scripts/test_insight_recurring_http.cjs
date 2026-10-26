'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const {createInsightStore,fault}=require('./lib/insight_store.cjs'),{createInsightHttp,csrf,json}=require('./lib/insight_http.cjs'),{createInsightRecurringCollection}=require('./lib/insight_recurring_collection.cjs');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'insight-recurring-http-')),store=createInsightStore({file:path.join(root,'customers.sqlite')}),catalog={companies:[{companyId:'cmp_test',name:'모의 경쟁업체',placeIds:['123']},{companyId:'cmp_foreign',name:'다른 업체',placeIds:['456']}],regions:[]},submits=[];
 const customer=store.ensure({memberId:'synthetic',username:'synthetic',role:'b2b'});store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{companyId:'cmp_test',kind:'competitor'}},catalog);
 const token=store.session(customer.customerId),serviceToken=crypto.randomUUID(),adminToken=crypto.randomUUID(),recurring=createInsightRecurringCollection({dataDir:root,store,catalog:async()=>catalog,collectorRequests:{submit:async payload=>submits.push(payload),get:async()=>{throw Error('no receipt');}},verifyStored:async()=>true,workerKey:'manual',now:()=>Date.parse('2026-10-26T06:00:00Z')});
 const adminStore={authenticate(value){if(value!==adminToken)throw fault('ADMIN_LOGIN_REQUIRED','로그인이 필요합니다.',401);return {adminId:'synthetic-admin',username:'synthetic-admin'};}};
 const requireAdmin=(session,req,res)=>{if(session?.role==='admin')return true;json(res,403,{error:{code:'ADMIN_REQUIRED'}});return false;};
 const handler=createInsightHttp({store,serviceToken,catalog:async()=>catalog,memberActive:async()=>true,adminStore,requireAdmin,recurringCollection:recurring});
 async function request(route,{method='GET',payload,headers={},central=false,session={role:'admin',username:'synthetic-central'}}={}){
  const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);req.method=method;req.headers={'content-type':'application/json',host:'fixture.invalid',origin:'http://fixture.invalid',authorization:'Bearer '+serviceToken,'x-insight-session':token,'x-csrf-token':csrf(token),...headers};
  const res={setHeader(){},writeHead(status){this.status=status;},end(text){this.data=JSON.parse(text);}};const url=new URL((central?'/api/admin/insight-customers':'/api/insight/v1')+route,'http://fixture.invalid');
  const accepted=central?await handler.admin(req,res,url,session):await handler.internal(req,res,url);assert.equal(accepted,true);return {status:res.status,data:res.data};
 }
 t.after(async()=>{await recurring.close();store.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('insight-recurring-http-'));fs.rmSync(root,{recursive:true,force:true});});
 return {store,customer,request,submits,token,serviceToken,adminToken,recurring};
}
test('customer request and bootstrap expose an approval request without dispatching collection',async t=>{
 const f=fixture(t);let reply=await f.request('/companies/cmp_test/recurring-collection');assert.equal(reply.status,200);assert.equal(reply.data.recurringCollection,null);
 reply=await f.request('/companies/cmp_test/recurring-collection',{method:'POST',payload:{requestKey:'request-key-1'}});assert.equal(reply.status,200);assert.equal(reply.data.recurringCollection.status,'pending');assert.equal(reply.data.recurringCollections.length,1);
 const me=await f.request('/me');assert.equal(me.data.features.recurringCollectionRequests,true);assert.equal(me.data.recurringCollections[0].companyId,'cmp_test');assert.equal(f.submits.length,0);assert.doesNotMatch(JSON.stringify(reply.data),/placeIds|serviceToken|password|actor/);
});
test('customer session, service identity, CSRF, relation and allowlisted inputs are enforced before mutation',async t=>{
 const f=fixture(t),route='/companies/cmp_test/recurring-collection';
 for(const [headers,status]of[[{authorization:'Bearer wrong'},401],[{'x-insight-session':'wrong'},401],[{'x-csrf-token':'wrong'},403]])assert.equal((await f.request(route,{method:'POST',payload:{requestKey:'request-key-1'},headers})).status,status);
 assert.equal((await f.request('/companies/cmp_foreign/recurring-collection',{method:'POST',payload:{requestKey:'request-key-1'}})).status,404);
 for(const payload of [{requestKey:'request-key-1',workerKey:'web'},{requestKey:'request-key-1',time:'10:00'},{requestKey:'request-key-1',companyId:'cmp_foreign'}])assert.equal((await f.request(route,{method:'POST',payload})).status,400);
 assert.equal((await f.request(route+'?workerKey=web')).status,400);assert.equal(f.recurring.adminList().length,0);assert.equal(f.submits.length,0);
});
test('central administrator route wins over customer-id matching and approval schedules tomorrow rather than immediate execution',async t=>{
 const f=fixture(t);await f.request('/companies/cmp_test/recurring-collection',{method:'POST',payload:{requestKey:'request-key-1'}});
 let reply=await f.request('/recurring-collections',{central:true});assert.equal(reply.status,200);assert.equal(reply.data.recurringCollections.length,1);assert.deepEqual(reply.data.defaults,{time:'14:00',bookingRangeDays:30,timezone:'Asia/Seoul'});
 const payload={companyId:'cmp_test',decision:'approve',reason:'모의 승인',requestKey:'approve-key-1'};
 assert.equal((await f.request('/recurring-collections/review',{central:true,method:'POST',payload,headers:{origin:'https://foreign.invalid'}})).status,403);
 assert.equal((await f.request('/recurring-collections/review',{central:true,method:'POST',payload,session:{role:'b2b'}})).status,403);
 reply=await f.request('/recurring-collections/review',{central:true,method:'POST',payload});assert.equal(reply.status,200);assert.equal(reply.data.recurringCollection.status,'approved');assert.equal(reply.data.recurringCollection.startsOn,'2026-10-27');assert.equal(reply.data.recurringCollection.nextRunAt,'2026-10-27T05:00:00.000Z');assert.equal(f.submits.length,0);
});
test('Insight administrator review is isolated from customer credentials and requires admin CSRF',async t=>{
 const f=fixture(t);await f.request('/companies/cmp_test/recurring-collection',{method:'POST',payload:{requestKey:'request-key-1'}});
 assert.equal((await f.request('/admin/recurring-collections')).status,401);
 const headers={'x-insight-admin-session':f.adminToken,'x-csrf-token':csrf(f.adminToken)},payload={companyId:'cmp_test',decision:'reject',reason:'모의 검수',requestKey:'reject-key-1'};
 assert.equal((await f.request('/admin/recurring-collections', {headers})).status,200);
 assert.equal((await f.request('/admin/recurring-collections/review',{method:'POST',payload,headers:{...headers,'x-csrf-token':'wrong'}})).status,403);
 const reply=await f.request('/admin/recurring-collections/review',{method:'POST',payload,headers});assert.equal(reply.status,200);assert.equal(reply.data.recurringCollection.status,'rejected');assert.equal(reply.data.recurringCollections.length,1);assert.equal(f.submits.length,0);
});
