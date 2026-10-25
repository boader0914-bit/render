'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {createCompanyIntegratedDb}=require('./lib/company_integrated_read_db.cjs');
const {createAnalyticalWorkScheduler}=require('./lib/analytical_work_scheduler.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));
const ID='cmp_read_selected',MONTH='2026-09';
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,{revision=true,cached=false,configure}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-selected-read-')),scheduler=createAnalyticalWorkScheduler(),reads=[];
  const company={companyId:ID,primaryName:'검수 업체',capacity:10,capacitySource:'db_review'},raw={companyId:ID,manualCorrection:{lodgingBasisTotal:10,revision:1}};
  const source={companies:[company],runs:[{id:'run',collectedAt:'2026-09-01T00:00:00Z',collectionQuality:{status:'complete'}}],observations:[{
    companyId:ID,companyKey:ID,runId:'run',collectedAt:'2026-09-01T00:00:00Z',stayDate:'2026-09-03',productType:'lodging',inventoryEvidenceVersion:5,
    supply:10,sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,missing:false,partial:false,unknownUnavailable:0,phoneMissingPriceBookings:0,
    capacityBasis:{count:10,source:'db_review'}}],rankObservations:[]};
  const state={revision:1,revisionFail:false,fail:false,beforeReturn:null,now:'2026-10-25T00:00:00Z'},options={dataDir:root,autoStart:false,now:()=>new Date(state.now),
    runWork:(operation,settings)=>scheduler.run(operation,settings),
    catalog:async()=>({companies:[copy(company)],rawCompanies:new Map([[ID,copy(raw)]]),runs:copy(source.runs)}),
    listTargets:async()=>[{companyId:ID,months:[MONTH,'2026-10','2026-11']}],
    ...(revision?{readRevision:async()=>{if(state.revisionFail)throw Error('private revision error');return hash(String(state.revision));}}:{}),
    loadSources:async request=>{reads.push(request.month);if(state.fail)throw Object.assign(Error('private source path'),{code:'SOURCE_NOT_VERIFIED'});
      await state.beforeReturn?.(request);return copy(source);}};
  if(cached){
    options.catalogCached=async()=>{await state.beforeCachedMetadata?.();return state.cachedMetaMiss?null:{company:copy(company),raw:copy(raw),data:{runs:copy(source.runs)}};};
    options.readRevision.prepareFreshCached=async settings=>{await state.beforeCachedRevision?.(settings);return state.cachedRevisionMiss?null:{revision:state.revision};};
    options.readRevision.forScope=prepared=>hash(String(prepared.revision));
  }
  await configure?.({root,scheduler,company,raw,source,state,options});
  const service=createCompanyIntegratedDb(options),directory=path.join(root,'company_integrated',hash(ID)),monthFile=path.join(directory,MONTH+'.json'),proofFile=path.join(directory,MONTH+'.refresh-proof.json'),queueFile=path.join(root,'company_integrated','queue.json');
  const preserved=path.join(root,'raw-and-issued-fixture.json');await fs.writeFile(preserved,JSON.stringify({raw:'never modify',issued:'keep original publication'}));
  t.after(async()=>{await service.stop();await scheduler.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));await fs.rm(root,{recursive:true,force:true});});
  return {root,service,scheduler,options,source,raw,state,reads,directory,monthFile,proofFile,queueFile,preserved};
}
async function staleProof(f){
  await f.service.queueCompany(ID,{months:[MONTH]});await f.service.refreshMonth(ID,{month:MONTH});const old=await fs.readFile(f.proofFile,'utf8');
  f.source.observations[0].sold=f.source.observations[0].publicBookings=1;
  f.source.observations[0].estimatedRevenue=f.source.observations[0].publicRevenue=100000;f.state.revision++;
  await f.service.drain();await f.service.queueCompany(ID,{months:['2026-10','2026-11'],reason:'bootstrap'});
  assert.equal(await fs.readFile(f.proofFile,'utf8'),old,'normal materialization leaves the prior explicit proof untouched');
  return old;
}

