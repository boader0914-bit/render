'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=file=>fs.readFileSync(require.resolve('../web/'+file),'utf8');
const clone=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(accountKind='customer'){
  const own={companyId:'cmp_own',name:'내 매장 검수 글램핑',address:'검수 주소 A',rooms:16,roomCountSource:'DB 검수값',dayUse:'unknown',facilities:'개별 BBQ',version:12};
  const competitor={...own,companyId:'cmp_competitor',name:'비교 검수 풀빌라',address:'검수 주소 B',rooms:10,version:7};
  return {customer:{customerId:'customer_navigation',username:'review',accountKind,revision:1,businessStatus:'owned',projectName:'검수 프로젝트',settings:{},regions:[],entitlements:{competitorLimit:3,interestRegionLimit:1},relations:[
    {companyId:competitor.companyId,relationId:'rel_competitor',kind:'competitor',status:'active'},
    {companyId:own.companyId,relationId:'rel_own',kind:'own',status:'pending'}]},
    companies:[competitor,own],corrections:[],preparations:[],regions:[],features:{directCollection:true},registrationAllowance:accountKind==='admin_preview'?{ownLimit:null,competitorLimit:null,interestRegionLimit:null}:{ownLimit:1,competitorLimit:3,interestRegionLimit:1},collectionAllowance:{limit:1,canRequest:true,resetsAt:'2026-10-14T15:00:00Z'}};
}
function collectionData(company){
  return {collectionAllowance:{limit:1,canRequest:true},request:null,result:{rooms:company.rooms,products:[],productCount:0,quality:{status:'complete'}},companyDetail:{companyId:company.companyId,basics:{...company},channels:[{label:'네이버',statusLabel:'저장 자료 연결',url:'https://booking.naver.com'}],integrated:{status:'ready',selectedMonth:'2026-10',snapshot:{},roomBasis:{count:company.rooms,label:'DB 검수값'}},current:{summary:{rangeStart:'2026-10-01',rangeEnd:'2026-10-02',calendarDays:2,observedDays:2,missingDays:0},daily:[{date:'2026-10-01',publicBookings:1,phoneBookings:0,estimatedRevenue:179000,publicRevenue:179000,phoneRevenue:0},{date:'2026-10-02',publicBookings:0,phoneBookings:0,estimatedRevenue:0,publicRevenue:0,phoneRevenue:0}]}}};
}
function multipleOwnFixture(accountKind='customer'){
  const s=fixture(accountKind),own=s.companies.find(row=>row.companyId==='cmp_own');
  own.regionKey='region-own';s.companies.find(row=>row.companyId==='cmp_competitor').regionKey='region-interest';
  s.companies.unshift({...own,companyId:'cmp_own_second',name:'두번째 내 매장',regionKey:'region-second'});
  s.customer.relations.push({companyId:'cmp_own_second',relationId:'rel_own_second',kind:'own',status:'active'});
  s.customer.regions=[{relationId:'rel_region_interest',regionKey:'region-interest',status:'active'}];
  s.regions=[{id:'region-interest',label:'관심지역'},{id:'region-own',label:'첫 매장 소재지'},{id:'region-second',label:'두번째 매장 소재지'}];
  return s;
}
async function screen({adminView=false,accountKind=adminView?'admin_preview':'customer',initialHash='#home',deferRequests=[],fixtureState=null,regionSearchResults=[]}={}){
  let currentState=fixtureState?clone(fixtureState):fixture(accountKind),hash=initialHash,mainRevision=0;
  const originalCompanies=clone(currentState.companies),elements=new Map(),documentEvents=new Map(),windowEvents=new Map(),calls=[],pending=[],mounted=[],contexts=[],invalidated=[],analysisPanels=[],analysisMounts=[],restoredCalls=[],analysisCacheContexts=[],analysisRestoredCalls=[],analysisLifecycle=[],reportCacheContexts=[],reportRestoredCalls=[],reportLifecycle=[];
  let clearCalls=0;
  const element=selector=>{
    if(elements.has(selector))return elements.get(selector);
    const classes=new Set();let content='';
    const result={textContent:'',hidden:false,disabled:false,dataset:{ready:'true'},children:[],
      classList:{add(value){classes.add(value);},remove(value){classes.delete(value);},toggle(value,force){if(force===true||force===undefined&&!classes.has(value))classes.add(value);else classes.delete(value);}},
      setAttribute(key,value){this[key]=value;},focus(){},append(child){this.children.push(child);}};
    Object.defineProperty(result,'innerHTML',{get(){return content;},set(value){content=value;if(selector==='#main'){mainRevision++;for(const key of [...elements.keys()])if(key.startsWith('#collection-')||key==='#company-current-view')elements.delete(key);}}});
    elements.set(selector,result);return result;
  };
  const document={hidden:false,activeElement:null,body:element('body'),documentElement:{dataset:{}},addEventListener(name,handler){const handlers=documentEvents.get(name)||[];handlers.push(handler);documentEvents.set(name,handlers);},
    querySelector(selector){
      if(selector.startsWith('#collection-result form'))return null;
      if(selector==='[data-collect] button[type=submit]')return element('#main').innerHTML.includes('data-collect=')?element(selector):null;
      if(selector.startsWith('#collection-')||selector==='#company-current-view'){
        const id=selector.slice(1);
        if(!element('#main').innerHTML.includes(`id="${id}"`)&&!element('#collection-result').innerHTML.includes(`id="${id}"`))return null;
      }
      return element(selector);
    }};
  const location={pathname:adminView?'/customer-view':'/',get hash(){return hash;},set hash(value){hash=value.startsWith('#')?value:`#${value}`;},assign(value){this.assigned=value;}};
  class FormDataFixture{constructor(form){this.values=form.values;}*[Symbol.iterator](){yield* Object.entries(this.values);}}
  const window={addEventListener(name,handler){windowEvents.set(name,handler);},scrollTo(){},InsightAuth:{screen(){return '<section class="signed-out-fixture">로그인</section>';},welcome(){return '<p>가입 완료</p>';},policy(){return '<p>정책</p>';}},InsightAnalysis:{stop(){},configureCache(options){analysisCacheContexts.push(options);analysisLifecycle.push('configure');},restore(views,scope){analysisRestoredCalls.push({views,scope});analysisLifecycle.push('restore');},configureReports(options){reportCacheContexts.push(options);reportLifecycle.push('configure');},restoreReports(views,scope){reportRestoredCalls.push({views,scope});reportLifecycle.push('restore');},panel(mode,s,selectedRegion,selectedOwnId){analysisPanels.push({mode,selectedRegion,selectedOwnId});return '<p>분석 검수 화면</p>';},mount(mode,request,s,selectedRegion,selectedOwnId){analysisMounts.push({mode,selectedRegion,selectedOwnId});analysisLifecycle.push('mount');if(mode==='reports')reportLifecycle.push('mount');}}};
  const response=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>clone(value)});
  const reply=(url,value)=>deferRequests.some(match=>typeof match==='string'?url===match:match.test(url))?new Promise(resolve=>pending.push({url,value,resolve})):response(value);
  const fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;
    calls.push({url,method:options.method||'GET',body,headers:{...options.headers}});
    if(url==='/api/insight-admin/v1/me')return reply(url,{csrfToken:'fixture-admin-csrf'});
    if(url.endsWith('/config'))return reply(url,{signupEnabled:true});
    if(url.endsWith('/me')||url.endsWith('/start'))return reply(url,currentState);
    if(url.endsWith('/auth/login'))return response(currentState);
    if(url.endsWith('/auth/logout'))return response({ok:true});
    if(url.includes('/catalog/regions?'))return response({results:regionSearchResults});
    const companyMatch=url.match(/\/companies\/([^/?]+)\/collection(?:\?.*)?$/);
    if(companyMatch){const company=currentState.companies.find(row=>row.companyId===decodeURIComponent(companyMatch[1]));assert.ok(company,'only registered company fixtures are queried');return reply(url,collectionData(company));}
    if(url.endsWith('/commands')){
      assert.equal(body.action,'correction','this flow may submit a review request only');
      const company=currentState.companies.find(row=>row.companyId===body.payload.companyId);
      currentState={...currentState,customer:{...currentState.customer,revision:currentState.customer.revision+1},corrections:[...currentState.corrections,{requestId:'correction_fixture',companyId:company.companyId,status:'pending',submittedAt:'2026-10-13T05:00:00Z',reason:body.payload.reason,baseValues:{rooms:company.rooms},proposed:body.payload.proposed}]};
      return response(currentState);
    }
    throw new Error('Unexpected fixture request: '+url);
  };
  const context=vm.createContext({window,document,location,fetch,FormData:FormDataFixture,crypto:{randomUUID(){return 'fixture-command-key';}},localStorage:{getItem(){return null;},setItem(){}},setTimeout(){return 1;},clearTimeout(){}});
  for(const file of ['company-flow.js','company-view.js','collection.js'])vm.runInContext(read(file),context);
  const collection=window.InsightCollection,originalMount=collection.mount,originalContext=collection.setContext,originalClear=collection.clearCache,originalInvalidate=collection.invalidate,originalRestore=collection.restore;
  collection.mount=(id,api,options)=>{mounted.push({id,options,request:api});return originalMount(id,api,options);};
  collection.setContext=(scope,ids,callback)=>{contexts.push({scope,ids:Array.from(ids||[])});return originalContext(scope,ids,callback);};
  collection.clearCache=()=>{clearCalls++;return originalClear();};
  collection.invalidate=id=>{invalidated.push(id);return originalInvalidate(id);};
  collection.restore=(views,scope)=>{restoredCalls.push({views,scope});return originalRestore(views,scope);};
  vm.runInContext(read('connected.js'),context);await flush();
  async function dispatch(name,event){for(const callback of documentEvents.get(name)||[])await callback(event);await flush();}
  return {calls,mounted,contexts,invalidated,originalCompanies,location,analysisPanels,analysisMounts,restoredCalls,analysisCacheContexts,analysisRestoredCalls,analysisLifecycle,reportCacheContexts,reportRestoredCalls,reportLifecycle,
    expireRegion(){analysisCacheContexts.at(-1).onSessionExpired();},
    expireReport(){reportCacheContexts.at(-1).onSessionExpired();},
    pending:()=>pending.map(row=>row.url),
    async respond(url,{status=200,value}={}){const index=pending.findIndex(row=>row.url===url);assert.notEqual(index,-1,'expected a pending request: '+url);const request=pending.splice(index,1)[0];request.resolve(response(value===undefined?request.value:value,status));await flush();},
    html:()=>element('#main').innerHTML,result:()=>document.querySelector('#collection-result')?.innerHTML||'',navigation:()=>element('#navigation').innerHTML,searchResults:()=>element('#search-results').innerHTML,
    state:()=>clone(currentState),clearCount:()=>clearCalls,revision:()=>mainRevision,
    async navigate(value){location.hash=value;windowEvents.get('hashchange')();await flush();},
    async correct(companyId,values){const form={dataset:{correction:companyId},values,querySelectorAll(){return [{disabled:false}];},querySelector(){return null;}};await dispatch('submit',{preventDefault(){},target:form});},
    async login(){const form={id:'auth-form',dataset:{},values:{username:'fixture-login',password:'fixture-password'},querySelectorAll(){return [{disabled:false}];},querySelector(){return null;}};await dispatch('submit',{preventDefault(){},target:form});},
    async searchRegion(q){const form={id:'search-form',dataset:{kind:'region'},values:{q},querySelectorAll(){return [{disabled:false}];},querySelector(){return null;}};await dispatch('submit',{preventDefault(){},target:form});},
    async logout(){const button={dataset:{action:'logout'},disabled:false};await dispatch('click',{target:{closest(){return button;}}});}};
}

