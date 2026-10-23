'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createReportReadCache}=require('../report-read-cache.cjs');
const AT=Date.parse('2026-10-23T00:00:00Z'),DAY=86400000;
const clone=value=>JSON.parse(JSON.stringify(value)),ok=data=>({status:200,ok:true,data}),fail=status=>({status,ok:false,data:{error:{code:'HTTP_'+status,message:'fixture error'}}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};},flush=()=>new Promise(resolve=>setImmediate(resolve));
const totals=(sold=5)=>({days:30,supply:300,sold,reservationRate:sold/300,publicBookings:sold,phoneBookings:0,estimatedRevenue:null});
function identity(){return {customer:{customerId:'cust_a',revision:1,accountStatus:'active',relations:[{companyId:'own_a',kind:'own',status:'active'},{companyId:'comp_b',kind:'competitor',status:'pending'}],regions:[{regionKey:'r_one',status:'active'}]},companies:[{companyId:'own_a',name:'Own A',rooms:10,regionKey:'r_one'},{companyId:'comp_b',name:'Competitor B',rooms:16,regionKey:'r_one'}],regions:[{id:'r_one',label:'One'}],preparations:[],csrfToken:'PRIVATE-CSRF',collectionAllowance:{used:0},corrections:[{memo:'PRIVATE-MEMO'}]};}
function report({start='2026-10-23',ownId='own_a',sold=5,account=identity()}={}){
 const end=new Date(Date.parse(start+'T00:00:00Z')+29*DAY).toISOString().slice(0,10),month=new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7))-2,1)).toISOString().slice(0,7);
 const companies=account.customer.relations.filter(row=>['active','pending'].includes(row.status)&&(row.kind==='competitor'||row.companyId===ownId)).map(row=>({...account.companies.find(c=>c.companyId===row.companyId),kind:row.kind,relationStatus:row.status,unavailable:false,lastObservedDay:null,lastObservedAt:null,summary:totals(sold)}));
 return {mode:'current_briefing',published:false,generatedAt:new Date(AT).toISOString(),period:{start,end,days:30},ownId,companies,comparisons:ownId?companies.filter(row=>row.kind==='competitor').map(row=>({companyId:row.companyId,name:row.name,commonDays:0,dates:[],own:totals(sold),competitor:totals(0),gapPp:null,status:'insufficient',basis:'same_stay_date_same_kst_observation_day_within_7_days'})):[],regions:account.regions.map(region=>({region,month,source:'datalab_saved',networkAttempted:false,availableSources:0,sources:[{key:'tourism_visitors',status:'partial',rows:[{key:'visitors',value:null,status:'missing'}],series:[{month,status:'missing',rows:[]}],metrics:[]}],warnings:[]})),actions:[{key:'coverage',title:'Review coverage',reason:'Missing observations',next:'Review saved source',check:'Observed dates',source:'Company DB'}],definitions:['Do not sum competitors.']};
}
function fixture(options={}){
 let time=AT,account=identity(),source=report(),guards=0,reads=0;const cache=createReportReadCache({now:()=>time,...options});
 const read=(extra={})=>cache.read({scope:'host:customer:opaque',audience:'https://insight.example:customer',ownId:'own_a',readIdentity:async()=>{guards++;return ok(clone(account));},...extra,readSource:extra.readSource||(async()=>{reads++;return source.status?clone(source):ok(clone(source));})});
 return {cache,read,account,value:()=>source,source(value){source=value;},setIdentity(value){account=value;},advance(ms){time+=ms;},time(value){time=value;},now:()=>time,guards:()=>guards,reads:()=>reads};
}
async function durable(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-report-cache-'));t.after(async()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('insight-report-cache-'));await fs.rm(resolved,{recursive:true,force:true});});return {persistenceDirectory:directory,namespace:'https://central.example',directory};}

test('a runtime hit checks central permission each time and stores only report display fields',async()=>{
 const f=fixture(),value=report();value.csrfToken='PRIVATE-TOKEN';value.companies[0].contact='PRIVATE-CONTACT';value.regions[0].sources[0].token='PRIVATE-SOURCE';value.companies[0].summary.phoneBookings=0;f.source(value);
 const first=await f.read();assert.equal(first.data.responseCache.state,'fresh');assert.equal(first.data.companies[0].summary.phoneBookings,0);assert.equal(first.data.companies[0].summary.estimatedRevenue,null);assert.doesNotMatch(JSON.stringify(first),/PRIVATE-/);
 first.data.companies[0].rooms=999;const hit=await f.read();assert.equal(hit.data.companies[0].rooms,10);assert.equal(hit.data.responseCache.state,'cached');assert.equal(f.guards(),2);assert.equal(f.reads(),1);
});

test('account, origin/mode audience, session and explicit/default own requests remain isolated',async()=>{
 const f=fixture(),variants=[{}, {scope:'different-session'},{audience:'https://insight.example:admin'},{audience:'https://other.example:customer'},{ownId:''}];
 for(const variant of variants)assert.equal((await f.read(variant)).data.responseCache.state,'fresh');assert.equal(f.reads(),variants.length);
 for(const variant of variants)assert.equal((await f.read(variant)).data.responseCache.state,'cached');
 const another=identity();another.customer.customerId='cust_other';f.setIdentity(another);assert.equal((await f.read()).data.responseCache.state,'fresh');
});

test('pending identity and source are singleflight only while pending',async()=>{
 const cache=createReportReadCache({now:()=>AT}),permission=deferred(),source=deferred();let guards=0,reads=0;
 const request={scope:'s',ownId:'own_a',readIdentity:()=>{guards++;return permission.promise;},readSource:()=>{reads++;return source.promise;}};
 const first=cache.read(request),second=cache.read(request);assert.equal(guards,1);permission.resolve(ok(identity()));await flush();assert.equal(reads,1);source.resolve(ok(report()));assert.equal((await first).status,200);assert.equal((await second).status,200);
 await cache.read({...request,readIdentity:async()=>{guards++;return ok(identity());}});assert.equal(guards,2);assert.equal(reads,1);
});

test('background refresh returns saved report while source is pending and replaces only after success',async()=>{
 const f=fixture(),pending=deferred();const first=await f.read();f.advance(30000);const options={readSource:()=>pending.promise};
 const hit=await f.read(options);assert.equal(hit.data.responseCache.refreshing,true);assert.equal(hit.data.generatedAt,first.data.generatedAt);assert.equal(hit.data.companies[0].summary.sold,5);assert.equal((await f.read(options)).data.responseCache.refreshing,true);
 pending.resolve(ok(report({sold:8})));await flush();assert.equal((await f.read()).data.companies[0].summary.sold,8);
});

for(const status of [401,403,503])test(`identity HTTP ${status} returns no saved report`,async()=>{const f=fixture();await f.read();const result=await f.read({readIdentity:async()=>fail(status)});assert.equal(result.status,status);assert.equal(result.data.companies,undefined);assert.equal(f.reads(),1);});

for(const status of [401,403,404])test(`source HTTP ${status} blocks same-scope disk/runtime resurrection`,async t=>{
 const config=await durable(t),f=fixture(config);await f.read();assert.equal((await f.read({force:true,readSource:async()=>fail(status)})).status,status);assert.equal((await f.read()).status,status);assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque',audience:'https://insight.example:customer',identity:identity()}),[]);
});

test('transient source failure retains original result and timestamp without fake freshness',async()=>{
 const f=fixture(),first=await f.read();f.advance(30000);await f.read({readSource:async()=>fail(503)});await flush();const hit=await f.read();assert.equal(hit.data.responseCache.refreshFailed,true);assert.equal(hit.data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(hit.data.companies[0].summary.sold,5);
});

for(const [label,change] of [
 ['company unavailable',r=>{r.companies[0].unavailable=true;}],
 ['region fallback',r=>{r.regions[0].sourceStatus='unavailable';r.regions[0].sources=[];r.regions[0].warnings=['source failed'];}],
 ['source error',r=>{r.regions[0].sources[0].status='error';}],
 ['series error',r=>{r.regions[0].sources[0].series[0].status='error';}],
 ['row error',r=>{r.regions[0].sources[0].rows[0].status='failed';}]
])test(`HTTP200 ${label} displays validated partial data without overwriting the normal snapshot`,async t=>{
 const config=await durable(t),f=fixture(config);await f.read();await f.cache.flushPersistence();const normalFile=(await fs.readdir(config.directory)).find(name=>name.endsWith('.json')),normalBefore=await fs.readFile(path.join(config.directory,normalFile));
 const broken=report({sold:0});change(broken);f.advance(1);
 const partial=await f.read({force:true,readSource:async()=>ok(broken)});assert.equal(partial.status,200);assert.equal(partial.data.responseCache.state,'partial');assert.equal(partial.data.responseCache.partial,true);assert.equal(partial.data.responseCache.refreshFailed,false);assert.equal(partial.data.dataQuality.status,'partial');assert.ok(partial.data.dataQuality.issues.length);assert.equal(partial.data.companies[0].summary.sold,0);assert.equal(partial.data.companies[0].summary.estimatedRevenue,null);
 assert.deepEqual(await fs.readFile(path.join(config.directory,normalFile)),normalBefore);assert.equal(f.cache.persistenceStatus().normalEntries,1);assert.equal(f.cache.persistenceStatus().partialEntries,1);
 const cold=fixture({...config,persistenceDirectory:path.join(config.directory,'cold')});const coldReply=await cold.read({readSource:async()=>ok(broken)});assert.equal(coldReply.status,200);assert.equal(coldReply.data.responseCache.state,'partial');assert.equal(cold.cache.persistenceStatus().normalEntries,0);assert.equal(cold.cache.persistenceStatus().partialEntries,1);
 const restarted=fixture(config);restarted.advance(2);const views=await restarted.cache.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:identity()});assert.equal(views[0].data.companies[0].summary.sold,0);assert.equal(views[0].data.responseCache.state,'partial');assert.equal(views[0].data.responseCache.partial,true);assert.equal(views[0].data.responseCache.persisted,true);assert.equal(views[0].data.responseCache.checkedAt,partial.data.responseCache.checkedAt);assert.deepEqual(views[0].data.dataQuality.issues,partial.data.dataQuality.issues);
});

