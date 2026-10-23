'use strict';
const {createHash}=require('node:crypto');

// A session-scoped copy of the public, saved regional projection. Permission
// results are never cached: each read must obtain a fresh central identity.
function createRegionReadCache({now=Date.now,ttlMs=30*60000,refreshMs=30000,maxEntries=64,maxBytes=8*1024*1024,maxPerScope=24,maxScopes=maxEntries*2,maxSnapshotBytes=512*1024}={}) {
  const entries=new Map(),states=new Map(),pendingSources=new Map();let bytes=0;
  const clock=()=>Number(now());
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const failure=(status,code,message)=>({status,ok:false,data:{error:{code,message}}});
  const unavailable=()=>failure(503,'CONNECTION_UNAVAILABLE','지역 자료 연결을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.');
  const invalidated=()=>failure(409,'REGION_VIEW_INVALIDATED','지역 연결 상태가 변경되었습니다. 다시 조회해 주세요.');
  const notFound=()=>failure(404,'NOT_FOUND','등록한 지역의 자료를 찾을 수 없습니다.');
  const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
  const keyFor=(scope,regionKey,month)=>JSON.stringify([scope,regionKey,month]);
  const validMonth=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  const validRegion=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]+$/.test(value);
  const meta=(entry,refreshing=false)=>({state:'cached',checkedAt:new Date(entry.checkedAt).toISOString(),refreshing,refreshFailed:entry.refreshFailed});
  const primitive=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
  const pick=(value,keys)=>!value||typeof value!=='object'||Array.isArray(value)?null:Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)&&primitive(value[key])).map(key=>[key,value[key]]));
  const row=value=>pick(value,['key','label','value','unit','status']);
  const point=value=>pick(value,['month','value']);
  const delta=value=>pick(value,['value','kind']);
  const rows=value=>Array.isArray(value)?value.map(row).filter(Boolean):[];
  function source(value) {
    const result=pick(value,['key','label','provider','status','period','periodType','keyword','normalizationPeriod','partialMonth','referenceOnly','sourceUrl','retrievedAt','sourceUpdatedAt']);
    if(!result)return null;
    result.rows=rows(value.rows);
    if(Array.isArray(value.series))result.series=value.series.map(item=>({...pick(item,['month','status','retrievedAt']),rows:rows(item?.rows)}));
    if(Array.isArray(value.metrics))result.metrics=value.metrics.map(item=>({...pick(item,['key','label','unit','observedMonths']),latest:point(item?.latest),mom:delta(item?.mom),yoy:delta(item?.yoy),peak:point(item?.peak),low:point(item?.low)}));
    return result;
  }
  function publicCore(data) {
    // Use an allow-list at every level, rather than retaining an accidental
    // account, session, raw evidence or service credential from an upstream.
    const core=pick(data,['month','source','networkAttempted','availableSources','refreshAvailable']);
    core.region=pick(data.region,['id','label']);
    core.window=pick(data.window,['start','end','months','storageStart','storageMonths','currentMonth']);
    core.location=pick(data.location,['interpretation','recommendedProduct','caution','source','updatedAt','basis']);
    if(core.location)core.location.clusters=Array.isArray(data.location.clusters)?data.location.clusters.map(item=>pick(item,['name','demand','product'])).filter(Boolean):[];
    core.sources=data.sources.map(source).filter(Boolean);
    core.warnings=Array.isArray(data.warnings)?data.warnings.filter(value=>typeof value==='string'):[];
    core.interim=pick(data.interim,['month','status']);
    if(core.interim)core.interim.sources=Array.isArray(data.interim.sources)?data.interim.sources.map(source).filter(Boolean):[];
    return core;
  }
  function sourceScope(data,regionKey,month) {
    return data?.region?.id===regionKey&&data.networkAttempted===false&&Array.isArray(data.sources)&&
      (!data.window?.end||data.window.end===month)&&(Object.hasOwn(data,'month')?data.month===month:data.window?.end===month);
  }
  function identityFor(data,regionKey) {
    const customer=data?.customer;
    if(!customer||typeof customer.customerId!=='string'||!customer.customerId||customer.accountStatus!=='active'||!Array.isArray(data.regions))return null;
    const region=data.regions.find(item=>item?.id===regionKey);
    return region?{customer,region}:null;
  }
  const fingerprint=identity=>hash({customerId:identity.customer.customerId,revision:identity.customer.revision,region:identity.region});
  function remove(key) {const entry=entries.get(key);if(entry){entries.delete(key);bytes-=entry.bytes;}}
  function clearEntries(scope) {for(const [key,entry] of entries)if(entry.scope===scope)remove(key);}
  function invalidate(scope) {
    const state=states.get(scope);if(state)state.epoch++;
    clearEntries(scope);states.delete(scope);
    for(const [key,pending] of pendingSources)if(pending.scope===scope)pendingSources.delete(key);
  }
  function scopeState(scope) {
    let state=states.get(scope);
    if(!state){state={scope,epoch:0,permissionVersion:0,identity:null,marks:new Map(),denied:new Map(),revoked:null};states.set(scope,state);}
    else{states.delete(scope);states.set(scope,state);}
    while(states.size>maxScopes)invalidate(states.keys().next().value);
    return state;
  }
  const current=(state,epoch,key,mark,binding)=>states.get(state.scope)===state&&state.epoch===epoch&&(!key||state.marks.get(key)?.mark===mark&&(!binding||state.marks.get(key)===binding));
  function syncIdentity(state,data) {
    for(const [key,stored] of state.marks){
      const checked=identityFor(data,stored.regionKey);
      if(!checked||fingerprint(checked)!==stored.mark){state.marks.delete(key);remove(key);pendingSources.delete(key);}
    }
    for(const [regionKey,denied] of state.denied){const checked=identityFor(data,regionKey);if(!checked||fingerprint(checked)!==denied.mark)state.denied.delete(regionKey);}
  }
  function revoke(state,reply) {
    state.epoch++;state.revoked={reply,at:clock()};state.marks.clear();state.denied.clear();clearEntries(state.scope);
    for(const [key,pending] of pendingSources)if(pending.scope===state.scope)pendingSources.delete(key);
  }
  function denyRegion(state,regionKey,mark,reply) {
    for(const [key,stored] of state.marks)if(stored.regionKey===regionKey){state.marks.delete(key);remove(key);pendingSources.delete(key);}
    state.denied.set(regionKey,{mark,reply,at:clock()});
    while(state.denied.size>maxPerScope*2)state.denied.delete(state.denied.keys().next().value);
  }
  async function safeRead(read) {
    try{const reply=await read();if(!reply||!Number.isInteger(reply.status)||!reply.data||typeof reply.data!=='object')return unavailable();
      return {status:reply.status,ok:reply.ok===true&&reply.status>=200&&reply.status<300,data:reply.data};
    }catch{return unavailable();}
  }
  function identityRead(state,readIdentity) {
    if(!state.identity){const promise=safeRead(readIdentity);state.identity=promise;promise.finally(()=>{if(state.identity===promise)state.identity=null;});}
    return state.identity;
  }
  function remember(key,state,mark,regionKey,month,core) {
    let serialized;try{serialized=JSON.stringify(core);}catch{return;}
    const size=Buffer.byteLength(serialized,'utf8');if(size>maxBytes||maxEntries<1||maxPerScope<1)return;
    remove(key);const at=clock();
    entries.set(key,{scope:state.scope,mark,regionKey,month,core:serialized,bytes:size,checkedAt:at,lastAttempt:at,refreshFailed:false});bytes+=size;
    let scoped=[...entries].filter(([,entry])=>entry.scope===state.scope);
    while(scoped.length>maxPerScope){remove(scoped[0][0]);scoped.shift();}
    while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);
  }
  const compose=(entry,refreshing=false)=>({status:200,ok:true,data:{...JSON.parse(entry.core),responseCache:meta(entry,refreshing)}});
  function sourceRead({key,state,epoch,mark,binding,regionKey,month,readSource}) {
    const former=pendingSources.get(key);
    if(former&&former.state===state&&former.epoch===epoch&&former.mark===mark&&former.binding===binding)return former.promise;
    const entry=entries.get(key);if(entry)entry.lastAttempt=clock();
    const pending={scope:state.scope,state,epoch,mark,binding,promise:null};
    pending.promise=safeRead(readSource).then(reply=>{
      if(!current(state,epoch,key,mark,binding))return invalidated();
      if(!reply.ok){
        if(reply.status===401)revoke(state,reply);
        else if([403,404].includes(reply.status))denyRegion(state,regionKey,mark,reply);
        else{const prior=entries.get(key);if(prior&&prior.mark===mark)prior.refreshFailed=true;}
        return reply;
      }
      if(!sourceScope(reply.data,regionKey,month)){const prior=entries.get(key);if(prior)prior.refreshFailed=true;return unavailable();}
      let core;try{core=publicCore(reply.data);core.month=month;}catch{return unavailable();}
      state.revoked=null;state.denied.delete(regionKey);remember(key,state,mark,regionKey,month,core);
      return {...reply,data:core};
    }).finally(()=>{if(pendingSources.get(key)===pending)pendingSources.delete(key);});
    pendingSources.set(key,pending);return pending.promise;
  }
  async function read({scope,regionKey,month,readIdentity,readSource,force=false}) {
    if(typeof scope!=='string'||!scope||typeof readIdentity!=='function'||typeof readSource!=='function')return unavailable();
    if(!validRegion(regionKey)||!validMonth(month))return failure(400,'INVALID_REGION_MONTH','지역과 마지막 기준월을 확인해 주세요.');
    const state=scopeState(scope),epoch=state.epoch,permissionVersion=state.permissionVersion,checked=await identityRead(state,readIdentity);
    if(!current(state,epoch)||permissionVersion!==state.permissionVersion)return invalidated();
    if(!checked.ok){if([401,403].includes(checked.status))revoke(state,checked);return checked;}
    syncIdentity(state,checked.data);const identity=identityFor(checked.data,regionKey);
    if(!identity)return notFound();
    const key=keyFor(scope,regionKey,month),mark=fingerprint(identity);
    const formerBinding=state.marks.get(key),binding=formerBinding?.mark===mark?formerBinding:{mark,regionKey,month};
    state.marks.delete(key);state.marks.set(key,binding);
    while(state.marks.size>maxPerScope*2){const oldest=state.marks.keys().next().value;state.marks.delete(oldest);remove(oldest);pendingSources.delete(oldest);}
    if(state.revoked&&clock()-state.revoked.at>=ttlMs)state.revoked=null;
    if(state.revoked&&!force)return state.revoked.reply;
    const denied=state.denied.get(regionKey);
    if(denied&&(denied.mark!==mark||clock()-denied.at>=ttlMs))state.denied.delete(regionKey);
    else if(denied&&!force)return denied.reply;
    for(const [entryKey,entry] of entries)if(clock()-entry.checkedAt>=ttlMs||clock()<entry.checkedAt)remove(entryKey);
    const entry=entries.get(key);
    if(entry&&entry.mark===mark&&!force){
      entries.delete(key);entries.set(key,entry);
      let refreshing=pendingSources.has(key);
      if(!refreshing&&clock()-entry.lastAttempt>=refreshMs){void sourceRead({key,state,epoch,mark,binding,regionKey,month,readSource});refreshing=true;}
      return compose(entry,refreshing);
    }
    const reply=await sourceRead({key,state,epoch,mark,binding,regionKey,month,readSource});
    if(!reply.ok)return reply;
    if(!current(state,epoch,key,mark,binding))return invalidated();
    return {...reply,data:{...clone(reply.data),responseCache:{state:'fresh',checkedAt:new Date(clock()).toISOString(),refreshing:false,refreshFailed:false}}};
  }
  function snapshot({scope,identity,maxViews=8}={}) {
    if(typeof scope!=='string'||!scope||!identity||typeof identity!=='object')return [];
    const state=states.get(scope),limit=Number.isFinite(maxViews)?Math.min(8,Math.max(0,Math.floor(maxViews))):8;
    if(!state)return [];
    // Fresh /me may revoke a region while an older refresh remains pending.
    // Prune its fingerprint as well as the saved payload before returning.
    state.permissionVersion++;state.identity=null;syncIdentity(state,identity);
    if(state.revoked||!limit)return [];
    const candidates=[];
    for(const [key,entry] of entries){
      if(entry.scope!==scope)continue;
      const age=clock()-entry.checkedAt;
      if(age<0||age>=ttlMs){remove(key);continue;}
      const checked=identityFor(identity,entry.regionKey);
      if(!checked||fingerprint(checked)!==entry.mark){remove(key);continue;}
      if(state.denied.has(entry.regionKey)||!validMonth(entry.month))continue;
      candidates.push({key,entry});
    }
    candidates.sort((a,b)=>b.entry.checkedAt-a.entry.checkedAt);
    const views=[];let payloadBytes=2;
    for(const {key,entry} of candidates){
      const pending=pendingSources.get(key),refreshing=Boolean(pending&&current(state,pending.epoch,key,pending.mark,pending.binding));
      const view={regionKey:entry.regionKey,month:entry.month,data:compose(entry,refreshing).data};
      const size=Buffer.byteLength(JSON.stringify(view),'utf8')+(views.length?1:0);
      if(payloadBytes+size>Math.min(maxBytes,maxSnapshotBytes))continue;
      payloadBytes+=size;views.push(view);entries.delete(key);entries.set(key,entry);
      if(views.length>=limit)break;
    }
    return views;
  }
  return {read,snapshot,invalidate};
}
module.exports={createRegionReadCache};
