'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/analysis.js'),'utf8');
const historySource=fs.readFileSync(require.resolve('../web/region-history.js'),'utf8');
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
function data(id='a',month='2026-09',value=10){return {region:{id,label:'지역 '+id},month,availableSources:1,sources:[{key:'visitors',label:'방문',provider:'공공자료',status:'ready',rows:[{label:'방문자',value,unit:'명'},{label:'미확인 자료',value:null,unit:'명'}]}],warnings:[]};}
function historical(value=10){return {...data('a','2026-09',value),window:{start:'2025-10',end:'2026-09'},sources:[{key:'visitors',label:'방문',provider:'공공자료',status:'ready',metrics:['first','second'].map(key=>({key,label:key,unit:'명',observedMonths:1,latest:{month:'2026-09',value}})),series:[{month:'2026-09',status:'observed',rows:[{key:'first',value},{key:'second',value:value+1}]}]}],refreshAvailable:false};}
function persisted(value=10,checkedAt='2026-10-22T22:00:00Z'){
  return {...data('a','2026-09',value),responseCache:{state:'cached',checkedAt,persisted:true,validUntil:new Date(Date.parse(checkedAt)+7*24*60*60*1000).toISOString(),revalidationRequired:true,refreshing:false,refreshFailed:false}};
}
function harness({history=false}={}){
  let now=Date.parse('2026-10-23T00:00:00Z'),html='',writes=0,active=null,cards=[],nextTimer=0,preparationDom=false;
  const handlers={},calls=[],timers=new Map(),window={},notice={textContent:'',hidden:true,dataset:{}},button={disabled:false,isConnected:true},select={value:'a'};
  const form={params:{month:'2026-09'},querySelector:()=>button};
  // A small DOM contract for the real region-history renderer: replacing a
  // region destroys its controls, and the view must restore their user state.
  const parseCard=(key,body)=>{
    const card={dataset:{historySource:key}};
    const metric={value:body.match(/<option value="([^"]+)" selected>/)?.[1]||'',matches:s=>s==='[data-history-metric]',closest:()=>card,focus(){active=metric;}};
    const summary={textContent:'월별 수치·출처 확인',matches:s=>s==='summary',closest:()=>detail,focus(){active=summary;}};
    const detail={open:false,closest:()=>card,querySelector:()=>summary};
    card.metric=metric;card.detail=detail;
    Object.defineProperty(card,'outerHTML',{set(value){metric.value=value.match(/<option value="([^"]+)" selected>/)?.[1]||'';detail.open=false;}});
    return card;
  };
  const slot={isConnected:true,contains:el=>cards.some(card=>el===card.metric||el===card.detail.querySelector()),
    querySelectorAll(selector){return selector==='[data-history-metric]'?cards.map(card=>card.metric):selector==='[data-history-source]'?cards:selector==='details'?cards.map(card=>card.detail):[];}};
  Object.defineProperty(slot,'innerHTML',{get:()=>html,set(value){html=value;writes++;cards=[...value.matchAll(/<article class="card history-source" data-history-source="([^"]+)">([\s\S]*?)<\/article>/g)].map(match=>parseCard(match[1],match[2]));}});
  const progress={textContent:'',innerHTML:'',isConnected:true},refresh={disabled:false,isConnected:true};
  const document={addEventListener:(type,fn)=>handlers[type]=fn,querySelector:selector=>({'#analysis-output':slot,'#analysis-form':form,'#analysis-form select':select,'#analysis-freshness':notice,'#history-progress':preparationDom?progress:null,'[data-history-refresh]':preparationDom?refresh:null}[selector]||null),get activeElement(){return active;}};
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context=vm.createContext({window,document,Date:Clock,FormData:class{constructor(){return Object.entries({...form.params,regionKey:select.value});}},setTimeout(fn,ms){timers.set(++nextTimer,{fn,ms});return nextTimer;},clearTimeout:id=>timers.delete(id)});
  if(history)vm.runInContext(historySource,context);vm.runInContext(source,context);
  const view=window.InsightAnalysis,request=(path,payload,options)=>new Promise((resolve,reject)=>calls.push({path,payload,options,resolve,reject}));
  let scope='customer-one',ids=['a','b'],expired=0;
  const state=()=>({customer:{relations:[]},companies:[],regions:ids.map(id=>({id,label:'지역 '+id}))});
  const configure=(nextScope=scope,nextIds=ids)=>{scope=nextScope;ids=nextIds;view.configureCache({scope,regionKeys:ids,onSessionExpired(){expired++;}});};
  configure();
  return {view,calls,notice,slot,button,select,handlers,timers,configure,state,html:()=>html,writes:()=>writes,expired:()=>expired,
    cards:()=>cards,focusMetric(){active=cards[0].metric;},active:()=>active,
    mount(id='a',month='2026-09'){slot.isConnected=true;button.isConnected=true;slot.innerHTML='new page';form.params.month=month;view.mount('regions',request,state(),id);},
    leave(){view.stop();slot.isConnected=false;},
    change(id,month=form.params.month){select.value=id;form.params.month=month;handlers.change({target:{closest:()=>true}});},
    advance(ms){now+=ms;},
    async resolve(index,value){calls[index].resolve(value);await flush();},
    async reject(index,status,message='조회 실패'){calls[index].reject(Object.assign(Error(message),{status}));await flush();},
    async tick(){const [id,timer]=timers.entries().next().value||[];if(!timer)return;timers.delete(id);timer.fn();await flush();},
    async prepare(){preparationDom=true;const target={disabled:false,closest:()=>target};handlers.click({target,preventDefault(){},stopImmediatePropagation(){}});await flush();}
  };
}

test('returning to the same authorized region and exact month displays its result before revalidation resolves',async()=>{
  const h=harness();h.mount();assert.match(h.html(),/연결하고/);await h.resolve(0,data());h.leave();h.mount();
  assert.match(h.html(),/지역 a/);assert.match(h.html(),/방문자<\/th><td>10/);assert.match(h.notice.textContent,/이전 조회 자료.*확인 중/);
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].payload,undefined);assert.equal(h.calls[1].options.refresh,false);
  await h.resolve(1,data('a','2026-09',15));assert.match(h.html(),/방문자<\/th><td>15/);assert.equal(h.notice.hidden,true);
});

test('an unchanged refresh keeps the same chart, chosen metric, open details and focus',async()=>{
  const h=harness({history:true});h.mount();await h.resolve(0,historical());h.leave();h.mount();
  const card=h.cards()[0];card.metric.value='second';card.detail.open=true;h.focusMetric();const writes=h.writes();
  const same=historical();same.generatedAt='later';same.responseCache={checkedAt:'2026-10-23T00:00:00Z',state:'cached'};await h.resolve(1,same);
  assert.equal(h.writes(),writes);assert.equal(h.cards()[0],card);assert.equal(card.metric.value,'second');assert.equal(card.detail.open,true);assert.equal(h.active(),card.metric);
});

test('changed data preserves the selected metric, open source details and focus when replacing charts',async()=>{
  const h=harness({history:true});h.mount();await h.resolve(0,historical());h.leave();h.mount();
  const before=h.cards()[0];before.metric.value='second';before.detail.open=true;h.focusMetric();await h.resolve(1,historical(20));
  assert.notEqual(h.cards()[0],before);assert.equal(h.cards()[0].metric.value,'second');assert.equal(h.cards()[0].detail.open,true);assert.equal(h.active(),h.cards()[0].metric);assert.match(h.html(),/20/);
});

test('region and month keys never reuse another condition and a late response cannot overwrite the new selection',async()=>{
  const h=harness();h.mount();h.change('b','2026-08');assert.match(h.html(),/연결하고/);
  await h.resolve(1,data('b','2026-08',22));await h.resolve(0,data('a','2026-09',11));assert.match(h.html(),/지역 b/);assert.doesNotMatch(h.html(),/지역 a/);
  h.leave();h.mount('a');assert.match(h.html(),/지역 a/,'safe late results can be reused when returning to their own region');h.change('a','2026-08');assert.match(h.html(),/연결하고/);
});

test('leaving and returning while a GET is pending shares that GET and never sends preparation POST',async()=>{
  const h=harness();h.mount();h.leave();h.mount();assert.equal(h.calls.length,1);await h.resolve(0,data());assert.match(h.html(),/지역 a/);assert.ok(h.calls.every(call=>call.payload===undefined));
});

test('refresh failure keeps the last good data with an honest notice and retains missing values',async()=>{
  const h=harness();h.mount();await h.resolve(0,data());h.leave();h.mount();await h.reject(1,504);
  assert.match(h.html(),/지역 a/);assert.match(h.html(),/미확인 자료<\/th><td>미확인/);assert.match(h.notice.textContent,/확인 지연.*이전 조회 자료/);
  h.leave();h.mount();const reply=data();reply.responseCache={refreshFailed:true};await h.resolve(2,reply);assert.match(h.notice.textContent,/확인 지연/);
});

test('401 expires the shared session and clears every regional cached result',async()=>{
  const h=harness();h.mount();await h.resolve(0,data());h.leave();h.mount('b');await h.resolve(1,data('b'));h.leave();h.mount();await h.reject(2,401);
  assert.equal(h.expired(),1);assert.match(h.html(),/로그인이 만료/);h.configure();h.mount('b');assert.match(h.html(),/연결하고/);
});

for(const status of [403,404])test(`${status} removes the denied region and restore cannot resurrect it`,async()=>{
  const h=harness();h.mount();const saved=data();saved.responseCache={checkedAt:'2026-10-23T00:00:00Z'};await h.resolve(0,saved);h.leave();h.mount();await h.reject(1,status);
  assert.match(h.html(),/지역 등록과 조회 권한/);h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.leave();h.mount();assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.equal(h.calls.length,3);assert.equal(h.calls[2].options.refresh,true,'an explicit reentry can recheck a server-side denied source');
  await h.resolve(2,data('a','2026-09',18));assert.match(h.html(),/방문자<\/th><td>18/);h.leave();h.mount();assert.match(h.html(),/방문자<\/th><td>18/,'a fresh successful GET restores cache use after a central permission regrant');
});

test('switching account invalidates cached results and late errors from the old account cannot log out the new one',async()=>{
  const h=harness();h.mount();h.configure('customer-two');h.mount();await h.resolve(1,data('a','2026-09',88));await h.reject(0,401);
  assert.match(h.html(),/방문자<\/th><td>88/);assert.equal(h.expired(),0);h.leave();h.mount();assert.match(h.html(),/88/);
});

test('removing and restoring regional permission invalidates both cache and prior pending response',async()=>{
  const h=harness();h.mount();h.configure('customer-one',['b']);h.configure('customer-one',['a','b']);h.mount();assert.equal(h.calls.length,2);
  await h.resolve(0,data('a','2026-09',999));assert.doesNotMatch(h.html(),/999/);await h.resolve(1,data('a','2026-09',7));assert.match(h.html(),/방문자<\/th><td>7/);
});

test('reload restores only fresh, correctly scoped and permitted region/month payloads from authenticated /me',async()=>{
  const h=harness(),saved=data();saved.responseCache={checkedAt:'2026-10-23T00:00:00Z'};
  h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'other-customer');h.mount();assert.match(h.html(),/연결하고/);h.leave();h.view.clearCache();
  h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();assert.match(h.html(),/방문자<\/th><td>10/);assert.match(h.notice.textContent,/이전 조회 자료/);
  h.leave();h.configure('customer-three',['a']);const invalid=[{regionKey:'b',month:'2026-09',data:{...saved,region:{id:'b'}}},{regionKey:'a',month:'2026-08',data:saved},{regionKey:'a',month:'2026-09',data:{...saved,responseCache:{checkedAt:'2026-10-22T23:00:00Z'}}},{regionKey:'a',month:'2026-09',data:{...saved,responseCache:{checkedAt:'2026-10-23T00:02:00Z'}}}];
  h.view.restore(invalid,'customer-three');h.mount();assert.match(h.html(),/연결하고/);
});

test('expiration and the 24-entry bound prevent indefinite private-result retention',async()=>{
  const h=harness();h.mount();await h.resolve(0,data());h.advance(30*60*1000+1);h.leave();h.mount();assert.match(h.html(),/연결하고/);
  const ids=Array.from({length:25},(_,i)=>'r'+i);h.configure('bounded',ids);
  for(const id of ids){h.leave();h.mount(id);await h.resolve(h.calls.length-1,data(id));}
  h.leave();h.mount('r24');assert.match(h.html(),/지역 r24/);h.leave();h.mount('r0');assert.match(h.html(),/연결하고/);
});

test('a background server refresh is checked with bounded GETs and publishes changed data while staying on the page',async()=>{
  const h=harness();h.mount();const pending=data();pending.responseCache={refreshing:true};await h.resolve(0,pending);assert.equal(h.timers.size,1);assert.match(h.notice.textContent,/최신 자료 확인 중/);
  await h.tick();assert.match(h.html(),/방문자<\/th><td>10/);await h.resolve(1,data('a','2026-09',12));assert.match(h.html(),/방문자<\/th><td>12/);assert.equal(h.timers.size,0);assert.ok(h.calls.every(call=>!call.payload));
});

test('a repeated server-cache reply cannot extend the original 30-minute retention period',async()=>{
  const h=harness(),saved=data();saved.responseCache={checkedAt:'2026-10-23T00:00:00Z'};h.mount();await h.resolve(0,saved);
  h.advance(29*60*1000);h.leave();h.mount();assert.match(h.html(),/지역 a/);await h.resolve(1,saved);
  h.advance(61*1000);h.leave();h.mount();assert.match(h.html(),/연결하고/);
});

test('wrong region or requested-month responses never enter the cache or replace the previous valid result',async()=>{
  const h=harness();h.mount();await h.resolve(0,data());h.leave();h.mount();await h.resolve(1,data('b'));
  assert.match(h.html(),/지역 a/);assert.doesNotMatch(h.html(),/지역 b/);assert.match(h.notice.textContent,/확인 지연/);
  h.leave();h.mount();await h.resolve(2,data('a','2026-08'));assert.match(h.html(),/2026-09/);assert.doesNotMatch(h.html(),/기준월 2026-08/);
});

test('explicit cache clearing invalidates both a pending request and its later private response',async()=>{
  const h=harness();h.mount();h.view.clearCache();h.leave();h.mount();assert.equal(h.calls.length,2);
  await h.resolve(0,data('a','2026-09',999));assert.doesNotMatch(h.html(),/999/);await h.resolve(1,data('a','2026-09',4));assert.match(h.html(),/방문자<\/th><td>4/);
});

test('background revalidation is bounded and route departure cancels its pending checks',async()=>{
  const h=harness();h.mount();const saved=data();saved.responseCache={refreshing:true};await h.resolve(0,saved);
  for(const delay of [2000,4000,8000,16000]){assert.equal([...h.timers.values()][0].ms,delay);await h.tick();await h.resolve(h.calls.length-1,saved);}
  assert.equal(h.calls.length,5);assert.equal(h.timers.size,0);assert.match(h.notice.textContent,/최신 확인에 시간이 걸려/);assert.equal(h.notice.dataset.state,'notice');
  h.leave();h.mount();await h.resolve(5,saved);assert.equal(h.timers.size,1);h.leave();assert.equal(h.timers.size,0);
});

test('a successful source refresh after the former four-second polling tail updates the open regional view',async()=>{
  const h=harness();h.mount();const saved=data();saved.responseCache={refreshing:true};await h.resolve(0,saved);
  await h.tick();await h.resolve(1,saved);h.advance(6000);await h.tick();await h.resolve(2,data('a','2026-09',31));
  assert.match(h.html(),/방문자<\/th><td>31/);assert.equal(h.notice.hidden,true);assert.equal(h.timers.size,0);
});

test('explicit preparation completion bypasses the saved result without an automatic preparation POST',async()=>{
  const h=harness();h.mount();await h.resolve(0,data());assert.equal(h.calls.length,1);
  await h.prepare();assert.equal(h.calls.length,2);assert.match(h.calls[1].path,/\/regions\/a\/preparation$/);assert.equal(h.calls[1].payload.month,'2026-09');
  await h.resolve(1,{regionKey:'a',month:'2026-09',job:{status:'ready',progress:{completed:6,total:6},steps:[]}});
  assert.equal(h.calls.length,3);assert.equal(h.calls[2].options.refresh,true);assert.equal(h.calls[2].payload,undefined);
  await h.resolve(2,data('a','2026-09',45));assert.match(h.html(),/방문자<\/th><td>45/);
});

test('a two-hour-old persisted bootstrap result appears before the first guarded analysis GET completes',async()=>{
  const h=harness(),saved=persisted();h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();
  assert.match(h.html(),/방문자<\/th><td>10/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].payload,undefined);
  assert.match(h.notice.textContent,/이전 저장 자료 표시 · 최신 자료 확인 중 · 마지막 확인/);assert.doesNotMatch(h.notice.textContent,/확인 전/);
  await h.resolve(0,{...data('a','2026-09',20),responseCache:{state:'fresh',checkedAt:'2026-10-23T00:00:00Z'}});
  assert.match(h.html(),/방문자<\/th><td>20/);assert.equal(h.notice.hidden,true);assert.equal(h.timers.size,0);
});

test('repeated persisted replies preserve the original checked date and cannot extend the fixed seven-day bound',async()=>{
  const h=harness(),saved=persisted();h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();
  const originalNotice=h.notice.textContent;await h.resolve(0,saved);assert.equal(h.notice.textContent,originalNotice);
  h.advance(60*60*1000);h.leave();h.mount();await h.resolve(1,saved);assert.equal(h.notice.textContent,originalNotice);
  h.advance(6*24*60*60*1000+21*60*60*1000);h.leave();h.mount();assert.match(h.html(),/연결하고/);
  await h.resolve(2,saved);assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.match(h.html(),/유효기간/);
});

test('fresh data replaces persisted results and returns to the ordinary thirty-minute in-page lifetime',async()=>{
  const h=harness(),saved=persisted();h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();
  await h.resolve(0,{...data('a','2026-09',30),responseCache:{state:'fresh',checkedAt:'2026-10-23T00:00:00Z',refreshing:false}});
  h.advance(29*60*1000);h.leave();h.mount();assert.match(h.html(),/방문자<\/th><td>30/);
  h.advance(61*1000);h.leave();h.mount();assert.match(h.html(),/연결하고/);
});

test('a persisted result expiring while verification is pending is not retained after verification fails',async()=>{
  const h=harness(),saved=persisted(10,'2026-10-16T00:00:01Z');h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();
  assert.match(h.html(),/방문자<\/th><td>10/);h.advance(1000);await h.reject(0,504);assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.match(h.html(),/조회 실패/);
});

for(const [label,metadata] of [
  ['missing expiry',{validUntil:undefined}],
  ['malformed expiry',{validUntil:'tomorrow'}],
  ['extended expiry',{validUntil:'2026-10-29T22:00:00.001Z'}],
  ['expired expiry',{validUntil:'2026-10-23T00:00:00Z'}],
  ['future check beyond permitted clock skew',{checkedAt:'2026-10-23T00:01:00.001Z'}],
  ['invalid calendar date',{checkedAt:'2026-09-31T22:00:00Z'}],
  ['missing check',{checkedAt:undefined}],
  ['false revalidation',{revalidationRequired:false}],
  ['fresh state',{state:'fresh'}]
])test(`persisted restoration rejects ${label} without displaying or renewing its saved data`,async()=>{
  const h=harness(),saved=persisted();Object.assign(saved.responseCache,metadata);
  h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();assert.match(h.html(),/연결하고/);
  await h.resolve(0,saved);assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.equal(h.timers.size,0);
});

for(const status of [401,403,404])test(`${status} removes a persisted restored result and prevents later bootstrap resurrection`,async()=>{
  const h=harness(),saved=persisted();h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();await h.reject(0,status);
  assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.leave();h.mount();
  assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.equal(h.expired(),status===401?1:0);
});

test('persisted results needing revalidation receive bounded GET checks even when no refresh is pending yet',async()=>{
  const h=harness(),saved=persisted();h.mount();await h.resolve(0,saved);
  for(const delay of [2000,4000,8000,16000]){assert.equal([...h.timers.values()][0].ms,delay);await h.tick();await h.resolve(h.calls.length-1,saved);}
  assert.equal(h.calls.length,5);assert.equal(h.timers.size,0);assert.match(h.notice.textContent,/최신 확인에 시간이 걸려.*마지막 확인/);assert.equal(h.notice.dataset.state,'notice');
});

test('failed persistent revalidation retains saved values with the original date and a delay notice',async()=>{
  const h=harness(),saved=persisted();saved.responseCache.refreshFailed=true;h.mount();await h.resolve(0,saved);
  assert.match(h.html(),/방문자<\/th><td>10/);assert.match(h.notice.textContent,/최신 자료 확인 지연.*마지막 확인/);assert.equal(h.timers.size,0);assert.equal(h.notice.dataset.state,'notice');
});

test('fresh verification accepts a 400 ms server clock lead without changing its original checkedAt',async()=>{
  const h=harness(),saved={...data(),responseCache:{state:'fresh',checkedAt:'2026-10-23T00:00:00.400Z'}};h.mount();await h.resolve(0,saved);
  assert.match(h.html(),/방문자<\/th><td>10/);assert.equal(h.notice.hidden,true);
  h.advance(30*60*1000+399);h.leave();h.mount();assert.match(h.html(),/방문자<\/th><td>10/);
  h.advance(1);h.leave();h.mount();assert.match(h.html(),/연결하고/,'expires relative to the unchanged original server checkedAt');
});

test('persisted verification accepts a 400 ms server clock lead without extending its original seven-day expiry',async()=>{
  const h=harness(),saved=persisted(10,'2026-10-23T00:00:00.400Z');h.view.restore([{regionKey:'a',month:'2026-09',data:saved}],'customer-one');h.mount();
  assert.match(h.html(),/방문자<\/th><td>10/);await h.resolve(0,saved);assert.equal(h.timers.size,1);
  h.advance(7*24*60*60*1000+399);h.leave();h.mount();assert.match(h.html(),/방문자<\/th><td>10/);
  h.advance(1);h.leave();h.mount();assert.match(h.html(),/연결하고/,'keeps the source expiry instead of rewriting either clock');
});

test('fresh verification rejects a server clock lead beyond sixty seconds',async()=>{
  const h=harness();h.mount();await h.resolve(0,{...data(),responseCache:{state:'fresh',checkedAt:'2026-10-23T00:01:00.001Z'}});
  assert.doesNotMatch(h.html(),/방문자<\/th><td>10/);assert.match(h.html(),/유효기간/);assert.equal(h.timers.size,0);
});
