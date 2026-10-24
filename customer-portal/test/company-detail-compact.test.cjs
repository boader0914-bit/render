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
  assert.equal((html.match(/data-company-month/g)||[]).length,1);assert.match(html,/<label class="company-stay-month"><span>숙박월<\/span><select data-company-month aria-label="통합관측 숙박월">/);
  assert.doesNotMatch(html,/data-company-view|누적 이력|통합 중|마지막 계산값|2026\. 10\. 13|<form|db-calendar|<polyline/);
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
  assert.match(html,/통합관측 숙박월|value="2026-10" selected|저장된 통합관측 자료를 확인/);
  assert.doesNotMatch(html,/300,000원|company-booking-chart|날짜별 추정 예약·매출/);
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
  assert.doesNotMatch(html,/<details[^>]*class="(?:db-history|collection-warning)|이 상품 정보 수정 요청|리드타임/);
});
test('complete booking quantities retain known revenue subtotals and unknown channel amounts',()=>{
  const data=fixture();
  Object.assign(data.companyDetail.current.summary,{quantityPartial:false,missingDays:0,revenuePartial:true});
  Object.assign(data.companyDetail.current.daily[0],{partial:false,revenuePartial:true,estimatedRevenue:200000,publicRevenue:200000,phoneRevenue:0});
  const html=ui().render(data);
  const day=[...html.matchAll(/<tr[^>]*><th>(2026-10-\d+)<\/th>(.*?)<\/tr>/g)].find(row=>row[1]==='2026-10-01')[2];
  assert.match(day,/>3실</);assert.match(day,/>2실</);assert.match(day,/>1실</);
  assert.equal((day.match(/<small>확인된 소계<\/small>/g)||[]).length,2);
  assert.match(day,/타채널 금액 미확인/);assert.doesNotMatch(day,/>0원/);
  assert.match(day,/가격 일부 확인 필요/);assert.doesNotMatch(day,/정상 관측/);
  assert.match(html,/일부 가격 미확인 · 매출은 확인된 금액만 표시/);
  const zero=[...html.matchAll(/<tr[^>]*><th>(2026-10-\d+)<\/th>(.*?)<\/tr>/g)].find(row=>row[1]==='2026-10-02')[2];
  assert.match(zero,/>0원</);assert.match(zero,/정상 관측/);assert.doesNotMatch(zero,/확인된 소계/);
});

test('the integrated card keeps one accessible API month selector when its default month has no observations',()=>{
  for(const collapseProducts of [false,true]){
    const data=fixture();data.companyDetail.integrated={status:'ready',selectedMonth:'2026-10',snapshot:{},months:[{month:'2026-09',status:'complete'},{month:'2026-10',status:'missing'},{month:'invalid',status:'complete'}]};
    data.companyDetail.current={daily:[{date:'2026-10-01',missing:true,publicBookings:0,phoneBookings:0,estimatedRevenue:0}],summary:null};
    const before=JSON.stringify(data),html=ui().render(data,{collapseProducts});
    assert.equal((html.match(/data-company-month/g)||[]).length,1);assert.match(html,/value="2026-10" selected/);assert.match(html,/value="2026-09"/);assert.doesNotMatch(html,/value="invalid"/);
    assert.match(html,/통합관측 자료가 없습니다/);assert.doesNotMatch(html,/company-booking-chart|0실|>0원<|data-collect|<form/);assert.equal(JSON.stringify(data),before);
  }
});

test('a selected month absent from the API catalog stays selected and unknown without another month values',()=>{
  const data=fixture();data.companyDetail.integrated={status:'ready',selectedMonth:'2026-08',snapshot:null,months:[{month:'2026-09',status:'complete'}]};data.companyDetail.current={daily:[],summary:null};
  const html=ui().render(data);assert.match(html,/value="2026-08" selected/);assert.match(html,/value="2026-09"/);assert.match(html,/예약과 금액은 미확인/);assert.doesNotMatch(html,/300,000원|company-booking-chart|0실/);
});

