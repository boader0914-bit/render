'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createConnectedServer,configuration}=require('../connected-server.cjs');
const origin='https://insight-report-persistence.example',alias='https://insight-report-alias.example',backend='https://central-report-persistence.example';
const report='/api/customer/v1/reports/briefing?ownId=cmp_own';
const day=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10),shift=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
const priorMonth=()=>new Date(Date.UTC(Number(day().slice(0,4)),Number(day().slice(5,7))-2,1)).toISOString().slice(0,7);
const historyStart=()=>new Date(Date.UTC(Number(priorMonth().slice(0,4)),Number(priorMonth().slice(5,7))-12,1)).toISOString().slice(0,7);
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-report-bff-'));
 const state={customerId:'cus_fixture_private_report_account',identityStatus:200,sourceStatus:200,version:1,catalogVersion:1,competitor:true,interest:true,unavailable:false,regionFailed:false,dayShift:0,hold:null},calls=[],generatedBase=Date.now()-120000;let server=null;
 const identity=()=>({customer:{customerId:state.customerId,accountStatus:'active',revision:1,relations:[{companyId:'cmp_own',kind:'own',status:'active'},...(state.competitor?[{companyId:'cmp_competitor',kind:'competitor',status:'active'}]:[])],regions:state.interest?[{regionKey:'region_interest',status:'active'}]:[]},companies:[{companyId:'cmp_own',name:'리포트 내 매장',version:state.catalogVersion,rooms:16,regionKey:'region_own'},...(state.competitor?[{companyId:'cmp_competitor',name:'리포트 경쟁업체',version:1,rooms:null,regionKey:'region_own'}]:[])],regions:[{id:'region_own',label:'내 매장 지역'},...(state.interest?[{id:'region_interest',label:'관심지역'}]:[])],preparations:[],csrfToken:'fixture-private-report-csrf',corrections:[{note:'fixture-private-report-correction'}],collectionAllowance:{canRequest:true}});
 const summary=()=>({days:1,supply:16,sold:state.version,reservationRate:state.version/16,publicBookings:0,phoneBookings:state.version,estimatedRevenue:null});
 const region=id=>({region:{id,label:id==='region_own'?'내 매장 지역':'관심지역'},month:priorMonth(),source:'datalab_saved',networkAttempted:false,window:{start:historyStart(),end:priorMonth(),months:12},sources:[{key:'tourism_visitors',label:'방문자',provider:'공식 지표',status:'partial',period:priorMonth(),rows:[{key:'observed_zero',label:'정상 0',value:0,unit:'명',status:'observed'},{key:'unknown',label:'미확인',value:null,unit:'명',status:'missing'}]}],availableSources:1,warnings:[]});
 const source=()=>({mode:'current_briefing',published:false,generatedAt:new Date(generatedBase+state.version*1000).toISOString(),period:{start:shift(day(),state.dayShift),end:shift(day(),29+state.dayShift),days:30},ownId:'cmp_own',companies:[{companyId:'cmp_own',name:'리포트 내 매장',rooms:16,regionKey:'region_own',kind:'own',relationStatus:'active',unavailable:state.unavailable,lastObservedDay:day(),lastObservedAt:new Date(generatedBase).toISOString(),summary:summary()},...(state.competitor?[{companyId:'cmp_competitor',name:'리포트 경쟁업체',rooms:null,regionKey:'region_own',kind:'competitor',relationStatus:'active',unavailable:false,lastObservedDay:null,lastObservedAt:null,summary:{days:0,supply:null,sold:null,reservationRate:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}}]:[])],comparisons:state.competitor?[{companyId:'cmp_competitor',name:'리포트 경쟁업체',commonDays:0,dates:[],own:summary(),competitor:{days:0,supply:null,sold:null,reservationRate:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null},gapPp:null,status:'insufficient',basis:'same_stay_date_same_kst_observation_day_within_7_days'}]:[],regions:[state.regionFailed?{region:{id:'region_own',label:'내 매장 지역'},month:'2026-09',sources:[],availableSources:0,warnings:['저장된 지역 자료를 확인하지 못했습니다.']}:region('region_own'),...(state.interest?[region('region_interest')]:[])],actions:[{key:'coverage',title:'자료 범위 확인',reason:'미확인 수치를 구분합니다.',next:'근거 확인',check:'관측 확보율',source:'저장 자료'}],definitions:['현재 상황 브리핑이며 발행된 보고서가 아닙니다.'],token:'fixture-private-report-token',customer:{customerId:state.customerId}});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url),isReport=u.pathname.endsWith('/reports/briefing');calls.push({path:u.pathname,method:options.method,search:u.search});
  if(isReport&&state.hold)await state.hold;
  if(isReport&&([...u.searchParams.keys()].some(k=>k!=='ownId')||u.searchParams.getAll('ownId').length>1))return {status:400,ok:false,headers:new Headers(),json:async()=>({error:{code:'INVALID_FIELDS'}})};
  const status=isReport?state.sourceStatus:state.identityStatus;
  return {status,ok:status===200,headers:new Headers(),json:async()=>status===200?(isReport?source():identity()):{error:{code:'FIXTURE_'+status,message:'fixture response'}}};
 };
 const start=async()=>{server=createConnectedServer({origin,origins:[alias],backend,serviceToken:'fixture-private-report-service-credential-not-real',fetchImpl,reportCacheDirectory:directory});await server.prepareReportSnapshots();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));};
 const close=async()=>{if(server){const previous=server;server=null;await previous.flushReportSnapshots();previous.closeAllConnections();await new Promise(resolve=>previous.close(resolve));}};
 t.after(async()=>{await close();const resolved=path.resolve(directory),temp=path.resolve(os.tmpdir())+path.sep;assert.ok(resolved.startsWith(temp)&&path.basename(resolved).startsWith('insight-report-bff-'));await fs.rm(resolved,{recursive:true,force:true});});
 const request=(route,{admin=false,refresh=false,method='GET',host=new URL(origin).host}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers:{Host:host,Cookie:admin?'__Host-sabun_insight_admin=fixture-private-report-admin-session':'__Host-sabun_insight_session=fixture-private-report-session',...(refresh?{'X-Insight-Refresh':'1'}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':'fixture-private-report-csrf'}:{})}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.on('error',reject);req.end(method==='POST'?'{}':undefined);
 });
 await start();return {directory,state,calls,start,close,request,sourceCalls:()=>calls.filter(c=>c.path.endsWith('/reports/briefing')).length};
}