for(const adminView of [false,true]){
  test(`${adminView?'administrator preview':'customer'} initially prepares only the primary own company using one read-only GET`,async()=>{
    const ui=await screen({adminView}),queries=ui.calls.filter(call=>call.url.includes('/companies/'));
    assert.equal(queries.length,1);assert.match(queries[0].url,/\/companies\/cmp_own\/collection$/);
    assert.ok(queries.every(call=>call.method==='GET'&&call.body===null));
    assert.ok(ui.calls.every(call=>call.method==='GET'||adminView&&call.url.endsWith('/customer-view/start')));
    assert.ok(ui.calls.every(call=>!call.url.includes('/crawl')&&!call.url.endsWith('/commands')));
  });
}

test('customer refresh starts configuration and session reads together without duplicate bootstrap requests',async()=>{
  const config='/api/customer/v1/config',me='/api/customer/v1/me';
  const ui=await screen({deferRequests:[config,me]});
  assert.deepEqual(ui.pending(),[config,me],'session lookup must begin while configuration is still pending');
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0);
  await ui.respond(me);
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,1,'fresh authorization can display saved company data while non-critical configuration is still pending');
  assert.match(ui.html(),/내 매장 보기/);
  await ui.respond(config);
  assert.match(ui.html(),/내 매장 보기/);
  assert.equal(ui.calls.filter(row=>row.url===config).length,1);
  assert.equal(ui.calls.filter(row=>row.url===me).length,1);
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,1);
  assert.ok(ui.calls.every(row=>row.method==='GET'));
});

