'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const strategy=require('../web/operating-strategy.js');
const {evaluateComparison,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const projection=require('../comparison-projection.cjs');
const {dailyPeriods}=require('../../scripts/lib/insight_briefing_periods.cjs');
const DAY=86400000,clone=v=>JSON.parse(JSON.stringify(v));
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
function fixture({historical=false,pending=false,cross=false,missing=false,zero=false,full=false,short=false,price=false,capacity=false,otherSold=null}={}){
  const start=historical?'2026-09-01':'2026-10-27',end=shift(start,29),asOf='2026-10-27';
  const policy={mode:historical?'historical':'current',period:{start,end},asOf,observationPolicy:{confirmed:!cross,maxSkewMs:7200000}};
  const make=(companyId,kind)=>({companyId,kind,name:kind==='own'?'월명 검수 매장':'등록 비교 매장',rooms:16,regionKey:kind==='competitor'&&cross?'pocheon':'sancheong',industryTags:['glamping'],comparisonPurpose:cross?'reference':'direct',relationStatus:kind==='own'&&pending?'pending':'active',capacityReviewRequired:capacity,capacityStatus:capacity?'review_required':'reviewed',days:Array.from({length:30},(_,i)=>{
    const date=shift(start,i),dow=new Date(date+'T00:00:00Z').getUTCDay(),sold=zero?0:full&&i===4?16:kind==='competitor'&&otherSold!==null?otherSold:dow>=1&&dow<=4?2:10;
    return {date,total:16,sold,publicBookings:sold,phoneBookings:0,estimatedRevenue:price&&i===2?null:sold*200000,revenuePartial:price&&i===2,revenueUnknownRooms:price&&i===2?1:0,phoneMissingPriceBookings:0,missing:missing&&i===2||short&&i>=6,collectedAt:historical?date+'T00:00:00.000Z':asOf+'T00:00:00.000Z'};
  })});
  const own=make('own','own'),other=make('other','competitor');
  const report={mode:'current_briefing',published:false,generatedAt:asOf+'T01:00:00Z',ownId:'own',asOf,selection:{stayMode:historical?'month':'upcoming30',month:historical?'2026-09':null},period:{start,end,days:30},companies:[own,other].map(c=>{
    const data=summarizeCompany(c,policy),company={companyId:c.companyId,name:c.name,kind:c.kind,rooms:c.rooms,relationStatus:c.relationStatus,capacityStatus:c.capacityStatus,capacityReviewRequired:c.capacityReviewRequired,sourceStatus:'ready',sourceIssues:[],...data};
    company.summaryQuality.mode=policy.mode;
    if(!historical)company.reservationSeries=projectReservationSeries(c,policy);
    else{
      const excluded=new Set(data.summaryQuality.excludedDates.map(d=>d.date));
      const daily=c.days.map(d=>excluded.has(d.date)?{date:d.date,total:null,sold:null,publicBookings:null,phoneBookings:null,reservationRate:null,collectedAt:null,collectedDate:null,missing:true,quantityStatus:'unknown',codes:['QUANTITY_MISSING']}:{...d,missing:false,collectedDate:d.date,reservationRate:d.sold/d.total,quantityStatus:'ready',codes:[]});
      company.reservationPeriods={period:reportPeriod(start,end),asOf,months:[{month:'2026-09',weeks:[{daily}]}]};
    }
    return company;
  }),comparisons:[projection.projectComparison(evaluateComparison(own,other,policy))],dataQuality:{status:'complete',issues:[]}};
  return report;
}
function reportPeriod(start,end){return {start,end,days:30};}
function operations(view){return view.actions.filter(a=>a.kind!=='data');}
function freeze(value){if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}return value;}

test('weighted weekday pattern uses only central daily quantities and gives a bounded manual experiment',()=>{
  const report=freeze(fixture()),before=JSON.stringify(report),view=strategy.build(report),action=view.actions.find(a=>a.id==='weekday_product_trial');
  assert.equal(view.status,'ready');assert.equal(view.summary.validDays,30);assert.equal(view.summary.selectedDays,30);assert.equal(view.summary.missingDays,0);
  assert.deepEqual(view.weekdaySegments.map(g=>g.label),['월~목','금~일']);
  const mon=view.weekdaySegments[0],fri=view.weekdaySegments[1];assert.equal(mon.rate,.125);assert.equal(fri.rate,.625);assert.equal(mon.rate,mon.sold/mon.supply);
  assert.equal(action.status,'proposal');assert.equal(action.kind,'experiment');assert.match(action.check,/비슷한 예약 선행일/);assert.ok(action.limits.some(s=>s.includes('검토 기준:')));assert.ok(action.limits.some(s=>s.includes('통계적 유의성')));
  assert.ok(view.limitations.some(s=>s.includes('공휴일')));assert.ok(operations(view).length<=3);assert.ok(view.actions.filter(a=>a.kind==='data').length<=2);assert.equal(JSON.stringify(report),before);
});

