'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function ui(){
  const window={},context=vm.createContext({window});
  for(const file of ['company-flow.js','company-view.js'])vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),context);
  return window;
}
const row=(date,extra={})=>({date,publicBookings:2,phoneBookings:1,estimatedRevenue:300000,publicRevenue:200000,phoneRevenue:100000,reservationRate:.1875,...extra});
function dates(start,end){
  const result=[];
  for(let time=Date.parse(start+'T00:00:00Z'),last=Date.parse(end+'T00:00:00Z');time<=last;time+=86400000)result.push(new Date(time).toISOString().slice(0,10));
  return result;
}
const company=(daily,summary={})=>({companyDetail:{current:{daily,summary}}});

test('month weeks use Monday through Sunday and stay within the selected month',()=>{
  const w=ui(),range={rangeStart:'2026-10-01',rangeEnd:'2026-10-31'};
  const rows=dates('2026-09-28','2026-11-02').map(date=>row(date));
  const groups=w.InsightCompanyView.weeklyGroups(rows,range);
  assert.equal(groups.map(g=>`${g.start}/${g.end}`).join('|'),'2026-10-01/2026-10-04|2026-10-05/2026-10-11|2026-10-12/2026-10-18|2026-10-19/2026-10-25|2026-10-26/2026-10-31');
  assert.equal(groups.reduce((total,g)=>total+g.expectedDays,0),31);
  assert.equal(groups.reduce((total,g)=>total+g.bookings,0),93);
  assert.equal(groups.reduce((total,g)=>total+g.estimatedRevenue,0),9300000);
  assert.ok(groups.every(g=>!g.quantityPartial&&!g.revenuePartial));
});

test('repeated dates are replaced consistently with the existing daily chart, not added again',()=>{
  const w=ui(),rows=[row('2026-10-02'),row('2026-10-01'),row('2026-10-01',{publicBookings:5,phoneBookings:2,estimatedRevenue:700000})];
  const [group]=w.InsightCompanyView.weeklyGroups(rows);
  assert.equal(group.expectedDays,2);
  assert.equal(group.bookings,10);
  assert.equal(group.estimatedRevenue,1000000);
  assert.equal(group.rows[0].publicBookings,5);
  assert.equal(w.InsightCompanyFlow.fillDays(rows)[0].publicBookings,5);
});

test('missing and conflicting zero values are unknown while a normal zero remains observed',()=>{
  const w=ui(),rows=[row('2026-10-01',{publicBookings:0,phoneBookings:0,estimatedRevenue:0}),row('2026-10-02',{missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}),row('2026-10-03',{inventoryConflict:true,publicBookings:16,phoneBookings:8,estimatedRevenue:999999})];
  const [group]=w.InsightCompanyView.weeklyGroups(rows,{rangeStart:'2026-10-01',rangeEnd:'2026-10-04'});
  assert.equal(group.expectedDays,4);assert.equal(group.observedDays,1);assert.equal(group.revenueObservedDays,1);
  assert.equal(group.bookings,0);assert.equal(group.estimatedRevenue,0);assert.equal(group.quantityPartial,true);assert.equal(group.revenuePartial,true);
  const html=w.InsightCompanyView.currentView(company(rows,{rangeStart:'2026-10-01',rangeEnd:'2026-10-04'}));
  const summary=html.match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  assert.match(summary,/>0실</);assert.match(summary,/>0원</);assert.match(summary,/일부 자료 · 관측 1\/4일/);assert.match(summary,/확인된 소계/);
  const conflict=html.match(/<tr class="observation-unknown"><th>2026-10-03<\/th>(.*?)<\/tr>/)[1];
  assert.doesNotMatch(conflict,/999,999원|>16실<|>8실<|>0원</);
});

