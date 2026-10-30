'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const arithmetic=require('../web/customer-operating-actions.js').computeCouponScenario;
const path=require.resolve('../web/customer-operating-actions-view.js');
function fixture(){
  const selection={ownCompanyId:'season',comparisonIds:['same','cross'],stayMode:'upcoming30',stayStart:'2026-10-30',stayEnd:'2026-10-31',asOfDate:'2026-10-30',selectedView:'flow'};
  return {selection,report:{ownId:'season',companyName:'시즌글램핑',sameName:'산청 비교',crossName:'진주 참고'},catalog:[]};
}
function model(report,selection){
  if(report.ownId!==selection.ownCompanyId)return {contextValid:false};
  const days=[selection.stayStart,selection.stayEnd].map((date,index)=>({date,weekday:index?'토':'금',leadDays:index,owner:{rate:index?0:.2,supply:10,sold:index?0:2,publicBookings:index?0:2,inferredBookings:0,products:[]},peers:{rate:.6,validCompanies:1,expectedCompanies:1},gapPp:index?-60:-40,action:'limited_coupon_review',actionLabel:'한정 쿠폰 조건 검토',status:'review',policyActionable:false,reasons:['같은 숙박일의 예약 차이'],reviewReasons:['객실 기준 검수 전'],preconditions:['실제 상품의 판매 가능 재고 확인'],evidence:['고객별 저장 자료'],steps:['상품·날짜를 좁혀 조건을 검토합니다.']}));
  return {version:'customer-operating-actions-v1',contextValid:true,company:{companyId:selection.ownCompanyId,name:report.companyName,rooms:10},rules:{minimumPeerCompanies:1,minimumPeerCoverage:.8},groups:{same:[{name:report.sameName,commonDays:2,actionable:false}],cross:[{name:report.crossName,commonDays:2}],unknown:[]},summary:{selectedDays:2,validDays:2,couponReviewDays:2,conditionReviewDays:0,maintainPriceDays:0,holdDays:0},days,limits:['다른 지역을 한 평균으로 합치지 않습니다.']};
}
function harness(){
  const handlers={},container={innerHTML:''},output={innerHTML:''};let allowed=true;
  const engine={computeOperatingPlan:model,computeCouponScenario:arithmetic};
  const document={querySelector:selector=>selector==='#customer-operating-actions'?container:selector==='[data-customer-coupon-output]'?output:null,addEventListener:(event,fn)=>handlers[event]=fn};
  const context=vm.createContext({module:{exports:{}},require:()=>engine,document,console});
  vm.runInContext(fs.readFileSync(path,'utf8'),context);
  const view=context.module.exports,f=fixture(),options={...f,scope:'customerA',isCurrent:()=>allowed};
  const render=()=>view.render(f.report,f.selection,f.catalog,{scope:options.scope});
  render();view.mount(options);
  const input=(field,value)=>handlers.input({target:{dataset:{customerCouponField:field},value,closest:()=>container}});
  const date=value=>handlers.click({target:{closest:()=>({dataset:{customerOperatingDate:value},closest:()=>container,hasAttribute:()=>false})},preventDefault(){}});
  return {view,f,options,handlers,container,output,render,input,date,deny:()=>allowed=false};
}
test('customer-specific direction, same/cross grouping and manual price classification do not import the fixed Wolmyeong example',()=>{
  const h=harness(),html=h.render();
  assert.match(html,/시즌글램핑 가격·쿠폰 운영 검토/);assert.match(html,/같은 지역 1곳/);assert.match(html,/산청 비교/);assert.match(html,/다른 지역 1곳/);assert.match(html,/진주 참고/);
  assert.match(html,/상품·운영 참고로만/);assert.match(html,/근거 확인 후 검토/);assert.match(html,/직접 입력한 가정/);assert.match(html,/상품 판매가격 가정 \(원\)/);assert.match(html,/미확인 → 미확인/);
  assert.doesNotMatch(html,/월명|경남글램핑|199,000원|쿠폰 발급하기|<form[^>]*action=/);
});
test('manual coupon inputs calculate required rooms and do not rerender or replace the active input field',()=>{
  const h=harness();for(const [key,value]of Object.entries({price:'179000',discount:'10',variableCost:'50000',commission:'10',baseline:'2',capacity:'4'}))h.input(key,value);
  assert.match(h.output.innerHTML,/161,100원/);assert.match(h.output.innerHTML,/111,100원 → 94,990원/);assert.match(h.output.innerHTML,/3실/);assert.match(h.output.innerHTML,/기준보다 \+1실/);assert.equal(h.container.innerHTML,'');
  h.input('capacity','2');assert.match(h.output.innerHTML,/상품 판매한도를 넘습니다/);
  h.input('commission','');assert.match(h.output.innerHTML,/미확인 → 미확인/);
});
test('background rendering of unchanged authorized conditions retains assumptions, but date and customer changes reset them',()=>{
  const h=harness();h.input('price','179000');h.input('discount','10');h.input('variableCost','50000');
  assert.match(h.render(),/data-customer-coupon-field="price"[^>]*value="179000"/);
  assert.match(h.render(),/data-customer-coupon-field="variableCost"[^>]*value="50000"/);
  h.date('2026-10-31');assert.match(h.container.innerHTML,/data-customer-coupon-field="price"[^>]*value=""/);assert.match(h.container.innerHTML,/data-customer-coupon-field="discount"[^>]*value="0"/);
  h.input('price','250000');h.options.scope='customerB';const next=h.render();assert.doesNotMatch(next,/value="250000"/);assert.match(next,/data-customer-coupon-field="price"[^>]*value=""/);
});
test('permission/context guard rejects late input updates and a different own store cannot show prior customer figures',()=>{
  const h=harness();h.input('price','179000');h.deny();h.input('price','1000');assert.match(h.render(),/value="179000"/);
  h.f.selection={...h.f.selection,ownCompanyId:'not-this-account'};h.options.selection=h.f.selection;
  const wrong=h.render();assert.match(wrong,/선택한 고객·매장·기간/);assert.doesNotMatch(wrong,/value="179000"|시즌글램핑 가격/);
});
test('customer labels and source reasons are escaped and explicit zero remains different from a blank assumption',()=>{
  const h=harness();h.f.report.companyName='<script>bad</script>';h.f.report.sameName='<img onerror=x>';
  const html=h.render();assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<script>|<img onerror/);
  assert.equal(h.view.blankNumber(''),null);assert.equal(h.view.blankNumber('  '),null);assert.equal(h.view.blankNumber('0'),0);assert.equal(h.view.blankNumber('Infinity'),null);
});

