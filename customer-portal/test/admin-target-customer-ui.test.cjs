'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=name=>fs.readFileSync(require.resolve('../web/'+name),'utf8'),flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const roster=[{customerId:'cus_alpha',username:'alpha<svg>',projectName:'내 매장',accountStatus:'active',businessStatus:'owned',relations:[]},{customerId:'cus_beta',username:'beta',projectName:'다른 매장',accountStatus:'active',relations:[]},{customerId:'cus_privateadmin',username:'private-admin',accountKind:'admin_preview',accountStatus:'active',relations:[]},{customerId:'cus_disabled',username:'inactive-user',accountStatus:'disabled',relations:[]}];
function account(id='cus_alpha',target=true){return{customer:{customerId:id,username:'alpha<svg>',revision:1,settings:{},regions:[],relations:[{companyId:'cmp_own',kind:'own',status:'active'},{companyId:'cmp_comp',kind:'competitor',status:'active'}],entitlements:{competitorLimit:3,interestRegionLimit:1}},companies:[{companyId:'cmp_own',name:'내 업체',rooms:10},{companyId:'cmp_comp',name:'경쟁 업체',rooms:20}],regions:[],corrections:[],preparations:[],features:{directCollection:true,recurringCollectionRequests:true},csrfToken:'fixture_csrf',...(target?{view:{mode:'admin_customer',readOnly:true,customerId:id,customerUsername:'alpha<svg>',adminUsername:'admin'}}:{})};}
async function harness({url='https://insight.example/customer-view?customerId=cus_alpha&ownCompanyId=old&stayMode=month&briefingMonth=2026-09#competitors',early=false,state=account(),meError=null,rosterError=false}={}){
 const calls=[],events={},elements=new Map(),assigned=[],scopes=[],mounted=[];let rosterFails=rosterError;
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,dataset:{},classList:{toggle(){},add(){},remove(){}},focus(){},setSelectionRange(){}});return elements.get(selector);};
 const location=new URL(url);location.assign=value=>assigned.push(value);
 const selection={ownCompanyId:'cmp_own',comparisonIds:['cmp_comp'],stayMode:'upcoming30',stayStart:'2026-10-26',stayEnd:'2026-11-24',asOfDate:'2026-10-26',selectedView:'flow'};
 const store={getState:()=>selection,configure(){},update(value){Object.assign(selection,value);return{ok:true,state:selection};},toQuery:()=>'',restoreUrl(){}};
 const window={addEventListener(name,fn){events[name]=fn;},scrollTo(){},InsightComparisonSelection:{createStore:()=>store},InsightComparisonView:{panel:()=>'<div>기존 비교 화면</div>',mount(){},stop(){}},InsightHomeContextView:{panel:s=>'<h2>'+s.customer.username+'</h2>'},InsightContextWorkspace:{controls:()=>'',mount(){},stop(){}},InsightRegionalContextView:{panel:()=>''},InsightCollection:{panel:()=>'<h2>업체 기본자료</h2>',mount(id,api,options){mounted.push({id,api,options});},stop(){},setContext(scope){scopes.push(scope);},restore(){},clearCache(){}},InsightAnalysis:{stop(){},configureCache(){},configureReports(){},restore(){},restoreReports(){},panel:()=>'<form id="analysis-form"></form>',mount(){}}};
 const context=vm.createContext({window,location,URL,URLSearchParams,history:{replaceState(){}},sessionStorage:{getItem(){return null;}},localStorage:{getItem(){return null;}},document:{querySelector:element,querySelectorAll:()=>[],body:element('body'),documentElement:{dataset:{},setAttribute(){}},addEventListener(name,fn){events[name]=fn;}},crypto:{randomUUID:()=> 'fixture_key'},AbortController,setTimeout(){return 1;},clearTimeout(){},
 fetch:async(url,options={})=>{calls.push({url,options});let status=200,data={};if(url.endsWith('/config'))data={};else if(url==='/api/insight-admin/v1/customers'){if(rosterFails){status=503;data={error:{message:'목록 연결 지연'}};}else data={customers:roster};}else if(url.endsWith('/customer-view/me')||url==='/api/customer/v1/me'){if(meError){status=meError;data={error:{code:meError===409?'CUSTOMER_VIEW_REQUIRED':'DENIED',message:'선택 고객 확인 필요'}};}else data=state;}else if(url==='/api/insight-admin/v1/me')data={admin:{username:'admin'},csrfToken:'fixture_csrf'};else if(url.endsWith('/start'))data=state;else if(url.endsWith('/auth/logout'))data={ok:true};return{status,ok:status<400,json:async()=>data};}});
 vm.runInContext(read('saved-keyword-comparison.js'),context);if(early)vm.runInContext(read('bootstrap-read.js'),context);vm.runInContext(read('connected.js'),context);await flush();
 return{calls,window,events,assigned,mounted,scopes,state,html:()=>element('#main').innerHTML,banner:()=>element('#admin-view-banner').innerHTML,setRosterError(value){rosterFails=value;},async navigate(hash){location.hash=hash;events.hashchange();await flush();},async action(action,dataset={}){const button={dataset:{action,...dataset},disabled:false};await events.click({target:{closest:()=>button}});await flush();},async submit(id){await events.submit({preventDefault(){},target:{id,dataset:{}}});await flush();},async select(value){events.change({target:{value,matches:selector=>selector==='[data-admin-customer-select]'}});await flush();},async search(value){events.input({target:{value,selectionStart:value.length,selectionEnd:value.length,matches:selector=>selector==='[data-admin-customer-search]'}});await flush();}};
}
for(const early of[false,true])test(`${early?'early':'normal'} selected customer reads carry its identity on config, bootstrap, company, report and archive GETs`,async()=>{
 const h=await harness({early});assert.match(h.banner(),/읽기 전용/);assert.match(h.banner(),/alpha&lt;svg&gt;/);assert.match(h.banner(),/cus_alpha/);assert.doesNotMatch(h.banner(),/private-admin|cus_privateadmin/);
 await h.navigate('#company=cmp_own');const current=h.mounted.at(-1);assert.equal(current.options.editHtml,'');for(const route of['/companies/cmp_own/collection?month=2026-09','/reports/briefing?stayMode=all_available','/archives','/archives/archive_fixture'])await current.api(route);
 const reads=h.calls.filter(c=>c.url.includes('/customer-view/'));assert.ok(reads.length>=6);assert.ok(reads.every(c=>c.options.headers['X-Insight-Customer-Id']==='cus_alpha'));assert.ok(reads.every(c=>c.options.method!=='POST'));assert.ok(h.scopes.every(scope=>scope==='admin:cus_alpha'));
 assert.equal(h.calls.filter(c=>c.url==='/api/insight-admin/v1/customers').length,1);assert.equal(h.calls.find(c=>c.url==='/api/insight-admin/v1/customers').options.headers['X-Insight-Customer-Id'],undefined);
});
test('selected customer mode hides registration, collection and corrections and blocks forged mutation clicks',async()=>{
 const h=await harness();assert.doesNotMatch(h.html(),/data-action="recurring-request"/);await h.navigate('#settings');assert.match(h.html(),/읽기 전용/);assert.doesNotMatch(h.html(),/onboarding-form|data-action="archive"|data-settings=|id="search-form"/);
 await h.navigate('#collect=cmp_own');assert.equal(h.mounted.at(-1).options.editHtml,'');await h.action('recurring-request',{company:'cmp_comp'});await h.action('add',{kind:'competitor',id:'cmp_other'});await h.action('archive',{relation:'rel_one'});
 await h.submit('onboarding-form');await h.submit('archive-publish-form');assert.equal(h.calls.some(c=>c.options.method==='POST'),false);await assert.rejects(h.mounted.at(-1).api('/archives/reports',{reportType:'monthly'}),/저장·수집·등록할 수 없습니다/);
});
test('read-only customer cards retain the next collection date, staggered time and review details',async()=>{
 for(const time of['14:00','14:10','14:20']){
  const state=account();state.recurringCollections=[{companyId:'cmp_comp',status:'approved',time,nextRunAt:`2026-10-28T05:${time.slice(3)}:00Z`,reviewReason:'정기 수집 승인',shared:true}];
  const h=await harness({state});assert.match(h.html(),new RegExp('다음 수집 2026-10-28 '+time));assert.match(h.html(),/매일 1회, 당일 포함 30일/);assert.match(h.html(),/검토 사유: 정기 수집 승인/);assert.match(h.html(),/기존 승인 일정과 결과/);assert.doesNotMatch(h.html(),/data-action="recurring-request"/);
 }
});
test('customer selector resets every old company, date, region and report parameter by full navigation',async()=>{
 const h=await harness();await h.select('cus_beta');assert.equal(h.assigned.at(-1),'/customer-view?customerId=cus_beta#home');await h.select('');assert.equal(h.assigned.at(-1),'/customer-view#home');await h.select('cus_privateadmin');await h.select('cus_disabled');assert.equal(h.assigned.length,2);assert.match(h.banner(),/value="cus_disabled"\s+disabled/);
 await h.search('beta');assert.match(h.banner(),/value="cus_beta"/);assert.match(h.banner(),/value="cus_alpha" selected/);assert.doesNotMatch(h.banner(),/private-admin/);
});
test('roster failure keeps the verified selected customer visible and retries only on request',async()=>{
 const h=await harness({rosterError:true});assert.match(h.banner(),/목록 연결 지연/);assert.match(h.banner(),/고객 목록 다시 확인/);assert.match(h.banner(),/alpha&lt;svg&gt;/);assert.equal(h.calls.filter(c=>c.url.endsWith('/customers')).length,1);
 h.setRosterError(false);await h.action('admin-roster-retry');assert.equal(h.calls.filter(c=>c.url.endsWith('/customers')).length,2);assert.match(h.banner(),/value="cus_beta"/);assert.doesNotMatch(h.banner(),/목록 연결 지연/);
});
test('a selected 409 or mismatched identity never falls back to administrator preview creation',async()=>{
 for(const options of[{meError:409},{state:account('cus_beta')}]){const h=await harness(options);assert.equal(h.calls.some(c=>c.options.method==='POST'||c.url.endsWith('/start')),false);assert.match(h.html(),/자료 연결 확인이 필요/);assert.doesNotMatch(h.html(),/기존 비교 화면/);}
});
test('default administrator preview keeps its old POST start behavior and omits selected-customer headers',async()=>{
 const h=await harness({url:'https://insight.example/customer-view#competitors',state:account('cus_preview',false),meError:409});assert.ok(h.calls.some(c=>c.url.endsWith('/start')&&c.options.method==='POST'));assert.ok(h.calls.every(c=>!c.options.headers?.['X-Insight-Customer-Id']));assert.match(h.banner(),/실제 저장됩니다/);
});
test('normal customer ignores administrator selection query and administrator logout does not send target identity',async()=>{
 const normal=await harness({url:'https://insight.example/?customerId=cus_beta#competitors',state:account('cus_alpha',false)});assert.equal(normal.window.InsightAdminCustomerView.readOnly(),false);assert.ok(normal.calls.every(c=>!c.options.headers?.['X-Insight-Customer-Id']));
 const h=await harness();await h.action('logout');const logout=h.calls.find(c=>c.url.endsWith('/auth/logout'));assert.equal(logout.url,'/api/insight-admin/v1/auth/logout');assert.equal(logout.options.headers['X-Insight-Customer-Id'],undefined);assert.equal(h.assigned.at(-1),'/admin');
});

