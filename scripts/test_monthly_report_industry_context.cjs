"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {createMonthlyReportIndustryContext,MAX_ENTRIES}=require("./lib/monthly_report_industry_context.cjs");
const {createMonthlyReportService}=require("./lib/monthly_reports.cjs");
const NOW="2026-10-17T00:00:00.000Z",REGION="kr_gyeongnam_sancheong";
const request={type:"company",targetId:"company-a",month:"2026-09",cutoffDate:"2026-09-30"};
const region={id:REGION,label:"경상남도 산청군",level:"local"};
const roster={companies:[{companyId:"company-a",industryIds:["glamping"],industryRegionKey:REGION}],regions:[region]};
function saved(condition,overrides={}){return {request:{...condition},cohort:{minRank:1,maxRank:20},
  summary:{companyCount:2,observedCompanies:2,coveredCompanyDays:2,expectedCompanyDays:60,missingCompanyDays:58,coverageRate:2/60,reservationRate:0.25,
    publicBookings:0,phoneBookings:2,sold:2,supply:16,estimatedRevenue:300000,publicRevenue:0,phoneRevenue:300000,availability:"partial",metricBasis:"equal_company_within_date_then_equal_observed_dates"},
  companies:[{capacity:16,capacityBasis:{source:"manual"}},{capacity:10,capacityBasis:{source:"observed_locked"}}],
  definitions:{reservationRate:"업체 동일 비중 평균"},quality:{warnings:["표본 자료"]},
  storage:{hasSnapshot:true,status:"ready",key:"key-one",resultVersion:"result-one",calculationVersion:"industry-analysis-v1",sourceRevision:"v1",resultRevision:"v1",calculatedAt:"2026-10-16T02:00:00Z"},...overrides};}
function reader(callback){const calls=[];const read=createMonthlyReportIndustryContext({now:()=>NOW,industryService:{readSaved:async condition=>{calls.push(condition);return callback?callback(condition):saved(condition);},
  analyze(){assert.fail("report must not calculate");},rebuild(){assert.fail("report must not enqueue");}}});return {read,calls};}
test("company uses saved industry and actual location, preserving exact industry values and references",async()=>{
  const f=reader(),value=await f.read(request,roster);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{industry:"glamping",region:REGION,month:"2026-09",cutoffDate:"2026-09-30"});
  const entry=value.entries[0];assert.equal(value.networkAttempted,false);assert.equal(entry.summary.reservationRate,.25);assert.equal(entry.summary.publicBookings,0);assert.equal(entry.summary.phoneRevenue,300000);
  assert.equal(entry.storage.resultVersion,"result-one");assert.equal(entry.capacityBasis.reviewedCompanyCount,1);assert.match(value.warnings.join(" "),/同|같은 비중/);
});
test("keyword connects deduplicated industry-region pairs, composite facilities enter both groups and unmapped locations remain missing",async()=>{
  const f=reader(),value=await f.read({...request,type:"keyword",targetId:"서울근교글램핑"},{...roster,companies:[
    ...roster.companies,{...roster.companies[0]},{companyId:"b",industryRegionKey:REGION,industryIds:["glamping","poolVilla"]},
    {companyId:"unknown",industryIds:["glamping"],regionKey:REGION}]});
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(r=>r.industry).sort(),["glamping","poolVilla"]);assert.equal(value.selectionCoverage.unmappedCompanyCount,1);assert.equal(value.status,"partial");
  assert.doesNotMatch(JSON.stringify(f.calls),/서울근교/);
});
test("explicit regional handoff selects its industry even for an empty report roster",async()=>{
  const f=reader(),value=await f.read({...request,type:"region",targetId:REGION,industry:"glamping"},{regions:[region],companies:[]});
  assert.equal(value.entries.length,1);assert.equal(f.calls[0].industry,"glamping");
});
test("closed-month effective cutoff is transparent and never borrows a later cutoff result",async()=>{
  const f=reader(),value=await f.read({...request,cutoffDate:"2026-10-16"},roster);assert.equal(f.calls[0].cutoffDate,"2026-09-30");assert.equal(value.reportCutoffDate,"2026-10-16");assert.match(value.warnings.join(" "),/月|月末|月|마감월/);
});
for(const status of ["queued","processing","failed","stale"]){test(`${status} keeps last valid snapshot with explicit status`,async()=>{
  const f=reader(c=>{const v=saved(c);v.storage.status=status;v.storage.stale=true;return v;});const value=await f.read(request,roster);
  assert.equal(value.entries[0].status,status);assert.equal(value.entries[0].summary.phoneBookings,2);assert.ok(value.entries[0].reasonLabel);assert.equal(value.status,"partial");
});}
test("missing, damaged and future results cannot supply numeric summaries",async()=>{
  for(const mutate of [()=>({storage:{hasSnapshot:false,status:"pending"}}),c=>saved({...c,cutoffDate:"2026-09-29"}),c=>saved(c,{cohort:{minRank:1,maxRank:21}}),
    c=>{const v=saved(c);v.storage.resultVersion=null;return v;},c=>{const v=saved(c);v.storage.calculatedAt="2026-10-18T00:00:00Z";return v;}]){
    const result=await reader(mutate).read(request,roster);assert.equal(result.entries[0].summary,null);
  }
});
test("normal observed zero stays zero; errors and unconfigured readers stay unavailable",async()=>{
  const zero=await reader(c=>{const v=saved(c);v.summary.publicBookings=0;v.summary.phoneBookings=0;v.summary.estimatedRevenue=0;return v;}).read(request,roster);
  assert.equal(zero.entries[0].summary.estimatedRevenue,0);
  const failed=await reader(()=>{throw new Error("private detail");}).read(request,roster);assert.equal(failed.entries[0].status,"unavailable");assert.equal(failed.entries[0].summary,null);assert.doesNotMatch(JSON.stringify(failed),/private detail/);
  const none=await createMonthlyReportIndustryContext({now:()=>NOW})(request,roster);assert.equal(none.entries[0].reasonCode,"INDUSTRY_SERVICE_UNAVAILABLE");
});

