'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const selection=require('../web/comparison-selection.js');
const regionalView=require('../web/regional-context-view.js'),homeView=require('../web/home-context-view.js'),workspaceView=require('../web/context-workspace.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness({query='',storage=new Map(),deferIdentity=false,identityState=null,adminView=false,deferRoster=false}={}){
  let url=new URL('http://localhost/'+(adminView?'customer-view':'')+query+'#competitors');const events={},documentEvents={},elements=new Map(),mounts=[],analyses=[],contextMounts=[],cacheContexts=[];
  const state=identityState||{customer:{customerId:'fixture',username:'검수',revision:1,settings:{},regions:[],businessStatus:'owned',relations:[{companyId:'own1',kind:'own',status:'active'},{companyId:'own2',kind:'own',status:'active'},{companyId:'cmp1',kind:'competitor',status:'active'}],entitlements:{competitorLimit:3,interestRegionLimit:1}},companies:[{companyId:'own1',name:'내 매장1',regionKey:'r1',rooms:16},{companyId:'own2',name:'내 매장2',regionKey:'r2',rooms:18},{companyId:'cmp1',name:'경쟁업체',regionKey:'r1',rooms:10}],regions:[{id:'r1',label:'지역1'},{id:'r2',label:'지역2'}],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[]};
  const element=id=>{if(id==='#regional-full-detail'&&!element('#main').innerHTML.includes('id="regional-full-detail"'))return null;if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,open:false,addEventListener(){},classList:{toggle(){},add(){},remove(){}},focus(){}});return elements.get(id);};
  const location={get href(){return url.href;},get pathname(){return url.pathname;},get hash(){return url.hash;},set hash(v){url.hash=v;},get search(){return url.search;}};
  const window={addEventListener:(name,fn)=>events[name]=fn,scrollTo(){},InsightComparisonSelection:selection,
    InsightComparisonView:{stop(){},panel:(s,selected)=>`<div data-own="${selected.ownCompanyId}">현재 비교</div>`,mount:options=>mounts.push(options)},
    InsightCollection:{stop(){},setContext(){},restore(){},panel:()=>'<div>ABC</div>',mount(){},prefetch(){}},
    InsightAnalysis:{stop(){},configureCache:options=>cacheContexts.push(options),configureReports(){},restore(){},restoreReports(){},panel:()=>'<div>분석</div>',mount:(...args)=>analyses.push(args),peekCurrentBriefing:()=>null,readCurrentBriefing:async()=>({})},InsightAuth:{screen:()=>'<p>로그인</p>'}
  };
  window.InsightRegionalContext={configure(){},restore(){},clear(){}};window.InsightRegionalContextView=regionalView;window.InsightHomeContextView=homeView;window.InsightContextWorkspace={controls:workspaceView.controls,stop(){},mount:options=>contextMounts.push({mode:options.mode,selection:options.store.getState()})};
  let resolveIdentity,resolveRoster,rosterFailed=false;const identity=deferIdentity?new Promise(resolve=>resolveIdentity=resolve):null,roster=deferRoster?new Promise(resolve=>resolveRoster=resolve):null;
  const reply=(value,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
  const context=vm.createContext({window,location,URL,URLSearchParams,history:{replaceState:(_,__,value)=>{url=new URL(value,url);}},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},localStorage:{getItem:()=>null},document:{querySelector:element,body:element('body'),documentElement:{dataset:{}},addEventListener:(name,handler)=>documentEvents[name]=handler},fetch:async path=>{if(path.endsWith('/me')&&identity)await identity;if(path==='/api/insight-admin/v1/customers'){if(roster)await roster;return reply(rosterFailed?{error:{code:'UNAUTHORIZED',message:'로그인이 만료되었습니다.'}}:{customers:[]},rosterFailed?401:200);}return reply(path.endsWith('/config')?{}:path.endsWith('/auth/logout')?{ok:true}:state);}});
  vm.runInContext(fs.readFileSync(require.resolve('../web/connected.js'),'utf8'),context);await flush();
  return {mounts,analyses,contextMounts,events,storage,location,state,html:()=>element('#main').innerHTML,navigate:(hash)=>{url.hash=hash;events.hashchange();},replace:v=>{url=new URL(v,url);},url:()=>url.href,
    async authenticate(){resolveIdentity?.();await flush();},expire(){cacheContexts.at(-1).onSessionExpired();},
    async failRoster(){rosterFailed=true;resolveRoster?.();await flush();},
    async logout(){const button={dataset:{action:'logout'},disabled:false};await documentEvents.click({target:{closest:()=>button}});await flush();}};
}
test('authenticated current comparison starts from registered companies and shares the chosen own store with region and report menus',async()=>{
  const h=await harness();assert.equal(h.mounts.length,1);const options=h.mounts[0];assert.equal(options.store.getState().ownCompanyId,'own1');assert.deepEqual(options.store.getState().comparisonIds,['cmp1']);
  const updated=options.store.update({ownCompanyId:'own2'});options.onSelectionChange(updated.state);assert.deepEqual(updated.state.comparisonIds,[]);assert.match(h.url(),/ownCompanyId=own2/);
  h.navigate('#regions');assert.equal(h.contextMounts.at(-1).selection.ownCompanyId,'own2');assert.equal(h.analyses.length,0,'collapsed full regional analysis does not start a source read');h.navigate('#reports');assert.equal(h.analyses.at(-1)[4],'own2');h.navigate('#competitors');assert.equal(h.mounts.at(-1).store.getState().ownCompanyId,'own2');
});
test('same-scope reload preserves an explicitly empty set instead of repopulating all registered competitors',async()=>{
  const h=await harness(),options=h.mounts[0];options.onSelectionChange(options.store.update({comparisonIds:[]}).state);
  const reloaded=await harness({query:new URL(h.url()).search,storage:h.storage});assert.deepEqual(reloaded.mounts[0].store.getState().comparisonIds,[]);
  const direct=await harness({storage:h.storage});assert.deepEqual(direct.mounts[0].store.getState().comparisonIds,[]);
});

