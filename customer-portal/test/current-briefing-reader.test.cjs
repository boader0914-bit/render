'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../web/analysis.js'),'utf8'),AT=Date.parse('2026-10-25T00:00:00Z'),DAY=86400000;
const copy=value=>JSON.parse(JSON.stringify(value));
function report({ownId='own_a',sold=0,at=AT}={}){
  const period={start:'2026-10-25',end:'2026-11-23',days:30},summary={days:30,supply:300,sold,reservationRate:sold/300,publicBookings:sold,phoneBookings:0,estimatedRevenue:null};
  return {mode:'current_briefing',published:false,ownId,generatedAt:new Date(at).toISOString(),period,companies:ownId?[{companyId:ownId,kind:'own',summary}]:[],comparisons:[],regions:[],actions:[],definitions:[],responseCache:{state:'fresh',checkedAt:new Date(at).toISOString(),refreshing:false,refreshFailed:false}};
}
function harness(){
  let now=AT,scope='customer:a',permissionVersion='revision1',ownIds=['own_a','own_b'],companyIds=['own_a','own_b','competitor'],expired=0;
  const window={},document={addEventListener(){},querySelector(){throw Error('DOM-independent reader must not query a view');}};
  class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  vm.runInContext(source,vm.createContext({window,document,Date:Clock,setTimeout,clearTimeout}));
  const view=window.InsightAnalysis,calls=[];
  const request=(path,payload,options)=>new Promise((resolve,reject)=>calls.push({path,payload,options,resolve,reject}));
  const configure=(changes={})=>{
    ({scope,permissionVersion,ownIds,companyIds}={scope,permissionVersion,ownIds,companyIds,...changes});
    view.configureReports({scope,permissionVersion,ownIds,companyIds,regionKeys:[],onSessionExpired(){expired++;}});
  };configure();
  return {view,request,calls,configure,expired:()=>expired,advance(ms){now+=ms;},
    restore(data=report(),ownId='own_a',savedScope=scope){view.restoreReports([{ownId,period:data.period,data}],savedScope);}};
}
test('independent reader and peek share authorized saved values without rendering or starting collection',async()=>{
  const h=harness(),data=report();h.restore(data);const shown=h.view.peekCurrentBriefing('own_a');
  assert.equal(shown.companies[0].summary.publicBookings,0);assert.equal(shown.companies[0].summary.estimatedRevenue,null);
  shown.companies[0].summary.publicBookings=999;assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.publicBookings,0);
  const read=h.view.readCurrentBriefing('own_a',h.request);assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/reports/briefing?ownId=own_a&stayMode=upcoming30');
  assert.equal(h.calls[0].payload,undefined);assert.equal(h.calls[0].options.refresh,false);
  h.calls[0].resolve(report({sold:7}));const value=await read;assert.equal(value.companies[0].summary.sold,7);
  value.companies[0].summary.sold=99;assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,7);
});
test('concurrent comparison readers share one ordinary GET and explicit refresh has its own pending key',async()=>{
  const h=harness(),a=h.view.readCurrentBriefing('own_a',h.request),b=h.view.readCurrentBriefing('own_a',h.request),forced=h.view.readCurrentBriefing('own_a',h.request,{force:true});
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].options.refresh,true);
  h.calls[0].resolve(report());h.calls[1].resolve(report({sold:8}));await Promise.all([a,b,forced]);
  assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,8);
});
test('a saved normal result remains the peek preference while a saved-only preview reports pending calculation',async()=>{
  const h=harness();h.restore(report({sold:9}));const pending=h.view.readCurrentBriefing('own_a',h.request);
  const preview=report({sold:4});preview.calculation={mode:'saved_only',status:'pending',oldestSourceCalculatedAt:null,latestSourceCalculatedAt:null};preview.responseCache={state:'preview',preview:true,checkedAt:new Date(AT).toISOString(),refreshing:true,refreshFailed:false,calculationStatus:'pending'};
  h.calls[0].resolve(preview);assert.equal((await pending).calculation.status,'pending');assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,9);
});
for(const status of [502,503,504])test(`HTTP ${status} keeps previously saved values and their original clocks`,async()=>{
  const h=harness(),data=report({sold:5});h.restore(data);const read=h.view.readCurrentBriefing('own_a',h.request);
  h.calls[0].reject(Object.assign(Error('Temporary source read failure'),{status}));await assert.rejects(read,error=>error.status===status);
  assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,5);assert.equal(h.view.peekCurrentBriefing('own_a').responseCache.checkedAt,data.responseCache.checkedAt);
});
test('current 401 expires the account without touching the DOM and cannot resurrect old reports',async()=>{
  const h=harness();h.restore();const read=h.view.readCurrentBriefing('own_a',h.request);h.calls[0].reject(Object.assign(Error('Expired'),{status:401}));
  await assert.rejects(read,error=>error.status===401);assert.equal(h.expired(),1);assert.equal(h.view.peekCurrentBriefing('own_a'),null);
  h.restore();assert.equal(h.view.peekCurrentBriefing('own_a'),null);
});
for(const status of [403,404,409])test(`current HTTP ${status} purges denied comparison data and the next GET requires refresh`,async()=>{
  const h=harness();h.restore();const read=h.view.readCurrentBriefing('own_a',h.request);h.calls[0].reject(Object.assign(Error('Denied'),{status}));await assert.rejects(read,error=>error.status===status);
  assert.equal(h.view.peekCurrentBriefing('own_a'),null);h.restore();assert.equal(h.view.peekCurrentBriefing('own_a'),null);
  const retry=h.view.readCurrentBriefing('own_a',h.request);assert.equal(h.calls[1].options.refresh,true);h.calls[1].resolve(report({sold:6}));await retry;
  assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,6);
});
test('account, registration and explicit cache invalidation reject former pending results before accepting data',async()=>{
  for(const change of [h=>h.configure({scope:'customer:b'}),h=>h.configure({permissionVersion:'revision2'}),h=>h.configure({ownIds:['own_b']}),h=>h.view.clearCache()]){
    const h=harness(),old=h.view.readCurrentBriefing('own_a',h.request);change(h);h.calls[0].resolve(report({sold:99}));
    await assert.rejects(old,error=>error.status===409&&error.code==='REPORT_SELECTION_CHANGED');assert.equal(h.view.peekCurrentBriefing('own_a'),null);
  }
});
test('a former-account 401 cannot expire the replacement account',async()=>{
  const h=harness(),old=h.view.readCurrentBriefing('own_a',h.request);h.configure({scope:'customer:b'});const current=h.view.readCurrentBriefing('own_a',h.request);
  h.calls[1].resolve(report({sold:7}));await current;h.calls[0].reject(Object.assign(Error('Old expired'),{status:401}));await assert.rejects(old,error=>error.status===409);
  assert.equal(h.expired(),0);assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,7);
});
test('KST midnight rejects old rolling-period results rather than relabeling them as the next day',async()=>{
  const h=harness(),old=h.view.readCurrentBriefing('own_a',h.request);h.advance(DAY);h.calls[0].resolve(report({sold:99}));
  await assert.rejects(old,error=>error.status===409);assert.equal(h.view.peekCurrentBriefing('own_a'),null);
});
test('unknown own stores, wrong response periods and unauthorized companies do not enter the shared cache',async()=>{
  const h=harness();assert.equal(h.view.peekCurrentBriefing('unregistered'),null);await assert.rejects(h.view.readCurrentBriefing('unregistered',h.request),error=>error.status===403);assert.equal(h.calls.length,0);
  for(const mutate of [r=>{r.ownId='own_b';},r=>{r.period.start='2026-10-24';},r=>{r.companies.push({companyId:'secret',kind:'competitor',summary:{}});}]){
    const read=h.view.readCurrentBriefing('own_a',h.request),data=report();mutate(data);h.calls.at(-1).resolve(data);await assert.rejects(read);assert.equal(h.view.peekCurrentBriefing('own_a'),null);
  }
});
test('a force result finishing first prevents an older ordinary response from rewinding data and check time',async()=>{
  const h=harness(),ordinary=h.view.readCurrentBriefing('own_a',h.request),forced=h.view.readCurrentBriefing('own_a',h.request,{force:true});
  h.advance(1000);const newest=report({sold:9,at:AT+1000});h.calls[1].resolve(newest);await forced;
  h.calls[0].resolve(report({sold:1}));const olderCompletion=await ordinary;
  assert.equal(olderCompletion.companies[0].summary.sold,9);assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,9);
  assert.equal(h.view.peekCurrentBriefing('own_a').responseCache.checkedAt,newest.responseCache.checkedAt);
});
test('a late view joining the original singleflight cannot acquire a newer request order than a force read',async()=>{
  const h=harness(),first=h.view.readCurrentBriefing('own_a',h.request),forced=h.view.readCurrentBriefing('own_a',h.request,{force:true}),lateJoin=h.view.readCurrentBriefing('own_a',h.request);
  assert.equal(h.calls.length,2);h.calls[1].resolve(report({sold:9}));await forced;h.calls[0].resolve(report({sold:1}));
  assert.equal((await first).companies[0].summary.sold,9);assert.equal((await lateJoin).companies[0].summary.sold,9);
});
test('an older normal completion still takes precedence over a newer saved-only preview',async()=>{
  const h=harness(),ordinary=h.view.readCurrentBriefing('own_a',h.request),forced=h.view.readCurrentBriefing('own_a',h.request,{force:true});
  const preview=report({sold:4});preview.calculation={mode:'saved_only',status:'pending',oldestSourceCalculatedAt:null,latestSourceCalculatedAt:null};preview.responseCache={state:'preview',preview:true,checkedAt:new Date(AT).toISOString(),refreshing:true,refreshFailed:false,calculationStatus:'pending'};
  h.calls[1].resolve(preview);await forced;assert.equal(h.view.peekCurrentBriefing('own_a').calculation.status,'pending');
  h.calls[0].resolve(report({sold:9}));await ordinary;assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,9);assert.equal(h.view.peekCurrentBriefing('own_a').calculation,undefined);
});
test('an old preview completing after a newer normal read returns the normal result without fake pending status',async()=>{
  const h=harness(),ordinary=h.view.readCurrentBriefing('own_a',h.request),forced=h.view.readCurrentBriefing('own_a',h.request,{force:true});
  h.calls[1].resolve(report({sold:9}));await forced;
  const preview=report({sold:4});preview.calculation={mode:'saved_only',status:'pending',oldestSourceCalculatedAt:null,latestSourceCalculatedAt:null};preview.responseCache={state:'preview',preview:true,checkedAt:new Date(AT).toISOString(),refreshing:true,refreshFailed:false,calculationStatus:'pending'};
  h.calls[0].resolve(preview);const old=await ordinary;assert.equal(old.companies[0].summary.sold,9);assert.equal(old.calculation,undefined);assert.equal(h.view.peekCurrentBriefing('own_a').companies[0].summary.sold,9);
});
