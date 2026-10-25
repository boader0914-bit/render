'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/collection.js'),'utf8');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};

function harness() {
  let now=Date.parse('2026-10-13T02:00:00Z'),protectedForm=null,present=true;
  const calls=[],events={},renders=[],renderData=[],marks=[],storage=new Map(),timers=new Map();let nextTimer=0;
  const elements=new Map();
  for(const key of ['#collection-result','#collection-progress','#collection-freshness','#collection-allowance','#company-current-view','#company-history-flow','#company-flow-details','#collection-settings','[data-collect] button[type=submit]'])elements.set(key,{innerHTML:'',textContent:'',disabled:true,dataset:{ready:'true'},children:[],append(node){this.children.push(node);},setAttribute(key,value){this[key]=value;}});
  const window={InsightPerformance:{markFirst(name){marks.push(name);}},InsightCompanyView:{render(data,options){const value=[data.companyDetail?.basics?.companyId,data.companyDetail?.integrated?.selectedMonth,data.result?.version].join('|');renders.push(value);renderData.push({data,options});return value;},currentView:()=>'',flowView:()=>''}};
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const document={hidden:false,addEventListener:(type,fn)=>events[type]=fn,querySelector(selector){if(!present&&selector.startsWith('#collection-'))return null;if(selector.includes('form'))return selector.includes(':focus-within')||protectedForm?.dataset.dirty?protectedForm:null;return elements.get(selector)||null;},querySelectorAll:()=>[],createElement:()=>({textContent:'',className:''}),get activeElement(){return protectedForm?{closest:()=>protectedForm}:null;}};
  vm.runInContext(source,vm.createContext({window,document,Date:ClockDate,localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},setTimeout(fn,ms){timers.set(++nextTimer,{fn,ms});return nextTimer;},clearTimeout:id=>timers.delete(id)}));
  const api=(path,_data,options)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject,options}));
  const result=()=>elements.get('#collection-result').innerHTML;
  const freshness=()=>elements.get('#collection-freshness').textContent+' '+elements.get('#collection-freshness').innerHTML;
  return {collection:window.InsightCollection,calls,renders,renderData,marks,elements,timers,result,freshness,storedKeys:()=>[...storage.keys()],
    context(scope='customer-one',ids=['a','b']){window.InsightCollection.setContext(scope,ids);},
    mount(id='a',options){present=true;elements.get('#collection-result').innerHTML='loading';elements.get('#collection-progress').innerHTML='';elements.get('#collection-freshness').textContent='';window.InsightCollection.mount(id,api,options);},
    leave(){window.InsightCollection.stop();present=false;},
    month(value){const target={value,matches:selector=>selector==='[data-company-month]'};events.change({target});return target;},
    protect(value=true){protectedForm=value?{dataset:value==='focused'?{}:{dirty:'true'},matches:()=>true}:null;},
    advance(ms){now+=ms;},
    async poll(){const next=timers.entries().next().value;assert.ok(next,'expected background poll');timers.delete(next[0]);next[1].fn();await flush();},
    async resolve(index,data){await flush();assert.ok(calls[index],'expected request '+index);calls[index].resolve(data);await flush();},
    async reject(index,status,message='저장 자료를 확인할 수 없습니다.'){await flush();assert.ok(calls[index],'expected request '+index);const error=new Error(message);error.status=status;error.statusCode=status;calls[index].reject(error);await flush();}
  };
}
function data(id='a',month='2026-10',version='v1',canRequest=true) {
  return {collectionAllowance:{limit:1,canRequest,resetsAt:'2026-10-13T15:00:00Z'},request:null,result:{version,runId:'run-'+version,products:[{key:'room-'+version,name:'객실',productType:'lodging',days:[],original:[]}]},companyDetail:{basics:{companyId:id},integrated:{selectedMonth:month,status:'ready'}}};
}
function restored(id='a',month='',version='bootstrap',checkedAt='2026-10-13T01:59:00Z'){
  return {companyId:id,month,data:{...data(id,month||'2026-10',version),responseCache:{state:'cached',checkedAt,refreshing:false,refreshFailed:false}}};
}
function persisted(id='a',month='',version='persisted',checkedAt='2026-10-13T00:00:00Z'){
  const row=restored(id,month,version,checkedAt);
  Object.assign(row.data.responseCache,{persisted:true,revalidationRequired:true,validUntil:new Date(Date.parse(checkedAt)+7*24*60*60*1000).toISOString()});
  return row;
}

test('first-data performance marking excludes the basic catalog seed until real data is rendered on the current route',async()=>{
  const h=harness();h.context();h.mount('a',{company:{companyId:'a',name:'temporary basic seed'},isCurrentView:()=>true});assert.deepEqual(h.marks,[]);
  await h.resolve(0,data());assert.deepEqual(h.marks,['insight-company-data-ready']);assert.equal(h.result(),'a|2026-10|v1');
});

