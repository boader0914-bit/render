'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createRegionSnapshotStore}=require('../region-snapshot-store.cjs');
const DAY=86400000,AT=Date.parse('2026-10-23T00:00:00Z');
const core=(regionKey='r1',month='2026-09',value=0)=>({region:{id:regionKey,label:'공개 지역'},month,networkAttempted:false,sources:[{key:'visitors',rows:[{value},{value:null}]}]});
const project=data=>({region:{id:data.region?.id,label:data.region?.label},month:data.month,networkAttempted:data.networkAttempted,sources:Array.isArray(data.sources)?data.sources.map(source=>({key:source.key,rows:source.rows.map(row=>({value:row.value}))})):null});
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const checksum=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'insight-region-snapshot-'));let now=AT;
  t.after(async()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('insight-region-snapshot-'));await fs.rm(resolved,{recursive:true,force:true});});
  const configuration={directory,namespace:'https://central.example',now:()=>now,minFreeBytes:0,project,...options};
  const store=createRegionSnapshotStore(configuration);await store.ready();
  return {directory,store,configuration,restart:()=>createRegionSnapshotStore(configuration),advance(ms){now+=ms;},async files(){return (await fs.readdir(directory)).filter(name=>name.endsWith('.json'));},async readEnvelope(){const name=(await this.files())[0];return {name,value:JSON.parse(await fs.readFile(path.join(directory,name),'utf8'))};},async replace(value,name){await fs.writeFile(path.join(directory,name),typeof value==='string'?value:JSON.stringify(value));}};
}
test('restart restores the same public zero/missing values and original verification clock',async t=>{
  const f=await fixture(t),value=core();value.customer={secret:'private-account'};value.token='private-token';value.region.session='private-session';value.sources[0].apiKey='private-key';value.sources[0].rows[0].csrf='private-csrf';
  assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:value}),true);await f.store.flush();
  const {value:envelope}=await f.readEnvelope();assert.doesNotMatch(JSON.stringify(envelope),/private-|customer|session|apiKey|csrf/);
  const next=f.restart();f.advance(DAY);await next.ready();const saved=next.get('r1','2026-09');
  assert.equal(saved.checkedAt,AT);assert.equal(saved.validUntil,AT+7*DAY);assert.equal(saved.core.sources[0].rows[0].value,0);assert.equal(saved.core.sources[0].rows[1].value,null);
  saved.core.sources[0].rows[0].value=999;assert.equal(next.get('r1','2026-09').core.sources[0].rows[0].value,0);assert.equal(next.status().persistedWrites,0);
});
test('list requires explicit allowed IDs and prefers the requested exact month',async t=>{
  const f=await fixture(t);for(const [id,month] of [['r1','2026-08'],['r1','2026-09'],['r2','2026-09']])assert.equal(await f.store.put({regionKey:id,month,checkedAt:AT,core:core(id,month)}),true);
  assert.deepEqual(f.store.list(undefined),[]);assert.deepEqual(f.store.list([]),[]);assert.deepEqual(f.store.list(['r1'],{limit:1,preferMonth:'2026-09'}).map(row=>row.month),['2026-09']);
  assert.deepEqual(new Set(f.store.list(['r1']).map(row=>row.regionKey)),new Set(['r1']));
  assert.equal(f.store.get('../escape','2026-09'),null);assert.equal(f.store.begin('../escape','2026-09'),null);assert.equal(await f.store.put({regionKey:'../escape',month:'2026-09',checkedAt:AT,core:core()}),false);
});
test('backend namespace and schema versions cannot restore or evict another cache',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});const original=(await f.files())[0];
  for(const variant of [{namespace:'https://other.example'},{version:'public-region-v2'}]){const other=createRegionSnapshotStore({...f.configuration,...variant,maxEntries:1});await other.ready();assert.equal(other.get('r1','2026-09'),null);assert.equal(await other.put({regionKey:'r2',month:'2026-09',checkedAt:AT,core:core('r2')}),true);}
  assert.ok((await f.files()).includes(original));
  for(const namespace of ['https://user:password@central.example','https://central.example/path','https://central.example?token=secret','http://untrusted.example'])assert.throws(()=>createRegionSnapshotStore({...f.configuration,namespace}),/canonical backend/);
});
for(const [label,mutate] of [
  ['truncated',()=>'{"format":'],
  ['checksum',value=>({...value,core:core('r1','2026-09',999)})],
  ['namespace',value=>({...value,namespace:'https://other.example'})],
  ['version',value=>({...value,version:'other-version'})],
  ['future',value=>({...value,checkedAt:AT+1,validUntil:AT+1+7*DAY})],
  ['wrong-month',value=>({...value,month:'2026-08'})],
  ['wrong-region',value=>({...value,regionKey:'r2'})]
])test('rejects '+label+' saved records without exposing a success',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});const {name,value}=await f.readEnvelope();let broken=mutate(value);
  if(typeof broken==='object'&&label!=='checksum'){const {checksum:ignored,...payload}=broken;broken={...payload,checksum:checksum(payload)};}
  await f.replace(broken,name);const next=f.restart();await next.ready();assert.equal(next.get('r1','2026-09'),null);assert.equal(next.status().entries,0);assert.ok(next.status().readFailures>=1);
});
test('expired data is not restored and reads never renew the verification date',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});f.advance(7*DAY-1);assert.equal(f.store.get('r1','2026-09').checkedAt,AT);assert.equal(f.store.list(['r1'])[0].checkedAt,AT);
  f.advance(1);assert.equal(f.store.get('r1','2026-09'),null);const next=f.restart();await next.ready();assert.equal(next.get('r1','2026-09'),null);assert.equal(await next.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()}),false);
});
test('oversized files and projections are bounded and cannot erase the preceding safe file',async t=>{
  const f=await fixture(t,{maxEntryBytes:512});await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});const {name,value}=await f.readEnvelope();
  const large=core();large.region.label='x'.repeat(2000);assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:large}),false);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,name),'utf8')),value);
  await f.replace('x'.repeat(10000),name);const next=f.restart();await next.ready();assert.equal(next.get('r1','2026-09'),null);assert.equal(next.status().lastError,'CACHE_OVERSIZED');
});
test('last-started source tickets prevent an older late source from overwriting a newer result',async t=>{
  const f=await fixture(t),old=f.store.begin('r1','2026-09'),latest=f.store.begin('r1','2026-09');
  assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core('r1','2026-09',200),ticket:latest}),true);
  assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core('r1','2026-09',999),ticket:old}),false);
  assert.equal(f.store.get('r1','2026-09').core.sources[0].rows[0].value,200);const restarted=f.restart();await restarted.ready();assert.equal(restarted.get('r1','2026-09').core.sources[0].rows[0].value,200);
});
test('queued earlier writes are superseded when a newer source starts before they commit',async t=>{
  const f=await fixture(t),a=f.store.begin('r1','2026-09'),old=f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core('r1','2026-09',999),ticket:a});
  const b=f.store.begin('r1','2026-09'),recent=f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core('r1','2026-09',200),ticket:b});
  assert.equal(await old,false);assert.equal(await recent,true);await f.store.flush();const next=f.restart();await next.ready();assert.equal(next.get('r1','2026-09').core.sources[0].rows[0].value,200);
});
test('low free space reports failure, retains memory fallback and preserves previous files',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});const {name,value}=await f.readEnvelope();
  const full=createRegionSnapshotStore({...f.configuration,minFreeBytes:Number.MAX_SAFE_INTEGER});await full.ready();assert.equal(await full.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core('r1','2026-09',200)}),false);
  assert.equal(full.get('r1','2026-09').core.sources[0].rows[0].value,200);assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,name),'utf8')),value);assert.equal(full.status().lastError,'CACHE_LOW_SPACE');assert.equal(full.status().persistedWrites,0);
});
test('directory errors retain a safe memory fallback and never return disk-write success',async t=>{
  const f=await fixture(t),file=path.join(f.directory,'not-a-directory');await fs.writeFile(file,'legacy');
  const next=createRegionSnapshotStore({...f.configuration,directory:file});await next.ready();assert.equal(await next.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()}),false);assert.equal(next.get('r1','2026-09').core.sources[0].rows[0].value,0);assert.ok(next.status().writeFailures);assert.equal(await fs.readFile(file,'utf8'),'legacy');
});
test('entry eviction deletes only validated files in this exact namespace after a successful replacement',async t=>{
  const f=await fixture(t,{maxEntries:1}),legacy=path.join(f.directory,'legacy.json');await fs.writeFile(legacy,'do not touch');
  await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});f.advance(1);await f.store.put({regionKey:'r2',month:'2026-09',checkedAt:AT+1,core:core('r2')});
  assert.equal(f.store.get('r1','2026-09'),null);assert.equal(f.store.status().entries,1);assert.equal((await f.files()).filter(name=>name.startsWith('region-')).length,1);assert.equal(await fs.readFile(legacy,'utf8'),'do not touch');
});
test('symlink directory paths are rejected without following or modifying the destination',async t=>{
  const f=await fixture(t),real=path.join(f.directory,'real'),link=path.join(f.directory,'link');await fs.mkdir(real);
  try{await fs.symlink(real,link,process.platform==='win32'?'junction':'dir');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('Symlink permission unavailable');return;}throw e;}
  const next=createRegionSnapshotStore({...f.configuration,directory:link});await next.ready();assert.equal(await next.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()}),false);assert.equal(next.status().lastError,'CACHE_UNSAFE_PATH');assert.deepEqual(await fs.readdir(real),[]);
});
test('source scope mismatches and failed projectors are never written',async t=>{
  const f=await fixture(t);for(const bad of [{...core(),networkAttempted:true},core('r2'),core('r1','2026-08'),{...core(),sources:null}])assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:bad}),false);
  assert.deepEqual(await f.files(),[]);assert.equal(f.store.get('r1','2026-09'),null);
  assert.equal(await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT+1,core:core()}),false);
});
test('a symlink cache file is not restored, replaced, or deleted',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});const {name}=await f.readEnvelope(),file=path.join(f.directory,name),outside=path.join(f.directory,'untouched-public.json');
  await fs.writeFile(outside,'outside record');await fs.unlink(file);
  try{await fs.symlink(outside,file,'file');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('File symlink permission unavailable');return;}throw e;}
  const next=f.restart();await next.ready();assert.equal(next.get('r1','2026-09'),null);assert.equal(await next.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()}),false);
  assert.equal(next.status().lastError,'CACHE_UNSAFE_PATH');assert.equal(await fs.readFile(outside,'utf8'),'outside record');assert.equal((await fs.lstat(file)).isSymbolicLink(),true);
});
test('memory byte budget and persisted record count remain bounded on reload',async t=>{
  const f=await fixture(t,{maxBytes:500,maxEntryBytes:400,maxEntries:2});
  for(let i=0;i<6;i++){const id='r'+i;f.advance(1);assert.equal(await f.store.put({regionKey:id,month:'2026-09',checkedAt:AT+i+1,core:core(id)}),true);}
  assert.ok(f.store.status().entries<=2);assert.ok(f.store.status().bytes<=500);assert.ok((await f.files()).length<=2);
  const next=f.restart();await next.ready();assert.ok(next.status().entries<=2);assert.ok(next.status().bytes<=500);assert.equal(next.status().initialized,true);assert.equal(next.status().pendingInitialization,false);
});
test('expired and corrupt owned snapshots are cleaned only after a safe new commit',async t=>{
  const f=await fixture(t);await f.store.put({regionKey:'r1',month:'2026-09',checkedAt:AT,core:core()});await f.store.put({regionKey:'r2',month:'2026-09',checkedAt:AT,core:core('r2')});
  const files=await f.files();await f.replace('{broken',files[0]);f.advance(7*DAY);const next=f.restart();await next.ready();assert.equal(next.status().entries,0);assert.equal((await f.files()).length,2);
  assert.equal(await next.put({regionKey:'r3',month:'2026-09',checkedAt:AT+7*DAY,core:core('r3')}),true);assert.equal((await f.files()).length,1);assert.equal(next.get('r3','2026-09').checkedAt,AT+7*DAY);
});
