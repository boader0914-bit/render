'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCollectionResults}=require('./lib/insight_collection_results.cjs');
const {createInsightAnalysis}=require('./lib/insight_analysis.cjs');
const {createAnalyticalWorkScheduler}=require('./lib/analytical_work_scheduler.cjs');
const {fixture}=require('./fixtures/insight_briefing_period_fixture.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function source(id,month,rows) {
  const value={companyId:id,status:'ready',selectedMonth:month,months:[{month:'2026-09'},{month:'2026-10'},{month:'2026-11'}],
    calculatedAt:'2026-10-26T01:00:00Z',calculationVersion:'company-integrated-v4-product-max-room-reuse',sourceRevision:'test_revision',roomBasis:{count:16,source:'db_review'},
    snapshot:{target:{type:'company',id},request:{type:'company',targetId:id,month},period:{start:month+'-01',end:month+'-30',cutoffDate:'2026-10-26',days:30},
      summary:{lodging:{sold:0}},daily:rows.map(row=>({date:row.date,lodging:{supply:row.total,sold:row.sold,publicBookings:row.publicBookings,phoneBookings:row.phoneBookings,
        estimatedRevenue:row.estimatedRevenue,publicRevenue:row.publicRevenue,phoneRevenue:row.phoneRevenue,revenuePartial:row.revenuePartial===true,knownPartialRevenue:row.knownPartialRevenue,
        coveredCompanyDays:row.missing?0:1,missingCompanyDays:row.missing?1:0}})),
      sources:{runIds:['test_run'],observations:rows.filter(row=>row.collectedAt).map(row=>({companyId:id,runId:'test_run',date:row.date,productType:'lodging',collectedAt:row.collectedAt,collectedDate:row.collectedAt.slice(0,10),runQuality:'complete',privatePayload:'PRIVATE_SOURCE_BODY'}))},privateRawPath:'PRIVATE_RAW_PATH'}};
  return value;
}
function readers({runWork,readIntegrated:customIntegrated}={}) {
  const f=fixture(),calls={abc:0,evidence:0,integrated:[],leases:0},values=new Map(f.catalog.companies.flatMap(company=>Object.entries(f.rows).map(([month,rows])=>[company.companyId+'|'+month,source(company.companyId,month,rows)])));
  const reader=createCollectionResults({catalog:async()=>clone(f.catalog),runWork:runWork||((operation)=>{calls.leases++;return operation();}),
    readEvidence:async()=>{calls.evidence++;assert.fail('report monthly reads must not read collection evidence');},
    readCompanyDetail:async id=>{calls.abc++;return {company:{companyId:id},salesHistory:{current:{daily:[]}},observationFlow:{privateValue:'PRIVATE_ABC_HISTORY'}};},
    readIntegratedMonths:async()=>[{month:'2026-09'},{month:'2026-10'},{month:'2026-11'}],
    readIntegrated:async(id,options)=>{calls.integrated.push({id,options:clone(options)});return customIntegrated?customIntegrated(id,options,values):values.get(id+'|'+options.month);}});
  return {f,calls,values,reader};
}

test('the dedicated month view matches normal integrated detail values with no basic-info, channel, evidence or raw-history reads',async()=>{
  const r=readers(),before=JSON.stringify([...r.values]);
  const projected=await r.reader.briefingMonth('own',{month:'2026-09'});
  assert.equal(r.calls.abc,0);assert.equal(r.calls.evidence,0);assert.equal(r.calls.leases,0);
  assert.deepEqual(r.calls.integrated,[{id:'own',options:{month:'2026-09',knownMonthsOnly:true}}]);
  const ordinary=await r.reader.companyDetail('own',{month:'2026-09'});
  assert.deepEqual(projected.current,ordinary.current);assert.deepEqual(projected.integrated,ordinary.integrated);assert.equal(r.calls.abc,1);
  assert.equal(JSON.stringify([...r.values]),before);assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_|basics|channels|observationFlow/);
  assert.equal(projected.current.daily.find(row=>row.date==='2026-09-12').sold,0);
  assert.equal(projected.current.daily.find(row=>row.date==='2026-09-01').sold,null);
});

test('the full all-period report prefers integrated-only month views and preserves the exact prior totals and period tree',async()=>{
  const light=readers(),old=readers(),lightBefore=JSON.stringify([...light.values]);
  const result=await createInsightAnalysis({...light.f.args,collectionResults:light.reader}).briefing(light.f.customer,'own');
  const original=await createInsightAnalysis({...old.f.args,collectionResults:{companyDetail:old.reader.companyDetail,companyMonths:old.reader.companyMonths}}).briefing(old.f.customer,'own');
  delete result.generatedAt;delete original.generatedAt;
  assert.deepEqual(result,original);assert.equal(light.calls.abc,0);assert.equal(light.calls.evidence,0);assert.equal(light.calls.leases,0);
  assert.equal(old.calls.abc,6,'the prior path reads ABC for every company-month');assert.equal(light.calls.integrated.length,6);
  assert.equal(JSON.stringify([...light.values]),lightBefore);assert.equal(result.period.start,'2026-09-10');assert.equal(result.period.end,'2026-11-03');
});