test('a current stored month with an old proof is reverified alone while every pending other month and original stays intact',async t=>{
  const f=await fixture(t),old=await staleProof(f),before=await fs.readFile(f.monthFile),queue=await fs.readFile(f.queueFile),preserved=await fs.readFile(f.preserved),raw=JSON.stringify(f.source),reads=f.reads.length;
  const ordinary=await f.service.get(ID,{month:MONTH});assert.equal(ordinary.status,'refreshing');assert.equal(f.reads.length,reads,'default admin path does not repair');
  const view=await f.service.get(ID,{month:MONTH,knownMonthsOnly:true});assert.equal(view.status,'ready');assert.equal(view.freshness.selectedMonthVerified,true);
  assert.equal(view.snapshot.summary.lodging.sold,1);assert.equal(view.snapshot.summary.lodging.estimatedRevenue,100000);
  assert.equal(view.snapshot.daily.find(row=>row.date==='2026-09-04').lodging.sold,null,'unobserved day never becomes zero');
  assert.deepEqual(f.reads.slice(reads),[MONTH,'2026-08'],'only selected month and its comparison month use normal scoped validation');
  assert.deepEqual(await fs.readFile(f.queueFile),queue);assert.deepEqual(await fs.readFile(f.monthFile),before);assert.deepEqual(await fs.readFile(f.preserved),preserved);assert.equal(JSON.stringify(f.source),raw);
  const proof=JSON.parse(await fs.readFile(f.proofFile,'utf8')),stored=JSON.parse(before);assert.notEqual(JSON.stringify(proof),old);
  assert.equal(proof.cacheDigest,stored.cacheDigest);assert.equal(proof.generation,(await f.service.status()).jobs[0].generation);
  const count=f.reads.length;assert.equal((await f.service.get(ID,{month:MONTH,knownMonthsOnly:true})).status,'ready');assert.equal(f.reads.length,count,'an already certified month never repeats the two source reads');
});

test('concurrent and nested selected reads share work only after admission and never wait behind their own analytical owner',{timeout:15000},async t=>{
  const f=await fixture(t);await staleProof(f);const reads=f.reads.length,entered=gate(),proceed=gate();t.after(()=>proceed.resolve());
  const parent=f.scheduler.run(async()=>{entered.resolve();await proceed.promise;return Promise.all([
    f.service.get(ID,{month:MONTH,knownMonthsOnly:true}),f.service.get(ID,{month:MONTH,knownMonthsOnly:true})]);},{kind:'fixture-parent'});
  await entered.promise;const outside=f.service.get(ID,{month:MONTH,knownMonthsOnly:true});await turn();proceed.resolve();
  const [inside,external]=await Promise.all([parent,outside]);assert.deepEqual(inside[0],inside[1]);assert.deepEqual(inside[0],external);assert.equal(external.status,'ready');
  assert.equal(f.reads.length,reads+2);assert.equal(f.scheduler.status().active,false);
});

test('an original engine failure before selected repair becomes a safe failed read rather than cacheable HTTP 200 data',async t=>{
  const f=await fixture(t);await staleProof(f);await f.service.refreshMonth(ID,{month:MONTH});
  const month=await fs.readFile(f.monthFile),proof=await fs.readFile(f.proofFile),reads=f.reads.length;f.state.revisionFail=true;
  await assert.rejects(f.service.get(ID,{month:MONTH,knownMonthsOnly:true}),{code:'COMPANY_INTEGRATION_REVISION_UNAVAILABLE',statusCode:503});
  assert.equal(f.reads.length,reads);assert.deepEqual(await fs.readFile(f.monthFile),month);assert.deepEqual(await fs.readFile(f.proofFile),proof);
});

