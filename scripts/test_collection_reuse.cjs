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
test('same-worker requests share one active collection, then persisted artifact is reused',async t=>{
  const f=await fixture(t);let release;let called=0;let joined=0;
  const gate=new Promise(r=>{release=r;});const reuse=createCollectionReuse({...f.options,onJoin:()=>{joined++;}});
  const execute=async()=>{called++;await gate;return f.artifact();};
  const first=reuse.run(payload,execute);
  while(called===0)await new Promise(r=>setImmediate(r));
  const second=reuse.run({...payload,trigger:'scheduled'},execute);
  while(joined===0)await new Promise(r=>setImmediate(r));
  release();const [one,two]=await Promise.all([first,second]);
  assert.equal(called,1);assert.equal(two.runId,one.runId);assert.equal(two.reuse.mode,'shared');
  const next=await f.create().run(payload,()=>{throw Error('must not collect');});
  assert.equal(next.reuse.mode,'same_day');assert.equal(next.workerKey,'manual');assert.equal(next.crawlTiming.recorded,false);
});
test('same-keyword collections in three workers execute independently while one remains active',async t=>{
  const f=await fixture(t);let release,started=false;const calls=[];
  const gate=new Promise(r=>{release=r;});
  const reuse=createCollectionReuse({...f.options,onJoin:()=>{throw Error('another worker must not join');}});
  const first=reuse.run(payload,async()=>{started=true;calls.push('manual');await gate;return f.artifact();});
  while(!started)await new Promise(r=>setImmediate(r));
  try {
    for(const workerKey of ['web','scheduled']) {
      const next=await reuse.run({...payload,workerKey,adults:workerKey==='web'?3:2},async()=>{
        calls.push(workerKey);return f.artifact({workerKey},`pocheon_${workerKey}_glamping_20260923_100000`);
      });
      assert.equal(next.reused,undefined);
      assert.equal(next.runId,`pocheon_${workerKey}_glamping_20260923_100000`);
    }
    assert.deepEqual(calls,['manual','web','scheduled']);
    await assert.rejects(reuse.run({...payload,adults:3},()=>{}),{code:'COLLECTION_SCOPE_BUSY'});
  } finally {release();await first;}
});
test('failed and blocked history is isolated by worker and stays isolated after restart',async t=>{
  for(const sourceWorker of ['manual','web','scheduled']) for(const errorCode of ['COLLECTOR_PROVIDER_BLOCKED','COLLECTOR_CRAWL_FAILED']) {
    await t.test(`${sourceWorker} ${errorCode}`,async t=>{
      const f=await fixture(t),request={...payload,workerKey:sourceWorker};
      await assert.rejects(f.create().run(request,async()=>{throw Object.assign(Error('fixture'),{code:errorCode});}),{code:errorCode});
      await assert.rejects(f.create().run(request,()=>{throw Error('same worker cannot retry silently');}),{code:'COLLECTION_REVIEW_REQUIRED'});
      for(const workerKey of ['manual','web','scheduled'].filter(key=>key!==sourceWorker)) {
        let called=0;
        const result=await f.create().run({...payload,workerKey},async()=>{
          called++;return f.artifact({workerKey},`pocheon_${workerKey}_glamping_20260923_100000`);
        });
        assert.equal(called,1);assert.equal(result.reused,undefined);
      }
      const saved=JSON.parse(await fs.readFile(path.join(f.options.dataDir,'history','collection-reuse.json'))).entries;
      assert.equal(saved[0].workerKey,sourceWorker);assert.equal(saved[0].errorCode,errorCode);
      assert.equal(saved[0].status,errorCode.includes('BLOCK')?'blocked':'failed');
      await assert.rejects(f.create().run(request,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'},'other successes cannot erase the original worker failure');
    });
  }
});
test('completed and incomplete artifacts from another worker neither satisfy nor prevent a collection',async t=>{
  for(const sourceWorker of ['manual','web','scheduled']) for(const status of ['complete','partial','blocked','failed']) {
    await t.test(`${sourceWorker} ${status}`,async t=>{
      const f=await fixture(t);
      const source=await f.artifact({workerKey:sourceWorker,quality:{status}},`pocheon_${sourceWorker}_glamping_20260923_100000`);
      const sourceFile=path.join(f.options.outputsDir,source.runId,'manifest.json');
      const original=await fs.readFile(sourceFile,'utf8');
      for(const workerKey of ['manual','web','scheduled'].filter(key=>key!==sourceWorker)) {
        let called=0;
        const result=await f.create().run({...payload,workerKey},async()=>{
          called++;return f.artifact({workerKey},`pocheon_${workerKey}_glamping_20260923_100000`);
        });
        assert.equal(called,1);assert.equal(result.reused,undefined);
        const reused=await f.create().run({...payload,workerKey},()=>{throw Error('same-worker artifact should be reused');});
        assert.equal(reused.reused,true);assert.equal(reused.workerKey,workerKey);assert.equal(reused.runId,result.runId);
      }
      assert.equal(await fs.readFile(sourceFile,'utf8'),original,'source artifacts remain untouched');
      if(status==='complete') {
        const result=await f.create().run({...payload,workerKey:sourceWorker},()=>{throw Error('same-worker complete should be reused');});
        assert.equal(result.runId,source.runId);
      } else await assert.rejects(f.create().run({...payload,workerKey:sourceWorker},()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
    });
  }
});
test('unknown legacy worker provenance cannot hold or satisfy any current worker',async t=>{
  const f=await fixture(t),file=path.join(f.options.dataDir,'history','collection-reuse.json');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({version:1,entries:['failed','blocked','running','complete'].map(status=>({
    id:`legacy-${status}`,day:'2026-09-23',status,scope:scope(payload)
  }))}));
  const source=await f.artifact({workerKey:undefined});
  const sourceFile=path.join(f.options.outputsDir,source.runId,'manifest.json'),original=await fs.readFile(sourceFile,'utf8');
  for(const workerKey of ['manual','web','scheduled']) {
    let called=0;
    const result=await f.create().run({...payload,workerKey},async()=>{
      called++;return f.artifact({workerKey},`pocheon_${workerKey}_glamping_20260923_100000`);
    });
    assert.equal(called,1);assert.equal(result.reused,undefined);
  }
  assert.equal(await fs.readFile(sourceFile,'utf8'),original);
  const entries=JSON.parse(await fs.readFile(file,'utf8')).entries;
  assert.equal(entries.find(row=>row.id==='legacy-running').status,'interrupted');
  assert.ok(entries.filter(row=>row.id.startsWith('legacy-')).every(row=>!Object.hasOwn(row,'workerKey')),'do not invent provenance for legacy rows');
});
test('a missing worker on a new request keeps the existing manual default',async t=>{
  const f=await fixture(t);let called=0;
  const first=await f.create().run({...payload,workerKey:undefined},async()=>{called++;return f.artifact();});
  const second=await f.create().run(payload,()=>{throw Error('manual duplicate');});
  assert.equal(called,1);assert.equal(second.runId,first.runId);assert.equal(second.reused,true);
  const entries=JSON.parse(await fs.readFile(path.join(f.options.dataDir,'history','collection-reuse.json'),'utf8')).entries;
  assert.equal(entries[0].workerKey,'manual');
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
  await fs.writeFile(file,JSON.stringify({version:1,entries:[{id:'old',day:'2026-09-23',workerKey:'manual',status:'running',scope:scope(payload)}]}));
  await assert.rejects(f.create().run(payload,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
  assert.equal(JSON.parse(await fs.readFile(file)).entries[0].status,'interrupted');
  const result=await f.create().run({...payload,workerKey:'web'},()=>f.artifact({workerKey:'web'}));
  assert.equal(result.collectionQuality.status,'complete');
  await assert.rejects(f.create().run(payload,()=>{}),{code:'COLLECTION_REVIEW_REQUIRED'});
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

test('recovery scope selects the unique upload failure within the original request-to-job interval',async t=>{
  const f=await fixture(t);const reuse=f.create();
  const fail=code=>async()=>{throw Object.assign(Error('fixture'),{code});};
  await assert.rejects(reuse.run(payload,fail('COLLECTOR_UPLOAD_FAILED')),{code:'COLLECTOR_UPLOAD_FAILED'});
  f.setClock('2026-09-23T01:01:00Z');
  await assert.rejects(reuse.run({...payload,workerKey:'scheduled',allowRepeat:true,repeatReason:'검증용 별도 실행'},fail('COLLECTOR_UPLOAD_FAILED')),{code:'COLLECTOR_UPLOAD_FAILED'});
  f.setClock('2026-09-23T01:02:00Z');
  await assert.rejects(reuse.run({...payload,allowRepeat:true,repeatReason:'검증용 별도 실행'},fail('COLLECTOR_CRAWL_FAILED')),{code:'COLLECTOR_CRAWL_FAILED'});
  f.setClock('2026-09-23T01:03:00Z');
  await assert.rejects(reuse.run({...payload,keyword:'가평글램핑'},fail('COLLECTOR_UPLOAD_FAILED')),{code:'COLLECTOR_UPLOAD_FAILED'});
  const target={...payload,bookingRangeDays:7,detailRankRanges:'1-5',adults:3};
  f.setClock('2026-09-23T01:04:00Z');
  await assert.rejects(reuse.run({...target,allowRepeat:true,repeatReason:'복구 범위 검증'},fail('COLLECTOR_UPLOAD_FAILED')),{code:'COLLECTOR_UPLOAD_FAILED'});
  const query={keyword:'  포천글램핑  ',workerKey:'manual',createdAt:'2026-09-23T01:00:00.001Z',jobCreatedAt:'2026-09-23T01:04:00Z'};
  const filename=path.join(f.options.dataDir,'history','collection-reuse.json');
  const before=await fs.readFile(filename,'utf8');
  const found=await reuse.recoveryScope(query);
  assert.deepEqual(found,scope(target));
  found.ranks.push(999);found.adults=999;
  assert.deepEqual(await reuse.recoveryScope(query),scope(target),'returned scope must not mutate stored evidence');
  assert.deepEqual(await f.create().recoveryScope(query),scope(target));
  assert.equal(await fs.readFile(filename,'utf8'),before,'scope review must not rewrite failure receipts');
});

test('recovery scope fails closed for ambiguous, absent, outside-window and invalid-time matches',async t=>{
  const f=await fixture(t);const reuse=f.create();
  const fail=async()=>{throw Object.assign(Error('fixture'),{code:'COLLECTOR_UPLOAD_FAILED'});};
  await assert.rejects(reuse.run(payload,fail),{code:'COLLECTOR_UPLOAD_FAILED'});
  f.setClock('2026-09-23T01:01:00Z');
  await assert.rejects(reuse.run({...payload,allowRepeat:true,repeatReason:'중복 판정 검증'},fail),{code:'COLLECTOR_UPLOAD_FAILED'});
  const query={keyword:payload.keyword,workerKey:'manual',createdAt:at,jobCreatedAt:'2026-09-23T01:01:00Z'};
  for(const change of [{},{keyword:'없는키워드'},{workerKey:'scheduled'},
    {createdAt:'2026-09-23T01:02:00Z',jobCreatedAt:'2026-09-23T01:03:00Z'},
    {createdAt:'2026-09-23T00:58:00Z',jobCreatedAt:'2026-09-23T00:59:00Z'},
    {createdAt:'2026-09-23T01:02:00Z',jobCreatedAt:at},{createdAt:'invalid'},{jobCreatedAt:'invalid'}]){
    await assert.rejects(reuse.recoveryScope({...query,...change}),{code:'COLLECTION_RECOVERY_SCOPE_UNCONFIRMED'});
  }
  assert.deepEqual(await reuse.recoveryScope({...query,jobCreatedAt:at}),scope(payload),'interval endpoints are inclusive');
});

test('legacy recovery lookup preserves its missing mode and original key order without rewriting evidence',async t=>{
  const f=await fixture(t),file=path.join(f.options.dataDir,'history','collection-reuse.json');
  const legacy=scope(payload);delete legacy.dayUseMode;
  const storedScope=Object.fromEntries(Object.entries(legacy).reverse());
  const stored=JSON.stringify({version:1,entries:[{id:'legacy-upload',day:'2026-09-23',status:'failed',errorCode:'COLLECTOR_UPLOAD_FAILED',workerKey:'manual',createdAt:at,scope:storedScope}]});
  await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,stored);
  const found=await f.create().recoveryScope({keyword:payload.keyword,workerKey:'manual',createdAt:at,jobCreatedAt:at});
  assert.deepEqual(found,storedScope);assert.equal(Object.hasOwn(found,'dayUseMode'),false);
  assert.equal(await fs.readFile(file,'utf8'),stored);
});
