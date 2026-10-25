'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createCompanyIntegratedDb}=require('./lib/company_integrated_read_db.cjs');
const {createAnalyticalWorkScheduler}=require('./lib/analytical_work_scheduler.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value));
const ID='cmp_read_selected',MONTH='2026-09';
const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

async function fixture(t,{revision=true}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'company-selected-read-')),scheduler=createAnalyticalWorkScheduler(),reads=[];
  const company={companyId:ID,primaryName:'검수 업체',capacity:10,capacitySource:'db_review'},raw={companyId:ID,manualCorrection:{lodgingBasisTotal:10,revision:1}};
  const source={companies:[company],runs:[{id:'run',collectedAt:'2026-09-01T00:00:00Z',collectionQuality:{status:'complete'}}],observations:[{
    companyId:ID,companyKey:ID,runId:'run',collectedAt:'2026-09-01T00:00:00Z',stayDate:'2026-09-03',productType:'lodging',inventoryEvidenceVersion:5,
    supply:10,sold:0,publicBookings:0,phoneBookings:0,publicRevenue:0,phoneRevenue:0,estimatedRevenue:0,missing:false,partial:false,unknownUnavailable:0,phoneMissingPriceBookings:0,
    capacityBasis:{count:10,source:'db_review'}}],rankObservations:[]};
  const state={revision:1,revisionFail:false,fail:false,beforeReturn:null},options={dataDir:root,autoStart:false,now:()=>new Date('2026-10-25T00:00:00Z'),
    runWork:(operation,settings)=>scheduler.run(operation,settings),
    catalog:async()=>({companies:[copy(company)],rawCompanies:new Map([[ID,copy(raw)]]),runs:copy(source.runs)}),
    listTargets:async()=>[{companyId:ID,months:[MONTH,'2026-10','2026-11']}],
    ...(revision?{readRevision:async()=>{if(state.revisionFail)throw Error('private revision error');return hash(String(state.revision));}}:{}),
    loadSources:async request=>{reads.push(request.month);if(state.fail)throw Object.assign(Error('private source path'),{code:'SOURCE_NOT_VERIFIED'});
      await state.beforeReturn?.(request);return copy(source);}};
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
