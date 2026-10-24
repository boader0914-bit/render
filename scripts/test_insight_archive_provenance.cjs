'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { buildMonthlyReportSnapshot } = require('./lib/monthly_reports.cjs');
const { projectIntegrated } = require('./lib/insight_company_integrated.cjs');
const { projectDailyReview, publicationSourceLinks } = require('../customer-portal/archive-provenance.cjs');
const COMPANY = 'cmp_place_123', MONTH = '2026-09', AT = '2026-10-24T00:00:00Z';
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const observation = (date,runId,collectedAt,sold) => ({companyId:COMPANY,stayDate:date,productType:'lodging',keyword:runId==='run_old'?'경남글램핑':'산청글램핑',runId,collectedAt,inventoryEvidenceVersion:4,
    supply:16,sold,publicBookings:sold,phoneBookings:0,publicRevenue:sold*100000,phoneRevenue:0,estimatedRevenue:sold*100000,phonePricedBookings:0,sharedDayUseExcluded:0,capacityBasis:{count:16,source:'db_review'}});
  const rows=[observation('2026-09-02','run_old','2026-09-01T01:00:00Z',1),observation('2026-09-02','run_selected','2026-09-02T01:00:00Z',2),observation('2026-09-03','run_zero','2026-09-02T01:00:00Z',0)];
  const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:COMPANY,month:MONTH,cutoffDate:'2026-09-30'},
    {companies:[{companyId:COMPANY,primaryName:'검수 업체',capacity:16}],observations:rows,runs:['run_old','run_selected','run_zero'].map(id=>({id,keyword:'경남글램핑',collectionQuality:{status:'complete'}}))},'2026-10-01T00:00:00Z');
  const integrated=projectIntegrated(COMPANY,{schemaVersion:1,companyId:COMPANY,status:'ready',calculatedAt:'2026-10-01T00:00:00Z',calculationVersion:'company-integrated-v1',selectedMonth:MONTH,months:[{month:MONTH}],roomBasis:{count:16,source:'db_review'},snapshot});
  return {companyDetail:{companyId:COMPANY,integrated},result:{runId:'run_unrelated_latest',quality:{status:'complete'}},responseCache:{state:'fresh'}};
}
const project = data => projectDailyReview({companyId:COMPANY,month:MONTH,data,reviewedAt:AT});
test('invalid period boundaries and all preview marker variants cannot become a durable review',()=>{
  for(const mutate of [d=>{d.companyDetail.integrated.snapshot.period.start=null;},d=>{d.companyDetail.integrated.snapshot.period.end='2026-10-01';},d=>{d.companyDetail.integrated.snapshot.period.days=1;},d=>{d.responseCache.preview=true;},d=>{d.calculation={mode:'saved_only'};}]){const data=fixture();mutate(data);assert.equal(project(data),null);}
});

test('source links reference the shared DB exact selected daily observation, not the most recent unrelated run',()=>{
  const data=fixture(),integrated=data.companyDetail.integrated,selected=integrated.snapshot.daily.find(row=>row.date==='2026-09-02');
  assert.equal(selected.sold,2);assert.equal(selected.sourceObservation.runId,'run_selected');
  assert.ok(integrated.snapshot.provenance.runIds.includes('run_old'),'intermediate pickup analysis sources remain linked');
  assert.deepEqual(integrated.snapshot.provenance.selectedRunIds,['run_selected','run_zero']);
  assert.equal(integrated.snapshot.provenance.linkageStatus,'complete');
  const record=project(data);assert.ok(record);assert.equal(record.calculationVersion,'company-integrated-v1');
  assert.equal(record.daily.find(row=>row.date==='2026-09-02').sourceObservation.runId,'run_selected');
  assert.ok(!record.provenance.runIds.includes('run_unrelated_latest'));
});

test('daily archive keeps normal zero, unknown, partial coverage and automatic review distinct',()=>{
  const record=project(fixture()),zero=record.daily.find(row=>row.date==='2026-09-03'),unknown=record.daily.find(row=>row.date==='2026-09-04');
  assert.equal(record.review.status,'partial');assert.equal(record.review.basis,'automatic_validation');assert.equal(record.review.normalDays,2);
  assert.equal(zero.sold,0);assert.equal(zero.estimatedRevenue,0);assert.equal(zero.review.status,'reviewed');
  assert.equal(unknown.sold,null);assert.equal(unknown.estimatedRevenue,null);assert.equal(unknown.sourceObservation,null);assert.equal(unknown.review.status,'unresolved');
  assert.equal(unknown.review.reason,'SOURCE_LINK_MISSING');
  const data=fixture(),row=data.companyDetail.integrated.snapshot.daily.find(row=>row.date==='2026-09-03');row.estimatedRevenue=null;row.revenuePartial=true;
  const priceUnknown=project(data).daily.find(row=>row.date==='2026-09-03');assert.equal(priceUnknown.review.quantityReviewed,true);assert.equal(priceUnknown.review.revenueReviewed,false);assert.equal(priceUnknown.estimatedRevenue,null);
});

