'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createRegionReadCache}=require('../region-read-cache.cjs');
const clone=value=>JSON.parse(JSON.stringify(value));
const ok=data=>({status:200,ok:true,data});
const fail=(status,extra={})=>({status,ok:false,data:{error:{code:`HTTP_${status}`,message:'fixture failure',...extra}}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function identity(regionKeys=['r1']) {
  return {customer:{customerId:'cus_a',accountStatus:'active',revision:1},regions:regionKeys.map(id=>({id,label:'지역 '+id,level:'local'})),csrfToken:'private-csrf'};
}
function source(regionKey='r1',month='2026-09',value=100) {
  return {region:{id:regionKey,label:'지역 '+regionKey},month,source:'datalab_saved',networkAttempted:false,
    window:{start:'2025-10',end:month,months:12,storageStart:'2024-10',storageMonths:24,currentMonth:'2026-10'},
    sources:[{key:'tourism_visitors',label:'방문자',provider:'공공 통계',status:'partial',period:'2025-10 ~ '+month,periodType:'M',sourceUrl:'https://example.org/data',retrievedAt:'2026-10-01T00:00:00Z',
      rows:[{key:'visitors',label:'방문자',value,unit:'명',status:'observed'},{key:'missing',label:'미확인',value:null,unit:'명',status:'missing'}],
      series:[{month,status:'observed',retrievedAt:'2026-10-01T00:00:00Z',rows:[{key:'visitors',label:'방문자',value,unit:'명',status:'observed'}]}],
      metrics:[{key:'visitors',label:'방문자',unit:'명',observedMonths:1,latest:{month,value},mom:{value:null,kind:'unavailable'},yoy:{value:10,kind:'percent'},peak:{month,value},low:{month,value}}]}],
    location:{interpretation:'입지 참고',recommendedProduct:'상품 참고',caution:'참고용',source:'지역DB',updatedAt:'2026-10-01T00:00:00Z',basis:'reference',clusters:[{name:'지역군',demand:'수요 참고',product:'숙박'}]},
    interim:{month:'2026-10',status:'partial_month',sources:[{key:'tourism_visitors',label:'진행월',period:'2026-10',status:'partial',rows:[{key:'visitors',label:'방문자',value:null,unit:'명',status:'missing'}]}]},
    availableSources:1,warnings:['미확인은 0이 아닙니다.'],refreshAvailable:true};
}
function fixture(options={}) {
  let time=Date.parse('2026-10-23T00:00:00Z'),permission=ok(identity()),identityCalls=0,sourceCalls=0;
  const cache=createRegionReadCache({now:()=>time,...options});let sourceReader=async request=>ok(source(request.regionKey,request.month));
  const read=(extra={})=>{const request={scope:'host:customer:opaque-a',regionKey:'r1',month:'2026-09',...extra};return cache.read({...request,
    readIdentity:extra.readIdentity||(async()=>{identityCalls++;return clone(permission);}),
    readSource:extra.readSource||(async()=>{sourceCalls++;return sourceReader(request);})});};
  return {cache,read,setIdentity(value){permission=value;},setSource(value){sourceReader=value;},advance(ms){time+=ms;},time(value){time=value;},identityCalls:()=>identityCalls,sourceCalls:()=>sourceCalls};
}

test('each regional cache hit checks fresh identity while preserving public fields, zero and missing',async()=>{
  const f=fixture();f.setSource(async request=>ok(source(request.regionKey,request.month,0)));
  const first=await f.read();assert.equal(first.status,200);assert.equal(first.data.responseCache.state,'fresh');
  first.data.sources[0].rows[0].value=999;
  const hit=await f.read();assert.equal(hit.data.responseCache.state,'cached');assert.equal(f.identityCalls(),2);assert.equal(f.sourceCalls(),1);
  assert.equal(hit.data.sources[0].rows[0].value,0);assert.equal(hit.data.sources[0].rows[1].value,null);
  assert.equal(hit.data.sources[0].metrics[0].latest.value,0);assert.equal(hit.data.sources[0].metrics[0].yoy.value,10);
  assert.equal(hit.data.location.clusters[0].name,'지역군');assert.equal(hit.data.interim.sources[0].rows[0].value,null);
  hit.data.sources[0].metrics[0].latest.value=99;assert.equal((await f.read()).data.sources[0].metrics[0].latest.value,0);
});

test('only the public regional schema survives fresh and saved replies',async()=>{
  const f=fixture(),data=source();
  data.customer={password:'private-account'};data.token='private-token';data.csrfToken='private-csrf';data.responseCache={state:'forged'};
  data.region.session='private-session';data.window.token='private-window';data.sources[0].credential='private-source';
  data.sources[0].rows[0].raw={token:'private-row'};data.sources[0].series[0].token='private-series';
  data.sources[0].metrics[0].latest.session='private-point';data.location.clusters[0].auth='private-cluster';data.interim.sources[0].token='private-interim';
  f.setSource(async()=>ok(data));
  for(const reply of [await f.read(),await f.read()]){
    assert.doesNotMatch(JSON.stringify(reply.data),/private-|forged/);assert.equal(reply.data.sources[0].metrics[0].latest.month,'2026-09');
  }
});

test('origin/session/admin mode, exact region and end month cannot share a core',async()=>{
  const f=fixture();f.setIdentity(ok(identity(['r1','r2'])));
  const variants=[{}, {scope:'other-host:customer:opaque-a'},{scope:'host:admin:opaque-a'},{scope:'host:customer:opaque-b'},{regionKey:'r2'},{month:'2026-08'}];
  for(const request of variants)assert.equal((await f.read(request)).data.responseCache.state,'fresh');
  for(const request of variants)assert.equal((await f.read(request)).data.responseCache.state,'cached');
  assert.equal(f.sourceCalls(),variants.length);
});

test('simultaneous identical reads share pending guards and one source without caching settled authentication',async()=>{
  const cache=createRegionReadCache(),permission=deferred(),sourceRead=deferred();let guards=0,reads=0;
  const request={scope:'opaque',regionKey:'r1',month:'2026-09',readIdentity:()=>{guards++;return permission.promise;},readSource:()=>{reads++;return sourceRead.promise;}};
  const a=cache.read(request),b=cache.read(request);assert.equal(guards,1);
  permission.resolve(ok(identity()));await flush();assert.equal(reads,1);sourceRead.resolve(ok(source()));
  assert.equal((await a).status,200);assert.equal((await b).status,200);
  await cache.read({...request,readIdentity:async()=>{guards++;return ok(identity());}});assert.equal(guards,2);assert.equal(reads,1);
});

test('last good core returns during a deduplicated background refresh and changes after success',async()=>{
  const f=fixture(),pending=deferred();await f.read();f.advance(30000);f.setSource(()=>pending.promise);
  const hit=await f.read();assert.equal(hit.data.sources[0].rows[0].value,100);assert.equal(hit.data.responseCache.refreshing,true);
  assert.equal((await f.read()).data.responseCache.refreshing,true);assert.equal(f.sourceCalls(),2);
  pending.resolve(ok(source('r1','2026-09',200)));await flush();
  const updated=await f.read();assert.equal(updated.data.sources[0].rows[0].value,200);assert.equal(updated.data.responseCache.refreshing,false);
});

for(const status of [503,504])test(`background ${status} preserves last good values and timestamp with a cooldown`,async()=>{
  const f=fixture();await f.read();const checkedAt=(await f.read()).data.responseCache.checkedAt;
  f.advance(30000);f.setSource(async()=>fail(status,{stage:'source'}));await f.read();await flush();
  const hit=await f.read();assert.equal(hit.data.sources[0].rows[0].value,100);assert.equal(hit.data.responseCache.checkedAt,checkedAt);
  assert.equal(hit.data.responseCache.refreshFailed,true);assert.equal(hit.data.responseCache.refreshing,false);assert.equal(f.sourceCalls(),2);
  const forced=await f.read({force:true});assert.equal(forced.status,status);assert.equal(forced.data.error.stage,'source');assert.equal(forced.data.sources,undefined);
  assert.equal((await f.read()).data.sources[0].rows[0].value,100);
  f.setSource(async()=>ok(source('r1','2026-09',300)));assert.equal((await f.read({force:true})).data.sources[0].rows[0].value,300);
  assert.equal((await f.read()).data.responseCache.refreshFailed,false);
});

for(const status of [401,403,503,504])test(`fresh identity ${status} never exposes saved regional data`,async()=>{
  const f=fixture();await f.read();f.setIdentity(fail(status,{stage:'identity'}));
  const rejected=await f.read();assert.equal(rejected.status,status);assert.equal(rejected.data.sources,undefined);assert.equal(f.sourceCalls(),1);
});

test('permission removal is enforced by both direct reads and authenticated snapshots',async()=>{
  const f=fixture();await f.read();f.setIdentity(ok(identity([])));assert.equal((await f.read()).status,404);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  f.setIdentity(ok(identity()));assert.equal((await f.read()).data.responseCache.state,'fresh');
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])})),[]);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
});