test('scope validation precedes integrated reads and a foreign company/month cannot supply normal quantities',async()=>{
  const r=readers();assert.equal(await r.reader.briefingMonth('unregistered',{month:'2026-09'}),null);assert.equal(r.calls.integrated.length,0);
  await assert.rejects(createInsightAnalysis({...r.f.args,collectionResults:r.reader}).briefing(r.f.customer,'unregistered'),{code:'NOT_FOUND'});assert.equal(r.calls.integrated.length,0);
  r.values.set('own|2026-09',source('foreign','2026-09',r.f.rows['2026-09']));
  const foreign=await r.reader.briefingMonth('own',{month:'2026-09'});assert.equal(foreign.integrated.snapshot,null);assert.deepEqual(foreign.current,{summary:null,daily:[]});
  r.values.set('own|2026-09',source('own','2026-10',r.f.rows['2026-10']));
  const wrongMonth=await r.reader.briefingMonth('own',{month:'2026-09'});assert.equal(wrongMonth.integrated.snapshot,null);assert.deepEqual(wrongMonth.current.daily,[]);
  assert.equal(r.calls.abc,0);assert.equal(r.calls.evidence,0);
});

test('normal month revalidation never substitutes saved-preview freshness and preserves current failures or updating state',async()=>{
  const r=readers();r.values.get('own|2026-09').status='refreshing';
  assert.equal((await r.reader.briefingMonth('own',{month:'2026-09'})).integrated.status,'updating');
  r.values.get('own|2026-09').status='failed';
  const failed=await r.reader.briefingMonth('own',{month:'2026-09'});assert.equal(failed.integrated.status,'failed');assert.ok(failed.current.daily.length>0);
  assert.ok(r.calls.integrated.every(call=>!Object.hasOwn(call.options,'savedPreview')&&call.options.knownMonthsOnly===true));
  assert.equal(r.calls.integrated.length,2,'settled results are freshly read, never retained as a normal-source memo');
  const unavailable=readers({readIntegrated:async()=>{throw Object.assign(Error('missing'),{code:'month_not_observed'});}});
  await assert.rejects(unavailable.reader.briefingMonth('own',{month:'2026-08'}),{code:'MONTH_NOT_OBSERVED',statusCode:400});assert.equal(unavailable.calls.abc,0);
});

test('saved-only report selection continues using its existing read-only detail adapter',async()=>{
  const r=readers(),savedCalls=[];
  const saved={companyMonths:r.f.reader.companyMonths,briefingMonth:()=>assert.fail('saved view must not switch to the normal freshness path'),
    companyDetail:async(...args)=>{savedCalls.push(args);return r.f.reader.companyDetail(...args);}};
  const result=await createInsightAnalysis({...r.f.args,collectionResults:r.reader,savedCollectionResults:saved}).briefing(r.f.customer,'own',{savedOnly:true});
  assert.equal(result.calculation.mode,'saved_only');assert.equal(savedCalls.length,6);assert.equal(r.calls.integrated.length,0);assert.equal(r.calls.abc,0);
});

test('only legacy readers without an integrated adapter retain the original projected company-detail fallback',async()=>{
  let reads=0;const reader=createCollectionResults({catalog:async()=>({companies:[{companyId:'legacy',rooms:16}]}),readCompanyDetail:async()=>{reads++;return {company:{companyId:'legacy'},salesHistory:{current:{daily:[{date:'2026-09-01',sold:0}]}}};}});
  const view=await reader.briefingMonth('legacy',{month:'2026-09'});assert.equal(view.legacyObservationView,true);assert.equal(view.current.daily[0].sold,0);assert.equal(reads,1);
});

test('an outer queued caller cannot deadlock the current analytical owner reentering the same month', {timeout:3000},async()=>{
  const scheduler=createAnalyticalWorkScheduler(),entered=gate(),reenter=gate();let loads=0;
  const r=readers({runWork:()=>assert.fail('dedicated month reader must not request an outer analytical lease'),
    readIntegrated:async(id,options,values)=>scheduler.run(async()=>{loads++;return values.get(id+'|'+options.month);},{kind:'fixture-month-proof'})});
  const owner=scheduler.run(async()=>{entered.resolve();await reenter.promise;return r.reader.briefingMonth('own',{month:'2026-09'});});
  await entered.promise;const queued=r.reader.briefingMonth('own',{month:'2026-09'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(scheduler.status().queuedForeground,1);reenter.resolve();
  const [inside,outside]=await Promise.all([owner,queued]);assert.deepEqual(inside,outside);assert.equal(loads,2);assert.equal(r.calls.abc,0);await scheduler.close();
});
