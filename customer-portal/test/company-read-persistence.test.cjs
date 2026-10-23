'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const AT=Date.parse('2026-10-23T00:00:00Z'),DAY=86400000;
const ok=data=>({status:200,ok:true,data}),fail=status=>({status,ok:false,data:{error:{code:'HTTP_'+status}}});
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function identity(ids=['a']){return {customer:{customerId:'private-customer-id',accountStatus:'active',revision:1,relations:ids.map(companyId=>({companyId,kind:'own',status:'active'}))},companies:ids.map(companyId=>({companyId,name:'업체 '+companyId,rooms:16,version:'v1'})),preparations:[],collectionAllowance:{canRequest:true,limit:1}};}
function source(companyId='a',month='2026-10',version='v1'){
  return {result:{companyId,runId:'run-'+version,version,rooms:16,products:[{key:'p1',name:'숙박',productType:'lodging',days:[{date:month+'-01',status:'observed',total:16,available:16,publicBookings:0,price:null}],original:[]}]},companyDetail:{companyId,basics:{name:'업체 '+companyId,rooms:16},channels:[{key:'naver',label:'네이버',url:'https://booking.naver.com/booking/3/bizes/123'}],current:{summary:{sold:0,estimatedRevenue:null},daily:[{date:month+'-01',total:16,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:null,missing:false},{date:month+'-02',total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null,missing:true}]},integrated:{companyId,status:'ready',selectedMonth:month,roomBasis:{count:16,label:'DB 검수값'},snapshot:{summary:{sold:0,estimatedRevenue:null},daily:[]}}},request:null};
}
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-company-persistence-'));let now=AT;
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-company-persistence-'));await fs.rm(target,{recursive:true,force:true});});
  const config={persistenceDirectory:directory,namespace:'https://central.example',now:()=>now,...options};
  const make=()=>createCompanyReadCache(config),cache=make();await cache.ready();
  const read=(cache,extra={})=>cache.read({scope:'ephemeral-session',audience:'https://insight.example:customer',companyId:'a',readIdentity:async()=>ok(identity()),readSource:async()=>ok(source()),...extra});
  return {directory,cache,read,make,advance(ms){now+=ms;},now:()=>now};
}

test('a new process/session restores exact valid zero and missing values, then refreshes behind the saved result',async t=>{
  const f=await fixture(t),first=await f.read(f.cache);await f.cache.flushPersistence();
  const next=f.make(),pending=defer();f.advance(DAY);await next.ready();let checks=0,sources=0;
  const reply=await f.read(next,{scope:'new-random-session',readIdentity:async()=>{checks++;return ok(identity());},readSource:()=>{sources++;return pending.promise;}});
  assert.equal(checks,1);assert.equal(sources,1);assert.equal(reply.data.result.version,'v1');assert.equal(reply.data.responseCache.persisted,true);assert.equal(reply.data.responseCache.refreshing,true);
  assert.equal(reply.data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(reply.data.responseCache.validUntil,new Date(AT+7*DAY).toISOString());
  assert.equal(reply.data.companyDetail.current.daily[0].publicBookings,0);assert.equal(reply.data.companyDetail.current.daily[0].estimatedRevenue,null);assert.equal(reply.data.companyDetail.current.daily[1].missing,true);
  pending.resolve(ok(source('a','2026-10','v2')));await turn();await next.flushPersistence();
  const third=f.make();await third.ready();const fresh=(await third.snapshot({scope:'third-session',audience:'https://insight.example:customer',identity:identity()}))[0];
  assert.equal(fresh.data.result.version,'v2');assert.equal(fresh.data.responseCache.checkedAt,new Date(f.now()).toISOString());
});

test('fresh bootstrap restores own and competitor companies without issuing source or identity reads',async t=>{
  const f=await fixture(t),account=identity(['a','b']);account.customer.relations[1].kind='competitor';
  for(const companyId of ['a','b'])await f.read(f.cache,{companyId,readIdentity:async()=>ok(account),readSource:async()=>ok(source(companyId))});
  const next=f.make();await next.ready();const views=await next.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:account});
  assert.deepEqual(new Set(views.map(view=>view.companyId)),new Set(['a','b']));assert.ok(views.every(view=>view.data.responseCache.persisted));
  assert.equal(views[0].data.collectionAllowance.canRequest,true);account.collectionAllowance.canRequest=false;
  const updated=await next.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:account});assert.equal(updated[0].data.collectionAllowance.canRequest,false);
});

test('customer, public origin, admin/customer mode, backend, relation and company version stay isolated across restart',async t=>{
  const f=await fixture(t);await f.read(f.cache);await f.cache.flushPersistence();
  const changedCustomer=identity();changedCustomer.customer.customerId='other-customer';
  const changedRelation=identity();changedRelation.customer.relations[0].kind='competitor';
  const changedCompany=identity();changedCompany.companies[0].version='v2';
  const changedRevision=identity();changedRevision.customer.revision++;
  for(const extra of [{identity:changedCustomer},{identity:changedRelation},{identity:changedCompany},{identity:changedRevision},{audience:'https://other.example:customer'},{audience:'https://insight.example:admin'},{audience:undefined}]){
    const next=f.make();await next.ready();assert.deepEqual(await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity(),...extra}),[]);
  }
  const other=createCompanyReadCache({persistenceDirectory:f.directory,namespace:'https://other.example',now:f.now});await other.ready();assert.deepEqual(await other.snapshot({scope:'other',audience:'https://insight.example:customer',identity:identity()}),[]);
});

