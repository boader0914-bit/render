'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {projectReservationSeries:centralSeries,summarizeCompany}=require('../../scripts/lib/insight_comparison.cjs');
const {projectReservationSeries}=require('../comparison-projection.cjs');
const {createReportReadCache}=require('../report-read-cache.cjs');
const AT=Date.parse('2026-10-25T00:00:00Z'),START='2026-10-25',END='2026-11-23',DAY=86400000;
const clone=v=>JSON.parse(JSON.stringify(v)),ok=data=>({status:200,ok:true,data});
const reportScope={period:{start:START,end:END,days:30}},policy={mode:'current',asOf:START,period:{start:START,end:END}};
function company(){return {companyId:'own_a',name:'Own',rooms:10,regionKey:'r_one',days:Array.from({length:30},(_,i)=>({date:new Date(AT+i*DAY).toISOString().slice(0,10),total:10,sold:i===0?0:2,publicBookings:i===0?0:1,phoneBookings:i===0?0:1,collectedAt:'2026-10-25T00:00:00.000Z',rawError:'PRIVATE-SOURCE'}))};}
function fixture(mutate=()=>{}){
  const c=company();mutate(c);const series=centralSeries(c,policy);
  const account={customer:{customerId:'cust_a',revision:1,accountStatus:'active',relations:[{companyId:c.companyId,kind:'own',status:'active'}],regions:[]},companies:[{companyId:c.companyId,name:c.name,rooms:c.rooms,regionKey:c.regionKey}],regions:[],preparations:[]};
  const report={mode:'current_briefing',published:false,generatedAt:new Date(AT).toISOString(),ownId:c.companyId,period:reportScope.period,
    companies:[{...account.companies[0],kind:'own',relationStatus:'active',summary:{days:30,supply:300,sold:58,reservationRate:58/300,publicBookings:29,phoneBookings:29,estimatedRevenue:null},reservationSeries:series}],comparisons:[],regions:[],actions:[],definitions:[]};
  return {company:c,series,account,report};
}
function reader(data,options={}){
  const cache=createReportReadCache({now:()=>AT,...options});
  return {cache,read:extra=>cache.read({scope:'current-session',audience:'https://insight.example:customer',ownId:'own_a',readIdentity:async()=>ok(clone(data.account)),readSource:async()=>ok(clone(data.report)),...extra})};
}
async function durable(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-series-projection-'));t.after(async()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('insight-series-projection-'));await fs.rm(resolved,{recursive:true,force:true});});return {directory,persistenceDirectory:directory,namespace:'https://central.example'};}
test('central current-thirty-day projection preserves real zero while missing and conflicted counts remain null',()=>{
  const f=fixture(c=>{c.days[1].missing=true;c.days[2].publicBookings=99;c.days[3].total=12;c.days[4].total=null;});
  const series=projectReservationSeries(f.series,f.company,reportScope);assert.ok(series);assert.equal(series.points.length,30);
  assert.equal(series.points[0].quantityStatus,'ready');assert.equal(series.points[0].sold,0);assert.equal(series.points[0].reservationRate,0);
  assert.equal(series.points[1].quantityStatus,'unknown');assert.equal(series.points[1].sold,null);
  assert.equal(series.points[2].quantityStatus,'conflict');assert.equal(series.points[2].sold,null);
  assert.equal(series.points[3].quantityStatus,'ready');assert.equal(series.points[3].sold,2);assert.equal(series.points[3].inventoryConflict,true);assert.equal(series.points[3].reservationRate,null);
  assert.equal(series.points[4].sold,2);assert.equal(series.points[4].total,null);assert.equal(series.points[4].reservationRate,null);assert.deepEqual(series.points[4].codes,['CAPACITY_UNKNOWN']);
});
test('safe daily quantities survive actual report persistence and restart without products, raw failures or credentials',async t=>{
  const config=await durable(t),data=fixture(c=>{c.days[1].missing=true;});
  data.report.companies[0].reservationSeries.token='PRIVATE-SERIES';data.report.companies[0].reservationSeries.points[0].products=[{cookie:'PRIVATE-POINT'}];
  const first=reader(data,config),value=await first.read();assert.equal(value.status,200);assert.equal(value.data.companies[0].reservationSeries.points[0].sold,0);
  assert.equal(value.data.companies[0].reservationSeries.points[1].sold,null);assert.doesNotMatch(JSON.stringify(value),/PRIVATE-|products|token|cookie/);
  await first.cache.flushPersistence();const next=reader(data,config),views=await next.cache.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:data.account});
  assert.equal(views.length,1);assert.deepEqual(views[0].data.companies[0].reservationSeries,value.data.companies[0].reservationSeries);
  const text=(await Promise.all((await fs.readdir(config.directory)).filter(name=>name.endsWith('.json')).map(name=>fs.readFile(path.join(config.directory,name),'utf8')))).join('');assert.doesNotMatch(text,/PRIVATE-|products|token|cookie|rawError/);
});
test('legacy observation dates without an exact time remain useful quantities without fabricating a timestamp',()=>{
  const f=fixture(c=>{delete c.days[1].collectedAt;c.days[1].collectedDate=START;});const result=projectReservationSeries(f.series,f.company,reportScope);
  assert.ok(result);assert.equal(result.points[1].collectedAt,null);assert.equal(result.points[1].collectedDate,START);assert.equal(result.points[1].sold,2);
});
for(const [label,mutate] of [
  ['foreign company',s=>{s.companyId='foreign';}],['wrong cutoff',s=>{s.asOf='2026-10-24';}],['wrong stay period',s=>{s.period.start='2026-10-24';}],['twenty-nine dates',s=>{s.points.pop();}],['duplicate stay date',s=>{s.points[1].date=s.points[0].date;}],
  ['missing day reported as zero',s=>{Object.assign(s.points[1],{quantityStatus:'unknown',codes:['QUANTITY_MISSING'],missing:true,inventoryConflict:false,collectedAt:null,collectedDate:null,reservationRate:null,total:null,sold:0,publicBookings:0,phoneBookings:0});}],
  ['unknown rate reported as zero',s=>{Object.assign(s.points[1],{quantityStatus:'unknown',codes:['QUANTITY_MISSING'],missing:true,inventoryConflict:false,collectedAt:null,collectedDate:null,reservationRate:0,total:null,sold:null,publicBookings:null,phoneBookings:null});}],
  ['quantity sum mismatch',s=>{s.points[1].publicBookings=3;}],['negative quantity',s=>{s.points[1].sold=-1;}],['fractional room',s=>{s.points[1].total=10.5;}],
  ['future ready observation',s=>{s.points[1].collectedAt='2026-10-26T00:00:00.000Z';s.points[1].collectedDate='2026-10-26';}],
  ['stale ready observation',s=>{s.points[1].collectedAt='2026-10-01T00:00:00.000Z';s.points[1].collectedDate='2026-10-01';}],
  ['KST day mismatch',s=>{s.points[1].collectedDate='2026-10-24';}],['unmarked capacity mismatch',s=>{s.points[1].total=12;}],['unconfirmed ratio',s=>{s.points[1].reservationRate=.9;}],
  ['arbitrary diagnostic code',s=>{s.points[1].codes=['PRIVATE_TOKEN'];}],['unknown null series',()=>null]
])test(`daily report projection rejects ${label}`,async()=>{
  const f=fixture(),result=mutate(f.report.companies[0].reservationSeries);if(result===null)f.report.companies[0].reservationSeries=null;
  const read=await reader(f).read();assert.equal(read.status,503);assert.equal(read.data.companies,undefined);
});
test('daily series without a known room denominator retain quantities and explicitly suppress the rate',()=>{
  const f=fixture(c=>{c.rooms=null;});const result=projectReservationSeries(f.series,f.company,reportScope);assert.ok(result);
  assert.equal(result.points[1].sold,2);assert.equal(result.points[1].reservationRate,null);assert.deepEqual(result.points[1].codes,['CAPACITY_UNKNOWN']);
});
test('historical or custom daily series are not relabeled as the currently authorized rolling period',()=>{
  assert.equal(centralSeries(company(),{...policy,mode:'historical'}),null);
  assert.equal(centralSeries(company(),{...policy,period:{start:'2026-10-01',end:'2026-10-30'}}),null);
  const f=fixture();assert.equal(projectReservationSeries(f.series,f.company,{period:{start:'2026-09-01',end:'2026-09-30',days:30}}),null);
});
test('legacy reports with no daily series remain cacheable and do not acquire fabricated graph points',async()=>{
  const f=fixture();delete f.report.companies[0].reservationSeries;const result=await reader(f).read();assert.equal(result.status,200);assert.equal(result.data.companies[0].reservationSeries,undefined);
});
test('series permission isolation survives restart and invalid refresh keeps previous normal daily quantities',async t=>{
  const config=await durable(t),f=fixture(),read=reader(f,config),first=await read.read();await read.cache.flushPersistence();
  const next=reader(f,config),account=clone(f.account);account.customer.relations=[];
  assert.deepEqual(await next.cache.snapshot({scope:'new-session',audience:'https://insight.example:customer',identity:account}),[]);
  const broken=clone(f.report);broken.companies[0].reservationSeries.points[0].sold=99;
  const refresh=await read.read({force:true,readSource:async()=>ok(broken)});assert.equal(refresh.status,503);
  await new Promise(resolve=>setImmediate(resolve));const kept=await read.read();assert.equal(kept.data.responseCache.refreshFailed,true);
  assert.deepEqual(kept.data.companies[0].reservationSeries,first.data.companies[0].reservationSeries);assert.equal(kept.data.responseCache.checkedAt,first.data.responseCache.checkedAt);
});

