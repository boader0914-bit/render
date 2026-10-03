'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/company-flow.js');
test('daily charts fill unobserved dates as gaps and never connect failure or partial values as zero',()=>{
  const rows=[{date:'2026-10-01',publicBookings:0,phoneBookings:1},{date:'2026-10-03',publicBookings:3,phoneBookings:2},{date:'2026-10-04',publicBookings:0,phoneBookings:0,partial:true}];
  const html=view.daily(rows,'bookings');
  assert.equal((html.match(/<polyline/g)||[]).length,2);
  assert.equal((html.match(/<rect /g)||[]).length,2);
  assert.match(html,/2026-10-02 · 미확인/);assert.match(html,/2026-10-04 · 미확인/);
  assert.match(html,/2026-10-01 · 공개 예약 0 실/);assert.doesNotMatch(html,/2026-10-04 · 공개 예약 0/);
  assert.equal(view.fillDays(rows).length,4);
});
test('blocked estimates use isolated positive bars; true zero, missing and failed values stay distinct without changing source values',()=>{
  const rows=Object.freeze([
    {date:'2026-10-01',publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0},
    {date:'2026-10-02',publicBookings:3,phoneBookings:2,publicRevenue:300000,phoneRevenue:200000},
    {date:'2026-10-03',publicBookings:0,phoneBookings:null,publicRevenue:0,phoneRevenue:null},
    {date:'2026-10-04',publicBookings:0,phoneBookings:0,partial:true},
    {date:'2026-10-05',publicBookings:1,phoneBookings:3,publicRevenue:100000,phoneRevenue:null,revenuePartial:true},
    {date:'2026-10-06',publicBookings:1,phoneBookings:0,publicRevenue:100000,phoneRevenue:70000},
  ].map(Object.freeze));
  const before=JSON.stringify(rows),html=view.daily(rows),group=html.match(/<g class="flow-estimate">(.*?)<\/g>/s)[1];
  assert.equal((group.match(/<rect /g)||[]).length,2);assert.doesNotMatch(group,/<polyline|<circle|2026-10-01|2026-10-03|2026-10-04|2026-10-06/);
  assert.match(html,/2026-10-01 · 공개 예약 0 실/);assert.match(html,/2026-10-03 · 미확인/);assert.match(html,/2026-10-04 · 미확인/);
  assert.doesNotMatch(html,/2026-10-01 · 미확인/);
  const revenue=view.daily(rows,'revenue'),bars=revenue.match(/<g class="flow-estimate">(.*?)<\/g>/s)[1];
  assert.equal((bars.match(/<rect /g)||[]).length,1);assert.match(bars,/2026-10-02 · 방막기 추정 매출 20 만원/);assert.match(revenue,/2026-10-05 · 미확인/);
  assert.equal(JSON.stringify(rows),before);
});
test('history labels fixed partial-month scope and net decline without summing observation snapshots',()=>{
  const html=view.history({periods:[{month:'2026-10',start:'2026-10-01',end:'2026-10-31',calendarDays:31,completeMonth:false,comparisonDates:['2026-10-03'],points:[{observedDate:'2026-09-20',publicBookings:5,phoneBookings:1,status:'complete',validDays:1,comparisonDays:1,freshDays:1},{observedDate:'2026-09-21',publicBookings:3,phoneBookings:0,status:'complete',validDays:1,comparisonDays:1,freshDays:1}]}]});
  assert.match(html,/1\/31일/);assert.match(html,/월 전체 합계 아님/);assert.match(html,/공개 예약 -2객실·박/);assert.match(html,/방막기 추정 -1객실·박/);
  assert.match(html,/고정 비교 숙박일: 2026-10-03/);
});
