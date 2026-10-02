'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomUUID}=require('node:crypto');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightAnalysis,buildBriefing,projectRegion}=require('./lib/insight_analysis.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const {createConnectedServer}=require('../customer-portal/connected-server.cjs');
const companies=Array.from({length:7},(_,i)=>({companyId:`c${i}`,name:`검수 업체 ${i}`,rooms:10,regionKey:`r${i%2}`,placeIds:[String(i+100)]}));
const regions=Array.from({length:3},(_,i)=>({id:`r${i}`,label:`검수 지역 ${i}`,level:'local'})),catalog={companies,regions};
const day=(date,sold,extra={})=>({date,total:10,sold,publicBookings:sold,phoneBookings:0,estimatedRevenue:sold*100000,collectedAt:'2026-10-02T01:00:00Z',...extra});
const days=sold=>Array.from({length:10},(_,i)=>day(`2026-10-${String(i+2).padStart(2,'0')}`,sold));
function setup(t){const store=createInsightStore({file:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'insight-analysis-')),'test.sqlite')});t.after(()=>store.close());const customer=store.ensure({memberId:'ordinary',username:'ordinary',role:'b2b'});const cmd=(c,action,payload)=>({revision:store.get(c.customerId).revision,requestKey:randomUUID(),action,payload});return {store,customer,cmd};}
test('admin registration quantities are unlimited, ordinary limits and duplicate protection stay enforced',t=>{
  const {store,customer,cmd}=setup(t),admin=store.ensure({memberId:'insight-admin:test',username:'admin',role:'b2b',accountKind:'admin_preview'});
  for(let i=0;i<7;i++)store.update(admin.customerId,cmd(admin,'add-company',{kind:i<2?'own':'competitor',companyId:`c${i}`}),catalog);
  for(const r of regions)store.update(admin.customerId,cmd(admin,'add-region',{regionKey:r.id}),catalog);
  assert.equal(store.get(admin.customerId).relations.length,7);assert.equal(store.get(admin.customerId).regions.length,3);
  assert.equal(store.collectionAllowance(admin.customerId).limit,null);
  assert.throws(()=>store.update(admin.customerId,cmd(admin,'add-company',{kind:'own',companyId:'c0'}),catalog),{code:'DUPLICATE_COMPANY'});
  assert.throws(()=>store.adminUpdate(admin.customerId,cmd(admin,'entitlements',{competitorLimit:0,interestRegionLimit:0,reason:'test'}),'admin',catalog),{code:'ADMIN_UNLIMITED'});
  for(let i=0;i<3;i++)store.update(customer.customerId,cmd(customer,'add-company',{kind:'competitor',companyId:`c${i}`}),catalog);
  assert.throws(()=>store.update(customer.customerId,cmd(customer,'add-company',{kind:'competitor',companyId:'c3'}),catalog),{code:'COMPETITOR_LIMIT'});
  store.update(customer.customerId,cmd(customer,'add-region',{regionKey:'r0'}),catalog);
  assert.throws(()=>store.update(customer.customerId,cmd(customer,'add-region',{regionKey:'r1'}),catalog),{code:'REGION_LIMIT'});
});
test('region projection retains observed zero, source periods and safe URLs, never private fields or failed zeros',()=>{
  const r=projectRegion(regions[0],'2026-09',{networkAttempted:false,secret:'private',sources:[{key:'population',period:'2025',periodType:'Y',sourceUrl:'javascript:alert(1)',rows:[{label:'정상',status:'observed',value:0},{label:'오류',status:'missing',value:0,private:'secret'}]}]},{regionKey:'r1',interpretation:'wrong region'});
  assert.equal(r.location,null);assert.equal(r.sources[0].sourceUrl,null);assert.equal(r.sources[0].period,'2025');assert.equal(r.sources[0].rows[0].value,0);assert.equal(r.sources[0].rows[1].value,null);assert.equal(JSON.stringify(r).includes('private'),false);
  assert.throws(()=>projectRegion(regions[0],'2026-09',{networkAttempted:true}),{code:'READ_ONLY_SOURCE_REQUIRED'});
});
test('briefing compares matching stay dates and observation dates only and shows evidence before actions',()=>{
  const own={...companies[0],kind:'own',relationStatus:'active',days:days(2)},other={...companies[1],kind:'competitor',days:days(4)};
  const r=buildBriefing([own,other],[],{today:'2026-10-02',ownId:'c0'});
  assert.equal(r.comparisons[0].commonDays,10);assert.equal(r.comparisons[0].gapPp,-20);assert.ok(r.actions.some(a=>a.key==='compare'));assert.equal(r.published,false);
  other.days[0].collectedAt='2026-10-01T01:00:00Z';other.days[1].partial=true;other.days[2].missing=true;other.days[3].total=0;
  const limited=buildBriefing([own,other],[],{today:'2026-10-02',ownId:'c0'});assert.equal(limited.comparisons[0].commonDays,6);assert.ok(!limited.actions.some(a=>a.key==='compare'));assert.ok(limited.actions.some(a=>a.key==='comparison_data'));
  assert.equal(limited.companies[0].days,undefined,'raw days remain behind company evidence view');
});
test('partial prices and stale observations do not become complete revenue or a current action signal',()=>{
  const own={...companies[0],kind:'own',days:days(0)},other={...companies[1],kind:'competitor',days:days(4)};
  own.days[0].revenuePartial=true;
  own.days[1].inventoryConflict=true;
  for(const d of other.days)d.collectedAt='2026-09-01T01:00:00Z';
  const r=buildBriefing([own,other],[],{today:'2026-10-02',ownId:'c0'});
  assert.equal(r.companies[0].summary.days,9);
  assert.equal(r.companies[0].summary.publicBookings,0);
  assert.equal(r.companies[0].summary.estimatedRevenue,null);
  assert.equal(r.comparisons[0].commonDays,0);
  assert.equal(r.comparisons[0].gapPp,null);
  assert.ok(!r.actions.some(a=>a.key==='compare'));
});
test('briefing includes only selected own location and explicit interests for multi-property admins',async()=>{
  const customer={relations:[{kind:'own',companyId:'c0',status:'active'},{kind:'own',companyId:'c1',status:'active'}],regions:[{regionKey:'r2',status:'active'}]};
  const reads=[];
  const service=createInsightAnalysis({catalog:async()=>catalog,now:()=>Date.parse('2026-10-02T00:00:00Z'),collectionResults:{companyDetail:async()=>({current:{daily:[]}})},readRegionContext:async r=>{reads.push(r.targetId);return {sources:[]};}});
  const r=await service.briefing(customer,'c0');
  assert.deepEqual(r.companies.map(c=>c.companyId),['c0']);
  assert.deepEqual(reads,['r2','r0']);
  assert.equal((await service.region(customer,'r1')).region.id,'r1','all registered own locations remain accessible in regional analysis');
});
test('authenticated BFF limits region and briefing reads to registered identities with no dispatch',async t=>{
  const {store,customer,cmd}=setup(t);store.update(customer.customerId,cmd(customer,'add-region',{regionKey:'r0'}),catalog);store.update(customer.customerId,cmd(customer,'add-company',{kind:'own',companyId:'c0'}),catalog);
  let reads=0;
  const analysis=createInsightAnalysis({catalog:async()=>catalog,collectionResults:{companyDetail:async()=>({current:{daily:days(2)}})},now:()=>Date.parse('2026-10-02T02:00:00Z'),readRegionContext:async(req)=>{reads++;assert.equal(req.targetId,'r0');return {sources:[{key:'test',label:'저장 지표',status:'ready',period:req.month,rows:[{status:'observed',value:100}]}],networkAttempted:false};}});
  const serviceToken='fixture-service-token-only-32-characters',h=createInsightHttp({store,serviceToken,authenticateMember:async()=>({memberId:'ordinary',username:'ordinary',role:'b2b'}),memberActive:async()=>true,catalog:async()=>catalog,requireAdmin:()=>false,analysis});
  const backend=http.createServer((req,res)=>h.internal(req,res,new URL(req.url,'http://local')));
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>backend.close());
  const front=createConnectedServer({origin:'http://127.0.0.1:57991',backend:`http://127.0.0.1:${backend.address().port}`,serviceToken});
  await new Promise(r=>front.listen(0,'127.0.0.1',r));t.after(()=>front.close());
  // Use native HTTP so the fixture can bind any free port while testing the declared Host/Origin.
  const request=(route,body,cookie)=>new Promise((resolve,reject)=>{const q=http.request({host:'127.0.0.1',port:front.address().port,path:'/api/customer/v1'+route,method:body?'POST':'GET',headers:{Host:'127.0.0.1:57991',Origin:'http://127.0.0.1:57991','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text),cookie:res.headers['set-cookie']?.[0].split(';')[0]}));});q.on('error',reject);q.end(body?JSON.stringify(body):undefined);});
  const auth=await request('/auth/login',{username:'ordinary',password:'fixture-password'}),cookie=auth.cookie;assert.equal(auth.status,200);
  const r=await request('/regions/r0/analysis?month=2026-09',null,cookie);assert.equal(r.status,200);assert.equal(r.data.region.id,'r0');assert.equal(r.data.month,'2026-09');
  assert.equal((await request('/regions/r1/analysis?month=2026-09',null,cookie)).status,404);
  assert.equal((await request('/regions/r0/analysis?month=2026-13',null,cookie)).status,400);
  assert.equal((await request('/regions/r0/analysis?force=true',null,cookie)).status,400);
  assert.equal((await request('/reports/briefing?ownId=c1',null,cookie)).status,404);
  const report=await request('/reports/briefing?ownId=c0',null,cookie);assert.equal(report.status,200);assert.deepEqual(report.data.companies.map(c=>c.companyId),['c0']);assert.equal(report.data.actions.some(a=>a.key==='verify'),true);
  assert.equal((await request('/reports/briefing')).status,401);assert.equal(reads,2);assert.equal(store.requests(customer.customerId).length,0);
});