test('switching to an uncached month retains only the same company A/B and clears every prior C value',async()=>{
  const h=harness();h.context();h.mount('a');const october=data();
  october.companyDetail.basics.name='업체 A';october.companyDetail.channels=[{label:'A 네이버'}];
  october.companyDetail.current={summary:{sold:16,estimatedRevenue:4904000},daily:[{date:'2026-10-01',sold:16,estimatedRevenue:4904000}]};
  await h.resolve(0,october);h.month('2026-09');
  const shell=h.renderData.at(-1).data;
  assert.equal(shell.companyDetail.basics.name,'업체 A');assert.equal(shell.companyDetail.channels[0].label,'A 네이버');assert.equal(shell.result.products[0].key,'room-v1');
  assert.equal(shell.referenceCatalogReady,true);assert.equal(shell.referenceLoading,true);assert.equal(shell.companyDetail.integrated.selectedMonth,'2026-09');
  assert.equal(shell.companyDetail.integrated.snapshot,null);assert.equal(shell.companyDetail.current.summary,null);assert.equal(shell.companyDetail.current.daily.length,0);assert.equal(shell.result.runId,undefined);
  assert.doesNotMatch(JSON.stringify(shell.companyDetail.current),/4904000|2026-10-01/);
  const september={...data('a','2026-09'),result:null,referenceLoading:true,calculation:{mode:'saved_only',status:'pending'},responseCache:{state:'preview',refreshing:true},companyDetail:{companyId:'a',basics:{companyId:'a'},integrated:{selectedMonth:'2026-09',status:'ready',snapshot:{}},current:{summary:{sold:2,estimatedRevenue:100000},daily:[{date:'2026-09-01',publicBookings:2,phoneBookings:0,estimatedRevenue:100000}]}}};
  await h.resolve(1,september);const shown=h.renderData.at(-1).data;
  assert.equal(shown.companyDetail.basics.name,'업체 A');assert.equal(shown.companyDetail.channels[0].label,'A 네이버');assert.equal(shown.result.products[0].key,'room-v1');
  assert.equal(shown.companyDetail.current.daily[0].date,'2026-09-01');assert.equal(shown.companyDetail.current.summary.estimatedRevenue,100000);
  assert.match(h.freshness(),/저장 자료 표시 · 최신 자료 확인 중/);assert.equal([...h.timers.values()][0].ms,5000);
  h.leave();h.mount('b',{company:{companyId:'b',name:'업체 B'}});assert.doesNotMatch(JSON.stringify(h.renderData.at(-1)?.data),/업체 A|A 네이버/);
});

test('a matching saved month preview marks visible observations, never a pending A/B reference shell',async()=>{
  const h=harness();h.context();h.mount('a',{company:{companyId:'a',name:'업체 A'},isCurrentView:()=>true});assert.deepEqual(h.marks,[]);
  const saved=data();saved.result=null;saved.referenceLoading=true;saved.calculation={mode:'saved_only',status:'pending'};saved.responseCache={state:'preview',refreshing:true};
  saved.companyDetail.current={summary:{sold:0,estimatedRevenue:0},daily:[{date:'2026-10-01',publicBookings:0,phoneBookings:0,estimatedRevenue:0,missing:false}]};
  await h.resolve(0,saved);assert.deepEqual(h.marks,['insight-company-data-ready']);
});

test('an authorized restored snapshot marks actual DOM readiness without waiting for its follow-up GET',()=>{
  const h=harness();h.context();h.collection.restore([persisted()],'customer-one');h.mount('a',{isCurrentView:()=>true});
  assert.equal(h.result(),'a|2026-10|persisted');assert.deepEqual(h.marks,['insight-company-data-ready']);assert.equal(h.calls.length,1);
});

test('off-route, rejected or late offscreen company responses never emit a visible-data performance mark',async()=>{
  const offRoute=harness();offRoute.context();offRoute.mount('a',{isCurrentView:()=>false});await offRoute.resolve(0,data());assert.deepEqual(offRoute.marks,[]);
  const denied=harness();denied.context();denied.mount('a',{isCurrentView:()=>true});await denied.reject(0,403);assert.deepEqual(denied.marks,[]);
  const departed=harness();departed.context();departed.mount('a',{isCurrentView:()=>true});departed.leave();await departed.resolve(0,data());assert.deepEqual(departed.marks,[]);
});

test('fresh authenticated bootstrap restores the saved company immediately while a new permission read remains pending',async()=>{
  const h=harness();h.context();const bootstrap=restored();
  h.collection.restore([bootstrap],'customer-one');bootstrap.data.result.version='mutated-response';
  h.mount();assert.equal(h.result(),'a|2026-10|bootstrap');assert.equal(h.calls.length,1);
  assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true,'a restored quota must not authorize collection');
  assert.match(h.freshness(),/확인/);assert.deepEqual(h.storedKeys(),[],'private snapshots stay out of browser storage');
  await h.resolve(0,data('a','2026-10','server-fresh'));
  assert.equal(h.result(),'a|2026-10|server-fresh');
  h.collection.restore([restored('a','','older-bootstrap')],'customer-one');h.leave();h.mount();
  assert.equal(h.result(),'a|2026-10|server-fresh','a later restore cannot replace a view already checked in this page');
});

test('restoration orders server snapshots by check time and keeps a newer explicit month for the default alias',()=>{
  const h=harness();h.context();
  h.collection.restore([restored('a','','old-default','2026-10-13T01:58:00Z'),restored('a','2026-10','new-month','2026-10-13T01:59:00Z')],'customer-one');
  h.mount();assert.equal(h.result(),'a|2026-10|new-month');
});

test('a late default snapshot cannot copy an already loaded different month into its explicit month alias',async()=>{
  for(const [currentMonth,lateMonth] of [['2026-10','2026-09'],['2026-09','2026-10']]){
    const h=harness();h.context();h.mount();await h.resolve(0,data('a',currentMonth,'current-view'));
    const late=restored('a','','late-bootstrap');late.data.companyDetail.integrated.selectedMonth=lateMonth;
    h.collection.restore([late],'customer-one');h.leave();h.mount();
    assert.equal(h.result(),`a|${currentMonth}|current-view`,'the existing default entry must remain unchanged');
    h.month(lateMonth);assert.equal(h.result(),`a|${lateMonth}|late-bootstrap`,'the new alias must contain the matching month from bootstrap');
    assert.ok(h.calls.at(-1).path.endsWith('?month='+lateMonth));
    h.month(currentMonth);assert.equal(h.result(),`a|${currentMonth}|current-view`,'the live month must also retain its original explicit alias');
  }
});

test('an explicitly restored past month is not presented as the automatic default month',()=>{
  const h=harness();h.context();h.collection.restore([restored('a','2026-09','september')],'customer-one');
  h.mount();assert.match(h.result(),/불러옵|loading/);h.month('2026-09');assert.equal(h.result(),'a|2026-09|september');
});

