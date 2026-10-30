'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const view=require('../web/comparison-dashboard-view.js');
function fixture(){
  return {contextValid:true,sourcePeriod:{start:'2026-10-30',end:'2026-11-28',asOf:'2026-10-30'},period:{start:'2026-10-30',end:'2026-11-28',days:30},filters:{dayFilter:'all'},
    own:{companyId:'own'},metrics:[
      {id:'peer_rate',label:'표본예약률',value:null,unit:'%',status:'unavailable',reasonCode:'OBSERVATION_DAY_MISMATCH',reason:'내 매장 10/28 · 경쟁업체 10/30'},
      {id:'product_price',label:'숙박상품 표시가격',value:219000,unit:'원',status:'ready',evidence:['숙박상품 3개 · 19일 · 57건']},
      {id:'public_change',label:'공개예약 순변화',value:0,unit:'실',status:'reference',reasonCode:'PICKUP_REFERENCE_ONLY',detail:'같은 숙박일 5일 · 저장 관측의 순변화'}],
    companies:[{companyId:'own',name:'내 매장',kind:'own',savedMetrics:{
      price:{value:219000,min:219000,max:320000,products:3,days:19,rowCount:57,status:'ready',source:{runId:'run-price',collectedAt:'2026-10-28T06:03:04.516Z'}},
      pickup:{value:0,days:5,intervalCount:5,status:'reference',reasonCode:'PICKUP_REFERENCE_ONLY',source:{previousObservedAt:'2026-10-27T04:20:05.714Z',currentObservedAt:'2026-10-28T06:03:04.516Z',calculationVersion:'saved-v1'},limitations:['최근 두 관측 사이의 순변화 · 신규 예약수 아님']}}},
      {companyId:'other',name:'경쟁업체',kind:'competitor',regionRelation:'same',savedMetrics:{price:{value:null,status:'unavailable',reasonCode:'PRICE_MISSING',reason:'양수 판매가격 자료가 없습니다.'},pickup:{value:null,status:'unavailable',reasonCode:'PICKUP_NO_PREVIOUS_OBSERVATION',reason:'동일 숙박일의 이전 관측이 없습니다.'}}}],judgments:[],daily:[]};
}
test('typed unknown reasons distinguish different observation days, missing price and previous observation',()=>{
  const html=view.summary(fixture());
  assert.match(html,/관측일 차이로 비교 보류/);assert.match(html,/가격 자료 없음/);assert.match(html,/이전 관측 없음/);
  assert.match(html,/data-reason-code="OBSERVATION_DAY_MISMATCH"/);
  assert.match(html,/219,000원/);assert.match(html,/<strong>0실<\/strong>/);assert.doesNotMatch(html,/>0원/);
});
test('company comparison defaults to visible while individual provenance stays collapsed and retains source dates and counts',()=>{
  const html=view.savedMetrics(fixture());
  assert.match(html,/<section class="card dashboard-saved-metrics"[^>]*data-dashboard-company-comparison/);
  assert.match(html,/<table[^>]*data-dashboard-company-table/);
  assert.doesNotMatch(html,/<details class="card dashboard-saved-metrics"/);
  assert.match(html,/3상품 · 19일 · 57건/);assert.match(html,/219,000~320,000원/);
  assert.match(html,/같은 숙박일 5일 · 관측 비교 5건 · 신규 예약수 아님/);
  assert.match(html,/run-price/);assert.match(html,/10\. 28\./);assert.match(html,/계산 기준 saved-v1/);
  assert.match(html,/data-dashboard-saved-company="other"/);assert.doesNotMatch(html,/<details[^>]* open/);
});
test('ready and loading/failure states never use a blanket unconnected comparison notice',()=>{
  const model=fixture();
  assert.match(view.controls(model),/이전·현재 저장 관측 비교 · 참고/);assert.doesNotMatch(view.controls(model),/이전 관측 비교 미연결/);
  model.metrics.find(m=>m.id==='public_change').value=null;
  model.metrics.find(m=>m.id==='public_change').reasonCode='SOURCE_LOADING';
  assert.match(view.controls(model),/저장 자료 조회 중/);
  model.metrics.find(m=>m.id==='public_change').reasonCode='FETCH_FAILED';
  assert.match(view.controls(model),/저장 자료 조회 실패/);
});
test('saved evidence cannot inject markup and invalid customer scope never exposes it',()=>{
  const model=fixture();model.companies[0].name='<img src=x>';model.companies[0].savedMetrics.price.source.runId='<script>secret()</script>';
  model.metrics[1].evidence=['<iframe>'];
  const html=view.summary(model);
  assert.doesNotMatch(html,/<img|<script|<iframe/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.match(html,/&lt;iframe/);
  assert.doesNotMatch(view.render({...model,contextValid:false}),/run-price|219,000원|data-dashboard-saved-company/);
});
test('negative changes remain signed and null does not become a zero',()=>{
  const model=fixture(),pickup=model.companies[0].savedMetrics.pickup;
  pickup.value=-3;assert.match(view.savedMetrics(model),/>-3실<\/strong>/);
  pickup.value=null;pickup.reasonCode='PICKUP_INVALID_EVIDENCE';
  const html=view.savedMetrics(model);assert.match(html,/관측 근거 확인 필요/);assert.doesNotMatch(html,/>0실<\/strong>/);
});