test('non-final integration, preview, mismatched source company/month/version and absent provenance cannot become reviewed archives',()=>{
  const mutations=[d=>{d.companyDetail.integrated.status='pending';},d=>{d.companyDetail.integrated.status='updating';},d=>{d.companyDetail.integrated.status='failed';},d=>{d.companyDetail.integrated.status='partial';},d=>{d.responseCache.state='preview';},d=>{d.companyDetail.companyId='cmp_other';},d=>{d.companyDetail.integrated.selectedMonth='2026-08';},d=>{d.companyDetail.integrated.snapshot.provenance.companyId='cmp_other';},d=>{d.companyDetail.integrated.snapshot.provenance.calculationVersion='company-integrated-v2';},d=>{delete d.companyDetail.integrated.snapshot.provenance;},d=>{d.companyDetail.integrated.snapshot.provenance.runIds=[];}];
  for(const mutate of mutations){const data=fixture();mutate(data);assert.equal(project(data),null,mutate.toString());}
});

test('foreign-company and unselected run references are not introduced into perday provenance',()=>{
  const data=fixture(),p=data.companyDetail.integrated.snapshot.provenance;
  p.observations.push({...p.observations[0],companyId:'cmp_private'});
  data.companyDetail.integrated.snapshot.daily.find(row=>row.date==='2026-09-02').sourceObservation.runId='run_unrelated_latest';
  const record=project(data);assert.ok(record);assert.equal(record.provenance.linkageStatus,'incomplete');
  assert.ok(record.provenance.observations.every(row=>row.companyId===COMPANY));
  assert.equal(record.daily.find(row=>row.date==='2026-09-02').sourceObservation,null);
  assert.equal(record.daily.find(row=>row.date==='2026-09-02').review.quantityReviewed,false);
});

test('partial collection responses never become final normal daily archives',()=>{
  const data=fixture(),p=data.companyDetail.integrated.snapshot.provenance;
  for(const row of p.observations)row.runQuality='partial';
  for(const row of data.companyDetail.integrated.snapshot.daily)if(row.sourceObservation){row.sourceObservation.runQuality='partial';row.collectionPartial=true;}
  assert.equal(project(data),null);
});

test('privacy projection admits safe IDs and excludes raw payloads, paths, contacts and arbitrary source fields',()=>{
  const data=fixture(),integrated=data.companyDetail.integrated;
  data.token='PRIVATE-TOKEN';data.companyDetail.contact='PRIVATE-CONTACT';integrated.snapshot.rawPath='/var/data/private';integrated.snapshot.provenance.raw='PRIVATE-RAW';
  integrated.snapshot.provenance.observations[0].contact='PRIVATE-OBSERVATION';integrated.snapshot.daily[0].raw='PRIVATE-DAY';
  const record=project(data);assert.ok(record);assert.doesNotMatch(JSON.stringify(record),/PRIVATE-|\/var\/data|rawPath|contact|token/);
  const unsafe=fixture();unsafe.companyDetail.integrated.snapshot.provenance.runIds=['/var/data/private'];assert.equal(project(unsafe),null);
});

test('publication links derive exact immutable review lineage without inventing versions or run IDs',()=>{
  const a=project(fixture()),b=clone(a);b.private='PRIVATE-PUBLICATION';
  const links=publicationSourceLinks([a,b,{...a,calculationVersion:'mismatched-version'},{...a,kind:'pending_review'}]);
  assert.equal(links.length,1);assert.equal(links[0].companyId,COMPANY);assert.equal(links[0].month,MONTH);assert.equal(links[0].calculationVersion,a.calculationVersion);
  assert.deepEqual(links[0].runIds,a.provenance.runIds);assert.equal(links[0].reviewStatus,'partial');assert.doesNotMatch(JSON.stringify(links),/PRIVATE-/);
});

test('projection discloses duplicate selected date evidence instead of selecting a source independently',()=>{
  const data=fixture(),source={companyId:COMPANY,status:'ready',calculatedAt:AT,calculationVersion:'company-integrated-v1',selectedMonth:MONTH,snapshot:{target:{type:'company',id:COMPANY},request:{type:'company',targetId:COMPANY,month:MONTH},daily:[{date:'2026-09-02',lodging:{supply:16,sold:1,publicBookings:1,phoneBookings:0,estimatedRevenue:100000,coveredCompanyDays:1}}],sources:{runIds:['run_one','run_two'],observations:['run_one','run_two'].map(runId=>({companyId:COMPANY,runId,date:'2026-09-02',productType:'lodging',collectedAt:'2026-09-01T00:00:00Z',collectedDate:'2026-09-01',runQuality:'complete'}))}}};
  const projected=projectIntegrated(COMPANY,source);assert.equal(projected.snapshot.provenance.linkageStatus,'incomplete');assert.equal(projected.snapshot.daily[0].sourceObservation,null);
  data.companyDetail.integrated=projected;assert.equal(project(data),null);
});
