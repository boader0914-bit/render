'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const ok=data=>({status:200,ok:true,data}),turn=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const identity={customer:{customerId:'private-customer',revision:1,accountStatus:'active',relations:[{companyId:'private-company',kind:'own',status:'active'}]},companies:[{companyId:'private-company',version:'private-version'}],preparations:[],collectionAllowance:{secret:'private-quota'}};
const data={result:{companyId:'private-company',version:'private-result',products:[]},companyDetail:{companyId:'private-company',integrated:{status:'ready',selectedMonth:'2026-09'},current:{daily:[],summary:null}},privateEvidence:'private-evidence'};
const requestId='12345678-1234-1234-1234-123456789abc';
function request(cache,extra={}){return cache.read({scope:'private-session',audience:'private-audience',companyId:'private-company',month:'2026-09',requestId,readIdentity:async()=>ok(identity),readSource:async()=>ok(data),...extra});}
function safe(entries){
 const stages=new Set(['requested','joined','received','failed','validated','persisting','persisted','persistence_skipped','persistence_failed','archiving','archive_completed','archive_failed','remembered','memory_skipped','not_cacheable','invalidated','settled']);
 assert.ok(entries.every(row=>row.event==='company_source_read'&&stages.has(row.stage)&&/^[a-f0-9-]{36}$/.test(row.requestId)&&Number.isInteger(row.elapsedMs)&&row.elapsedMs>=0));
 for(const row of entries)assert.ok(Object.keys(row).every(key=>['event','stage','requestId','elapsedMs','status','errorCode'].includes(key)));
 assert.doesNotMatch(JSON.stringify(entries),/private-|2026-09|token|cookie|https:|Authorization|customerId|companyId/);
}
test('fixed phases identify source, disk, archive and memory stages without changing pending deduplication',async()=>{
 const source=defer(),disk=defer(),archive=defer(),events=[];let reads=0,tick=0;
 const cache=createCompanyReadCache({namespace:'https://central.example',onStage:row=>events.push(row),stageClock:()=>++tick,persistentStore:{async ready(){},get(){return null;},begin(){return {};},async put(){return disk.promise;}},onVerifiedSource:()=>archive.promise});
 const one=request(cache,{readSource:()=>{reads++;return source.promise;}}),two=request(cache,{readSource:()=>{reads++;return source.promise;}});await turn();assert.equal(reads,1);
 assert.deepEqual(events.map(row=>row.stage),['requested','joined']);source.resolve(ok(data));await turn();assert.equal(events.at(-1).stage,'persisting');
 disk.resolve(true);await turn();assert.equal(events.at(-1).stage,'archiving');archive.resolve({status:'stored'});
 assert.equal((await one).status,200);assert.equal((await two).status,200);
 assert.deepEqual(events.map(row=>row.stage),['requested','joined','received','validated','persisting','persisted','archiving','archive_completed','remembered','settled']);
 assert.ok(events.every(row=>row.requestId===requestId));safe(events);
});
test('source invalidation is observable and cannot repopulate a removed scope',async()=>{
 const source=defer(),events=[],cache=createCompanyReadCache({onStage:row=>events.push(row)}),pending=request(cache,{readSource:()=>source.promise});await turn();cache.invalidate('private-session');source.resolve(ok(data));
 assert.equal((await pending).status,409);assert.deepEqual(events.map(row=>row.stage),['requested','received','invalidated','settled']);assert.equal(events.find(row=>row.stage==='invalidated').errorCode,'SOURCE_STATE_REPLACED');safe(events);
});
test('only allowlisted status and error codes enter diagnostics, never raw errors',async()=>{
 for(const code of ['UPSTREAM_TIMEOUT','private-company-secret']){
  const events=[],cache=createCompanyReadCache({onStage:row=>events.push(row)}),reply=await request(cache,{readSource:async()=>({status:504,ok:false,data:{error:{code,message:'private-error-body'}}})});
  assert.equal(reply.status,504);assert.equal(events.find(row=>row.stage==='received').status,504);
  assert.equal(events.find(row=>row.stage==='failed').errorCode,code==='UPSTREAM_TIMEOUT'?code:undefined);safe(events);
 }
});
test('failed or skipped persistence and failed archives retain the successful read behavior',async()=>{
 for(const stored of [false,'throw']){
  const events=[],cache=createCompanyReadCache({namespace:'https://central.example',onStage:row=>events.push(row),persistentStore:{async ready(){},get(){return null;},begin(){return {};},async put(){if(stored==='throw')throw Error('private-disk-failure');return false;}},onVerifiedSource:async()=>{throw Error('private-archive-failure');}});
  assert.equal((await request(cache)).status,200);assert.ok(events.some(row=>row.stage===(stored==='throw'?'persistence_failed':'persistence_skipped')));assert.ok(events.some(row=>row.stage==='archive_failed'));assert.ok(events.some(row=>row.stage==='remembered'));safe(events);
 }
});
test('diagnostic exceptions and malformed caller IDs cannot alter reads or expose input strings',async()=>{
 const cache=createCompanyReadCache({onStage(){throw Error('logger failure');}});assert.equal((await request(cache)).status,200);
 const brokenClock=createCompanyReadCache({onStage(){},stageClock(){throw Error('clock failure');}});assert.equal((await request(brokenClock)).status,200);
 const events=[],another=createCompanyReadCache({onStage:row=>events.push(row)});assert.equal((await request(another,{requestId:'private-token'})).status,200);safe(events);
});
