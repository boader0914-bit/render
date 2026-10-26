'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createReportReadCache}=require('../report-read-cache.cjs'),{identity,report,NOW}=require('./fixtures/report-period-fixture.cjs');
const clone=v=>JSON.parse(JSON.stringify(v)),ok=data=>({status:200,ok:true,data}),flush=()=>new Promise(resolve=>setImmediate(resolve));
const allDaily=r=>r.companies[0].reservationPeriods.months.flatMap(m=>m.weeks.flatMap(w=>w.daily));
function source(amount=123000){
 const r=report(),company=r.companies[0];
 for(const m of company.reservationPeriods.months){
  for(const w of m.weeks)for(const d of w.daily){d.missingReason=d.missing?'partial_inventory':null;d.partialConfirmedRevenue=null;d.partialRevenueEvidence=null;}
 }
 const d=allDaily(r).find(d=>d.date==='2026-09-30');
 d.partialConfirmedRevenue=amount;d.partialRevenueEvidence=amount===null?null:{companyId:'own',runId:'synthetic-run',date:d.date,productType:'lodging',collectedAt:'2026-09-29T01:00:00Z',collectedDate:'2026-09-29',reason:'partial_inventory',amount};
 for(const m of company.reservationPeriods.months){
  const sums=records=>{const partial=records.filter(d=>d.missing&&d.partialConfirmedRevenue!==null);return {partialConfirmedRevenue:partial.length?partial.reduce((v,d)=>v+d.partialConfirmedRevenue,0):null,partialConfirmedDays:partial.length};};
  for(const w of m.weeks)Object.assign(w.summary,sums(w.daily));
  Object.assign(m.summary,sums(m.weeks.flatMap(w=>w.daily)));
 }
 return r;
}
async function read(value,options={}){const cache=createReportReadCache({now:()=>NOW,...options});return cache.read({scope:'synthetic',audience:'https://partial.synthetic:customer',ownId:'own',selection:{stayMode:'all_available'},readIdentity:async()=>ok(identity()),readSource:async()=>ok(clone(value))});}

test('scoped partial-source money reaches daily, week and month separately without changing normal counts or money',async()=>{
 const r=source(),before=JSON.stringify(r),reply=await read(r);assert.equal(reply.status,200);const days=allDaily(reply.data),d=days[1],month=reply.data.companies[0].reservationPeriods.months[0];
 assert.equal(d.missing,true);assert.equal(d.quantityStatus,'unknown');assert.equal(d.sold,null);assert.equal(d.estimatedRevenue,null);assert.equal(d.knownRevenueSubtotal,null);assert.equal(d.knownPartialRevenue,null);assert.equal(d.partialConfirmedRevenue,123000);assert.equal(d.missingReason,'partial_inventory');assert.equal(d.partialRevenueEvidence.runId,'synthetic-run');
 assert.equal(month.summary.partialConfirmedRevenue,123000);assert.equal(month.summary.partialConfirmedDays,1);assert.equal(month.weeks[0].summary.partialConfirmedRevenue,123000);assert.equal(month.summary.knownRevenueSubtotal,200);assert.equal(month.summary.estimatedRevenue,null);assert.equal(month.summary.knownSoldSubtotal,2);assert.equal(JSON.stringify(r),before);
});

for(const amount of [0,null])test('partial '+String(amount)+' retains its meaning without manufactured normal zero',async()=>{const reply=await read(source(amount));assert.equal(reply.status,200);const d=allDaily(reply.data)[1],s=reply.data.companies[0].reservationPeriods.months[0].summary;assert.equal(d.partialConfirmedRevenue,amount);assert.equal(s.partialConfirmedRevenue,amount);assert.equal(s.partialConfirmedDays,amount===null?0:1);assert.equal(d.sold,null);assert.equal(d.estimatedRevenue,null);});