test('restoration requires the current explicit account scope and a permitted company',()=>{
  const h=harness();h.context();
  h.collection.restore([restored()]);h.collection.restore([restored()],'other-account');h.collection.restore([restored('private')],'customer-one');
  h.mount();assert.match(h.result(),/불러옵|loading/);
  h.context('customer-two');h.collection.restore([restored()],'customer-one');h.leave();h.mount();
  assert.match(h.result(),/불러옵|loading/,'a former account snapshot cannot enter the new account scope');
});

test('denied and removed registrations cannot be restored by replaying bootstrap data',async()=>{
  const h=harness();h.context();h.mount();await h.reject(0,403);
  h.collection.restore([restored()],'customer-one');h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
  const removed=harness();removed.context();removed.collection.restore([restored()],'customer-one');
  removed.context('customer-one',['b']);removed.context();removed.collection.restore([restored()],'customer-one');
  removed.mount();assert.match(removed.result(),/불러옵|loading/,'registration removal invalidates the old bootstrap generation');
});

test('malformed, stale, mismatched and active snapshots do not restore apparent complete data',()=>{
  const wrongCompany=restored();wrongCompany.data.companyDetail.basics.companyId='other-company';
  const wrongMonth=restored('a','2026-09');wrongMonth.data.companyDetail.integrated.selectedMonth='2026-10';
  const active=restored();active.data.request={status:'collecting'};
  const pending=restored();pending.data.companyDetail.integrated.status='pending';
  const missingStamp=restored();delete missingStamp.data.responseCache.checkedAt;
  for(const snapshot of [null,{},wrongCompany,wrongMonth,active,pending,missingStamp,restored('a','2026-99'),restored('a','','expired','2026-10-13T01:00:00Z'),restored('a','','future','2026-10-13T02:02:00Z')]){
    const h=harness();h.context();h.collection.restore([snapshot],'customer-one');h.mount();
    assert.match(h.result(),/불러옵|loading/,'an unusable snapshot must remain unconfirmed');
  }
});

test('server reuse displays saved data while waiting for a bounded background freshness check',async()=>{
  const h=harness();h.context();h.mount();
  await h.resolve(0,{...data(),responseCache:{state:'cached',refreshing:true,checkedAt:'2026-10-13T01:59:00Z'}});
  assert.equal(h.result(),'a|2026-10|v1');assert.match(h.freshness(),/저장 자료 표시 · 최신 자료 확인 중/);assert.doesNotMatch(h.freshness(),/최신 자료 확인 완료/);
  assert.equal([...h.timers.values()][0].ms,5000);
  await h.poll();await h.resolve(1,{...data('a','2026-10','v2'),responseCache:{state:'fresh'}});
  assert.equal(h.result(),'a|2026-10|v2');assert.match(h.freshness(),/최신 자료 확인 완료/);assert.equal(h.timers.size,0);
});

test('a failed server refresh retains saved quantities, reports uncertainty and does not retry in a loop',async()=>{
  const h=harness();h.context();h.mount();
  await h.resolve(0,{...data(),responseCache:{state:'cached',refreshing:false,refreshFailed:true}});
  assert.equal(h.result(),'a|2026-10|v1');assert.match(h.freshness(),/최신 확인 실패/);
  assert.match(h.elements.get('#collection-progress').innerHTML,/저장 자료를 표시/);assert.equal(h.timers.size,0);
});

test('a slow server refresh stops automatic checks after 24 polls and keeps the saved result',async()=>{
  const h=harness();h.context();h.mount();
  const saved={...data(),responseCache:{state:'cached',refreshing:true}};
  await h.resolve(0,saved);
  for(let index=1;index<=24;index++){await h.poll();await h.resolve(index,saved);}
  assert.equal(h.calls.length,25);assert.equal(h.timers.size,0);assert.equal(h.result(),'a|2026-10|v1');
  assert.match(h.elements.get('#collection-progress').innerHTML,/확인에 시간이 걸리고/);
});

test('explicit refresh bypasses an ordinary in-flight GET without letting its late response overwrite the new view',async()=>{
  const h=harness();h.context();h.mount();
  const pending=h.collection.refresh();assert.equal(h.calls.length,2);assert.equal(h.calls[1].options.refresh,true);
  await h.resolve(1,data('a','2026-10','new'));await pending;
  await h.resolve(0,data('a','2026-10','old'));assert.equal(h.result(),'a|2026-10|new');
  h.leave();h.mount();assert.equal(h.result(),'a|2026-10|new');
});

test('returning to a company shows its saved view immediately, then checks current permission and fresh data',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());assert.equal(h.result(),'a|2026-10|v1');
  h.leave();h.mount();
  assert.equal(h.result(),'a|2026-10|v1','menu reentry must render synchronously without waiting for GET');
  assert.equal(h.calls.length,2,'reentry still verifies the server in the background');
  assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true,'cached allowance must not authorize collection');
  assert.match(h.freshness(),/확인/);
  await h.resolve(1,data('a','2026-10','v2',false));assert.equal(h.result(),'a|2026-10|v2');assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);
  assert.match(h.freshness(),/확인/);
});

test('each company restores its selected stay month and shares the default response with the explicit month',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());
  h.month('2026-10');assert.equal(h.result(),'a|2026-10|v1','server-selected month should have a reusable alias');
  await h.resolve(1,data('a','2026-10','v2'));
  h.month('2026-09');assert.match(h.calls[2].path,/\?month=2026-09$/);await h.resolve(2,data('a','2026-09','sept'));
  h.leave();h.mount('b');assert.match(h.result(),/불러옵|loading/,'company B must not show company A');await h.resolve(3,data('b','2026-08','b1'));
  h.month('2026-07');await h.resolve(4,data('b','2026-07','b2'));
  h.leave();h.mount('a');assert.equal(h.result(),'a|2026-09|sept');assert.match(h.calls[5].path,/\?month=2026-09$/);
  h.leave();h.mount('b');assert.equal(h.result(),'b|2026-07|b2');assert.match(h.calls[6].path,/\?month=2026-07$/);
});

