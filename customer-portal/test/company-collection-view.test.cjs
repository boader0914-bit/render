'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve('../web/'+file),'utf8');
function ui() {
  const elements=new Map(['#collection-allowance','#collection-progress','#collection-result','[data-collect] button[type=submit]'].map(k=>[k,{innerHTML:'',textContent:'',disabled:false,dataset:{ready:'true'},append(){}}]));
  const window={},context=vm.createContext({window,document:{querySelector:s=>elements.get(s)||null},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('company-view.js'),context);vm.runInContext(read('collection.js'),context);
  return {window,elements};
}
const quota=allowed=>({limit:1,canRequest:allowed,resetsAt:'2026-10-02T15:00:00Z'});
test('collection view waits for allowance, keeps the fixed range and disables another submission after server refresh',async()=>{
  const {window:w,elements}=ui();
  assert.match(w.InsightCollection.panel({companyId:'a',name:'가상 업체'},true,null,null),/type="submit"[^>]+disabled/);
  const panel=w.InsightCollection.panel({companyId:'a',name:'가상 업체'},true,null,quota(true));
  assert.match(panel,/name="bookingRangeDays" value="30"/);assert.match(panel,/유무 확인/);assert.match(panel,/계정 전체 하루 1회/);
  let response={collectionAllowance:quota(false),request:null,result:null,companyDetail:null};
  w.InsightCollection.mount('a',async()=>response);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
  assert.match(elements.get('#collection-allowance').textContent,/1\/1회 사용/);
  response.collectionAllowance=quota(true);await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,false);
  response.request={status:'collecting',submittedAt:'2026-10-02T01:00:00Z'};await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
});
test('A-D view preserves quality warnings and distinguishes unknown from observed zero',()=>{
  const {window:w}=ui();
  const r={rooms:null,roomCountSource:'확인 전',productCount:0,range:{start:'2026-10-02',end:'2026-10-31',days:30},dayUse:{},days:[],issues:[],quality:{status:'partial',reason:'날짜 누락'},truncated:true};
  const detail={basics:{name:'가상 <업체>',lodgingTypes:[]},channels:[],current:{summary:null,daily:[{date:'2026-10-02',publicBookings:0,phoneBookings:null,estimatedRevenue:null,partial:true}]},history:{leadTime:{},ranks:[],performance:[],months:[]}};
  const html=w.InsightCompanyView.render({result:r,companyDetail:detail,previousResult:true},'');
  for(const label of ['업체 기본정보','예약 채널','최근 운영 관측','누적 이력·관리','이번 요청의 완료 결과가 아닙니다','일부 완료','날짜 누락','보존된 상품 목록','공개 0실','방막기 확인 전','산출 보류'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/확인 전실|가상 <업체>/);assert.match(html,/가상 &lt;업체&gt;/);
});

test('view switches are local, persist the preference and preserve an open correction form; opening collection settings does not submit',async()=>{
  const events={},storage=new Map(),elements=new Map(),modes=[],apiCalls=[];
  for(const id of ['#collection-progress','#collection-result','#company-current-view','#company-history-flow','#company-flow-details','#collection-settings'])elements.set(id,{innerHTML:'',hidden:true});
  const correction={value:'작성 중인 검수 근거'};elements.set('#product-correction',correction);
  const buttons=['default','graph','calendar','table'].map(mode=>({dataset:{companyView:mode},setAttribute(k,v){this[k]=v;}}));
  const window={InsightCompanyView:{render:(_,__,o)=>{modes.push(o.mode);return 'ABCD';},currentView:(_,o)=>o.mode,flowView:()=>'<graph>'}};
  const context=vm.createContext({window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{addEventListener:(type,fn)=>events[type]=fn,querySelector:s=>elements.get(s),querySelectorAll:()=>buttons},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('collection.js'),context);
  window.InsightCollection.mount('cmp_1',async path=>{apiCalls.push(path);return {companyDetail:{},result:null};});
  await new Promise(r=>setImmediate(r));assert.equal(modes.at(-1),'default');
  for(const mode of ['graph','calendar','table']){
    events.click({target:{closest:s=>s==='[data-company-view]'?buttons.find(b=>b.dataset.companyView===mode):null}});
    assert.equal(elements.get('#company-current-view').innerHTML,mode);assert.equal(storage.get('insight-company-view'),mode);
    assert.equal(correction.value,'작성 중인 검수 근거');
  }
  const trigger={setAttribute(k,v){this[k]=v;}};
  events.click({target:{closest:s=>s==='[data-open-collection]'?trigger:null}});
  assert.equal(elements.get('#collection-settings').hidden,false);assert.equal(trigger['aria-expanded'],'true');
  assert.equal(apiCalls.length,1,'mode changes and collection settings do not issue network requests');
  window.InsightCollection.mount('cmp_2',async path=>{apiCalls.push(path);return {};});await new Promise(r=>setImmediate(r));assert.equal(modes.at(-1),'table');
  assert.deepEqual(apiCalls,['/companies/cmp_1/collection','/companies/cmp_2/collection']);
});

test('shared month selector reads the selected month and ignores an older in-flight response',async()=>{
  const events={},elements=new Map(),calls=[],resolvers=[];
  for(const key of ['#collection-progress','#collection-result'])elements.set(key,{innerHTML:''});
  const window={InsightCompanyView:{render:data=>data.companyDetail?.integrated?.selectedMonth||'loading'}};
  const context=vm.createContext({window,document:{addEventListener:(type,fn)=>events[type]=fn,querySelector:key=>elements.get(key)||null},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('collection.js'),context);
  window.InsightCollection.mount('cmp_one',path=>{calls.push(path);return new Promise(resolve=>resolvers.push(resolve));});
  events.change({target:{value:'2026-09',matches:selector=>selector==='[data-company-month]'}});
  assert.deepEqual(calls,['/companies/cmp_one/collection','/companies/cmp_one/collection?month=2026-09']);
  resolvers[1]({companyDetail:{integrated:{selectedMonth:'2026-09',status:'ready'}}});await new Promise(resolve=>setImmediate(resolve));
  resolvers[0]({companyDetail:{integrated:{selectedMonth:'2026-10',status:'ready'}}});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('#collection-result').innerHTML,'2026-09');
});

test('pending integration is explicit, never computes month totals from the latest raw result',()=>{
  const {window:w}=ui();
  const raw={rooms:16,roomCountSource:'DB 검수',productCount:0,range:{days:1},dayUse:{},issues:[],days:[{date:'2026-09-01',productType:'lodging',publicRevenue:123456,estimatedRevenue:100000,publicBookings:1,estimatedBlocked:1,total:16}]};
  const detail={basics:{},channels:[],current:{summary:null,daily:[]},legacyObservationView:false,integrated:{status:'pending',months:[{month:'2026-09'}],selectedMonth:'2026-09',snapshot:null},history:{leadTime:{},ranks:[],performance:[],months:[]}};
  const html=w.InsightCompanyView.render({result:raw,companyDetail:detail},'');
  assert.match(html,/조회할 숙박월/);assert.match(html,/통합 준비 중/);assert.match(html,/산출 보류/);assert.doesNotMatch(html,/223,456|123,456/);
  const legacy=w.InsightCompanyView.render({result:raw},'');assert.match(legacy,/월별 통합 자료 연결 전/);assert.doesNotMatch(legacy,/223,456/);
});

test('calendar hides normal zero inferred bookings but shows freshness and excluded latest responses',()=>{
  const {window:w}=ui();
  const html=w.InsightCompanyView.currentView({companyDetail:{current:{daily:[{date:'2026-09-01',total:16,publicBookings:0,phoneBookings:0,estimatedRevenue:0,observationLeadTimeDays:2,latestAttemptStatus:'excluded'}]}}},{mode:'calendar'});
  assert.match(html,/공개 0실/);assert.doesNotMatch(html,/방막기 0실/);assert.match(html,/숙박 2일 전 관측/);assert.match(html,/최근 응답 제외/);
});

test('complete quantities with prior observations show freshness guidance instead of a quantity warning',()=>{
  const {window:w}=ui();
  const data={companyDetail:{basics:{},channels:[],current:{summary:{rangeStart:'2026-08-01',rangeEnd:'2026-08-31',observedDays:31,calendarDays:31,partial:true,missingDays:0,staleDays:29,quantityPartial:false},daily:[]}}};
  let html=w.InsightCompanyView.render(data,'');
  assert.match(html,/숙박일 이전 마지막 관측 포함/);assert.doesNotMatch(html,/수량 확인이 필요한 날짜/);
  delete data.companyDetail.current.summary.quantityPartial;
  html=w.InsightCompanyView.render(data,'');assert.match(html,/숙박일 이전 마지막 관측 포함/);
  data.companyDetail.current.summary.missingDays=1;data.companyDetail.current.summary.observedDays=30;
  html=w.InsightCompanyView.render(data,'');assert.match(html,/수량 확인이 필요한 날짜/);
  Object.assign(data.companyDetail.current.summary,{missingDays:0,staleDays:0,containsPartialRun:true});
  html=w.InsightCompanyView.render(data,'');assert.match(html,/일부 완료 회차에서 확보한 정상 수량 포함/);assert.doesNotMatch(html,/수량 확인이 필요한 날짜/);
});
