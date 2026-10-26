'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function ui() {
  const handlers={},window={},slot={innerHTML:'',isConnected:true},button={disabled:false,isConnected:true},select={value:'r0'};
  const form={params:{regionKey:'r0',month:'2026-09'},querySelector:()=>button};
  const context=vm.createContext({window,document:{addEventListener:(name,fn)=>handlers[name]=fn,querySelector:s=>({'#analysis-output':slot,'#analysis-form':form,'#analysis-form select':select}[s])},FormData:class{constructor(f){return Object.entries({...f.params,regionKey:select.value});}}});
  vm.runInContext(fs.readFileSync(require.resolve('../web/analysis.js'),'utf8'),context);
  return {view:window.InsightAnalysis,handlers,slot,button,select};
}
const region=(id='r0',label='지역 예시')=>({region:{id,label},month:'2026-09',availableSources:1,sources:[{label:'방문 지표',provider:'출처',period:'2026-09',status:'ready',rows:[{label:'정상 0',value:0,unit:'명'},{label:'누락',value:null,unit:'명'}]}],warnings:[]});
function state(){return {customer:{relations:[{companyId:'competitor',kind:'competitor',status:'active'},{companyId:'own',kind:'own',status:'active'}]},companies:[{companyId:'competitor',name:'경쟁업체',regionKey:'r0'},{companyId:'own',name:'내 매장',regionKey:'r1'}],regions:[{id:'r0',label:'관심지역'},{id:'r1',label:'내 매장 소재지'}]};}

for(const relationStatus of ['active','pending'])test(`${relationStatus} own-company region is selected before the first request regardless of catalog ordering`,async()=>{
  const {view,select}=ui(),s=state(),calls=[];s.customer.relations.find(r=>r.kind==='own').status=relationStatus;
  const html=view.panel('regions',s);
  assert.match(html,/<option value="r1" selected>/);assert.doesNotMatch(html,/<option value="r0" selected>/);
  view.mount('regions',async url=>{calls.push(url);return region('r1');},s);
  assert.equal(select.value,'r1');assert.equal(calls.length,1);assert.match(calls[0],/\/regions\/r1\/analysis\?/);
});

test('an allowed explicit region link takes precedence over the own-company default',()=>{
  const {view,select}=ui(),s=state(),calls=[];
  assert.match(view.panel('regions',s,'r0'),/<option value="r0" selected>/);
  view.mount('regions',async url=>{calls.push(url);return region('r0');},s,'r0');
  assert.equal(select.value,'r0');assert.equal(calls.length,1);assert.match(calls[0],/\/regions\/r0\/analysis\?/);
});

test('a selected registered own company determines the region while the first registration remains the fallback',()=>{
  const s=state();s.customer.relations.push({companyId:'own-second',kind:'own',status:'active'});s.companies.unshift({companyId:'own-second',name:'두번째 내 매장',regionKey:'r2'});s.regions.unshift({id:'r2',label:'두번째 매장 소재지'});
  for(const [selectedOwnId,expected] of [[null,'r1'],['own-second','r2'],['competitor','r1'],['unknown-company','r1']]){
    const {view,select}=ui(),calls=[];
    assert.match(view.panel('regions',s,null,selectedOwnId),new RegExp('<option value="'+expected+'" selected>'));
    view.mount('regions',async url=>{calls.push(url);return region(expected);},s,null,selectedOwnId);
    assert.equal(select.value,expected);assert.equal(calls.length,1);assert.ok(calls[0].includes('/regions/'+expected+'/analysis?'));
  }
});

test('an own-company region outside the permitted catalog shows connection status without selecting another interest region',()=>{
  const {view,slot,select,button,handlers}=ui(),s=state(),calls=[];s.regions=s.regions.filter(r=>r.id!=='r1');
  const html=view.panel('regions',s);
  assert.match(html,/value="" selected disabled/);assert.match(html,/내 매장 소재지가 분석 가능 지역에 연결되지 않았습니다/);
  assert.doesNotMatch(html,/<option value="r0" selected>/);
  view.mount('regions',async url=>{calls.push(url);return region('r0');},s);
  assert.equal(select.value,'');assert.equal(button.disabled,true);assert.equal(calls.length,0);
  assert.match(slot.innerHTML,/내 매장 소재지가 분석 가능 지역에 연결되지 않았습니다/);
  select.value='r0';handlers.change({target:{closest:()=>true}});
  assert.equal(calls.length,1,'the customer may explicitly choose an available interest region');assert.match(calls[0],/\/regions\/r0\/analysis\?/);
});

for(const invalid of ['not-registered',''])test(`an unavailable explicit region ${JSON.stringify(invalid)} never requests a different default region`,()=>{
  const {view,slot,select,button}=ui(),s=state(),calls=[];
  view.mount('regions',async url=>{calls.push(url);return region();},s,invalid);
  assert.equal(select.value,'');assert.equal(button.disabled,true);assert.equal(calls.length,0);
  assert.match(slot.innerHTML,/등록한 지역의 자료를 찾을 수 없습니다/);
  assert.doesNotMatch(view.panel('regions',s,invalid),/<option value="r[01]" selected>/);
});

