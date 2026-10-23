'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const script=fs.readFileSync(require.resolve('../web/connected.js'),'utf8');
const earlyScript=fs.readFileSync(require.resolve('../web/bootstrap-read.js'),'utf8');
const auth=require('../web/auth.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const account=()=>({customer:{customerId:'fixture_customer',username:'fixture',revision:1,settings:{},regions:[],relations:[{companyId:'company_one',kind:'competitor',status:'active'}],entitlements:{competitorLimit:3,interestRegionLimit:1}},companies:[{companyId:'company_one',name:'경쟁업체 검수',rooms:30}],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[]});

function harness({admin=false,hash='#company=company_one',early=false}={}) {
  const elements=new Map(),events={},calls=[],timers=new Map(),restored=[],mounted=[];let sequence=0;
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,classList:{add(){},remove(){},toggle(){}},focus(){}});return elements.get(selector);};
  const location={pathname:admin?'/customer-view':'/',hash};
  const window={addEventListener(name,callback){events[name]=callback;},scrollTo(){},InsightAuth:auth,
    InsightCollection:{stop(){},setContext(){},restore(value,scope){restored.push({value,scope});},panel(company){return `<h1>${company.name}</h1>`;},mount(id){mounted.push(id);}},
    InsightAnalysis:{stop(){},configureCache(){},configureReports(){},restore(){},restoreReports(){}},
  };
  const context=vm.createContext({location,window,AbortController,Promise,FormData:class{constructor(form){this.values=form.values;}*[Symbol.iterator](){yield*Object.entries(this.values);}},
    document:{querySelector:element,body:element('body'),documentElement:{dataset:{}},addEventListener(name,callback){events[name]=callback;}},
    localStorage:{getItem(){return null;}},crypto:{randomUUID(){return 'fixture';}},
    setTimeout(callback,delay){const id=++sequence;timers.set(id,{callback,delay});return id;},clearTimeout(id){timers.delete(id);},
    fetch(url,options={}){return new Promise((resolve,reject)=>{const call={url,options,resolve,reject};calls.push(call);options.signal?.addEventListener('abort',()=>{const error=new Error('aborted');error.name='AbortError';reject(error);},{once:true});});},
  });
  if(early)vm.runInContext(earlyScript,context);
  const earlyCalls=calls.length;
  vm.runInContext(script,context);
  const path=name=>admin?(name==='me'?'/api/insight-admin/v1/me':'/api/insight-admin/v1/customer-view/'+name):'/api/customer/v1/'+name;
  const matching=name=>calls.filter(call=>call.url===path(name));
  return {window,context,calls,events,location,mounted,restored,earlyCalls,path,matching,html:()=>element('#main').innerHTML,
    resolve(name,data,status=200,index=-1){matching(name).at(index).resolve(response(data,status));return flush();},
    reject(name,message='network',index=-1){const error=new Error(message);error.name='TypeError';matching(name).at(index).reject(error);return flush();},
    async tick(delay){for(const[id,timer]of[...timers])if(timer.delay===delay){timers.delete(id);timer.callback();}await flush();},
    async action(action){const button={dataset:{action},disabled:false};await events.click({target:{closest(){return button;}}});await flush();},
    async navigate(hash){location.hash=hash;events.hashchange();await flush();},
    async submit(values){const form={id:'auth-form',dataset:{},values,querySelectorAll(){return[];},querySelector(){return null;}};await events.submit({preventDefault(){},target:form});await flush();},
  };
}

test('authenticated company data renders while non-critical configuration is still pending',async()=>{
  const h=harness();await h.resolve('me',account());assert.match(h.html(),/경쟁업체 검수/);assert.deepEqual(h.mounted,['company_one']);
  assert.equal(h.matching('config').length,1);assert.equal(h.matching('me').length,1);
  await h.resolve('config',{signupEnabled:false});assert.deepEqual(h.mounted,['company_one'],'late configuration must not reset a mounted company or start another data load');
  assert.equal(h.calls.filter(call=>call.options.method==='POST').length,0);
});

for(const early of [false,true])test(`${early?'early':'normal'} startup HTML HTTP 503 requires explicit reconnection without repeating successful GETs`,async()=>{
  const h=harness({early});assert.equal(h.earlyCalls,early?2:0);assert.equal(h.matching('me').length,1);assert.equal(h.matching('config').length,1);
  await h.resolve('config',{signupEnabled:false});h.matching('me')[0].resolve({ok:false,status:503,json:async()=>{throw new SyntaxError('html response');}});await flush();
  assert.match(h.html(),/자료 연결 확인이 필요/);assert.match(h.html(),/data-action="retry-connection"/);
  await h.tick(250);assert.equal(h.matching('me').length,1);const retry=h.action('retry-connection');await flush();assert.equal(h.matching('me').length,2);await h.resolve('me',account());await retry;assert.match(h.html(),/경쟁업체 검수/);assert.equal(h.matching('config').length,1);
});

