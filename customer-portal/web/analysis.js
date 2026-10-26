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
  const reports=new Map(),reportPreviews=new Map(),reportRequests=new Map(),deniedReports=new Set();
  let reportScope='',reportPermission='',reportGeneration=0,reportRequestSequence=0,reportOwnIds=[],reportCompanies=new Set(),reportRegions=new Set();
  let reportViewSelection={stayMode:'all_available',month:null,start:null,end:null};
  const epoch=id=>regionEpochs.get(id)||0;
  const requestAllowed=id=>Boolean(cacheScope)&&(!allowedRegions||allowedRegions.has(id));
  const permitted=id=>requestAllowed(id)&&!deniedRegions.has(id);
  const cacheKey=(id,month)=>JSON.stringify([cacheScope,id,month]);
  const clone=value=>JSON.parse(JSON.stringify(value));
  const version=data=>{const {responseCache,generatedAt,...result}=data;return JSON.stringify(result);};
  const reportVersion=data=>{const {responseCache,...result}=data;return JSON.stringify([result,isReportPreview(data)?[responseCache.calculationStatus,responseCache.refreshing===true,responseCache.refreshFailed===true]:null]);};
  const validMonth=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  const previewErrors={REPORT_CALCULATION_TIMEOUT:'최신 리포트 계산이 지연되고 있습니다. 저장 자료를 유지합니다. 다시 확인해 주세요.',REPORT_CALCULATION_FAILED:'최신 리포트 계산을 확인하지 못했습니다. 저장 자료를 유지합니다. 다시 확인해 주세요.'};
  function isReportPreview(data){
    const info=data?.responseCache,calculation=data?.calculation;
    if(info?.state!=='preview'||info.preview!==true||calculation?.mode!=='saved_only')return false;
    if(calculation.status==='pending')return info.calculationStatus==='pending'&&info.refreshFailed===false
      &&calculation.errorCode===undefined&&calculation.errorMessage===undefined&&info.refreshErrorCode===undefined&&info.refreshErrorMessage===undefined;
    return calculation.status==='failed'&&info.calculationStatus==='failed'&&info.refreshFailed===true&&info.refreshing===false
      &&Object.hasOwn(previewErrors,calculation.errorCode)&&calculation.errorMessage===previewErrors[calculation.errorCode]
      &&info.refreshErrorCode===calculation.errorCode&&info.refreshErrorMessage===calculation.errorMessage;
  }
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
      const storedPartial=info.state==='partial'&&info.partial===true&&data.mode==='current_briefing'&&data.dataQuality?.status==='partial';
      const storedPreview=data.mode==='current_briefing'&&isReportPreview(data);
      if(timestamp(info.checkedAt)!==stamp||info.state!=='cached'&&!storedPartial&&!storedPreview||info.revalidationRequired!==true||!Number.isFinite(until)||until<=now||until<=stamp||until>stamp+PERSISTED_MAX_AGE)return null;
      return {checkedAt:stamp,validUntil:until,persisted:true};
    }
    return now-stamp<=CACHE_MAX_AGE?{checkedAt:stamp,validUntil:stamp+CACHE_MAX_AGE,persisted:false}:null;
  }
  function previousNotice(entry,message='이전 저장 자료 표시 · 최신 자료 확인 중'){
    return entry?.persisted&&Date.now()-entry.checkedAt>CACHE_MAX_AGE?`${message} · 마지막 확인 ${time(new Date(entry.checkedAt).toISOString())}`:message;
  }
  function clearTimers(){if(pollTimer!==null)clearTimeout(pollTimer);if(refreshTimer!==null)clearTimeout(refreshTimer);pollTimer=refreshTimer=null;}
  function clearReports(){reportGeneration++;reports.clear();reportPreviews.clear();reportRequests.clear();deniedReports.clear();}
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
  const validDay=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const shiftDay=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  function reportSelection(input={},fallback='upcoming30'){
    const stayMode=input.stayMode||fallback;
    if(!['all_available','month','upcoming30','custom'].includes(stayMode))return null;
    const selection={stayMode,month:null,start:null,end:null};
    if(stayMode==='month'){if(!validMonth(input.month))return null;selection.month=input.month;}
    if(stayMode==='custom'){if(!validDay(input.start)||!validDay(input.end)||input.start>input.end)return null;selection.start=input.start;selection.end=input.end;}
    return selection;
  }
  function restoreReportSelection(){
    try{if(!window.location?.href)return null;const query=new URL(window.location.href).searchParams,keys={stayMode:'briefingStayMode',month:'briefingMonth',start:'briefingStart',end:'briefingEnd'},input={};for(const [field,key] of Object.entries(keys)){if(query.getAll(key).length>1)return null;if(query.has(key))input[field]=query.get(key);}return input.stayMode?reportSelection(input,'all_available'):null;}catch{return null;}
  }
  function persistReportSelection(){
    try{if(!reportScope||!window.location?.href||!window.history?.replaceState)return;const url=new URL(window.location.href),keys={stayMode:'briefingStayMode',month:'briefingMonth',start:'briefingStart',end:'briefingEnd'};for(const [field,key] of Object.entries(keys)){url.searchParams.delete(key);if(reportViewSelection[field])url.searchParams.set(key,reportViewSelection[field]);}window.history.replaceState(null,'',url.pathname+url.search+url.hash);}catch{}
  }
  function reportPeriod(selection=reportSelection()){
    if(!selection)return null;
    let start=null,end=null;
    if(selection.stayMode==='upcoming30'){start=today();end=shiftDay(start,29);}
    else if(selection.stayMode==='month'){start=selection.month+'-01';const [year,month]=selection.month.split('-').map(Number);end=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);}
    else if(selection.stayMode==='custom'){start=selection.start;end=selection.end;}
    return {start,end,days:start?Math.round((Date.parse(end)-Date.parse(start))/86400000)+1:0,selection,asOf:today()};
  }
  const periodSelection=period=>period?.selection||reportSelection();
  const reportKey=(ownId,period)=>JSON.stringify([reportScope,reportPermission,ownId,periodSelection(period),period.asOf||today()]);
  const periodCurrent=period=>(period.asOf||today())===today();
  const reportAllowed=ownId=>Boolean(reportScope)&&(ownId===''||reportOwnIds.includes(ownId));
  function configureReports({scope='',ownIds=[],companyIds=[],regionKeys=[],permissionVersion='',onSessionExpired:expired=null}={}){
    const next=typeof scope==='string'?scope:'',owns=Array.isArray(ownIds)?[...new Set(ownIds.filter(id=>typeof id==='string'&&id))]:[];
    const companies=Array.isArray(companyIds)?companyIds.filter(id=>typeof id==='string'&&id):[],regions=Array.isArray(regionKeys)?regionKeys.filter(id=>typeof id==='string'&&id):[];
    const permission=JSON.stringify([permissionVersion,owns,[...new Set(companies)].sort(),[...new Set(regions)].sort()]);
    if(next!==reportScope||permission!==reportPermission){if(next!==reportScope)reportViewSelection=restoreReportSelection(next,permission)||{stayMode:'all_available',month:null,start:null,end:null};clearReports();if(kind==='reports'){seq++;renderedVersion=null;clearTimers();const slot=document.querySelector('#analysis-output');if(slot)slot.innerHTML='<p class="empty-note">등록 상태를 확인하고 있습니다.</p>';freshness('');}}
    reportScope=next;reportPermission=permission;reportOwnIds=owns;reportCompanies=new Set(companies);reportRegions=new Set(regions);
    if(typeof expired==='function')onSessionExpired=expired;
  }
  function reportScopeValid(data,ownId,period){
    const expected=ownId||reportOwnIds[0]||null;
    if(!reportAllowed(ownId)||!data||data.mode!=='current_briefing'||data.published!==false||data.ownId!==expected||!periodCurrent(period))return false;
    const selection=periodSelection(period),received=data.selection?reportSelection(data.selection):reportSelection();
    if(!received||JSON.stringify(received)!==JSON.stringify(selection))return false;
    const range=data.period;
    if(!range||!(range.start===null&&range.end===null&&range.days===0||validDay(range.start)&&validDay(range.end)&&range.start<=range.end&&range.days===Math.round((Date.parse(range.end)-Date.parse(range.start))/86400000)+1))return false;
    if(selection.stayMode!=='all_available'&&(range.start!==period.start||range.end!==period.end||range.days!==period.days))return false;
    const generated=timestamp(data.generatedAt);if(!Number.isFinite(generated)||generated>Date.now()+CLOCK_SKEW)return false;
    if(!['companies','comparisons','regions','actions','definitions'].every(key=>Array.isArray(data[key])))return false;
    if(data.companies.some(company=>!reportCompanies.has(company?.companyId)||!['own','competitor'].includes(company.kind)||!company.summary||typeof company.summary!=='object'))return false;
    const own=data.companies.filter(company=>company.kind==='own');
    if(expected?(own.length!==1||own[0].companyId!==expected):own.length!==0)return false;
    if(new Set(data.companies.map(company=>company.companyId)).size!==data.companies.length)return false;
    if(data.comparisons.some(company=>!reportCompanies.has(company?.companyId)||!company.own||!company.competitor))return false;
    return !data.regions.some(region=>!reportRegions.has(region?.region?.id)||!Array.isArray(region.sources));
  }
  function reportCached(ownId,period,storage=reports){
    const key=reportKey(ownId,period),entry=storage.get(key);
    if(!entry||!reportAllowed(ownId)||deniedReports.has(ownId))return null;
    if(Date.now()>=entry.validUntil||!reportScopeValid(entry.data,ownId,period)){storage.delete(key);return null;}
    storage.delete(key);storage.set(key,entry);return entry;
  }
  function rememberReport(ownId,period,data,{requestOrder=0}={}){
    if(!reportScopeValid(data,ownId,period))throw Error('선택한 내 매장·숙박기간과 리포트가 다릅니다.');
    const preview=isReportPreview(data);
    if((data.responseCache?.state==='preview'||data.responseCache?.preview===true||data.calculation?.mode==='saved_only')&&!preview)throw Error('저장 자료 미리보기의 계산 상태를 확인하지 못했습니다.');
    const saved=clone(data),checked=timestamp(saved.responseCache?.checkedAt||saved.generatedAt),age=lifetime(saved,checked);
    if(!age)throw Error('저장 리포트의 확인 시각과 유효기간을 다시 확인해 주세요.');
    const entry={ownId,period:{...period},data:saved,version:reportVersion(saved),requestOrder,...age},key=reportKey(ownId,period);
    const storage=preview?reportPreviews:reports;
    deniedReports.delete(ownId);storage.delete(key);storage.set(key,entry);while(storage.size>CACHE_LIMIT)storage.delete(storage.keys().next().value);if(!preview)reportPreviews.delete(key);return entry;
  }
  function restoreReports(views,scope){
    if(!scope||scope!==reportScope||!Array.isArray(views))return;
    for(const row of views.slice(0,CACHE_LIMIT*2).sort((a,b)=>Date.parse(b?.data?.responseCache?.checkedAt)-Date.parse(a?.data?.responseCache?.checkedAt))){
      const ownId=row?.ownId,selection=reportSelection(row?.selection||row?.data?.selection||{}),period=reportPeriod(selection);
      if(!period||typeof ownId!=='string'||!reportAllowed(ownId)||deniedReports.has(ownId)||!row.period||row.period.start!==row.data?.period?.start||row.period.end!==row.data?.period?.end||row.period.days!==row.data?.period?.days||reportCached(ownId,period))continue;
      if(reports.size>=CACHE_LIMIT)break;
      try{rememberReport(ownId,period,row.data);}catch{}
    }
  }
  function readReport(ownId,period,request,force){
    const key=reportKey(ownId,period)+(force?':refresh':'');let pending=reportRequests.get(key);
    if(!pending){
      const scope=reportScope,permission=reportPermission,generation=reportGeneration,requestOrder=++reportRequestSequence;
      const selection=periodSelection(period),query=Object.entries({...(ownId?{ownId}:{}),stayMode:selection.stayMode,...(selection.month?{month:selection.month}:{}),...(selection.start?{start:selection.start,end:selection.end}:{})}).map(([key,value])=>encodeURIComponent(key)+'='+encodeURIComponent(value)).join('&');
      let source;try{source=Promise.resolve(request('/reports/briefing?'+query,undefined,{refresh:force}));}catch(error){source=Promise.reject(error);}
      const promise=source.then(data=>{
        if(scope!==reportScope||permission!==reportPermission||generation!==reportGeneration||!reportAllowed(ownId)||!periodCurrent(period))throw Object.assign(new Error('업체·권한·숙박기간이 변경되어 이전 응답을 사용하지 않았습니다.'),{status:409,code:'REPORT_SELECTION_CHANGED'});
        const normal=reportCached(ownId,period),preview=reportCached(ownId,period,reportPreviews),incomingPreview=isReportPreview(data);
        // Orders belong to actual network reads, not to later views joining a
        // singleflight. Older completion cannot overwrite a newer normal result.
        // A newer preview must still never suppress a completed normal result.
        if(normal?.requestOrder>requestOrder)return clone(normal.data);
        if(incomingPreview&&preview?.requestOrder>requestOrder)return clone((normal||preview).data);
        return clone(rememberReport(ownId,period,data,{requestOrder}).data);
      });
      pending={promise};reportRequests.set(key,pending);const cleanup=()=>{if(reportRequests.get(key)===pending)reportRequests.delete(key);};promise.then(cleanup,cleanup);
    }
    return pending.promise;
  }
  function peekCurrentBriefing(ownId=''){
    if(typeof ownId!=='string'||!reportAllowed(ownId))return null;
    const period=reportPeriod(),entry=reportCached(ownId,period)||reportCached(ownId,period,reportPreviews);
    return entry?clone(entry.data):null;
  }
  async function readCurrentBriefing(ownId='',request,{force=false}={}){
    const failure=(status,code,message)=>Object.assign(new Error(message),{status,code});
    if(typeof ownId!=='string'||!reportAllowed(ownId))throw failure(403,'REPORT_ACCESS_REQUIRED','내 매장 등록과 비교 자료 조회 권한을 다시 확인해 주세요.');
    if(typeof request!=='function')throw failure(400,'REPORT_READER_REQUIRED','저장 자료 조회 연결을 확인해 주세요.');
    const period=reportPeriod(),scope=reportScope,permission=reportPermission,generation=reportGeneration;
    const authorized=()=>scope===reportScope&&permission===reportPermission&&generation===reportGeneration&&reportAllowed(ownId);
    const stale=()=>failure(409,'REPORT_SELECTION_CHANGED','업체·권한·숙박기간이 변경되어 이전 응답을 사용하지 않았습니다.');
    try{
      const data=await readReport(ownId,period,request,force||deniedReports.has(ownId));
      if(!authorized()||!periodCurrent(period))throw stale();
      return clone(data);
    }catch(error){
      if(!authorized()||!periodCurrent(period))throw stale();
      if(error.status===401)expireSession(false);
      else if([403,404,409].includes(error.status)){clearReports();deniedReports.add(ownId);}
      throw error;
    }
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
      const base=detail.dataset?.briefingWeek?'week:'+detail.dataset.briefingWeek:source?'source:'+source:'note:'+(detail.querySelector?.('summary')?.textContent||'');
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
  function expireSession(displayNotice=true){
    window.InsightArchives?.stop();
    clearCache();cacheScope='';allowedRegions=new Set();seq++;regionData=null;renderedVersion=null;clearTimers();
    reportScope='';reportPermission='';reportOwnIds=[];reportCompanies.clear();reportRegions.clear();
    if(displayNotice){const slot=document.querySelector('#analysis-output');if(slot)slot.innerHTML='<p class="collection-warning">로그인이 만료되었습니다. 다시 로그인해 주세요.</p>';freshness('');}
    if(onSessionExpired)onSessionExpired();
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
  function reportControls(){
    const s=reportViewSelection;
    return `<label class="field"><span>숙박기간</span><select name="stayMode" data-briefing-period>${[['all_available','자료 있는 전체'],['month','월별'],['upcoming30','오늘부터 30일'],['custom','직접 선택']].map(([value,label])=>`<option value="${value}"${s.stayMode===value?' selected':''}>${label}</option>`).join('')}</select></label><label class="field" data-briefing-field="month"${s.stayMode==='month'?'':' hidden'}><span>숙박월</span><input type="month" name="month" min="2017-12" max="2099-12" value="${esc(s.month||today().slice(0,7))}"${s.stayMode==='month'?' required':' disabled'}></label><label class="field" data-briefing-field="custom"${s.stayMode==='custom'?'':' hidden'}><span>숙박 시작일</span><input type="date" name="start" min="2017-12-01" max="2099-12-31" value="${esc(s.start||today())}"${s.stayMode==='custom'?' required':' disabled'}></label><label class="field" data-briefing-field="custom"${s.stayMode==='custom'?'':' hidden'}><span>숙박 종료일</span><input type="date" name="end" min="2017-12-01" max="2099-12-31" value="${esc(s.end||shiftDay(today(),29))}"${s.stayMode==='custom'?' required':' disabled'}></label><p class="muted briefing-period-note">숙박일 기준으로 업체마다 한 번씩 합산합니다. 지역 지표는 각 통계의 실제 공표기간을 표시합니다.</p>`;
  }
  function syncReportControls(form){
    const mode=form?.querySelector?.('[name="stayMode"]')?.value;
    if(!['all_available','month','upcoming30','custom'].includes(mode))return;
    for(const field of form.querySelectorAll?.('[data-briefing-field]')||[]){const active=field.dataset.briefingField===mode;field.hidden=!active;for(const input of field.querySelectorAll?.('input')||[]){input.disabled=!active;input.required=active;}}
  }
  function panel(mode,s,selectedRegion=null,selectedOwnId=null) {
    const own=s.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>s.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const choices=mode==='regions'?s.regions:own;
    const selection=mode==='regions'?regionSelection(s,selectedRegion,selectedOwnId):null;
    return `<section class="card analysis-intro"><span class="eyebrow">${mode==='regions'?'REGIONAL CONTEXT':'SITUATION → NEXT ACTION'}</span><h2>${mode==='regions'?'지역의 12개월 흐름':'현재 상황과 다음 행동'}</h2><p class="muted">${mode==='regions'?'등록한 관심지역과 매장 소재지의 방문·체류·소비·검색 관심 변화를 확인합니다.':'내 매장·등록 경쟁업체·지역 배경을 함께 확인합니다. 저장 자료로 보는 현재 상황 브리핑입니다.'}</p><form id="analysis-form" data-analysis-form><div class="form-grid"><label class="field"><span>${mode==='regions'?'분석 지역':'기준 내 매장'}</span><select name="${mode==='regions'?'regionKey':'ownId'}" ${!choices.length?'disabled':''}>${selection&&!selection.id?'<option value="" selected disabled>지역 연결 확인 필요</option>':''}${choices.map(c=>`<option value="${esc(c.id||c.companyId)}"${selection?.id===(c.id||c.companyId)?' selected':''}>${esc(c.label||c.name)}</option>`).join('')||'<option>등록 대기</option>'}</select></label>${mode==='regions'?`<label class="field"><span>마지막 기준월</span><input name="month" type="month" min="2017-12" max="${prior()}" value="${prior()}" required></label>`:reportControls()}</div><button class="button" type="submit" ${mode==='regions'&&!selection.id?'disabled':''}>저장 자료 확인</button></form></section><p id="analysis-freshness" class="muted connection-check" role="status" aria-live="polite" hidden></p><section id="analysis-output" aria-live="polite"><p class="empty-note">${esc(selection?.message||'저장 자료를 불러오고 있습니다.')}</p></section>${mode==='reports'&&window.InsightArchives?window.InsightArchives.panel(s,selectedOwnId):''}`;
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
  function reportIssues(r) {
    const listed=Array.isArray(r.dataQuality?.issues)?r.dataQuality.issues:[];
    const companies=new Map(r.companies.map(c=>[c.companyId,c])),regions=new Map(r.regions.map(g=>[g.region.id,g]));
    const issues=listed.filter(issue=>issue&&(
      issue.scope==='company'&&companies.has(issue.companyId)||issue.scope==='region'&&regions.has(issue.regionId)
    ));
    if(!listed.length)for(const c of r.companies)if(c.unavailable)issues.push({scope:'company',companyId:c.companyId,name:c.name,period:r.period,reason:'이 기간의 저장 자료를 확인하지 못했습니다.'});
    const partial=issues.length||r.dataQuality?.status==='partial'||r.responseCache?.partial===true;
    if(!partial)return '';
    const period=issue=>{
      const p=issue.period;
      if(/^\d{4}-\d{2}-\d{2}$/.test(p?.start||'')&&/^\d{4}-\d{2}-\d{2}$/.test(p?.end||''))return `${p.start} ~ ${p.end}`;
      return validMonth(issue.month)?issue.month:`${r.period.start} ~ ${r.period.end}`;
    };
    const referencePeriod=issue=>{
      const p=issue.period,start=validDay(p?.start)?p.start:validMonth(issue.month)?issue.month+'-01':null;
      const end=validDay(p?.end)?p.end:validMonth(issue.month)?issue.month+'-31':null;
      return start&&end&&validDay(r.period?.start)&&validDay(r.period?.end)&&(end<r.period.start||start>r.period.end);
    };
    return `<section class="card report-source-issues" aria-label="자료 확인이 필요한 부분"><div class="analysis-card-top"><h2>자료 확인이 필요한 부분</h2><span class="status-pill pending">일부 자료</span></div><p class="muted">확인된 자료는 아래에 표시합니다. 미확인 값은 0으로 처리하지 않습니다.</p>${issues.length?`<div class="collection-table-wrap"><table><thead><tr><th>업체·지역</th><th>확인하지 못한 기간</th><th>사유</th></tr></thead><tbody>${issues.map(issue=>`<tr><th>${esc(issue.scope==='company'?companies.get(issue.companyId).name:regions.get(issue.regionId).region.label)}${issue.sourceName?`<br><small class="muted">${esc(issue.sourceName)}</small>`:''}</th><td>${esc(period(issue))}${referencePeriod(issue)?'<small class="briefing-reference-period">참고기간 · 선택 숙박일 범위 밖</small>':''}</td><td>${esc(issue.reason||'저장 자료를 확인하지 못했습니다.')}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">일부 원자료를 확인하지 못했습니다. 확인된 업체·기간의 자료만 표시합니다.</p>'}</section>`;
  }
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const reservationCodes={QUANTITY_MISSING:'관측 자료 없음',QUANTITY_INVALID:'객실 수량 확인 필요',DUPLICATE_STAY_DATE:'중복 날짜 확인 필요',OBSERVATION_AFTER_CUTOFF:'관측 기준일 이후 자료',OBSERVATION_STALE:'관측일 확인 필요',CAPACITY_UNKNOWN:'객실 기준 확인 필요',CAPACITY_CONFLICT:'객실 기준 불일치',REVENUE_PARTIAL:'금액 일부 미확인'};
  const reservationMissingReasons={partial_inventory:'상품 재고 일부 미확인',missing_response:'예약 응답·수량 미확인',run_blocked:'수집 접근 제한',run_failed:'수집 실패',run_interrupted:'수집 중단',legacy_inventory_evidence:'구형 자료의 상품별 근거 확인 필요',post_stay_observation:'숙박일 이후 관측 자료',shared_dayuse_unverified:'데이유즈 공유 수량 확인 부족'};
  function partialConfirmedAmount(value,{daily=false}={}){
    if(!value||!numeric(value.partialConfirmedRevenue)||value.partialConfirmedRevenue<0||daily&&value.quantityStatus==='ready'&&value.missing!==true)return '';
    const days=Number.isInteger(value.partialConfirmedDays)&&value.partialConfirmedDays>0?`${n(value.partialConfirmedDays)}일 · `:'';
    return `<span class="briefing-partial-amount"><span>일부 상품 확인금액</span> <strong>${n(value.partialConfirmedRevenue)}원</strong><small>${days}정상 매출 소계와 별도 · 전체 금액 미확인</small></span>`;
  }
  function partialConfirmedSource(row){
    const evidence=row?.partialRevenueEvidence;
    if(!partialConfirmedAmount(row,{daily:true})||!evidence||evidence.date!==row.date||evidence.amount!==row.partialConfirmedRevenue)return '';
    return `<details class="briefing-partial-source"><summary>저장 근거</summary><small>관측 ${esc(validDay(evidence.collectedDate)?evidence.collectedDate:'확인 전')}<br>수집 번호 ${esc(evidence.runId||'확인 전')}</small></details>`;
  }
  function reservationAmount(summary={}){
    if(numeric(summary.estimatedRevenue)&&summary.revenuePartial!==true)return {label:'추정매출',html:n(summary.estimatedRevenue)+'원',partial:false};
    if(numeric(summary.knownRevenueSubtotal))return {label:'확인된 매출 소계',html:n(summary.knownRevenueSubtotal)+'원',partial:true};
    return {label:'추정매출',html:'미확인',partial:true};
  }
  function reservationQuantity(summary={},key='sold',known='knownSoldSubtotal'){
    if(numeric(summary[key]))return n(summary[key])+'<small> 실·박</small>';
    return numeric(summary[known])?n(summary[known])+'<small> 실·박 확인 · 일부 미확인</small>':'미확인';
  }
  function reservationSummary(summary={},period={}){
    const amount=reservationAmount(summary),days=Number.isInteger(summary.calendarDays)?summary.calendarDays:period.days,observed=Number.isInteger(summary.observedDays)?summary.observedDays:summary.days;
    const missing=Number.isInteger(summary.missingDays)?summary.missingDays:Number.isInteger(days)&&Number.isInteger(observed)?Math.max(0,days-observed):null;
    return `<div class="briefing-period-totals"><div><span>예약 수량</span><strong>${reservationQuantity(summary)}</strong></div><div><span>공개 예약</span><strong class="public-value">${reservationQuantity(summary,'publicBookings','knownPublicBookingsSubtotal')}</strong></div><div><span>타채널 추정</span><strong class="estimated-value">${reservationQuantity(summary,'phoneBookings','knownPhoneBookingsSubtotal')}</strong></div><div><span>${amount.label}</span><strong${amount.partial?' class="briefing-unknown"':''}>${amount.html}</strong></div></div><p class="briefing-period-coverage">수량 확인 ${n(observed)} / ${n(days)}일${missing>0?` <span class="briefing-unknown">· 관측 공백 ${n(missing)}일</span>`:''}${amount.partial?' <span class="briefing-unknown">· 금액 미확인 포함</span>':''}</p>${partialConfirmedAmount(summary)?`<div class="briefing-period-partial">${partialConfirmedAmount(summary)}</div>`:''}`;
  }
  function reservationDaily(rows=[]){
    const seen=new Set();
    return `<div class="collection-table-wrap briefing-daily-wrap"><table><caption>숙박일별 예약·매출</caption><thead><tr><th>숙박일</th><th>공개 예약</th><th>타채널 추정</th><th>예약 합계</th><th>추정매출</th><th>확인 상태</th></tr></thead><tbody>${rows.map(row=>{
      if(!validDay(row?.date)||seen.has(row.date))return '';seen.add(row.date);
      const known=row.quantityStatus==='ready'&&row.missing!==true,amount=known?reservationAmount(row):{html:'미확인',partial:true,label:'추정매출'};
      const count=key=>known&&numeric(row[key])?n(row[key])+'실':'미확인';
      const reasons=Array.isArray(row.codes)?row.codes.map(code=>code==='QUANTITY_MISSING'&&partialConfirmedAmount(row,{daily:true})?'전체 객실 수량 미확인':reservationCodes[code]||'관측 근거 확인 필요'):[];
      if(row.missingReason)reasons.push(reservationMissingReasons[row.missingReason]||'관측 근거 확인 필요');
      const state=!known?(row.quantityStatus==='conflict'?'수량 충돌 · 미확인':partialConfirmedAmount(row,{daily:true})?'일부 상품 확인 · 전체 미확인':'관측 공백 · 미확인'):amount.partial?'수량 확인 · 금액 미확인':'정상 관측';
      return `<tr${known?'':' class="briefing-missing-day"'}><th>${esc(row.date)}<small>${esc(['일','월','화','수','목','금','토'][new Date(row.date+'T00:00:00Z').getUTCDay()])}</small></th><td class="public-value">${count('publicBookings')}</td><td${known&&row.phoneBookings>0?' class="estimated-value"':''}>${count('phoneBookings')}</td><td>${count('sold')}</td><td>${amount.html}${known&&amount.partial&&amount.label==='확인된 매출 소계'?'<small>확인된 소계</small>':''}${partialConfirmedAmount(row,{daily:true})}${partialConfirmedSource(row)}</td><td><span${known&&!amount.partial?'':' class="briefing-unknown"'}>${state}</span>${reasons.length?`<small>${esc([...new Set(reasons)].join(' · '))}</small>`:''}</td></tr>`;
    }).join('')||'<tr><td colspan="6">저장된 날짜별 자료가 없습니다.</td></tr>'}</tbody></table></div>`;
  }
  function reservationCompanyView(company){
    const groups=company.reservationPeriods?.months,seenMonths=new Set(),seenDates=new Set();
    if(!Array.isArray(groups))return '';
    const months=groups.filter(month=>validMonth(month?.month)&&!seenMonths.has(month.month)&&seenMonths.add(month.month));
    return `<article class="briefing-reservation-company" data-briefing-company="${esc(company.companyId)}"><div class="analysis-card-top"><div><span class="status-pill">${company.kind==='own'?'내 매장':'경쟁업체'}</span>${company.sourceStatus&&company.sourceStatus!=='ready'?` <span class="status-pill pending">${company.sourceStatus==='partial'?'일부 기간 확인 필요':'자료 확인 필요'}</span>`:''}<h3>${esc(company.name)}</h3></div><span class="muted">객실 ${numeric(company.rooms)?n(company.rooms)+'실':'미확인'}</span></div>${months.map(month=>{
      const weeks=Array.isArray(month.weeks)?month.weeks:[],seenWeeks=new Set();
      return `<section class="briefing-reservation-month" data-briefing-month="${esc(month.month)}"><div class="briefing-month-heading"><h4>${esc(month.month.replace('-','년 '))}월 합계</h4><span>${esc(month.period?.start||'기간 확인 전')} ~ ${esc(month.period?.end||'기간 확인 전')}</span></div>${reservationSummary(month.summary,month.period)}<div class="briefing-reservation-weeks">${weeks.map(week=>{
        if(!validDay(week?.weekStart)||seenWeeks.has(week.weekStart))return '';seenWeeks.add(week.weekStart);
        const daily=(Array.isArray(week.daily)?week.daily:[]).filter(row=>validDay(row?.date)&&row.date.startsWith(month.month+'-')&&!seenDates.has(row.date)&&seenDates.add(row.date));
        const amount=reservationAmount(week.summary),coverage=week.summary?.missingDays;
        return `<details class="briefing-reservation-week" data-briefing-week="${esc(company.companyId+':'+month.month+':'+week.weekStart)}"><summary><span class="briefing-week-period">${esc(week.period?.start||'기간 확인 전')} ~ ${esc(week.period?.end||'기간 확인 전')}${coverage>0?`<small class="briefing-unknown">관측 공백 ${n(coverage)}일</small>`:''}</span><span class="briefing-week-quantity">예약 ${reservationQuantity(week.summary)}</span><span class="briefing-week-revenue"><small>${amount.label}</small>${amount.html}${partialConfirmedAmount(week.summary)}</span><span class="briefing-week-expand"><span class="briefing-expand-label">펼치기</span><span class="briefing-collapse-label">접기</span><b aria-hidden="true">+</b></span></summary>${reservationDaily(daily)}</details>`;
      }).join('')}</div></section>`;
    }).join('')||'<p class="empty-note">이 업체의 선택 기간에 관측된 자료가 없습니다. 미확인 값을 0으로 합산하지 않습니다.</p>'}<a class="text-link" href="#collection=${encodeURIComponent(company.companyId)}">업체별 원본·통합관측 →</a></article>`;
  }
  function reportView(r) {
    const own=r.companies.find(c=>c.kind==='own'),preview=isReportPreview(r),previewFailed=(r.responseCache?.refreshFailed||r.responseCache?.calculationStatus==='failed')&&r.responseCache?.refreshing!==true;
    // A normalized city/county mapping is authoritative, including an explicit
    // unresolved null. Only older responses without the field use the raw key.
    const ownRegionKey=own&&Object.hasOwn(own,'analysisRegionKey')?own.analysisRegionKey:own?.regionKey;
    return `<section class="briefing-banner"><span class="eyebrow">${preview?(previewFailed?'저장 자료 미리보기 · 계산 확인 필요':'저장 자료 미리보기 · 계산 확인 중'):'현재 상황 브리핑 · 미발행'}</span><h2>${esc(own?.name||'사업 준비')}의 ${preview?'저장 자료':'다음 판단'}</h2><p>${r.period.start?'숙박일 '+esc(r.period.start)+' ~ '+esc(r.period.end):'저장된 관측기간이 없습니다.'}</p><p class="briefing-period-note muted">업체별 수량·금액이며 업체 간 매출은 합산하지 않습니다. 주간을 펼치면 날짜별 근거를 볼 수 있습니다.</p><p class="muted">${preview?'저장 자료 요약 시각':'확인 시각'} ${esc(time(r.generatedAt))}</p></section>${reportIssues(r)}<section class="card"><div class="db-section-heading"><b>1</b><h2>현재 상황</h2></div><div class="briefing-company-grid">${r.companies.map(c=>Array.isArray(c.reservationPeriods?.months)?reservationCompanyView(c):`<article><span class="status-pill">${c.kind==='own'?'내 매장':'경쟁업체'}</span>${c.sourceStatus&&c.sourceStatus!=='ready'?` <span class="status-pill pending">${c.sourceStatus==='partial'?'일부 기간 확인 필요':'자료 확인 필요'}</span>`:''}<h3>${esc(c.name)}</h3><p class="muted">객실 ${c.rooms==null?'미확인':n(c.rooms)+'실'} · 수량 유효 ${n(c.summary.days)}/${n(r.period.days)}일<br>마지막 관측 ${esc(c.lastObservedAt?time(c.lastObservedAt):(c.lastObservedDay||'확인 전'))}</p><dl><div><dt>추정 예약률</dt><dd>${rate(c.summary.reservationRate)}</dd></div><div><dt>공개 예약</dt><dd class="public-value">${c.summary.publicBookings==null?'미확인':n(c.summary.publicBookings)+'실'}</dd></div><div><dt>방막기 추정</dt><dd class="estimated-value">${c.summary.phoneBookings==null?'미확인':n(c.summary.phoneBookings)+'실'}</dd></div><div><dt>추정매출</dt><dd>${c.summary.estimatedRevenue==null?'산출 보류':`${n(c.summary.estimatedRevenue)}원`}</dd></div></dl><p class="muted">${c.unavailable?'자료 연결 확인 필요':'위 수치는 업체별 확보 기간의 요약입니다. 업체 간 비교는 아래 공통 날짜 기준을 확인하세요.'}</p><a class="text-link" href="#collection=${encodeURIComponent(c.companyId)}">근거·수집 결과 확인</a></article>`).join('')||'<p class="empty-note">등록한 업체가 없습니다.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>2</b><h2>경쟁업체와의 차이</h2></div><p class="muted">같은 숙박일과 같은 관측일이 겹치는 자료만 비교합니다. 가격·시설·연휴 등의 원인은 이 차이만으로 확정하지 않습니다.</p><div class="collection-table-wrap"><table><thead><tr><th>경쟁업체</th><th>공통 숙박일</th><th>내 매장 예약률</th><th>경쟁 예약률</th><th>차이</th><th>판단 상태</th></tr></thead><tbody>${preview?'<tr><td colspan="6">리포트 계산 후 같은 날짜 기준으로 비교합니다.</td></tr>':r.comparisons.map(c=>`<tr><th>${esc(c.name)}</th><td>${c.commonDays}일</td><td>${rate(c.own.reservationRate)}</td><td>${rate(c.competitor.reservationRate)}</td><td>${c.gapPp===null?'비교 보류':`${c.gapPp>0?'+':''}${n(c.gapPp)}%p`}</td><td>${c.status==='comparable'?'비교 가능':'표본 부족'}</td></tr>`).join('')||'<tr><td colspan="6">내 매장과 경쟁업체 자료가 필요합니다.</td></tr>'}</tbody></table></div></section><section class="card"><div class="db-section-heading"><b>3</b><h2>지역 수요 배경</h2></div><div class="briefing-region-grid">${r.regions.map(g=>`<article><span class="status-pill">${g.region.id===ownRegionKey?'매장 소재지':'관심지역'}</span><h3>${esc(g.region.label)}</h3><p>${g.window?`최근 12개월 ${esc(g.window.start)} ~ ${esc(g.window.end)}`:`기준월 ${esc(g.month)}`} · 저장 지표 ${g.availableSources}종</p><p class="muted">${esc(g.location?.interpretation||'입지 해석 자료 확인 전')}</p>${trendBrief(g)}<a href="#regions=${encodeURIComponent(g.region.id)}" class="text-link">지역별 지표·출처 확인</a></article>`).join('')||'<p class="empty-note">매장 소재지 또는 관심지역을 연결해 주세요.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>4</b><h2>다음 행동</h2></div><div class="briefing-actions">${preview?'<p class="empty-note" role="status">리포트 계산 후 다음 행동을 확인할 수 있습니다.</p>':r.actions.map((a,i)=>`<article><span class="action-number">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(a.title)}</h3><p>${esc(a.reason)}</p><p class="action-step">${esc(a.next)}</p><p class="muted">실행 후 확인: ${esc(a.check)}</p><small class="muted">근거: ${esc(a.source)}</small></div></article>`).join('')}</div></section><details class="card analysis-notes"><summary>집계 범위와 판단 기준</summary><ul>${r.definitions.map(d=>`<li>${esc(d)}</li>`).join('')}</ul></details>`;
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
    const params=Object.fromEntries(new FormData(form)),ownId=reportOwnIds.length?params.ownId||'':'',selection=reportSelection(params),period=reportPeriod(selection),request=api;
    if(!period){freshness('숙박월 또는 시작일·종료일을 확인해 주세요.');return;}
    if(params.stayMode){reportViewSelection=selection;persistReportSelection();}
    const scope=reportScope,permission=reportPermission,generation=reportGeneration;
    const authorized=()=>scope===reportScope&&permission===reportPermission&&generation===reportGeneration&&reportAllowed(ownId);
    const visible=()=>id===seq&&slot.isConnected&&authorized();
    const button=form.querySelector('button');
    if(!reportAllowed(ownId)){renderedVersion=null;freshness('');button.disabled=true;slot.innerHTML='<p class="collection-warning">내 매장 등록과 리포트 조회 권한을 다시 확인해 주세요.</p>';return;}
    const complete=reportCached(ownId,period),entry=complete||reportCached(ownId,period,reportPreviews);regionData=null;button.disabled=true;
    if(entry){
      if(renderedVersion!==entry.version){drawReport(slot,entry.data);renderedVersion=entry.version;}
      freshness(previousNotice(entry,isReportPreview(entry.data)?'저장 자료 먼저 표시 · 리포트 계산 확인 중':entry.persisted?'이전 저장 리포트 표시 · 최신 자료 확인 중':'이전 조회 리포트 표시 · 최신 자료 확인 중'),'checking');
    }else{renderedVersion=null;freshness('');slot.innerHTML='<p class="empty-note" role="status">업체별 보존 이력을 계산하고 있습니다. 자료량에 따라 최대 3분 정도 걸릴 수 있습니다.</p>';}
    try{
      const data=await readReport(ownId,period,request,force||deniedReports.has(ownId));
      if(!authorized())return;
      if(!periodCurrent(period)){if(visible())void loadReport();return;}
      const fresh=reportCached(ownId,period,isReportPreview(data)?reportPreviews:reports);if(!fresh||!visible())return;
      const preview=isReportPreview(data),latestNormal=reportCached(ownId,period),shown=preview&&latestNormal?latestNormal:fresh;
      if(renderedVersion!==shown.version){drawReport(slot,shown.data,Boolean(entry));renderedVersion=shown.version;}
      const info=data.responseCache||{},sourcePending=data.dataQuality?.issues?.some(issue=>['COMPANY_INTEGRATION_UPDATING','COMPANY_INTEGRATION_PENDING'].includes(issue.code));
      const failed=(info.refreshFailed||info.calculationStatus==='failed')&&info.refreshing!==true,pending=info.refreshing===true||!failed&&(info.revalidationRequired||sourcePending||preview&&info.calculationStatus==='pending'),checking=pending&&backgroundChecks<REPORT_CHECK_DELAYS.length;
      const partial=info.partial===true||data.dataQuality?.status==='partial';
      const failureDetail=typeof info.refreshErrorMessage==='string'?info.refreshErrorMessage.slice(0,300):'리포트 계산을 완료하지 못했습니다.';
      const failureCode=/^[A-Z][A-Z0-9_]{1,99}$/.test(info.refreshErrorCode||'')?` (${info.refreshErrorCode})`:'';
      const message=preview?(failed?`저장 자료 유지 · ${failureDetail}${failureCode} ‘저장 자료 확인’으로 다시 확인해 주세요.`:checking?'저장 자료 먼저 표시 · 리포트 계산 중':'저장 자료 유지 · 리포트 계산에 시간이 걸리고 있습니다. ‘저장 자료 확인’으로 다시 확인할 수 있습니다.'):failed?(partial?'일부 자료 표시 · 최신 리포트 확인에 실패했습니다.':'최신 리포트 확인 지연 · 이전 저장 자료를 표시합니다.'):partial?(checking?'일부 자료 표시 · 최신 자료 확인 중':pending?'일부 자료 표시 · 최신 확인에 시간이 걸리고 있습니다.':'일부 자료 확인 필요 · 정상 자료를 표시합니다.'):checking?'이전 저장 리포트 표시 · 최신 자료 확인 중':pending?'최신 확인에 시간이 걸려 이전 리포트를 표시합니다.':'';
      freshness(message?previousNotice(shown,message):'',checking?'checking':'notice');
      if(checking&&typeof setTimeout==='function')refreshTimer=setTimeout(()=>{refreshTimer=null;if(visible())void loadReport({backgroundChecks:backgroundChecks+1});},REPORT_CHECK_DELAYS[backgroundChecks]);
    }catch(error){
      if(!authorized())return;
      if(!periodCurrent(period)){if(visible())void loadReport();return;}
      if(error.status===401){expireSession();return;}
      if([403,404,409].includes(error.status)){
        const show=visible();clearReports();deniedReports.add(ownId);
        if(show){renderedVersion=null;freshness('');slot.innerHTML='<p class="collection-warning">업체·지역 등록과 리포트 조회 권한을 다시 확인해 주세요.</p>';}
      }else if(visible()){
        if(!periodCurrent(period)){void loadReport();return;}
        if(entry&&Date.now()<entry.validUntil)freshness(previousNotice(entry,isReportPreview(entry.data)?`저장 자료 유지 · ${error.message||'리포트 계산 연결을 확인하지 못했습니다.'} ‘저장 자료 확인’으로 다시 확인해 주세요.`:'최신 리포트 확인 지연 · 이전 저장 자료를 표시합니다.'));
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
        const pending=info.refreshing===true||!info.refreshFailed&&info.revalidationRequired,failed=info.refreshFailed&&info.refreshing!==true,checking=pending&&backgroundChecks<4;
        const message=failed?'최신 자료 확인 지연 · 이전 저장 자료를 표시합니다.':checking?(fresh.persisted?'이전 저장 자료 표시 · 최신 자료 확인 중':'저장 자료 표시 · 최신 자료 확인 중'):pending?'최신 확인에 시간이 걸려 이전 저장 자료를 표시합니다.':'';
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
  document.addEventListener('submit',e=>{if(e.target.id!=='analysis-form')return;e.preventDefault();e.stopImmediatePropagation();load({force:kind==='reports'});});
  document.addEventListener('change',e=>{if(e.target.matches?.('[data-history-metric]')&&regionData){const card=e.target.closest('[data-history-source]'),s=regionData.sources.find(s=>s.key===card.dataset.historySource);if(s)card.outerHTML=window.InsightRegionHistory.source(s,regionData.window,e.target.value);return;}if(e.target.closest?.('#analysis-form')){if(kind==='reports')syncReportControls(document.querySelector('#analysis-form'));load();}});
  window.InsightAnalysis={panel,regionView,reportView,configureCache,configureReports,restore,restoreReports,peekCurrentBriefing,readCurrentBriefing,clearCache,invalidate,mount(mode,request,s,selectedRegion=null,selectedOwnId=null){kind=mode;api=request;renderedVersion=null;
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
    if(mode==='reports')window.InsightArchives?.mount(request,{onSessionExpired:expireSession});
    load();},stop(){window.InsightArchives?.stop();seq++;regionData=null;renderedVersion=null;clearTimers();}};
})();
