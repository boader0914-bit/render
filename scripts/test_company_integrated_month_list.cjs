'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createCompanyIntegratedDb}=require('./lib/company_integrated_db.cjs');
const {createCollectionResults}=require('./lib/insight_collection_results.cjs');
async function fixture(t,index,targets=[]) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'integrated-month-list-')),companyId='test-own',directory=path.join(root,'company_integrated',crypto.createHash('sha256').update(companyId).digest('hex'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('integrated-month-list-'));await fs.rm(root,{recursive:true,force:true});});
  if(index){await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'index.json'),JSON.stringify(index));}
  const calls={sources:0,targets:0,revision:0,catalog:0};
  const db=createCompanyIntegratedDb({dataDir:root,autoStart:false,catalog:async options=>{calls.catalog++;assert.equal(options.savedPreview,true);return {companies:[{companyId,capacity:16}],rawCompanies:new Map([[companyId,{}]]),runs:[]};},
    loadSources:async()=>{calls.sources++;assert.fail('month enumeration must not load observations');},
    listTargets:async input=>{calls.targets++;assert.deepEqual(input,{companyIds:[companyId]});return targets;},
    readRevision:async()=>{calls.revision++;assert.fail('month enumeration must not verify or rebuild revisions');}});
  return {root,directory,db,calls};
}
test('stored company-month enumeration reads only catalog and index without queue initialization or calculation',async t=>{
  const f=await fixture(t,{schemaVersion:1,companyId:'test-own',months:['2026-10','2026-09','2026-09']});
  const before=await fs.readFile(path.join(f.directory,'index.json'));
  assert.deepEqual(await f.db.listMonths('test-own'),[{month:'2026-09',status:'stored'},{month:'2026-10',status:'stored'}]);
  assert.deepEqual(f.calls,{sources:0,targets:0,revision:0,catalog:1});
  assert.deepEqual(await fs.readFile(path.join(f.directory,'index.json')),before);
  assert.deepEqual(await fs.readdir(path.join(f.root,'company_integrated')),[path.basename(f.directory)]);
});
test('a missing company-month index discovers existing raw target metadata without calculating or writing an empty index',async t=>{
  const f=await fixture(t,null,[{companyId:'another-company',months:['2025-01']},{companyId:'test-own',months:['2026-09','2026-10']}]);
  assert.deepEqual(await f.db.listMonths('test-own'),[{month:'2026-09',status:'pending'},{month:'2026-10',status:'pending'}]);
  assert.deepEqual(f.calls,{sources:0,targets:1,revision:0,catalog:1});assert.deepEqual(await fs.readdir(f.root),[]);
});
test('invalid or cross-company month indexes are rejected without falling back to another company',async t=>{
  for(const index of [{schemaVersion:1,companyId:'foreign',months:['2026-09']},{schemaVersion:1,companyId:'test-own',months:['not-a-month']}]) {
    const f=await fixture(t,index);await assert.rejects(f.db.listMonths('test-own'));assert.equal(f.calls.targets,0);assert.equal(f.calls.sources,0);
  }
});
test('customer month-list discovery uses its dedicated index callback without joining a heavy detail lease',async()=>{
  let reads=0;
  const reader=createCollectionResults({catalog:async()=>({companies:[{companyId:'test-own'}]}),runWork:()=>assert.fail('index-only month lists must not wait for an analytical lease'),
    readIntegrated:()=>assert.fail('normal integrated reader not allowed for enumeration'),readCompanyDetail:()=>assert.fail('company source body not allowed for enumeration'),
    readIntegratedMonths:async id=>{reads++;assert.equal(id,'test-own');return [{month:'2026-10',status:'ready'},{month:'2026-09',status:'ready'},{month:'2026-09',status:'ready'}];}});
  const [first,second]=await Promise.all([reader.companyMonths('test-own'),reader.companyMonths('test-own')]);
  assert.deepEqual(first,[{month:'2026-09',status:'ready'},{month:'2026-10',status:'ready'}]);assert.deepEqual(second,first);assert.equal(reads,1);
  assert.deepEqual(await reader.companyMonths('unregistered'),[]);assert.equal(reads,1);
});