test('snapshot permission removal prevents an older pending response from restoring or returning data',async()=>{
  const f=fixture(),pending=deferred();f.setSource(()=>pending.promise);const old=f.read();await flush();
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])})),[]);
  pending.resolve(ok(source('r1','2026-09',999)));assert.equal((await old).status,409);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
});

test('removing then restoring the same permission cannot revive an older in-flight generation',async()=>{
  const f=fixture(),oldSource=deferred();f.setSource(()=>oldSource.promise);const old=f.read();await flush();
  (await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])}));
  f.setSource(async()=>ok(source('r1','2026-09',200)));const restored=await f.read();assert.equal(restored.data.sources[0].rows[0].value,200);
  oldSource.resolve(ok(source('r1','2026-09',999)));assert.equal((await old).status,409);
  assert.equal((await f.read()).data.sources[0].rows[0].value,200);
});

test('a fresh bootstrap snapshot invalidates an older still-pending identity before a source can start',async()=>{
  const f=fixture(),oldIdentity=deferred();let sources=0;
  const old=f.read({readIdentity:()=>oldIdentity.promise,readSource:async()=>{sources++;return ok(source());}});
  (await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])}));
  oldIdentity.resolve(ok(identity()));assert.equal((await old).status,409);assert.equal(sources,0);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
});

