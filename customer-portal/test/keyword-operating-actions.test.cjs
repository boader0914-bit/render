'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs');
const content=path.join(__dirname,'../review/keyword-comparison/src/content/shared');
const api=import(pathToFileURL(path.join(content,'operating-actions.mjs')).href);
const comparison=import(pathToFileURL(path.join(content,'comparison-engine.mjs')).href);
const clone=value=>JSON.parse(JSON.stringify(value));
function row(extra={}){return {runId:'current',companyId:'own',date:'2026-09-23',supply:10,publicBookings:1,inferredBookings:0,sold:1,available:9,
  dayUseExcluded:0,quantityStatus:'valid',priceValues:[100000],productPrices:[{id:'room',name:'숙박상품',price:100000,conditionStatus:'unverified'}],productCount:1,
  productSignature:'room',capacityRevision:'basis-v1',sourceRefs:['saved:row'],reasons:[],...extra};}
function fixture(){
  const members=['own','peer1','peer2','peer3'];
  const current=[row(),...members.slice(1).map(companyId=>row({companyId,publicBookings:5,sold:5,available:5,priceValues:[90000]}))];
  return {meta:{ownerPlaceId:'35644668',defaultRunId:'current',defaultStart:'2026-09-23',defaultEnd:'2026-09-23',archiveDirectoryDate:'2026-10-22'},
    runs:[{id:'previous',observedAt:'2026-09-21T16:00:00Z',members},{id:'current',observedAt:'2026-09-22T16:00:00Z',members}],
    companies:members.map((id,index)=>({id,placeId:index?'peer'+index:'35644668',name:id,capacity:{rooms:10,reviewed:id==='own'},ranks:{current:index+1}})),
    daily:[...current.map(item=>({...clone(item),runId:'previous'})),...current]};
}
async function model(input,options={}){return (await comparison).computeComparison(input,options);}

