'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),http=require('node:http');
const dashboard=require('../web/comparison-dashboard.js'),selection=require('../web/comparison-selection.js');
const {evaluateComparison,summarizeCompany,projectReservationSeries}=require('../../scripts/lib/insight_comparison.cjs');
const {projectComparison}=require('../comparison-projection.cjs');
const START=new Date(Date.now()+9*3600000).toISOString().slice(0,10),DAY=86400000;
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10),END=shift(START,29),clone=v=>JSON.parse(JSON.stringify(v));
const days=Array.from({length:30},(_,i)=>shift(START,i));
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2;};
const metric=(model,key)=>model.metrics.find(row=>row.id===key);
function fixture({mismatch=false}={}){
  const policy={mode:'current',asOf:START,period:{start:START,end:END},observationPolicy:{confirmed:true,maxSkewMs:7200000}};
  const raw=['own','same'].map((companyId,index)=>({companyId,kind:index?'competitor':'own',name:index?'같은 지역 업체':'내 매장',regionKey:'sancheong',regionLabel:'산청군',rooms:10,
    relationStatus:'active',industryTags:['glamping'],comparisonPurpose:'direct',capacityStatus:'reviewed',capacityReviewRequired:false,
    days:days.map(date=>({date,total:10,sold:3+index,publicBookings:2+index,phoneBookings:1,missing:false,estimatedRevenue:300000,
      collectedAt:(index&&mismatch?shift(START,-1):START)+'T01:00:00.000Z'}))}));
  const report={mode:'current_briefing',published:false,ownId:'own',asOf:START,selection:{stayMode:'upcoming30'},period:{start:START,end:END,days:30},generatedAt:START+'T02:00:00.000Z',dataQuality:{status:'complete',issues:[]},
    companies:raw.map(c=>{const out={...c,sourceStatus:'ready',sourceIssues:[],...summarizeCompany(c,policy),reservationSeries:projectReservationSeries(c,policy)};delete out.days;out.summaryQuality.mode='current';return out;}),
    comparisons:[projectComparison(evaluateComparison(raw[0],raw[1],policy))]};
  const catalog=raw.map(c=>({companyId:c.companyId,name:c.name,rooms:c.rooms}));
  const s={ownCompanyId:'own',comparisonIds:['same'],stayMode:'upcoming30',stayStart:START,stayEnd:END,asOfDate:START,selectedView:'flow'};
  const store=selection.createStore({scope:'saved-integration',permissionSignature:'p1',authorizedOwnCompanyIds:['own'],authorizedComparisonIds:['same'],ownCompanyId:'own',companies:raw,initialState:s});
  const state={customer:{customerId:'customer-one',username:'first',revision:1,relations:raw.map(c=>({companyId:c.companyId,kind:c.kind,status:'active'}))},companies:catalog};
  return {report,catalog,selection:s,store,state};
}
function payload(companyId='own',month=START.slice(0,7)){
  const last=new Date(Date.parse(month+'-01T00:00:00Z'));last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
  const dates=days.filter(date=>date.startsWith(month+'-'));
  return {result:{companyId,runId:'saved-run-'+companyId,collectedAt:START+'T01:00:00.000Z',range:{start:START,end:END,days:30},quality:{status:'complete'},products:[
    {bizItemId:'room',name:'숙박 객실',productType:'lodging',days:days.map((date,i)=>({date,status:'observed',price:200000+i*1000,errorCode:null}))},
    {bizItemId:'day',name:'데이유즈',productType:'dayuse',days:days.map(date=>({date,status:'observed',price:1,errorCode:null}))}]},
    companyDetail:{companyId,integrated:{companyId,status:'ready',calculationVersion:'saved-calculation-v1',selectedMonth:month,
      snapshot:{period:{start:month+'-01',end:last.toISOString().slice(0,10),cutoffDate:START},analysis:{pickup:{status:'ready',comparableIntervals:dates.length,
        intervals:dates.map(date=>({date,previousCollectedAt:shift(START,-1)+'T01:00:00.000Z',collectedAt:START+'T01:00:00.000Z',publicChange:1,blockedChange:-1,netChange:0}))}}}}}};
}
const sources=()=>Object.fromEntries(['own','same'].map(id=>[id,{status:'ready',payloads:[...new Set(days.map(d=>d.slice(0,7)))].map(month=>payload(id,month))}]));
test('dashboard combines existing company prices and same-interval pickup without dayuse or duplicate monthly rows',()=>{
  const f=fixture(),input=sources(),before=JSON.stringify(input),model=dashboard.project(f.report,f.selection,f.catalog,{},input);
  assert.equal(model.contextValid,true);assert.equal(metric(model,'product_price').value,214500);assert.equal(metric(model,'public_change').value,30);
  assert.equal(metric(model,'public_change').status,'reference');assert.equal(model.own.savedMetrics.price.rowCount,30);
  assert.equal(model.own.savedMetrics.pickup.days,30);assert.equal(model.executionAllowed,false);assert.equal(JSON.stringify(input),before);
  assert.notEqual(metric(model,'product_price').reasonCode,'PRICE_NOT_CONNECTED');
});
test('range and weekday filters recalculate prices and pickup from precisely the displayed dates',()=>{
  const f=fixture(),input=sources();
  for(const filters of [{dayFilter:'saturday'},{start:shift(START,3),end:shift(START,10),dayFilter:'weekday'}]){
    const model=dashboard.project(f.report,f.selection,f.catalog,filters,input),values=model.dates.map(d=>200000+days.indexOf(d)*1000);
    assert.ok(model.dates.length);assert.equal(metric(model,'product_price').value,median(values));assert.equal(metric(model,'public_change').value,model.dates.length);
    assert.equal(model.own.savedMetrics.price.rowCount,model.dates.length);assert.deepEqual(model.own.savedMetrics.price.rows.map(row=>row.date),model.dates);
    assert.deepEqual(model.own.savedMetrics.pickup.rows.map(row=>row.date),model.dates);
  }
});
test('company detail receives filter-scoped allowlisted source rows without another company or unselected date leaking into the model',()=>{
  const f=fixture(),input=sources(),filters={start:shift(START,2),end:shift(START,4),dayFilter:'all'};
  for(const saved of input.own.payloads){saved.result.products[0].privateCookie='PRIVATE-PRICE-COOKIE';saved.result.products[0].days[0].privatePayload='PRIVATE-DAY-PAYLOAD';}
  input.foreign={status:'ready',payloads:[payload('foreign')],private:'PRIVATE-UNREGISTERED-SOURCE'};
  const model=dashboard.project(f.report,f.selection,f.catalog,filters,input),own=model.companies.find(row=>row.companyId==='own');
  assert.deepEqual(own.points.map(row=>row.date),model.dates);assert.deepEqual(own.savedMetrics.price.rows.map(row=>row.date),model.dates);
  assert.deepEqual(own.savedMetrics.pickup.rows.map(row=>row.date),model.dates);
  assert.deepEqual(own.savedMetrics.price.rows.map(row=>row.price),[202000,203000,204000]);
  assert.equal(own.savedMetrics.price.source.runId,'saved-run-own');assert.equal(own.savedMetrics.price.rows.length,3);
  assert.equal(model.companies.some(row=>row.companyId==='foreign'),false);assert.doesNotMatch(JSON.stringify(model),/PRIVATE-PRICE-COOKIE|PRIVATE-DAY-PAYLOAD|PRIVATE-UNREGISTERED-SOURCE/);
  assert.equal(model.executionAllowed,false);
});
test('different observed days keep a typed benchmark hold while individual saved prices remain available',()=>{
  const f=fixture({mismatch:true}),model=dashboard.project(f.report,f.selection,f.catalog,{},sources());
  assert.equal(metric(model,'peer_rate').value,null);assert.equal(metric(model,'peer_rate').reasonCode,'OBSERVATION_DATE_MISMATCH');
  assert.match(metric(model,'peer_rate').reason,/관측일이 달라/);assert.equal(metric(model,'product_price').value,214500);assert.equal(model.judgments[0].status,'hold');
});
test('foreign payloads and invalid customer selections never contribute source amounts or private labels',()=>{
  const f=fixture(),input=sources();input.same.payloads=[payload('foreign')];input.foreign={payloads:[payload('foreign')],private:'PRIVATE-SOURCE'};
  const model=dashboard.project(f.report,f.selection,f.catalog,{},input),same=model.companies.find(c=>c.companyId==='same');
  assert.equal(same.savedMetrics.price.value,null);assert.equal(same.savedMetrics.price.reasonCode,'SOURCE_CONTEXT_MISMATCH');assert.doesNotMatch(JSON.stringify(model),/PRIVATE-SOURCE/);
  const invalid=dashboard.project(f.report,{...f.selection,comparisonIds:['foreign']},f.catalog,{},input);
  assert.equal(invalid.contextValid,false);assert.deepEqual(invalid.companies,[]);assert.ok(invalid.metrics.every(m=>m.value===null));
});
test('a pending saved-only payload preserves valid pickup and labels only missing price as loading rather than unconnected',()=>{
  const f=fixture(),input=sources();
  for(const entry of Object.values(input)){entry.status='loading';for(const saved of entry.payloads)delete saved.result;}
  let model=dashboard.project(f.report,f.selection,f.catalog,{},input);
  assert.equal(metric(model,'product_price').value,null);assert.equal(metric(model,'product_price').reasonCode,'SOURCE_LOADING');
  assert.equal(metric(model,'public_change').value,30);assert.equal(metric(model,'public_change').status,'reference');
  assert.equal(metric(model,'public_change').reasonCode,'PICKUP_REFERENCE_ONLY');
  input.own.status='failed';input.own.errorCode='SOURCE_READ_FAILED';model=dashboard.project(f.report,f.selection,f.catalog,{},input);
  assert.equal(metric(model,'product_price').reasonCode,'SOURCE_READ_FAILED');assert.equal(metric(model,'public_change').value,30);
});
function harness(){
  const f=fixture(),handlers={},slot={innerHTML:'',isConnected:true},filterSlot={innerHTML:''},status={textContent:''},timers=[],storage=new Map();
  const context=vm.createContext({module:{exports:{}},require:specifier=>require('../web/'+specifier.replace('./','')),Date,URL,Promise,
    sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    document:{querySelector:key=>key==='#comparison-results'?slot:key==='#comparison-status'?status:key==='[data-comparison-filter-controls]'?filterSlot:null,addEventListener:(name,fn)=>handlers[name]=fn},
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}});
  vm.runInContext(fs.readFileSync(require.resolve('../web/comparison-view.js'),'utf8'),context);
  return {...f,ui:context.module.exports,handlers,slot,filterSlot,status,timers};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const sourceValue=html=>html.match(/data-dashboard-metric="product_price"[\s\S]*?<strong>([^<]*)<\/strong>/)?.[1];
