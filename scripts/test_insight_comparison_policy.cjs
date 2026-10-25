'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {evaluateComparison,buildComparisonSet,classifyRegion,classifyIndustry,validQuantityDay}=require('./lib/insight_comparison.cjs');
const {buildBriefing}=require('./lib/insight_analysis.cjs');
const row=(i,extra={})=>({date:`2026-10-${String(i+2).padStart(2,'0')}`,total:16,sold:5,publicBookings:2,phoneBookings:3,estimatedRevenue:500000,collectedAt:'2026-10-02T01:00:00Z',...extra});
const company=(id,extra={})=>({companyId:id,name:id,regionKey:'local-sancheong',industryTags:['glamping'],rooms:16,capacityStatus:'reviewed',relationStatus:'active',comparisonPurpose:'direct',days:Array.from({length:8},(_,i)=>row(i)),...extra});
const options={asOf:'2026-10-02',observationPolicy:{confirmed:true,maxSkewMs:3600000}};
const has=(value,code)=>value.reasons.some(r=>r.code===code);
test('same region, common industry and explicit direct purpose are separate conditions',()=>{
  const value=evaluateComparison(company('own'),company('other'),options);
  assert.equal(value.regionRelation,'same');assert.equal(value.industryRelation,'common');assert.equal(value.purpose,'direct');
  assert.equal(value.displayable,true);assert.equal(value.comparable,true);assert.equal(value.actionable,true);
  assert.equal(value.own.sold,40);assert.equal(value.own.publicBookings+value.own.phoneBookings,value.own.sold);assert.equal(value.own.reservationRate,40/128);
  assert.equal(value.basisDetail.regionAdjusted,false);assert.equal(value.basisDetail.statisticalConfidenceClaim,false);
});
test('a different district stays cross-region even in the same province, and direct designation cannot remove the warning',()=>{
  const value=evaluateComparison(company('own',{regionKey:'local-gyeongnam-sancheong'}),company('other',{regionKey:'local-gyeongnam-hadong'}),options);
  assert.equal(value.regionRelation,'cross');assert.equal(value.purpose,'direct');assert.equal(value.comparable,true);assert.equal(value.actionable,false);assert.ok(has(value,'REGION_DIFFERENT'));
});
test('only an explicitly supplied official hierarchy can group general districts under one analysis city',()=>{
  const own=company('own',{regionKey:'suwon-paldal'}),other=company('other',{regionKey:'suwon-yeongtong'});
  assert.equal(classifyRegion(own,other).relation,'cross');
  const region=classifyRegion(own,other,{regionHierarchy:{'suwon-paldal':'suwon','suwon-yeongtong':'suwon'}});
  assert.equal(region.relation,'same');assert.equal(region.hierarchyApplied,true);assert.equal(region.ownRegionKey,'suwon-paldal');assert.equal(region.ownAnalysisRegionKey,'suwon');
  assert.equal(classifyRegion({...own,regionKey:null},{...other,name:'같은 수원시',address:'경기도 수원시'}).relation,'unknown');
});
test('unknown region, industry or purpose are never inferred from a company name or address',()=>{
  const value=evaluateComparison(company('own'),company('other',{name:'산청 글램핑',industryTags:undefined,regionKey:null,comparisonPurpose:null,address:'산청군'}),options);
  assert.equal(value.regionRelation,'unknown');assert.equal(value.industryRelation,'unknown');assert.equal(value.purpose,'reference');assert.equal(value.purposeExplicit,false);
  assert.equal(value.actionable,false);assert.ok(has(value,'PURPOSE_UNSPECIFIED'));
});
test('reference purpose remains reference even in the same region and common industry',()=>{
  const value=evaluateComparison(company('own'),company('other',{comparisonPurpose:'reference'}),options);
  assert.equal(value.regionRelation,'same');assert.equal(value.comparable,true);assert.equal(value.actionable,false);assert.ok(has(value,'REFERENCE_PURPOSE'));
});
test('composite industries use explicit common tags and never duplicate a company in the comparison set',()=>{
  const own=company('own',{industryTags:['glamping','camping']}),other=company('other',{industryTags:['glamping','poolvilla','glamping']});
  const industry=classifyIndustry(own,other);assert.equal(industry.relation,'common');assert.deepEqual(industry.sharedIndustryKeys,['glamping']);assert.equal(industry.composite,true);
  const value=buildComparisonSet(own,[other,{...other},own,company('cross',{regionKey:'gapyeong'})],options);
  assert.equal(value.comparisons.length,2);assert.equal(value.summary.duplicateExcluded,2);assert.equal(value.regionMode,'mixed');assert.equal(value.summary.same,1);assert.equal(value.summary.cross,1);
});
test('different explicit industry tags allow numeric context but no automatic action',()=>{
  const value=evaluateComparison(company('own'),company('other',{industryTags:['pension']}),options);
  assert.equal(value.industryRelation,'mixed');assert.equal(value.comparable,true);assert.equal(value.actionable,false);assert.ok(has(value,'INDUSTRY_DIFFERENT'));
});
test('common seven days is the minimum and six days retain normal reference values',()=>{
  const own=company('own'),other=company('other',{days:company('x').days.slice(0,7)});
  assert.equal(evaluateComparison(own,other,options).comparable,true);
  const six=evaluateComparison(own,{...other,days:other.days.slice(0,6)},options);
  assert.equal(six.commonDays,6);assert.equal(six.displayable,true);assert.equal(six.comparable,false);assert.equal(six.gapPp,null);assert.equal(six.reference.competitor.sold,30);assert.ok(has(six,'INSUFFICIENT_COMMON_DAYS'));
});
test('unknown price does not discard a normal quantity or turn missing revenue into zero',()=>{
  const own=company('own'),other=company('other');other.days[0]={...other.days[0],partial:true,revenuePartial:true,estimatedRevenue:null};
  const value=evaluateComparison(own,other,options);
  assert.equal(value.commonDays,8);assert.equal(value.comparable,true);assert.equal(value.quality.quantity.status,'ready');assert.equal(value.quality.revenue.status,'partial');
  assert.equal(value.quality.revenue.comparable,false);assert.equal(value.competitor.estimatedRevenue,null);assert.equal(value.competitor.knownRevenueSubtotal,3500000);assert.deepEqual(value.competitor.revenueUnknownDays,['2026-10-02']);
  assert.equal(value.competitor.revenueUnknownRooms,null,'a missing price does not invent how many booked rooms lack price');assert.equal(value.own.estimatedRevenue,4000000);
  other.days[0].estimatedRevenue=200000;other.days[0].revenueUnknownRooms=3;
  other.days[0].phoneMissingPriceBookings=2;other.days[0].knownPartialRevenue=100000;
  const partial=evaluateComparison(own,other,options);assert.equal(partial.competitor.knownRevenueSubtotal,3700000);assert.equal(partial.competitor.revenueUnknownRooms,3);assert.equal(partial.competitor.estimatedRevenue,null);
  assert.equal(partial.competitor.completeRevenueSubtotal,3500000);assert.equal(partial.competitor.partialKnownRevenueSubtotal,200000);assert.equal(partial.competitor.knownMissingPhonePriceRooms,2);assert.equal(partial.competitor.separatePartialRevenueSubtotal,100000);
});
test('real zero quantity and revenue survive while missing and failed zeros are excluded',()=>{
  const own=company('own'),other=company('other',{days:company('x').days.map(d=>({...d,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0}))});
  const zero=evaluateComparison(own,other,options);assert.equal(zero.competitor.sold,0);assert.equal(zero.competitor.estimatedRevenue,0);assert.equal(zero.competitor.reservationRate,0);
  other.days[0].missing=true;other.days[1].partial=true;
  const failed=evaluateComparison(own,other,options);assert.equal(failed.commonDays,6);assert.equal(failed.comparable,false);assert.equal(failed.quality.quantity.competitorExcludedDates.length,2);
});
test('public plus other-channel estimates must equal the supplied central reservation total',()=>{
  assert.equal(validQuantityDay(row(0,{phoneBookings:4})),false);
  const other=company('other');other.days[0].phoneBookings=-1;
  const value=evaluateComparison(company('own'),other,options);assert.equal(value.commonDays,7);assert.ok(has(value,'QUANTITY_INVALID'));
});
test('capacity unknown or conflict prevents reservation-rate comparisons without inventing a 40-room cap',()=>{
  const own=company('own'),unknown=evaluateComparison({...own,rooms:null},company('other'),options);
  assert.equal(unknown.displayable,true);assert.equal(unknown.comparable,false);assert.equal(unknown.own.reservationRate,null);assert.ok(has(unknown,'CAPACITY_UNKNOWN'));
  const conflict=evaluateComparison(own,company('other',{capacityStatus:'conflict'}),options);assert.equal(conflict.comparable,false);assert.ok(has(conflict,'CAPACITY_CONFLICT'));
  const sixty=company('large',{rooms:60,days:company('x').days.map(d=>({...d,total:60}))});
  assert.equal(evaluateComparison(sixty,{...sixty,companyId:'large2'},options).comparable,true);
  const mismatch=evaluateComparison(own,company('other',{rooms:17}),options);assert.equal(mismatch.commonDays,8);assert.equal(mismatch.quality.quantity.comparable,true);assert.equal(mismatch.quality.reservationRate.comparable,false);assert.equal(mismatch.competitor.sold,40);assert.ok(has(mismatch,'CAPACITY_CONFLICT'));
});
test('current stale observations are excluded but a historical month uses its own cutoff and stay period',()=>{
  const days=Array.from({length:8},(_,i)=>row(i,{date:`2026-09-${String(i+1).padStart(2,'0')}`,collectedAt:'2026-09-20T01:00:00Z'}));
  const own=company('own',{days}),other=company('other',{days:days.map(d=>({...d}))});
  const current=evaluateComparison(own,other,{...options,period:{start:'2026-09-01',end:'2026-09-30'}});
  assert.equal(current.commonDays,0);assert.ok(has(current,'OBSERVATION_STALE'));
  const historical=evaluateComparison(own,other,{...options,mode:'historical',asOf:'2026-09-30',period:{start:'2026-09-01',end:'2026-09-30'}});
  assert.equal(historical.commonDays,8);assert.equal(historical.comparable,true);assert.equal(historical.basisDetail.currentFreshnessDays,null);assert.equal(has(historical,'OBSERVATION_STALE'),false);
  const future=evaluateComparison(own,other,{...options,mode:'historical',asOf:'2026-09-19',period:{start:'2026-09-01',end:'2026-09-30'}});
  assert.equal(future.commonDays,0);assert.ok(has(future,'OBSERVATION_AFTER_CUTOFF'));
});
test('same stay dates observed on different days remain separately visible reference data',()=>{
  const own=company('own'),other=company('other',{days:company('x').days.map(d=>({...d,collectedAt:'2026-10-01T01:00:00Z'}))});
  const value=evaluateComparison(own,other,options);assert.equal(value.commonDays,0);assert.equal(value.displayable,true);assert.equal(value.reference.own.sold,40);assert.equal(value.reference.competitor.sold,40);assert.equal(value.quality.timing.referenceOnlyDates.length,8);
});
test('same observation day does not imply simultaneous observation; unset, exceeded and unknown times all block actions',()=>{
  const own=company('own'),other=company('other',{days:company('x').days.map(d=>({...d,collectedAt:'2026-10-02T03:00:00Z'}))});
  const unset=evaluateComparison(own,other,{asOf:options.asOf});assert.equal(unset.comparable,true);assert.equal(unset.actionable,false);assert.ok(has(unset,'OBSERVATION_TIME_POLICY_UNSET'));
  const exceeded=evaluateComparison(own,other,options);assert.equal(exceeded.quality.timing.maximumObservedSkewMs,7200000);assert.equal(exceeded.actionable,false);assert.ok(has(exceeded,'OBSERVATION_SKEW_EXCEEDED'));
  const unknown=evaluateComparison(own,{...other,days:other.days.map(d=>({...d,collectedAt:null,collectedDate:'2026-10-02'}))},options);
  assert.equal(unknown.comparable,true);assert.equal(unknown.actionable,false);assert.ok(has(unknown,'OBSERVATION_TIME_UNKNOWN'));assert.equal(unknown.quality.timing.maximumObservedSkewMs,null);
});
test('exact KST day boundary and explicit timezone are respected; locale date-time cannot fabricate a timestamp',()=>{
  const own=company('own',{days:company('x').days.map(d=>({...d,collectedAt:'2026-10-01T15:00:00Z'}))});
  assert.equal(evaluateComparison(own,company('other'),options).commonDays,8);
  const ambiguous=company('other',{days:company('x').days.map(d=>({...d,collectedAt:'2026-10-02T10:00:00'}))});
  assert.equal(evaluateComparison(own,ambiguous,options).commonDays,0);
});
test('duplicate company is excluded, selected stay dates are bounded and overlap never adds room counts twice',()=>{
  const own=company('own'),other=company('other');
  const same=evaluateComparison(own,{...own},options);assert.equal(same.displayable,false);assert.equal(same.commonDays,0);assert.equal(same.status,'excluded');
  other.days.push({...other.days[0]});
  const value=evaluateComparison(own,other,{...options,period:{start:'2026-10-02',end:'2026-10-08'}});
  assert.equal(value.commonDays,7);assert.equal(value.competitor.sold,35);assert.deepEqual(value.basisDetail.duplicateStayDates.competitor,['2026-10-02']);
  other.days.push({...other.days[0],sold:6,publicBookings:3,collectedAt:'2026-10-02T01:30:00Z'});
  const conflicting=evaluateComparison(own,other,{...options,period:{start:'2026-10-02',end:'2026-10-08'}});
  assert.equal(conflicting.commonDays,6);assert.equal(conflicting.comparable,false);assert.ok(has(conflicting,'DUPLICATE_STAY_DATE'));
});
test('input is not mutated and all reasons use controlled codes without raw provider text',()=>{
  const own=company('own'),other=company('other',{errorMessage:'secret-provider-body'}),before=JSON.stringify([own,other]);
  const result=evaluateComparison(own,other,{asOf:'not-a-date',purpose:'untrusted-value'});
  assert.equal(JSON.stringify([own,other]),before);assert.equal(result.comparable,false);assert.equal(JSON.stringify(result).includes('secret-provider-body'),false);assert.equal(result.requestedPurpose,null);
});
test('briefing never suggests competitive superiority from cross-region or time-policy-unconfirmed comparisons',()=>{
  const own=company('own',{kind:'own'}),other=company('other',{kind:'competitor',regionKey:'gapyeong',days:company('x').days.map(d=>({...d,sold:8,publicBookings:5,estimatedRevenue:800000}))});
  const cross=buildBriefing([own,other],[],{today:options.asOf,ownId:'own',observationPolicy:options.observationPolicy});
  assert.ok(cross.actions.some(a=>a.key==='comparison_review'));assert.equal(cross.actions.some(a=>a.key==='compare'||a.key==='track'),false);
  const same=buildBriefing([own,{...other,regionKey:own.regionKey}],[],{today:options.asOf,ownId:'own'});
  assert.equal(same.comparisons[0].comparable,true);assert.equal(same.comparisons[0].actionable,false);assert.equal(same.actions.some(a=>a.key==='compare'||a.key==='track'),false);
  const confirmed=buildBriefing([own,{...other,regionKey:own.regionKey}],[],{today:options.asOf,ownId:'own',observationPolicy:options.observationPolicy});
  assert.ok(confirmed.actions.some(a=>a.key==='compare'));
});
test('historical briefing company totals use the same stay period and cutoff and do not add overlapping dates',()=>{
  const rows=Array.from({length:8},(_,i)=>row(i,{date:`2026-09-${String(i+1).padStart(2,'0')}`,collectedAt:'2026-09-20T01:00:00Z'}));
  rows.push({...rows[0]});
  rows.push(row(0,{date:'2026-09-09',collectedAt:'2026-10-01T01:00:00Z'}));
  rows.push(row(0,{date:'2026-10-02',collectedAt:'2026-09-20T01:00:00Z'}));
  const own=company('own',{kind:'own',days:rows}),other=company('other',{kind:'competitor',days:rows.map(r=>({...r}))});
  const result=buildBriefing([own,other],[],{ownId:'own',today:'2026-10-25',mode:'historical',asOf:'2026-09-30',period:{start:'2026-09-01',end:'2026-09-30'},observationPolicy:options.observationPolicy});
  assert.equal(result.mode,'historical_briefing');assert.equal(result.period.days,30);assert.equal(result.companies[0].summary.days,8);assert.equal(result.companies[0].summary.sold,40);assert.equal(result.comparisons[0].own.sold,40);assert.equal(result.companies[0].lastObservedDay,'2026-09-20');assert.equal(result.companies[0].summaryQuality.excludedDates[0].date,'2026-09-09');
});
test('fractional room counts cannot enter quantity comparisons',()=>{
  assert.equal(validQuantityDay(row(0,{sold:5.5,publicBookings:2.5})),false);
  const result=evaluateComparison(company('own'),company('other',{rooms:16.5}),options);
  assert.equal(result.comparable,false);assert.equal(result.quality.quantity.comparable,true);assert.equal(result.competitor.reservationRate,null);
});
test('explicit invalid periods are rejected rather than silently replaced with a current 30-day window',()=>{
  for(const period of [null,{start:'invalid',end:'2026-10-31'},{start:'2026-10-02'},{}]) {
    const result=evaluateComparison(company('own'),company('other'),{...options,period});
    assert.equal(result.comparable,false);assert.equal(result.commonDays,0);assert.ok(has(result,'INVALID_PERIOD'));
  }
  assert.equal(evaluateComparison(company('own'),company('other'),{...options,mode:'unrecognized'}).comparable,false);
});
test('reference-only dates independently validate their denominator instead of inheriting pair eligibility',()=>{
  const own=company('own'),other=company('other',{days:company('x').days.slice(0,7)});
  own.days[7].total=20;
  const result=evaluateComparison(own,other,options);
  assert.equal(result.comparable,true);assert.equal(result.own.reservationRate,35/112);assert.equal(result.reference.own.sold,40);assert.equal(result.reference.own.reservationRate,null);
});
test('briefing coverage uses distinct valid stay dates instead of duplicated projected rows',()=>{
  const days=Array.from({length:15},(_,i)=>row(i)),own=company('own',{kind:'own',days:[...days,...days.map(r=>({...r}))]});
  const result=buildBriefing([own],[],{today:options.asOf,ownId:'own'});
  assert.equal(result.companies[0].summary.days,15);assert.ok(result.actions.find(a=>a.key==='coverage').reason.includes('15일'));
});