for(const [label,change] of [
 ['room review',a=>{a.companies[0].rooms=16;}],['company name',a=>{a.companies[0].name='Changed';}],['revision',a=>{a.customer.revision++;}],['relation',a=>{a.customer.relations[1].status='active';}],['region catalog',a=>{a.regions[0].label='Changed';}],['preparation',a=>{a.preparations=[{companyId:'own_a',status:'ready',runId:'new-source'}];}]
])test(`${label} changes invalidate only the obsolete report identity partition`,async t=>{
 const config=await durable(t),f=fixture(config);await f.read();const account=identity();change(account);f.setIdentity(account);f.source(report({account}));assert.equal((await f.read()).data.responseCache.state,'fresh');
 const next=fixture(config);next.setIdentity(account);assert.equal((await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:account}))[0].data.responseCache.persisted,true);
});

test('process restart restores original clocks after fresh identity and refreshes in background',async t=>{
 const config=await durable(t),first=fixture(config),fresh=await first.read();await first.cache.flushPersistence();
 const files=await fs.readdir(config.directory);assert.equal(files.filter(name=>name.endsWith('.json')).length,1);const text=await fs.readFile(path.join(config.directory,files[0]),'utf8');assert.doesNotMatch(text,/PRIVATE-|csrfToken|collectionAllowance|corrections|customerId|cust_a/);
 const next=fixture(config);next.advance(1000);await next.cache.ready();const views=await next.cache.snapshot({scope:'host:customer:new-hmac',audience:'https://insight.example:customer',identity:identity()});assert.equal(next.reads(),0);assert.equal(next.guards(),0);assert.equal(views.length,1);assert.equal(views[0].ownId,'own_a');assert.equal(views[0].data.responseCache.persisted,true);assert.equal(views[0].data.responseCache.checkedAt,fresh.data.responseCache.checkedAt);assert.equal(views[0].data.generatedAt,fresh.data.generatedAt);
 const pending=deferred(),hit=await next.read({scope:'host:customer:new-hmac',readSource:()=>pending.promise});assert.equal(hit.data.responseCache.refreshing,true);assert.equal(hit.data.responseCache.persisted,true);assert.equal(next.guards(),1);pending.resolve(ok(report({sold:9})));await flush();await next.cache.flushPersistence();
 assert.equal((await next.read({scope:'host:customer:new-hmac'})).data.companies[0].summary.sold,9);
});