test('an early route render during authenticated reload preserves the selected competitors until identity arrives',async()=>{
  const initial=await harness(),selected=initial.mounts[0];selected.onSelectionChange(selected.store.update({comparisonIds:['cmp1']}).state);
  const before=initial.storage.get(selection.STORAGE_KEY),reload=await harness({query:new URL(initial.url()).search,storage:initial.storage,deferIdentity:true});
  reload.navigate('#competitors');
  assert.equal(reload.storage.get(selection.STORAGE_KEY),before,'loading identity is not a logout and cannot erase the saved selection');
  assert.equal(reload.mounts.length,0,'saved customer selections do not authorize a view before identity');
  await reload.authenticate();assert.deepEqual(reload.mounts[0].store.getState().comparisonIds,['cmp1']);assert.match(reload.url(),/comparisonIds=cmp1/);
});

test('an early route render restores the same scoped selection without a selection query',async()=>{
  const initial=await harness(),before=initial.storage.get(selection.STORAGE_KEY),reload=await harness({storage:initial.storage,deferIdentity:true});
  reload.navigate('#regions');reload.navigate('#competitors');assert.equal(reload.storage.get(selection.STORAGE_KEY),before);
  await reload.authenticate();assert.deepEqual(reload.mounts[0].store.getState().comparisonIds,['cmp1']);
});

test('restored comparison selection is still partitioned by authenticated customer and permission revision',async()=>{
  for(const change of [state=>{state.customer.customerId='other-customer';},state=>{state.customer.revision++;}]){
    const initial=await harness(),next=JSON.parse(JSON.stringify(initial.state));change(next);
    const reload=await harness({storage:initial.storage,identityState:next,deferIdentity:true});reload.navigate('#competitors');
    await reload.authenticate();assert.deepEqual(reload.mounts[0].store.getState().comparisonIds,[]);
  }
});

test('explicit logout and authenticated session expiry still clear saved selections and invalidate old requests',async()=>{
  for(const action of ['logout','expire']){
    const h=await harness(),store=h.mounts[0].store,token=store.requestToken();assert.ok(h.storage.has(selection.STORAGE_KEY));
    await h[action]();assert.equal(h.storage.has(selection.STORAGE_KEY),false);assert.equal(store.isCurrent(token),false);
    assert.deepEqual(store.getState().comparisonIds,[]);assert.equal(store.getState().ownCompanyId,null);assert.match(h.html(),/로그인/);
  }
});

test('an administrator roster HTTP 401 clears an existing comparison scope and invalidates pending selection tokens',async()=>{
  const h=await harness({adminView:true,deferRoster:true}),store=h.mounts[0].store,token=store.requestToken();
  assert.deepEqual(store.getState().comparisonIds,['cmp1']);assert.ok(h.storage.has(selection.STORAGE_KEY));
  await h.failRoster();assert.equal(h.storage.has(selection.STORAGE_KEY),false);assert.equal(store.isCurrent(token),false);
  assert.equal(store.getState().ownCompanyId,null);assert.deepEqual(store.getState().comparisonIds,[]);assert.match(h.html(),/관리자 로그인이 필요합니다/);
});
test('history restoration coalesces hash transitions while query-only history changes still rerender the current view',async()=>{
  const h=await harness();h.navigate('#regions');const before=h.mounts.length;
  h.replace('/?ownCompanyId=own2&comparisonIds=&stayMode=upcoming30#competitors');h.events.popstate();assert.equal(h.mounts.length,before,'hashchange will render this history entry once');h.events.hashchange();assert.equal(h.mounts.length,before+1);assert.equal(h.mounts.at(-1).store.getState().ownCompanyId,'own2');
  h.replace('/?ownCompanyId=own1&comparisonIds=cmp1&stayMode=upcoming30#competitors');h.events.popstate();assert.equal(h.mounts.length,before+2);assert.equal(h.mounts.at(-1).store.getState().ownCompanyId,'own1');
});
test('registration controls live in settings while every competitor retains its result link',async()=>{
  const h=await harness();assert.match(h.html(),/#company=cmp1/);assert.doesNotMatch(h.html(),/id="search-form"/);assert.match(h.html(),/#settings/);
  h.navigate('#settings');assert.match(h.html(),/data-kind="competitor"/);assert.match(h.html(),/data-action="archive"/);
});
