(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=v=>v==null?'미확인':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1});
  const rate=v=>v==null?'비교 보류':`${(v*100).toFixed(1)}%`;
  const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const prior=()=>{const d=today();return new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7)-2,1)).toISOString().slice(0,7);};
  let seq=0,api,kind,regionData=null,pollTimer=null,refreshTimer=null,renderedVersion=null;
  // Previously authorized regional results remain private to this signed-in page.
  // Reload restoration comes from the freshly authenticated /me response only.
  const cache=new Map(),inFlight=new Map(),regionEpochs=new Map(),deniedRegions=new Set();
  const CACHE_LIMIT=24,CACHE_MAX_AGE=30*60*1000,PERSISTED_MAX_AGE=7*24*60*60*1000,CLOCK_SKEW=60*1000;
  // A preserved report may take the source's full three-minute budget to
  // recalculate. Cover that window without keeping an endless polling loop.
  const REPORT_CHECK_DELAYS=[2000,4000,8000,16000,30000,45000,45000,45000];
  let cacheScope='default',allowedRegions=null,cacheGeneration=0,onSessionExpired=null;
  const reports=new Map(),reportRequests=new Map(),deniedReports=new Set();
  let reportScope='',reportPermission='',reportGeneration=0,reportOwnIds=[],reportCompanies=new Set(),reportRegions=new Set();
  const epoch=id=>regionEpochs.get(id)||0;
  const requestAllowed=id=>Boolean(cacheScope)&&(!allowedRegions||allowedRegions.has(id));
  const permitted=id=>requestAllowed(id)&&!deniedRegions.has(id);
  const cacheKey=(id,month)=>JSON.stringify([cacheScope,id,month]);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const version=data=>{const {responseCache,generatedAt,...result}=data;return JSON.stringify(result);};
  const reportVersion=data=>{const {responseCache,...result}=data;return JSON.stringify(result);};
  const validMonth=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  const timestamp=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
    const parsed=Date.parse(value),canonical=value.replace(/(?:\.(\d{1,3}))?Z$/,(_,fraction)=>'.'+(fraction||'').padEnd(3,'0')+'Z');
    return Number.isFinite(parsed)&&new Date(parsed).toISOString()===canonical?parsed:NaN;
  };
  function lifetime(data,checkedAt){
    const info=data?.responseCache||{},now=Date.now();
    const stamp=Number.isFinite(checkedAt)?checkedAt:info.checkedAt===undefined?now:timestamp(info.checkedAt);
    // Source servers and browsers can differ slightly. Keep the source's
    // original clock; a small permitted skew must not manufacture a new one.
    if(!Number.isFinite(stamp)||stamp>now+CLOCK_SKEW)return null;
    if(info.persisted===true){
      // Only the authenticated server can opt an older snapshot into its fixed
      // persisted lifetime. Reading it again must never advance checkedAt.
      const until=timestamp(info.validUntil);
      if(timestamp(info.checkedAt)!==stamp||info.state!=='cached'||info.revalidationRequired!==true||!Number.isFinite(until)||until<=now||until<=stamp||until>stamp+PERSISTED_MAX_AGE)return null;
      return {checkedAt:stamp,validUntil:until,persisted:true};
    }
    return now-stamp<=CACHE_MAX_AGE?{checkedAt:stamp,validUntil:stamp+CACHE_MAX_AGE,persisted:false}:null;
  }
  function previousNotice(entry,message='이전 저장 자료 표시 · 최신 자료 확인 중'){
    return entry?.persisted&&Date.now()-entry.checkedAt>CACHE_MAX_AGE?`${message} · 마지막 확인 ${time(new Date(entry.checkedAt).toISOString())}`:message;
  }
  function clearTimers(){if(pollTimer!==null)clearTimeout(pollTimer);if(refreshTimer!==null)clearTimeout(refreshTimer);pollTimer=refreshTimer=null;}
  function clearReports(){reportGeneration++;reports.clear();reportRequests.clear();deniedReports.clear();}
  function clearCache(){cacheGeneration++;cache.clear();inFlight.clear();regionEpochs.clear();deniedRegions.clear();clearReports();}
  function invalidate(id){
    regionEpochs.set(id,epoch(id)+1);
    for(const [key,entry] of cache)if(entry.regionKey===id)cache.delete(key);
    for(const [key,entry] of inFlight)if(entry.regionKey===id)inFlight.delete(key);
  }
  function configureCache({scope='',regionKeys=[],onSessionExpired:expired=null}={}){
    const next=typeof scope==='string'?scope:'';
    if(next!==cacheScope){clearCache();seq++;regionData=null;renderedVersion=null;clearTimers();cacheScope=next;}
    const allowed=new Set(Array.isArray(regionKeys)?regionKeys.filter(value=>typeof value==='string'):[]);
    if(allowedRegions)for(const id of allowedRegions)if(!allowed.has(id)){invalidate(id);deniedRegions.add(id);}
    for(const id of allowed)if(!allowedRegions?.has(id))deniedRegions.delete(id);
    allowedRegions=allowed;onSessionExpired=typeof expired==='function'?expired:null;
  }
  function cached(id,month){
    if(!permitted(id))return null;
    const key=cacheKey(id,month),entry=cache.get(key);if(!entry)return null;
    if(Date.now()>=entry.validUntil){cache.delete(key);return null;}
    cache.delete(key);cache.set(key,entry);return entry;
  }
  function remember(id,month,data,checkedAt){
    if(!requestAllowed(id)||data?.region?.id!==id||data.month!==month)throw Error('선택한 지역·기간과 응답이 다릅니다.');
    const saved=clone(data),age=lifetime(saved,checkedAt);
    if(!age)throw Error('저장 자료의 확인 시각과 유효기간을 다시 확인해 주세요.');
    const entry={regionKey:id,month,data:saved,version:version(saved),...age};
    deniedRegions.delete(id);
    const key=cacheKey(id,month);cache.delete(key);cache.set(key,entry);
    while(cache.size>CACHE_LIMIT)cache.delete(cache.keys().next().value);
    return entry;
  }
  function restore(views,scope){
    if(!scope||scope!==cacheScope||!allowedRegions||!Array.isArray(views))return;
    const rows=views.slice(0,CACHE_LIMIT*2).sort((a,b)=>Date.parse(b?.data?.responseCache?.checkedAt)-Date.parse(a?.data?.responseCache?.checkedAt));
    for(const row of rows){
      const id=row?.regionKey,month=row?.month,data=row?.data,at=timestamp(data?.responseCache?.checkedAt);
      if(!permitted(id)||!validMonth(month)||!Number.isFinite(at)||!lifetime(data,at)||epoch(id)>0)continue;
      if(data?.region?.id!==id||data.month!==month||!Array.isArray(data.sources)||cached(id,month))continue;
      if(cache.size>=CACHE_LIMIT)break;
      try{remember(id,month,data,at);}catch{}
    }
  }
  const reportPeriod=()=>{const start=today();return {start,end:new Date(Date.parse(start+'T00:00:00Z')+29*86400000).toISOString().slice(0,10),days:30};};
  const reportKey=(ownId,period)=>JSON.stringify([reportScope,reportPermission,ownId,period.start,period.end]);
  const reportAllowed=ownId=>Boolean(reportScope)&&(ownId===''||reportOwnIds.includes(ownId));
  function configureReports({scope='',ownIds=[],companyIds=[],regionKeys=[],permissionVersion='',onSessionExpired:expired=null}={}){
    const next=typeof scope==='string'?scope:'',owns=Array.isArray(ownIds)?[...new Set(ownIds.filter(id=>typeof id==='string'&&id))]:[];
    const companies=Array.isArray(companyIds)?companyIds.filter(id=>typeof id==='string'&&id):[],regions=Array.isArray(regionKeys)?regionKeys.filter(id=>typeof id==='string'&&id):[];
    const permission=JSON.stringify([permissionVersion,owns,[...new Set(companies)].sort(),[...new Set(regions)].sort()]);
    if(next!==reportScope||permission!==reportPermission){clearReports();if(kind==='reports'){seq++;renderedVersion=null;clearTimers();const slot=document.querySelector('#analysis-output');if(slot)slot.innerHTML='<p class="empty-note">등록 상태를 확인하고 있습니다.</p>';freshness('');}}
    reportScope=next;reportPermission=permission;reportOwnIds=owns;reportCompanies=new Set(companies);reportRegions=new Set(regions);
    if(typeof expired==='function')onSessionExpired=expired;
  }
  function reportScopeValid(data,ownId,period){
    const expected=ownId||reportOwnIds[0]||null;
    if(!reportAllowed(ownId)||!data||data.mode!=='current_briefing'||data.published!==false||data.ownId!==expected||data.period?.start!==period.start||data.period?.end!==period.end||data.period?.days!==30)return false;
    const generated=timestamp(data.generatedAt);if(!Number.isFinite(generated)||generated>Date.now()+CLOCK_SKEW)return false;
    if(!['companies','comparisons','regions','actions','definitions'].every(key=>Array.isArray(data[key])))return false;
    if(data.companies.some(company=>!reportCompanies.has(company?.companyId)||!['own','competitor'].includes(company.kind)||!company.summary||typeof company.summary!=='object'))return false;
    const own=data.companies.filter(company=>company.kind==='own');
    if(expected?(own.length!==1||own[0].companyId!==expected):own.length!==0)return false;
    if(new Set(data.companies.map(company=>company.companyId)).size!==data.companies.length)return false;
    if(data.comparisons.some(company=>!reportCompanies.has(company?.companyId)||!company.own||!company.competitor))return false;
    return !data.regions.some(region=>!reportRegions.has(region?.region?.id)||!Array.isArray(region.sources));
  }
  function reportCached(ownId,period){
    const key=reportKey(ownId,period),entry=reports.get(key);
    if(!entry||!reportAllowed(ownId)||deniedReports.has(ownId))return null;
    if(Date.now()>=entry.validUntil||!reportScopeValid(entry.data,ownId,period)){reports.delete(key);return null;}
    reports.delete(key);reports.set(key,entry);return entry;
  }
  function rememberReport(ownId,period,data){
    if(!reportScopeValid(data,ownId,period))throw Error('선택한 내 매장·숙박기간과 리포트가 다릅니다.');
    const saved=clone(data),checked=timestamp(saved.responseCache?.checkedAt||saved.generatedAt),age=lifetime(saved,checked);
    if(!age)throw Error('저장 리포트의 확인 시각과 유효기간을 다시 확인해 주세요.');
    const entry={ownId,period:{...period},data:saved,version:reportVersion(saved),...age},key=reportKey(ownId,period);
    deniedReports.delete(ownId);reports.delete(key);reports.set(key,entry);while(reports.size>CACHE_LIMIT)reports.delete(reports.keys().next().value);return entry;
  }
  function restoreReports(views,scope){
    if(!scope||scope!==reportScope||!Array.isArray(views))return;
    const period=reportPeriod();
    for(const row of views.slice(0,CACHE_LIMIT*2).sort((a,b)=>Date.parse(b?.data?.responseCache?.checkedAt)-Date.parse(a?.data?.responseCache?.checkedAt))){
      const ownId=row?.ownId;
      if(typeof ownId!=='string'||!reportAllowed(ownId)||deniedReports.has(ownId)||row.period?.start!==period.start||row.period?.end!==period.end||row.period?.days!==30||reportCached(ownId,period))continue;
      if(reports.size>=CACHE_LIMIT)break;
      try{rememberReport(ownId,period,row.data);}catch{}
    }
  }
  function readReport(ownId,period,request,force){
    const key=reportKey(ownId,period)+(force?':refresh':'');let pending=reportRequests.get(key);
    if(!pending){
      let promise;try{promise=Promise.resolve(request(`/reports/briefing${ownId?'?ownId='+encodeURIComponent(ownId):''}`,undefined,{refresh:force}));}catch(error){promise=Promise.reject(error);}
      pending={promise};reportRequests.set(key,pending);const cleanup=()=>{if(reportRequests.get(key)===pending)reportRequests.delete(key);};promise.then(cleanup,cleanup);
    }
    return pending.promise;
  }
  function drawReport(slot,data,preserve=false){
    const open=new Set(preserve?detailKeys(slot).filter(row=>row.detail.open).map(row=>row.key):[]);
    slot.innerHTML=reportView(data);for(const row of detailKeys(slot))if(open.has(row.key))row.detail.open=true;
  }
  function freshness(message,state='notice'){
    const target=document.querySelector('#analysis-freshness');if(!target)return;
    target.textContent=message;target.hidden=!message;target.dataset.state=state;
  }
  function detailKeys(slot){
    const counts=new Map();return [...(slot.querySelectorAll?.('details')||[])].map(detail=>{
      const source=detail.closest?.('[data-history-source]')?.dataset.historySource;
      const base=source?'source:'+source:'note:'+(detail.querySelector?.('summary')?.textContent||'');
      const index=counts.get(base)||0;counts.set(base,index+1);return {detail,key:base+':'+index};
    });
  }
  function drawRegion(slot,data,preserve=false){
    const metrics=preserve?[...(slot.querySelectorAll?.('[data-history-metric]')||[])].map(select=>({key:select.closest('[data-history-source]')?.dataset.historySource,value:select.value})):[];
    const open=new Set(preserve?detailKeys(slot).filter(row=>row.detail.open).map(row=>row.key):[]);
    const focused=preserve&&slot.contains?.(document.activeElement)?document.activeElement:null;
    const focusMetric=focused?.matches?.('[data-history-metric]')?focused.closest('[data-history-source]')?.dataset.historySource:null;
    const focusDetail=focused?.matches?.('summary')?detailKeys(slot).find(row=>row.detail===focused.closest('details'))?.key:null;
    const focusRefresh=focused?.matches?.('[data-history-refresh]');
    slot.innerHTML=regionView(data);
    for(const metric of metrics){
      const card=[...(slot.querySelectorAll?.('[data-history-source]')||[])].find(row=>row.dataset.historySource===metric.key);
      const source=data.sources?.find(row=>row.key===metric.key);
      if(card&&source?.metrics?.some(row=>row.key===metric.value)&&window.InsightRegionHistory)card.outerHTML=window.InsightRegionHistory.source(source,data.window,metric.value);
    }
    const details=detailKeys(slot);for(const row of details)if(open.has(row.key))row.detail.open=true;
    const focus=focusMetric?[...(slot.querySelectorAll?.('[data-history-metric]')||[])].find(select=>select.closest('[data-history-source]')?.dataset.historySource===focusMetric):focusDetail?details.find(row=>row.key===focusDetail)?.detail.querySelector('summary'):focusRefresh?slot.querySelector?.('[data-history-refresh]'):null;
    focus?.focus?.({preventScroll:true});
  }
  function expireSession(){
    clearCache();cacheScope='';allowedRegions=new Set();seq++;regionData=null;renderedVersion=null;clearTimers();
    reportScope='';reportPermission='';reportOwnIds=[];reportCompanies.clear();reportRegions.clear();
    const slot=document.querySelector('#analysis-output');if(slot)slot.innerHTML='<p class="collection-warning">로그인이 만료되었습니다. 다시 로그인해 주세요.</p>';
    freshness('');if(onSessionExpired)onSessionExpired();
  }
  function readPending(id,month,request,force){
    const key=cacheKey(id,month)+(force?':refresh':'');let pending=inFlight.get(key);
    if(!pending){
      let promise;try{promise=Promise.resolve(request(`/regions/${encodeURIComponent(id)}/analysis?month=${encodeURIComponent(month)}`,undefined,{refresh:force}));}catch(error){promise=Promise.reject(error);}
      pending={promise,regionKey:id};inFlight.set(key,pending);
      const cleanup=()=>{if(inFlight.get(key)===pending)inFlight.delete(key);};promise.then(cleanup,cleanup);
    }
    return pending.promise;
  }
  function regionSelection(s,selectedRegion=null,selectedOwnId=null) {
    const regions=Array.isArray(s.regions)?s.regions:[];
    if(selectedRegion!==null&&selectedRegion!==undefined)return regions.some(r=>r.id===selectedRegion)?{id:selectedRegion}:{id:'',message:'등록한 지역의 자료를 찾을 수 없습니다. 분석 지역을 다시 선택해 주세요.'};
    const own=(s.customer?.relations||[]).filter(r=>r.kind==='own'&&['active','pending'].includes(r.status));
    const relation=own.find(r=>r.companyId===selectedOwnId)||own[0];
    if(relation){
      const company=(s.companies||[]).find(c=>c.companyId===relation.companyId);
      if(!company)return {id:'',message:'내 매장 기본자료를 연결하지 못했습니다. 매장 정보를 확인해 주세요.'};
      if(!company.regionKey)return {id:'',message:'내 매장 소재지의 시군구 연결이 필요합니다. 매장 주소와 지역 정보를 확인해 주세요.'};
      if(!regions.some(r=>r.id===company.regionKey))return {id:'',message:'내 매장 소재지가 분석 가능 지역에 연결되지 않았습니다. 지역 연결 상태를 확인해 주세요.'};
      return {id:company.regionKey};
    }
    return regions.length?{id:regions[0].id}:{id:'',message:'관심지역을 등록하면 지역 자료가 연결됩니다.'};
  }
  function panel(mode,s,selectedRegion=null,selectedOwnId=null) {
    const own=s.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>s.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const choices=mode==='regions'?s.regions:own;
    const selection=mode==='regions'?regionSelection(s,selectedRegion,selectedOwnId):null;
    return `<section class="card analysis-intro"><span class="eyebrow">${mode==='regions'?'REGIONAL CONTEXT':'SITUATION → NEXT ACTION'}</span><h2>${mode==='regions'?'지역의 12개월 흐름':'현재 상황과 다음 행동'}</h2><p class="muted">${mode==='regions'?'등록한 관심지역과 매장 소재지의 방문·체류·소비·검색 관심 변화를 확인합니다.':'내 매장·등록 경쟁업체·지역 배경을 함께 확인합니다. 저장 자료로 보는 현재 상황 브리핑입니다.'}</p><form id="analysis-form" data-analysis-form><div class="form-grid"><label class="field"><span>${mode==='regions'?'분석 지역':'기준 내 매장'}</span><select name="${mode==='regions'?'regionKey':'ownId'}" ${!choices.length?'disabled':''}>${selection&&!selection.id?'<option value="" selected disabled>지역 연결 확인 필요</option>':''}${choices.map(c=>`<option value="${esc(c.id||c.companyId)}"${selection?.id===(c.id||c.companyId)?' selected':''}>${esc(c.label||c.name)}</option>`).join('')||'<option>등록 대기</option>'}</select></label>${mode==='regions'?`<label class="field"><span>마지막 기준월</span><input name="month" type="month" min="2017-12" max="${prior()}" value="${prior()}" required></label>`:'<p class="muted">예약 전망은 오늘 포함 향후 30일, 지역 배경은 최근 12개월 흐름과 각 통계의 실제 공표기간을 사용합니다.</p>'}</div><button class="button" type="submit" ${mode==='regions'&&!selection.id?'disabled':''}>저장 자료 확인</button></form></section><p id="analysis-freshness" class="muted" role="status" aria-live="polite" hidden></p><section id="analysis-output" aria-live="polite"><p class="empty-note">${esc(selection?.message||'저장 자료를 불러오고 있습니다.')}</p></section>`;
  }
  const status=s=>({ready:'저장 자료',complete:'정상 자료',partial:'일부 자료',missing:'자료 없음',publication_pending:'공표 대기',not_configured:'연결 준비',error:'확인 필요',pending:'대기'}[s]||'상태 확인');
  function sourceCard(s) {
    const rows=s.rows||[],latest=rows.filter(r=>r.value!==null).at(-1);
    return `<article class="card region-source"><div class="analysis-card-top"><h3>${esc(s.label)}</h3><span class="status-pill ${latest?'':'pending'}">${esc(status(s.status))}</span></div><p class="muted">${esc(s.provider)} · 기준 ${esc(s.period||'확인 전')}${s.partialMonth?' · 진행 중인 월 포함':''}</p><p class="region-source-value">${latest?`${esc(latest.label)} <strong>${n(latest.value)}</strong> ${esc(latest.unit)}`:'저장된 수치 없음'}</p><details><summary>세부 지표·출처 확인</summary><div class="collection-table-wrap"><table><thead><tr><th>지표</th><th>값</th><th>단위</th></tr></thead><tbody>${rows.map(r=>`<tr><th>${esc(r.label)}</th><td>${n(r.value)}</td><td>${esc(r.unit)}</td></tr>`).join('')||'<tr><td colspan="3">자료가 없습니다.</td></tr>'}</tbody></table></div><p class="muted">저장 ${esc(time(s.retrievedAt))}${s.sourceUpdatedAt?` · 원자료 갱신 ${esc(s.sourceUpdatedAt)}`:''}</p>${s.sourceUrl?`<a class="text-link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">자료 출처</a>`:''}</details></article>`;
  }
  function regionView(r) {
    if(r.window&&window.InsightRegionHistory)return window.InsightRegionHistory.render(r);
    const loc=r.location;
    return `<div class="analysis-heading"><h2>${esc(r.region.label)}</h2><span class="status-pill">${r.availableSources}종 저장 지표</span></div><p class="muted">관광 기준월 ${esc(r.month)} · 데이터랩 저장 자료 · 화면 조회로 외부 API를 수집하지 않습니다.</p>${loc?`<section class="card region-location"><h3>입지·고객층 참고</h3><p>${esc(loc.interpretation)}</p><div class="analysis-clusters">${loc.clusters.map(c=>`<article><strong>${esc(c.name)}</strong><p>${esc(c.demand)}</p><small>${esc(c.product)}</small></article>`).join('')}</div><p class="muted">상품 검토 방향: ${esc(loc.recommendedProduct)}</p><p class="muted">${esc(loc.caution)}</p><small class="muted">${esc(loc.source)} · 기준 ${esc(time(loc.updatedAt))}</small></section>`:'<p class="empty-note">이 지역의 입지 해석 자료는 아직 저장되지 않았습니다.</p>'}<div class="region-source-grid">${r.sources.map(sourceCard).join('')||'<p class="empty-note">저장된 지역 지표가 없습니다. 관리자에게 지역 자료 준비를 요청하세요.</p>'}</div>${r.warnings?.length?`<details class="card analysis-notes"><summary>지표를 읽을 때 확인할 점</summary><ul>${r.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}`;
  }
  function trendBrief(g) {
    if(!g.window)return '';
    return `<div class="briefing-trends">${[['tourism_visitors','averageDailyVisitors'],['tourism_stay_spend','spendOverall'],['naver_search_trend','interest']].map(([key,metric])=>{
      const source=g.sources?.find(s=>s.key===key),m=source?.metrics?.find(m=>m.key===metric);
      return `<p><strong>${esc(m?.label||({averageDailyVisitors:'일평균 방문자',spendOverall:'소비 지수',interest:'검색 관심도'}[metric]))}</strong> · ${m?.latest?`${esc(m.latest.month)} ${n(m.latest.value)} ${esc(m.unit)}<br>전월 ${window.InsightRegionHistory?.delta(m.mom)||'비교 자료 없음'} · 전년 동월 ${window.InsightRegionHistory?.delta(m.yoy)||'비교 자료 없음'}`:'월별 자료 확인 필요'}</p>`;
    }).join('')}</div>`;
  }
  function reportView(r) {
    const own=r.companies.find(c=>c.kind==='own');
    return `<section class="briefing-banner"><span class="eyebrow">현재 상황 브리핑 · 미발행</span><h2>${esc(own?.name||'사업 준비')}의 다음 판단</h2><p>숙박일 ${esc(r.period.start)} ~ ${esc(r.period.end)}</p><p class="muted">확인 시각 ${esc(time(r.generatedAt))}</p></section><section class="card"><div class="db-section-heading"><b>1</b><h2>현재 상황</h2></div><div class="briefing-company-grid">${r.companies.map(c=>`<article><span class="status-pill">${c.kind==='own'?'내 매장':'경쟁업체'}</span><h3>${esc(c.name)}</h3><p class="muted">객실 ${c.rooms==null?'미확인':n(c.rooms)+'실'} · 수량 유효 ${c.summary.days}/30일<br>마지막 관측 ${esc(c.lastObservedAt?time(c.lastObservedAt):(c.lastObservedDay||'확인 전'))}</p><dl><div><dt>추정 예약률</dt><dd>${rate(c.summary.reservationRate)}</dd></div><div><dt>공개 예약</dt><dd class="public-value">${c.summary.publicBookings==null?'미확인':n(c.summary.publicBookings)+'실'}</dd></div><div><dt>방막기 추정</dt><dd class="estimated-value">${c.summary.phoneBookings==null?'미확인':n(c.summary.phoneBookings)+'실'}</dd></div><div><dt>추정매출</dt><dd>${c.summary.estimatedRevenue===null?'산출 보류':`${n(c.summary.estimatedRevenue)}원`}</dd></div></dl><p class="muted">${c.unavailable?'자료 연결 확인 필요':'위 수치는 업체별 확보 기간의 요약입니다. 업체 간 비교는 아래 공통 날짜 기준을 확인하세요.'}</p><a class="text-link" href="#collection=${encodeURIComponent(c.companyId)}">근거·수집 결과 확인</a></article>`).join('')||'<p class="empty-note">등록한 업체가 없습니다.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>2</b><h2>경쟁업체와의 차이</h2></div><p class="muted">같은 숙박일과 같은 관측일이 겹치는 자료만 비교합니다. 가격·시설·연휴 등의 원인은 이 차이만으로 확정하지 않습니다.</p><div class="collection-table-wrap"><table><thead><tr><th>경쟁업체</th><th>공통 숙박일</th><th>내 매장 예약률</th><th>경쟁 예약률</th><th>차이</th><th>판단 상태</th></tr></thead><tbody>${r.comparisons.map(c=>`<tr><th>${esc(c.name)}</th><td>${c.commonDays}일</td><td>${rate(c.own.reservationRate)}</td><td>${rate(c.competitor.reservationRate)}</td><td>${c.gapPp===null?'비교 보류':`${c.gapPp>0?'+':''}${n(c.gapPp)}%p`}</td><td>${c.status==='comparable'?'비교 가능':'표본 부족'}</td></tr>`).join('')||'<tr><td colspan="6">내 매장과 경쟁업체 자료가 필요합니다.</td></tr>'}</tbody></table></div></section><section class="card"><div class="db-section-heading"><b>3</b><h2>지역 수요 배경</h2></div><div class="briefing-region-grid">${r.regions.map(g=>`<article><span class="status-pill">${g.region.id===own?.regionKey?'매장 소재지':'관심지역'}</span><h3>${esc(g.region.label)}</h3><p>${g.window?`최근 12개월 ${esc(g.window.start)} ~ ${esc(g.window.end)}`:`기준월 ${esc(g.month)}`} · 저장 지표 ${g.availableSources}종</p><p class="muted">${esc(g.location?.interpretation||'입지 해석 자료 확인 전')}</p>${trendBrief(g)}<a href="#regions=${encodeURIComponent(g.region.id)}" class="text-link">지역별 지표·출처 확인</a></article>`).join('')||'<p class="empty-note">매장 소재지 또는 관심지역을 연결해 주세요.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>4</b><h2>다음 행동</h2></div><div class="briefing-actions">${r.actions.map((a,i)=>`<article><span class="action-number">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(a.title)}</h3><p>${esc(a.reason)}</p><p class="action-step">${esc(a.next)}</p><p class="muted">실행 후 확인: ${esc(a.check)}</p><small class="muted">근거: ${esc(a.source)}</small></div></article>`).join('')}</div></section><details class="card analysis-notes"><summary>집계 범위와 판단 기준</summary><ul>${r.definitions.map(d=>`<li>${esc(d)}</li>`).join('')}</ul></details>`;
  }
  const jobStatus=s=>({queued:'대기',running:'갱신 중',ready:'완료',complete:'완료',partial:'일부 자료',failed:'실패',missing:'자료 없음',interrupted:'중단',publication_pending:'공표 대기'}[s]||'확인 전');
  const jobError=code=>({MISSING_KEY:'인증키 설정 필요',AUTH_ERROR:'이용 권한 확인 필요',QUOTA_EXCEEDED:'제공기관 요청 한도 도달',TIMEOUT:'응답 시간 초과',NETWORK_ERROR:'연결 실패',REGIONAL_SOURCE_BUSY:'다른 지역 자료 갱신 중',MISSING_VALUES:'일부 월 자료 없음',NO_DATA:'제공 자료 없음',PUBLICATION_PENDING:'아직 공표되지 않음',CACHE_WRITE_ERROR:'자료 저장 실패'}[code]||'자료 연결 확인 필요');
  async function checkPreparation(id,params,start=false,wasActive=false) {
    const slot=document.querySelector('#history-progress'),button=document.querySelector('[data-history-refresh]');
    const scope=cacheScope,generation=cacheGeneration,regionEpoch=epoch(params.regionKey);
    const current=()=>id===seq&&slot?.isConnected&&scope===cacheScope&&generation===cacheGeneration&&regionEpoch===epoch(params.regionKey)&&requestAllowed(params.regionKey);
    if(!slot||!current())return;
    if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null;}
    if(button)button.disabled=true;
    if(start)slot.textContent='24개월 지역 자료 갱신을 요청하고 있습니다.';
    let active=false;
    try {
      const base=`/regions/${encodeURIComponent(params.regionKey)}/preparation`;
      const result=await api(start?base:`${base}?month=${encodeURIComponent(params.month)}`,start?{month:params.month}:undefined);
      if(!current())return;
      if(result.regionKey!==params.regionKey||result.month!==params.month)throw Error('선택한 지역·기간과 응답이 다릅니다.');
      const job=result.job;active=['queued','running'].includes(job?.status);
      slot.innerHTML=job?`<p>${job.reused?'방금 준비한 결과를 사용합니다. ':''}${jobStatus(job.status)} · ${job.progress.completed}/${job.progress.total} 항목</p><ul>${job.steps.map(s=>`<li>${esc(s.label)} · ${jobStatus(s.status)}${s.observedMonths!==null&&s.observedMonths!==undefined?` (${s.observedMonths}/${s.expectedMonths}개월)`:''}${s.errorCode?` · ${esc(jobError(s.errorCode))}`:''}</li>`).join('')}</ul>${active?'<p>화면을 이동해도 서버에서 준비를 계속합니다.</p>':'<p>같은 지역·기간은 공유하며 1시간 안의 반복 요청은 저장 결과를 사용합니다.</p>'}`:'';
      if(active)pollTimer=setTimeout(()=>{pollTimer=null;void checkPreparation(id,params,false,true);},3000);
      else if(start||wasActive){invalidate(params.regionKey);await load({force:true});}
    } catch(e) {
      if(current()){
        if(e.status===401)expireSession();
        else if([403,404].includes(e.status)){
          invalidate(params.regionKey);deniedRegions.add(params.regionKey);regionData=null;renderedVersion=null;
          document.querySelector('#analysis-output').innerHTML='<p class="collection-warning">지역 등록과 조회 권한을 다시 확인해 주세요.</p>';freshness('');
        }else slot.textContent=e.message;
      }
    }
    finally {if(current()&&button?.isConnected)button.disabled=active;}
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('[data-history-refresh]');if(!button||button.disabled||!regionData)return;
    e.preventDefault();e.stopImmediatePropagation();
    if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
    const params=Object.fromEntries(new FormData(document.querySelector('#analysis-form')));
    void checkPreparation(seq,params,true);
  });
  async function loadReport({force=false,backgroundChecks=0}={}){
    const id=++seq,slot=document.querySelector('#analysis-output'),form=document.querySelector('#analysis-form');if(!slot||!form)return;
    if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
    const params=Object.fromEntries(new FormData(form)),ownId=reportOwnIds.length?params.ownId||'':'',period=reportPeriod(),request=api;
    const scope=reportScope,permission=reportPermission,generation=reportGeneration;
    const authorized=()=>scope===reportScope&&permission===reportPermission&&generation===reportGeneration&&reportAllowed(ownId);
    const visible=()=>id===seq&&slot.isConnected&&authorized();
    const button=form.querySelector('button');
    if(!reportAllowed(ownId)){renderedVersion=null;freshness('');button.disabled=true;slot.innerHTML='<p class="collection-warning">내 매장 등록과 리포트 조회 권한을 다시 확인해 주세요.</p>';return;}
    const entry=reportCached(ownId,period);regionData=null;button.disabled=true;
    if(entry){
      if(renderedVersion!==entry.version){drawReport(slot,entry.data);renderedVersion=entry.version;}
      freshness(previousNotice(entry,entry.persisted?'이전 저장 리포트 표시 · 최신 자료 확인 중':'이전 조회 리포트 표시 · 최신 자료 확인 중'),'checking');
    }else{renderedVersion=null;freshness('');slot.innerHTML='<p class="empty-note" role="status">업체별 보존 이력을 계산하고 있습니다. 자료량에 따라 최대 3분 정도 걸릴 수 있습니다.</p>';}
    try{
      const data=await readReport(ownId,period,request,force||deniedReports.has(ownId));
      if(!authorized())return;
      if(period.start!==reportPeriod().start){if(visible())void loadReport();return;}
      const fresh=rememberReport(ownId,period,data);if(!visible())return;
      if(renderedVersion!==fresh.version){drawReport(slot,fresh.data,Boolean(entry));renderedVersion=fresh.version;}
      const info=data.responseCache||{},pending=info.refreshing||info.revalidationRequired,checking=pending&&!info.refreshFailed&&backgroundChecks<REPORT_CHECK_DELAYS.length;
      const message=info.refreshFailed?'최신 리포트 확인 지연 · 이전 저장 자료를 표시합니다.':checking?'이전 저장 리포트 표시 · 최신 자료 확인 중':pending?'최신 확인에 시간이 걸려 이전 리포트를 표시합니다.':'';
      freshness(message?previousNotice(fresh,message):'',checking?'checking':'notice');
      if(checking&&typeof setTimeout==='function')refreshTimer=setTimeout(()=>{refreshTimer=null;if(visible())void loadReport({backgroundChecks:backgroundChecks+1});},REPORT_CHECK_DELAYS[backgroundChecks]);
    }catch(error){
      if(!authorized())return;
      if(error.status===401){expireSession();return;}
      if([403,404,409].includes(error.status)){
        const show=visible();clearReports();deniedReports.add(ownId);
        if(show){renderedVersion=null;freshness('');slot.innerHTML='<p class="collection-warning">업체·지역 등록과 리포트 조회 권한을 다시 확인해 주세요.</p>';}
      }else if(visible()){
        if(period.start!==reportPeriod().start){void loadReport();return;}
        if(entry&&Date.now()<entry.validUntil)freshness(previousNotice(entry,'최신 리포트 확인 지연 · 이전 저장 자료를 표시합니다.'));
        else{renderedVersion=null;freshness('');slot.innerHTML=`<p class="collection-warning">${esc(error.message)}</p>`;}
      }
    }finally{if(id===seq&&button.isConnected)button.disabled=false;}
  }
  async function load({force=false,backgroundChecks=0}={}) {
    if(kind==='reports')return loadReport({force,backgroundChecks});
    const id=++seq,slot=document.querySelector('#analysis-output'),form=document.querySelector('#analysis-form');if(!slot||!form)return;
    const mode=kind,request=api,params=Object.fromEntries(new FormData(form));
    if(refreshTimer!==null){clearTimeout(refreshTimer);refreshTimer=null;}
    if(mode==='regions'&&(!params.regionKey||!validMonth(params.month)||!requestAllowed(params.regionKey))){
      regionData=null;renderedVersion=null;freshness('');form.querySelector('button').disabled=true;
      slot.innerHTML='<p class="collection-warning">지역과 기준월의 조회 권한을 다시 확인해 주세요.</p>';return;
    }
    const scope=cacheScope,generation=cacheGeneration,regionEpoch=epoch(params.regionKey);
    const authorized=()=>scope===cacheScope&&generation===cacheGeneration&&regionEpoch===epoch(params.regionKey)&&(mode!=='regions'||requestAllowed(params.regionKey));
    const visible=()=>id===seq&&slot.isConnected&&authorized();
    const retainedAge=mode==='regions'&&force&&regionData?.region?.id===params.regionKey&&regionData.month===params.month?lifetime(regionData):null;
    const button=form.querySelector('button'),entry=mode==='regions'?(cached(params.regionKey,params.month)||(retainedAge?{data:regionData,version:version(regionData),...retainedAge}:null)):null;
    button.disabled=true;
    if(entry){
      regionData=entry.data;
      if(renderedVersion!==entry.version){drawRegion(slot,entry.data);renderedVersion=entry.version;}
      freshness(previousNotice(entry,entry.persisted?'이전 저장 자료 표시 · 최신 자료 확인 중':'이전 조회 자료 표시 · 최신 자료 확인 중'),'checking');
    }else{
      regionData=null;renderedVersion=null;freshness('');
      slot.innerHTML='<p class="empty-note" role="status">'+(mode==='reports'?'업체별 보존 이력을 계산하고 있습니다. 자료량에 따라 최대 3분 정도 걸릴 수 있습니다.':'저장 자료를 연결하고 있습니다.')+'</p>';
    }
    try {
      const data=await (mode==='regions'?readPending(params.regionKey,params.month,request,force||deniedRegions.has(params.regionKey)):request(`/reports/briefing${params.ownId?'?ownId='+encodeURIComponent(params.ownId):''}`));
      if(!authorized())return;
      const fresh=mode==='regions'?remember(params.regionKey,params.month,data):null;
      if(!visible())return;
      regionData=mode==='regions'?fresh.data:null;
      if(mode==='regions'){
        if(renderedVersion!==fresh.version){drawRegion(slot,fresh.data,Boolean(entry));renderedVersion=fresh.version;}
        const info=data.responseCache||{};
        const pending=info.refreshing||info.revalidationRequired,checking=pending&&!info.refreshFailed&&backgroundChecks<4;
        const message=info.refreshFailed?'최신 자료 확인 지연 · 이전 저장 자료를 표시합니다.':checking?(fresh.persisted?'이전 저장 자료 표시 · 최신 자료 확인 중':'저장 자료 표시 · 최신 자료 확인 중'):pending?'최신 확인에 시간이 걸려 이전 저장 자료를 표시합니다.':'';
        freshness(message?previousNotice(fresh,message):'',checking?'checking':'notice');
        if(checking&&typeof setTimeout==='function')refreshTimer=setTimeout(()=>{refreshTimer=null;if(visible())void load({backgroundChecks:backgroundChecks+1});},[2000,4000,8000,16000][backgroundChecks]);
        if(data.refreshAvailable)void checkPreparation(id,params);
      }else{slot.innerHTML=reportView(data);renderedVersion=null;}
    }
    catch(e){
      if(!authorized())return;
      if(e.status===401){expireSession();return;}
      if(mode==='regions'&&[403,404].includes(e.status)){
        invalidate(params.regionKey);deniedRegions.add(params.regionKey);
        if(id===seq&&slot.isConnected){regionData=null;renderedVersion=null;slot.innerHTML='<p class="collection-warning">지역 등록과 조회 권한을 다시 확인해 주세요.</p>';freshness('');}
      }else if(visible()){
        if(entry&&Date.now()<entry.validUntil)freshness(previousNotice(entry,'최신 자료 확인 지연 · 이전 조회 자료를 표시합니다.'));
        else {regionData=null;renderedVersion=null;freshness('');slot.innerHTML=`<p class="collection-warning">${esc(e.message)}</p>`;}
      }
    }
    finally{if(id===seq&&button.isConnected)button.disabled=false;}
  }
  document.addEventListener('submit',e=>{if(e.target.id!=='analysis-form')return;e.preventDefault();e.stopImmediatePropagation();load();});
  document.addEventListener('change',e=>{if(e.target.matches?.('[data-history-metric]')&&regionData){const card=e.target.closest('[data-history-source]'),s=regionData.sources.find(s=>s.key===card.dataset.historySource);if(s)card.outerHTML=window.InsightRegionHistory.source(s,regionData.window,e.target.value);return;}if(e.target.closest?.('#analysis-form'))load();});
  window.InsightAnalysis={panel,regionView,reportView,configureCache,configureReports,restore,restoreReports,clearCache,invalidate,mount(mode,request,s,selectedRegion=null,selectedOwnId=null){kind=mode;api=request;renderedVersion=null;
    if(mode==='reports'){
      const select=document.querySelector('#analysis-form select');
      if(select)select.value=reportOwnIds.includes(selectedOwnId)?selectedOwnId:reportOwnIds[0]||'';
    }
    if(mode==='regions'){
      configureCache({scope:cacheScope,regionKeys:(s.regions||[]).map(row=>row.id),onSessionExpired});
      const selection=regionSelection(s,selectedRegion,selectedOwnId),select=document.querySelector('#analysis-form select');
      if(select)select.value=selection.id;
      if(!selection.id){
        seq++;regionData=null;clearTimers();
        const slot=document.querySelector('#analysis-output'),button=document.querySelector('#analysis-form')?.querySelector('button');
        if(slot)slot.innerHTML=`<p class="collection-warning">${esc(selection.message)}</p>`;
        if(button)button.disabled=true;
        return;
      }
    }
    load();},stop(){seq++;regionData=null;renderedVersion=null;clearTimers();}};
})();