test('changing to an uncached month keeps only that company API month choices and restores per-month cached data',async()=>{
  const h=harness();h.context();h.mount('a',{company:{companyId:'a',name:'내 매장'}});
  const october=data('a','2026-10','october');october.companyDetail.integrated.months=[{month:'2026-10',status:'missing'},{month:'2026-09',status:'complete'}];await h.resolve(0,october);
  h.month('2026-09');assert.match(h.calls[1].path,/\?month=2026-09$/);let options=h.renderData.at(-1).options;assert.equal(options.selectedMonth,'2026-09');assert.equal(options.months.map(row=>row.month).join(','),'2026-10,2026-09');
  const september=data('a','2026-09','september');september.companyDetail.integrated.months=october.companyDetail.integrated.months;await h.resolve(1,september);
  h.month('2026-10');assert.equal(h.result(),'a|2026-10|october');assert.match(h.freshness(),/이전 조회 자료.*확인 중/);h.month('2026-09');assert.equal(h.result(),'a|2026-09|september');
  h.leave();h.mount('b',{company:{companyId:'b',name:'경쟁업체'},relationKind:'competitor'});assert.equal(h.renderData.at(-1).options.months.length,0,'another company must not inherit the first month catalog');
  const other=data('b','2026-08','other');other.companyDetail.integrated.months=[{month:'2026-08',status:'complete'}];await h.resolve(4,other);h.month('2026-08');assert.equal(h.result(),'b|2026-08|other');assert.equal(h.renderData.at(-1).options.months[0].month,'2026-08');
  await h.resolve(2,data('a','2026-10','late-october'));await h.resolve(3,september);assert.equal(h.result(),'b|2026-08|other');h.leave();h.mount('a',{company:{companyId:'a'}});assert.equal(h.result(),'a|2026-09|september');assert.match(h.calls.at(-1).path,/\?month=2026-09$/);
});

test('malformed month selection makes no request and cannot replace the remembered selected month',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());h.month('2026-13');h.month('../private');assert.equal(h.calls.length,1);h.leave();h.mount();assert.equal(h.calls[1].path,'/companies/a/collection');
});

test('reentering during one pending request shares the GET and delivers its result to the current view',async()=>{
  const h=harness();h.context();h.mount();h.leave();h.mount();assert.equal(h.calls.length,1);
  await h.resolve(0,data());assert.equal(h.result(),'a|2026-10|v1');
});

test('a normal response finishing after navigation can be reused when the same account returns',async()=>{
  const h=harness();h.context();h.mount('a');h.leave();h.mount('b');await h.resolve(0,data('a','2026-10','away'));assert.match(h.result(),/불러옵|loading/);
  await h.resolve(1,data('b','2026-10','b1'));h.leave();h.mount('a');assert.equal(h.result(),'a|2026-10|away');
});

test('an earlier month response or error never overwrites the newly selected month',async()=>{
  const h=harness();h.context();h.mount();h.month('2026-09');await h.resolve(1,data('a','2026-09','selected'));
  await h.reject(0,500,'이전 월 오류');assert.equal(h.result(),'a|2026-09|selected');assert.doesNotMatch(h.elements.get('#collection-progress').innerHTML,/이전 월 오류/);
  h.month('2026-08');h.month('2026-07');await h.resolve(3,data('a','2026-07','newer'));await h.resolve(2,data('a','2026-08','older'));assert.equal(h.result(),'a|2026-07|newer');
});

test('a failed background check preserves the previous good result and leaves collection disabled',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());h.leave();h.mount();await h.reject(1,503,'서버 연결 지연');
  assert.equal(h.result(),'a|2026-10|v1');assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);assert.match(h.freshness(),/유지|이전/);
  h.leave();h.mount();assert.equal(h.result(),'a|2026-10|v1','error must never replace a successful cache entry');
});

test('changing customer scope discards former account data and its late pending responses',async()=>{
  const h=harness();h.context('customer-one');h.mount();await h.resolve(0,data('a','2026-10','private-one'));h.month('2026-09');
  h.context('customer-two');h.mount();assert.match(h.result(),/불러옵|loading/);assert.equal(h.calls.length,3);
  await h.resolve(1,data('a','2026-09','late-private-one'));await h.resolve(2,data('a','2026-10','private-two'));assert.equal(h.result(),'a|2026-10|private-two');
  h.month('2026-09');assert.doesNotMatch(h.result(),/private-one/,'old account month must not be restored');assert.equal(h.calls.length,4);
});

test('late authentication failure from a previous account cannot clear the new account view or cache',async()=>{
  const h=harness();h.context('customer-one');h.mount();h.context('customer-two');h.mount();await h.resolve(1,data('a','2026-10','new-account'));await h.reject(0,401,'이전 계정 로그인 만료');
  assert.equal(h.result(),'a|2026-10|new-account');h.leave();h.mount();assert.equal(h.result(),'a|2026-10|new-account');
});

test('removing a registered company or invalidating it removes its cached result',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());h.leave();h.context('customer-one',['b']);h.context('customer-one',['a','b']);h.mount();assert.match(h.result(),/불러옵|loading/);
  await h.resolve(1,data('a','2026-10','re-added'));h.collection.invalidate('a');h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
});

test('clearCache invalidates pending responses as well as settled data',async()=>{
  const h=harness();h.context();h.mount();h.collection.clearCache();h.leave();h.mount();assert.equal(h.calls.length,2,'a cleared in-flight request is not shared');
  await h.resolve(0,data('a','2026-10','before-clear'));assert.match(h.result(),/불러옵|loading/);await h.resolve(1,data('a','2026-10','after-clear'));assert.equal(h.result(),'a|2026-10|after-clear');
});

