'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/company-flow.js');
test('daily bookings use stacked quantities, preserve normal zero and leave missing days separate',()=>{
  const rows=[{date:'2026-10-01',publicBookings:0,phoneBookings:1},{date:'2026-10-03',publicBookings:3,phoneBookings:2},{date:'2026-10-04',publicBookings:0,phoneBookings:0}];
  const html=view.daily(rows,'bookings');
  assert.equal((html.match(/<polyline/g)||[]).length,0);
  assert.equal((html.match(/<rect/g)||[]).length,3);
  assert.match(html,/2026-10-03 · 공개 예약 3실 \+ 방막기 2실 · 합계 5실/);
  assert.match(html,/2026-10-02 · 미확인/);assert.match(html,/2026-10-04 · 정상 응답 · 예약 0실/);
  const parts=[...html.matchAll(/<rect class="flow-(public|estimate)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)];
  const publicPart=parts.find(r=>r[1]==='public'),blockedPart=parts.find(r=>r[1]==='estimate'&&r[2]===publicPart[2]);
  assert.equal(Number(blockedPart[3])+Number(blockedPart[5]),Number(publicPart[3]),'purple bar sits immediately above green bar');
  assert.equal(view.fillDays(rows).length,4);
});

test('unknown, failed and conflicting quantities never become a zero or a complete stacked total',()=>{
  const html=view.daily([
    {date:'2026-10-01',publicBookings:5,phoneBookings:null},
    {date:'2026-10-02',publicBookings:0,phoneBookings:0,missing:true},
    {date:'2026-10-03',publicBookings:7,phoneBookings:8,inventoryConflict:true},
    {date:'2026-10-04',publicBookings:2,phoneBookings:1,partial:true},
    {date:'2026-10-05',publicBookings:3,phoneBookings:-1}
  ]);
  for(const date of ['2026-10-01','2026-10-02','2026-10-03','2026-10-05'])assert.match(html,new RegExp(date+' · 미확인'));
  assert.equal((html.match(/<rect/g)||[]).length,2);
  assert.match(html,/2026-10-04 · 공개 예약 2실 \+ 방막기 1실 · 합계 3실 · 일부 확인 필요/);
  assert.doesNotMatch(html,/정상 응답 · 예약 0실/);
});

test('daily detail shows bookings only even for a stored old view preference',()=>{
  const html=view.daily([{date:'2026-10-01',publicBookings:2,phoneBookings:1,publicRevenue:100000,phoneRevenue:80000,reservationRate:.3}],'revenue');
  assert.match(html,/합계 3실/);assert.doesNotMatch(html,/data-flow-metric|표시 지표|숙박 추정매출|polyline/);
});
test('history labels fixed partial-month scope and net decline without summing observation snapshots',()=>{
  const html=view.history({periods:[{month:'2026-10',start:'2026-10-01',end:'2026-10-31',calendarDays:31,completeMonth:false,comparisonDates:['2026-10-03'],points:[{observedDate:'2026-09-20',publicBookings:5,phoneBookings:1,status:'complete',validDays:1,comparisonDays:1,freshDays:1},{observedDate:'2026-09-21',publicBookings:3,phoneBookings:0,status:'complete',validDays:1,comparisonDays:1,freshDays:1}]}]});
  assert.match(html,/1\/31일/);assert.match(html,/월 전체 합계 아님/);assert.match(html,/공개 예약 -2객실·박/);assert.match(html,/방막기 추정 -1객실·박/);
  assert.match(html,/고정 비교 숙박일: 2026-10-03/);
});
