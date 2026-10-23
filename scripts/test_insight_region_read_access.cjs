'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomBytes,randomUUID}=require('node:crypto');
const {createInsightAnalysis,regionIds,readableRegionIds}=require('./lib/insight_analysis.cjs');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const {createInsightAdminStore}=require('./lib/insight_admin_store.cjs');
const {createConnectedServer}=require('../customer-portal/connected-server.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const catalog={companies:[
  {companyId:'cmp-own',name:'같은 표시 이름',regionKey:'r-home',rooms:16},
  {companyId:'cmp-competitor',name:'같은 표시 이름',regionKey:'r-other',rooms:10},
  {companyId:'cmp-no-region',name:'주소만 있는 업체',address:'r-home',regionKey:''},
  {companyId:'cmp-broad',name:'광역만 확인된 업체',regionKey:'r-broad'}
],regions:[{id:'r-home',label:'내 매장 소재지',level:'local'},{id:'r-other',label:'다른 지역',level:'local'},{id:'r-interest',label:'관심지역',level:'local'},{id:'r-broad',label:'광역',level:'broad'}]};
const owner=(status='pending')=>({relations:[{companyId:'cmp-own',kind:'own',status}],regions:[]});
function service() {
  const reads=[],preparations=[];
  const analysis=createInsightAnalysis({catalog:async()=>catalog,now:()=>Date.parse('2026-10-23T00:00:00Z'),
    readRegionContext:async request=>{reads.push(clone(request));return {sources:[{key:'visitors',label:'저장 지표',rows:[{key:'count',status:'observed',value:0}]}],networkAttempted:false};},
    regionPreparation:{get:async input=>{preparations.push({method:'get',input});return null;},start:async input=>{preparations.push({method:'start',input});return {id:'fixture-preparation',status:'queued'};}}
  });
  return {analysis,reads,preparations};
}

test('pending own location has read permission without ownership approval or preparation permission',async()=>{
  const customer=owner(),before=clone(customer),s=service();
  assert.deepEqual([...regionIds(customer,catalog)],[]);
  assert.deepEqual([...readableRegionIds(customer,catalog)],['r-home']);
  const result=await s.analysis.region(customer,'r-home','2026-09');
  assert.equal(result.region.id,'r-home');assert.equal(result.refreshAvailable,false);assert.equal(result.sources[0].rows[0].value,0);
  await assert.rejects(s.analysis.preparation(customer,'r-home','2026-09'),{code:'NOT_FOUND',statusCode:404});
  await assert.rejects(s.analysis.preparation(customer,'r-home','2026-09',true),{code:'NOT_FOUND',statusCode:404});
  assert.equal(s.preparations.length,0);assert.equal(s.reads.length,1);assert.deepEqual(customer,before);
});

test('competitors, removed relations, unknown company IDs and broad/address guesses cannot grant regional access',async()=>{
  for(const relations of [
    [{companyId:'cmp-competitor',kind:'competitor',status:'pending'}],
    [{companyId:'cmp-competitor',kind:'competitor',status:'active'}],
    [{companyId:'cmp-own',kind:'own',status:'archived'}],
    [{companyId:'cmp-own',kind:'own',status:'rejected'}],
    [{companyId:'cmp-missing',kind:'own',status:'pending'}],
    [{companyId:'cmp-no-region',kind:'own',status:'pending'}],
    [{companyId:'cmp-broad',kind:'own',status:'pending'}]
  ]){
    const customer={relations,regions:[]},s=service();
    assert.deepEqual([...readableRegionIds(customer,catalog)],[]);
    for(const region of ['r-home','r-other','r-broad'])await assert.rejects(s.analysis.region(customer,region,'2026-09'),{statusCode:404});
    assert.equal(s.reads.length,0);
  }
});

