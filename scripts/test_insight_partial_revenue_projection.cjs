'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMonthlyReportSnapshot}=require('./lib/monthly_reports.cjs');
const {projectIntegrated}=require('./lib/insight_company_integrated.cjs');
const {dailyPeriods,availableRange}=require('./lib/insight_briefing_periods.cjs');
const {projectReservationSeries,summarizeCompany}=require('./lib/insight_comparison.cjs');
const ID='synthetic_partial',clone=v=>JSON.parse(JSON.stringify(v));
function fixture({normal=false}={}){
 const row=(date,overrides={})=>({companyId:ID,companyKey:ID,runId:'run-partial',collectedAt:'2026-09-01T00:00:00Z',stayDate:date,productType:'lodging',inventoryEvidenceVersion:4,supply:16,sold:2,publicBookings:2,phoneBookings:0,publicRevenue:200000,phoneRevenue:0,estimatedRevenue:200000,partial:true,sharedDayUseIncomplete:true,missing:false,unknownUnavailable:0,...overrides});
 const observations=[row('2026-09-03'),row('2026-09-04')];
 if(normal)observations.push(row('2026-09-03',{runId:'run-normal',partial:false,sharedDayUseIncomplete:false}));
 const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:ID,month:'2026-09',cutoffDate:'2026-09-30'},{companies:[{companyId:ID,primaryName:'모의 매장',capacity:16}],runs:['run-partial','run-normal'].map(id=>({id,collectedAt:'2026-09-01T00:00:00Z',collectionQuality:{status:'complete'}})),observations},'2026-10-26T00:00:00Z');
 return {companyId:ID,schemaVersion:1,status:'ready',selectedMonth:'2026-09',calculationVersion:'synthetic-v1',snapshot,latestAttempts:[{date:'2026-09-03',productType:'lodging',reason:'partial_inventory',detailReason:'shared_dayuse_unverified',status:'excluded',collectedAt:'2026-09-01T00:00:00Z'}]};
}
const get=(value,date='2026-09-03')=>projectIntegrated(ID,value).snapshot.daily.find(row=>row.date===date);
const tree=value=>dailyPeriods({companyId:ID,rooms:16,days:projectIntegrated(ID,value).snapshot.daily},{start:'2026-09-03',end:'2026-09-04'},{asOf:'2026-10-26',mode:'historical'});

test('partial-only month preserves linked existing money while quantity and full revenue remain unknown',()=>{
 const source=fixture(),before=JSON.stringify(source),row=get(source);
 assert.equal(source.snapshot.sources.observations.length,0);assert.ok(source.snapshot.sources.runIds.includes('run-partial'));
 assert.equal(row.missing,true);assert.equal(row.sold,null);assert.equal(row.estimatedRevenue,null);assert.equal(row.partialConfirmedRevenue,200000);assert.equal(row.missingReason,'shared_dayuse_unverified');
 assert.deepEqual(row.partialRevenueEvidence,{companyId:ID,runId:'run-partial',date:'2026-09-03',productType:'lodging',collectedAt:'2026-09-01T00:00:00Z',collectedDate:'2026-09-01',reason:'partial_inventory',amount:200000});
 const month=tree(source).months[0],daily=month.weeks[0].daily;
 assert.equal(month.summary.partialConfirmedRevenue,400000);assert.equal(month.summary.partialConfirmedDays,2);assert.equal(month.summary.estimatedRevenue,null);assert.equal(month.summary.knownRevenueSubtotal,null);assert.equal(month.summary.sold,null);assert.equal(month.weeks[0].summary.partialConfirmedRevenue,400000);assert.equal(daily[0].partialConfirmedRevenue,200000);assert.equal(daily[0].knownRevenueSubtotal,null);assert.equal(daily[0].knownPartialRevenue,null);assert.equal(JSON.stringify(source),before);
 source.latestAttempts=[];assert.deepEqual(availableRange([{days:projectIntegrated(ID,source).snapshot.daily}],'2026-10-26'),{start:'2026-09-03',end:'2026-09-04',months:['2026-09']},'a partial-only stored month still has an explicitly observed range');
});

