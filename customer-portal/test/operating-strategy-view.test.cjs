'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/operating-strategy-view.js'),'utf8');
const shift=(day,amount)=>new Date(Date.parse(day+'T00:00:00Z')+amount*86400000).toISOString().slice(0,10);
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(){
  return {version:'operating-strategy-test',status:'limited',period:{start:'2026-09-01',end:'2026-09-30',days:30,asOf:'2026-10-27',valid:true},
    source:{mode:'historical',generatedAt:'2026-10-27T01:30:00Z',preview:false,refreshing:false,refreshFailed:false},company:{companyId:'own',name:'예시 글램핑',rooms:16},
    summary:{validDays:30,selectedDays:30,missingDays:0,sold:134,supply:480,rate:134/480,publicBookings:125,phoneBookings:9,knownRevenueSubtotal:32725000,unknownRevenueDays:['2026-09-04','2026-09-12','2026-09-19','2026-09-20','2026-09-25']},
    weekdaySegments:[{key:'weekday',label:'월~목',days:18,selectedDays:18,missingDays:0,sold:54,supply:288,rate:54/288},{key:'friday',label:'금요일',days:4,selectedDays:4,missingDays:0,sold:24,supply:64,rate:24/64},{key:'weekend',label:'토·일',days:8,selectedDays:8,missingDays:0,sold:56,supply:128,rate:56/128}],
    actions:[{id:'own_flow',kind:'operation',status:'proposal',title:'다음 평일의 판매 조건을 검토하세요.',finding:'선택기간 월~목 예약률은 18.8%입니다.',next:'다음 평일 판매조건 한 가지를 검토하고 변경 내역을 기록하세요.',check:'같은 요일의 공개 예약과 유효 관측일',basis:['내 매장 유효 관측 30일','월~목 54실 / 공급 288실'],limits:['과거 흐름이며 현재 가격의 효과는 확인되지 않았습니다.'],dates:['2026-09-01','2026-09-02'],companyId:'own'},
      {id:'reference',kind:'experiment',status:'review',title:'운영 참고 업체의 상품 구성을 검토하세요.',finding:'다른 지역의 참고 업체가 포함돼 있습니다.',next:'운영자가 적용 가능한 상품 조건 한 가지를 비교하세요.',check:'선택한 상품 조건과 같은 요일의 예약 수량',basis:['다른 지역은 운영 참고'],limits:['지역 수요 차이는 보정되지 않았습니다.'],dates:[],companyId:'own'},
      {id:'unknown_money',kind:'data',status:'held',title:'미확인 금액의 판단을 보류하세요.',finding:'가격이 확인되지 않은 숙박일이 5일입니다.',next:'미확인 날짜를 제외한 확인된 소계만 검토하세요.',check:'금액 미확인 숙박일',basis:['금액 미확인 5일'],limits:['확인된 소계는 전체 매출이 아닙니다.'],dates:['2026-09-04','2026-09-12','2026-09-19','2026-09-20','2026-09-25'],companyId:'own'}],
    limitations:['내 매장 연결은 확인 대기 중입니다.','과거 관측을 바탕으로 한 검토 제안입니다.']};
}
function load(build=()=>fixture()){
  const context={module:{exports:{}},require:name=>{assert.equal(name,'./operating-strategy.js');return {build};}};
  vm.runInNewContext(source,context);
  return context.module.exports;
}
const view=load();

test('browser export delegates the supplied saved report and options without network, storage, DOM or input writes',()=>{
  const bad=()=>assert.fail('renderer must remain a pure read-only presentation'),report={saved:true},options={ownCompanyId:'own'},model=fixture(),before=JSON.stringify(model);let calls=0;
  const window={InsightOperatingStrategy:{build:(received,settings)=>{calls++;assert.equal(received,report);assert.equal(settings,options);return model;}}};
  vm.runInNewContext(source,{window,fetch:bad,XMLHttpRequest:bad,localStorage:{getItem:bad,setItem:bad},document:new Proxy({},{get:bad})});
  const html=window.InsightOperatingStrategyView.render(report,options);
  assert.equal(calls,1);assert.equal(JSON.stringify(model),before);assert.match(html,/data-operating-strategy/);
  assert.doesNotMatch(html,/<form|<button|data-collection|수집하기|예약 재개|정기수집 요청|전화예약 확인/);
});

