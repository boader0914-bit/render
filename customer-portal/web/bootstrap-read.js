(() => {
  'use strict';
  // Three fixed marks per document distinguish application readiness from QA waits.
  // Names and browser times only: no account, company, payload or credential details.
  const markAttributes={'insight-bootstrap-start':'data-insight-bootstrap-start-ms','insight-identity-ready':'data-insight-identity-ready-ms','insight-company-data-ready':'data-insight-company-ready-ms'},marked=new Set();
  window.InsightPerformance={markFirst(name){
    if(!Object.hasOwn(markAttributes,name)||marked.has(name))return;
    try{
      if(typeof performance==='undefined'||typeof performance.mark!=='function')return;
      const entry=performance.mark(name);marked.add(name);
      const at=typeof entry?.startTime==='number'?entry.startTime:performance.now?.();
      if(Number.isFinite(at)&&at>=0)document.documentElement?.setAttribute?.(markAttributes[name],at.toFixed(3));
    }catch{}
  }};
  window.InsightPerformance.markFirst('insight-bootstrap-start');
  // This page-scoped handoff starts protected reads alongside the larger UI assets.
  // Nothing is persisted, and connected.js consumes each response only once.
  const adminView=location.pathname==='/customer-view';
  const selectedCustomer=(()=>{if(!adminView)return '';try{return new URL(location.href).searchParams.get('customerId')||'';}catch{return '';}})();
  window.InsightAdminCustomerView={customerId:selectedCustomer,readOnly:()=>Boolean(selectedCustomer),headers:()=>selectedCustomer?{'X-Insight-Customer-Id':selectedCustomer}:{}};
  const base=adminView?'/api/insight-admin/v1':'/api/customer/v1';
  const bootstrapHeaders=()=>{
    const current=location.hash.slice(1)||'home',company=/^(?:company|collection|collect)=([a-zA-Z0-9_-]{1,180})$/.exec(current);
    // The saved-data launcher reuses the identity-only settings bucket; it
    // must not prefetch customer company, regional or report snapshots.
    const view=current==='saved-keyword-comparison'?'settings':company?'company':current.startsWith('regions=')?'regions':['home','property','competitors','regions','reports','settings'].includes(current)?current:null;
    return {Accept:'application/json',...window.InsightAdminCustomerView.headers(),...(view?{'X-Insight-Bootstrap-View':view}:{}),...(company?{'X-Insight-Bootstrap-Company':company[1]}:{})};
  };
  const reads=new Map();
  for(const path of [base+(adminView?'/customer-view':'')+'/me',base+(adminView?'/customer-view':'')+'/config']) {
    const controller=new AbortController();
    const promise=fetch(path,{headers:path.endsWith('/me')?bootstrapHeaders():{Accept:'application/json',...window.InsightAdminCustomerView.headers()},credentials:'same-origin',signal:controller.signal}).then(response=>({response}),error=>({error}));
    reads.set(path,{promise,abort(){controller.abort();}});
  }
  window.InsightBootstrapReads={headers:bootstrapHeaders,take(path){const read=reads.get(path);reads.delete(path);return read;}};
})();
