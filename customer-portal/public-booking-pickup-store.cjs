'use strict';
// Private Insight evidence, separate from source collection, total inventory,
// issued reports and the normal company response cache. Reads never collect.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {VERSION,CALCULATION_VERSION,computePublicBookingPickup}=require('./lib/public-booking-pickup.cjs');
const {fromImportedLedger}=require('./lib/public-booking-pickup-adapter.cjs');
const hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const id=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fault=code=>Object.assign(new Error(code),{code});
const kst=value=>new Date(value.getTime()+9*3600000).toISOString().slice(0,10);
const monthDates=month=>{
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||''))throw fault('PUBLIC_PICKUP_INVALID_MONTH');
  const [year,number]=month.split('-').map(Number),days=new Date(Date.UTC(year,number,0)).getUTCDate();
  return Array.from({length:days},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
};
function createPublicBookingPickupStore({directory=null,namespace='',now=()=>new Date()}={}){
  if(directory&&(!path.isAbsolute(directory)||path.resolve(directory)===path.parse(path.resolve(directory)).root))throw fault('PUBLIC_PICKUP_INVALID_DIRECTORY');
  const namespaceDigest=hash(namespace),root=directory?path.join(directory,namespaceDigest):null,memory=new Map();
  let writes=Promise.resolve();
  const folder=companyId=>path.join(root,hash(companyId));
  async function readJson(file,maximum=12*1024*1024){
    try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum)throw fault('PUBLIC_PICKUP_STORE_INVALID');return JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error){if(error.code==='ENOENT')return null;throw fault('PUBLIC_PICKUP_STORE_INVALID');}
  }
  function validateIndex(value,companyId){
    if(!value)return null;
    const content={...value};delete content.indexDigest;
    if(!sha(value.indexDigest)||hash(content)!==value.indexDigest)throw fault('PUBLIC_PICKUP_STORE_INVALID');
    if(value.version!==1||value.companyId!==companyId||value.namespaceDigest!==namespaceDigest||!/^\d{1,20}$/.test(value.placeId||'')||!Array.isArray(value.sources)||value.sources.length>10000)throw fault('PUBLIC_PICKUP_STORE_INVALID');
    const seen=new Set();
    for(const row of value.sources){
      if(!row||typeof row.runId!=='string'||!Number.isFinite(Date.parse(row.collectedAt))||!sha(row.sourceDigest)||!sha(row.contentDigest)||seen.has(row.runId))throw fault('PUBLIC_PICKUP_STORE_INVALID');
      seen.add(row.runId);
    }
    return content;
  }
  async function readIndex(companyId){return validateIndex(root?await readJson(path.join(folder(companyId),'index.json'),2*1024*1024):memory.get(companyId)?.index,companyId);}
  async function immutableJson(file,value){
    const data=JSON.stringify(value);await fs.mkdir(path.dirname(file),{recursive:true});
    const temp=file+'.'+crypto.randomUUID()+'.tmp';let handle;
    try{
      handle=await fs.open(temp,'wx',0o600);await handle.writeFile(data);await handle.sync();await handle.close();handle=null;
      try{await fs.link(temp,file);}
      catch(error){if(error.code!=='EEXIST')throw error;const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||await fs.readFile(file,'utf8')!==data)throw fault('PUBLIC_PICKUP_STORE_CONFLICT');}
    }finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
  }
  async function replaceIndex(file,value){
    const temp=file+'.'+crypto.randomUUID()+'.tmp';let handle;
    try{handle=await fs.open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(temp,file);}
    finally{if(handle)await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}
  }
  async function importOne(input){
    const checked=fromImportedLedger(input,{companyId:input?.companyId,placeId:input?.placeId});
    if(checked.status!=='ready')throw fault(checked.reasonCode||'PUBLIC_PICKUP_IMPORT_INVALID');
    const ledger=checked.ledger,companyId=ledger.companyId,previous=await readIndex(companyId);
    if(companyId.startsWith('cmp_place_')&&companyId!=='cmp_place_'+ledger.placeId)throw fault('SOURCE_CONTEXT_MISMATCH');
    if(previous&&previous.placeId!==ledger.placeId)throw fault('PUBLIC_PICKUP_STORE_CONFLICT');
    const index=previous?structuredClone(previous):{version:1,namespaceDigest,companyId,placeId:ledger.placeId,sources:[]};
    if(root){await fs.mkdir(root,{recursive:true});const space=await fs.statfs(root);if(space.bavail*space.bsize<=200*1024*1024)throw fault('PUBLIC_PICKUP_LOW_SPACE');}
    const existing=new Map(index.sources.map(row=>[row.runId,row])),sourceValues=new Map(memory.get(companyId)?.sources||[]);
    for(const source of ledger.sources){
      const content={version:VERSION,namespaceDigest,companyId,placeId:ledger.placeId,source},contentDigest=hash(content),old=existing.get(source.runId);
      if(old&&(old.contentDigest!==contentDigest||old.sourceDigest!==source.sourceDigest||old.collectedAt!==source.collectedAt))throw fault('PUBLIC_PICKUP_SOURCE_CONFLICT');
      if(root)await immutableJson(path.join(folder(companyId),contentDigest+'.json'),content);
      else sourceValues.set(contentDigest,content);
      if(!old){const reference={runId:source.runId,collectedAt:source.collectedAt,sourceDigest:source.sourceDigest,contentDigest};index.sources.push(reference);existing.set(source.runId,reference);}
    }
    if(index.sources.length>10000)throw fault('PUBLIC_PICKUP_STORE_LIMIT');
    index.sources.sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt)||a.runId.localeCompare(b.runId));
    if(root){
      // Keep immutable copies of every successful index, including old ones.
      await immutableJson(path.join(folder(companyId),'index-'+hash(index)+'.json'),index);
      await replaceIndex(path.join(folder(companyId),'index.json'),{...index,indexDigest:hash(index)});
    }else memory.set(companyId,{index:{...index,indexDigest:hash(index)},sources:sourceValues});
    return {companyId,placeId:ledger.placeId,sourceCount:index.sources.length,importedSources:ledger.sources.length,ledgerDigest:checked.ledgerDigest};
  }
  function importLedger(input){const operation=writes.then(()=>importOne(input));writes=operation.catch(()=>{});return operation;}
  async function project({companyId,month,asOf=kst(now())}={}){
    if(!id(companyId))throw fault('PUBLIC_PICKUP_INVALID_COMPANY');
    if(typeof asOf!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(asOf)||!Number.isFinite(Date.parse(asOf+'T00:00:00Z'))||new Date(asOf+'T00:00:00Z').toISOString().slice(0,10)!==asOf)throw fault('PUBLIC_PICKUP_INVALID_DATE');
    const dates=monthDates(month||asOf.slice(0,7));
    try{
      const index=await readIndex(companyId);if(!index)return null;
      // The index is small. Read only the two latest source files at the
      // observation cutoff, plus same-time ties so ambiguity stays visible.
      const eligible=index.sources.filter(row=>kst(new Date(row.collectedAt))<=asOf).sort((a,b)=>Date.parse(b.collectedAt)-Date.parse(a.collectedAt)||b.runId.localeCompare(a.runId));
      const latestTime=eligible[0]?.collectedAt,previousTime=eligible.find(row=>row.collectedAt!==latestTime)?.collectedAt;
      const references=eligible.filter(row=>row.collectedAt===latestTime||row.collectedAt===previousTime);
      const sources=[];
      for(const reference of references){
        const value=root?await readJson(path.join(folder(companyId),reference.contentDigest+'.json')):memory.get(companyId)?.sources.get(reference.contentDigest);
        if(!value||hash(value)!==reference.contentDigest||value.namespaceDigest!==namespaceDigest||value.companyId!==companyId||value.placeId!==index.placeId||value.source.runId!==reference.runId||value.source.collectedAt!==reference.collectedAt||value.source.sourceDigest!==reference.sourceDigest)throw fault('PUBLIC_PICKUP_STORE_INVALID');
        sources.push(value.source);
      }
      const value=computePublicBookingPickup({version:VERSION,companyId,placeId:index.placeId,sources},{companyId,placeId:index.placeId,asOf,dates});
      // Do not send the original product rows to a customer. The customer gets
      // scoped daily counts and source references only, never total estimates.
      return {...value,rows:value.rows.map(({productEvidence,...row})=>row)};
    }catch(error){return {companyId,status:'unavailable',calculationVersion:CALCULATION_VERSION,rows:[],publicChange:null,days:0,reasonCode:'PUBLIC_PICKUP_STORE_INVALID',reason:'공개예약 원본의 저장·무결성을 확인하지 못했습니다.',publicOnly:true,wholeReservationRestored:false,inferredChange:null,actionable:false,executionAllowed:false};}
  }
  return {importLedger,project};
}
module.exports={createPublicBookingPickupStore};
