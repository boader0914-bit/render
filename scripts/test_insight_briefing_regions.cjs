'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createInsightAnalysis,regionIds}=require('./lib/insight_analysis.cjs');

// All sources are deterministic in-memory fixtures. No provider, production
// database, saved report or published edition is opened by these checks.
const clone=value=>JSON.parse(JSON.stringify(value));
const NOW=Date.parse('2026-10-26T01:00:00Z');
const data=()=>({companies:[
  {companyId:'own',name:'내 매장',regionKey:'home',rooms:16},
  {companyId:'other-own',name:'선택하지 않은 내 매장',regionKey:'other',rooms:10},
  {companyId:'competitor',name:'타지역 경쟁업체',regionKey:'competition',rooms:12}
],regions:[
  {id:'home',label:'내 매장 공식 지역',level:'local'},
  {id:'other',label:'다른 내 매장 지역',level:'local'},
  {id:'competition',label:'경쟁업체 지역',level:'local'},
  {id:'interest',label:'등록 관심지역',level:'local'},
  {id:'province',label:'시도',level:'broad'}
],regionHierarchy:{}});
const customer=()=>({customerId:'test-member',accountStatus:'active',revision:1,
  relations:[{companyId:'own',kind:'own',status:'pending'},
    {companyId:'other-own',kind:'own',status:'active'},
    {companyId:'competitor',kind:'competitor',status:'active'}],
  regions:[],entitlements:{interestRegionLimit:1,competitorLimit:3}});
const savedRegion=()=>({networkAttempted:false,sources:[{key:'visitors',label:'저장 방문 지표',provider:'공개 통계',status:'ready',period:'2026-09',rows:[{key:'count',label:'방문자',unit:'명',status:'observed',value:123}]}]});
const savedCompany=month=>({integrated:{status:'ready',snapshot:{}},legacyObservationView:false,current:{daily:[{
  date:month==='2026-10'?'2026-10-26':'2026-11-01',total:16,sold:2,publicBookings:1,phoneBookings:1,
  estimatedRevenue:200000,collectedAt:'2026-10-26T01:00:00Z'
}]}});
function service(catalog=data(),read=async()=>savedRegion()) {
  const reads=[],preparations=[],companyReads=[],savedCompanyReads=[];
  const analysis=createInsightAnalysis({catalog:async()=>clone(catalog),now:()=>NOW,
    collectionResults:{companyDetail:async(id,{month})=>{companyReads.push({id,month});return savedCompany(month);}},
    savedCollectionResults:{companyDetail:async(id,{month})=>{savedCompanyReads.push({id,month});return savedCompany(month);}},
    readRegionContext:async input=>{reads.push(clone(input));return read(input);},
    regionPreparation:{get:async input=>{preparations.push({method:'get',input});return null;},start:async input=>{preparations.push({method:'start',input});return null;}}
  });
  return {analysis,reads,preparations,companyReads,savedCompanyReads,catalog};
}

test('pending selected own store has the same stored region in its analysis and briefing without approving ownership',async()=>{
  const c=customer(),before=clone(c),s=service();
  const region=await s.analysis.region(c,'home','2026-09');
  const report=await s.analysis.briefing(c,'own');
  assert.equal(region.refreshAvailable,false);
  assert.deepEqual(report.regions.map(row=>row.region.id),['home']);
  assert.equal(report.regions[0].sources[0].rows[0].value,123);
  assert.equal(report.companies.find(row=>row.companyId==='own').analysisRegionKey,'home');
  assert.ok(report.actions.some(row=>row.key==='region'));
  assert.ok(!report.actions.some(row=>row.key==='region_data'));
  assert.ok(report.actions.some(row=>row.key==='verify'),'ownership review remains visible');
  assert.equal(s.preparations.length,0);assert.deepEqual(c,before);
});

test('a report resolves an official parent from the catalog hierarchy and uses that key for its regional action',async()=>{
  const d=data();d.companies[0].regionKey='district';d.regionHierarchy.district='home';
  const c=customer(),s=service(d),report=await s.analysis.briefing(c,'own');
  assert.deepEqual(s.reads,[{type:'region',targetId:'home',month:'2026-09'}]);
  const own=report.companies.find(row=>row.companyId==='own');
  assert.equal(own.regionKey,'district','original company geography remains available');
  assert.equal(own.analysisRegionKey,'home');
  assert.equal(report.regions[0].region.id,'home');
  assert.ok(report.actions.some(row=>row.key==='region'));
  assert.ok(!report.actions.some(row=>row.key==='region_data'));
});

test('newly catalogued localities resolve generically without a hardcoded address or company-name guess',async()=>{
  const d=data();d.regions.push({id:'future-official-city',label:'새 공식 시군구',level:'local'});
  d.companies[0].regionKey='new-town';d.regionHierarchy['new-town']='future-official-city';
  const s=service(d),report=await s.analysis.briefing(customer(),'own');
  assert.deepEqual(s.reads.map(row=>row.targetId),['future-official-city']);
  assert.equal(report.companies.find(row=>row.companyId==='own').analysisRegionKey,'future-official-city');
  assert.equal(report.regions[0].region.label,'새 공식 시군구');
});

