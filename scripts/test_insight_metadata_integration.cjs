'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const {createInsightIntegration,reviewedRooms}=require('./lib/insight_integration.cjs');
const {createAnalyticalWorkScheduler}=require('./lib/analytical_work_scheduler.cjs');
const companyId='cmp_place_metadata_test';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function fixture(t,envPatch={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'insight-metadata-integration-'));
  const companyFile=path.join(dir,'company_master','companies.json');fs.mkdirSync(path.dirname(companyFile),{recursive:true});
  let company={companyId,primaryName:'검수 숙소',addresses:['경상남도 산청군 시천면'],placeIds:['123456789'],
    manualCorrection:{active:true,lodgingBasisTotal:16,facilityTags:['바베큐'],updatedAt:'2026-10-23T01:00:00Z'},
    adminProfile:{active:true,primaryName:'DB 검수 숙소',address:'경상남도 산청군 시천면'},
    privateMemo:'NEVER_SEND_PRIVATE_METADATA',inventory:{latest:{collectedAt:'2026-10-22T02:00:00Z',products:[{privateSource:'NEVER_SEND_PRIVATE_METADATA'}]}}};
  const save=patch=>{company={...company,...patch};fs.writeFileSync(companyFile,JSON.stringify({companies:{[companyId]:company}}));};save({});
  let memberEnabled=true,memberReads=0,fullCatalogReads=0;
  const blocker=deferred(),entered=deferred(),scheduler=createAnalyticalWorkScheduler();
  const heavy=scheduler.run(async()=>{entered.resolve();await blocker.promise;},{priority:'background',kind:'company-month'});
  t.after(async()=>{blocker.resolve();await heavy;});
  const key=randomUUID(),config={dataDir:dir,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:key,INSIGHT_METADATA_READ_ENABLED:'1',...envPatch},
    readCatalog:()=>scheduler.run(()=>{fullCatalogReads++;throw Error('Login must not enter full analytical catalog');}),
    readMembers:async()=>{memberReads++;return {members:[{memberId:'metadata-member',username:'metadata',role:'b2b',status:memberEnabled?'active':'disabled'}]};},
    authenticateMember:async()=>({memberId:'metadata-member',username:'metadata',role:'b2b',status:memberEnabled?'active':'disabled'}),requireAdmin:()=>false};
  let app=createInsightIntegration(config);
  const customer=app.store.ensure({memberId:'metadata-member',username:'metadata',role:'b2b',status:'active'});
  app.store.update(customer.customerId,{revision:customer.revision,requestKey:randomUUID(),action:'add-company',payload:{kind:'own',companyId}},
    {companies:[{companyId,name:'검수 숙소'}],regions:[]});
  const session=app.store.session(customer.customerId);
  const server=http.createServer((req,res)=>{void app.internal(req,res,new URL(req.url,'http://local.test')).catch(()=>{res.statusCode=500;res.end();});});
  t.after(()=>{server.closeAllConnections();server.close();app.store.close();app.adminStore.close();});
  const start=async()=>{await entered.promise;await new Promise(done=>server.listen(0,'127.0.0.1',done));};
  const me=()=>fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/me`,{headers:{Authorization:'Bearer '+key,'X-Insight-Session':session},signal:AbortSignal.timeout(3000)});
  return {dir,companyFile,start,me,save,config,session,customer,get app(){return app;},get fullCatalogReads(){return fullCatalogReads;},get memberReads(){return memberReads;},
    disable(){memberEnabled=false;},restart(){app.store.close();app.adminStore.close();app=createInsightIntegration(config);},scheduler};
}
test('deployed Insight metadata bypasses a busy analytical lease on cold, concurrent warm and restarted reads',async t=>{
  const f=fixture(t);await f.start();
  const first=await f.me();assert.equal(first.status,200);const data=await first.json();
  assert.equal(data.companies[0].companyId,companyId);assert.equal(data.companies[0].name,'DB 검수 숙소');assert.equal(data.companies[0].rooms,16);
  assert.equal(data.companies[0].regionKey,'kr_gyeongnam_sancheong');assert.equal(data.regions[0].id,'kr_gyeongnam_sancheong');
  assert.equal(data.customer.relations[0].status,'pending');assert.equal(data.customer.regions.length,0);
  assert.doesNotMatch(JSON.stringify(data),/NEVER_SEND_PRIVATE_METADATA|privateSource|privateMemo/);
  const warm=await Promise.all(Array.from({length:8},async()=>{const reply=await f.me();return {status:reply.status,body:await reply.json()};}));
  assert.ok(warm.every(row=>row.status===200&&row.body.companies[0].rooms===16));assert.ok(f.memberReads>=9);
  assert.equal(f.fullCatalogReads,0);assert.equal(f.scheduler.status().activeKind,'company-month');assert.equal(f.scheduler.status().queuedForeground,0);
  await f.app.metadataCatalog.prepare();f.restart();
  const restarted=await f.me();assert.equal(restarted.status,200);assert.equal((await restarted.json()).companies[0].rooms,16);assert.equal(f.fullCatalogReads,0);
});
test('metadata reflects DB reviews, new locations and deletion without recomputing revenue or keeping a vanished source',async t=>{
  const f=fixture(t);await f.start();assert.equal((await f.me()).status,200);
  f.save({manualCorrection:{active:true,lodgingBasisTotal:17,regionOverride:'kr_gyeongnam_sacheon'},addresses:['경상남도 사천시'],adminProfile:{active:true,primaryName:'이전한 숙소',address:'경상남도 사천시'}});
  const changed=await (await f.me()).json();assert.equal(changed.companies[0].rooms,17);assert.equal(changed.companies[0].regionKey,'kr_gyeongnam_sacheon');assert.equal(changed.regions[0].id,'kr_gyeongnam_sacheon');
  assert.equal(f.fullCatalogReads,0);
  f.save({deletedAt:'2026-10-23T03:00:00Z'});const removed=await (await f.me()).json();assert.deepEqual(removed.companies,[]);assert.deepEqual(removed.regions,[]);
  fs.renameSync(f.companyFile,path.join(f.dir,'company_master','preserved-companies.json'));
  const missing=await f.me();assert.equal(missing.status,503);assert.equal((await missing.json()).error.code,'SERVICE_UNAVAILABLE');
});
test('metadata reuse never keeps a disabled member signed in',async t=>{
  const f=fixture(t);await f.start();assert.equal((await f.me()).status,200);f.disable();
  const disabled=await f.me();assert.equal(disabled.status,403);assert.equal((await disabled.json()).error.code,'ACCOUNT_DISABLED');assert.equal(f.fullCatalogReads,0);
});
for(const environment of [{RENDER:'true'},{NODE_ENV:'production'}])test(`deployed ${Object.keys(environment)[0]} runtime selects the fast reader without an environment edit`,async t=>{
  const f=fixture(t,{INSIGHT_METADATA_READ_ENABLED:undefined,...environment});await f.start();
  assert.ok(f.app.metadataCatalog);const reply=await f.me();assert.equal(reply.status,200);assert.equal(f.fullCatalogReads,0);
});
test('reviewed room projection preserves the established explicit and room-segment precedence',()=>{
  assert.equal(reviewedRooms({manualCorrection:{active:true,lodgingBasisTotal:16,roomSegments:[{count:99}]}}),16);
  assert.equal(reviewedRooms({manualCorrection:{active:true,roomSegments:[{count:'10실'},{roomCount:'7'}]}}),17);
  assert.equal(reviewedRooms({manualCorrection:{active:false,lodgingBasisTotal:16}}),null);
  assert.equal(reviewedRooms({}),null);
});
