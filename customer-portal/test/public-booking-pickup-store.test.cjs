'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createPublicBookingPickupStore}=require('../public-booking-pickup-store.cjs');
const VERSION='public-booking-pickup-ledger-v1',companyId='cmp_place_1460523479',placeId='1460523479',namespace='https://insight.example|central:https://datalab.example';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),clone=value=>JSON.parse(JSON.stringify(value));
function ledger(before=0,after=1){
  return {version:VERSION,companyId,placeId,sources:[27,28].map((day,index)=>{
    const runId='fixture_202610'+day,collectedAt='2026-10-'+day+'T04:00:00Z';
    return {runId,collectedAt,sourceDigest:String(index+1).repeat(64),products:[{bizItemId:'room_a',productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량'}],rows:[{companyId,placeId,runId,collectedAt,bizItemId:'room_a',productType:'lodging',listType:'객실 종류별 리스트',availabilityUnit:'재고수량',date:'2026-10-30',stock:4,bookingCount:index?after:before,responseStatus:200,collectionFailed:false,errorCode:null,stockObserved:true,inventoryObserved:true,inventoryConflict:false,salesEvidence:'bookingCount'}]};})};
}
async function setup(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-public-pickup-test-'));
  t.after(async()=>{
    const resolved=path.resolve(directory),temporary=path.resolve(os.tmpdir())+path.sep;
    if(!resolved.startsWith(temporary)||!path.basename(resolved).startsWith('insight-public-pickup-test-'))throw new Error('Unsafe temporary cleanup target');
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const options={directory,namespace,now:()=>new Date('2026-10-30T10:00:00Z')},folder=path.join(directory,sha(namespace),sha(companyId));
  return {directory,folder,options,store:createPublicBookingPickupStore(options),project:{companyId,month:'2026-10',asOf:'2026-10-30'}};
}
async function files(directory){
  const out={};
  async function walk(current){for(const entry of await fs.readdir(current,{withFileTypes:true})){const absolute=path.join(current,entry.name);if(entry.isDirectory())await walk(absolute);else{const stat=await fs.stat(absolute),bytes=await fs.readFile(absolute);out[path.relative(directory,absolute)]={sha:sha(bytes),size:stat.size,mtimeMs:stat.mtimeMs};}}}
  await walk(directory);return out;
}
test('verified imports persist across process-store restart with source run IDs and signed quantity',async t=>{
  const h=await setup(t);const receipt=await h.store.importLedger(ledger());assert.equal(receipt.companyId,companyId);assert.equal(receipt.sourceCount,2);
  const restarted=createPublicBookingPickupStore(h.options),result=await restarted.project(h.project);
  assert.equal(result.status,'reference');assert.equal(result.publicChange,1);assert.equal(result.previousPublic,0);assert.equal(result.currentPublic,1);assert.equal(result.days,1);assert.equal(result.source.previousRunId,'fixture_20261027');assert.equal(result.source.currentRunId,'fixture_20261028');assert.equal(result.wholeReservationRestored,false);assert.equal(result.inferredChange,null);
  assert.equal(result.rows[0].productEvidence,undefined,'customer projection must not expose original per-product proof rows');
});
test('projection never writes source files, indexes or cache metadata',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const before=await files(h.directory);
  await h.store.project(h.project);await h.store.project({...h.project,month:'2026-11'});await h.store.project({...h.project,asOf:'2026-10-27'});
  assert.deepEqual(await files(h.directory),before);
});
test('the same directory is isolated by backend namespace and company identity',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());
  assert.equal(await createPublicBookingPickupStore({...h.options,namespace:'other-central'}).project(h.project),null);
  assert.equal(await h.store.project({...h.project,companyId:'cmp_place_999'}),null);
  await assert.rejects(h.store.project({...h.project,companyId:'../other'}),{code:'PUBLIC_PICKUP_INVALID_COMPANY'});
});
test('tampered source contents fail closed without returning zero or raw path details',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const index=JSON.parse(await fs.readFile(path.join(h.folder,'index.json'),'utf8')),file=path.join(h.folder,index.sources.at(-1).contentDigest+'.json');
  const value=JSON.parse(await fs.readFile(file,'utf8'));value.source.rows[0].bookingCount=4;await fs.writeFile(file,JSON.stringify(value));
  const result=await h.store.project(h.project);assert.equal(result.status,'unavailable');assert.equal(result.reasonCode,'PUBLIC_PICKUP_STORE_INVALID');assert.equal(result.publicChange,null);assert.equal(result.rows.length,0);assert.doesNotMatch(JSON.stringify(result),/\.json|private|\\|\/var\/data/);
});
for(const mutation of ['invalid_json','wrong_namespace','missing_source_reference','remove_latest'])test('tampered index '+mutation+' fails closed',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const file=path.join(h.folder,'index.json'),index=JSON.parse(await fs.readFile(file,'utf8'));
  if(mutation==='wrong_namespace')index.namespaceDigest='0'.repeat(64);else if(mutation==='missing_source_reference')index.sources.at(-1).contentDigest='0'.repeat(64);else if(mutation==='remove_latest')index.sources.pop();
  await fs.writeFile(file,mutation==='invalid_json'?'{broken':JSON.stringify(index));
  const result=await h.store.project(h.project);assert.equal(result.status,'unavailable');assert.equal(result.publicChange,null);assert.equal(result.reasonCode,'PUBLIC_PICKUP_STORE_INVALID');
});
test('repeated imports are idempotent and do not duplicate immutable files or indexed observations',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const names=Object.keys(await files(h.directory)).sort(),indexBefore=await fs.readFile(path.join(h.folder,'index.json'),'utf8');
  const receipt=await h.store.importLedger(ledger());assert.equal(receipt.sourceCount,2);assert.deepEqual(Object.keys(await files(h.directory)).sort(),names);assert.equal(await fs.readFile(path.join(h.folder,'index.json'),'utf8'),indexBefore);assert.equal((await h.store.project(h.project)).publicChange,1);
});
test('conflicting source import preserves the last normal index and does not poison subsequent queue work',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const indexBefore=await fs.readFile(path.join(h.folder,'index.json'),'utf8'),conflict=ledger();conflict.sources[1].rows[0].bookingCount=3;
  await assert.rejects(h.store.importLedger(conflict),{code:'PUBLIC_PICKUP_SOURCE_CONFLICT'});assert.equal(await fs.readFile(path.join(h.folder,'index.json'),'utf8'),indexBefore);assert.equal((await h.store.project(h.project)).publicChange,1);
  const retry=await h.store.importLedger(ledger());assert.equal(retry.sourceCount,2);
});
test('missing or malformed raw proof cannot create a stored ledger',async t=>{
  const h=await setup(t),input=ledger();delete input.sources[0].rows[0].stockObserved;
  await assert.rejects(h.store.importLedger(input),{code:'PUBLIC_PRODUCT_RESPONSE_UNVERIFIED'});assert.equal(await h.store.project(h.project),null);assert.deepEqual(Object.keys(await files(h.directory)),[]);
});
for(const [before,after,change] of [[2,2,0],[3,1,-2]])test('observed public quantity '+change+' stays signed and never becomes an inferred reservation or revenue',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger(before,after));const result=await h.store.project(h.project);
  assert.equal(result.status,'reference');assert.equal(result.publicChange,change);assert.equal(result.previousPublic,before);assert.equal(result.currentPublic,after);assert.equal(result.inferredChange,null);assert.equal(result.estimatedRevenue,null);assert.equal(result.executionAllowed,false);
});
test('empty imports cannot delete or replace an earlier normal source index',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const before=await fs.readFile(path.join(h.folder,'index.json'),'utf8'),input=ledger();input.sources=[];
  await assert.rejects(h.store.importLedger(input),{code:'PUBLIC_LEDGER_INVALID'});assert.equal(await fs.readFile(path.join(h.folder,'index.json'),'utf8'),before);assert.equal((await h.store.project(h.project)).publicChange,1);
});
test('a changed place binding cannot overwrite an existing company ledger',async t=>{
  const h=await setup(t);await h.store.importLedger(ledger());const input=clone(ledger());input.placeId='999';for(const source of input.sources)for(const row of source.rows)row.placeId='999';
  await assert.rejects(h.store.importLedger(input),error=>['PUBLIC_PICKUP_STORE_CONFLICT','SOURCE_CONTEXT_MISMATCH'].includes(error.code));assert.equal((await h.store.project(h.project)).placeId,placeId);
});
