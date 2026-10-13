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
async function screen({adminView=false,accountKind=adminView?'admin_preview':'customer',initialHash='#home'}={}){
  let currentState=fixture(accountKind),hash=initialHash,mainRevision=0;
  const originalCompanies=clone(currentState.companies),elements=new Map(),documentEvents=new Map(),windowEvents=new Map(),calls=[],mounted=[],contexts=[],invalidated=[];
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
  const window={addEventListener(name,handler){windowEvents.set(name,handler);},scrollTo(){},InsightAuth:{screen(){return '<section class="signed-out-fixture">로그인</section>';},welcome(){return '<p>가입 완료</p>';},policy(){return '<p>정책</p>';}},InsightAnalysis:{stop(){},panel(){return '<p>분석 검수 화면</p>';},mount(){}}};
  const response=value=>({ok:true,status:200,json:async()=>clone(value)});
  const fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;
    calls.push({url,method:options.method||'GET',body});
    if(url==='/api/insight-admin/v1/me')return response({csrfToken:'fixture-admin-csrf'});
    if(url.endsWith('/config'))return response({signupEnabled:true});
    if(url.endsWith('/me')||url.endsWith('/start'))return response(currentState);
    if(url.endsWith('/auth/logout'))return response({ok:true});
    const companyMatch=url.match(/\/companies\/([^/?]+)\/collection(?:\?.*)?$/);
    if(companyMatch){const company=currentState.companies.find(row=>row.companyId===decodeURIComponent(companyMatch[1]));assert.ok(company,'only registered company fixtures are queried');return response(collectionData(company));}
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
  const collection=window.InsightCollection,originalMount=collection.mount,originalContext=collection.setContext,originalClear=collection.clearCache,originalInvalidate=collection.invalidate;
  collection.mount=(id,api,options)=>{mounted.push({id,options});return originalMount(id,api,options);};
  collection.setContext=(scope,ids,callback)=>{contexts.push({scope,ids:Array.from(ids||[])});return originalContext(scope,ids,callback);};
  collection.clearCache=()=>{clearCalls++;return originalClear();};
  collection.invalidate=id=>{invalidated.push(id);return originalInvalidate(id);};
  vm.runInContext(read('connected.js'),context);await flush();
  async function dispatch(name,event){for(const callback of documentEvents.get(name)||[])await callback(event);await flush();}
  return {calls,mounted,contexts,invalidated,originalCompanies,location,
    html:()=>element('#main').innerHTML,result:()=>document.querySelector('#collection-result')?.innerHTML||'',navigation:()=>element('#navigation').innerHTML,
    state:()=>clone(currentState),clearCount:()=>clearCalls,revision:()=>mainRevision,
    async navigate(value){location.hash=value;windowEvents.get('hashchange')();await flush();},
    async correct(companyId,values){const form={dataset:{correction:companyId},values,querySelectorAll(){return [{disabled:false}];},querySelector(){return null;}};await dispatch('submit',{preventDefault(){},target:form});},
    async logout(){const button={dataset:{action:'logout'},disabled:false};await dispatch('click',{target:{closest(){return button;}}});}};
}

for(const adminView of [false,true]){
  test(`${adminView?'administrator preview':'customer'} initially prepares registered company views using read-only GETs`,async()=>{
    const ui=await screen({adminView}),queries=ui.calls.filter(call=>call.url.includes('/companies/'));
    assert.equal(queries.length,2);assert.match(queries[0].url,/\/companies\/cmp_own\/collection$/);
    assert.match(queries[1].url,/\/companies\/cmp_competitor\/collection$/);
    assert.ok(queries.every(call=>call.method==='GET'&&call.body===null));
    assert.ok(ui.calls.every(call=>call.method==='GET'||adminView&&call.url.endsWith('/customer-view/start')));
    assert.ok(ui.calls.every(call=>!call.url.includes('/crawl')&&!call.url.endsWith('/commands')));
  });
}

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
