'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const pair=require('../web/comparison-company-pair.js');
const dates=['2026-10-30','2026-10-31','2026-11-01'],previous='2026-10-27T04:20:05.714Z',current='2026-10-28T06:03:04.516Z';
const clone=value=>JSON.parse(JSON.stringify(value));
function company(companyId,kind,rooms){
  const own=kind==='own',source={previousRunId:companyId+'_before',currentRunId:companyId+'_current',previousObservedAt:previous,currentObservedAt:current,calculationVersion:'public-booking-pickup-v1',sourceDigests:{previous:'a'.repeat(64),current:'b'.repeat(64)},ledgerDigest:'c'.repeat(64)};
  const publicCounts=own?[[1,3],[0,0],[2,1]]:[[1,2],[1,1],[0,2]],sold=own?[2,0,5]:[10,0,10];
  return {companyId,name:own?'우리 숙소':'선택 경쟁업체',kind,rooms,regionLabel:own?'산청군':'산청군',regionRelation:own?'own':'same',industryRelation:own?'own':'common',capacity:{conflict:false,reviewRequired:false,label:'검수 객실'},reasons:[],
    points:dates.map((date,i)=>({date,status:'ready',sold:sold[i],supply:rooms,publicBookings:own?[1,0,3][i]:[8,0,8][i],phoneBookings:own?[1,0,2][i]:[2,0,2][i],rate:sold[i]/rooms,reservationRate:sold[i]/rooms,collectedAt:current,collectedDate:'2026-10-28'})),
    savedMetrics:{price:{value:999999,status:'ready',reason:null,reasonCode:null,source:{runId:companyId+'_price',collectedAt:current},limitations:['가격은 상품별 표시가격'],rows:own?[
      {date:dates[0],productId:'a',productName:'A객실',price:100000},{date:dates[0],productId:'b',productName:'B객실',price:300000},
      {date:dates[1],productId:'a',productName:'A객실',price:0},{date:dates[2],productId:'a',productName:'A객실',price:200000}]:dates.map((date,i)=>({date,productId:'other',productName:'경쟁 객실',price:i===1?300000:250000}))},
      pickup:{value:999999,status:'reference',reason:'공개예약만 비교',reasonCode:'PICKUP_PUBLIC_ONLY_REFERENCE',source,limitations:['전체 예약·매출로 대체하지 않습니다.'],rows:dates.map((date,i)=>({date,publicChange:publicCounts[i][1]-publicCounts[i][0],previousPublic:publicCounts[i][0],currentPublic:publicCounts[i][1],productCount:1,matchedProductIds:['lodging_room'],previousCollectedAt:previous,collectedAt:current}))}}};
}
function fixture(){
  const own=company('own','own',10),other=company('other','competitor',20);
  return {contextValid:true,own,companies:[own,other],sourcePeriod:{start:dates[0],end:dates[2],asOf:'2026-10-30'},period:{start:dates[0],end:dates[2],asOf:'2026-10-30',days:3},filters:{start:dates[0],end:dates[2],dayFilter:'all'},dates:[...dates],executionAllowed:false};
}
function updatePair(metric,before,at){metric.source.previousObservedAt=before;metric.source.currentObservedAt=at;for(const row of metric.rows){row.previousCollectedAt=before;row.collectedAt=at;}}

