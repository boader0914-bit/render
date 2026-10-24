'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {createArchiveStore}=require('../archive-store.cjs');
const AT=Date.parse('2026-10-24T00:00:00Z'),DAY=86400000;
const input=(extra={})=>({kind:'daily-review',ownerId:'customer-a',audience:'customer',period:{from:'2026-10-24',to:'2026-11-22'},identity:{companyId:'cmp_place_1',runIds:['run-1'],calculationVersion:'company-v1'},payload:{roomCount:16,reservedRooms:0,revenue:null,sourceStatus:'verified'},metadata:{reviewStatus:'accepted'},idempotencyKey:'daily-review-run-1-v1',...extra});
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-archive-test-'));let now=AT;
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-archive-test-'));await fs.rm(target,{recursive:true,force:true});});
  const config={directory,namespace:'https://central.example',clock:()=>now,minFreeBytes:0,...options},store=createArchiveStore(config);await store.ready();
  return {directory,config,store,advance(ms){now+=ms;},restart:()=>createArchiveStore(config),async files(){return (await fs.readdir(directory)).filter(name=>name.endsWith('.json'));},async file(){return path.join(directory,(await this.files())[0]);}};
}
const readFor=(store,id,extra={})=>store.get({ownerId:'customer-a',audience:'customer',id,...extra});
const listFor=(store,extra={})=>store.list({ownerId:'customer-a',audience:'customer',...extra});

test('immutable daily and published records survive a year and restart without expiry or payload indexes',async t=>{
  const f=await fixture(t),first=await f.store.put(input());assert.equal(first.created,true);assert.equal(first.record.createdAt,new Date(AT).toISOString());assert.equal(first.record.payload,undefined);
  const report=await f.store.put(input({kind:'published-report',period:{type:'monthly',month:'2026-10'},idempotencyKey:'report-202610-v1',payload:{title:'2026년 10월',estimatedRevenue:1230000}}));
  const weekly=await f.store.put(input({kind:'published-report',period:{type:'weekly',from:'2026-10-19',to:'2026-10-25'},idempotencyKey:'weekly-v1',payload:{title:'주간 리포트'}}));
  await f.store.flush();f.advance(365*DAY);const next=f.restart();await next.ready();
  const restored=await readFor(next,first.record.id);assert.equal(restored.createdAt,first.record.createdAt);assert.equal(restored.payload.reservedRooms,0);assert.equal(restored.payload.revenue,null);assert.deepEqual(restored.identity.runIds,['run-1']);assert.equal(restored.identity.calculationVersion,'company-v1');
  restored.payload.roomCount=999;assert.equal((await readFor(next,first.record.id)).payload.roomCount,16);
  const records=await listFor(next);assert.equal(records.length,3);assert.ok(records.every(record=>!('payload' in record)));assert.equal((await listFor(next,{kind:'published-report'})).length,2);
  assert.equal((await readFor(next,report.record.id)).payload.estimatedRevenue,1230000);assert.equal((await readFor(next,weekly.record.id)).period.type,'weekly');assert.equal(next.status().persistedWrites,0);assert.equal(next.status().entries,3);
});

test('same-key concurrent retries commit exactly once and changing content cannot overwrite',async t=>{
  const f=await fixture(t),results=await Promise.all(Array.from({length:20},()=>f.store.put(input())));assert.equal(results.filter(result=>result.created).length,1);assert.equal(new Set(results.map(result=>result.record.id)).size,1);assert.equal((await f.files()).length,1);
  const before=await fs.readFile(await f.file(),'utf8');f.advance(DAY);
  const repeated=await f.store.put(input());assert.equal(repeated.created,false);assert.equal(repeated.record.createdAt,new Date(AT).toISOString());
  await assert.rejects(f.store.put(input({payload:{roomCount:999}})),{code:'ARCHIVE_IDEMPOTENCY_CONFLICT'});assert.equal(await fs.readFile(await f.file(),'utf8'),before);
});

test('two independent store instances use atomic no-overwrite commits',async t=>{
  const f=await fixture(t),other=f.restart();await other.ready();const pair=await Promise.all([f.store.put(input()),other.put(input())]);assert.equal(pair.filter(row=>row.created).length,1);assert.equal(pair[0].record.id,pair[1].record.id);assert.equal((await f.files()).length,1);
});

