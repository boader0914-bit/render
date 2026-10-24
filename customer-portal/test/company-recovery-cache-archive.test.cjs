'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const {createArchiveService}=require('../archive-service.cjs');
const {projectDailyReview}=require('../archive-provenance.cjs');
const {buildMonthlyReportSnapshot}=require('../../scripts/lib/monthly_reports.cjs');
const {projectIntegrated}=require('../../scripts/lib/insight_company_integrated.cjs');
const COMPANY='cmp_place_123',MONTH='2026-09',AT=Date.parse('2026-10-24T01:00:00Z'),DAY=86400000;
const AUDIENCE='https://insight.example:customer',NAMESPACE='https://central.example';
const ok=data=>({status:200,ok:true,data});
const identity=()=>({customer:{customerId:'cus_fixture',revision:1,accountStatus:'active',relations:[{kind:'own',companyId:COMPANY,status:'active'}]},companies:[{companyId:COMPANY,name:'복구 검수 업체',version:'v1'}],preparations:[]});
function source(version=1){
  const runId='run_saved_'+version,collectedAt='2026-09-01T01:00:00Z';
  const observations=[1,2,4].map(day=>({companyId:COMPANY,stayDate:MONTH+'-'+String(day).padStart(2,'0'),productType:'lodging',runId,keyword:'검수',collectedAt,inventoryEvidenceVersion:4,
    supply:16,sold:day===2?0:2,publicBookings:day===2?0:2,phoneBookings:0,publicRevenue:day===2?0:200000,phoneRevenue:0,estimatedRevenue:day===2?0:200000,phonePricedBookings:0,sharedDayUseExcluded:0,capacityBasis:{count:16,source:'db_review'}}));
  const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:COMPANY,month:MONTH,cutoffDate:'2026-09-30'},
    {companies:[{companyId:COMPANY,primaryName:'검수 업체',capacity:16}],observations,runs:[{id:runId,collectionQuality:{status:'complete'}}]},'2026-10-01T00:00:00Z');
  const integrated=projectIntegrated(COMPANY,{schemaVersion:1,companyId:COMPANY,status:'ready',calculatedAt:`2026-10-01T00:00:${String(version).padStart(2,'0')}Z`,calculationVersion:'company-integrated-v3-saved-product-recovery',selectedMonth:MONTH,months:[{month:MONTH}],roomBasis:{count:16,source:'db_review'},snapshot});
  const proof=row=>({kind:'saved_product_recovery_v1',companyId:row.companyId,runId:row.runId,date:row.date,productType:row.productType,collectedAt:row.collectedAt,
    originalRunQuality:'unknown',receiptId:'a'.repeat(64),sourceDigest:'b'.repeat(64),rowDigest:'c'.repeat(64),token:'must-not-persist',raw:{private:'must-not-persist'}});
  for(const row of integrated.snapshot.provenance.observations){row.runQuality='unknown';row.sourceRecovery=proof(row);}
  for(const row of integrated.snapshot.daily){
    Object.assign(row,{phoneMissingPriceBookings:row.missing?null:0,phoneFallbackBookings:row.missing?null:0,phoneFallbackRevenue:row.missing?null:0});
    if(row.sourceObservation){row.sourceObservation.runQuality='unknown';row.sourceObservation.sourceRecovery=proof(row.sourceObservation);}
    if(row.date==='2026-09-04')Object.assign(row,{sold:5,publicBookings:1,phoneBookings:4,publicRevenue:279000,phoneRevenue:0,estimatedRevenue:279000,revenuePartial:true,phoneMissingPriceBookings:4,phoneFallbackBookings:1,phoneFallbackRevenue:55000});
  }
  Object.assign(integrated.snapshot.summary,{sold:7,publicBookings:3,phoneBookings:4,estimatedRevenue:null,revenuePartial:true,phoneMissingPriceBookings:4,phoneFallbackBookings:1,phoneFallbackRevenue:55000});
  return {result:{companyId:COMPANY,runId,rooms:16},companyDetail:{companyId:COMPANY,basics:{companyId:COMPANY,name:'검수 업체',rooms:16},
    current:{summary:structuredClone(integrated.snapshot.summary),daily:structuredClone(integrated.snapshot.daily)},history:{months:[{month:MONTH,summary:structuredClone(integrated.snapshot.summary),daily:structuredClone(integrated.snapshot.daily)}]},integrated},responseCache:{state:'fresh'}};
}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-recovery-cache-'));let clock=AT;
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-recovery-cache-'));await fs.rm(target,{recursive:true,force:true});});
  const archiveDirectory=path.join(directory,'archives'),cacheDirectory=path.join(directory,'cache');
  const archives=()=>createArchiveService({directory:archiveDirectory,namespace:'fixture-archives',clock:()=>clock});
  let archive=archives();await archive.ready();const captures=[],waiters=[];
  const cache=()=>createCompanyReadCache({persistenceDirectory:cacheDirectory,namespace:NAMESPACE,now:()=>clock,onVerifiedSource:async context=>{captures.push(await archive.capture(context));for(const resolve of waiters.splice(0))resolve();}});
  const read=async(instance,data)=>instance.read({scope:'session',audience:AUDIENCE,companyId:COMPANY,month:MONTH,readIdentity:async()=>ok(identity()),readSource:async()=>ok(data),force:true});
  return {directory,cacheDirectory,archiveDirectory,cache,read,captures,waitCaptures:async count=>{while(captures.length<count)await new Promise(resolve=>waiters.push(resolve));},archive:()=>archive,restartArchive:async()=>{await archive.flush();archive=archives();await archive.ready();},advance:()=>clock+=DAY};
}
function assertEvidence(data){
  const detail=data.companyDetail,snapshot=detail.integrated.snapshot;
  for(const group of [snapshot,detail.current,detail.history.months[0]]){
    assert.equal(group.summary.phoneMissingPriceBookings,4);assert.equal(group.summary.phoneFallbackBookings,1);assert.equal(group.summary.phoneFallbackRevenue,55000);
    const zero=group.daily.find(row=>row.date==='2026-09-02'),gap=group.daily.find(row=>row.date==='2026-09-04'),missing=group.daily.find(row=>row.date==='2026-09-03');
    assert.equal(zero.sold,0);assert.equal(zero.estimatedRevenue,0);assert.equal(zero.phoneMissingPriceBookings,0);
    assert.equal(gap.phoneMissingPriceBookings,4);assert.equal(gap.phoneRevenue,0);assert.equal(gap.revenuePartial,true);assert.equal(gap.phoneFallbackBookings,1);assert.equal(gap.phoneFallbackRevenue,55000);
    assert.equal(missing.sold,null);assert.equal(missing.phoneMissingPriceBookings,null);
    assert.equal(gap.sourceObservation.sourceRecovery.rowDigest,'c'.repeat(64));assert.equal(gap.sourceObservation.runQuality,'unknown');
    assert.deepEqual(Object.keys(gap.sourceObservation.sourceRecovery).sort(),['kind','companyId','runId','date','productType','collectedAt','originalRunQuality','receiptId','sourceDigest','rowDigest'].sort());
  }
  assert.ok(snapshot.provenance.observations.every(row=>row.runQuality==='unknown'&&row.sourceRecovery));
}

