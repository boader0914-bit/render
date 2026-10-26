'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {createInsightAnalysis}=require('./lib/insight_analysis.cjs');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const companies=[{companyId:'cmp_own',name:'내 매장',rooms:16,regionKey:'region_one'},{companyId:'cmp_comp',name:'경쟁 업체',rooms:10,regionKey:'region_one'}];
const regions=[{id:'region_one',label:'매장 소재지',level:'local'},{id:'region_two',label:'관심 지역',level:'local'}];
const catalog={companies,regions};
const now=()=>Date.parse('2026-10-23T01:00:00Z');
const customer={relations:[{companyId:'cmp_own',kind:'own',status:'pending'},{companyId:'cmp_comp',kind:'competitor',status:'active'}],regions:[]};
const day=(date,sold=2)=>({date,total:10,sold,publicBookings:sold,phoneBookings:0,estimatedRevenue:sold*100000,collectedAt:'2026-10-23T01:00:00Z'});
const normal=(month,sold=2)=>({integrated:{status:'ready',snapshot:{}},legacyObservationView:false,current:{daily:[day(month==='2026-10'?'2026-10-23':'2026-11-01',sold)]}});
function service(companyDetail,options={}){return createInsightAnalysis({catalog:async()=>catalog,collectionResults:{companyDetail},readRegionContext:async()=>({networkAttempted:false,sources:[]}),now,...options});}

test('a missing later month keeps normal company amounts and identifies only that company and month',async()=>{
  const calls=[],analysis=service(async(id,{month})=>{
    calls.push([id,month]);if(id==='cmp_comp'&&month==='2026-11')throw Object.assign(Error('private raw path /var/data/private'),{code:'MONTH_NOT_OBSERVED'});
    return normal(month,id==='cmp_own'?2:0);
  });
  const report=await analysis.briefing(customer,'cmp_own',{stayMode:'upcoming30'}),own=report.companies[0],competitor=report.companies[1];
  assert.deepEqual(calls,[['cmp_own','2026-10'],['cmp_own','2026-11'],['cmp_comp','2026-10'],['cmp_comp','2026-11']]);
  assert.equal(own.summary.sold,4);assert.equal(own.sourceStatus,'ready');assert.equal(own.unavailable,false);
  assert.equal(competitor.summary.sold,0);assert.equal(competitor.summary.estimatedRevenue,0);assert.equal(competitor.sourceStatus,'partial');
  assert.equal(competitor.unavailable,true);assert.equal(report.dataQuality.status,'partial');assert.equal(report.dataQuality.issues.length,1);
  const issue=report.dataQuality.issues[0];
  assert.deepEqual(issue,{scope:'company',companyId:'cmp_comp',name:'경쟁 업체',month:'2026-11',period:{start:'2026-11-01',end:'2026-11-21'},code:'MONTH_NOT_OBSERVED',reason:'해당 숙박월의 수집 이력이 없습니다.'});
  assert.doesNotMatch(JSON.stringify(report),/private|\/var\/data/);
});

test('an earlier month failure does not prevent reading the following month and unknown errors are safely explained',async()=>{
  const calls=[],analysis=service(async(id,{month})=>{
    calls.push([id,month]);if(month==='2026-10')throw Object.assign(Error('private-token-123'),{code:'PRIVATE_PASSWORD_123'});return normal(month,3);
  });
  const report=await analysis.briefing({...customer,relations:[customer.relations[0]]},'cmp_own',{stayMode:'upcoming30'});
  assert.deepEqual(calls,[['cmp_own','2026-10'],['cmp_own','2026-11']]);
  assert.equal(report.companies[0].summary.sold,3);assert.equal(report.companies[0].summary.days,1);
  assert.deepEqual(report.dataQuality.issues[0].period,{start:'2026-10-23',end:'2026-10-31'});
  assert.equal(report.dataQuality.issues[0].code,'COMPANY_SOURCE_UNAVAILABLE');assert.doesNotMatch(JSON.stringify(report),/private|PASSWORD/);
});

test('updating snapshots retain observed quantities but pending and failed sources never become normal zero',async()=>{
  const analysis=service(async(id,{month})=>{
    if(id==='cmp_own')return {...normal(month,0),integrated:{status:'updating',snapshot:{}}};
    return {integrated:{status:month==='2026-10'?'failed':'pending',snapshot:null},legacyObservationView:false,current:{daily:[]}};
  });
  const report=await analysis.briefing(customer,'cmp_own',{stayMode:'upcoming30'});
  assert.equal(report.companies[0].summary.sold,0);assert.equal(report.companies[0].sourceStatus,'partial');
  assert.ok(report.companies[0].sourceIssues.every(issue=>issue.code==='COMPANY_INTEGRATION_UPDATING'));
  assert.equal(report.companies[1].summary.sold,null);assert.equal(report.companies[1].summary.estimatedRevenue,null);assert.equal(report.companies[1].sourceStatus,'unavailable');
  assert.deepEqual(report.companies[1].sourceIssues.map(issue=>issue.code),['COMPANY_INTEGRATION_FAILED','COMPANY_INTEGRATION_PENDING']);
});

