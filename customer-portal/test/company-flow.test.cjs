 'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/company-flow.js');
const panel=(html,metric)=>html.match(new RegExp('<section class="company-chart-panel" data-chart-metric="'+metric+'">([\\s\\S]*?)</section>'))[1];
test('paired charts stack components once and the total line follows the top of the stack',()=>{
  const rows=Object.freeze([Object.freeze({date:'2026-10-09',publicBookings:5,phoneBookings:11,publicRevenue:1515000,phoneRevenue:3389000,estimatedRevenue:4904000}),Object.freeze({date:'2026-10-10',publicBookings:15,phoneBookings:1,publicRevenue:4585000,phoneRevenue:319000,estimatedRevenue:4904000})]);
  const before=JSON.stringify(rows),html=view.daily(rows,{selectedDate:'2026-10-09'}),bookings=panel(html,'bookings'),revenue=panel(html,'revenue');
  assert.match(bookings,/2026-10-09 · 합계 16 실 · 네이버 5 실 · 타채널·전화 11 실/);
  assert.match(revenue,/2026-10-09 · 합계 490.4 만원/);
  const rects=[...bookings.matchAll(/<rect class="flow-(public|estimate)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)].map(m=>({tone:m[1],y:Number(m[3]),height:Number(m[5])}));
  assert.equal(rects.length,4);assert.equal(rects[0].height,166*5/16);assert.equal(rects[1].height,166*11/16);assert.equal(rects[1].y,38);assert.equal(rects[1].y+rects[1].height,rects[0].y);
  assert.match(bookings,/<polyline points="52,38 444,38"/);
  assert.equal((bookings.match(/<polyline/g)||[]).length,1);assert.match(bookings,/aria-pressed="true"/);assert.doesNotMatch(html,/검증|전화예약 확인/);
  assert.equal(JSON.stringify(rows),before);
});
test('zero stays on the baseline, purple zero is omitted, and missing or failed observations break total lines',()=>{
  const rows=[{date:'2026-10-01',publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0},{date:'2026-10-03',publicBookings:3,phoneBookings:2,publicRevenue:300000,phoneRevenue:200000},{date:'2026-10-04',publicBookings:0,phoneBookings:0,partial:true},{date:'2026-10-05',publicBookings:1,phoneBookings:3,publicRevenue:100000,phoneRevenue:null,revenuePartial:true}];
  const html=view.daily(rows),bookings=panel(html,'bookings'),revenue=panel(html,'revenue');
  assert.equal(view.fillDays(rows).length,5);assert.equal((bookings.match(/<polyline/g)||[]).length,3);
  assert.match(bookings,/2026-10-01 · 합계 0 실/);assert.match(bookings,/2026-10-02 · 합계 미확인/);assert.match(bookings,/2026-10-04 · 합계 미확인/);
  const purple=[...bookings.matchAll(/<rect class="flow-estimate"[^>]*><title>(.*?)<\/title>/g)].map(m=>m[1]);
  assert.deepEqual(purple,['2026-10-03 · 타채널·전화 2 실','2026-10-05 · 타채널·전화 3 실']);
  assert.match(revenue,/2026-10-05 · 합계 미확인/);assert.doesNotMatch(revenue,/2026-10-04 · 합계 0/);
});
test('history keeps fixed partial-month scope and net declines without summing snapshots',()=>{
  const html=view.history({periods:[{month:'2026-10',start:'2026-10-01',end:'2026-10-31',calendarDays:31,completeMonth:false,comparisonDates:['2026-10-03'],points:[{observedDate:'2026-09-20',publicBookings:5,phoneBookings:1,status:'complete',validDays:1,comparisonDays:1,freshDays:1},{observedDate:'2026-09-21',publicBookings:3,phoneBookings:0,status:'complete',validDays:1,comparisonDays:1,freshDays:1}]}]});
  assert.match(html,/1\/31일/);assert.match(html,/월 전체 합계 아님/);assert.match(html,/네이버 -2객실·박/);assert.match(html,/타채널·전화 -1객실·박/);assert.match(html,/고정 비교 숙박일: 2026-10-03/);
});