test('customer session expiry during parallel bootstrap renders login without preparing private companies',async()=>{
  const config='/api/customer/v1/config',me='/api/customer/v1/me';
  const ui=await screen({deferRequests:[config,me]});
  await ui.respond(me,{status:401,value:{error:{code:'UNAUTHORIZED',message:'로그인이 만료되었습니다.'}}});
  await ui.respond(config);
  assert.match(ui.html(),/signed-out-fixture/);
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0);
  assert.equal(ui.contexts.at(-1).scope,'');
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} sends cache refresh intent only for an explicit GET option`,async()=>{
  const ui=await screen({adminView,initialHash:'#property'});
  const request=ui.mounted.at(-1).request;
  assert.ok(ui.calls.filter(row=>row.method==='GET').every(row=>!('X-Insight-Refresh' in row.headers)));
  await request('/companies/cmp_own/collection',undefined,{refresh:true});
  const refresh=ui.calls.at(-1);
  assert.equal(refresh.method,'GET');assert.equal(refresh.headers['X-Insight-Refresh'],'1');
  assert.equal(refresh.headers.Accept,'application/json');assert.equal(refresh.body,null);
  await request('/auth/logout',{}, {refresh:true});
  const post=ui.calls.at(-1);
  assert.equal(post.method,'POST');assert.equal(post.headers['Content-Type'],'application/json');
  assert.ok(!('X-Insight-Refresh' in post.headers),'refresh must not alter command or collection POST headers');
});

test('administrator refresh overlaps identity and configuration but starts one preview with verified CSRF',async()=>{
  const identity='/api/insight-admin/v1/me',config='/api/insight-admin/v1/customer-view/config',start='/api/insight-admin/v1/customer-view/start';
  const ui=await screen({adminView:true,deferRequests:[identity,config]});
  assert.deepEqual(new Set(ui.pending()),new Set([identity,config]));
  await ui.respond(config);
  assert.equal(ui.calls.filter(row=>row.url===start).length,0,'configuration alone cannot authorize a preview start');
  await ui.respond(identity);
  const starts=ui.calls.filter(row=>row.url===start);
  assert.equal(starts.length,1);assert.equal(starts[0].method,'POST');
  assert.equal(starts[0].headers['X-CSRF-Token'],'fixture-admin-csrf');
  assert.equal(ui.calls.filter(row=>row.url===identity).length,1);
  assert.equal(ui.calls.filter(row=>row.url===config).length,1);
  assert.match(ui.html(),/관리자 체험/);
});

test('administrator identity expiry takes precedence over a failed parallel configuration read',async()=>{
  const identity='/api/insight-admin/v1/me',config='/api/insight-admin/v1/customer-view/config';
  const ui=await screen({adminView:true,deferRequests:[identity,config]});
  await ui.respond(config,{status:503,value:{error:{message:'설정 연결 실패'}}});
  await ui.respond(identity,{status:401,value:{error:{message:'로그인 필요'}}});
  assert.match(ui.html(),/관리자 로그인이 필요합니다/);
  assert.doesNotMatch(ui.html(),/설정 연결 실패/);
  assert.ok(ui.calls.every(row=>row.method==='GET'),'an expired administrator must not start a preview or prepare companies');
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0);
});

test('parallel configuration failure does not block an administrator preview after fresh identity verification',async()=>{
  const identity='/api/insight-admin/v1/me',config='/api/insight-admin/v1/customer-view/config';
  const ui=await screen({adminView:true,deferRequests:[identity,config]});
  await ui.respond(identity);
  await ui.respond(config,{status:503,value:{error:{message:'설정 연결 실패'}}});
  assert.match(ui.html(),/관리자 체험/);assert.doesNotMatch(ui.html(),/설정 연결 실패/);
  assert.equal(ui.calls.filter(row=>row.url.endsWith('/customer-view/start')).length,1);
  assert.ok(ui.calls.every(row=>row.method==='GET'||row.url.endsWith('/customer-view/start')));
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,1);
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} refresh shares only the visible competitor read without warming another company`,async()=>{
  const ui=await screen({adminView,initialHash:'#company=cmp_competitor',deferRequests:[/\/companies\/[^/]+\/collection$/]});
  const first=ui.calls.filter(row=>row.url.includes('/companies/'));
  assert.equal(first.length,1,'background own-company reads must not compete with the visible company');
  assert.match(first[0].url,/\/companies\/cmp_competitor\/collection$/);
  assert.equal(ui.mounted.at(-1).id,'cmp_competitor');
  await ui.respond(first[0].url);
  const all=ui.calls.filter(row=>row.url.includes('/companies/'));
  assert.equal(all.length,1);
  assert.equal(all.filter(row=>row.url===first[0].url).length,1,'mount and warmup share the visible company request');
  assert.ok(all.every(row=>!row.url.includes('/companies/cmp_own/')),'a viewed competitor does not trigger an offscreen own-company calculation');
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} direct collection routes read exactly the requested registered company`,async()=>{
  for(const route of ['company','collection','collect']){
    const ui=await screen({adminView,fixtureState:multipleOwnFixture(adminView?'admin_preview':'customer'),initialHash:'#'+route+'=cmp_own_second'});
    const queries=ui.calls.filter(row=>row.url.includes('/companies/'));
    assert.equal(queries.length,1);assert.match(queries[0].url,/\/companies\/cmp_own_second\/collection$/);
    assert.equal(ui.mounted.at(-1).id,'cmp_own_second');
    assert.ok(queries.every(row=>row.method==='GET'),'opening an explicit collection page must not start collection');
  }
});

test('home and a multiple-property list warm only the first registered own company rather than catalog-order competitors',async()=>{
  for(const initialHash of ['#home','#property']){
    const ui=await screen({fixtureState:multipleOwnFixture(),initialHash}),queries=ui.calls.filter(row=>row.url.includes('/companies/'));
    assert.equal(queries.length,1);assert.match(queries[0].url,/\/companies\/cmp_own\/collection$/);
  }
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} regional, reporting, management and competitor lists never warm unopened company views`,async()=>{
  for(const initialHash of ['#regions','#regions=region-interest','#reports','#settings','#competitors','#register-own','#welcome']){
    const ui=await screen({adminView,fixtureState:multipleOwnFixture(adminView?'admin_preview':'customer'),initialHash});
    assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0,initialHash+' must not calculate an offscreen company');
    assert.equal(ui.mounted.length,0);
  }
});