test('a revision failure after proof publication cannot return a cacheable successful latest response',async t=>{
  const f=await fixture(t);await staleProof(f);const month=await fs.readFile(f.monthFile),queue=await fs.readFile(f.queueFile),rename=fs.rename;
  fs.rename=async(from,to)=>{const result=await rename(from,to);if(to===f.proofFile)f.state.revisionFail=true;return result;};
  try{await assert.rejects(f.service.get(ID,{month:MONTH,knownMonthsOnly:true}),{code:'COMPANY_INTEGRATION_REVISION_UNAVAILABLE',statusCode:503});}
  finally{fs.rename=rename;}
  assert.deepEqual(await fs.readFile(f.monthFile),month);assert.deepEqual(await fs.readFile(f.queueFile),queue);
  assert.equal((await f.service.get(ID,{month:MONTH})).status,'failed');
  f.state.revisionFail=false;assert.equal((await f.service.get(ID,{month:MONTH,knownMonthsOnly:true})).status,'ready');
});

test('source errors retain the last normal snapshot and proof without certifying, consuming or reordering jobs',async t=>{
  const f=await fixture(t);await staleProof(f);const month=await fs.readFile(f.monthFile),proof=await fs.readFile(f.proofFile),queue=await fs.readFile(f.queueFile);f.state.fail=true;
  await assert.rejects(f.service.get(ID,{month:MONTH,knownMonthsOnly:true}),error=>error.code==='SOURCE_NOT_VERIFIED'&&error.statusCode===503&&!error.message.includes('private source path'));
  assert.equal((await f.service.get(ID,{month:MONTH})).snapshot.summary.lodging.sold,1);
  for(const [file,bytes]of [[f.monthFile,month],[f.proofFile,proof],[f.queueFile,queue]])assert.deepEqual(await fs.readFile(file),bytes);
});

test('a newer queue generation during selected validation is preserved and never receives the former certificate',async t=>{
  const f=await fixture(t);await staleProof(f);const month=await fs.readFile(f.monthFile),proof=await fs.readFile(f.proofFile);let once=true;
  f.state.beforeReturn=async request=>{if(once&&request.month===MONTH){once=false;await f.service.queueCompany(ID,{months:['2026-12'],reason:'new_source'});}};
  await assert.rejects(f.service.get(ID,{month:MONTH,knownMonthsOnly:true}),{code:'COMPANY_INTEGRATION_GENERATION_CHANGED',statusCode:503});
  assert.deepEqual(await fs.readFile(f.monthFile),month);assert.deepEqual(await fs.readFile(f.proofFile),proof);
  const job=(await f.service.status()).jobs[0];assert.equal(job.status,'queued');assert.deepEqual(job.months,['2026-10','2026-11','2026-12']);
});

test('unknown periods, missing or corrupt snapshots, explicit cutoff and absent source revisions do not start automatic repair',async t=>{
  const f=await fixture(t);await assert.rejects(f.service.get(ID,{month:'2026-07',knownMonthsOnly:true}),{code:'MONTH_NOT_OBSERVED'});assert.deepEqual(f.reads,[]);
  const pending=await f.service.get(ID,{month:'2026-10',knownMonthsOnly:true});assert.equal(pending.snapshot,null);assert.equal(pending.status,'refreshing');assert.deepEqual(f.reads,[]);
  await staleProof(f);const count=f.reads.length;
  assert.equal((await f.service.get(ID,{month:MONTH,cutoffDate:'2026-09-30',knownMonthsOnly:true})).status,'refreshing');assert.equal(f.reads.length,count,'an explicit cutoff never receives the automatic selected-month repair');
  const before=JSON.parse(await fs.readFile(f.monthFile,'utf8'));before.snapshot.summary.lodging.sold=999;
  await fs.writeFile(f.monthFile,JSON.stringify(before));const corrupt=await f.service.get(ID,{month:MONTH,knownMonthsOnly:true});assert.notEqual(corrupt.status,'ready');assert.equal(corrupt.snapshot,null);assert.equal(f.reads.length,count);
  const without=await fixture(t,{revision:false});await without.service.queueCompany(ID,{months:[MONTH,'2026-10']});await without.service.refreshMonth(ID,{month:MONTH});const reads=without.reads.length;
  assert.equal((await without.service.get(ID,{month:MONTH,knownMonthsOnly:true})).status,'refreshing');assert.equal(without.reads.length,reads);
});

