'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMonthlyReportSnapshot}=require('./lib/monthly_reports.cjs');
const {projectIntegrated}=require('./lib/insight_company_integrated.cjs');
const ID='cmp_projection_price';
function fixture(){
  const row=(date,publicBookings,phoneBookings,publicRevenue,phoneRevenue,phoneMissingPriceBookings)=>({companyId:ID,companyKey:ID,
    runId:'fixture-run',collectedAt:'2026-09-01T00:00:00Z',stayDate:date,productType:'lodging',inventoryEvidenceVersion:4,
    supply:16,sold:publicBookings+phoneBookings,publicBookings,phoneBookings,publicRevenue,phoneRevenue,
    estimatedRevenue:publicRevenue+phoneRevenue,phoneMissingPriceBookings,missing:false,partial:false,unknownUnavailable:0});
  const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:ID,month:'2026-09',cutoffDate:'2026-09-30'},
    {companies:[{companyId:ID,primaryName:'가격 표시 검수',capacity:16}],runs:[{id:'fixture-run',collectedAt:'2026-09-01T00:00:00Z',collectionQuality:{status:'complete'}}],
      observations:[row('2026-09-02',0,0,0,0,0),row('2026-09-04',1,4,279000,0,4),row('2026-09-05',1,4,279000,200000,2),row('2026-09-06',0,4,0,0,4)]},
    '2026-10-24T00:00:00Z');
  return {companyId:ID,schemaVersion:1,status:'ready',selectedMonth:'2026-09',calculationVersion:'company-integrated-v3-saved-product-recovery',
    calculatedAt:'2026-10-24T00:00:00Z',snapshot,roomBasis:{capacity:16,source:'db_review'},months:[{month:'2026-09'}]};
}
test('the safe projection preserves actual missing-price and fallback fields without changing quantities or amounts',()=>{
  const source=fixture(),before=JSON.stringify(source),result=projectIntegrated(ID,source),byDate=date=>result.snapshot.daily.find(row=>row.date===date);
  const partial=byDate('2026-09-04');
  assert.equal(partial.sold,5);assert.equal(partial.phoneBookings,4);assert.equal(partial.publicRevenue,279000);
  assert.equal(partial.phoneRevenue,0);assert.equal(partial.estimatedRevenue,279000);assert.equal(partial.phoneMissingPriceBookings,4);assert.equal(partial.revenuePartial,true);
  const positive=byDate('2026-09-05');
  assert.equal(positive.phoneRevenue,200000);assert.equal(positive.phoneMissingPriceBookings,2);assert.equal(positive.revenuePartial,true);
  const zero=byDate('2026-09-02');
  assert.equal(zero.sold,0);assert.equal(zero.estimatedRevenue,0);assert.equal(zero.phoneMissingPriceBookings,0);assert.equal(zero.phoneFallbackBookings,0);assert.equal(zero.phoneFallbackRevenue,0);
  const missing=byDate('2026-09-03');
  assert.equal(missing.sold,null);assert.equal(missing.estimatedRevenue,null);assert.equal(missing.phoneMissingPriceBookings,null);
  assert.equal(result.snapshot.summary.phoneMissingPriceBookings,source.snapshot.summary.lodging.phoneMissingPriceBookings,'aggregate follows the engine rather than re-summing source evidence');
  assert.equal(JSON.stringify(source),before,'this projection never mutates shared monthly data');
});
test('price-ineligible day retains the selected source missing-price count while a metric zero remains authoritative',()=>{
  const source=fixture(),metric=source.snapshot.daily.find(row=>row.date==='2026-09-06').lodging;
  assert.equal(metric.phoneMissingPriceBookings,null);
  const row=projectIntegrated(ID,source).snapshot.daily.find(row=>row.date==='2026-09-06');
  assert.equal(row.estimatedRevenue,null);assert.equal(row.phoneRevenue,null);assert.equal(row.phoneMissingPriceBookings,4);
  const selected=source.snapshot.sources.observations.find(row=>row.date==='2026-09-04');
  source.snapshot.daily.find(row=>row.date==='2026-09-04').lodging.phoneMissingPriceBookings=0;
  assert.equal(selected.phoneMissingPriceBookings,4);
  assert.equal(projectIntegrated(ID,source).snapshot.daily.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings,0);
});
test('untrusted count shapes stay unknown and unsupported price fields or raw evidence never leak',()=>{
  for(const bad of [-1,1.5,'4',true,Infinity]){
    const source=fixture(),metric=source.snapshot.daily.find(row=>row.date==='2026-09-04').lodging;
    metric.phoneMissingPriceBookings=bad;metric.phoneFallbackBookings=bad;
    source.snapshot.sources.observations.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings=bad;
    metric.privatePriceEvidence='private';metric.publicMissingPriceBookings=99;
    const result=projectIntegrated(ID,source),row=result.snapshot.daily.find(row=>row.date==='2026-09-04');
    assert.equal(row.phoneMissingPriceBookings,null);assert.equal(row.phoneFallbackBookings,null);
    assert.equal(Object.hasOwn(row,'publicMissingPriceBookings'),false,'do not invent a public missing-price aggregate absent from the engine contract');
    assert.doesNotMatch(JSON.stringify(result),/privatePriceEvidence/);
  }
});
