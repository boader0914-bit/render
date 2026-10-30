'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const selection=require('../web/comparison-selection.js'),view=require('../web/comparison-view.js');
const {buildComparisonSet,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10),shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10),clone=v=>JSON.parse(JSON.stringify(v));
function fixture(){
  const start=today(),period={start,end:shift(start,29)},options={mode:'current',asOf:start,period};
  const companies=[['own','r1'],['same','r1'],['cross','r2']].map(([companyId,regionKey],k)=>{
    const c={companyId,kind:companyId==='own'?'own':'competitor',name:companyId==='own'?'내 매장':'비교 '+companyId,regionKey,rooms:16+k,relationStatus:'active',industryTags:['glamping'],comparisonPurpose:'reference',capacityStatus:'reviewed',days:Array.from({length:30},(_,i)=>({date:shift(start,i),total:16+k,sold:i===0?0:5+k,publicBookings:i===0?0:3+k,phoneBookings:i===0?0:2,estimatedRevenue:i===1?null:100000,revenuePartial:i===1,missing:i===2,collectedAt:start+'T03:00:00.000Z'}))};
    return {...c,...summarizeCompany(c,options),reservationSeries:projectReservationSeries(c,options)};
  });
  const data={mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{...period,days:30},ownId:'own',companies,comparisons:buildComparisonSet(companies[0],companies.slice(1),options).comparisons,regions:[],actions:[],definitions:[],dataQuality:{status:'complete',issues:[]}};
  const store=selection.createStore({scope:'test',permissionSignature:'p1',authorizedOwnCompanyIds:['own'],authorizedComparisonIds:['same','cross'],ownCompanyId:'own',companies,initialState:{ownCompanyId:'own',comparisonIds:['same','cross']}});
  return {data,store,state:{customer:{relations:companies.map(c=>({companyId:c.companyId,kind:c.kind,status:'active'}))},companies}};
}
test('real comparison contract renders individual quantities, region relations and partial money without invented averages',()=>{
  const f=fixture(),html=view.render(f.data,f.store.getState(),f.state.companies);
  assert.match(html,/같은 지역 1 · 다른 지역 1/);assert.match(html,/지역 차이 미보정/);assert.match(html,/일부 금액 미확인/);assert.match(html,/0실 \(공개 0/);assert.match(html,/미확인/);assert.match(html,/지역 전체 평균으로 표시하지 않습니다/);
  assert.doesNotMatch(html,/NaN|undefined|比較|실제 예약 확정/);
});
test('wrong own, stay period or historical cutoff never display the current series under different controls',()=>{
  const f=fixture(),s=f.store.getState();
  for(const change of [{ownCompanyId:'other'},{stayStart:shift(s.stayStart,-1)},{stayMode:'month',stayMonth:'2026-09',asOfDate:'2026-09-30'}]){
    const html=view.render(f.data,{...s,...change});assert.match(html,/이전 조건의 숫자를 표시하지 않습니다/);assert.doesNotMatch(html,/comparison-rate|<svg/);
  }
});
test('capacity conflicts retain normal count bars but hold the rate and never fill unknown dates with zero',()=>{
  const f=fixture(),c=f.data.companies[0];c.reservationSeries.points[1].inventoryConflict=true;c.reservationSeries.points[1].reservationRate=null;
  const html=view.chart(c,20);assert.match(html,/객실 기준 확인 필요/);assert.match(html,/예약 5실/);assert.match(html,/예약률 보류/);assert.match(html,/comparison-missing/);
});
test('legacy saved rows remain visible as reference and absent daily series never create fake charts',()=>{
  const f=fixture();for(const c of f.data.companies)delete c.reservationSeries;
  f.data.comparisons=f.data.comparisons.map(c=>({companyId:c.companyId,name:c.name,commonDays:c.commonDays,own:c.own,competitor:c.competitor,gapPp:c.gapPp,status:c.status}));
  const html=view.render(f.data,f.store.getState(),f.state.companies);assert.match(html,/이전 비교 기준의 참고자료/);assert.match(html,/일별 표시 자료가 없습니다/);assert.doesNotMatch(html,/<svg/);
});
test('product and region views use linked saved evidence without fabricated prices or unauthorized region calls',()=>{
  const f=fixture();f.store.update({selectedView:'products'});let html=view.render(f.data,f.store.getState(),f.state.companies);assert.match(html,/A·B·C 자료 보기/);assert.doesNotMatch(html,/평일 19만원/);
  f.store.update({selectedView:'regions'});html=view.render(f.data,f.store.getState(),f.state.companies);assert.match(html,/지역 요약 연결 전/);assert.doesNotMatch(html,/href="#regions=r2"/);
});
test('names and controlled source reasons are HTML escaped',()=>{
  const f=fixture();f.data.companies[0].name='<img onerror=x>';f.data.comparisons[0].reasons=[{reason:'<script>bad</script>'}];
  const html=view.render(f.data,f.store.getState(),f.state.companies);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);assert.doesNotMatch(html,/<script>|<img onerror/);
});
function harness({dashboard=false,storage=new Map()}={}){
  const f=fixture(),handlers={},slot={innerHTML:'',isConnected:true},status={textContent:''},timers=[];
  const context=vm.createContext({module:{exports:{}},...(dashboard?{require:specifier=>require('../web/'+specifier.replace('./','')),sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}}:{}),document:{querySelector:s=>s==='#comparison-results'?slot:s==='#comparison-status'?status:null,addEventListener:(n,fn)=>handlers[n]=fn},Date,URL,Promise,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}});
  vm.runInContext(fs.readFileSync(require.resolve('../web/comparison-view.js'),'utf8'),context);
  return {...f,ui:context.module.exports,handlers,slot,status,timers};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('saved normal data appears immediately and is retained while a newer saved-only calculation is pending',async()=>{
  const h=harness();let resolve;const pending=new Promise(r=>resolve=r);
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:()=>pending});assert.match(h.slot.innerHTML,/추정 예약률/);
  const preview=clone(h.data);preview.responseCache={preview:true,refreshing:true};preview.companies[0].summary.sold=999;resolve(preview);await flush();assert.doesNotMatch(h.slot.innerHTML,/예약 999/);assert.match(h.status.textContent,/계산 확인 중/);assert.equal(h.timers.length,1);
});
test('view changes during a pending refresh do not duplicate reads or suppress the final latest update',async()=>{
  const h=harness();let resolve,calls=0;const pending=new Promise(r=>resolve=r);
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:()=>{calls++;return pending;}});
  const button={dataset:{comparisonView:'products'},hasAttribute:()=>false};h.handlers.click({target:{closest:()=>button},preventDefault(){}});
  assert.equal(calls,1);assert.match(h.slot.innerHTML,/상품·가격 확인 범위/);
  const next=clone(h.data);next.companies[0].summary.knownRevenueSubtotal=76540000;resolve(next);await flush();assert.match(h.slot.innerHTML,/7,654만원/);assert.match(h.slot.innerHTML,/상품·가격 확인 범위/);
});
test('navigation and permission changes prevent late data and late authentication failures from altering the current page',async()=>{
  for(const permissionChange of [false,true]){
    const h=harness();let reject;const pending=new Promise((_,r)=>reject=r);let expired=0;
    h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:()=>pending,onSessionExpired:()=>expired++});
    if(permissionChange)h.store.configure({permissionSignature:'p2',authorizedComparisonIds:[]});else h.ui.stop();
    h.slot.innerHTML='current page';reject(Object.assign(Error('old'),{status:401}));await flush();assert.equal(h.slot.innerHTML,'current page');assert.equal(expired,0);
  }
});
test('temporary failures preserve saved results, but a current authorization failure removes them',async()=>{
  for(const status of [503,403]){
    const h=harness();h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:async()=>{throw Object.assign(Error('fixture'),{status});}});await flush();
    if(status===503){assert.match(h.slot.innerHTML,/추정 예약률/);assert.match(h.status.textContent,/이전 저장 자료/);}else{assert.doesNotMatch(h.slot.innerHTML,/추정 예약률/);assert.match(h.slot.innerHTML,/조회 권한/);}
  }
});
test('a transient failure can display a newer normal result completed by another reader even with no initial saved result',async()=>{
  const h=harness();let reject,saved=null;
  h.ui.mount({store:h.store,state:h.state,peek:()=>saved&&clone(saved),read:()=>new Promise((_,r)=>reject=r)});
  saved=clone(h.data);saved.companies[0].summary.sold=123;saved.companies[0].summary.reservationRate=123/saved.companies[0].summary.supply;
  reject(Object.assign(Error('old read'),{status:503}));await flush();assert.match(h.slot.innerHTML,/예약 123/);assert.match(h.status.textContent,/이전 저장 자료/);
});
test('a late preview does not replace a newer normal result completed by another reader',async()=>{
  const h=harness();let resolve,saved=clone(h.data);
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(saved),read:()=>new Promise(r=>resolve=r)});
  saved.companies[0].summary.sold=123;saved.companies[0].summary.reservationRate=123/saved.companies[0].summary.supply;
  const preview=clone(h.data);preview.responseCache={preview:true,refreshing:true};resolve(preview);await flush();assert.match(h.slot.innerHTML,/예약 123/);assert.match(h.status.textContent,/계산 확인 중/);
});