test('401 removes all cached company data and 403 or 404 removes the denied company view',async()=>{
  const h=harness();h.context();h.mount('a');await h.resolve(0,data());h.leave();h.mount('b');await h.resolve(1,data('b','2026-10','b1'));h.leave();h.mount('a');await h.reject(2,401,'로그인이 필요합니다.');
  assert.doesNotMatch(h.result(),/a\|2026-10\|v1/);h.leave();h.mount('b');assert.match(h.result(),/불러옵|loading/,'401 clears other company caches too');await h.resolve(3,data('b','2026-10','b2'));
  for(const status of [403,404]){h.leave();h.mount('b');assert.equal(h.result(),'b|2026-10|b2');await h.reject(h.calls.length-1,status,'업체 조회 권한이 없습니다.');assert.doesNotMatch(h.result(),/b\|2026-10\|b2/);h.leave();h.mount('b');assert.match(h.result(),/불러옵|loading/);await h.resolve(h.calls.length-1,data('b','2026-10','b2'));}
});

test('background replacement preserves the open correction form and the result version used by its payload',async()=>{
  const h=harness();h.context();h.mount();const first=data();first.request={status:'collecting',submittedAt:'2026-10-13T02:00:00Z'};await h.resolve(0,first);h.protect();await h.poll();await h.resolve(1,data('a','2026-10','v2'));
  assert.equal(h.result(),'a|2026-10|v1');const correction=h.collection.correction(0,{total:'',productType:'lodging',date:'2026-10-13',reason:'작성 중'});assert.equal(correction.baseVersion,'v1');assert.equal(correction.target.productKey,'room-v1');
  h.protect(false);h.leave();h.mount();assert.equal(h.result(),'a|2026-10|v2','fresh data remains cached for a later clean view');
});

test('a focused correction form also survives a background refresh and dirty edits block stay-month changes',async()=>{
  const h=harness();h.context();h.mount();const first=data();first.request={status:'collecting',submittedAt:'2026-10-13T02:00:00Z'};await h.resolve(0,first);h.protect('focused');await h.poll();await h.resolve(1,data('a','2026-10','v2'));assert.equal(h.result(),'a|2026-10|v1');
  h.protect();const changed=h.month('2026-09');assert.equal(changed.value,'2026-10');assert.equal(h.calls.length,2);assert.equal(h.result(),'a|2026-10|v1');assert.match(h.elements.get('#collection-progress').innerHTML,/작성 중/);
});

test('a response for a removed company cannot repopulate the cache after registration is restored',async()=>{
  const h=harness();h.context();h.mount('a');h.leave();h.context('customer-one',['b']);await h.resolve(0,data('a','2026-10','removed-company'));h.context();h.mount('a');assert.match(h.result(),/불러옵|loading/);assert.equal(h.calls.length,2);
});

test('removing and restoring registration while a GET is pending starts a new request and rejects the former response',async()=>{
  const h=harness();h.context();h.mount('a');h.context('customer-one',['b']);h.context();h.mount('a');
  assert.equal(h.calls.length,2,'a request from before registration removal must not be shared');
  await h.resolve(0,data('a','2026-10','before-removal'));assert.doesNotMatch(h.result(),/before-removal/);
  await h.resolve(1,data('a','2026-10','restored'));assert.equal(h.result(),'a|2026-10|restored');
  h.leave();h.mount('a');assert.equal(h.result(),'a|2026-10|restored','only the response for the restored registration may be cached');
});

test('a late 401 for the current account clears every cache and current company data after navigation',async()=>{
  const h=harness();h.context();h.mount('a');h.leave();h.mount('b');await h.resolve(1,data('b','2026-10','visible-before-expiry'));
  await h.reject(0,401,'로그인이 만료되었습니다.');assert.doesNotMatch(h.result(),/visible-before-expiry/,'an account-wide expiry applies to the current screen too');
  assert.match(h.result()+' '+h.freshness(),/로그인|권한/);h.leave();h.mount('b');assert.match(h.result(),/불러옵|loading/,'the expired account cache must not restore company B');
});

for(const status of [403,404])test('an offscreen '+status+' removes only the denied company and preserves another company response',async()=>{
  const h=harness();h.context();h.mount('a');await h.resolve(0,data('a','2026-10','cached-a'));h.leave();h.mount('a');h.leave();h.mount('b');
  await h.reject(1,status,'업체 A 조회 권한이 없습니다.');await h.resolve(2,data('b','2026-10','current-b'));assert.equal(h.result(),'b|2026-10|current-b','company A invalidation must not cancel company B in flight');
  h.leave();h.mount('a');assert.match(h.result(),/불러옵|loading/,'the denied company cache must be removed even when its screen is closed');
  h.leave();h.mount('b');assert.equal(h.result(),'b|2026-10|current-b','another company cache remains usable');
});

for(const status of [403,404])test('a late '+status+' for another month removes the current view of the same denied company',async()=>{
  const h=harness();h.context();h.mount('a');h.month('2026-09');await h.resolve(1,data('a','2026-09','visible-september'));
  await h.reject(0,status,'업체 A 조회 권한이 없습니다.');assert.doesNotMatch(h.result(),/visible-september/,'company access denial applies to all stay months of the current company');
  assert.match(h.result()+' '+h.freshness(),/등록|권한/);assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);
  h.leave();h.mount('a');assert.match(h.result(),/불러옵|loading/,'the denied month result must not be restored from cache');assert.equal(h.calls.length,3);
});

test('expired data is not rendered as a cached result and the cache evicts the least recently used month',async()=>{
  const h=harness();h.context();h.mount();await h.resolve(0,data());h.advance(30*60*1000+1);h.leave();h.mount();assert.doesNotMatch(h.result(),/a\|2026-10\|v1/);await h.resolve(1,data());
  h.collection.clearCache();
  const months=Array.from({length:25},(_,i)=>(2024+Math.floor(i/12))+'-'+String(i%12+1).padStart(2,'0'));
  for(const month of months.slice(0,24)){h.month(month);await h.resolve(h.calls.length-1,data('a',month));}
  h.month(months[0]);assert.equal(h.result(),'a|'+months[0]+'|v1');await h.resolve(h.calls.length-1,data('a',months[0]));
  h.month(months[24]);await h.resolve(h.calls.length-1,data('a',months[24]));h.month(months[1]);assert.doesNotMatch(h.result(),new RegExp('a\\|'+months[1]+'\\|v1'),'an older unused result must yield to recently used entries');
});

