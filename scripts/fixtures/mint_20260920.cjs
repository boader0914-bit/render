"use strict";
// Public reservation-product evidence, read from the saved production CSV without
// recollecting: pocheon_glamping_20260920_150137, 2026-09-20 15:01 KST.
const mintStock = [16,16,16,16,21,21,18,16,16,16,16,16,16,18,17,16,16,16,16,19,18,16,16,16,16,16,16,8,16,16,16];
const lavenderStock = [5,5,5,5,5,6,5,5,5,5,5,5,5,6,6,5,5,5,5,6,5,5,5,5,5,5,5,5,5,5,5];
const mintBookings = [3,1,0,1,21,20,14,6,0,1,1,0,1,18,12,2,0,0,0,18,8,0,0,0,0,0,0,7,1,0,0];
const lavenderBookings = [0,0,0,0,3,4,2,0,0,0,0,0,0,1,4,0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0];
const nightPrices = [139,109,109,169,249,249,249,139,109,109,109,109,169,249,249,139,109,109,169,249,249,139,109,109,109,109,169,249,139,109,109];
const nightClosed = new Set([11,12,16,17,18,22,23,24,25,26,29,30]);
const dayZero = new Set([6,13,20,27]);
const dayOpen = new Set([0,1,2,3,7,8,9,10,15,21,28]);
const dayPrices = [99,69,69,119,149,149,0,99,69,69,69,69,119,0,99,99,69,69,69,119,0,99,69,69,69,69,119,0,99,69,69];
const weeklyProductDetails = [];
for (let index = 0; index < 31; index++) {
  const date = new Date(Date.UTC(2026, 8, 20 + index)).toISOString().slice(0,10);
  for (const [bizItemId, name, stock, bookingCount] of [
    ["4066789", "민트글램핑 [1번~21번 랜덤배정]", mintStock[index], mintBookings[index]],
    ["4066841", "라벤더글램핑 [1번~7번 랜덤배정]", lavenderStock[index], lavenderBookings[index]]
  ]) weeklyProductDetails.push({date,bizItemId,name,stock,bookingCount,occupiedBookingCount:0,price:nightPrices[index]*1000,open:!nightClosed.has(index),saleType:"숙박",listType:"객실 묶음 상품리스트"});
  weeklyProductDetails.push({date,bizItemId:"4223868",name:"당일글램핑",stock:dayZero.has(index)?0:3,bookingCount:index===0?1:index===15?2:0,occupiedBookingCount:0,price:dayPrices[index]*1000,open:dayOpen.has(index),saleType:"데이유즈",listType:dayZero.has(index)?"객실별 예약리스트":"객실 종류별 리스트"});
}
module.exports = {
  placeId:"1975818551",bookingBusinessId:"571273",name:"민트 글램핑",rank:1,
  address:"경기도 포천시",weeklyProductDetails,itemDetails:weeklyProductDetails.slice(0,3),
  weeklyDays:31,weeklyOperatingTotal:21,weeklyBasisTotal:27,
  weeklyTotalStock:675,weeklyTotalSoldOut:159,weeklyEstimatedRevenue:37691000,weeklyAdjustedRevenue:37691000,
  dayUseWeeklyTotalStock:93,dayUseWeeklyTotalSoldOut:15,dayUseWeeklyEstimatedRevenue:297000,dayUseWeeklyAdjustedRevenue:1485000
};
