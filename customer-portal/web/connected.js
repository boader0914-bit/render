(() => {
  'use strict';
  const koreaDate = value => Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0,10) : '일자 확인 전';
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const menus = [['home','홈'],['property','내 매장'],['competitors','경쟁 분석'],['regions','지역 분석'],['reports','리포트'],['settings','설정']];
  const labels = { pending:'확인 대기',active:'등록 완료',rejected:'반려',verified:'반영 확인',withdrawn:'철회',superseded:'새 요청으로 대체',needs_review:'자료 준비 접수' };
  const dayUse = { unknown:'확인 전',none:'없음',separate:'별도 객실',shared:'숙박과 공유' };
  const adminView = location.pathname === '/customer-view';
  const selectedCustomerId=(()=>{if(!adminView)return '';try{return new URL(location.href).searchParams.get('customerId')||'';}catch{return '';}})();
  const customerViewHeaders=()=>adminView&&selectedCustomerId?{'X-Insight-Customer-Id':selectedCustomerId}:{};
  const customerViewReadOnly=()=>adminView&&(Boolean(selectedCustomerId)||state?.view?.readOnly===true);
  window.InsightAdminCustomerView={customerId:selectedCustomerId,headers:customerViewHeaders,readOnly:customerViewReadOnly};
  let adminRoster=null,adminRosterError=null,adminRosterRequest=null;
  let adminCsrf = '';
  let state = null, config = {}, busy = false, searchSequence = 0, selectedOwnId = null;
  let comparisonSelection=null,lastRenderedHash=null;
  let bootstrapStatus = 'loading', bootstrapError = null, bootstrapInFlight = false;
  let configStatus = 'loading', configError = null, configRequest = null;
  const recurringRequestKeys=new Map(),recurringUncertain=new Set(),recurringEpochs=new Map(),recurringStatusErrors=new Set();
  let recurringPollTimer=null,recurringPollGeneration=0,recurringPollOffset=0;
  const restoredStates=new WeakSet();
  const reportPermissionVersion=s=>s?JSON.stringify([s.customer.revision,s.customer.relations.filter(row=>['active','pending'].includes(row.status)),s.companies,s.regions,s.preparations,s.comparisonRegionBindings]):'';
  const route = () => location.hash.slice(1) || ({'/signup':'signup','/login':'login','/terms':'terms','/privacy':'privacy'}[location.pathname]) || 'home';
  const menuRoute=()=>route()==='saved-keyword-comparison'?'competitors':route()==='register-own'?'property':route().startsWith('regions=')?'regions':/^(company|collection|collect)=/.test(route())?(state?.customer.relations.find(row=>row.companyId===decodeURIComponent(route().split('=').slice(1).join('=')))?.kind==='own'?'property':'competitors'):route();
  const selectionFields=['ownCompanyId','comparisonIds','stayMode','stayMonth','stayStart','stayEnd','asOfDate','selectedView'];
  function selectionUrl(){
    if(!comparisonSelection||!state)return;
    const url=new URL(location.href);for(const key of selectionFields)url.searchParams.delete(key);
    for(const [key,value] of new URLSearchParams(comparisonSelection.toQuery()))url.searchParams.set(key,value);
    history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
  function configureSelection(scope){
    if(!window.InsightComparisonSelection)return;
    // Do not create an anonymous store during an initial render before /me:
    // it would delete the authenticated selection awaiting restoration.
    // A previously authenticated store must still lose every permission when
    // identity is cleared, including an administrator roster's HTTP 401.
    if(!state){comparisonSelection?.configure({scope:'',permissionSignature:'',authorizedOwnCompanyIds:[],authorizedComparisonIds:[],authorizedComparisonIdsByOwn:{}});return;}
    const relations=state?.customer.relations.filter(row=>['active','pending'].includes(row.status))||[],ownIds=relations.filter(row=>row.kind==='own').map(row=>row.companyId),ids=relations.filter(row=>row.kind==='competitor').map(row=>row.companyId);
    const ownId=ownIds.includes(selectedOwnId)?selectedOwnId:comparisonSelection?.getState().ownCompanyId;
    const context={scope,permissionSignature:reportPermissionVersion(state),authorizedOwnCompanyIds:ownIds,authorizedComparisonIds:ids,authorizedComparisonIdsByOwn:Object.fromEntries(ownIds.map(id=>[id,ids])),companies:(state?.companies||[]).map(c=>({...c,...state?.comparisonRegionBindings?.find(b=>b.companyId===c.companyId)})),ownCompanyId:ownIds.includes(ownId)?ownId:ownIds[0]||null,businessStatus:state?.customer.businessStatus||'planning',maxRangeDays:93};
    if(!comparisonSelection){let storage;try{storage=sessionStorage;}catch{}comparisonSelection=window.InsightComparisonSelection.createStore({...context,storage,url:location.href});}
    else comparisonSelection.configure(context);
    selectedOwnId=comparisonSelection.getState().ownCompanyId;
  }
  function selectionChanged(selection){selectedOwnId=selection.ownCompanyId;selectionUrl();}
  const toast = message => { $('#toast').textContent = message; $('#toast').classList.add('visible'); setTimeout(() => $('#toast').classList.remove('visible'), 4500); };
  const startupMark=name=>{try{window.InsightPerformance?.markFirst?.(name);}catch{}};
  const bootstrapHeaders=()=>{
    if(window.InsightBootstrapReads?.headers)return window.InsightBootstrapReads.headers();
    const current=route(),company=/^(?:company|collection|collect)=([a-zA-Z0-9_-]{1,180})$/.exec(current);
    // The archived-comparison launcher needs identity only; reuse the existing
    // settings bootstrap bucket without changing the actual settings screen.
    const view=current==='saved-keyword-comparison'?'settings':company?'company':current.startsWith('regions=')?'regions':['home','property','competitors','regions','reports','settings'].includes(current)?current:null;
    return {...(view?{'X-Insight-Bootstrap-View':view}:{}),...(company?{'X-Insight-Bootstrap-Company':company[1]}:{})};
  };
  async function responseValue(response) {
    let value;
    try { value = await response.json(); }
    catch { const error = new Error('자료 연결 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.'); error.status=response.status; error.code=response.ok?'INVALID_RESPONSE':`HTTP_${response.status}`; throw error; }
    if (!response.ok) { const error = new Error(value?.error?.message || '요청을 처리하지 못했습니다.'); error.status = response.status; error.code = value?.error?.code; throw error; }
    if(!value||typeof value!=='object'||Array.isArray(value)){const error=new Error('자료 연결 응답을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');error.status=response.status;error.code='INVALID_RESPONSE';throw error;}
    return value;
  }
  async function startupFetch(url,options) {
    const early=window.InsightBootstrapReads?.take?.(url);
    if(!early)return fetch(url,options);
    const abort=()=>early.abort();
    options.signal?.addEventListener('abort',abort,{once:true});
    try { const result=await early.promise;if(result.error)throw result.error;return result.response; }
    finally { options.signal?.removeEventListener('abort',abort); }
  }
  async function api(url, data, options={}) {
    if(data&&customerViewReadOnly()&&url!=='/auth/logout')throw new Error('고객 화면 확인 중에는 저장·수집·등록할 수 없습니다.');
    const base = adminView ? '/api/insight-admin/v1' : '/api/customer/v1';
    const target = adminView && url !== '/auth/logout' ? '/customer-view' + url : url;
    const response = await (options.startup===true?startupFetch:fetch)(`${base}${target}`, { method:data ? 'POST':'GET', headers:{...(data ? { 'Content-Type':'application/json','X-CSRF-Token':state?.csrfToken || adminCsrf || '' }: { Accept:'application/json',...(options.refresh===true?{'X-Insight-Refresh':'1'}:{}) }),...(url!=='/auth/logout'?customerViewHeaders():{}),...((options.startup===true&&url==='/me'||adminView&&url==='/start')?bootstrapHeaders():{})}, ...(data ? { body:JSON.stringify(data) }: {}), ...(options.signal?{signal:options.signal}:{}) });
    return responseValue(response);
  }
  const connectionLoading = message => `<section class="card" role="status" aria-live="polite"><div class="initial-loading"><span class="loading-ring" aria-hidden="true"></span><p>${esc(message)}</p></div></section>`;
  const connectionFailure = (error,action) => `<section class="card"><h1>자료 연결 확인이 필요합니다.</h1><p>${esc(error?.message || '잠시 후 다시 시도해 주세요.')}</p><button type="button" class="button" data-action="${action}">다시 연결</button></section>`;
  function configurationScreen() {
    $('#main').innerHTML=configStatus==='failed'?connectionFailure(configError,'retry-config'):connectionLoading('회원가입·이용 안내 설정을 확인하고 있습니다.');
  }
  async function bootstrapRead(read) {
    // Only startup GETs enter this retry path. Commands, login and /start remain single requests.
    for(let attempt=0;attempt<2;attempt++) {
      const controller=typeof AbortController==='function'?new AbortController():null;
      let timer;
      try {
        const timeout=controller?new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();const error=new Error('자료 연결 확인이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');error.code='BOOTSTRAP_TIMEOUT';reject(error);},8000);}):null;
        return await (timeout?Promise.race([read(controller.signal),timeout]):read());
      } catch(error) {
        // The BFF alone retries upstream HTTP failures. A client timeout cannot prove
        // that its upstream read stopped; only browser transport failures retry here.
        const transient=error.name==='TypeError';
        if(!transient||attempt===1)throw error;
        if(bootstrapStatus==='loading'&&!state)$('#main').innerHTML=connectionLoading('연결이 잠시 지연되어 다시 확인하고 있습니다.');
        await new Promise(resolve=>setTimeout(resolve,250));
      } finally { if(timer!==undefined&&typeof clearTimeout==='function')clearTimeout(timer); }
    }
  }
  function loadConfiguration() {
    if(configRequest)return configRequest;
    configStatus='loading';configError=null;
    configRequest=bootstrapRead(signal=>api('/config',undefined,{signal,startup:true})).then(value=>{config=value;configStatus='ready';},error=>{configStatus='failed';configError=error;}).finally(()=>{
      configRequest=null;
      if(bootstrapStatus!=='loading'&&(route()==='signup'&&!state||['terms','privacy'].includes(route())))render();
    });
    return configRequest;
  }
  function renderAdminBanner(query=''){
    const banner=$('#admin-view-banner');if(!banner||!adminView||!state)return;
    const current=state.view?.customerUsername||state.customer.username,readonly=customerViewReadOnly(),q=query.trim().toLowerCase();
    const roster=(adminRoster||[]).filter(row=>row.accountKind!=='admin_preview'&&/^cus_[a-zA-Z0-9-]+$/.test(row.customerId||''));
    const choices=roster.filter(row=>row.customerId===selectedCustomerId||!q||`${row.username||''} ${row.projectName||''}`.toLowerCase().includes(q));
    banner.innerHTML=`<div class="admin-view-context"><strong>${readonly?'고객 화면 확인 · 읽기 전용':'관리자 · 고객 화면'}</strong><p>${readonly?`${esc(current)} 고객의 등록 자료를 보고 있습니다. 등록·수정·수집·발행은 할 수 없습니다.`:'관리자 전용 체험 계정입니다. 등록·수정·요청 내용은 실제 저장됩니다.'}</p></div><div class="admin-view-selector"><label><span>고객 아이디 검색</span><input type="search" data-admin-customer-search value="${esc(query)}" placeholder="아이디·매장 이름" autocomplete="off"></label><label><span>확인할 고객</span><select data-admin-customer-select aria-label="확인할 고객" ${!adminRoster?'disabled':''}><option value="" ${!selectedCustomerId?'selected':''}>관리자 체험</option>${choices.map(row=>`<option value="${esc(row.customerId)}" ${row.customerId===selectedCustomerId?'selected':''} ${row.accountStatus==='disabled'?'disabled':''}>${esc(row.username||row.customerId)}${row.projectName?` · ${esc(row.projectName)}`:''}${row.accountStatus==='disabled'?' · 이용 중지':''}</option>`).join('')}${selectedCustomerId&&!choices.some(row=>row.customerId===selectedCustomerId)?`<option value="${esc(selectedCustomerId)}" selected>${esc(current)}</option>`:''}</select></label>${adminRosterError?`<p class="registration-note" role="status">${esc(adminRosterError)} <button type="button" class="button small" data-action="admin-roster-retry">고객 목록 다시 확인</button></p>`:!adminRoster?'<p class="muted" role="status">고객 목록 연결 중</p>':''}</div><a class="button small" href="/admin">관리자 화면</a>`;
    if(adminRoster===null&&!adminRosterRequest&&!adminRosterError)void loadAdminRoster();
  }
  function loadAdminRoster(){
    if(!adminView||!state||adminRosterRequest)return adminRosterRequest;
    adminRosterError=null;
    adminRosterRequest=fetch('/api/insight-admin/v1/customers',{headers:{Accept:'application/json'}}).then(responseValue).then(data=>{
      if(!Array.isArray(data.customers))throw Error('고객 목록 응답을 확인하지 못했습니다.');
      adminRoster=data.customers;adminRosterError=null;
    }).catch(error=>{adminRosterError=error.message||'고객 목록을 확인하지 못했습니다.';if(error.status===401){state=null;adminCsrf='';render();}}).finally(()=>{adminRosterRequest=null;if(state)renderAdminBanner();});
    return adminRosterRequest;
  }
  async function command(action, payload) {
    if(customerViewReadOnly())throw new Error('읽기 전용 고객 화면에서는 저장할 수 없습니다.');
    const affectedCompany=payload.companyId || state.customer.relations.find(row=>row.relationId===payload.relationId)?.companyId || state.corrections.find(row=>row.requestId===payload.requestId)?.companyId;
    state = await api('/commands', { revision:state.customer.revision, requestKey:crypto.randomUUID(), action, payload });
    if(affectedCompany)window.InsightCollection?.invalidate?.(affectedCompany);
    if(action==='add-company'&&location.hash!=='#company='+encodeURIComponent(payload.companyId))location.hash='company='+encodeURIComponent(payload.companyId);else render(); toast(action==='collect'?'수집 요청 상태를 확인했습니다.':action.includes('correction')?'검수 요청을 저장했습니다.':'저장했습니다.');
  }
  const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${esc(label)}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  function auth() { if(!adminView&&route()==='signup'&&configStatus!=='ready'){configurationScreen();return;} $('#main').innerHTML = adminView ? '<section class="card"><h1>관리자 로그인이 필요합니다.</h1><p>고객 화면을 이용하려면 관리자 계정으로 로그인해 주세요.</p><a class="button primary" href="/admin">관리자 로그인</a></section>' : window.InsightAuth.screen({ signup: route()==='signup', config }); }
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
  function correctionEditor(company) {
    if(customerViewReadOnly())return '';
    const requests=state.corrections.filter(row=>row.companyId===company.companyId);
    return `<details class="company-edit"><summary>정보 수정${requests.some(row=>row.status==='pending')?' · 검수 대기':''}</summary><form data-correction="${esc(company.companyId)}"><p class="muted">수정 내용은 검수 요청으로 별도 저장됩니다.</p><div class="form-grid">${field('매장명','name',company.name)}${field('객실 수','rooms',company.rooms??'','number','min="1" step="1"')}${field('주소','address',company.address)}<label class="field"><span>데이유즈</span><select name="dayUse">${Object.entries(dayUse).map(([v,n])=>`<option value="${v}" ${company.dayUse===v?'selected':''}>${n}</option>`).join('')}</select></label></div>${field('시설·편의정보','facilities',company.facilities)}<label class="field"><span>변경 근거</span><textarea name="reason" required maxlength="1000" placeholder="변경 내용과 확인 근거를 적어 주세요."></textarea></label><button class="button primary" type="submit">수정 요청 저장</button></form>${requests.length?`<ol class="history-list">${requests.map(row=>`<li>${esc(labels[row.status]||row.status)} · ${esc(koreaDate(row.submittedAt))}<p>${esc(row.reason)}</p>${row.kind==='product'?`<p>상품 ${esc(row.baseValues.name)} · ${esc(row.target.date)}</p>`:''}<p>${Object.entries(row.proposed).map(([key,value])=>`${esc({rooms:'객실 수',total:'상품 객실 수',productType:'상품 구분',dayUse:'데이유즈',facilities:'시설',name:'이름',address:'주소'}[key]||key)}: ${esc(row.baseValues[key]??'확인 전')} → ${esc(value)}`).join(' · ')}</p>${row.reviewMessage?`<p>${esc(row.reviewMessage)}</p>`:''}${row.status==='pending'?`<button class="button small" data-action="withdraw" data-request="${esc(row.requestId)}">요청 철회</button>`:''}</li>`).join('')}</ol>`:''}</details>`;
  }
  const recurringLabels={pending:'관리자 승인 대기',approved:'정기수집 승인됨',rejected:'요청 반려',paused:'정기수집 일시중지'};
  const registeredCompany=id=>state?.customer?.relations?.some(row=>row.companyId===id&&row.kind==='competitor'&&row.status==='active');
  function recurringRecord(id){return(Array.isArray(state?.recurringCollections)?state.recurringCollections:[]).find(row=>row?.companyId===id)||null;}
  function rememberRecurring(id,data){
    if(!registeredCompany(id))return null;
    const record=data?.recurringCollection;
    // Each lightweight read owns only its selected company. A slower sibling
    // response must not restore another company's older state after a request.
    if(record&&record.companyId===id)state.recurringCollections=[...(state.recurringCollections||[]).filter(row=>row.companyId!==id&&registeredCompany(row.companyId)),record];
    else if(record===null)state.recurringCollections=(state.recurringCollections||[]).filter(row=>row.companyId!==id);
    else throw new Error('정기수집 요청 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
    return recurringRecord(id);
  }
  function recurringExecution(record){
    if(!record)return '';
    const attempt=record.latestAttempt,attemptLabels={dispatching:'작업 배정 중',queued:'수집 대기',running:'수집 중',collecting:'수집 중',verifying:'저장 자료 검증 중',complete:'저장·검증 완료',reused:'검증된 기존 자료 재사용',partial:'일부 자료',failed:'수집 실패',blocked:'접근 제한으로 중단',interrupted:'수집 중단',needs_review:'실행 확인 필요',error:'실행 확인 필요'};
    const execution=attempt?.status?attemptLabels[attempt.status]||'실행 상태 확인 필요':record.errorCode?'실행 확인 필요':record.status==='approved'?'다음 실행 대기':null;
    return `${execution?`<p class="connected-recurring-execution"><strong>${esc(execution)}</strong>${attempt?.runId?` <small>수집 ${esc(attempt.runId)}</small>`:''}</p>`:''}${record.message?`<p class="muted">${esc(record.message)}</p>`:''}${record.errorCode||attempt?.errorCode?`<p class="registration-note">원인 ${esc(record.errorCode||attempt.errorCode)}</p>`:''}`;
  }
  function recurringCard(company,compact=false){
    if(state.features?.recurringCollectionRequests!==true||!registeredCompany(company.companyId))return '';
    const record=recurringRecord(company.companyId),status=record&&recurringLabels[record.status]?record.status:null,uncertain=recurringUncertain.has(company.companyId);
    const locked=['pending','approved','paused'].includes(status)||customerViewReadOnly(),last=record?.lastCollectedDay||record?.lastCollectedAt;
    if(customerViewReadOnly())return `<section class="connected-recurring${compact?' connected-recurring-compact':''}" data-recurring-company="${esc(company.companyId)}" data-recurring-compact="${compact?'1':'0'}" aria-label="정기수집 상태"><div class="connected-recurring-top"><strong>정기수집</strong><span class="status-pill">${esc(status?recurringLabels[status]:'미신청')}</span></div><p class="connected-recurring-help muted">저장된 업체자료를 먼저 보여드립니다. 매일 1회, 당일 포함 30일 수집은 관리자 승인 후 시작합니다.</p><p class="connected-recurring-history">마지막 정기수집 ${esc(last?(record.lastCollectedDay||koreaDate(last)):'기록 없음')}${record?.nextRunAt?` · 다음 수집 ${esc(koreaDate(record.nextRunAt))} ${esc(record.time||'14:00')}`:''}</p><div class="connected-recurring-execution-slot">${recurringExecution(record)}${recurringStatusErrors.has(company.companyId)?'<p class="registration-note" role="status">상태 갱신 지연 · 마지막 확인 상태를 유지합니다.</p>':''}</div>${record?.shared?'<p class="muted">같은 업체는 기존 승인 일정과 결과를 함께 사용합니다.</p>':''}${record?.reviewReason?`<p class="muted">검토 사유: ${esc(record.reviewReason)}</p>`:''}</section>`;
    return `<section class="connected-recurring${compact?' connected-recurring-compact':''}" data-recurring-company="${esc(company.companyId)}" data-recurring-compact="${compact?'1':'0'}" aria-label="정기수집 요청"><div class="connected-recurring-top"><strong>정기수집</strong><span class="status-pill ${status==='approved'?'':'pending'}">${esc(status?recurringLabels[status]:'미신청')}</span></div><p class="connected-recurring-help muted">저장된 업체자료를 먼저 보여드립니다. 매일 1회, 당일 포함 30일 수집은 관리자 승인 후 시작합니다.</p><p class="connected-recurring-history">마지막 정기수집 ${esc(last?(record.lastCollectedDay||koreaDate(last)):'기록 없음')}${record?.nextRunAt?` · 다음 수집 ${esc(koreaDate(record.nextRunAt))} ${esc(record.time||'14:00')}`:''}</p><div class="connected-recurring-execution-slot">${recurringExecution(record)}${recurringStatusErrors.has(company.companyId)?'<p class="registration-note" role="status">상태 갱신 지연 · 마지막 확인 상태를 유지합니다.</p>':''}</div>${record?.shared?'<p class="muted">같은 업체는 기존 승인 일정과 결과를 함께 사용합니다.</p>':''}${record?.reviewReason?`<p class="muted">검토 사유: ${esc(record.reviewReason)}</p>`:''}${uncertain?'<p class="registration-note" role="status">접수 결과를 확인하지 못했습니다. 다시 확인하면 중복 신청 없이 기존 접수부터 확인합니다.</p>':''}<button type="button" class="button small" data-action="recurring-request" data-company="${esc(company.companyId)}" ${locked?'disabled':''}>${uncertain?'접수 상태 다시 확인':status==='pending'?'승인 대기 중':status==='approved'?'정기수집 연결됨':status==='paused'?'관리자 재개 필요':'정기수집 요청'}</button></section>`;
  }
  function patchRecurring(companyId){
    const company=state?.companies?.find(row=>row.companyId===companyId);if(!company)return;
    document.querySelectorAll?.('[data-recurring-company="'+companyId+'"]').forEach(node=>{node.outerHTML=recurringCard(company,node.dataset.recurringCompact==='1');});
  }
  function stopRecurringPoll(){recurringPollGeneration++;if(recurringPollTimer!==null){clearTimeout(recurringPollTimer);recurringPollTimer=null;}}
  function startRecurringPoll(ids){
    if(state?.features?.recurringCollectionRequests!==true)return;
    const companies=[...new Set(ids)].filter(registeredCompany);if(!companies.length)return;
    const generation=recurringPollGeneration,customerId=state.customer.customerId;
    recurringPollTimer=setTimeout(async()=>{
      recurringPollTimer=null;if(generation!==recurringPollGeneration||state?.customer?.customerId!==customerId)return;
      if(document.hidden===true){startRecurringPoll(companies);return;}
      const selected=Array.from({length:Math.min(3,companies.length)},(_,index)=>companies[(recurringPollOffset+index)%companies.length]);recurringPollOffset=(recurringPollOffset+selected.length)%companies.length;
      const epochs=selected.map(id=>recurringEpochs.get(id)||0),results=await Promise.allSettled(selected.map(id=>api('/companies/'+encodeURIComponent(id)+'/recurring-collection')));
      if(generation!==recurringPollGeneration||state?.customer?.customerId!==customerId)return;
      for(let index=0;index<selected.length;index++){
        const id=selected[index];if(!registeredCompany(id)||(recurringEpochs.get(id)||0)!==epochs[index])continue;
        const result=results[index];if(result.status==='fulfilled'){try{rememberRecurring(id,result.value);recurringStatusErrors.delete(id);}catch{recurringStatusErrors.add(id);}}
        else if(result.reason?.status===401){state=null;adminCsrf='';recurringRequestKeys.clear();recurringUncertain.clear();render();return;}else recurringStatusErrors.add(id);
        patchRecurring(id);
      }
      if(generation===recurringPollGeneration)startRecurringPoll(companies);
    },60000);
  }
  async function requestRecurring(companyId){
    if(state?.features?.recurringCollectionRequests!==true||!registeredCompany(companyId))throw new Error('등록한 업체의 정기수집만 요청할 수 있습니다.');
    recurringEpochs.set(companyId,(recurringEpochs.get(companyId)||0)+1);
    const customerId=state.customer.customerId,route='/companies/'+encodeURIComponent(companyId)+'/recurring-collection';
    const current=await api(route);if(state?.customer?.customerId!==customerId||!registeredCompany(companyId))return;
    const record=rememberRecurring(companyId,current);
    if(record&&['pending','approved','paused'].includes(record.status)){recurringUncertain.delete(companyId);recurringRequestKeys.delete(companyId);patchRecurring(companyId);toast('기존 정기수집 요청 상태를 확인했습니다.');return;}
    if(!recurringRequestKeys.has(companyId))recurringRequestKeys.set(companyId,crypto.randomUUID());
    try{
      const result=await api(route,{requestKey:recurringRequestKeys.get(companyId)});
      if(state?.customer?.customerId!==customerId||!registeredCompany(companyId))return;
      rememberRecurring(companyId,result);recurringUncertain.delete(companyId);recurringRequestKeys.delete(companyId);patchRecurring(companyId);toast('정기수집 요청을 접수했습니다. 관리자 승인 후 시작합니다.');
    }catch(error){if(state?.customer?.customerId===customerId){recurringUncertain.add(companyId);patchRecurring(companyId);}throw error;}
  }
  function companyCard(relation,management=false) {
    management=management&&!customerViewReadOnly();
    const company = state.companies.find(row => row.companyId === relation.companyId);
    if (!company) return `<article class="connected-row"><strong>업체 연결 확인 필요</strong><p class="muted">기존 관계를 보존했습니다. 관리자에게 연결 상태를 확인해 주세요.</p></article>`;
    const settings = state.customer.settings[company.companyId] || {};
    const preview=state.customer.accountKind==='admin_preview',pending=relation.status==='pending'&&!preview;
    const label=preview?'관리자 체험':pending?(relation.kind==='own'?'내 매장 확인 대기':'업체 연결 확인 대기'):labels[relation.status];
    return `<article class="connected-row"><div><span class="status-pill ${pending?'pending':''}">${esc(label)}</span>${management?` <span class="muted">${relation.kind==='own'?'내 매장':'경쟁업체'}</span>`:''}</div><h3>${esc(settings.nickname||company.name)}</h3><p class="muted">${esc(company.address)}</p><p>객실 총량 <strong>${company.rooms==null?'확인 전':`${esc(company.rooms)}실`}</strong> <span class="muted">${esc(company.roomCountSource)}</span></p>${pending?`<p class="registration-note">${relation.kind==='own'?'내 매장':'업체'} 연결에 대한 관리자 확인이 필요합니다. 저장된 업체자료는 바로 볼 수 있습니다.</p>`:''}<div class="connected-actions"><a class="button primary small" href="#company=${encodeURIComponent(company.companyId)}">${relation.kind==='own'?'내 매장 보기':'업체 자료 보기'}</a>${management?`${state.features.directCollection?`<a class="button small" href="#collect=${encodeURIComponent(company.companyId)}">자료 갱신</a>`:''}<button class="button small" data-action="archive" data-relation="${esc(relation.relationId)}">등록 해제</button>`:''}</div>${recurringCard(company)}${management?`<details><summary>개인 설정</summary><form data-settings="${esc(company.companyId)}">${field('나만의 별칭','nickname',settings.nickname||'')}<label class="field"><span>나만의 메모</span><textarea name="note" maxlength="1000">${esc(settings.note||'')}</textarea></label><button class="button" type="submit">개인 설정 저장</button></form></details>`:''}</article>`;
  }
  function prepareCompanies() {
    if(!state)return;
    const relations=state.customer.relations.filter(row=>['active','pending'].includes(row.status));
    const current=route();let selected=null;
    if(/^(company|collection|collect)=/.test(current)){
      const id=decodeURIComponent(current.slice(current.indexOf('=')+1));
      if(relations.some(row=>row.companyId===id))selected=id;
    }else if(current==='home'||current==='property'){
      const own=relations.filter(row=>row.kind==='own');
      selected=(own.find(row=>row.companyId===selectedOwnId)||own[0])?.companyId;
    }
    const company=selected&&state.companies.find(row=>row.companyId===selected);
    if(company)window.InsightCollection?.prefetch?.([company],api);
  }
  function openCompany(company,openCollection=false) {
    $('#main').innerHTML=recurringCard(company,true)+window.InsightCollection.panel(company,!customerViewReadOnly()&&state.features.directCollection,state.preparations.find(row=>row.companyId===company.companyId),state.collectionAllowance,openCollection&&!customerViewReadOnly());
    const relation=state.customer.relations.find(row=>row.companyId===company.companyId&&['active','pending'].includes(row.status));
    if(relation?.kind==='own'){selectedOwnId=company.companyId;if(comparisonSelection?.getState().ownCompanyId!==company.companyId){comparisonSelection?.update({ownCompanyId:company.companyId});selectionUrl();}}
    const isCurrentView=()=>{
      const current=route();
      if(/^(company|collection|collect)=/.test(current))return decodeURIComponent(current.slice(current.indexOf('=')+1))===company.companyId;
      const own=state?.customer.relations.filter(row=>row.kind==='own'&&['active','pending'].includes(row.status))||[];
      return current==='property'&&own.length===1&&own[0].companyId===company.companyId;
    };
    window.InsightCollection.mount(company.companyId,api,{company,relationKind:relation?.kind,editHtml:correctionEditor(company),isCurrentView});
    if(relation?.kind==='competitor')startRecurringPoll([company.companyId]);
  }
  function search(kind) { return `<section class="card search-box"><h2>${kind==='region'?'관심지역 추가':kind==='own'?'내 매장 등록':'경쟁업체 추가'}</h2><form id="search-form" data-kind="${kind}"><label class="field"><span>${kind==='region'?'시군구 이름':'업체명·주소·플레이스 번호'}</span><input name="q" required minlength="2" maxlength="120" placeholder="두 글자 이상 입력하세요."></label><button class="button" type="submit">저장된 업체·지역 검색</button></form><div id="search-results" class="search-results" aria-live="polite"></div>${kind==='region'?'':'<div id="company-registration-progress"></div>'}</section>`; }
  function render() {
    stopRecurringPoll();
    lastRenderedHash=location.hash;
    searchSequence++; window.InsightContextWorkspace?.stop(); window.InsightComparisonView?.stop(); window.InsightAnalysis?.stop(); window.InsightCollection?.stop?.();
    const scope=state?.customer.customerId?`${adminView?'admin':'customer'}:${state.customer.customerId}`:'';
    const sessionExpired=()=>{state=null;adminCsrf='';selectedOwnId=null;comparisonSelection?.configure({scope:'',permissionSignature:'',authorizedOwnCompanyIds:[],authorizedComparisonIds:[],authorizedComparisonIdsByOwn:{}});render();};
    configureSelection(scope);
    window.InsightCollection?.setContext?.(scope,state?.customer.relations.filter(row=>['active','pending'].includes(row.status)).map(row=>row.companyId)||[],sessionExpired);
    window.InsightAnalysis?.configureCache?.({scope,regionKeys:state?.regions?.map(row=>row.id)||[],onSessionExpired:sessionExpired});
    window.InsightAnalysis?.configureReports?.({scope,ownIds:state?.customer.relations.filter(row=>row.kind==='own'&&['active','pending'].includes(row.status)).map(row=>row.companyId)||[],companyIds:state?.customer.relations.filter(row=>['active','pending'].includes(row.status)).map(row=>row.companyId)||[],regionKeys:state?.regions?.map(row=>row.id)||[],permissionVersion:reportPermissionVersion(state),onSessionExpired:sessionExpired});
    window.InsightRegionalContext?.configure?.({scope,permissionVersion:reportPermissionVersion(state),state,onSessionExpired:sessionExpired});
    if(state&&!restoredStates.has(state)){restoredStates.add(state);window.InsightCollection?.restore?.(state.companyViews,scope);window.InsightAnalysis?.restore?.(state.regionViews,scope);window.InsightAnalysis?.restoreReports?.(state.reportViews,scope);window.InsightRegionalContext?.restore?.(state.comparisonRegionViews,scope);}
    $('#logout').hidden = !state;
    $('#admin-view-banner').hidden = !adminView || !state;
    if(adminView&&state)renderAdminBanner();
    $('#navigation').innerHTML = state ? menus.map(([key,label])=>`<a href="#${key}" class="nav-link ${menuRoute()===key?'active':''}">${label}</a>`).join(''):'';
    $('#customer-name').textContent = state ? state.customer.username : '사분 인사이트';
    document.body.classList.toggle('auth-view', !state);
    if(bootstrapStatus==='loading'&&!state){$('#main').innerHTML=connectionLoading('로그인 상태를 확인하고 저장 자료를 연결하고 있습니다.');return;}
    if(bootstrapStatus==='failed'&&!state){$('#main').innerHTML=connectionFailure(bootstrapError,'retry-connection');return;}
    if (['terms','privacy'].includes(route())) { if(configStatus!=='ready'){configurationScreen();return;} policy(route()); return; }
    policySequence++;
    if (!state) { auth(); return; }
    if (route() === 'welcome') { $('#main').innerHTML=window.InsightAuth.welcome(state.customer); return; }
    if (route() === 'saved-keyword-comparison') {
      $('#main').innerHTML = window.InsightSavedKeywordComparison?.panel({adminView}) || '<section class="card"><h1>저장 비교 화면 연결을 확인해 주세요.</h1><a href="#competitors">경쟁 분석으로 돌아가기</a></section>';
      return;
    }
    const c = state.customer, relations = c.relations.filter(row=>['active','pending'].includes(row.status));
    const limits=state.registrationAllowance || {ownLimit:1,...c.entitlements};
    const limitText=v=>v===null?'제한 없음':`${v}곳`;
    const own = relations.filter(row=>row.kind==='own'), competitors = relations.filter(row=>row.kind==='competitor');
    if(route()==='register-own'){$('#main').innerHTML=customerViewReadOnly()?'<section class="card"><h1>고객 화면 확인</h1><p>읽기 전용으로 보고 있습니다. 업체 등록은 고객 또는 관리자 관리 화면에서 진행해 주세요.</p></section>':`<div class="page-heading"><h1>내 매장 등록</h1></div>${limits.ownLimit===null||own.length<limits.ownLimit?search('own'):'<section class="card"><p>이미 내 매장이 등록되어 있습니다. 변경하려면 설정에서 등록 관계를 관리하세요.</p><a class="button" href="#settings">설정으로 이동</a></section>'}`;return;}
    if(/^(company|collection|collect)=/.test(route())) {
      const id=decodeURIComponent(route().slice(route().indexOf('=')+1)),relation=relations.find(r=>r.companyId===id),company=state.companies.find(r=>r.companyId===id);
      if(!relation||!company){$('#main').innerHTML='<section class="card"><h1>등록한 업체를 찾을 수 없습니다.</h1><a href="#property">내 매장으로 이동</a></section>';return;}
      openCompany(company,route().startsWith('collect='));return;
    }
    const current = menus.find(([key])=>key===menuRoute()) || menus[0];
    const selectedRegion=route().startsWith('regions=')?decodeURIComponent(route().slice(8)):null;
    let content = '';
    if(current[0]==='home')content=window.InsightHomeContextView.panel(state,comparisonSelection.getState());
    if(current[0]==='property'&&own.length===1){const company=state.companies.find(row=>row.companyId===own[0].companyId);if(company){openCompany(company);return;}}
    if (current[0]==='property') content = `<div class="connected-list">${own.map(relation => companyCard(relation)).join('') || '<div class="empty-note">내 매장을 등록하면 저장된 업체자료를 볼 수 있습니다.</div>'}</div>${!customerViewReadOnly()&&(limits.ownLimit===null||own.length<limits.ownLimit)?search('own'):''}`;
    if(current[0]==='competitors')content=`<div id="comparison-workspace">${window.InsightComparisonView&&comparisonSelection?window.InsightComparisonView.panel(state,comparisonSelection.getState()):'<p class="empty-note">비교 화면 연결을 확인해 주세요.</p>'}</div><details class="card comparison-management"><summary>등록 경쟁업체 · ${competitors.length}곳</summary><div class="connected-list">${competitors.map(relation=>companyCard(relation)).join('')||'<p class="empty-note">등록한 업체가 없습니다.</p>'}</div><a class="text-link" href="#settings">업체 등록·해제는 설정에서 관리</a></details>`;

    if(current[0]==='regions')content=window.InsightContextWorkspace.controls(state,comparisonSelection.getState())+window.InsightRegionalContextView.panel(state,comparisonSelection.getState())+(state.regions.length?`<details class="card regional-context-detail" id="regional-full-detail" ${selectedRegion?'open':''}><summary>내 매장·관심지역 상세 자료</summary>${window.InsightAnalysis.panel('regions',state,selectedRegion,selectedOwnId)}</details>`:'')+'<p class="muted">관심지역 등록·해제는 <a href="#settings">설정</a>에서 관리합니다.</p>';
    if (current[0]==='reports') content = window.InsightAnalysis.panel('reports',state);
    if (current[0]==='settings') content = `<section class="card"><h2>사업 정보</h2><form id="onboarding-form"><label class="field"><span>현재 상태</span><select name="businessStatus"><option value="planning" ${c.businessStatus==='planning'?'selected':''}>매장 준비 중</option><option value="owned" ${c.businessStatus==='owned'?'selected':''}>내 매장 등록</option></select></label>${field('매장·프로젝트 이름','projectName',c.projectName)}<button class="button primary" type="submit">저장</button></form></section><section class="card registered-management"><h2>등록업체 관리</h2><p class="muted">등록 해제는 내 계정의 연결만 해제하며, 업체 DB와 저장자료는 보존됩니다.</p><div class="connected-list">${relations.map(relation=>companyCard(relation,true)).join('')||'<p class="empty-note">등록한 업체가 없습니다.</p>'}</div><a class="button small" href="#register-own">내 매장 등록</a> <a class="button small" href="#competitors">경쟁업체 등록</a></section>`;
    if(current[0]==='settings'&&(limits.competitorLimit===null||competitors.length<limits.competitorLimit))content+=search('competitor');
    if(current[0]==='settings')content+=`<section class="card"><h2>관심지역 관리</h2>${c.regions.filter(activeRegion).map(r=>`<div class="connected-row"><strong>${esc(state.regions.find(v=>v.id===r.regionKey)?.label||'연결 지역')}</strong><button class="button small" data-action="archive-region" data-relation="${esc(r.relationId)}">관심지역 해제</button></div>`).join('')||'<p class="muted">등록한 관심지역이 없습니다.</p>'}</section>`+(limits.interestRegionLimit===null||c.regions.filter(activeRegion).length<limits.interestRegionLimit?search('region'):'');
    if(current[0]==='settings'&&customerViewReadOnly())content=`<section class="card"><h2>고객 등록 정보 · 읽기 전용</h2><p class="muted">사업 정보, 등록·해제, 수정 요청은 관리자 관리 화면에서 처리해 주세요.</p><div class="connected-list">${relations.map(relation=>companyCard(relation)).join('')||'<p class="muted">등록한 업체가 없습니다.</p>'}</div></section>`;
    $('#main').innerHTML = `<div class="page-heading"><div><span class="eyebrow">SABUN INSIGHT</span><h1>${current[1]}</h1></div></div>${content}`;
    const contextMount=mode=>window.InsightContextWorkspace?.mount({mode,store:comparisonSelection,state,api,peekBrief:id=>window.InsightAnalysis.peekCurrentBriefing(id),readBrief:id=>window.InsightAnalysis.readCurrentBriefing(id,api),onSelectionChange:selectionChanged,onSessionExpired:sessionExpired,onRebuild:render});
    if(['home','regions'].includes(current[0]))contextMount(current[0]);
    if(current[0]==='competitors'&&comparisonSelection)window.InsightComparisonView?.mount({store:comparisonSelection,state,peek:id=>window.InsightAnalysis.peekCurrentBriefing(id),read:(id,options)=>window.InsightAnalysis.readCurrentBriefing(id,api,options),onSelectionChange:selectionChanged,onSessionExpired:sessionExpired,onRegionalView:()=>contextMount('comparison')});
    if(current[0]==='competitors')startRecurringPoll(competitors.map(row=>row.companyId));
    if(current[0]==='reports')window.InsightAnalysis.mount('reports',api,state,selectedRegion,selectedOwnId);
    if(current[0]==='regions'){const full=$('#regional-full-detail'),show=()=>window.InsightAnalysis.mount('regions',api,state,selectedRegion,selectedOwnId);if(full?.open)show();full?.addEventListener('toggle',()=>{if(full.open)show();else window.InsightAnalysis.stop();});}
  }
  function activeRegion(row) { return row.status==='active'; }
  document.addEventListener('submit', async event => {
    event.preventDefault(); if(busy) return;
    if(customerViewReadOnly()){toast('읽기 전용 고객 화면에서는 저장할 수 없습니다.');return;}
    const form=event.target, p=Object.fromEntries(new FormData(form)); busy=true;
    form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      if(form.id==='auth-form') {
        const signup=route()==='signup';
        if(signup&&configStatus!=='ready')throw new Error('회원가입 설정을 확인한 뒤 다시 시도해 주세요.');
        if(signup&&!config.signupEnabled)throw new Error('현재 신규 가입을 받지 않습니다.');
        if(signup&&p.password!==p.passwordConfirm)throw new Error('비밀번호 확인이 일치하지 않습니다.');
        state=await api(signup?'/auth/signup':'/auth/login', {...p,...(signup?{agreeTerms:!!p.agreeTerms,agreePrivacy:!!p.agreePrivacy,confirmAge:!!p.confirmAge,termsVersion:config.termsVersion,privacyVersion:config.privacyVersion}:{})}); location.hash=signup?'welcome':'home'; render();prepareCompanies();
      } else if(form.dataset.collect) await command('collect',{companyId:form.dataset.collect,checkIn:p.checkIn,bookingRangeDays:Number(p.bookingRangeDays),dayUseMode:p.dayUseMode});
      else if(form.dataset.productCorrection !== undefined) await command('product-correction',window.InsightCollection.correction(form.dataset.productCorrection,p));
      else if(form.id==='onboarding-form') await command('onboarding',p);
      else if(form.id==='search-form') {
        const serial=++searchSequence, kind=form.dataset.kind;
        const data=await api(`/catalog/${kind==='region'?'regions':'companies'}?q=${encodeURIComponent(p.q)}`);
        if(serial!==searchSequence)return;
        const results=kind==='region'?data.results.filter(row=>!state.regions.some(region=>region.id===row.id)):data.results;
        const connected=kind==='region'&&results.length<data.results.length?'<p class="muted">이미 연결된 지역은 추가 등록이 필요 없습니다. 지역 분석에서 바로 확인하세요.</p>':'';
        $('#search-results').innerHTML=(results.map(row=>`<button type="button" data-action="add" data-kind="${kind}" data-id="${esc(row.companyId||row.id)}"><strong>${esc(row.name||row.label)}</strong><span class="muted">${esc(row.address||'')} · 등록</span></button>`).join('')||(!connected?'<p class="muted">저장된 후보가 없습니다. 관리자에게 업체 등록을 요청해 주세요.</p>':''))+connected;
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
    if(action==='retry-connection'){await bootstrap();return;}
    if(action==='retry-config'){loadConfiguration();configurationScreen();return;}
    if(action==='admin-roster-retry'){await loadAdminRoster();return;}
    if(customerViewReadOnly()&&!['logout','refresh-collection'].includes(action)){toast('읽기 전용 고객 화면에서는 저장·등록·수집할 수 없습니다.');return;}
    busy=true;button.disabled=true;
    try{
      if(action==='check-username'){const input=$('[name=username]'), slot=$('#username-status');if(!input.reportValidity())return;const requested=input.value.trim(), value=await api(`/auth/username?username=${encodeURIComponent(requested)}`);if(!slot.isConnected||input.value.trim()!==requested)return;slot.textContent=value.message;slot.dataset.available=String(value.available);}
      else if(action==='logout'){await api('/auth/logout',{});recurringRequestKeys.clear();recurringUncertain.clear();comparisonSelection?.configure({scope:'',permissionSignature:'',authorizedOwnCompanyIds:[],authorizedComparisonIds:[],authorizedComparisonIdsByOwn:{}});window.InsightAnalysis?.clearCache?.();window.InsightRegionalContext?.clear?.();window.InsightContextWorkspace?.stop();window.InsightComparisonView?.stop();window.InsightCollection?.clearCache?.();state=null;adminCsrf='';selectedOwnId=null;if(adminView){location.assign('/admin');return;}location.hash='login';render();}
      else if(action==='add'){
        const connecting=button.dataset.kind!=='region'?$('#company-registration-progress'):null;
        if(connecting)connecting.innerHTML=window.InsightCollection.loading('업체 등록 · 자료 연결 중','등록을 저장하고 업체 기본정보를 연결하고 있습니다.');
        try{await command(button.dataset.kind==='region'?'add-region':'add-company',button.dataset.kind==='region'?{regionKey:button.dataset.id}:{kind:button.dataset.kind,companyId:button.dataset.id});}
        finally{if(connecting)connecting.innerHTML='';}
      }
      else if(action==='archive')await command('archive-company',{relationId:button.dataset.relation});
      else if(action==='archive-region')await command('archive-region',{relationId:button.dataset.relation});
      else if(action==='withdraw')await command('withdraw-correction',{requestId:button.dataset.request});
      else if(action==='refresh-collection')await window.InsightCollection.refresh();
      else if(action==='recurring-request')await requestRecurring(button.dataset.company);
    }catch(error){toast(error.message);}finally{busy=false;button.disabled=false;}
  });
  document.addEventListener('input',event=>{if(event.target.matches?.('[data-admin-customer-search]')){const input=event.target,start=input.selectionStart,end=input.selectionEnd;renderAdminBanner(input.value);const next=$('[data-admin-customer-search]');next?.focus?.();if(typeof start==='number')next?.setSelectionRange?.(start,end);return;}const form=event.target.closest('[data-product-correction], [data-correction]');if(form)form.dataset.dirty='true';if(event.target.name==='username'&&$('#username-status'))$('#username-status').textContent='';});
  window.addEventListener('popstate',()=>{if(!state||!comparisonSelection)return;comparisonSelection.restoreUrl(location.href);selectedOwnId=comparisonSelection.getState().ownCompanyId;if(lastRenderedHash===location.hash)render();});
  document.addEventListener('change',event=>{if(event.target.matches?.('[data-admin-customer-select]')){const id=event.target.value;if(!id||adminRoster?.some(row=>row.customerId===id&&row.accountKind!=='admin_preview'&&row.accountStatus!=='disabled'))location.assign('/customer-view'+(id?'?customerId='+encodeURIComponent(id):'')+'#home');return;}if(event.target.matches?.('#analysis-form [name=ownId]')&&comparisonSelection){const updated=comparisonSelection.update({ownCompanyId:event.target.value});if(updated.ok)selectionChanged(updated.state);}});
  window.addEventListener('hashchange',()=>{render();$('#main').focus();window.scrollTo(0,0);});
  try{document.documentElement.dataset.theme=localStorage.getItem('insight-theme')==='dark'?'dark':'light';}catch{}
  async function bootstrap() {
    if(bootstrapInFlight)return;
    bootstrapInFlight=true;bootstrapStatus='loading';bootstrapError=null;
    $('#main').innerHTML=connectionLoading('로그인 상태를 확인하고 저장 자료를 연결하고 있습니다.');
    if(configStatus!=='ready')loadConfiguration();
    try {
      if(adminView){
        try{state=await bootstrapRead(signal=>api('/me',undefined,{signal,startup:true}));}
        catch(error){
          // Only an authenticated, explicitly missing preview may create it.
          // Existing previews restore their saved views in one protected GET.
          if(selectedCustomerId)throw error;
          if(error.status!==409||error.code!=='CUSTOMER_VIEW_REQUIRED')throw error;
          const identity=await bootstrapRead(signal=>startupFetch('/api/insight-admin/v1/me',{headers:{Accept:'application/json'},...(signal?{signal}:{})}).then(responseValue));
          adminCsrf=identity.csrfToken;
          state=await api('/start',{});
        }
        if(selectedCustomerId&&(state?.view?.mode!=='admin_customer'||state.view.readOnly!==true||state.view.customerId!==selectedCustomerId))throw new Error('선택한 고객과 조회 응답이 다릅니다. 관리자 화면에서 다시 선택해 주세요.');
        if(state?.customer?.customerId)startupMark('insight-identity-ready');
      }else{state=await bootstrapRead(signal=>api('/me',undefined,{signal,startup:true}));if(state?.customer?.customerId)startupMark('insight-identity-ready');}
      bootstrapStatus='ready';render();prepareCompanies();
    }catch(error){
      state=null;adminCsrf='';
      if(error.status===401){bootstrapStatus='ready';render();}
      else{bootstrapStatus='failed';bootstrapError=error;render();}
    }finally{bootstrapInFlight=false;}
  }
  bootstrap();
})();
