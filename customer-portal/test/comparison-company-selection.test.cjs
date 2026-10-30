'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const selection=require('../web/comparison-selection.js');
const {buildComparisonSet,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const clone=value=>JSON.parse(JSON.stringify(value)),today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10),shift=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
function fixture({scope='account-a',permission='permission-a',customerId='customer-a',comparisonIds=['same','cross']}={}){
  const start=today(),period={start,end:shift(start,29)},options={mode:'current',asOf:start,period};
  const companies=[['own','r1'],['same','r1'],['cross','r2']].map(([companyId,regionKey],index)=>{
    const raw={companyId,kind:companyId==='own'?'own':'competitor',name:companyId==='own'?'내 매장':'등록 업체 '+companyId,regionKey,rooms:10+index,relationStatus:'active',industryTags:['glamping'],comparisonPurpose:'reference',capacityStatus:'reviewed',days:Array.from({length:30},(_,i)=>({date:shift(start,i),total:10+index,sold:4,publicBookings:2,phoneBookings:2,estimatedRevenue:800000,revenuePartial:false,missing:false,collectedAt:start+'T03:00:00.000Z'}))};
    return {...raw,...summarizeCompany(raw,options),reservationSeries:projectReservationSeries(raw,options)};
  });
  const data={mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{...period,days:30},ownId:'own',companies,comparisons:buildComparisonSet(companies[0],companies.slice(1),options).comparisons,regions:[],actions:[],definitions:[],dataQuality:{status:'complete',issues:[]}};
  const store=selection.createStore({scope,permissionSignature:permission,authorizedOwnCompanyIds:['own'],authorizedComparisonIds:comparisonIds,ownCompanyId:'own',companies,initialState:{ownCompanyId:'own',comparisonIds}});
  return {data,store,state:{customer:{customerId,revision:1,relations:companies.filter(row=>row.companyId==='own'||comparisonIds.includes(row.companyId)).map(row=>({companyId:row.companyId,kind:row.kind,status:'active'}))},companies}};
}
function harness({storage=new Map()}={}){
  const handlers={},slot={innerHTML:'',isConnected:true},status={textContent:''},filterSlot={innerHTML:'',isConnected:true},scrolls=[],focuses=[],timers=new Map();let timerId=0;
  const detail={isConnected:true,focus:options=>focuses.push(options),scrollIntoView:options=>scrolls.push(options)};
  const detailQuery=selector=>selector?.includes('dashboard-company-detail')?detail:null;
  slot.querySelector=detailQuery;slot.querySelectorAll=()=>[];
  const document={activeElement:null,querySelector(selector){return selector==='#comparison-results'?slot:selector==='#comparison-status'?status:selector==='[data-comparison-filter-controls]'?filterSlot:detailQuery(selector);},addEventListener:(name,handler)=>handlers[name]=handler};
  const context=vm.createContext({module:{exports:{}},require:specifier=>require('../web/'+specifier.replace('./','')),sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},document,Date,URL,Promise,requestAnimationFrame:fn=>fn(),setTimeout(fn,ms){timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(fs.readFileSync(require.resolve('../web/comparison-view.js'),'utf8'),context);
  const ui=context.module.exports;
  return {ui,handlers,slot,status,filterSlot,scrolls,focuses,timers,storage,
    mount(f,overrides={}){const options={store:f.store,state:f.state,peek:()=>clone(f.data),read:async()=>clone(f.data),...overrides};ui.mount(options);return options;},
    click(id){const button={dataset:{dashboardCompanySelect:id},hasAttribute:name=>name==='data-dashboard-company-select',getAttribute:name=>name==='data-dashboard-company-select'?id:null};handlers.click({target:{closest:selector=>selector.includes('[data-dashboard-company-select]')?button:null},preventDefault(){}});},
    filter(key,value){const attribute={'start':'data-dashboard-start','end':'data-dashboard-end','dayFilter':'data-dashboard-day-filter'}[key];handlers.change({target:{value,matches:selector=>selector.includes(attribute),hasAttribute:name=>name===attribute}});},
    selected(){return /data-dashboard-company-detail="([^"]+)"/.exec(slot.innerHTML)?.[1]||null;}};
}
const flush=async()=>{await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));};
test('clicking a registered company opens its on-page detail without navigation, new source reads or source mutations',async()=>{
  const f=fixture(),h=harness(),before=JSON.stringify(f.data),comparisonIds=f.store.getState().comparisonIds;let reads=0;
  h.mount(f,{read:async()=>{reads++;return clone(f.data);}});await flush();assert.equal(h.selected(),'own');
  h.click('same');assert.equal(h.selected(),'same');assert.match(h.slot.innerHTML,/data-dashboard-company-select="same"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-dashboard-company-select="same"/);assert.equal(reads,1);assert.equal(JSON.stringify(f.data),before);
  assert.equal(f.store.getState().ownCompanyId,'own','selecting a detail must not change the comparison owner');assert.deepEqual(f.store.getState().comparisonIds,comparisonIds);h.ui.stop();
});
test('a newer main report response preserves the actively selected company',async()=>{
  const f=fixture(),h=harness();let resolve;
  h.mount(f,{read:()=>new Promise(value=>resolve=value)});h.click('cross');assert.equal(h.selected(),'cross');
  const newer=clone(f.data);newer.generatedAt=new Date().toISOString();resolve(newer);await flush();assert.equal(h.selected(),'cross');h.ui.stop();
});
test('an independent saved-company response cannot reset the chosen detail or start an automatic scroll',async()=>{
  const f=fixture(),h=harness();let resolveCompany;
  h.mount(f,{readCompany:()=>new Promise(value=>resolveCompany=value)});await flush();h.click('same');assert.equal(h.selected(),'same');const scrolls=h.scrolls.length;
  resolveCompany({result:null,companyDetail:{companyId:'own'},responseCache:{refreshing:false}});await flush();assert.equal(h.selected(),'same');assert.equal(h.scrolls.length,scrolls,'background redraw must not steal scroll position');h.ui.stop();
});
test('date and weekday filters keep the selected company and do not move scroll position',async()=>{
  const f=fixture(),h=harness();h.mount(f);await flush();h.click('cross');const scrolls=h.scrolls.length;
  h.filter('start',shift(f.data.period.start,2));h.filter('dayFilter','saturday');assert.equal(h.selected(),'cross');assert.equal(h.scrolls.length,scrolls);h.ui.stop();
});
test('crafted clicks cannot select a company outside the rendered authorized comparison',async()=>{
  const f=fixture(),h=harness();h.mount(f);await flush();h.click('same');const html=h.slot.innerHTML;
  h.click('foreign_private');assert.equal(h.selected(),'same');assert.equal(h.slot.innerHTML,html);h.ui.stop();
});
test('clicks during an authorization failure cannot revive an earlier report or company detail',async()=>{
  const f=fixture(),h=harness();let reject;
  h.mount(f,{read:()=>new Promise((_,value)=>reject=value)});h.click('same');reject(Object.assign(Error('denied'),{status:403}));await flush();
  assert.match(h.slot.innerHTML,/조회 권한/);assert.equal(h.selected(),null);const denied=h.slot.innerHTML;h.click('cross');assert.equal(h.slot.innerHTML,denied);assert.equal(h.selected(),null);h.ui.stop();
});
test('tenant and permission partitions reset persisted selection instead of carrying another account choice',async()=>{
  const storage=new Map(),h=harness({storage}),first=fixture();h.mount(first);await flush();h.click('same');assert.equal(h.selected(),'same');h.ui.stop();
  for(const options of [{scope:'account-b',customerId:'customer-b'},{permission:'permission-b'}]){
    const next=fixture(options);h.mount(next);await flush();assert.equal(h.selected(),'own');h.ui.stop();
  }
});
test('same-account remount restores the selected detail without an extra scroll',async()=>{
  const h=harness(),first=fixture();h.mount(first);await flush();h.click('cross');assert.equal(h.selected(),'cross');const scrolls=h.scrolls.length;h.ui.stop();
  h.mount(fixture());await flush();assert.equal(h.selected(),'cross');assert.equal(h.scrolls.length,scrolls);h.ui.stop();
});
test('a permission change rejects an old on-screen button before the next mount',async()=>{
  const f=fixture(),h=harness();h.mount(f);await flush();h.click('same');const before=h.slot.innerHTML,scrolls=h.scrolls.length;
  f.store.configure({permissionSignature:'permission-changed',authorizedComparisonIds:[]});h.click('cross');assert.equal(h.slot.innerHTML,before);assert.equal(h.scrolls.length,scrolls);h.ui.stop();
});
test('removing a selected competitor resets the detail and old requests cannot put it back',async()=>{
  const h=harness(),first=fixture();let resolve;
  h.mount(first,{read:()=>new Promise(value=>resolve=value)});h.click('cross');assert.equal(h.selected(),'cross');h.ui.stop();
  const next=fixture({permission:'permission-without-cross',comparisonIds:['same']});next.data.companies=next.data.companies.filter(row=>row.companyId!=='cross');next.data.comparisons=next.data.comparisons.filter(row=>row.companyId!=='cross');
  h.mount(next);await flush();assert.equal(h.selected(),'own');const current=h.slot.innerHTML;resolve(clone(first.data));await flush();assert.equal(h.slot.innerHTML,current);assert.equal(h.selected(),'own');h.ui.stop();
});
