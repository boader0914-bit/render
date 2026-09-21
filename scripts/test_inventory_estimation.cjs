"use strict";
const assert = require("node:assert/strict");
const { applyInventoryEvidence, productEvidence } = require("./inventory_estimation.cjs");
const mint = require("./fixtures/mint_20260920.cjs");
const before = JSON.stringify(mint);
const result = applyInventoryEvidence(mint);
assert.equal(JSON.stringify(mint), before, "Original evidence must stay unchanged");
assert.equal(result.inventoryEvidence.physicalRooms.count, 28);
assert.equal(result.inventoryEvidence.version, 3);
assert.equal(result.weeklyTotalStock, 868, "Known 28-room capacity remains fixed for all 31 dates");
assert.equal(result.weeklyPublicBookings, 151, "Preserve observed public booking evidence");
assert.equal(result.weeklyPhoneBookings, 449);
assert.equal(result.weeklySharedDayUseExcluded, 3);
assert.equal(result.weeklyTotalSoldOut, 600);
assert.equal(result.weeklyPublicRevenue, 35699000);
assert.equal(result.weeklyPhoneRevenue, 59372000);
assert.equal(result.weeklyAdjustedRevenue, 95071000);
assert.equal(result.weeklyPhoneMissingPriceBookings, 11, "Unmapped shared blocks do not borrow another product's price");
assert.equal(result.dayUseWeeklyTotalStock, 93);
assert.equal(result.dayUseWeeklyTotalSoldOut, 3);
assert.equal(result.dayUseWeeklyAdjustedRevenue, 297000);
assert.equal(result.dayUseWeeklyMissingPriceSoldOut, 0, "Closed dates do not become price-missing sales");
assert.equal(result.inventoryEvidence.lodging.rawTotal, 667, "Preserve original date-varying public stock separately");
assert.equal(result.inventoryEvidence.dayUse.rows.length, 31, "Zero-stock days remain visible");
assert.equal(result.inventoryEvidence.lodging.rows.find(r=>r.date==="2026-10-05").publicBookings, 2, "Shared rooms do not erase independent overnight bookings");
assert.equal(result.inventoryEvidence.lodging.rows.find(r=>r.date==="2026-10-05").phoneBookings, 5);
assert.equal(result.inventoryEvidence.lodging.rows.find(r=>r.date==="2026-10-05").sharedDayUseExcluded, 2);
assert.equal(result.inventoryEvidence.dayUse.rows.find(r=>r.date==="2026-10-05").sold, 2);
assert.equal(applyInventoryEvidence(result), result, "Do not apply corrections twice");
const closed = productEvidence({date:"2026-09-26",stock:0,bookingCount:0,occupiedBookingCount:0,price:0,open:false,listType:"객실별 예약리스트"});
assert.deepEqual([closed.total,closed.sold,closed.missingPriceSoldOut],[0,0,0]);
const shared = productEvidence({date:"2026-09-21",stock:10,bookingCount:2,occupiedBookingCount:3,price:100000,open:true});
assert.deepEqual([shared.total,shared.available,shared.sold,shared.unverifiedOccupied,shared.estimatedRevenue],[10,5,2,3,200000]);
const stockAlreadyReduced = productEvidence({date:"2026-09-21",stock:7,bookingCount:2,occupiedBookingCount:0,price:100000,open:true});
assert.equal(stockAlreadyReduced.sold,2,"Already-reduced stock is not subtracted from reservations again");
assert.equal(productEvidence({stock:null,bookingCount:null,open:false}).observed,false,"Missing provider response is not zero sales");
const priceMissing = productEvidence({stock:5,bookingCount:2,occupiedBookingCount:0,price:null,open:true});
assert.equal(priceMissing.missingPriceSoldOut,2);
assert.equal(priceMissing.estimatedRevenue,0);
const conflict = productEvidence({stock:0,bookingCount:2,price:100000,open:false});
assert.equal(conflict.inventoryConflict,true);
assert.equal(conflict.sold,2,"Retain explicit evidence even when inventory conflicts");
const unknown = applyInventoryEvidence({...mint,placeId:"other"});
assert.equal(unknown.inventoryEvidence.physicalRooms.count,null,"Do not infer physical rooms from max channel stock or product names");
const legacy = { weeklyProductDetails: [{date:"2026-09-20",name:"old",total:5,available:2,soldOut:3}], weeklyTotalSoldOut:3 };
assert.equal(applyInventoryEvidence(legacy),legacy,"Legacy totals alone cannot be upgraded to booking evidence");
assert.equal(applyInventoryEvidence({weeklyProductDetails:[{date:"2026-09-20",name:"데이유즈도 가능한 객실",saleType:"숙박",stock:5,bookingCount:1,price:100000}]}).inventoryEvidence.lodging.sold,1,"Explicit sale type takes precedence over promotional name");
assert.equal(productEvidence({name:"Holiday room",stock:1,bookingCount:1}).kind,"lodging");
assert.equal(productEvidence({name:"대실",stock:1,bookingCount:1}).kind,"dayUse");
assert.equal(productEvidence({stock:" ",bookingCount:false}).observed,false);
const mixed = applyInventoryEvidence({weeklyDays:3,weeklyProductDetails:[
  {date:"2026-09-20",name:"객실",stock:5,bookingCount:1,price:100000},
  {date:"2026-09-22",name:"당일글램핑",stock:null,bookingCount:null,price:null}
],dayUseWeeklyAdjustedRevenue:900});
assert.equal(mixed.inventoryEvidence.dayUse.status,"missing");
assert.equal(mixed.dayUseWeeklyAdjustedRevenue,0,"All-missing day-use evidence must not revive legacy estimated sales");
assert.equal(mixed.inventoryEvidence.lodging.complete,false,"Missing requested dates prevent a complete label");
const row = (date, stock, bookingCount, extra = {}) => ({ date, bizItemId: "room", name: "객실", saleType: "숙박", stock, bookingCount, price: 100000, ...extra });
const season = applyInventoryEvidence({ placeId: "season", weeklyDays: 4, weeklyProductDetails: [
  row("2026-09-25", 10, 0), row("2026-09-26", 3, 3),
  row("2026-09-27", 0, 0), row("2026-09-28", 10, 0, { open: false })
] });
assert.equal(season.weeklyTotalStock, 40);
assert.deepEqual(season.inventoryEvidence.lodging.rows.map(r => [r.total, r.publicBookings, r.phoneBookings, r.sold, r.available]), [
  [10, 0, 0, 0, 10], [10, 3, 7, 10, 0], [10, 0, 10, 10, 0], [10, 0, 10, 10, 0]
], "Zero public bookings means phone inference only for unavailable inventory; closed numeric zero is distinct from missing response");
assert.equal(season.weeklyPhoneRevenue, 2700000);
assert.equal(season.weeklyPublicRevenue, 300000);
const sharedInput = { inventoryCapacityBaseline: { lodging: 10 }, weeklyDays: 1, weeklyProductDetails: [
  row("2026-09-26", 3, 3), row("2026-09-26", 2, 2, { bizItemId: "day", saleType: "데이유즈" })
] };
const sharing = applyInventoryEvidence(sharedInput);
assert.equal(sharing.inventoryEvidence.sharedRooms.status, "assumed_shared");
assert.equal(sharing.weeklyPublicBookings, 3);
assert.equal(sharing.weeklyPhoneBookings, 5);
assert.equal(sharing.weeklySharedDayUseExcluded, 2);
assert.equal(sharing.weeklyTotalSoldOut, 8);
const separate = applyInventoryEvidence({ ...sharedInput, sharedRooms: { status: "separate" } });
assert.equal(separate.weeklySharedDayUseExcluded, 0, "Confirmed separate rooms do not block lodging");
assert.equal(separate.weeklyPhoneBookings, 7);
const capped = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: 5 }, weeklyProductDetails: [
  row("2026-09-26", 4, 3), row("2026-09-26", 20, 20, { bizItemId: "day", saleType: "데이유즈" })
] });
assert.equal(capped.weeklySharedDayUseExcluded, 1, "Day-use subtraction cannot exceed non-public unavailable lodging inventory");
assert.equal(capped.weeklyTotalSoldOut, 3, "Explicit lodging bookings must not be erased by day-use volume");
assert.equal(capped.inventoryEvidence.lodging.available, 1);
const noDayStockSubtraction = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [
  row("2026-09-26", 0, 0), row("2026-09-26", 20, 0, { bizItemId: "day", saleType: "데이유즈" })
] });
assert.equal(noDayStockSubtraction.weeklyPhoneBookings, 10, "Day-use capacity is not day-use sales");
assert.equal(noDayStockSubtraction.weeklySharedDayUseExcluded, 0);
const dateAligned = applyInventoryEvidence({ weeklyDays: 2, weeklyProductDetails: [
  row("2026-09-26", 10, 0), row("2026-09-27", 0, 0),
  row("2026-09-26", 2, 2, { bizItemId: "day", saleType: "데이유즈" }),
  row("2026-09-27", 2, 0, { bizItemId: "day", saleType: "데이유즈" })
] });
assert.deepEqual(dateAligned.inventoryEvidence.lodging.rows.map(r => [r.phoneBookings, r.sharedDayUseExcluded]), [[0, 0], [10, 0]], "Never subtract another stay date's day-use bookings");
const missing = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: { count: 10 } }, weeklyDays: 3, weeklyProductDetails: [
  row("2026-09-25", 10, 1), row("2026-09-27", null, null, { open: false })
] });
assert.equal(missing.weeklyTotalStock, 30, "Missing dates cannot shrink fixed capacity or the requested period");
assert.equal(missing.weeklyPhoneBookings, 0);
assert.equal(missing.weeklyUnknownUnavailable, 20);
assert.equal(missing.weeklyAvgReservationRate, null);
assert.deepEqual(missing.inventoryEvidence.lodging.rows.map(r => r.rate), [0.1, null, null]);
assert.equal(missing.inventoryEvidence.lodging.missingDays, 2);
const failed = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [row("2026-09-25", 0, 0, { collectionFailed: true })] });
assert.equal(failed.weeklyPhoneBookings, 0, "A provider failure with numeric placeholders is not a sold-out date");
assert.equal(failed.weeklyUnknownUnavailable, 10);
const partial = applyInventoryEvidence({ weeklyProductDetails: [
  row("2026-09-25", 5, 0), row("2026-09-25", 5, 0, { bizItemId: "second" }),
  row("2026-09-26", 0, 0), row("2026-09-26", null, null, { bizItemId: "second" })
] });
assert.equal(partial.weeklyTotalStock, 20);
assert.equal(partial.weeklyPhoneBookings, 0, "One missing product prevents whole-company phone imputation on that date");
assert.equal(partial.inventoryEvidence.lodging.rows[1].unknownUnavailable, 10);
assert.equal(partial.inventoryEvidence.lodging.rows[1].partial, true);
const unrelatedCompany = applyInventoryEvidence({ placeId: "unrelated", weeklyProductDetails: [row("2026-09-26", 3, 0)] });
assert.equal(unrelatedCompany.totalRooms, 3, "A previous company's maximum cannot leak into another calculation");
const raisedBaseline = applyInventoryEvidence({ ...season, inventoryCapacityBaseline: { lodging: 12 } });
assert.equal(raisedBaseline.weeklyTotalStock, 48, "A newly loaded same-company historical maximum upgrades an already projected item");
const alternatingProducts = applyInventoryEvidence({ weeklyProductDetails: [
  row("2026-09-25", 8, 0), row("2026-09-25", 2, 0, { bizItemId: "second" }),
  row("2026-09-26", 2, 0), row("2026-09-26", 8, 0, { bizItemId: "second" })
] });
assert.equal(alternatingProducts.totalRooms, 10, "Different dates' product maxima must not be summed into 16 rooms");
assert.equal(alternatingProducts.weeklyPhoneBookings, 0);
const noPriceBorrow = applyInventoryEvidence({ weeklyProductDetails: [
  row("2026-09-25", 10, 0), row("2026-09-26", 0, 0, { price: null })
] });
assert.equal(noPriceBorrow.weeklyPhoneBookings, 10);
assert.equal(noPriceBorrow.weeklyPhoneRevenue, 0, "No implicit cross-date price fallback");
assert.equal(noPriceBorrow.weeklyPhoneMissingPriceBookings, 10);
const unmatchedHistoricalCapacity = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [row("2026-09-26", 3, 3)] });
assert.equal(unmatchedHistoricalCapacity.weeklyPhoneBookings, 7);
assert.equal(unmatchedHistoricalCapacity.weeklyPhoneRevenue, 0, "Unmatched aggregate capacity must not borrow a product's price");
assert.equal(unmatchedHistoricalCapacity.weeklyPhoneMissingPriceBookings, 7);
const separateDayUseInput = applyInventoryEvidence({ weeklyProductDetails: [row("2026-09-26", 5, 0)], dayUseWeeklyProductDetails: [
  { date: "2026-09-26", bizItemId: "day", stock: 2, bookingCount: 2, price: 50000 }
] });
assert.equal(separateDayUseInput.dayUseWeeklyTotalSoldOut, 2, "Separate day-use array retains its sale type and is not treated as lodging");
assert.equal(separateDayUseInput.totalRooms, 5);
const sharedMissing = applyInventoryEvidence({ inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [
  row("2026-09-26", 3, 3), row("2026-09-26", null, null, { bizItemId: "day", saleType: "데이유즈", collectionFailed: true })
] });
assert.equal(sharedMissing.weeklyPublicBookings, 3);
assert.equal(sharedMissing.weeklyPhoneBookings, 0, "Unknown day-use booking volume cannot silently become telephone bookings");
assert.equal(sharedMissing.weeklyUnknownUnavailable, 7);
assert.equal(sharedMissing.inventoryEvidence.lodging.rows[0].sharedDayUseIncomplete, true);
assert.equal(sharedMissing.inventoryEvidence.lodging.rows[0].rate, null);
assert.equal(sharedMissing.weeklyAvgReservationRate, null);
assert.equal(sharedMissing.inventoryEvidence.lodging.status, "partial");
const expectedDayUseMissing = applyInventoryEvidence({ dayUseItemCount: 1, inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [row("2026-09-26", 0, 0)] });
assert.equal(expectedDayUseMissing.weeklyPhoneBookings, 0, "Expected day-use product with no response retains unavailable quantity as unknown");
assert.equal(expectedDayUseMissing.weeklyUnknownUnavailable, 10);
assert.equal(expectedDayUseMissing.weeklyAvgReservationRate, null);
const leadingMissing = applyInventoryEvidence({ checkIn: "2026-09-25", weeklyDays: 3, inventoryCapacityBaseline: { lodging: 10 }, weeklyProductDetails: [row("2026-09-26", 3, 0), row("2026-09-27", 3, 0)] });
assert.deepEqual(leadingMissing.inventoryEvidence.lodging.rows.map(r => r.date), ["2026-09-25", "2026-09-26", "2026-09-27"], "An absent first requested date must not shift the period forward");
assert.equal(leadingMissing.weeklyTotalStock, 30);
assert.equal(leadingMissing.inventoryEvidence.lodging.rows[0].unknownUnavailable, 10);
const sparseRequestedRange = applyInventoryEvidence({ checkIn: "2026-09-20", bookingRangeDays: 31, weeklyDays: 5, weeklyProductDetails: [
  "2026-09-20", "2026-09-26", "2026-10-03", "2026-10-10", "2026-10-17"
].map(date => row(date, 10, 0)) });
assert.equal(sparseRequestedRange.weeklyTotalStock, 310, "Manifest requested days take precedence over sparse successful-date count");
assert.equal(sparseRequestedRange.inventoryEvidence.lodging.rows.length, 31);
assert.equal(sparseRequestedRange.inventoryEvidence.lodging.missingDays, 26);
assert.equal(sparseRequestedRange.weeklyAvgReservationRate, null);
const conflictCapacity = applyInventoryEvidence({ weeklyProductDetails: [row("2026-09-26", 0, 2)] });
assert.equal(conflictCapacity.totalRooms, 0, "Conflicting booking count must not inflate maximum observed room stock");
assert.equal(conflictCapacity.weeklyPublicBookings, 2);
assert.equal(conflictCapacity.weeklyAvgReservationRate, null);
console.log("inventory estimation: fixed capacity, phone estimates, shared day-use exclusions, missing evidence and same-product pricing passed");