function evidenceFixture(){
 return fixture(c=>{
  Object.assign(c.days[1],{missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,collectedAt:null,collectedDate:null,knownPartialRevenue:240000,partialConfirmedRevenue:240000,missingReason:'shared_dayuse_unverified',
    latestAttemptAt:'2026-10-25T00:00:00Z',latestAttemptReason:'partial_inventory',latestAttemptStatus:'excluded',
    partialRevenueEvidence:{companyId:c.companyId,runId:'saved_partial_1',date:c.days[1].date,productType:'lodging',collectedAt:'2026-10-25T00:00:00Z',collectedDate:START,reason:'partial_inventory',amount:240000,privatePath:'PRIVATE-PROOF'}});
  Object.assign(c.days[2],{collectedAt:'2026-10-01T00:00:00Z',collectedDate:'2026-10-01',latestAttemptAt:'2026-10-25T00:00:00Z',latestAttemptStatus:'excluded',latestAttemptReason:'partial_inventory'});
 });
}

test('current saved source evidence survives report projection and restart without becoming normal quantities or totals',async t=>{
 const config=await durable(t),f=evidenceFixture();f.report.companies[0].summary=summarizeCompany(f.company,policy).summary;
 const first=reader(f,config),value=await first.read();assert.equal(value.status,200);
 const [zero,partial,old]=value.data.companies[0].reservationSeries.points;
 assert.equal(zero.sold,0);assert.equal(partial.sold,null);assert.equal(partial.reservationRate,null);assert.equal(partial.partialConfirmedRevenue,240000);assert.equal(partial.partialRevenueEvidence.runId,'saved_partial_1');assert.equal(partial.missingReason,'shared_dayuse_unverified');assert.equal(partial.latestAttemptReason,'partial_inventory');
 assert.equal(old.sold,null);assert.equal(old.quantityStatus,'unknown');assert.equal(old.storedReference.sold,2);assert.equal(old.storedReference.collectedDate,'2026-10-01');assert.equal(old.partialConfirmedRevenue,null);assert.equal(value.data.companies[0].summary.days,28);assert.doesNotMatch(JSON.stringify(value),/PRIVATE-/);
 await first.cache.flushPersistence();const next=reader(f,config),views=await next.cache.snapshot({scope:'restored-evidence-session',audience:'https://insight.example:customer',identity:f.account});
 assert.equal(views.length,1);assert.deepEqual(views[0].data.companies[0].reservationSeries,value.data.companies[0].reservationSeries);
});

