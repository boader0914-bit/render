'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs');
const origin='https://insight.example',backend='https://datalab.example';
async function setup(t){
 const calls=[],state={allowed:true,expired:false,revision:1,sourceVersion:1};
 const identity=()=>({customer:{customerId:'customer-fixture',accountStatus:'active',revision:state.revision,relations:state.allowed?[{companyId:'cmp_one',kind:'own',status:'active'}]:[]},companies:state.allowed?[{companyId:'cmp_one',name:'검수 업체',version:1,rooms:16}]:[],preparations:[],collectionAllowance:{canRequest:true,limit:1}});
 const server=createConnectedServer({origin,backend,serviceToken:'fixture-service-token-not-a-real-credential',fetchImpl:async(url,options)=>{
  calls.push({path:new URL(url).pathname,method:options.method,query:new URL(url).search});
  const status=state.expired?401:200,ok=status===200;
  let data=identity();
  if(new URL(url).pathname.endsWith('/collection')){
   const u=new URL(url);if(u.searchParams.getAll('month').length>1||u.searchParams.has('month')&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(u.searchParams.get('month'))||[...u.searchParams.keys()].some(k=>k!=='month'))return {status:400,ok:false,json:async()=>({error:{code:'INVALID_MONTH'}})};
   data={result:{version:'source-'+state.sourceVersion,runId:'run-'+state.sourceVersion,products:[]},companyDetail:{companyId:'cmp_one',basics:{name:'검수 업체'},integrated:{status:'ready',selectedMonth:u.searchParams.get('month')||'2026-10',snapshot:{}},current:{daily:[]}},request:null,collectionAllowance:{canRequest:false}};
  }
  if(status===401)data={error:{code:'SESSION_EXPIRED'}};
  return {status,ok,json:async()=>data};
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const request=(path,options={})=>new Promise((resolve,reject)=>{
  const method=options.method||'GET',req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Host:'insight.example',Cookie:options.admin?'__Host-sabun_insight_admin=fixture-session':'__Host-sabun_insight_session=fixture-session',...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{}),...options.headers}},res=>{
   const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,data:res.headers['content-type']?.includes('application/json')?JSON.parse(text):null});});
  });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
 });
 return {request,calls,state,sourceCalls:()=>calls.filter(call=>call.path.endsWith('/collection')).length};
}
const customer='/api/customer/v1/companies/cmp_one/collection',admin='/api/insight-admin/v1/customer-view/companies/cmp_one/collection';

test('same-session reload reuses company data only after a new central permission check',async t=>{
 const f=await setup(t),first=await f.request(customer),second=await f.request(customer);
 assert.equal(first.status,200);assert.equal(second.status,200);assert.equal(f.sourceCalls(),1);
 assert.equal(f.calls.filter(call=>call.path==='/api/insight/v1/me').length,2);
 assert.equal(second.data.result.version,'source-1');assert.equal(second.data.responseCache.state,'cached');
 assert.equal(second.data.collectionAllowance.canRequest,true,'quota is from the fresh permission response');
 assert.match(second.headers['cache-control'],/private, no-store/);assert.doesNotMatch(second.text,/fixture-session|fixture-service-token/);
 f.state.allowed=false;const revoked=await f.request(customer);assert.equal(revoked.status,404);assert.equal(revoked.data.result,undefined);
 f.state.allowed=true;f.state.expired=true;const expired=await f.request(customer);assert.equal(expired.status,401);assert.equal(expired.data.result,undefined);assert.match(expired.headers['set-cookie'][0],/Max-Age=0/);
});

test('customer/admin, exact month, explicit refresh and command invalidation remain isolated',async t=>{
 const f=await setup(t);await f.request(customer+'?month=2026-09');await f.request(customer+'?month=2026-10');
 assert.equal(f.sourceCalls(),2);await f.request(customer+'?month=2026-09');assert.equal(f.sourceCalls(),2);
 await f.request(admin+'?month=2026-09',{admin:true});assert.equal(f.sourceCalls(),3);
 assert.ok(f.calls.some(call=>call.path==='/api/insight/v1/admin/customer-view/me'));
 await f.request('/api/insight-admin/v1/customer-view/start',{admin:true,method:'POST'});
 await f.request(admin+'?month=2026-09',{admin:true});assert.equal(f.sourceCalls(),3,'idempotent admin start does not discard the reload cache');
 f.state.sourceVersion=2;const forced=await f.request(customer+'?month=2026-09',{headers:{'X-Insight-Refresh':'1'}});
 assert.equal(forced.data.result.version,'source-2');assert.equal(f.sourceCalls(),4);
 await f.request('/api/customer/v1/commands',{method:'POST'});await f.request(customer+'?month=2026-09');assert.equal(f.sourceCalls(),5);
 for(const query of ['?month=2026-99','?month=2026-09&month=2026-09','?other=1'])assert.equal((await f.request(customer+query)).status,400);
});

test('static assets revalidate with ETag and 304 while HTML and private APIs stay no-store',async t=>{
 const f=await setup(t),asset=await f.request('/connected.css');
 assert.equal(asset.status,200);assert.ok(asset.text.length>100);assert.match(asset.headers['cache-control'],/private, no-cache/);assert.ok(asset.headers.etag);
 const same=await f.request('/connected.css',{headers:{'If-None-Match':asset.headers.etag}});assert.equal(same.status,304);assert.equal(same.text,'');
 const weak=await f.request('/connected.css',{headers:{'If-None-Match':'W/'+asset.headers.etag}});assert.equal(weak.status,304);
 assert.equal((await f.request('/connected.css',{headers:{'If-None-Match':'"different"'}})).status,200);
 const html=await f.request('/');assert.match(html.headers['cache-control'],/no-store/);assert.equal(html.headers.etag,undefined);
 assert.match((await f.request('/api/health')).headers['cache-control'],/no-store/);
 assert.equal(f.calls.length,0,'static validation must not contact DataLab');
});
