'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const model=require('../web/comparison-readiness.js');
const {evaluateComparison,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const historical=require('./fixtures/report-period-fixture.cjs');
const START='2026-10-25',END='2026-11-23',DAY=86400000,AT=Date.parse(START+'T00:00:00Z');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture({missing=false,price=false,zero=false,skew=false,stale=false,short=false,review=false,cross=false}={}){
 const policy={mode:'current',asOf:START,period:{start:START,end:END},observationPolicy:{confirmed:true,maxSkewMs:7200000}};
 const company=(companyId,kind)=>({companyId,kind,name:companyId==='own'?'월명 검수 매장':'등록 비교 매장',rooms:16,regionKey:kind==='competitor'&&cross?'other':'sancheong',industryTags:['glamping'],comparisonPurpose:'direct',relationStatus:'active',capacityReviewRequired:review,
   days:Array.from({length:short?6:30},(_,i)=>({date:new Date(AT+i*DAY).toISOString().slice(0,10),total:16,sold:zero?0:2,publicBookings:zero?0:1,phoneBookings:zero?0:1,estimatedRevenue:price&&i===2?null:zero?0:200000,revenuePartial:price&&i===2,revenueUnknownRooms:price&&i===2?2:0,phoneMissingPriceBookings:price&&i===2?1:0,missing:missing&&i===4,collectedAt:stale?'2026-10-01T00:00:00.000Z':skew&&kind==='competitor'?'2026-10-24T00:00:00.000Z':'2026-10-25T00:00:00.000Z'}))});
 const own=company('own','own'),comp=company('comp','competitor'),raw=[own,comp];
 return {ownId:'own',mode:'current_briefing',period:{start:START,end:END,days:30},generatedAt:'2026-10-25T01:00:00Z',companies:raw.map(c=>({companyId:c.companyId,name:c.name,kind:c.kind,relationStatus:c.relationStatus,rooms:c.rooms,...summarizeCompany(c,policy),reservationSeries:projectReservationSeries(c,policy),sourceStatus:'ready',sourceIssues:[]})),comparisons:[evaluateComparison(own,comp,policy)],dataQuality:{status:'complete',issues:[]}};
}
test('readiness keeps central quantities and eligibility with real zero intact',()=>{
 const r=fixture({zero:true}),v=model.build(r);assert.equal(v.status,'ready');assert.equal(v.companies[0].quantity.sold,0);assert.equal(v.companies[0].knownRevenueSubtotal,0);assert.equal(v.companies[0].revenueUnknownRooms,0);assert.equal(v.companies[0].availableDays,30);assert.equal(v.companies[0].missingDayCount,0);assert.equal(v.companies[0].coverageKnown,true);assert.equal(v.comparisons[0].comparable,true);assert.equal(v.comparisons[0].rate.gapPp,0);assert.equal(v.comparisons[0].actionable,true);
 assert.equal(JSON.stringify(r),JSON.stringify(fixture({zero:true})),'input is not changed');
});
test('unknown counts stay null and exact missing dates remain distinct from zero',()=>{
 const v=model.build(fixture({missing:true})),c=v.companies[0];assert.equal(c.availableDays,29);assert.deepEqual(c.missingDays,['2026-10-29']);assert.equal(c.missingDayCount,1);assert.equal(c.quantity.sold,58);assert.equal(v.comparisons[0].commonDays,29);assert.ok(c.issues.some(i=>i.code==='QUANTITY_MISSING'&&i.date==='2026-10-29'));
 const unavailable=fixture();unavailable.companies[0].summary={days:0,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null,knownRevenueSubtotal:null,revenueUnknownRooms:null};delete unavailable.companies[0].reservationSeries;delete unavailable.companies[0].summaryQuality;const c2=model.build(unavailable).companies[0];assert.equal(c2.quantity.sold,null);assert.equal(c2.knownRevenueSubtotal,null);assert.equal(c2.revenueUnknownRooms,null);assert.equal(c2.coverageKnown,false);
});
test('different observation days are reference only and enumerate exact excluded dates',()=>{
 const v=model.build(fixture({skew:true})),c=v.comparisons[0];assert.equal(c.commonDays,0);assert.equal(c.comparable,false);assert.equal(c.rate.gapPp,null);assert.equal(c.excludedDates.length,30);assert.deepEqual(c.excludedDates[0].codes,['OBSERVATION_DAY_DIFFERENT']);assert.equal(c.excludedDates[0].side,'both');assert.ok(c.reasons.some(r=>r.code==='OBSERVATION_DAY_DIFFERENT'));
});
test('a six-day sample never becomes comparable through local availability calculations',()=>{
 const v=model.build(fixture({short:true})),c=v.comparisons[0];assert.equal(c.commonDays,6);assert.equal(c.minimumDays,7);assert.equal(c.quantity.comparable,false);assert.equal(c.rate.comparable,false);assert.equal(c.actionable,false);assert.equal(c.rate.gapPp,null);assert.equal(v.companies[0].missingDays.length,24);
});
test('unknown price does not become zero or suppress normal quantity comparisons',()=>{
 const v=model.build(fixture({price:true})),c=v.companies[0],pair=v.comparisons[0];assert.equal(c.quantity.sold,60);assert.equal(c.knownRevenueSubtotal,5800000);assert.equal(c.revenueUnknownRooms,2);assert.deepEqual(c.unknownRevenueDates,['2026-10-27']);assert.equal(pair.quantity.comparable,true);assert.equal(pair.revenue.comparable,false);assert.equal(pair.revenue.status,'partial');assert.deepEqual(pair.revenue.unknownDates,['2026-10-27']);
});
test('selection includes registered identities once and never exposes nonselected diagnostics',()=>{
 const r=fixture();r.companies.push({...clone(r.companies[1]),companyId:'foreign',name:'PRIVATE-COMPANY'});r.dataQuality.issues=[{scope:'company',companyId:'foreign',code:'COMPANY_MONTH_UNAVAILABLE',reason:'PRIVATE-FAILURE'}];const v=model.build(r,{ownCompanyId:'own',comparisonIds:['comp','comp','own','not_registered']});assert.deepEqual(v.companies.map(c=>c.companyId),['own','comp']);assert.equal(v.comparisons.length,1);assert.ok(v.issues.some(i=>i.code==='DUPLICATE_COMPANY'));assert.ok(v.issues.some(i=>i.code==='INVALID_COMPANY'));assert.doesNotMatch(JSON.stringify(v),/PRIVATE/);
 assert.deepEqual(model.build(r,{comparisonIds:[]}).companies.map(c=>c.companyId),['own']);
});
test('wrong own identity and inactive registrations fail closed',()=>{
 assert.equal(model.build(fixture(),{ownCompanyId:'other'}).companies.length,0);const r=fixture();r.companies[1].relationStatus='removed';const v=model.build(r,{comparisonIds:['comp']});assert.equal(v.comparisons.length,0);assert.equal(v.companies.length,1);
});
test('old comparison rows and wrong-period central results are not promoted',()=>{
 const r=fixture();r.comparisons=[{companyId:'comp',commonDays:30,status:'comparable',gapPp:3}];let c=model.build(r).comparisons[0];assert.equal(c.legacy,true);assert.equal(c.comparable,false);assert.equal(c.commonDays,null);assert.equal(c.reasons[0].code,'LEGACY_COMPARISON');
 const wrong=fixture();wrong.comparisons[0].basisDetail.asOf='2026-10-24';c=model.build(wrong).comparisons[0];assert.equal(c.comparable,false);assert.equal(c.reasons[0].code,'CONTEXT_MISMATCH');
 wrong.companies[0].summaryQuality.asOf='2026-10-24';assert.equal(model.build(wrong).companies[0].quantity.sold,null);
});
test('preview can display saved values but cannot claim a completed comparison',()=>{
 const r=fixture();r.responseCache={preview:true,refreshing:true,refreshFailed:false,checkedAt:'2026-10-25T01:00:00Z'};const v=model.build(r);assert.equal(v.companies[0].quantity.sold,60);assert.equal(v.comparisons[0].quantity.comparable,false);assert.equal(v.comparisons[0].comparable,false);assert.equal(v.comparisons[0].actionable,false);assert.equal(v.comparisons[0].rate.gapPp,null);assert.equal(v.source.refreshing,true);assert.ok(v.issues.some(i=>i.code==='PREVIEW_RESULT'));
});
test('every saved-only preview signal independently prevents completed comparison claims',()=>{
 for(const signal of [{responseCache:{state:'preview'}},{responseCache:{preview:true}},{calculation:{mode:'saved_only'}}]){
  const r={...fixture(),...signal},v=model.build(r);assert.equal(v.source.preview,true);assert.equal(v.companies[0].quantity.sold,60);assert.equal(v.comparisons[0].comparable,false);assert.equal(v.comparisons[0].quantity.comparable,false);assert.equal(v.comparisons[0].revenue.comparable,false);assert.equal(v.comparisons[0].actionable,false);
 }
});
test('daily availability inconsistent with summary is held without changing saved values',()=>{
 const r=fixture();r.companies[0].summary.days=29;const v=model.build(r),c=v.companies[0];assert.equal(c.coverageKnown,false);assert.equal(c.availableDays,null);assert.equal(c.missingDayCount,null);assert.equal(c.quantity.sold,60);assert.ok(c.issues.some(i=>i.code==='CONTEXT_MISMATCH'));
});
test('daily duplicates and central duplicate-date warnings never claim a known coverage',()=>{
 for(const mutate of [r=>{r.companies[0].reservationSeries.points[1]={...r.companies[0].reservationSeries.points[0]};},r=>{r.companies[0].summaryQuality.duplicateStayDates=[START];}]){
  const r=fixture();mutate(r);const c=model.build(r).companies[0];assert.equal(c.availableDays,null);assert.equal(c.coverageKnown,false);assert.ok(c.missingDays.includes(START));assert.ok(c.issues.some(i=>i.code==='DUPLICATE_STAY_DATE'));assert.ok(c.issues.some(i=>i.code==='CONTEXT_MISMATCH'));
 }
});
test('historical missing causes identify collection and inventory issues without inventing amount failures',()=>{
 const labels={run_blocked:'수집 접근 제한',missing_response:'예약 응답',partial_inventory:'상품 재고 일부',shared_dayuse_unverified:'공유 수량'};
 for(const [cause,label] of Object.entries(labels)){
  const r=historical.report(),missing=r.companies[0].reservationPeriods.months.flatMap(m=>m.weeks.flatMap(w=>w.daily)).find(d=>d.missing);missing.missingReason=cause;
  const c=model.build(r).companies[0],issue=c.issues.find(i=>i.code===cause.toUpperCase());assert.ok(issue);assert.match(issue.label,new RegExp(label));assert.equal(issue.scope,'quantity');assert.equal(issue.date,'2026-09-30');assert.deepEqual(c.unknownRevenueDates,['2026-10-02']);assert.equal(c.issues.some(i=>i.code==='REVENUE_UNKNOWN'&&i.date==='2026-09-30'),false);
 }
});
test('a later failed recheck preserves a successful day and labels the latest attempt separately',()=>{
 const r=historical.report(),point=r.companies[0].reservationPeriods.months[0].weeks[0].daily[0];assert.equal(point.date,'2026-09-29');point.latestAttemptReason='run_blocked';point.latestAttemptError='PRIVATE-PROVIDER';
 const c=model.build(r).companies[0];assert.equal(c.coverageKnown,true);assert.equal(c.availableDays,3);assert.deepEqual(c.missingDays,['2026-09-30']);const cause=c.issues.find(i=>i.date===point.date&&i.code==='RUN_BLOCKED');assert.equal(cause.scope,'timing');assert.match(cause.label,/최근 재확인/);assert.match(cause.label,/정상 자료는 유지/);assert.doesNotMatch(JSON.stringify(c),/PRIVATE/);
});
test('source failures expose canonical reason and periods without provider error or credentials',()=>{
 const r=fixture(),failure={scope:'company',companyId:'own',period:{start:'2026-10-25',end:'2026-10-31'},code:'COMPANY_MONTH_UNAVAILABLE',reason:'PRIVATE-TOKEN',rawError:'PRIVATE-ERROR',stack:'PRIVATE-STACK'};r.companies[0].sourceStatus='partial';r.companies[0].sourceIssues=[failure];r.dataQuality.issues=[failure,{...failure,code:'PRIVATE_SECRET_CODE'}];r.token='PRIVATE-ROOT';r.companies[0].summary.token='PRIVATE-SUMMARY';const v=model.build(r),c=v.companies[0];assert.equal(c.quantity.sold,60);assert.equal(c.issues.filter(i=>i.code==='COMPANY_MONTH_UNAVAILABLE').length,1);assert.deepEqual(c.issues.find(i=>i.code==='COMPANY_MONTH_UNAVAILABLE').period,failure.period);assert.ok(c.issues.some(i=>i.code==='SOURCE_CONFIRMATION_REQUIRED'));assert.doesNotMatch(JSON.stringify(v),/PRIVATE|token|stack|rawError/i);
});
test('historical and all-available periods preserve missing dates and unknown amounts',()=>{
 const r=historical.report(),v=model.build(r);assert.deepEqual(v.period,{start:'2026-09-29',end:'2026-10-02',days:4,asOf:'2026-10-26',valid:true});assert.equal(v.source.mode,'historical');assert.deepEqual(v.companies[0].missingDays,['2026-09-30']);assert.deepEqual(v.companies[0].unknownRevenueDates,['2026-10-02']);assert.equal(v.companies[0].knownRevenueSubtotal,300);assert.equal(v.companies[0].revenueUnknownRooms,null);assert.equal(v.companies[0].coverageKnown,true);
});
test('room count has no artificial forty-room maximum or scale classification',()=>{
 const r=fixture();r.companies[0].rooms=72;const c=model.build(r).companies[0];assert.equal(c.rooms,72);assert.equal(c.capacity.label,'객실 기준 72실');assert.equal(c.scale,undefined);
 const review=model.build(fixture({review:true}));assert.equal(review.comparisons[0].actionable,false);assert.ok(review.comparisons[0].reasons.some(r=>r.code==='CAPACITY_REVIEW_REQUIRED'));
});
test('pair room-basis flags stay visible without guessing which company needs review',()=>{
 const r=fixture({review:true});r.comparisons[0].reasons=[];const v=model.build(r);assert.equal(v.companies[0].capacity.reviewRequired,false);assert.equal(v.companies[1].capacity.reviewRequired,false);assert.equal(v.comparisons[0].actionable,false);assert.ok(v.comparisons[0].reasons.some(i=>i.code==='CAPACITY_REVIEW_REQUIRED'));
 const conflict=fixture();conflict.comparisons[0].quality.quantity.capacityConflict=true;conflict.comparisons[0].quality.quantity.capacityKnown=false;conflict.comparisons[0].reasons=[];const pair=model.build(conflict).comparisons[0],reasons=pair.reasons;assert.equal(pair.comparable,false);assert.equal(pair.actionable,false);assert.ok(reasons.some(i=>i.code==='CAPACITY_CONFLICT'));assert.ok(reasons.some(i=>i.code==='CAPACITY_UNKNOWN'));
});
test('stale observations retain their central exclusion reasons instead of filling zeros',()=>{
 const v=model.build(fixture({stale:true}));assert.equal(v.companies[0].quantity.sold,null);assert.equal(v.companies[0].missingDays.length,30);assert.ok(v.companies[0].issues.some(r=>r.code==='OBSERVATION_STALE'));assert.equal(v.comparisons[0].comparable,false);
});
test('valid leap days and the 3660-day bound are checked before expanding dates',()=>{
 const r=fixture();r.period={start:'2024-02-28',end:'2024-03-01',days:3};r.asOf='2026-10-25';r.companies=[];assert.equal(model.build(r).period.valid,true);
 r.period={start:'2026-02-29',end:'2026-03-01',days:2};assert.equal(model.build(r).period.valid,false);
 r.period={start:'2000-01-01',end:new Date(Date.parse('2000-01-01')+3659*DAY).toISOString().slice(0,10),days:3660};assert.equal(model.build(r).period.valid,true);
 r.period.end=new Date(Date.parse('2000-01-01')+3660*DAY).toISOString().slice(0,10);r.period.days=3661;assert.equal(model.build(r).period.valid,false);
});
test('empty saved history does not acquire zero-valued observations',()=>{
 const r=historical.report(undefined,{empty:true}),v=model.build(r);assert.equal(v.period.valid,true);assert.equal(v.period.days,0);assert.equal(v.status,'unavailable');assert.equal(v.companies[0].quantity.sold,null);assert.equal(v.companies[0].knownRevenueSubtotal,null);
});
test('browser export has no network, collection, storage or mutation side effects',()=>{
 const context={window:{},Date,Set,Map,Object,Array,Number,JSON,String,globalThis:{},fetch:()=>assert.fail('network'),localStorage:{setItem:()=>assert.fail('write')}};vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-readiness.js'),'utf8'),context);assert.equal(typeof context.window.InsightComparisonReadiness.build,'function');assert.equal(context.window.InsightComparisonReadiness.build(fixture()).companies.length,2);assert.equal(context.window.InsightComparisonReadiness.build(fixture({cross:true})).comparisons[0].actionable,false);
});
