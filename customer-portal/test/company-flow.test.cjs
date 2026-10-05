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

const ratePanel=html=>html.match(/<section class="company-chart-panel company-rate-panel" data-chart-metric="rate">([\s\S]*?)<\/section>/)[1];
test('daily rate uses a fixed 0 to 100 percent axis and preserves zero with clickable dates',()=>{
  const rows=[{date:'2026-10-05',total:16,publicBookings:0,phoneBookings:0,sold:0,reservationRate:0},{date:'2026-10-06',total:16,publicBookings:5,phoneBookings:3,sold:8,reservationRate:.5},{date:'2026-10-07',total:16,publicBookings:5,phoneBookings:11,sold:16,reservationRate:1}];
  const before=JSON.stringify(rows),html=view.daily(rows,{selectedDate:'2026-10-06'}),rate=ratePanel(html);
  assert.match(rate,/2026-10-05 · 예약률 0 %/);
  assert.match(rate,/2026-10-06 · 예약률 50 %/);
  assert.match(rate,/2026-10-07 · 예약률 100 %/);
  assert.match(rate,/<polyline points="52,204 488,121 924,38"/);
  assert.equal((rate.match(/class="flow-grid"/g)||[]).length,3);
  for(const tick of ['0%','50%','100%'])assert.ok(rate.includes('>'+tick+'</text>'));
  assert.match(rate,/data-company-date="2026-10-06" aria-pressed="true"/);
  assert.doesNotMatch(rate,/<rect class="flow-(public|estimate)"/);
  assert.equal(JSON.stringify(rows),before);
  assert.ok(html.indexOf('data-chart-metric="rate"')<html.indexOf('data-chart-metric="bookings"'));
});

test('central four decimal rate rounding does not hide a normal observation',()=>{
  const rate=ratePanel(view.daily([{date:'2026-10-01',total:3,publicBookings:1,phoneBookings:0,sold:1,reservationRate:.3333}]));
  assert.match(rate,/예약률 33.3 %/);
  assert.doesNotMatch(rate,/예약률 미확인/);
});

test('rate calculation rejects contradictions and breaks lines at missing or invalid observations',()=>{
  const base={total:10,publicBookings:3,phoneBookings:2,sold:5,reservationRate:.5};
  const rows=[{...base,date:'2026-10-01'},{...base,date:'2026-10-03'},{...base,date:'2026-10-04',partial:true},{...base,date:'2026-10-05',inventoryConflict:true},{...base,date:'2026-10-06',publicBookings:9,phoneBookings:2,sold:11,reservationRate:1.1},{...base,date:'2026-10-07',reservationRate:.4},{...base,date:'2026-10-08',sold:6},{...base,date:'2026-10-09',phoneBookings:null},{...base,date:'2026-10-10',total:0},{...base,date:'2026-10-11',reservationRate:null,sold:null}];
  const rate=ratePanel(view.daily(rows));
  assert.equal((rate.match(/<polyline/g)||[]).length,3);
  for(const day of ['02','04','05','06','07','08','09','10'])assert.match(rate,new RegExp('2026-10-'+day+' · 예약률 미확인'));
  assert.match(rate,/2026-10-11 · 예약률 50 %/);
  assert.doesNotMatch(rate,/예약률 110 %/);
  assert.doesNotMatch(rate,/예약률 0 %/);
});

test('rates stay on the same scale for sparse data and retain unknown markers when all values are unavailable',()=>{
  const valid=ratePanel(view.daily([{date:'2026-10-01',total:10,publicBookings:1,phoneBookings:0}]));
  assert.match(valid,/cy="187.4"/);
  assert.match(valid,/>100%<\/text>/);
  const unknown=ratePanel(view.daily([{date:'2026-10-01',total:10,publicBookings:1,phoneBookings:0,missing:true}]));
  assert.match(unknown,/2026-10-01 · 예약률 미확인/);
  assert.match(unknown,/>100%<\/text>/);
  assert.doesNotMatch(unknown,/<polyline|<circle/);
});