test('normal selected observations suppress partial subtotal even when a stale flag incorrectly says included',()=>{
 const source=fixture({normal:true}),proof=source.snapshot.sources.partialEvidence.find(row=>row.date==='2026-09-03');assert.equal(proof.includedInPartialSubtotal,false);proof.includedInPartialSubtotal=true;
 assert.equal(get(source).partialConfirmedRevenue,null);assert.equal(get(source).sold,2);const month=tree(source).months[0];assert.equal(month.summary.partialConfirmedRevenue,200000);assert.equal(month.summary.partialConfirmedDays,1);assert.equal(month.summary.knownRevenueSubtotal,200000);
});

for(const [name,mutate]of[
 ['foreign company',r=>r.companyId='foreign'],['foreign date',r=>r.date='2026-08-03'],['unlinked run',r=>r.runId='foreign-run'],['excluded flag',r=>r.includedInPartialSubtotal=false],['unverified amount',r=>r.knownPartialRevenue=300000],['negative amount',r=>r.knownPartialRevenue=-1],['future observation',r=>r.collectedAt='2026-10-01T00:00:00Z'],['post-stay observation',r=>r.collectedAt='2026-09-04T00:00:00Z'],['unsafe reason',r=>r.reason='private_error']
])test(name+' cannot introduce partial money',()=>{const source=fixture();mutate(source.snapshot.sources.partialEvidence[0]);assert.equal(get(source).partialConfirmedRevenue,null);assert.equal(get(source).sold,null);});

test('conflicting proof, malformed lists and untrusted fields cannot leak or invent amounts',()=>{
 const source=fixture(),proof=source.snapshot.sources.partialEvidence[0];source.snapshot.sources.partialEvidence.push({...proof,runId:'run-normal'});source.snapshot.sources.runIds.push('run-normal');assert.equal(get(source).partialConfirmedRevenue,null);
 source.snapshot.sources.partialEvidence={privatePath:'secret'};assert.equal(get(source).partialConfirmedRevenue,null);
 const clean=fixture();clean.snapshot.sources.partialEvidence[0].privatePath='PRIVATE';const safe=projectIntegrated(ID,clean);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|privatePath/);
 const row=safe.snapshot.daily.find(row=>row.date==='2026-09-03');row.partialRevenueEvidence.private='PRIVATE';const t=dailyPeriods({companyId:ID,rooms:16,days:[row]},{start:row.date,end:row.date},{asOf:'2026-10-26',mode:'historical'});assert.doesNotMatch(JSON.stringify(t),/PRIVATE/);
});

test('explicit zero is distinct from null and arbitrary knownPartialRevenue has no display proof',()=>{
 const source=fixture();source.snapshot.sources.partialEvidence[0].knownPartialRevenue=0;source.snapshot.daily.find(row=>row.date==='2026-09-03').lodging.knownPartialRevenue=0;
 assert.equal(get(source).partialConfirmedRevenue,0);assert.equal(tree(source).months[0].weeks[0].daily[0].partialConfirmedRevenue,0);
 const company={companyId:ID,rooms:16,days:[{date:'2026-09-03',missing:true,knownPartialRevenue:500000}]},t=dailyPeriods(company,{start:'2026-09-03',end:'2026-09-03'},{asOf:'2026-10-26',mode:'historical'});
 assert.equal(t.months[0].summary.partialConfirmedRevenue,null);assert.equal(t.months[0].summary.partialConfirmedDays,0);assert.equal(t.months[0].weeks[0].daily[0].partialConfirmedRevenue,null);
});

test('daily cutoff, proof identity and conflicting source rows suppress separate money',()=>{
 const row=get(fixture());
 for(const mutate of [r=>r.partialRevenueEvidence.companyId='foreign',r=>r.partialRevenueEvidence.collectedDate='2026-09-02',r=>r.partialRevenueEvidence.amount=3,r=>r.inventoryConflict=true]){
  const changed=clone(row);mutate(changed);const result=dailyPeriods({companyId:ID,rooms:16,days:[changed]},{start:row.date,end:row.date},{asOf:'2026-10-26',mode:'historical'});assert.equal(result.months[0].summary.partialConfirmedRevenue,null);
 }
 const result=dailyPeriods({companyId:ID,rooms:16,days:[row]},{start:row.date,end:row.date},{asOf:'2026-08-31',mode:'historical'});assert.equal(result.months[0].summary.partialConfirmedRevenue,null);
});