test('fixed historical review never appears in normal, administrator-preview or selected-customer competition pages',async()=>{
 for(const options of [
  {url:'https://insight.example/#competitors',state:account('cus_alpha',false)},
  {url:'https://insight.example/customer-view#competitors',state:account('cus_preview',false)},
  {url:'https://insight.example/customer-view?customerId=cus_alpha#competitors',state:account()}
 ]){
  const h=await harness(options);assert.match(h.html(),/기존 비교 화면/);
  assert.doesNotMatch(h.html(),/저장 키워드 비교|월명|상위 20|href="\/saved-keyword-comparison\/"/);
  assert.equal(h.calls.some(call=>call.url.startsWith('/saved-keyword-comparison/')),false);
  await h.navigate('#saved-keyword-comparison');
  assert.match(h.html(),/관리자 전용|관리자 화면으로 이동/);
  assert.doesNotMatch(h.html(),/월명|상위 20|href="\/saved-keyword-comparison\/"/);
  assert.equal(h.calls.some(call=>call.url.startsWith('/saved-keyword-comparison/')),false,'legacy navigation cannot prefetch the private archive');
 }
});

test('authenticated administrator management renders the historical entry using GET-only listing reads',async()=>{
 async function admin(authorized){
  const calls=[],elements=new Map(),events={};
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,dataset:{},addEventListener(name,fn){events[selector+':'+name]=fn;}});return elements.get(selector);};
  const scope={document:{querySelector:element,querySelectorAll:()=>[],documentElement:{dataset:{}}},location:{assign(){}},crypto:{randomUUID:()=> 'fixture_key'},fetch:async(url,options={})=>{
   calls.push({url,method:options.method||'GET'});
   if(url.endsWith('/me'))return{status:authorized?200:401,ok:authorized,json:async()=>authorized?{admin:{username:'admin'},csrfToken:'fixture'}:{error:{message:'관리자 로그인 필요'}}};
   assert.ok(authorized,'unauthenticated management cannot request customer or recurring lists');
   assert.ok(['/api/insight-admin/v1/customers','/api/insight-admin/v1/recurring-collections'].includes(url),'rendering a review link cannot read a bundle or company records');
   return{status:200,ok:true,json:async()=>url.endsWith('/customers')?{customers:roster}:{recurringCollections:[]}};
  }};
  scope.window=scope;const context=vm.createContext(scope);
  vm.runInContext(read('saved-keyword-comparison.js'),context);vm.runInContext(read('admin.js'),context);await flush();
  return{calls,html:element('#main').innerHTML};
 }
 const logged=await admin(true);assert.match(logged.html,/저장 키워드 비교/);assert.match(logged.html,/고객별 경쟁분석과 별도/);
 assert.match(logged.html,/href="\/saved-keyword-comparison\/" target="_blank" rel="noopener"/);
 assert.ok(logged.calls.every(call=>call.method==='GET'));assert.equal(logged.calls.length,3);
 const anonymous=await admin(false);assert.match(anonymous.html,/인사이트 관리자 로그인/);assert.doesNotMatch(anonymous.html,/저장 키워드 비교|href="\/saved-keyword-comparison\/"/);
 assert.deepEqual(anonymous.calls,[{url:'/api/insight-admin/v1/me',method:'GET'}]);
});
test('archive and regional views retain read filters while hiding publication and preparation controls',()=>{
 const window={InsightAdminCustomerView:{readOnly:()=>true}},handlers={};const context=vm.createContext({window,document:{addEventListener(name,fn){handlers[name]=fn;},querySelector(){return null;}},Date});
 vm.runInContext(read('archive.js'),context);const archive=window.InsightArchives.panel(account());assert.match(archive,/archive-kind/);assert.match(archive,/archive-list/);assert.doesNotMatch(archive,/archive-publish-form|archive-review-form/);
 const writes=[];window.InsightArchives.mount((...args)=>writes.push(args),{readOnly:true});for(const id of['archive-publish-form','archive-review-form'])handlers.submit({target:{id},preventDefault(){},stopImmediatePropagation(){}});assert.equal(writes.length,0,'forged keyboard submits cannot capture reviews or publish reports');
 vm.runInContext(read('region-history.js'),context);const regional=window.InsightRegionHistory.render({region:{label:'검수 지역'},sources:[],window:{start:'2025-10',end:'2026-09'},warnings:[],refreshAvailable:true});assert.doesNotMatch(regional,/data-history-refresh|지역 자료 갱신<\/button>/);assert.match(regional,/2025-10/);
});
test('administrator roster and details link only actual customer accounts and escape names',async()=>{
 const elements=new Map(),events={};const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,dataset:{},addEventListener(name,fn){events[selector+':'+name]=fn;}});return elements.get(selector);};
 const customer={...roster[0],entitlements:{competitorLimit:3,interestRegionLimit:1},regions:[]};
 vm.runInContext(read('admin.js'),vm.createContext({document:{querySelector:element,querySelectorAll:()=>[],documentElement:{dataset:{}}},location:{assign(){}},crypto:{randomUUID:()=> 'fixture_key'},fetch:async url=>({status:200,ok:true,json:async()=>url.endsWith('/me')?{admin:{username:'admin'},csrfToken:'fixture'}:url.endsWith('/customers')?{customers:roster}:url.endsWith('/customers/cus_alpha')?{customer,companies:[],regions:[],corrections:[],preparations:[]}:{recurringCollections:[]}})}));
 await flush();const list=element('#main').innerHTML;assert.match(list,/href="\/customer-view\?customerId=cus_alpha#home"/);assert.match(list,/href="\/customer-view\?customerId=cus_beta#home"/);assert.doesNotMatch(list,/customerId=cus_privateadmin|customerId=cus_disabled|alpha<svg>/);assert.match(list,/이용 중지 · 고객 화면 조회 불가/);assert.match(list,/alpha&lt;svg&gt;/);
 const button={dataset:{customer:'cus_alpha'},disabled:false};await events['#main:click']({target:{closest:()=>button}});await flush();assert.match(element('#main').innerHTML,/href="\/customer-view\?customerId=cus_alpha#home"/);
});
