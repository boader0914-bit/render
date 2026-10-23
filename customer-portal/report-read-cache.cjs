'use strict';
const {createHash}=require('node:crypto');
// Read-only report projections. Authorization is obtained afresh before every
// read/bootstrap; only account-isolated display data is written to disk.
function createReportReadCache({now=Date.now,ttlMs=10*60000,refreshMs=30000,maxEntries=64,maxBytes=16*1024*1024,maxPerScope=8,maxScopes=maxEntries*2,persistenceDirectory,namespace,persistentStore}={}) {
  const entries=new Map(),states=new Map(),pendingSources=new Map(),invalidatedScopes=new Set();let bytes=0;
  const clock=()=>Number(now()),DAY=86400000;
  const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
  const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  const hash=value=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
  const day=()=>new Date(clock()+9*3600000).toISOString().slice(0,10);
  const shift=(value,n)=>new Date(Date.parse(value+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
  const periodFor=start=>({start,end:shift(start,29),days:30});
  const validDay=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]+$/.test(value);
  const failure=(status,code,message)=>({status,ok:false,data:{error:{code,message}}});
  const unavailable=()=>failure(503,'CONNECTION_UNAVAILABLE','리포트 자료 연결을 확인하지 못했습니다. 잠시 후 다시 조회해 주세요.');
  const invalidated=()=>failure(409,'REPORT_VIEW_INVALIDATED','리포트의 등록 상태 또는 기준일이 변경되었습니다. 다시 조회해 주세요.');
  const notFound=()=>failure(404,'NOT_FOUND','등록한 내 매장의 리포트를 찾을 수 없습니다.');
  const fields=keys=>Object.fromEntries(keys.split(' ').map(key=>[key,true]));
  const totals=fields('days supply sold reservationRate publicBookings phoneBookings estimatedRevenue');
  const regionRow=fields('key label value unit status'),point=fields('month value'),delta=fields('value kind');
  const regionSource={...fields('key label provider status period periodType keyword normalizationPeriod partialMonth referenceOnly sourceUrl retrievedAt sourceUpdatedAt'),rows:[regionRow],series:[{...fields('month status retrievedAt'),rows:[regionRow]}],metrics:[{...fields('key label unit observedMonths'),latest:point,mom:delta,yoy:delta,peak:point,low:point}]};
  const regionSchema={...fields('month source networkAttempted availableSources refreshAvailable'),region:fields('id label'),window:fields('start end months storageStart storageMonths currentMonth'),location:{...fields('interpretation recommendedProduct caution source updatedAt basis'),clusters:[fields('name demand product')]},sources:[regionSource],warnings:[true],interim:{...fields('month status'),sources:[regionSource]}};
  const schema={...fields('mode published generatedAt ownId'),period:fields('start end days'),companies:[{...fields('companyId name rooms regionKey kind relationStatus unavailable lastObservedDay lastObservedAt'),summary:totals}],comparisons:[{...fields('companyId name commonDays gapPp status basis'),dates:[true],own:totals,competitor:totals}],regions:[regionSchema],actions:[fields('key title reason next check source')],definitions:[true]};
  function projectValue(value,shape){
    if(value===null)return null;
    if(shape===true)return typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)?value:undefined;
    if(Array.isArray(shape))return Array.isArray(value)?value.map(item=>projectValue(item,shape[0])).filter(item=>item!==undefined):undefined;
    if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
    return Object.fromEntries(Object.keys(shape).filter(key=>Object.hasOwn(value,key)).map(key=>[key,projectValue(value[key],shape[key])]).filter(([,item])=>item!==undefined));
  }
  function projectedCore(value,{periodStart}={}){
    const core=projectValue(value,schema);
    if(!core||core.mode!=='current_briefing'||core.published!==false||!Number.isFinite(Date.parse(core.generatedAt))||!core.period||!validDay(core.period.start)||core.period.days!==30||core.period.end!==shift(core.period.start,29)||periodStart&&core.period.start!==periodStart||!['companies','comparisons','regions','actions','definitions'].every(key=>Array.isArray(core[key])))return null;
    if(core.ownId!==null&&!validId(core.ownId))return null;
    if(core.companies.some(row=>!validId(row?.companyId)||!['own','competitor'].includes(row.kind)||!['active','pending'].includes(row.relationStatus)||!row.summary)||core.comparisons.some(row=>!validId(row?.companyId)||!row.own||!row.competitor)||core.regions.some(row=>!validId(row?.region?.id)||!Array.isArray(row.sources)||row.networkAttempted===true))return null;
    return core;
  }
  const projectionVersion=hash([schema,projectValue.toString(),projectedCore.toString(),validDay.toString(),validId.toString(),shift.toString()]);
  const disk=persistentStore||(persistenceDirectory&&namespace?require('./report-snapshot-store.cjs').createReportSnapshotStore({directory:persistenceDirectory,namespace,version:projectionVersion,now,project:projectedCore}):null);
  const ready=async()=>{if(disk)try{await disk.ready();}catch{}};
  function validatedIdentity(data,ownId){
    const customer=data?.customer;
    if(!customer||!validId(customer.customerId)||customer.accountStatus!=='active'||!Array.isArray(customer.relations)||!Array.isArray(data.companies)||!Array.isArray(data.regions))return null;
    const relations=customer.relations.filter(row=>row&&['active','pending'].includes(row.status)&&['own','competitor'].includes(row.kind)&&validId(row.companyId));
    const own=relations.filter(row=>row.kind==='own'),resolved=ownId||own[0]?.companyId||null;
    if(ownId&&!own.some(row=>row.companyId===ownId))return null;
    const selected=relations.filter(row=>row.kind==='competitor'||row.companyId===resolved).map(relation=>({relation,company:data.companies.find(row=>row?.companyId===relation.companyId)})).filter(row=>row.company);
    const regionKeys=new Set((customer.regions||[]).filter(row=>row&&['active','pending'].includes(row.status)).map(row=>row.regionKey));
    const ownCompany=selected.find(row=>row.relation.kind==='own'&&row.relation.status==='active'&&row.company.companyId===resolved)?.company;
    if(ownCompany?.regionKey)regionKeys.add(ownCompany.regionKey);
    const regions=data.regions.filter(row=>regionKeys.has(row?.id));
    return {data,customer,ownId,resolved,selected,regions};
  }
  const fingerprint=identity=>hash([identity.customer.customerId,identity.customer.revision,identity.customer.accountStatus,identity.customer.relations,identity.customer.regions||[],identity.data.companies,identity.data.regions,identity.data.preparations||[]]);
  const durableSlot=(identity,audience)=>typeof audience==='string'&&audience&&audience.length<4096?hash([namespace,audience,identity.customer.customerId,identity.ownId,fingerprint(identity)]):null;
  const keyFor=(scope,ownId,start,audience)=>JSON.stringify([scope,ownId,start,audience||'']);
  function sourceScope(core,identity,start){
    if(!core||core.period?.start!==start||core.period?.end!==shift(start,29)||core.period?.days!==30||core.ownId!==identity.resolved)return false;
    const allowed=new Map(identity.selected.map(row=>[row.company.companyId,row]));
    const seen=new Set();
    for(const company of core.companies||[]){
      const match=allowed.get(company.companyId);
      if(!match||seen.has(company.companyId)||company.kind!==match.relation.kind||company.relationStatus!==match.relation.status)return false;
      for(const field of ['name','rooms','regionKey'])if(Object.hasOwn(match.company,field)&&company[field]!==match.company[field])return false;
      seen.add(company.companyId);
    }
    if(seen.size!==allowed.size)return false;
    const competitors=new Set(identity.selected.filter(row=>row.relation.kind==='competitor').map(row=>row.company.companyId)),compared=new Set();
    for(const comparison of core.comparisons||[]){if(!competitors.has(comparison.companyId)||compared.has(comparison.companyId))return false;compared.add(comparison.companyId);if(comparison.dates?.some(date=>date<start||date>shift(start,29)))return false;}
    const regions=new Set(identity.regions.map(row=>row.id)),regionSeen=new Set(),regionMonth=new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7))-2,1)).toISOString().slice(0,7);
    for(const region of core.regions||[]){if(!regions.has(region.region.id)||regionSeen.has(region.region.id)||region.month!==regionMonth||region.window?.end&&region.window.end!==regionMonth)return false;regionSeen.add(region.region.id);}
    return regionSeen.size===regions.size&&compared.size===(identity.resolved?competitors.size:0);
  }
  // HTTP 200 can contain explicit source failures. Preserve the prior normal
  // report on refresh. A cold read reports source failure instead of saving
  // an incomplete reply as the next restart's normal report.
  const failedStatus=row=>['error','failed','unavailable','blocked'].includes(row?.status);
  const cacheable=core=>!core.companies.some(row=>row.unavailable===true)&&core.regions.every(region=>region.networkAttempted===false&&!region.sources.some(source=>failedStatus(source)||(source.rows||[]).some(failedStatus)||(source.series||[]).some(point=>failedStatus(point)||(point.rows||[]).some(failedStatus))));
  function remove(key){const previous=entries.get(key);if(previous){bytes-=previous.bytes;entries.delete(key);}}
  function clearEntries(scope){for(const [key,entry] of entries)if(entry.scope===scope)remove(key);}
  function invalidate(scope){const state=states.get(scope);if(state)state.epoch++;clearEntries(scope);states.delete(scope);invalidatedScopes.add(scope);while(invalidatedScopes.size>maxScopes)invalidatedScopes.delete(invalidatedScopes.values().next().value);for(const [key,pending] of pendingSources)if(pending.scope===scope)pendingSources.delete(key);}
  function scopeState(scope){let state=states.get(scope);if(!state){state={scope,epoch:0,permissionVersion:0,identity:null,marks:new Map(),denied:new Map(),revoked:null};states.set(scope,state);}else{states.delete(scope);states.set(scope,state);}while(states.size>maxScopes)invalidate(states.keys().next().value);return state;}
  const current=(state,epoch,key,mark,binding,start)=>states.get(state.scope)===state&&state.epoch===epoch&&(!start||day()===start)&&(!key||state.marks.get(key)?.mark===mark&&(!binding||state.marks.get(key)===binding));
  function syncIdentity(state,data){for(const [key,binding] of state.marks){const identity=validatedIdentity(data,binding.ownId);if(!identity||fingerprint(identity)!==binding.mark||binding.start!==day()){state.marks.delete(key);state.denied.delete(key);remove(key);pendingSources.delete(key);}}}
  function revoke(state,reply){state.epoch++;state.revoked=reply;state.marks.clear();state.denied.clear();clearEntries(state.scope);for(const [key,pending] of pendingSources)if(pending.scope===state.scope)pendingSources.delete(key);}
  async function safeRead(read){try{const reply=await read();if(!reply||!Number.isInteger(reply.status)||!reply.data||typeof reply.data!=='object')return unavailable();return {status:reply.status,ok:reply.ok===true&&reply.status>=200&&reply.status<300,data:reply.data};}catch{return unavailable();}}
  function identityRead(state,read){if(!state.identity){const promise=safeRead(read);state.identity=promise;promise.finally(()=>{if(state.identity===promise)state.identity=null;});}return state.identity;}
  const expiry=entry=>entry.validUntil??entry.checkedAt+ttlMs;
  function remember(key,state,mark,core,{checkedAt=clock(),validUntil=checkedAt+ttlMs,persisted=false}={}){
    const text=JSON.stringify(core),size=Buffer.byteLength(text);if(size>maxBytes||maxEntries<1||maxPerScope<1)return;
    remove(key);entries.set(key,{scope:state.scope,mark,core:text,bytes:size,checkedAt,validUntil,persisted,needsRevalidation:persisted,lastAttempt:checkedAt,refreshFailed:false});bytes+=size;
    let scoped=[...entries].filter(([,entry])=>entry.scope===state.scope);while(scoped.length>maxPerScope){remove(scoped[0][0]);scoped.shift();}while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);
  }
  function compose(entry,refreshing){return {status:200,ok:true,data:{...JSON.parse(entry.core),responseCache:{state:'cached',checkedAt:new Date(entry.checkedAt).toISOString(),refreshing,refreshFailed:entry.refreshFailed,...(entry.persisted?{persisted:true,validUntil:new Date(entry.validUntil).toISOString(),revalidationRequired:true}:{})}}};}
  function hydrate(key,state,mark,identity,start,audience){
    if(!disk||entries.has(key)||state.revoked||state.denied.has(key)||invalidatedScopes.has(state.scope))return;
    const slotKey=durableSlot(identity,audience);if(!slotKey)return;let saved;try{saved=disk.get(slotKey,start);}catch{return;}
    if(!saved||saved.slotKey!==slotKey||saved.periodStart!==start||!Number.isFinite(saved.checkedAt)||saved.checkedAt>clock()||!Number.isFinite(saved.validUntil)||saved.validUntil<=clock()||saved.validUntil>saved.checkedAt+7*DAY)return;
    const core=projectedCore(saved.core,{periodStart:start});if(!core||!sourceScope(core,identity,start)||!cacheable(core))return;
    remember(key,state,mark,core,{checkedAt:saved.checkedAt,validUntil:saved.validUntil,persisted:true});
  }
  function bind(state,ownId,start,mark,audience){const key=keyFor(state.scope,ownId,start,audience),previous=state.marks.get(key);if(previous?.mark!==mark){remove(key);state.denied.delete(key);state.marks.delete(key);}const binding=state.marks.get(key)||{ownId,start,mark};state.marks.delete(key);state.marks.set(key,binding);while(state.marks.size>maxPerScope*2){const oldest=state.marks.keys().next().value;state.marks.delete(oldest);state.denied.delete(oldest);remove(oldest);pendingSources.delete(oldest);}return {key,binding};}
  async function snapshot({scope,audience,identity,maxViews=4}={}){
    if(typeof scope!=='string'||!scope||!identity||typeof identity!=='object')return [];
    const checked=validatedIdentity(identity,'');if(!checked)return [];
    const state=states.get(scope)||(disk?scopeState(scope):null),limit=Number.isFinite(maxViews)?Math.min(4,Math.max(0,Math.floor(maxViews))):4;if(!state)return [];
    state.permissionVersion++;state.identity=null;syncIdentity(state,identity);if(state.revoked||!limit)return [];
    const epoch=state.epoch,permissionVersion=state.permissionVersion,start=day(),mark=fingerprint(checked);await ready();if(!current(state,epoch,null,null,null,start)||state.permissionVersion!==permissionVersion)return [];
    const requests=['',...checked.customer.relations.filter(row=>row.kind==='own'&&['active','pending'].includes(row.status)).map(row=>row.companyId)],views=[];let payloadBytes=2;
    for(const ownId of [...new Set(requests)]){
      const selected=validatedIdentity(identity,ownId);if(!selected)continue;const {key}=bind(state,ownId,start,mark,audience);hydrate(key,state,mark,selected,start,audience);const entry=entries.get(key);
      if(!entry||entry.mark!==mark||entry.checkedAt>clock()||clock()>=expiry(entry)||state.denied.has(key))continue;
      const core=projectedCore(JSON.parse(entry.core),{periodStart:start});if(!core||!sourceScope(core,selected,start)||!cacheable(core)){remove(key);continue;}
      const pending=pendingSources.get(key),refreshing=Boolean(pending&&pending.state===state&&pending.epoch===epoch&&pending.mark===mark),row={ownId,period:periodFor(start),data:compose(entry,refreshing).data};const size=Buffer.byteLength(JSON.stringify(row))+(views.length?1:0);
      if(payloadBytes+size>maxBytes)continue;payloadBytes+=size;views.push(row);if(views.length>=limit)break;
    }
    return views;
  }
  function sourceRead({state,epoch,key,mark,binding,identity,start,audience,readSource}){
    const former=pendingSources.get(key);if(former&&former.state===state&&former.epoch===epoch&&former.mark===mark&&former.binding===binding)return former.promise;
    const previous=entries.get(key);if(previous){previous.lastAttempt=clock();previous.needsRevalidation=false;}
    const slotKey=durableSlot(identity,audience);let ticket;try{if(slotKey)ticket=disk?.begin(slotKey,start);}catch{}
    const pending={scope:state.scope,state,epoch,mark,binding,promise:null};
    const isCurrent=()=>current(state,epoch,key,mark,binding,start);
    pending.promise=safeRead(readSource).then(async reply=>{
      if(!isCurrent())return invalidated();
      if(!reply.ok){if([401,403].includes(reply.status))revoke(state,reply);else if(reply.status===404){remove(key);state.denied.set(key,{reply,mark});}else{const entry=entries.get(key);if(entry)entry.refreshFailed=true;}return reply;}
      const core=projectedCore(reply.data,{periodStart:start});
      if(!core||!sourceScope(core,identity,start)){const entry=entries.get(key);if(entry)entry.refreshFailed=true;return unavailable();}
      if(!cacheable(core)){const entry=entries.get(key);if(entry){entry.refreshFailed=true;return {...compose(entry,false),preserved:true};}return failure(503,'REPORT_SOURCE_UNAVAILABLE','일부 리포트 자료를 확인하지 못했습니다. 이전 정상 자료가 있으면 유지합니다.');}
      state.revoked=null;state.denied.delete(key);const checkedAt=clock();
      if(disk&&slotKey)try{await disk.put({slotKey,periodStart:start,checkedAt,core,ticket,guard:isCurrent});}catch{}
      if(!isCurrent())return invalidated();invalidatedScopes.delete(state.scope);remember(key,state,mark,core,{checkedAt});return {status:200,ok:true,data:core,checkedAt};
    }).finally(()=>{if(pendingSources.get(key)===pending)pendingSources.delete(key);});
    pendingSources.set(key,pending);return pending.promise;
  }
  async function read({scope,audience,ownId='',readIdentity,readSource,force=false}={}){
    if(typeof scope!=='string'||!scope||typeof readIdentity!=='function'||typeof readSource!=='function')return unavailable();
    if(typeof ownId!=='string'||ownId&&!validId(ownId))return failure(400,'INVALID_REPORT_OWN','내 매장을 확인해 주세요.');
    const state=scopeState(scope),epoch=state.epoch,permissionVersion=state.permissionVersion,checked=await identityRead(state,readIdentity);
    if(!current(state,epoch)||state.permissionVersion!==permissionVersion)return invalidated();
    if(!checked.ok){if([401,403].includes(checked.status))revoke(state,checked);return checked;}
    syncIdentity(state,checked.data);const identity=validatedIdentity(checked.data,ownId);
    if(!identity){state.epoch++;state.marks.clear();state.denied.clear();clearEntries(scope);return notFound();}
    const start=day(),mark=fingerprint(identity),{key,binding}=bind(state,ownId,start,mark,audience);
    if(state.revoked&&!force)return state.revoked;const denial=state.denied.get(key);if(denial&&denial.mark===mark&&!force)return denial.reply;
    await ready();if(!current(state,epoch,key,mark,binding,start)||state.permissionVersion!==permissionVersion)return invalidated();
    for(const [entryKey,entry] of entries)if(clock()<entry.checkedAt||clock()>=expiry(entry))remove(entryKey);
    if(!force)hydrate(key,state,mark,identity,start,audience);const entry=entries.get(key);
    if(entry&&entry.mark===mark&&!force){entries.delete(key);entries.set(key,entry);let refreshing=pendingSources.has(key);if(!refreshing&&(entry.needsRevalidation||clock()-entry.lastAttempt>=refreshMs)){sourceRead({state,epoch,key,mark,binding,identity,start,audience,readSource});refreshing=true;}return compose(entry,refreshing);}
    const reply=await sourceRead({state,epoch,key,mark,binding,identity,start,audience,readSource});if(!reply.ok)return reply;if(!current(state,epoch,key,mark,binding,start))return invalidated();if(reply.preserved)return {status:reply.status,ok:reply.ok,data:reply.data};
    return {status:200,ok:true,data:{...clone(reply.data),responseCache:{state:'fresh',checkedAt:new Date(reply.checkedAt).toISOString(),refreshing:false,refreshFailed:reply.refreshFailed===true}}};
  }
  const flushPersistence=()=>disk?disk.flush():Promise.resolve();
  return {read,snapshot,invalidate,ready,flush:flushPersistence,flushPersistence,persistenceStatus:()=>disk?disk.status():{enabled:false}};
}
module.exports={createReportReadCache};
