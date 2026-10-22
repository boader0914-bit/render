'use strict';
const {createHash}=require('node:crypto');

// This is an Insight-process cache, not a second source of company data. The
// caller supplies an opaque host/mode/session scope and both central GETs.
function createCompanyReadCache({now=Date.now,ttlMs=600000,refreshMs=30000,maxEntries=64,maxBytes=16*1024*1024,maxPerScope=8,maxScopes=maxEntries*2}={}) {
  const entries=new Map(),states=new Map(),pendingSources=new Map();
  let bytes=0;
  const clock=()=>Number(now());
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const failure=(status,code,message)=>({status,ok:false,data:{error:{code,message}}});
  const unavailable=()=>failure(503,'CONNECTION_UNAVAILABLE','자료 연결을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.');
  const invalidated=()=>failure(409,'COMPANY_VIEW_INVALIDATED','등록 상태가 변경되었습니다. 다시 조회해 주세요.');
  const notFound=()=>failure(404,'NOT_FOUND','등록한 업체의 결과를 찾을 수 없습니다.');
  const active=request=>['dispatching','queued','collecting'].includes(request?.status);
  const kst=value=>new Date(value+9*3600000).toISOString().slice(0,10);
  const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
  const meta=(state,checkedAt,refreshing=false,refreshFailed=false)=>({state,checkedAt:new Date(checkedAt).toISOString(),refreshing,refreshFailed});
  function remove(key) {const entry=entries.get(key);if(entry){bytes-=entry.bytes;entries.delete(key);}}
  function clearEntries(scope) {for(const [key,entry] of entries)if(entry.scope===scope)remove(key);}
  function invalidate(scope) {
    const state=states.get(scope);if(state)state.epoch++;
    clearEntries(scope);states.delete(scope);
    for(const [key,pending] of pendingSources)if(pending.scope===scope)pendingSources.delete(key);
  }
  function scopeState(scope) {
    let state=states.get(scope);
    if(!state){state={scope,epoch:0,identity:null,fingerprints:new Map(),denied:new Map(),revoked:null};states.set(scope,state);}
    else{states.delete(scope);states.set(scope,state);}
    while(states.size>maxScopes)invalidate(states.keys().next().value);
    return state;
  }
  function current(state,epoch,key,fingerprint) {
    return states.get(state.scope)===state&&state.epoch===epoch&&(!key||state.fingerprints.get(key)===fingerprint);
  }
  function revoke(state,reply) {
    state.epoch++;state.revoked={reply,at:clock()};state.denied.clear();state.fingerprints.clear();clearEntries(state.scope);
    for(const [key,pending] of pendingSources)if(pending.scope===state.scope)pendingSources.delete(key);
  }
  async function safeRead(read) {
    try {
      const reply=await read();
      if(!reply||!Number.isInteger(reply.status)||!reply.data||typeof reply.data!=='object')return unavailable();
      return {status:reply.status,ok:reply.ok===true&&reply.status>=200&&reply.status<300,data:reply.data};
    }catch{return unavailable();}
  }
  function identityRead(state,readIdentity) {
    // Share only a simultaneously pending permission check, never a settled
    // permission result or a time-based authentication cache.
    if(!state.identity){
      const promise=safeRead(readIdentity);state.identity=promise;
      promise.finally(()=>{if(state.identity===promise)state.identity=null;});
    }
    return state.identity;
  }
  function validatedIdentity(data,companyId) {
    const customer=data.customer;
    if(!customer||typeof customer.customerId!=='string'||!customer.customerId||customer.accountStatus!=='active'||!Array.isArray(customer.relations)||!Array.isArray(data.companies))return null;
    const relation=customer.relations.find(row=>row.companyId===companyId&&['active','pending'].includes(row.status));
    const company=data.companies.find(row=>row.companyId===companyId);
    if(!relation||!company)return null;
    const request=(Array.isArray(data.preparations)?data.preparations:[]).find(row=>row.companyId===companyId)||null;
    return {data,customer,company,relation,request};
  }
  function fingerprint(identity) {
    return hash({customerId:identity.customer.customerId,revision:identity.customer.revision,relation:identity.relation,company:identity.company,request:identity.request,day:kst(clock())});
  }
  function sourceScope(data,companyId,month) {
    const selected=data.companyDetail?.integrated?.selectedMonth;
    return (!data.result?.companyId||data.result.companyId===companyId)&&(!data.companyDetail?.companyId||data.companyDetail.companyId===companyId)&&(!month||!selected||selected===month);
  }
  function cacheable(data,identity) {
    return Boolean(data.result||data.companyDetail)&&!active(identity.request)&&!active(data.request)&&!['pending','updating'].includes(data.companyDetail?.integrated?.status);
  }
  function remember(key,state,mark,data) {
    let core;try{core=JSON.stringify({result:data.result??null,companyDetail:data.companyDetail??null});}catch{return;}
    const size=Buffer.byteLength(core,'utf8');if(size>maxBytes||maxEntries<1||maxPerScope<1)return;
    remove(key);
    const at=clock();entries.set(key,{scope:state.scope,fingerprint:mark,core,bytes:size,checkedAt:at,lastAttempt:at,refreshFailed:false});bytes+=size;
    let scoped=[...entries].filter(([,entry])=>entry.scope===state.scope);
    while(scoped.length>maxPerScope){remove(scoped[0][0]);scoped.shift();}
    while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);
  }
  function compose(entry,identity,refreshing) {
    const core=JSON.parse(entry.core),request=clone(identity.request);
    return {status:200,ok:true,data:{...core,request,collectionAllowance:clone(identity.data.collectionAllowance),previousResult:Boolean(core.result&&request&&core.result.runId!==request.runId),responseCache:meta('cached',entry.checkedAt,refreshing,entry.refreshFailed)}};
  }
  function sourceRead({key,state,epoch,mark,companyId,month,identity,readSource}) {
    const former=pendingSources.get(key);
    if(former&&former.state===state&&former.epoch===epoch&&former.mark===mark)return former.promise;
    const entry=entries.get(key);if(entry)entry.lastAttempt=clock();
    const pending={scope:state.scope,state,epoch,mark,promise:null};
    pending.promise=safeRead(readSource).then(reply=>{
      if(!current(state,epoch,key,mark))return reply;
      if(!reply.ok){
        if([401,403].includes(reply.status))revoke(state,reply);
        else if(reply.status===404){remove(key);state.denied.set(key,{reply,mark,at:clock()});}
        else{const previous=entries.get(key);if(previous&&previous.fingerprint===mark)previous.refreshFailed=true;}
        return reply;
      }
      if(!sourceScope(reply.data,companyId,month)){
        const previous=entries.get(key);if(previous)previous.refreshFailed=true;
        return unavailable();
      }
      state.revoked=null;state.denied.delete(key);
      if(cacheable(reply.data,identity))remember(key,state,mark,reply.data);else remove(key);
      return reply;
    }).finally(()=>{if(pendingSources.get(key)===pending)pendingSources.delete(key);});
    pendingSources.set(key,pending);return pending.promise;
  }
  async function read({scope,route='',companyId,month='',readIdentity,readSource,force=false}) {
    if(typeof scope!=='string'||!scope||typeof readIdentity!=='function'||typeof readSource!=='function')return unavailable();
    if(!/^[a-zA-Z0-9_-]+$/.test(companyId||'')||typeof month!=='string'||month&&!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))return failure(400,'INVALID_COMPANY_MONTH','업체와 숙박월을 확인해 주세요.');
    const state=scopeState(scope),epoch=state.epoch;
    const checked=await identityRead(state,readIdentity);
    if(!current(state,epoch))return invalidated();
    if(!checked.ok){if([401,403].includes(checked.status))revoke(state,checked);return checked;}
    const identity=validatedIdentity(checked.data,companyId);
    if(!identity){state.epoch++;state.fingerprints.clear();state.denied.clear();clearEntries(scope);return notFound();}
    const day=kst(clock()),key=JSON.stringify([scope,route,companyId,month||`default:${day.slice(0,7)}`]),mark=fingerprint(identity);
    const previousMark=state.fingerprints.get(key);
    if(previousMark&&previousMark!==mark){remove(key);state.denied.delete(key);}
    state.fingerprints.delete(key);state.fingerprints.set(key,mark);
    // Bound metadata as well as payloads; evicted in-flight reads may finish but
    // no longer have the matching fingerprint needed to insert an old result.
    while(state.fingerprints.size>maxPerScope*2){const oldest=state.fingerprints.keys().next().value;state.fingerprints.delete(oldest);state.denied.delete(oldest);remove(oldest);}
    if(state.revoked&&clock()-state.revoked.at>ttlMs)state.revoked=null;
    if(state.revoked&&!force)return state.revoked.reply;
    const denied=state.denied.get(key);
    if(denied&&(denied.mark!==mark||clock()-denied.at>ttlMs))state.denied.delete(key);
    else if(denied&&!force)return denied.reply;
    for(const [entryKey,entry] of entries)if(clock()-entry.checkedAt>=ttlMs)remove(entryKey);
    const entry=entries.get(key);
    if(entry&&entry.fingerprint===mark&&!force&&!active(identity.request)){
      entries.delete(key);entries.set(key,entry);
      let refreshing=pendingSources.has(key);
      if(!refreshing&&clock()-entry.lastAttempt>=refreshMs){sourceRead({key,state,epoch,mark,companyId,month,identity,readSource});refreshing=true;}
      return compose(entry,identity,refreshing);
    }
    const reply=await sourceRead({key,state,epoch,mark,companyId,month,identity,readSource});
    if(!reply.ok)return reply;
    if(!current(state,epoch,key,mark))return invalidated();
    if(!sourceScope(reply.data,companyId,month))return unavailable();
    return {...reply,data:{...clone(reply.data),responseCache:meta('fresh',clock())}};
  }
  return {read,invalidate};
}
module.exports={createCompanyReadCache};
