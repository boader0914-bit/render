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
  for(const [view,expected] of [['regions',['region']],['reports',['report']],['settings',[]],['competitors',['company']],['home',['company','region']],[null,['company','region','report']]]){
    const calls=[],domains=Object.fromEntries(['company','region','report'].map(name=>[name+'Reads',{async snapshot(args){calls.push(name);if(name==='company'&&view==='competitors')assert.deepEqual(args.companyIds,['other']);return [name];}}]));
    const result=await createBootstrapSnapshots(domains)({headers:hint(view),identity});assert.deepEqual(calls,expected);for(const name of ['company','region','report'])assert.deepEqual(result[name+'Views'],expected.includes(name)?[name]:[]);
  }
});