test('an exact company region is read while a same-name competitor region remains inaccessible',async()=>{
  const customer={relations:[...owner().relations,{companyId:'cmp-competitor',kind:'competitor',status:'active'}],regions:[]},s=service();
  assert.deepEqual([...readableRegionIds(customer,catalog)],['r-home']);
  assert.equal((await s.analysis.region(customer,'r-home','2026-09')).region.id,'r-home');
  await assert.rejects(s.analysis.region(customer,'r-other','2026-09'),{statusCode:404});
  customer.relations[0].status='archived';
  await assert.rejects(s.analysis.region(customer,'r-home','2026-09'),{statusCode:404});
  assert.deepEqual(s.reads.map(row=>row.targetId),['r-home']);
});

test('verified own and separately registered interest locations retain their existing preparation rights',async()=>{
  for(const customer of [owner('active'),{relations:owner().relations,regions:[{regionKey:'r-home',status:'active'}]}]){
    const s=service();assert.equal((await s.analysis.region(customer,'r-home','2026-09')).refreshAvailable,true);
    await s.analysis.preparation(customer,'r-home','2026-09');await s.analysis.preparation(customer,'r-home','2026-09',true);
    assert.deepEqual(s.preparations.map(row=>row.method),['get','start']);
  }
});

test('read permission does not widen the briefing selected-own-location scope',async()=>{
  const s=service();const result=await s.analysis.briefing(owner(),'cmp-own');
  assert.deepEqual(result.regions,[]);assert.equal(s.reads.length,0);assert.equal(s.preparations.length,0);
});

async function httpFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-region-read-'));
  const store=createInsightStore({file:path.join(dir,'customers.sqlite')}),adminStore=createInsightAdminStore({file:path.join(dir,'admins.sqlite')});
  t.after(()=>{store.close();adminStore.close();});
  const customer=store.ensure({memberId:'fixture-member',username:'fixture-member',role:'b2b'});
  const command=(customerId,action,payload)=>({revision:store.get(customerId).revision,requestKey:randomUUID(),action,payload});
  store.update(customer.customerId,command(customer.customerId,'add-company',{kind:'own',companyId:'cmp-own'}),catalog);
  const s=service(),token=randomBytes(32).toString('hex');
  const handlers=createInsightHttp({store,adminStore,serviceToken:token,authenticateMember:async()=>({memberId:'fixture-member',username:'fixture-member',role:'b2b'}),memberActive:async()=>true,catalog:async()=>catalog,requireAdmin:()=>false,analysis:s.analysis});
  const back=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://local')));
  await new Promise(resolve=>back.listen(0,'127.0.0.1',resolve));t.after(()=>{back.closeAllConnections();back.close();});
  const front=createConnectedServer({origin:'http://127.0.0.1:57991',backend:`http://127.0.0.1:${back.address().port}`,serviceToken:token});
  await new Promise(resolve=>front.listen(0,'127.0.0.1',resolve));t.after(()=>{front.closeAllConnections();front.close();});
  const request=(tail,payload,cookie='',csrf='',admin=false)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:front.address().port,path:(admin?'/api/insight-admin/v1':'/api/customer/v1')+tail,method:payload?'POST':'GET',headers:{Host:'127.0.0.1:57991',Origin:'http://127.0.0.1:57991','Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8')),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]||''}));
    });req.on('error',reject);req.end(payload?JSON.stringify(payload):undefined);
  });
  return {...s,store,adminStore,customer,command,request};
}

