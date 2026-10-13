(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const statuses = {dispatching:'접수 확인',queued:'수집 대기',collecting:'수집 대기·진행 중',ready:'완료',partial:'일부 완료',blocked:'접근 제한',failed:'실패',needs_review:'확인 필요'};
  const active = r => ['dispatching','queued','collecting'].includes(r?.status);
  let api, companyId, view = null, serial = 0, timer, renderedVersion, loadOrder=0, selectedMonth='', collectionSetup=false, mountOptions={};
  // Private result payloads stay in this signed-in page's memory only.
  const cache = new Map(), inFlight = new Map(), lastMonths = new Map(), companyEpochs = new Map(), references=new Map(), referenceDenied=new Set();
  const CACHE_LIMIT=24, CACHE_MAX_AGE=30*60*1000, PREFETCH_LIMIT=4;
  let cacheScope='default', allowedCompanies=null, cacheGeneration=0, onSessionExpired=null;
  const cacheKey=(id,month)=>JSON.stringify([cacheScope,id,month]);
  const permitted=id=>Boolean(cacheScope)&&(!allowedCompanies||allowedCompanies.has(id));
  const resultVersion=data=>JSON.stringify([data.result?.version,data.previousResult,data.companyDetail]);
  const companyEpoch=id=>companyEpochs.get(id)||0;
  let prefetchState={queue:[],keys:new Set(),running:false,promise:null};
  function clearCache(){cacheGeneration++;cache.clear();inFlight.clear();lastMonths.clear();companyEpochs.clear();references.clear();referenceDenied.clear();prefetchState={queue:[],keys:new Set(),running:false,promise:null};}
  function invalidate(id){
    companyEpochs.set(id,companyEpoch(id)+1);
    references.delete(id);referenceDenied.delete(id);
    for(const [key,pending] of inFlight)if(pending.companyId===id)inFlight.delete(key);
    for(const [key,entry] of cache)if(entry.companyId===id)cache.delete(key);
  }
  function cached(id,month){
    if(!permitted(id))return null;
    const key=cacheKey(id,month),entry=cache.get(key);
    if(!entry)return null;
    if(Date.now()-entry.checkedAt>CACHE_MAX_AGE){cache.delete(key);return null;}
    cache.delete(key);cache.set(key,entry);return entry;
  }
  function remember(id,month,data){
    referenceDenied.delete(id);
    const entry={companyId:id,data,version:resultVersion(data),checkedAt:Date.now()};
    const resolved=data.companyDetail?.integrated?.selectedMonth;
    for(const value of new Set([month,...(!month&&resolved?[resolved]:[])])){
      const key=cacheKey(id,value);cache.delete(key);cache.set(key,entry);
    }
    while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);
    return entry;
  }
  function freshness(message,entry){
    const target=document.querySelector('#collection-freshness');if(!target)return;
    target.textContent=message;
    target.dataset.state=message.includes('확인 중')?'checking':message==='최신 자료 확인 완료'?'ready':'notice';
    target.hidden=Boolean(!view||target.dataset.state==='ready'||view.referenceLoading&&target.dataset.state==='checking');
  }
  function loading(title='업체 자료 연결 중',description='기본정보와 예약채널을 불러오고 있습니다.'){
    return '<div class="company-connection is-loading" role="status" aria-live="polite"><span class="connection-spinner" aria-hidden="true"></span><div><strong>'+esc(title)+'</strong><p>'+esc(description)+'</p></div><span class="connection-track" aria-hidden="true"><i></i></span></div>';
  }
  function connectionBusy(value){
    const target=document.querySelector('#collection-result');target?.setAttribute?.('aria-busy',String(value));
  }
  function disableCollection(message){const submit=document.querySelector('[data-collect] button[type=submit]');if(submit)submit.disabled=true;const note=document.querySelector('#collection-allowance');if(note&&message)note.textContent=message;}
  function seed(company){
    const id=company?.companyId;
    if(!/^[a-zA-Z0-9_-]+$/.test(id||'')||!permitted(id)||referenceDenied.has(id))return;
    const basics={companyId:id,name:company.name,address:company.address,rooms:typeof company.rooms==='number'&&Number.isFinite(company.rooms)?company.rooms:null,roomCountSource:company.roomCountSource,facilities:company.facilities,lodgingTypes:[]};
    references.delete(id);references.set(id,{referenceLoading:true,result:null,companyDetail:{companyId:id,source:'company_db_catalog',basics,channels:[],current:{daily:[],summary:null}}});
    while(references.size>CACHE_LIMIT)references.delete(references.keys().next().value);
  }
  function readPending(id,month,request){
    const key=cacheKey(id,month);let pending=inFlight.get(key);
    if(!pending){
      let promise;try{promise=Promise.resolve(request(`/companies/${encodeURIComponent(id)}/collection${month?'?month='+encodeURIComponent(month):''}`));}catch(error){promise=Promise.reject(error);}
      pending={promise,companyId:id};inFlight.set(key,pending);
      const cleanup=()=>{if(inFlight.get(key)===pending)inFlight.delete(key);};promise.then(cleanup,cleanup);
    }
    return pending.promise;
  }
  function expireSession(){
    const formerlyAllowed=allowedCompanies?[...allowedCompanies]:[];
    clearCache();for(const id of formerlyAllowed)referenceDenied.add(id);
    serial++;clearTimeout(timer);view=null;renderedVersion=null;disableCollection();connectionBusy(false);
    const target=document.querySelector('#collection-result');if(target)target.innerHTML='<p class="collection-warning">로그인이 만료되었습니다. 다시 로그인해 주세요.</p>';
    freshness('자료 조회 권한 확인 필요');if(onSessionExpired)onSessionExpired();
  }
  function denyCompany(id){
    invalidate(id);referenceDenied.add(id);
    if(id!==companyId||!document.querySelector('#collection-result'))return;
    serial++;clearTimeout(timer);view=null;renderedVersion=null;disableCollection();connectionBusy(false);
    document.querySelector('#collection-result').innerHTML='<p class="collection-warning">업체 등록과 조회 권한을 다시 확인해 주세요.</p>';freshness('자료 조회 권한 확인 필요');
  }
  function prefetch(companies,request){
    if(!Array.isArray(companies)||typeof request!=='function'||!cacheScope||!allowedCompanies)return Promise.resolve();
    const batch=prefetchState,generation=cacheGeneration,scope=cacheScope;
    for(const company of companies.slice(0,PREFETCH_LIMIT)){
      const id=company?.companyId;if(!permitted(id)||!/^[a-zA-Z0-9_-]+$/.test(id||''))continue;
      seed(company);const month=lastMonths.get(id)||'',epoch=companyEpoch(id),key=JSON.stringify([id,month,epoch]);
      if(cached(id,month)||batch.keys.has(key))continue;
      batch.keys.add(key);batch.queue.push({id,month,epoch,key,request});
    }
    if(batch.running)return batch.promise;
    batch.running=true;
    batch.promise=(async()=>{
      while(batch.queue.length&&generation===cacheGeneration&&scope===cacheScope){
        const job=batch.queue.shift(),{id,month,epoch,key}=job;
        const current=()=>generation===cacheGeneration&&scope===cacheScope&&epoch===companyEpoch(id)&&permitted(id);
        if(!current()||cached(id,month)){batch.keys.delete(key);continue;}
        try{
          const data=await readPending(id,month,job.request);
          if(current()&&(!month||!data.companyDetail?.integrated?.selectedMonth||data.companyDetail.integrated.selectedMonth===month))remember(id,month,data);
        }
        catch(error){if(current()){if(error.status===401)expireSession();else if([403,404].includes(error.status))denyCompany(id);}}
        finally{batch.keys.delete(key);}
      }
    })().finally(()=>{batch.running=false;});
    return batch.promise;
  }
  function showCached(){
    const entry=cached(companyId,selectedMonth);
    if(entry){view=entry.data;renderedVersion=entry.version;document.querySelector('#collection-result').innerHTML=renderResult(entry.data);}
    else{view=permitted(companyId)&&!referenceDenied.has(companyId)?references.get(companyId)||null:null;renderedVersion=null;document.querySelector('#collection-result').innerHTML=view?renderResult(view):loading();}
    connectionBusy(!entry);
    disableCollection('수집 가능 여부를 서버에서 확인하고 있습니다.');freshness(entry?'이전 조회 자료 표시 · 최신 자료 확인 중':'최신 자료 확인 중',entry);
    return entry;
  }
  const date = () => new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  let allowance=null,display={mode:'default',metric:'bookings',month:''};
  document.addEventListener?.('change',event=>{
    if(event.target.matches?.('[data-company-month]')){
      if(document.querySelector('#collection-result form[data-dirty]')){
        event.target.value=view?.companyDetail?.integrated?.selectedMonth||selectedMonth;
        const progress=document.querySelector('#collection-progress');
        if(progress)progress.innerHTML='<p class="collection-warning">작성 중인 수정 요청을 유지했습니다. 내용을 정리한 뒤 숙박월을 바꿔 주세요.</p>';
        return;
      }
      selectedMonth=event.target.value;display.month=selectedMonth;lastMonths.set(companyId,selectedMonth);showCached();load();
    }
  });
  function allowanceText(q) {
    if(!q)return '오늘 수집 가능 여부를 확인하고 있습니다.';
    if(q.limit===null)return '관리자는 일일 횟수 제한을 적용하지 않습니다. 동일 업체·조건은 기존 작업을 확인합니다.';
    return q.canRequest ? '일반 고객 · 계정 전체 하루 1회 · 오늘 요청 가능 · 한국시간 기준' : '오늘 수집 요청 1/1회 사용 · '+new Date(q.resetsAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+'부터 다시 요청 가능';
  }
  function panel(company, enabled, request, quota, openCollection=false) {
    allowance=quota||null;
    collectionSetup=openCollection;
    if(!openCollection)return '<p id="collection-freshness" class="connection-check" role="status" hidden></p><section id="collection-progress" class="collection-progress" aria-live="polite"></section><section id="collection-result" aria-label="업체 자료" aria-busy="true">'+loading()+'</section>';
    const intent=request?.intent || {}, start=intent.checkIn>=date()?intent.checkIn:date(), mode=intent.dayUseMode || 'inspect';
    return '<section id="collection-settings" class="card collection-setup" '+(openCollection?'':'hidden')+'><h1>'+esc(company.name)+' 예약·매출 수집</h1><form data-collect="'+esc(company.companyId)+'"><div class="form-grid collection-fields"><label class="field"><span>숙박 시작일</span><input name="checkIn" type="date" min="'+date()+'" value="'+esc(start)+'" required></label><label class="field"><span>수집 기간</span><input value="시작일 포함 30일" readonly><input type="hidden" name="bookingRangeDays" value="30"></label><label class="field"><span>데이유즈</span><select name="dayUseMode">'+Object.entries({inspect:'유무 확인',lodging_only:'숙박만',detail:'상세 수집'}).map(([v,n])=>'<option value="'+v+'" '+(mode===v?'selected':'')+'>'+n+'</option>').join('')+'</select></label></div><p class="muted">30일의 날짜별 예약 수량과 숙박 객실 판매금액을 확인합니다. 데이유즈의 날짜별 수량은 상세 수집을 선택하세요.</p><p class="collection-allowance" id="collection-allowance" role="status">'+esc(allowanceText(allowance))+'</p><button class="button primary" type="submit" data-ready="'+enabled+'" '+(!enabled||!allowance?.canRequest?'disabled':'')+'>수집 시작</button><p class="muted">저장 자료 조회·정보 수정 요청은 횟수 제한 없이 이용할 수 있습니다. 접수 후 실패·차단된 요청은 관리자 확인이 필요합니다.</p>'+(!enabled?'<p class="muted">수집기 연결을 준비 중입니다.</p>':'')+'</form></section><section id="collection-progress" class="collection-progress" aria-live="polite"></section><section id="collection-result" aria-label="업체 자료" aria-busy="true">'+loading()+'</section>';
  }
  function progress(data) {
    const r=data?.request;
    if(data?.collectionAllowance)allowance=data.collectionAllowance;
    const note=document.querySelector('#collection-allowance');if(note)note.textContent=allowanceText(allowance);
    const target=document.querySelector('#collection-progress'); if(!target)return;
    target.innerHTML=r&&(collectionSetup||active(r))?'<div class="collection-status '+(active(r)?'running':'')+'"><span class="activity-dot" aria-hidden="true"></span><strong>'+esc(statuses[r.status]||'상태 확인')+'</strong><span>'+esc(r.message)+'</span><button type="button" class="button small" data-action="refresh-collection">새로고침</button></div><p class="muted">접수 '+esc(new Date(r.submittedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))+(r.errorCode?' · 원인 코드 '+esc(r.errorCode):'')+'</p>':'';
    const submit=document.querySelector('[data-collect] button[type=submit]'); if(submit)submit.disabled=active(r)||submit.dataset.ready!=='true'||!allowance?.canRequest;
  }
  function renderResult(data) {
    return window.InsightCompanyView.render(data,{editHtml:mountOptions.editHtml||''});
  }
  async function load(force=false) {
    const mine=serial, id=companyId, month=selectedMonth, order=++loadOrder, generation=cacheGeneration, epoch=companyEpoch(companyId), scope=cacheScope;
    const contextCurrent=()=>generation===cacheGeneration&&epoch===companyEpoch(id)&&scope===cacheScope;
    const current=()=>mine===serial&&order===loadOrder&&contextCurrent()&&id===companyId&&month===selectedMonth&&document.querySelector('#collection-result');
    clearTimeout(timer);
    if(!permitted(id)){disableCollection();return;}
    freshness(view?'이전 조회 자료 표시 · 최신 자료 확인 중':'최신 자료 확인 중',cached(id,month));
    try {
      const data=await readPending(id,month,api);
      if(!contextCurrent()||!permitted(id))return;
      if(month&&data.companyDetail?.integrated?.selectedMonth&&data.companyDetail.integrated.selectedMonth!==month)throw new Error('선택한 숙박월의 자료를 확인하지 못했습니다. 다시 확인해 주세요.');
      const entry=remember(id,month,data);
      if(!current())return;
      connectionBusy(false);
      progress(data);
      const version=entry.version;
      if(force || renderedVersion!==version) {
        if(!force && document.querySelector('#collection-result form:focus-within, #collection-result form[data-dirty]')) { freshness('새 결과가 있습니다. 작성 중인 내용을 유지했습니다.',entry); if(active(data.request))timer=setTimeout(()=>load(),10000); return; }
        view=data;renderedVersion=version;document.querySelector('#collection-result').innerHTML=renderResult(data);
      }
      freshness('최신 자료 확인 완료',entry);
      if(active(data.request)||['pending','updating'].includes(data.companyDetail?.integrated?.status)&&!data.companyDetail?.legacyObservationView)timer=setTimeout(()=>{if(!document.hidden)load();else timer=setTimeout(()=>load(),10000);},10000);
    } catch(error) {
      if(!contextCurrent())return;
      if(error.status===401){
        expireSession();
        return;
      }
      if([403,404].includes(error.status)){denyCompany(id);return;}
      if(!current())return;
      connectionBusy(false);
      disableCollection('수집 가능 여부를 다시 확인해 주세요.');
      if(view?.referenceLoading){
        view={...view,referenceLoading:false,referenceError:true};
        if(!document.querySelector('#collection-result form:focus-within, #collection-result form[data-dirty]'))document.querySelector('#collection-result').innerHTML=renderResult(view);
        else for(const [part,message] of [['products','상품 자료 연결 확인 필요'],['channels','예약채널 연결 확인 필요'],['observation','통합관측 연결 확인 필요']]){
          const status=document.querySelector(`#collection-result [data-reference-status="${part}"]`);if(status)status.textContent=message;
        }
      }
      freshness(view?'최신 확인 실패 · 이전 조회 자료 유지':'최신 자료 확인 실패',cached(id,month));
      if(!view)document.querySelector('#collection-result').innerHTML='<p class="muted">업체 자료를 확인하지 못했습니다.</p>';
      const message=error.status?error.message:'최신 자료를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.';
      const target=document.querySelector('#collection-progress');if(target)target.innerHTML=`<p class="collection-warning">${esc(message)} <button class="button small" data-action="refresh-collection">다시 확인</button></p>`;
    }
  }
  window.InsightCollection={panel,loading,prefetch,
    setContext(scope,ids,sessionExpired){
      if(scope!==cacheScope){clearCache();cacheScope=scope;}
      const next=Array.isArray(ids)?new Set(ids):null;
      if(allowedCompanies&&next)for(const id of allowedCompanies)if(!next.has(id))invalidate(id);
      allowedCompanies=next;onSessionExpired=typeof sessionExpired==='function'?sessionExpired:null;
      for(const [key,entry] of cache)if(!permitted(entry.companyId))cache.delete(key);
      for(const id of lastMonths.keys())if(!permitted(id))lastMonths.delete(id);
      for(const id of references.keys())if(!permitted(id))references.delete(id);
    },clearCache,invalidate,
    mount(id,request,options={}){mountOptions=options;seed(options.company);display={mode:'stacked',metric:'bookings',month:''};selectedMonth=lastMonths.get(id)||'';display.month=selectedMonth;serial++;clearTimeout(timer);companyId=id;api=request;view=null;renderedVersion=null;showCached();load();},stop(){serial++;clearTimeout(timer);},refresh:()=>load(true),
    correction(index,p){const r=view?.result, product=r?.products[Number(index)];if(!product)throw Error('수집 결과를 다시 열어 주세요.');const proposed={};if(p.total!=='')proposed.total=Number(p.total);if(p.productType!==product.productType)proposed.productType=p.productType;return {companyId,baseVersion:r.version,target:{runId:r.runId,productKey:product.key,date:p.date},proposed,reason:p.reason};}};
})();
