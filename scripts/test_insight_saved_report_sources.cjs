'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const {createInsightSavedReportSources}=require('./lib/insight_saved_report_sources.cjs');
const {createInsightAnalysis}=require('./lib/insight_analysis.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const {createInsightStore}=require('./lib/insight_store.cjs');
const {buildMonthlyReportSnapshot}=require('./lib/monthly_reports.cjs');
const {projectIntegrated}=require('./lib/insight_company_integrated.cjs');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const NOW=Date.parse('2026-10-24T01:00:00Z');
async function fixture(t,{cleanup,calculationVersion='company-integrated-v1'}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'insight-saved-report-'));
  const companies=[{companyId:'cmp_one',name:'내 매장',primaryName:'내 매장',rooms:16,capacity:16,roomCountSource:'db_review',regionKey:'region_one'},
    {companyId:'cmp_two',name:'경쟁 업체',primaryName:'경쟁 업체',rooms:10,capacity:10,roomCountSource:'db_review',regionKey:'region_one'}];
  const region={id:'region_one',label:'검수 지역',level:'local'},catalog={companies,regions:[region]};
  const months=['2026-10','2026-11'],saved=new Map();
  const file=(id,month)=>path.join(root,'company_integrated',digest(id),month+'.json');
  for(const c of companies)for(const month of months){
    const date=month==='2026-10'?'2026-10-24':'2026-11-01',sold=c.companyId==='cmp_one'?(month==='2026-10'?0:3):2;
    const observation={companyId:c.companyId,companyKey:c.companyId,runId:'fixture_run',keyword:'모의 검색',collectedAt:'2026-10-23T01:00:00Z',stayDate:date,productType:'lodging',
      inventoryEvidenceVersion:4,supply:c.rooms,sold,publicBookings:sold,phoneBookings:0,publicRevenue:sold*100000,phoneRevenue:0,estimatedRevenue:sold*100000,
      partial:false,missing:false,unknownUnavailable:0,phoneMissingPriceBookings:0,sharedDayUseExcluded:0,capacityBasis:{count:c.rooms,source:'db_review'}};
    const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:c.companyId,month,cutoffDate:'2026-10-23'},
      {companies:[c],observations:[observation],runs:[{id:'fixture_run',keyword:'모의 검색',collectionQuality:{status:'complete'}}]},'2026-10-23T02:00:00Z');
    const body={schemaVersion:1,companyId:c.companyId,month,calculationVersion,calculatedAt:month==='2026-10'?'2026-10-23T02:00:00Z':'2026-10-23T03:00:00Z',
      cutoffDate:'2026-10-23',sourceRevision:calculationVersion==='company-integrated-v1'?'fixture-source-version':digest('fixture-source-version'),roomBasis:{capacity:c.rooms,source:'db_review'},snapshot,latestAttempts:[],failedAttempts:[]};
    const value={...body,cacheDigest:digest(body)};saved.set(c.companyId+'|'+month,value);
    await fs.mkdir(path.dirname(file(c.companyId,month)),{recursive:true});await fs.writeFile(file(c.companyId,month),JSON.stringify(value));
  }
  const queue=path.join(root,'company_integrated','queue.json');await fs.writeFile(queue,JSON.stringify({sentinel:'must not inspect, queue or modify'}));
  t.after(async()=>{await cleanup?.();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  const source=createInsightSavedReportSources({dataDir:root,now:()=>NOW});
  const customer={relations:[{companyId:'cmp_one',kind:'own',status:'active'},{companyId:'cmp_two',kind:'competitor',status:'active'}],regions:[]};
  return {root,companies,catalog,region,months,file,saved,source,customer,queue};
}

test('saved-only preview uses exact company-month files, preserves zero and null, and never joins normal calculation',async t=>{
  const f=await fixture(t),paths=new Set([...f.saved].map(([key])=>f.file(...key.split('|')))),reads=[],originals=new Map(await Promise.all([...paths,f.queue].map(async file=>[file,await fs.readFile(file)])));
  const storage=Object.create(fs);storage.open=async(file,...args)=>{assert.ok(paths.has(String(file)),'only selected snapshot files can be opened');reads.push(String(file));return fs.open(file,...args);};
  let normalReads=0,regionalReads=0;
  const analysis=createInsightAnalysis({catalog:async()=>f.catalog,savedCollectionResults:createInsightSavedReportSources({dataDir:f.root,fileSystem:storage,now:()=>NOW}),
    collectionResults:{companyDetail:async()=>{normalReads++;throw Error('normal calculation forbidden');}},now:()=>NOW,
    readRegionContext:async request=>{regionalReads++;assert.equal(request.month,'2026-09');return {networkAttempted:false,sources:[{key:'population',label:'인구',status:'ready',rows:[{key:'count',label:'인구',status:'observed',value:0}]}]};}});
  const report=await analysis.briefing(f.customer,'cmp_one',{savedOnly:true,stayMode:'upcoming30'});
  assert.equal(normalReads,0);assert.equal(regionalReads,1);assert.equal(reads.length,4);
  assert.deepEqual(report.period,{start:'2026-10-24',end:'2026-11-22',days:30});
  assert.deepEqual(report.calculation,{mode:'saved_only',status:'pending',oldestSourceCalculatedAt:'2026-10-23T02:00:00Z',latestSourceCalculatedAt:'2026-10-23T03:00:00Z'});
  assert.equal(report.companies[0].summary.sold,3);assert.equal(report.companies[0].summary.days,2);assert.equal(report.companies[1].summary.sold,4);
  assert.equal(report.regions[0].sources[0].rows[0].value,0);assert.equal(report.comparisons.length,1);
  const detail=await f.source.companyDetail('cmp_one',{month:'2026-10',company:f.companies[0]});
  assert.equal(detail.current.daily.find(row=>row.date==='2026-10-24').sold,0);
  assert.equal(detail.current.daily.find(row=>row.date==='2026-10-25').sold,null);
  assert.deepEqual(detail.current,(()=>{const result=projectIntegrated('cmp_one',{...f.saved.get('cmp_one|2026-10'),status:'ready',selectedMonth:'2026-10'},'2026-10');return {summary:result.snapshot.summary,daily:result.snapshot.daily};})());
  for(const [file,bytes]of originals)assert.deepEqual(await fs.readFile(file),bytes,'read-only preview preserves '+path.basename(file));
});

test('missing saved periods remain unknown and a new report never substitutes another company or month',async t=>{
  const f=await fixture(t);await fs.unlink(f.file('cmp_two','2026-11'));
  const analysis=createInsightAnalysis({catalog:async()=>f.catalog,savedCollectionResults:f.source,collectionResults:{companyDetail:()=>assert.fail('normal reader forbidden')},now:()=>NOW});
  const report=await analysis.briefing({...f.customer,relations:f.customer.relations.map(row=>({...row,status:'pending'}))},'cmp_one',{savedOnly:true,stayMode:'upcoming30'});
  const other=report.companies[1];assert.equal(other.summary.sold,2);assert.equal(other.sourceStatus,'partial');
  assert.ok(other.sourceIssues.some(issue=>issue.code==='MONTH_NOT_OBSERVED'&&issue.month==='2026-11'));
  await fs.unlink(f.file('cmp_two','2026-10'));
  const missing=await analysis.briefing({...f.customer,relations:f.customer.relations.map(row=>({...row,status:'pending'}))},'cmp_one',{savedOnly:true,stayMode:'upcoming30'});
  assert.equal(missing.companies[1].summary.sold,null);assert.equal(missing.companies[1].summary.estimatedRevenue,null);
  assert.equal(missing.calculation.mode,'saved_only');assert.equal(missing.dataQuality.status,'partial');
});

for(const calculationVersion of ['company-integrated-v2-price-observation-time','company-integrated-v3-saved-product-recovery','company-integrated-v4-product-max-room-reuse'])test('saved-only preview accepts the verified '+calculationVersion+' format without modifying or recalculating it',async t=>{
  const f=await fixture(t,{calculationVersion}),paths=[...f.saved.keys()].map(key=>f.file(...key.split('|'))),before=new Map(await Promise.all([...paths,f.queue].map(async file=>[file,await fs.readFile(file)])));
  const analysis=createInsightAnalysis({catalog:async()=>f.catalog,savedCollectionResults:f.source,
    collectionResults:{companyDetail:()=>assert.fail('saved preview must not recompute company history')},now:()=>NOW});
  const report=await analysis.briefing(f.customer,'cmp_one',{savedOnly:true,stayMode:'upcoming30'});
  assert.equal(report.calculation.mode,'saved_only');assert.equal(report.companies[0].summary.sold,3);assert.equal(report.companies[1].summary.sold,4);
  const detail=await f.source.companyDetail('cmp_one',{month:'2026-10',company:f.companies[0]});
  assert.equal(detail.integrated.calculationVersion,calculationVersion);
  assert.equal(detail.current.daily.find(row=>row.date==='2026-10-24').sold,0);
  assert.equal(detail.current.daily.find(row=>row.date==='2026-10-25').sold,null);
  for(const [file,bytes]of before)assert.deepEqual(await fs.readFile(file),bytes,'supported saved source remains byte-identical');
});

test('current v4 saved projection preserves recovered-price evidence, missing money and shared day-use without recalculation',async t=>{
  const f=await fixture(t,{calculationVersion:'company-integrated-v4-product-max-room-reuse'}),original=f.saved.get('cmp_one|2026-10');
  const observation={...original.snapshot.sources.observations[0],stayDate:'2026-10-24',date:'2026-10-24',supply:16,sold:3,
    publicBookings:1,phoneBookings:2,publicRevenue:110000,phoneRevenue:220000,estimatedRevenue:330000,sharedDayUseExcluded:1,
    inventoryEvidenceVersion:5,priceRecoveryPolicy:'inventory_price_recovery_v1',phoneValuationPolicy:'product_minmax_proportional_v2',
    priceUnknownCauses:[],phoneValuation:{policy:'product_minmax_proportional_v2',completePriceCoverage:true,recoveryPolicies:[{
      policy:'uniform_current_catalog_price_v1',quantity:2,revenue:220000,unitPrice:110000,estimatedQuantity:true,sourceDate:'2026-10-24',productKeys:['room_one','room_two']}]}};
  const snapshot=buildMonthlyReportSnapshot({type:'company',targetId:'cmp_one',month:'2026-10',cutoffDate:'2026-10-23'},
    {companies:[f.companies[0]],observations:[observation],runs:[{id:'fixture_run',keyword:'모의 검색',collectionQuality:{status:'complete'}}]},original.calculatedAt);
  const value={...original,snapshot};delete value.cacheDigest;value.cacheDigest=digest(value);
  await fs.writeFile(f.file('cmp_one','2026-10'),JSON.stringify(value));const before=await fs.readFile(f.file('cmp_one','2026-10'));
  const detail=await f.source.companyDetail('cmp_one',{month:'2026-10',company:f.companies[0]}),day=detail.current.daily.find(row=>row.date==='2026-10-24');
  assert.equal(day.sold,3);assert.equal(day.sharedDayUseExcluded,1);assert.equal(day.estimatedRevenue,330000);assert.equal(day.phoneMissingPriceBookings,0);
  assert.deepEqual(day.phoneValuation.recoveryPolicies,observation.phoneValuation.recoveryPolicies);
  assert.deepEqual(day.priceUnknownCauses,[]);assert.equal(day.priceRecoveryPolicy,'inventory_price_recovery_v1');
  assert.equal(detail.current.daily.find(row=>row.date==='2026-10-25').estimatedRevenue,null);
  assert.deepEqual(await fs.readFile(f.file('cmp_one','2026-10')),before);
  const changed=JSON.parse(before);changed.snapshot.sources.observations[0].phoneValuation.recoveryPolicies[0].revenue=999999;
  await fs.writeFile(f.file('cmp_one','2026-10'),JSON.stringify(changed));
  await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
});

test('unreviewed future version labels cannot enter the saved-only projection even with a valid integrity hash',async t=>{
  const f=await fixture(t,{calculationVersion:'company-integrated-v3-saved-product-recovery'}),file=f.file('cmp_one','2026-10'),original=f.saved.get('cmp_one|2026-10');
  for(const calculationVersion of ['company-integrated-v4','company-integrated-v3-saved-product-recovery-extra','company-integrated-v2','v3',null]){
    const value={...original,calculationVersion};delete value.cacheDigest;value.cacheDigest=digest(value);await fs.writeFile(file,JSON.stringify(value));
    await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID',statusCode:503});
  }
});

test('current saved versions require source and cache hashes and reject impossible quantities without filling missing values',async t=>{
  const f=await fixture(t,{calculationVersion:'company-integrated-v3-saved-product-recovery'}),file=f.file('cmp_one','2026-10'),original=f.saved.get('cmp_one|2026-10');
  for(const change of [value=>{delete value.sourceRevision;},value=>{value.sourceRevision='unverified';},
    value=>{delete value.cacheDigest;},value=>{value.snapshot.daily[23].lodging.sold=17;},
    value=>{value.snapshot.sources.observations[0].publicBookings=1;},value=>{value.snapshot.summary.lodging.supply=-1;},
    value=>{value.snapshot.daily[23].lodging.publicBookings='0';}]){
    const value=JSON.parse(JSON.stringify(original));change(value);
    if(Object.hasOwn(value,'cacheDigest')){delete value.cacheDigest;value.cacheDigest=digest(value);}
    await fs.writeFile(file,JSON.stringify(value));
    await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID',statusCode:503});
  }
});

test('corrupt, mismatched, oversized and unsafe saved source files are rejected instead of entering a preview',async t=>{
  const f=await fixture(t),file=f.file('cmp_one','2026-10'),original=await fs.readFile(file);
  const corrupt=JSON.parse(original);corrupt.snapshot.summary.lodging.sold=999;await fs.writeFile(file,JSON.stringify(corrupt));
  await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  const wrong={...f.saved.get('cmp_one|2026-10'),companyId:'cmp_two'};delete wrong.cacheDigest;wrong.cacheDigest=digest(wrong);await fs.writeFile(file,JSON.stringify(wrong));
  await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  for(const change of [
    value=>{value.cutoffDate=value.snapshot.request.cutoffDate=value.snapshot.period.cutoffDate='2026-02-30';},
    value=>{value.snapshot.period.start='2026-09-01';},
    value=>{value.snapshot.daily[0].date='2026-11-01';},
    value=>{value.snapshot.companies[0].companyId='cmp_two';},
    value=>{value.snapshot.sources.observations[0].companyId='cmp_two';}
  ]){
    const candidate=JSON.parse(original);change(candidate);delete candidate.cacheDigest;candidate.cacheDigest=digest(candidate);await fs.writeFile(file,JSON.stringify(candidate));
    await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  }
  await fs.writeFile(file,original);
  await assert.rejects(createInsightSavedReportSources({dataDir:f.root,maxBytes:1,now:()=>NOW}).companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  const unsafe=Object.create(fs);unsafe.lstat=async filename=>filename===file?{isFile:()=>true,isSymbolicLink:()=>true}:fs.lstat(filename);
  await assert.rejects(createInsightSavedReportSources({dataDir:f.root,fileSystem:unsafe,now:()=>NOW}).companyDetail('cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  await assert.rejects(f.source.companyDetail('../cmp_one',{month:'2026-10'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
  await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-13'}),{code:'SAVED_COMPANY_SOURCE_INVALID'});
});

test('a changed reviewed room count is explained without recomputing or showing old quantities as the new basis',async t=>{
  const f=await fixture(t);await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10',company:{...f.companies[0],rooms:17}}),{code:'COMPANY_CAPACITY_REVIEW_CHANGED'});
  for(const roomCountSource of ['관리자 검수값','최대 관측 기준 고정 · 미검수'])await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10',company:{...f.companies[0],rooms:17,roomCountSource}}),{code:'COMPANY_CAPACITY_REVIEW_CHANGED'});
  const value=f.saved.get('cmp_one|2026-10'),withoutBasis={...value,roomBasis:null};delete withoutBasis.cacheDigest;withoutBasis.cacheDigest=digest(withoutBasis);
  await fs.writeFile(f.file('cmp_one','2026-10'),JSON.stringify(withoutBasis));
  await assert.rejects(f.source.companyDetail('cmp_one',{month:'2026-10',company:{...f.companies[0],roomCountSource:'관리자 검수값'}}),{code:'COMPANY_CAPACITY_REVIEW_CHANGED'});
  await fs.writeFile(f.file('cmp_one','2026-10'),JSON.stringify(value));
  const catalog={...f.catalog,companies:f.companies.map(c=>c.companyId==='cmp_one'?{...c,rooms:17}:c)};
  const analysis=createInsightAnalysis({catalog:async()=>catalog,savedCollectionResults:f.source,now:()=>NOW});
  const report=await analysis.briefing({...f.customer,relations:f.customer.relations.map(row=>({...row,status:'pending'}))},'cmp_one',{savedOnly:true,stayMode:'upcoming30'});
  assert.equal(report.companies[0].summary.sold,null);assert.equal(report.companies[0].rooms,17);assert.ok(report.companies[0].sourceIssues.every(i=>i.code==='COMPANY_CAPACITY_REVIEW_CHANGED'));
});

test('saved-only report query is authenticated, strict and does not activate the normal source path',async t=>{
  let store,server,normalReads=0;
  const f=await fixture(t,{cleanup:async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store?.close();}});store=createInsightStore({file:path.join(f.root,'test.sqlite')});
  const c=store.ensure({memberId:'fixture-member',username:'fixture-user',role:'b2b'});
  store.update(c.customerId,{revision:c.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_one'}},f.catalog);
  const token=store.session(c.customerId),serviceToken='fixture-service-token-with-at-least-32-characters';
  const analysis=createInsightAnalysis({catalog:async()=>f.catalog,savedCollectionResults:f.source,collectionResults:{companyDetail:async(id,opts)=>{normalReads++;return f.source.companyDetail(id,opts);}},now:()=>NOW});
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>f.catalog,analysis,memberActive:async()=>true});
  server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=(query,session=token)=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/reports/briefing${query}`,{headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':session}});
  assert.equal((await get('?savedOnly=1','')).status,401);
  assert.equal((await get('?savedOnly=1&ownId=cmp_two')).status,404);
  for(const query of ['?savedOnly=0','?savedOnly=true','?savedOnly=1&savedOnly=1','?savedOnly=1&month=2026-10','?savedOnly=1&ownId=cmp_one&ownId=cmp_one'])assert.equal((await get(query)).status,400);
  const response=await get('?savedOnly=1&ownId=cmp_one');assert.equal(response.status,200);const report=await response.json();
  assert.equal(report.calculation.mode,'saved_only');assert.equal(report.companies.length,1);assert.equal(report.companies[0].companyId,'cmp_one');assert.equal(normalReads,0);
  const normal=await get('?ownId=cmp_one&stayMode=upcoming30');assert.equal(normal.status,200);assert.equal((await normal.json()).calculation,undefined);assert.equal(normalReads,2);
  assert.equal(store.requests(c.customerId).length,0);
});

test('saved company-month HTTP preview is authenticated, exact-scoped and cannot call collection or analytical readers',async t=>{
  let store,server,normalReads=0,refreshes=0,memberEnabled=true;
  const f=await fixture(t,{calculationVersion:'company-integrated-v4-product-max-room-reuse',cleanup:async()=>{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store?.close();
  }});
  store=createInsightStore({file:path.join(f.root,'company-http.sqlite')});
  const customer=store.ensure({memberId:'fixture-member',username:'fixture-user',role:'b2b'});
  store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_one'}},f.catalog);
  const token=store.session(customer.customerId),serviceToken='fixture-company-preview-service-token-32-chars';
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>f.catalog,memberActive:async()=>memberEnabled,
    preparationBridge:{refresh:()=>{refreshes++;assert.fail('preview must not verify receipts or dispatch');}},
    collectionResults:{companyDetail:()=>{normalReads++;assert.fail('preview must not read raw details');},read:()=>assert.fail('preview must not read collection evidence')},
    savedCollectionResults:f.source});
  server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=(query,session=token,id='cmp_one')=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/companies/${id}/collection${query}`,
    {headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':session}});
  const query='?month=2026-10&savedOnly=1';
  assert.equal((await get(query,'')).status,401);assert.equal((await get(query,token,'cmp_two')).status,404);
  for(const invalid of ['?savedOnly=1','?month=2026-13&savedOnly=1','?month=2026-10&savedOnly=0','?month=2026-10&savedOnly=true',
    '?month=2026-10&savedOnly=1&savedOnly=1','?month=2026-10&month=2026-11&savedOnly=1','?month=2026-10&savedOnly=1&refresh=1'])assert.equal((await get(invalid)).status,400);
  const response=await get(query),data=await response.json();assert.equal(response.status,200);
  assert.equal(data.companyDetail.companyId,'cmp_one');assert.equal(data.companyDetail.integrated.selectedMonth,'2026-10');
  assert.equal(data.companyDetail.current.daily.find(row=>row.date==='2026-10-24').sold,0);
  assert.equal(data.companyDetail.current.daily.find(row=>row.date==='2026-10-25').sold,null);
  assert.equal(data.calculation.mode,'saved_only');assert.equal(data.responseCache.state,'preview');assert.equal(data.referenceLoading,true);
  assert.equal(data.result,null);assert.equal(data.companyDetail.channels,undefined);assert.equal(data.companyDetail.basics.name,'내 매장');
  assert.equal(normalReads,0);assert.equal(refreshes,0);assert.equal(store.requests(customer.customerId).length,0);
  await fs.unlink(f.file('cmp_one','2026-10'));assert.equal((await get(query)).status,400);
  memberEnabled=false;assert.equal((await get(query)).status,403);
});

for(const changed of ['logout','relationship','member','final-member'])test('saved company preview rechecks '+changed+' before returning asynchronously read data',async t=>{
  let store,server,release,entered,memberEnabled=true,memberChecks=0;
  const wait=new Promise(resolve=>{release=resolve;}),reading=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{calculationVersion:'company-integrated-v4-product-max-room-reuse',cleanup:async()=>{
    release();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store?.close();
  }});
  store=createInsightStore({file:path.join(f.root,'changing-auth.sqlite')});
  const customer=store.ensure({memberId:'fixture-member',username:'fixture-user',role:'b2b'});
  store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_one'}},f.catalog);
  const token=store.session(customer.customerId),serviceToken='fixture-company-preview-service-token-32-chars';
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>f.catalog,memberActive:async()=>{
    if(changed==='final-member'&&++memberChecks===2){await Promise.resolve();store.logout(token);}return memberEnabled;
  },
    savedCollectionResults:{async companyDetail(id,options){const data=await f.source.companyDetail(id,options);entered();await wait;return data;}}});
  server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const pending=fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/companies/cmp_one/collection?month=2026-10&savedOnly=1`,
    {headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':token}});
  await reading;
  if(changed==='logout')store.logout(token);
  else if(changed==='member')memberEnabled=false;
  else if(changed==='relationship'){const current=store.get(customer.customerId);store.update(customer.customerId,{revision:current.revision,requestKey:crypto.randomUUID(),action:'archive-company',payload:{relationId:current.relations[0].relationId}},f.catalog);}
  release();const response=await pending;assert.equal(response.status,['logout','final-member'].includes(changed)?401:changed==='member'?403:404);
  assert.equal((await response.json()).companyDetail,undefined);
});
