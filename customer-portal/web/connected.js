(() => {
  'use strict';
  const koreaDate = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0,10) : '일자 확인 전';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const menus = [['home','홈'],['property','내 매장'],['competitors','경쟁 분석'],['regions','지역 분석'],['reports','리포트'],['settings','설정']];
  const labels = { pending:'확인 대기',active:'등록 완료',rejected:'반려',verified:'반영 확인',withdrawn:'철회',superseded:'새 요청으로 대체',needs_review:'자료 준비 접수' };
  const dayUse = { unknown:'확인 전',none:'없음',separate:'별도 객실',shared:'숙박과 공유' };
  const adminView = location.pathname === '/customer-view';
  let adminCsrf = '';
  let state = null, config = {}, busy = false, searchSequence = 0, sessionExpired=false;
  const route = () => location.hash.slice(1) || ({'/signup':'signup','/login':'login','/terms':'terms','/privacy':'privacy'}[location.pathname]) || 'home';
  const menuRoute=()=>{const r=route();if(r.startsWith('regions='))return 'regions';if(/^(company|collection|collect)=/.test(r)){const id=r.slice(r.indexOf('=')+1);return state?.customer.relations.find(x=>x.companyId===id)?.kind==='competitor'?'competitors':'property';}return r;};
  const toast = message => { $('#toast').textContent = message; $('#toast').classList.add('visible'); setTimeout(() => $('#toast').classList.remove('visible'), 4500); };
  function expireSession(){window.InsightSession?.remember(adminView,location.hash);window.InsightAnalysis?.clearCache?.();state=null;adminCsrf='';sessionExpired=true;render();}
  async function api(url, data) {
    const base = adminView ? '/api/insight-admin/v1' : '/api/customer/v1';
    const target = adminView && url !== '/auth/logout' ? '/customer-view' + url : url;
    const response = await fetch(`${base}${target}`, { method:data ? 'POST':'GET', headers:data ? { 'Content-Type':'application/json','X-CSRF-Token':state?.csrfToken || adminCsrf || '' }: { Accept:'application/json' }, ...(data ? { body:JSON.stringify(data) }: {}) });
    const value = await response.json();
    if (!response.ok) { if(response.status===401&&url!=='/auth/login'&&url!=='/auth/signup')expireSession(); const error = new Error(value.error?.message || '요청을 처리하지 못했습니다.'); error.status = response.status; error.code = value.error?.code; throw error; }
    return value;
  }
  async function command(action, payload) {
    state = await api('/commands', { revision:state.customer.revision, requestKey:crypto.randomUUID(), action, payload });
    window.InsightAnalysis?.clearCache?.();
    if(action==='add-company'&&location.hash!=='#company='+encodeURIComponent(payload.companyId))location.hash='company='+encodeURIComponent(payload.companyId);else render(); toast(action==='collect'?'수집 요청 상태를 확인했습니다.':action.includes('correction')?'검수 요청을 저장했습니다.':'저장했습니다.');
  }
  const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  function auth() { $('#main').innerHTML = (sessionExpired?'<p class="collection-warning" role="alert">로그인이 만료되었습니다. 다시 로그인하면 보던 화면으로 돌아갑니다.</p>':'') + (adminView ? '<section class="card"><h1>관리자 로그인이 필요합니다.</h1><p>고객 화면을 이용하려면 관리자 계정으로 로그인해 주세요.</p><a class="button primary" href="/admin">관리자 로그인</a></section>' : window.InsightAuth.screen({ signup: route()==='signup', config })); }
  let policySequence = 0;
  async function policy(kind) {
    const serial = ++policySequence;
    $('#main').innerHTML = '<section class="card policy-card"><p role="status">안내 문서를 불러옵니다.</p></section>';
    try {
      const doc = await api(`/policies/${kind}`);
      if (serial !== policySequence || route() !== kind) return;
      $('#main').innerHTML = window.InsightAuth.policy(doc, config, Boolean(state));
    } catch(error) { if (serial===policySequence&&route()===kind) $('#main').innerHTML=`<section class="card"><h1>안내 문서를 확인하지 못했습니다.</h1><p>${esc(error.message)}</p><a href="/${kind}" class="button">다시 열기</a></section>`; }
  }
  function companyCard(relation,editingOnly=false) {
    const company = state.companies.find(row => row.companyId === relation.companyId);
    if (!company) return `<article class="connected-row"><strong>업체 연결 확인 필요</strong><p class="muted">기존 관계를 보존했습니다. 관리자에게 연결 상태를 확인해 주세요.</p></article>`;
    const settings = state.customer.settings[company.companyId] || {};
    const requests = state.corrections.filter(row => row.companyId === company.companyId);
    const prep = state.preparations.find(row => row.companyId === company.companyId);
    return `<article class="connected-row"><div><span class="status-pill ${relation.status==='pending'?'pending':''}">${esc(relation.status==='pending'?'매장 연결 확인 대기':labels[relation.status])}</span></div><h3>${esc(settings.nickname || company.name)}</h3><p class="muted">${esc(company.name)} · ${esc(company.address)}</p><p>객실 총량 <strong>${company.rooms===null?'확인 전':`${esc(company.rooms)}실`}</strong> <span class="muted">${esc(company.roomCountSource)}</span></p><div class="connected-actions">${editingOnly?'':`<a class="button primary small" href="#company=${encodeURIComponent(company.companyId)}">업체 자료 보기</a><a class="button small" href="#collect=${encodeURIComponent(company.companyId)}">30일 예약·추정매출 수집</a>`}<button class="button small" data-action="archive" data-relation="${esc(relation.relationId)}">등록 해제</button></div>${prep?`<p class="muted">${esc(prep.message)} · ${esc(koreaDate(prep.submittedAt))}</p>`:''}<details><summary>정보 수정 · 검수 요청 ${requests.some(row=>row.status==='pending')?'(대기 중)':''}</summary><form data-settings="${esc(company.companyId)}">${field('나만의 별칭','nickname',settings.nickname || '')}<label class="field"><span>나만의 메모</span><textarea name="note" maxlength="1000">${esc(settings.note || '')}</textarea></label><button class="button" type="submit">개인 설정 저장</button></form><form data-correction="${esc(company.companyId)}"><p class="muted">공통 정보는 관리자가 근거를 검토한 후 반영합니다.</p><div class="form-grid">${field('매장명','name',company.name)}${field('객실 수','rooms',company.rooms ?? '', 'number','min="1" step="1"')}${field('주소','address',company.address)}<label class="field"><span>데이유즈</span><select name="dayUse">${Object.entries(dayUse).map(([v,n])=>`<option value="${v}" ${company.dayUse===v?'selected':''}>${n}</option>`).join('')}</select></label></div>${field('시설·편의정보','facilities',company.facilities)}<label class="field"><span>변경 근거</span><textarea name="reason" required maxlength="1000" placeholder="확인한 객실 수, 안내 위치, 확인 날짜 등을 적어 주세요."></textarea></label><button class="button primary" type="submit">검수 요청 보내기</button></form>${requests.length?`<ol class="history-list">${requests.map(row=>`<li>${esc(labels[row.status] || row.status)} · ${esc(koreaDate(row.submittedAt))}<p>${esc(row.reason)}</p>${row.kind==='product'?`<p>상품 ${esc(row.baseValues.name)} · ${esc(row.target.date)}</p>`:''}<p>${Object.entries(row.proposed).map(([key,value])=>`${esc({rooms:'객실 수',total:'상품 객실 수',productType:'상품 구분',dayUse:'데이유즈',facilities:'시설',name:'이름',address:'주소'}[key]||key)}: ${esc(row.baseValues[key]??'확인 전')} → ${esc(value)}`).join(' · ')}</p>${row.reviewMessage?`<p>${esc(row.reviewMessage)}</p>`:''}${row.status==='pending'?`<button class="button small" data-action="withdraw" data-request="${esc(row.requestId)}">요청 철회</button>`:''}</li>`).join('')}</ol>`:''}</details></article>`;
  }
  function search(kind) { return `<section class="card search-box"><h2>${kind==='region'?'관심지역 추가':kind==='own'?'내 매장 등록':'경쟁업체 추가'}</h2><form id="search-form" data-kind="${kind}"><label class="field"><span>${kind==='region'?'시군구 이름':'업체명·주소·플레이스 번호'}</span><input name="q" required minlength="2" maxlength="120" placeholder="두 글자 이상 입력하세요."></label><button class="button" type="submit">저장된 업체·지역 검색</button></form><div id="search-results" class="search-results" aria-live="polite"></div></section>`; }
  function render() {
    searchSequence++; window.InsightAnalysis?.stop(); window.InsightCollection?.stop?.();
    document.body.dataset.page=menuRoute();
    $('#logout').hidden = !state;
    $('#admin-view-banner').hidden = !adminView || !state;
    $('#navigation').innerHTML = state ? menus.map(([key,label])=>`<a href="#${key}" class="nav-link ${menuRoute()===key?'active':''}">${label}</a>`).join(''):'';
    $('#customer-name').textContent = state ? state.customer.username : '사분 인사이트';
    document.body.classList.toggle('auth-view', !state);
    if (['terms','privacy'].includes(route())) { policy(route()); return; }
    policySequence++;
    if (!state) { auth(); return; }
    if (route() === 'welcome') { $('#main').innerHTML=window.InsightAuth.welcome(state.customer); return; }
    const c = state.customer, relations = c.relations.filter(row=>['active','pending'].includes(row.status));
    const limits=state.registrationAllowance || {ownLimit:1,...c.entitlements};
    const limitText=v=>v===null?'제한 없음':`${v}곳`;
    const own = relations.filter(row=>row.kind==='own'), competitors = relations.filter(row=>row.kind==='competitor');
    if(/^(company|collection|collect)=/.test(route())) {
      const id=decodeURIComponent(route().slice(route().indexOf('=')+1)),relation=relations.find(r=>r.companyId===id),company=state.companies.find(r=>r.companyId===id);
      if(!relation||!company){$('#main').innerHTML='<section class="card"><h1>등록한 업체를 찾을 수 없습니다.</h1><a href="#property">내 매장으로 이동</a></section>';return;}
      $('#main').innerHTML='<a class="text-link" href="#'+(relation.kind==='own'?'property':'competitors')+'">← 등록 업체로 돌아가기</a>'+window.InsightCollection.panel(company,state.features.directCollection,state.preparations.find(r=>r.companyId===id),state.collectionAllowance,route().startsWith('collect='))+'<section class="collection-company-edit"><h2>업체 정보 수정</h2>'+companyCard(relation,true)+'</section>';
      window.InsightCollection.mount(id,api);return;
    }
    const current = menus.find(([key])=>key===menuRoute()) || menus[0];
    let content = '';
    if (current[0]==='home') content = (window.InsightAnalysis?.panel('home',state)||'')+`<details class="card registration-summary"><summary>등록 현황 · 내 매장 ${own.length}곳 · 경쟁업체 ${competitors.length}곳 · 관심지역 ${c.regions.filter(activeRegion).length}곳</summary><div class="connected-list">${own.map(relation=>companyCard(relation)).join('')||'<p>내 매장을 등록하거나 설정에서 매장 준비 중으로 시작하세요.</p>'}</div></details>`;
    if (current[0]==='property') content = `<div class="connected-list">${own.map(relation => companyCard(relation)).join('') || '<div class="empty-note">내 매장 등록 후 관리자의 연결 확인을 받습니다.</div>'}</div>${limits.ownLimit===null||own.length<limits.ownLimit?search('own'):''}`;
    if (current[0]==='competitors') content = (window.InsightAnalysis?.panel('competitors',state)||'')+`<section class="competitor-management"><h2>등록 업체 관리</h2><p class="muted">등록 ${competitors.length} / ${limitText(limits.competitorLimit)} · ${limits.competitorLimit===null?'관리자 등록 수량 무제한':'제공 수량 변경은 관리자에게 문의하세요.'}</p><div class="connected-list">${competitors.map(relation=>companyCard(relation)).join('')||'<p class="empty-note">비교할 업체를 등록해 주세요.</p>'}</div>${limits.competitorLimit===null||competitors.length<limits.competitorLimit?search('competitor'):''}</section>`;
    if (current[0]==='regions') content = window.InsightAnalysis.panel('regions',state)+`<div class="connected-list region-registrations">${state.regions.map(row=>`<article class="connected-row"><h3>${esc(row.label)}</h3>${c.regions.some(r=>r.regionKey===row.id&&r.status==='active')?`<button class="button small" data-action="archive-region" data-relation="${esc(c.regions.find(r=>r.regionKey===row.id&&r.status==='active').relationId)}">관심지역 해제</button>`:'<span class="status-pill">내 매장 소재 지역</span>'}</article>`).join('')}</div>${limits.interestRegionLimit===null||c.regions.filter(activeRegion).length<limits.interestRegionLimit?search('region'):''}`;
    if (current[0]==='reports') content = window.InsightAnalysis.panel('reports',state);
    if (current[0]==='settings') content = `<section class="card"><h2>사업 정보</h2><form id="onboarding-form"><label class="field"><span>현재 상태</span><select name="businessStatus"><option value="planning" ${c.businessStatus==='planning'?'selected':''}>매장 준비 중</option><option value="owned" ${c.businessStatus==='owned'?'selected':''}>내 매장 등록</option></select></label>${field('매장·프로젝트 이름','projectName',c.projectName)}<button class="button primary" type="submit">저장</button></form></section>`;
    $('#main').innerHTML = `<div class="page-heading"><div><span class="eyebrow">SABUN INSIGHT</span><h1>${current[1]}</h1><p>${{home:'오늘 확인할 운영 지표와 다음 행동을 살펴보세요.',property:'내 매장 자료와 정보 수정 내역을 관리합니다.',competitors:'같은 날짜의 예약률과 객실 판매금액을 비교하세요.',regions:'지역 수요의 흐름과 최신 확보월을 확인하세요.',reports:'현재 상황과 주간·월간 숙박기간을 정리합니다.',settings:'사업 상태와 프로젝트 정보를 관리합니다.'}[current[0]]}</p></div></div>${content}`;
    if(['home','competitors','regions','reports'].includes(current[0]))window.InsightAnalysis?.mount(current[0],api,state,route().startsWith('regions=')?decodeURIComponent(route().slice(8)):null);
  }
  function activeRegion(row) { return row.status==='active'; }
  document.addEventListener('submit', async event => {
    event.preventDefault(); if(busy) return;
    const form=event.target, p=Object.fromEntries(new FormData(form)); busy=true;
    form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      if(form.id==='auth-form') {
        const signup=route()==='signup';
        if(signup&&!config.signupEnabled)throw new Error('현재 신규 가입을 받지 않습니다.');
        if(signup&&p.password!==p.passwordConfirm)throw new Error('비밀번호 확인이 일치하지 않습니다.');
        state=await api(signup?'/auth/signup':'/auth/login', {...p,...(signup?{agreeTerms:!!p.agreeTerms,agreePrivacy:!!p.agreePrivacy,confirmAge:!!p.confirmAge,termsVersion:config.termsVersion,privacyVersion:config.privacyVersion}:{})}); sessionExpired=false;location.hash=signup?'welcome':window.InsightSession?.consume(adminView)||'home'; render();
      } else if(form.dataset.collect) await command('collect',{companyId:form.dataset.collect,checkIn:p.checkIn,bookingRangeDays:Number(p.bookingRangeDays),dayUseMode:p.dayUseMode});
      else if(form.dataset.productCorrection !== undefined) await command('product-correction',window.InsightCollection.correction(form.dataset.productCorrection,p));
      else if(form.id==='onboarding-form') await command('onboarding',p);
      else if(form.id==='search-form') {
        const serial=++searchSequence, kind=form.dataset.kind;
        const data=await api(`/catalog/${kind==='region'?'regions':'companies'}?q=${encodeURIComponent(p.q)}`);
        if(serial!==searchSequence)return;
        $('#search-results').innerHTML=data.results.map(row=>`<button type="button" data-action="add" data-kind="${kind}" data-id="${esc(row.companyId||row.id)}"><strong>${esc(row.name||row.label)}</strong><span class="muted">${esc(row.address||'')} · 등록</span></button>`).join('') || '<p class="muted">저장된 후보가 없습니다. 관리자에게 업체 등록을 요청해 주세요.</p>';
      } else if(form.dataset.settings) await command('settings',{companyId:form.dataset.settings,...p});
      else if(form.dataset.correction) {
        const company=state.companies.find(row=>row.companyId===form.dataset.correction), proposed={};
        for(const key of ['name','address','rooms','dayUse','facilities']) {
          if(key==='rooms'&&p[key]==='')continue;
          const value=key==='rooms'?Number(p[key]):p[key].trim(); if(value!==company[key])proposed[key]=value;
        }
        if(!Object.keys(proposed).length)throw new Error('변경할 정보를 입력해 주세요.');
        await command('correction',{companyId:company.companyId,baseVersion:company.version,proposed,reason:p.reason});
      }
    } catch(error) { const slot=form.querySelector('.form-error'); if(slot){slot.textContent=error.message;slot.focus();} else toast(error.message); if(error.code==='STALE_REVISION'||error.code==='STALE_COMPANY'){state=await api('/me');render();} }
    finally {busy=false;form.querySelectorAll('button').forEach(button=>button.disabled=false);if(form.dataset.collect)await window.InsightCollection.refresh();}
  });
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-action]');if(!button||busy)return;
    const action=button.dataset.action;
    if(action==='theme'){const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('insight-theme',theme);}catch{}return;}
    busy=true;button.disabled=true;
    try{
      if(action==='check-username'){const input=$('[name=username]'), slot=$('#username-status');if(!input.reportValidity())return;const requested=input.value.trim(), value=await api(`/auth/username?username=${encodeURIComponent(requested)}`);if(!slot.isConnected||input.value.trim()!==requested)return;slot.textContent=value.message;slot.dataset.available=String(value.available);}
      else if(action==='logout'){await api('/auth/logout',{});window.InsightAnalysis?.clearCache?.();window.InsightSession?.clear(adminView);state=null;adminCsrf='';sessionExpired=false;if(adminView){location.assign('/admin');return;}location.hash='login';render();}
      else if(action==='add')await command(button.dataset.kind==='region'?'add-region':'add-company',button.dataset.kind==='region'?{regionKey:button.dataset.id}:{kind:button.dataset.kind,companyId:button.dataset.id});
      else if(action==='archive')await command('archive-company',{relationId:button.dataset.relation});
      else if(action==='archive-region')await command('archive-region',{relationId:button.dataset.relation});
      else if(action==='withdraw')await command('withdraw-correction',{requestId:button.dataset.request});
      else if(action==='refresh-collection')await window.InsightCollection.refresh();
    }catch(error){toast(error.message);}finally{busy=false;button.disabled=false;}
  });
  document.addEventListener('input',event=>{const form=event.target.closest('[data-product-correction]');if(form)form.dataset.dirty='true';if(event.target.name==='username'&&$('#username-status'))$('#username-status').textContent='';});
  window.addEventListener('hashchange',()=>{render();$('#main').focus();window.scrollTo(0,0);});
  try{document.documentElement.dataset.theme=localStorage.getItem('insight-theme')==='dark'?'dark':'light';}catch{}
  (async()=>{try{
    if(adminView){
      const response=await fetch('/api/insight-admin/v1/me',{headers:{Accept:'application/json'}});
      if(response.status===401){expireSession();return;}
      const identity=await response.json();if(!response.ok)throw new Error(identity.error?.message||'관리자 연결을 확인해 주세요.');
      adminCsrf=identity.csrfToken;config=await api('/config');state=await api('/start',{});
    }else{config=await api('/config');try{state=await api('/me');}catch(error){if(error.status!==401)throw error;}}
    render();
  }catch(error){if(adminView&&error.status===401){state=null;render();return;}$('#main').innerHTML=`<section class="card"><h1>자료 연결 확인이 필요합니다.</h1><p>${esc(error.message)}</p><a class="button" href="${adminView?'/customer-view':'/'}">다시 열기</a></section>`;}})();
})();
