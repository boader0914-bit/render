'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createReportReadCache}=require('../report-read-cache.cjs');
const AT=Date.parse('2026-10-26T00:00:00Z'),DAY=86400000;
const clone=v=>JSON.parse(JSON.stringify(v)),ok=data=>({status:200,ok:true,data}),flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
function identity({bindings=true}={}){
 const relations=[{companyId:'own',kind:'own',status:'pending'},{companyId:'other',kind:'own',status:'active'},{companyId:'competitor',kind:'competitor',status:'active'}];
 const companies=relations.map((r,i)=>({companyId:r.companyId,name:r.companyId,rooms:16,regionKey:['town','other_city','competitor_city'][i]}));
 const regions=['town','city','other_city','competitor_city','interest'].map(id=>({id,label:id,level:'local'}));
 const result={customer:{customerId:'synthetic_customer',accountStatus:'active',revision:1,relations,regions:[{regionKey:'interest',status:'pending'}]},companies,regions,preparations:[]};
 if(bindings)result.comparisonRegionBindings=relations.map((r,i)=>({companyId:r.companyId,kind:r.kind,relationStatus:r.status,regionKey:companies[i].regionKey,analysisRegionKey:i===0?'city':companies[i].regionKey,regionLabel:i===0?'city':companies[i].regionKey,hierarchyApplied:i===0,regionStatus:'ready'}));
 return result;
}
function report(account=identity(),{legacy=false,sold=1,ownId='own'}={}){
 const summary={days:1,supply:16,sold,reservationRate:sold/16,publicBookings:sold,phoneBookings:0,estimatedRevenue:null};
 const selected=account.customer.relations.filter(r=>r.kind==='competitor'||r.companyId===ownId);
 const companies=selected.map(r=>({...account.companies.find(c=>c.companyId===r.companyId),kind:r.kind,relationStatus:r.status,...(!legacy?{analysisRegionKey:account.comparisonRegionBindings.find(b=>b.companyId===r.companyId).analysisRegionKey}:{}),summary}));
 const own=companies.find(c=>c.kind==='own');
 const ids=['interest'];if(!legacy||own?.relationStatus==='active')ids.push(legacy?own.regionKey:own.analysisRegionKey);
 return {mode:'current_briefing',published:false,generatedAt:new Date(AT+sold*1000).toISOString(),ownId,period:{start:'2026-10-26',end:'2026-11-24',days:30},companies,comparisons:[{companyId:'competitor',name:'competitor',commonDays:0,dates:[],own:summary,competitor:summary,gapPp:null,status:'insufficient',basis:'same_stay_date_same_kst_observation_day_within_7_days'}],regions:ids.filter(Boolean).map(id=>({region:{id,label:id},month:'2026-09',source:'datalab_saved',networkAttempted:false,availableSources:0,sources:[],warnings:[]})),actions:[],definitions:['소유 확인은 대기 상태이며 소재지 자료만 읽기 전용으로 연결합니다.']};
}
function fixture(options={}){
 let account=identity(),source=report(),calls=0,time=AT;const cache=createReportReadCache({now:()=>time,...options});
 const read=(extra={})=>cache.read({scope:'synthetic_scope',audience:'https://insight.synthetic:customer',ownId:'own',readIdentity:async()=>ok(clone(account)),readSource:async()=>{calls++;return ok(clone(source));},...extra});
 return {cache,read,setIdentity(v){account=v;},setSource(v){source=v;},advance(v){time+=v;},calls:()=>calls};
}
async function durable(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-report-region-binding-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('insight-report-region-binding-'));await fs.rm(directory,{recursive:true,force:true});});return {persistenceDirectory:directory,namespace:'https://central.synthetic',directory};}

test('pending own city/county context and registered pending interest are read-only authorized and retain original location',async()=>{
 const f=fixture(),reply=await f.read();assert.equal(reply.status,200);assert.deepEqual(reply.data.regions.map(r=>r.region.id).sort(),['city','interest']);assert.equal(reply.data.companies[0].regionKey,'town');assert.equal(reply.data.companies[0].analysisRegionKey,'city');assert.equal(reply.data.companies[0].relationStatus,'pending');assert.match(reply.data.definitions[0],/소유 확인은 대기/);
});
for(const [label,change] of [
 ['mismatched report binding',r=>{r.companies[0].analysisRegionKey='competitor_city';}],
 ['null mismatched report binding',r=>{r.companies[0].analysisRegionKey=null;}],
 ['malformed report binding',r=>{r.companies[0].analysisRegionKey={id:'city'};}],
 ['competitor location',r=>{r.regions.push({region:{id:'competitor_city',label:'competitor_city'},month:'2026-09',networkAttempted:false,sources:[]});}],
 ['non-selected own location',r=>{r.regions.push({region:{id:'other_city',label:'other_city'},month:'2026-09',networkAttempted:false,sources:[]});}]
])test(label+' cannot become a report projection',async()=>{const f=fixture(),data=report();change(data);f.setSource(data);const reply=await f.read();assert.equal(reply.status,503);assert.equal(reply.data.companies,undefined);});

