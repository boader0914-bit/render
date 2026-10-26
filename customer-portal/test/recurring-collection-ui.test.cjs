'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/connected.js'),'utf8'),adminSource=fs.readFileSync(require.resolve('../web/admin.js'),'utf8');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
const record=(status='pending',extra={})=>({companyId:'cmp_one',companyName:'등록 업체',status,bookingRangeDays:30,...extra});
async function customer({admin=false,records=[],enabled=true,kind='competitor',relationStatus='active'}={}){
 const events={},elements=new Map(),calls=[],keys=[],timers=new Map();let current=null,postError=null,timerId=0;
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,classList:{toggle(){},add(){},remove(){}},focus(){}});return elements.get(selector);};
 const state={csrfToken:'fixture_csrf',customer:{customerId:'cus_fixture',username:'fixture',settings:{},regions:[],entitlements:{competitorLimit:3},relations:[{companyId:'cmp_one',relationId:'rel_one',kind,status:relationStatus}]},companies:[{companyId:'cmp_one',name:'<img src=x onerror=alert(1)>',rooms:10,address:'검수 주소',roomCountSource:'검수값'}],corrections:[],preparations:[],features:{directCollection:false,recurringCollectionRequests:enabled},recurringCollections:records};
 const location={pathname:admin?'/customer-view':'/',hash:'#competitors'};
 const recurringNode={dataset:{recurringCompact:'0'},outerHTML:''};
 vm.runInContext(source,vm.createContext({location,window:{addEventListener(name,fn){events[name]=fn;},scrollTo(){},InsightCollection:{panel(){return'<h2>기본정보 A</h2>';},mount(){}}},document:{querySelector:element,querySelectorAll(selector){return selector.includes('data-recurring-company')?[recurringNode]:[];},body:element('body'),documentElement:{dataset:{}},addEventListener(name,fn){events[name]=fn;}},localStorage:{getItem(){return null;}},crypto:{randomUUID(){const key='fixture_key_'+(keys.length+1);keys.push(key);return key;}},setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout(id){timers.delete(id);},AbortController,
 fetch:async(url,options={})=>{calls.push({url,options});let data=url.endsWith('/config')?{}:state;if(url.endsWith('/recurring-collection')){if(options.method==='POST'){if(postError)throw postError;current=record();}data={recurringCollection:current,recurringCollections:current?[current]:[]};}return{ok:true,status:200,json:async()=>data};}}));
 await flush();return{calls,keys,html:()=>element('#main').innerHTML,state,patched:()=>recurringNode.outerHTML,setCurrent(value){current=value;},setPostError(value){postError=value;},async request(id='cmp_one'){const button={disabled:false,dataset:{action:'recurring-request',company:id}};await events.click({target:{closest(){return button;}}});await flush();},async tick(){const item=[...timers].find(([,value])=>value.delay===60000);if(item){timers.delete(item[0]);await item[1].fn();await flush();}},async navigate(hash){location.hash=hash;events.hashchange();await flush();},toast:()=>element('#toast').textContent};
}
for(const admin of[false,true])test(`${admin?'admin preview':'customer'} registration cards show saved results and an explicit approval request without collecting automatically`,async()=>{
 const h=await customer({admin});assert.match(h.html(),/업체 자료 보기/);assert.match(h.html(),/정기수집 요청/);assert.match(h.html(),/관리자 승인 후 시작/);assert.match(h.html(),/당일 포함 30일/);assert.match(h.html(),/마지막 정기수집 기록 없음/);assert.doesNotMatch(h.html(),/<img src=x/);assert.match(h.html(),/&lt;img/);
 assert.equal(h.calls.some(c=>c.options.method==='POST'),false);
 const previousPage=h.html();await h.request();const recurring=h.calls.filter(c=>c.url.endsWith('/recurring-collection'));
 assert.deepEqual(recurring.map(c=>c.options.method),['GET','POST']);assert.deepEqual(JSON.parse(recurring[1].options.body),{requestKey:'fixture_key_1'});
 assert.match(recurring[1].url,new RegExp(admin?'/insight-admin/v1/customer-view/':'/customer/v1/'));
 assert.equal(recurring[1].options.headers['X-CSRF-Token'],'fixture_csrf');assert.match(h.patched(),/승인 대기 중/);assert.equal(h.html(),previousPage,'request status changes only its own bar; comparison forms, disclosure state and graphs are not rebuilt');
 assert.ok(h.calls.every(c=>!c.url.endsWith('/commands')&&!c.url.endsWith('/crawl')));
});
test('a stale unrequested bootstrap checks fresh approval state before submitting, preventing repeat requests',async()=>{
 const h=await customer(),previousPage=h.html();h.setCurrent(record('approved',{time:'14:00',nextRunAt:'2026-10-27T05:00:00Z',lastCollectedDay:'2026-10-26',shared:true}));await h.request();
 assert.equal(h.calls.filter(c=>c.url.endsWith('/recurring-collection')).length,1);assert.equal(h.calls.some(c=>c.options.method==='POST'),false);
 assert.match(h.patched(),/정기수집 연결됨/);assert.match(h.patched(),/마지막 정기수집 2026-10-26/);assert.match(h.patched(),/하나의 일정|기존 승인 일정/);assert.match(h.patched(),/2026-10-27 14:00/);assert.equal(h.html(),previousPage,'finding an existing request keeps the current comparison view');
});
test('an uncertain POST keeps its request key and rechecks status before a manual retry',async()=>{
 const h=await customer(),previousPage=h.html();h.setPostError(new TypeError('network interrupted'));await h.request();assert.match(h.patched(),/접수 상태 다시 확인/);assert.equal(h.html(),previousPage,'an uncertain submission preserves the current page and open company list');
 h.setPostError(null);await h.request();const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);
 assert.equal(JSON.parse(posts[0].options.body).requestKey,JSON.parse(posts[1].options.body).requestKey);assert.equal(h.keys.length,1);
 assert.deepEqual(h.calls.filter(c=>c.url.endsWith('/recurring-collection')).map(c=>c.options.method),['GET','POST','GET','POST']);assert.match(h.patched(),/승인 대기 중/);assert.equal(h.html(),previousPage);
});
test('a timed-out committed request is found by GET and never posted a second time',async()=>{
 const h=await customer();h.setPostError(new TypeError('response lost'));await h.request();h.setCurrent(record());h.setPostError(null);await h.request();
 assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);assert.match(h.patched(),/승인 대기 중/);assert.doesNotMatch(h.patched(),/접수 상태 다시 확인/);
});
test('paused requests remain paused and cannot be restarted by a customer button',async()=>{
 const h=await customer({records:[record('paused',{reviewReason:'<svg onload=alert(1)>'})]});assert.match(h.html(),/관리자 재개 필요/);assert.doesNotMatch(h.html(),/<svg onload/);
 h.setCurrent(record('paused'));await h.request();assert.equal(h.calls.some(c=>c.options.method==='POST'),false);
});
test('the feature gate and registered-company boundary prevent hidden or other-customer requests',async()=>{
 const off=await customer({enabled:false});assert.doesNotMatch(off.html(),/data-action="recurring-request"/);await off.request();assert.equal(off.calls.some(c=>c.url.endsWith('/recurring-collection')),false);
 const h=await customer({records:[{companyId:'cmp_other_customer',status:'approved',companyName:'another-customer-private-name'}]});await h.request('cmp_other_customer');assert.equal(h.calls.some(c=>c.url.endsWith('/recurring-collection')),false);assert.doesNotMatch(h.html(),/another-customer-private-name/);
});
test('own-company cards and details never expose competitor-only recurring requests',async()=>{
 const h=await customer({kind:'own'});assert.doesNotMatch(h.html(),/data-action="recurring-request"/);await h.request();assert.equal(h.calls.some(c=>c.url.endsWith('/recurring-collection')),false);
 await h.navigate('#company=cmp_one');assert.match(h.html(),/기본정보 A/);assert.doesNotMatch(h.html(),/data-recurring-company|정기수집 요청/);await h.tick();assert.equal(h.calls.some(c=>c.url.endsWith('/recurring-collection')),false);
});
test('a competitor connection still awaiting review cannot request recurring collection',async()=>{
 const h=await customer({relationStatus:'pending'});assert.match(h.html(),/업체 연결 확인 대기/);assert.doesNotMatch(h.html(),/data-action="recurring-request"/);await h.request();assert.equal(h.calls.some(c=>c.url.endsWith('/recurring-collection')),false);
});
test('newly registered competitor detail exposes a compact request bar above the saved company data',async()=>{
 const h=await customer();await h.navigate('#company=cmp_one');assert.match(h.html(),/connected-recurring-compact/);assert.match(h.html(),/정기수집 요청[\s\S]*기본정보 A/);assert.equal(h.calls.some(c=>c.options.method==='POST'),false);
});
test('approved schedule and failed execution remain distinct and status refresh never dispatches a job',async()=>{
 const h=await customer({records:[record('approved')]});h.setCurrent(record('approved',{errorCode:'NAVER_BLOCKED',message:'접근 제한으로 중단했습니다.',latestAttempt:{status:'blocked',runId:'saved_attempt',errorCode:'NAVER_BLOCKED'}}));await h.tick();
 assert.match(h.patched(),/정기수집 승인됨/);assert.match(h.patched(),/접근 제한으로 중단/);assert.match(h.patched(),/NAVER_BLOCKED/);assert.match(h.patched(),/마지막 정기수집 기록 없음/);assert.equal(h.calls.some(c=>c.options.method==='POST'),false);
 await h.navigate('#settings');const count=h.calls.length;await h.tick();assert.equal(h.calls.length,count,'leaving the comparison or detail stops periodic status reads');
});
async function administrator(){
 const events={},elements=new Map(),calls=[],keys=[];let rows=[record('pending',{companyName:'<img src=x onerror=alert(1)>',requestCount:2,requesters:[{username:'<b>client</b>'}],lastCollectedAt:null})],reviewError=null;
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',hidden:false,dataset:{},addEventListener(name,fn){events[selector+':'+name]=fn;}});return elements.get(selector);};
 vm.runInContext(adminSource,vm.createContext({document:{querySelector:element,querySelectorAll(){return[];},documentElement:{dataset:{}}},location:{assign(){}},crypto:{randomUUID(){const key='admin_key_'+(keys.length+1);keys.push(key);return key;}},FormData:class{constructor(f){return Object.entries(f.values);}},fetch:async(url,options)=>{calls.push({url,options});let data=url.endsWith('/me')?{admin:{username:'fixture_admin'},csrfToken:'admin_csrf'}:url.endsWith('/customers')?{customers:[]}:url.endsWith('/recurring-collections/review')?{recurringCollections:rows}:url.endsWith('/recurring-collections')?{recurringCollections:rows}:{};if(url.endsWith('/review')&&reviewError)throw reviewError;return{ok:true,status:200,json:async()=>data};}}));
 await flush();return{calls,keys,html:()=>element('#recurring-list').innerHTML,main:()=>element('#main').innerHTML,setReviewError(value){reviewError=value;},async submit({companyId='cmp_one',decision='approve',reason='운영 검토',time='14:00'}={}){const b={disabled:false},f={id:'',dataset:{recurring:companyId},values:{decision,reason,time},querySelector(){return b;}};await events['#main:submit']({preventDefault(){},target:f});await flush();},feedback:()=>element('#feedback').textContent};
}
test('administrator recurring review lists escaped shared requests and submits approval for the next day',async()=>{
 const h=await administrator();assert.match(h.main(),/정기수집 요청 관리/);assert.match(h.html(),/다음 날부터 매일 1회/);assert.match(h.html(),/요청 2건/);assert.match(h.html(),/마지막 정기수집 기록 없음/);assert.match(h.html(),/value="14:00"/);assert.doesNotMatch(h.html(),/<img src=x|<b>client/);assert.match(h.html(),/&lt;img/);
 await h.submit();const post=h.calls.find(c=>c.url.endsWith('/review'));assert.deepEqual(JSON.parse(post.options.body),{companyId:'cmp_one',decision:'approve',reason:'운영 검토',time:'14:00',requestKey:'admin_key_1'});assert.equal(post.options.headers['X-CSRF-Token'],'admin_csrf');assert.match(h.feedback(),/다음 날부터 적용/);
});
test('administrator retry preserves the same review key and rejects companies outside the current list',async()=>{
 const h=await administrator();h.setReviewError(new TypeError('response lost'));await h.submit();h.setReviewError(null);await h.submit();
 const posts=h.calls.filter(c=>c.url.endsWith('/review'));assert.equal(posts.length,2);assert.equal(JSON.parse(posts[0].options.body).requestKey,JSON.parse(posts[1].options.body).requestKey);assert.equal(h.keys.length,1);
 await h.submit({companyId:'cmp_other'});assert.equal(h.calls.filter(c=>c.url.endsWith('/review')).length,2);assert.match(h.feedback(),/현재 요청 목록/);
});