test('configuration HTTP 503 never repeats automatically or replaces already authenticated company content',async()=>{
  const h=harness();await h.resolve('config',{error:{message:'temporary'}},503);await h.resolve('me',account());assert.match(h.html(),/경쟁업체 검수/);
  await h.tick(250);assert.equal(h.matching('config').length,1);assert.match(h.html(),/경쟁업체 검수/);assert.equal(h.mounted.length,1);assert.equal(h.matching('me').length,1);
});

test('a temporary network failure is retried once and recovered without a reload',async()=>{
  const h=harness();await h.resolve('config',{});await h.reject('me');await h.tick(250);await h.resolve('me',account());assert.match(h.html(),/경쟁업체 검수/);assert.equal(h.matching('me').length,2);
});

test('startup timeout aborts its GET without repeating a potentially still-running upstream request',async()=>{
  const h=harness({early:true});await h.resolve('config',{});await h.tick(8000);assert.equal(h.matching('me')[0].options.signal.aborted,true);await h.tick(250);assert.equal(h.matching('me').length,1);
  await h.tick(8000);assert.match(h.html(),/자료 연결 확인이 필요/);assert.match(h.html(),/data-action="retry-connection"/);await h.tick(250);assert.equal(h.matching('me').length,1);
});

test('401 opens login immediately without waiting for settings or retrying authorization',async()=>{
  const h=harness();await h.resolve('me',{error:{message:'login required'}},401);assert.match(h.html(),/id="auth-form"/);assert.doesNotMatch(h.html(),/경쟁업체 검수/);
  await h.tick(250);assert.equal(h.matching('me').length,1);assert.equal(h.restored.length,0);
});

for(const status of [403,404,429])test(`${status} is not retried and cannot expose a protected cached company`,async()=>{
  const h=harness({early:true});await h.resolve('me',{error:{message:'denied'}},status);await h.resolve('config',{});await h.tick(250);
  assert.equal(h.matching('me').length,1);assert.equal(h.restored.length,0);assert.match(h.html(),/자료 연결 확인이 필요/);assert.doesNotMatch(h.html(),/경쟁업체 검수/);
});

test('a null 403 error body preserves authorization failure without retrying',async()=>{
  const h=harness();await h.resolve('config',{});await h.resolve('me',null,403);await h.tick(250);assert.equal(h.matching('me').length,1);assert.equal(h.restored.length,0);assert.match(h.html(),/자료 연결 확인이 필요/);
});

test('a malformed successful bootstrap is an error rather than an expired login or a real zero',async()=>{
  const h=harness();await h.resolve('config',{});await h.resolve('me',null);await h.tick(250);assert.equal(h.matching('me').length,1);assert.equal(h.restored.length,0);assert.match(h.html(),/자료 연결 확인이 필요/);assert.doesNotMatch(h.html(),/id="auth-form"|0실/);
});

for(const status of [408,502,503,504])test(`HTTP ${status} preserves the BFF retry decision and waits for an explicit new GET cycle`,async()=>{
  const h=harness();await h.resolve('config',{});h.matching('me')[0].resolve({...response({error:{message:'temporary'}},status),headers:{get(name){return name.toLowerCase()==='retry-after'?'120':null;}}});await flush();await h.tick(250);
  assert.match(h.html(),/data-action="retry-connection"/);assert.equal(h.matching('me').length,1,'browser must not bypass the BFF retry or Retry-After decision');
  const retry=h.action('retry-connection');await flush();assert.equal(h.matching('me').length,2);await h.resolve('me',account());await retry;assert.match(h.html(),/경쟁업체 검수/);assert.equal(h.matching('config').length,1);
});

test('malformed HTTP 200 JSON remains an explicit connection error without an automatic repeat',async()=>{
  const h=harness();await h.resolve('config',{});h.matching('me')[0].resolve({ok:true,status:200,json:async()=>{throw new SyntaxError('html');}});await flush();await h.tick(250);assert.equal(h.matching('me').length,1);assert.match(h.html(),/자료 연결 확인이 필요/);assert.equal(h.restored.length,0);
});

