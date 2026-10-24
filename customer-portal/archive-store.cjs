'use strict';
// Immutable customer projections, not a cache. No retention timer, eviction,
// overwrite or delete API is provided. The caller owns projection/authorization.
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const FORMAT=1,KINDS=new Set(['daily-review','published-report']);
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function failure(code){const error=new Error(code);error.code=code;return error;}
function text(value,max=512){return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value);}
function jsonValue(value){
  let nodes=0;const seen=new Set();
  function visit(item,depth){
    if(++nodes>100000||depth>32)throw failure('ARCHIVE_INVALID_RECORD');
    if(item===null||typeof item==='boolean'||typeof item==='string')return item;
    if(typeof item==='number'&&Number.isFinite(item))return item;
    if(typeof item!=='object'||seen.has(item))throw failure('ARCHIVE_INVALID_RECORD');
    if(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw failure('ARCHIVE_INVALID_RECORD');
    seen.add(item);let result;
    if(Array.isArray(item))result=item.map(value=>visit(value,depth+1));
    else{result={};for(const key of Object.keys(item).sort()){
      const normalized=key.replace(/[^a-z0-9]/gi,'').toLowerCase();
      if(['__proto__','prototype','constructor'].includes(key)||/^(?:.*token|.*password|.*passwd|.*cookie|authorization|.*secret|apikey|sessionid|sessionkey|guestname|guestphone|guestemail|customerphone|customeremail|customername|reservationcontact|residentregistrationnumber)$/.test(normalized))throw failure('ARCHIVE_SENSITIVE_FIELD');
      if(key.length>256||/[\x00-\x1f]/.test(key))throw failure('ARCHIVE_INVALID_RECORD');
      result[key]=visit(item[key],depth+1);
    }}seen.delete(item);return result;
  }return visit(value,0);
}
function createArchiveStore({directory=null,namespace='insight',clock=Date.now,minFreeBytes=200*1024*1024,maxRecordBytes=2*1024*1024,statfs=fs.statfs}={}){
  if(directory!==null&&(!text(directory,4096)||!path.isAbsolute(directory)))throw new TypeError('An absolute archive directory is required');
  if(!text(namespace,2048)||typeof clock!=='function'||typeof statfs!=='function')throw new TypeError('Invalid archive configuration');
  for(const value of [minFreeBytes,maxRecordBytes])if(!Number.isSafeInteger(value)||value<0)throw new TypeError('Invalid archive bound');
  const enabled=directory!==null,root=enabled?path.resolve(directory):null,namespaceHash=digest(namespace),prefix='archive-'+namespaceHash.slice(0,32)+'-';
  const pattern=new RegExp('^'+prefix+'([a-f0-9]{64})-([a-f0-9]{64})\\.json$');
  const rows=new Map();let initialization,initialized=false,available=enabled,serial=Promise.resolve(),readFailures=0,writeFailures=0,lastError=null,persistedWrites=0,storedBytes=0,freeBytes=null;
  const note=(error,write=false)=>{const code=/^ARCHIVE_[A-Z_]+$/.test(error?.code||'')?error.code:write?'ARCHIVE_WRITE_FAILED':'ARCHIVE_READ_FAILED';lastError=code;if(write)writeFailures++;else readFailures++;return failure(code);};
  function scope(ownerId,audience){if(!text(ownerId)||!text(audience))throw failure('ARCHIVE_INVALID_SCOPE');return digest(JSON.stringify([namespaceHash,ownerId,audience]));}
  function filename(scopeHash,id){return prefix+scopeHash+'-'+id+'.json';}
  function safePath(name){if(!enabled||!pattern.test(name))throw failure('ARCHIVE_UNSAFE_PATH');const file=path.resolve(root,name);if(path.dirname(file)!==root)throw failure('ARCHIVE_UNSAFE_PATH');return file;}
  async function safeDirectory(create=false){
    const parsed=path.parse(root);let cursor=parsed.root;
    for(const part of root.slice(parsed.root.length).split(path.sep).filter(Boolean)){
      cursor=path.join(cursor,part);let stat;
      try{stat=await fs.lstat(cursor);}catch(error){if(error.code!=='ENOENT'||!create)throw error;try{await fs.mkdir(cursor,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}stat=await fs.lstat(cursor);}
      if(stat.isSymbolicLink()||!stat.isDirectory())throw failure('ARCHIVE_UNSAFE_PATH');
    }
  }
  async function read(name){
    const file=safePath(name);let handle;
    try{
      const before=await fs.lstat(file);if(before.isSymbolicLink()||!before.isFile())throw failure('ARCHIVE_UNSAFE_PATH');if(before.size>maxRecordBytes)throw failure('ARCHIVE_OVERSIZED');
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();
      if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>maxRecordBytes)throw failure('ARCHIVE_UNSAFE_PATH');
      const buffer=Buffer.alloc(Math.min(opened.size+1,maxRecordBytes+1));let length=0;
      while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      const after=await fs.lstat(file);if(after.isSymbolicLink()||after.dev!==opened.dev||after.ino!==opened.ino||length!==opened.size||after.size!==opened.size)throw failure('ARCHIVE_UNSAFE_PATH');
      let envelope;try{envelope=JSON.parse(buffer.toString('utf8',0,length));}catch{throw failure('ARCHIVE_INVALID_RECORD');}
      return decode(envelope,name,length);
    }finally{await handle?.close().catch(()=>{});}
  }
  function decode(envelope,name,bytes){
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||envelope.format!==FORMAT||envelope.namespaceHash!==namespaceHash||!hex(envelope.scopeHash)||!hex(envelope.id)||!hex(envelope.contentChecksum)||!hex(envelope.checksum)||!KINDS.has(envelope.kind)||filename(envelope.scopeHash,envelope.id)!==name)throw failure('ARCHIVE_INVALID_RECORD');
    const keys=['format','namespaceHash','scopeHash','id','createdAt','kind','period','identity','payload','metadata','contentChecksum','checksum'];
    if(Object.keys(envelope).length!==keys.length||keys.some(key=>!Object.hasOwn(envelope,key)))throw failure('ARCHIVE_INVALID_RECORD');
    if(typeof envelope.createdAt!=='string'||!Number.isFinite(Date.parse(envelope.createdAt)))throw failure('ARCHIVE_INVALID_RECORD');
    const {checksum,...unsigned}=envelope;const clean=jsonValue(unsigned);if(digest(clean)!==checksum)throw failure('ARCHIVE_CHECKSUM');
    const content={kind:clean.kind,period:clean.period,identity:clean.identity,payload:clean.payload,metadata:clean.metadata};
    if(digest(jsonValue(content))!==clean.contentChecksum)throw failure('ARCHIVE_CHECKSUM');
    return {envelope:{...clean,checksum},bytes,name};
  }
  function metadata(row){const {payload,namespaceHash:ignoredNamespace,scopeHash:ignoredScope,...record}=row.envelope;return {...clone(record),bytes:row.bytes};}
  function remember(row){const previous=rows.get(row.envelope.id);if(previous)storedBytes-=previous.bytes;const {payload,...index}=row.envelope;rows.set(index.id,{envelope:index,bytes:row.bytes,name:row.name});storedBytes+=row.bytes;}
  async function space(){const value=await statfs(root);freeBytes=Number(value.bavail)*Number(value.bsize);if(!Number.isFinite(freeBytes)||freeBytes<0)throw failure('ARCHIVE_SPACE_UNKNOWN');return freeBytes;}
  function ready(){
    if(!initialization)initialization=(async()=>{
      if(!enabled){initialized=true;return;}
      try{
        await safeDirectory(true);const directoryHandle=await fs.opendir(root);
        try{for await(const entry of directoryHandle){if(!pattern.test(entry.name))continue;if(entry.isSymbolicLink()||!entry.isFile()){note(failure('ARCHIVE_UNSAFE_PATH'));continue;}try{remember(await read(entry.name));}catch(error){note(error);}}}finally{await directoryHandle.close().catch(()=>{});}
        await space();available=true;
      }catch(error){available=false;note(error);}finally{initialized=true;}
    })();return initialization;
  }
  async function get({ownerId,audience,id}={}){
    const scopeHash=scope(ownerId,audience);if(!hex(id))throw failure('ARCHIVE_INVALID_ID');await ready();if(!enabled)return null;
    const row=rows.get(id);if(!row||row.envelope.scopeHash!==scopeHash)return null;
    try{await safeDirectory();const actual=await read(row.name);if(actual.envelope.scopeHash!==scopeHash)throw failure('ARCHIVE_INVALID_RECORD');return {...metadata(actual),payload:clone(actual.envelope.payload)};}catch(error){throw note(error);}
  }
  async function list({ownerId,audience,kind,period,limit=100,offset=0}={}){
    const scopeHash=scope(ownerId,audience);if(kind!==undefined&&!KINDS.has(kind))throw failure('ARCHIVE_INVALID_KIND');if(!Number.isSafeInteger(limit)||limit<0||limit>1000||!Number.isSafeInteger(offset)||offset<0)throw failure('ARCHIVE_INVALID_RANGE');
    const periodKey=period===undefined?null:JSON.stringify(jsonValue(period));await ready();
    return [...rows.values()].filter(row=>row.envelope.scopeHash===scopeHash&&(!kind||row.envelope.kind===kind)&&(!periodKey||JSON.stringify(row.envelope.period)===periodKey)).sort((a,b)=>b.envelope.createdAt.localeCompare(a.envelope.createdAt)||b.envelope.id.localeCompare(a.envelope.id)).slice(offset,offset+limit).map(metadata);
  }
  function put({kind,ownerId,audience,period,identity,payload,metadata:recordMetadata={},idempotencyKey}={}){
    let scopeHash,content,id,createdAt;
    try{
      if(!enabled)throw failure('ARCHIVE_DISABLED');if(!KINDS.has(kind))throw failure('ARCHIVE_INVALID_KIND');scopeHash=scope(ownerId,audience);
      if(period===undefined||identity===undefined||payload===undefined)throw failure('ARCHIVE_INVALID_RECORD');
      content=jsonValue({kind,period,identity,payload,metadata:recordMetadata});
      if(Buffer.byteLength(JSON.stringify(content))>maxRecordBytes)throw failure('ARCHIVE_OVERSIZED');
      if(idempotencyKey!==undefined&&!text(idempotencyKey,2048))throw failure('ARCHIVE_INVALID_IDEMPOTENCY_KEY');
      const stamp=Number(clock());if(!Number.isSafeInteger(stamp)||stamp<0)throw failure('ARCHIVE_INVALID_CLOCK');createdAt=new Date(stamp).toISOString();
      id=digest(JSON.stringify([namespaceHash,scopeHash,kind,idempotencyKey===undefined?digest(content):idempotencyKey]));
    }catch(error){return Promise.reject(note(error,true));}
    const operation=async()=>{
      await ready();if(!available)throw failure(lastError||'ARCHIVE_UNAVAILABLE');await safeDirectory();
      const name=filename(scopeHash,id),file=safePath(name),contentChecksum=digest(content);
      const existing=async()=>{const row=await read(name);if(row.envelope.contentChecksum!==contentChecksum)throw failure('ARCHIVE_IDEMPOTENCY_CONFLICT');remember(row);return {record:metadata(row),created:false};};
      try{await fs.lstat(file);return await existing();}catch(error){if(error.code!=='ENOENT')throw error;}
      const unsigned=jsonValue({format:FORMAT,namespaceHash,scopeHash,id,createdAt,...content,contentChecksum}),envelope={...unsigned,checksum:digest(unsigned)},serialized=JSON.stringify(envelope),bytes=Buffer.byteLength(serialized);
      if(bytes>maxRecordBytes)throw failure('ARCHIVE_OVERSIZED');if(await space()<minFreeBytes+bytes)throw failure('ARCHIVE_LOW_SPACE');
      let temporary=path.join(root,'.archive-'+crypto.randomUUID()+'.tmp'),handle;
      try{
        handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(serialized);await handle.sync();await handle.close();handle=null;
        await safeDirectory();
        // Hard-link commit is atomic and fails if final already exists. rename()
        // would silently overwrite an immutable record on some platforms.
        try{await fs.link(temporary,file);}catch(error){if(error.code==='EEXIST')return await existing();throw error;}
        const row={envelope,bytes,name};remember(row);persistedWrites++;
        try{const directoryHandle=await fs.open(root,constants.O_RDONLY);try{await directoryHandle.sync();}finally{await directoryHandle.close();}}catch{}
        return {record:metadata(row),created:true};
      }finally{await handle?.close().catch(()=>{});await fs.unlink(temporary).catch(()=>{});}
    };
    const result=serial.then(operation,operation).catch(error=>{throw note(error,true);});serial=result.then(()=>{},()=>{});return result;
  }
  async function flush(){await ready();await serial;}
  function status(){return {enabled,initialized,available,entries:rows.size,storedBytes,freeBytes,persistedWrites,readFailures,writeFailures,lastError};}
  return {ready,put,list,get,status,flush};
}
module.exports={createArchiveStore};
