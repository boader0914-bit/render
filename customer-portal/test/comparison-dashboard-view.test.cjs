'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/comparison-dashboard-view.js');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(){
  const dates=['2026-10-30','2026-10-31','2026-11-01'];
  const own={companyId:'own',name:'내 매장',kind:'own',rooms:10,regionRelation:'own',summary:{days:2,sold:5,supply:20,publicBookings:3,phoneBookings:2,reservationRate:.25},points:[]};
  const same={companyId:'same',name:'같은 지역 업체',kind:'competitor',rooms:16,regionRelation:'same',summary:{days:3,sold:0,supply:48,publicBookings:0,phoneBookings:0,reservationRate:0},points:[]};
  const cross={companyId:'cross',name:'타지역 업체',kind:'competitor',rooms:20,regionRelation:'cross',summary:{days:0,sold:null,supply:null,publicBookings:null,phoneBookings:null,reservationRate:null},points:[]};
  return {contextValid:true,status:'partial',sourcePeriod:{start:dates[0],end:dates[2],days:3,asOf:'2026-10-30'},period:{start:dates[0],end:dates[2],days:3,asOf:'2026-10-30'},dates,filters:{start:dates[0],end:dates[2],dayFilter:'all'},own,companies:[own,same,cross],metrics:[
    {id:'own_rate',label:'내 매장 추정 예약률',value:.25,unit:'%',status:'reference',detail:'공개 3실 + 타채널 추정 2실 · 2/3일'},
    {id:'peer_rate',label:'같은 지역·업종 표본 예약률',value:0,unit:'%',status:'reference',detail:'내 매장 제외 · 공통 관측 기준'},
    {id:'product_price',label:'숙박상품 표시가격 중앙값',value:null,unit:'원',status:'unavailable',detail:'상품가격 자료 미연결'},
    {id:'public_change',label:'공개예약 순변화',value:null,unit:'실',status:'unavailable',detail:'이전 동일조건 관측 미연결'}],
    judgments:[{id:'reservation_level',label:'예약 수준',title:'같은 숙박일을 먼저 확인',status:'hold',reason:'관측일이 달라 판단 보류',evidence:['내 매장 10월 28일 · 경쟁업체 10월 30일'],nextAction:'같은 관측 조건을 확인합니다.'},{id:'price_conditions',label:'가격 조건',title:'가격은 상품 조건과 함께',status:'hold',evidence:['표시가격 자료가 없습니다.'],nextAction:'판매 조건을 확인합니다.'},{id:'reservation_change',label:'예약 변화',title:'이전 회차가 필요합니다.',status:'hold',evidence:[],nextAction:'신규 예약으로 해석하지 않습니다.'}],
    daily:[{date:dates[0],ownRate:0,peerRate:.25,peerCompanyCount:1},{date:dates[1],ownRate:null,peerRate:null,peerCompanyCount:0},{date:dates[2],ownRate:.5,peerRate:.75,peerCompanyCount:1}],quality:{status:'partial',issues:[]}};
}
test('dashboard exposes the requested order and customer-specific names without a fixed property',()=>{
  const html=view.render(fixture()),ordered=['01 · 비교 조건','02 · 핵심 지표','03 · 판단 카드','04 · 비교 그래프'].map(text=>html.indexOf(text));
  assert.ok(ordered.every(i=>i>=0));assert.deepEqual([...ordered].sort((a,b)=>a-b),ordered);
  assert.match(html,/내 매장/);assert.match(html,/같은 지역 업체/);assert.doesNotMatch(html,/월명|상위 20|NaN|undefined/);
  assert.equal((html.match(/data-dashboard-metric=/g)||[]).length,4);
});
test('normal zero rate is visible while unconnected price and change stay unknown',()=>{
  const html=view.summary(fixture());
  assert.match(html,/25\.0%/);assert.match(html,/0\.0%/);
  assert.equal((html.match(/<strong>미확인<\/strong>/g)||[]).length,2);
  assert.match(html,/상품가격 자료 미연결/);assert.match(html,/이전 동일조건 관측 미연결/);assert.doesNotMatch(html,/>0원|>0실/);
});
test('date controls remain bounded by the saved source window and publish explicit filter hooks',()=>{
  const m=fixture();m.filters={start:'2026-10-31',end:'2026-11-01',dayFilter:'saturday'};m.period.days=1;
  const html=view.controls(m);
  assert.match(html,/data-dashboard-start value="2026-10-31" min="2026-10-30" max="2026-11-01"/);
  assert.match(html,/data-dashboard-end value="2026-11-01"/);assert.match(html,/value="saturday" selected/);
  assert.match(html,/data-dashboard-reset/);assert.match(html,/이전 관측 비교 미연결/);assert.match(html,/선택 1일/);
});
test('comparison composition splits public and inferred values and preserves normal zero / missing',()=>{
  const html=view.graphs(fixture());
  assert.match(html,/width:15\.00000%/);assert.match(html,/width:10\.00000%/);
  assert.match(html,/dashboard-zero-dot/);assert.match(html,/dashboard-bar-unknown">미확인/);
  assert.match(html,/타지역 업체/);assert.match(html,/다른 지역 · 참고/);
  assert.match(html,/공개 3실 \+ 타채널 추정 2실 \/ 공급 20실/);
});
test('flow never draws a line across unknown dates while retaining normal-zero dots',()=>{
  const html=view.rateFlow(fixture());
  assert.doesNotMatch(html,/<polyline/);
  assert.equal((html.match(/class="dashboard-own-series-point"/g)||[]).length,2);
  assert.match(html,/2026-10-30 · 내 매장 0\.0%/);assert.match(html,/관측 공백은 선으로 연결하지 않습니다/);
  assert.match(html,/<th scope="row">2026-10-31<\/th><td>미확인<\/td><td>미확인/);
});
test('contiguous observed values form segments and out-of-range rates never create chart geometry',()=>{
  const m=fixture();m.daily[1].ownRate=.3;m.daily[1].peerRate=2;
  const html=view.rateFlow(m);
  assert.match(html,/<polyline class="dashboard-own-series"/);
  assert.doesNotMatch(html,/<polyline class="dashboard-peer-series"/);assert.doesNotMatch(html,/200\.0%|NaN|Infinity/);
});
test('unsafe labels, evidence and identifiers cannot inject markup or links',()=>{
  const m=fixture();m.own.name='<img src=x onerror=alert(1)>';m.companies[0].companyId='own" onclick="x';
  m.judgments[0].title='<script>bad()</script>';m.judgments[0].evidence=['<iframe src=x>'];
  const html=view.render(m);
  assert.doesNotMatch(html,/<img |<script>|<iframe/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
  assert.match(html,/#company=own%22%20onclick%3D%22x/);
});
test('invalid scope shows no previous companies, KPIs or charts',()=>{
  const html=view.render({...fixture(),contextValid:false});
  assert.match(html,/선택한 고객·매장·기간/);assert.doesNotMatch(html,/data-dashboard-metric|<svg|같은 지역 업체|타지역 업체/);
});
test('an empty day filter renders an honest empty flow and does not invent rates',()=>{
  const m=fixture();m.dates=[];m.daily=[];m.period.days=0;
  const html=view.render(m);assert.match(html,/선택 0일/);assert.match(html,/선택한 조건의 숙박일 자료가 없습니다/);
  assert.doesNotMatch(html,/NaN|Infinity/);
});
test('inconsistent composed rate stays unknown instead of overflowing its bar',()=>{
  const m=fixture();m.companies[0].summary.publicBookings=30;
  const html=view.graphs(m);assert.match(html,/dashboard-bar-unknown/);assert.doesNotMatch(html,/width:150/);
});
test('metric price and change only format supplied numeric evidence, never derive price from revenue',()=>{
  assert.equal(view.metricValue({id:'product_price',value:199000,unit:'원'}),'199,000원');
  assert.equal(view.metricValue({id:'public_change',value:-3,unit:'실'}),'-3실');
  assert.equal(view.metricValue({id:'public_change',value:4,unit:'실'}),'+4실');
  assert.equal(view.metricValue({id:'product_price',value:null,unit:'원',revenue:2800000,sold:13}),'미확인');
});
test('actual dashboard projection renders same-region, cross-region and mixed saved-report contracts',()=>{
  const model=require('../web/comparison-dashboard.js'),{getScenario}=require('../review/comparison/fixtures.cjs');
  const {summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
  const {projectComparison}=require('../comparison-projection.cjs');
  for(const scenario of ['same','cross','mixed']){
    const f=getScenario({scenario}),raw=[f.own,...f.competitors],start=f.today,end=f.own.days.at(-1).date;
    const policy={mode:'current',asOf:start,period:{start,end},observationPolicy:{confirmed:true,maxSkewMs:2*60*60*1000}};
    const report={mode:'current_briefing',published:false,ownId:f.own.companyId,asOf:start,selection:{stayMode:'upcoming30'},period:{start,end,days:30},generatedAt:start+'T08:00:00Z',
      companies:raw.map((c,i)=>{const result={...c,...summarizeCompany(c,policy),kind:i?'competitor':'own',sourceStatus:'ready',sourceIssues:[],reservationSeries:projectReservationSeries(c,policy)};result.summaryQuality.mode='current';delete result.days;return result;}),
      comparisons:f.comparisonSet.comparisons.map(projectComparison),dataQuality:{status:'complete',issues:[]}};
    const selection={ownCompanyId:f.own.companyId,comparisonIds:f.competitors.map(c=>c.companyId),stayMode:'upcoming30',stayStart:start,stayEnd:end,asOfDate:start};
    const projected=model.project(report,selection,raw),html=view.render(projected);
    assert.equal(projected.contextValid,true,scenario+' '+JSON.stringify(projected.quality));assert.match(html,/내 매장 · 산청/);assert.match(html,/data-dashboard-metric="own_rate"/);
    assert.match(html,/관측 공백은 선으로 연결하지 않습니다/);assert.doesNotMatch(html,/NaN|undefined|Infinity|월명/);
    for(const c of f.competitors)assert.ok(html.includes(c.name),c.name);
    if(scenario==='cross'){assert.equal(projected.metrics.find(m=>m.id==='peer_rate').value,null);assert.match(html,/동일지역·공통업종의 표본 대상이 없습니다/);}
  }
});
test('all-unknown daily records have no fabricated SVG while one genuine zero remains drawable',()=>{
  const m=fixture();m.daily=m.daily.map(row=>({...row,ownRate:null,peerRate:null}));
  assert.doesNotMatch(view.rateFlow(m),/<svg/);assert.match(view.rateFlow(m),/일별 표시 자료가 없습니다/);
  m.daily[0].ownRate=0;assert.match(view.rateFlow(m),/<svg/);assert.match(view.rateFlow(m),/내 매장 0\.0%/);
});
function companyRow(html,id){
  const safe=id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('<tr[^>]*data-dashboard-saved-company="'+safe+'"[^>]*>[\\s\\S]*?<\\/tr>').exec(html)?.[0]||'';
}
function cell(html,key){return new RegExp('<td[^>]*data-dashboard-cell="'+key+'"[^>]*>([\\s\\S]*?)<\\/td>').exec(html)?.[1]||'';}
test('company comparison is always visible, keyboard scrollable and includes every selected company even without loaded evidence',()=>{
  const m=fixture(),html=view.summary(m),tableAt=html.indexOf('data-dashboard-company-table');
  assert.ok(tableAt>=0);assert.match(html,/<section[^>]*data-dashboard-company-comparison/);
  const before=html.slice(0,tableAt),depth=(before.match(/<details\b/g)||[]).length-(before.match(/<\/details>/g)||[]).length;
  assert.equal(depth,0,'the company table itself is not hidden inside a disclosure');
  assert.match(html,/dashboard-table-scroll[^>]*tabindex="0"/);
  const columns=[...html.matchAll(/<th scope="col">(.*?)<\/th>/g)].map(match=>match[1]);
  assert.deepEqual(columns,['업체','지역','객실 기준','추정 예약률','상품가격','공개예약 순변화','수량 확보']);
  assert.deepEqual([...html.matchAll(/data-dashboard-saved-company="([^"]+)"/g)].map(match=>match[1]),['own','same','cross']);
  assert.match(companyRow(html,'same'),/같은 지역 업체/);assert.match(companyRow(html,'cross'),/타지역 업체/);
  assert.match(cell(companyRow(html,'cross'),'reservation-rate'),/미확인/);
  assert.doesNotMatch(cell(companyRow(html,'cross'),'reservation-rate'),/0\.0%/);
  assert.doesNotMatch(cell(companyRow(html,'cross'),'public-change'),/>0실/);
});
test('public-only pickup remains visible independently of unknown full inventory, while normal zero stays different from missing',()=>{
  const m=fixture(),same=m.companies[1],cross=m.companies[2];
  same.rooms=null;same.summary={days:0,sold:null,supply:null,publicBookings:null,phoneBookings:null,reservationRate:null};
  same.savedMetrics={price:{value:179000,min:149000,max:299000,products:4,days:2,rowCount:8,status:'partial'},pickup:{value:2,publicChange:2,days:2,intervalCount:2,status:'reference',reasonCode:'PICKUP_PUBLIC_ONLY_REFERENCE',
    source:{previousRunId:'previous_public',currentRunId:'current_public',previousObservedAt:'2026-10-27T04:20:05.714Z',currentObservedAt:'2026-10-28T06:03:04.516Z',calculationVersion:'public-booking-pickup-v1'},
    limitations:['공개예약만 비교 · 전체 객실·방막기·매출은 미확인 유지']}};
  cross.savedMetrics={price:{value:0,min:0,max:0,products:1,days:1,rowCount:1,status:'ready'},pickup:{value:0,days:1,intervalCount:1,status:'reference',reasonCode:'PICKUP_PUBLIC_ONLY_REFERENCE'}};
  const html=view.savedMetrics(m),a=companyRow(html,'same'),b=companyRow(html,'cross');
  assert.match(cell(a,'reservation-rate'),/미확인/);assert.doesNotMatch(cell(a,'reservation-rate'),/0\.0%/);
  assert.match(cell(a,'rooms'),/미확인/);assert.match(cell(a,'public-change'),/>\+2실<\/strong>/);
  assert.match(cell(a,'public-change'),/공개예약만 비교 · 참고/);assert.match(cell(a,'public-change'),/previous_public/);assert.match(cell(a,'public-change'),/current_public/);
  assert.match(cell(b,'price'),/>0원<\/strong>/);assert.match(cell(b,'public-change'),/>0실<\/strong>/);
  assert.doesNotMatch(html,/<details[^>]* open/,'per-company provenance stays collapsed');
  const absent=companyRow(html,'own');assert.match(cell(absent,'price'),/미확인/);assert.doesNotMatch(cell(absent,'public-change'),/>0실<\/strong>/);
});
test('embedded conditions keep date bounds and weekday controls without introducing another card or heading',()=>{
  const m=fixture();m.filters={start:'2026-10-31',end:'2026-11-01',dayFilter:'saturday'};
  const html=view.controls(m,{embedded:true});
  assert.equal((html.match(/data-dashboard-start/g)||[]).length,1);assert.equal((html.match(/data-dashboard-end/g)||[]).length,1);assert.equal((html.match(/data-dashboard-day-filter/g)||[]).length,1);
  assert.match(html,/min="2026-10-30" max="2026-11-01"/);assert.match(html,/value="saturday" selected/);
  assert.doesNotMatch(html,/<section\b|<h2\b|data-dashboard-reset/);
});
test('company-table names, region labels and evidence remain escaped when exposed by default',()=>{
  const m=fixture();m.companies[1].name='<svg onload=alert(1)>';m.companies[1].regionLabel='<img src=x onerror=alert(2)>';
  m.companies[1].savedMetrics={price:{value:null,status:'unavailable',reasonCode:'PRICE_MISSING',reason:'<iframe src=x>'},pickup:{value:null,status:'unavailable',reasonCode:'PICKUP_NO_PREVIOUS_OBSERVATION'}};
  const html=view.savedMetrics(m);assert.match(html,/&lt;svg/);assert.match(html,/&lt;iframe/);assert.doesNotMatch(html,/<svg |<img |<iframe/);
});
function detailFixture({singleOwn=false}={}){
  const model=fixture(),company=model.companies[1];
  company.rooms=null;company.summary={days:0,sold:null,supply:null,publicBookings:null,phoneBookings:null,reservationRate:null};
  company.points=model.dates.map(date=>({date,status:'unavailable',sold:null,supply:null,publicBookings:null,phoneBookings:null,rate:null,reasons:['공유객실 수량 미확인']}));
  company.savedMetrics={price:{value:100000,min:0,max:200000,products:2,days:2,rowCount:3,status:'partial',source:{runId:'saved_price_same',collectedAt:'2026-10-28T06:03:04.516Z'},
    rows:[{date:model.dates[0],productId:'room-a',productName:'숙박 A',price:100000},{date:model.dates[0],productId:'room-b',productName:'숙박 B',price:200000},{date:model.dates[1],productId:'room-a',productName:'숙박 A',price:0}]},
    pickup:{value:2,publicChange:2,inferredChange:null,days:2,intervalCount:2,status:'reference',reasonCode:'PICKUP_PUBLIC_ONLY_REFERENCE',reason:'공개예약만 비교하는 참고값',
      rows:[{date:model.dates[0],previousPublic:1,currentPublic:3,publicChange:2,productCount:2,matchedProductIds:['room-a','room-b']},{date:model.dates[1],previousPublic:0,currentPublic:0,publicChange:0,productCount:2,matchedProductIds:['room-a','room-b']}],
      source:{previousRunId:'same_previous',currentRunId:'same_current',previousObservedAt:'2026-10-27T04:20:05.714Z',currentObservedAt:'2026-10-28T06:03:04.516Z',calculationVersion:'public-booking-pickup-v1',sourceDigests:{previous:'a'.repeat(64),current:'b'.repeat(64)}},limitations:['전체 예약수량·예약률·타채널 추정·매출은 미확인 유지']}};
  if(singleOwn){
    const selected={...company,companyId:model.own.companyId,name:'내 매장',kind:'own',regionRelation:'own'};
    model.companies=[selected,...model.companies.filter(row=>row.kind!=='own'&&row.companyId!==company.companyId)];model.own=selected;
  }
  return model;
}
const detailRow=(html,date)=>new RegExp('<tr[^>]*data-dashboard-detail-date="'+date+'"[^>]*>[\\s\\S]*?<\\/tr>').exec(html)?.[0]||'';
const detailCell=(html,key)=>new RegExp('<td[^>]*data-dashboard-detail-cell="'+key+'"[^>]*>([\\s\\S]*?)<\\/td>').exec(html)?.[1]||'';
test('company names provide buttons for instant in-page detail rather than requiring a separate company navigation',()=>{
  const html=view.savedMetrics(detailFixture());
  for(const id of ['own','same','cross'])assert.match(html,new RegExp('<button[^>]*type="button"[^>]*data-dashboard-company-select="'+id+'"'));
});
test('selecting a competitor changes only the pressed table row, keeping the customer own-property KPI and data unchanged',()=>{
  const model=detailFixture(),before=JSON.stringify(model),html=view.summary(model,{selectedCompanyId:'same'}),selected=companyRow(html,'same'),own=companyRow(html,'own');
  assert.match(selected,/data-dashboard-company-select="same"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-dashboard-company-select="same"/);
  assert.match(own,/data-dashboard-company-select="own"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-dashboard-company-select="own"/);
  assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);assert.match(html,/data-dashboard-metric="own_rate"[\s\S]*?25\.0%/);
  assert.equal(JSON.stringify(model),before);assert.equal(model.own.companyId,'own');
});
test('own property detail preserves independent public pickup and verified prices while full inventory stays unknown',()=>{
  const m=detailFixture({singleOwn:true}),before=JSON.stringify(m),html=view.companyDetail(m,'own');
  assert.match(html,/data-dashboard-company-detail="own"/);assert.match(html,/내 매장/);assert.match(html,/data-dashboard-company-daily/);
  assert.doesNotMatch(html,/타지역 업체/);assert.deepEqual([...html.matchAll(/data-dashboard-detail-date="([^"]+)"/g)].map(match=>match[1]),m.dates);
  const first=detailRow(html,m.dates[0]),zero=detailRow(html,m.dates[1]),missing=detailRow(html,m.dates[2]);
  for(const key of ['public','inferred','total','rate'])assert.match(detailCell(first,key),/미확인/,key);
  assert.match(detailCell(first,'price'),/150,000/);assert.match(detailCell(first,'price'),/2상품|상품 2/);assert.match(detailCell(first,'public-change'),/\+2실/);
  assert.match(detailCell(zero,'price'),/0원/);assert.match(detailCell(zero,'public-change'),/0실/);
  assert.match(detailCell(missing,'price'),/미확인/);assert.match(detailCell(missing,'public-change'),/미확인/);assert.doesNotMatch(detailCell(missing,'public-change'),/>0실/);
  assert.match(html,/data-dashboard-detail-source="price"/);assert.match(html,/saved_price_same/);assert.match(html,/숙박 A/);assert.match(html,/숙박 B/);
  assert.match(html,/data-dashboard-detail-source="pickup"/);assert.match(html,/same_previous/);assert.match(html,/same_current/);assert.match(html,/공개예약/);assert.match(html,/미확인 유지/);
  assert.equal(JSON.stringify(m),before);
});
test('own property detail follows the active selected dates and excludes out-of-filter price and pickup rows',()=>{
  const m=detailFixture({singleOwn:true});m.dates=m.dates.slice(0,1);m.period={...m.period,days:1,end:m.dates[0]};
  m.own.savedMetrics.price.rows.push({date:'2027-01-01',productId:'foreign-date',productName:'OUTSIDE-SELECTED-PRODUCT',price:999999});
  m.own.savedMetrics.pickup.rows.push({date:'2027-01-01',previousPublic:0,currentPublic:999999,publicChange:999999,productCount:1,matchedProductIds:['foreign-date']});
  const html=view.companyDetail(m,'own');
  assert.deepEqual([...html.matchAll(/data-dashboard-detail-date="([^"]+)"/g)].map(match=>match[1]),m.dates);
  assert.doesNotMatch(html,/OUTSIDE-SELECTED-PRODUCT|2027-01-01|999,999실|999,999원/);
});
test('detail displays normal public and inferred reservations together while retaining normal zero and unrelated missing price/pickup',()=>{
  const m=detailFixture({singleOwn:true}),company=m.own;company.rooms=10;
  company.points[0]={date:m.dates[0],status:'ready',sold:3,supply:10,publicBookings:1,phoneBookings:2,rate:.3,reservationRate:.3,reasons:[]};
  company.points[2]={date:m.dates[2],status:'ready',sold:0,supply:10,publicBookings:0,phoneBookings:0,rate:0,reservationRate:0,reasons:[]};
  company.summary={days:2,sold:3,supply:20,publicBookings:1,phoneBookings:2,reservationRate:.15};
  const html=view.companyDetail(m,'own'),first=detailRow(html,m.dates[0]),zero=detailRow(html,m.dates[2]);
  assert.match(detailCell(first,'public'),/1실/);assert.match(detailCell(first,'inferred'),/2실/);assert.match(detailCell(first,'total'),/3실/);assert.match(detailCell(first,'rate'),/30\.0%/);
  for(const key of ['public','inferred','total'])assert.match(detailCell(zero,key),/0실/);assert.match(detailCell(zero,'rate'),/0\.0%/);
  assert.match(detailCell(zero,'price'),/미확인/);assert.match(detailCell(zero,'public-change'),/미확인/);
});
test('aggregate-only saved evidence exposes its proof but cannot fabricate date-level prices or reservation changes',()=>{
  const m=detailFixture({singleOwn:true}),saved=m.own.savedMetrics;saved.price.rows=[];saved.pickup.rows=[];
  const html=view.companyDetail(m,'own');assert.match(html,/same_previous/);assert.match(html,/same_current/);
  for(const date of m.dates){const row=detailRow(html,date);assert.match(detailCell(row,'price'),/미확인/);assert.match(detailCell(row,'public-change'),/미확인/);assert.doesNotMatch(detailCell(row,'public-change'),/\+2실|>0실/);}
});
test('invalid company and invalid customer context do not fall back to another company private detail',()=>{
  const m=detailFixture();
  for(const html of [view.companyDetail(m,'not-registered'),view.companyDetail({...m,contextValid:false},'same')]){
    assert.doesNotMatch(html,/same_previous|saved_price_same|150,000원|data-dashboard-company-daily|같은 지역 업체/);
  }
});
test('new detail headings, product names and source references remain escaped',()=>{
  const m=detailFixture({singleOwn:true}),company=m.own;company.name='<script>bad()</script>';company.savedMetrics.price.rows[0].productName='<img src=x onerror=bad()>';
  company.savedMetrics.pickup.source.currentRunId='<iframe>bad</iframe>';company.savedMetrics.pickup.limitations.push('<script>source limitation</script>');
  const html=view.companyDetail(m,'own');assert.match(html,/&lt;script/);assert.match(html,/&lt;img/);assert.match(html,/&lt;iframe/);assert.doesNotMatch(html,/<script>|<img |<iframe/);
});
test('large selected-company product evidence keeps the first ten visible and the rest accessible in a closed disclosure',()=>{
  const m=detailFixture({singleOwn:true}),price=m.own.savedMetrics.price;
  price.rows=Array.from({length:12},(_,i)=>({date:m.dates[0],productId:'room-'+String(i).padStart(2,'0'),productName:'검증 객실 '+String(i).padStart(2,'0'),price:100000+i*1000}));
  price.products=12;price.rowCount=12;
  const html=view.companyDetail(m,'own'),match=html.match(/<details class="dashboard-detail-more-products">([\s\S]*?)<\/details>/);
  assert.ok(match);assert.match(match[1],/2개 상품 더보기/);assert.equal((match[1].match(/<li>/g)||[]).length,2);
  const before=html.slice(0,html.indexOf('<details class="dashboard-detail-more-products">'));
  assert.equal((before.match(/<li><span>검증 객실/g)||[]).length,10);
  assert.doesNotMatch(html,/<details[^>]*class="dashboard-detail-more-products"[^>]* open/);
});