for(const [label,change] of [
 ['malformed binding container',a=>{a.comparisonRegionBindings={};}],
 ['missing bound company',a=>{a.comparisonRegionBindings.pop();}],
 ['binding and company raw-key conflict',a=>{a.comparisonRegionBindings[0].regionKey='forged_town';}],
 ['binding and relation conflict',a=>{a.comparisonRegionBindings[0].relationStatus='active';}],
 ['invalid binding hierarchy flag',a=>{a.comparisonRegionBindings[0].hierarchyApplied=false;}]
])test('present '+label+' cannot silently downgrade to legacy authorization',async()=>{const f=fixture(),a=identity();change(a);f.setIdentity(a);const reply=await f.read();assert.equal(reply.status,404);assert.equal(f.calls(),0);});

test('a validated unresolved city mapping retains an explicit null without guessing the town',async()=>{
 const f=fixture(),a=identity();Object.assign(a.comparisonRegionBindings[0],{analysisRegionKey:null,regionLabel:null,hierarchyApplied:false,regionStatus:'unknown'});f.setIdentity(a);f.setSource(report(a));const reply=await f.read();assert.equal(reply.status,200);assert.equal(reply.data.companies[0].analysisRegionKey,null);assert.deepEqual(reply.data.regions.map(r=>r.region.id),['interest']);
});

test('legacy identities and old pending-property reports remain readable before the central deployment',async()=>{
 const f=fixture(),a=identity({bindings:false});f.setIdentity(a);f.setSource(report(a,{legacy:true}));const reply=await f.read();assert.equal(reply.status,200);assert.deepEqual(reply.data.regions.map(r=>r.region.id),['interest']);assert.equal(Object.hasOwn(reply.data.companies[0],'analysisRegionKey'),false);
});

test('an existing snapshot stays visible then updates to a normalized report that survives restart',async t=>{
 const config=await durable(t),first=fixture(config),oldIdentity=identity({bindings:false});first.setIdentity(oldIdentity);first.setSource(report(oldIdentity,{legacy:true}));const old=await first.read();await first.cache.flushPersistence();const before=await fs.readdir(config.directory);assert.equal(before.filter(f=>f.endsWith('.json')).length,1);
 const restarted=fixture(config),pending=deferred();restarted.advance(2000);const initial=await restarted.read({readSource:()=>pending.promise});assert.equal(initial.status,200);assert.equal(initial.data.responseCache.persisted,true);assert.equal(initial.data.responseCache.refreshing,true);assert.equal(initial.data.generatedAt,old.data.generatedAt);assert.deepEqual(initial.data.regions.map(r=>r.region.id),['interest']);
 pending.resolve(ok(report(identity(),{sold:3})));await flush();await restarted.cache.flushPersistence();const fresh=await restarted.read();assert.equal(fresh.data.companies[0].analysisRegionKey,'city');assert.equal(fresh.data.companies[0].summary.sold,3);assert.deepEqual(fresh.data.regions.map(r=>r.region.id).sort(),['city','interest']);
 const third=fixture(config);third.advance(3000);const boot=await third.cache.snapshot({scope:'new_session',audience:'https://insight.synthetic:customer',identity:identity()});const saved=boot.find(r=>r.ownId==='own');assert.ok(saved);assert.equal(saved.data.companies[0].analysisRegionKey,'city');assert.equal(saved.data.companies[0].regionKey,'town');assert.equal(saved.data.companies[0].summary.sold,3);assert.equal(saved.data.responseCache.persisted,true);
});

test('binding-only hierarchy changes invalidate runtime and durable snapshots even when raw catalog and slot stay the same',async t=>{
 const config=await durable(t),f=fixture(config);await f.read();await f.cache.flushPersistence();const changed=identity();Object.assign(changed.comparisonRegionBindings[0],{analysisRegionKey:'other_city',regionLabel:'other_city'});f.setIdentity(changed);const pending=deferred(),read=f.read({readSource:()=>pending.promise});await flush();let settled=false;void read.then(()=>{settled=true;});await flush();assert.equal(settled,false,'old runtime report must not display under the changed binding');
 const restarted=fixture(config);restarted.setIdentity(changed);assert.deepEqual(await restarted.cache.snapshot({scope:'new_session',audience:'https://insight.synthetic:customer',identity:changed}),[],'old disk report must fail fresh hierarchy authorization');pending.resolve(ok(report(changed,{sold:4})));assert.equal((await read).data.companies[0].analysisRegionKey,'other_city');
});

test('selected non-default own reports use independent region context in read and restart bootstrap',async t=>{
 const config=await durable(t),f=fixture(config),a=identity();f.setSource(report(a,{ownId:'other'}));const reply=await f.read({ownId:'other'});assert.equal(reply.status,200);assert.deepEqual(reply.data.regions.map(r=>r.region.id).sort(),['interest','other_city']);await f.cache.flushPersistence();const restarted=fixture(config);const boot=await restarted.cache.snapshot({scope:'new_session',audience:'https://insight.synthetic:customer',identity:a});assert.ok(boot.some(r=>r.ownId==='other'&&r.data.companies.find(c=>c.kind==='own').analysisRegionKey==='other_city'));
});