test('certified recovery survives fresh read, cache restart, automatic archive and immutable isolated publication',async t=>{
  const f=await fixture(t),input=source(),untouched=structuredClone(input),first=f.cache();
  const fresh=await f.read(first,input);assertEvidence(fresh.data);assert.deepEqual(input,untouched,'safe projection must not mutate the central response');
  await first.flushPersistence();assert.equal(f.captures.length,1);assert.equal(f.captures[0].status,'stored');
  const original=(await f.archive().get({identity:identity(),audience:AUDIENCE,id:f.captures[0].recordId})).record;
  assert.equal(original.payload.review.recoveredDays,3);assert.equal(original.payload.daily.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings,4);
  assert.equal(original.payload.daily.find(row=>row.date==='2026-09-04').review.reason,'REVENUE_NOT_REVIEWABLE');
  assert.equal(original.payload.daily.find(row=>row.date==='2026-09-02').review.status,'reviewed');
  const publishInput={reportType:'monthly',anchorDate:'2026-09-15',requestKey:'fixture_publication_0001'};
  const published=await f.archive().publish({identity:identity(),audience:AUDIENCE,input:publishInput});
  const publishedRecord=(await f.archive().get({identity:identity(),audience:AUDIENCE,id:published.record.id})).record;
  const publishedText=JSON.stringify(publishedRecord),publishedDigest=crypto.createHash('sha256').update(publishedText).digest('hex');
  const report=publishedRecord.payload.companies[0];assert.equal(report.summary.observedDays,3);assert.equal(report.daily.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings,4);
  assert.equal(report.daily.find(row=>row.date==='2026-09-02').estimatedRevenue,0);assert.ok(report.provenance[0].observations.every(row=>row.sourceRecovery));
  await f.restartArchive();const restarted=f.cache();await restarted.ready();
  const restored=await restarted.snapshot({scope:'new-session',audience:AUDIENCE,identity:identity()});assert.equal(restored.length,1);assertEvidence(restored[0].data);
  assert.equal(f.captures.length,1,'disk restoration must not fabricate a newly verified archival event');
  let complete;const pending=new Promise(resolve=>{complete=resolve;});
  const cached=await restarted.read({scope:'new-session',audience:AUDIENCE,companyId:COMPANY,month:MONTH,readIdentity:async()=>ok(identity()),readSource:()=>pending});
  assertEvidence(cached.data);assert.equal(cached.data.responseCache.persisted,true);assert.equal(cached.data.responseCache.refreshing,true);
  f.advance();complete(ok(source(2)));await f.waitCaptures(2);await restarted.flushPersistence();await f.archive().flush();
  assert.equal(f.captures.length,2);assert.equal(f.captures[1].status,'stored');
  assert.equal((await f.archive().list({identity:identity(),audience:AUDIENCE,kind:'daily-review'})).total,2);
  const replay=await f.archive().publish({identity:identity(),audience:AUDIENCE,input:publishInput});
  const replayRecord=(await f.archive().get({identity:identity(),audience:AUDIENCE,id:replay.record.id})).record;
  assert.equal(replay.created,false);assert.equal(crypto.createHash('sha256').update(JSON.stringify(replayRecord)).digest('hex'),publishedDigest,'an earlier private publication must remain byte-for-byte immutable');
  assert.equal((await f.archive().list({identity:identity(),audience:AUDIENCE,kind:'published-report'})).total,1);
  for(const folder of [f.cacheDirectory,f.archiveDirectory])for(const file of await fs.readdir(folder))if(file.endsWith('.json')){
    const text=await fs.readFile(path.join(folder,file),'utf8');assert.equal(text.includes('must-not-persist'),false);assert.equal(text.includes('"token"'),false);assert.equal(text.includes('"raw"'),false);
  }
});