test('slow saved company reads do not delay a saved briefing and are processed sequentially',async()=>{
  const h=harness(),reads=[];let resolve;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),readCompany:(id,options)=>{reads.push([id,options.month]);return new Promise(r=>resolve=r);}});
  assert.match(h.slot.innerHTML,/내 매장/);assert.match(h.slot.innerHTML,/data-dashboard-metric="own_rate"/);assert.match(h.slot.innerHTML,/저장 자료 조회 중/);assert.equal(reads.length,1);
  resolve(payload('own',reads[0][1]));await flush();assert.equal(reads.length,2);assert.equal(sourceValue(h.slot.innerHTML),'214,500원');h.ui.stop();
});
test('a source reply arriving after a display filter change respects the latest filter without another briefing read',async()=>{
  const h=harness();let resolve,briefingReads=0,sourceReads=0;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>{briefingReads++;return new Promise(()=>{});},readCompany:()=>{sourceReads++;return new Promise(r=>resolve=r);}});
  h.handlers.change({target:{value:'saturday',matches:()=>true,hasAttribute:()=>false}});
  const selected=days.filter(d=>new Date(d+'T00:00:00Z').getUTCDay()===6),expected=median(selected.map(d=>200000+days.indexOf(d)*1000)).toLocaleString('ko-KR')+'원';
  resolve(payload('own'));await flush();
  assert.equal(sourceValue(h.slot.innerHTML),expected);assert.match(h.filterSlot.innerHTML,/value="saturday" selected/);assert.equal(briefingReads,1);assert.equal(sourceReads,2);h.ui.stop();
});
test('saved-only previews retain pickup and a loading price badge until automatic source polling supplies the normal price',async()=>{
  const h=harness(),reads=new Map();
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),readCompany:async(id,{month})=>{
    const key=id+month,n=reads.get(key)||0;reads.set(key,n+1);const out=payload(id,month);
    if(n===0){delete out.result;out.responseCache={refreshing:true};out.referenceLoading=true;}return out;
  }});
  await flush();
  assert.equal(sourceValue(h.slot.innerHTML),'미확인');
  assert.match(h.slot.innerHTML,/data-dashboard-metric="product_price"[\s\S]*?data-reason-code="SOURCE_LOADING"/);
  assert.match(h.slot.innerHTML,/data-dashboard-metric="public_change"[\s\S]*?<strong>\+30실<\/strong>/);
  const poll=h.timers.find(timer=>timer.ms===2000);assert.ok(poll,'an updating source schedules a bounded follow-up read');
  poll.fn();await flush();
  assert.equal(sourceValue(h.slot.innerHTML),'214,500원');
  assert.ok([...reads.values()].every(n=>n===2),'normal prices arrive through one source follow-up rather than a new briefing or collection');h.ui.stop();
});
test('late source replies or authentication failures after stop, selected competitors or customer change never alter another context',async()=>{
  for(const cause of ['stop','selection','customer','permission'])for(const rejectReply of [false,true]){
    const h=harness();let resolve,reject,expired=0;
    h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),readCompany:()=>new Promise((r,j)=>{resolve=r;reject=j;}),onSessionExpired:()=>expired++});
    if(cause==='stop')h.ui.stop();
    else if(cause==='selection')h.store.update({comparisonIds:[]});
    else if(cause==='customer')h.state.customer.customerId='another-customer';
    else h.store.configure({permissionSignature:'p2',authorizedComparisonIds:[]});
    h.slot.innerHTML='new context';if(rejectReply)reject(Object.assign(Error('old source'),{status:401}));else resolve(payload());await flush();
    assert.equal(h.slot.innerHTML,'new context',cause+' '+rejectReply);assert.equal(expired,0);h.ui.stop();
  }
});
test('a saved source cache displays immediately and a temporary error preserves those valid values',async()=>{
  const h=harness();
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),peekCompany:(id,month)=>payload(id,month),readCompany:async()=>{throw Object.assign(Error('transient'),{status:503});}});
  assert.equal(sourceValue(h.slot.innerHTML),'214,500원');await flush();assert.equal(sourceValue(h.slot.innerHTML),'214,500원');assert.match(h.slot.innerHTML,/saved-run-own/);h.ui.stop();
});
test('a current source permission denial clears that company cache and skips later months without resurrecting denied values',async()=>{
  const h=harness();let ownReads=0;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),
    peekCompany:(id,month)=>{const out=payload(id,month);if(id==='own')for(const row of out.result.products[0].days)row.price=999999;return out;},
    readCompany:async(id,{month})=>{if(id==='own'){ownReads++;throw Object.assign(Error('denied source'),{status:403});}return payload(id,month);}});
  assert.equal(sourceValue(h.slot.innerHTML),'999,999원');await flush();
  assert.equal(sourceValue(h.slot.innerHTML),'미확인');assert.equal(ownReads,1,'another month of a denied company is not retried');assert.doesNotMatch(h.slot.innerHTML,/999,999원/);h.ui.stop();
});
test('a current source session expiry cancels source reads and notifies once without reviving cached metrics',async()=>{
  const h=harness();let sourceReads=0,expired=0;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise(()=>{}),peekCompany:(id,month)=>payload(id,month),
    readCompany:async()=>{sourceReads++;throw Object.assign(Error('expired'),{status:401});},onSessionExpired:()=>expired++});
  await flush();assert.equal(expired,1);assert.equal(sourceReads,1);assert.equal(sourceValue(h.slot.innerHTML),'미확인');h.ui.stop();
});
test('a main report permission denial cannot be overwritten by a late successful company source response',async()=>{
  const h=harness();let rejectReport,resolveSource,sourceReads=0;
  h.ui.mount({store:h.store,state:h.state,peek:()=>clone(h.report),read:()=>new Promise((_,reject)=>rejectReport=reject),
    readCompany:()=>{sourceReads++;return new Promise(resolve=>resolveSource=resolve);}});
  assert.match(h.slot.innerHTML,/data-dashboard-metric="own_rate"/);
  rejectReport(Object.assign(Error('report denied'),{status:403}));await flush();
  const warning=h.slot.innerHTML;assert.match(warning,/조회 권한/);assert.doesNotMatch(warning,/data-dashboard-metric/);
  resolveSource(payload());await flush();
  assert.equal(h.slot.innerHTML,warning);assert.equal(sourceReads,1,'late source completion cannot continue another source job after report denial');h.ui.stop();
});
test('the production connected page loads the new helper before its consumer and serves it as an immutable versioned asset',async t=>{
  const {createConnectedServer}=require('../connected-server.cjs');
  const origin='http://127.0.0.1:58057',server=createConnectedServer({origin,backend:'https://saved-source.invalid',serviceToken:'local-fixture-service-token-not-real',fetchImpl:async()=>assert.fail('static assets must not read upstream')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=route=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:server.address().port,path:route,headers:{host:new URL(origin).host}},response=>{let body='';response.on('data',part=>body+=part);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body}));}).on('error',reject);});
  const html=await get('/login');assert.equal(html.status,200);const helper=html.body.match(/\/comparison-saved-metrics\.js\?v=[^"'<>]+/);
  assert.ok(helper);assert.ok(html.body.indexOf(helper[0])<html.body.indexOf('/comparison-dashboard.js?v='));
  const asset=await get(helper[0]);assert.equal(asset.status,200);assert.match(asset.headers['content-type'],/javascript/);assert.match(asset.body,/InsightComparisonSavedMetrics/);assert.match(asset.headers['cache-control'],/immutable/);
  const connected=await get('/connected.js');assert.match(connected.body,/peekCompany:[\s\S]*readCompany:/);assert.doesNotMatch(connected.body,/comparison[^\n]*api\/crawl/);
});