test('the representative five-booking day shows 279000 as a subtotal and four other-channel amounts as unknown',()=>{
  const data=fixture(),day={date:'2026-09-04',publicBookings:1,publicRevenue:279000,phoneBookings:4,phoneRevenue:0,phoneMissingPriceBookings:4,estimatedRevenue:279000,revenuePartial:true,reservationRate:.5};
  data.companyDetail.integrated={status:'ready',selectedMonth:'2026-09',snapshot:{},months:[{month:'2026-09',status:'partial'}]};data.companyDetail.current={daily:[day],summary:{rangeStart:day.date,rangeEnd:day.date,revenuePartial:true}};
  const before=JSON.stringify(data),html=ui().render(data),detail=html.match(/<tr class=""><th>2026-09-04<\/th>(.*?)<\/tr>/)[1];
  assert.match(detail,/>5실<.*>1실<.*>4실</);assert.match(detail,/279,000원<small>확인된 소계/);assert.match(detail,/타채널 금액 미확인/);assert.doesNotMatch(detail,/>0원/);
  assert.match(html,/기간 매출 소계/);assert.match(html,/week-metric-label">매출 소계/);assert.equal(JSON.stringify(data),before);
});

test('an explicitly complete zero-priced channel remains zero while a positive partial channel is a subtotal',()=>{
  const data=fixture();Object.assign(data.companyDetail.current.daily[0],{publicBookings:1,phoneBookings:4,publicRevenue:0,phoneRevenue:120000,estimatedRevenue:120000,phoneMissingPriceBookings:2,revenuePartial:true});
  let html=ui().render(data),day=html.match(/<tr class=""><th>2026-10-01<\/th>(.*?)<\/tr>/)[1];assert.match(day,/120,000원<small>확인된 소계/);assert.match(day,/타채널 금액 미확인/);
  Object.assign(data.companyDetail.current.daily[0],{publicRevenue:120000,phoneRevenue:0,estimatedRevenue:120000,phoneMissingPriceBookings:0});html=ui().render(data);day=html.match(/<tr class=""><th>2026-10-01<\/th>(.*?)<\/tr>/)[1];assert.match(day,/<td class="estimated-value">0원<\/td>/);
});

test('wholly unpriced positive bookings never become zero currency in daily, weekly or monthly displays',()=>{
  const data=fixture(),day={date:'2026-09-04',publicBookings:0,publicRevenue:0,phoneBookings:4,phoneRevenue:0,phoneMissingPriceBookings:4,estimatedRevenue:0,revenuePartial:true};
  data.companyDetail.current={daily:[day],summary:{rangeStart:day.date,rangeEnd:day.date,revenuePartial:true}};
  const view=ui(),html=view.currentView(data),total=view.monthTotals([day]);assert.equal(total.estimatedRevenue,0,'stored numeric subtotal is preserved');assert.equal(total.bookings,4);
  const month=html.split('<div class="company-flow">')[0],week=html.match(/<summary class="company-week-summary">(.*?)<\/summary>/)[1];
  for(const section of [month,week]){assert.match(section,/금액 미확인/);assert.doesNotMatch(section,/>0원</);}
  assert.match(html,/<td class="public-value">0원<\/td>/,'an actually empty channel remains zero');assert.match(html,/타채널 금액 미확인/);
});

test('confirmed free-price bookings retain zero subtotals when other dates are unobserved',()=>{
  const data=fixture(),day={date:'2026-09-04',publicBookings:1,publicRevenue:0,phoneBookings:0,phoneRevenue:0,phoneMissingPriceBookings:0,estimatedRevenue:0,revenuePartial:false};
  data.companyDetail.current={daily:[day],summary:{rangeStart:'2026-09-01',rangeEnd:'2026-09-30'}};
  const view=ui(),html=view.currentView(data),total=view.monthTotals([day],data.companyDetail.current.summary);assert.equal(total.estimatedRevenue,0);assert.equal(total.revenueUnconfirmed,false);
  const month=html.split('<div class="company-flow">')[0];assert.match(month,/>0원</);assert.doesNotMatch(month,/금액 미확인/);
});