test('restart cannot restore another account, host/mode, revoked registration or changed catalog',async t=>{
 const config=await durable(t),first=fixture(config);await first.read();
 for(const transform of [a=>{a.customer.customerId='other';},a=>{a.customer.relations=[];},a=>{a.companies[0].rooms=16;}]){const a=identity();transform(a);const next=fixture(config);assert.deepEqual(await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:a}),[]);}
 for(const audience of ['https://other.example:customer','https://insight.example:admin']){const next=fixture(config);assert.deepEqual(await next.cache.snapshot({scope:'new',audience,identity:identity()}),[]);}
});

test('default own resolution reorder cannot reuse a prior default report',async t=>{
 const config=await durable(t),f=fixture(config);await f.read({ownId:''});const changed=identity();changed.customer.relations.unshift({companyId:'own_second',kind:'own',status:'active'});changed.companies.push({companyId:'own_second',name:'Second',rooms:7,regionKey:'r_one'});f.setIdentity(changed);f.source(report({ownId:'own_second',account:changed}));const latest=await f.read({ownId:''});assert.equal(latest.data.ownId,'own_second');assert.equal(latest.data.responseCache.state,'fresh');
});

test('KST midnight rejects yesterday report in bootstrap, source response and pending commit',async t=>{
 const config=await durable(t),f=fixture(config);f.time(Date.parse('2026-10-23T14:59:59.000Z'));await f.read();f.advance(1001);assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque',audience:'https://insight.example:customer',identity:identity()}),[]);assert.equal((await f.read()).status,503);
 f.source(report({start:'2026-10-24'}));assert.equal((await f.read()).data.period.start,'2026-10-24');
 const pendingFixture=fixture({...config,persistenceDirectory:path.join(config.directory,'pending')}),pending=deferred();pendingFixture.time(Date.parse('2026-10-23T14:59:59.000Z'));const old=pendingFixture.read({readSource:()=>pending.promise});await flush();pendingFixture.advance(1001);pending.resolve(ok(report()));assert.equal((await old).status,409);await pendingFixture.cache.flushPersistence();assert.equal(pendingFixture.cache.persistenceStatus().entries,0);
});