async function runIntegratedRoute(query,{get,authorized=true}={}){
  const source=(await fs.readFile(path.join(__dirname,'glamping_app_server.cjs'),'utf8')).replace(/\r\n/g,'\n');
  const start=source.indexOf('    if (req.method === "GET" && reqUrl.pathname === "/api/company-master/integrated") {');
  const end=source.indexOf('\n    if (req.method === "POST" && reqUrl.pathname === "/api/company-master/recover-saved-products") {',start);
  assert.ok(start>0&&end>start,'exercise the authenticated production route without starting the server');
  return vm.runInNewContext('(async()=>{'+source.slice(start,end)+'})()',{
    req:{method:'GET'},reqUrl:new URL('https://staydatalab.test/api/company-master/integrated?'+query),session:{},res:{},
    requireAdminSession:()=>authorized,companyIntegratedDb:{get},send:(_res,status,body)=>({status,body})
  });
}

test('the authenticated normal web route opts into only selected-month verification while preview and cutoff remain ordinary reads',async()=>{
  const calls=[],get=async(id,request)=>{calls.push({id,request:copy(request)});return {companyId:id};};
  for(const [query,expected]of [
    ['companyId='+ID+'&month='+MONTH,{month:MONTH,verifySelectedMonth:true}],
    ['companyId='+ID,{verifySelectedMonth:true}],
    ['companyId='+ID+'&month='+MONTH+'&view=saved',{month:MONTH,savedPreview:true}],
    ['companyId='+ID+'&month='+MONTH+'&cutoffDate=2026-09-20',{month:MONTH,cutoffDate:'2026-09-20'}],
    ['companyId='+ID+'&month='+MONTH+'&view=saved&cutoffDate=2026-09-20',{month:MONTH,cutoffDate:'2026-09-20'}]
  ]){
    assert.equal((await runIntegratedRoute(query,{get})).status,200);
    assert.deepEqual(calls.at(-1),{id:ID,request:expected});
  }
  const count=calls.length;assert.equal(await runIntegratedRoute('companyId='+ID,{get,authorized:false}),undefined);
  assert.equal(calls.length,count,'an unauthenticated request never reads even a stored month');
  const missing=await runIntegratedRoute('month='+MONTH,{get});assert.equal(missing.status,400);assert.equal(calls.length,count);
});

test('the real normal web route verifies a stored selected month across a newer generation without waiting for or consuming other months',async t=>{
  const f=await fixture(t);await staleProof(f);
  const queue=await fs.readFile(f.queueFile),month=await fs.readFile(f.monthFile),preserved=await fs.readFile(f.preserved),reads=f.reads.length;
  const result=await runIntegratedRoute('companyId='+ID+'&month='+MONTH,{get:f.service.get});
  assert.equal(result.status,200);assert.equal(result.body.status,'ready');assert.equal(result.body.freshness.selectedMonthVerified,true);
  assert.equal(result.body.snapshot.summary.lodging.sold,1);assert.equal(result.body.snapshot.summary.lodging.estimatedRevenue,100000);
  assert.deepEqual(f.reads.slice(reads),[MONTH,'2026-08'],'the existing scoped source/cache pipeline verifies only the selected and comparison month');
  assert.deepEqual(await fs.readFile(f.queueFile),queue);assert.deepEqual(await fs.readFile(f.monthFile),month);assert.deepEqual(await fs.readFile(f.preserved),preserved);
  const count=f.reads.length;assert.equal((await runIntegratedRoute('companyId='+ID+'&month='+MONTH,{get:f.service.get})).body.status,'ready');
  assert.equal(f.reads.length,count,'the certified unchanged month reuses its exact normal source proof');
});