for(const[name,mutate]of[
 ['foreign company',r=>allDaily(r)[1].partialRevenueEvidence.companyId='competitor'],
 ['wrong day',r=>allDaily(r)[1].partialRevenueEvidence.date='2026-09-29'],
 ['unsafe run id',r=>allDaily(r)[1].partialRevenueEvidence.runId='/var/data/private'],
 ['wrong amount',r=>allDaily(r)[1].partialRevenueEvidence.amount=999],
 ['post-stay proof',r=>{const p=allDaily(r)[1].partialRevenueEvidence;p.collectedAt='2026-10-01T01:00:00Z';p.collectedDate='2026-10-01';}],
 ['future proof',r=>{const p=allDaily(r)[1].partialRevenueEvidence;p.collectedAt='2026-10-27T01:00:00Z';p.collectedDate='2026-10-27';}],
 ['inconsistent clock',r=>allDaily(r)[1].partialRevenueEvidence.collectedDate='2026-09-28'],
 ['unknown reason',r=>allDaily(r)[1].partialRevenueEvidence.reason='internal_secret'],
 ['conflicting quantity',r=>allDaily(r)[1].quantityStatus='conflict'],
 ['missing proof',r=>allDaily(r)[1].partialRevenueEvidence=null],
 ['proof attached to null',r=>allDaily(r)[1].partialConfirmedRevenue=null],
 ['weekly money tamper',r=>r.companies[0].reservationPeriods.months[0].weeks[0].summary.partialConfirmedRevenue=5],
 ['monthly count tamper',r=>r.companies[0].reservationPeriods.months[0].summary.partialConfirmedDays=3],
 ['normal-overlap partial',r=>{const ds=allDaily(r);ds[0].partialConfirmedRevenue=123000;ds[0].partialRevenueEvidence={...ds[1].partialRevenueEvidence,date:ds[0].date};}],
 ['unsafe missing reason',r=>allDaily(r)[1].missingReason='PRIVATE_REASON']
])test(name+' is rejected without persisting a false normal or partial total',async()=>{const r=source();mutate(r);const reply=await read(r);assert.equal(reply.status,503);assert.equal(reply.data.companies,undefined);});

test('optional new fields keep legacy cached contracts usable and remove private evidence properties',async()=>{assert.equal((await read(report())).status,200);const r=source();allDaily(r)[1].partialRevenueEvidence.privatePath='PRIVATE';allDaily(r)[1].rawProduct='PRIVATE';const reply=await read(r);assert.equal(reply.status,200);assert.doesNotMatch(JSON.stringify(reply),/PRIVATE|privatePath|rawProduct/);});

test('separate money and scoped source proof survive restart, stored preview and background refresh',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'report-partial-evidence-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('report-partial-evidence-'));await fs.rm(directory,{recursive:true,force:true});});
 const options={persistenceDirectory:directory,namespace:'https://central.partial.synthetic',now:()=>NOW},request={scope:'synthetic',audience:'https://partial.synthetic:customer',ownId:'own',selection:{stayMode:'all_available'},readIdentity:async()=>ok(identity())};
 const first=createReportReadCache(options);assert.equal((await first.read({...request,readSource:async()=>ok(source())})).status,200);await first.flushPersistence();
 let resolve;const held=new Promise(done=>resolve=done),restart=createReportReadCache({...options,now:()=>NOW+2000}),saved=await restart.read({...request,readSource:()=>held});assert.equal(saved.data.responseCache.persisted,true);assert.equal(allDaily(saved.data)[1].partialConfirmedRevenue,123000);assert.equal(saved.data.responseCache.refreshing,true);
 resolve(ok(source(456000)));await flush();await restart.flushPersistence();const updated=await restart.read({...request,readSource:async()=>ok(source(456000))});assert.equal(allDaily(updated.data)[1].partialConfirmedRevenue,456000);assert.equal(updated.data.companies[0].reservationPeriods.months[0].summary.knownRevenueSubtotal,200);
});