test('an account without an own company or an unregistered explicit link does not fall back to warming competitors',async()=>{
  const noOwn=fixture();noOwn.customer.relations=noOwn.customer.relations.filter(row=>row.kind!=='own');
  for(const initialHash of ['#home','#property']){
    const ui=await screen({fixtureState:noOwn,initialHash});assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0);
  }
  const invalid=await screen({initialHash:'#company=not-registered'});
  assert.match(invalid.html(),/등록한 업체를 찾을 수 없습니다/);assert.equal(invalid.calls.filter(row=>row.url.includes('/companies/')).length,0);
});

test('a competitor is loaded when opened and its visited view remains immediately reusable without offscreen warming',async()=>{
  const ui=await screen({deferRequests:[/\/companies\/cmp_competitor\/collection$/]});
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/cmp_competitor/')).length,0);
  await ui.navigate('#company=cmp_competitor');
  const first=ui.pending().find(url=>url.includes('/companies/cmp_competitor/'));assert.ok(first);await ui.respond(first);
  const saved=ui.result();assert.match(saved,/비교 검수 풀빌라/);
  await ui.navigate('#home');await ui.navigate('#company=cmp_competitor');
  assert.equal(ui.result(),saved,'a visited company still renders its cached view before its permission recheck returns');
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/cmp_competitor/')).length,2);
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/cmp_own/')).length,1,'navigation does not restart the offscreen own-company warmup');
});