test('a normal web proof, scoped repair and final proof share one admission after an active background owner releases',async t=>{
  const f=await fixture(t);await staleProof(f);const entered=gate(),proceed=gate(),before=f.scheduler.status().timing.recent.at(-1)?.id||0;
  t.after(()=>proceed.resolve());
  const background=f.scheduler.run(async()=>{entered.resolve();await proceed.promise;},{priority:'background',kind:'industry-build'});
  await entered.promise;
  const reading=runIntegratedRoute('companyId='+ID+'&month='+MONTH,{get:f.service.get});
  for(let attempt=0;attempt<200&&f.scheduler.status().queuedForeground===0;attempt++)await turn();
  assert.equal(f.scheduler.status().activeKind,'industry-build');assert.equal(f.scheduler.status().queuedForeground,1);
  proceed.resolve();await background;assert.equal((await reading).body.status,'ready');
  const records=f.scheduler.status().timing.recent.filter(row=>row.id>before),owners=records.filter(row=>row.priority==='foreground'&&!row.parentId);
  assert.equal(owners.length,1,'the initial proof, selected repair and final proof never readmit between their owned awaits');
  assert.equal(owners[0].kind,'company-selected-month-read');
  const nested=records.filter(row=>row.parentId===owners[0].id).map(row=>row.kind);
  assert.ok(nested.includes('company-month-repair'));assert.ok(nested.includes('company-month-proof-read'));
});

test('saved previews never enter foreground repair even when a direct caller combines verification flags',async t=>{
  const f=await fixture(t);await staleProof(f);const reads=f.reads.length,queue=await fs.readFile(f.queueFile),proof=await fs.readFile(f.proofFile),month=await fs.readFile(f.monthFile);
  const get=f.service.get;
  const preview=await get(ID,{month:MONTH,knownMonthsOnly:true,verifySelectedMonth:true,savedPreview:true});
  assert.equal(preview.freshness.savedPreview,true);assert.equal(preview.freshness.selectedMonthVerified,false);assert.equal(preview.status,'refreshing');
  const web=await runIntegratedRoute('companyId='+ID+'&month='+MONTH+'&view=saved',{get});
  assert.equal(web.body.freshness.savedPreview,true);assert.equal(f.reads.length,reads);
  for(const [file,bytes]of [[f.queueFile,queue],[f.proofFile,proof],[f.monthFile,month]])assert.deepEqual(await fs.readFile(file),bytes);
});

test('normal web verification recalculates genuinely changed evidence and never certifies a source failure as ready',async t=>{
  const f=await fixture(t);await staleProof(f);const queue=await fs.readFile(f.queueFile),preserved=await fs.readFile(f.preserved);
  f.source.observations[0].sold=f.source.observations[0].publicBookings=2;
  f.source.observations[0].estimatedRevenue=f.source.observations[0].publicRevenue=240000;f.state.revision++;
  const view=(await runIntegratedRoute('companyId='+ID+'&month='+MONTH,{get:f.service.get})).body;
  assert.equal(view.status,'ready');assert.equal(view.freshness.selectedMonthVerified,true);assert.equal(view.snapshot.summary.lodging.sold,2);
  assert.equal(view.snapshot.summary.lodging.estimatedRevenue,240000);assert.equal(view.snapshot.daily.find(row=>row.date==='2026-09-04').lodging.sold,null);
  assert.deepEqual(await fs.readFile(f.queueFile),queue);assert.deepEqual(await fs.readFile(f.preserved),preserved);
  const saved=await fs.readFile(f.monthFile),proof=await fs.readFile(f.proofFile);f.state.revision++;f.state.fail=true;
  await assert.rejects(runIntegratedRoute('companyId='+ID+'&month='+MONTH,{get:f.service.get}),{code:'SOURCE_NOT_VERIFIED',statusCode:503});
  assert.deepEqual(await fs.readFile(f.monthFile),saved);assert.deepEqual(await fs.readFile(f.proofFile),proof);assert.deepEqual(await fs.readFile(f.queueFile),queue);
});

