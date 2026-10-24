'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {buildMonthlyReportSnapshot}=require('../../scripts/lib/monthly_reports.cjs');
const {projectIntegrated}=require('../../scripts/lib/insight_company_integrated.cjs');
const {createArchiveService,publicationPeriod}=require('../archive-service.cjs');
const DAY=86400000,OWN='cmp_place_123',COMP='cmp_place_456',AT=Date.parse('2026-10-24T01:00:00Z');
const AUDIENCE=JSON.stringify({host:'insight.sabun.co.kr',type:'customer'}),ADMIN=JSON.stringify({host:'insight.sabun.co.kr',type:'admin-customer-view'});
function identity({owner='cus_test',competitor=true,removeOwn=false}={}){return {customer:{customerId:owner,accountStatus:'active',relations:[...(!removeOwn?[{kind:'own',companyId:OWN,status:'active'}]:[]),...(competitor?[{kind:'competitor',companyId:COMP,status:'active'}]:[])]},companies:[{companyId:OWN,name:'검수 내 매장'},{companyId:COMP,name:'검수 경쟁업체'}]};}
function source({companyId=OWN,month='2026-09',version=1,sold=2,missing=[],priceMissing=[],days=null}={}){
  const count=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).getUTCDate(),selected=days||Array.from({length:count},(_,i)=>i+1);
  const runId=`run_${companyId}_v${version}`,previousId=`run_${companyId}_v${version}_previous`;
  const observations=selected.filter(n=>!missing.includes(n)).map(n=>({companyId,stayDate:month+'-'+String(n).padStart(2,'0'),productType:'lodging',runId,keyword:'경남글램핑',collectedAt:month+'-01T00:00:00Z',inventoryEvidenceVersion:4,
    supply:16,sold:n===3?0:sold,publicBookings:n===3?0:sold,phoneBookings:0,publicRevenue:priceMissing.includes(n)?null:(n===3?0:sold*100000),phoneRevenue:0,estimatedRevenue:priceMissing.includes(n)?null:(n===3?0:sold*100000),phonePricedBookings:0,sharedDayUseExcluded:0,capacityBasis:{count:16,source:'db_review'}}));
  // Keep an earlier cross-keyword observation so publication must use the shared
  // final daily selection once, not add collection snapshots together.
  const old={...observations[0],runId:previousId,keyword:'산청글램핑',collectedAt:month+'-01T00:00:00Z',sold:1,publicBookings:1,publicRevenue:100000,estimatedRevenue:100000};
  // Tie selection is deterministic but not based on submission order; enforce
  // a genuinely later observation for a duplicate date.
  for(const row of observations)row.collectedAt=month+'-01T01:00:00Z';
  const finalSnapshot=buildMonthlyReportSnapshot({type:'company',targetId:companyId,month,cutoffDate:month+'-'+String(count).padStart(2,'0')},
    {companies:[{companyId,primaryName:'검수 업체',capacity:16}],observations:[old,...observations],runs:[previousId,runId].map(id=>({id,keyword:'경남글램핑',collectionQuality:{status:'complete'}}))},'2026-10-01T00:00:00Z');
  const integrated=projectIntegrated(companyId,{schemaVersion:1,companyId,status:'ready',calculatedAt:`2026-10-01T00:00:${String(version).padStart(2,'0')}Z`,calculationVersion:'company-integrated-v'+version,selectedMonth:month,months:[{month}],roomBasis:{count:16,source:'db_review'},snapshot:finalSnapshot});
  return {companyDetail:{companyId,integrated},result:{runId:'unrelated_latest_run'},responseCache:{state:'fresh'}};
}
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-archive-service-'));let clock=AT;
  const options={directory,namespace:'archive-service-fixture',clock:()=>clock},service=createArchiveService(options);await service.ready();
  t.after(async()=>{await service.flush();await fs.rm(directory,{recursive:true,force:true});});
  const capture=(data=source(),extra={})=>service.capture({identity:identity(),audience:AUDIENCE,companyId:OWN,month:'2026-09',data,checkedAt:clock,...extra});
  const publish=(input={},extra={})=>service.publish({identity:identity(),audience:AUDIENCE,input:{reportType:'monthly',anchorDate:'2026-09-15',requestKey:'request_monthly_0001',...input},...extra});
  const read=async result=>(await service.get({identity:identity(),audience:AUDIENCE,id:result.record.id})).record;
  return {directory,service,capture,publish,read,advance:n=>clock+=n,clock:()=>clock,restart:()=>createArchiveService(options)};
}