test('the section shows its own historical period, observation cutoff, quantities, partial money and meaningful weekday values',()=>{
  const html=view.renderModel(fixture());
  assert.match(html,/>4<\/b><h2>운영 전략과 다음 행동/);assert.match(html,/선택 기간 회고/);assert.match(html,/2026-09-01 ~ 2026-09-30 · 30일/);assert.match(html,/관측 기준 2026-10-27/);
  assert.match(html,/예시 글램핑/);assert.match(html,/객실 16실/);assert.match(html,/href="#company=own"/);assert.match(html,/공개 125실 · 타채널 추정 9실/);assert.match(html,/27\.9%/);
  assert.match(html,/32,725,000원/);assert.match(html,/금액 미확인 5일/);assert.match(html,/확인된 매출 소계는 전체 매출을 뜻하지 않습니다/);
  assert.match(html,/월~목<\/h4><strong>18\.8%/);assert.match(html,/예약 54실 \/ 공급 288실/);assert.match(html,/유효 18 \/ 18일 · 미확인 0일/);
  assert.match(html,/금요일<\/h4><strong>37\.5%/);assert.match(html,/토·일<\/h4><strong>43\.8%/);assert.doesNotMatch(html,/NaN|undefined|confidence/i);
});

test('current and historical contexts stay distinct and large valid room counts are kept intact',()=>{
  const model=fixture();model.source.mode='current';model.period={start:'2026-10-27',end:'2026-11-25',days:30,asOf:'2026-10-27'};model.company.rooms=72;
  const html=view.renderModel(model);assert.match(html,/현재 30일 관측/);assert.doesNotMatch(html,/선택 기간 회고/);assert.match(html,/객실 72실/);
});

test('mixed saved periods and future custom selections use their actual stay dates rather than the historical transport mode',()=>{
  const mixed=fixture();mixed.period={start:'2026-09-01',end:'2026-11-16',days:77,asOf:'2026-10-27'};
  let html=view.renderModel(mixed);assert.match(html,/과거·향후 함께 보기/);assert.doesNotMatch(html,/선택 기간 회고|현재 30일 관측/);
  mixed.period={start:'2026-11-01',end:'2026-11-10',days:10,asOf:'2026-10-27'};html=view.renderModel(mixed);assert.match(html,/향후 숙박일 관측/);assert.doesNotMatch(html,/選択|선택 기간 회고|현재 30일 관측/);
});

test('zero bookings and zero known money stay visible while missing values never become zero',()=>{
  const normal=fixture();Object.assign(normal.summary,{sold:0,rate:0,publicBookings:0,phoneBookings:0,knownRevenueSubtotal:0,unknownRevenueDays:[]});normal.actions=[];
  let html=view.renderModel(normal);assert.match(html,/예약 수량<\/dt><dd>0실/);assert.match(html,/추정 예약률<\/dt><dd>0\.0%/);assert.match(html,/확인된 매출 소계<\/dt><dd>0원/);
  const missing=clone(normal);for(const key of ['sold','supply','rate','publicBookings','phoneBookings','knownRevenueSubtotal','validDays','missingDays'])missing.summary[key]=null;missing.weekdaySegments=[{label:'토요일',days:null,selectedDays:4,missingDays:null,sold:null,supply:null,rate:null}];
  html=view.renderModel(missing);assert.match(html,/확보 범위 미확인/);assert.match(html,/수량 미확인/);assert.match(html,/<dd>금액 미확인<span/);assert.match(html,/토요일<\/h4><strong>미확인/);assert.match(html,/유효일 미확인/);assert.doesNotMatch(html,/>0실|>0원|>0\.0%/);
});

test('proposal, manual review and held cards expose each step and keep the evidence initially folded',()=>{
  const html=view.renderModel(fixture());
  for(const label of ['제안','검토','보류','확인한 흐름','제안 행동','다음 확인 지표','판단 근거와 한계','사용한 근거','판단의 한계'])assert.ok(html.includes(label),label);
  for(const status of ['proposal','review','held'])assert.match(html,new RegExp('operating-strategy-state is-'+status));
  assert.equal((html.match(/data-operating-strategy-action=/g)||[]).length,3);assert.equal((html.match(/data-operating-strategy-evidence=/g)||[]).length,3);assert.doesNotMatch(html,/<details[^>]*\sopen(?:[=>\s])/);
  assert.match(html,/내 매장 유효 관측 30일/);assert.match(html,/지역 수요 차이는 보정되지 않았습니다/);assert.match(html,/이 제안을 볼 때/);
});

test('every valid evidence date remains available in the bounded exact-date list without mutating or duplicating it',()=>{
  const model=fixture();model.period={start:'2026-09-01',end:'2026-10-30',days:60,asOf:'2026-10-27'};model.actions=[model.actions[0]];
  const dates=Array.from({length:45},(_,index)=>shift(model.period.start,index));model.actions[0].dates=[...dates].reverse().concat(dates[0]);const before=JSON.stringify(model);
  const html=view.renderModel(model);assert.match(html,/근거 숙박일 · 전체 45일/);assert.equal((html.match(/<time datetime=/g)||[]).length,45);
  for(const day of dates)assert.ok(html.includes(`<time datetime="${day}">${day}</time>`),day);
  assert.equal(JSON.stringify(model),before);assert.match(html,/tabindex="0" aria-label="근거 숙박일 전체 목록"/);
});