test('existing durable normal reports remain valid when optional new display evidence is absent',async t=>{
 const config=await durable(t),f=fixture();for(const point of f.report.companies[0].reservationSeries.points)for(const key of ['missingReason','latestAttemptAt','latestAttemptReason','latestAttemptStatus','partialConfirmedRevenue','partialRevenueEvidence','storedReference'])delete point[key];
 const first=reader(f,config),saved=await first.read();assert.equal(saved.status,200);await first.cache.flushPersistence();
 const newer=fixture(),next=reader(newer,config),views=await next.cache.snapshot({scope:'after-release',audience:'https://insight.example:customer',identity:f.account});
 assert.equal(views.length,1);assert.equal(views[0].data.companies[0].reservationSeries.points[0].sold,0);assert.equal(Object.hasOwn(views[0].data.companies[0].reservationSeries.points[0],'partialRevenueEvidence'),false);
 const refreshed=await next.read({force:true});assert.equal(refreshed.status,200);assert.equal(refreshed.data.companies[0].reservationSeries.points[0].partialRevenueEvidence,null);
});

for(const [label,mutate]of[
 ['foreign partial company',s=>s.points[1].partialRevenueEvidence.companyId='foreign'],
 ['foreign partial date',s=>s.points[1].partialRevenueEvidence.date=START],
 ['partial amount mismatch',s=>s.points[1].partialRevenueEvidence.amount=9],
 ['future partial proof',s=>{s.points[1].partialRevenueEvidence.collectedAt='2026-10-27T00:00:00Z';s.points[1].partialRevenueEvidence.collectedDate='2026-10-27';}],
 ['unknown latest reason',s=>s.points[1].latestAttemptReason='PRIVATE-TOKEN'],
 ['future latest attempt',s=>s.points[1].latestAttemptAt='2026-10-27T00:00:00Z'],
 ['undated latest attempt',s=>s.points[1].latestAttemptAt=null],
 ['old reference sum mismatch',s=>s.points[2].storedReference.sold=9],
 ['old reference rate mismatch',s=>s.points[2].storedReference.reservationRate=.9],
 ['old reference period mismatch',s=>s.points[2].storedReference.date=START],
 ['old reference is actually fresh',s=>{s.points[2].storedReference.collectedAt='2026-10-25T00:00:00Z';s.points[2].storedReference.collectedDate=START;}],
 ['old reference on partial data',s=>s.points[1].storedReference=clone(s.points[2].storedReference)]
])test('optional display projection rejects '+label,()=>{const f=evidenceFixture();mutate(f.series);assert.equal(projectReservationSeries(f.series,f.company,reportScope),null);});
