"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {applyInventoryEvidence} = require("./inventory_estimation.cjs");
const mint = applyInventoryEvidence(require("./fixtures/mint_20260920.cjs"));
const source = fs.readFileSync(path.join(__dirname,"../web/app.js"),"utf8");
const names = ["inventoryAssessment","roomCapacityPresentation","manualCorrectionRoomSegments","cleanManualCorrectionSegment","manualCorrectionSegmentHasValue","sheetInventorySummary","sheetBookingQuantityBasis","sheetCollectionStatusPanel","inventorySourceHtml","sheetDisclosure","escapeHtml","fmtNumber","fmtRate","weeklyRows","salesStats","bookingGraphRows","bookingQuantityBreakdown","sheetRowsForBooking","dateRow","miniBars","itemRevenueStats","projectedRevenueFields","finiteNumber","optionalNumber","parseDate","monthDay","isoAddDays","normalizeMonthDayLabel","bookingRangeLabels","bookingDays"];
const context = vm.createContext({state:{data:{run:{checkIn:"2026-09-20",checkOut:"2026-10-20",bookingRangeDays:31}}},DEFAULT_BOOKING_DAYS:31,B2B_MY_LODGE_SEGMENT_LIMIT:8,isAdminRole:()=>true});
for (const name of names) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`,"m"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}
const stats = context.salesStats(mint);
const chart = context.bookingGraphRows(mint);
assert.equal(stats.supply,27 * 31,"The observed maximum, not the public room description, stays in every date's denominator");
assert.equal(chart.reduce((n,r)=>n+r.total,0),stats.supply,"List and detail must share a denominator");
assert.equal(chart.reduce((n,r)=>n+r.sold,0),stats.sold);
assert.equal(stats.rawSold,151,"Observed Naver bookings remain independently visible");
assert.equal(stats.sharedDayUseExcluded,3);
assert.equal(stats.sold,569,"Fixed room capacity includes inferred phone bookings but excludes three shared day-use blocks");
assert.equal(stats.phoneBookings,418);
assert.equal(mint.inventoryEvidence.lodging.publicRevenue,35699000);
assert.equal(context.itemRevenueStats(mint).adjustedRevenue,mint.inventoryEvidence.lodging.revenue);
assert.equal(context.itemRevenueStats(mint,"day").adjustedRevenue,297000);
assert.equal(context.salesStats(mint,"day").sold,3);
assert.equal(context.weeklyRows(mint,"day").filter(r=>r.rawTotal===0).length,4,"Zero public-stock days must remain inspectable with the fixed denominator");
const missing = {...mint,inventoryEvidence:{...mint.inventoryEvidence,lodging:{...mint.inventoryEvidence.lodging,rows:mint.inventoryEvidence.lodging.rows.slice(1)}}};
assert.equal(context.bookingGraphRows(missing)[0].missing,true,"Uncollected dates are not zero-booking observations");
const conflictItem = applyInventoryEvidence({weeklyProductDetails:[{date:"2026-09-20",stock:0,bookingCount:2,price:100000}]});
assert.ok(Number.isNaN(context.salesStats(conflictItem).rate),"Conflicting stock/booking data must not become 100 percent");
assert.ok(Number.isNaN(context.weeklyRows(conflictItem)[0].rate));
assert.ok(Number.isNaN(context.bookingGraphRows(conflictItem)[0].rate));
assert.equal(context.roomCapacityPresentation(mint).count,27);
assert.equal(context.roomCapacityPresentation(mint).physicalCount,28);
assert.equal(context.roomCapacityPresentation(mint).estimated,true,"The fixed maximum remains a calculation basis while physical evidence stays separate");
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{lodgingBasisTotal:26}}).count,26,"Active DB correction takes precedence over both observation and public room references");
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{lodgingBasisTotal:26}}).operatingCount,26);
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{active:false,lodgingBasisTotal:26}}).operatingCount,null);
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{active:false,lodgingBasisTotal:26}}).count,27);
const example = {
  inventoryEvidence: {version:2,physicalRooms:{count:null},lodging:{
    total:246,sold:68,status:"observed",complete:true,
    rows:Array.from({length:31},(_,i)=>({date:new Date(Date.UTC(2026,8,20+i)).toISOString().slice(0,10),rawTotal:i===0?6:8,total:i===0?6:8}))
  }}
};
assert.equal(context.roomCapacityPresentation(example).count,8,"Use the largest observed daily lodging quantity as the displayed estimate");
assert.equal(context.roomCapacityPresentation(example).physicalCount,null,"An observed maximum does not become verified physical capacity");
assert.equal(context.roomCapacityPresentation(example).estimated,true);
assert.equal(context.roomCapacityPresentation(example).minimum,6);
assert.equal(context.roomCapacityPresentation(example).maximum,8);
assert.equal(context.roomCapacityPresentation(example).dailyText,"6~8실 / 일");
const correctedSegments = {...example,companyManualCorrection:{active:true,roomSegments:[{type:"스탠다드",count:4},{type:"디럭스",roomCount:2},{type:"미입력"},{type:"잘못된 수량",count:-8}]}};
const segmentCapacity = context.roomCapacityPresentation(correctedSegments);
assert.equal(segmentCapacity.count,6,"Legacy evidence uses the active DB room-type count sum before the observed maximum");
assert.equal(segmentCapacity.physicalCount,null,"DB room counts remain distinct from public reference metadata");
assert.equal(segmentCapacity.estimated,false);
assert.equal(segmentCapacity.sourceLabel,"DB 보정");
assert.match(context.sheetInventorySummary(correctedSegments),/<strong>6실<\/strong><small>DB 보정/);
assert.equal(context.roomCapacityPresentation({...correctedSegments,companyManualCorrection:{...correctedSegments.companyManualCorrection,lodgingBasisTotal:3}}).count,3,"An explicit DB total takes precedence over room-type sums");
const legacySegmentItem = {weeklyReservationRateDetail:"9/20 20%(2/10)",companyManualCorrection:correctedSegments.companyManualCorrection};
assert.equal(context.roomCapacityPresentation(legacySegmentItem).count,6,"DB room-type correction also applies without inventory evidence or raw products");
assert.equal(context.roomCapacityPresentation({...legacySegmentItem,manualLodgingBasisTotal:99,companyManualCorrection:{...correctedSegments.companyManualCorrection,active:false}}).count,10,"Inactive segment correction must not revive stale manual aliases");
assert.equal(context.roomCapacityPresentation({...legacySegmentItem,manualLodgingBasisTotal:99,companyManualCorrection:{}}).count,10,"Cleared correction must not revive stale manual aliases");
assert.equal(context.roomCapacityPresentation({...example,companyManualCorrection:{roomSegments:[{type:"수량 미입력"}]}}).count,8,"Room types without valid counts do not establish DB capacity");
const operating = context.roomCapacityPresentation({...example,companyManualCorrection:{lodgingBasisTotal:26}});
assert.equal(operating.count,26,"DB correction takes precedence even on a legacy evidence record");
assert.equal(operating.physicalCount,null);
assert.equal(operating.operatingCount,26);
assert.equal(operating.estimated,false);
assert.equal(operating.sourceLabel,"DB 보정");
const exampleHtml = context.sheetInventorySummary(example);
assert.match(exampleHtml,/<span>객실 총량<\/span><strong>8실<\/strong>/);
assert.match(exampleHtml,/최대 관측\(추정\)/);
assert.match(exampleHtml,/<strong>68박<\/strong>/);
assert.match(exampleHtml,/31일 집계 · 예약 비율 28%/);
assert.equal(context.salesStats(example).rate,68/246,"The room estimate must not change the period booking-rate denominator");
assert.doesNotMatch(exampleHtml,/<strong>68 \/ 246<\/strong>/);
assert.match(exampleHtml,/246은 날짜별 공개 수량의 합계/);
const allMissing = {...example,inventoryEvidence:{...example.inventoryEvidence,lodging:{...example.inventoryEvidence.lodging,status:"missing",rows:[{missing:true,total:0}]}}};
assert.equal(context.roomCapacityPresentation(allMissing).maximum,null,"Missing dates are not zero capacity");
assert.equal(context.roomCapacityPresentation(allMissing).count,null);
assert.equal(context.roomCapacityPresentation(allMissing).estimated,false);
assert.equal(context.roomCapacityPresentation(conflictItem).maximum,0,"Conflicting reservations must not inflate public room stock");
assert.equal(context.roomCapacityPresentation(conflictItem).count,null,"A zero observed quantity does not become a positive room estimate");
assert.equal(context.roomCapacityPresentation(conflictItem).estimated,false);

const withLodgingRows = (rows, additions = {}) => ({...example,inventoryEvidence:{...example.inventoryEvidence,...additions,lodging:{...example.inventoryEvidence.lodging,rows}}});
const periodOnly = context.roomCapacityPresentation(withLodgingRows([]));
assert.equal(periodOnly.count,null,"Never reverse-calculate room capacity from 246 room-nights / 31 days");
assert.equal(periodOnly.maximum,null);
assert.equal(periodOnly.estimated,false);
const allZero = context.roomCapacityPresentation(withLodgingRows([{rawTotal:0,total:0},{rawTotal:0,total:0}]));
assert.equal(allZero.count,null);
assert.equal(allZero.maximum,0,"Keep zero as a valid observed range endpoint");
assert.equal(allZero.dailyText,"0실 / 일");
assert.equal(allZero.estimated,false);

const rawPriority = context.roomCapacityPresentation(withLodgingRows([
  {rawTotal:6,total:60}, {rawTotal:8,total:80}, {missing:true,rawTotal:999,total:999}
],{dayUse:{rows:[{rawTotal:1000,total:1000}],total:1000}}));
assert.equal(rawPriority.count,8,"Prefer raw lodging stock; ignore inferred totals, missing dates and day-use capacity");
assert.equal(rawPriority.maximum,8);
assert.equal(context.roomCapacityPresentation(withLodgingRows([{total:7},{rawTotal:null,total:9}])).count,9,"Use daily total only when rawTotal is absent");
const verified = context.roomCapacityPresentation(withLodgingRows([{rawTotal:40,total:40}],{physicalRooms:{count:28}}));
assert.equal(verified.count,40,"A public room description remains reference-only even on legacy evidence");
assert.equal(verified.physicalCount,28);
assert.equal(verified.maximum,40,"Keep the observed range separate from the displayed physical count");
assert.equal(verified.estimated,true);
const referenceOnly = withLodgingRows([],{physicalRooms:{count:28}});
assert.equal(context.roomCapacityPresentation(referenceOnly).count,null,"A public description alone never establishes room capacity");
assert.match(context.sheetInventorySummary(referenceOnly),/객실 안내 참고/);
assert.doesNotMatch(context.sheetInventorySummary(referenceOnly),/직접 확인한 객실 수를 우선|확인된 객실 수/);
const legacyFixedTotal = withLodgingRows([{total:28,available:20,publicBookings:1}],{
  version:3,physicalRooms:{count:28}
});
legacyFixedTotal.inventoryEvidence.lodging.operatingTotal = 28;
const unknownLegacyCapacity = context.roomCapacityPresentation(legacyFixedTotal);
assert.equal(unknownLegacyCapacity.count,null,"A v3 derived total without raw stock cannot become an observed capacity");
assert.equal(unknownLegacyCapacity.dailyText,"공개 수량 미확인");
assert.match(context.sheetInventorySummary(legacyFixedTotal),/<span>객실 총량<\/span><strong>확인 전<\/strong>/);
assert.match(context.sheetInventorySummary(legacyFixedTotal),/객실 안내 참고/);
const legacyObservedMaximum = {...legacyFixedTotal,inventoryEvidence:{...legacyFixedTotal.inventoryEvidence,lodging:{...legacyFixedTotal.inventoryEvidence.lodging,observedMaximum:21}}};
assert.equal(context.roomCapacityPresentation(legacyObservedMaximum).count,21,"Trust a preserved observed maximum separately from guide-derived daily totals");
assert.equal(context.roomCapacityPresentation(legacyObservedMaximum).dailyText,"공개 수량 미확인");

const historicalMaximum = withLodgingRows([{rawTotal:8,total:8}],{
  version:4,capacityBasis:{source:"observed_maximum",count:12,observedMaximum:12,currentObservedMaximum:8}
});
assert.equal(context.roomCapacityPresentation(historicalMaximum).count,12,"Preserve the same company's historical maximum from server evidence");
assert.equal(context.roomCapacityPresentation(historicalMaximum).maximum,8,"Current public daily range remains independent");
const metadataCorrection = withLodgingRows([{rawTotal:40,total:40}],{
  version:4,capacityBasis:{source:"db_correction",count:26,observedMaximum:40,currentObservedMaximum:40}
});
assert.equal(context.roomCapacityPresentation(metadataCorrection).count,26);
assert.match(context.sheetInventorySummary(metadataCorrection),/DB 보정/);
assert.equal(context.roomCapacityPresentation({...metadataCorrection,companyManualCorrection:{active:false,lodgingBasisTotal:26}}).count,40,"Inactive correction cannot keep an old DB capacity label or value");
const canonicalReference = withLodgingRows([{rawTotal:40,total:40}],{
  version:4,roomGuideReference:{count:28},physicalRooms:{count:900}
});
assert.equal(context.roomCapacityPresentation(canonicalReference).physicalCount,28,"Read canonical reference metadata before the compatibility alias");
assert.equal(context.roomCapacityPresentation(canonicalReference).count,40);
const reviewNeeded = withLodgingRows([{rawTotal:52,total:52}],{
  capacityReview:{required:true,threshold:40,message:"글램핑 객실 총량 40실 초과"}
});
assert.equal(context.roomCapacityPresentation(reviewNeeded).count,52,"Review flags must never cap the displayed total");
assert.match(context.sheetInventorySummary(reviewNeeded),/객실 수 검토 필요/);
assert.match(context.sheetInventorySummary(reviewNeeded),/글램핑 객실 총량 40실 초과/);
assert.equal(context.roomCapacityPresentation(withLodgingRows([{rawTotal:52,total:52}])).reviewRequired,false,"The UI does not infer glamping classification from a large total");
const maliciousReview = withLodgingRows([{rawTotal:52,total:52}],{capacityReview:{required:true,message:'<img src=x onerror=alert(1)>'}});
assert.doesNotMatch(context.sheetInventorySummary(maliciousReview),/<img src=x/);
const smallerDbCapacity = applyInventoryEvidence({
  inventoryCapacityBaseline:{lodgingOverride:{count:5,source:"db_manual_correction"}},
  weeklyProductDetails:[{date:"2026-09-20",bizItemId:"db-room",saleType:"숙박",stock:10,bookingCount:9,price:100000}]
});
const smallerDbRow = context.sheetRowsForBooking(smallerDbCapacity)[0];
assert.equal(context.roomCapacityPresentation(smallerDbCapacity).count,5,"Keep an exact smaller DB count visible when public stock conflicts");
assert.equal(context.salesStats(smallerDbCapacity).phoneBookings,0);
assert.ok(Number.isNaN(context.salesStats(smallerDbCapacity).rate));
assert.ok(Number.isNaN(smallerDbRow.rate));
assert.match(context.sheetInventorySummary(smallerDbCapacity),/<strong>5실<\/strong><small>DB 보정/);
assert.match(context.dateRow(smallerDbRow),/DB 보정과 수집 수량 충돌/);
assert.match(context.dateRow(smallerDbRow),/예약 비율 확인 필요/);
assert.doesNotMatch(context.sheetInventorySummary(smallerDbCapacity),/180%/);
assert.doesNotMatch(context.dateRow(smallerDbRow),/180%/);

const shiftingProducts = applyInventoryEvidence({weeklyProductDetails:[
  {date:"2026-09-20",bizItemId:"room-a",saleType:"숙박",stock:8,bookingCount:0,price:100000},
  {date:"2026-09-20",bizItemId:"room-b",saleType:"숙박",stock:2,bookingCount:0,price:100000},
  {date:"2026-09-21",bizItemId:"room-a",saleType:"숙박",stock:3,bookingCount:0,price:100000},
  {date:"2026-09-21",bizItemId:"room-b",saleType:"숙박",stock:7,bookingCount:0,price:100000}
]});
const simultaneousMaximum = context.roomCapacityPresentation(shiftingProducts);
assert.equal(simultaneousMaximum.count,10,"Use max(8+2, 3+7)=10 from the same dates, never max(8,3)+max(2,7)=15 across products");
assert.equal(simultaneousMaximum.physicalCount,null);
assert.equal(simultaneousMaximum.estimated,true);

// Season regression: a lower public inventory must not shrink the total.
const season = applyInventoryEvidence({weeklyDays:2,weeklyProductDetails:[
  {date:"2026-09-20",bizItemId:"season",saleType:"숙박",stock:10,bookingCount:0,price:100000},
  {date:"2026-09-21",bizItemId:"season",saleType:"숙박",stock:3,bookingCount:3,price:100000}
]});
const seasonRows = context.sheetRowsForBooking(season);
assert.equal(context.roomCapacityPresentation(season).count,10);
assert.equal(context.salesStats(season).supply,20);
assert.equal(seasonRows[0].sold,0,"Zero public bookings with ten available rooms must stay zero bookings");
assert.equal(seasonRows[0].phoneBookings,0);
assert.equal(seasonRows[1].supply,10);
assert.equal(seasonRows[1].publicBookings,3);
assert.equal(seasonRows[1].phoneBookings,7);
assert.equal(seasonRows[1].sold,10);
assert.equal(seasonRows[1].rate,1);
const seasonDateHtml = context.dateRow(seasonRows[1]);
assert.match(seasonDateHtml,/예약 추정 10객실 \/ 객실 총량 10객실/);
assert.match(seasonDateHtml,/네이버 3객실 · 전화예약 추정 7객실/);
assert.doesNotMatch(seasonDateHtml,/과거 추정|예약 관측 10/);
assert.match(context.miniBars(season),/네이버 3실 · 전화예약 추정 7실/);
const seasonSummary = context.sheetInventorySummary(season);
assert.match(seasonSummary,/최대 관측\(추정\) · 날짜별 고정/);
assert.match(seasonSummary,/네이버 3박 · 전화예약 추정 7박/);
assert.match(seasonSummary,/10박 ÷ 20객실·박 = 50%/);
assert.match(seasonSummary,/예약 가능한 객실의 예약 수량이 0인 경우는 전화예약으로 더하지 않습니다/);
const seasonCollectionStatus = context.sheetCollectionStatusPanel(season);
assert.match(seasonCollectionStatus,/예약 추정 보류 0박/);
assert.doesNotMatch(seasonCollectionStatus,/판매 중지·기타 이용 불가 0건/);
assert.match(context.sheetCollectionStatusPanel(example),/판매 중지·기타 이용 불가 0건/,"The v2 label keeps its original meaning");

const sharedSeason = applyInventoryEvidence({...season,inventoryEvidence:undefined,weeklyProductDetails:[
  ...season.weeklyProductDetails,
  {date:"2026-09-20",bizItemId:"day",saleType:"데이유즈",stock:3,bookingCount:0,price:50000},
  {date:"2026-09-21",bizItemId:"day",saleType:"데이유즈",stock:3,bookingCount:2,price:50000}
]});
const sharedRows = context.sheetRowsForBooking(sharedSeason);
assert.equal(sharedRows[1].supply,10);
assert.equal(sharedRows[1].publicBookings,3,"Day-use blocks never erase direct lodging bookings");
assert.equal(sharedRows[1].phoneBookings,5);
assert.equal(sharedRows[1].sharedDayUseExcluded,2);
assert.equal(sharedRows[1].sold,8);
assert.equal(sharedRows[1].rate,0.8);
assert.equal(context.salesStats(sharedSeason,"day").sold,2);
assert.match(context.dateRow(sharedRows[1]),/당일 이용 차단 제외 2객실/);
const sharedSummary = context.sheetInventorySummary(sharedSeason);
assert.match(sharedSummary,/객실 공유 가정/);
assert.match(sharedSummary,/전화예약 추정 5박 · 당일 이용 차단 제외 2박/);
assert.match(sharedSummary,/당일 이용 차단 2박은 숙박 예약 추정에서 제외/);

const closedSeason = applyInventoryEvidence({weeklyDays:2,weeklyProductDetails:[
  {date:"2026-09-20",bizItemId:"season",saleType:"숙박",stock:10,bookingCount:0,price:100000},
  {date:"2026-09-21",bizItemId:"season",saleType:"숙박",stock:10,bookingCount:0,open:false,price:100000}
]});
const closedRow = context.sheetRowsForBooking(closedSeason)[1];
assert.equal(closedRow.publicBookings,0);
assert.equal(closedRow.phoneBookings,10,"Unavailable stock is explicitly estimated instead of being presented as confirmed bookings");
assert.match(context.dateRow(closedRow),/네이버 0객실 · 전화예약 추정 10객실/);
const partialSeason = applyInventoryEvidence({weeklyDays:2,weeklyProductDetails:[
  {date:"2026-09-20",bizItemId:"a",saleType:"숙박",stock:5,bookingCount:0,price:100000},
  {date:"2026-09-20",bizItemId:"b",saleType:"숙박",stock:5,bookingCount:0,price:100000},
  {date:"2026-09-21",bizItemId:"a",saleType:"숙박",stock:3,bookingCount:1,price:100000}
]});
assert.equal(context.sheetRowsForBooking(partialSeason)[1].phoneBookings,0,"Missing products must not turn into telephone reservations");
assert.ok(Number.isNaN(context.sheetRowsForBooking(partialSeason)[1].rate));
assert.ok(Number.isNaN(context.weeklyRows(partialSeason)[1].rate));
assert.ok(Number.isNaN(context.salesStats(partialSeason).rate),"A partial period does not display an apparently complete booking rate");
console.log("inventory UI: fixed total, observed/phone split, available zero-booking rooms, shared day-use exclusion, closed dates and legacy compatibility passed");