test('names, titles, findings, steps, evidence and limitations are escaped while unrelated raw errors are ignored',()=>{
  const model=fixture(),hostile='<img src=x onerror=alert(1)>';
  model.company.name=hostile;model.actions=[{...model.actions[0],id:'bad" onclick="x',title:hostile,finding:hostile,next:hostile,check:hostile,basis:[hostile],limits:[hostile],dates:['2026-09-01','2026-02-30','<script>private</script>'],rawError:'PRIVATE-ERROR',token:'PRIVATE-TOKEN'}];model.limitations=[hostile];
  const html=view.renderModel(model);assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.doesNotMatch(html,/<img|<script|onclick=|PRIVATE|2026-02-30/);assert.match(html,/data-operating-strategy-action="action_0"/);
});

test('a preview holds cards even if an incoming action claims proposal status and does not present its next step as ready to apply',()=>{
  const model=fixture();model.source.preview=true;model.actions=[{...model.actions[0],status:'proposal',next:'APPLY-UNCONFIRMED-CHANGE',check:'UNCONFIRMED-CHECK'}];
  let html=view.renderModel(model);assert.match(html,/저장 자료 미리보기 · 계산 확인 중 · 제안 보류/);assert.match(html,/is-held/);assert.match(html,/보류 중인 행동/);assert.match(html,/계산 완료 여부와 선택한 숙박기간/);
  assert.doesNotMatch(html,/is-proposal|APPLY-UNCONFIRMED-CHANGE|UNCONFIRMED-CHECK/);assert.match(html,/32,725,000원/);
  model.source.refreshFailed=true;html=view.renderModel(model);assert.match(html,/계산 확인 필요 · 제안 보류/);
});

test('a failed latest check retains normal saved evidence and labels its age without inventing a fresh collection',()=>{
  const model=fixture();model.source.refreshFailed=true;
  const html=view.renderModel(model);assert.match(html,/최신 확인 지연 · 저장된 근거 기준/);assert.match(html,/32,725,000원/);assert.match(html,/2026-09-04/);assert.doesNotMatch(html,/최신 수집 완료|새 수집/);
});

test('empty action lists communicate no proposal without adding default operations or an execution control',()=>{
  const model=fixture();model.actions=[];model.weekdaySegments=[];
  let html=view.renderModel(model);assert.match(html,/추가 행동 제안을 만들지 않았습니다/);assert.match(html,/요일별로 나눌 날짜별 근거가 없습니다/);assert.doesNotMatch(html,/data-operating-strategy-action=|<button|<form/);
  model.source.preview=true;html=view.renderModel(model);assert.match(html,/계산 결과를 확인한 뒤 다음 행동을 검토/);
});

test('invalid models, periods, identities and numeric values fail closed without markup failures or operational instructions',()=>{
  for(const model of [null,undefined,{},[],{status:'unknown'},'invalid']){
    const html=view.renderModel(model);assert.match(html,/자료 확인 필요/);assert.match(html,/저장 자료를 확인하지 못했습니다/);assert.doesNotMatch(html,/NaN|undefined|\[object Object\]|href=/);
  }
  for(const mutate of [m=>{m.period={start:'2026-02-30',end:'2026-03-01',days:2};},m=>{m.company.companyId='javascript:bad';}]){
    const model=fixture();mutate(model);model.actions[0].next='UNVERIFIED-OPERATION';const html=view.renderModel(model);assert.match(html,/is-held/);assert.doesNotMatch(html,/UNVERIFIED-OPERATION|32,725,000원|>18\.8%/);
  }
  const model=fixture();model.summary.rate=Infinity;model.summary.sold=-1;model.summary.knownRevenueSubtotal='0';model.summary.publicBookings=NaN;model.summary.unknownRevenueDays=null;
  const html=view.renderModel(model);assert.doesNotMatch(html,/Infinity|NaN|>-1|>0원/);assert.match(html,/금액 미확인 범위 확인 필요/);
});

test('unavailable projection and model exceptions give a reviewable empty state',()=>{
  for(const api of [load(()=>{throw Error('PRIVATE-PROVIDER-ERROR');}),load(null)]){
    assert.equal(api.project({}),null);const html=api.render({});assert.match(html,/자료 확인 필요/);assert.doesNotMatch(html,/PRIVATE-PROVIDER/);
  }
});
