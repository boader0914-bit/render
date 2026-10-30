'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../web/customer-operating-actions.js');
const {evaluateComparison,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const projection=require('../comparison-projection.cjs');
const DAY=86400000,START='2026-10-30',END='2026-11-28';
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture({pending=false,crossOnly=false,missing=false,review=false,unconfirmed=false,zero=false}={}){
  const policy={mode:'current',asOf:START,period:{start:START,end:END},observationPolicy:{confirmed:!unconfirmed,maxSkewMs:7200000}};
  const make=(companyId,kind,regionKey,rooms,sold)=>({companyId,kind,regionKey,name:companyId==='own'?'시즌글램핑':companyId==='same'?'산청 비교업체':'타지역 비교업체',rooms,industryTags:['glamping'],comparisonPurpose:'direct',relationStatus:kind==='own'&&pending?'pending':'active',capacityStatus:review?'review_required':'reviewed',capacityReviewRequired:review,days:Array.from({length:30},(_,i)=>({date:new Date(Date.parse(START)+i*DAY).toISOString().slice(0,10),total:rooms,sold:zero?0:sold,publicBookings:zero?0:sold,phoneBookings:0,missing:missing&&i===3,collectedAt:START+'T01:00:00Z',estimatedRevenue:zero?0:sold*200000}))});
  const own=make('own','own','sancheong',10,1),same=make('same','competitor',crossOnly?'jinju':'sancheong',20,10),cross=make('cross','competitor','jinju',30,27);
  const raw=[own,same,cross],report={mode:'current_briefing',published:false,ownId:'own',asOf:START,selection:{stayMode:'upcoming30'},period:{start:START,end:END,days:30},generatedAt:START+'T02:00:00Z',dataQuality:{status:'complete',issues:[]},companies:raw.map(c=>{const company={...c,sourceStatus:'ready',sourceIssues:[],...summarizeCompany(c,policy),reservationSeries:projectReservationSeries(c,policy)};delete company.days;company.summaryQuality.mode='current';return company;}),comparisons:[same,cross].map(c=>projection.projectComparison(evaluateComparison(own,c,policy)))};
  const selection={ownCompanyId:'own',comparisonIds:['same','cross'],stayMode:'upcoming30',stayStart:START,stayEnd:END,asOfDate:START,selectedView:'flow'};
  const catalog=raw.map(c=>({companyId:c.companyId,name:c.name,rooms:c.rooms}));
  return {report,selection,catalog};
}
const build=f=>api.computeOperatingPlan(f.report,f.selection,f.catalog);

test('customer name and selected same-region daily peers drive proposals; cross-region is never pooled',()=>{
  const f=fixture(),before=JSON.stringify(f),view=build(f),day=view.days[0];
  assert.equal(view.company.name,'시즌글램핑');assert.equal(view.company.rooms,10);assert.equal(view.groups.same.length,1);assert.equal(view.groups.cross.length,1);
  assert.equal(day.owner.rate,.1);assert.equal(day.peers.rate,.5);assert.equal(day.peers.supply,20);assert.equal(day.gapPp,-40);assert.equal(day.peers.expectedCompanies,1);
  assert.equal(day.action,'limited_coupon_review');assert.equal(day.policyActionable,true);assert.equal(day.executionAllowed,false);assert.equal(day.owner.available,null);assert.equal(day.owner.observedUnsold,9);
  assert.equal(view.summary.validDays,30);assert.equal(view.summary.couponReviewDays,15);assert.equal(JSON.stringify(f),before);
});
test('same-region weighted rates use available supply, not an unweighted percentage average',()=>{
  const f=fixture();f.report.companies[2].regionKey='sancheong';const raw=f.report.companies[2],pair=f.report.comparisons[1];pair.regionRelation='same';pair.region.relation='same';pair.region.competitorRegionKey='sancheong';pair.region.competitorAnalysisRegionKey='sancheong';
  const view=build(f);assert.equal(view.days[0].peers.supply,50);assert.equal(view.days[0].peers.rate,37/50);assert.notEqual(view.days[0].peers.rate,(.5+.9)/2);assert.equal(raw.rooms,30);
});
test('a same-region facility from a different or unknown industry stays visible but cannot raise the coupon benchmark',()=>{
  const f=fixture(),pair=f.report.comparisons[1];f.report.companies[2].regionKey='sancheong';pair.regionRelation='same';pair.region.relation='same';pair.region.competitorRegionKey='sancheong';pair.region.competitorAnalysisRegionKey='sancheong';pair.industryRelation='mixed';pair.industry.relation='mixed';pair.industry.competitorIndustryKeys=['poolVilla'];pair.industry.sharedIndustryKeys=[];pair.actionable=false;
  let view=build(f);assert.equal(view.groups.same.length,2);assert.equal(view.summary.sameRegionCompanies,2);assert.equal(view.summary.sameIndustryPeerCompanies,1);assert.equal(view.days[0].peers.expectedCompanies,1);assert.equal(view.days[0].peers.rate,.5);assert.equal(view.days[0].peers.excludedCompanies,1);assert.equal(view.days[0].excludedPeerReferences[0].companyId,'cross');assert.match(view.days[0].excludedPeerReferences[0].reason,/다른 업종/);
  const same=f.report.comparisons[0];same.industryRelation='unknown';same.industry.relation='unknown';same.industry.ownIndustryKeys=[];same.industry.sharedIndustryKeys=[];same.actionable=false;
  view=build(f);assert.equal(view.summary.couponReviewDays,0);assert.equal(view.summary.sameIndustryPeerCompanies,0);assert.ok(view.days.every(day=>day.peers.rate===null));
});
test('normal zero keeps a measured rate while a missing date remains unknown',()=>{
  const zero=build(fixture({zero:true}));assert.equal(zero.days[0].owner.rate,0);assert.equal(zero.days[0].owner.sold,0);
  const missing=build(fixture({missing:true}));assert.equal(missing.summary.validDays,29);assert.equal(missing.summary.missingDays,1);assert.equal(missing.days[3].owner.rate,null);assert.equal(missing.days[3].action,'hold');
});
test('pending ownership and unconfirmed central action policy keep useful review drafts without granting action permission',()=>{
  for(const options of[{pending:true},{unconfirmed:true},{review:true}]){
    const view=build(fixture(options)),day=view.days[0];assert.equal(view.groups.same[0].actionable,false);assert.equal(day.policyActionable,false);assert.equal(day.status,'review');assert.equal(day.action,'limited_coupon_review');assert.ok(day.preconditions.length);assert.ok(day.reasons.some(x=>x.includes('중앙 비교')));assert.equal(view.executionAllowed,false);
  }
});
test('only cross-region peers produce operational references, never coupon candidates or a pooled benchmark',()=>{
  const view=build(fixture({crossOnly:true}));assert.equal(view.groups.same.length,0);assert.equal(view.groups.cross.length,2);assert.equal(view.summary.couponReviewDays,0);assert.ok(view.days.every(day=>day.peers.rate===null&&day.action==='sales_conditions_review'));assert.ok(view.days[0].reasons.some(x=>x.includes('타지역')));
});
test('a selected empty comparison set is preserved and unselected companies never enter evidence or groups',()=>{
  const f=fixture();f.selection.comparisonIds=[];f.report.companies[2].name='PRIVATE-UNSELECTED';const view=build(f);
  assert.equal(view.groups.same.length,0);assert.equal(view.groups.cross.length,0);assert.equal(view.summary.couponReviewDays,0);assert.doesNotMatch(JSON.stringify(view),/PRIVATE-UNSELECTED/);
});
test('customer identity, registered-company scope, period and published artifacts fail closed',()=>{
  const changes=[f=>f.selection.ownCompanyId='foreign',f=>f.selection.comparisonIds.push('foreign'),f=>f.catalog=f.catalog.filter(c=>c.companyId!=='same'),f=>f.report.ownId='foreign',f=>f.report.period.end='2026-11-27',f=>f.report.asOf='2026-10-29',f=>f.report.published=true,f=>f.report.mode='published_report',f=>f.selection.comparisonIds.push('same')];
  for(const mutate of changes){const f=fixture();mutate(f);const view=build(f);assert.equal(view.contextValid,false);assert.equal(view.days.length,0);assert.equal(view.summary.couponReviewDays,0);}
});
test('conflicting repeated dates, room-basis conflicts and malformed quantity identities never become pricing facts',()=>{
  const changes=[f=>f.report.companies[0].reservationSeries.points.push(clone(f.report.companies[0].reservationSeries.points[0])),f=>f.report.companies[0].reservationSeries.points[0].total=11,f=>f.report.companies[0].reservationSeries.points[0].phoneBookings=1,f=>f.report.companies[0].reservationSeries.points[0].collectedDate='2026-10-31'];
  for(const mutate of changes){const f=fixture();mutate(f);const view=build(f);assert.equal(view.days[0].owner.rate,null);assert.equal(view.days[0].action,'hold');}
});
test('common-date eligibility and eighty-percent coverage control candidates without filling peer gaps',()=>{
  const f=fixture();f.report.comparisons[0].dates=f.report.comparisons[0].dates.slice(0,3);f.report.comparisons[0].commonDays=3;f.report.comparisons[0].quality.quantity.commonDays=3;f.report.comparisons[0].comparable=false;f.report.comparisons[0].quality.reservationRate.comparable=false;
  const view=build(f);assert.equal(view.summary.couponReviewDays,0);assert.ok(view.days.every(d=>d.action==='hold'));assert.equal(view.days[0].peers.rate,null);
});
test('observed prices require same property, stay date and observation day; revenue per reservation is never a price',()=>{
  const f=fixture(),view=build(f);assert.equal(view.days[0].owner.price,null);assert.deepEqual(view.days[0].owner.products,[]);assert.equal(view.days[0].change.publicNetChange,null);
  const prices=[{source:'stored_product_price',companyId:'own',date:START,productId:'room',name:'객실',price:179000,observedAt:START+'T02:00:00Z'},{source:'stored_product_price',companyId:'foreign',date:START,productId:'secret',name:'PRIVATE-FOREIGN',price:1,observedAt:START+'T02:00:00Z'},{source:'stored_product_price',companyId:'own',date:START,productId:'stale',name:'PRIVATE-STALE',price:1,observedAt:'2026-10-29T02:00:00Z'}];
  const withPrices=api.computeOperatingPlan(f.report,f.selection,f.catalog,{priceRows:prices});assert.equal(withPrices.days[0].owner.price,179000);assert.equal(withPrices.days[0].owner.products.length,1);assert.equal(withPrices.days[1].owner.price,null);assert.doesNotMatch(JSON.stringify(withPrices),/PRIVATE-/);
});
test('preview results hold coupon candidates while older valid observations disclose their actual observation day',()=>{
  const preview=fixture();preview.report.responseCache={preview:true};const draft=build(preview);assert.equal(draft.summary.couponReviewDays,0);assert.ok(draft.days.every(day=>day.action==='hold'));assert.ok(draft.limits.some(x=>x.includes('미리보기')));
  const older=fixture();for(const company of older.report.companies)for(const row of company.reservationSeries.points){row.collectedAt='2026-10-28T01:00:00Z';row.collectedDate='2026-10-28';}const result=build(older);assert.equal(result.days[0].leadDays,0);assert.equal(result.days[0].owner.collectedDate,'2026-10-28');assert.ok(result.days[0].evidence.some(x=>x.includes('실제 수량 관측일 2026-10-28')));assert.ok(result.days[0].reasons.some(x=>x.includes('그 뒤 검토 기준일까지')));
});
test('unknown control fields and provider errors are never copied into a customer plan',()=>{
  const f=fixture();f.selection.secret='PRIVATE-SELECTION';f.report.accessToken='PRIVATE-TOKEN';f.report.companies[0].rawError='PRIVATE-ERROR';const view=build(f);assert.doesNotMatch(JSON.stringify(view),/PRIVATE-/);
  f.selection.ownCompanyId='foreign';assert.doesNotMatch(JSON.stringify(build(f)),/PRIVATE-/);
});
test('a newer company series cannot be joined to a comparison calculated from another observation version',()=>{
  const f=fixture();f.report.companies[0].reservationSeries.points[0].collectedAt=START+'T03:00:00Z';const view=build(f);assert.equal(view.days[0].owner.rate,.1);assert.equal(view.days[0].peers.rate,null);assert.equal(view.days[0].action,'hold');assert.equal(view.days[1].action,'limited_coupon_review');
});
test('coupon calculations use explicit hypothetical inputs and preserve safe arithmetic, unknowns, limits and real zero',()=>{
  const values={price:179000,discountPercent:10,variableCost:50000,commissionPercent:10,baselineRooms:2,capacity:4},result=api.computeCouponScenario(values);assert.equal(result.discountedPrice,161100);assert.equal(result.discountPerRoom,17900);assert.equal(result.baselineContributionPerRoom,111100);assert.equal(result.couponContributionPerRoom,94990);assert.equal(result.breakEvenRooms,3);assert.equal(result.extraRooms,1);assert.equal(result.capacityFeasible,true);
  assert.equal(api.computeCouponScenario({...values,capacity:2}).status,'capacity_exceeded');
  for(const key of ['variableCost','commissionPercent','baselineRooms','capacity'])assert.equal(api.computeCouponScenario({...values,[key]:null}).breakEvenRooms,null);
  assert.equal(api.computeCouponScenario({price:100000,variableCost:0,commissionPercent:0,baselineRooms:0,capacity:0}).status,'calculated');
  assert.equal(api.computeCouponScenario({...values,discountPercent:100}).status,'unprofitable');assert.equal(api.computeCouponScenario({...values,capacity:1}).status,'invalid');assert.equal(api.computeCouponScenario({...values,baselineRooms:Number.MAX_SAFE_INTEGER,capacity:Number.MAX_SAFE_INTEGER}).status,'invalid');
});
test('browser UMD calculation has no network, timer, storage or mutation side effects',()=>{
  const context={window:{},fetch:()=>assert.fail('network'),localStorage:{setItem:()=>assert.fail('storage')},setTimeout:()=>assert.fail('timer')};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-readiness.js'),'utf8'),context);vm.runInNewContext(fs.readFileSync(require.resolve('../web/customer-operating-actions.js'),'utf8'),context);
  const f=fixture(),before=JSON.stringify(f),view=context.window.InsightCustomerOperatingActions.computeOperatingPlan(f.report,f.selection,f.catalog);assert.equal(view.company.name,'시즌글램핑');assert.equal(view.days.length,30);assert.equal(JSON.stringify(f),before);
});
test('large safe integer quantities never lose whole rooms to a scaled rounding tolerance',()=>{
  const unchanged=api.computeCouponScenario({price:1,discountPercent:0,variableCost:0,commissionPercent:0,baselineRooms:4000000000000000,capacity:4000000000000000});
  assert.equal(unchanged.status,'calculated');assert.equal(unchanged.breakEvenRooms,4000000000000000);assert.equal(unchanged.extraRooms,0);
  const halfPrice=api.computeCouponScenario({price:2,discountPercent:50,variableCost:0,commissionPercent:0,baselineRooms:2000000000000000,capacity:4000000000000000});
  assert.equal(halfPrice.status,'calculated');assert.equal(halfPrice.breakEvenRooms,4000000000000000);assert.equal(halfPrice.extraRooms,2000000000000000);
});
