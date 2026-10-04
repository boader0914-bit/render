(() => {
  'use strict';
  const safe=value=>/^#(?:home|property|competitors|regions|reports|settings|(?:company|collect|collection|regions)=[a-zA-Z0-9_-]+)$/.test(value||'');
  const key=admin=>'insight-return-'+(admin?'admin':'customer');
  const api={
    remember(admin,hash){if(safe(hash))try{sessionStorage.setItem(key(admin),hash);}catch{}},
    consume(admin){let target='#home';try{const saved=sessionStorage.getItem(key(admin));sessionStorage.removeItem(key(admin));if(safe(saved))target=saved;}catch{}return target;},
    clear(admin){try{sessionStorage.removeItem(key(admin));}catch{}},safe
  };
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightSession=api;
})();