test('missing own-company data or region mapping remains unconfirmed rather than inferred from an address',()=>{
  for(const missingCompany of [false,true]){
    const {view,slot,select}=ui(),s=state(),calls=[];
    if(missingCompany)s.companies=s.companies.filter(c=>c.companyId!=='own');
    else{s.companies.find(c=>c.companyId==='own').regionKey=null;s.companies.find(c=>c.companyId==='own').address='관심지역 주소';}
    view.mount('regions',async url=>{calls.push(url);return region();},s);
    assert.equal(select.value,'');assert.equal(calls.length,0);assert.match(slot.innerHTML,/매장 기본자료|시군구 연결이 필요합니다/);
  }
});

test('an explicit permitted region still opens when the own-company mapping needs attention',()=>{
  const {view,select}=ui(),s=state(),calls=[];s.companies.find(c=>c.companyId==='own').regionKey='not-connected';
  view.mount('regions',async url=>{calls.push(url);return region();},s,'r0');
  assert.equal(select.value,'r0');assert.equal(calls.length,1);assert.match(calls[0],/\/regions\/r0\/analysis\?/);
});

test('an unlinked first own company does not silently switch to another registered property region',()=>{
  const {view,select,slot}=ui(),s=state(),calls=[];
  s.companies.find(c=>c.companyId==='own').regionKey='not-connected';
  s.customer.relations.push({companyId:'own-second',kind:'own',status:'active'});s.companies.push({companyId:'own-second',name:'두번째 매장',regionKey:'r1'});
  view.mount('regions',async url=>{calls.push(url);return region();},s);
  assert.equal(select.value,'');assert.equal(calls.length,0);assert.match(slot.innerHTML,/연결되지 않았습니다/);
});

test('a blocked explicit region selection also suppresses a previous permitted region response',async()=>{
  const {view,slot}=ui(),s=state(),pending=[];
  view.mount('regions',url=>new Promise(resolve=>pending.push({url,resolve})),s);
  assert.equal(pending.length,1);assert.match(pending[0].url,/\/regions\/r1\/analysis\?/);
  view.mount('regions',()=>{throw Error('must not request a blocked selection');},s,'not-registered');
  pending[0].resolve(region('r1','이전 지역 응답'));await new Promise(resolve=>setImmediate(resolve));
  assert.match(slot.innerHTML,/등록한 지역의 자료를 찾을 수 없습니다/);assert.doesNotMatch(slot.innerHTML,/이전 지역 응답/);
});

test('without a registered own company, a permitted interest region is used without inspecting competitor addresses',()=>{
  const {view,select}=ui(),s=state(),calls=[];s.customer.relations=s.customer.relations.filter(r=>r.kind==='competitor');s.companies.find(c=>c.companyId==='competitor').regionKey='r1';
  view.mount('regions',async url=>{calls.push(url);return region();},s);
  assert.equal(select.value,'r0');assert.equal(calls.length,1);assert.match(calls[0],/\/regions\/r0\/analysis\?/);
});

test('no permitted region leaves a clear registration state without making a request',()=>{
  const {view,slot,select,button}=ui(),s=state(),calls=[];s.customer.relations=[];s.regions=[];
  view.mount('regions',async url=>{calls.push(url);return region();},s);
  assert.equal(calls.length,0);assert.equal(select.value,'');assert.equal(button.disabled,true);assert.match(slot.innerHTML,/관심지역을 등록하면/);
});

test('regional view distinguishes zero from missing data and escapes source labels',()=>{
  const {view}=ui();const r=region('r0','<img src=x onerror=alert(1)>');
  const html=view.regionView(r);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);
  assert.match(html,/정상 0<\/th><td>0<\/td>/);assert.match(html,/누락<\/th><td>미확인<\/td>/);
  assert.match(html,/2026-09/);assert.match(html,/자료가 없습니다|저장|확인/);
});
test('briefing routes to the exact region and separates absent figures and unpublished actions',()=>{
  const {view}=ui();const report={period:{start:'2026-10-02',end:'2026-10-31'},companies:[{companyId:'own',kind:'own',name:'예시 매장',rooms:16,summary:{days:0,reservationRate:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}}],comparisons:[],regions:[region('region-b')],actions:[{title:'자료 확인',reason:'관측 없음',next:'범위 확인',check:'유효 관측일',source:'업체DB'}],definitions:[]};
  const html=view.reportView(report);
  assert.match(html,/href="#regions=region-b"/);assert.match(html,/브리핑 · 미발행/);assert.match(html,/산출 보류/);assert.match(html,/유효 관측일/);assert.doesNotMatch(html,/0원/);
});
test('changing region suppresses old responses and maintains requested region selection',async()=>{
  const {view,handlers,slot,select,button}=ui(),pending=[];
  view.mount('regions',url=>new Promise(resolve=>pending.push({url,resolve})),{regions:[{id:'r0'},{id:'r1'}]},'r1');
  assert.equal(select.value,'r1');assert.match(pending[0].url,/regions\/r1/);
  select.value='r0';handlers.change({target:{closest:()=>true}});
  pending[1].resolve(region('r0','새 지역'));await new Promise(r=>setImmediate(r));
  pending[0].resolve(region('r1','이전 지역'));await new Promise(r=>setImmediate(r));
  assert.match(slot.innerHTML,/새 지역/);assert.doesNotMatch(slot.innerHTML,/이전 지역/);assert.equal(button.disabled,false);
  handlers.change({target:{closest:()=>true}});view.stop();slot.isConnected=false;
  pending[2].resolve(region('r0','이탈 후 응답'));await new Promise(r=>setImmediate(r));
  assert.doesNotMatch(slot.innerHTML,/이탈 후 응답/);
});
