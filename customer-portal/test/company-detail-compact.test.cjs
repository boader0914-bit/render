'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function ui(){
  const window={};const context=vm.createContext({window});
  for(const file of ['company-flow.js','company-view.js'])vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),context);
  return window.InsightCompanyView;
}
function fixture(){
  return {result:{rooms:17,productCount:1,products:[{name:'<객실 A>',productType:'lodging',days:[{status:'observed',price:100000},{status:'error',price:0},{status:'observed',price:150000}]}],dayUse:{presence:'absent'},quality:{status:'complete'}},companyDetail:{basics:{name:'<등록 업체>',address:'경남 산청',rooms:16},channels:[{label:'네이버',statusLabel:'연결',url:'https://booking.naver.com'}],integrated:{status:'updating',selectedMonth:'2026-10',calculatedAt:'2026-10-13T03:00:00Z',snapshot:{},roomBasis:{count:16,label:'DB 검수값'}},current:{summary:{rangeStart:'2026-10-01',rangeEnd:'2026-10-31',observedDays:2,calendarDays:31,publicBookings:2,phoneBookings:1,estimatedRevenue:300000,publicRevenue:200000,phoneRevenue:100000,reservationRate:.3,missingDays:29,quantityPartial:true},daily:[{date:'2026-10-01',publicBookings:2,phoneBookings:1,estimatedRevenue:300000,publicRevenue:200000,phoneRevenue:100000,reservationRate:.3},{date:'2026-10-02',publicBookings:0,phoneBookings:0,estimatedRevenue:0,publicRevenue:0,phoneRevenue:0,reservationRate:0},{date:'2026-10-03',missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}]},history:{leadTime:{},ranks:[],performance:[],months:[]}}};
}
test('company details show basic data, channels and booking bars with table without old controls',()=>{
  const html=ui().render(fixture(),'<form>old product correction</form>',{mode:'calendar'});
  for(const label of ['업체 기본정보','예약채널','통합관측','DB 검수값','16실','관측 판매금액','100,000원 ~ 150,000원','예약 수량','날짜별 추정 예약·매출'])assert.ok(html.includes(label),label);
  assert.match(html,/&lt;등록 업체&gt;/);assert.match(html,/&lt;객실 A&gt;/);
  assert.doesNotMatch(html,/data-company-view|data-company-month|누적 이력|통합 중|마지막 계산값|2026\. 10\. 13|<form|db-calendar|<polyline/);
});
test('company view treats missing observations as unknown and preserves normally observed zero',()=>{
  const html=ui().render(fixture());
  const rows=[...html.matchAll(/<tr[^>]*><th>(2026-10-\d+)<\/th>(.*?)<\/tr>/g)];
  const zero=rows.find(row=>row[1]==='2026-10-02')[2],missing=rows.find(row=>row[1]==='2026-10-03')[2];
  assert.match(zero,/>0실</);assert.match(zero,/>0원</);assert.match(zero,/정상 관측/);
  assert.match(missing,/>미확인</);assert.match(missing,/미관측/);assert.doesNotMatch(missing,/>0실<|>0원</);
  assert.match(rows.find(row=>row[1]==='2026-10-01')[2],/>3실</);
});
test('pending integrated snapshots do not show raw previous values as integrated observation',()=>{
  const data=fixture();data.companyDetail.integrated.snapshot=null;
  const html=ui().render(data);
  assert.match(html,/업체 기본정보/);assert.match(html,/예약채널/);
  assert.doesNotMatch(html,/통합관측|300,000원|company-booking-chart|날짜별 추정 예약·매출/);
});
test('no observation suppresses C and absent product information is unknown rather than zero',()=>{
  const data={companyDetail:{basics:{name:'등록 업체'},channels:[],current:{daily:[],summary:null}}};
  const html=ui().render(data);
  assert.doesNotMatch(html,/통합관측|상품 종류<\/span><strong>0개|미확인개|undefined/);
  assert.match(html,/상품 관측 자료가 없습니다/);
});
test('normal zero product price is retained while missing/error zero is not used',()=>{
  const data=fixture();data.result.products[0].days=[{status:'observed',price:0},{status:'error',price:999999}];
  const html=ui().render(data);assert.match(html,/<td>0원<\/td>/);assert.doesNotMatch(html,/999,999원/);
});
test('material quantity/quality warnings stay visible without adding diagnostics panels',()=>{
  const data=fixture();data.companyDetail.integrated.roomBasis.reviewRequired=true;data.result.quality={status:'partial',reason:'예약 응답 누락'};data.result.capacityWarning='상품 중복 가능성';
  const html=ui().render(data);
  for(const warning of ['객실 총량 검토','예약 응답 누락','상품 중복 가능성','미확인 날짜는 합계에서 제외'])assert.ok(html.includes(warning),warning);
  assert.doesNotMatch(html,/<details|이 상품 정보 수정 요청|리드타임/);
});
test('complete booking quantities retain a partial-revenue warning, including a zero subtotal',()=>{
  const data=fixture();
  Object.assign(data.companyDetail.current.summary,{quantityPartial:false,missingDays:0,revenuePartial:true});
  Object.assign(data.companyDetail.current.daily[0],{partial:false,revenuePartial:true,estimatedRevenue:200000,publicRevenue:200000,phoneRevenue:0});
  const html=ui().render(data);
  const day=[...html.matchAll(/<tr[^>]*><th>(2026-10-\d+)<\/th>(.*?)<\/tr>/g)].find(row=>row[1]==='2026-10-01')[2];
  assert.match(day,/>3실</);assert.match(day,/>2실</);assert.match(day,/>1실</);
  assert.equal((day.match(/<small>일부 금액<\/small>/g)||[]).length,3);
  assert.match(day,/>0원<small>일부 금액<\/small>/);
  assert.match(day,/가격 일부 확인 필요/);assert.doesNotMatch(day,/정상 관측/);
  assert.match(html,/일부 가격 미확인 · 매출은 확인된 금액만 표시/);
  const zero=[...html.matchAll(/<tr[^>]*><th>(2026-10-\d+)<\/th>(.*?)<\/tr>/g)].find(row=>row[1]==='2026-10-02')[2];
  assert.match(zero,/>0원</);assert.match(zero,/정상 관측/);assert.doesNotMatch(zero,/일부 금액/);
});
