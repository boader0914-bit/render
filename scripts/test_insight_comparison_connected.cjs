'use strict';
// Synthetic saved master + integrated-month adapters only. No network provider,
// collection, operational DB, raw inventory modification or deployed service.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {createInsightIntegration}=require('./lib/insight_integration.cjs');
const {createInsightCatalog}=require('./lib/insight_catalog.cjs');
const {INDUSTRY_IDS,projectIndustryMetadata,projectCapacityMetadata,regionHierarchyFromUnits}=require('./lib/insight_comparison_metadata.cjs');
const {industryAnalysisIndustries}=require('./lib/industry_analysis.cjs');
const {projectReservationSeries}=require('./lib/insight_comparison.cjs');
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function fixture(t,{regions=['경상남도 산청군','경상남도 산청군','경기도 가평군'],patch={},basis={}}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'insight-comparison-connected-')),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10),at=today+'T00:00:00+09:00';
  const companies=Object.fromEntries(regions.map((address,i)=>['cmp_'+i,{companyId:'cmp_'+i,primaryName:i?'직접 검색 글램핑 업체 '+i:'내 매장',industryIds:i===1?['glamping','pension']:[],lodgingTypes:i===1?[]:['글램핑'],addresses:[address+' 검수 주소'],placeIds:[String(123400+i)],manualCorrection:{active:true,lodgingBasisTotal:16},privateMemo:'DO_NOT_SEND_COMPARISON_PRIVATE',inventory:{latest:{collectedAt:at,products:[{name:'DO_NOT_SEND_COMPARISON_PRIVATE'}]}}}]));
  for(const [id,value] of Object.entries(patch))Object.assign(companies[id],value);
  const masterFile=path.join(dir,'company_master','companies.json');await fs.mkdir(path.dirname(masterFile),{recursive:true});await fs.writeFile(masterFile,JSON.stringify({companies}));
  const reads=[],serviceToken=crypto.randomUUID();let fullCatalogReads=0;
  const config={dataDir:dir,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:serviceToken,INSIGHT_METADATA_READ_ENABLED:'1'},
    readCatalog:async()=>{fullCatalogReads++;throw Error('Full catalog must not be read');},readMembers:async()=>({members:[{memberId:'test-member',role:'b2b',status:'active'}]}),requireAdmin:()=>false,
    readEvidence:async()=>{throw Error('Collection evidence must not be requested');},
    readCompanyDetail:async id=>({company:{companyId:id,lodgingTypes:companies[id].lodgingTypes,privateMemo:'DO_NOT_SEND_COMPARISON_PRIVATE'},salesHistory:{},rawProducts:[{secret:'DO_NOT_SEND_COMPARISON_PRIVATE'}]}),
    readIntegrated:async(id,{month})=>{
      reads.push({id,month});const daily=Array.from({length:30},(_,i)=>({date:shift(today,i),lodging:{supply:16,sold:i===0?0:5,publicBookings:i===0?0:2,phoneBookings:i===0?0:3,estimatedRevenue:i===0?0:i===1?200000:500000,revenuePartial:i===1,phoneMissingPriceBookings:i===1?2:0,coveredCompanyDays:1}})).filter(r=>r.date.startsWith(month+'-'));
      return {companyId:id,status:'ready',selectedMonth:month,calculationVersion:'test-calculation-v1',sourceRevision:'test-revision',roomBasis:{capacity:basis[id]?.count??16,source:'db_review',reviewRequired:basis[id]?.reviewRequired===true},
        snapshot:{target:{type:'company',id},request:{type:'company',targetId:id,month},period:{start:month+'-01',end:month+'-31',days:31,cutoffDate:today},daily,sources:{runIds:['test_run'],observations:daily.map(r=>({companyId:id,runId:'test_run',date:r.date,productType:'lodging',collectedAt:at,collectedDate:today,runQuality:'complete'}))}}};
    },readRegionContext:async()=>({sources:[],networkAttempted:false})};
  const app=createInsightIntegration(config),customer=app.store.ensure({memberId:'test-member',username:'fixture',role:'b2b'}),catalog={companies:Object.values(companies).map(c=>({companyId:c.companyId,name:c.primaryName})),regions:[]};
  for(const [index,id] of Object.keys(companies).entries())app.store.update(customer.customerId,{revision:app.store.get(customer.customerId).revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:index?'competitor':'own',companyId:id}},catalog);
  const session=app.store.session(customer.customerId),server=http.createServer((req,res)=>app.internal(req,res,new URL(req.url,'http://fixture')));
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));await app.metadataCatalog.prepare();app.store.close();app.adminStore.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('insight-comparison-connected-'));await fs.rm(dir,{recursive:true,force:true});});
  const request=(route,authorized=true)=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1${route}`,{headers:{Authorization:'Bearer '+serviceToken,...(authorized?{'X-Insight-Session':session}:{})}});
  return {app,config,dir,masterFile,today,at,reads,request,get fullCatalogReads(){return fullCatalogReads;}};
}
test('comparison canonical industry IDs exactly match the central registry without importing its inference behavior',()=>{
  assert.deepEqual([...INDUSTRY_IDS].sort(),industryAnalysisIndustries.map(r=>r.id).sort());
  assert.deepEqual(projectIndustryMetadata({primaryName:'글램핑 풀빌라',keywords:['펜션'],facilities:['캠핑장']}).industryTags,[]);
  const value=projectIndustryMetadata({industryIds:['glamping','invalid'],lodgingTypes:['펜션','풀빌라','글램핑 펜션']});
  assert.deepEqual(value.industryTags,['glamping','pension','poolVilla']);assert.equal(value.industryEvidence.find(r=>r.industryId==='pension').source,'stored_lodging_type');
});
test('capacity projection preserves reviewed, observed, warning and unknown provenance without parsing a display label',()=>{
  assert.equal(projectCapacityMetadata({capacity:16,capacityBasis:{source:'db_review'}}).capacityStatus,'reviewed');
  assert.equal(projectCapacityMetadata({capacity:16,capacityBasis:{source:'observed_locked',warnings:['review']}}).capacityStatus,'review_required');
  assert.equal(projectCapacityMetadata({capacity:16,capacitySource:'관리자 검수값'}).capacityStatus,'unknown');
  assert.equal(projectCapacityMetadata({capacity:16,capacitySource:'관리자 검수값'}).capacityReviewRequired,true,'a display label cannot establish the denominator provenance for actions');
  assert.equal(projectCapacityMetadata({capacity:null,capacityBasis:{source:'db_review'}}).rooms,null);
});
test('only active official general-district parent links are projected; province membership does not group counties',()=>{
  const mapping=regionHierarchyFromUnits([{regionKey:'city',active:true,selectable:true,level:'local',unitType:'city'},{regionKey:'district',parentRegionKey:'city',active:true,level:'address',unitType:'general_district'},{regionKey:'retired',parentRegionKey:'city',active:false,unitType:'general_district'},{regionKey:'county',parentRegionKey:'province',active:true,level:'local',unitType:'county'}]);
  assert.deepEqual({...mapping},{district:'city'});
});
test('live metadata projection supplies exact industry evidence and official hierarchy and survives restart without a body read',async t=>{
  const f=await fixture(t),first=await f.request('/me'),state=await first.json();assert.equal(first.status,200);
  assert.deepEqual(state.companies[0].industryTags,['glamping']);assert.equal(state.companies[0].industryEvidence[0].source,'stored_lodging_type');assert.equal(state.companies[0].capacityStatus,'reviewed');assert.equal(state.companies[0].roomBasis.source,'db_review');
  const metadata=await f.app.metadataCatalog.catalog();assert.equal(metadata.regionHierarchy.kr_admin_4111500000,'kr_admin_4111000000');
  const restart=createInsightCatalog({dataDir:f.dir,regionMasterFile:path.join(__dirname,'..','web','data','region_master.json'),reviewedCapacity:require('./lib/insight_integration.cjs').reviewedRooms,fileSystem:{...fs,open:async(file,...args)=>{assert.notEqual(file,f.masterFile,'restart must reuse unchanged projected body');return fs.open(file,...args);}}});
  assert.deepEqual(await restart.catalog(),metadata);assert.equal(restart.status().projectionReads,0);assert.equal(f.fullCatalogReads,0);
  assert.doesNotMatch(JSON.stringify(state),/DO_NOT_SEND_COMPARISON_PRIVATE|rawProducts|privateMemo/);
});
for(const [name,regions,expected] of [['same',['경상남도 산청군','경상남도 산청군'],'same'],['cross',['경상남도 산청군','경상남도 사천시'],'cross'],['mixed',['경상남도 산청군','경상남도 산청군','경기도 가평군'],'mixed']])test(`current30 connected report classifies ${name} competition from saved official metadata`,async t=>{
  const f=await fixture(t,{regions}),reply=await f.request('/reports/briefing?ownId=cmp_0&stayMode=upcoming30'),report=await reply.json();assert.equal(reply.status,200);
  assert.equal(report.comparisonPolicy.regionMode,expected);assert.equal(report.comparisons.length,regions.length-1);
  assert.ok(report.comparisons.every(r=>r.industryRelation==='common'&&r.purpose==='reference'&&!r.purposeExplicit&&!r.actionable&&r.comparable));
  assert.equal(report.actions.some(r=>r.key==='compare'||r.key==='track'),false);
  const own=report.companies[0];assert.equal(own.rooms,16);assert.equal(own.capacityStatus,'reviewed');assert.equal(own.regionLabel,'경상남도 산청군');assert.equal(own.roomCountSource,'관리자 검수값');assert.equal(own.summary.days,30);assert.equal(own.summary.estimatedRevenue,null);assert.equal(own.summary.knownRevenueSubtotal,14200000);assert.equal(own.summary.partialKnownRevenueSubtotal,200000);
  assert.equal(own.reservationSeries.points.length,30);assert.equal(own.reservationSeries.points[0].sold,0);assert.equal(own.reservationSeries.points[1].quantityStatus,'ready');assert.equal(own.reservationSeries.points[1].publicBookings+own.reservationSeries.points[1].phoneBookings,own.reservationSeries.points[1].sold);
  assert.deepEqual(own.reservationSeries.period,{start:f.today,end:shift(f.today,29)});assert.equal(f.fullCatalogReads,0);
  assert.ok(f.reads.every(r=>r.month===f.today.slice(0,7)||r.month===shift(f.today,29).slice(0,7)));
  assert.doesNotMatch(JSON.stringify(report),/DO_NOT_SEND_COMPARISON_PRIVATE|rawProducts|privateMemo|products/);
});
test('a current DB review and a saved month disagreement keep quantities but block rates and do not overwrite the reviewed count',async t=>{
  const f=await fixture(t,{regions:['경상남도 산청군','경상남도 산청군'],basis:{cmp_1:{count:17}}}),report=await (await f.request('/reports/briefing?stayMode=upcoming30')).json();
  assert.equal(report.companies[1].rooms,16);assert.equal(report.companies[1].capacityStatus,'conflict');assert.equal(report.companies[1].summary.sold,145);assert.equal(report.companies[1].summary.reservationRate,null);
  assert.equal(report.comparisons[0].comparable,false);assert.equal(report.comparisons[0].quality.quantity.comparable,true);assert.equal(report.comparisons[0].competitor.knownRevenueSubtotal,14200000);
  const point=report.companies[1].reservationSeries.points[1];assert.equal(point.quantityStatus,'ready');assert.equal(point.inventoryConflict,true);assert.equal(point.sold,5);assert.equal(point.reservationRate,null);
});
test('a saved room-basis review warning stays visible without erasing normal quantities or inventing an unknown amount',async t=>{
  const f=await fixture(t,{regions:['경상남도 산청군','경상남도 산청군'],basis:{cmp_1:{reviewRequired:true}}}),report=await (await f.request('/reports/briefing?stayMode=upcoming30')).json();
  assert.equal(report.companies[1].capacityStatus,'review_required');assert.equal(report.companies[1].capacityReviewRequired,true);assert.equal(report.comparisons[0].comparable,true);assert.equal(report.comparisons[0].actionable,false);
  assert.ok(report.comparisons[0].reasons.some(r=>r.code==='CAPACITY_REVIEW_REQUIRED'));assert.equal(report.companies[1].summary.sold,145);assert.equal(report.companies[1].summary.estimatedRevenue,null);assert.equal(report.companies[1].summary.partialKnownRevenueSubtotal,200000);
});
test('missing stored industry remains unknown despite an industry-looking name, and scope/auth failures cannot read sources',async t=>{
  const f=await fixture(t,{regions:['경상남도 산청군','경상남도 산청군'],patch:{cmp_1:{industryIds:[],lodgingTypes:[]}}});
  assert.equal((await f.request('/reports/briefing',false)).status,401);assert.equal((await f.request('/reports/briefing?ownId=unregistered')).status,404);assert.equal((await f.request('/reports/briefing?period=2026-09')).status,400);assert.equal(f.reads.length,0);
  const report=await (await f.request('/reports/briefing')).json();assert.equal(report.comparisons[0].industryRelation,'unknown');assert.equal(report.comparisons[0].purpose,'reference');assert.equal(report.comparisons[0].actionable,false);
});
test('series keeps normal zero, quantity with unknown denominator and incomplete dates distinct, exposing no source payload',()=>{
  const today='2026-10-25',collectedAt='2026-10-25T10:00:00+09:00',row={date:today,total:null,sold:0,publicBookings:0,phoneBookings:0,collectedAt,rawProducts:['PRIVATE_SERIES']};
  const value=projectReservationSeries({companyId:'company',rooms:null,days:[row,{...row,date:shift(today,1),total:16,sold:5,publicBookings:5,phoneBookings:1}]},{asOf:today});
  assert.equal(value.points[0].quantityStatus,'ready');assert.equal(value.points[0].sold,0);assert.equal(value.points[0].reservationRate,null);assert.equal(value.points[0].collectedAt,'2026-10-25T01:00:00.000Z');
  assert.equal(value.points[1].quantityStatus,'conflict');assert.equal(value.points[1].sold,null);assert.equal(value.points[2].quantityStatus,'unknown');assert.equal(value.points[2].sold,null);
  assert.equal(value.points.length,30);assert.doesNotMatch(JSON.stringify(value),/PRIVATE_SERIES|rawProducts/);
  assert.equal(projectReservationSeries({companyId:'company',days:[row]},{asOf:today,mode:'historical',period:{start:today,end:shift(today,29)}}),null);
});
