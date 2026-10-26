'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function ui(){
  const window={},context=vm.createContext({window});
  for(const file of ['company-flow.js','company-view.js'])vm.runInContext(fs.readFileSync(require.resolve('../web/'+file),'utf8'),context);
  return window.InsightCompanyView;
}
const clone=value=>JSON.parse(JSON.stringify(value));
function interval(date,publicChange,blockedChange,extra={}){
  const day=Number(date.slice(8));
  return {date,previousCollectedAt:'2026-10-23T02:00:00Z',collectedAt:'2026-10-25T03:00:00Z',previousLeadDays:day-23,currentLeadDays:day-25,publicChange,blockedChange,netChange:publicChange+blockedChange,...extra};
}
function fixture(){
  const rows=[interval('2026-10-28',3,-1),interval('2026-10-29',-2,1),interval('2026-10-30',0,0)];
  const daily=rows.map(row=>({date:row.date,total:16,sold:4,publicBookings:2,phoneBookings:2,estimatedRevenue:400000,publicRevenue:200000,phoneRevenue:200000,missing:false}));
  return {result:{rooms:16,productCount:1,products:[]},companyDetail:{companyId:'own_a',basics:{name:'등록 업체',rooms:16},channels:[],current:{daily,summary:{rangeStart:'2026-10-01',rangeEnd:'2026-10-31'}},integrated:{companyId:'own_a',status:'ready',selectedMonth:'2026-10',roomBasis:{count:16,label:'DB 검수값',reviewRequired:false},snapshot:{period:{start:'2026-10-01',end:'2026-10-31',cutoffDate:'2026-10-25'},analysis:{collectionDateCount:7,pickup:{status:'ready',increase:100,decrease:1,net:99,comparableIntervals:3,leadTime:{averageDays:99,averageMinDays:98,averageMaxDays:100},intervals:rows}}}}}};
}
test('one exact observation pair shows signed quantity changes and its fixed stay dates without using global pickup totals',()=>{
  const data=fixture(),before=clone(data),view=ui(),model=view.pickupModel(data),html=view.pickupView(data);
  assert.equal(model.status,'ready');assert.equal(model.publicChange,1);assert.equal(model.blockedChange,0);assert.equal(model.rows.length,3);
  assert.match(html,/공개 예약 변화<\/span><strong>\+1실/);assert.match(html,/방막기 변화<\/span><strong>0실/);
  assert.match(html,/고정 비교 숙박일: 2026-10-28, 2026-10-29, 2026-10-30/);assert.match(html,/공통 숙박일 3일/);
  assert.match(html,/\+3실/);assert.match(html,/−2실/);assert.match(html,/−1실/);assert.match(html,/3~5일 전/);
  assert.doesNotMatch(html,/99실|98~100|예약 취소 확정|신규 예약 건수/);assert.deepEqual(data,before);
});
test('observed zero is visible without purple emphasis while unknown quantities never become zero',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup.intervals=[interval('2026-10-28',0,0)];
  data.companyDetail.integrated.snapshot.analysis.pickup.status='no_increase';
  let html=view.pickupView(data);assert.equal((html.match(/<strong>0실<\/strong>/g)||[]).length,2);
  assert.doesNotMatch(html,/company-pickup-estimate is-nonzero/);assert.match(html,/증가 관측 없음/);
  data.companyDetail.integrated.snapshot.analysis.pickup.intervals[0].publicChange=null;
  html=view.pickupView(data);assert.match(html,/수량 확인 필요/);assert.doesNotMatch(html,/<strong>0실<\/strong>/);
});
test('unavailable lead-time evidence does not remove otherwise normal quantity changes or invent a point estimate',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup.intervals[0].currentLeadDays=null;
  const model=view.pickupModel(data),html=view.pickupView(data);assert.equal(model.publicChange,1);assert.equal(model.rows.length,3);
  assert.match(html,/관측 간격 확인 필요/);assert.match(html,/<td>미확인<\/td>/);assert.doesNotMatch(html,/99일 전/);
});
test('same current time with different previous times is not added into a single comparison interval',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup.intervals.push(interval('2026-10-31',50,50,{previousCollectedAt:'2026-10-24T02:00:00Z',previousLeadDays:7}));
  data.companyDetail.integrated.snapshot.analysis.pickup.intervals.push(interval('2026-10-31',80,80,{previousCollectedAt:'2026-10-22T02:00:00Z',collectedAt:'2026-10-24T03:00:00Z',previousLeadDays:9,currentLeadDays:7}));
  const model=view.pickupModel(data);assert.equal(model.publicChange,1);assert.equal(model.blockedChange,0);assert.equal(model.otherGroups,2);
  assert.match(view.pickupView(data),/다른 2개 구간은 위 요약에 합산하지 않았습니다/);
});
test('a later current observation wins and dates with a longer old gap do not masquerade as the same cohort',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.period.cutoffDate='2026-10-26';
  data.companyDetail.integrated.snapshot.analysis.pickup.intervals.push(interval('2026-10-31',-4,2,{previousCollectedAt:'2026-10-25T03:00:00Z',collectedAt:'2026-10-26T03:00:00Z',previousLeadDays:6,currentLeadDays:5}));
  const model=view.pickupModel(data);assert.equal(model.rows.length,1);assert.equal(model.publicChange,-4);assert.equal(model.blockedChange,2);
  assert.match(view.pickupView(data),/공개 예약 변화<\/span><strong>−4실/);
});
test('duplicate identical evidence is counted once and conflicting same-pair evidence is withheld',()=>{
  const data=fixture(),view=ui(),raw=data.companyDetail.integrated.snapshot.analysis.pickup.intervals;
  raw.push(clone(raw[0]));let model=view.pickupModel(data);assert.equal(model.publicChange,1);assert.equal(model.duplicateCount,1);
  raw.push({...raw[0],publicChange:4,netChange:3});model=view.pickupModel(data);assert.equal(model.publicChange,-2);assert.equal(model.rows.length,2);
  assert.ok(model.issues.some(row=>row.code==='conflict'));assert.match(view.pickupView(data),/비교 근거가 서로 달라 제외 · 2026-10-28/);
});
for(const [name,change,reason] of [
  ['invalid stay date',row=>{row.date='2026-10-32';},'숙박일 또는 관측기간 확인 필요'],
  ['other month',row=>{row.date='2026-09-28';},'숙박일 또는 관측기간 확인 필요'],
  ['locale timestamp',row=>{row.collectedAt='2026-10-25 12:00:00';},'관측 시각 확인 필요'],
  ['reversed timestamps',row=>{row.previousCollectedAt='2026-10-26T03:00:00Z';},'관측 시각 확인 필요'],
  ['after cutoff',row=>{row.collectedAt='2026-10-26T03:00:00Z';},'관측 마감일 또는 숙박일 뒤'],
  ['fractional room change',row=>{row.publicChange=.5;row.netChange=-.5;},'변화 수량 확인 필요'],
  ['inconsistent total',row=>{row.netChange=99;},'변화 수량 확인 필요']
])test(`invalid ${name} is diagnosed without discarding other valid stay dates`,()=>{
  const data=fixture(),view=ui();change(data.companyDetail.integrated.snapshot.analysis.pickup.intervals[0]);
  const model=view.pickupModel(data),html=view.pickupView(data);assert.equal(model.rows.length,2);assert.equal(model.publicChange,-2);assert.match(html,new RegExp(reason));
});
test('price-only partial data retains quantity change and capacity review is a separate caution',()=>{
  const data=fixture(),view=ui();Object.assign(data.companyDetail.current.daily[0],{revenuePartial:true,estimatedRevenue:null});
  data.companyDetail.integrated.roomBasis.reviewRequired=true;
  const model=view.pickupModel(data),html=view.pickupView(data);assert.equal(model.publicChange,1);assert.equal(model.rows.length,3);
  assert.match(html,/가격이 빠진 날짜도 정상 수량의 변화는 유지/);assert.match(html,/객실 총량 검토가 필요/);assert.match(html,/예약률의 우열은 판단하지 않습니다/);
});
test('legacy flow and global lead summaries cannot substitute for missing selected-month interval evidence',()=>{
  const data=fixture(),view=ui();delete data.companyDetail.integrated.snapshot.analysis.pickup;
  data.companyDetail.history={observationFlow:{periods:[{points:[{publicBookings:900}]}]},leadTime:{averageDays:900}};
  assert.equal(view.pickupModel(data).status,'insufficient');assert.equal(view.pickupView(data),'');
  data.companyDetail.legacyObservationView=true;assert.equal(view.pickupView(data),'');
});
test('a modern insufficient response keeps a truthful preparation state rather than a zero summary',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup={status:'insufficient',comparableIntervals:0,intervals:[]};
  const html=view.pickupView(data);assert.match(html,/유효 관측이 2회 이상/);assert.doesNotMatch(html,/company-pickup-grid|<strong>0실/);
});
test('an older integrated projection with an empty optional pickup stays unavailable without a false error or zero',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup={status:'',comparableIntervals:null,intervals:[]};
  const html=view.pickupView(data);assert.match(html,/유효 관측이 2회 이상/);assert.doesNotMatch(html,/판정 상태를 확인|<strong>0실/);
});
test('wrong company, selected month or incomplete scope cannot reuse an otherwise valid interval list',()=>{
  for(const mutate of [data=>{data.companyDetail.integrated.companyId='other';},data=>{data.companyDetail.integrated.selectedMonth='2026-09';},data=>{delete data.companyDetail.integrated.snapshot.period.cutoffDate;}]){
    const data=fixture(),view=ui();mutate(data);const html=view.pickupView(data);assert.match(html,/비교 근거 확인 필요/);assert.doesNotMatch(html,/company-pickup-grid/);
  }
});
test('insufficient or conflicting source status does not display a manufactured zero or positive change',()=>{
  const data=fixture(),view=ui(),pickup=data.companyDetail.integrated.snapshot.analysis.pickup;
  pickup.status='insufficient';assert.doesNotMatch(view.pickupView(data),/company-pickup-grid/);
  pickup.status='no_increase';assert.match(view.pickupView(data),/판정 상태와 근거가 일치하지 않아/);
  pickup.status='failed';assert.match(view.pickupView(data),/판정 상태를 확인해야/);
});
test('limited source evidence is labelled as recent evidence rather than a complete monthly pickup total',()=>{
  const data=fixture(),view=ui();data.companyDetail.integrated.snapshot.analysis.pickup.comparableIntervals=99;
  const html=view.pickupView(data);assert.match(html,/월 전체 비교 근거 99개 중 최근 3개/);assert.match(html,/월 전체 증감이 아닙니다/);
});
test('the integrated pickup panel preserves A/B/C, monthly totals, stacked bars and initially collapsed weekly tables',()=>{
  const html=ui().render(fixture());
  for(const label of ['업체 기본정보','예약채널','통합관측','월간 추정 예약·매출','최근 관측 간 변화','company-booking-chart','주간 추정 예약·매출'])assert.ok(html.includes(label),label);
  assert.ok(html.indexOf('월간 추정 예약·매출')<html.indexOf('최근 관측 간 변화'));
  assert.ok(html.indexOf('최근 관측 간 변화')<html.indexOf('company-booking-chart'));
  assert.match(html,/<details class="company-week-group/);assert.doesNotMatch(html,/<details class="company-week-group[^>]* open|data-collect|<form|data-flow-month|data-flow-metric/);
});