test('saved-only first results include pending own official region without invoking the live company reader',async()=>{
  const d=data();d.companies[0].regionKey='town';d.regionHierarchy.town='home';
  const s=service(d),report=await s.analysis.briefing(customer(),'own',{savedOnly:true});
  assert.deepEqual(s.companyReads,[]);assert.ok(s.savedCompanyReads.length>0);
  assert.deepEqual(report.regions.map(row=>row.region.id),['home']);
  assert.equal(report.companies.find(row=>row.companyId==='own').analysisRegionKey,'home');
  assert.equal(report.calculation.mode,'saved_only');assert.equal(report.calculation.status,'pending');
  assert.ok(report.actions.some(row=>row.key==='region'));
});

test('selected own scope does not read an unselected own store or a competitor region and deduplicates registered interest',async()=>{
  const c=customer();c.regions=[{regionKey:'home',status:'active'},{regionKey:'interest',status:'active'}];
  const s=service(),report=await s.analysis.briefing(c,'own');
  assert.deepEqual(s.reads.map(row=>row.targetId).sort(),['home','interest']);
  assert.equal(s.reads.filter(row=>row.targetId==='home').length,1);
  assert.ok(!s.reads.some(row=>['other','competition'].includes(row.targetId)));
  assert.ok(!report.companies.some(row=>row.companyId==='other-own'));
  const next=service();await next.analysis.briefing(c,'other-own');
  assert.ok(next.reads.some(row=>row.targetId==='other'));
  assert.ok(!next.reads.some(row=>row.targetId==='competition'));
});

for(const status of ['archived','rejected','cancelled'])test(`a ${status} own relation cannot select or read its report region`,async()=>{
  const c=customer();c.relations[0].status=status;const s=service();
  await assert.rejects(s.analysis.briefing(c,'own'),{code:'NOT_FOUND',statusCode:404});
  assert.deepEqual(s.reads,[]);assert.deepEqual(s.companyReads,[]);
});

for(const extra of [{companyId:'own',kind:'competitor',status:'active'},{companyId:'own',kind:'own',status:'active'}])test(`conflicting ${extra.kind}/${extra.status} relation does not grant an implicit region read`,async()=>{
  const c=customer();c.relations.push(extra);const s=service(),report=await s.analysis.briefing(c,'own');
  assert.ok(!s.reads.some(row=>row.targetId==='home'));
  assert.ok(!report.regions.some(row=>row.region.id==='home'));
  assert.ok(report.actions.some(row=>row.key==='region_data'));
});

test('read-only pending report access neither grants preparation permission nor changes interest quota',async()=>{
  const c=customer();c.relations=c.relations.filter(row=>row.companyId==='own');const before=clone(c),s=service();
  await s.analysis.briefing(c,'own');
  assert.deepEqual([...regionIds(c,s.catalog)],[]);
  for(const start of [false,true])await assert.rejects(s.analysis.preparation(c,'home','2026-09',start),{code:'NOT_FOUND',statusCode:404});
  assert.deepEqual(s.preparations,[]);assert.deepEqual(c,before);
});

test('a failed stored region keeps normal company quantities and revenue while naming the failed region and period safely',async()=>{
  const c=customer(),s=service(data(),async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_RESPONSE'),{code:'PRIVATE_CODE'});});
  const report=await s.analysis.briefing(c,'own'),own=report.companies.find(row=>row.companyId==='own');
  assert.equal(own.summary.sold,4);assert.equal(own.summary.estimatedRevenue,400000);assert.equal(own.sourceStatus,'ready');
  assert.equal(report.regions[0].sourceStatus,'unavailable');
  assert.deepEqual(report.regions[0].sourceIssues[0].period,{start:'2026-09-01',end:'2026-09-30'});
  assert.equal(report.regions[0].sourceIssues[0].regionId,'home');
  assert.equal(report.regions[0].sourceIssues[0].code,'REGION_SOURCE_UNAVAILABLE');
  assert.equal(report.dataQuality.status,'partial');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
  assert.ok(report.actions.some(row=>row.key==='region_data'));
});

test('unmapped, broad and address-only company geography stays unresolved instead of reading an inferred region',async()=>{
  for(const key of ['unknown-town','province','']) {
    const d=data();d.companies[0]={...d.companies[0],regionKey:key,address:'내 매장 공식 지역'};
    const s=service(d),report=await s.analysis.briefing(customer(),'own');
    assert.deepEqual(s.reads,[]);assert.deepEqual(report.regions,[]);
    assert.equal(report.companies.find(row=>row.companyId==='own').analysisRegionKey,null);
    assert.ok(report.actions.some(row=>row.key==='region_data'));
  }
});
