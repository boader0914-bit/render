'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createCollectionResults}=require('./lib/insight_collection_results.cjs');
const {createAnalyticalWorkScheduler}=require('./lib/analytical_work_scheduler.cjs');
const {createInsightIntegration}=require('./lib/insight_integration.cjs');
const {createInsightHttp}=require('./lib/insight_http.cjs');
const {createInsightStore,fault}=require('./lib/insight_store.cjs');
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const companies=['cmp_a','cmp_b'].map(companyId=>({companyId,name:companyId,rooms:16,placeIds:['123'],version:'fixture',regionKey:'region_one'}));
const catalog={companies,regions:[]};

function reader(t,{onIntegrated,onDetail,onEvidence}={}){
  const timings=[],scheduler=createAnalyticalWorkScheduler({onTaskTiming:record=>timings.push(record)}),calls=[];
  t.after(()=>scheduler.close());
  const runWork=(operation,options)=>scheduler.run(operation,options);
  const step=(stage,id,read,callback)=>runWork(async()=>{
    assert.equal(scheduler.status().activeKind==='insight-company-view'||scheduler.status().activeKind==='fixture-parent',true,'all parts use the complete view owner');
    calls.push(stage+':'+id);await callback?.(id);return read();
  },{priority:'foreground',kind:'fixture-'+stage});
  const source=createCollectionResults({catalog:async()=>catalog,runWork,
    readIntegrated:(id,{month})=>step('proof',id,()=>({companyId:id,status:'ready',selectedMonth:month,months:[{month,status:'partial'}],snapshot:null}),onIntegrated),
    readCompanyDetail:id=>step('detail',id,()=>({company:{companyId:id},salesHistory:{current:{daily:[],summary:null}}}),onDetail),
    readEvidence:id=>step('evidence',id,()=>({run:{id:'run_'+id,checkIn:'2026-09-01',bookingRangeDays:30,dayUseMode:'inspect',collectionQuality:{status:'complete'}},snapshot:{daily:[]},rows:[]}),onEvidence)});
  return {source,scheduler,runWork,calls,timings};
}

test('a complete company read waits for active industry once, then proof/detail/evidence share one foreground owner', {timeout:5000}, async t=>{
  const blocked=gate(),entered=gate();let followup;
  const f=reader(t,{onIntegrated:()=>{followup=f.runWork(()=>f.calls.push('industry-followup'),{priority:'background',kind:'industry-followup',detached:true});}});
  t.after(()=>blocked.resolve());
  const industry=f.runWork(async()=>{entered.resolve();await blocked.promise;},{priority:'background',kind:'industry-build'});
  await entered.promise;
  const a=f.source.readView('cmp_a',{month:'2026-09'}),b=f.source.readView('cmp_a',{month:'2026-09'});await turn();
  assert.deepEqual(f.calls,[]);assert.equal(f.scheduler.status().queuedForeground,2);
  blocked.resolve();const [one,two]=await Promise.all([a,b]);await industry;await followup;
  assert.deepEqual(one,two);assert.equal(one.companyDetail.companyId,'cmp_a');assert.equal(one.result.companyId,'cmp_a');
  assert.deepEqual(f.calls,['proof:cmp_a','detail:cmp_a','evidence:cmp_a','industry-followup']);
  const stages=f.timings.filter(row=>row.kind.startsWith('fixture-'));
  assert.equal(stages.length,3);assert.ok(stages.every(row=>row.reentrant&&row.parentId===stages[0].parentId));
  assert.equal(f.timings.filter(row=>!row.reentrant&&row.kind==='insight-company-view').length,2,'concurrent callers share one started load, not an unowned promise');
  assert.equal(f.scheduler.status().active,false);
});

test('nested company views do not join a queued promise behind their own lease and share the same company work', {timeout:5000}, async t=>{
  const f=reader(t),entered=gate(),proceed=gate();t.after(()=>proceed.resolve());
  const parent=f.runWork(async()=>{
    entered.resolve();await proceed.promise;
    const [view,detail]=await Promise.all([f.source.readView('cmp_a',{month:'2026-09'}),f.source.companyDetail('cmp_a',{month:'2026-09'})]);
    assert.deepEqual(view.companyDetail,detail);return view;
  },{kind:'fixture-parent'});
  await entered.promise;const queued=f.source.readView('cmp_a',{month:'2026-09'});await turn();proceed.resolve();
  const [inside,outside]=await Promise.all([parent,queued]);assert.deepEqual(inside,outside);
  assert.deepEqual(f.calls,['proof:cmp_a','detail:cmp_a','evidence:cmp_a']);assert.equal(f.scheduler.status().active,false);
});

test('different company and month reads keep one allocation owner and never mix the requested scopes', {timeout:5000}, async t=>{
  const entered=gate(),release=gate();let resources=0,peak=0;
  const f=reader(t,{onEvidence:async id=>{resources++;peak=Math.max(peak,resources);if(id==='cmp_a'){entered.resolve();await release.promise;}resources--;}});
  t.after(()=>release.resolve());const one=f.source.readView('cmp_a',{month:'2026-09'});await entered.promise;
  const two=f.source.readView('cmp_b',{month:'2026-10'});await turn();assert.equal(f.calls.some(row=>row.endsWith('cmp_b')),false);
  release.resolve();const [a,b]=await Promise.all([one,two]);assert.equal(peak,1);assert.equal(a.companyDetail.integrated.selectedMonth,'2026-09');
  assert.equal(b.companyDetail.integrated.selectedMonth,'2026-10');assert.equal(b.result.companyId,'cmp_b');
});