test('a read after fresh bootstrap never shares the older still-pending identity check',async()=>{
  const f=fixture(),oldIdentity=deferred();let guards=0;
  const old=f.read({readIdentity:()=>oldIdentity.promise});
  (await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])}));
  const latest=await f.read({readIdentity:async()=>{guards++;return ok(identity([]));}});
  assert.equal(latest.status,404);assert.equal(guards,1);
  oldIdentity.resolve(ok(identity()));assert.equal((await old).status,409);assert.equal(f.sourceCalls(),0);
});

test('scope invalidation and customer revision changes invalidate late source results',async()=>{
  for(const invalidate of [f=>f.cache.invalidate('host:customer:opaque-a'),async f=>{const account=identity();account.customer.revision=2;(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}));}]){
    const f=fixture(),pending=deferred();f.setSource(()=>pending.promise);const old=f.read();await flush();await invalidate(f);
    pending.resolve(ok(source()));assert.equal((await old).status,409);
    assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  }
});

for(const status of [403,404])test(`source ${status} denies only that region and can recover after a forced fresh read`,async()=>{
  const f=fixture();f.setIdentity(ok(identity(['r1','r2'])));await f.read();await f.read({regionKey:'r2'});
  f.advance(30000);f.setSource(async request=>request.regionKey==='r1'?fail(status):ok(source('r2',request.month)));
  await f.read();await flush();assert.equal((await f.read()).status,status);
  assert.equal((await f.read({regionKey:'r2'})).status,200,'another permitted region remains available');
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity(['r1','r2'])})).map(view=>view.regionKey),['r2']);
  f.setSource(async()=>ok(source('r1','2026-09',400)));assert.equal((await f.read({force:true})).data.sources[0].rows[0].value,400);
});

