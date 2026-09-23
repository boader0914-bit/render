const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createCollectionReuse,serialExecutor,dayKey,scope,covers}=require('./collection_reuse.cjs');
const payload={keyword:'포천글램핑',checkIn:'2026-09-23',checkOut:'2026-10-23',bookingRangeDays:31,detailRankRanges:'1-20',workerKey:'manual'};
const at='2026-09-23T01:00:00Z';
async function fixture(t) {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'collector-reuse-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  const outputsDir=path.join(dataDir,'outputs');
  let clock=at;
  const options={dataDir,outputsDir,now:()=>new Date(clock),inspect:m=>m?.quality||{status:'failed'}};
  async function artifact(overrides={},name='pocheon_glamping_20260923_100000') {
    const dir=path.join(outputsDir,name);await fs.mkdir(dir,{recursive:true});
    const manifest={...payload,collectedAt:clock,startedAt:clock,quality:{status:'complete'},workerKey:'manual',trigger:'manual',files:['rows.csv'],...overrides};
    await fs.writeFile(path.join(dir,'rows.csv'),'rank,name\n1,test');
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    return {runId:name,output:manifest,collectionQuality:manifest.quality};
  }
  return {options,artifact,create:()=>createCollectionReuse(options),setClock:value=>{clock=value;}};
}
test('KST date and scope coverage retain query semantics',()=>{
  assert.equal(dayKey('2026-09-22T15:01:00Z'),'2026-09-23');
  const broad=scope(payload);
  assert.ok(covers(broad,scope({...payload,detailRankRanges:'2-5'})));
  assert.ok(covers(broad,scope({...payload,bookingRangePlaceLimit:20})), 'a cap covering all selected ranks has identical coverage');
  assert.equal(covers(broad,scope({...payload,checkOut:'2026-09-24',bookingRangeDays:1})),false);
  assert.equal(covers(scope({...payload,detailRankRanges:'1-40',bookingRangePlaceLimit:20}),scope({...payload,detailRankRanges:'21-40',bookingRangePlaceLimit:20})),false);
  for(const change of [{adults:3},{searchScope:'all_lodging'},{detailRankRanges:'1-21'},{bookingRangeDays:32},{keyword:'가평글램핑'}]) assert.equal(covers(broad,scope({...payload,...change})),false);
});
test('two worker requests share one active collection, then persisted artifact is reused',async t=>{
  const f=await fixture(t);let release;let called=0;let joined=0;
  const gate=new Promise(r=>{release=r;});const reuse=createCollectionReuse({...f.options,onJoin:()=>{joined++;}});
  const execute=async()=>{called++;await gate;return f.artifact();};
  const first=reuse.run(payload,execute);
  while(called===0)await new Promise(r=>setImmediate(r));
  const second=reuse.run({...payload,workerKey:'scheduled',trigger:'scheduled'},execute);
  while(joined===0)await new Promise(r=>setImmediate(r));
  release();const [one,two]=await Promise.all([first,second]);
  assert.equal(called,1);assert.equal(two.runId,one.runId);assert.equal(two.reuse.mode,'shared');
  const next=await f.create().run(payload,()=>{throw Error('must not collect');});
  assert.equal(next.reuse.mode,'same_day');assert.equal(next.workerKey,'manual');assert.equal(next.crawlTiming.recorded,false);
});
test('different keywords execute independently while a same-keyword scope conflict is blocked',async t=>{
  const f=await fixture(t);const reuse=f.create();let release;
  const gate=new Promise(r=>{release=r;});let started=false;
  const pending=reuse.run(payload,async()=>{started=true;await gate;return f.artifact();});
  while(!started)await new Promise(r=>setImmediate(r));
  await assert.rejects(reuse.run({...payload,adults:3},()=>{}),{code:'COLLECTION_SCOPE_BUSY'});
  const other=await reuse.run({...payload,keyword:'가평글램핑'},()=>f.artifact({keyword:'가평글램핑'},'gapyeong_glamping_20260923_100000'));
  assert.ok(other.runId);release();await pending;
});
test('partial, failed and missing artifacts cannot be silently collected again',async t=>{
  const f=await fixture(t);const reuse=f.create();
  await reuse.run(payload,()=>f.artifact({quality:{status:'partial'}}));
  await assert.rejects(reuse.run(payload,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
  const result=await reuse.run({...payload,allowRepeat:true,repeatReason:'누락 범위 확인 후 재수집'},()=>f.artifact());
  assert.equal(result.collectionQuality.status,'complete');
  await fs.unlink(path.join(f.options.outputsDir,result.runId,'rows.csv'));
  await assert.rejects(f.create().run(payload,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
});
test('different requested scope requires a reason even with completed data',async t=>{
  const f=await fixture(t);await f.artifact();
  await assert.rejects(f.create().run({...payload,adults:3},()=>{}),{code:'COLLECTION_SCOPE_REVIEW'});
  await assert.rejects(f.create().run({...payload,adults:3,allowRepeat:true,repeatReason:'x'},()=>{}),{code:'COLLECTION_SCOPE_REVIEW'});
});
test('pre-existing partial artifact without a coordinator ledger still requires review',async t=>{
  const f=await fixture(t);await f.artifact({quality:{status:'partial'}});
  await assert.rejects(f.create().run(payload,()=>{throw Error('must not recrawl');}),{code:'COLLECTION_REVIEW_REQUIRED'});
});
test('interrupted durable claim fails closed after restart',async t=>{
  const f=await fixture(t);
  const file=path.join(f.options.dataDir,'history','collection-reuse.json');await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({version:1,entries:[{id:'old',day:'2026-09-23',status:'running',scope:scope(payload)}]}));
  await assert.rejects(f.create().run(payload,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
  assert.equal(JSON.parse(await fs.readFile(file)).entries[0].status,'interrupted');
});
test('an active request survives a KST midnight without duplicate execution',async t=>{
  const f=await fixture(t);let release;let began=false;let joined=0;
  const gate=new Promise(r=>{release=r;});const reuse=createCollectionReuse({...f.options,onJoin:()=>{joined++;}});
  const first=reuse.run(payload,async()=>{began=true;await gate;return f.artifact();});
  while(!began)await new Promise(r=>setImmediate(r));
  f.setClock('2026-09-23T15:01:00Z');
  const second=reuse.run(payload,()=>{throw Error('duplicate');});
  while(!joined)await new Promise(r=>setImmediate(r));release();
  assert.equal((await second).runId,(await first).runId);
});
test('reentrant storage transaction prevents lost updates',async()=>{
  const serial=serialExecutor();let value=0;
  await Promise.all(Array.from({length:30},()=>serial(async()=>{const old=value;await serial(()=>new Promise(r=>setImmediate(r)));value=old+1;})));
  assert.equal(value,30);
});
