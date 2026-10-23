'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createCompanySnapshotStore}=require('../company-snapshot-store.cjs');
const AT=Date.parse('2026-10-23T00:00:00Z'),DAY=86400000,SLOT='a'.repeat(64),OTHER='b'.repeat(64);
const core=(rooms=0)=>({result:{companyId:'a',rooms,price:null},companyDetail:null});
const project=value=>value?.result&&typeof value.result.companyId==='string'?{result:{companyId:value.result.companyId,rooms:value.result.rooms,price:value.result.price},companyDetail:null}:null;
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const checksum=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-company-store-'));let now=AT;
  t.after(async()=>{const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('insight-company-store-'));await fs.rm(target,{recursive:true,force:true});});
  const config={directory,namespace:'https://central.example',now:()=>now,minFreeBytes:0,project,...options},store=createCompanySnapshotStore(config);await store.ready();
  const put=(target=store,extra={})=>target.put({slotKey:SLOT,month:'2026-10',checkedAt:now,core:core(),...extra});
  return {directory,config,store,put,restart:()=>createCompanySnapshotStore(config),advance(ms){now+=ms;},files:()=>fs.readdir(directory),async envelope(){const name=(await fs.readdir(directory)).find(name=>name.endsWith('.json'));return {name,value:JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))};}};
}

test('successful atomic records survive restart with original clocks, zeros and nulls and contain no unknown fields',async t=>{
  const f=await fixture(t),data=core();data.token='private-token';data.result.cookie='private-cookie';assert.equal(await f.put(f.store,{core:data}),true);await f.store.flush();
  const {name,value}=await f.envelope();assert.doesNotMatch(JSON.stringify(value),/private-|token|cookie/);assert.match(name,/^company-[a-f0-9]{32}-[a-f0-9]{64}\.json$/);
  const next=f.restart();f.advance(DAY);await next.ready();const saved=next.get(SLOT,'2026-10');assert.equal(saved.checkedAt,AT);assert.equal(saved.validUntil,AT+7*DAY);assert.equal(saved.core.result.rooms,0);assert.equal(saved.core.result.price,null);
  saved.core.result.rooms=999;assert.equal(next.get(SLOT,'2026-10').core.result.rooms,0);assert.equal(next.status().persistedWrites,0);
});

test('slot key, month, canonical backend and schema boundaries never restore another cache',async t=>{
  const f=await fixture(t);await f.put();assert.equal(f.store.get(OTHER,'2026-10'),null);assert.equal(f.store.get(SLOT,'2026-09'),null);
  for(const option of [{namespace:'https://other.example'},{version:'company-v2'}]){const next=createCompanySnapshotStore({...f.config,...option});await next.ready();assert.equal(next.get(SLOT,'2026-10'),null);}
  assert.deepEqual(f.store.list([OTHER]),[]);assert.deepEqual(f.store.list(undefined),[]);assert.equal(f.store.list([SLOT],{limit:1})[0].slotKey,SLOT);
  assert.equal(await f.put(f.store,{slotKey:'../a'}),false);assert.equal(await f.put(f.store,{month:'2026-13'}),false);
  for(const namespace of ['https://user:secret@central.example','https://central.example/path','https://central.example?token=secret','http://untrusted.example'])assert.throws(()=>createCompanySnapshotStore({...f.config,namespace}),/canonical backend/);
});

for(const [label,mutate] of [
  ['truncated',()=>'{"format":'],
  ['checksum',value=>({...value,core:core(999)})],
  ['namespace',value=>({...value,namespace:'https://other.example'})],
  ['version',value=>({...value,version:'wrong-version'})],
  ['future',value=>({...value,checkedAt:AT+1,validUntil:AT+1+7*DAY})],
  ['wrong-month',value=>({...value,month:'2026-09'})],
  ['wrong-slot',value=>({...value,slotKey:OTHER})]
])test('corrupt '+label+' files never restore or reset the saved timestamp',async t=>{
  const f=await fixture(t);await f.put();const {name,value}=await f.envelope();let broken=mutate(value);
  if(typeof broken==='object'&&label!=='checksum'){const {checksum:ignored,...payload}=broken;broken={...payload,checksum:checksum(payload)};}
  await fs.writeFile(path.join(f.directory,name),typeof broken==='string'?broken:JSON.stringify(broken));const next=f.restart();await next.ready();assert.equal(next.get(SLOT,'2026-10'),null);assert.ok(next.status().readFailures>0);
});

test('expiry is fixed and neither reads nor startup make old records fresh again',async t=>{
  const f=await fixture(t);await f.put();f.advance(7*DAY-1);assert.equal(f.store.get(SLOT,'2026-10').checkedAt,AT);f.advance(1);assert.equal(f.store.get(SLOT,'2026-10'),null);
  const next=f.restart();await next.ready();assert.equal(next.get(SLOT,'2026-10'),null);assert.equal(await f.put(next,{checkedAt:AT}),false);
});

test('last-started tickets and revoked commit guards prevent superseded disk writes',async t=>{
  const f=await fixture(t),old=f.store.begin(SLOT,'2026-10'),latest=f.store.begin(SLOT,'2026-10');
  assert.equal(await f.put(f.store,{ticket:latest,core:core(16)}),true);assert.equal(await f.put(f.store,{ticket:old,core:core(999)}),false);
  assert.equal(await f.put(f.store,{guard:()=>false,core:core(999)}),false);const next=f.restart();await next.ready();assert.equal(next.get(SLOT,'2026-10').core.result.rooms,16);
});

test('low disk space and oversized writes preserve the previous file and cannot claim persisted success',async t=>{
  const f=await fixture(t);await f.put();const {name,value}=await f.envelope();
  const full=createCompanySnapshotStore({...f.config,minFreeBytes:Number.MAX_SAFE_INTEGER});await full.ready();assert.equal(await f.put(full,{core:core(999)}),false);assert.equal(full.status().lastError,'CACHE_LOW_SPACE');assert.equal(full.get(SLOT,'2026-10').core.result.rooms,0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,name),'utf8')),value);assert.equal(full.status().persistedWrites,0);
  const small=createCompanySnapshotStore({...f.config,maxEntryBytes:8});await small.ready();assert.equal(await f.put(small),false);assert.equal(small.status().lastError,'CACHE_OVERSIZED');assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,name),'utf8')),value);
});

test('unsafe directories and symlinks are rejected without altering their targets',async t=>{
  const f=await fixture(t),target=path.join(f.directory,'real'),link=path.join(f.directory,'link');await fs.mkdir(target);
  try{await fs.symlink(target,link,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Directory symlink permission unavailable');return;}throw error;}
  const linked=createCompanySnapshotStore({...f.config,directory:link});await linked.ready();assert.equal(await f.put(linked),false);assert.equal(linked.status().lastError,'CACHE_UNSAFE_PATH');assert.deepEqual(await fs.readdir(target),[]);
});

test('entry and memory budgets only evict this exact derived namespace after a safe commit',async t=>{
  const f=await fixture(t,{maxEntries:1,maxBytes:256}),legacy=path.join(f.directory,'legacy.json');await fs.writeFile(legacy,'untouched');await f.put();f.advance(1);await f.put(f.store,{slotKey:OTHER,core:core(16)});
  assert.equal(f.store.get(SLOT,'2026-10'),null);assert.equal(f.store.status().entries,1);assert.ok(f.store.status().bytes<=256);assert.equal((await f.files()).filter(name=>name.startsWith('company-')).length,1);assert.equal(await fs.readFile(legacy,'utf8'),'untouched');
});