test('source 401 revokes all regional entries in that session but does not affect another scope',async()=>{
  const f=fixture();await f.read();await f.read({scope:'other-session'});f.advance(30000);f.setSource(async()=>fail(401));
  await f.read();await flush();assert.equal((await f.read()).status,401);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  assert.equal((await f.cache.snapshot({scope:'other-session',identity:identity()})).length,1);
});

for(const mutate of [d=>{d.region.id='another-region';},d=>{d.month='2026-08';},d=>{d.month=null;},d=>{d.window.end='2026-08';},d=>{d.networkAttempted=true;},d=>{delete d.networkAttempted;},d=>{d.sources=null;}])test('mismatched period/region or a non-saved result is rejected and never cached: '+mutate.toString(),async()=>{
  const f=fixture(),data=source();mutate(data);f.setSource(async()=>ok(data));
  const reply=await f.read();assert.equal(reply.status,503);assert.equal(reply.data.sources,undefined);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
});

test('legacy explicit window end is accepted only if a contradictory month is absent',async()=>{
  const f=fixture(),data=source();delete data.month;f.setSource(async()=>ok(data));assert.equal((await f.read()).status,200);
  f.setSource(async()=>ok({...data,month:'2026-08'}));assert.equal((await f.read({force:true})).status,503);
  assert.equal((await f.read()).data.window.end,'2026-09');
});

test('source shape mismatches during refresh preserve the verified old values as refresh failed',async()=>{
  const f=fixture();await f.read();f.advance(30000);f.setSource(async()=>ok(source('r1','2026-08')));await f.read();await flush();
  const hit=await f.read();assert.equal(hit.data.month,'2026-09');assert.equal(hit.data.responseCache.refreshFailed,true);
});

test('TTL is measured from source verification rather than repeated reads or snapshots',async()=>{
  const f=fixture({ttlMs:60000,refreshMs:120000});await f.read();f.advance(59000);
  assert.equal((await f.read()).data.responseCache.state,'cached');assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})).length,1);
  f.advance(1000);assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  assert.equal((await f.read()).data.responseCache.state,'fresh');assert.equal(f.sourceCalls(),2);
});

test('snapshots use only the fresh allowed identity and never start reads',async()=>{
  const f=fixture();await f.read();await f.read({month:'2026-08'});const reads=f.sourceCalls(),guards=f.identityCalls();
  const views=(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}));assert.equal(views.length,2);
  assert.deepEqual(new Set(views.map(view=>view.month)),new Set(['2026-09','2026-08']));assert.equal(f.sourceCalls(),reads);assert.equal(f.identityCalls(),guards);
  views[0].data.sources[0].rows[0].value=999;assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}))[0].data.sources[0].rows[0].value,100);
  for(const scope of ['another-session','host:admin:opaque-a','other-host:customer:opaque-a'])assert.deepEqual((await f.cache.snapshot({scope,identity:identity()})),[]);
});

for(const invalid of [null,{}, {...identity(),customer:{...identity().customer,accountStatus:'disabled'}},{...identity(),customer:{...identity().customer,customerId:'another-customer'}},{...identity(),regions:[]}])test('snapshot denies changed/missing account or region identity: '+JSON.stringify(invalid),async()=>{
  const f=fixture();await f.read();assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:invalid})),[]);
});