test('authenticated state includes pending own region without using an interest slot or enabling refresh',async t=>{
  const f=await httpFixture(t),before=f.store.get(f.customer.customerId);
  const login=await f.request('/auth/login',{username:'fixture-member',password:'fixture-password'});assert.equal(login.status,200);
  const state=await f.request('/me',null,login.cookie);assert.equal(state.status,200);assert.deepEqual(state.data.regions.map(row=>row.id),['r-home']);
  assert.equal(state.data.customer.relations[0].status,'pending');assert.deepEqual(state.data.customer.regions,[]);
  assert.equal(state.data.registrationAllowance.interestRegionLimit,1);
  assert.equal((await f.request('/regions/r-home/analysis?month=2026-09',null,login.cookie)).data.refreshAvailable,false);
  assert.equal((await f.request('/regions/r-home/preparation?month=2026-09',null,login.cookie)).status,404);
  assert.equal((await f.request('/regions/r-home/preparation',{month:'2026-09'},login.cookie,login.data.csrfToken)).status,404);
  assert.equal((await f.request('/regions/r-other/analysis?month=2026-09',null,login.cookie)).status,404);
  assert.equal((await f.request('/regions/r-home/analysis?month=2026-09')).status,401);
  assert.equal(f.preparations.length,0);assert.deepEqual(f.store.get(f.customer.customerId),before);
  const relationId=before.relations[0].relationId;
  f.store.update(before.customerId,f.command(before.customerId,'archive-company',{relationId}),catalog);
  assert.deepEqual((await f.request('/me',null,login.cookie)).data.regions,[]);
  assert.equal((await f.request('/regions/r-home/analysis?month=2026-09',null,login.cookie)).status,404);
});

test('administrator preview reads its own pending location under the same no-refresh rule',async t=>{
  const f=await httpFixture(t),account=f.adminStore.reserve('fixture-admin','fixture');
  await f.adminStore.activate(account.adminId,'FixtureAdmin2026!','FixtureAdmin2026!','fixture');
  const login=await f.request('/auth/login',{username:'fixture-admin',password:'FixtureAdmin2026!'},'','',true);assert.equal(login.status,200);
  const started=await f.request('/customer-view/start',{},login.cookie,login.data.csrfToken,true);assert.equal(started.status,200);
  const preview=started.data.customer;
  f.store.update(preview.customerId,f.command(preview.customerId,'add-company',{kind:'own',companyId:'cmp-own'}),catalog);
  const state=await f.request('/customer-view/me',null,login.cookie,'',true);
  assert.equal(state.data.customer.accountKind,'admin_preview');assert.equal(state.data.customer.relations[0].status,'pending');
  assert.deepEqual(state.data.regions.map(row=>row.id),['r-home']);assert.deepEqual(state.data.customer.regions,[]);
  const result=await f.request('/customer-view/regions/r-home/analysis?month=2026-09',null,login.cookie,'',true);
  assert.equal(result.status,200);assert.equal(result.data.refreshAvailable,false);
  assert.equal((await f.request('/customer-view/regions/r-home/preparation?month=2026-09',null,login.cookie,'',true)).status,404);
  assert.equal((await f.request('/customer-view/regions/r-home/preparation',{month:'2026-09'},login.cookie,login.data.csrfToken,true)).status,404);
  assert.equal(f.preparations.length,0);
});

test('runtime-added local regions connect by exact company ID even with duplicate names across provinces',async()=>{
  const data={companies:[],regions:[]},customer={relations:[{companyId:'cmp-new-local',kind:'own',status:'pending'}],regions:[],entitlements:{interestRegionLimit:1}};
  const before=clone(customer),reads=[],preparations=[];
  const analysis=createInsightAnalysis({catalog:async()=>data,now:()=>Date.parse('2026-10-23T00:00:00Z'),
    readRegionContext:async request=>{reads.push(clone(request));return {networkAttempted:false,sources:[]};},
    regionPreparation:{get:async()=>{preparations.push('get');return null;},start:async()=>{preparations.push('start');return null;}}
  });
  assert.deepEqual([...readableRegionIds(customer,data)],[]);
  await assert.rejects(analysis.region(customer,'r-province-b-namgu','2026-09'),{statusCode:404});
  data.regions.push({id:'r-province-a-namgu',label:'남구',level:'local'},{id:'r-province-b-namgu',label:'남구',level:'local'});
  data.companies.push({companyId:'cmp-same-name',name:'동일 업체명',regionKey:'r-province-a-namgu'},
    {companyId:'cmp-new-local',name:'동일 업체명',regionKey:'r-province-b-namgu'});
  assert.deepEqual([...readableRegionIds(customer,data)],['r-province-b-namgu']);
  assert.deepEqual([...regionIds(customer,data)],[]);
  const result=await analysis.region(customer,'r-province-b-namgu','2026-09');
  assert.equal(result.region.id,'r-province-b-namgu');assert.equal(result.refreshAvailable,false);
  await assert.rejects(analysis.region(customer,'r-province-a-namgu','2026-09'),{statusCode:404});
  await assert.rejects(analysis.preparation(customer,'r-province-b-namgu','2026-09',true),{statusCode:404});
  assert.deepEqual(reads.map(row=>row.targetId),['r-province-b-namgu']);assert.deepEqual(preparations,[]);
  assert.deepEqual(customer,before,'catalog expansion and read access must not approve ownership or use an interest slot');
});