test('publication period uses complete Monday–Sunday weeks and calendar months',()=>{
  assert.deepEqual(publicationPeriod('weekly','2026-09-30'),{start:'2026-09-28',end:'2026-10-04',days:7});
  assert.deepEqual(publicationPeriod('monthly','2028-02-15'),{start:'2028-02-01',end:'2028-02-29',days:29});
  for(const [kind,date] of [['monthly','2026-02-30'],['daily','2026-09-01']])assert.throws(()=>publicationPeriod(kind,date),error=>error.code==='ARCHIVE_INVALID_PERIOD');
});

test('same KST day capture is idempotent across check times, next day creates a new immutable linked record',async t=>{
  const f=await fixture(t),first=await f.capture();assert.equal(first.created,true);assert.equal(first.status,'stored');
  f.advance(60000);const again=await f.capture();assert.equal(again.created,false);assert.equal(again.recordId,first.recordId);
  const saved=await f.read(first);assert.equal(saved.payload.companyId,OWN);assert.equal(saved.payload.calculationVersion,'company-integrated-v1');
  assert.ok(saved.payload.provenance.runIds.includes('run_'+OWN+'_v1'));assert.ok(!saved.payload.provenance.runIds.includes('unrelated_latest_run'));
  assert.equal(saved.payload.daily.find(row=>row.date==='2026-09-02').sourceObservation.runId,'run_'+OWN+'_v1');
  assert.equal(saved.payload.review.basis,'automatic_validation');assert.doesNotMatch(JSON.stringify(saved.payload),/human_review|reviewedBy|manually_verified/);
  f.advance(DAY);const tomorrow=await f.capture();assert.equal(tomorrow.created,true);assert.notEqual(tomorrow.recordId,first.recordId);
  assert.deepEqual((await f.read(first)).payload,saved.payload,'later capture never rewrites the first review');
  const next=f.restart();await next.ready();assert.equal((await next.list({identity:identity(),audience:AUDIENCE,kind:'daily-review'})).total,2);
  assert.deepEqual((await next.get({identity:identity(),audience:AUDIENCE,id:first.recordId})).record.payload,saved.payload);await next.flush();
});

test('archive retains partial coverage and normal zero separately from absent or unpriced data',async t=>{
  const f=await fixture(t),result=await f.capture(source({missing:[4],priceMissing:[5]})),saved=await f.read(result);
  assert.equal(saved.payload.review.status,'partial');
  const zero=saved.payload.daily.find(row=>row.date==='2026-09-03'),missing=saved.payload.daily.find(row=>row.date==='2026-09-04'),unpriced=saved.payload.daily.find(row=>row.date==='2026-09-05');
  assert.equal(zero.sold,0);assert.equal(zero.estimatedRevenue,0);assert.equal(zero.review.quantityReviewed,true);
  assert.equal(missing.sold,null);assert.equal(missing.estimatedRevenue,null);assert.equal(missing.missing,true);assert.equal(missing.review.quantityReviewed,false);
  assert.equal(unpriced.estimatedRevenue,null);assert.equal(unpriced.review.revenueReviewed,false);
  const pending=source();pending.companyDetail.integrated.status='pending';assert.equal((await f.capture(pending)).status,'needs_review');
  assert.equal((await f.service.list({identity:identity(),audience:AUDIENCE})).total,1);
});

test('weekly and monthly publication use archived days once and explicitly retain missing competitor data',async t=>{
  const f=await fixture(t);await f.capture();
  const weekly=await f.read(await f.publish({reportType:'weekly',anchorDate:'2026-09-08',requestKey:'request_weekly_00001'}));
  assert.equal(weekly.payload.published,true);assert.equal(weekly.payload.period.days,7);
  assert.equal(weekly.payload.companies.find(row=>row.companyId===OWN).summary.sold,14);
  const absent=weekly.payload.companies.find(row=>row.companyId===COMP);assert.equal(absent.summary.sold,null);assert.equal(absent.summary.observedDays,0);assert.ok(absent.daily.every(row=>row.sold===null&&row.missing));
  assert.deepEqual(weekly.payload.quality.missingCompanies,[COMP]);assert.equal(weekly.payload.quality.status,'partial');
  const monthly=await f.read(await f.publish());
  assert.equal(monthly.payload.period.days,30);assert.equal(monthly.payload.companies.find(row=>row.companyId===OWN).summary.sold,58,'30 stay dates less one real zero; older duplicate collection is not added');
  assert.equal(monthly.payload.companies[0].summary.estimatedRevenue,5800000);
  assert.equal(monthly.payload.companies[0].review.basis,'automatic_validation');
  assert.equal(monthly.payload.sourceArchives.length,1);assert.ok(monthly.identity.sourceLinks[0].runIds.includes('run_'+OWN+'_v1'));
});

