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
  for(const label of ['객실·상품','예약 채널','최근 운영 관측','누적 이력·관리','이번 요청의 완료 결과가 아닙니다','일부 완료','날짜 누락','보존된 상품 목록','네이버 미확인','타채널·전화 미확인','미확인'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/확인 전실|가상 <업체>/);assert.match(html,/가상 &lt;업체&gt;/);
});
test('calendar highlights only confirmed positive blocked estimates and preserves totals and unknown days',()=>{
  const {window:w}=ui(),daily=Object.freeze([
    {date:'2026-10-01',total:16,publicBookings:0,phoneBookings:0,phoneRevenue:0,estimatedRevenue:0},
    {date:'2026-10-02',total:16,publicBookings:1,phoneBookings:2,phoneRevenue:400000,estimatedRevenue:600000},
    {date:'2026-10-03',phoneBookings:0,partial:true},
    {date:'2026-10-04',phoneBookings:4,inventoryConflict:true},
    {date:'2026-10-05',phoneBookings:2,phoneRevenue:null,revenuePartial:true},
    {date:'2026-10-06',phoneBookings:0,missing:true},
  ].map(Object.freeze)),before=JSON.stringify(daily);
  const html=w.InsightCompanyView.currentView({companyDetail:{current:{daily}}},{mode:'calendar'});
  assert.equal((html.match(/has-estimate/g)||[]).length,2);
  assert.match(html,/타채널·전화 2실 · 40만원/);assert.match(html,/<b>3실<\/b>/);assert.match(html,/<b>60만원<\/b>/);
  assert.doesNotMatch(html,/방막기 0실|방막기 4실|방막기 매출 0만원/);
  assert.match(html,/네이버 0실/);assert.match(html,/<b>0만원<\/b>/);assert.match(html,/타채널·전화 미확인/);assert.match(html,/타채널·전화 2실 · 미확인/);assert.match(html,/예약 미확인/);
  assert.equal(JSON.stringify(daily),before);
});

test('view switches are local, persist the preference and preserve an open correction form; opening collection settings does not submit',async()=>{
  const events={},storage=new Map(),elements=new Map(),modes=[],apiCalls=[];
  for(const id of ['#collection-progress','#collection-result','#company-current-view','#company-history-flow','#company-current-summary','#company-flow-details','#collection-settings'])elements.set(id,{innerHTML:'',hidden:true});
  const correction={value:'작성 중인 검수 근거'};elements.set('#product-correction',correction);
  const buttons=['default','graph','calendar','table'].map(mode=>({dataset:{companyView:mode},setAttribute(k,v){this[k]=v;}}));
  const window={InsightCompanyView:{render:(_,__,o)=>{modes.push(o.mode);return 'ABCD';},currentView:(_,o)=>o.mode,summaryView:(_,o)=>o.day||'today',flowView:()=>'<graph>'}};
  const context=vm.createContext({window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},document:{addEventListener:(type,fn)=>events[type]=fn,querySelector:s=>elements.get(s),querySelectorAll:()=>buttons},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('collection.js'),context);
  window.InsightCollection.mount('cmp_1',async path=>{apiCalls.push(path);return {companyDetail:{},result:null};});
  await new Promise(r=>setImmediate(r));assert.equal(modes.at(-1),'default');
  for(const mode of ['graph','calendar','table']){
    events.click({target:{closest:s=>s==='[data-company-view]'?buttons.find(b=>b.dataset.companyView===mode):null}});
    assert.equal(elements.get('#company-current-view').innerHTML,mode);assert.equal(storage.get('insight-company-view'),mode);
    assert.equal(correction.value,'작성 중인 검수 근거');
  }
  events.click({target:{closest:s=>s==='[data-company-date]'?{dataset:{companyDate:'2026-10-09'}}:null}});
  assert.equal(elements.get('#company-current-summary').innerHTML,'2026-10-09');
  events.change({target:{matches:s=>s==='[data-company-day]',value:'2026-10-10'}});
  assert.equal(elements.get('#company-current-summary').innerHTML,'2026-10-10');
  events.click({target:{closest:s=>s==='[data-company-period]'?{}:null}});
  assert.equal(elements.get('#company-current-summary').innerHTML,'period');
  const trigger={setAttribute(k,v){this[k]=v;}};
  events.click({target:{closest:s=>s==='[data-open-collection]'?trigger:null}});
  assert.equal(elements.get('#collection-settings').hidden,false);assert.equal(trigger['aria-expanded'],'true');
  assert.equal(apiCalls.length,1,'mode changes and collection settings do not issue network requests');
  window.InsightCollection.mount('cmp_2',async path=>{apiCalls.push(path);return {};});await new Promise(r=>setImmediate(r));assert.equal(modes.at(-1),'table');
  assert.deepEqual(apiCalls,['/companies/cmp_1/collection','/companies/cmp_2/collection']);
});

test('selected day and period summary show total plus components without double counting or source mutation',()=>{
  const {window:w}=ui(),day=Object.freeze({date:'2026-10-09',total:16,publicBookings:5,phoneBookings:11,publicRevenue:1515000,phoneRevenue:3389000,estimatedRevenue:4904000}),summary=Object.freeze({rangeStart:'2026-10-09',rangeEnd:'2026-10-10',publicBookings:20,phoneBookings:12,publicRevenue:6100000,phoneRevenue:3708000,estimatedRevenue:9808000}),data={companyDetail:{basics:{rooms:16},current:{daily:[day],summary}}},before=JSON.stringify(data);
  const html=w.InsightCompanyView.summaryView(data,{day:'2026-10-09'});
  for(const value of ['선택일 추정 예약·매출','16실','490.4만원','5실','11실','151.5만원','338.9만원'])assert.match(html,new RegExp(value));
  assert.doesNotMatch(html,/27실|829.3만원|전화예약 확인|검증/);
  const period=w.InsightCompanyView.summaryView(data,{day:'period'});assert.match(period,/기간 추정 예약·매출/);assert.match(period,/32실/);assert.match(period,/980.8만원/);
  const absent=w.InsightCompanyView.summaryView(data,{day:'2026-10-10'});assert.match(absent,/미확인/);assert.doesNotMatch(absent,/490.4만원|0실/);
  assert.equal(JSON.stringify(data),before);
});

test('inventory conflicts and failed observations cannot become normal values when switching to table or summary',()=>{
  const {window:w}=ui();
  for(const issue of [{inventoryConflict:true},{partial:true},{missing:true}]){
    const d={date:'2026-10-04',total:16,publicBookings:5,phoneBookings:20,estimatedRevenue:5000000,publicRevenue:1000000,phoneRevenue:4000000,reservationRate:1.56,...issue};
    const data={companyDetail:{basics:{rooms:16},current:{daily:[d]}}};
    for(const html of [w.InsightCompanyView.currentView(data,{mode:'table'}),w.InsightCompanyView.summaryView(data,{day:d.date})]){
      assert.doesNotMatch(html,/500만원|400만원|156\.0%|>관측<|20실/);assert.match(html,/미확인/);
    }
  }
});
