'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs');
const origin='https://insight-recurring.example';
async function fixture(t){
 const calls=[],server=createConnectedServer({origin,backend:'https://central-recurring.example',serviceToken:'fixture-recurring-service-credential-not-real',fetchImpl:async(url,options)=>{
  calls.push({path:new URL(url).pathname,method:options.method,body:options.body,headers:options.headers});
  return {status:200,ok:true,json:async()=>({recurringCollections:[],status:'pending'})};
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const request=(route,{method='GET',payload,origin:sentOrigin=origin,admin=false}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:new URL(origin).host,Cookie:admin?'__Host-sabun_insight_admin=fixture_admin':'__Host-sabun_insight_session=fixture_customer','X-CSRF-Token':'fixture_csrf',...(method==='POST'?{Origin:sentOrigin,'Content-Type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));});req.on('error',reject);req.end(payload?JSON.stringify(payload):undefined);
 });return{calls,request};
}
for(const admin of [false,true])test(`${admin?'administrator customer view':'customer'} recurring request is an uncached authenticated proxy, never a collection dispatch`,async t=>{
 const f=await fixture(t),route=(admin?'/api/insight-admin/v1/customer-view':'/api/customer/v1')+'/companies/cmp_fixture/recurring-collection';
 assert.equal((await f.request(route,{admin})).status,200);
 const post=await f.request(route,{admin,method:'POST',payload:{requestKey:'fixture_request'}});assert.equal(post.status,200);assert.match(post.headers['cache-control'],/private, no-store/);
 assert.deepEqual(f.calls.map(c=>[c.path,c.method]),[[`/api/insight/v1${admin?'/admin/customer-view':''}/companies/cmp_fixture/recurring-collection`,'GET'],[`/api/insight/v1${admin?'/admin/customer-view':''}/companies/cmp_fixture/recurring-collection`,'POST']]);
 assert.deepEqual(JSON.parse(f.calls[1].body),{requestKey:'fixture_request'});assert.equal(f.calls[1].headers['X-CSRF-Token'],'fixture_csrf');
 assert.equal(f.calls[1].headers[admin?'X-Insight-Admin-Session':'X-Insight-Session'],admin?'fixture_admin':'fixture_customer');
 assert.doesNotMatch(post.text,/fixture_admin|fixture_customer|fixture_csrf|fixture-recurring-service/);
 assert.ok(f.calls.every(c=>!c.path.endsWith('/commands')&&!c.path.endsWith('/crawl')&&!c.path.endsWith('/collection')));
});
test('administrator list and review are exact routes with CSRF and origin checks',async t=>{
 const f=await fixture(t),list='/api/insight-admin/v1/recurring-collections',review=list+'/review';
 assert.equal((await f.request(list,{admin:true})).status,200);
 const payload={companyId:'cmp_fixture',decision:'approve',reason:'운영 확인',time:'14:00',requestKey:'review_fixture'};
 assert.equal((await f.request(review,{admin:true,method:'POST',payload})).status,200);
 assert.deepEqual(f.calls.map(c=>[c.path,c.method]),[['/api/insight/v1/admin/recurring-collections','GET'],['/api/insight/v1/admin/recurring-collections/review','POST']]);
 assert.deepEqual(JSON.parse(f.calls[1].body),payload);
 const count=f.calls.length;assert.equal((await f.request(review,{admin:true,method:'POST',payload,origin:'https://outside.example'})).status,403);assert.equal(f.calls.length,count);
});
test('unlisted recurring paths and methods cannot reach central administration',async t=>{
 const f=await fixture(t);
 for(const [route,method]of [['/api/customer/v1/recurring-collections','GET'],['/api/customer/v1/recurring-collections/review','POST'],['/api/insight-admin/v1/recurring-collections','POST'],['/api/insight-admin/v1/recurring-collections/review','GET'],['/api/customer/v1/companies/cmp_fixture/recurring-collection/review','POST'],['/api/customer/v1/companies/cmp_fixture/recurring-collection','DELETE']])assert.equal((await f.request(route,{method,payload:method==='POST'?{}:undefined})).status,404,route+' '+method);
 assert.equal(f.calls.length,0);
});