test('new calculation/source keys preserve previous versions and default keys are content-addressed',async t=>{
  const f=await fixture(t),v1=await f.store.put(input());f.advance(1);
  const v2=await f.store.put(input({idempotencyKey:'run-1-v2',identity:{companyId:'cmp_place_1',runIds:['run-1'],calculationVersion:'company-v2'},payload:{roomCount:16,reservedRooms:2,revenue:300000}}));
  assert.notEqual(v1.record.id,v2.record.id);assert.equal((await readFor(f.store,v1.record.id)).payload.reservedRooms,0);assert.equal((await readFor(f.store,v2.record.id)).payload.reservedRooms,2);
  const withoutKey=input();delete withoutKey.idempotencyKey;const a=await f.store.put(withoutKey),b=await f.store.put(withoutKey);assert.equal(a.record.id,b.record.id);assert.equal(b.created,false);assert.equal((await listFor(f.store)).length,3);
});

test('owner, audience and namespace never leak records; filenames and files contain no raw owner or audience',async t=>{
  const f=await fixture(t),saved=await f.store.put(input());assert.deepEqual(await listFor(f.store,{ownerId:'customer-b'}),[]);assert.deepEqual(await listFor(f.store,{audience:'admin-preview'}),[]);
  assert.equal(await readFor(f.store,saved.record.id,{ownerId:'customer-b'}),null);assert.equal(await readFor(f.store,saved.record.id,{audience:'admin-preview'}),null);
  const other=createArchiveStore({...f.config,namespace:'https://other.example'});await other.ready();assert.deepEqual(await listFor(other),[]);assert.equal(await readFor(other,saved.record.id),null);
  const a=await f.store.put(input({ownerId:'customer-b'})),b=await f.store.put(input({audience:'admin-preview'}));assert.notEqual(a.record.id,saved.record.id);assert.notEqual(b.record.id,saved.record.id);
  for(const name of await f.files()){const raw=await fs.readFile(path.join(f.directory,name),'utf8');assert.doesNotMatch(name,/customer|admin-preview|central/);assert.doesNotMatch(raw,/customer-a|customer-b|admin-preview|https:\/\/central/);}
});

for(const [label,mutate] of [['truncated',()=>'{"format":'],['checksum',value=>({...value,payload:{roomCount:999}})],['namespace',value=>({...value,namespaceHash:'0'.repeat(64)})]])
test('tampered '+label+' records are rejected both during reads and restart without deletion',async t=>{
  const f=await fixture(t),saved=await f.store.put(input()),file=await f.file(),raw=JSON.parse(await fs.readFile(file,'utf8')),broken=mutate(raw);await fs.writeFile(file,typeof broken==='string'?broken:JSON.stringify(broken));
  await assert.rejects(readFor(f.store,saved.record.id),error=>/^ARCHIVE_(CHECKSUM|INVALID_RECORD)$/.test(error.code));const next=f.restart();await next.ready();assert.deepEqual(await listFor(next),[]);assert.ok(next.status().readFailures>0);assert.equal((await f.files()).length,1);
  await assert.rejects(next.put(input()),error=>/^ARCHIVE_(CHECKSUM|INVALID_RECORD)$/.test(error.code));assert.equal((await f.files()).length,1);
});