test('signup never assumes unavailable policy settings and uses actual returned versions',async()=>{
  const h=harness({hash:'#signup'});await h.resolve('me',{error:{}},401);assert.match(h.html(),/회원가입·이용 안내 설정/);assert.doesNotMatch(h.html(),/id="auth-form"/);
  await h.submit({username:'fixture',password:'real-fixture',passwordConfirm:'real-fixture'});assert.equal(h.calls.some(call=>call.url.endsWith('/auth/signup')),false);
  await h.resolve('config',{signupEnabled:true,termsVersion:'terms_actual',privacyVersion:'privacy_actual'});assert.match(h.html(),/동의하고 회원가입/);
  const submit=h.submit({username:'fixture',password:'real-fixture',passwordConfirm:'real-fixture',agreeTerms:'on',agreePrivacy:'on',confirmAge:'on'});await flush();
  const signup=h.calls.find(call=>call.url.endsWith('/auth/signup'));assert.ok(signup);assert.equal(JSON.parse(signup.options.body).termsVersion,'terms_actual');assert.equal(JSON.parse(signup.options.body).privacyVersion,'privacy_actual');
  signup.resolve(response(account(),503));await submit;assert.equal(h.calls.filter(call=>call.url.endsWith('/auth/signup')).length,1,'failed signup POST must never retry');
});

test('policy documents stay blocked until configuration is verified and then load normally',async()=>{
  const h=harness({hash:'#terms'});await h.resolve('me',{error:{}},401);assert.match(h.html(),/회원가입·이용 안내 설정/);assert.equal(h.calls.some(call=>call.url.includes('/policies/')),false);
  await h.resolve('config',{termsVersion:'actual'});const policy=h.calls.find(call=>call.url.endsWith('/policies/terms'));assert.ok(policy);policy.resolve(response({title:'실제 약관',version:'actual',sections:[]}));await flush();assert.match(h.html(),/실제 약관/);
});

test('configuration failure offers an explicit retry while signup remains unavailable',async()=>{
  const h=harness({hash:'#signup'});await h.resolve('me',{error:{}},401);await h.resolve('config',{error:{message:'temporary'}},503);await h.tick(250);assert.equal(h.matching('config').length,1);
  assert.match(h.html(),/retry-config/);assert.doesNotMatch(h.html(),/id="auth-form"/);await h.action('retry-config');assert.equal(h.matching('config').length,2);await h.resolve('config',{signupEnabled:true});assert.match(h.html(),/동의하고 회원가입/);
});

test('admin early startup uses its own identity and configuration paths and starts exactly once',async()=>{
  const h=harness({admin:true,early:true});assert.equal(h.earlyCalls,2);assert.equal(h.matching('me').length,1);assert.equal(h.matching('config').length,1);
  await h.resolve('me',{csrfToken:'fixture_admin'});assert.equal(h.matching('start').length,1);assert.equal(h.matching('start')[0].options.method,'POST');
  await h.resolve('start',account());assert.match(h.html(),/경쟁업체 검수/);await h.resolve('config',{});assert.equal(h.matching('start').length,1);assert.equal(h.calls.some(call=>call.url.startsWith('/api/customer/')),false);
});

test('admin start failures never repeat POSTs automatically',async()=>{
  const h=harness({admin:true,early:true});await h.resolve('config',{});await h.resolve('me',{csrfToken:'fixture_admin'});await h.resolve('start',{error:{message:'temporary'}},503);await h.tick(250);
  assert.match(h.html(),/자료 연결 확인이 필요/);assert.equal(h.matching('start').length,1);assert.equal(h.restored.length,0);
});

test('the early reader is page-scoped, once-only and runs before styles and deferred UI assets',()=>{
  const html=fs.readFileSync(require.resolve('../web/connected.html'),'utf8');assert.ok(html.indexOf('/bootstrap-read.js')<html.indexOf('/styles.css'));assert.ok(html.indexOf('/bootstrap-read.js')<html.indexOf('/connected.js'));assert.match(html,/<script src="\/bootstrap-read\.js"><\/script>/);
  const h=harness({early:true});assert.equal(h.earlyCalls,2);assert.equal(h.window.InsightBootstrapReads.take(h.path('me')),undefined,'connected.js already consumed the exact pending identity read');assert.equal(h.window.InsightBootstrapReads.take(h.path('config')),undefined);
  assert.doesNotMatch(earlyScript,/localStorage|sessionStorage|csrfToken|POST|INSIGHT_SERVICE_TOKEN/);
});
