'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto');
const { buildMonthlyReportSnapshot } = require('./lib/monthly_reports.cjs');
const { projectIntegrated } = require('./lib/insight_company_integrated.cjs');
const { projectCompanyDetail } = require('./lib/insight_company_detail.cjs');
const { createCollectionResults } = require('./lib/insight_collection_results.cjs');
const { createInsightStore } = require('./lib/insight_store.cjs');
const { createInsightHttp } = require('./lib/insight_http.cjs');
const { createConnectedServer } = require('../customer-portal/connected-server.cjs');
const { createInsightAnalysis } = require('./lib/insight_analysis.cjs');

const company = { companyId:'cmp_one', name:'검수 업체', rooms:16, roomCountSource:'db_review', placeIds:['123'] };
function integration() {
  const observations = [1,2].map(n => ({ companyId:company.companyId, stayDate:`2026-09-0${n}`, productType:'lodging', keyword:'경남글램핑', runId:'run', collectedAt:'2026-09-01T01:00:00Z', inventoryEvidenceVersion:4, supply:16, sold:n === 1 ? 2 : 0, publicBookings:n === 1 ? 1 : 0, phoneBookings:n === 1 ? 1 : 0, publicRevenue:n === 1 ? 100000 : 0, phoneRevenue:n === 1 ? 120000 : 0, estimatedRevenue:n === 1 ? 220000 : 0, phonePricedBookings:n === 1 ? 1 : 0, sharedDayUseExcluded:0, capacityBasis:{count:16,source:'db_review'} }));
  const snapshot = buildMonthlyReportSnapshot({type:'company',targetId:company.companyId,month:'2026-09',cutoffDate:'2026-09-30'}, {companies:[{...company,capacity:16}],observations,runs:[{id:'run',keyword:'경남글램핑',collectionQuality:{status:'complete'}}]},'2026-10-01T00:00:00Z');
  return {schemaVersion:1,companyId:company.companyId,status:'ready',calculatedAt:'2026-10-01T00:00:00Z',calculationVersion:'v1',selectedMonth:'2026-09',months:[{month:'2026-09',status:'partial'}],roomBasis:{count:16,source:'db_review'},snapshot};
}

test('customer projection copies the shared monthly amounts without recomputation and preserves null versus zero', () => {
  const source=integration(), output=projectIntegrated(company.companyId,source);
  const s=source.snapshot.summary.lodging;
  for(const key of ['sold','supply','estimatedRevenue','publicRevenue','phoneRevenue','publicBookings','phoneBookings','reservationRate']) assert.equal(output.snapshot.summary[key],s[key],key);
  assert.equal(output.snapshot.summary.estimatedRevenue,220000);
  assert.equal(output.snapshot.daily.find(d=>d.date==='2026-09-02').sold,0);
  assert.equal(output.snapshot.daily.find(d=>d.date==='2026-09-03').sold,null);
  assert.equal(output.snapshot.daily.find(d=>d.date==='2026-09-03').missing,true);
  assert.equal(output.snapshot.daily.find(d=>d.date==='2026-09-02').partial,false,'prior observation remains usable and explicitly dated');
  assert.equal(output.snapshot.daily.find(d=>d.date==='2026-09-02').observationLeadTimeDays,1);
});

