'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const {createConnectedServer}=require('../connected-server.cjs');
const reports=require('../web/period-report.js');
const read=name=>fs.readFileSync(require.resolve('../web/'+name),'utf8');
function ui(){const window={},context=vm.createContext({window,URL});for(const file of ['company-flow.js','company-products.js','company-adjustment.js','company-view.js'])vm.runInContext(read(file),context);return window.InsightCompanyView;}
function fixture(){
  const daily=[{date:'2026-09-01',total:16,sold:3,publicBookings:1,phoneBookings:2,publicRevenue:100000,phoneRevenue:200000,estimatedRevenue:300000,reservationRate:3/16,collectedAt:'2026-08-30T05:00:00Z',observationLeadTimeDays:2,latestAttemptStatus:'excluded'}];
  const summary={rangeStart:'2026-09-01',rangeEnd:'2026-09-30',calendarDays:30,observedDays:1,missingDays:29,revenueObservedDays:1,publicBookings:1,phoneBookings:2,sold:3,supply:16,publicRevenue:100000,phoneRevenue:200000,estimatedRevenue:300000,reservationRate:3/16,quantityPartial:true,staleDays:1};
  const integrated={status:'ready',selectedMonth:'2026-09',months:[{month:'2026-09'},{month:'2026-08'}],roomBasis:{count:16,source:'db_review'},snapshot:{summary,daily,analysis:{pace:[],weekdays:[],pickup:{intervals:[]},pricing:{estimatedPerSoldUnit:100000}}}};
  return {companyDetail:{basics:{rooms:16,name:'모의 업체'},channels:[],legacyObservationView:false,integrated,current:{summary,daily},history:{months:[{month:'2026-09',summary,daily}],ranks:[],performance:[],leadTime:{}}}};
}
test('integrated monthly source preserves the production booking chart, revenue calendar and locked own editor',()=>{
  const data=fixture(),before=JSON.stringify(data),view=ui(),html=view.render(data,'',{own:true});
  assert.match(html,/조회할 숙박월/);assert.match(html,/option value="2026-09" selected/);assert.match(html,/월별 통합 관측/);
  assert.match(html,/data-chart-metric="rate"/);assert.doesNotMatch(html,/data-chart-metric="revenue"/);
  assert.match(html,/company-month-calendar/);assert.match(html,/disabled>수정 준비 중/);assert.match(html,/DB 검수값/);
  assert.match(view.dayDetail(data,{day:'2026-09-01'}),/숙박 2일 전 관측 · 최근 응답 제외|숙박 2일 전 관측/);
  assert.equal(JSON.stringify(data),before);
});
test('pending integration never substitutes the latest raw collection and normal missing state stays explicit',()=>{
  const data=fixture();data.companyDetail.integrated.status='pending';data.companyDetail.integrated.snapshot=null;data.companyDetail.current={summary:null,daily:[]};
  data.result={rooms:16,products:[],productCount:0,issues:[],dayUse:{},days:[{date:'2026-09-01',productType:'lodging',estimatedRevenue:999999}],range:{days:1}};
  const view=ui(),html=view.render(data,'');assert.match(html,/통합 준비 중/);assert.doesNotMatch(html,/999,999|99.9만원/);
  assert.equal(view.current({result:data.result}).summary,null);assert.equal(view.current({result:data.result}).daily.length,0);
});
test('freshness is separate from incomplete quantities in the monthly screen',()=>{
  const data=fixture(),s=data.companyDetail.current.summary;Object.assign(s,{quantityPartial:false,missingDays:0,staleDays:29,partial:true});
  assert.match(ui().render(data,''),/숙박일 이전 마지막 관측 포함/);assert.doesNotMatch(ui().render(data,''),/수량 확인이 필요한 날짜가 있습니다/);
  s.missingDays=1;assert.match(ui().render(data,''),/수량 확인이 필요한 날짜가 있습니다/);
});
test('monthly report and revenue table use exact shared month totals instead of recomputing the source',()=>{
  const data=fixture(),s=data.companyDetail.current.summary;Object.assign(s,{estimatedRevenue:505000,publicRevenue:100000,phoneRevenue:405000});
  const before=JSON.stringify(data),period=reports.range('monthly','2026-09','2026-10-10');
  const report=reports.build([{companyId:'cmp_one',kind:'own',detail:data.companyDetail}],period,{ownId:'cmp_one'});
  assert.equal(report.companies[0].summary.estimatedRevenue,505000);assert.equal(report.companies[0].summary.source,'company_db_integrated');
  const table=ui().currentView(data,{mode:'table'});assert.match(table,/<tfoot>[\s\S]*월간 통합값[\s\S]*50.5만원/);
  s.estimatedRevenue=null;assert.match(ui().currentView(data,{mode:'table'}),/<tfoot>[\s\S]*<td>미확인<\/td>/);s.estimatedRevenue=505000;
  assert.equal(JSON.stringify(data),before);
});
test('month selection requests the shared month, preserves revenue mode and discards older responses',async()=>{
  const events={},elements=new Map(),calls=[],pending=[],options=[];
  for(const key of ['#collection-progress','#collection-result'])elements.set(key,{innerHTML:''});
  const window={InsightCompanyView:{render:(data,_,o)=>{options.push({...o});return data.companyDetail.integrated.selectedMonth;}}};
  const context=vm.createContext({window,document:{addEventListener:(type,fn)=>events[type]=fn,querySelector:key=>elements.get(key)||null},localStorage:{getItem:()=> 'table'},setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(read('collection.js'),context);window.InsightCollection.mount('cmp_one',path=>{calls.push(path);return new Promise(resolve=>pending.push(resolve));},{kind:'own'});
  events.change({target:{value:'2026-09',matches:s=>s==='[data-company-month]'}});
  assert.deepEqual(calls,['/companies/cmp_one/collection','/companies/cmp_one/collection?month=2026-09']);
  pending[1](fixture());await new Promise(r=>setImmediate(r));const older=fixture();older.companyDetail.integrated.selectedMonth='2026-10';pending[0](older);await new Promise(r=>setImmediate(r));
  assert.equal(elements.get('#collection-result').innerHTML,'2026-09');assert.equal(options.at(-1).mode,'table');assert.equal(options.at(-1).own,true);assert.equal(options.at(-1).calendarMonth,'2026-09');
  elements.set('#collection-result form[data-dirty]',{});const change={value:'2026-08',matches:s=>s==='[data-company-month]'};events.change({target:change});
  assert.equal(change.value,'2026-09');assert.equal(calls.length,2);assert.match(elements.get('#collection-progress').innerHTML,/작성 중인 수정 요청을 유지/);
});
test('existing BFF forwards month unchanged for both customer and administrator views',async t=>{
  const urls=[],data=fixture();const server=createConnectedServer({origin:'http://127.0.0.1:57997',backend:'https://example.test',serviceToken:'test-only-'.repeat(4),fetchImpl:async url=>{urls.push(url);return {ok:true,status:200,json:async()=>data};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  for(const prefix of ['/api/customer/v1','/api/insight-admin/v1/customer-view']){
    const response=await new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}${prefix}/companies/cmp_one/collection?month=2026-09`,{headers:{Host:'127.0.0.1:57997'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));}).on('error',reject));
    assert.equal(response.status,200);assert.equal(response.data.companyDetail.integrated.selectedMonth,'2026-09');
  }
  assert.equal(urls.length,2);assert.ok(urls.every(url=>url.endsWith('/companies/cmp_one/collection?month=2026-09')));
});
test('historical period report explicitly reads each requested month including a cross-month week',async()=>{
  const handlers={},calls=[],slot={isConnected:true,innerHTML:''},button={isConnected:true},form={querySelector:()=>button};
  const params={reportType:'weekly',weekStart:'2026-09-29',ownId:'cmp_one'},window={InsightPeriodReport:reports};
  const context=vm.createContext({window,document:{addEventListener:(name,fn)=>handlers[name]=fn,querySelector:s=>s==='#analysis-output'?slot:s==='#analysis-form'?form:null},FormData:class{constructor(){return Object.entries(params);}}});
  vm.runInContext(read('analysis.js'),context);
  window.InsightAnalysis.mount('reports',async path=>{calls.push(path);return fixture();},{customer:{relations:[{companyId:'cmp_one',kind:'own',status:'active'}]},companies:[{companyId:'cmp_one',name:'모의 업체'}],regions:[]});
  await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['/companies/cmp_one/collection?month=2026-09','/companies/cmp_one/collection?month=2026-10']);assert.match(slot.innerHTML,/주간 리포트/);
});
