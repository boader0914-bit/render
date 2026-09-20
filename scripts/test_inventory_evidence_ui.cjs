"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {applyInventoryEvidence} = require("./inventory_estimation.cjs");
const mint = applyInventoryEvidence(require("./fixtures/mint_20260920.cjs"));
const source = fs.readFileSync(path.join(__dirname,"../web/app.js"),"utf8");
const names = ["inventoryAssessment","roomCapacityPresentation","sheetInventorySummary","sheetBookingQuantityBasis","inventorySourceHtml","sheetDisclosure","escapeHtml","fmtNumber","fmtRate","weeklyRows","salesStats","bookingGraphRows","itemRevenueStats","projectedRevenueFields","finiteNumber","optionalNumber","parseDate","monthDay","isoAddDays","normalizeMonthDayLabel","bookingRangeLabels","bookingDays"];
const context = vm.createContext({state:{data:{run:{checkIn:"2026-09-20",checkOut:"2026-10-20",bookingRangeDays:31}}},DEFAULT_BOOKING_DAYS:31});
for (const name of names) {
  const declaration = source.match(new RegExp(`^function ${name}\\([^]*?^}`,"m"))?.[0];
  assert.ok(declaration, name);
  vm.runInContext(declaration, context);
}
const stats = context.salesStats(mint);
const chart = context.bookingGraphRows(mint);
assert.equal(stats.supply,667);
assert.equal(chart.reduce((n,r)=>n+r.total,0),stats.supply,"List and detail must share a denominator");
assert.equal(chart.reduce((n,r)=>n+r.sold,0),stats.sold);
assert.equal(stats.sold,151);
assert.equal(context.itemRevenueStats(mint).adjustedRevenue,35699000);
assert.equal(context.itemRevenueStats(mint,"day").adjustedRevenue,297000);
assert.equal(context.salesStats(mint,"day").sold,3);
assert.equal(context.weeklyRows(mint,"day").filter(r=>r.total===0).length,4,"Closed days must remain inspectable");
const missing = {...mint,inventoryEvidence:{...mint.inventoryEvidence,lodging:{...mint.inventoryEvidence.lodging,rows:mint.inventoryEvidence.lodging.rows.slice(1)}}};
assert.equal(context.bookingGraphRows(missing)[0].missing,true,"Uncollected dates are not zero-booking observations");
const conflictItem = applyInventoryEvidence({weeklyProductDetails:[{date:"2026-09-20",stock:0,bookingCount:2,price:100000}]});
assert.ok(Number.isNaN(context.salesStats(conflictItem).rate),"Conflicting stock/booking data must not become 100 percent");
assert.ok(Number.isNaN(context.weeklyRows(conflictItem)[0].rate));
assert.ok(Number.isNaN(context.bookingGraphRows(conflictItem)[0].rate));
assert.equal(context.roomCapacityPresentation(mint).count,28);
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{lodgingBasisTotal:26}}).count,28,"Operating basis must not replace verified physical capacity");
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{lodgingBasisTotal:26}}).operatingCount,26);
assert.equal(context.roomCapacityPresentation({...mint,companyManualCorrection:{active:false,lodgingBasisTotal:26}}).operatingCount,null);
const example = {
  inventoryEvidence: {version:2,physicalRooms:{count:null},lodging:{
    total:246,sold:68,status:"observed",complete:true,
    rows:Array.from({length:31},(_,i)=>({date:`2026-09-${i+1}`,rawTotal:i===0?6:8,total:i===0?6:8}))
  }}
};
assert.equal(context.roomCapacityPresentation(example).count,null,"246 over 31 days does not prove 8 physical rooms");
assert.equal(context.roomCapacityPresentation(example).dailyText,"6~8실 / 일");
assert.equal(context.roomCapacityPresentation({...example,companyManualCorrection:{roomSegments:[{type:"부분 입력",count:4}]}}).count,null,"Partial room-type input must not become physical total");
const exampleHtml = context.sheetInventorySummary(example);
assert.match(exampleHtml,/<span>객실 총량<\/span><strong>확인 전/);
assert.match(exampleHtml,/<strong>68박<\/strong>/);
assert.match(exampleHtml,/31일 집계 · 예약 비율 28%/);
assert.doesNotMatch(exampleHtml,/<strong>68 \/ 246<\/strong>/);
assert.match(exampleHtml,/246은 날짜별 공개 수량의 합계/);
const allMissing = {...example,inventoryEvidence:{...example.inventoryEvidence,lodging:{...example.inventoryEvidence.lodging,status:"missing",rows:[{missing:true,total:0}]}}};
assert.equal(context.roomCapacityPresentation(allMissing).maximum,null,"Missing dates are not zero capacity");
assert.equal(context.roomCapacityPresentation(conflictItem).maximum,0,"Conflicting reservations must not inflate public room stock");
console.log("inventory UI: list/detail/revenue/closed-day consistency passed");
