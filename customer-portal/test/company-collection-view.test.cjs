'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve('../web/'+file),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function ui() {
  const elements=new Map(['#collection-allowance','#collection-progress','#collection-result','#collection-freshness','[data-collect] button[type=submit]'].map(k=>[k,{innerHTML:'',textContent:'',disabled:false,dataset:{ready:'true'},setAttribute(key,value){this[key]=value;}}]));
  const window={},context=vm.createContext({window,document:{querySelector:s=>elements.get(s)||null},setTimeout:()=>0,clearTimeout(){}});
  for(const file of ['company-flow.js','company-view.js','collection.js'])vm.runInContext(read(file),context);
  return {window,elements};
}
const quota=allowed=>({limit:1,canRequest:allowed,resetsAt:'2026-10-02T15:00:00Z'});

test('basic information remains visible with one animated connection indicator until stored reference data arrives',()=>{
  const {window:w}=ui();
  const pending={referenceLoading:true,result:null,companyDetail:{basics:{name:'기본정보 연결 업체',rooms:16},channels:[],current:{daily:[],summary:null}}};
  const html=w.InsightCompanyView.render(pending);
  assert.match(html,/기본정보 연결 업체/);assert.match(html,/16실/);
  assert.equal((html.match(/class="connection-spinner"/g)||[]).length,1);
  assert.match(html,/data-reference-status="products"/);assert.match(html,/저장된 예약채널 연결 중/);
  const failed=w.InsightCompanyView.render({...pending,referenceLoading:false,referenceError:true});
  assert.doesNotMatch(failed,/connection-spinner|0실/);assert.match(failed,/예약채널 연결 확인 필요/);
});
test('company detail has no collection tools; separate collection route retains range and quota checks',async()=>{
  const {window:w,elements}=ui(),company={companyId:'a',name:'가상 업체'};
  const detail=w.InsightCollection.panel(company,true,null,quota(true));
  assert.match(detail,/업체 자료 연결 중/);assert.match(detail,/aria-busy="true"/);
  assert.doesNotMatch(detail,/data-collect=|data-open-collection|저장 자료 다시 보기|COMPANY DATABASE|collection-settings/);
  assert.match(w.InsightCollection.panel(company,true,null,null,true),/type="submit"[^>]+disabled/);
  const panel=w.InsightCollection.panel(company,true,null,quota(true),true);
  assert.match(panel,/name="bookingRangeDays" value="30"/);assert.match(panel,/유무 확인/);assert.match(panel,/계정 전체 하루 1회/);
  let response={collectionAllowance:quota(false),request:null,result:null,companyDetail:null};
  w.InsightCollection.mount('a',async()=>response);await flush();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
  assert.match(elements.get('#collection-allowance').textContent,/1\/1회 사용/);
  response.collectionAllowance=quota(true);await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,false);
  response.request={status:'collecting',submittedAt:'2026-10-02T01:00:00Z'};await w.InsightCollection.refresh();
  assert.equal(elements.get('[data-collect] button[type=submit]').disabled,true);
});
test('connecting animation stops on success and never replaces a cached company result',async()=>{
  const {window:w,elements}=ui();let resolve;
  w.InsightCollection.mount('a',()=>new Promise(done=>resolve=done));
  assert.match(elements.get('#collection-result').innerHTML,/connection-spinner/);
  assert.equal(elements.get('#collection-result')['aria-busy'],'true');
  resolve({companyDetail:{basics:{name:'자료 연결 업체',rooms:16},channels:[],current:{daily:[],summary:null}},result:null});await flush();
  assert.match(elements.get('#collection-result').innerHTML,/자료 연결 업체/);
  assert.doesNotMatch(elements.get('#collection-result').innerHTML,/connection-spinner/);
  assert.equal(elements.get('#collection-result')['aria-busy'],'false');
  assert.equal(elements.get('#collection-freshness').hidden,true);
  w.InsightCollection.stop();w.InsightCollection.mount('a',()=>new Promise(()=>{}));
  assert.match(elements.get('#collection-result').innerHTML,/자료 연결 업체/);
  assert.doesNotMatch(elements.get('#collection-result').innerHTML,/connection-spinner/);
  assert.equal(elements.get('#collection-freshness').dataset.state,'checking');
  assert.equal(elements.get('#collection-freshness').hidden,false);
});
test('failed initial connection ends the animation and offers a retry, without pretending zero data',async()=>{
  const {window:w,elements}=ui();
  w.InsightCollection.mount('a',async()=>{throw Error('network');});await flush();
  assert.doesNotMatch(elements.get('#collection-result').innerHTML,/connection-spinner/);
  assert.equal(elements.get('#collection-result')['aria-busy'],'false');
  assert.match(elements.get('#collection-progress').innerHTML,/다시 확인/);
  assert.doesNotMatch(elements.get('#collection-result').innerHTML,/0실/);
});
test('A B C use compact basics and observed data without month, history or calendar controls',()=>{
  const {window:w}=ui();
  const data={result:{rooms:16,productCount:1,products:[{name:'객실 <A>',productType:'lodging',days:[{status:'observed',price:150000}]}],dayUse:{},quality:{status:'complete'}},companyDetail:{basics:{name:'가상 <업체>',rooms:16},channels:[],current:{summary:null,daily:[{date:'2026-10-01',total:16,publicBookings:0,phoneBookings:0,estimatedRevenue:0}]}}};
  const html=w.InsightCompanyView.render(data);
  for(const label of ['업체 기본정보','예약채널','통합관측','company-booking-chart','날짜별','가상 &lt;업체&gt;','객실 &lt;A&gt;','150,000원'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/data-company-month|통합 중|마지막 계산값|누적 이력|db-calendar|data-company-view|<polyline|<form/);
  assert.match(html,/0실/);assert.doesNotMatch(html,/가상 <업체>/);
});
test('unavailable integrated results are not replaced by the latest raw run or shown as zero',()=>{
  const {window:w}=ui();
  const data={result:{rooms:16,products:[],productCount:0,quality:{status:'partial',reason:'날짜 누락'}},companyDetail:{basics:{rooms:16},channels:[],legacyObservationView:false,integrated:{status:'pending',selectedMonth:'2026-09',snapshot:null,roomBasis:{count:16}},current:{daily:[{date:'2026-09-01',publicBookings:1,phoneBookings:2,estimatedRevenue:223456}],summary:{estimatedRevenue:223456}}}};
  const html=w.InsightCompanyView.render(data);
  assert.doesNotMatch(html,/db-current|223,456|통합 중|숙박월|마지막 계산값|0실/);
  assert.match(html,/업체 기본정보/);assert.match(html,/날짜 누락/);
  const missing=w.InsightCompanyView.render({companyDetail:{basics:{},channels:[],current:{daily:[{date:'2026-10-01',missing:true}],summary:null}}});
  assert.doesNotMatch(missing,/db-current|0실/);
});
