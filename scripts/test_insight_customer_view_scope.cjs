'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createInsightStore,fault}=require('./lib/insight_store.cjs');
const {createInsightHttp,csrf}=require('./lib/insight_http.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'insight-customer-view-scope-')),store=createInsightStore({file:path.join(directory,'customers.sqlite')});
 const serviceToken='fixture-customer-view-service-token-not-a-secret',adminToken='A'.repeat(43),otherAdminToken='B'.repeat(43);
 const validity={admin:true,members:true},calls={region:[],briefing:[],collection:[],dispatch:0,recurring:0,publication:0};
 const data={companies:[{companyId:'cmp_own_a',name:'Actual A',regionKey:'region_a',placeIds:['101']},{companyId:'cmp_own_b',name:'Actual B',regionKey:'region_b',placeIds:['102']},{companyId:'cmp_shared',name:'Shared company',regionKey:'region_shared',placeIds:['103']}],
  regions:[{id:'region_a',label:'Region A',level:'local'},{id:'region_b',label:'Region B',level:'local'},{id:'region_shared',label:'Shared region',level:'local'}]};
 function seed(member,own){let c=store.ensure(member);for(const [kind,companyId]of[['own',own],['competitor','cmp_shared']])c=store.update(c.customerId,{revision:c.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind,companyId}},data);return c;}
 const a=seed({memberId:'actual_member_a',username:'actual-a',role:'b2b'},'cmp_own_a'),b=seed({memberId:'actual_member_b',username:'actual-b',role:'b2b'},'cmp_own_b');
 const preview=seed({memberId:'insight-admin:admin_a',username:'admin-a',role:'b2b',accountKind:'admin_preview'},'cmp_own_a');
 const otherPreview=store.ensure({memberId:'insight-admin:admin_b',username:'admin-b',role:'b2b',accountKind:'admin_preview'});
 const normalToken=store.session(a.customerId),gates={catalog:null,region:null,briefing:null,collection:null,pdf:null};
 const adminStore={authenticate(token){if(!validity.admin||![adminToken,otherAdminToken].includes(token))throw fault('ADMIN_LOGIN_REQUIRED','Expired fixture admin',401);return {adminId:token===adminToken?'admin_a':'admin_b',username:token===adminToken?'admin-a':'admin-b'};}};
 const handler=createInsightHttp({store,serviceToken,catalog:async()=>{if(gates.catalog)await gates.catalog.promise;return clone(data);},adminStore,memberActive:async()=>validity.members,
  recurringCollection:{forCustomer:()=>[],get:()=>null,request:async()=>{calls.recurring++;return {};},adminState:()=>({requests:[],defaults:{time:'14:00',bookingRangeDays:30,timezone:'Asia/Seoul'}}),adminList:()=>[]},
  preparationBridge:{refresh:async()=>{},dispatch:async()=>{calls.dispatch++;}},
  collectionResults:{readView:async(companyId,{month})=>{calls.collection.push(companyId);if(gates.collection)await gates.collection.promise;return {companyDetail:{companyId,integrated:{status:'ready',selectedMonth:month||'2026-10'}},result:{companyId,runId:'run_'+companyId}};}},
  analysis:{region:async(c,regionKey,month)=>{calls.region.push(c.customerId);if(gates.region)await gates.region.promise;return {customerId:c.customerId,regionKey,month};},
   briefing:async(c,ownId,selection)=>{calls.briefing.push(c.customerId);if(gates.briefing)await gates.briefing.promise;return {customerId:c.customerId,ownId,selection};},
   preparation:async()=>{calls.dispatch++;return {status:'queued'};}},
  reportDelivery:{list:async(customerId,{verifyAccess})=>{await verifyAccess();return {reports:[{reportId:'mr_scope_fixture',customerId}]};},
   detail:async(customerId,id,{verifyAccess})=>{await verifyAccess();return {report:{id,customerId}};},
   authorizedReport:async(customerId,id,{verifyAccess})=>{await verifyAccess();return {id,customerId,month:'2026-09',version:1};}},
  renderReportPdf:async report=>{if(gates.pdf)await gates.pdf.promise;return Buffer.from('%PDF-1.7\n'+report.customerId);},companyDiagnostics:()=>{},identityDiagnostics:()=>{}});
 async function request(route,{method='GET',payload,target,admin=true,token=adminToken,service=serviceToken,extraHeaders={}}={}){
  const headers={host:'fixture.invalid',origin:'http://fixture.invalid',authorization:'Bearer '+service,'content-type':'application/json',...(admin?{'x-insight-admin-session':token}:{'x-insight-session':normalToken}),'x-csrf-token':csrf(admin?token:normalToken),...(target===undefined?{}:{'x-insight-customer-id':target}),...extraHeaders};
  const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);Object.assign(req,{method,headers});
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,values={}){this.status=status;Object.assign(this.headers,values);},end(value){this.raw=Buffer.from(value||'');}};
  const matched=await handler.internal(req,res,new URL('/api/insight/v1'+(admin?'/admin/customer-view':'')+route,'http://fixture.invalid'));assert.equal(matched,true);
  let value;try{value=JSON.parse(res.raw.toString());}catch{value=res.raw.toString();}return {status:res.status,data:value,headers:res.headers};
 }
 t.after(()=>{store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
 return {store,a,b,preview,otherPreview,request,validity,gates,calls,adminToken,normalToken,data};
}
test('administrator selects two actual customer identities without start, revision changes or preview creation',async t=>{
 const f=fixture(t),before=f.store.list().map(c=>[c.customerId,c.revision,f.store.history(c.customerId).length]);
 const [a,b]=await Promise.all([f.request('/me',{target:f.a.customerId}),f.request('/me',{target:f.b.customerId})]);
 assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.customer.customerId,f.a.customerId);assert.equal(b.data.customer.customerId,f.b.customerId);
 assert.deepEqual(a.data.view,{mode:'admin_customer',adminUsername:'admin-a',readOnly:true,customerId:f.a.customerId,customerUsername:'actual-a'});
 assert.deepEqual(b.data.view,{mode:'admin_customer',adminUsername:'admin-a',readOnly:true,customerId:f.b.customerId,customerUsername:'actual-b'});
 assert.deepEqual(a.data.companies.map(c=>c.companyId).sort(),['cmp_own_a','cmp_shared']);assert.deepEqual(b.data.companies.map(c=>c.companyId).sort(),['cmp_own_b','cmp_shared']);
 assert.deepEqual(f.store.list().map(c=>[c.customerId,c.revision,f.store.history(c.customerId).length]),before);
});
test('selected company, region and report readers use the actual customer scope',async t=>{
 const f=fixture(t);
 for(const c of[f.a,f.b]){
  const companyId=c===f.a?'cmp_own_a':'cmp_own_b',regionKey=c===f.a?'region_a':'region_b';
  const company=await f.request('/companies/'+companyId+'/collection?month=2026-09',{target:c.customerId});assert.equal(company.status,200);assert.equal(company.data.result.companyId,companyId);
  assert.equal((await f.request('/companies/'+(c===f.a?'cmp_own_b':'cmp_own_a')+'/collection?month=2026-09',{target:c.customerId})).status,404);
  const region=await f.request('/regions/'+regionKey+'/analysis?month=2026-09',{target:c.customerId});assert.equal(region.status,200);assert.equal(region.data.customerId,c.customerId);
  const briefing=await f.request('/reports/briefing?stayMode=all_available',{target:c.customerId});assert.equal(briefing.status,200);assert.equal(briefing.data.customerId,c.customerId);
  const reports=await f.request('/reports',{target:c.customerId});assert.equal(reports.status,200);assert.equal(reports.data.reports[0].customerId,c.customerId);
  const pdf=await f.request('/reports/mr_scope_fixture/pdf',{target:c.customerId});assert.equal(pdf.status,200);assert.ok(pdf.data.startsWith('%PDF-'));assert.ok(pdf.data.includes(c.customerId));
 }
});
test('every selected-customer POST is denied before commands, collection, preparation or publication',async t=>{
 const f=fixture(t),before=clone(f.store.get(f.a.customerId)),routes=['/start','/commands','/regions/region_a/preparation','/companies/cmp_shared/recurring-collection','/archives/reviews','/archives/reports','/auth/logout','/unknown-mutation'];
 for(const route of routes){const value=await f.request(route,{target:f.a.customerId,method:'POST',payload:{action:'collect'}});assert.equal(value.status,403,route);assert.equal(value.data.error.code,'CUSTOMER_VIEW_READ_ONLY',route);}
 assert.deepEqual(f.store.get(f.a.customerId),before);assert.equal(f.calls.dispatch,0);assert.equal(f.calls.recurring,0);assert.equal(f.calls.publication,0);
});
test('target syntax, unknown users and all admin-preview targets fail closed',async t=>{
 const f=fixture(t);
 for(const target of['bad/id',' ../cus_other','', ['cus_a','cus_b']])assert.equal((await f.request('/me',{target})).status,400,String(target));
 assert.equal((await f.request('/me',{target:'cus_00000000-0000-0000-0000-000000000000'})).status,404);
 for(const target of[f.preview.customerId,f.otherPreview.customerId])assert.equal((await f.request('/me',{target})).status,403);
});
test('customer and service credentials cannot impersonate an administrator target',async t=>{
 const f=fixture(t);assert.equal((await f.request('/me',{target:f.b.customerId,token:f.normalToken})).status,401);
 assert.equal((await f.request('/me',{target:f.b.customerId,service:'wrong'})).status,401);
 const normal=await f.request('/me',{admin:false,target:f.b.customerId});assert.ok([200,400,403].includes(normal.status));if(normal.status===200){assert.equal(normal.data.customer.customerId,f.a.customerId);assert.ok(!JSON.stringify(normal.data.companies).includes('cmp_own_b'));}
});
test('without a target administrator preview remains writable and isolated from actual customers',async t=>{
 const f=fixture(t);const before=f.store.get(f.a.customerId).revision,started=await f.request('/start',{method:'POST',payload:{}});assert.equal(started.status,200);assert.equal(started.data.customer.customerId,f.preview.customerId);
 const changed=await f.request('/commands',{method:'POST',payload:{revision:started.data.customer.revision,requestKey:crypto.randomUUID(),action:'settings',payload:{companyId:'cmp_own_a',nickname:'Preview only',note:''}}});
 assert.equal(changed.status,200);assert.equal(changed.data.customer.settings.cmp_own_a.nickname,'Preview only');assert.equal(f.store.get(f.a.customerId).revision,before);
});
test('expired administrator session never returns a selected customer or previously loaded collection',async t=>{
 const f=fixture(t);assert.equal((await f.request('/companies/cmp_shared/collection?month=2026-09',{target:f.a.customerId})).status,200);f.validity.admin=false;
 for(const route of['/me','/companies/cmp_shared/collection?month=2026-09','/regions/region_a/analysis','/reports/briefing','/reports/mr_scope_fixture/pdf']){const value=await f.request(route,{target:f.a.customerId});assert.equal(value.status,401,route);assert.equal(value.data.customer,undefined);assert.equal(value.data.companyDetail,undefined);}
});
for(const domain of['catalog','collection','region','briefing','pdf'])test('administrator revocation while '+domain+' is reading blocks the late private result',async t=>{
 const f=fixture(t),gate=deferred();f.gates[domain]=gate;
 const route={catalog:'/me',collection:'/companies/cmp_shared/collection?month=2026-09',region:'/regions/region_a/analysis',briefing:'/reports/briefing',pdf:'/reports/mr_scope_fixture/pdf'}[domain];
 const pending=f.request(route,{target:f.a.customerId});await new Promise(resolve=>setImmediate(resolve));f.validity.admin=false;gate.resolve();const value=await pending;
 assert.equal(value.status,401);assert.equal(value.data.customerId,undefined);assert.equal(value.data.companyDetail,undefined);assert.equal(typeof value.data,'object');
});
test('disabled selected account is rejected and does not become an administrator preview',async t=>{
 const f=fixture(t);f.store.adminUpdate(f.a.customerId,{revision:f.store.get(f.a.customerId).revision,requestKey:crypto.randomUUID(),action:'account-status',payload:{status:'disabled',reason:'fixture disabled'}},'fixture-admin');
 const value=await f.request('/me',{target:f.a.customerId});assert.equal(value.status,403);assert.equal(value.data.customer,undefined);
});
test('actual customer member revocation and admin-prefixed forged customer targets fail closed',async t=>{
 const f=fixture(t);f.validity.members=false;const disabled=await f.request('/me',{target:f.a.customerId});assert.equal(disabled.status,403);assert.equal(disabled.data.customer,undefined);
 f.validity.members=true;const forged=f.store.ensure({memberId:'insight-admin:forged-with-normal-kind',username:'forged-fixture',role:'b2b'});assert.equal(forged.accountKind,'customer');
 assert.equal((await f.request('/me',{target:forged.customerId})).status,403);
});
for(const domain of['collection','region','briefing'])test('registered access changes during '+domain+' reading reject the stale targeted result',async t=>{
 const f=fixture(t),gate=deferred();f.gates[domain]=gate;
 const route={collection:'/companies/cmp_shared/collection?month=2026-09',region:'/regions/region_a/analysis',briefing:'/reports/briefing'}[domain];
 const pending=f.request(route,{target:f.a.customerId});await new Promise(resolve=>setImmediate(resolve));const current=f.store.get(f.a.customerId);
 f.store.update(f.a.customerId,{revision:current.revision,requestKey:crypto.randomUUID(),action:'archive-company',payload:{relationId:current.relations.find(row=>row.companyId==='cmp_shared').relationId}},f.data);
 gate.resolve();const reply=await pending;assert.equal(reply.status,409);assert.equal(reply.data.companyDetail,undefined);assert.equal(reply.data.customerId,undefined);
});
test('interest region removal while regional data is reading rejects the previous target boundary',async t=>{
 const f=fixture(t);let customer=f.store.get(f.a.customerId);customer=f.store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-region',payload:{regionKey:'region_shared'}},f.data);
 const gate=deferred();f.gates.region=gate;const pending=f.request('/regions/region_shared/analysis',{target:f.a.customerId});await new Promise(resolve=>setImmediate(resolve));
 f.store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'archive-region',payload:{relationId:customer.regions.find(row=>row.regionKey==='region_shared').relationId}},f.data);
 gate.resolve();const reply=await pending;assert.equal(reply.status,409);assert.equal(reply.data.customerId,undefined);assert.equal(reply.data.regionKey,undefined);
});
