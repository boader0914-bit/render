'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const ok=data=>({status:200,ok:true,data});
const fail=status=>({status,ok:false,data:{error:{code:'HTTP_'+status}}});
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function identity(ids=['a']){return {customer:{customerId:'customer',accountStatus:'active',revision:1,relations:ids.map(companyId=>({companyId,kind:'own',status:'active'}))},companies:ids.map(companyId=>({companyId,rooms:16,version:1})),preparations:[],collectionAllowance:{canRequest:false,limit:1}};}
function source(month='2026-09'){
  const daily=[{date:month+'-01',sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:0,missing:false},{date:month+'-02',sold:null,estimatedRevenue:null,missing:true}];
  return {request:null,result:{companyId:'a',version:'verified',products:[]},companyDetail:{companyId:'a',basics:{companyId:'a',name:'업체 A',rooms:16},channels:[],current:{summary:{sold:0,estimatedRevenue:0},daily},integrated:{companyId:'a',status:'ready',selectedMonth:month,calculationVersion:'company-integrated-v4-product-max-room-reuse',snapshot:{summary:{sold:0,estimatedRevenue:0},daily}}}};
}
function preview(month='2026-09'){return {...source(month),result:null,referenceLoading:true,calculation:{mode:'saved_only',status:'pending'},responseCache:{state:'preview',preview:true,refreshing:true}};}
function fixture(options={}){
  let now=Date.parse('2026-10-25T00:00:00Z'),guards=0,full=0,saved=0,archives=0,writes=0;
  const disk={async ready(){},get(){return null;},list(){return [];},begin(){return {};},async put(){writes++;},async flush(){},status(){return {};}};
  const cache=createCompanyReadCache({now:()=>now,namespace:'central',persistentStore:disk,onVerifiedSource:async()=>{archives++;},...options});
  const read=(extra={})=>cache.read({scope:'session-a',audience:'insight:customer',companyId:'a',month:'2026-09',readIdentity:async()=>{guards++;return ok(identity());},readSavedSource:async()=>{saved++;return ok(preview());},readSource:async()=>{full++;return ok(source());},...extra});
  return {cache,read,advance(ms){now+=ms;},counts:()=>({guards,full,saved,archives,writes})};
}
test('a cold saved month renders before slow full work and only verified completion persists and archives',async()=>{
  const f=fixture(),pending=defer(),contexts=[];
  const first=await f.read({readSource:context=>{contexts.push(context);return pending.promise;}});
  assert.equal(first.status,200);assert.equal(first.data.responseCache.state,'preview');assert.equal(first.data.responseCache.refreshing,true);
  assert.equal(first.data.calculation.mode,'saved_only');assert.equal(first.data.referenceLoading,true);
  assert.equal(first.data.companyDetail.current.daily[0].estimatedRevenue,0);assert.equal(first.data.companyDetail.current.daily[1].estimatedRevenue,null);
  assert.equal(first.data.result,null);assert.deepEqual(f.counts(),{guards:1,full:0,saved:1,archives:0,writes:0});
  assert.equal(contexts[0].background,true,'only the matching saved core permits a longer background read');
  assert.deepEqual(await f.cache.snapshot({scope:'session-a',identity:identity(),audience:'insight:customer'}),[],'display previews are not normal bootstrap snapshots');
  await f.read({readSource:()=>pending.promise});assert.equal(f.counts().saved,1,'one preview and full refresh are shared');
  pending.resolve(ok(source()));await turn();
  const latest=await f.read();assert.equal(latest.data.responseCache.state,'cached');assert.equal(latest.data.result.version,'verified');
  assert.equal(latest.data.calculation,undefined);assert.equal(latest.data.referenceLoading,undefined);assert.equal(f.counts().archives,1);assert.equal(f.counts().writes,1);
});
test('a cold source without saved values keeps the foreground deadline context',async()=>{
  const f=fixture(),contexts=[];await f.read({readSavedSource:undefined,readSource:async context=>{contexts.push(context);return ok(source());}});
  assert.deepEqual(contexts,[{background:false}]);
});
test('a failed full refresh retains the matching normal saved preview without fabricating zero or archiving',async()=>{
  const f=fixture();await f.read({readSource:async()=>fail(503)});await turn();
  const retained=await f.read();assert.equal(retained.data.responseCache.state,'preview');assert.equal(retained.data.responseCache.refreshFailed,true);assert.equal(retained.data.responseCache.refreshing,false);
  assert.equal(retained.data.referenceLoading,false);assert.equal(retained.data.referenceError,true);assert.equal(retained.data.calculation.status,'failed');
  assert.equal(retained.data.companyDetail.current.daily[1].missing,true);assert.equal(retained.data.companyDetail.current.daily[1].estimatedRevenue,null);
  assert.equal(f.counts().archives,0);assert.equal(f.counts().writes,0);
  const again=await f.read({force:true});assert.equal(again.status,200);await turn();assert.equal(f.counts().archives,1);
});
for(const status of [401,403])test('saved preview authentication '+status+' never falls back or retries a private source',async()=>{
  const f=fixture(),reply=await f.read({readSavedSource:async()=>fail(status)});
  assert.equal(reply.status,status);assert.equal(f.counts().full,0);assert.equal(f.counts().archives,0);
  const next=await f.read();assert.equal(next.status,status);assert.equal(f.counts().full,0);
});
test('fresh identity denial and registration removal prevent cached previews and late saved responses',async()=>{
  const f=fixture(),pending=defer(),old=f.read({readSavedSource:()=>pending.promise});await turn();
  assert.equal((await f.read({readIdentity:async()=>ok(identity([]))})).status,404);
  pending.resolve(ok(preview()));assert.equal((await old).status,409);assert.equal(f.counts().full,0);
  assert.equal((await f.read({readIdentity:async()=>fail(401)})).status,401);assert.equal(f.counts().saved,0);
});
test('unavailable, unsupported, malformed and wrong-period previews fall back to the unchanged normal source',async()=>{
  const wrong=preview();wrong.companyDetail.current.daily[0].date='2026-10-01';
  const wrongVersion=preview();wrongVersion.companyDetail.integrated.calculationVersion='unknown-version';
  for(const reply of [fail(400),fail(404),fail(503),ok({}),ok(preview('2026-10')),ok(wrong),ok(wrongVersion)]){
    const f=fixture(),result=await f.read({readSavedSource:async()=>reply});assert.equal(result.status,200);assert.equal(result.data.result.version,'verified');assert.equal(f.counts().full,1);assert.equal(f.counts().writes,1);
  }
});
test('a hung preview is bounded, and its late result cannot overwrite the normal source',async()=>{
  const f=fixture({savedReadTimeoutMs:10}),pending=defer(),result=await f.read({readSavedSource:()=>pending.promise});
  assert.equal(result.data.result.version,'verified');pending.resolve(ok(preview()));await turn();
  assert.equal((await f.read()).data.result.version,'verified');assert.equal(f.counts().archives,1);assert.equal(f.counts().writes,1);
});
test('full-source preview markers are never promoted to durable or verified data',async()=>{
  const f=fixture(),result=await f.read({readSavedSource:undefined,readSource:async()=>ok(preview())});
  assert.equal(result.status,503);assert.equal(f.counts().writes,0);assert.equal(f.counts().archives,0);
});
test('a verified normal result survives later refresh failure and never yields to a new preview',async()=>{
  const f=fixture();await f.read({readSavedSource:undefined});f.advance(30000);
  const previous=await f.read({readSource:async()=>fail(503)});assert.equal(previous.data.result.version,'verified');await turn();
  const retained=await f.read();assert.equal(retained.data.result.version,'verified');assert.equal(retained.data.responseCache.refreshFailed,true);assert.equal(f.counts().saved,0);
});