test('the web verification option preserves ordinary unobserved-period behavior instead of enabling restricted month discovery',async t=>{
  const f=await fixture(t);
  const normal=await runIntegratedRoute('companyId='+ID+'&month=2026-07',{get:f.service.get});
  assert.equal(normal.body.status,'refreshing');assert.equal(normal.body.snapshot,null);assert.deepEqual(f.reads,[]);
  await assert.rejects(f.service.get(ID,{month:'2026-06',knownMonthsOnly:true}),{code:'MONTH_NOT_OBSERVED',statusCode:400});
});

test('bounded cache-only verification advances only the current proof generation and returns the complete real normal envelope',async t=>{
  const f=await fixture(t,{cached:true});await staleProof(f);
  const reads=f.reads.length,queue=await fs.readFile(f.queueFile),month=await fs.readFile(f.monthFile),preserved=await fs.readFile(f.preserved);
  const cached=await f.service.tryCachedMonth(ID,{month:MONTH});
  assert.ok(cached);assert.equal(cached.status,'ready');assert.equal(cached.freshness.selectedMonthVerified,true);
  assert.deepEqual(cached,await f.service.get(ID,{month:MONTH}),'the fast capability shares the exact normal response formatter');
  assert.equal(f.reads.length,reads,'no raw source or comparison calculation runs');
  assert.equal(cached.snapshot.daily.find(row=>row.date==='2026-09-04').lodging.sold,null);
  for(const[file,bytes]of [[f.queueFile,queue],[f.monthFile,month],[f.preserved,preserved]])assert.deepEqual(await fs.readFile(file),bytes);
  const proof=JSON.parse(await fs.readFile(f.proofFile,'utf8'));assert.equal(proof.generation,(await f.service.status()).jobs[0].generation);
});

test('cache-only verification misses on uncertain revisions, changed reviews, invalid stored bytes, budget and abort without reading raw evidence',async t=>{
  const f=await fixture(t,{cached:true});await staleProof(f);const reads=f.reads.length,proof=await fs.readFile(f.proofFile),month=await fs.readFile(f.monthFile);
  f.state.cachedMetaMiss=true;assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);f.state.cachedMetaMiss=false;
  f.state.cachedRevisionMiss=true;assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);f.state.cachedRevisionMiss=false;
  f.state.revision++;assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);f.state.revision--;
  f.raw.manualCorrection.revision++;assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);f.raw.manualCorrection.revision--;
  const corrupted=JSON.parse(month);corrupted.snapshot.summary.lodging.sold=99;await fs.writeFile(f.monthFile,JSON.stringify(corrupted));
  assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);await fs.writeFile(f.monthFile,month);
  f.state.beforeCachedMetadata=()=>new Promise(resolve=>setTimeout(resolve,5));assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH,budgetMs:1}),null);f.state.beforeCachedMetadata=null;
  const abort=new AbortController();abort.abort();assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH,signal:abort.signal}),null);
  assert.equal(f.reads.length,reads);assert.deepEqual(await fs.readFile(f.proofFile),proof);
});

test('a busy durable queue writer causes an immediate cache-only miss instead of waiting inside a paused owner',async t=>{
  const f=await fixture(t,{cached:true});await staleProof(f);const entered=gate(),proceed=gate(),rename=fs.rename;
  fs.rename=async(from,to)=>{if(to===f.queueFile){entered.resolve();await proceed.promise;}return rename(from,to);};
  const writing=f.service.queueCompany(ID,{months:['2026-12']});
  try{await entered.promise;assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);}
  finally{proceed.resolve();await writing;fs.rename=rename;}
});