test('snapshot count, byte limits, per-scope and global LRU bound retained payloads',async()=>{
  const f=fixture();for(let n=1;n<=10;n++)await f.read({month:`2026-${String(n).padStart(2,'0')}`});
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity(),maxViews:999})).length,8);
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity(),maxViews:1})).length,1);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity(),maxViews:0})),[]);
  const g=fixture({maxEntries:3,maxPerScope:2});await g.read();await g.read({month:'2026-08'});await g.read({month:'2026-07'});
  assert.equal((await g.read()).data.responseCache.state,'fresh');await g.read({scope:'scope-b'});await g.read({scope:'scope-c'});
  assert.equal((await g.read({month:'2026-07'})).data.responseCache.state,'fresh');
  const h=fixture({maxBytes:16});await h.read();await h.read();assert.equal(h.sourceCalls(),2);assert.deepEqual((await h.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  const i=fixture({maxBytes:7000});await i.read();await i.read({month:'2026-08'});const limited=(await i.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}));assert.ok(Buffer.byteLength(JSON.stringify(limited))<=7000);
});

test('snapshot has a separate serialized payload budget and skips a large core without source or identity reads',async()=>{
  const f=fixture({maxSnapshotBytes:3000});await f.read();await f.read({month:'2026-08'});const guards=f.identityCalls(),reads=f.sourceCalls();
  const views=(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}));
  assert.equal(views.length,1);assert.ok(Buffer.byteLength(JSON.stringify(views),'utf8')<=3000);
  assert.equal(f.identityCalls(),guards);assert.equal(f.sourceCalls(),reads);
  const g=fixture({maxSnapshotBytes:16});await g.read();assert.deepEqual((await g.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
  assert.equal((await g.read()).data.responseCache.state,'cached','skipping bootstrap snapshots does not discard the normal guarded GET cache');
});

test('old scope eviction and bounded in-flight metadata prevent unbounded stale completion reuse',async()=>{
  const f=fixture({maxScopes:1}),pending=deferred();f.setSource(()=>pending.promise);const old=f.read();await flush();
  const other=f.read({scope:'other-scope',readSource:async()=>ok(source())});await other;
  pending.resolve(ok(source('r1','2026-09',999)));assert.equal((await old).status,409);
  assert.deepEqual((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()})),[]);
});

test('invalid and missing explicit months never reach central source or use another key',async()=>{
  const f=fixture();await f.read();
  for(const request of [{month:''},{month:undefined},{month:'2026-13'},{month:'2026-09&x=1'},{regionKey:'../r1'}])assert.equal((await f.read(request)).status,400);
  assert.equal(f.sourceCalls(),1);assert.equal(f.identityCalls(),1);
});

async function persistedFixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-region-cache-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const options={persistenceDirectory:directory,namespace:'https://central.example.test'};
  const first=fixture(options),reply=await first.read();await first.cache.flushPersistence();
  return {directory,options,first,checkedAt:reply.data.responseCache.checkedAt};
}
function projectedStore({ready=async()=>{},put=async()=>true,checkedAt=Date.parse('2026-10-23T00:00:00Z'),data=source()}={}) {
  const row={regionKey:'r1',month:'2026-09',checkedAt,validUntil:checkedAt+7*86400000,core:clone(data)};
  let readyCalls=0,getCalls=0;
  return {ready:()=>{readyCalls++;return ready();},get:()=>{getCalls++;return clone(row);},list:allowed=>allowed.includes('r1')?[clone(row)]:[],begin:()=>({}),put,flush:async()=>{},status:()=>({enabled:true}),readyCalls:()=>readyCalls,getCalls:()=>getCalls};
}

