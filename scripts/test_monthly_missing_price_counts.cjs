"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const {buildMonthlyReportSnapshot}=require("./lib/monthly_reports.cjs");
const {projectIntegrated}=require("./lib/insight_company_integrated.cjs");
const MONTH="2026-09",AT="2026-10-24T00:00:00Z",A="cmp_price_a",B="cmp_price_b";
const companies=[A,B].map(companyId=>({companyId,primaryName:companyId,regionKey:"region_test",capacity:10}));
const request={type:"region",targetId:"region_test",month:MONTH,cutoffDate:"2026-09-30"};
const row=(date,overrides={})=>({companyId:A,companyKey:A,runId:"saved_normal",collectedAt:"2026-08-28T00:00:00Z",stayDate:date,
  productType:"lodging",inventoryEvidenceVersion:5,supply:10,sold:1,publicBookings:1,phoneBookings:0,publicRevenue:100000,phoneRevenue:0,
  estimatedRevenue:100000,phoneMissingPriceBookings:0,sharedDayUseExcluded:0,partial:false,missing:false,...overrides});
const unpriced=(date,count=2,overrides={})=>row(date,{sold:count,publicBookings:0,phoneBookings:count,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,phoneMissingPriceBookings:count,...overrides});
const inputs=observations=>({companies,runs:[{id:"saved_normal",collectedAt:"2026-08-28T00:00:00Z",collectionQuality:{status:"complete"}},
  {id:"blocked",collectedAt:"2026-08-28T00:00:00Z",collectionQuality:{status:"blocked"}}],observations});
const snapshot=(observations,overrides={})=>buildMonthlyReportSnapshot({...request,...overrides},inputs(observations),AT);
const withoutMissingCounter=value=>Array.isArray(value)?value.map(withoutMissingCounter):value&&typeof value==="object"
  ?Object.fromEntries(Object.entries(value).filter(([key])=>key!=="phoneMissingPriceBookings").map(([key,item])=>[key,withoutMissingCounter(item)])):value;
function oldBuilder(){
  const file=require.resolve("./lib/monthly_reports.cjs"),current=fs.readFileSync(file,"utf8");
  const original=current.replace('"explicitBlockedBookings", "phoneMissingPriceBookings"]','"explicitBlockedBookings"]')
    .replace('"phoneFallbackRevenue", "phoneFallbackBookings",\n','"phoneFallbackRevenue", "phoneFallbackBookings", "phoneMissingPriceBookings",\n')
    .replace('"phoneFallbackRevenue", "phoneFallbackBookings",\r\n','"phoneFallbackRevenue", "phoneFallbackBookings", "phoneMissingPriceBookings",\r\n');
  assert.notEqual(original,current,"the control changes only the diagnostic metric's aggregation cohort");
  const control=new Module(file,module);control.filename=file;control.paths=Module._nodeModulePaths(path.dirname(file));control._compile(original,file);
  return control.exports.buildMonthlyReportSnapshot;
}

test("a fully unpriced two-room observation remains in the diagnostic total beside one normally priced room",()=>{
  const data=[row("2026-09-01"),unpriced("2026-09-02")],current=snapshot(data,{type:"company",targetId:A});
  assert.equal(current.summary.lodging.sold,3);assert.equal(current.summary.lodging.phoneBookings,2);assert.equal(current.summary.lodging.phoneMissingPriceBookings,2);
  const missing=current.daily.find(value=>value.date==="2026-09-02").lodging;
  assert.equal(missing.coveredCompanyDays,1);assert.equal(missing.phoneMissingPriceBookings,2);assert.equal(missing.estimatedRevenue,null);
  assert.equal(current.summary.lodging.estimatedRevenue,100000);assert.equal(current.summary.lodging.revenueCoveredCompanyDays,1);
  const previous=oldBuilder()({...request,type:"company",targetId:A},inputs(data),AT);
  assert.equal(previous.summary.lodging.phoneMissingPriceBookings,0,"the prior implementation dropped the fully unpriced room count");
  assert.deepEqual(withoutMissingCounter(current),withoutMissingCounter(previous),"reservations, monetary cohorts, subtotals, coverage, source selection and every other calculation are unchanged");
  const customer=projectIntegrated(A,{schemaVersion:1,companyId:A,status:"ready",selectedMonth:MONTH,calculatedAt:AT,calculationVersion:"fixture",roomBasis:{count:10},snapshot:current},MONTH);
  assert.equal(customer.snapshot.summary.phoneMissingPriceBookings,2);assert.equal(customer.snapshot.daily[1].phoneMissingPriceBookings,2);
});