test('pending own relationship keeps useful self-property proposals visibly under review',()=>{
  const view=strategy.build(fixture({pending:true}));assert.equal(view.status,'limited');assert.ok(operations(view).length);assert.ok(operations(view).every(a=>a.status==='review'));assert.ok(view.limitations.some(s=>s.includes('연결 확인 대기')));
});

test('a full date uses room operation checks without adding inventory or changing prices',()=>{
  const view=strategy.build(fixture({full:true})),action=view.actions.find(a=>a.id==='full_dates_operation');assert.ok(action);assert.deepEqual(action.dates,['2026-10-31']);assert.match(action.next,/청소·입실/);assert.ok(action.limits.some(s=>s.includes('초과 예약')));assert.match(action.check,/취소 수량/);
});

test('historical-only central periods propose the next similar dates and preserve exact past evidence',()=>{
  const view=strategy.build(fixture({historical:true,full:true})),action=view.actions.find(a=>a.id==='weekday_product_trial'),full=view.actions.find(a=>a.id==='full_dates_operation');
  assert.equal(view.source.mode,'historical');assert.equal(view.summary.validDays,30);assert.match(action.title,/다음/);assert.match(action.next,/다음 같은 요일/);assert.ok(action.dates.every(d=>d<view.period.asOf));assert.ok(action.limits.some(s=>s.includes('과거 관측 근거')));assert.match(full.title,/다음 수요 집중일/);
});

test('unknown days are excluded while observed zero remains a measured zero',()=>{
  const missing=strategy.build(fixture({missing:true}));assert.equal(missing.summary.validDays,29);assert.equal(missing.summary.missingDays,1);assert.equal(missing.status,'limited');assert.equal(missing.weekdaySegments.reduce((n,g)=>n+g.days,0),29);
  const zero=strategy.build(fixture({zero:true}));assert.equal(zero.summary.validDays,30);assert.equal(zero.summary.sold,0);assert.equal(zero.summary.rate,0);assert.equal(zero.summary.publicBookings,0);assert.equal(zero.summary.knownRevenueSubtotal,0);assert.equal(operations(zero).length,0);
  const none=fixture();const own=none.companies[0];own.summary={days:0,supply:null,sold:null,reservationRate:null,publicBookings:null,phoneBookings:null,knownRevenueSubtotal:null,revenueUnknownDays:[]};own.summaryQuality.excludedDates=own.reservationSeries.points.map(p=>({date:p.date,codes:['QUANTITY_MISSING']}));own.reservationSeries.points=own.reservationSeries.points.map(p=>({...p,quantityStatus:'unknown',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,reservationRate:null,collectedAt:null,collectedDate:null,codes:['QUANTITY_MISSING']}));
  const unknown=strategy.build(none);assert.equal(unknown.status,'unavailable');assert.equal(unknown.summary.validDays,0);assert.equal(unknown.summary.sold,null);assert.equal(unknown.summary.rate,null);assert.equal(operations(unknown).length,0);
});

test('six valid days and a small weekday difference do not become an operational pattern',()=>{
  assert.equal(operations(strategy.build(fixture({short:true}))).length,0);
  const report=fixture();for(const point of report.companies[0].reservationSeries.points){point.sold=4;point.publicBookings=4;point.reservationRate=.25;}
  Object.assign(report.companies[0].summary,{sold:120,publicBookings:120,reservationRate:.25});const view=strategy.build(report);assert.equal(view.summary.rate,.25);assert.equal(view.actions.some(a=>a.id==='weekday_product_trial'),false);
});

test('summary mismatch, duplicate dates and malformed quantity identities fail closed',()=>{
  const mutations=[r=>r.companies[0].summary.sold++,r=>r.companies[0].summaryQuality.asOf='2026-10-26',r=>r.companies[0].reservationSeries.companyId='private',r=>r.companies[0].reservationSeries.points.push({...r.companies[0].reservationSeries.points[0]}),r=>r.companies[0].reservationSeries.points[0].phoneBookings=1,r=>r.companies[0].reservationSeries.points[0].collectedDate='2026-10-28',r=>r.companies[0].summaryQuality.duplicateStayDates=[r.period.start]];
  for(const mutate of mutations){const report=fixture();mutate(report);const view=strategy.build(report);assert.equal(operations(view).length,0);assert.equal(view.summary.sold,null);assert.equal(view.status,'unavailable');}
});