test('server restart restores a two-hour-old public snapshot before a slow source, preserving its verification date',async t=>{
  const {options,checkedAt}=await persistedFixture(t),restarted=fixture(options),pending=deferred();
  restarted.advance(2*3600000);restarted.setSource(()=>pending.promise);
  const boot=await restarted.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()});
  assert.equal(boot.length,1);assert.equal(restarted.sourceCalls(),0);assert.equal(restarted.identityCalls(),0);
  assert.equal(boot[0].data.responseCache.checkedAt,checkedAt);assert.equal(boot[0].data.responseCache.persisted,true);
  assert.equal(boot[0].data.responseCache.revalidationRequired,true);assert.equal(boot[0].data.responseCache.refreshing,false);
  assert.equal(Date.parse(boot[0].data.responseCache.validUntil),Date.parse(checkedAt)+7*86400000);
  const fast=await restarted.read();assert.equal(fast.status,200);assert.equal(fast.data.responseCache.state,'cached');
  assert.equal(fast.data.responseCache.checkedAt,checkedAt);assert.equal(fast.data.responseCache.refreshing,true);
  assert.equal(restarted.identityCalls(),1);assert.equal(restarted.sourceCalls(),1);
  pending.resolve(ok(source('r1','2026-09',250)));await flush();await restarted.cache.flushPersistence();await flush();
  const updated=await restarted.read();assert.equal(updated.data.sources[0].rows[0].value,250);assert.equal(updated.data.responseCache.persisted,undefined);
  const twice=fixture(options);twice.advance(2*3600000);
  assert.equal((await twice.cache.snapshot({scope:'another-session',identity:identity()}))[0].data.sources[0].rows[0].value,250);
});

for(const status of [401,403,503,504])test(`restart identity ${status} cannot read the public disk snapshot before current authorization`,async()=>{
  const store=projectedStore(),f=fixture({persistentStore:store});f.setIdentity(fail(status,{stage:'identity'}));
  assert.equal((await f.read()).status,status);assert.equal(store.readyCalls(),0);assert.equal(store.getCalls(),0);assert.equal(f.sourceCalls(),0);
});

test('restart missing allowed region and disabled account cannot recover persisted data',async()=>{
  for(const account of [identity([]),{...identity(),customer:{...identity().customer,accountStatus:'disabled'}}]){
    const store=projectedStore(),f=fixture({persistentStore:store});f.setIdentity(ok(account));
    assert.equal((await f.read()).status,404);assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:account}),[]);
    assert.equal(store.readyCalls(),0);assert.equal(store.getCalls(),0);assert.equal(f.sourceCalls(),0);
  }
});

test('permission removal during disk preload invalidates both an old direct read and an old bootstrap snapshot',async()=>{
  for(const mode of ['read','snapshot']){
    const loaded=deferred(),store=projectedStore({ready:()=>loaded.promise}),f=fixture({persistentStore:store});
    const old=mode==='read'?f.read():f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()});await flush();
    assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])}),[]);
    loaded.resolve();const reply=await old;
    if(mode==='read')assert.equal(reply.status,409);else assert.deepEqual(reply,[]);
    assert.equal(store.getCalls(),0);assert.equal(f.sourceCalls(),0);
  }
});

test('same permission removed then restored during preload cannot revive an earlier request binding',async()=>{
  const loaded=deferred(),store=projectedStore({ready:()=>loaded.promise}),f=fixture({persistentStore:store});
  const old=f.read();await flush();await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])});
  const latest=f.read();await flush();loaded.resolve();
  assert.equal((await old).status,409);assert.equal((await latest).data.responseCache.persisted,true);
  assert.equal(f.sourceCalls(),1);await flush();
});

for(const status of [503,504])test(`restart source ${status} retains the last good disk values and date instead of overwriting them`,async t=>{
  const {options,checkedAt}=await persistedFixture(t),f=fixture(options);f.advance(2*3600000);f.setSource(async()=>fail(status));
  assert.equal((await f.read()).data.responseCache.persisted,true);await flush();await f.cache.flushPersistence();
  const failed=await f.read();assert.equal(failed.data.responseCache.refreshFailed,true);assert.equal(failed.data.responseCache.checkedAt,checkedAt);
  const g=fixture(options);g.advance(3*3600000);const views=await g.cache.snapshot({scope:'new',identity:identity()});
  assert.equal(views[0].data.sources[0].rows[0].value,100);assert.equal(views[0].data.responseCache.checkedAt,checkedAt);
});

