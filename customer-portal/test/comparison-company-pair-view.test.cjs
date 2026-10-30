'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/comparison-dashboard-view.js');
const dates=['2026-10-31','2026-11-01','2026-11-02'],clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  const collectedAt='2026-10-30T03:00:00.000Z';
  const point=(date,rooms,sold,extra={})=>({date,status:'ready',sold,supply:rooms,publicBookings:sold,phoneBookings:0,reservationRate:sold/rooms,rate:sold/rooms,collectedAt,collectedDate:'2026-10-30',reasons:[],...extra});
  const price=(productId,value,runId)=>({value,min:value,max:value,products:1,days:3,rowCount:3,status:'ready',reasonCode:null,source:{runId,collectedAt},rows:dates.map(date=>({date,productId,productName:'객실 '+productId,price:value}))});
  const pickup=(runId,previous,current,changes)=>({value:changes.reduce((sum,row)=>sum+row,0),publicChange:changes.reduce((sum,row)=>sum+row,0),days:3,intervalCount:3,status:'reference',reasonCode:'PICKUP_REFERENCE_ONLY',reason:'관측 수량의 변화 · 신규 예약 확정 아님',source:{previousRunId:'previous_'+runId,currentRunId:runId,previousObservedAt:previous,currentObservedAt:current,calculationVersion:'public-booking-pickup-v1',sourceDigests:{previous:'a'.repeat(64),current:'b'.repeat(64)}},rows:dates.map((date,index)=>({date,publicChange:changes[index],previousPublic:2,currentPublic:2+changes[index],previousCollectedAt:previous,collectedAt:current,productCount:1,matchedProductIds:['room_a']})),limitations:['각 업체의 관측 구간과 상품 기준을 확인합니다.']});
  const own={companyId:'own',name:'내 기준 매장',kind:'own',rooms:10,regionLabel:'경남 산청',regionRelation:'own',industryRelation:'own',capacity:{label:'검수값',reviewRequired:false},summary:{days:3,sold:4,supply:30,publicBookings:4,phoneBookings:0,reservationRate:4/30},points:dates.map((date,index)=>point(date,10,index?2:0)),savedMetrics:{price:price('id:own',219000,'run_own'),pickup:pickup('run_own','2026-10-27T03:00:00.000Z',collectedAt,[0,1,0])}};
  const competitor={companyId:'peer',name:'선택 경쟁업체',kind:'competitor',rooms:12,regionLabel:'경남 진주',regionRelation:'cross',industryRelation:'common',capacity:{label:'최대 관측',reviewRequired:false},comparable:false,actionable:false,reasons:['다른 지역 · 개별 참고'],summary:{days:2,sold:4,supply:24,publicBookings:4,phoneBookings:0,reservationRate:4/24},points:dates.map((date,index)=>point(date,12,2,{collectedAt:'2026-10-31T03:00:00.000Z',collectedDate:'2026-10-31',...(index===0?{status:'unavailable',sold:null,supply:null,publicBookings:null,phoneBookings:null,reservationRate:null,rate:null,reasons:['정상 응답 자료가 없는 날짜']}:{})})),savedMetrics:{price:price('id:peer',179000,'run_peer'),pickup:pickup('run_peer','2026-10-28T03:00:00.000Z','2026-10-31T03:00:00.000Z',[0,2,-1])}};
  return {contextValid:true,own,companies:[own,competitor],dates:[...dates],sourcePeriod:{start:dates[0],end:dates[2],asOf:'2026-10-31'},period:{start:dates[0],end:dates[2],asOf:'2026-10-31',days:3},filters:{start:dates[0],end:dates[2],dayFilter:'all'},quality:{actionable:false},metrics:[],judgments:[],daily:[]};
}
function row(html,date){const match=new RegExp('<tr[^>]*data-dashboard-pair-date="'+date+'"[^>]*>([\\s\\S]*?)<\\/tr>').exec(html);assert.ok(match,'missing shared date row '+date);return match[1];}
function cell(html,key){const match=new RegExp('<td[^>]*data-dashboard-pair-cell="'+key+'"[^>]*>([\\s\\S]*?)<\\/td>').exec(html);assert.ok(match,'missing paired cell '+key);return match[1];}
test('a selected competitor shows the own property and competitor on one shared set of stay dates',()=>{
  const model=fixture(),html=view.companyDetail(model,'peer');
  assert.match(html,/data-dashboard-company-detail="peer"/);assert.match(html,/data-dashboard-company-pair="peer"/);assert.match(html,/내 기준 매장/);assert.match(html,/선택 경쟁업체/);
  assert.deepEqual([...html.matchAll(/data-dashboard-pair-date="([^"]+)"/g)].map(value=>value[1]),dates);
  for(const date of dates)for(const key of ['own-rate','peer-rate','own-price','peer-price','own-public-change','peer-public-change'])cell(row(html,date),key);
});
test('a genuine zero and an unavailable competitor point stay visibly different on the same date',()=>{
  const html=view.companyDetail(fixture(),'peer'),first=row(html,dates[0]);
  assert.match(cell(first,'own-rate'),/0\.0%/);assert.match(cell(first,'peer-rate'),/미확인/);assert.doesNotMatch(cell(first,'peer-rate'),/0\.0%/);
  assert.match(cell(first,'own-public-change'),/0실/);assert.match(cell(first,'peer-public-change'),/0실/);
});
test('same displayed stay dates do not hide different observation dates or imply an actionable ranking',()=>{
  const html=view.companyDetail(fixture(),'peer');
  assert.match(html,/관측(?:일| 시각| 시점| 구간)/);assert.match(html,/10\.\s*30\.|2026-10-30/);assert.match(html,/10\.\s*31\.|2026-10-31/);
  assert.match(html,/참고|보류/);assert.doesNotMatch(html,/예약률 우위 확정|자동 할인 실행|신규 예약 확정 [0-9]/);
});
test('different pickup observation pairs keep their own daily values without manufacturing a difference or combined new bookings',()=>{
  const html=view.companyDetail(fixture(),'peer'),second=row(html,dates[1]);
  assert.match(cell(second,'own-public-change'),/\+1실/);assert.match(cell(second,'peer-public-change'),/\+2실/);assert.match(html,/관측 구간|관측 시각/);
  assert.doesNotMatch(html,/신규예약 합계|신규 예약 합계|쿠폰 자동 실행/);
});
test('filtered date axes exclude all outside reservation, price and pickup dates on both sides',()=>{
  const model=fixture();model.dates=[dates[1]];model.period={...model.period,start:dates[1],end:dates[1],days:1};model.filters={start:dates[1],end:dates[1],dayFilter:'sunday'};
  const html=view.companyDetail(model,'peer');assert.deepEqual([...html.matchAll(/data-dashboard-pair-date="([^"]+)"/g)].map(value=>value[1]),[dates[1]]);
  assert.match(cell(row(html,dates[1]),'own-price'),/219,000원/);assert.match(cell(row(html,dates[1]),'peer-price'),/179,000원/);
});
test('the pair is a read-only projection and leaves company sources, filters and quantities untouched',()=>{
  const model=fixture(),before=clone(model);view.companyDetail(model,'peer');assert.deepEqual(model,before);
});
test('invalid customer context and foreign selections cannot reveal the pair or source prices',()=>{
  const model=fixture();assert.equal(view.companyDetail({...model,contextValid:false},'peer'),'');assert.equal(view.companyDetail(model,'unregistered_private'),'');
});
test('selecting own property retains the single-company detail rather than a duplicated pair',()=>{
  const html=view.companyDetail(fixture(),'own');assert.match(html,/data-dashboard-company-detail="own"/);assert.doesNotMatch(html,/data-dashboard-company-pair|data-dashboard-pair-date/);assert.match(html,/data-dashboard-company-daily/);
});
