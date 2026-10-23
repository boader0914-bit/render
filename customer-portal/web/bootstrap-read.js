(() => {
  'use strict';
  // This page-scoped handoff starts protected reads alongside the larger UI assets.
  // Nothing is persisted, and connected.js consumes each response only once.
  const adminView=location.pathname==='/customer-view';
  const base=adminView?'/api/insight-admin/v1':'/api/customer/v1';
  const reads=new Map();
  for(const path of [base+'/me',base+(adminView?'/customer-view':'')+'/config']) {
    const controller=new AbortController();
    const promise=fetch(path,{headers:{Accept:'application/json'},credentials:'same-origin',signal:controller.signal}).then(response=>({response}),error=>({error}));
    reads.set(path,{promise,abort(){controller.abort();}});
  }
  window.InsightBootstrapReads={take(path){const read=reads.get(path);reads.delete(path);return read;}};
})();
