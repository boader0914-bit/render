'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{randomBytes}=require('node:crypto');
const {configuration,createConnectedServer}=require('../customer-portal/connected-server.cjs');
const canonical='https://insight.sabun.co.kr',alias='https://sa-labs-datalab-v4-preview.onrender.com';
function env(extra={}){return {INSIGHT_SERVICE_TOKEN:randomBytes(32).toString('hex'),...extra};}
test('canonical/default origins remain supported and aliases accept comma or newline with deduplication',()=>{
  const legacy=configuration(env());assert.equal(legacy.origin,'http://127.0.0.1:57951');assert.deepEqual(legacy.origins,[legacy.origin]);
  const c=configuration(env({INSIGHT_PUBLIC_ORIGIN:canonical,INSIGHT_PUBLIC_ORIGINS:`${alias},\n${canonical}\r\n${alias}`}));
  assert.equal(c.origin,canonical);assert.deepEqual(c.origins,[canonical,alias]);
});
test('unsafe origins, protocol changes, credentials, paths, query and fragments fail configuration',()=>{
  for(const invalid of ['http://unsafe.example','http://localhost:57951','ftp://unsafe.example','https://user:pass@example.com','https://example.com/app','https://example.com/?q=1','https://example.com/#home','https://example.com/?','https://example.com/#']){
    assert.throws(()=>configuration(env({INSIGHT_PUBLIC_ORIGIN:canonical,INSIGHT_PUBLIC_ORIGINS:invalid})),undefined,invalid);
  }
  assert.throws(()=>configuration(env({INSIGHT_PUBLIC_ORIGIN:'http://localhost:57951',INSIGHT_PUBLIC_ORIGINS:canonical})));
  const local=configuration(env({INSIGHT_PUBLIC_ORIGIN:'http://127.0.0.1:57951',INSIGHT_PUBLIC_ORIGINS:'http://localhost:57951'}));assert.deepEqual(local.origins,['http://127.0.0.1:57951','http://localhost:57951']);
});
async function setup(t,withAlias=true){
  const token=randomBytes(32).toString('hex'),session=randomBytes(32).toString('base64url'),calls=[];
  const server=createConnectedServer({origin:canonical,origins:withAlias?[alias]:[],backend:'https://backend.example',serviceToken:token,fetchImpl:async(url,options)=>{
    calls.push({url,options});assert.equal(options.headers.Authorization,'Bearer '+token);
    return {ok:true,status:200,json:async()=>url.endsWith('/auth/login')?{token:session,csrfToken:'fixture-csrf',customer:{id:'fixture'}}:{ok:true}};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  async function request(host,route,origin,method='GET',headers={}){
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:host,...(origin?{Origin:origin}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{}),...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));
      });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
    });
  }
  return {request,calls,token,session};
}
test('canonical and explicitly allowed alias serve pages and customer/admin POSTs with exact same-origin checks',async t=>{
  const f=await setup(t);
  for(const origin of [canonical,alias]){
    const host=new URL(origin).host;
    assert.equal((await f.request(host,'/api/health')).status,200);
    assert.equal((await f.request(host,'/login')).status,200);
    const login=await f.request(host,'/api/customer/v1/auth/login',origin,'POST');assert.equal(login.status,200);
    assert.match(login.headers['set-cookie'][0],/^__Host-sabun_insight_session=/);assert.match(login.headers['set-cookie'][0],/; Secure/);assert.match(login.headers['set-cookie'][0],/HttpOnly/);assert.equal(login.headers['set-cookie'][0].includes('Domain='),false);
    assert.equal(JSON.parse(login.text).token,undefined);assert.equal(login.text.includes(f.token),false);assert.equal(login.text.includes(f.session),false);
    const admin=await f.request(host,'/api/insight-admin/v1/auth/login',origin,'POST');assert.equal(admin.status,200);assert.match(admin.headers['set-cookie'][0],/^__Host-sabun_insight_admin=/);assert.match(admin.headers['set-cookie'][0],/SameSite=Strict/);assert.match(admin.headers['set-cookie'][0],/; Secure/);assert.equal(JSON.parse(admin.text).token,undefined);
  }
  assert.equal(f.calls.length,4);
});
test('cross-alias Origin, unknown hosts, and foreign absolute URL requests are rejected without backend calls',async t=>{
  const f=await setup(t),host=new URL(alias).host;
  for(const route of ['/api/customer/v1/commands','/api/insight-admin/v1/customer-view/start']){
    const rejected=await f.request(host,route,canonical,'POST');assert.equal(rejected.status,403);assert.equal(JSON.parse(rejected.text).error.code,'INVALID_ORIGIN');
    assert.equal((await f.request(new URL(canonical).host,route,alias,'POST')).status,403);
    assert.equal((await f.request(host,route,undefined,'POST')).status,403);
  }
  for(const target of [canonical+'/api/health','https://foreign.example/api/health','//foreign.example/api/health'])assert.equal((await f.request(host,target)).status,403);
  assert.equal((await f.request('foreign.example','/api/health')).status,403);
  assert.equal(f.calls.length,0);
});
test('legacy single-origin server does not implicitly allow Render or forwarding headers',async t=>{
  const f=await setup(t,false);
  assert.equal((await f.request(new URL(canonical).host,'/api/health')).status,200);
  assert.equal((await f.request(new URL(alias).host,'/api/health')).status,403);
  assert.equal((await f.request('foreign.example','/api/health',undefined,'GET',{'X-Forwarded-Host':new URL(canonical).host})).status,403);
});
test('explicit local HTTP alias retains development cookie scope and exact POST Origin',async t=>{
  const token=randomBytes(32).toString('hex'),session=randomBytes(32).toString('base64url');
  const origin='http://127.0.0.1:57951',localAlias='http://localhost:57951';
  const server=createConnectedServer({origin,origins:[localAlias],backend:'http://127.0.0.1:57950',serviceToken:token,fetchImpl:async()=>({ok:true,status:200,json:async()=>({token:session,customer:{id:'fixture'}})})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const response=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/customer/v1/auth/login',method:'POST',headers:{Host:new URL(localAlias).host,Origin:localAlias,'Content-Type':'application/json'}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end('{}');});
  assert.equal(response.status,200);assert.match(response.headers['set-cookie'][0],/^insight_local_session=/);assert.equal(response.headers['set-cookie'][0].includes('; Secure'),false);assert.equal(response.headers['set-cookie'][0].includes('Domain='),false);assert.equal(JSON.parse(response.text).token,undefined);
});