test("damaged saved summary is unavailable and capacity review categories do not overlap",async()=>{
  for(const summary of [{},{companyCount:-1},{...saved({}).summary,coveredCompanyDays:61},
    {...saved({}).summary,reservationRate:1.2},{...saved({}).summary,missingCompanyDays:59}]){
    const value=await reader(c=>saved(c,{summary})).read(request,roster);
    assert.equal(value.entries[0].status,"unavailable");assert.equal(value.entries[0].summary,null);
  }
  const value=await reader(c=>saved(c,{companies:[{capacity:null,capacityBasis:{source:"manual"}},{capacity:16,capacityBasis:{source:"manual"}}]})).read(request,roster);
  assert.deepEqual(value.entries[0].capacityBasis,{policy:"관리자 검수값 우선, 없으면 고정 최대 관측값",companyCount:2,reviewedCompanyCount:1,unreviewedCompanyCount:0,missingCapacityCompanyCount:1});
});

test("damaged stored files keep their actual reason rather than being described as absent",async()=>{
  for(const [code,reason] of [["INDUSTRY_RESULT_INVALID","INDUSTRY_AGGREGATE_INVALID"],["EACCES","INDUSTRY_AGGREGATE_READ_FAILED"]]){
    const value=await reader(()=>({storage:{hasSnapshot:false,status:"unavailable",errorCode:code}})).read(request,roster);
    assert.equal(value.entries[0].reasonCode,reason);assert.equal(value.entries[0].storage.errorCode,code);assert.equal(value.entries[0].summary,null);
  }
});
test("report rejects external work and projections remain bounded with omitted counts",async()=>{
  await assert.rejects(reader(c=>({...saved(c),networkAttempted:true})).read(request,roster),e=>e.code==="MONTHLY_INDUSTRY_MUST_BE_SAVED_ONLY");
  const many={regions:Array.from({length:MAX_ENTRIES+1},(_,i)=>({id:`r${i}`,label:`지역${i}`,level:"local"})),companies:Array.from({length:MAX_ENTRIES+1},(_,i)=>({companyId:`c${i}`,industryRegionKey:`r${i}`,industryIds:["glamping"]}))};
  const result=await reader().read({...request,type:"keyword"},many);assert.equal(result.entries.length,MAX_ENTRIES);assert.equal(result.selectionCoverage.omittedEntryCount,1);assert.equal(result.status,"partial");
});
test("approved preview freezes industry references through publish, while an explicit revision can attach newer results",async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"monthly-industry-link-"));t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith("monthly-industry-link-"));await fs.rm(directory,{recursive:true,force:true});});
  const sources={companies:[{companyId:"company-a",primaryName:"[모의] 월명 글램핑",regionKey:REGION,regionKeys:[REGION],industryRegionKey:REGION,industryIds:["glamping"],capacity:16}],regions:[region],observations:[],runs:[]};
  let version="one",sourceReads=0,referenceReads=0;
  const read=createMonthlyReportIndustryContext({now:()=>NOW,industryService:{readSaved:async c=>{referenceReads++;const v=saved(c);v.storage.resultVersion=version;return v;}}});
  const service=createMonthlyReportService({dataDir:directory,now:()=>new Date(NOW),loadSources:async()=>{sourceReads++;return sources;},readSourceRevision:async()=>"stable",readIndustryContext:read});
  const preview=await service.preview(request);assert.equal(preview.industryBenchmarks.entries[0].storage.resultVersion,"one");assert.equal(sourceReads,2);
  version="two";const draft=await service.create({...request,previewToken:preview.previewToken});const review=await service.update(draft.id,{revision:draft.revision,status:"review"});
  const issued=await service.publish(draft.id,{revision:review.revision,acknowledgeQuality:true});assert.equal(issued.snapshot.industryBenchmarks.entries[0].storage.resultVersion,"one");assert.equal(referenceReads,1);
  const subsequent=await service.preview(request);assert.equal(sourceReads,2,"saved lodging aggregates are reused while industry references refresh");assert.equal(subsequent.industryBenchmarks.entries[0].storage.resultVersion,"two");
  assert.equal((await service.get(issued.id)).snapshot.industryBenchmarks.entries[0].storage.resultVersion,"one");
  const updated=await service.revise(issued.id,{revision:issued.revision});await service.rebuild(updated.id,{revision:updated.revision});assert.equal((await service.get(issued.id)).snapshot.industryBenchmarks.entries[0].storage.resultVersion,"one");
});