test('operating benchmark excludes owner and uses same-date supply weighted peers',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();
  const result=computeOperatingActions(input,await model(input));
  assert.equal(result.days[0].owner.rate,0.1);assert.equal(result.days[0].peers.rate,0.5);
  assert.equal(result.days[0].peers.expectedCompanies,3);assert.equal(result.days[0].peers.validCompanies,3);
  assert.equal(result.days[0].peers.supply,30);assert.equal(result.days[0].gapPp,-40);
  assert.equal(result.summary.peerLabel,'월명 제외 표본');assert.equal(result.summary.peerRate,0.5);
  assert.equal(result.days[0].action,'limited_coupon_review');
});
test('days remaining use Korea observation date, not today or the UTC date',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();
  const result=computeOperatingActions(input,await model(input));
  assert.equal(result.selection.asOfDate,'2026-09-23');assert.equal(result.days[0].leadDays,0);
  assert.match(result.limits.join(' '),/실제 예약 리드타임이 아닙니다/);
});
test('normal zero remains a valid candidate while unknown zero is held',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();const own=input.daily.find(item=>item.runId==='current'&&item.companyId==='own');
  Object.assign(own,{publicBookings:0,sold:0,available:10});
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.rate,0);assert.equal(result.days[0].action,'limited_coupon_review');
  own.quantityStatus='legacy_unverified';result=computeOperatingActions(input,await model(input));
  assert.equal(result.days[0].owner.rate,null);assert.equal(result.days[0].action,'hold');assert.equal(result.summary.couponReviewDays,0);
});
test('unreviewed owner capacity, negative horizon and missing peers each hold decisions',async()=>{
  const {computeOperatingActions}=await api;
  for(const modify of [s=>{s.companies[0].capacity.reviewed=false;},s=>{s.runs[1].observedAt='2026-09-24T05:00:00Z';},s=>{s.daily=s.daily.filter(item=>item.companyId==='own');}]){
    const input=fixture();modify(input);const result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'hold');assert.equal(result.days[0].status,'hold');
  }
});
test('a reviewed room basis cannot be overridden by an internally valid but different supply',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();input.companies[0].capacity.rooms=16;
  const result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'hold');assert.ok(result.days[0].reasonCodes.includes('owner_capacity_mismatch'));
});
test('available stock must reconcile with sold plus shared day-use, not inferred from supply minus sold',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();const own=input.daily.find(item=>item.runId==='current'&&item.companyId==='own');
  own.dayUseExcluded=2;own.available=7;
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.available,7);assert.equal(result.days[0].owner.sold,1);assert.equal(result.days[0].action,'limited_coupon_review');
  delete own.available;result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.available,null);assert.equal(result.days[0].action,'sales_conditions_review');
  own.available=9;delete own.dayUseExcluded;result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.available,null);assert.equal(result.days[0].owner.dayUseExcluded,null);
});
test('one conflicting duplicate quarantines that company-date instead of summing it',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();input.daily.push(clone(input.daily.find(item=>item.runId==='current'&&item.companyId==='own')));
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.sold,1);
  input.daily.at(-1).priceValues=[99999];result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].owner.rate,null);assert.equal(result.days[0].action,'hold');
});
test('peer gaps are missing rather than zero and lower coverage can hold a day',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();input.daily=input.daily.filter(item=>item.runId!=='current'||item.companyId!=='peer3');
  const result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].peers.rate,0.5);assert.equal(result.days[0].peers.coverage,2/3);
  assert.equal(result.days[0].peers.expectedCompanies,3);assert.equal(result.days[0].action,'hold');
});
test('a large later gap reviews sales conditions and no availability does not suggest coupons',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();for(const item of input.daily)item.date='2026-10-20';input.meta.defaultStart=input.meta.defaultEnd='2026-10-20';
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].leadDays,27);assert.equal(result.days[0].action,'sales_conditions_review');
  const own=input.daily.find(item=>item.runId==='current'&&item.companyId==='own');Object.assign(own,{publicBookings:10,sold:10,available:0});
  result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'maintain_price');assert.ok(result.days[0].reasonCodes.includes('no_available_inventory'));
});
test('negative observed changes remain signed and a capacity revision change holds the delta',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();const before=input.daily.find(item=>item.runId==='previous'&&item.companyId==='own');Object.assign(before,{publicBookings:4,sold:4,available:6});
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].change.publicNetChange,-3);assert.ok(result.days[0].reasonCodes.includes('negative_observed_change'));
  before.capacityRevision='another';result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].change.comparable,false);assert.equal(result.days[0].change.publicNetChange,null);
});
test('positive public booking momentum and already lower displayed prices do not prioritize another discount',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();const before=input.daily.find(item=>item.runId==='previous'&&item.companyId==='own');
  Object.assign(before,{publicBookings:0,sold:0,available:10});
  let result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'sales_conditions_review');assert.ok(result.days[0].reasonCodes.includes('public_bookings_growing'));
  Object.assign(before,{publicBookings:1,sold:1,available:9});const current=input.daily.find(item=>item.runId==='current'&&item.companyId==='own');current.priceValues=[80000];
  result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'sales_conditions_review');assert.ok(result.days[0].reasonCodes.includes('visible_price_already_lower'));
});
test('higher inferred reservation counts do not become a confirmed-demand or price-increase signal',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();const own=input.daily.find(item=>item.runId==='current'&&item.companyId==='own');Object.assign(own,{publicBookings:0,inferredBookings:8,sold:8,available:2});
  const result=computeOperatingActions(input,await model(input));assert.equal(result.days[0].action,'maintain_price');assert.ok(result.days[0].reasonCodes.includes('inferred_majority'));
  assert.match(result.days[0].reasons.join(' '),/가격 인상 근거로 해석하지/);
});
test('rule values are explicit hypotheses and do not alter the snapshot or source comparison model',async()=>{
  const {computeOperatingActions}=await api;const input=fixture(),before=JSON.stringify(input),view=await model(input),beforeView=JSON.stringify(view);
  const result=computeOperatingActions(input,view,{gapPp:5,couponLeadDays:7});
  assert.equal(result.rules.gapPp,5);assert.equal(result.rules.couponLeadDays,7);assert.equal(result.rules.label,'검토용 가정');
  assert.equal(result.rules.minimumPeerCoverage,0.8);
  assert.equal(JSON.stringify(input),before);assert.equal(JSON.stringify(view),beforeView);
  assert.equal(result.scenarioDefaults.discountPercent,0);assert.equal(result.scenarioDefaults.commissionPercent,null);
});
test('weekday controls apply to the action population and all empty groups keep unknown rates',async()=>{
  const {computeOperatingActions}=await api;const input=fixture();
  for(const date of ['2026-09-24','2026-09-25'])for(const item of [...input.daily].filter(item=>item.date==='2026-09-23'))input.daily.push({...clone(item),date});
  const result=computeOperatingActions(input,await model(input,{start:'2026-09-23',end:'2026-09-25',dayFilter:'friday'}));
  assert.deepEqual(result.days.map(day=>day.date),['2026-09-25']);assert.equal(result.weekdayGroups.find(day=>day.weekday==='금').matchedDays,1);
  assert.equal(result.weekdayGroups.find(day=>day.weekday==='월').peerRate,null);
});
test('coupon arithmetic preserves baseline contribution, applies commission after coupon and rounds required rooms upward',async()=>{
  const {computeCouponScenario}=await api;
  const result=computeCouponScenario({price:100000,discountPercent:10,variableCost:20000,commissionPercent:10,baselineRooms:5,capacity:10});
  assert.equal(result.discountedPrice,90000);assert.equal(result.discountPerRoom,10000);assert.equal(result.baselineContributionPerRoom,70000);
  assert.equal(result.couponContributionPerRoom,61000);assert.equal(result.baselineContribution,350000);assert.equal(result.breakEvenRooms,6);assert.equal(result.extraRooms,1);assert.equal(result.capacityFeasible,true);assert.equal(result.status,'calculated');
});
test('missing cost, commission or expected unsold inventory assumptions cannot establish profit',async()=>{
  const {computeCouponScenario}=await api;const base={price:100000,discountPercent:10,variableCost:20000,commissionPercent:0,baselineRooms:5,capacity:10};
  for(const key of ['variableCost','commissionPercent','baselineRooms','capacity'])for(const missing of [null,undefined,'']){
    const result=computeCouponScenario({...base,[key]:missing});assert.equal(result.status,'incomplete');assert.equal(result.discountedPrice,90000);assert.equal(result.couponContributionPerRoom,null);assert.equal(result.breakEvenRooms,null);
  }
});
test('explicit zero assumptions are valid and a default zero coupon keeps the expected room count',async()=>{
  const {computeCouponScenario}=await api;const result=computeCouponScenario({price:199000,variableCost:0,commissionPercent:0,baselineRooms:7,capacity:7});
  assert.equal(result.discountPercent,0);assert.equal(result.breakEvenRooms,7);assert.equal(result.extraRooms,0);assert.equal(result.status,'calculated');
  const zero=computeCouponScenario({price:199000,discountPercent:10,variableCost:0,commissionPercent:0,baselineRooms:0,capacity:0});assert.equal(zero.breakEvenRooms,0);assert.equal(zero.extraRooms,0);
});
test('room limits and unprofitable or invalid scenarios are explicit rather than clipped',async()=>{
  const {computeCouponScenario}=await api;const base={price:100000,discountPercent:10,variableCost:20000,commissionPercent:10,baselineRooms:5,capacity:5};
  let result=computeCouponScenario(base);assert.equal(result.breakEvenRooms,6);assert.equal(result.status,'capacity_exceeded');assert.equal(result.capacityFeasible,false);
  result=computeCouponScenario({...base,discountPercent:100});assert.equal(result.status,'unprofitable');assert.equal(result.breakEvenRooms,null);
  for(const change of [{discountPercent:-1},{discountPercent:101},{variableCost:-1},{commissionPercent:101},{baselineRooms:1.5},{capacity:4}])assert.equal(computeCouponScenario({...base,...change}).status,'invalid');
  assert.equal(computeCouponScenario({...base,discountPercent:null}).status,'invalid');
  assert.equal(computeCouponScenario({...base,price:1e100}).status,'invalid');
  assert.equal(computeCouponScenario({...base,baselineRooms:Number.MAX_SAFE_INTEGER,capacity:Number.MAX_SAFE_INTEGER}).status,'invalid');
});
test('actual saved Wolmyeong action dates retain source data and match independently reconciled peers',async()=>{
  const {computeOperatingActions}=await api;const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../review/keyword-comparison/src/data.json'),'utf8'));
  const container=data.queries.comparison_payload.rows[0].payload;const input=typeof container==='string'?JSON.parse(container):container;
  const before=JSON.stringify(input);const result=computeOperatingActions(input,await model(input));
  const day=result.days.find(item=>item.date==='2026-09-29');assert.equal(day.owner.supply,16);assert.equal(day.owner.sold,0);assert.equal(day.owner.available,16);
  assert.equal(day.peers.expectedCompanies,19);assert.equal(day.peers.validCompanies,19);assert.equal(day.peers.supply,414);
  assert.ok(Math.abs(day.peers.rate-0.20531400966183574)<1e-12);assert.equal(day.owner.price,189000);assert.equal(day.peers.price,160000);
  assert.equal(day.change.publicNetChange,0);assert.equal(day.leadDays,7);assert.equal(day.action,'limited_coupon_review');
  assert.equal(result.days.find(item=>item.date==='2026-10-17').action,'sales_conditions_review');
  assert.ok(result.days.find(item=>item.date==='2026-09-23').reasonCodes.includes('public_bookings_growing'));
  assert.ok(result.days.find(item=>item.date==='2026-10-02').reasonCodes.includes('inferred_majority'));
  assert.equal(result.summary.peerExpectedCompanies,19);assert.equal(JSON.stringify(input),before);
});
