'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs');
const origin='https://insight-observability.example',backend='https://central-observability.example';
const customerMe='/api/customer/v1/me',customerCompany='/api/customer/v1/companies/cmp_fixture/collection';
const identity=()=>({customer:{customerId:'customer-fixture',accountStatus:'active',revision:1,relations:[{companyId:'cmp_fixture',kind:'own',status:'active'}]},companies:[{companyId:'cmp_fixture',name:'검수 업체',rooms:16,version:1}],preparations:[],collectionAllowance:{canRequest:true,limit:1}});
const company=()=>({result:{companyId:'cmp_fixture',version:'source-1',runId:'run-1',quality:{status:'partial'},products:[]},companyDetail:{companyId:'cmp_fixture',integrated:{status:'ready',selectedMonth:'2026-10'},current:{daily:[{date:'2026-10-01',publicBookings:0,estimatedRevenue:0},{date:'2026-10-02',publicBookings:null,estimatedRevenue:null}]}},request:null});
const response=(data,status=200,timing='')=>({status,ok:status>=200&&status<300,headers:{get:name=>name.toLowerCase()==='server-timing'?timing:null},json:async()=>data});
const timeout=()=>Object.assign(new Error('synthetic timeout with private internal details'),{name:'TimeoutError'});
async function fixture(t,handler){
  const calls=[],server=createConnectedServer({origin,backend,serviceToken:'fixture-service-credential-not-real-and-not-to-be-exposed',fetchImpl:async(url,options)=>{
    const target=new URL(url),call={path:target.pathname,query:target.search,options};calls.push(call);
    return handler(call);
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const request=(path,{method='GET',admin=false,headers={}}={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:new URL(origin).host,Cookie:admin?'__Host-sabun_insight_admin=fixture-session':'__Host-sabun_insight_session=fixture-session',...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'fixture-csrf'}:{}),...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,data:text?JSON.parse(text):null});});
    });
    req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
  return {request,calls};
}
function safeTiming(reply){
  const header=reply.headers['server-timing'];assert.equal(typeof header,'string');
  const names=[];
  for(const item of header.split(',')){
    const match=/^\s*([a-z_]+);dur=(\d+(?:\.\d+)?)\s*$/.exec(item);assert.ok(match,'only a fixed name and numeric duration may be exposed');
    assert.ok(['upstream_headers','upstream_body','snapshot','total','state_catalog','state_total'].includes(match[1]));
    names.push(match[1]);assert.ok(Number.isFinite(Number(match[2])));
  }
  for(const name of ['upstream_headers','upstream_body','snapshot','total'])assert.ok(names.includes(name),'missing fixed timing '+name);
  assert.doesNotMatch(header,/fixture|private|credential|cmp_|session|desc=|NaN|Infinity/);
  return header;
}

test('successful login-state responses expose fixed timing stages and only numeric allowlisted central timings',async t=>{
  const raw='state_catalog;dur=12.25;desc="private company cmp_fixture", state_total;dur=18.5, secret_session;dur=9, state_catalog;dur=-1, state_total;dur=NaN, state_total;dur=999999999999999';
  const f=await fixture(t,()=>response(identity(),200,raw));
  const reply=await f.request(customerMe),header=safeTiming(reply);
  assert.equal(reply.status,200);assert.match(header,/state_catalog;dur=12\.3/);assert.match(header,/state_total;dur=18\.5/);
  assert.deepEqual(reply.data.companyViews,[]);assert.equal(reply.headers['set-cookie'],undefined);
  assert.match(reply.headers['cache-control'],/private, no-store/);assert.equal(f.calls.length,1);
});

test('administrator preview startup retains one CSRF-protected POST with measured state and snapshot stages',async t=>{
  const f=await fixture(t,call=>{assert.equal(call.path,'/api/insight/v1/admin/customer-view/start');assert.equal(call.options.method,'POST');assert.equal(call.options.headers['X-CSRF-Token'],'fixture-csrf');return response(identity(),200,'state_total;dur=4');});
  const reply=await f.request('/api/insight-admin/v1/customer-view/start',{method:'POST',admin:true});
  assert.equal(reply.status,200);safeTiming(reply);assert.deepEqual(reply.data.companyViews,[]);assert.equal(f.calls.length,1);
});

