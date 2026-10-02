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