test('region failures identify the region or indicator while observed zero and ordinary historical gaps remain distinct',async()=>{
  const analysis=service(async()=>({current:{daily:[]}}),{readRegionContext:async selector=>{
    if(selector.targetId==='region_one')throw Object.assign(Error('private source response'),{code:'REGION_NOT_READY'});
    return {networkAttempted:false,sources:[{key:'visitors',label:'방문자',status:'partial',rows:[{key:'count',label:'인원',status:'observed',value:0}]},
      {key:'stay',label:'체류 소비',status:'error',rows:[{key:'amount',status:'missing',value:0}]},
      {key:'missing',label:'자료 공백',status:'missing',rows:[{key:'count',status:'missing',value:null}]}]};
  }});
  const report=await analysis.briefing({...customer,relations:[],regions:regions.map(r=>({regionKey:r.id,status:'active'}))},undefined,{stayMode:'upcoming30'});
  assert.equal(report.dataQuality.status,'partial');assert.equal(report.dataQuality.issues.length,2);
  const failed=report.regions[0],partial=report.regions[1];
  assert.equal(failed.source,'datalab_saved');assert.equal(failed.networkAttempted,false);assert.equal(failed.sourceStatus,'unavailable');
  assert.equal(failed.sourceIssues[0].code,'REGION_NOT_READY');assert.equal(partial.sourceStatus,'partial');
  assert.equal(partial.sources[0].rows[0].value,0);assert.equal(partial.sources[1].rows[0].value,null);
  assert.equal(partial.sourceIssues.length,1);assert.equal(partial.sourceIssues[0].sourceKey,'stay');assert.equal(partial.sourceIssues[0].sourceName,'체류 소비');
  assert.doesNotMatch(JSON.stringify(report),/private/);
});

test('a normal briefing remains complete despite real missing stay dates and never duplicates legacy days',async()=>{
  let reads=0;const analysis=service(async()=>{reads++;return {legacyObservationView:true,current:{daily:[day('2026-10-23',0),{...day('2026-10-24',0),sold:null,publicBookings:null,missing:true}]}};});
  const report=await analysis.briefing({...customer,relations:[customer.relations[0]]},'cmp_own',{stayMode:'upcoming30'});
  assert.equal(reads,1);assert.equal(report.dataQuality.status,'complete');assert.deepEqual(report.dataQuality.issues,[]);
  assert.equal(report.companies[0].summary.days,1);assert.equal(report.companies[0].summary.sold,0);
});

test('stored months without usable room observations explain insufficient data instead of reporting zero',async()=>{
  const analysis=service(async(id,{month})=>id==='cmp_own'?normal(month,0):{
    integrated:{status:'ready',snapshot:{summary:{observedDays:0,sold:null}}},legacyObservationView:false,
    current:{daily:[{date:month==='2026-10'?'2026-10-23':'2026-11-01',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}]}
  });
  const report=await analysis.briefing(customer,'cmp_own',{stayMode:'upcoming30'}),own=report.companies[0],competitor=report.companies[1];
  assert.equal(own.sourceStatus,'ready');assert.equal(own.summary.sold,0);assert.equal(own.summary.estimatedRevenue,0);
  assert.equal(competitor.sourceStatus,'unavailable');assert.equal(competitor.summary.sold,null);assert.equal(competitor.summary.estimatedRevenue,null);
  assert.deepEqual(competitor.sourceIssues.map(issue=>issue.code),['COMPANY_OBSERVATION_INSUFFICIENT','COMPANY_OBSERVATION_INSUFFICIENT']);
  assert.deepEqual(competitor.sourceIssues.map(issue=>issue.period),[{start:'2026-10-23',end:'2026-10-31'},{start:'2026-11-01',end:'2026-11-21'}]);
  assert.equal(report.dataQuality.status,'partial');assert.equal(report.comparisons[0].commonDays,0);assert.equal(report.comparisons[0].gapPp,null);
});

