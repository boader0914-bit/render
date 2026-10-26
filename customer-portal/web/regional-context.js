(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.InsightRegionalContext=api;})(typeof window==='undefined'?globalThis:window,()=>{
  'use strict';
  const clone=v=>JSON.parse(JSON.stringify(v));
  const month=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(v);
  const previousMonth=(now=Date.now())=>{const d=new Date(now+9*3600000);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()-1,1)).toISOString().slice(0,7);};
  const error=(status,code)=>Object.assign(Error('지역 연결 상태를 다시 확인해 주세요.'),{status,code});
  function createReader({now=Date.now}={}){
    let scope='',permission='',generation=0,identity=null,expired=null,order=0;
    const entries=new Map(),requests=new Map(),denied=new Set();
    const key=(ownId,m)=>JSON.stringify([scope,permission,ownId||'',m]);
    const ownIds=()=>identity?.customer?.relations?.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>r.companyId)||[];
    const allowed=id=>Boolean(scope)&&(!id||ownIds().includes(id));
    function clear(){generation++;entries.clear();requests.clear();denied.clear();}
    function configure({scope:next='',permissionVersion='',state=null,onSessionExpired=null}={}){
      const signature=JSON.stringify([permissionVersion,state?.comparisonRegionBindings,state?.customer?.relations,state?.customer?.regions]);
      if(scope!==next||permission!==signature){clear();scope=next;permission=signature;}
      identity=state;expired=onSessionExpired;
    }
    function valid(data,id,m){
      if(!allowed(id)||data?.schemaVersion!==1||data.mode!=='comparison_region_summary'||data.month!==m||data.ownId!==(id||null)||data.source!=='datalab_saved'||data.networkAttempted!==false||data.access?.summaryOnly!==true||data.access.fullAnalysis!==false||data.access.preparation!==false)return false;
      if(!Array.isArray(data.bindings)||!Array.isArray(data.groups)||!Array.isArray(data.unresolved))return false;
      const relations=identity.customer.relations.filter(r=>['active','pending'].includes(r.status)&&(r.kind==='competitor'||r.kind==='own'&&r.companyId===data.ownId));
      const expected=(identity.comparisonRegionBindings||[]).filter(b=>b.kind==='competitor'||b.kind==='own'&&b.companyId===data.ownId);
      if(data.bindings.length!==expected.length||new Set(data.bindings.map(b=>b.companyId)).size!==data.bindings.length)return false;
      for(const b of data.bindings){
        if(!relations.some(r=>r.companyId===b.companyId&&r.kind===b.kind&&r.status===b.relationStatus))return false;
        const known=identity.comparisonRegionBindings?.find(r=>r.companyId===b.companyId&&r.kind===b.kind);
        if(!known||['regionKey','analysisRegionKey','relationStatus'].some(k=>(b[k]??null)!==(known[k]??null)))return false;
      }
      const regions=new Set(data.bindings.map(b=>b.analysisRegionKey).filter(Boolean));
      for(const r of identity.customer.regions||[])if(r.status==='active'&&identity.regions?.some(v=>v.id===r.regionKey))regions.add(r.regionKey);
      if(new Set(data.groups.map(g=>g.region?.id)).size!==data.groups.length)return false;
      return data.groups.every(g=>regions.has(g.region?.id)&&Array.isArray(g.companyIds)&&g.companyIds.every(id=>data.bindings.some(b=>b.companyId===id&&b.analysisRegionKey===g.region.id))&&Array.isArray(g.summary?.sources)&&Array.isArray(g.summary?.sourceIssues));
    }
    function remember(id,m,data,requestOrder=0){
      if(!valid(data,id,m))throw error(409,'REGION_SUMMARY_SCOPE_CHANGED');
      const info=data.responseCache||{},at=Date.parse(info.checkedAt),time=now();
      if(!Number.isFinite(at)||at>time+60000)throw error(409,'REGION_SUMMARY_INVALID_TIME');
      const until=info.persisted===true?Date.parse(info.validUntil):at+30*60000;
      if(!Number.isFinite(until)||until<=time||until>at+7*86400000||info.persisted===true&&info.revalidationRequired!==true)throw error(409,'REGION_SUMMARY_EXPIRED');
      const k=key(id,m),previous=entries.get(k);if(previous&&previous.order>requestOrder)return clone(previous.data);
      entries.delete(k);entries.set(k,{data:clone(data),until,order:requestOrder});while(entries.size>24)entries.delete(entries.keys().next().value);denied.delete(k);return clone(data);
    }
    function peek(id='',m=previousMonth(now())){
      const k=key(id,m),entry=entries.get(k);if(!entry||!allowed(id)||denied.has(k))return null;
      if(entry.until<=now()||!valid(entry.data,id,m)){entries.delete(k);return null;}return clone(entry.data);
    }
    function restore(views,restoreScope){
      if(!scope||scope!==restoreScope||!Array.isArray(views))return;
      for(const row of views.slice(0,24)){if(typeof row?.ownId!=='string'||!month(row.month)||denied.has(key(row.ownId,row.month))||peek(row.ownId,row.month))continue;try{remember(row.ownId,row.month,row.data);}catch{}}
    }
    function read(id='',m=previousMonth(now()),api){
      if(!allowed(id))return Promise.reject(error(403,'REGION_SUMMARY_FORBIDDEN'));
      if(!month(m))return Promise.reject(error(400,'INVALID_MONTH'));
      const k=key(id,m);if(requests.has(k))return requests.get(k).then(clone);
      const g=generation,s=scope,p=permission,o=++order;
      const current=()=>g===generation&&s===scope&&p===permission&&allowed(id);
      const promise=Promise.resolve().then(()=>api('/regions/comparison-summary?'+new URLSearchParams({...id?{ownId:id}:{},month:m}))).then(data=>{
        if(!current())throw error(409,'REGION_SUMMARY_SCOPE_CHANGED');return remember(id,m,data,o);
      }).catch(e=>{
        if(!current())throw error(409,'REGION_SUMMARY_SCOPE_CHANGED');
        if([401,403,404,409].includes(e.status)){entries.delete(k);denied.add(k);if(e.status===401){clear();if(typeof expired==='function')expired();}}
        throw e;
      }).finally(()=>{if(requests.get(k)===promise)requests.delete(k);});
      requests.set(k,promise);return promise.then(clone);
    }
    return {configure,peek,read,restore,clear};
  }
  const shared=createReader();
  return {createReader,previousMonth,...shared};
});