test('low-space writes preserve all existing versions and failed temporary writes do not claim success',async t=>{
  let free=1024*1024;const f=await fixture(t,{minFreeBytes:1024,statfs:async()=>({bavail:free,bsize:1})}),saved=await f.store.put(input()),file=await f.file(),raw=await fs.readFile(file,'utf8');free=1024;
  await assert.rejects(f.store.put(input({idempotencyKey:'next'})),{code:'ARCHIVE_LOW_SPACE'});assert.equal(f.store.status().persistedWrites,1);assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal((await readFor(f.store,saved.record.id)).payload.roomCount,16);assert.deepEqual((await fs.readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
});

test('oversized, unsafe and secret-bearing payloads are refused without removing accepted records',async t=>{
  const f=await fixture(t,{maxRecordBytes:4096});await f.store.put(input());
  await assert.rejects(f.store.put(input({idempotencyKey:'large',payload:{text:'x'.repeat(4096)}})),{code:'ARCHIVE_OVERSIZED'});
  for(const payload of [{token:'secret'},{nested:{api_key:'secret'}},{sessionCookie:'secret'},{guestName:'private person'},{guestPhone:'010-0000-0000'}])await assert.rejects(f.store.put(input({idempotencyKey:'secret',payload})),{code:'ARCHIVE_SENSITIVE_FIELD'});
  const loop={};loop.self=loop;await assert.rejects(f.store.put(input({payload:loop})),{code:'ARCHIVE_INVALID_RECORD'});await assert.rejects(f.store.put(input({payload:{price:Infinity}})),{code:'ARCHIVE_INVALID_RECORD'});assert.equal((await f.files()).length,1);
});

test('disabled persistence cannot silently accept a write and invalid paths/IDs cannot escape the archive',async t=>{
  const disabled=createArchiveStore();await disabled.ready();assert.equal(disabled.status().enabled,false);assert.equal(disabled.status().available,false);await assert.rejects(disabled.put(input()),{code:'ARCHIVE_DISABLED'});
  assert.throws(()=>createArchiveStore({directory:'../archive'}),/absolute archive/);
  const f=await fixture(t);await assert.rejects(readFor(f.store,'../outside.json'),{code:'ARCHIVE_INVALID_ID'});await assert.rejects(listFor(f.store,{limit:1001}),{code:'ARCHIVE_INVALID_RANGE'});
  const escaped=await f.store.put(input({ownerId:'../../outside',audience:'../admin'}));assert.equal((await f.files()).length,1);assert.match(escaped.record.id,/^[a-f0-9]{64}$/);assert.equal(await readFor(f.store,escaped.record.id),null);
});

test('a symlinked archive directory is rejected without writing the target',async t=>{
  const f=await fixture(t),target=path.join(f.directory,'real'),link=path.join(f.directory,'linked');await fs.mkdir(target);
  try{await fs.symlink(target,link,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Directory symlink permission unavailable');return;}throw error;}
  const unsafe=createArchiveStore({...f.config,directory:link});await unsafe.ready();assert.equal(unsafe.status().available,false);assert.equal(unsafe.status().lastError,'ARCHIVE_UNSAFE_PATH');await assert.rejects(unsafe.put(input()),{code:'ARCHIVE_UNSAFE_PATH'});assert.deepEqual(await fs.readdir(target),[]);
});

test('a replaced record path cannot follow a directory link or overwrite its destination',async t=>{
  const f=await fixture(t),saved=await f.store.put(input()),file=await f.file(),outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'sentinel'),'untouched');await fs.rename(file,file+'.backup');
  try{await fs.symlink(outside,file,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Directory symlink permission unavailable');return;}throw error;}
  await assert.rejects(readFor(f.store,saved.record.id),{code:'ARCHIVE_UNSAFE_PATH'});await assert.rejects(f.store.put(input()),{code:'ARCHIVE_UNSAFE_PATH'});assert.equal(await fs.readFile(path.join(outside,'sentinel'),'utf8'),'untouched');
  const next=f.restart();await next.ready();assert.deepEqual(await listFor(next),[]);assert.equal(next.status().lastError,'ARCHIVE_UNSAFE_PATH');
});

test('list supports exact period filters and bounded pagination while retaining every record',async t=>{
  const f=await fixture(t);for(let n=0;n<5;n++){f.advance(1);await f.store.put(input({idempotencyKey:'version-'+n,period:{month:n<3?'2026-10':'2026-11'}}));}
  const list=await listFor(f.store,{limit:2});assert.equal(list.length,2);const second=await listFor(f.store,{limit:2,offset:2});assert.equal(second.length,2);assert.notEqual(second[0].id,list[0].id);
  assert.equal((await listFor(f.store,{period:{month:'2026-10'}})).length,3);assert.equal((await f.files()).length,5);assert.equal(f.store.status().entries,5);
});
