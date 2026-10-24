'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const {createCompanyReadCache}=require('../company-read-cache.cjs');
const {createCompanySnapshotStore}=require('../company-snapshot-store.cjs');
const AT=Date.parse('2026-10-24T00:00:00Z'),DAY=86400000,NAMESPACE='https://central.example',AUDIENCE='https://insight.example:customer';
// Golden fingerprints taken from the deployed pre-archive display contract.
// Node preserves source line endings in Function.toString(); both existing
// Windows review files and LF production files must remain compatible.
const LEGACY_LF='9a8100c5b9acd46cd346920d15aca17d57d075387c8deea5f1f0cfeb69eb2cc0';
const LEGACY_CRLF='04795abad0760f0b9eba30fd26dbb5d12057c18df24821f3bec1878203c16f74';
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const account=()=>({customer:{customerId:'customer-fixture',revision:1,accountStatus:'active',relations:[{companyId:'cmp_place_1',kind:'own',status:'active'}]},companies:[{companyId:'cmp_place_1',name:'Fixture',version:'v1'}],preparations:[],collectionAllowance:{limit:1,canRequest:true}});
const ok=data=>({status:200,ok:true,data});
function configuredVersion(source){
  const sourceRequire=require('node:module').createRequire(require.resolve('../company-read-cache.cjs'));
  let version;const sandbox={module:{exports:{}},require:name=>name==='./company-snapshot-store.cjs'?{createCompanySnapshotStore:options=>{version=options.version;return {};}}:sourceRequire(name)};
  vm.runInNewContext(source,sandbox,{filename:'company-read-cache.cjs'});
  sandbox.module.exports.createCompanyReadCache({persistenceDirectory:path.resolve(os.tmpdir(),'fixture-unused'),namespace:NAMESPACE});return version;
}
function core(withEvidence=false){
  const source={companyId:'cmp_place_1',runId:'run-observed',date:'2026-10-24',productType:'lodging',collectedAt:'2026-10-24T00:00:00Z',collectedDate:'2026-10-24',runQuality:'complete'};
  return {result:{companyId:'cmp_place_1',runId:withEvidence?'run-new':'run-old',rooms:16},companyDetail:{companyId:'cmp_place_1',basics:{name:'Fixture',rooms:16},integrated:{companyId:'cmp_place_1',source:'company_db_integrated',status:'ready',selectedMonth:'2026-10',calculationVersion:'company-v1',calculatedAt:'2026-10-24T00:00:00Z',snapshot:{period:{start:'2026-10-01',end:'2026-10-31',days:31},summary:{sold:0,estimatedRevenue:null},daily:[{date:'2026-10-24',total:16,sold:0,publicBookings:0,phoneBookings:0,estimatedRevenue:null,missing:false,...(withEvidence?{sourceObservation:source}:{})}],...(withEvidence?{provenance:{source:'company_db_integrated',companyId:'cmp_place_1',calculationVersion:'company-v1',linkageStatus:'complete',runIds:['run-observed'],selectedRunIds:['run-observed'],observations:[source]}}:{})}}}};
}

test('optional archive evidence preserves the exact previously deployed display fingerprints',async()=>{
  const source=await fs.readFile(path.join(__dirname,'..','company-read-cache.cjs'),'utf8');
  assert.equal(configuredVersion(source.replace(/\r\n/g,'\n')),LEGACY_LF);
  assert.equal(configuredVersion(source.replace(/\r?\n/g,'\r\n')),LEGACY_CRLF);
});

test('pre-archive durable snapshots display while new source is held and never gain fabricated archive lineage',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-archive-compat-'));
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-archive-compat-'));await fs.rm(target,{recursive:true,force:true});});
  const sourceText=await fs.readFile(path.join(__dirname,'..','company-read-cache.cjs'),'utf8'),version=configuredVersion(sourceText);
  assert.ok([LEGACY_LF,LEGACY_CRLF].includes(version));
  const identity=account(),slotKey=hash([NAMESPACE,AUDIENCE,identity.customer.customerId,identity.customer.revision,identity.customer.relations[0],identity.companies[0],null,true]);
  const legacy=createCompanySnapshotStore({directory,namespace:NAMESPACE,version,now:()=>AT,minFreeBytes:0,project:value=>value});await legacy.ready();
  assert.equal(await legacy.put({slotKey,month:'2026-10',checkedAt:AT,core:core()}),true);await legacy.flush();
  let resolveSource,sourceCalls=0;const sourcePending=new Promise(resolve=>{resolveSource=resolve;}),captured=[];
  const cache=createCompanyReadCache({persistenceDirectory:directory,namespace:NAMESPACE,now:()=>AT+DAY,onVerifiedSource:async context=>{captured.push(context);}});await cache.ready();
  const views=await cache.snapshot({scope:'new-session',audience:AUDIENCE,identity});assert.equal(views.length,1);assert.equal(views[0].data.result.runId,'run-old');assert.equal(views[0].data.companyDetail.integrated.snapshot.provenance,undefined);assert.equal(captured.length,0);
  const reply=await cache.read({scope:'new-session',audience:AUDIENCE,companyId:'cmp_place_1',readIdentity:async()=>ok(identity),readSource:()=>{sourceCalls++;return sourcePending;}});
  assert.equal(sourceCalls,1);assert.equal(reply.data.result.runId,'run-old');assert.equal(reply.data.responseCache.persisted,true);assert.equal(reply.data.responseCache.refreshing,true);assert.equal(reply.data.responseCache.checkedAt,new Date(AT).toISOString());assert.equal(reply.data.responseCache.validUntil,new Date(AT+7*DAY).toISOString());
  assert.equal(reply.data.companyDetail.integrated.snapshot.daily[0].sold,0);assert.equal(reply.data.companyDetail.integrated.snapshot.daily[0].estimatedRevenue,null);assert.equal(reply.data.companyDetail.integrated.snapshot.daily[0].sourceObservation,undefined);assert.equal(captured.length,0);
  resolveSource(ok(core(true)));await new Promise(resolve=>setImmediate(resolve));await cache.flushPersistence();
  assert.equal(captured.length,1);assert.deepEqual(captured[0].data.companyDetail.integrated.snapshot.provenance.runIds,['run-observed']);
  const next=createCompanyReadCache({persistenceDirectory:directory,namespace:NAMESPACE,now:()=>AT+DAY});await next.ready();const [updated]=await next.snapshot({scope:'another-session',audience:AUDIENCE,identity});assert.equal(updated.data.result.runId,'run-new');assert.deepEqual(updated.data.companyDetail.integrated.snapshot.provenance.runIds,['run-observed']);assert.equal(updated.data.companyDetail.integrated.snapshot.daily[0].sourceObservation.runId,'run-observed');
});