test('a wholly unobserved week never becomes a zero reservation or revenue total',()=>{
  const w=ui(),rows=[row('2026-10-01',{missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0})];
  const [group]=w.InsightCompanyView.weeklyGroups(rows,{rangeStart:'2026-10-01',rangeEnd:'2026-10-04'});
  assert.equal(group.bookings,null);assert.equal(group.estimatedRevenue,null);
  const html=w.InsightCompanyView.currentView(company(rows,{rangeStart:'2026-10-01',rangeEnd:'2026-10-04'}));
  const summary=html.match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  assert.equal((summary.match(/>미확인</g)||[]).length,3);
  assert.doesNotMatch(summary,/>0실<|>0원</);
});

test('known revenue subtotals stay numeric and marked partial without losing complete quantity coverage',()=>{
  const w=ui(),rows=dates('2026-10-01','2026-10-04').map(date=>row(date));
  Object.assign(rows[1],{estimatedRevenue:0,revenuePartial:true});
  const [group]=w.InsightCompanyView.weeklyGroups(rows);
  assert.equal(group.bookings,12);assert.equal(group.observedDays,4);assert.equal(group.quantityPartial,false);
  assert.equal(group.estimatedRevenue,900000);assert.equal(group.revenueObservedDays,4);assert.equal(group.revenuePartial,true);
  const summary=w.InsightCompanyView.currentView(company(rows)).match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  assert.match(summary,/900,000원/);assert.match(summary,/확인된 소계/);assert.match(summary,/관측 4\/4일/);
  assert.doesNotMatch(summary,/일부 자료/);
});

test('separate booking and price coverage is visible when available dates differ',()=>{
  const w=ui(),rows=[row('2026-10-01'),row('2026-10-02',{estimatedRevenue:null})];
  const [group]=w.InsightCompanyView.weeklyGroups(rows);
  assert.equal(group.bookings,6);assert.equal(group.estimatedRevenue,300000);
  assert.equal(group.observedDays,2);assert.equal(group.revenueObservedDays,1);
  const summary=w.InsightCompanyView.currentView(company(rows)).match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  assert.match(summary,/예약 2\/2일 · 매출 1\/2일/);assert.match(summary,/확인된 소계/);
});