test('pair contains selected owner/competitor, every selected date and independently verified metric rows without mutation',()=>{
  const input=fixture(),before=JSON.stringify(input),out=pair.project(input,'other');
  assert.equal(out.contextValid,true);assert.equal(out.own.companyId,'own');assert.equal(out.competitor.companyId,'other');assert.deepEqual(out.dates,dates);
  assert.equal(out.rows[0].own.rate,.2);assert.equal(out.rows[0].competitor.rate,.5);assert.equal(out.rows[0].own.price,200000);
  assert.deepEqual(out.rows[0].own.priceProducts,[{productId:'a',productName:'A객실',price:100000},{productId:'b',productName:'B객실',price:300000}]);
  assert.equal(out.rows[0].own.priceProductCount,2);assert.equal(out.rows[0].own.publicChange,2);assert.equal(out.rows[0].competitor.publicChange,1);
  assert.equal(out.actionable,false);assert.equal(out.executionAllowed,false);assert.ok(Object.values(out.metrics).every(metric=>metric.actionable===false&&metric.gapPp===null));assert.equal(JSON.stringify(input),before);
});
test('reservation rate uses only common valid stay dates and supply weighting, never the larger individual subtotal or raw room scale',()=>{
  const input=fixture();input.companies[1].points[2].status='unavailable';
  const out=pair.project(input,'other'),metric=out.metrics.rate;
  assert.equal(metric.commonDays,2);assert.deepEqual(metric.dates,dates.slice(0,2));assert.equal(metric.ownSold,2);assert.equal(metric.ownSupply,20);assert.equal(metric.competitorSold,10);assert.equal(metric.competitorSupply,40);
  assert.equal(metric.own,.1);assert.equal(metric.competitor,.25);assert.equal(out.rows[2].own.rate,.5);assert.equal(out.rows[2].competitor.rate,null);
  assert.equal(metric.status,'reference');assert.equal(metric.gapPp,null);
});
test('same-day observation timestamp differences stay explicit reference and unknown timestamps never make a comparison actionable',()=>{
  const input=fixture();input.companies[1].points[0].collectedAt='2026-10-28T06:03:05.516Z';
  let out=pair.project(input,'other');assert.equal(out.metrics.rate.reasonCode,'OBSERVATION_TIME_MISMATCH');assert.equal(out.metrics.rate.sameObservationTime,false);assert.equal(out.metrics.rate.own,7/30);assert.equal(out.metrics.rate.gapPp,null);
  input.companies[1].points[0].collectedAt=null;out=pair.project(input,'other');assert.equal(out.metrics.rate.reasonCode,'OBSERVATION_TIME_UNKNOWN');assert.equal(out.metrics.rate.own,7/30);assert.equal(out.actionable,false);
});
test('common price summaries keep the original product-date row median definition rather than averaging daily medians or dividing revenue',()=>{
  const out=pair.project(fixture(),'other'),metric=out.metrics.price;
  assert.equal(metric.commonDays,3);assert.equal(metric.own,150000);assert.equal(metric.competitor,250000);assert.equal(metric.ownRows,4);assert.equal(metric.ownProducts,2);
  assert.notEqual(metric.own,200000,'daily medians 200000/0/200000 are not the source row median');assert.equal(metric.reasonCode,'PRICE_CONDITIONS_DIFFER');
  assert.equal(out.own.sourceProof.price.value,150000);assert.equal(out.rows[1].own.price,0);
});
test('independent public pickup aggregates only common dates with the exact same observation pair',()=>{
  const out=pair.project(fixture(),'other'),metric=out.metrics.publicChange;
  assert.equal(metric.commonDays,3);assert.equal(metric.own,1);assert.equal(metric.competitor,3);assert.equal(metric.ownPreviousPublic,3);assert.equal(metric.ownCurrentPublic,4);
  assert.equal(metric.sameObservationPair,true);assert.equal(metric.status,'reference');assert.equal(out.own.sourceProof.pickup.value,1);assert.equal(out.competitor.sourceProof.pickup.value,3);
  assert.equal(out.rows[1].own.publicChange,0);assert.equal(out.rows[2].own.publicChange,-1);
});
test('different public pickup pairs hold both comparison totals while preserving each individual value and immutable provenance',()=>{
  const input=fixture();updatePair(input.companies[1].savedMetrics.pickup,'2026-10-26T03:00:00Z','2026-10-29T03:00:00Z');
  const out=pair.project(input,'other'),metric=out.metrics.publicChange;
  assert.equal(metric.status,'hold');assert.equal(metric.reasonCode,'PICKUP_INTERVAL_MISMATCH');assert.equal(metric.own,null);assert.equal(metric.competitor,null);assert.equal(metric.sameObservationPair,false);
  assert.equal(out.rows[0].own.publicChange,2);assert.equal(out.rows[0].competitor.publicChange,1);assert.equal(out.own.sourceProof.pickup.value,1);assert.equal(out.competitor.sourceProof.pickup.value,3);
  assert.equal(metric.ownSource.currentRunId,'own_current');assert.equal(metric.competitorSource.currentObservedAt,'2026-10-29T03:00:00.000Z');
});
test('unknown total inventory does not erase independent prices or public pickup, and cannot borrow their counts for a rate',()=>{
  const input=fixture();input.companies[1].rooms=null;input.companies[1].points=input.companies[1].points.map(row=>({...row,status:'unavailable',sold:null,supply:null,publicBookings:null,phoneBookings:null,rate:null,reservationRate:null}));
  const out=pair.project(input,'other');assert.equal(out.metrics.rate.commonDays,0);assert.equal(out.metrics.rate.own,null);assert.equal(out.metrics.rate.competitor,null);
  assert.equal(out.metrics.price.competitor,250000);assert.equal(out.metrics.publicChange.competitor,3);assert.equal(out.rows[0].competitor.rate,null);assert.equal(out.rows[0].competitor.sold,null);assert.equal(out.rows[0].competitor.publicChange,1);
});
test('a missing counterpart metric produces null common summaries while each known daily value remains visible',()=>{
  const input=fixture();input.companies[1].savedMetrics.price.rows=[];input.companies[1].savedMetrics.pickup.rows=[];
  const out=pair.project(input,'other');assert.equal(out.metrics.price.own,null);assert.equal(out.metrics.price.competitor,null);assert.equal(out.metrics.price.commonDays,0);
  assert.equal(out.metrics.publicChange.own,null);assert.equal(out.metrics.publicChange.commonDays,0);assert.equal(out.rows[0].own.price,200000);assert.equal(out.rows[0].own.publicChange,2);
  assert.equal(out.rows[0].competitor.price,null);assert.equal(out.rows[0].competitor.publicChange,null);assert.equal(out.competitor.sourceProof.pickup.aggregateOnly,true);
});
test('date range and weekday selections remain exact, include missing dates and never revive unselected price/product data',()=>{
  const input=fixture();input.dates=[dates[0]];input.filters.dayFilter='friday';input.period.days=1;
  input.companies[0].savedMetrics.price.rows.push({date:'2027-01-01',productId:'hidden',productName:'OUTSIDE-PRIVATE-PRODUCT',price:111111111});
  const out=pair.project(input,'other');assert.equal(out.contextValid,true);assert.deepEqual(out.dates,[dates[0]]);assert.equal(out.rows.length,1);assert.equal(out.metrics.rate.own,.2);
  assert.equal(out.metrics.price.own,200000);assert.equal(out.metrics.publicChange.own,2);assert.doesNotMatch(JSON.stringify(out),/OUTSIDE-PRIVATE-PRODUCT|111111111/);
  const empty=fixture();empty.dates=[];empty.period.days=0;empty.filters.dayFilter='weekday';const noDates=pair.project(empty,'other');
  assert.equal(noDates.contextValid,true);assert.deepEqual(noDates.rows,[]);assert.ok(Object.values(noDates.metrics).every(metric=>metric.own===null&&metric.competitor===null));
});
test('duplicate price/product, reservation and pickup conflicts are excluded instead of selecting a convenient copy or inventing zero',()=>{
  const input=fixture(),own=input.companies[0];own.points.push({...own.points[0],sold:4,publicBookings:3,rate:.4,reservationRate:.4});
  own.savedMetrics.price.rows.push({...own.savedMetrics.price.rows[0],price:999999});own.savedMetrics.pickup.rows.push({...own.savedMetrics.pickup.rows[0],currentPublic:4,publicChange:3});
  const out=pair.project(input,'other');assert.equal(out.rows[0].own.rate,null);assert.equal(out.rows[0].own.price,300000);assert.equal(out.rows[0].own.priceProductCount,1);assert.equal(out.rows[0].own.publicChange,null);
  assert.ok(out.rows[0].own.reasons.some(row=>row.code==='DUPLICATE_QUANTITY'));assert.ok(out.rows[0].own.reasons.some(row=>row.code==='PRICE_DUPLICATE_CONFLICT'));assert.ok(out.rows[0].own.reasons.some(row=>row.code==='PICKUP_DUPLICATE_CONFLICT'));
});
test('identical duplicated valid evidence is idempotent across repeated renders',()=>{
  const input=fixture(),before=pair.project(input,'other');
  for(const company of input.companies){company.points.push(clone(company.points[0]));company.savedMetrics.price.rows.push(clone(company.savedMetrics.price.rows[0]));company.savedMetrics.pickup.rows.push(clone(company.savedMetrics.pickup.rows[0]));}
  assert.deepEqual(pair.project(input,'other'),before);
});
test('source run identity, independent digests and observation times remain mandatory even if an aggregate is positive',()=>{
  for(const mutate of [c=>delete c.savedMetrics.price.source.runId,c=>c.savedMetrics.price.source.collectedAt='2026-10-31T01:00:00Z']){
    const input=fixture();mutate(input.companies[1]);const out=pair.project(input,'other');assert.equal(out.rows[0].competitor.price,null);assert.equal(out.metrics.price.commonDays,0);
  }
  for(const mutate of [c=>c.savedMetrics.pickup.source.currentRunId='bad run',c=>c.savedMetrics.pickup.source.sourceDigests.current='bad',c=>c.savedMetrics.pickup.source.currentObservedAt='2026-10-31T03:00:00Z']){
    const input=fixture();mutate(input.companies[1]);const out=pair.project(input,'other');assert.equal(out.rows[0].competitor.publicChange,null);assert.equal(out.metrics.publicChange.commonDays,0);assert.equal(out.competitor.sourceProof.pickup,null);
  }
});
test('malformed quantity arithmetic, timestamp and capacity mismatches do not leak a reservation rate',()=>{
  for(const mutate of [row=>row.sold=99,row=>row.supply=21,row=>row.publicBookings=.5,row=>row.rate=.9,row=>row.collectedAt='bad',row=>row.collectedDate='2026-10-29',row=>row.reservationRate=.9]){
    const input=fixture();mutate(input.companies[1].points[0]);const out=pair.project(input,'other');assert.equal(out.rows[0].competitor.rate,null);assert.equal(out.rows[0].competitor.sold,null);
  }
  const input=fixture();input.companies[1].capacity.conflict=true;assert.equal(pair.project(input,'other').metrics.rate.commonDays,0);
});
test('different region or industry never promotes reference values into rankings, gaps or policy actions',()=>{
  const input=fixture();input.companies[1].regionRelation='cross';input.companies[1].industryRelation='mixed';const out=pair.project(input,'other');
  assert.equal(out.competitor.rooms,20);assert.equal(out.own.rooms,10);assert.match(out.limits.join(' '),/다른 지역/);assert.match(out.limits.join(' '),/업종/);
  assert.equal(out.executionAllowed,false);assert.ok(Object.values(out.metrics).every(value=>value.gapPp===null&&value.actionable===false));
});
test('proof projections use allowlists and no input row or source object can be mutated through the output',()=>{
  const input=fixture();input.companies[1].savedMetrics.price.source.rawCookie='PRIVATE-COOKIE';input.companies[1].savedMetrics.pickup.source.raw={token:'PRIVATE-TOKEN'};
  input.companies[1].savedMetrics.pickup.rows[0].raw='PRIVATE-ROW';const out=pair.project(input,'other');assert.doesNotMatch(JSON.stringify(out),/PRIVATE-COOKIE|PRIVATE-TOKEN|PRIVATE-ROW|rawCookie/);
  out.rows[0].competitor.priceProducts[0].price=1;out.competitor.sourceProof.pickup.source.sourceDigests.current='d'.repeat(64);
  assert.equal(input.companies[1].savedMetrics.price.rows[0].price,250000);assert.equal(input.companies[1].savedMetrics.pickup.source.sourceDigests.current,'b'.repeat(64));
});
test('invalid or foreign selection/own identity/period/date filters fail closed without names, data or fallback to another competitor',()=>{
  for(const [mutate,id] of [
    [()=>{},'own'],[()=>{},'unregistered'],[m=>m.contextValid=false,'other'],[m=>m.own={companyId:'other',kind:'own'},'other'],[m=>m.own={...m.own,rooms:11},'other'],
    [m=>m.companies.push(clone(m.companies[1])),'other'],[m=>m.period.start='2026-10-29','other'],[m=>m.period.asOf='2026-10-29','other'],
    [m=>m.filters.dayFilter='holiday','other'],[m=>m.dates.pop(),'other'],[m=>m.dates.reverse(),'other'],[m=>m.dates[0]='2026-02-30','other']
  ]){const input=fixture();mutate(input);const out=pair.project(input,id);assert.equal(out.contextValid,false);assert.equal(out.own,null);assert.equal(out.competitor,null);assert.deepEqual(out.rows,[]);assert.ok(Object.values(out.metrics).every(value=>value.own===null&&value.competitor===null));assert.doesNotMatch(JSON.stringify(out),/우리 숙소|선택 경쟁업체/);}
});
test('browser UMD is deterministic with CommonJS and never fetches, stores, collects or schedules',()=>{
  const input=fixture(),before=JSON.stringify(input),context={window:{},fetch:()=>assert.fail('fetch'),setTimeout:()=>assert.fail('timer'),localStorage:{setItem:()=>assert.fail('storage')}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-company-pair.js'),'utf8'),context);
  assert.equal(JSON.stringify(context.window.InsightComparisonCompanyPair.project(input,'other')),JSON.stringify(pair.project(input,'other')));assert.equal(JSON.stringify(input),before);assert.equal(pair.buildPair,pair.project);
});
