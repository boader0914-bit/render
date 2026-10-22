"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monthly-run-rows-"));
  t.after(async () => { assert.ok(root.startsWith(os.tmpdir()+path.sep)); await fs.rm(root,{recursive:true,force:true}); });
  let revision="r1", loads=0, duringLoad=null;
  const companies = ["a","b"].map((id,i)=>({ companyId:id,primaryName:id,placeIds:[id],runIds:["run"],manualCorrection:{lodgingBasisTotal:10+i} }));
  const run={id:"run",keyword:"stored",collectedAt:"2026-09-20T00:00:00Z",collectedAtSource:"manifest",collectionQuality:{status:"complete"},checkIn:"2026-09-20",bookingRangeDays:21};
  const data={rawCompanies:new Map(companies.map(c=>[c.companyId,c])),companies:companies.map(c=>({companyId:c.companyId})),runs:[run]};
  const owner={revision,assertCurrent:async()=>{if(revision!==owner.revision)throw Error("changed");},readCompany:async id=>companies.find(c=>c.companyId===id)};
  data._companySource=owner;
  const options={cacheDirectory:root,cacheVersion:"test-1",loadRun:async(id,opts)=>{loads++;assert.equal(opts.capacityCompanies.length,2);if(duringLoad)duringLoad();return {run:{id},availability:{items:[{placeId:"a"},{placeId:"b"}]}};},
    companyProductAvailabilityMatch:(c,item)=>c.placeIds.includes(item.placeId),
    applyCompanyManualCorrection:(item,c)=>({...item,supply:c.manualCorrection.lodgingBasisTotal,inventoryEvidence:{version:4}}),
    buildHistoryObservations:s=>s.availability.items.flatMap(item=>["2026-09-22","2026-10-02"].map(stayDate=>({...item,stayDate,productType:"lodging",inventoryEvidenceVersion:4,sold:0,missingPrice:true,estimatedRevenue:null})))};
  const request=(id,month="2026-09")=>({type:"company",targetId:id,month,cutoffDate:"2026-10-22"});
  return {root,data,companies,options,request,loads:()=>loads,change:()=>revision="r2",during:fn=>duringLoad=fn};
}
test("one saved run supplies both companies and adjacent months, preserving null and true zero",async t=>{
  const f=await fixture(t), baseline=createMonthlyCompanyRecalculation({...f.options,cacheDirectory:null}), improved=createMonthlyCompanyRecalculation(f.options);
  const expected=[]; for(const id of ["a","b"])for(const month of ["2026-09","2026-10"])expected.push(await baseline(f.request(id,month),f.data));
  const initialLoads=f.loads(), actual=[];for(const id of ["a","b"])for(const month of ["2026-09","2026-10"])actual.push(await improved(f.request(id,month),f.data));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)));
  assert.equal(f.loads()-initialLoads,1);assert.equal(improved.stats().runRowCacheHits,3);
  assert.equal(actual[0][0].sold,0);assert.equal(actual[0][0].estimatedRevenue,null);assert.equal(actual[0][0].missingPrice,true);
  const restarted=createMonthlyCompanyRecalculation(f.options);await restarted(f.request("a"),f.data);assert.equal(f.loads()-initialLoads,1,"saved compact rows survive restart");
});
test("a changing source never certifies rows under the old revision",async t=>{
  const f=await fixture(t), helper=createMonthlyCompanyRecalculation(f.options);f.during(f.change);
  await assert.rejects(helper(f.request("a"),f.data));
  assert.equal((await fs.readdir(f.root)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).length,0);
});
test("unrelated ambiguity stays isolated while target ambiguity still fails closed",async t=>{
  const f=await fixture(t);f.options.companyProductAvailabilityMatch=(c,item)=>c.companyId==="b"||item.placeId===c.companyId;
  const helper=createMonthlyCompanyRecalculation(f.options);
  assert.equal((await helper(f.request("a"),f.data)).length,1);
  await assert.rejects(helper(f.request("b"),f.data),/저장 원문/);assert.equal(f.loads(),1);
});
test("invalid derived content rebuilds; changed source and calculation version cannot reuse old rows",async t=>{
  const f=await fixture(t), helper=createMonthlyCompanyRecalculation(f.options);await helper(f.request("a"),f.data);
  const file=path.join(f.root,(await fs.readdir(f.root)).find(n=>n.endsWith(".json")));await fs.writeFile(file,"{bad");
  await helper(f.request("a"),f.data);assert.equal(f.loads(),2);
  const changed=createMonthlyCompanyRecalculation({...f.options,cacheVersion:"test-2"});await changed(f.request("a"),f.data);assert.equal(f.loads(),3);
  f.change();await assert.rejects(helper(f.request("a"),f.data));assert.equal(f.loads(),3);
});
test("oversized cross-company builds fall back to target-only reads without retaining or repeatedly rebuilding the run",async t=>{
  const f=await fixture(t), baseline=createMonthlyCompanyRecalculation({...f.options,cacheDirectory:null});
  const expected=await baseline(f.request("a"),f.data), before=f.loads();
  const helper=createMonthlyCompanyRecalculation({...f.options,maxCachedRunBytes:128});
  assert.deepEqual(await helper(f.request("a"),f.data),expected);
  assert.equal(helper.stats().runRowOversizeFallbacks,1);
  assert.equal(f.loads()-before,2,"bounded build is released before one target-only retry");
  await helper(f.request("b"),f.data);assert.equal(f.loads()-before,3,"next target bypasses the oversize build");
  assert.equal((await fs.readdir(f.root)).filter(n=>n.endsWith(".json")).length,0);
});
test("a fresh owner after a source or run-quality change rebuilds or excludes instead of reusing old corrected quantities",async t=>{
  const f=await fixture(t), helper=createMonthlyCompanyRecalculation(f.options);
  assert.equal((await helper(f.request("a"),f.data))[0].supply,10);
  f.change();f.data._companySource.revision="r2";f.companies[0].manualCorrection.lodgingBasisTotal=8;
  assert.equal((await helper(f.request("a"),f.data))[0].supply,8);assert.equal(f.loads(),2);
  f.data.runs[0].collectionQuality.status="blocked";
  assert.deepEqual(await helper(f.request("a"),f.data),[]);assert.equal(f.loads(),2);
  f.data.runs[0].collectionQuality.status="complete";
  assert.deepEqual(await helper({...f.request("a"),cutoffDate:"2026-09-19"},f.data),[]);
});