test('coupon form submission is fully contained and a changed manual product starts with fresh assumptions',()=>{
  const h=harness();let prevented=0,stopped=0;
  h.handlers.submit({target:{matches:()=>true},preventDefault:()=>prevented++,stopImmediatePropagation:()=>stopped++});
  assert.equal(prevented,1);assert.equal(stopped,1);
  h.input('price','179000');h.input('discount','10');h.input('productName','다른 객실');
  h.handlers.change({target:{dataset:{customerCouponField:'productName'},value:'다른 객실',closest:()=>h.container,hasAttribute:()=>false}});
  assert.match(h.container.innerHTML,/data-customer-coupon-field="productName"[^>]*value="다른 객실"/);
  assert.match(h.container.innerHTML,/data-customer-coupon-field="price"[^>]*value=""/);
  assert.match(h.container.innerHTML,/data-customer-coupon-field="discount"[^>]*value="0"/);
});

test('a stale disclosure toggle cannot change the current customer form presentation after its context is no longer authorized',()=>{
  const h=harness();
  const target={dataset:{customerOperatingDetail:'scenario'},open:true,closest:()=>h.container};
  h.handlers.toggle({target});assert.match(h.render(),/data-customer-operating-detail="scenario" open/);
  h.deny();target.open=false;h.handlers.toggle({target});
  assert.match(h.render(),/data-customer-operating-detail="scenario" open/,'a denied late toggle must not overwrite the last authorized disclosure state');
});
