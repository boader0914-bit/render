'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {createConnectedServer,configuration}=require('../connected-server.cjs');
const origin='https://insight-archive.test',backend='https://central-archive.test',audience='["https://insight-archive.test","customer"]';
function source(companyId,month,version=1){
  const runId='run_original_'+version,calculationVersion='company-integrated-v1',collectedAt=month+'-01T00:00:00Z';
  const observation={companyId,runId,date:month+'-02',productType:'lodging',collectedAt,collectedDate:month+'-01',runQuality:'complete'};
  const daily={date:month+'-02',supply:10,total:10,sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,missing:false,partial:false,revenuePartial:false,collectedAt,collectedDate:month+'-01',sourceObservation:observation};
  return {result:{companyId,runId:'unrelated_latest',quality:{status:'complete'},privateRaw:'PRIVATE-RAW'},companyDetail:{companyId,basics:{companyId,name:'검수 업체'},integrated:{schemaVersion:1,source:'company_db_integrated',companyId,status:'ready',calculatedAt:month+'-03T00:00:00Z',calculationVersion,selectedMonth:month,roomBasis:{count:10,source:'db_review',reviewRequired:false},snapshot:{period:{start:month+'-01',end:month+'-31',days:31},summary:{supply:10,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0,partial:true},daily:[daily],provenance:{source:'company_db_integrated',companyId,calculationVersion,linkageStatus:'complete',runIds:[runId],selectedRunIds:[runId],observations:[observation],sourceDigest:String(version).repeat(64)}}}},csrfToken:'PRIVATE-TOP-CSRF'};
}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-archive-http-'));
  let server;const state={customerId:'cus_archive_test',allowed:['cmp_own'],identityStatus:200,sourceStatus:200,sourceVersion:1,preview:false},calls=[];
  const identity=()=>({customer:{customerId:state.customerId,accountStatus:'active',revision:1,relations:state.allowed.map(companyId=>({companyId,kind:companyId==='cmp_own'?'own':'competitor',status:'active'}))},companies:state.allowed.map(companyId=>({companyId,name:'검수 업체'})),csrfToken:'fixture-csrf'});
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url),headers=new Headers(options.headers);calls.push({path:parsed.pathname,method:options.method});
    const authenticated=headers.get('X-Insight-Session')||headers.get('X-Insight-Admin-Session');
    const match=/\/companies\/([^/]+)\/collection$/.exec(parsed.pathname),status=!authenticated?401:match?state.sourceStatus:state.identityStatus;
    return {status,ok:status===200,headers:new Headers(),json:async()=>status===200?(match?{...source(match[1],parsed.searchParams.get('month')||'2026-10',state.sourceVersion),...(state.preview?{responseCache:{state:'preview'}}:{})}:identity()):{error:{code:'FIXTURE_'+status,message:'fixture'}}};
  };
  const start=async()=>{server=createConnectedServer({origin,backend,serviceToken:'fixture-service-token-32-characters-long',fetchImpl,archiveDirectory:directory});await server.prepareArchives();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
  const close=async()=>{if(server){const previous=server;server=null;await previous.flushArchives();previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));}};
  t.after(async()=>{await close();assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('insight-archive-http-'));await fs.rm(directory,{recursive:true,force:true});});
  const request=(route,{admin=false,method='GET',data,cookie=true,csrf='fixture-csrf',requestOrigin=origin}={})=>new Promise((resolve,reject)=>{
    const payload=data===undefined?undefined:JSON.stringify(data),req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:new URL(origin).host,...(cookie?{Cookie:admin?'__Host-sabun_insight_admin=fixture-admin-session':'__Host-sabun_insight_session=fixture-session'}:{}),...(method==='POST'?{Origin:requestOrigin,'Content-Type':'application/json','X-CSRF-Token':csrf}:{}),...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.end(payload);
  });
  await start();return {directory,state,calls,request,start,close};
}
test('Render archive uses its persistent root independently of the legacy cache DATA_DIR',()=>{
 const c=configuration({INSIGHT_SERVICE_TOKEN:'x'.repeat(32),RENDER:'true',DATA_DIR:'/var/data/legacy'});assert.equal(c.archiveDirectory.replaceAll('\\','/'),'/var/data/insight-archive');assert.equal(c.companyCacheDirectory.replaceAll('\\','/'),'/var/data/legacy/insight-company-cache');
 assert.throws(()=>configuration({INSIGHT_SERVICE_TOKEN:'x'.repeat(32),INSIGHT_ARCHIVE_DIR:'/'}),/dedicated/);
});
test('normal saved company reads archive once; source IDs survive HTTP retrieval and process restart',async t=>{
 const f=await fixture(t),route='/api/customer/v1/companies/cmp_own/collection?month=2026-10';assert.equal((await f.request(route)).status,200);
 let listed=await f.request('/api/customer/v1/archives');assert.equal(listed.status,200);assert.equal(listed.data.records.length,1);const id=listed.data.records[0].id;
 const record=(await f.request('/api/customer/v1/archives/'+id)).data.record;assert.equal(record.payload.daily[0].sold,0);assert.equal(record.payload.daily[0].estimatedRevenue,0);assert.deepEqual(record.identity.runIds,['run_original_1']);assert.equal(record.identity.calculationVersion,'company-integrated-v1');assert.equal(record.payload.review.basis,'automatic_validation');
 assert.doesNotMatch(JSON.stringify(record),/PRIVATE-|unrelated_latest|csrfToken/);await f.request(route);assert.equal((await f.request('/api/customer/v1/archives')).data.records.length,1);
 await f.close();await f.start();listed=await f.request('/api/customer/v1/archives');assert.equal(listed.data.records[0].id,id);assert.equal((await f.request('/api/customer/v1/archives/'+id)).data.record.payload.daily[0].sold,0);
 assert.ok(f.calls.every(call=>call.method==='GET'),'only central saved data is read; no collection is executed');
});
test('explicit review and publication require current login, current company access, origin and CSRF',async t=>{
 const f=await fixture(t),base='/api/customer/v1/archives';
 assert.equal((await f.request(base,{cookie:false})).status,401);
 for(const options of [{csrf:''},{csrf:'wrong'},{requestOrigin:'https://other.test'}])assert.equal((await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'},...options})).status,403);
 assert.equal((await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_other',month:'2026-10'}})).status,404);
 const captured=await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'}});assert.equal(captured.status,200);assert.equal(captured.data.status,'stored');
 const id=captured.data.record.id;f.state.allowed=[];assert.equal((await f.request(base)).data.records.length,0);assert.equal((await f.request(base+'/'+id)).status,404);
});
test('weekly and monthly publication is frozen, linked to exact saved sources and scoped to customer or administrator',async t=>{
 const f=await fixture(t),base='/api/customer/v1/archives';await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'}});
 const input={reportType:'monthly',anchorDate:'2026-10-24',requestKey:'publish-request-00000001',ownId:'cmp_own'};
 const published=await f.request(base+'/reports',{method:'POST',data:input});assert.equal(published.status,200);assert.equal(published.data.created,true);
 const id=published.data.record.id,first=(await f.request(base+'/'+id)).data.record;assert.equal(first.payload.period.days,31);assert.equal(first.payload.quality.status,'partial');assert.equal(first.payload.companies[0].summary.sold,null);assert.equal(first.payload.companies[0].summary.knownSold,0);assert.deepEqual(first.identity.sourceLinks[0].runIds,['run_original_1']);
 f.state.sourceVersion=2;await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'}});const retry=await f.request(base+'/reports',{method:'POST',data:input});assert.equal(retry.data.created,false);assert.equal(retry.data.record.id,id);assert.deepEqual((await f.request(base+'/'+id)).data.record,first);
 assert.equal((await f.request(base+'/reports',{method:'POST',data:{...input,reportType:'weekly',requestKey:'publish-request-empty-week'}})).status,409,'an entirely unobserved stay week cannot be issued');
 const weekly=await f.request(base+'/reports',{method:'POST',data:{...input,reportType:'weekly',anchorDate:'2026-10-02',requestKey:'publish-request-00000002'}});assert.equal(weekly.status,200);assert.deepEqual(weekly.data.record.period,{start:'2026-09-28',end:'2026-10-04',days:7});
 assert.equal((await f.request('/api/insight-admin/v1/customer-view/archives',{admin:true})).data.records.length,0);
 f.state.customerId='cus_other';assert.equal((await f.request(base)).data.records.length,0);assert.equal((await f.request(base+'/'+id)).status,404);
});
test('failed or pending source is not archived as normal, and invalid query cannot bypass authentication',async t=>{
 const f=await fixture(t),base='/api/customer/v1/archives';f.state.sourceStatus=503;
 assert.equal((await f.request(base+'/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'}})).status,503);assert.equal((await f.request(base)).data.records.length,0);
 assert.equal((await f.request(base+'?kind=secret')).status,400);assert.equal((await f.request(base+'?kind=secret',{cookie:false})).status,401);
 assert.equal((await f.request(base+'/reports',{method:'POST',data:{reportType:'monthly',anchorDate:'2026-10-24',requestKey:'publish-request-00000001',payload:{sold:999}}})).status,400);
});
test('full-source preview markers are rejected before durable persistence or automatic capture',async t=>{
 const f=await fixture(t);f.state.preview=true;assert.equal((await f.request('/api/customer/v1/companies/cmp_own/collection?month=2026-10')).status,503);
 assert.equal((await f.request('/api/customer/v1/archives')).data.records.length,0);
 assert.equal((await f.request('/api/customer/v1/archives/reviews',{method:'POST',data:{companyId:'cmp_own',month:'2026-10'}})).status,409);
});
