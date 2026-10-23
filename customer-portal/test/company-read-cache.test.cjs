'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const ok=data=>({status:200,ok:true,data});
const fail=status=>({status,ok:false,data:{error:{code:`HTTP_${status}`,message:'fixture failure'}}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function identity(companyIds=['a']) {
  return {customer:{customerId:'customer-a',accountStatus:'active',revision:1,relations:companyIds.map(companyId=>({companyId,kind:'own',status:'active'}))},companies:companyIds.map(companyId=>({companyId,rooms:16,version:'company-v1'})),preparations:[],collectionAllowance:{limit:1,used:0,canRequest:true}};
}
function source(companyId='a',month='2026-10',version='v1') {
  return {result:{companyId,rooms:16,runId:'run-'+version,version},companyDetail:{companyId,integrated:{status:'ready',selectedMonth:month,snapshot:{value:version}}},request:null,collectionAllowance:{limit:1,used:0,canRequest:true},previousResult:false};
}
function fixture(options={}) {
  let time=Date.parse('2026-10-22T00:00:00Z'),identityReply=ok(identity()),identityCalls=0,sourceCalls=0;
  const cache=createCompanyReadCache({now:()=>time,...options});
  let sourceReader=async({companyId,month})=>ok(source(companyId,month||'2026-10'));
  const read=(extra={})=>{const request={scope:'host:customer:opaque-a',route:'/companies/collection',companyId:'a',month:'',...extra};return cache.read({...request,readIdentity:extra.readIdentity||(async()=>{identityCalls++;return clone(identityReply);}),readSource:extra.readSource||(async()=>{sourceCalls++;return sourceReader(request);})});};
  return {cache,read,setIdentity(value){identityReply=value;},setSource(value){sourceReader=value;},advance(ms){time+=ms;},time(value){time=value;},identityCalls:()=>identityCalls,sourceCalls:()=>sourceCalls};
}

test('a cache hit still checks identity and defensively stores only the company core',async()=>{
  const f=fixture(),first=await f.read();
  assert.equal(first.data.responseCache.state,'fresh');first.data.result.rooms=999;
  const hit=await f.read();assert.equal(hit.data.responseCache.state,'cached');assert.equal(hit.data.result.rooms,16);
  assert.equal(f.identityCalls(),2);assert.equal(f.sourceCalls(),1);
  hit.data.companyDetail.integrated.snapshot.value='edited-return-value';
  assert.equal((await f.read()).data.companyDetail.integrated.snapshot.value,'v1');
});

test('cached data uses the freshly checked quota and request and recomputes previousResult',async()=>{
  const f=fixture(),account=identity();account.preparations=[{companyId:'a',status:'ready',runId:'another-run',requestId:'request-a'}];
  f.setIdentity(ok(account));await f.read();
  account.collectionAllowance={limit:1,used:1,canRequest:false};f.setIdentity(ok(account));
  const hit=await f.read();assert.equal(hit.data.responseCache.state,'cached');assert.equal(f.sourceCalls(),1);
  assert.equal(hit.data.collectionAllowance.canRequest,false);assert.equal(hit.data.request.requestId,'request-a');assert.equal(hit.data.previousResult,true);
});

test('host, session, customer/admin mode, company and requested month remain separate',async()=>{
  const f=fixture();f.setIdentity(ok(identity(['a','b'])));
  const variants=[{}, {scope:'other-host:customer:opaque-a'},{scope:'host:admin:opaque-a'},{scope:'host:customer:opaque-b'},{companyId:'b'},{month:'2026-09'}];
  for(const variant of variants)assert.equal((await f.read(variant)).data.responseCache.state,'fresh');
  assert.equal(f.sourceCalls(),variants.length);
  for(const variant of variants)assert.equal((await f.read(variant)).data.responseCache.state,'cached');
  assert.equal(f.sourceCalls(),variants.length);
});

test('simultaneous permission checks and identical initial source reads share pending work only',async()=>{
  const cache=createCompanyReadCache(),permission=deferred(),company=deferred();let guards=0,reads=0;
  const request={scope:'opaque',companyId:'a',readIdentity:()=>{guards++;return permission.promise;},readSource:()=>{reads++;return company.promise;}};
  const one=cache.read(request),two=cache.read(request);assert.equal(guards,1);
  permission.resolve(ok(identity()));await flush();assert.equal(reads,1);
  company.resolve(ok(source()));assert.equal((await one).status,200);assert.equal((await two).status,200);
  await cache.read({...request,readIdentity:async()=>{guards++;return ok(identity());}});assert.equal(guards,2);assert.equal(reads,1);
});

test('a hit returns while its single background refresh is still pending and later exposes the new core',async()=>{
  const f=fixture(),pending=deferred();await f.read();f.advance(30000);f.setSource(()=>pending.promise);
  const hit=await f.read();assert.equal(hit.data.result.version,'v1');assert.equal(hit.data.responseCache.refreshing,true);
  const again=await f.read();assert.equal(again.data.responseCache.refreshing,true);assert.equal(f.sourceCalls(),2);
  pending.resolve(ok(source('a','2026-10','v2')));await flush();
  const latest=await f.read();assert.equal(latest.data.result.version,'v2');assert.equal(latest.data.responseCache.refreshing,false);
});

test('a failed refresh keeps the last good core and observes the retry cooldown',async()=>{
  const f=fixture();await f.read();const checkedAt=(await f.read()).data.responseCache.checkedAt;
  f.advance(30000);f.setSource(async()=>fail(503));await f.read();await flush();
  const preserved=await f.read();assert.equal(preserved.data.result.version,'v1');assert.equal(preserved.data.responseCache.checkedAt,checkedAt);
  assert.equal(preserved.data.responseCache.refreshFailed,true);assert.equal(preserved.data.responseCache.refreshing,false);assert.equal(f.sourceCalls(),2);
  assert.equal((await f.read({force:true})).status,503);assert.equal(f.sourceCalls(),3);
  f.setSource(async()=>ok(source('a','2026-10','recovered')));assert.equal((await f.read({force:true})).data.result.version,'recovered');
  assert.equal((await f.read()).data.responseCache.refreshFailed,false);
});

for(const status of [401,403])test(`a fresh identity ${status} never falls back to a saved private result`,async()=>{
  const f=fixture();await f.read();f.setIdentity(fail(status));
  const denied=await f.read();assert.equal(denied.status,status);assert.equal(denied.data.result,undefined);assert.equal(f.sourceCalls(),1);
});

test('failed permission validation cannot return cached data or replace the saved identity',async()=>{
  const f=fixture();await f.read();f.setIdentity(fail(503));assert.equal((await f.read()).status,503);assert.equal(f.sourceCalls(),1);
  f.setIdentity(ok(identity()));assert.equal((await f.read()).data.responseCache.state,'cached');
});

test('registration removal refuses reads and invalidates an old in-flight source response',async()=>{
  const f=fixture(),pending=deferred();f.setSource(()=>pending.promise);
  const old=f.read();await flush();f.setIdentity(ok(identity([])));
  assert.equal((await f.read()).status,404);pending.resolve(ok(source('a','2026-10','removed-private')));
  assert.equal((await old).status,409);
  const restored=identity();restored.customer.revision=2;f.setIdentity(ok(restored));f.setSource(async()=>ok(source('a','2026-10','restored')));
  assert.equal((await f.read()).data.result.version,'restored');assert.equal(f.sourceCalls(),2);
});

test('scope invalidation during a command prevents late responses from repopulating the cache',async()=>{
  const f=fixture(),pending=deferred();f.setSource(()=>pending.promise);
  const old=f.read();await flush();f.cache.invalidate('host:customer:opaque-a');pending.resolve(ok(source('a','2026-10','old-private')));
  assert.equal((await old).status,409);
  f.setSource(async()=>ok(source('a','2026-10','new-private')));
  assert.equal((await f.read()).data.result.version,'new-private');assert.equal(f.sourceCalls(),2);
});

for(const status of [401,403,404])test(`a background source ${status} denies the next read and force can verify recovery`,async()=>{
  const f=fixture();await f.read();f.advance(30000);f.setSource(async()=>fail(status));
  assert.equal((await f.read()).data.responseCache.refreshing,true);await flush();
  const denied=await f.read();assert.equal(denied.status,status);assert.equal(denied.data.result,undefined);assert.equal(f.sourceCalls(),2);
  f.setSource(async()=>ok(source('a','2026-10','restored')));
  assert.equal((await f.read({force:true})).data.result.version,'restored');
});

test('company basis or customer revision changes require a new source read',async()=>{
  const f=fixture(),account=identity();await f.read();
  account.companies[0].version='company-v2';account.companies[0].rooms=17;f.setIdentity(ok(account));assert.equal((await f.read()).data.responseCache.state,'fresh');
  account.customer.revision++;f.setIdentity(ok(account));assert.equal((await f.read()).data.responseCache.state,'fresh');assert.equal(f.sourceCalls(),3);
});

for(const pending of ['active-job','pending-integration','updating-integration'])test(`${pending} stays uncached so progress cannot be frozen`,async()=>{
  const f=fixture(),data=source();
  if(pending==='active-job'){const account=identity();account.preparations=[{companyId:'a',status:'collecting'}];f.setIdentity(ok(account));data.request=account.preparations[0];}
  else data.companyDetail.integrated.status=pending.split('-')[0];
  f.setSource(async()=>ok(clone(data)));await f.read();assert.equal((await f.read()).data.responseCache.state,'fresh');assert.equal(f.sourceCalls(),2);
});

test('expired entries and default-month rollover fetch again without reusing a prior period',async()=>{
  const f=fixture({ttlMs:60000});await f.read();f.advance(60000);assert.equal((await f.read()).data.responseCache.state,'fresh');
  f.time(Date.parse('2026-10-31T14:59:00Z'));await f.read();const before=f.sourceCalls();
  f.time(Date.parse('2026-10-31T15:00:00Z'));assert.equal((await f.read()).data.responseCache.state,'fresh');assert.equal(f.sourceCalls(),before+1);
});

test('per-session and global LRU limits evict payloads rather than returning another key',async()=>{
  const f=fixture({maxEntries:3,maxPerScope:2});f.setIdentity(ok(identity(['a','b','c'])));
  await f.read({companyId:'a'});await f.read({companyId:'b'});await f.read({companyId:'c'});
  assert.equal((await f.read({companyId:'a'})).data.responseCache.state,'fresh');
  await f.read({scope:'second'});await f.read({scope:'third'});
  const before=f.sourceCalls();assert.equal((await f.read({companyId:'c'})).data.responseCache.state,'fresh');assert.equal(f.sourceCalls(),before+1);
});

test('byte limits skip oversized cores and malformed company/month input cannot select cached results',async()=>{
  const f=fixture({maxBytes:16});await f.read();await f.read();assert.equal(f.sourceCalls(),2);
  for(const request of [{companyId:'../a'},{month:'2026-13'},{month:'2026-01&force=1'}])assert.equal((await f.read(request)).status,400);
});

test('a mismatched result company cannot be cached or exposed as another registered company',async()=>{
  const f=fixture();f.setSource(async()=>ok(source('another-company')));
  const reply=await f.read();assert.equal(reply.status,503);assert.equal(reply.data.result,undefined);
});

test('a response for another stay month cannot populate the explicitly requested month',async()=>{
  const f=fixture();f.setSource(async()=>ok(source('a','2026-10')));
  const reply=await f.read({month:'2026-09'});assert.equal(reply.status,503);assert.equal(reply.data.result,undefined);
  f.setSource(async()=>ok(source('a','2026-09')));
  assert.equal((await f.read({month:'2026-09'})).data.companyDetail.integrated.selectedMonth,'2026-09');assert.equal(f.sourceCalls(),2);
});

test('fresh-state snapshots reuse a permitted core without another identity or source read',async()=>{
  const f=fixture();await f.read();const checks=f.identityCalls(),reads=f.sourceCalls();
  const views=await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()});
  assert.equal(views.length,1);assert.equal(views[0].companyId,'a');assert.equal(views[0].month,'');
  assert.equal(views[0].data.result.version,'v1');assert.equal(views[0].data.responseCache.state,'cached');
  assert.equal(f.identityCalls(),checks);assert.equal(f.sourceCalls(),reads);
  views[0].data.result.rooms=999;
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}))[0].data.result.rooms,16);
});

