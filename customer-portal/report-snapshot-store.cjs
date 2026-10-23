'use strict';
// Rebuildable account-isolated report projections. Only an opaque derived
// slot key and allowlisted report core are stored; never authentication data.
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const FORMAT=1,DAY=86400000;
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const validSlot=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const validPeriod=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
function canonicalNamespace(value){
  try{const u=new URL(value);if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)))throw Error();return u.origin;}
  catch{throw new TypeError('A canonical backend origin is required for report snapshots');}
}
function createReportSnapshotStore({directory,namespace,version='report-v1',quality='complete',now=Date.now,maxAgeMs=7*DAY,maxEntries=128,maxBytes=16*1024*1024,maxEntryBytes=2*1024*1024,minFreeBytes=32*1024*1024,project}={}){
  if(typeof directory!=='string'||!directory||typeof project!=='function'||typeof now!=='function'||typeof version!=='string'||!/^[a-zA-Z0-9_.-]{1,80}$/.test(version)||!['complete','partial'].includes(quality))throw new TypeError('Invalid report snapshot configuration');
  for(const value of [maxAgeMs,maxEntries,maxBytes,maxEntryBytes,minFreeBytes])if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid report snapshot limit');
  namespace=canonicalNamespace(namespace);
  const root=path.resolve(directory),prefix=(quality==='partial'?'report-partial-':'report-')+hash([namespace,version]).slice(0,32)+'-',filePattern=new RegExp('^'+prefix+'[a-f0-9]{64}\\.json$');
  const rows=new Map(),tickets=new Map(),knownFiles=new Set();let memoryBytes=0,sequence=0,initialization,initialized=false,serial=Promise.resolve(),readFailures=0,writeFailures=0,lastError=null,persistedWrites=0;
  const clock=()=>Number(now()),keyFor=(slotKey,periodStart)=>JSON.stringify([slotKey,periodStart]);
  const filename=(slotKey,periodStart)=>prefix+hash([slotKey,periodStart])+'.json';
  const safePath=name=>{if(!filePattern.test(name))throw Error('CACHE_UNSAFE_PATH');const file=path.resolve(root,name);if(path.dirname(file)!==root)throw Error('CACHE_UNSAFE_PATH');return file;};
  const error=(code,writing=false)=>{lastError=code;if(writing)writeFailures++;else readFailures++;};
  const current=ticket=>Boolean(ticket&&tickets.get(ticket.key)===ticket);
  const stampValid=at=>Number.isSafeInteger(at)&&at>=0&&Number.isFinite(clock())&&at<=clock()&&clock()-at<maxAgeMs;
  function discard(key){const former=rows.get(key);if(former){memoryBytes-=former.bytes;rows.delete(key);}}
  function prune(){
    for(const [key,row] of rows)if(!stampValid(row.checkedAt))discard(key);
    while(rows.size>maxEntries||memoryBytes>maxBytes){let oldest;for(const entry of rows)if(!oldest||entry[1].checkedAt<oldest[1].checkedAt)oldest=entry;if(!oldest)break;discard(oldest[0]);}
  }
  function projected(slotKey,periodStart,core){
    if(quality==='partial'?core?.dataQuality?.status!=='partial':core?.dataQuality?.status==='partial'||core?.responseCache?.partial===true)throw Error('CACHE_QUALITY_MISMATCH');
    const value=project(core,{slotKey,periodStart});
    if(!value||typeof value!=='object'||Array.isArray(value)||value.mode!=='current_briefing'||!value.period)throw Error('CACHE_INVALID_PROJECTION');
    if(quality==='partial'?value.dataQuality?.status!=='partial':value.dataQuality?.status==='partial')throw Error('CACHE_QUALITY_MISMATCH');
    const text=JSON.stringify(value),bytes=Buffer.byteLength(text);if(bytes>maxEntryBytes||bytes>maxBytes)throw Error('CACHE_OVERSIZED');
    return {core:JSON.parse(text),bytes};
  }
  function remember(row){const key=keyFor(row.slotKey,row.periodStart);discard(key);rows.set(key,row);memoryBytes+=row.bytes;prune();}
  function visible(row){return row?clone({slotKey:row.slotKey,periodStart:row.periodStart,checkedAt:row.checkedAt,validUntil:row.validUntil,core:row.core}):null;}
  async function safeDirectory(create=false){
    const parsed=path.parse(root);let cursor=parsed.root;
    for(const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,part);let stat;
      try{stat=await fs.lstat(cursor);}catch(failure){if(failure.code!=='ENOENT'||!create)throw failure;try{await fs.mkdir(cursor,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}stat=await fs.lstat(cursor);}
      if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('CACHE_UNSAFE_PATH');
    }
  }
  async function boundedRead(name){
    const file=safePath(name),limit=maxEntryBytes+8192;let handle;
    try{
      const before=await fs.lstat(file);if(before.isSymbolicLink()||!before.isFile())throw Error('CACHE_UNSAFE_PATH');if(before.size>limit)throw Error('CACHE_OVERSIZED');
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>limit)throw Error('CACHE_UNSAFE_PATH');
      const buffer=Buffer.alloc(limit+1);let length=0;
      while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      if(length>limit)throw Error('CACHE_OVERSIZED');
      const after=await fs.lstat(file);if(after.isSymbolicLink()||after.dev!==opened.dev||after.ino!==opened.ino)throw Error('CACHE_UNSAFE_PATH');
      return JSON.parse(buffer.toString('utf8',0,length));
    }finally{await handle?.close().catch(()=>{});}
  }
  function decode(value,name){
    if(!value||typeof value!=='object'||value.format!==FORMAT||value.namespace!==namespace||value.version!==version||(value.quality||'complete')!==quality||typeof value.checksum!=='string'||!/^[a-f0-9]{64}$/.test(value.checksum))throw Error('CACHE_INVALID_ENVELOPE');
    const {checksum,...payload}=value;if(hash(payload)!==checksum)throw Error('CACHE_CHECKSUM');
    const {slotKey,periodStart,checkedAt,validUntil,core}=payload;
    if(!validSlot(slotKey)||!validPeriod(periodStart)||filename(slotKey,periodStart)!==name||!stampValid(checkedAt)||validUntil!==checkedAt+maxAgeMs)throw Error('CACHE_INVALID_RECORD');
    return {slotKey,periodStart,checkedAt,validUntil,...projected(slotKey,periodStart,core)};
  }
  function ready(){
    if(!initialization)initialization=(async()=>{
      try{
        await safeDirectory(true);const directory=await fs.opendir(root);let scanned=0;
        try{for await(const entry of directory){if(++scanned>Math.max(256,maxEntries*8)){error('CACHE_SCAN_LIMIT');break;}if(!filePattern.test(entry.name))continue;
          if(entry.isSymbolicLink()||!entry.isFile()){error('CACHE_UNSAFE_PATH');continue;}
          // Only this exact namespace's reserved, hashed regular files may be
          // cleaned after a later successful commit. Expired/corrupt derived
          // snapshots must not accumulate forever or consume the scan budget.
          knownFiles.add(entry.name);
          try{remember(decode(await boundedRead(entry.name),entry.name));}catch(e){error(/^CACHE_[A-Z_]+$/.test(e.message)?e.message:'CACHE_READ_FAILED');}
        }}finally{await directory.close().catch(()=>{});}
      }catch(e){error(e.message==='CACHE_UNSAFE_PATH'?e.message:'CACHE_READ_FAILED');}finally{initialized=true;}
    })();return initialization;
  }
  function begin(slotKey,periodStart){if(!validSlot(slotKey)||!validPeriod(periodStart))return null;const key=keyFor(slotKey,periodStart),ticket=Object.freeze({key,sequence:++sequence});tickets.delete(key);tickets.set(key,ticket);while(tickets.size>Math.max(256,maxEntries*4))tickets.delete(tickets.keys().next().value);return ticket;}
  function get(slotKey,periodStart){if(!validSlot(slotKey)||!validPeriod(periodStart))return null;prune();return visible(rows.get(keyFor(slotKey,periodStart)));}
  function list(slotKeys,{limit=8,preferPeriod}={}){
    if(!Array.isArray(slotKeys)||!Number.isInteger(limit)||limit<0)return [];const allowed=new Set(slotKeys.filter(validSlot));prune();
    return [...rows.values()].filter(row=>allowed.has(row.slotKey)).sort((a,b)=>Number(b.periodStart===preferPeriod)-Number(a.periodStart===preferPeriod)||b.checkedAt-a.checkedAt||b.periodStart.localeCompare(a.periodStart)).slice(0,Math.min(limit,maxEntries)).map(visible);
  }
  async function removeEvicted(){
    const keep=new Set([...rows.values()].map(row=>filename(row.slotKey,row.periodStart)));
    for(const name of knownFiles){if(keep.has(name))continue;try{const file=safePath(name),stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile()){error('CACHE_UNSAFE_PATH',true);continue;}await fs.unlink(file);knownFiles.delete(name);}catch(e){if(e.code==='ENOENT')knownFiles.delete(name);else error('CACHE_EVICTION_FAILED',true);}}
  }
  function put({slotKey,periodStart,checkedAt,core,ticket,guard}={}){
    if(!validSlot(slotKey)||!validPeriod(periodStart)||!stampValid(checkedAt)||maxEntries<1||guard&&typeof guard!=='function')return Promise.resolve(false);
    const permitted=()=>!guard||guard()===true;
    if(!permitted())return Promise.resolve(false);
    ticket=ticket||begin(slotKey,periodStart);if(ticket?.key!==keyFor(slotKey,periodStart)||!current(ticket))return Promise.resolve(false);
    let projection;try{projection=projected(slotKey,periodStart,core);}catch(e){error(/^CACHE_[A-Z_]+$/.test(e.message)?e.message:'CACHE_INVALID_PROJECTION',true);return Promise.resolve(false);}
    const record={slotKey,periodStart,checkedAt,validUntil:checkedAt+maxAgeMs,...projection};
    const operation=async()=>{
      await ready();if(!current(ticket)||!stampValid(checkedAt)||!permitted())return false;
      const payload={format:FORMAT,namespace,version,quality,slotKey,periodStart,checkedAt,validUntil:record.validUntil,core:record.core},envelope={...payload,checksum:hash(payload)};
      const name=filename(slotKey,periodStart),file=safePath(name);let temporary,handle;
      try{
        await safeDirectory(true);const space=await fs.statfs(root),free=Number(space.bavail)*Number(space.bsize);
        if(!Number.isFinite(free)||free<minFreeBytes+Buffer.byteLength(JSON.stringify(envelope))){error('CACHE_LOW_SPACE',true);return false;}
        try{const existing=await fs.lstat(file);if(existing.isSymbolicLink()||!existing.isFile())throw Error('CACHE_UNSAFE_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}
        if(!current(ticket)||!permitted())return false;
        temporary=path.join(root,'.'+name+'.'+crypto.randomUUID()+'.tmp');handle=await fs.open(temporary,'wx',0o600);
        await handle.writeFile(JSON.stringify(envelope));await handle.sync();await handle.close();handle=null;
        await safeDirectory();if(!current(ticket)||!stampValid(checkedAt)||!permitted())return false;
        await fs.rename(temporary,file);temporary=null;remember(record);knownFiles.add(name);persistedWrites++;
        // A crash may leave the preceding safe file; failed/low-space writes
        // never delete it in an attempt to make room for the next result.
        try{const directory=await fs.open(root,constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}catch{}
        await removeEvicted();return current(ticket)&&permitted();
      }catch(e){error(e.message==='CACHE_UNSAFE_PATH'?e.message:'CACHE_WRITE_FAILED',true);return false;}
      finally{await handle?.close().catch(()=>{});if(temporary)await fs.unlink(temporary).catch(()=>{});}
    };
    const result=serial.then(operation,operation);serial=result.then(()=>{},()=>{});return result;
  }
  async function flush(){await ready();await serial;}
  function status(){prune();return {entries:rows.size,bytes:memoryBytes,readFailures,writeFailures,persistedWrites,lastError,initialized,pendingInitialization:Boolean(initialization)&&!initialized};}
  return {ready,get,list,put,begin,flush,status};
}
module.exports={createReportSnapshotStore};
