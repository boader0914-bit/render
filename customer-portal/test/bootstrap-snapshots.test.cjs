'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBootstrapSnapshots,selection}=require('../bootstrap-snapshots.cjs');
const identity={customer:{relations:[{companyId:'own',kind:'own',status:'active'},{companyId:'other',kind:'competitor',status:'pending'},{companyId:'removed',kind:'own',status:'withdrawn'}]}};
const hint=(view,id)=>({'x-insight-bootstrap-view':view,...(id?{'x-insight-bootstrap-company':id}:{})});

test('property bootstrap does not await unrelated region and report storage initialization',async()=>{
  const calls=[],timings=[];
  const snapshots=createBootstrapSnapshots({companyReads:{async snapshot(input){calls.push(['company',input]);return ['saved-company'];}},regionReads:{snapshot(){throw Error('must not wait for region storage');}},reportReads:{snapshot(){throw Error('must not wait for report storage');}}});
  const value=await snapshots({headers:hint('property'),scope:'current-session',audience:'current-origin',identity,timing:{add(...entry){timings.push(entry);}}});
  assert.deepEqual(value,{companyViews:['saved-company'],regionViews:[],reportViews:[]});assert.equal(calls.length,1);assert.deepEqual(calls[0][1].companyIds,['own']);assert.equal(calls[0][1].identity,identity);assert.equal(calls[0][1].scope,'current-session');assert.equal(calls[0][1].audience,'current-origin');assert.equal(timings[0][0],'snapshot_company');
});

test('selected-company hints narrow fresh relationships and never create authorization',()=>{
  assert.deepEqual(selection(hint('company','other'),identity),{company:true,companyIds:['other'],region:false,report:false});
  for(const id of ['removed','unregistered'])assert.deepEqual(selection(hint('company',id),identity).companyIds,[]);
  assert.deepEqual(selection(hint('company','own'),{customer:{relations:[]}}).companyIds,[]);
  for(const headers of [{},hint('unknown'),hint('company','bad/id'),{'x-insight-bootstrap-view':['property']}])assert.deepEqual(selection(headers,identity),{company:true,region:true,report:true});
});

test('other view hints request only matching saved domains and unknown clients preserve all domains',async()=>{
  for(const [view,expected] of [['regions',['region']],['reports',['report']],['settings',[]],['competitors',['company','report']],['home',['company','region','report']],[null,['company','region','report']]]){
    const calls=[],domains=Object.fromEntries(['company','region','report'].map(name=>[name+'Reads',{async snapshot(args){calls.push(name);if(name==='company'&&view==='competitors')assert.deepEqual(args.companyIds,['other']);return [name];}}]));
    const result=await createBootstrapSnapshots(domains)({headers:hint(view),identity});assert.deepEqual(calls,expected);for(const name of ['company','region','report'])assert.deepEqual(result[name+'Views'],expected.includes(name)?[name]:[]);
  }
});
test('home/regions/competitors restore separate summary snapshots without promoting full regional permissions or starting reads',async()=>{
  for(const view of ['home','regions','competitors','property','company','reports','settings']){
    let calls=0;
    const saved={snapshot:async()=>[],read(){throw Error('bootstrap cannot query source');}};
    const snapshots=createBootstrapSnapshots({companyReads:saved,regionReads:saved,reportReads:saved,comparisonRegionReads:{async snapshot(input){calls++;assert.equal(input.identity,identity);assert.equal(input.scope,'session');return [{ownId:'own',month:'2026-09',data:{mode:'comparison_region_summary'}}];},read(){throw Error('bootstrap cannot calculate');}}});
    const result=await snapshots({headers:hint(view,view==='company'?'own':undefined),scope:'session',audience:'origin',identity});
    const expected=['home','regions','competitors'].includes(view);assert.equal(calls,expected?1:0);assert.equal(result.comparisonRegionViews.length,expected?1:0);assert.deepEqual(result.regionViews,[]);
  }
});
test('competitor bootstrap adds only freshly authorized saved report snapshots and never starts a calculation',async()=>{
  const calls=[];
  const snapshots=createBootstrapSnapshots({companyReads:{async snapshot(input){calls.push(['company',input]);return [];}},regionReads:{snapshot(){throw Error('unrelated region read');}},reportReads:{async snapshot(input){calls.push(['report',input]);assert.equal(input.identity,identity);assert.equal(input.scope,'current-session');assert.equal(input.audience,'current-origin');return ['saved-comparison'];},read(){throw Error('bootstrap must not calculate');}}});
  const result=await snapshots({headers:hint('competitors'),scope:'current-session',audience:'current-origin',identity});
  assert.deepEqual(result,{companyViews:[],regionViews:[],reportViews:['saved-comparison']});assert.deepEqual(calls.map(row=>row[0]),['company','report']);
});

test('the comparison summary snapshot has its own fixed timing name and preserves audience and identity',async()=>{
  const stages=[],snapshots=createBootstrapSnapshots({companyReads:{snapshot:async()=>[]},regionReads:{snapshot:async()=>[]},reportReads:{snapshot:async()=>[]},comparisonRegionReads:{snapshot:async input=>{assert.equal(input.identity,identity);assert.equal(input.scope,'current-session');assert.equal(input.audience,'current-origin');return [];},read(){throw Error('snapshot must never start a regional query');}}});
  const result=await snapshots({headers:hint('home'),scope:'current-session',audience:'current-origin',identity,timing:{add(name,duration){stages.push(name);assert.ok(Number.isFinite(duration)&&duration>=0);}}});
  assert.deepEqual(result.comparisonRegionViews,[]);assert.ok(stages.includes('snapshot_comparison_region'));assert.equal(new Set(stages).size,4);assert.ok(stages.every(name=>/^snapshot_(company|region|report|comparison_region)$/.test(name)));
});