test('coupon inputs remain bound to the selection rendered on screen even when a newer request replaces its mutable token box',()=>{
  const f=fixture(),mounted=[],slot={innerHTML:'',isConnected:true},status={textContent:''};
  const context=vm.createContext({module:{exports:{}},window:{InsightCustomerOperatingActionsView:{render:()=>'<section>coupon fixture</section>',mount:options=>mounted.push(options),stop(){}},InsightComparisonReadinessView:{render:()=>''}},document:{querySelector:selector=>selector==='#comparison-results'?slot:selector==='#comparison-status'?status:null,addEventListener(){}},Date,URL,Promise,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(require.resolve('../web/comparison-view.js'),'utf8'),context);
  const options={store:f.store,state:f.state,peek:()=>clone(f.data),read:()=>new Promise(()=>{})};
  context.module.exports.mount(options);assert.equal(mounted.length,1);assert.equal(mounted[0].isCurrent(),true);
  f.store.update({comparisonIds:['same']});options.pendingToken={value:f.store.requestToken()};
  assert.equal(mounted[0].isCurrent(),false,'an old rendered coupon form cannot borrow the newer request token');
  context.module.exports.stop();
});

test('dashboard filters reproject the stored response without new reads or changes to the source period',async()=>{
  const h=harness({dashboard:true}),original=JSON.stringify(h.data);let reads=0;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:async()=>{reads++;return clone(h.data);}});await flush();
  const headings=['저장 자료에서 비교할 기간','선택 기간 한눈에 보기','먼저 검토할 판단','예약 수준과 날짜별 흐름','상세 근거'];
  for(let i=1;i<headings.length;i++)assert.ok(h.slot.innerHTML.indexOf(headings[i-1])<h.slot.innerHTML.indexOf(headings[i]));
  const target={value:'saturday',matches:()=>true,hasAttribute:()=>false};h.handlers.change({target});
  assert.match(h.slot.innerHTML,/선택 5일/);assert.equal(reads,1);assert.equal(h.store.getState().stayStart,h.data.period.start);assert.equal(JSON.stringify(h.data),original);
  const before=h.slot.innerHTML,invalid={value:'2020-01-01',matches:()=>true,hasAttribute:key=>key==='data-dashboard-start'};h.handlers.change({target:invalid});
  assert.equal(invalid.value,h.data.period.start);assert.equal(h.slot.innerHTML,before);assert.match(h.status.textContent,/이전 조건을 유지/);
  const reset={hasAttribute:key=>key==='data-dashboard-reset'};h.handlers.click({target:{closest:()=>reset},preventDefault(){}});
  assert.match(h.slot.innerHTML,/선택 30일/);assert.equal(reads,1);h.ui.stop();
});

test('a newer saved response preserves the active filter and refreshes the displayed quantities',async()=>{
  const h=harness({dashboard:true});let resolve;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.data),read:()=>new Promise(r=>resolve=r)});
  h.handlers.change({target:{value:'saturday',matches:()=>true,hasAttribute:()=>false}});
  const updated=clone(h.data);updated.generatedAt=new Date().toISOString();resolve(updated);await flush();
  assert.match(h.slot.innerHTML,/선택 5일/);assert.match(h.slot.innerHTML,/data-dashboard-day-filter/);h.ui.stop();
});