test('snapshots recompute current quota and previousResult but reject changed company or customer fingerprints',async()=>{
  const f=fixture(),account=identity();account.preparations=[{companyId:'a',status:'ready',runId:'older-run'}];f.setIdentity(ok(account));await f.read();
  account.collectionAllowance={limit:1,used:1,canRequest:false};
  const fresh=(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}))[0].data;
  assert.equal(fresh.collectionAllowance.canRequest,false);assert.equal(fresh.previousResult,true);assert.equal(fresh.request.runId,'older-run');
  account.customer.revision++;
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}),[]);
  f.setIdentity(ok(account));await f.read();account.companies[0].rooms=17;
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}),[]);
});

test('snapshot scope, active registration, catalog membership and account status must all match',async()=>{
  const accounts=[identity([]),{...identity(),companies:[]},{...identity(),customer:{...identity().customer,accountStatus:'disabled'}},{...identity(),customer:{...identity().customer,customerId:'another-customer'}},null,{}];
  for(const account of accounts){
    const f=fixture();await f.read();
    assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}),[]);
  }
  const f=fixture();await f.read();
  for(const scope of ['other-host:customer:opaque-a','host:admin:opaque-a','host:customer:opaque-b'])assert.deepEqual(await f.cache.snapshot({scope,identity:identity()}),[]);
  const pending=identity();pending.customer.relations[0].status='pending';f.setIdentity(ok(pending));await f.read();
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:pending})).length,1);
});