test('series and periods are never added and divergent secondary projections are held',()=>{
  const report=fixture(),own=report.companies[0];own.reservationPeriods={period:clone(report.period),asOf:report.asOf,months:[{weeks:[{daily:clone(own.reservationSeries.points)}]}]};
  assert.equal(strategy.build(report).summary.validDays,30);assert.equal(strategy.build(report).summary.sold,own.summary.sold);
  own.reservationPeriods.months[0].weeks[0].daily[0].sold++;let view=strategy.build(report);assert.equal(operations(view).length,0);assert.equal(view.summary.sold,null);
  const fallback=fixture();fallback.companies[0].reservationPeriods=own.reservationPeriods;fallback.companies[0].reservationSeries.period.start='2026-10-26';view=strategy.build(fallback);assert.equal(operations(view).length,0,'bad canonical series cannot fall back to another representation');
});

test('a centrally excluded stale day can retain its period timestamp without blocking the other 29 days',()=>{
  const report=fixture(),company={companyId:'own',rooms:16,days:report.companies[0].reservationSeries.points.map(p=>({...p,estimatedRevenue:p.sold*200000}))};
  company.days[10].collectedAt='2026-10-01T00:00:00.000Z';
  const policy={mode:'current',asOf:report.asOf,period:{start:report.period.start,end:report.period.end}};
  Object.assign(report.companies[0],summarizeCompany(company,policy),{reservationSeries:projectReservationSeries(company,policy),reservationPeriods:dailyPeriods(company,report.period,{asOf:report.asOf,mode:'current'})});
  report.companies[0].summaryQuality.mode='current';
  const row=report.companies[0].reservationPeriods.months.flatMap(m=>m.weeks.flatMap(w=>w.daily)).find(r=>r.date===company.days[10].date);
  assert.equal(row.missing,true);assert.notEqual(row.collectedDate,report.companies[0].reservationSeries.points[10].collectedDate);
  const view=strategy.build(report);assert.equal(view.status,'limited');assert.equal(view.summary.validDays,29);assert.equal(view.summary.missingDays,1);assert.ok(operations(view).some(a=>a.id==='weekday_product_trial'));
  row.sold=1;assert.equal(strategy.build(report).status,'unavailable','an unknown period record cannot smuggle an extra quantity');
});

test('capacity review, unknown capacity and conflicts prevent rate-based operations',()=>{
  for(const mutate of [r=>r.companies[0].capacityReviewRequired=true,r=>r.companies[0].capacityConflict=true,r=>r.companies[0].capacityStatus='unknown',r=>r.companies[0].summaryQuality.reservationRateAvailable=false,r=>r.companies[0].reservationSeries.points[0].total=17]){
    const report=fixture();mutate(report);const view=strategy.build(report);assert.equal(operations(view).length,0);assert.ok(view.limitations.some(s=>/객실 기준|중앙 집계/.test(s)));
  }
});

test('every preview signal holds operations; refresh failure keeps saved evidence visibly limited',()=>{
  for(const signal of [{responseCache:{preview:true}},{responseCache:{state:'preview'}},{calculation:{mode:'saved_only'}}]){
    const view=strategy.build({...fixture(),...signal});assert.equal(operations(view).length,0);assert.equal(view.source.preview,true);assert.equal(view.status,'limited');assert.equal(view.summary.validDays,30);
  }
  const view=strategy.build({...fixture(),responseCache:{refreshFailed:true}});assert.equal(view.summary.validDays,30);assert.equal(view.status,'limited');assert.ok(operations(view).length);assert.ok(operations(view).every(a=>a.status==='review'));assert.ok(view.limitations.some(s=>s.includes('최신 확인에 실패')));
});