test('current catalog region and pending-own relation changes immediately replace automatic read access without changing quotas',async()=>{
  const data=clone(catalog),customer={...owner(),entitlements:{competitorLimit:3,interestRegionLimit:1}},reads=[],preparations=[];
  const analysis=createInsightAnalysis({catalog:async()=>data,now:()=>Date.parse('2026-10-23T00:00:00Z'),
    readRegionContext:async request=>{reads.push(request.targetId);return {networkAttempted:false,sources:[]};},
    regionPreparation:{get:async()=>{preparations.push('get');return null;},start:async()=>{preparations.push('start');return null;}}
  });
  const unchanged=async action=>{const before=clone(customer);await action();assert.deepEqual(customer,before);};
  await unchanged(async()=>assert.equal((await analysis.region(customer,'r-home','2026-09')).refreshAvailable,false));
  data.regions.push({id:'r-new-current-location',label:'새로 추가된 소재지',level:'local'});
  data.companies.find(row=>row.companyId==='cmp-own').regionKey='r-new-current-location';
  assert.deepEqual([...readableRegionIds(customer,data)],['r-new-current-location']);
  await unchanged(async()=>{
    await assert.rejects(analysis.region(customer,'r-home','2026-09'),{statusCode:404});
    assert.equal((await analysis.region(customer,'r-new-current-location','2026-09')).refreshAvailable,false);
  });
  customer.relations[0].companyId='cmp-competitor';
  assert.deepEqual([...readableRegionIds(customer,data)],['r-other']);
  await unchanged(async()=>{
    await assert.rejects(analysis.region(customer,'r-new-current-location','2026-09'),{statusCode:404});
    assert.equal((await analysis.region(customer,'r-other','2026-09')).refreshAvailable,false);
    await assert.rejects(analysis.preparation(customer,'r-other','2026-09',true),{statusCode:404});
  });
  customer.relations[0].status='rejected';
  assert.deepEqual([...readableRegionIds(customer,data)],[]);
  await assert.rejects(analysis.region(customer,'r-other','2026-09'),{statusCode:404});
  assert.deepEqual(preparations,[],'pending own and changed regions never receive preparation permission');
  customer.relations[0].status='active';
  await unchanged(async()=>{
    assert.deepEqual([...regionIds(customer,data)],['r-other']);
    assert.equal((await analysis.region(customer,'r-other','2026-09')).refreshAvailable,true);
    await analysis.preparation(customer,'r-other','2026-09');await analysis.preparation(customer,'r-other','2026-09',true);
  });
  assert.deepEqual(preparations,['get','start'],'explicitly approved ownership keeps its existing preparation permission');
  assert.deepEqual(customer.regions,[]);assert.deepEqual(customer.entitlements,{competitorLimit:3,interestRegionLimit:1});
  assert.deepEqual(reads,['r-home','r-new-current-location','r-other','r-other']);
});
