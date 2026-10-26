'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs'),{identity,report,NOW}=require('./fixtures/report-period-fixture.cjs');
const origin='https://period-http.synthetic',backend='https://period-central.synthetic';
const response=data=>({status:200,ok:true,headers:new Headers(),json:async()=>data});
async function fixture(t){
 t.mock.timers.enable({apis:['Date'],now:NOW});
 const calls=[],server=createConnectedServer({origin,backend,serviceToken:'synthetic-period-read-token-only',diagnosticsLogger(){},fetchImpl:async(value,options)=>{const url=new URL(value);calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:options.method});if(url.pathname.endsWith('/me'))return response(identity());const selection=Object.fromEntries(['stayMode','month','start','end'].filter(k=>url.searchParams.has(k)).map(k=>[k,url.searchParams.get(k)])),data=report(selection);if(url.searchParams.has('savedOnly'))data.calculation={mode:'saved_only',status:'pending',oldestSourceCalculatedAt:null,latestSourceCalculatedAt:null};return response(data);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const request=(query='',admin=false)=>new Promise((resolve,reject)=>{const route=(admin?'/api/insight-admin/v1/customer-view':'/api/customer/v1')+'/reports/briefing'+query;http.get({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{Host:new URL(origin).host,Cookie:admin?'__Host-sabun_insight_admin=synthetic-session':'__Host-sabun_insight_session=synthetic-session'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));}).on('error',reject);});
 return {calls,request};
}
for(const admin of [false,true])test((admin?'administrator customer view':'customer')+' defaults to all available and forwards only canonical read-only selection',async t=>{
 const f=await fixture(t),reply=await f.request('?ownId=own',admin);assert.equal(reply.status,200);assert.equal(reply.data.selection.stayMode,'all_available');assert.equal(reply.data.period.days,4);assert.ok(f.calls.filter(c=>c.path.endsWith('/reports/briefing')).every(c=>c.query.stayMode==='all_available'&&c.query.ownId==='own'));assert.ok(f.calls.every(c=>c.method==='GET'));assert.ok(f.calls.some(c=>c.query.savedOnly==='1'));
});
test('month, custom and upcoming HTTP requests keep each selected response scope',async t=>{
 const f=await fixture(t);for(const [query,mode,days] of [['?ownId=own&stayMode=month&month=2026-09','month',30],['?ownId=own&stayMode=custom&start=2026-09-29&end=2026-09-30','custom',2],['?ownId=own&stayMode=upcoming30','upcoming30',30]]){const reply=await f.request(query);assert.equal(reply.status,200);assert.equal(reply.data.selection.stayMode,mode);assert.equal(reply.data.period.days,days);}assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('duplicate, conflicting and unknown period query fields never reach the central server',async t=>{
 const f=await fixture(t);for(const query of ['?stayMode=all_available&stayMode=month','?stayMode=month&month=2026-13','?stayMode=custom&start=2026-09-29','?stayMode=upcoming30&month=2026-09','?stayMode=all_available&secret=private','?ownId=own&ownId=own']){assert.equal((await f.request(query)).status,400);}assert.equal(f.calls.length,0);
});