test('nested region errors keep their actual month, include blocked and unavailable, and deduplicate repeated row statuses',async()=>{
  const analysis=service(async()=>({current:{daily:[]}}),{readRegionContext:async()=>({networkAttempted:false,window:{currentMonth:'2026-10'},sources:[
    {key:'visitors',label:'지역 방문자',status:'partial',rows:[{key:'count',status:'observed',value:0}],series:[
      {month:'2026-08',status:'error',rows:[{key:'count',status:'error',value:null},{key:'duplicate',status:'failed',value:null}]},
      {month:'2026-09',status:'partial',rows:[{key:'count',status:'blocked',value:null}]},
      {month:'2026-10',status:'error',rows:[{key:'count',status:'error',value:null}]}]},
    {key:'spend',label:'체류 소비',status:'ready',period:'2026-07',rows:[{key:'amount',status:'unavailable',value:null}],metrics:[{key:'amount',status:'failed',latest:{month:'2026-06',value:null,status:'failed'}}]},
    {key:'search',label:'검색 관심',status:'blocked',period:'2026-05',rows:[]}
  ]})});
  const report=await analysis.briefing({relations:[],regions:[{regionKey:'region_one',status:'active'}]},undefined,{stayMode:'upcoming30'});
  const value=report.regions[0],issues=value.sourceIssues;
  assert.equal(value.sourceStatus,'partial');assert.equal(value.sources[0].rows[0].value,0);
  assert.equal(issues.filter(i=>i.sourceKey==='visitors'&&i.month==='2026-08').length,1,'top and repeated rows in the same month share one cause');
  assert.ok(issues.some(i=>i.sourceKey==='visitors'&&i.month==='2026-09'&&i.code==='REGION_INDICATOR_BLOCKED'));
  assert.ok(issues.some(i=>i.sourceKey==='spend'&&i.month==='2026-07'&&i.code==='REGION_INDICATOR_UNAVAILABLE'));
  assert.ok(issues.some(i=>i.sourceKey==='spend'&&i.month==='2026-06'&&i.code==='REGION_INDICATOR_FAILED'));
  assert.ok(issues.some(i=>i.sourceKey==='search'&&i.month==='2026-05'&&i.code==='REGION_INDICATOR_BLOCKED'));
  assert.ok(issues.every(i=>i.month<='2026-09'));assert.equal(report.dataQuality.status,'partial');
  assert.deepEqual(issues.find(i=>i.month==='2026-08').period,{start:'2026-08-01',end:'2026-08-31'});
});

test('a large region issue list is bounded and explains that additional causes were omitted',async()=>{
  const analysis=service(async()=>({current:{daily:[]}}),{readRegionContext:async()=>({networkAttempted:false,sources:Array.from({length:40},(_,i)=>({key:'source_'+i,label:'지표 '+i,status:'unavailable',rows:[]}))})});
  const report=await analysis.briefing({relations:[],regions:[{regionKey:'region_one',status:'active'}]},undefined,{stayMode:'upcoming30'});
  assert.equal(report.regions[0].sourceStatus,'unavailable');assert.equal(report.regions[0].sourceIssues.length,32);
  assert.equal(report.regions[0].sourceIssues.at(-1).code,'REGION_ADDITIONAL_ISSUES');
  assert.equal(report.regions[0].sourceIssues.at(-1).reason,'추가 지표 오류가 있어 일부 사유만 표시합니다.');
  assert.equal(report.dataQuality.issues.length,32);
});

test('authenticated central report returns HTTP 200 with partial details without dispatching collection or exposing errors',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-report-status-'));
  const store=createInsightStore({file:path.join(directory,'fixture.sqlite')});let server;
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  const account=store.ensure({memberId:'fixture-member',username:'fixture-user',role:'b2b'});
  store.update(account.customerId,{revision:account.revision,requestKey:randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_own'}},catalog);
  const token=store.session(account.customerId),analysis=service(async(id,{month})=>{if(month==='2026-11')throw Object.assign(Error('secret-provider-body'),{code:'MONTH_NOT_OBSERVED'});return normal(month);});
  const serviceToken='fixture-service-credential-at-least-32-characters';
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>catalog,memberActive:async()=>true,analysis});
  server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://fixture')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/reports/briefing?ownId=cmp_own&stayMode=upcoming30`,{headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':token}});
  assert.equal(response.status,200);const report=await response.json();assert.equal(report.dataQuality.status,'partial');
  assert.equal(report.companies[0].summary.sold,2);assert.equal(report.dataQuality.issues[0].code,'MONTH_NOT_OBSERVED');
  assert.equal(store.requests(account.customerId).length,0);assert.doesNotMatch(JSON.stringify(report),/secret-provider-body/);
});