test('registration remove/restore ABA and scope invalidation prevent delayed writes',async t=>{
 const config=await durable(t),f=fixture(config),pending=deferred();const old=f.read({readSource:()=>pending.promise});await flush();const removed=identity();removed.customer.relations=[];f.setIdentity(removed);assert.equal((await f.read()).status,404);f.setIdentity(identity());const restored=await f.read({readSource:async()=>ok(report({sold:8}))});assert.equal(restored.status,200);pending.resolve(ok(report({sold:99})));assert.equal((await old).status,409);await f.cache.flushPersistence();assert.equal((await f.read()).data.companies[0].summary.sold,8);
 const another=deferred();f.advance(30000);await f.read({readSource:()=>another.promise});f.cache.invalidate('host:customer:opaque');another.resolve(ok(report({sold:99})));await flush();assert.deepEqual(await f.cache.snapshot({scope:'host:customer:opaque',audience:'https://insight.example:customer',identity:identity()}),[]);
});

for(const [label,change] of [
 ['wrong period',r=>{r.period.start='2026-10-22';}],['bad period',r=>{r.period.start='not-a-date';}],['wrong own',r=>{r.ownId='another';}],['wrong company',r=>{r.companies[0].companyId='another';}],['missing company',r=>{r.companies=[];}],['missing comparison',r=>{r.comparisons=[];}],['missing region',r=>{r.regions=[];}],['wrong region month',r=>{r.regions[0].month='2026-08';}],['wrong region window',r=>{r.regions[0].window={end:'2026-08'};}]
])test(`malformed source ${label} never becomes a saved normal report`,async()=>{const f=fixture(),broken=report();change(broken);assert.equal((await f.read({readSource:async()=>ok(broken)})).status,503);});

test('empty business-planning report is supported without fabricating an own company',async()=>{const account=identity();account.customer.relations=[];account.customer.regions=[];account.companies=[];account.regions=[];const f=fixture();f.setIdentity(account);f.source(report({ownId:null,account}));const reply=await f.read({ownId:''});assert.equal(reply.status,200);assert.equal(reply.data.ownId,null);assert.deepEqual(reply.data.companies,[]);assert.equal((await f.read({ownId:''})).data.responseCache.state,'cached');});

test('oversize memory results do not persist in runtime and no shared display objects escape',async()=>{const f=fixture({maxBytes:1});assert.equal((await f.read()).status,200);assert.equal((await f.read()).data.responseCache.state,'fresh');assert.equal(f.reads(),2);});

