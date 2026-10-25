'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const selection=require('../web/comparison-selection.js');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness({query='',storage=new Map()}={}){
  let url=new URL('http://localhost/'+query+'#competitors');const events={},elements=new Map(),mounts=[],analyses=[];
  const state={customer:{customerId:'fixture',username:'검수',revision:1,settings:{},regions:[],businessStatus:'owned',relations:[{companyId:'own1',kind:'own',status:'active'},{companyId:'own2',kind:'own',status:'active'},{companyId:'cmp1',kind:'competitor',status:'active'}],entitlements:{competitorLimit:3,interestRegionLimit:1}},companies:[{companyId:'own1',name:'내 매장1',regionKey:'r1',rooms:16},{companyId:'own2',name:'내 매장2',regionKey:'r2',rooms:18},{companyId:'cmp1',name:'경쟁업체',regionKey:'r1',rooms:10}],regions:[{id:'r1',label:'지역1'},{id:'r2',label:'지역2'}],corrections:[],preparations:[],features:{directCollection:false},companyViews:[],regionViews:[],reportViews:[]};
  const element=id=>{if(!elements.has(id))elements.set(id,{innerHTML:'',textContent:'',hidden:false,classList:{toggle(){},add(){},remove(){}},focus(){}});return elements.get(id);};
  const location={get href(){return url.href;},get pathname(){return url.pathname;},get hash(){return url.hash;},set hash(v){url.hash=v;},get search(){return url.search;}};
  const window={addEventListener:(name,fn)=>events[name]=fn,scrollTo(){},InsightComparisonSelection:selection,
    InsightComparisonView:{stop(){},panel:(s,selected)=>`<div data-own="${selected.ownCompanyId}">현재 비교</div>`,mount:options=>mounts.push(options)},
    InsightCollection:{stop(){},setContext(){},restore(){},panel:()=>'<div>ABC</div>',mount(){},prefetch(){}},
    InsightAnalysis:{stop(){},configureCache(){},configureReports(){},restore(){},restoreReports(){},panel:()=>'<div>분석</div>',mount:(...args)=>analyses.push(args),peekCurrentBriefing:()=>null,readCurrentBriefing:async()=>({})}
  };
  const context=vm.createContext({window,location,URL,URLSearchParams,history:{replaceState:(_,__,value)=>{url=new URL(value,url);}},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},localStorage:{getItem:()=>null},document:{querySelector:element,body:element('body'),documentElement:{dataset:{}},addEventListener(){}},fetch:async path=>({ok:true,status:200,json:async()=>path.endsWith('/config')?{}:state})});
  vm.runInContext(fs.readFileSync(require.resolve('../web/connected.js'),'utf8'),context);await flush();
  return {mounts,analyses,events,storage,location,state,html:()=>element('#main').innerHTML,navigate:(hash)=>{url.hash=hash;events.hashchange();},replace:v=>{url=new URL(v,url);},url:()=>url.href};
}
test('authenticated current comparison starts from registered companies and shares the chosen own store with region and report menus',async()=>{
  const h=await harness();assert.equal(h.mounts.length,1);const options=h.mounts[0];assert.equal(options.store.getState().ownCompanyId,'own1');assert.deepEqual(options.store.getState().comparisonIds,['cmp1']);
  const updated=options.store.update({ownCompanyId:'own2'});options.onSelectionChange(updated.state);assert.deepEqual(updated.state.comparisonIds,[]);assert.match(h.url(),/ownCompanyId=own2/);
  h.navigate('#regions');assert.equal(h.analyses.at(-1)[4],'own2');h.navigate('#reports');assert.equal(h.analyses.at(-1)[4],'own2');h.navigate('#competitors');assert.equal(h.mounts.at(-1).store.getState().ownCompanyId,'own2');
});
test('same-scope reload preserves an explicitly empty set instead of repopulating all registered competitors',async()=>{
  const h=await harness(),options=h.mounts[0];options.onSelectionChange(options.store.update({comparisonIds:[]}).state);
  const reloaded=await harness({query:new URL(h.url()).search,storage:h.storage});assert.deepEqual(reloaded.mounts[0].store.getState().comparisonIds,[]);
  const direct=await harness({storage:h.storage});assert.deepEqual(direct.mounts[0].store.getState().comparisonIds,[]);
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