test('a full month observed in advance is freshness-limited, not missing room quantities',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-month-freshness-'));
  const fixture=await require('./fixtures/monthly_report_fixture.cjs').seedMonthlyReportFixture(dir);
  const source={companies:Object.values(fixture.companies),observations:fixture.observations,runs:fixture.runIds.map(id=>JSON.parse(fs.readFileSync(path.join(dir,'outputs',id,'manifest.json'),'utf8')))};
  const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:fixture.companyId,month:'2026-08',cutoffDate:'2026-08-31'},source,'2026-10-10T00:00:00Z');
  const output=projectIntegrated(fixture.companyId,{...integration(),companyId:fixture.companyId,selectedMonth:'2026-08',snapshot});
  assert.equal(output.snapshot.summary.observedDays,31);assert.equal(output.snapshot.summary.missingDays,0);
  assert.equal(output.snapshot.summary.staleDays,29);assert.equal(output.snapshot.summary.partial,true,'broad source quality still discloses older observation dates');
  assert.equal(output.snapshot.summary.quantityPartial,false);assert.equal(output.snapshot.daily.some(row=>row.partial||row.missing),false);
  source.observations=source.observations.filter(row=>row.stayDate!=='2026-08-31');
  const missingSnapshot=buildMonthlyReportSnapshot({type:'company',targetId:fixture.companyId,month:'2026-08',cutoffDate:'2026-08-31'},source,'2026-10-10T00:00:00Z');
  const missing=projectIntegrated(fixture.companyId,{...integration(),companyId:fixture.companyId,selectedMonth:'2026-08',snapshot:missingSnapshot});
  assert.equal(missing.snapshot.summary.quantityPartial,true);assert.equal(missing.snapshot.summary.missingDays,1);
});

test('the customer boundary rejects mismatched company/month and removes internal evidence', () => {
  const source=integration();source.internalToken='private-token';source.roomBasis.reviewedBy='private-admin';source.snapshot.sources.rawPath='/var/data/private';source.snapshot.sources.observations[0].secret='private-evidence';
  const output=projectIntegrated(company.companyId,source);
  assert.doesNotMatch(JSON.stringify(output),/private-|\/var\/data|rawPath|sourceRunIds|reviewedBy|runId/);
  assert.equal(projectIntegrated('cmp_other',source).snapshot,null);
  assert.equal(projectIntegrated(company.companyId,source,'2026-10').snapshot,null);
  source.snapshot.target.id='cmp_other';assert.equal(projectIntegrated(company.companyId,source).snapshot,null);
});

test('pending shared integration never silently substitutes the legacy archive', () => {
  const detail={company:{companyId:company.companyId},salesHistory:{current:{summary:{estimatedRevenue:99999},daily:[{date:'2026-09-01',estimatedRevenue:99999}]}}};
  const pending=projectCompanyDetail(company,detail,{integrationConnected:true,integrated:null});
  assert.equal(pending.integrated.status,'pending');assert.equal(pending.current.summary,null);assert.deepEqual(pending.current.daily,[]);
  const old=projectCompanyDetail(company,detail);
  assert.equal(old.legacyObservationView,true);assert.equal(old.current.summary.estimatedRevenue,99999);
  const ready=projectCompanyDetail(company,detail,{integrationConnected:true,integrated:integration()});
  assert.equal(ready.legacyObservationView,false);assert.equal(ready.current.summary.estimatedRevenue,220000);
  const refreshing=projectCompanyDetail(company,detail,{integrationConnected:true,integrated:{...integration(),status:'refreshing'}});
  assert.equal(refreshing.integrated.status,'updating');assert.equal(refreshing.current.summary.estimatedRevenue,220000);
});

test('month reads use distinct in-flight keys and forward only the requested month',async()=>{
  const calls=[];
  const reader=createCollectionResults({catalog:async()=>({companies:[company]}),readCompanyDetail:async()=>({company}),readIntegrated:async(id,options)=>{calls.push([id,options]);return integration();}});
  const [a,b]=await Promise.all([reader.companyDetail(company.companyId,{month:'2026-09'}),reader.companyDetail(company.companyId,{month:'2026-10'})]);
  assert.equal(calls.length,2);assert.equal(a.current.summary.estimatedRevenue,220000);assert.equal(b.current.summary,null);
  assert.ok(calls.every(([,options])=>options.knownMonthsOnly===true),'the core range guard is always requested');
});