test('weekly publication spanning months combines stored monthly selections without duplicate days',async t=>{
  const f=await fixture(t);await f.capture();await f.capture(source({month:'2026-10',sold:3}),{month:'2026-10'});
  const published=await f.read(await f.publish({reportType:'weekly',anchorDate:'2026-09-30',requestKey:'request_boundary_0001'}));
  const own=published.payload.companies.find(row=>row.companyId===OWN);assert.equal(own.daily.length,7);assert.equal(new Set(own.daily.map(row=>row.date)).size,7);
  // Sep 28–30: 6 rooms, Oct 1–4: 9 rooms (Oct 3 is a real zero).
  assert.equal(own.summary.sold,15);assert.deepEqual(own.provenance.map(link=>link.month),['2026-10','2026-09']);assert.equal(published.payload.sourceArchives.length,2);
});

test('publication cannot invent report sources and ignores client-supplied payload or links',async t=>{
  const f=await fixture(t);await assert.rejects(f.publish(),error=>error.code==='ARCHIVE_SOURCES_NOT_READY');
  await f.capture();for(const extra of [{payload:{sold:999}},{sourceArchives:[]},{runIds:['invented']}])await assert.rejects(f.publish(extra),error=>error.code==='ARCHIVE_INVALID_FIELDS');
});

test('request replay returns the frozen issued report after source changes; a new request creates a separate version',async t=>{
  const f=await fixture(t);await f.capture();const first=await f.publish(),before=await f.read(first);f.advance(1000);await f.capture(source({version:2,sold:4}));
  const replay=await f.publish();assert.equal(replay.created,false);assert.equal(replay.record.id,first.record.id);assert.deepEqual((await f.read(replay)).payload,before.payload);
  const next=await f.publish({requestKey:'request_monthly_0002'}),after=await f.read(next);assert.notEqual(next.record.id,first.record.id);
  assert.equal(before.payload.companies[0].summary.sold,58);assert.equal(after.payload.companies[0].summary.sold,116);
  assert.equal(after.identity.sourceLinks[0].calculationVersion,'company-integrated-v2');assert.equal((await f.read(first)).checksum,before.checksum);
  await assert.rejects(f.publish({reportType:'weekly'}),error=>error.code==='ARCHIVE_IDEMPOTENCY_CONFLICT'&&error.statusCode===409);
});

test('owner, customer/admin audience, and current relations isolate captured and published archives',async t=>{
  const f=await fixture(t),captured=await f.capture(),published=await f.publish();
  for(const extra of [{identity:identity({owner:'cus_other'})},{audience:ADMIN},{identity:identity({removeOwn:true})}]){
    assert.equal((await f.service.list({identity:identity(),audience:AUDIENCE,...extra})).total,0);
    for(const id of [captured.record.id,published.record.id])await assert.rejects(f.service.get({identity:identity(),audience:AUDIENCE,id,...extra}),error=>error.code==='NOT_FOUND');
  }
  await assert.rejects(f.capture(source({companyId:'cmp_unknown'}),{companyId:'cmp_unknown'}),error=>error.code==='NOT_FOUND');
  const noCompetitor=identity({competitor:false});assert.equal((await f.service.list({identity:noCompetitor,audience:AUDIENCE,kind:'daily-review'})).total,1);
  assert.equal((await f.service.list({identity:noCompetitor,audience:AUDIENCE,kind:'published-report'})).total,0,'a report containing a removed relation is no longer visible');
  await assert.rejects(f.publish({}, {identity:{...identity(),customer:{...identity().customer,accountStatus:'disabled'}}}),error=>error.code==='LOGIN_REQUIRED');
});

test('changed partial source keeps complete prior publication frozen and publishes only known subtotals',async t=>{
  const f=await fixture(t);await f.capture();const old=await f.publish(),before=await f.read(old);f.advance(2000);await f.capture(source({version:2,missing:[2],priceMissing:[5]}));
  const next=await f.read(await f.publish({requestKey:'request_partial_0001'})),own=next.payload.companies[0];
  assert.equal(own.summary.sold,null);assert.equal(own.summary.estimatedRevenue,null);assert.equal(own.summary.observedDays,29);assert.equal(own.summary.knownSold,56);assert.equal(own.summary.revenuePartial,true);
  assert.equal((await f.read(old)).payload.companies[0].summary.sold,before.payload.companies[0].summary.sold);
});

test('concurrent request-key reuse with a different publication intent is rejected',async t=>{
  const f=await fixture(t);await f.capture();
  const results=await Promise.allSettled([f.publish(),f.publish({reportType:'weekly'})]);
  assert.equal(results[0].status,'fulfilled');
  assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'ARCHIVE_IDEMPOTENCY_CONFLICT');
  const reports=await f.service.list({identity:identity(),audience:AUDIENCE,kind:'published-report'});assert.equal(reports.total,1);
});
