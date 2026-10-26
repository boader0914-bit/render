'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConnectedServer}=require('../connected-server.cjs');
const ORIGIN='https://admin-scope.example',BACKEND='https://central-scope.example',ADMIN='A'.repeat(43),CUSTOMER='C'.repeat(43);
const A='cus_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',B='cus_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',PREVIEW='cus_cccccccc-cccc-cccc-cccc-cccccccccccc';
const clone=value=>JSON.parse(JSON.stringify(value)),DAY=86400000;
const day=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10),shift=(value,n)=>new Date(Date.parse(value+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};},flush=()=>new Promise(resolve=>setImmediate(resolve));
async function eventually(read,ready){const deadline=Date.now()+5000;let value;do{value=await read();if(ready(value))return value;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);assert.fail('Expected customer-scoped background result did not settle: '+JSON.stringify(value));}
function identity(target){
 const letter=target===B?'b':target===A?'a':'preview',own='cmp_own_'+letter;
 return {customer:{customerId:target,username:'user-'+letter,accountKind:target===PREVIEW?'admin_preview':'customer',accountStatus:'active',revision:1,relations:[{companyId:own,kind:'own',status:'active'},{companyId:'cmp_shared',kind:'competitor',status:'active'}],regions:[{regionKey:'region_'+letter,status:'active'}]},
  companies:[{companyId:own,name:'Own '+letter,rooms:10,regionKey:'region_'+letter,version:'stable-own-'+letter},{companyId:'cmp_shared',name:'Shared competitor',rooms:10,regionKey:'region_shared',version:'stable-shared'}],
  regions:[{id:'region_'+letter,label:'Region '+letter,level:'local'},{id:'region_shared',label:'Shared region',level:'local'}],preparations:[{requestId:'request-'+letter,companyId:'cmp_shared',status:'ready',runId:'unrelated-'+letter}],
  collectionAllowance:{limit:1,used:target===A?0:1,canRequest:target===A},csrfToken:'fixture-csrf',view:{mode:'admin_customer',adminUsername:'fixture-admin',...(target===PREVIEW?{}:{readOnly:true,customerId:target,customerUsername:'user-'+letter})}};
}
function companySource(target,companyId,month,{preview=false,version=1}={}){
 const letter=target===A?'a':target===B?'b':'preview',calculationVersion='company-integrated-v4-product-max-room-reuse',runId='run_'+letter+'_'+version,collectedAt=month+'-01T00:00:00Z';
 const observation={companyId,runId,date:month+'-02',productType:'lodging',collectedAt,collectedDate:month+'-01',runQuality:'complete'};
 const daily={date:month+'-02',supply:10,total:10,sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,missing:false,partial:false,revenuePartial:false,collectedAt,collectedDate:month+'-01',sourceObservation:observation};
 const last=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),0)).toISOString().slice(0,10);
 return {result:preview?null:{companyId,runId,rooms:10,version:letter+'-'+version,quality:{status:'complete'}},request:null,
  companyDetail:{companyId,basics:{companyId,name:'Scope '+letter},integrated:{schemaVersion:1,source:'company_db_integrated',companyId,status:'ready',calculatedAt:month+'-03T00:00:00Z',calculationVersion,selectedMonth:month,
   roomBasis:{count:10,source:'db_review',reviewRequired:false},snapshot:{period:{start:month+'-01',end:last,days:Number(last.slice(-2))},summary:{supply:10,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0,partial:true},daily:[daily],
    provenance:{source:'company_db_integrated',companyId,calculationVersion,linkageStatus:'complete',runIds:[runId],selectedRunIds:[runId],observations:[observation],sourceDigest:(target===B?'b':'a').repeat(64)}}}},
  ...(preview?{calculation:{mode:'saved_only',status:'pending'},referenceLoading:true,responseCache:{state:'preview',preview:true}}:{})};
}
function regionSource(target,regionKey,month){return {region:{id:regionKey,label:'Scoped '+regionKey},month,source:'datalab_saved',networkAttempted:false,availableSources:1,
 sources:[{key:'tourism_visitors',label:'Visitors',status:'observed',rows:[{key:'visitors',value:target===A?111:222,status:'observed'}],series:[],metrics:[]}],warnings:[]};}