test('restarted report bootstrap restores the same report, scope, missingness and original clocks only after fresh central authorization',async t=>{
 const f=await fixture(t),first=await f.request(report);assert.equal(first.status,200);assert.equal(first.data.companies[0].summary.publicBookings,0);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.status,200);assert.equal(f.sourceCalls(),1);assert.equal(boot.data.reportViews.length,1);
 const saved=boot.data.reportViews[0];assert.equal(saved.ownId,'cmp_own');assert.deepEqual(saved.period,first.data.period);assert.equal(saved.data.generatedAt,first.data.generatedAt);assert.equal(saved.data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(saved.data.responseCache.persisted,true);assert.equal(saved.data.responseCache.revalidationRequired,true);
 assert.equal(saved.data.published,false);assert.equal(saved.data.companies[0].summary.publicBookings,0);assert.equal(saved.data.companies[0].summary.estimatedRevenue,null);assert.equal(saved.data.companies[1].summary.sold,null);assert.equal(saved.data.regions[0].sources[0].rows[0].value,0);assert.equal(saved.data.regions[0].sources[0].rows[1].value,null);
 assert.ok(f.calls.filter(c=>c.path==='/api/insight/v1/me').length>=2);assert.ok(f.calls.every(c=>c.method==='GET'));assert.match(boot.headers['cache-control'],/private, no-store/);
 const files=await Promise.all((await fs.readdir(f.directory)).filter(file=>file.endsWith('.json')).map(file=>fs.readFile(path.join(f.directory,file),'utf8')));assert.ok(files.length>0);assert.doesNotMatch(files.join('\n'),/fixture-private|cus_fixture_private_report_account|csrfToken|collectionAllowance|customerId|corrections/);
});