test('login prefetch warms permitted companies serially and shares its request with a mounted seeded view',async()=>{
  const h=harness();h.context('customer-one',['a','b']);
  const companies=[{companyId:'a',name:'저장된 업체 A',rooms:16},{companyId:'b',name:'저장된 업체 B',rooms:8},{companyId:'private',name:'미등록 업체'}];
  const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const batch=h.collection.prefetch(companies,request);
  assert.equal(h.calls.length,1,'only one registered-company read begins at a time');
  h.mount('a', {company:companies[0],editHtml:'<form>업체 수정</form>'});
  assert.equal(h.result(),'a||','basic catalog data renders before historical calculation returns');
  assert.equal(h.calls.length,1,'mount must share login prefetch, not duplicate the expensive read');
  await h.resolve(0,data('a','2026-10','prefetched-a'));
  assert.equal(h.result(),'a|2026-10|prefetched-a');assert.equal(h.calls.length,2);
  const current=h.result();await h.resolve(1,data('b','2026-10','prefetched-b'));await batch;
  assert.equal(h.result(),current,'offscreen prefetch never overwrites the mounted company');
  h.leave();h.mount('b');assert.equal(h.result(),'b|2026-10|prefetched-b');
  assert.ok(h.calls.every(call=>!call.path.includes('private')&&call.path.startsWith('/companies/')&&call.path.endsWith('/collection')),'reads only: no crawler or unregistered-company request');
});

test('prefetch seed preserves unknown room counts and renders editing HTML through mount options',async()=>{
  const h=harness();h.context();h.mount('a',{company:{companyId:'a',name:'방 정보 대기',rooms:null},editHtml:'<form>수정 도구</form>'});
  assert.equal(h.result(),'a||');
  assert.equal(h.renderData.at(-1).data.referenceLoading,true);
  assert.equal(h.renderData.at(-1).data.companyDetail.basics.rooms,null);
  assert.equal(h.renderData.at(-1).options.editHtml,'<form>수정 도구</form>');
  await h.reject(0,503,'연결 지연');
  assert.equal(h.result(),'a||','a failed historical lookup does not erase authorized catalog basics');
  assert.equal(h.renderData.at(-1).data.referenceLoading,false);assert.equal(h.renderData.at(-1).data.referenceError,true);
});

test('repeated prefetch shares a queued login batch and never replaces a complete cached result with seed data',async()=>{
  const h=harness();h.context();const companies=[{companyId:'a',name:'저장 A',rooms:16},{companyId:'b',name:'저장 B',rooms:8}];
  const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const first=h.collection.prefetch(companies,request),second=h.collection.prefetch(companies,request);
  assert.equal(h.calls.length,1);await h.resolve(0,data());assert.equal(h.calls.length,2);await h.resolve(1,data('b','2026-10','b1'));await Promise.all([first,second]);
  h.mount('a',{company:companies[0]});assert.equal(h.result(),'a|2026-10|v1');
  h.collection.prefetch(companies,request);assert.equal(h.calls.length,3,'only mounted revalidation, no redundant warm reads');
});

test('account changes and registration removal reject prefetched private data and queued reads',async()=>{
  const h=harness();h.context('customer-one',['a','b']);const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const former=h.collection.prefetch([{companyId:'a',name:'이전 비공개 A'},{companyId:'b',name:'이전 비공개 B'}],request);
  h.context('customer-two',['a']);h.mount('a',{company:{companyId:'a',name:'현재 A'}});await h.resolve(0,data('a','2026-10','private-former'));await former;
  assert.equal(h.calls.length,2,'former account queued B must not run');assert.doesNotMatch(h.result(),/private-former/);
  await h.resolve(1,data('a','2026-10','private-current'));assert.match(h.result(),/private-current/);
  h.leave();const removing=h.collection.prefetch([{companyId:'a',name:'현재 A'}],request);await removing;
  h.collection.invalidate('a');const pending=h.collection.prefetch([{companyId:'a',name:'현재 A'}],request);h.context('customer-two',[]);await h.resolve(2,data('a','2026-10','removed'));await pending;
  h.context('customer-two',['a']);h.mount('a');assert.doesNotMatch(h.result(),/removed|현재 A/);
});

for(const status of [401,403,404])test(`prefetch ${status} clears protected data without restoring denied catalog seeds`,async()=>{
  const h=harness();h.context();const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const prefetch=h.collection.prefetch([{companyId:'a',name:'권한 대상 A',rooms:16}],request);
  h.mount('a',{company:{companyId:'a',name:'권한 대상 A',rooms:16}});assert.equal(h.result(),'a||');
  await h.reject(0,status,'조회 권한 없음');await prefetch;
  assert.doesNotMatch(h.result(),/^a\|/);h.leave();h.mount('a',{company:{companyId:'a',name:'권한 대상 A',rooms:16}});
  if(status!==401)assert.match(h.result(),/불러옵|loading/,'denied catalog data must not reappear before successful permission check');
  assert.doesNotMatch(h.result(),/v1/);
});