test('a source change during cache-only proof publication never returns a current ready envelope',async t=>{
  const f=await fixture(t,{cached:true});await staleProof(f);const reads=f.reads.length,month=await fs.readFile(f.monthFile);let calls=0;
  f.state.beforeCachedRevision=()=>{if(++calls===2)f.state.revision++;};
  assert.equal(await f.service.tryCachedMonth(ID,{month:MONTH}),null);
  assert.equal((await f.service.get(ID,{month:MONTH})).status,'refreshing');assert.equal(f.reads.length,reads);assert.deepEqual(await fs.readFile(f.monthFile),month);
});

test('Korea midnight during cached verification cannot certify the previous current-month cutoff',async t=>{
  const f=await fixture(t,{cached:true});await staleProof(f);await f.service.refreshMonth(ID,{month:'2026-10'});let calls=0;
  f.state.beforeCachedRevision=()=>{if(++calls===2)f.state.now='2026-10-26T00:00:00Z';};
  assert.equal(await f.service.tryCachedMonth(ID,{month:'2026-10'}),null);
  assert.notEqual((await f.service.get(ID,{month:'2026-10'})).status,'ready');
});

test('the real cached source provider and wrapper certify during a background checkpoint without replay or a raw read',async t=>{
  const {createCompanyIntegratedSourceRevision}=require('./lib/company_integrated_source_revision.cjs');
  const {createSourceReadScheduler}=require('./lib/source_read_scheduler.cjs');
  const write=async(root,name,value)=>{const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
  let reader;
  const f=await fixture(t,{configure:async({root,scheduler,company,raw,source,options})=>{
    await write(root,'company_master/companies.json',{companies:{[ID]:{...company,...raw,runIds:['run']}}});
    await write(root,'history/observations.jsonl',source.observations.map(row=>JSON.stringify(row)).join('\n')+'\n');
    await write(root,'company_integrated/capacity-bases.json',{schemaVersion:1,companies:{[ID]:{count:10}}});
    await write(root,'regions.json',{units:[]});await write(root,'outputs/run/manifest.json',{id:'run',collectedAt:'2026-09-01T00:00:00Z',status:'complete'});
    reader=createCompanyIntegratedSourceRevision({dataDir:root,regionMasterFile:path.join(root,'regions.json'),includeContext:false});
    options.readRevision=reader;
    options.catalogCached=async()=>({company:copy(company),raw:copy(raw),data:{runs:copy(source.runs)}});
    options.runCheckpointRead=(operation,settings)=>scheduler.runCheckpointRead(operation,settings);
  }});
  await f.service.queueCompany(ID,{months:[MONTH]});await f.service.refreshMonth(ID,{month:MONTH});
  await f.service.drain();await f.service.queueCompany(ID,{months:['2026-10','2026-11']});
  await reader.prepare();const reads=f.reads.length,queue=await fs.readFile(f.queueFile),month=await fs.readFile(f.monthFile);
  const entered=gate(),proceed=gate(),sourceScheduler=createSourceReadScheduler();let attempts=0;
  t.after(()=>proceed.resolve());
  const background=f.scheduler.run(async()=>{attempts++;entered.resolve();await proceed.promise;await sourceScheduler.checkpoint({priority:'background',kind:'industry-build'});return 'continued';},{priority:'background',kind:'industry-build'});
  await entered.promise;const reading=f.service.get(ID,{month:MONTH,verifySelectedMonth:true});await turn();proceed.resolve();
  const [view,result]=await Promise.all([reading,background]);assert.equal(result,'continued');assert.equal(view.status,'ready');assert.equal(view.freshness.selectedMonthVerified,true);
  assert.equal(attempts,1);assert.equal(f.scheduler.status().timing.restarted,0);assert.equal(f.scheduler.status().timing.checkpointReadCompleted,1);
  assert.equal(f.reads.length,reads,'the real revision cache did not fall back to normal source reads');
  assert.deepEqual(await fs.readFile(f.queueFile),queue);assert.deepEqual(await fs.readFile(f.monthFile),month);
});
