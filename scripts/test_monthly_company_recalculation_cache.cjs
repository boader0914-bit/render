"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { createMonthlyCompanyRecalculation } = require("./lib/monthly_company_recalculation.cjs");
const { compactMonthlyCapacityCompany } = require("./lib/monthly_company_source_catalog.cjs");
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

test("correction projection is explicit and validates its function, company identity and correction eligibility",async t=>{
  const f=await fixture(t);
  assert.throws(()=>createMonthlyCompanyRecalculation({...f.options,projectCorrectionCompany:42}),TypeError);
  for(const projectCorrectionCompany of [()=>null,()=>({companyId:"other",manualCorrection:{lodgingBasisTotal:10}}),c=>({companyId:c.companyId,manualCorrection:null})]){
    const helper=createMonthlyCompanyRecalculation({...f.options,projectCorrectionCompany});
    await assert.rejects(helper(f.request("a"),f.data),error=>error.code==="MONTHLY_RECALCULATION_UNAVAILABLE");
  }
});

test("generic callbacks retain their full-company contract for cold cache builds, broad reads and oversized fallbacks",async t=>{
  const f=await fixture(t);let reads=0;
  for(const c of f.companies)c.futureCallbackField={quantity:40+(c.companyId==="b"?1:0)};
  f.data.rawCompanies=new Map(f.companies.map(c=>[c.companyId,compactMonthlyCapacityCompany(c)]));
  f.data._companySource.readCompany=async id=>{reads++;return f.companies.find(c=>c.companyId===id);};
  f.options.applyCompanyManualCorrection=(item,c)=>({...item,supply:c.futureCallbackField.quantity,inventoryEvidence:{version:4}});
  const helper=createMonthlyCompanyRecalculation(f.options);
  assert.equal((await helper(f.request("a"),f.data))[0].supply,40);assert.equal(reads,2);
  const broad=await helper({...f.request("a"),type:"industry",targetId:"__industry_all__"},f.data);
  assert.deepEqual(broad.map(row=>row.supply),[40,41]);assert.equal(reads,4);
  const fallback=createMonthlyCompanyRecalculation({...f.options,cacheVersion:"oversize-generic",maxCachedRunBytes:128});
  assert.equal((await fallback(f.request("a"),f.data))[0].supply,40);
  assert.equal(fallback.stats().runRowOversizeFallbacks,1);
});

test("explicit compact correction companies avoid full-body reads while industry uses a separate run cache",async t=>{
  const f=await fixture(t), baseline=createMonthlyCompanyRecalculation({...f.options,cacheDirectory:null});
  const request={...f.request("a"),type:"industry",targetId:"__industry_all__"};
  const expected=await baseline(request,f.data);
  f.data.rawCompanies=new Map(f.companies.map(c=>[c.companyId,compactMonthlyCapacityCompany(c)]));
  f.data._companySource.readCompany=()=>assert.fail("explicit compact correction must not load full company inventories");
  const helper=createMonthlyCompanyRecalculation({...f.options,projectCorrectionCompany:compactMonthlyCapacityCompany});
  assert.deepEqual(await helper(request,f.data),expected);
  assert.equal(helper.stats().runRowBuilds,0);assert.equal(helper.stats().companyProjectionsRead,0);
  assert.equal(helper.stats().correctionCompanyProjections,2);assert.deepEqual(await fs.readdir(f.root),["industry_rows"]);
  assert.equal(helper.stats().industryRunRowBuilds,1);assert.equal((await fs.readdir(path.join(f.root,"industry_rows"))).filter(name=>name.endsWith(".json")).length,1);
  const fallback=createMonthlyCompanyRecalculation({...f.options,projectCorrectionCompany:compactMonthlyCapacityCompany,maxCachedRunBytes:128});
  assert.equal((await fallback(f.request("a"),f.data))[0].supply,10);
  assert.equal(fallback.stats().runRowOversizeFallbacks,1);assert.equal(fallback.stats().companyProjectionsRead,0);
});

test("explicit correction projections preserve disabled-review eligibility and skipped run quality",async t=>{
  const f=await fixture(t);f.companies[0].manualCorrection.active=false;
  f.data.rawCompanies=new Map(f.companies.map(c=>[c.companyId,compactMonthlyCapacityCompany(c)]));
  f.data._companySource.readCompany=()=>assert.fail("opted-in projection must not read full company bodies");
  const helper=createMonthlyCompanyRecalculation({...f.options,projectCorrectionCompany:compactMonthlyCapacityCompany});
  const request={...f.request("a"),type:"industry",targetId:"__industry_all__"};
  const rows=await helper(request,f.data);assert.equal(rows.length,1);assert.equal(rows[0].companyId,"b");
  assert.equal(helper.stats().correctionCompanyProjections,1);
  f.data.runs[0].collectionQuality.status="failed";assert.deepEqual(await helper(request,f.data),[]);
  assert.equal(helper.stats().correctionCompanyProjections,1);
});

test("source-read validation is explicit, invocation-bound and never weakens default or direct callers", async t => {
  const f = await fixture(t); let assertions = 0;
  const owner = f.data._companySource, original = owner.assertCurrent;
  owner.assertCurrent = async () => { assertions++; return original(); };
  assert.throws(() => createMonthlyCompanyRecalculation({ ...f.options, useSourceReadValidationBoundary: "true" }), TypeError);
  const generic = createMonthlyCompanyRecalculation(f.options);
  const invalidBoundary = { owner: null, revision: "wrong", isActive: () => false };
  await generic(f.request("a"), f.data, { sourceReadValidationBoundary: invalidBoundary });
  assert.equal(assertions, 2, "default build still freshly validates before and after calculation");
  await generic(f.request("a"), f.data, { sourceReadValidationBoundary: invalidBoundary });
  assert.equal(assertions, 3, "default hit still freshly validates after reading its payload");
  const optedIn = createMonthlyCompanyRecalculation({ ...f.options, useSourceReadValidationBoundary: true });
  await optedIn(f.request("a"), f.data);
  assert.equal(assertions, 4, "an opted-in direct caller without an active source boundary still freshly validates");
  for (const boundary of [invalidBoundary,
    { owner, revision: "wrong", isActive: () => true },
    { owner, revision: owner.revision, isActive: () => false },
    { owner, revision: owner.revision }]) {
    await assert.rejects(optedIn(f.request("a"), f.data, { sourceReadValidationBoundary: boundary }),
      error => error.code === "MONTHLY_RECALCULATION_UNAVAILABLE");
  }
});
