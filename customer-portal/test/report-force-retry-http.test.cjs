'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConnectedServer}=require('../connected-server.cjs');
const origin='https://insight-report-force.example',backend='https://central-report-force.example';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const json=(data,status=200)=>({status,ok:status>=200&&status<300,headers:new Headers(),json:async()=>data});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

for(const admin of [false,true])test((admin?'administrator customer view':'customer')+' explicitly retries a persisted failed preview through the HTTP refresh header only once', {timeout:10000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-force-report-')),calls=[];
 const storedAt=new Date(Date.now()-2*3600000).toISOString(),start=new Date(Date.now()+9*3600000).toISOString().slice(0,10),end=new Date(Date.parse(start+'T00:00:00Z')+29*86400000).toISOString().slice(0,10);
 const identity={customer:{customerId:'customer_force_fixture',accountStatus:'active',revision:1,relations:[{companyId:'own_force_fixture',kind:'own',status:'active'}],regions:[]},companies:[{companyId:'own_force_fixture',name:'검수 내 매장',rooms:16}],regions:[],preparations:[]};
 const source=(sold=0)=>({mode:'current_briefing',published:false,generatedAt:storedAt,ownId:'own_force_fixture',period:{start,end,days:30},companies:[{companyId:'own_force_fixture',name:'검수 내 매장',rooms:16,kind:'own',relationStatus:'active',unavailable:false,summary:{days:30,supply:480,sold,reservationRate:sold/480,publicBookings:sold,phoneBookings:0,estimatedRevenue:null}}],comparisons:[],regions:[],actions:[],definitions:[]});
 let server,sourceStatus=500,sourceHold=null,sold=0;
 const fetchImpl=async(value,options)=>{
  const url=new URL(value);calls.push({path:url.pathname,query:url.search,method:options.method});
  if(url.pathname.endsWith('/me'))return json(identity);
  assert.ok(url.pathname.endsWith('/reports/briefing'));assert.equal(options.method,'GET');
  if(url.searchParams.get('savedOnly')==='1')return json({...source(),calculation:{mode:'saved_only',status:'pending',oldestSourceCalculatedAt:storedAt,latestSourceCalculatedAt:storedAt}});
  if(sourceHold)await sourceHold.promise;
  return sourceStatus===200?json(source(sold)):json({error:{code:'FIXTURE_SOURCE_FAILURE',message:'PRIVATE source details must not escape'}},sourceStatus);
 };
 const startServer=async()=>{server=createConnectedServer({origin,backend,serviceToken:'fixture-service-credential-only-for-local-mock',fetchImpl,reportCacheDirectory:directory,diagnosticsLogger(){}});await server.prepareReportSnapshots();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
 const close=async()=>{if(!server)return;const previous=server;server=null;await previous.flushReportSnapshots();previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));};
 t.after(async()=>{sourceHold?.resolve();await close();const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-force-report-'));await fs.rm(target,{recursive:true,force:true});});
 const route=(admin?'/api/insight-admin/v1/customer-view':'/api/customer/v1')+'/reports/briefing?ownId=own_force_fixture';
 const request=(refresh=false)=>new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:server.address().port,path:route,headers:{Host:new URL(origin).host,Cookie:admin?'__Host-sabun_insight_admin=mock-admin-session':'__Host-sabun_insight_session=mock-session',...(refresh?{'X-Insight-Refresh':'1'}:{})}},res=>{let body='';res.on('data',value=>body+=value);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(body)}));});req.on('error',reject);});
 const actualCalls=()=>calls.filter(call=>call.path.endsWith('/reports/briefing')&&!new URLSearchParams(call.query).has('savedOnly'));
 const waitFor=async predicate=>{for(let i=0;i<100;i++){const reply=await request();if(predicate(reply))return reply;await delay(10);}throw Error('Mock report transition did not finish');};

 await startServer();const initial=await request();assert.equal(initial.status,200);assert.equal(initial.data.responseCache.state,'preview');
 const failed=await waitFor(reply=>reply.data.responseCache.calculationStatus==='failed');assert.equal(failed.data.calculation.status,'failed');assert.equal(failed.data.responseCache.refreshFailed,true);assert.equal(failed.data.responseCache.refreshing,false);assert.equal(failed.data.responseCache.refreshErrorCode,'REPORT_CALCULATION_FAILED');assert.doesNotMatch(JSON.stringify(failed),/PRIVATE|FIXTURE_SOURCE_FAILURE/);assert.equal(actualCalls().length,1);
 const originalCheck=failed.data.responseCache.checkedAt;await close();await startServer();
 const restored=await request();assert.equal(restored.data.responseCache.persisted,true);assert.equal(restored.data.responseCache.calculationStatus,'failed');assert.equal(restored.data.responseCache.checkedAt,originalCheck);assert.equal(restored.data.companies[0].summary.publicBookings,0);assert.equal(restored.data.companies[0].summary.estimatedRevenue,null);assert.equal(actualCalls().length,1,'ordinary GET must not retry the failed calculation after restart');

 sourceStatus=200;sold=9;sourceHold=deferred();
 const forced=await Promise.all([request(true),request(true)]);for(const reply of forced){assert.equal(reply.status,200);assert.equal(reply.data.responseCache.state,'preview');assert.equal(reply.data.calculation.status,'pending');assert.equal(reply.data.responseCache.calculationStatus,'pending');assert.equal(reply.data.responseCache.refreshing,true);assert.equal(reply.data.responseCache.refreshFailed,false);assert.equal(reply.data.responseCache.refreshErrorCode,undefined);assert.equal(reply.data.calculation.errorCode,undefined);assert.equal(reply.data.responseCache.checkedAt,originalCheck);}
 assert.equal(actualCalls().length,2,'two forced HTTP GETs must share the one active recalculation');assert.equal((await request()).data.responseCache.refreshing,true);assert.equal(actualCalls().length,2);
 sourceHold.resolve();sourceHold=null;
 const complete=await waitFor(reply=>reply.data.responseCache.calculationStatus==='complete');assert.equal(complete.data.calculation,undefined);assert.equal(complete.data.responseCache.state,'cached');assert.equal(complete.data.responseCache.refreshing,false);assert.equal(complete.data.responseCache.refreshFailed,false);assert.equal(complete.data.companies[0].summary.publicBookings,9);assert.equal(complete.data.companies[0].summary.estimatedRevenue,null);assert.equal(actualCalls().length,2);assert.equal(calls.filter(call=>new URLSearchParams(call.query).get('savedOnly')==='1').length,1);assert.ok(calls.every(call=>call.method==='GET'));
 await close();await startServer();const afterRestart=await request();assert.equal(afterRestart.data.calculation,undefined);assert.equal(afterRestart.data.responseCache.calculationStatus,'complete');assert.equal(afterRestart.data.companies[0].summary.publicBookings,9);
});