test('a restored report responds before a held source and its successful replacement survives another restart',async t=>{
 const f=await fixture(t),first=await f.request(report);await f.close();await f.start();const held=deferred();f.state.hold=held.promise;
 const saved=await f.request(report);assert.equal(saved.status,200);assert.equal(saved.data.responseCache.refreshing,true);assert.equal(saved.data.generatedAt,first.data.generatedAt);assert.equal(saved.data.companies[0].summary.sold,1);
 f.state.version=2;held.resolve();f.state.hold=null;const fresh=await f.request(report,{refresh:true});assert.equal(fresh.data.companies[0].summary.sold,2);await f.close();await f.start();
 const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.reportViews[0].data.companies[0].summary.sold,2);assert.equal(boot.data.reportViews[0].data.generatedAt,fresh.data.generatedAt);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('report restoration isolates accounts, administrator/customer modes, and public aliases',async t=>{
 const f=await fixture(t);await f.request(report);await f.close();await f.start();f.state.customerId='cus_different_private_report_account';
 assert.deepEqual((await f.request('/api/customer/v1/me')).data.reportViews,[]);f.state.customerId='cus_fixture_private_report_account';
 assert.deepEqual((await f.request('/api/insight-admin/v1/customer-view/me',{admin:true})).data.reportViews,[]);
 assert.deepEqual((await f.request('/api/customer/v1/me',{host:new URL(alias).host})).data.reportViews,[]);assert.equal(f.sourceCalls(),1);
 const admin='/api/insight-admin/v1/customer-view/reports/briefing?ownId=cmp_own';assert.equal((await f.request(admin,{admin:true})).status,200);await f.close();await f.start();
 const boot=await f.request('/api/insight-admin/v1/customer-view/me',{admin:true});assert.equal(boot.data.reportViews.length,1);assert.equal(boot.data.reportViews[0].data.responseCache.persisted,true);
});

for(const change of ['competitor','interest','catalog'])test('changed '+change+' registrations or reviewed company values invalidate the report snapshot',async t=>{
 const f=await fixture(t);await f.request(report);await f.close();await f.start();if(change==='catalog')f.state.catalogVersion++;else f.state[change]=false;
 assert.deepEqual((await f.request('/api/customer/v1/me')).data.reportViews,[]);assert.equal(f.sourceCalls(),1);
});

test('an expired session or failed permission read never exposes a report from the disk',async t=>{
 const f=await fixture(t);await f.request(report);await f.close();await f.start();f.state.identityStatus=401;
 const expired=await f.request(report);assert.equal(expired.status,401);assert.equal(expired.data.companies,undefined);assert.match(expired.headers['set-cookie'][0],/Max-Age=0/);assert.equal(f.sourceCalls(),1);
 f.state.identityStatus=504;const failed=await f.request(report);assert.equal(failed.status,504);assert.equal(failed.data.companies,undefined);assert.equal(f.sourceCalls(),1);
});

for(const failure of ['http','unavailable','regionFailed'])test('failed '+failure+' report updates never replace the durable last good report',async t=>{
 const f=await fixture(t),first=await f.request(report);await f.close();await f.start();if(failure==='http')f.state.sourceStatus=503;else f.state[failure]=true;
 await f.request(report,{refresh:true});await f.close();await f.start();const boot=await f.request('/api/customer/v1/me');assert.equal(boot.data.reportViews.length,1);assert.equal(boot.data.reportViews[0].data.generatedAt,first.data.generatedAt);assert.equal(boot.data.reportViews[0].data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(boot.data.reportViews[0].data.companies[0].unavailable,false);
});

test('a different rolling window and invalid input cannot be persisted as the requested current report',async t=>{
 const f=await fixture(t);f.state.dayShift=-1;const old=await f.request(report);assert.equal(old.status,503);await f.close();await f.start();assert.deepEqual((await f.request('/api/customer/v1/me')).data.reportViews,[]);
 for(const query of ['?ownId=cmp_own&ownId=cmp_own','?month=2026-09'])assert.equal((await f.request('/api/customer/v1/reports/briefing'+query)).status,400);
});

test('customer commands invalidate a persisted report and force a fresh source instead of reviving the old copy',async t=>{
 const f=await fixture(t);await f.request(report);await f.close();await f.start();assert.equal((await f.request('/api/customer/v1/me')).data.reportViews.length,1);
 await f.request('/api/customer/v1/commands',{method:'POST'});assert.deepEqual((await f.request('/api/customer/v1/me')).data.reportViews,[]);f.state.version=2;const updated=await f.request(report);assert.equal(updated.data.companies[0].summary.sold,2);assert.equal(f.sourceCalls(),2);
});

test('report cache configuration is explicit locally and uses its own existing-disk directory in Render',()=>{
 const base={INSIGHT_SERVICE_TOKEN:'fixture-private-report-service-credential-not-real'};assert.equal(configuration(base).reportCacheDirectory,null);assert.equal(configuration({...base,RENDER:'1'}).reportCacheDirectory,path.join('/var/data','insight-report-cache'));assert.equal(configuration({...base,DATA_DIR:os.tmpdir()}).reportCacheDirectory,path.join(os.tmpdir(),'insight-report-cache'));
 assert.throws(()=>configuration({...base,INSIGHT_REPORT_CACHE_DIR:'relative-cache'}),/absolute/);assert.throws(()=>configuration({...base,INSIGHT_REPORT_CACHE_DIR:path.parse(os.tmpdir()).root}),/dedicated/);
});
