'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs');
const origin='https://insight.example',backend='https://datalab.example';
async function setup(t){
  const calls=[],state={allowed:true,revision:1,identityStatus:200,sourceStatus:200,sourceVersion:1,identityTimeout:false};
  const identity=()=>({customer:{customerId:'cus_fixture',accountStatus:'active',revision:state.revision,relations:[],regions:[]},companies:[],regions:state.allowed?[{id:'region_one',label:'검수 지역'}]:[],preparations:[],collectionAllowance:{canRequest:true}});
  const server=createConnectedServer({origin,backend,serviceToken:'fixture-service-token-not-a-real-credential',fetchImpl:async(url,options)=>{
    const u=new URL(url),source=u.pathname.endsWith('/analysis');
    calls.push({path:u.pathname,method:options.method,query:u.search});
    if(!source&&state.identityTimeout){const error=new Error('fixture');error.name='TimeoutError';throw error;}
    let status=source?state.sourceStatus:state.identityStatus;
    if(source&&(u.searchParams.getAll('month').length!==1||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(u.searchParams.get('month'))||[...u.searchParams.keys()].some(k=>k!=='month')))status=400;
    const month=u.searchParams.get('month');
    const data=status!==200?{error:{code:'FIXTURE_'+status,message:'fixture failure'}}:source?{
      region:{id:'region_one',label:'검수 지역'},month,window:{start:'2025-10',end:month,storageStart:'2024-10',months:[]},
      source:'datalab_saved',networkAttempted:false,location:null,sources:[{key:'visitors',label:'방문자',status:'partial',rows:[{label:'정상 0',value:0,unit:'명'},{label:'미확인',value:null,unit:'명'}]}],
      availableSources:1,warnings:['fixture-v'+state.sourceVersion],refreshAvailable:true,
      token:'fixture-sensitive-field-must-not-be-cached',customer:{private:'fixture-private'}
    }:identity();
    return {status,ok:status===200,json:async()=>data,headers:new Headers()};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=(route,options={})=>new Promise((resolve,reject)=>{
    const method=options.method||'GET',req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:'insight.example',Cookie:options.admin?'__Host-sabun_insight_admin=fixture-admin-session':'__Host-sabun_insight_session='+ (options.session||'fixture-session'),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...options.headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,data:JSON.parse(text)});});
    });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
  return {request,calls,state,sourceCalls:()=>calls.filter(c=>c.path.endsWith('/analysis')).length};
}
const customer='/api/customer/v1/regions/region_one/analysis?month=2026-09',admin='/api/insight-admin/v1/customer-view/regions/region_one/analysis?month=2026-09';

test('regional revisit and browser reload reuse saved results only after fresh central identity verification',async t=>{
  const f=await setup(t),first=await f.request(customer),hit=await f.request(customer);
  assert.equal(first.status,200);assert.equal(hit.status,200);assert.equal(f.sourceCalls(),1);
  assert.equal(f.calls.filter(c=>c.path==='/api/insight/v1/me').length,2);
  assert.equal(hit.data.responseCache.state,'cached');assert.equal(hit.data.sources[0].rows[0].value,0);assert.equal(hit.data.sources[0].rows[1].value,null);
  assert.match(hit.headers['server-timing'],/upstream_headers;dur=/);assert.match(hit.headers['cache-control'],/private, no-store/);
  assert.doesNotMatch(hit.text,/fixture-session|fixture-service-token|fixture-sensitive|fixture-private/);
  const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.regionViews.length,1);assert.equal(boot.data.regionViews[0].regionKey,'region_one');assert.equal(boot.data.regionViews[0].month,'2026-09');
  assert.equal(boot.data.regionViews[0].data.region.id,'region_one');assert.equal(f.sourceCalls(),1,'bootstrap must not issue source GETs');
  assert.doesNotMatch(JSON.stringify(boot.data.regionViews),/fixture-sensitive|fixture-private/);
});

test('regional scopes separate sessions, administrator preview and exact requested months',async t=>{
  const f=await setup(t);await f.request(customer);await f.request(customer.replace('2026-09','2026-08'));await f.request(customer,{session:'fixture-second'});await f.request(admin,{admin:true});
  assert.equal(f.sourceCalls(),4);
  await f.request(customer);await f.request(admin,{admin:true});assert.equal(f.sourceCalls(),4);
  assert.ok(f.calls.some(c=>c.path==='/api/insight/v1/admin/customer-view/me'));
  const boot=await f.request('/api/insight-admin/v1/customer-view/me',{admin:true});assert.equal(boot.data.regionViews.length,1);assert.equal(boot.data.regionViews[0].month,'2026-09');
  await f.request('/api/insight-admin/v1/customer-view/start',{admin:true,method:'POST'});await f.request(admin,{admin:true});assert.equal(f.sourceCalls(),4,'idempotent start keeps a verified preview cache');
  const customerBoot=await f.request('/api/customer/v1/me');assert.equal(customerBoot.data.regionViews.length,2);assert.deepEqual(customerBoot.data.regionViews.map(r=>r.month).sort(),['2026-08','2026-09']);
});

test('explicit data refresh, customer commands and preparation mutations invalidate server regional results',async t=>{
  const f=await setup(t);await f.request(customer);f.state.sourceVersion=2;
  const forced=await f.request(customer,{headers:{'X-Insight-Refresh':'1'}});assert.deepEqual(forced.data.warnings,['fixture-v2']);assert.equal(f.sourceCalls(),2);
  await f.request('/api/customer/v1/commands',{method:'POST'});assert.deepEqual((await f.request('/api/customer/v1/me')).data.regionViews,[]);await f.request(customer);assert.equal(f.sourceCalls(),3);
  await f.request('/api/customer/v1/regions/region_one/preparation',{method:'POST'});await f.request(customer);assert.equal(f.sourceCalls(),4);
  await f.request('/api/insight-admin/v1/customer-view/commands',{admin:true,method:'POST'});await f.request(admin,{admin:true});assert.equal(f.sourceCalls(),5);
});

test('removed regional access and expired identities cannot receive or restore cached data',async t=>{
  const f=await setup(t);await f.request(customer);f.state.allowed=false;
  const removedBoot=await f.request('/api/customer/v1/me');assert.deepEqual(removedBoot.data.regionViews,[]);
  const removed=await f.request(customer);assert.equal(removed.status,404);assert.equal(removed.data.sources,undefined);
  f.state.allowed=true;f.state.identityStatus=401;
  const expired=await f.request(customer);assert.equal(expired.status,401);assert.equal(expired.data.sources,undefined);assert.match(expired.headers['set-cookie'][0],/Max-Age=0/);
});

test('a central identity timeout fails closed even when a regional result was already saved',async t=>{
  const f=await setup(t);await f.request(customer);f.state.identityTimeout=true;
  const timeout=await f.request(customer);assert.equal(timeout.status,504);assert.equal(timeout.data.error.code,'UPSTREAM_TIMEOUT');assert.equal(timeout.data.error.stage,'identity');assert.equal(timeout.data.sources,undefined);assert.equal(timeout.headers['set-cookie'],undefined);
});

test('invalid and repeated month arguments follow central validation without selecting a saved period',async t=>{
  const f=await setup(t);await f.request(customer);
  for(const query of ['month=2026-99','month=2026-09&month=2026-09','month=2026-09&other=1','']){
    const bad=await f.request('/api/customer/v1/regions/region_one/analysis'+(query?'?'+query:''));assert.equal(bad.status,400);assert.equal(bad.data.sources,undefined);
  }
  assert.equal((await f.request(customer)).status,200);assert.equal(f.sourceCalls(),5);
});
