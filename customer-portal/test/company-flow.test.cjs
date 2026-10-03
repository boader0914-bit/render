'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/company-flow.js');
test('daily charts fill unobserved dates as gaps and never connect failure or partial values as zero',()=>{
  const rows=[{date:'2026-10-01',publicBookings:0,phoneBookings:1},{date:'2026-10-03',publicBookings:3,phoneBookings:2},{date:'2026-10-04',publicBookings:0,phoneBookings:0,partial:true}];
  const html=view.daily(rows,'bookings');
  assert.equal((html.match(/<polyline/g)||[]).length,4);
  assert.match(html,/2026-10-01 · 공개 예약 0 실/);assert.doesNotMatch(html,/2026-10-04 · 공개 예약 0/);
  assert.equal(view.fillDays(rows).length,4);
});
test('history labels fixed partial-month scope and net decline without summing observation snapshots',()=>{
  const html=view.history({periods:[{month:'2026-10',start:'2026-10-01',end:'2026-10-31',calendarDays:31,completeMonth:false,comparisonDates:['2026-10-03'],points:[{observedDate:'2026-09-20',publicBookings:5,phoneBookings:1,status:'complete',validDays:1,comparisonDays:1,freshDays:1},{observedDate:'2026-09-21',publicBookings:3,phoneBookings:0,status:'complete',validDays:1,comparisonDays:1,freshDays:1}]}]});
  assert.match(html,/1\/31일/);assert.match(html,/월 전체 합계 아님/);assert.match(html,/공개 예약 -2객실·박/);assert.match(html,/방막기 추정 -1객실·박/);
  assert.match(html,/고정 비교 숙박일: 2026-10-03/);
});