test('cache never promotes incomplete or mismatched saved-product proof to an archived observation',async()=>{
  const cases=[['companyId','cmp_place_other'],['runId','other-run'],['date','2026-09-05'],['productType','day_use'],['collectedAt','2026-09-02T01:00:00Z'],['originalRunQuality','complete'],['receiptId','invalid'],['sourceDigest','invalid'],['rowDigest','invalid']];
  for(const [key,value] of cases){
    let captured;const cache=createCompanyReadCache({now:()=>AT,onVerifiedSource:async context=>{captured=context.data;}}),data=source();
    for(const row of data.companyDetail.integrated.snapshot.provenance.observations)row.sourceRecovery[key]=value;
    for(const row of data.companyDetail.integrated.snapshot.daily)if(row.sourceObservation)row.sourceObservation.sourceRecovery[key]=value;
    const reply=await cache.read({scope:'fixture-'+key,audience:AUDIENCE,companyId:COMPANY,month:MONTH,readIdentity:async()=>ok(identity()),readSource:async()=>ok(data)});
    assert.equal(reply.ok,true);assert.equal(reply.data.companyDetail.integrated.snapshot.daily.find(row=>row.date==='2026-09-04').sold,5,'ordinary display remains available');
    assert.ok(captured.companyDetail.integrated.snapshot.provenance.observations.every(row=>!row.sourceRecovery),key);
    assert.equal(projectDailyReview({companyId:COMPANY,month:MONTH,data:captured,reviewedAt:new Date(AT).toISOString()}),null,key);
  }
  for(const [key,value] of [['date','2026-10-04'],['collectedDate','2026-09-02'],['collectedAt','+275760-09-13T00:00:00.000Z']]){
    const data=source();let captured;
    const rows=[...data.companyDetail.integrated.snapshot.provenance.observations,...data.companyDetail.integrated.snapshot.daily.map(row=>row.sourceObservation).filter(Boolean)];
    for(const row of rows){row[key]=value;if(Object.hasOwn(row.sourceRecovery,key))row.sourceRecovery[key]=value;}
    const cache=createCompanyReadCache({now:()=>AT,onVerifiedSource:async context=>{captured=context.data;}});
    const reply=await cache.read({scope:'invalid-row-'+key,audience:AUDIENCE,companyId:COMPANY,month:MONTH,readIdentity:async()=>ok(identity()),readSource:async()=>ok(data)});
    assert.equal(reply.ok,true);assert.ok(captured.companyDetail.integrated.snapshot.provenance.observations.every(row=>!row.sourceRecovery),key);
    assert.equal(projectDailyReview({companyId:COMPANY,month:MONTH,data:captured,reviewedAt:new Date(AT).toISOString()}),null,key);
  }
  for(const value of ['4',-1,1.5,Infinity,{token:'secret'}]){
    const data=source();data.companyDetail.integrated.snapshot.summary.phoneMissingPriceBookings=value;
    data.companyDetail.integrated.snapshot.daily.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings=value;
    let captured;const cache=createCompanyReadCache({now:()=>AT,onVerifiedSource:async context=>{captured=context.data;}});
    const reply=await cache.read({scope:'invalid-number',audience:AUDIENCE,companyId:COMPANY,month:MONTH,readIdentity:async()=>ok(identity()),readSource:async()=>ok(data)});
    assert.equal(reply.ok,true);assert.ok(captured.companyDetail.integrated.snapshot.summary.phoneMissingPriceBookings==null);
    assert.ok(captured.companyDetail.integrated.snapshot.daily.find(row=>row.date==='2026-09-04').phoneMissingPriceBookings==null);
  }
});