test('prefetch is limited to the first four registered companies and leaves the rest for explicit opening',async()=>{
  const h=harness(),ids=['a','b','c','d','e','f'];h.context('customer-one',ids);
  const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const batch=h.collection.prefetch(ids.map(companyId=>({companyId,name:companyId})),request);
  for(let index=0;index<4;index++){assert.equal(h.calls.length,index+1,'serial prefetch');await h.resolve(index,data(ids[index]));}
  await batch;assert.equal(h.calls.length,4);assert.ok(h.calls.every(call=>!/^\/companies\/[ef]\//.test(call.path)));
  h.mount('e',{company:{companyId:'e',name:'추가업체 E'}});assert.equal(h.result(),'e||');assert.equal(h.calls.length,5);
});

test('a queued company opened and completed before its prefetch turn is not requested again',async()=>{
  const h=harness();h.context();const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const batch=h.collection.prefetch([{companyId:'a',name:'A'},{companyId:'b',name:'B'}],request);
  h.mount('b',{company:{companyId:'b',name:'B'}});assert.equal(h.calls.length,2);
  await h.resolve(1,data('b','2026-10','clicked-b'));await h.resolve(0,data('a','2026-10','prefetched-a'));await batch;
  assert.equal(h.calls.length,2,'the queued prefetch reuses the already completed current-account cache');assert.equal(h.result(),'b|2026-10|clicked-b');
});

test('invalidated prefetch responses cannot refill the cache and a mounted dirty seed remains intact',async()=>{
  const h=harness();h.context();const request=path=>new Promise((resolve,reject)=>h.calls.push({path,resolve,reject}));
  const batch=h.collection.prefetch([{companyId:'a',name:'A'}],request);h.mount('a',{company:{companyId:'a',name:'A'},editHtml:'작성 중 수정'});h.protect();
  await h.resolve(0,data('a','2026-10','fresh-completed'));await batch;assert.equal(h.result(),'a||');assert.match(h.freshness(),/작성 중/);
  h.protect(false);h.leave();h.mount('a');assert.equal(h.result(),'a|2026-10|fresh-completed');
  h.collection.invalidate('a');h.leave();const former=h.collection.prefetch([{companyId:'a',name:'A'}],request);h.collection.invalidate('a');await h.resolve(2,data('a','2026-10','invalidated-private'));await former;
  h.mount('a');assert.doesNotMatch(h.result(),/invalidated-private/);
});

test('a failed first observation read does not erase edits already begun in the basic-data seed',async()=>{
  const h=harness();h.context();h.mount('a',{company:{companyId:'a',name:'A'},editHtml:'수정 도구'});h.protect();
  const rendered=h.renders.length,before=h.result();await h.reject(0,503,'관측 연결 지연');
  assert.equal(h.result(),before);assert.equal(h.renders.length,rendered,'network failure must not recreate the initial editing form');
  assert.match(h.elements.get('#collection-progress').innerHTML,/다시 확인/);
});

test('freshly authorized persisted own and competitor company views restore synchronously before their guarded GETs',async()=>{
  const h=harness();h.context();const own=persisted(),competitor=persisted('b','','competitor');
  h.collection.restore([own,competitor],'customer-one');own.data.result.version='mutated-bootstrap';
  h.mount('a');assert.equal(h.result(),'a|2026-10|persisted');assert.equal(h.calls.length,1);
  assert.match(h.freshness(),/이전 조회 자료 표시 · 최신 자료 확인 중 · 마지막 확인/);
  assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);
  h.leave();h.mount('b',{relationKind:'competitor'});assert.equal(h.result(),'b|2026-10|competitor');assert.equal(h.calls.length,2);
  assert.equal(h.renderData.at(-1).options.collapseProducts,true);assert.deepEqual(h.storedKeys(),[]);
  await h.resolve(0,data('a','2026-10','fresh-own'));assert.equal(h.result(),'b|2026-10|competitor');
  await h.resolve(1,data('b','2026-10','fresh-competitor'));assert.equal(h.result(),'b|2026-10|fresh-competitor');
});

test('persisted defaults remain separate from explicit past-month snapshots and mismatched company or account data',()=>{
  const h=harness();h.context();
  const wrong=persisted('a','','wrong');wrong.data.result.companyId='b';
  h.collection.restore([persisted('a','2026-09','september')],'customer-one');h.mount();assert.match(h.result(),/불러옵|loading/);
  h.month('2026-09');assert.equal(h.result(),'a|2026-09|september');
  h.context('customer-two');h.collection.restore([persisted()],'customer-one');h.collection.restore([wrong],'customer-two');h.mount();
  assert.match(h.result(),/불러옵|loading/);
});

test('repeated persisted GETs keep the original check date and fixed seven-day expiration',async()=>{
  const h=harness(),saved=persisted();h.context();h.collection.restore([saved],'customer-one');h.mount();
  const originalDate=h.freshness().split('마지막 확인 ')[1];await h.resolve(0,saved.data);assert.equal(h.freshness().split('마지막 확인 ')[1],originalDate);
  assert.equal([...h.timers.values()][0].ms,5000,'an actual permission GET is followed by bounded freshness checks');
  h.advance(60*60*1000);h.leave();h.mount();await h.resolve(1,saved.data);assert.equal(h.freshness().split('마지막 확인 ')[1],originalDate);
  h.advance(6*24*60*60*1000+21*60*60*1000);h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
  await h.resolve(2,saved.data);assert.doesNotMatch(h.result(),/\|persisted$/);assert.match(h.elements.get('#collection-progress').innerHTML,/확인하지 못했/);
});

test('fresh source data replaces a persisted view and returns to the ordinary thirty-minute lifetime',async()=>{
  const h=harness(),saved=persisted();h.context();h.collection.restore([saved],'customer-one');h.mount();
  await h.resolve(0,{...data('a','2026-10','fresh'),responseCache:{state:'fresh',checkedAt:'2026-10-13T02:00:00Z'}});
  h.advance(29*60*1000);h.leave();h.mount();assert.equal(h.result(),'a|2026-10|fresh');
  h.advance(60*1000);h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
});

test('ordinary cached responses also preserve the original check time across repeated GETs',async()=>{
  const h=harness(),saved={...data(),responseCache:{state:'cached',checkedAt:'2026-10-13T02:00:00Z'}};h.context();h.mount();await h.resolve(0,saved);
  h.advance(29*60*1000);h.leave();h.mount();await h.resolve(1,saved);
  h.advance(60*1000);h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
});

for(const [label,metadata] of [
  ['missing expiry',{validUntil:undefined}],
  ['malformed expiry',{validUntil:'tomorrow'}],
  ['extended expiry',{validUntil:'2026-10-20T00:00:00.001Z'}],
  ['expired expiry',{validUntil:'2026-10-13T02:00:00Z'}],
  ['future check beyond clock skew',{checkedAt:'2026-10-13T02:01:00.001Z'}],
  ['invalid calendar date',{checkedAt:'2026-09-31T00:00:00Z'}],
  ['missing check',{checkedAt:undefined}],
  ['false revalidation',{revalidationRequired:false}],
  ['fresh state',{state:'fresh'}]
])test(`persisted company restoration rejects ${label} without renewing or displaying invalid data`,async()=>{
  const h=harness(),saved=persisted();h.context();Object.assign(saved.data.responseCache,metadata);
  h.collection.restore([saved],'customer-one');h.mount();assert.match(h.result(),/불러옵|loading/);
  await h.resolve(0,saved.data);assert.doesNotMatch(h.result(),/\|persisted$/);assert.equal(h.timers.size,0);
});

test('persisted active collection and pending integration responses are never restored as completed observations',async()=>{
  for(const state of ['collecting','pending','updating']){
    const h=harness(),saved=persisted();h.context();
    if(state==='collecting')saved.data.request={status:state};else saved.data.companyDetail.integrated.status=state;
    h.collection.restore([saved],'customer-one');h.mount();assert.match(h.result(),/불러옵|loading/);
    await h.resolve(0,saved.data);assert.doesNotMatch(h.result(),/\|persisted$/);assert.equal(h.timers.size,0);
  }
});

test('a transient permission-read failure retains an unexpired persisted result and its original check date',async()=>{
  const h=harness(),saved=persisted();h.context();h.collection.restore([saved],'customer-one');h.mount();await h.reject(0,503,'일시 연결 지연');
  assert.equal(h.result(),'a|2026-10|persisted');assert.match(h.freshness(),/이전 조회 자료 유지 · 마지막 확인/);
  assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);assert.equal(h.timers.size,0);
  h.leave();h.mount();assert.equal(h.result(),'a|2026-10|persisted');
});

