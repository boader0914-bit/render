'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createReader,previousMonth}=require('../web/regional-context.js');
const AT=Date.parse('2026-10-25T03:00:00Z');
const binding=(id,kind,region='r1')=>({companyId:id,kind,relationStatus:'active',regionKey:region,analysisRegionKey:region,regionLabel:region,hierarchyApplied:false});
function identity(){return {customer:{customerId:'a',relations:[{companyId:'own',kind:'own',status:'active'},{companyId:'comp',kind:'competitor',status:'active'}],regions:[]},comparisonRegionBindings:[binding('own','own'),binding('comp','competitor')],regions:[]};}
function response({id='own',value=0,at=AT}={}){return {schemaVersion:1,mode:'comparison_region_summary',ownId:id,month:'2026-09',source:'datalab_saved',networkAttempted:false,bindings:[...id?[binding(id,'own')]:[],binding('comp','competitor')],groups:[{region:{id:'r1',label:'가상군'},companyIds:[...id?[id]:[],'comp'],kinds:[...id?['own']:[],'competitor'],relationToOwn:id?'same':'unknown',status:'ready',summary:{sources:[{key:'tourism_visitors',metrics:[{latest:{month:'2026-08',value}}]}],sourceIssues:[]}}],unresolved:[],access:{summaryOnly:true,fullAnalysis:false,preparation:false},responseCache:{state:'fresh',checkedAt:new Date(at).toISOString()}};}
function harness(){let now=AT,expired=0;const reader=createReader({now:()=>now});const configure=(state=identity(),scope='customer:a')=>reader.configure({scope,state,onSessionExpired:()=>expired++});configure();return {reader,configure,advance:ms=>{now+=ms;},expired:()=>expired};}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('regional month follows Korean calendar including year rollover',()=>{assert.equal(previousMonth(Date.parse('2026-12-31T15:00:00Z')),'2026-12');assert.equal(previousMonth(Date.parse('2026-10-24T23:59:00Z')),'2026-09');});
test('normal zero survives cached clone and duplicate reads share one source request',async()=>{
  const h=harness(),d=deferred();let calls=0;const api=url=>{calls++;assert.equal(url,'/regions/comparison-summary?ownId=own&month=2026-09');return d.promise;};
  const a=h.reader.read('own','2026-09',api),b=h.reader.read('own','2026-09',api);d.resolve(response());const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);x.groups[0].summary.sources[0].metrics[0].latest.value=99;assert.equal(y.groups[0].summary.sources[0].metrics[0].latest.value,0);assert.equal(h.reader.peek('own','2026-09').groups[0].summary.sources[0].metrics[0].latest.value,0);
});
test('relationship removal and late replies cannot restore revoked company regions',async()=>{
  const h=harness(),d=deferred(),p=h.reader.read('own','2026-09',()=>d.promise);const state=identity();state.customer.relations=state.customer.relations.filter(r=>r.kind==='own');state.comparisonRegionBindings=state.comparisonRegionBindings.filter(r=>r.kind==='own');h.configure(state);d.resolve(response());await assert.rejects(p,e=>e.status===409);assert.equal(h.reader.peek('own','2026-09'),null);
});
test('account switch rejects old errors without expiring the new session',async()=>{
  const h=harness(),d=deferred(),p=h.reader.read('own','2026-09',()=>d.promise);h.configure(identity(),'customer:b');await h.reader.read('own','2026-09',async()=>response({value:12}));d.reject(Object.assign(Error(),{status:401}));await assert.rejects(p,e=>e.status===409);assert.equal(h.expired(),0);assert.equal(h.reader.peek('own','2026-09').groups[0].summary.sources[0].metrics[0].latest.value,12);
});
test('source failure retains last normal value but permission errors clear it',async()=>{
  const h=harness();await h.reader.read('own','2026-09',async()=>response());await assert.rejects(h.reader.read('own','2026-09',async()=>{throw Object.assign(Error(),{status:503});}));assert.ok(h.reader.peek('own','2026-09'));
  await assert.rejects(h.reader.read('own','2026-09',async()=>{throw Object.assign(Error(),{status:403});}));assert.equal(h.reader.peek('own','2026-09'),null);
});
test('restored snapshot requires exact identity, fixed lifetime and registered binding',()=>{
  const h=harness(),data=response({at:AT-86400000});data.responseCache={state:'cached',checkedAt:new Date(AT-86400000).toISOString(),persisted:true,validUntil:new Date(AT+86400000).toISOString(),revalidationRequired:true};h.reader.restore([{ownId:'own',month:'2026-09',data}],'customer:a');assert.ok(h.reader.peek('own','2026-09'));h.advance(86400001);assert.equal(h.reader.peek('own','2026-09'),null);
  const bad=response();bad.bindings[1].analysisRegionKey='other';h.reader.restore([{ownId:'own',month:'2026-09',data:bad}],'customer:a');assert.equal(h.reader.peek('own','2026-09'),null);
});
test('no own anchor stays null and never picks the first own automatically',async()=>{
  const h=harness(),r=await h.reader.read('','2026-09',async()=>response({id:null}));assert.equal(r.ownId,null);assert.equal(r.bindings.length,1);await assert.rejects(h.reader.read('secret','2026-09',async()=>response()),e=>e.status===403);
});
test('unsafe full-analysis grants and added unrelated groups never enter saved view',async()=>{
  for(const mutate of [r=>{r.networkAttempted=true;},r=>{r.access.preparation=true;},r=>{r.groups.push({...r.groups[0],region:{id:'secret',label:'secret'}});},r=>{r.groups.push(r.groups[0]);},r=>{r.bindings[0].relationStatus='pending';}]){
    const h=harness(),data=response();mutate(data);await assert.rejects(h.reader.read('own','2026-09',async()=>data));assert.equal(h.reader.peek('own','2026-09'),null);
  }
});
test('bootstrap restore cannot undo a same-scope authorization failure',async()=>{const h=harness();await h.reader.read('own','2026-09',async()=>response());await assert.rejects(h.reader.read('own','2026-09',async()=>{throw Object.assign(Error(),{status:403});}));h.reader.restore([{ownId:'own',month:'2026-09',data:response()}],'customer:a');assert.equal(h.reader.peek('own','2026-09'),null);});