test('home cards contain a company view link without collection, unregister or correction controls',async()=>{
  const ui=await screen();
  assert.match(ui.html(),/href="#company=cmp_own"/);assert.match(ui.html(),/내 매장 보기/);
  assert.doesNotMatch(ui.html(),/href="#collect=|data-action="archive"|data-correction=|정보 수정|자료 갱신|수집 시작|30일 예약/);
  assert.match(ui.navigation(),/href="#property"/);assert.match(ui.navigation(),/href="#settings"/);
});

test('ordinary ownership verification remains explained while administrator preview is labelled as a preview',async()=>{
  const customer=await screen();
  assert.match(customer.html(),/내 매장 확인 대기/);assert.match(customer.html(),/내 매장 연결에 대한 관리자 확인이 필요합니다/);
  assert.match(customer.html(),/저장된 업체자료는 바로 볼 수 있습니다/);assert.doesNotMatch(customer.html(),/관리자 체험/);
  const admin=await screen({adminView:true});
  assert.match(admin.html(),/관리자 체험/);assert.doesNotMatch(admin.html(),/내 매장 확인 대기|내 매장 연결에 대한 관리자 확인/);
});

test('Settings provides the registered-company management actions for each relationship',async()=>{
  const ui=await screen();await ui.navigate('#settings');
  assert.match(ui.html(),/등록업체 관리/);assert.match(ui.html(),/업체 DB와 저장자료는 보존됩니다/);
  assert.equal((ui.html().match(/data-action="archive"/g)||[]).length,2);
  assert.equal((ui.html().match(/>자료 갱신<\/a>/g)||[]).length,2);
  assert.equal((ui.html().match(/<summary>개인 설정<\/summary>/g)||[]).length,2);
  assert.match(ui.html(),/data-settings="cmp_own"/);assert.match(ui.html(),/data-settings="cmp_competitor"/);
  assert.doesNotMatch(ui.html(),/data-correction=|정보 수정|수집 시작/);
  assert.ok(ui.calls.every(call=>call.method==='GET'),'opening Settings must not collect or change stored data');
});

test('a single own-company menu opens details directly and attaches the common editor to basic information',async()=>{
  const ui=await screen();await ui.navigate('#property');
  assert.equal(ui.mounted.at(-1).id,'cmp_own');
  assert.match(ui.mounted.at(-1).options.editHtml,/data-correction="cmp_own"/);
  const html=ui.result(),basics=html.split('<section class="card db-channels">')[0];
  assert.match(basics,/업체 기본정보/);assert.match(basics,/data-correction="cmp_own"/);assert.match(basics,/수정 내용은 검수 요청으로 별도 저장/);
  assert.match(html,/예약채널/);assert.match(html,/통합관측/);
  assert.doesNotMatch(ui.html(),/connected-row|id="search-form"|등록 업체로 돌아가기/);
  await ui.navigate('#company=cmp_competitor');
  assert.equal(ui.mounted.at(-1).id,'cmp_competitor');
  assert.match(ui.result().split('<section class="card db-channels">')[0],/data-correction="cmp_competitor"/);
});

test('common editing sends a separate correction request with baseline version and keeps the displayed DB value',async()=>{
  const ui=await screen();await ui.navigate('#property');
  await ui.correct('cmp_own',{name:'내 매장 검수 글램핑',address:'검수 주소 A',rooms:'17',dayUse:'unknown',facilities:'개별 BBQ',reason:'검수 예시 근거'});
  const command=ui.calls.find(call=>call.url.endsWith('/commands'));
  assert.equal(command.method,'POST');assert.equal(command.body.action,'correction');
  assert.equal(command.body.payload.companyId,'cmp_own');assert.equal(command.body.payload.baseVersion,12);
  assert.deepEqual(command.body.payload.proposed,{rooms:17});assert.equal(command.body.payload.reason,'검수 예시 근거');
  assert.deepEqual(ui.state().companies,ui.originalCompanies);
  assert.equal(ui.state().corrections[0].status,'pending');assert.equal(ui.state().corrections[0].baseValues.rooms,16);
  assert.match(ui.result(),/객실 총량<\/span><strong>16실/);assert.match(ui.result(),/정보 수정 · 검수 대기/);
  assert.deepEqual(ui.invalidated,['cmp_own']);
  assert.ok(ui.calls.every(call=>call.method==='GET'||call.url.endsWith('/commands')));
});

test('logout removes the authenticated view and clears the private company cache context',async()=>{
  const ui=await screen();await ui.navigate('#property');assert.match(ui.result(),/내 매장 검수 글램핑/);
  await ui.logout();
  assert.equal(ui.clearCount(),1);assert.equal(ui.contexts.at(-1).scope,'');assert.deepEqual(ui.contexts.at(-1).ids,[]);
  assert.equal(ui.location.hash,'#login');assert.match(ui.html(),/signed-out-fixture/);assert.equal(ui.result(),'');
  assert.doesNotMatch(ui.html(),/내 매장 검수 글램핑|검수 주소 A|16실/);
  const logout=ui.calls.find(call=>call.url.endsWith('/auth/logout'));assert.equal(logout.method,'POST');
});

test('an administrator with one own company retains an explicit path for another registration',async()=>{
  const ui=await screen({adminView:true});await ui.navigate('#settings');
  assert.match(ui.html(),/href="#register-own"/);
  await ui.navigate('#register-own');
  assert.match(ui.html(),/id="search-form" data-kind="own"/);
  assert.match(ui.navigation(),/href="#property" class="nav-link active"/);
  assert.ok(ui.calls.every(call=>call.method==='GET'||call.url.endsWith('/customer-view/start')));
});

test('the separate registration route still respects the ordinary customer own-company limit',async()=>{
  const ui=await screen();await ui.navigate('#register-own');
  assert.doesNotMatch(ui.html(),/id="search-form"/);
  assert.match(ui.html(),/이미 내 매장이 등록되어 있습니다/);
  assert.match(ui.html(),/href="#settings"/);
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} region navigation preserves the selected own company through a competitor view`,async()=>{
  const ui=await screen({adminView,fixtureState:multipleOwnFixture(adminView?'admin_preview':'customer')});
  await ui.navigate('#company=cmp_own_second');await ui.navigate('#regions');
  const expected={mode:'regions',selectedRegion:null,selectedOwnId:'cmp_own_second'};
  assert.deepEqual(ui.analysisPanels.at(-1),expected);assert.deepEqual(ui.analysisMounts.at(-1),expected);
  await ui.navigate('#company=cmp_competitor');await ui.navigate('#regions');
  assert.deepEqual(ui.analysisPanels.at(-1),expected,'opening a competitor must not replace the selected own property');
  assert.deepEqual(ui.analysisMounts.at(-1),expected,'the initial read and visible form receive identical defaults');
});

test('explicit region links are passed unchanged to the form and first read even after selecting another own property',async()=>{
  const ui=await screen({fixtureState:multipleOwnFixture()});
  await ui.navigate('#company=cmp_own_second');
  for(const selectedRegion of ['region-interest','not-registered','']){
    await ui.navigate('#regions='+encodeURIComponent(selectedRegion));
    const expected={mode:'regions',selectedRegion,selectedOwnId:'cmp_own_second'};
    assert.deepEqual(ui.analysisPanels.at(-1),expected);assert.deepEqual(ui.analysisMounts.at(-1),expected);
  }
});

test('a direct region entry neither reads offscreen companies nor invents a selected own company',async()=>{
  const ui=await screen({fixtureState:multipleOwnFixture(),initialHash:'#regions=region-interest'});
  const expected={mode:'regions',selectedRegion:'region-interest',selectedOwnId:null};
  assert.deepEqual(ui.analysisPanels.at(-1),expected);assert.deepEqual(ui.analysisMounts.at(-1),expected);
  assert.equal(ui.calls.filter(row=>row.url.includes('/companies/')).length,0,'regional entry must not calculate a company in the background');
});

test('logout clears the in-page own-property selection before another login',async()=>{
  const ui=await screen({fixtureState:multipleOwnFixture()});
  await ui.navigate('#company=cmp_own_second');await ui.navigate('#regions');
  assert.equal(ui.analysisMounts.at(-1).selectedOwnId,'cmp_own_second');
  await ui.logout();await ui.login();await ui.navigate('#regions');
  const expected={mode:'regions',selectedRegion:null,selectedOwnId:null};
  assert.deepEqual(ui.analysisPanels.at(-1),expected);assert.deepEqual(ui.analysisMounts.at(-1),expected);
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} restores authenticated company snapshots once before opening the initial property`,async()=>{
  const s=fixture(adminView?'admin_preview':'customer'),own=s.companies.find(row=>row.companyId==='cmp_own');
  s.companyViews=[{companyId:own.companyId,month:'',data:{...collectionData(own),responseCache:{state:'cached',checkedAt:new Date(Date.now()-1000).toISOString(),refreshing:false}}}];
  const ui=await screen({adminView,fixtureState:s,initialHash:'#property',deferRequests:[/\/companies\/[^/]+\/collection$/]});
  assert.match(ui.result(),/업체 기본정보/);assert.match(ui.result(),/예약채널/);assert.match(ui.result(),/통합관측/);
  assert.match(ui.result(),/href="https:\/\/booking.naver.com"/,'stored channel details render before the company GET completes');
  assert.equal(ui.restoredCalls.length,1);assert.equal(ui.restoredCalls[0].scope,`${adminView?'admin':'customer'}:customer_navigation`);
  assert.ok(ui.pending().some(url=>url.includes('/companies/cmp_own/collection')),'the normal permission recheck still starts in the background');
  await ui.navigate('#home');await ui.navigate('#property');
  assert.equal(ui.restoredCalls.length,1,'menu navigation must not replay bootstrap data from the same state object');
  assert.match(ui.result(),/href="https:\/\/booking.naver.com"/);
});

test('a newly returned state may restore once while later renders of that state do not replay its snapshots',async()=>{
  const ui=await screen({initialHash:'#property'});assert.equal(ui.restoredCalls.length,1);
  await ui.correct('cmp_own',{name:'내 매장 검수 글램핑',address:'검수 주소 A',rooms:'17',dayUse:'unknown',facilities:'개별 BBQ',reason:'검수 예시 근거'});
  assert.equal(ui.restoredCalls.length,2,'a successful command returns a distinct authenticated state');
  await ui.navigate('#home');await ui.navigate('#property');assert.equal(ui.restoredCalls.length,2);
});

test('region search hides an already connected own-company region without consuming an interest-region slot',async()=>{
  const s=fixture(),own=s.companies.find(row=>row.companyId==='cmp_own');own.regionKey='region-own';
  s.regions=[{id:'region-own',label:'내 매장 소재지'}];
  const ui=await screen({fixtureState:s,regionSearchResults:[{id:'region-own',label:'내 매장 소재지'},{id:'region-other',label:'다른 관심지역'}]});
  await ui.navigate('#regions');await ui.searchRegion('지역');
  assert.doesNotMatch(ui.searchResults(),/data-id="region-own"/);assert.match(ui.searchResults(),/data-id="region-other"/);
  assert.match(ui.searchResults(),/이미 연결된 지역은 추가 등록이 필요 없습니다/);
  assert.deepEqual(ui.state().customer.regions,[],'filtering a catalog must not create a region relation');
  assert.ok(ui.calls.every(row=>row.method==='GET'),'searching does not request a command or collection');
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} configures and restores regional snapshots before mounting the initial region`,async()=>{
  const s=multipleOwnFixture(adminView?'admin_preview':'customer');
  s.regionViews=[{regionKey:'region-own',month:'2026-09',data:{region:{id:'region-own',label:'첫 매장 소재지'},month:'2026-09',sources:[],responseCache:{checkedAt:new Date().toISOString()}}}];
  const ui=await screen({adminView,fixtureState:s,initialHash:'#regions'});
  assert.equal(ui.analysisRestoredCalls.length,1);assert.equal(ui.analysisRestoredCalls[0].scope,`${adminView?'admin':'customer'}:customer_navigation`);
  assert.deepEqual(ui.analysisRestoredCalls[0].views,s.regionViews);
  assert.deepEqual(Array.from(ui.analysisCacheContexts.at(-1).regionKeys),s.regions.map(r=>r.id));
  assert.deepEqual(ui.analysisLifecycle.slice(0,3),['configure','restore','mount']);
  await ui.navigate('#home');await ui.navigate('#regions');assert.equal(ui.analysisRestoredCalls.length,1,'same bootstrap object must not replay an earlier snapshot');
  ui.expireRegion();assert.match(ui.html(),/로그인|관리자 로그인이 필요합니다/);assert.equal(ui.analysisCacheContexts.at(-1).scope,'');assert.deepEqual(Array.from(ui.analysisCacheContexts.at(-1).regionKeys),[]);
  assert.equal(ui.calls.filter(c=>c.url.includes('/crawl')||c.url.endsWith('/preparation')).length,0,'restoration never dispatches a collection or region refresh');
});

for(const adminView of [false,true])test(`${adminView?'administrator':'customer'} configures report scope and restores a fresh bootstrap before the report is mounted`,async()=>{
  const s=multipleOwnFixture(adminView?'admin_preview':'customer');
  s.reportViews=[{ownId:'cmp_own',period:{start:'2026-10-23',end:'2026-11-21',days:30},data:{mode:'current_briefing',published:false,ownId:'cmp_own',companies:[],regions:[]}}];
  const ui=await screen({adminView,fixtureState:s,initialHash:'#reports'}),context=ui.reportCacheContexts.at(-1);
  assert.equal(context.scope,`${adminView?'admin':'customer'}:customer_navigation`);assert.deepEqual(Array.from(context.ownIds),['cmp_own','cmp_own_second']);assert.deepEqual(Array.from(context.companyIds),s.customer.relations.map(r=>r.companyId));assert.deepEqual(Array.from(context.regionKeys),s.regions.map(r=>r.id));
  assert.equal(typeof context.permissionVersion,'string');assert.match(context.permissionVersion,/cmp_own|region-own/);assert.doesNotMatch(context.permissionVersion,/csrf|password|token/);
  assert.equal(ui.reportRestoredCalls.length,1);assert.equal(ui.reportRestoredCalls[0].scope,context.scope);assert.deepEqual(ui.reportRestoredCalls[0].views,s.reportViews);assert.deepEqual(ui.reportLifecycle.slice(0,3),['configure','restore','mount']);
  await ui.navigate('#home');await ui.navigate('#reports');assert.equal(ui.reportRestoredCalls.length,1,'navigation cannot replay an older bootstrap');assert.equal(ui.reportCacheContexts.at(-1).permissionVersion,context.permissionVersion);
  ui.expireReport();assert.match(ui.html(),/로그인|관리자 로그인이 필요합니다/);assert.equal(ui.reportCacheContexts.at(-1).scope,'');assert.deepEqual(Array.from(ui.reportCacheContexts.at(-1).ownIds),[]);assert.deepEqual(Array.from(ui.reportCacheContexts.at(-1).companyIds),[]);assert.deepEqual(Array.from(ui.reportCacheContexts.at(-1).regionKeys),[]);
  assert.ok(ui.calls.every(c=>!c.url.includes('/crawl')&&!c.url.endsWith('/preparation')));
});