test('snapshots never restore revoked or denied views and do not start reads for missing cores',async()=>{
  for(const status of [401,403,404]){
    const f=fixture();await f.read();f.advance(30000);f.setSource(async()=>fail(status));await f.read();await flush();
    const before=f.sourceCalls();assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);assert.equal(f.sourceCalls(),before);
  }
  const f=fixture(),account=identity(['a','b']);f.setIdentity(ok(account));await f.read();
  const before=f.sourceCalls(),views=await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account});
  assert.deepEqual(views.map(view=>view.companyId),['a']);assert.equal(f.sourceCalls(),before);
});

test('snapshots choose one view per company, preferring the current default over a newer explicit month',async()=>{
  const f=fixture();await f.read();f.advance(1);await f.read({month:'2026-09'});
  let views=await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()});
  assert.equal(views.length,1);assert.equal(views[0].month,'');assert.equal(views[0].data.companyDetail.integrated.selectedMonth,'2026-10');
  f.cache.invalidate('host:customer:opaque-a');await f.read({month:'2026-09'});f.advance(1);await f.read({month:'2026-08'});
  views=await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()});
  assert.equal(views.length,1);assert.equal(views[0].month,'2026-08');assert.equal(views[0].data.companyDetail.integrated.selectedMonth,'2026-08');
});

