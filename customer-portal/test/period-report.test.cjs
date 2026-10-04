'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {range,selectDays,totals,build}=require('../web/period-report.js');
const day=(date,extra={})=>({date,collectedAt:'2026-09-20T05:00:00Z',total:16,sold:8,publicBookings:5,phoneBookings:3,publicRevenue:1000000,phoneRevenue:600000,estimatedRevenue:1600000,...extra});
test('report periods use stay dates, calendar month length and explicit open periods',()=>{
  assert.deepEqual(range('monthly','2026-09','2026-10-04'),{type:'monthly',start:'2026-09-01',end:'2026-09-30',days:30,closed:true});
  assert.equal(range('monthly','2024-02','2026-10-04').days,29);
  assert.equal(range('weekly','2026-09-29','2026-10-04').end,'2026-10-05');
  assert.equal(range('weekly','2026-09-29','2026-10-04').closed,false);
  assert.throws(()=>range('weekly','2026-02-30','2026-10-04'));
  assert.throws(()=>range('monthly','2026-11','2026-10-04'));
});
test('latest company stay-day is counted once and a later failed observation does not revive an older sale',()=>{
  const detail={history:{months:[{daily:[day('2026-09-10'),day('2026-09-11')]}]},current:{daily:[day('2026-09-10',{collectedAt:'2026-09-21T05:00:00Z',sold:10,publicBookings:7}),day('2026-09-11',{collectedAt:'2026-09-21T05:00:00Z',partial:true})]}};
  const before=JSON.stringify(detail),rows=selectDays(detail,range('monthly','2026-09','2026-10-04'));
  assert.equal(rows.length,2);assert.equal(totals(rows).sold,10);assert.equal(totals(rows).days,1);assert.equal(JSON.stringify(detail),before);
});
test('normal zero, absent observations, invalid stock and unpriced bookings remain distinct',()=>{
  const zero=day('2026-09-10',{sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0});
  assert.equal(totals([zero]).estimatedRevenue,0);assert.equal(totals([zero]).reservationRate,0);assert.equal(totals([]).estimatedRevenue,null);
  assert.equal(totals([day('2026-09-11',{inventoryConflict:true})]).sold,null);
  assert.equal(totals([day('2026-09-11',{sold:17,publicBookings:14})]).days,0);
  assert.equal(totals([day('2026-09-11',{sold:3})]).days,0);
  const partial=totals([zero,day('2026-09-12',{revenuePartial:true})]);assert.equal(partial.sold,8);assert.equal(partial.estimatedRevenue,null);assert.equal(partial.revenueDays,1);
});
test('comparison uses the same observation and stay dates, keeps companies separate and holds inadequate samples',()=>{
  const days=Array.from({length:8},(_,i)=>day(`2026-09-${10+i}`));
  const entries=[{companyId:'a',kind:'own',name:'내 매장',detail:{current:{daily:days}}},{companyId:'b',kind:'competitor',name:'경쟁',detail:{current:{daily:days.map((d,i)=>({...d,collectedAt:i===7?'2026-09-21T05:00:00Z':d.collectedAt}))}}}];
  const r=build(entries,range('monthly','2026-09','2026-10-04'),{ownId:'a'});
  assert.equal(r.comparisons[0].commonDays,7);assert.equal(r.comparisons[0].status,'comparable');assert.equal(r.companies[0].summary.sold,64);assert.equal(r.companies[1].summary.sold,64);assert.equal(r.published,false);
  const repeated=build([...entries,entries[0]],r.period,{ownId:'a'});assert.equal(repeated.companies.length,2);
  entries[1].detail.current.daily.pop();entries[1].detail.current.daily.pop();assert.equal(build(entries,r.period,{ownId:'a'}).comparisons[0].status,'insufficient');
});