test('a failed source refresh retains the persisted result without polling or manufacturing freshness',async()=>{
  const h=harness(),saved=persisted();h.context();h.mount();saved.data.responseCache.refreshFailed=true;saved.data.responseCache.refreshing=false;
  await h.resolve(0,saved.data);assert.equal(h.result(),'a|2026-10|persisted');assert.match(h.freshness(),/최신 확인 실패.*마지막 확인/);assert.equal(h.timers.size,0);
});

test('a real company refresh takes precedence over its prior failure and replaces saved data automatically',async()=>{
  const h=harness(),saved=persisted();saved.data.responseCache.refreshFailed=true;saved.data.responseCache.refreshing=true;h.context();h.mount();
  await h.resolve(0,saved.data);assert.equal(h.result(),'a|2026-10|persisted');assert.match(h.freshness(),/최신 자료 확인 중.*마지막 확인/);assert.doesNotMatch(h.freshness(),/최신 확인 실패/);assert.equal([...h.timers.values()][0].ms,5000);
  assert.doesNotMatch(h.elements.get('#collection-progress').innerHTML,/최신 자료를 확인하지 못해/);
  await h.poll();await h.resolve(1,{...data('a','2026-10','recovered'),responseCache:{state:'fresh',checkedAt:'2026-10-13T02:00:00Z',refreshing:false,refreshFailed:false}});
  assert.equal(h.result(),'a|2026-10|recovered');assert.match(h.freshness(),/최신 자료 확인 완료/);assert.equal(h.timers.size,0);
});

test('a company refresh that fails again stops checks despite persisted revalidation being required',async()=>{
  const h=harness(),saved=persisted();saved.data.responseCache.refreshFailed=true;saved.data.responseCache.refreshing=true;h.context();h.mount();await h.resolve(0,saved.data);
  await h.poll();await h.resolve(1,{...saved.data,responseCache:{...saved.data.responseCache,refreshing:false}});
  assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);assert.equal(h.result(),'a|2026-10|persisted');assert.match(h.freshness(),/최신 확인 실패.*마지막 확인/);
});

test('a persisted result expiring while a permission read is pending disappears after that read fails',async()=>{
  const h=harness(),saved=persisted('a','','near-expiry','2026-10-06T02:00:01Z');h.context();h.collection.restore([saved],'customer-one');h.mount();
  assert.equal(h.result(),'a|2026-10|near-expiry');h.advance(1000);await h.reject(0,504);
  assert.doesNotMatch(h.result(),/near-expiry/);assert.match(h.result(),/확인하지 못/);assert.equal(h.elements.get('[data-collect] button[type=submit]').disabled,true);
});

for(const status of [401,403,404])test(`${status} removes persisted company data and prevents bootstrap replay after denial`,async()=>{
  const h=harness(),saved=persisted();h.context();h.collection.restore([saved],'customer-one');h.mount();await h.reject(0,status);
  assert.doesNotMatch(h.result(),/\|persisted$/);h.collection.restore([saved],'customer-one');h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
});

test('persisted verification polls are bounded even when a saved response still requires revalidation',async()=>{
  const h=harness(),saved=persisted();saved.data.responseCache.refreshFailed=true;saved.data.responseCache.refreshing=true;h.context();h.mount();await h.resolve(0,saved.data);
  for(let index=1;index<=24;index++){await h.poll();await h.resolve(index,saved.data);}
  assert.equal(h.calls.length,25);assert.equal(h.timers.size,0);assert.equal(h.result(),'a|2026-10|persisted');
  assert.match(h.freshness(),/마지막 확인/);assert.match(h.elements.get('#collection-progress').innerHTML,/시간이 걸리고/);
});

test('small server clock lead preserves the original persisted expiration instead of rewriting checkedAt',async()=>{
  const h=harness(),saved=persisted('a','','clock-skew','2026-10-13T02:00:00.400Z');h.context();h.collection.restore([saved],'customer-one');h.mount();
  assert.equal(h.result(),'a|2026-10|clock-skew');await h.resolve(0,saved.data);
  h.advance(7*24*60*60*1000+399);h.leave();h.mount();assert.equal(h.result(),'a|2026-10|clock-skew');
  h.advance(1);h.leave();h.mount();assert.match(h.result(),/불러옵|loading/);
});