test('cross-region central comparable gap remains reference review and never becomes central action permission',()=>{
  const report=fixture({cross:true,otherSold:14});assert.equal(report.comparisons[0].comparable,true);assert.equal(report.comparisons[0].actionable,false);
  const view=strategy.build(report),action=view.actions.find(a=>a.id==='comparison_product_reference');assert.ok(action);assert.equal(action.kind,'data');assert.equal(action.status,'review');assert.equal(action.companyId,'other');assert.ok(action.limits.some(s=>s.includes('행동 판단 보류를 해제하지')));assert.ok(action.basis.some(s=>s.includes('다른 지역')));assert.match(action.next,/이미 제공되거나 저장된/);assert.doesNotMatch(action.next,/실험|수정하세요|변경하세요/);assert.doesNotMatch(action.check,/설명 변경|적용일/);assert.equal(report.comparisons[0].actionable,false);
});

test('legacy and insufficient pair rows stay held and never provide an operational competitor card',()=>{
  const report=fixture();report.comparisons=[{companyId:'other',gapPp:-50,commonDays:30}];let view=strategy.build(report);assert.equal(view.actions.some(a=>a.id==='comparison_product_reference'),false);assert.equal(view.actions.find(a=>a.id==='comparison_held').status,'held');
  view=strategy.build(fixture({short:true}));assert.equal(view.actions.some(a=>a.id==='comparison_product_reference'),false);assert.match(view.actions.find(a=>a.id==='comparison_held').finding,/6일/);
});

test('unknown money remains a known subtotal with exact unknown dates and no revenue promise',()=>{
  const view=strategy.build(fixture({price:true}));assert.deepEqual(view.summary.unknownRevenueDays,['2026-10-29']);assert.equal(view.summary.knownRevenueSubtotal,fixture({price:true}).companies[0].summary.knownRevenueSubtotal);assert.ok(view.limitations.some(s=>s.includes('전체 매출·영업이익이 아닙니다')));assert.ok(operations(view).length,'price gaps do not erase sound quantity-based self-property review');
});

test('own and selected comparison identities stay scoped and unselected data never enters the output',()=>{
  const report=fixture({cross:true,otherSold:14});report.companies.push({...clone(report.companies[1]),companyId:'secret',name:'PRIVATE-COMPANY'});report.companies[0].rawError='PRIVATE-ERROR';report.token='PRIVATE-TOKEN';
  const view=strategy.build(report,{ownCompanyId:'own',comparisonIds:[]});assert.equal(view.actions.some(a=>a.companyId==='other'),false);assert.doesNotMatch(JSON.stringify(view),/PRIVATE|secret|token|rawError/);
  assert.equal(strategy.build(report,{ownCompanyId:'foreign'}).status,'unavailable');report.companies[0].relationStatus='removed';assert.equal(strategy.build(report).status,'unavailable');
});

test('published artifacts, wrong report modes and invalid periods are never reinterpreted as strategy input',()=>{
  for(const change of [{published:true},{published:undefined},{mode:'published_report'},{period:{start:'2026-02-29',end:'2026-03-30',days:30}}]){
    const view=strategy.build({...fixture(),...change});assert.equal(view.status,'unavailable');assert.equal(operations(view).length,0);assert.equal(view.summary.sold,null);
  }
});

test('mixed historical and future selection keeps action evidence in one time direction',()=>{
  const report=fixture({historical:true});report.asOf='2026-09-15';for(const c of report.companies){c.summaryQuality.asOf=report.asOf;c.reservationPeriods.asOf=report.asOf;for(const day of c.reservationPeriods.months[0].weeks[0].daily){day.collectedDate=report.asOf;day.collectedAt=report.asOf+'T00:00:00.000Z';}}
  // Central historical daily records can have a later recheck. The model does
  // not invent a second observation or recompute the central comparison.
  const view=strategy.build(report),action=view.actions.find(a=>a.id==='weekday_product_trial');assert.ok(action);assert.ok(action.dates.every(d=>d>=report.asOf));assert.ok(view.limitations.some(s=>s.includes('과거와 향후')));assert.match(action.finding,/향후 숙박일/);
});

test('browser UMD model exports with no network, storage, callbacks or input mutation',()=>{
  const context={window:{},fetch:()=>assert.fail('network'),localStorage:{setItem:()=>assert.fail('storage')},setTimeout:()=>assert.fail('timer')};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/comparison-readiness.js'),'utf8'),context);vm.runInNewContext(fs.readFileSync(require.resolve('../web/operating-strategy.js'),'utf8'),context);
  const report=freeze(fixture()),before=JSON.stringify(report),view=context.window.InsightOperatingStrategy.build(report);assert.equal(view.summary.validDays,30);assert.equal(JSON.stringify(report),before);assert.ok(view.actions.every(a=>typeof a.next==='string'&&typeof a.check==='string'));
});