test('a failed proof releases the whole read and the same scope can subsequently retry without retaining a failed flight',async t=>{
  let fail=true;const f=reader(t,{onIntegrated:()=>{if(fail)throw Object.assign(Error('fixture failure'),{code:'COMPANY_PROOF_UNAVAILABLE'});}});
  await assert.rejects(f.source.readView('cmp_a',{month:'2026-09'}),{code:'COMPANY_PROOF_UNAVAILABLE'});
  assert.equal(f.scheduler.status().active,false);assert.deepEqual(f.calls,['proof:cmp_a']);fail=false;
  assert.equal((await f.source.readView('cmp_a',{month:'2026-09'})).result.companyId,'cmp_a');
  assert.deepEqual(f.calls,['proof:cmp_a','proof:cmp_a','detail:cmp_a','evidence:cmp_a']);
});

test('integration discovers the reader ownership capability without changing the application calculator wiring',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'insight-group-adapter-')),scheduler=createAnalyticalWorkScheduler();
  let server,app;const runWork=(operation,options)=>scheduler.run(operation,options),stages=[],serviceToken=crypto.randomUUID();
  const readCompanyDetail=async id=>{assert.equal(scheduler.status().activeKind,'insight-company-view');stages.push('detail');return {company:{companyId:id}};};
  Object.defineProperty(readCompanyDetail,'runWork',{value:runWork});
  app=createInsightIntegration({dataDir:dir,env:{INSIGHT_CONNECTION_ENABLED:'1',INSIGHT_SERVICE_TOKEN:serviceToken,INSIGHT_METADATA_READ_ENABLED:'0'},
    readCatalog:async()=>({companies:companies.map(c=>({...c,primaryName:c.name,capacity:c.rooms})),regions:[],
      rawCompanies:new Map(companies.map(c=>[c.companyId,{addresses:['경상남도 산청군'],manualCorrection:{}}]))}),
    readCompanyDetail,readIntegrated:async id=>{assert.equal(scheduler.status().activeKind,'insight-company-view');stages.push('proof');return {companyId:id,status:'pending',snapshot:null};},
    readEvidence:async()=>{assert.equal(scheduler.status().activeKind,'insight-company-view');stages.push('evidence');return null;},
    readMembers:async()=>({members:[{memberId:'member',role:'b2b',status:'active'}]}),requireAdmin:()=>false});
  t.after(async()=>{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}app.store.close();app.adminStore.close();await scheduler.close();await fs.rm(dir,{recursive:true,force:true});});
  const customer=app.store.ensure({memberId:'member',username:'fixture',role:'b2b'});
  app.store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_a'}},catalog);
  const token=app.store.session(customer.customerId);
  server=http.createServer((req,res)=>app.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const reply=await fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1/companies/cmp_a/collection?month=2026-09`,
    {headers:{Authorization:'Bearer '+serviceToken,'X-Insight-Session':token}});
  assert.equal(reply.status,200);assert.equal((await reply.json()).companyDetail.companyId,'cmp_a');
  assert.deepEqual(stages,['proof','detail','evidence']);
});

for(const change of ['logout','relationship','member','final-member','admin'])test('full grouped HTTP response rechecks '+change+' after asynchronous source reads',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'insight-group-auth-')),store=createInsightStore({file:path.join(dir,'state.sqlite')});
  let server,memberEnabled=true,adminEnabled=true,memberChecks=0;const entered=gate(),release=gate();
  t.after(async()=>{release.resolve();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}store.close();await fs.rm(dir,{recursive:true,force:true});});
  const isAdmin=change==='admin',memberId=isAdmin?'insight-admin:fixture-admin':'member',customer=store.ensure({memberId,username:'fixture',role:'b2b',accountKind:isAdmin?'admin_preview':'customer'});
  store.update(customer.customerId,{revision:customer.revision,requestKey:crypto.randomUUID(),action:'add-company',payload:{kind:'own',companyId:'cmp_a'}},catalog);
  const token=isAdmin?'fixture-admin-session':store.session(customer.customerId),serviceToken=crypto.randomUUID();let grouped=0;
  const handlers=createInsightHttp({store,serviceToken,catalog:async()=>catalog,
    memberActive:async()=>{if(change==='final-member'&&++memberChecks===2){await Promise.resolve();store.logout(token);}return memberEnabled;},
    adminStore:{authenticate(value){if(!adminEnabled||value!==token)throw fault('ADMIN_LOGIN_REQUIRED','관리자 로그인 필요',401);return {adminId:'fixture-admin',username:'fixture'};}},
    collectionResults:{async readView(id,{month}){grouped++;assert.equal(month,'2026-09');entered.resolve();await release.promise;return {companyDetail:{companyId:id},result:{companyId:id,runId:'fixture'}};},
      read:()=>assert.fail('grouped path must replace separate source reads'),companyDetail:()=>assert.fail('grouped path must replace separate detail reads')}});
  server=http.createServer((req,res)=>handlers.internal(req,res,new URL(req.url,'http://fixture')));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const pending=fetch(`http://127.0.0.1:${server.address().port}/api/insight/v1${isAdmin?'/admin/customer-view':''}/companies/cmp_a/collection?month=2026-09`,
    {headers:{Authorization:'Bearer '+serviceToken,[isAdmin?'X-Insight-Admin-Session':'X-Insight-Session']:token}});
  await entered.promise;
  if(change==='logout')store.logout(token);else if(change==='admin')adminEnabled=false;else if(change==='member')memberEnabled=false;
  else if(change==='relationship'){const current=store.get(customer.customerId);store.update(customer.customerId,{revision:current.revision,requestKey:crypto.randomUUID(),action:'archive-company',payload:{relationId:current.relations[0].relationId}},catalog);}
  release.resolve();const response=await pending;assert.equal(grouped,1);assert.equal(response.status,['logout','final-member','admin'].includes(change)?401:change==='member'?403:404);
  assert.equal((await response.json()).companyDetail,undefined);
});
