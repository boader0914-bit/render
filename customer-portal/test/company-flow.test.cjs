'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/company-flow.js');
const ratePanel=html=>html.match(/<section class="company-chart-panel company-rate-panel" data-chart-metric="rate">([\s\S]*?)<\/section>/)[1];
test('one reservation graph normalizes stacked counts to daily capacity without a second count or revenue chart',()=>{
 const rows=Object.freeze([Object.freeze({date:'2026-10-09',total:16,publicBookings:5,phoneBookings:11}),Object.freeze({date:'2026-10-10',total:20,publicBookings:5,phoneBookings:5})]);
 const before=JSON.stringify(rows),html=view.daily(rows,{selectedDate:'2026-10-09'}),graph=ratePanel(html);
 assert.equal((html.match(/data-chart-metric=/g)||[]).length,1);
 assert.match(graph,/예약률 100 % · 예약 16실 \/ 전체 16실 · 네이버 5실 · 타채널·전화 11실/);
 assert.match(graph,/예약률 50 % · 예약 10실 \/ 전체 20실/);
 const rects=[...graph.matchAll(/<rect class="flow-(public|estimate)" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)].map(m=>({y:Number(m[3]),height:Number(m[5])}));
 assert.equal(rects.length,4);assert.equal(rects[0].height,166*5/16);assert.equal(rects[1].height,166*11/16);assert.equal(rects[1].y,38);assert.equal(rects[2].height,166*5/20);assert.equal(rects[3].y,121);
 assert.doesNotMatch(graph,/<polyline|<circle/);assert.match(graph,/aria-pressed="true"/);
 assert.equal(JSON.stringify(rows),before);
});
test('zero stays on the baseline, purple zero is omitted and missing or failed days retain unknown markers',()=>{
 const rows=[{date:'2026-10-01',total:16,publicBookings:0,phoneBookings:0},{date:'2026-10-03',total:16,publicBookings:3,phoneBookings:2},{date:'2026-10-04',total:16,publicBookings:0,phoneBookings:0,partial:true},{date:'2026-10-05',total:16,publicBookings:1,phoneBookings:3,revenuePartial:true}];
 const graph=ratePanel(view.daily(rows));
 assert.equal(view.fillDays(rows).length,5);assert.match(graph,/2026-10-01 · 예약률 0 % · 예약 0실/);assert.match(graph,/cy="204"/);
 for(const date of ['02','04'])assert.match(graph,new RegExp('2026-10-'+date+' · 예약률 미확인'));
 assert.equal((graph.match(/<rect class="flow-estimate"/g)||[]).length,2);assert.equal((graph.match(/class="flow-unknown"/g)||[]).length,2);
 assert.match(graph,/2026-10-05 · 예약률 25 %/);assert.doesNotMatch(graph,/<polyline/);
});
test('history keeps fixed partial-month scope and net declines without summing snapshots',()=>{
 const html=view.history({periods:[{month:'2026-10',start:'2026-10-01',end:'2026-10-31',calendarDays:31,completeMonth:false,comparisonDates:['2026-10-03'],points:[{observedDate:'2026-09-20',publicBookings:5,phoneBookings:1,status:'complete',validDays:1,comparisonDays:1,freshDays:1},{observedDate:'2026-09-21',publicBookings:3,phoneBookings:0,status:'complete',validDays:1,comparisonDays:1,freshDays:1}]}]});
 assert.match(html,/1\/31일/);assert.match(html,/월 전체 합계 아님/);assert.match(html,/네이버 -2객실·박/);assert.match(html,/타채널·전화 -1객실·박/);assert.match(html,/고정 비교 숙박일: 2026-10-03/);
});
test('fixed percentage axis includes 0, 50 and 100 percent and selectable dates',()=>{
 const graph=ratePanel(view.daily([{date:'2026-10-06',total:16,publicBookings:5,phoneBookings:3,sold:8,reservationRate:.5}],{selectedDate:'2026-10-06'}));
 assert.equal((graph.match(/class="flow-grid"/g)||[]).length,3);
 for(const tick of ['0%','50%','100%'])assert.ok(graph.includes('>'+tick+'</text>'));
 assert.match(graph,/data-company-date="2026-10-06" aria-pressed="true"/);
});
test('central four decimal rate rounding does not hide a normal observation',()=>{
 const graph=ratePanel(view.daily([{date:'2026-10-01',total:3,publicBookings:1,phoneBookings:0,sold:1,reservationRate:.3333}]));
 assert.match(graph,/예약률 33.3 %/);assert.doesNotMatch(graph,/예약률 미확인/);
});
test('contradictory quantities or percentages cannot appear as normal reservations',()=>{
 const base={total:10,publicBookings:3,phoneBookings:2,sold:5,reservationRate:.5};
 const rows=[{...base,date:'2026-10-01'},{...base,date:'2026-10-03'},{...base,date:'2026-10-04',partial:true},{...base,date:'2026-10-05',inventoryConflict:true},{...base,date:'2026-10-06',publicBookings:9,phoneBookings:2,sold:11,reservationRate:1.1},{...base,date:'2026-10-07',reservationRate:.4},{...base,date:'2026-10-08',sold:6},{...base,date:'2026-10-09',phoneBookings:null},{...base,date:'2026-10-10',total:0},{...base,date:'2026-10-11',reservationRate:null,sold:null}];
 const graph=ratePanel(view.daily(rows));
 for(const day of ['02','04','05','06','07','08','09','10'])assert.match(graph,new RegExp('2026-10-'+day+' · 예약률 미확인'));
 assert.match(graph,/2026-10-11 · 예약률 50 %/);assert.doesNotMatch(graph,/예약률 110 %|예약률 0 %/);
});
test('sparse and entirely unavailable observations keep the same percentage scale',()=>{
 const valid=ratePanel(view.daily([{date:'2026-10-01',total:10,publicBookings:1,phoneBookings:0}]));
 assert.match(valid,/y="187.4"/);assert.match(valid,/>100%<\/text>/);
 const unknown=ratePanel(view.daily([{date:'2026-10-01',total:10,publicBookings:1,phoneBookings:0,missing:true}]));
 assert.match(unknown,/예약률 미확인/);assert.match(unknown,/>100%<\/text>/);assert.doesNotMatch(unknown,/<polyline|<circle|<rect class="flow-public"/);
});