test('weekly totals default closed and expanding keeps the original public and blocked daily columns',()=>{
  const w=ui(),rows=dates('2026-10-01','2026-10-14').map(date=>row(date)),data=company(rows);
  const html=w.InsightCompanyView.currentView(data),details=[...html.matchAll(/<details class="company-week-group[^>]*>/g)];
  assert.equal(details.length,3);assert.ok(details.every(match=>!(/\bopen(?:\s|=|>)/).test(match[0])));
  assert.match(html,/주간 추정 예약·매출/);assert.match(html,/숙박일별 수량 합산/);
  assert.match(html,/week-toggle" aria-hidden="true"><span class="week-toggle-open">\+<\/span><span class="week-toggle-close">−<\/span>/);assert.match(html,/<th>공개 예약<\/th><th>방막기<\/th>/);
  assert.match(html,/class="public-value">2실/);assert.match(html,/class="estimated-value">1실/);
  const chart=w.InsightCompanyFlow.daily(rows);
  assert.ok(html.includes(chart),'the existing daily stacked bar chart is retained without changes');
  assert.ok(html.indexOf('company-month-summary')<html.indexOf(chart),'monthly totals precede the daily chart');
  assert.ok(html.indexOf(chart)<html.indexOf('company-week-list'),'weekly details follow the daily chart');
});

test('year boundaries and leap dates retain the proper week and immutable source values',()=>{
  const w=ui(),rows=dates('2026-12-28','2027-01-03').map(date=>Object.freeze(row(date)));
  Object.freeze(rows);
  const before=JSON.stringify(rows),[group]=w.InsightCompanyView.weeklyGroups(rows);
  assert.equal(group.start,'2026-12-28');assert.equal(group.end,'2027-01-03');assert.equal(group.expectedDays,7);
  assert.equal(JSON.stringify(rows),before);
  const leap=w.InsightCompanyView.weeklyGroups([row('2028-02-28'),row('2028-02-29'),row('2028-02-30'),row('<bad>')]);
  assert.equal(leap.length,1);assert.equal(leap[0].expectedDays,2);assert.equal(leap[0].end,'2028-02-29');
});

test('currency is summed from stored values before display and missing booking components are not zero',()=>{
  const w=ui(),rows=[row('2026-10-01',{estimatedRevenue:101234}),row('2026-10-02',{estimatedRevenue:201234,phoneBookings:null})];
  const [group]=w.InsightCompanyView.weeklyGroups(rows);
  assert.equal(group.estimatedRevenue,302468);assert.equal(group.bookings,3);assert.equal(group.observedDays,1);
  assert.equal(group.quantityPartial,true);
  const summary=w.InsightCompanyView.currentView(company(rows)).match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  assert.match(summary,/302,468원/);assert.match(summary,/일부 자료 · 예약 1\/2일 · 매출 2\/2일/);
});

test('monthly totals match deduplicated weekly totals and exclude dates outside the target month',()=>{
  const w=ui(),range={rangeStart:'2026-10-01',rangeEnd:'2026-10-31'};
  const rows=dates('2026-09-28','2026-11-02').map(date=>row(date));
  rows.push(row('2026-10-03',{publicBookings:5,phoneBookings:2,estimatedRevenue:700000,publicRevenue:500000,phoneRevenue:200000}));
  const groups=w.InsightCompanyView.weeklyGroups(rows,range),total=w.InsightCompanyView.monthTotals(rows,range);
  assert.equal(total.wholeMonth,true);assert.equal(total.start,range.rangeStart);assert.equal(total.end,range.rangeEnd);
  assert.equal(total.expectedDays,31);assert.equal(total.observedDays,31);assert.equal(total.priceCompleteDays,31);
  assert.equal(total.bookings,97);assert.equal(total.publicBookings,65);assert.equal(total.phoneBookings,32);
  assert.equal(total.estimatedRevenue,9700000);assert.equal(total.publicRevenue,6500000);assert.equal(total.phoneRevenue,3200000);
  assert.equal(total.bookings,groups.reduce((sum,group)=>sum+group.bookings,0));
  assert.equal(total.estimatedRevenue,groups.reduce((sum,group)=>sum+group.estimatedRevenue,0));
  const html=w.InsightCompanyView.currentView(company(rows,range)),month=html.slice(0,html.indexOf('<div class="company-flow">'));
  assert.match(month,/월간 추정 예약·매출/);assert.match(month,/월 예약 합계/);assert.match(month,/월 매출 합계/);
  assert.match(month,/>97실<\/strong>/);assert.match(month,/>9,700,000원<\/strong>/);
  assert.match(month,/현재 관측 합계/);assert.match(month,/공개 예약 \+ 방막기/);
  assert.doesNotMatch(month,/공개 65실|방막기 32실|6,500,000원|3,200,000원|확정|마감/);
});

test('monthly quantity and price coverage are separate when the final dates have no price',()=>{
  const w=ui(),range={rangeStart:'2026-10-01',rangeEnd:'2026-10-31'};
  const rows=dates(range.rangeStart,range.rangeEnd).map(date=>row(date,{publicBookings:0,phoneBookings:0,estimatedRevenue:0,publicRevenue:0,phoneRevenue:0}));
  Object.assign(rows[0],{publicBookings:1,estimatedRevenue:179000,publicRevenue:179000});
  Object.assign(rows[29],{publicBookings:1,phoneBookings:1,estimatedRevenue:null,publicRevenue:null,phoneRevenue:null,partial:true,revenuePartial:false});
  Object.assign(rows[30],{publicBookings:7,phoneBookings:9,estimatedRevenue:null,publicRevenue:null,phoneRevenue:null,partial:true,revenuePartial:false});
  const total=w.InsightCompanyView.monthTotals(rows,range);
  assert.equal(total.bookings,19);assert.equal(total.publicBookings,9);assert.equal(total.phoneBookings,10);
  assert.equal(total.observedDays,31);assert.equal(total.revenueObservedDays,29);assert.equal(total.priceCompleteDays,29);
  assert.equal(total.estimatedRevenue,179000);assert.equal(total.revenuePartial,true);
  const html=w.InsightCompanyView.currentView(company(rows,range)),month=html.slice(0,html.indexOf('<div class="company-flow">'));
  assert.match(month,/>19실<\/strong>/);assert.match(month,/>179,000원<\/strong>/);
  assert.match(month,/예약 관측 31\/31일/);assert.match(month,/가격 확인 29\/31일/);
  assert.match(month,/month-partial">확인된 소계/);assert.match(month,/확인된 금액만 합산/);
});

test('monthly display distinguishes an observed zero from unavailable and conflicting values',()=>{
  const w=ui(),range={rangeStart:'2026-10-01',rangeEnd:'2026-10-04'};
  const rows=[row('2026-10-01',{publicBookings:0,phoneBookings:0,estimatedRevenue:0,publicRevenue:0,phoneRevenue:0}),row('2026-10-02',{missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}),row('2026-10-03',{inventoryConflict:true,publicBookings:99,phoneBookings:99,estimatedRevenue:9999999})];
  const total=w.InsightCompanyView.monthTotals(rows,range);
  assert.equal(total.bookings,0);assert.equal(total.estimatedRevenue,0);assert.equal(total.expectedDays,4);assert.equal(total.observedDays,1);assert.equal(total.priceCompleteDays,1);
  const month=w.InsightCompanyView.currentView(company(rows,range)).split('<div class="company-flow">')[0];
  assert.match(month,/>0실<\/strong>/);assert.match(month,/>0원<\/strong>/);assert.match(month,/가격 확인 1\/4일/);
  const unknown=[row('2026-10-01',{missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0})];
  const unknownTotal=w.InsightCompanyView.monthTotals(unknown,range);
  assert.equal(unknownTotal.bookings,null);assert.equal(unknownTotal.estimatedRevenue,null);
  const unknownMonth=w.InsightCompanyView.currentView(company(unknown,range)).split('<div class="company-flow">')[0];
  assert.equal((unknownMonth.match(/<strong>미확인<\/strong>/g)||[]).length,2);
  assert.doesNotMatch(unknownMonth,/>0실<|>0원</);
});

test('a partial price subtotal is included but does not count as a fully available price day',()=>{
  const w=ui(),rows=[row('2026-10-01',{estimatedRevenue:200000,revenuePartial:true}),row('2026-10-02')];
  const total=w.InsightCompanyView.monthTotals(rows);
  assert.equal(total.bookings,6);assert.equal(total.estimatedRevenue,500000);assert.equal(total.revenueObservedDays,2);assert.equal(total.priceCompleteDays,1);
  const month=w.InsightCompanyView.currentView(company(rows)).split('<div class="company-flow">')[0];
  assert.match(month,/>500,000원<\/strong>/);assert.match(month,/가격 확인 1\/2일/);assert.match(month,/확인된 소계/);
});

test('short or cross-month target ranges are labelled as periods rather than whole monthly totals',()=>{
  const w=ui(),cases=[['2026-10-10','2026-10-23'],['2026-12-28','2027-01-03']];
  for(const [start,end] of cases){
    const rows=dates(start,end).map(date=>row(date)),range={rangeStart:start,rangeEnd:end},total=w.InsightCompanyView.monthTotals(rows,range);
    assert.equal(total.wholeMonth,false);
    const month=w.InsightCompanyView.currentView(company(rows,range)).split('<div class="company-flow">')[0];
    assert.match(month,/기간 추정 예약·매출/);assert.match(month,/기간 예약 합계/);assert.match(month,/기간 매출 합계/);
    assert.ok(month.includes(`숙박일 ${start} ~ ${end}`));assert.match(month,/현재 관측 합계/);
    assert.doesNotMatch(month,/월 예약 합계|월 매출 합계|월 전체|확정|마감|기간간/);
  }
});