test("only selected valid room quantities contribute; missing, blocked, conflicting and partial responses stay excluded",()=>{
  const data=[row("2026-09-01"),unpriced("2026-09-02"),
    unpriced("2026-09-03",9,{supply:null,sold:null,publicBookings:null,phoneBookings:null,phoneMissingPriceBookings:999}),
    unpriced("2026-09-04",8,{status:"blocked",phoneMissingPriceBookings:888}),
    unpriced("2026-09-05",7,{runId:"blocked",phoneMissingPriceBookings:777}),
    unpriced("2026-09-06",6,{sold:1,phoneMissingPriceBookings:666}),
    row("2026-09-07",{partial:true,phoneMissingPriceBookings:555}),
    unpriced("2026-09-08",4),row("2026-09-08",{collectedAt:"2026-08-29T00:00:00Z"})];
  const current=snapshot(data,{type:"company",targetId:A});assert.equal(current.summary.lodging.phoneMissingPriceBookings,2);assert.equal(current.summary.lodging.sold,4);
  assert.equal(current.daily.find(value=>value.date==="2026-09-08").lodging.phoneMissingPriceBookings,0,"superseded snapshots do not repeat their diagnostic count");
  for(const date of ["2026-09-03","2026-09-04","2026-09-05","2026-09-06","2026-09-07"]){const day=current.daily.find(value=>value.date===date).lodging;assert.equal(day.coveredCompanyDays,0,date);assert.equal(day.phoneMissingPriceBookings,null,date);}
  assert.equal(current.quality.discardedByReason.missing_quantity,1);assert.equal(current.quality.discardedByReason.missing_response,1);
  assert.equal(current.quality.discardedByReason.run_blocked,1);assert.equal(current.quality.discardedByReason.quantity_conflict,1);assert.equal(current.quality.discardedByReason.partial_inventory,1);
  assert.deepEqual(withoutMissingCounter(current),withoutMissingCounter(oldBuilder()({...request,type:"company",targetId:A},inputs(data),AT)));
});

test("company, daily, calendar-week and monthly totals agree for both lodging and day-use",()=>{
  const data=[];
  for(const [index,date]of ["2026-09-01","2026-09-07","2026-09-14","2026-09-21","2026-09-28"].entries()){
    data.push(unpriced(date,index+1),unpriced(date,1,{companyId:B,companyKey:B}),row(date,{productType:"dayuse",dayUsePresence:"present",dayUseScheduleStatus:"requested"}),
      unpriced(date,2,{companyId:B,companyKey:B,productType:"dayuse",dayUsePresence:"present",dayUseScheduleStatus:"requested"}));
  }
  const current=snapshot(data),selected=current.sources.observations;
  for(const product of ["lodging","dayuse"]){
    const expected=selected.filter(value=>value.productType===product).reduce((sum,value)=>sum+value.phoneMissingPriceBookings,0);
    assert.equal(current.summary[product].phoneMissingPriceBookings,expected);
    assert.equal(current.companies.reduce((sum,company)=>sum+company.summary[product].phoneMissingPriceBookings,0),expected);
    assert.equal(current.daily.reduce((sum,day)=>sum+(day[product].phoneMissingPriceBookings??0),0),expected);
    const weekly=new Map();for(const day of current.daily){const time=new Date(day.date+"T00:00:00Z"),key=new Date(time.getTime()-((time.getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);if(!weekly.has(key))weekly.set(key,[]);weekly.get(key).push(day);}
    for(const days of weekly.values()){
      const dates=new Set(days.map(day=>day.date)),sourceCount=selected.filter(value=>value.productType===product&&dates.has(value.date)).reduce((sum,value)=>sum+value.phoneMissingPriceBookings,0);
      assert.equal(days.reduce((sum,day)=>sum+(day[product].phoneMissingPriceBookings??0),0),sourceCount);
    }
    assert.equal([...weekly.values()].reduce((sum,days)=>sum+days.reduce((s,day)=>s+(day[product].phoneMissingPriceBookings??0),0),0),expected);
    for(const company of current.companies)assert.equal(company.summary[product].phoneMissingPriceBookings,company.daily.reduce((sum,day)=>sum+(day[product].phoneMissingPriceBookings??0),0));
  }
  assert.equal(current.summary.lodging.phoneMissingPriceBookings,20);assert.equal(current.summary.dayuse.phoneMissingPriceBookings,10);
  assert.deepEqual(withoutMissingCounter(current),withoutMissingCounter(oldBuilder()(request,inputs(data),AT)));
});

test("genuine observed zeros stay zero while an unobserved company's diagnostic count remains unknown",()=>{
  const current=snapshot([row("2026-09-01",{sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0})]);
  const observed=current.companies.find(company=>company.companyId===A),missing=current.companies.find(company=>company.companyId===B);
  assert.equal(observed.summary.lodging.phoneMissingPriceBookings,0);assert.equal(observed.daily[0].lodging.phoneMissingPriceBookings,0);assert.equal(observed.summary.lodging.estimatedRevenue,0);
  assert.equal(missing.summary.lodging.phoneMissingPriceBookings,null);assert.equal(missing.summary.lodging.estimatedRevenue,null);assert.equal(missing.summary.lodging.sold,null);
});
