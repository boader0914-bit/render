'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createInsightRegionHistory,monthsEnding,metricsFor,change}=require('./lib/insight_region_history.cjs');
const {createInsightAnalysis,projectRegion}=require('./lib/insight_analysis.cjs');
const region={id:'r0',label:'가상 지역',level:'local'},catalog={companies:[],regions:[region]};
const now=()=>Date.parse('2026-10-03T00:00:00Z');
const request={type:'region',targetId:'r0',month:'2026-09'};
const series=()=>monthsEnding('2026-09',24).map((m,i)=>({yearMonth:m.replace('-',''),status:'complete',averageDailyVisitors:i,visitorDays:i*30,stayOverall:i,spendOverall:i,values:{service:i,culture:i,visitor:i,spend:i,international:i},collectedAt:'2026-10-02T01:00:00Z'}));
function fixture(extra={}) {
  const calls=[];const result=()=>({region:{regionKey:'r0'},regions:[{regionKey:'r0',series:series()}],series:series(),collection:{networkAttemptedMonths:0},source:{referenceUrl:'https://example.org/source'}});
  const tourismCollector=Object.fromEntries(['collectVisitorHistory','collectDemandStrengthHistory','collectResourceDemandHistory','collectDiversityHistory'].map(method=>[method,async input=>{calls.push(input);return result();}]));
  const trend=async input=>({regionKey:'r0',month:'2026-09',keyword:'가상글램핑',partialMonth:false,startDate:input.months===24?'2024-10-01':'2025-10-01',endDate:'2026-09-30',status:'ready',series:monthsEnding('2026-09',input.months||12).map((m,i)=>({period:`${m}-01`,value:i,status:'observed'}))});
  const options={now,tourismCollector,searchTrendService:{get:trend},readMonthlyContext:async r=>({sources:[{key:'kosis_population',label:'인구',period:'202608',periodType:'M',rows:[{key:'total',value:10,status:'observed'}]},...(r.month==='2026-10'?[{key:'naver_search_trend',rows:[{key:'2026-09-01',value:99,status:'observed'},{key:'2026-10-01',value:9,status:'observed'}]}]:[])],networkAttempted:false}),...extra};
  return {calls,options,read:createInsightRegionHistory(options)};
}
test('closed 12-month display retains 24 exact monthly observations and current partial separately without provider requests',async()=>{
  const f=fixture(),r=await f.read(request,catalog);
  assert.deepEqual(r.window,{start:'2025-10',end:'2026-09',months:12,storageStart:'2024-10',storageMonths:24,currentMonth:'2026-10'});
  assert.equal(r.sources[0].period,'202608');assert.equal(r.sources[1].series.length,24);
  assert.equal(r.sources[1].series[0].rows[0].value,0);
  assert.equal(r.sources[1].metrics[0].latest.value,23);assert.equal(r.sources[1].metrics[0].observedMonths,12);
  assert.equal(r.sources[1].metrics[0].yoy.value,(23-11)/11*100);
  assert.equal(r.interim.sources[0].rows.length,1);assert.equal(r.interim.sources[0].rows[0].key,'2026-10-01');
  assert.equal(f.calls.length,4);assert.ok(f.calls.every(i=>i.months===24&&!i.collectMissing&&!i.refresh&&!i.force));
  const publicResult=projectRegion(region,request.month,r);assert.equal(publicResult.sources[1].series.length,24);
});
test('missing middle months break comparisons; observed zero survives and zero baseline is not infinite',()=>{
  const rows=monthsEnding('2026-09',24).map(month=>({month,rows:[{key:'v',value:0}]}));
  rows[22].rows[0].value=null;rows[23].rows[0].value=10;
  const [m]=metricsFor(rows,[['v','방문자','명']],{start:'2025-10',end:'2026-09'});
  assert.equal(m.observedMonths,11);assert.equal(m.mom.value,null);assert.equal(m.yoy.kind,'zero_baseline');
  assert.equal(change(40,20,'지수').value,20);assert.equal(change(40,20,'명').value,100);
});
test('search trend fallback uses one saved 12-month normalization, never stitches independent query windows',async()=>{
  const requests=[];const f=fixture({searchTrendService:{get:async input=>{requests.push(input);return {regionKey:'r0',month:'2026-09',startDate:input.months===24?'2024-10-01':'2025-10-01',endDate:'2026-09-30',keyword:'가상글램핑',partialMonth:false,status:input.months===24?'missing':'ready',series:input.months===24?[]:monthsEnding('2026-09',12).map(m=>({period:`${m}-01`,value:80,status:'observed'}))};}}});
  const r=await f.read(request,catalog),s=r.sources.at(-1);
  assert.equal(requests.length,2);assert.equal(s.metrics[0].observedMonths,12);assert.equal(s.metrics[0].yoy.value,null);assert.equal(s.metrics[0].mom.value,0);
  assert.equal(s.normalizationPeriod,'2025-10-01 ~ 2026-09-30');
});
test('wrong regional identity, failed and duplicated months do not become observed values',async()=>{
  const f=fixture();f.options.tourismCollector.collectVisitorHistory=async()=>({regions:[{regionKey:'other',series:series()}]});
  f.options.tourismCollector.collectDemandStrengthHistory=async()=>({region:{regionKey:'r0'},series:[...series().map((p,i)=>i===23?{...p,status:'failed',spendOverall:0}:p),series()[22]]});
  const r=await f.read(request,catalog);
  assert.ok(r.sources[1].series.every(p=>p.rows.every(v=>v.value===null)));
  assert.equal(r.sources[2].series[23].rows[1].value,null);assert.equal(r.sources[2].series[22].rows[1].value,null);
});
test('cache-only violations propagate rather than masquerading as missing observations',async()=>{
  const f=fixture();f.options.tourismCollector.collectVisitorHistory=async()=>({networkAttempted:true});
  await assert.rejects(f.read(request,catalog),/INSIGHT_HISTORY_MUST_BE_CACHE_ONLY/);
});
test('history requests and preparation are scoped to registered regions, completed months, and safe job fields',async()=>{
  let starts=0;const f=fixture(),customer={relations:[],regions:[{regionKey:'r0',status:'active'}]};
  const service=createInsightAnalysis({catalog:async()=>catalog,now,readRegionContext:f.read,regionPreparation:{start:async input=>{starts++;assert.equal(input.cutoffDate,'2026-10-03');return {id:'job',status:'queued',secret:'never return',steps:[{key:'visitors',label:'방문자',status:'queued',raw:'private'}]};},get:async()=>null}});
  await assert.rejects(service.preparation({...customer,regions:[]},'r0','2026-09',true),{code:'NOT_FOUND'});
  await assert.rejects(service.preparation(customer,'r0','2026-10',true),{code:'INVALID_MONTH'});
  assert.equal(starts,0);const r=await service.preparation(customer,'r0','2026-09',true);
  assert.equal(starts,1);assert.equal(JSON.stringify(r).includes('private'),false);assert.equal(JSON.stringify(r).includes('secret'),false);
  assert.equal((await service.region(customer,'r0')).window.start,'2025-10');
});
