(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.InsightContextWorkspace=api;})(typeof window==='undefined'?globalThis:window,()=>{
  'use strict';
  let active=null,generation=0;const timers=new Set();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stop=()=>{generation++;for(const t of timers)clearTimeout(t);timers.clear();active=null;};
  const monthFor=(s,latest)=>s.stayMode==='month'&&s.stayMonth&&s.stayMonth<=latest?s.stayMonth:latest;
  function controls(state,s){
    const owns=state.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>state.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    return `<section class="card regional-context-controls">${owns.length?`<label class="field"><span>기준 내 매장</span><select data-context-own aria-label="지역분석 기준 내 매장">${owns.map(c=>`<option value="${esc(c.companyId)}" ${c.companyId===s.ownCompanyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>`:'<p class="muted">매장 준비 중 · 등록한 경쟁업체·관심지역의 참고자료</p>'}<p class="muted">최근 마감월까지의 저장 자료 · 실제 공표월은 지표별 표시</p><button type="button" class="button small" data-context-retry>저장 자료 확인</button></section>`;
  }
  function mount(options){
    stop();active=options;const id=generation,s=options.store.getState(),token=options.store.requestToken(),ownId=s.ownCompanyId||'',m=monthFor(s,window.InsightRegionalContext.previousMonth());
    const output=document.querySelector(options.mode==='home'?'#home-context-output':options.mode==='comparison'?'#comparison-regional-context':'#regional-context-output');
    const status=document.querySelector(options.mode==='home'?'#home-context-status':options.mode==='comparison'?'#comparison-regional-status':'#regional-context-status');
    if(!output)return;
    const current=()=>active===options&&generation===id&&output.isConnected&&options.store.isCurrent(token);
    let brief=options.peekBrief?.(ownId)||null,regional=window.InsightRegionalContext.peek(ownId,m),briefNotice='',regionNotice='',blocked=false;
    const show=()=>{
      if(!current())return;
      const selection={...options.store.getState(),regionMonth:m};
      output.innerHTML=blocked?'<section class="card"><p class="collection-warning">업체 등록·지역 연결과 조회 권한을 다시 확인해 주세요.</p><a href="#settings" class="text-link">등록 상태 보기</a></section>':options.mode==='home'?window.InsightHomeContextView.render(brief,regional,{state:options.state,selection}):regional?window.InsightRegionalContextView.render(regional,{state:options.state,selection}):'<div class="company-connection is-loading" role="status"><span class="connection-spinner" aria-hidden="true"></span><p>저장된 지역 요약을 연결하고 있습니다.</p></div>';
      if(status)status.textContent=[briefNotice,regionNotice].filter(Boolean).join(' · ');
    };
    const later=(fn,attempt)=>{if(attempt>=5)return;const t=setTimeout(()=>{timers.delete(t);if(current())void fn(attempt+1);},[2000,4000,8000,16000,30000][attempt]);timers.add(t);};
    const failed=(e,type)=>{
      if(!current())return;
      if([401,403,404,409].includes(e.status)){blocked=true;brief=null;regional=null;if(e.status===401)options.onSessionExpired?.();}
      const notice=type==='region'?regional?'지역 최신 확인 실패 · 정상 저장 자료 유지':'지역 저장 자료 연결 확인 필요':brief?'예약 최신 확인 실패 · 정상 저장 자료 유지':'예약 저장 자료 연결 확인 필요';
      if(type==='region')regionNotice=notice;else briefNotice=notice;
      show();
      if(!blocked&&!regional&&options.mode!=='home')output.innerHTML='<section class="card"><p class="collection-warning">지역 저장 자료를 확인하지 못했습니다.</p><button class="button" type="button" data-context-retry>다시 확인</button></section>';
    };
    async function loadRegion(attempt=0){
      try{const r=await window.InsightRegionalContext.read(ownId,m,options.api);if(!current())return;regional=r;const info=r.responseCache||{};regionNotice=info.refreshFailed?'지역 최신 확인 실패 · 정상 저장 자료 유지':info.refreshing||info.revalidationRequired?'지역 저장 자료 표시 · 최신 자료 확인 중':'지역 저장 자료 확인 완료';show();if((info.refreshing||info.revalidationRequired)&&!info.refreshFailed)later(loadRegion,attempt);}catch(e){failed(e,'region');}
    }
    async function loadBrief(attempt=0){
      try{const r=await options.readBrief(ownId);if(!current())return;brief=options.peekBrief(ownId)||r;const info=r.responseCache||{};briefNotice=info.refreshFailed?'예약 최신 확인 실패 · 정상 저장 자료 유지':info.refreshing||info.revalidationRequired||info.preview?'예약 저장 자료 표시 · 최신 계산 확인 중':'예약 저장 자료 확인 완료';show();if((info.refreshing||info.revalidationRequired||info.preview)&&!info.refreshFailed)later(loadBrief,attempt);}catch(e){failed(e,'brief');}
    }
    regionNotice=regional?'지역 저장 자료 표시 · 최신 자료 확인 중':'지역 요약 연결 중';
    const canBrief=options.mode==='home'&&ownId&&window.InsightComparisonView.exactCurrent(s);
    if(canBrief)briefNotice=brief?'예약 저장 자료 표시 · 최신 자료 확인 중':'예약 자료 연결 중';
    show();void loadRegion();if(canBrief)void loadBrief();
  }
  if(typeof document!=='undefined'){
    document.addEventListener('change',e=>{
      if(!active||!e.target.matches?.('[data-context-own]'))return;
      const options=active,updated=options.store.update({ownCompanyId:e.target.value});if(!updated.ok)return;options.onSelectionChange?.(updated.state);options.onRebuild?.();
    });
    document.addEventListener('click',e=>{if(!active||!e.target.closest?.('[data-context-retry]'))return;e.preventDefault();mount(active);});
  }
  return {controls,mount,stop,monthFor};
});