test('snapshots exclude expired entries, old default periods and in-progress identities',async()=>{
  const f=fixture({ttlMs:60000});await f.read();f.advance(60000);
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);
  f.time(Date.parse('2026-10-31T14:59:30Z'));await f.read();f.time(Date.parse('2026-10-31T15:00:00Z'));
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);
  const g=fixture();await g.read();const account=identity();account.preparations=[{companyId:'a',status:'collecting'}];
  assert.deepEqual(await g.cache.snapshot({scope:'host:customer:opaque-a',identity:account}),[]);
});

test('snapshots are limited to four companies and serialized payloads stay within the configured byte bound',async()=>{
  const f=fixture(),account=identity(['a','b','c','d','e']);f.setIdentity(ok(account));
  for(const companyId of ['a','b','c','d','e'])await f.read({companyId});
  const views=await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account,maxViews:999});assert.equal(views.length,4);
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account,maxViews:1})).length,1);
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account,maxViews:0}),[]);
  const bound=800,g=fixture({maxBytes:bound}),two=identity(['a','b']);g.setIdentity(ok(two));await g.read();await g.read({companyId:'b'});
  const limited=await g.cache.snapshot({scope:'host:customer:opaque-a',identity:two});assert.equal(limited.length,1,'core payloads fit but adding both complete response wrappers would exceed the bound');assert.ok(Buffer.byteLength(JSON.stringify(limited),'utf8')<=bound);
});

test('a snapshot with removed registration invalidates older in-flight cores without issuing a source read',async()=>{
  const f=fixture(),pending=deferred();await f.read();f.advance(30000);f.setSource(()=>pending.promise);await f.read();
  const checks=f.identityCalls(),reads=f.sourceCalls();assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])}),[]);
  pending.resolve(ok(source('a','2026-10','old-private')));await flush();
  assert.equal(f.identityCalls(),checks);assert.equal(f.sourceCalls(),reads);
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);
});