for(const status of [401,403,404])test(`a persisted source ${status} is not resurrected within the same session after normal memory TTL`,async t=>{
  const {options}=await persistedFixture(t),f=fixture(options);f.setSource(async()=>fail(status));
  await f.read();await flush();assert.equal((await f.read()).status,status);
  f.advance(31*60000);assert.equal((await f.read()).status,status);
  assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);
  f.setSource(async()=>ok(source('r1','2026-09',400)));assert.equal((await f.read({force:true})).data.sources[0].rows[0].value,400);
});

test('read and bootstrap never extend persisted lifetime or manufacture a current verification date',async t=>{
  const {options,checkedAt}=await persistedFixture(t),f=fixture(options);f.advance(6*86400000);f.setSource(async()=>fail(503));
  const first=await f.read();assert.equal(first.data.responseCache.checkedAt,checkedAt);await flush();
  const view=(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}))[0];
  assert.equal(view.data.responseCache.validUntil,new Date(Date.parse(checkedAt)+7*86400000).toISOString());
  f.advance(86400000);assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}),[]);
  assert.equal((await f.read()).status,503);
});

test('forced fresh source bypasses disk fallback while a failed refresh preserves the persisted public projection',async t=>{
  const {options,checkedAt}=await persistedFixture(t),f=fixture(options);f.advance(3600000);f.setSource(async()=>fail(504));
  assert.equal((await f.read({force:true})).status,504);
  const restarted=fixture(options);restarted.advance(3600000);
  const views=await restarted.cache.snapshot({scope:'new',identity:identity()});
  assert.equal(views.length,1);assert.equal(views[0].data.responseCache.checkedAt,checkedAt);
});

test('a fresh source waits for atomic persistence, then rejects an access change during the write',async()=>{
  const writing=deferred(),started=deferred(),store=projectedStore({put:()=>{started.resolve();return writing.promise;}}),f=fixture({persistentStore:store});
  let settled=false;const result=f.read({force:true}).then(reply=>{settled=true;return reply;});await started.promise;
  assert.equal(settled,false);await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity([])});
  writing.resolve(true);assert.equal((await result).status,409);
});

test('persisted public payload excludes private fields and bootstrap prefers the current default end month',async t=>{
  const {options}=await persistedFixture(t),f=fixture(options),data=source();
  data.customer={secret:'private-account'};data.token='private-token';data.sources[0].credential='private-source';
  data.sources[0].rows[0].secret='private-row';f.setSource(async()=>ok(data));await f.read({force:true});
  f.advance(1000);f.setSource(async request=>ok(source(request.regionKey,request.month)));await f.read({month:'2026-08'});await f.cache.flushPersistence();
  const restarted=fixture(options);restarted.advance(3600000);const views=await restarted.cache.snapshot({scope:'new',identity:identity()});
  assert.equal(views[0].month,'2026-09');assert.doesNotMatch(JSON.stringify(views),/private-|csrfToken|customerId|opaque-a/);
  assert.equal((await restarted.cache.snapshot({scope:'new',identity:identity(),preferMonth:'2026-08'}))[0].month,'2026-08');
});

test('bootstrap default-month priority uses Korea time at a UTC month boundary',async()=>{
  const f=fixture();f.time(Date.parse('2026-10-31T16:00:00Z'));
  await f.read({month:'2026-10'});f.advance(1000);await f.read({month:'2026-09'});
  assert.equal((await f.cache.snapshot({scope:'host:customer:opaque-a',identity:identity()}))[0].month,'2026-10');
});