for(const entry of [{path:customerMe},{path:'/api/insight-admin/v1/customer-view/me',admin:true},{path:'/api/insight-admin/v1/customer-view/start',admin:true,method:'POST'}])test(`${entry.path} reports identity timeout without deleting the session or retrying`,async t=>{
  const f=await fixture(t,()=>{throw timeout();}),reply=await f.request(entry.path,entry);
  assert.equal(reply.status,504);assert.equal(reply.data.error.code,'UPSTREAM_TIMEOUT');assert.equal(reply.data.error.stage,'identity');
  assert.equal(reply.data.error.message,'로그인 확인이 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.');
  assert.doesNotMatch(JSON.stringify(reply.data),/synthetic|private internal/);assert.equal(reply.headers['set-cookie'],undefined);assert.equal(f.calls.length,1);safeTiming(reply);
});

test('an identity response-body timeout remains identifiable after headers have arrived',async t=>{
  const f=await fixture(t,()=>({...response(identity(),200,'state_total;dur=3'),json:async()=>{throw timeout();}}));
  const reply=await f.request(customerMe);assert.equal(reply.status,504);assert.equal(reply.data.error.stage,'identity');safeTiming(reply);
});

test('a cached company still refuses identity timeout and preserves the prior core for a later authorized read',async t=>{
  let failIdentity=false;
  const f=await fixture(t,call=>{
    if(call.path.endsWith('/me')){if(failIdentity)throw timeout();return response(identity());}
    return response(company());
  });
  assert.equal((await f.request(customerCompany)).status,200);failIdentity=true;
  const denied=await f.request(customerCompany);assert.equal(denied.status,504);assert.equal(denied.data.error.stage,'identity');
  assert.equal(denied.data.result,undefined);assert.equal(denied.headers['set-cookie'],undefined);safeTiming(denied);
  assert.equal(f.calls.filter(call=>call.path.endsWith('/collection')&&!new URLSearchParams(call.query).has('savedOnly')).length,1,'a failed permission check must not read a company source');
  failIdentity=false;const recovered=await f.request(customerCompany);
  assert.equal(recovered.status,200);assert.equal(recovered.data.responseCache.state,'cached');assert.equal(recovered.data.result.version,'source-1');
  assert.equal(f.calls.filter(call=>call.path.endsWith('/collection')&&!new URLSearchParams(call.query).has('savedOnly')).length,1,'an identity timeout does not turn the saved core into a failure or zero');
});

test('company source timeout is distinguished from the successful identity guard',async t=>{
  const f=await fixture(t,call=>{if(call.path.endsWith('/me'))return response(identity());throw timeout();});
  const reply=await f.request(customerCompany);assert.equal(reply.status,504);assert.equal(reply.data.error.code,'UPSTREAM_TIMEOUT');assert.equal(reply.data.error.stage,'source');
  assert.equal(reply.data.error.message,'자료 조회가 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.');
  assert.equal(reply.data.result,undefined);assert.equal(f.calls.length,3);assert.equal(f.calls.filter(call=>new URLSearchParams(call.query).has('savedOnly')).length,1);assert.equal(f.calls.filter(call=>call.path.endsWith('/collection')&&!new URLSearchParams(call.query).has('savedOnly')).length,1);safeTiming(reply);
});

for(const admin of [false,true])for(const status of [401,403])test(`${admin?'administrator':'customer'} HTTP ${status} keeps its original authentication result and cookie policy`,async t=>{
  const error={code:status===401?'INVALID_CREDENTIALS':'ACCOUNT_DISABLED',message:status===401?'아이디 또는 비밀번호를 확인해 주세요.':'이용이 중지된 계정입니다.'};
  const f=await fixture(t,()=>response({error},status)),reply=await f.request(admin?'/api/insight-admin/v1/auth/login':'/api/customer/v1/auth/login',{method:'POST',admin});
  assert.equal(reply.status,status);assert.deepEqual(reply.data.error,error);assert.equal(f.calls.length,1);safeTiming(reply);
  if(status===401)assert.match(reply.headers['set-cookie'][0],/Max-Age=0/);else assert.equal(reply.headers['set-cookie'],undefined);
});

test('an unknown network failure keeps the generic connection error and exposes no raw internal detail',async t=>{
  const f=await fixture(t,()=>{throw Error('private upstream URL and credential detail');}),reply=await f.request(customerMe);
  assert.equal(reply.status,503);assert.equal(reply.data.error.code,'CONNECTION_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(reply.data),/private upstream|credential/);safeTiming(reply);
});

test('a timed-out write command is never automatically retried or mislabeled as a login failure',async t=>{
  const f=await fixture(t,()=>{throw timeout();}),reply=await f.request('/api/customer/v1/commands',{method:'POST'});
  assert.equal(reply.status,503);assert.equal(reply.data.error.code,'CONNECTION_UNAVAILABLE');assert.equal(reply.data.error.stage,undefined);assert.equal(f.calls.length,1);
  assert.equal(reply.headers['set-cookie'],undefined);
});