test('current 30-day series retains separate proven money and missing reason without normalizing missing quantities to zero',()=>{
 const source=fixture(),company={companyId:ID,rooms:16,days:projectIntegrated(ID,source).snapshot.daily};
 const result=projectReservationSeries(company,{mode:'current',asOf:'2026-09-01',period:{start:'2026-09-01',end:'2026-09-30'}}),row=result.points[2];
 assert.equal(row.missing,true);assert.equal(row.quantityStatus,'unknown');assert.equal(row.sold,null);assert.equal(row.publicBookings,null);assert.equal(row.reservationRate,null);
 assert.equal(row.missingReason,'shared_dayuse_unverified');assert.equal(row.latestAttemptReason,'partial_inventory');assert.equal(row.latestAttemptStatus,'excluded');assert.equal(row.latestAttemptAt,'2026-09-01T00:00:00.000Z');
 assert.equal(row.partialConfirmedRevenue,200000);assert.equal(row.partialRevenueEvidence.companyId,ID);assert.equal(row.partialRevenueEvidence.date,row.date);assert.equal(row.partialRevenueEvidence.runId,'run-partial');
 assert.equal(summarizeCompany(company,{mode:'current',asOf:'2026-09-01',period:result.period}).summary.knownRevenueSubtotal,null);
 assert.equal(row.storedReference,null);assert.equal(result.points[0].partialConfirmedRevenue,null);
});

test('current old normal observations are references only and do not acquire the newer partial money',()=>{
 const source={date:'2026-10-30',total:10,sold:3,publicBookings:2,phoneBookings:1,estimatedRevenue:300000,collectedAt:'2026-10-08T01:00:00Z',collectedDate:'2026-10-08',missing:false,
 latestAttemptAt:'2026-10-28T01:00:00Z',latestAttemptStatus:'excluded',latestAttemptReason:'partial_inventory'};
 const company={companyId:ID,rooms:10,days:[source]},policy={mode:'current',asOf:'2026-10-30',period:{start:'2026-10-30',end:'2026-11-28'}},row=projectReservationSeries(company,policy).points[0];
 assert.equal(row.quantityStatus,'unknown');assert.equal(row.sold,null);assert.equal(row.reservationRate,null);assert.deepEqual(row.codes,['OBSERVATION_STALE']);
 assert.equal(row.storedReference.sold,3);assert.equal(row.storedReference.reservationRate,.3);assert.equal(row.storedReference.collectedDate,'2026-10-08');assert.equal(row.storedReference.reason,'OBSERVATION_STALE');
 assert.equal(row.latestAttemptReason,'partial_inventory');assert.equal(row.partialConfirmedRevenue,null);assert.equal(summarizeCompany(company,policy).summary.days,0);
 source.phoneBookings=2;assert.equal(projectReservationSeries(company,policy).points[0].storedReference,null);
});

test('current series rejects foreign proof, conflicting duplicate amounts and future attempt metadata',()=>{
 const company={companyId:ID,rooms:16,days:[get(fixture())]},policy={mode:'current',asOf:'2026-09-01',period:{start:'2026-09-01',end:'2026-09-30'}};
 const foreign=clone(company);foreign.days[0].partialRevenueEvidence.companyId='foreign';assert.equal(projectReservationSeries(foreign,policy).points[2].partialConfirmedRevenue,null);
 const conflict=clone(company),other=clone(conflict.days[0]);other.partialRevenueEvidence.amount=other.partialConfirmedRevenue=other.knownPartialRevenue=300000;conflict.days.push(other);assert.equal(projectReservationSeries(conflict,policy).points[2].partialConfirmedRevenue,null);
 const historical=dailyPeriods(conflict,{start:'2026-09-03',end:'2026-09-03'},{mode:'historical',asOf:'2026-10-26'});assert.equal(historical.months[0].summary.partialConfirmedRevenue,null);
 const future=clone(company);future.days[0].latestAttemptAt='2026-09-02T00:00:00Z';const row=projectReservationSeries(future,policy).points[2];assert.equal(row.latestAttemptAt,null);assert.equal(row.latestAttemptReason,null);assert.equal(row.partialConfirmedRevenue,200000);
});