function reportSource(target,{preview=false,version=1}={}){
 const account=identity(target),start=day(),end=shift(start,29),sold=(target===A?1:2)*version,totals=count=>({days:30,supply:300,sold:count,reservationRate:count/300,publicBookings:count,phoneBookings:0,estimatedRevenue:null}),ownId=account.companies[0].companyId;
 return {mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{start,end,days:30},ownId,companies:account.companies.map((company,i)=>({...company,kind:i?'competitor':'own',relationStatus:'active',unavailable:false,lastObservedDay:null,lastObservedAt:null,summary:totals(sold)})),
  comparisons:[{companyId:'cmp_shared',name:'Shared competitor',commonDays:0,dates:[],own:totals(sold),competitor:totals(sold),gapPp:null,status:'insufficient',basis:'same_stay_date_same_kst_observation_day_within_7_days'}],
  regions:account.regions.filter(region=>account.customer.regions.some(relation=>relation.regionKey===region.id)).map(region=>regionSource(target,region.id,new Date(Date.UTC(+start.slice(0,4),+start.slice(5,7)-2,1)).toISOString().slice(0,7))),actions:[],definitions:['Shared scope fixture'],
  ...(preview?{calculation:{mode:'saved_only',status:'pending',oldestSourceCalculatedAt:shift(start,-1)+'T00:00:00Z',latestSourceCalculatedAt:shift(start,-1)+'T01:00:00Z'}}:{})};
}
async function fixture(t,{persistent=false}={}){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-admin-customer-scope-')),calls=[],state={session:true,status:{},preview:{},version:{},identityGate:{},companyGate:{},reportGate:{},companyFailure:{},reportFailure:{},identities:{}};
 let server;
 const fetchImpl=async(input,options={})=>{
  const url=new URL(input),headers=new Headers(options.headers),method=options.method||'GET',selected=headers.get('x-insight-customer-id'),admin=url.pathname.includes('/admin/');
  const target=admin?selected||PREVIEW:A;calls.push({path:url.pathname,query:url.search,method,target:selected||null,admin});
  const reply=(status,value)=>({status,ok:status>=200&&status<300,headers:new Headers(),json:async()=>clone(value)});
  const token=headers.get(admin?'X-Insight-Admin-Session':'X-Insight-Session');if(!state.session||token!==(admin?ADMIN:CUSTOMER))return reply(401,{error:{code:'LOGIN_REQUIRED'}});
  if(url.pathname==='/api/insight/v1/admin/auth/logout'){state.session=false;return reply(200,{ok:true});}
  if(selected&&!/^cus_[a-zA-Z0-9-]+$/.test(selected))return reply(400,{error:{code:'INVALID_CUSTOMER_ID'}});
  if(selected&&!([A,B].includes(selected)))return reply(selected===PREVIEW?403:404,{error:{code:'CUSTOMER_NOT_FOUND'}});
  if(selected&&method!=='GET')return reply(403,{error:{code:'CUSTOMER_VIEW_READ_ONLY'}});
  if(state.status[target])return reply(state.status[target],{error:{code:'ACCOUNT_DISABLED'}});
  if(url.pathname.endsWith('/me')||url.pathname.endsWith('/start')){if(state.identityGate[target])await state.identityGate[target].promise;return reply(200,state.identities[target]||identity(target));}
  const match=/\/companies\/([^/]+)\/collection$/.exec(url.pathname);
  if(match){
   const month=url.searchParams.get('month')||day().slice(0,7),saved=url.searchParams.get('savedOnly')==='1';
   if(saved&&!state.preview[target])return reply(404,{error:{code:'NOT_FOUND'}});
   if(!saved&&state.companyGate[target])await state.companyGate[target].promise;
   if(!saved&&state.companyFailure[target])return reply(state.companyFailure[target],{error:{code:'SOURCE_UNAVAILABLE'}});
   return reply(200,companySource(target,match[1],month,{preview:saved,version:state.version[target]||1}));
  }
  const region=/\/regions\/([^/]+)\/analysis$/.exec(url.pathname);if(region)return reply(200,regionSource(target,region[1],url.searchParams.get('month')||'2026-09'));
  if(url.pathname.endsWith('/reports/briefing')){
   const saved=url.searchParams.get('savedOnly')==='1';if(saved&&!state.preview[target])return reply(404,{error:{code:'NOT_FOUND'}});
   if(!saved&&state.reportGate[target])await state.reportGate[target].promise;
   if(!saved&&state.reportFailure[target])return reply(state.reportFailure[target],{error:{code:'REPORT_UNAVAILABLE'}});
   return reply(200,reportSource(target,{preview:saved,version:state.version[target]||1}));
  }
  return reply(200,{ok:true});
 };
 async function start(){server=createConnectedServer({origin:ORIGIN,backend:BACKEND,serviceToken:'fixture-admin-view-service-token-not-real',fetchImpl,companyDiagnosticsLogger:()=>{},diagnosticsLogger:()=>{},
  archiveDirectory:path.join(directory,'archives'),...(persistent?{companyCacheDirectory:path.join(directory,'company-cache'),regionCacheDirectory:path.join(directory,'region-cache'),reportCacheDirectory:path.join(directory,'report-cache')}: {})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 async function close(){if(!server)return;const current=server;server=null;await Promise.all([current.flushCompanySnapshots(),current.flushRegionSnapshots(),current.flushReportSnapshots(),current.flushArchives()]);current.closeAllConnections();await new Promise(resolve=>current.close(resolve));}
 const request=(route,{target,admin=true,method='GET',data,headers={},cookie=true}={})=>new Promise((resolve,reject)=>{
  const payload=data===undefined?undefined:JSON.stringify(data),req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:new URL(ORIGIN).host,
   ...(cookie?{Cookie:admin?'__Host-sabun_insight_admin='+ADMIN:'__Host-sabun_insight_session='+CUSTOMER}:{}),...(target===undefined?{}:{'X-Insight-Customer-Id':target}),
   ...(method==='POST'?{Origin:ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'fixture-csrf'}:{}),...headers,...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data,headers:res.headers});});});req.on('error',reject);req.end(payload);
 });
 await start();t.after(async()=>{for(const group of[state.identityGate,state.companyGate,state.reportGate])for(const gate of Object.values(group))gate.resolve();await flush();await close();assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});});
 return {calls,state,request,start,close,directory};
}
const VIEW='/api/insight-admin/v1/customer-view',COMPANY=VIEW+'/companies/cmp_shared/collection?month=2026-09',REPORT=VIEW+'/reports/briefing?stayMode=upcoming30';
test('same admin cookie selects two actual identities without start POST and forwards the target on every scoped read',async t=>{
 const f=await fixture(t);const [a,b]=await Promise.all([f.request(VIEW+'/me',{target:A}),f.request(VIEW+'/me',{target:B})]);
 assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.customer.customerId,A);assert.equal(b.data.customer.customerId,B);assert.equal(a.data.view.readOnly,true);assert.equal(b.data.view.readOnly,true);
 assert.ok(f.calls.every(call=>call.method==='GET'));assert.ok(f.calls.every(call=>[A,B].includes(call.target)));assert.ok(!f.calls.some(call=>call.path.endsWith('/start')));
});
test('concurrent shared-company reads partition identity singleflight, source work, cache and request overlays by target',async t=>{
 const f=await fixture(t),gateA=deferred(),gateB=deferred();f.state.companyGate[A]=gateA;f.state.companyGate[B]=gateB;
 const a=f.request(COMPANY,{target:A}),b=f.request(COMPANY,{target:B});await flush();gateB.resolve();gateA.resolve();
 const [one,two]=await Promise.all([a,b]);assert.equal(one.status,200);assert.equal(two.status,200);assert.equal(one.data.result.version,'a-1');assert.equal(two.data.result.version,'b-1');
 for(const [target,marker]of[[A,'a'],[B,'b']]){const cached=await f.request(COMPANY,{target});assert.equal(cached.status,200);assert.equal(cached.data.result.version,marker+'-1');assert.equal(cached.data.request.requestId,'request-'+marker);}
 const reads=f.calls.filter(call=>/\/companies\/cmp_shared\/collection$/.test(call.path)&&!call.query.includes('savedOnly'));assert.equal(reads.filter(call=>call.target===A).length,1);assert.equal(reads.filter(call=>call.target===B).length,1);
});
test('regional values and report results stay isolated while the same administrator switches customer targets',async t=>{
 const f=await fixture(t);
 for(const [target,expected]of[[A,111],[B,222],[A,111],[B,222]]){
  const region=await f.request(VIEW+'/regions/region_shared/analysis?month=2026-09',{target});assert.equal(region.status,200);assert.equal(region.data.sources[0].rows[0].value,expected);
  const report=await f.request(REPORT,{target});assert.equal(report.status,200);assert.equal(report.data.ownId,target===A?'cmp_own_a':'cmp_own_b');assert.equal(report.data.companies[0].summary.sold,target===A?1:2);
 }
});
test('saved previews and late background updates cannot overwrite the other customer scope',async t=>{
 const f=await fixture(t);for(const target of[A,B]){f.state.preview[target]=true;f.state.companyGate[target]=deferred();}
 const [a,b]=await Promise.all([f.request(COMPANY,{target:A}),f.request(COMPANY,{target:B})]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.responseCache.state,'preview');assert.equal(b.data.responseCache.state,'preview');
 assert.equal(a.data.companyDetail.basics.name,'Scope a');assert.equal(b.data.companyDetail.basics.name,'Scope b');
 f.state.companyFailure[A]=503;f.state.companyGate[A].resolve();f.state.version[B]=2;f.state.companyGate[B].resolve();await flush();await flush();
 const finalB=await eventually(()=>f.request(COMPANY,{target:B}),value=>value.data.result?.version==='b-2');assert.equal(finalB.status,200);assert.equal(finalB.data.result.version,'b-2');
 const failedA=await eventually(()=>f.request(COMPANY,{target:A}),value=>value.data.responseCache?.refreshFailed===true);assert.equal(failedA.status,200);assert.equal(failedA.data.result,null);assert.equal(failedA.data.companyDetail.basics.name,'Scope a');assert.equal(failedA.data.responseCache.refreshFailed,true);
});
test('saved report calculation failure and completion remain separate for concurrent target customers',async t=>{
 const f=await fixture(t);for(const target of[A,B]){f.state.preview[target]=true;f.state.reportGate[target]=deferred();}
 const [a,b]=await Promise.all([f.request(REPORT,{target:A}),f.request(REPORT,{target:B})]);assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.responseCache.state,'preview');assert.equal(b.data.responseCache.state,'preview');
 f.state.reportFailure[A]=503;f.state.reportGate[A].resolve();f.state.version[B]=3;f.state.reportGate[B].resolve();await flush();await flush();
 const [failed,ready]=await Promise.all([eventually(()=>f.request(REPORT,{target:A}),value=>value.data.responseCache?.refreshFailed===true),eventually(()=>f.request(REPORT,{target:B}),value=>value.data.companies?.[0]?.summary?.sold===6&&!value.data.responseCache?.refreshing)]);assert.equal(failed.status,200);assert.equal(ready.status,200);assert.equal(failed.data.ownId,'cmp_own_a');assert.equal(failed.data.responseCache.refreshFailed,true);
 assert.equal(ready.data.ownId,'cmp_own_b');assert.equal(ready.data.companies[0].summary.sold,6);assert.equal(ready.data.responseCache.refreshFailed,false);
});
test('bootstrap snapshots and persistent cache restore remain bound to the selected customer',async t=>{
 const f=await fixture(t,{persistent:true});for(const target of[A,B])await f.request(COMPANY,{target});await f.close();await f.start();
 for(const [target,letter]of[[B,'b'],[A,'a']]){
  const state=await f.request(VIEW+'/me',{target,headers:{'X-Insight-Bootstrap-View':'company','X-Insight-Bootstrap-Company':'cmp_shared'}});assert.equal(state.status,200);assert.equal(state.data.customer.customerId,target);
  assert.equal(state.data.companyViews.length,1);assert.equal(state.data.companyViews[0].data.result.version,letter+'-1');
 }
});
test('archive records use the chosen actual customer owner and another customer cannot retrieve them',async t=>{
 const f=await fixture(t);await f.request(COMPANY,{target:A});const own=await f.request(VIEW+'/archives',{target:A});assert.equal(own.status,200);assert.equal(own.data.records.length,1);const id=own.data.records[0].id;
 assert.equal((await f.request(VIEW+'/archives',{target:B})).data.records.length,0);assert.equal((await f.request(VIEW+'/archives/'+id,{target:B})).status,404);
 const record=await f.request(VIEW+'/archives/'+id,{target:A});assert.equal(record.status,200);assert.equal(record.data.record.identity.companyId,'cmp_shared');assert.deepEqual(record.data.record.identity.runIds,['run_a_1']);
});
test('selected administrator reads the actual customer ordinary reviews and published reports while other targets and own preview remain isolated',async t=>{
 const f=await fixture(t),normal='/api/customer/v1/archives';
 const reviewed=await f.request(normal+'/reviews',{admin:false,method:'POST',data:{companyId:'cmp_own_a',month:'2026-09'}});assert.equal(reviewed.status,200);
 const reviewId=reviewed.data.record.id;
 const published=await f.request(normal+'/reports',{admin:false,method:'POST',data:{reportType:'monthly',anchorDate:'2026-09-24',ownId:'cmp_own_a',requestKey:'customer-published-report-0001'}});assert.equal(published.status,200);
 const reportId=published.data.record.id;
 const actualList=await f.request(VIEW+'/archives',{target:A});assert.equal(actualList.status,200);assert.ok(actualList.data.records.some(row=>row.id===reviewId));assert.ok(actualList.data.records.some(row=>row.id===reportId));
 for(const id of[reviewId,reportId]){
  const viewed=await f.request(VIEW+'/archives/'+id,{target:A});assert.equal(viewed.status,200);assert.equal(viewed.data.record.id,id);
  assert.equal((await f.request(VIEW+'/archives/'+id,{target:B})).status,404);
  assert.equal((await f.request(VIEW+'/archives/'+id)).status,404);
 }
 const preview=await f.request(VIEW+'/archives');assert.equal(preview.status,200);assert.equal(preview.data.records.length,0);
 const retained=await f.request(normal+'/reports',{admin:false,method:'POST',data:{reportType:'monthly',anchorDate:'2026-09-24',ownId:'cmp_own_a',requestKey:'customer-published-report-0001'}});assert.equal(retained.status,200);assert.equal(retained.data.created,false);assert.equal(retained.data.record.id,reportId);
});
for(const operation of['list','get'])for(const change of['session','member','relation'])test('selected archive '+operation+' revalidates '+change+' after asynchronous disk access',async t=>{
 const f=await fixture(t),saved=await f.request('/api/customer/v1/archives/reviews',{admin:false,method:'POST',data:{companyId:'cmp_shared',month:'2026-09'}});assert.equal(saved.status,200);
 const id=saved.data.record.id;await f.close();await f.start();
 const entered=deferred(),release=deferred(),originalOpen=fs.open,archiveDirectory=path.join(f.directory,'archives');let held=false,pending,timer;
 const mock=t.mock.method(fs,'open',async(file,...args)=>{
  if(!held&&typeof file==='string'&&path.dirname(file)===archiveDirectory&&/^archive-.+\.json$/.test(path.basename(file))){held=true;entered.resolve();await release.promise;}
  return originalOpen(file,...args);
 });
 const start=f.calls.length;
 try{
  pending=f.request(VIEW+'/archives'+(operation==='get'?'/'+id:''),{target:A});
  await Promise.race([entered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Archive IO barrier was not reached')),5000);})]);clearTimeout(timer);
  assert.ok(f.calls.slice(start).some(call=>call.path.endsWith('/customer-view/me')&&call.target===A),'initial authorization must precede disk access');
  if(change==='session')f.state.session=false;
  else if(change==='member')f.state.status[A]=403;
  else {const changed=identity(A);changed.customer.revision++;changed.customer.relations=changed.customer.relations.filter(row=>row.companyId!=='cmp_shared');changed.companies=changed.companies.filter(row=>row.companyId!=='cmp_shared');f.state.identities[A]=changed;}
  release.resolve();const reply=await pending;assert.equal(reply.status,{session:401,member:403,relation:409}[change]);
  if(change==='relation')assert.equal(reply.data.error.code,'CUSTOMER_VIEW_SCOPE_CHANGED');
  assert.equal(reply.data.record,undefined);assert.equal(reply.data.records,undefined);assert.doesNotMatch(JSON.stringify(reply.data),/run_a_1/);
  assert.ok(f.calls.slice(start).filter(call=>call.path.endsWith('/customer-view/me')&&call.target===A).length>=2,'selected customer is freshly authorized after the disk result');
 }finally{clearTimeout(timer);release.resolve();await pending?.catch(()=>{});mock.mock.restore();}
});
test('unselected administrator preview continues to read its own saved archive after restart',async t=>{
 const f=await fixture(t),saved=await f.request(VIEW+'/archives/reviews',{method:'POST',data:{companyId:'cmp_shared',month:'2026-09'}});assert.equal(saved.status,200);
 const id=saved.data.record.id;await f.close();await f.start();
 const list=await f.request(VIEW+'/archives');assert.equal(list.status,200);assert.equal(list.data.records.length,1);assert.equal(list.data.records[0].id,id);
 const detail=await f.request(VIEW+'/archives/'+id);assert.equal(detail.status,200);assert.deepEqual(detail.data.record.identity.runIds,['run_preview_1']);
 assert.equal((await f.request(VIEW+'/archives/'+id,{target:A})).status,404);
});
test('targeted POSTs including local archives are read-only and cannot start, mutate, collect or publish',async t=>{
 const f=await fixture(t);for(const route of['/start','/commands','/regions/region_a/preparation','/companies/cmp_shared/recurring-collection','/archives/reviews','/archives/reports','/unknown-mutation']){
  const reply=await f.request(VIEW+route,{target:A,method:'POST',data:{}});assert.equal(reply.status,403,route);assert.equal(reply.data.error.code,'CUSTOMER_VIEW_READ_ONLY',route);
 }assert.ok(f.calls.every(call=>call.method==='GET'),'no target mutation may reach central');
});
test('missing cookie, expiry and logout deny cached company, region, report and archive contents',async t=>{
 const f=await fixture(t);await f.request(COMPANY,{target:A});await f.request(REPORT,{target:A});
 assert.equal((await f.request(COMPANY,{target:A,cookie:false})).status,401);
 const logout=await f.request('/api/insight-admin/v1/auth/logout',{method:'POST',data:{}});assert.equal(logout.status,200);
 for(const route of[VIEW+'/me',COMPANY,VIEW+'/regions/region_shared/analysis?month=2026-09',REPORT,VIEW+'/archives']){
  const reply=await f.request(route,{target:A});assert.equal(reply.status,401,route);assert.equal(reply.data.result,undefined);assert.equal(reply.data.companies,undefined);assert.equal(reply.data.records,undefined);
 }
});
test('normal customer header cannot select another customer and admin management routes do not forward it',async t=>{
 const f=await fixture(t),normal=await f.request('/api/customer/v1/me',{admin:false,target:B});assert.ok([200,400,403].includes(normal.status));
 if(normal.status===200)assert.equal(normal.data.customer.customerId,A);
 assert.ok(f.calls.filter(call=>!call.admin).every(call=>call.target===null));
 const count=f.calls.length,management=await f.request('/api/insight-admin/v1/me',{target:B});assert.ok([200,400].includes(management.status));
 if(management.status===400)assert.equal(f.calls.length,count);else assert.equal(f.calls.at(-1).target,null);
});
test('invalid targets are rejected and unselected preview preserves the previous writable behavior',async t=>{
 const f=await fixture(t);assert.equal((await f.request(VIEW+'/me',{target:'bad/id'})).status,400);assert.equal((await f.request(VIEW+'/me',{target:'cus_00000000-0000-0000-0000-000000000000'})).status,404);
 const started=await f.request(VIEW+'/start',{method:'POST',data:{}});assert.equal(started.status,200);assert.equal(started.data.customer.customerId,PREVIEW);
 assert.equal((await f.request(VIEW+'/commands',{method:'POST',data:{}})).status,200);
});