test('unknown months are refused before expensive detail and evidence reads, while archived history and initial pending are preserved',async()=>{
  let details=0;
  const reader=createCollectionResults({catalog:async()=>({companies:[company]}),readCompanyDetail:async()=>{details++;return {company};},readIntegrated:async(id,{month,knownMonthsOnly})=>{
    assert.equal(knownMonthsOnly,true);
    if(month==='2099-12')throw Object.assign(Error('internal raw location'),{code:'MONTH_NOT_OBSERVED',statusCode:400});
    return {...integration(),selectedMonth:month||'2026-10',snapshot:null,status:'pending'};
  }});
  await assert.rejects(reader.companyDetail(company.companyId,{month:'2099-12'}),error=>error.code==='MONTH_NOT_OBSERVED'&&error.statusCode===400&&!error.message.includes('internal'));
  assert.equal(details,0);
  // The lightweight detail contains no historical archive. Only the shared core
  // decides what full history exists; the customer projection must not reject it.
  const old=await reader.companyDetail(company.companyId,{month:'2024-01'});
  assert.equal(old.integrated.status,'pending');assert.equal(old.integrated.selectedMonth,'2024-01');
  const first=await reader.companyDetail(company.companyId);
  assert.equal(first.integrated.status,'pending');assert.equal(details,2);
});

async function listen(server) {await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}
test('authenticated BFF enforces linked-company and tenant scope before integrated reads',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-shared-month-')),store=createInsightStore({file:path.join(dir,'test.sqlite')});t.after(()=>store.close());
  const catalog={companies:[company,{companyId:'cmp_other',name:'타 업체'}],regions:[]};
  const owner=store.ensure({memberId:'owner',username:'owner',role:'b2b'}),stranger=store.ensure({memberId:'other',username:'other',role:'b2b'});
  store.update(owner.customerId,{revision:owner.revision,requestKey:randomUUID(),action:'add-company',payload:{kind:'competitor',companyId:company.companyId}},catalog);
  const ownerToken=store.session(owner.customerId),strangerToken=store.session(stranger.customerId),serviceToken=randomUUID();let reads=0;
  const collectionResults=createCollectionResults({catalog:async()=>catalog,readEvidence:async()=>null,readCompanyDetail:async()=>({company}),readIntegrated:async(id,{month})=>{reads++;assert.equal(id,company.companyId);assert.equal(month,'2026-09');return integration();}});
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>catalog,memberActive:async()=>true,collectionResults});
  const back=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://local'))),backend=await listen(back);t.after(()=>{back.closeAllConnections();back.close();});
  const reserve=http.createServer(),origin=await listen(reserve);await new Promise(resolve=>reserve.close(resolve));
  const front=createConnectedServer({origin,backend,serviceToken});await new Promise(resolve=>front.listen(Number(new URL(origin).port),'127.0.0.1',resolve));t.after(()=>{front.closeAllConnections();front.close();});
  const get=(tail,token=ownerToken)=>fetch(origin+'/api/customer/v1'+tail,{headers:{Cookie:'insight_local_session='+token}});
  assert.equal((await get('/companies/cmp_other/collection?month=2026-09')).status,404);
  assert.equal((await get('/companies/cmp_one/collection?month=2026-09',strangerToken)).status,404);
  assert.equal(reads,0);
  for(const query of ['month=2026-13','month=','month=2026-09&month=2026-10','month=2026-09&runId=private'])assert.equal((await get('/companies/cmp_one/collection?'+query)).status,400);
  const response=await get('/companies/cmp_one/collection?month=2026-09');assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.companyDetail.current.summary.estimatedRevenue,220000);assert.equal(reads,1);
  assert.equal((await get('/companies/cmp_one/collection?month=2026-09','')).status,401);
  for(let index=1;index<240;index++)store.throttle(`company-read:${owner.customerId}`,240);
  assert.equal((await get('/companies/cmp_one/collection?month=2026-09')).status,429,'excess customer polling stops before shared or evidence reads');
  assert.equal(reads,1);
});

test('current briefing reads both shared months across a month boundary',async()=>{
  const calls=[];
  const analysis=createInsightAnalysis({catalog:async()=>({companies:[company],regions:[]}),collectionResults:{companyDetail:async(id,{month})=>{calls.push(month);return {legacyObservationView:false,integrated:{snapshot:{}},current:{daily:[]}};}},now:()=>Date.parse('2026-09-20T00:00:00Z')});
  await analysis.briefing({regions:[],relations:[{kind:'own',status:'active',companyId:company.companyId}]});
  assert.deepEqual(calls,['2026-09','2026-10']);
});