for(const status of [401,403,503])test('restart always checks central identity; '+status+' cannot expose prior data',async t=>{
  const f=await fixture(t);await f.read(f.cache);const next=f.make();await next.ready();let sources=0;
  const denied=await f.read(next,{readIdentity:async()=>fail(status),readSource:async()=>{sources++;return ok(source());}});
  assert.equal(denied.status,status);assert.equal(denied.data.result,undefined);assert.equal(sources,0);
});

test('removed or disabled registrations and active work cannot restore prior bootstrap or freeze progress',async t=>{
  const f=await fixture(t);await f.read(f.cache);
  const disabled=identity();disabled.customer.accountStatus='disabled';
  const active=identity();active.preparations=[{companyId:'a',status:'collecting'}];
  for(const account of [identity([]),disabled,active]){const next=f.make();await next.ready();assert.deepEqual(await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:account}),[]);}
});

test('persisted core drops all unknown sensitive fields at each level and keeps no account/session/request/quota',async t=>{
  const f=await fixture(t),data=source();Object.assign(data,{token:'private-token',request:{status:'ready',cookie:'private-cookie'},collectionAllowance:{secret:'private-quota'}});
  data.result.session='private-session';data.result.products[0].password='private-password';data.result.products[0].days[0].raw='private-raw';
  data.companyDetail.customer='private-account';data.companyDetail.basics.contact='private-contact';data.companyDetail.current.daily[0].guest='private-guest';data.companyDetail.integrated.snapshot.corrections='private-corrections';
  await f.read(f.cache,{readSource:async()=>ok(data)});await f.cache.flushPersistence();
  const files=await fs.readdir(f.directory);assert.equal(files.length,1);const text=await fs.readFile(path.join(f.directory,files[0]),'utf8');
  assert.doesNotMatch(text,/private-|customerId|allowance|cookie|password|csrf|corrections|session|contact|guest/);
  const next=f.make();await next.ready();const [restored]=await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()});assert.equal(restored.data.result.products[0].days[0].price,null);
});

test('default-period rollover and explicit stay months cannot relabel an earlier default view',async t=>{
  const f=await fixture(t);await f.read(f.cache);await f.read(f.cache,{month:'2026-09',readSource:async()=>ok(source('a','2026-09','september'))});
  f.advance(7*DAY); // Exactly expired; reads cannot renew the original observation.
  const next=f.make();await next.ready();assert.deepEqual(await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()}),[]);
  const g=await fixture(t);g.advance(8*DAY);await g.read(g.cache);g.advance(DAY); // KST October -> November.
  const november=g.make();await november.ready();assert.deepEqual(await november.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()}),[]);
});

test('permission remove/re-add ABA rejects the old refresh and prevents its durable overwrite',async t=>{
  const f=await fixture(t),pending=defer();await f.read(f.cache);f.advance(30000);await f.read(f.cache,{readSource:()=>pending.promise});
  await f.cache.snapshot({scope:'ephemeral-session',audience:'https://insight.example:customer',identity:identity([])});
  await f.cache.snapshot({scope:'ephemeral-session',audience:'https://insight.example:customer',identity:identity()});
  pending.resolve(ok(source('a','2026-10','forbidden-late')));await turn();await f.cache.flushPersistence();
  const next=f.make();await next.ready();const [saved]=await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()});assert.equal(saved.data.result.version,'v1');
});

for(const status of [403,404])test('a source '+status+' prevents bootstrap disk resurrection in the same session',async t=>{
  const f=await fixture(t);await f.read(f.cache);f.advance(30000);await f.read(f.cache,{readSource:async()=>fail(status)});await turn();
  assert.deepEqual(await f.cache.snapshot({scope:'ephemeral-session',audience:'https://insight.example:customer',identity:identity()}),[]);
  f.advance(DAY);let attempts=0;
  assert.equal((await f.read(f.cache,{readSource:async()=>{attempts++;return ok(source());}})).status,status);assert.equal(attempts,0,'date changes cannot remove source denial');
  assert.deepEqual(await f.cache.snapshot({scope:'ephemeral-session',audience:'https://insight.example:customer',identity:identity()}),[]);
});

test('failed/pending integrated responses and mismatched company IDs never replace last durable normal result',async t=>{
  const f=await fixture(t);await f.read(f.cache);
  for(const state of ['pending','updating','failed']){const bad=source('a','2026-10',state);bad.companyDetail.integrated.status=state;await f.read(f.cache,{force:true,readSource:async()=>ok(bad)});}
  const bad=source();bad.companyDetail.basics.companyId='different';assert.equal((await f.read(f.cache,{force:true,readSource:async()=>ok(bad)})).status,503);
  const next=f.make();await next.ready();assert.equal((await next.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()}))[0].data.result.version,'v1');
});

test('command invalidation cannot restore the old disk core until a new successful source response',async t=>{
  const f=await fixture(t);await f.read(f.cache);f.cache.invalidate('ephemeral-session');
  assert.deepEqual(await f.cache.snapshot({scope:'ephemeral-session',audience:'https://insight.example:customer',identity:identity()}),[]);
  let reads=0;const response=await f.read(f.cache,{readSource:async()=>{reads++;return ok(source('a','2026-10','after-command'));}});
  assert.equal(reads,1);assert.equal(response.data.responseCache.state,'fresh');assert.equal(response.data.result.version,'after-command');
});
