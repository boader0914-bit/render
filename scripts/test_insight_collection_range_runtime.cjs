'use strict';
// Executes the deployed crawler functions with inert provider responses. The
// crawler entry point, browser, network, storage, and scheduler are never run.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'gyeongnam_glamping_crawl.cjs'),'utf8');
function sourceFunction(name){
  const start=source.indexOf(`async function ${name}(`);assert.ok(start>=0);
  const next=/\n(?:async )?function /.exec(source.slice(start+1));
  return source.slice(start,next?start+1+next.index:source.length);
}
const start='2026-10-27',addDays=(date,index)=>new Date(Date.parse(date+'T00:00:00Z')+index*86400000).toISOString().slice(0,10);
function fixture(){
  const calls=[],targets=[],items=Array.from({length:16},(_,i)=>({bizItemId:String(i+1),name:'가상 객실 '+(i+1),price:100000}));
  const context={
    GUARDED_COLLECTION:false,DAY_USE_MODE:'detail',COLLECTION_PROFILE:{collectWeeklyRange:true},BOOKING_RANGE_DAYS:30,CHECK_IN:start,
    NAVER_SCHEDULE_CONCURRENCY:2,NAVER_SCHEDULE_DELAY_MS:0,delay:async()=>{},addDays,
    selectProductTargets:rows=>rows,
    getNaverBookingBusiness:async()=>({bookingBusinessId:'fixture-business',bookingUrl:'https://fixture.invalid'}),
    getNaverBookingItems:async()=>({items}),
    dayUsePlan:()=>({all:items,eligible:items,collectDayUseSchedules:true,listComplete:true,presence:'absent',excludedDayUse:false}),
    naverBookingSaleType:()=> '숙박',
    getNaverDailySchedule:async(businessId,itemId,date)=>{calls.push({businessId,itemId,date});return {status:200,errors:[],day:{stock:1,bookingCount:0,occupiedBookingCount:0,prices:[{price:100000}]}};},
    productCoverage:{discover:(businessId,all,eligible,dates)=>targets.push({businessId,products:eligible.length,dates}),record:()=>{},snapshot:()=>({targets:[{businessId:'fixture-business'}]})},
    asStockNumber:value=>typeof value==='number'?value:null,couponSource:()=>({}),summarizeNaverCouponExposure:()=>({couponStatus:'없음'}),getNaverBookingPageCouponSignal:async()=>null,
    naverScheduleResponseDiagnostics:()=>({}),
    classifyNaverBookingList:()=> '객실별 예약리스트',
    summarizeNaverScheduleGroup:(_items,schedules)=>({availableStock:schedules.length,totalStock:schedules.length,observedTotalStock:schedules.length,soldOutStock:0,rate:0,estimatedRevenue:0,pricedSoldOut:0,missingPriceSoldOut:0,avgSoldUnitPrice:0,knownStockCount:schedules.length,observedProductCount:schedules.length,unverifiedOccupied:0,unverifiedUnavailable:0,inventoryConflictCount:0}),
    operatingTotalBasisFromTotals:(_totals,basis)=>({operatingTotal:basis,operatingTotalDays:30,structuralBlockedTotal:0,stockBasisType:'fixture'}),
    buildProductStockBasis:()=>new Map(),allocateInventoryShortfall:()=>({byProduct:new Map(),unallocated:0}),
    compactNaverScheduleDetail:(schedule,_type,date)=>({date,bizItemId:schedule.bizItemId}),scheduleProductKey:row=>row.bizItemId,
    revenueProjectionFields:()=>({adjustedEstimatedRevenue:0,missingPriceEstimatedRevenue:0,revenuePrecisionRate:1}),
    shortDate:value=>value,formatRate:value=>String(value),formatWon:value=>String(value),summarizeRevenueByDayType:()=>'',
    summarizeNaverBookingAvailability:()=>({}),withoutUncollectedDayUse:value=>value,applyCrawlerInventoryEvidence:value=>value
  };
  const code=['mapWithConcurrency','collectNaverSchedulesForItems','collectWeeklyNaverAvailability','collectNaverBookingAvailability'].map(sourceFunction).join('\n');
  const read=vm.runInNewContext(code+'\ncollectNaverBookingAvailability',context);
  return {read,calls,targets,items};
}
test('the enabled one-company range path observes sixteen products on all thirty stay dates without network access',async()=>{
  const h=fixture(),cache=new Map(),result=await h.read('123456',cache,{collectRange:true});
  assert.equal(h.calls.length,16*30,'the initial date is reused once and the other twenty-nine dates are queried');
  assert.equal(new Set(h.calls.map(row=>row.date)).size,30);
  for(let i=0;i<30;i++)assert.equal(h.calls.filter(row=>row.date===addDays(start,i)).length,16);
  assert.equal(result.weekly.requestedDays,30);assert.equal(result.weekly.observedDays,30);assert.equal(result.weekly.productDetails.length,16*30);
  assert.deepEqual(Array.from(result.weekly.dates,row=>row.date),Array.from({length:30},(_,i)=>addDays(start,i)));
  assert.equal(h.targets[0].dates.length,30);assert.equal(result.weekly.dates.at(-1).date,'2026-11-25');
  assert.equal(await h.read('123456',cache,{collectRange:true}),result);assert.equal(h.calls.length,16*30,'same-place reuse never sends another product/date query');
});
test('the disabled legacy range path reproduces one day instead of certifying a thirty-day response',async()=>{
  const h=fixture(),result=await h.read('123456',new Map(),{collectRange:false});
  assert.equal(h.calls.length,16);assert.deepEqual([...new Set(h.calls.map(row=>row.date))],[start]);
  assert.equal(result.weekly,null);assert.equal(h.targets[0].dates.length,1);
});