function diagnosedPartial(){
 const value=report(),company=value.companies[1],issue={scope:'company',companyId:company.companyId,name:company.name,month:'2026-11',period:{start:'2026-11-01',end:'2026-11-21'},code:'COMPANY_MONTH_NOT_OBSERVED',reason:'해당 숙박월의 저장 관측 자료가 없습니다.'};
 company.unavailable=true;company.sourceStatus='partial';company.sourceIssues=[issue];company.summary={days:0,supply:null,sold:null,reservationRate:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null};value.dataQuality={status:'partial',issues:[issue]};return value;
}
test('partial diagnostic fields, genuine zero and unknown amounts survive restart without storing private source details',async t=>{
 const config=await durable(t),f=fixture(config),value=diagnosedPartial();value.dataQuality.issues[0].rawError='PRIVATE-EXCEPTION';value.companies[1].sourceIssues[0].stack='PRIVATE-STACK';value.companies[0].summary.publicBookings=0;
 const first=await f.read({readSource:async()=>ok(value)});assert.equal(first.status,200);assert.equal(first.data.responseCache.partial,true);assert.equal(first.data.companies[0].summary.publicBookings,0);assert.equal(first.data.companies[1].summary.sold,null);assert.equal(first.data.companies[1].sourceIssues[0].month,'2026-11');assert.doesNotMatch(JSON.stringify(first),/PRIVATE-|rawError|stack/);await f.cache.flushPersistence();
 const next=fixture(config),views=await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:identity()});assert.equal(views.length,1);assert.equal(next.reads(),0);assert.equal(views[0].data.responseCache.state,'partial');assert.equal(views[0].data.responseCache.partial,true);assert.equal(views[0].data.responseCache.persisted,true);assert.equal(views[0].data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.deepEqual(views[0].data.dataQuality,first.data.dataQuality);assert.deepEqual(views[0].data.companies[1].sourceIssues,first.data.companies[1].sourceIssues);
 const text=(await Promise.all((await fs.readdir(config.directory)).filter(name=>name.endsWith('.json')).map(name=>fs.readFile(path.join(config.directory,name),'utf8')))).join('');assert.doesNotMatch(text,/PRIVATE-|csrfToken|customerId|cust_a/);
});
test('a partial snapshot cannot cross account, permission, origin, selection or Korea-day boundaries',async t=>{
 const config=await durable(t),first=fixture(config);await first.read({readSource:async()=>ok(diagnosedPartial())});
 for(const mutate of [a=>{a.customer.customerId='other';},a=>{a.customer.relations.pop();},a=>{a.companies[0].rooms=11;}]){const next=fixture(config),account=identity();mutate(account);assert.deepEqual(await next.cache.snapshot({scope:'new',audience:'https://insight.example:customer',identity:account}),[]);}
 const next=fixture(config);assert.deepEqual(await next.cache.snapshot({scope:'new',audience:'https://other.example:customer',identity:identity()}),[]);assert.equal((await next.read({readIdentity:async()=>fail(403)})).status,403);assert.equal(next.reads(),0);
 next.advance(DAY);assert.deepEqual(await next.cache.snapshot({scope:'different',audience:'https://insight.example:customer',identity:identity()}),[]);
});
test('an HTTP failure after a partial result preserves its check date and cannot promote it to a complete report',async()=>{
 const f=fixture(),first=await f.read({readSource:async()=>ok(diagnosedPartial())});f.advance(30000);await f.read({readSource:async()=>fail(503)});await flush();const kept=await f.read();assert.equal(kept.data.responseCache.state,'partial');assert.equal(kept.data.responseCache.partial,true);assert.equal(kept.data.responseCache.refreshFailed,true);assert.equal(kept.data.responseCache.checkedAt,first.data.responseCache.checkedAt);assert.equal(kept.data.dataQuality.status,'partial');assert.equal(kept.data.companies[1].summary.sold,null);
});
for(const [label,change] of [
 ['external region request',r=>{r.regions[0].networkAttempted=true;}],['unverified region transport',r=>{delete r.regions[0].networkAttempted;}],['foreign diagnostic company',r=>{r.dataQuality.issues[0].companyId='foreign';}],['foreign row diagnostic',r=>{r.companies[1].sourceIssues=[{...r.companies[1].sourceIssues[0],companyId:'own_a'}];}],['diagnostic outside period',r=>{r.dataQuality.issues[0].month='2026-09';}],['malformed diagnostic array',r=>{r.companies[1].sourceIssues={code:'PRIVATE-INVALID'};}],['malformed companies',r=>{r.companies={};}]
])test('partial data does not bypass '+label+' validation',async()=>{const f=fixture(),value=diagnosedPartial();change(value);const reply=await f.read({readSource:async()=>ok(value)});assert.equal(reply.status,503);assert.equal(reply.data.companies,undefined);});
