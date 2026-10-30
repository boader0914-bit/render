(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightComparisonView=api;
})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const rate=v=>numeric(v)?`${(v*100).toFixed(1)}%`:'산출 보류';
  const money=v=>numeric(v)?`${(v/10000).toLocaleString('ko-KR',{maximumFractionDigits:1})}만원`:'금액 미확인';
  const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'시각 미확인';
  const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const relation=v=>({same:'같은 지역',cross:'다른 지역',unknown:'지역 확인 필요'})[v]||'이전 비교 기준';
  const exactCurrent=s=>s?.stayMode==='upcoming30'&&s.stayStart===today()&&s.asOfDate===today();
  const companyLink=id=>`#company=${encodeURIComponent(id)}`;
  function dashboardApi(){return typeof window!=='undefined'?window.InsightComparisonDashboard:typeof require==='function'?require('./comparison-dashboard.js'):null;}
  function dashboardView(){return typeof window!=='undefined'?window.InsightComparisonDashboardView:typeof require==='function'?require('./comparison-dashboard-view.js'):null;}
  let dashboardState=null;
  const dashboardStorageKey='insight:competition-dashboard:v1';
  function dashboardContext(s){return JSON.stringify([operatingScope(),active?.store.requestToken().partition,s.ownCompanyId,s.comparisonIds.slice().sort(),s.stayStart,s.stayEnd,s.asOfDate]);}
  function filtersFor(s){
    const defaults={start:s.stayStart,end:s.stayEnd,dayFilter:'all'};
    if(!active)return defaults;
    const key=dashboardContext(s);
    if(dashboardState?.key===key)return dashboardState.filters;
    let filters=defaults;
    try{const saved=JSON.parse(sessionStorage.getItem(dashboardStorageKey)||'null');if(saved?.key===key&&dashboardApi()?.normalizeFilters({period:{start:s.stayStart,end:s.stayEnd}},saved.filters).valid)filters=saved.filters;}catch{/* Optional view preferences cannot block saved data. */}
    dashboardState={key,filters};return filters;
  }
  function setFilters(s,filters){
    const normalized=dashboardApi()?.normalizeFilters({period:{start:s.stayStart,end:s.stayEnd}},filters);
    if(!normalized?.valid)return false;
    dashboardState={key:dashboardContext(s),filters:{start:normalized.start,end:normalized.end,dayFilter:normalized.dayFilter}};
    try{sessionStorage.setItem(dashboardStorageKey,JSON.stringify(dashboardState));}catch{/* No persistence is required to use a filter. */}
    return true;
  }
  function dashboardModel(r,s,catalog){return dashboardApi()?.project(r,s,catalog,filtersFor(s),active?.savedSourceState?.key===dashboardContext(s)?active.savedSourceState.companies:{});}
  function savedMonths(s){
    const start=s.stayStart?.slice(0,7),end=s.stayEnd?.slice(0,7);
    return /^20\d{2}-(0[1-9]|1[0-2])$/.test(start||'')&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(end||'')?[...new Set([start,end])]:[];
  }
  function loadSavedSources(options,s,force=false){
    if(typeof options.readCompany!=='function')return;
    const key=dashboardContext(s);
    if(options.savedSourceState?.key===key&&!force)return;
    const source={key,companies:{},cancelled:false,timers:[]},ids=[s.ownCompanyId,...s.comparisonIds],months=savedMonths(s);
    if(options.savedSourceState){options.savedSourceState.cancelled=true;for(const value of options.savedSourceState.timers||[])clearTimeout(value);}
    options.savedSourceState=source;
    const current=()=>active===options&&!source.cancelled&&dashboardContext(options.store.getState())===key;
    const redraw=()=>{
      if(!current())return;
      const report=options.lastRenderedReport,slot=document.querySelector('#comparison-results');
      if(slot?.isConnected&&report&&matching(report,options.store.getState()))drawResults(slot,render(report,options.store.getState(),options.state.companies,focusId),report);
    };
    for(const id of ids){
      const payloads=months.map(month=>options.peekCompany?.(id,month)).filter(Boolean);
      source.companies[id]={payloads,status:'loading',months:{}};
    }
    // These are the existing authorized, cached company reads. They are never
    // a crawl request. One read at a time avoids a new burst of heavy reads.
    const jobs=ids.flatMap(id=>months.map(month=>({id,month})));
    const readJobs=async(jobs,attempt=0)=>{
      const pending=[];
      for(const {id,month} of jobs){
        if(!current())return;
        const entry=source.companies[id];
        if(entry.denied)continue;
        try{
          const data=await options.readCompany(id,{month,force:force&&attempt===0});
          if(!current())return;
          entry.months[month]=data;
          entry.payloads=months.map(value=>entry.months[value]||options.peekCompany?.(id,value)).filter(Boolean);
          entry.status='ready';
          if(data.responseCache?.refreshing===true||data.responseCache?.revalidationRequired===true||data.referenceLoading===true)pending.push({id,month});
        }catch(error){
          if(!current())return;
          entry.status='failed';entry.errorCode=[401,403,404,409].includes(error?.status)?'SOURCE_CONTEXT_MISMATCH':'SOURCE_READ_FAILED';
          if([401,403,404,409].includes(error?.status)){
            entry.denied=true;entry.months={};entry.payloads=[];redraw();
            if(error.status===401){source.cancelled=true;options.onSessionExpired?.();return;}
            continue;
          }
        }
        redraw();
      }
      if(current()&&pending.length&&attempt<6)source.timers.push(setTimeout(()=>{if(current())void readJobs(pending,attempt+1);},[2000,4000,8000,16000,30000,45000][attempt]));
    };
    void readJobs(jobs);
  }
  function readiness(report,selection){
    const view=typeof window!=='undefined'?window.InsightComparisonReadinessView:typeof require==='function'?require('./comparison-readiness-view.js'):null;
    return view?.render?.(report,selection)||'';
  }
  function evidenceModel(report,selection){
    const view=typeof window!=='undefined'?window.InsightComparisonReadinessView:typeof require==='function'?require('./comparison-readiness-view.js'):null;
    return view?.project?.(report,selection);
  }
  function savedAvailability(company){
    const partial=company?.partialRevenue,stored=company?.storedReference;
    return `${partial?.days>0?`<span class="is-partial">부분 상품 금액 ${n(partial.days)}일 · ${money(partial.amount)} <small>정상 소계와 별도</small></span>`:''}${stored?.days>0?`<span class="is-stored">오래된 저장 수량 ${n(stored.days)}일 <small>현재 비교에서 제외</small></span>`:''}`;
  }
  function operatingView(){
    if(typeof window!=='undefined')return window.InsightCustomerOperatingActionsView;
    if(typeof require==='function'){try{return require('./customer-operating-actions-view.js');}catch{return null;}}
    return null;
  }
  function operatingScope(){
    const customer=active?.state?.customer;
    return customer?JSON.stringify([customer.customerId||customer.username||'',customer.revision,customer.relations]):'';
  }
  function drawResults(slot,html,report){
    const open=slot.querySelector?.('[data-readiness-details="evidence"]')?.open===true;
    const disclosed=[...(slot.querySelectorAll?.('[data-dashboard-detail][open]')||[])].map(node=>node.dataset.dashboardDetail);
    slot.innerHTML=html;
    const evidence=slot.querySelector?.('[data-readiness-details="evidence"]');
    if(open&&evidence)evidence.open=true;
    for(const name of disclosed){const detail=slot.querySelector?.(`[data-dashboard-detail="${name}"]`);if(detail)detail.open=true;}
    const options=active;
    if(options)options.lastRenderedReport=report;
    const operatingToken=options?.store.requestToken();
    const s=options?.store.getState(),filterToken=s?JSON.stringify(filtersFor(s)):'',model=s&&report?dashboardModel(report,s,options.state.companies):null;
    if(options&&report&&matching(report,s))operatingView()?.mount({report,selection:s,catalog:options.state.companies,scope:operatingScope()+filterToken,displayDates:model?.dates,displayPeriod:model?.period,displayComparisonActionable:model?.quality?.actionable,displayHoldReason:model?.judgments?.[0]?.reason,isCurrent:()=>active===options&&slot.isConnected&&options.store.isCurrent(operatingToken)&&JSON.stringify(filtersFor(options.store.getState()))===filterToken});
    else operatingView()?.stop();
  }
  const isNew=c=>c?.rulesVersion==='insight-comparison-v1';
  const selected=(r,s)=>r.comparisons.filter(c=>s.comparisonIds.includes(c.companyId));
  function matching(r,s){return Boolean(r&&r.mode==='current_briefing'&&r.ownId===s.ownCompanyId&&r.period?.start===s.stayStart&&r.period?.end===s.stayEnd&&exactCurrent(s));}
  function reasonList(c){
    if(!isNew(c))return '<li>이전 비교 기준의 참고자료입니다. 최신 확인 후 지역·업종·품질 근거를 표시합니다.</li>';
    const quantity=c.quality.quantity,dates=[...new Set([...quantity.ownExcludedDates,...quantity.competitorExcludedDates].map(d=>d.date))];
    return c.reasons.map(row=>`<li>${esc(row.reason)}</li>`).join('')+
      (dates.length?`<li>수량 비교 제외 날짜: ${dates.map(esc).join(', ')}</li>`:'')+
      (c.quality.revenue.unknownDates.length?`<li>금액 미확인 날짜: ${c.quality.revenue.unknownDates.map(esc).join(', ')}</li>`:'')+
      `<li>실제 관측시차: ${c.quality.timing.maximumObservedSkewMs===null?'시각 확인 필요':n(c.quality.timing.maximumObservedSkewMs/60000)+'분'} · 자동 판단 시차 기준 ${c.quality.timing.policy.confirmed?'확정':'미확정'}</li>`;
  }
  function card(c,comparison,own,evidence){
    const tags=own?comparison?.industry?.ownIndustryKeys:comparison?.industry?.competitorIndustryKeys,labels={glamping:'글램핑',campground:'캠핑',caravan:'카라반',pension:'펜션',poolVilla:'풀빌라',privateStay:'독채',hotelResort:'호텔·리조트',motel:'모텔'},industry=Array.isArray(tags)&&tags.length?tags.map(key=>labels[key]||key).join('·'):'업종 확인 필요';
    const summary=c.summary||{},role=own?'내 매장':isNew(comparison)&&comparison.purpose==='direct'?'직접 경쟁':'운영 참고';
    const supplemental=savedAvailability(evidence);
    return `<article class="comparison-summary ${own?'is-own':''}"><div class="comparison-card-top"><span>${own?'분석 기준':relation(comparison?.regionRelation)}</span><span class="status-pill">${role}</span></div><h3><a href="${companyLink(c.companyId)}">${esc(c.name)}</a></h3><p class="muted">${esc(c.regionLabel||'지역 확인 필요')} · ${esc(industry)} · 객실 ${numeric(c.rooms)?n(c.rooms)+'실':'미확인'} · 유효 ${n(summary.days)}일</p><span class="comparison-metric-label">추정 예약률</span><strong class="comparison-rate">${rate(summary.reservationRate)}</strong><p>예약 ${n(summary.sold)} / 공급 ${n(summary.supply)} 실</p>${supplemental?`<p class="comparison-saved-availability">${supplemental}</p>`:''}<p class="comparison-card-foot">${own?esc(c.roomCountSource||'현재 업체 DB 기준'):isNew(comparison)?comparison.actionable?'같은 조건 비교':comparison.comparable?'수치 참고':'비교 보류':'이전 기준 참고'} · <a href="${companyLink(c.companyId)}">업체자료 보기</a></p></article>`;
  }
  function summaryGroups(own,others,comparisons,model){
    const find=c=>model?.companies.find(row=>row.companyId===c.companyId);
    const group=(title,rows,description='')=>rows.length?`<section style="--comparison-group-size:${rows.length}"><h2>${title}${description?`<small>${description}</small>`:''}</h2><div class="comparison-summary-grid">${rows.map(c=>card(c,comparisons.find(p=>p.companyId===c.companyId),false,find(c))).join('')}</div></section>`:'';
    return `<div class="comparison-summary-groups"><section style="--comparison-group-size:1"><h2>내 매장 <small>분석 기준</small></h2><div class="comparison-summary-grid">${card(own,comparisons[0],true,find(own))}</div></section>${group('같은 지역',others.filter(c=>comparisons.find(p=>p.companyId===c.companyId)?.regionRelation==='same'),'공통 숙박일 비교')}${group('다른 지역',others.filter(c=>comparisons.find(p=>p.companyId===c.companyId)?.regionRelation==='cross'),'상품·운영 참고')}${group('지역 확인 필요',others.filter(c=>!['same','cross'].includes(comparisons.find(p=>p.companyId===c.companyId)?.regionRelation)),'지역 차이 판단 보류')}</div>`;
  }
  function pairTable(r,s){
    const rows=selected(r,s);
    return `<section class="card comparison-table-card"><div class="comparison-section-title"><h2>공통 날짜 기준 비교</h2><p class="muted">예약률 차이 = 내 매장 − 비교업체 · 같은 숙박일·관측일 기준</p></div><div class="collection-table-wrap"><table><thead><tr><th>업체 / 비교 유형</th><th>공통 날짜</th><th>내 매장</th><th>비교업체</th><th>차이</th><th>확인 금액</th></tr></thead><tbody>${rows.map(c=>`<tr><th><a href="${companyLink(c.companyId)}">${esc(c.name)}</a><small>${relation(c.regionRelation)} · ${isNew(c)&&c.purpose==='direct'?'직접 경쟁':'운영 참고'}</small></th><td>${n(c.commonDays)}일</td><td>${rate(c.own.reservationRate)}</td><td>${rate(c.competitor.reservationRate)}</td><td>${isNew(c)&&!c.comparable||c.gapPp===null?'비교 보류':`${c.gapPp>0?'+':''}${n(c.gapPp)}%p`}${c.regionRelation==='cross'?'<small>지역 차이 미보정</small>':''}</td><td>${money(c.competitor.knownRevenueSubtotal??c.competitor.estimatedRevenue)}<small>${isNew(c)?({ready:'확인됨',partial:'일부 금액 미확인',unavailable:'금액 미확인'})[c.quality.revenue.status]:'이전 기준 참고'}</small></td></tr>`).join('')||'<tr><td colspan="6">비교할 업체를 선택해 주세요.</td></tr>'}</tbody></table></div><p class="muted comparison-footnote">업체별 요약과 공통 날짜 비교의 범위는 다를 수 있습니다. 등록 업체를 지역 전체 평균으로 표시하지 않습니다.</p><details class="comparison-evidence"><summary>계산 근거·제외 사유</summary>${rows.map(c=>`<article><h3>${esc(c.name)}</h3><ul>${reasonList(c)}</ul></article>`).join('')}</details></section>`;
  }
  function chart(c,max,evidence){
    const series=c.reservationSeries,points=series?.points;
    if(!Array.isArray(points)||!points.length)return `<article class="comparison-chart"><h3>${esc(c.name)}</h3><p class="empty-note">이전 저장 자료에는 일별 표시 자료가 없습니다. 최신 확인 후 표시합니다.</p></article>`;
    const left=34,bottom=110,height=84,step=548/points.length,w=Math.min(18,step*.6),percent=v=>(v/600*100)+'%';
    const bars=points.map((d,i)=>{
      const x=left+step*(i+.5),label=d.date.slice(5).replace('-','/');
      const dateLabel=i===0||i===points.length-1||i%7===0&&i<points.length-3?`<text x="${percent(x)}" y="133" text-anchor="middle">${label}</text>`:'';
      if(d.quantityStatus!=='ready'){
        const partial=evidence?.partialRevenue?.rows.find(row=>row.date===d.date),stored=evidence?.storedReference?.rows.find(row=>row.date===d.date);
        const detail=partial?` · 일부 상품 금액(추정 포함) ${money(partial.amount)} · 전체 예약수량 미확인`:stored?` · ${stored.collectedDate} 관측 당시 ${n(stored.sold)}실 · 오래된 참고, 현재 비교 제외`:' · 미확인';
        return `<g class="comparison-missing"><line x1="${percent(x-2)}" x2="${percent(x+2)}" y1="${bottom-5}" y2="${bottom-1}"/><line x1="${percent(x-2)}" x2="${percent(x+2)}" y1="${bottom-1}" y2="${bottom-5}"/><title>${esc(d.date+detail)}</title></g>${dateLabel}`;
      }
      const ph=d.publicBookings/max*height,bh=d.phoneBookings/max*height;
      return `<g><title>${esc(d.date)} · 예약 ${n(d.sold)}실 (공개 ${n(d.publicBookings)} + 타채널 추정 ${n(d.phoneBookings)})${d.reservationRate===null?' · 예약률 보류':' · 예약률 '+rate(d.reservationRate)}${d.inventoryConflict?' · 객실 기준 확인 필요':''}</title>${d.publicBookings>0?`<rect class="comparison-public" x="${percent(x-w/2)}" y="${bottom-ph}" width="${percent(w)}" height="${ph}"/>`:''}${d.phoneBookings>0?`<rect class="comparison-estimate" x="${percent(x-w/2)}" y="${bottom-ph-bh}" width="${percent(w)}" height="${bh}"/>`:''}${d.sold===0?`<circle class="comparison-public" cx="${percent(x)}" cy="${bottom}" r="2"/>`:''}</g>${dateLabel}`;
    }).join('');
    return `<article class="comparison-chart"><header><h3>${esc(c.name)}</h3><span class="muted">${numeric(c.rooms)?n(c.rooms)+'실 기준':'객실 기준 미확인'} · 객실 수</span></header><svg width="100%" height="156" role="img" aria-label="${esc(c.name)} 날짜별 예약 수량. 공개 예약과 타채널 추정을 합산하고 미확인은 0실과 구분합니다."><text x="0" y="${bottom-height+4}">${n(max)}</text><text x="2.5%" y="${bottom+4}">0</text><line class="comparison-grid" x1="5%" x2="99%" y1="${bottom-height}" y2="${bottom-height}"/><line class="comparison-grid" x1="5%" x2="99%" y1="${bottom}" y2="${bottom}"/>${bars}</svg></article>`;
  }
  function flow(r,s,focus){
    const companies=r.companies.filter(c=>c.companyId===s.ownCompanyId||c.companyId===focus),points=companies.flatMap(c=>c.reservationSeries?.points||[]),max=Math.max(1,...companies.map(c=>numeric(c.rooms)?c.rooms:0),...points.filter(d=>d.quantityStatus==='ready').map(d=>d.sold));
    const evidence=evidenceModel(r,s);
    return `<div class="comparison-section-title"><h2>날짜별 예약 흐름</h2><p class="muted">같은 30일·같은 세로축 · 객실 총량과 예약률은 위 요약에서 함께 확인하세요.</p></div><div class="collection-legend"><span class="flow-label-public">● 공개 예약</span><span class="flow-label-estimate">● 타채널 추정</span><span>× 미확인·현재 비교 제외 · ● 정상 0실</span></div>${companies.map(c=>chart(c,max,evidence?.companies.find(row=>row.companyId===c.companyId))).join('')}<p class="muted comparison-footnote">방막기는 타채널 예약 추정입니다. 막대는 각 업체의 유효 관측이며, 비교표는 공통으로 확인된 날짜만 계산합니다. 부분 금액·오래된 참고는 위의 비교 자료 확인에서 별도로 봅니다.</p>`;
  }
  function products(r,s,catalog){
    const companies=r.companies.filter(c=>c.companyId===s.ownCompanyId||s.comparisonIds.includes(c.companyId));
    return `<div class="comparison-section-title"><h2>상품·가격 확인 범위</h2><p class="muted">상품별 판매가격·시설·채널은 업체 DB의 A·B에서 확인합니다.</p></div><div class="collection-table-wrap"><table><thead><tr><th>업체</th><th>객실 기준</th><th>데이유즈</th><th>이 기간의 확인 금액</th><th>기본정보</th></tr></thead><tbody>${companies.map(c=>{const meta=catalog.find(row=>row.companyId===c.companyId)||{};return `<tr><th>${esc(c.name)}</th><td>${n(c.rooms)}실</td><td>${esc({unknown:'미확인',none:'없음',shared:'숙박과 공유',separate:'별도 객실'}[meta.dayUse]||'미확인')}</td><td>${money(c.summary.knownRevenueSubtotal??c.summary.estimatedRevenue)}${c.summary.estimatedRevenue===null?'<small>전체 매출 아님 · 일부 금액 미확인</small>':''}</td><td><a class="text-link" href="${companyLink(c.companyId)}">A·B·C 자료 보기</a></td></tr>`;}).join('')}</tbody></table></div>`;
  }
  function regions(r,s){
    if(typeof window!=='undefined'&&window.InsightRegionalContextView)return '<p id="comparison-regional-status" class="connection-check" role="status" aria-live="polite"></p><div id="comparison-regional-context"></div>';
    const companies=r.companies.filter(c=>c.companyId===s.ownCompanyId||s.comparisonIds.includes(c.companyId)),groups=new Map();
    for(const c of companies){const comparison=r.comparisons.find(row=>isNew(row)&&(row.companyId===c.companyId||c.companyId===r.ownId));const canonical=c.companyId===r.ownId?comparison?.region.ownAnalysisRegionKey:comparison?.region.competitorAnalysisRegionKey;const key=canonical||c.regionKey||'unknown:'+c.companyId;groups.set(key,[...(groups.get(key)||[]),c]);}
    return `<div class="comparison-section-title"><h2>업체별 지역 배경</h2><p class="muted">같은 지역은 한 묶음으로, 다른 지역은 나누어 봅니다.</p></div><div class="comparison-region-grid">${[...groups.entries()].map(([id,list])=>{const region=r.regions.find(row=>row.region.id===id);return `<article><h3>${esc(region?.region.label||[...new Set(list.map(c=>c.regionLabel).filter(Boolean))].join(' / ')||'지역 요약 연결 전')}</h3><p>${list.map(c=>esc(c.name)).join(' · ')}</p>${region?`<p class="muted">${region.window?esc(region.window.start)+' ~ '+esc(region.window.end):esc(region.month)} · 저장 지표 ${n(region.availableSources)}종</p><a class="text-link" href="#regions=${encodeURIComponent(id)}">지역 자료 보기</a>`:'<p class="muted">업체 소재지 참고 요약은 후속 지역 연결 단계에서 제공합니다.</p>'}</article>`;}).join('')}</div><p class="muted comparison-footnote">지역지표의 공표기간은 예약 숙박기간과 다를 수 있습니다. 지역 간 평균·보정 순위를 만들지 않습니다.</p>`;
  }
  function render(r,s,catalog=[],focusId=null){
    if(!matching(r,s))return '<section class="card"><p class="collection-warning">선택한 매장·기간의 자료를 확인하지 못했습니다. 이전 조건의 숫자를 표시하지 않습니다.</p></section>';
    const comparisons=selected(r,s),own=r.companies.find(c=>c.companyId===s.ownCompanyId),others=r.companies.filter(c=>c.kind==='competitor'&&s.comparisonIds.includes(c.companyId));
    if(!own)return '<section class="card"><p class="empty-note">내 매장의 저장 자료가 없습니다. 업체 DB의 확보 범위를 확인해 주세요.</p></section>';
    const same=comparisons.filter(c=>c.regionRelation==='same').length,cross=comparisons.filter(c=>c.regionRelation==='cross').length;
    const focus=others.some(c=>c.companyId===focusId)?focusId:others[0]?.companyId;
    const partial=r.dataQuality?.status==='partial'||r.responseCache?.partial===true;
    const model=dashboardModel(r,s,catalog),dashboard=dashboardView();
    if(model&&dashboard){
      if(!model.contextValid)return dashboard.render(model);
      const filterToken=JSON.stringify(filtersFor(s));
      return `<div class="comparison-dashboard" data-comparison-dashboard>${dashboard.controls(model)}${dashboard.summary(model)}${dashboard.judgments(model)}${dashboard.graphs(model)}<section class="comparison-dashboard-details" aria-label="상세 근거"><div class="comparison-section-title"><span class="dashboard-kicker">05 · 상세 근거</span><h2>상세 근거</h2><p class="muted">선택한 업체의 확보일·공통 관측 조건과 원본 30일 자료를 확인합니다.</p></div><details class="card" data-dashboard-detail="evidence"><summary>업체별 자료 확보·비교 제외 사유 <span aria-hidden="true">+</span></summary>${readiness(r,s)}${summaryGroups(own,others,comparisons,evidenceModel(r,s))}${pairTable(r,s)}${partial?sourceIssues(r,s):''}</details><details class="card" data-dashboard-detail="operating"><summary>날짜별 운영 검토·쿠폰 계산 <span aria-hidden="true">+</span></summary>${operatingView()?.render(r,s,catalog,{scope:operatingScope()+filterToken,displayDates:model.dates,displayPeriod:model.period,displayComparisonActionable:model.quality?.actionable,displayHoldReason:model.judgments?.[0]?.reason})||''}</details><details class="card" data-dashboard-detail="additional"><summary>상품·예약수량·지역 자료 <span aria-hidden="true">+</span></summary><div class="comparison-view-tabs" role="tablist" aria-label="경쟁 비교 보기">${[['flow','예약 흐름'],['products','가격·상품'],['regions','지역 배경']].map(([id,name])=>`<button type="button" role="tab" data-comparison-view="${id}" aria-selected="${s.selectedView===id}" aria-controls="comparison-detail">${name}</button>`).join('')}</div>${s.selectedView==='flow'&&others.length?`<label class="comparison-focus"><span>그래프 비교업체</span><select data-comparison-focus aria-label="그래프 비교업체">${others.map(c=>`<option value="${esc(c.companyId)}" ${focus===c.companyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>`:''}<div id="comparison-detail" role="tabpanel">${s.selectedView==='products'?products(r,s,catalog):s.selectedView==='regions'?regions(r,s):flow(r,s,focus)}</div></details></section></div>`;
    }
    return `<div class="comparison-notice"><p>${!others.length?'비교업체를 선택하면 같은 조건으로 비교합니다.':cross?'다른 지역 업체는 지역 수요 차이를 포함한 참고 비교입니다.':'같은 지역에서도 업종·상품·관측 조건을 확인합니다.'}</p><small>같은 지역 ${same} · 다른 지역 ${cross}</small></div>${partial?'<p class="collection-warning">일부 자료를 확인하지 못했습니다. 정상 자료는 표시하며 업체별 날짜와 사유를 아래 근거에서 확인할 수 있습니다.</p>':''}${summaryGroups(own,others,comparisons,evidenceModel(r,s))}${readiness(r,s)}${operatingView()?.render(r,s,catalog,{scope:operatingScope()})||''}<section class="card"><div class="comparison-view-tabs" role="tablist" aria-label="경쟁 비교 보기">${[['flow','예약 흐름'],['products','가격·상품'],['regions','지역 배경']].map(([id,name])=>`<button type="button" role="tab" data-comparison-view="${id}" aria-selected="${s.selectedView===id}" aria-controls="comparison-detail">${name}</button>`).join('')}</div>${s.selectedView==='flow'&&others.length?`<label class="comparison-focus"><span>그래프 비교업체</span><select data-comparison-focus aria-label="그래프 비교업체">${others.map(c=>`<option value="${esc(c.companyId)}" ${focus===c.companyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>`:''}<div id="comparison-detail" role="tabpanel">${s.selectedView==='products'?products(r,s,catalog):s.selectedView==='regions'?regions(r,s):flow(r,s,focus)}</div></section>${pairTable(r,s)}${partial?sourceIssues(r,s):''}`;
  }
  function sourceIssues(r,s){
    const ids=new Set([s.ownCompanyId,...s.comparisonIds]);
    const issues=(r.dataQuality?.issues||[]).filter(row=>row.scope==='company'&&ids.has(row.companyId));
    return `<details class="card comparison-evidence"><summary>업체·기간별 연결 사유</summary><ul>${issues.map(row=>`<li><strong>${esc(r.companies.find(c=>c.companyId===row.companyId)?.name||'업체')}</strong> · ${esc(row.period?row.period.start+' ~ '+row.period.end:row.month||'기간 확인 필요')} · ${esc(row.reason)}</li>`).join('')||'<li>개별 근거의 수량·가격 미확인 날짜를 확인해 주세요.</li>'}</ul></details>`;
  }
  function panel(state,selection){
    const own=state.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>state.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const competitors=state.customer.relations.filter(r=>r.kind==='competitor'&&['active','pending'].includes(r.status)).map(r=>state.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    if(!own.length)return '<section class="card"><h2>비교 기준이 될 내 매장을 등록하세요.</h2><p class="muted">등록한 경쟁업체 자료는 아래에서 볼 수 있습니다. 내 매장이 없을 때 예약·매출을 0으로 생성하지 않습니다.</p><a class="button" href="#register-own">내 매장 등록</a></section>';
    const current=exactCurrent(selection);
    return `<section class="card comparison-controls"><h2 class="comparison-controls-title">비교 조건</h2><form id="comparison-form"><div class="form-grid"><label class="field"><span>기준 내 매장</span><select name="comparisonOwnId" aria-label="비교 기준 내 매장">${own.map(c=>`<option value="${esc(c.companyId)}" ${c.companyId===selection.ownCompanyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><div class="comparison-period"><span>저장 자료 범위</span><strong>${esc(selection.stayStart)} ~ ${esc(selection.stayEnd)}</strong><small>관측 기준 ${esc(selection.asOfDate)} · 한국시간</small></div><button class="button" type="submit">저장 자료 확인</button></div><details><summary>비교업체 선택 · ${selection.comparisonIds.length}곳</summary><div class="comparison-choices">${competitors.map(c=>`<label><input type="checkbox" name="comparisonIds" value="${esc(c.companyId)}" ${selection.comparisonIds.includes(c.companyId)?'checked':''}>${esc(c.name)}</label>`).join('')||'<p class="muted">설정에서 비교할 업체를 등록하세요.</p>'}</div></details></form>${current?'':`<p class="collection-warning">현재 나란히 비교는 오늘부터 30일 자료를 지원합니다. 선택한 과거 기간을 현재 자료로 대체하지 않습니다.</p><button class="button small" type="button" data-comparison-current>현재 30일로 보기</button>`}<p class="muted comparison-footnote">과거 숙박월은 업체자료의 C 통합관측에서 확인할 수 있습니다.</p></section><p id="comparison-status" role="status" class="connection-check" aria-live="polite"></p><div id="comparison-results" aria-live="polite"></div>`;
  }
  let active=null,generation=0,timer=null,focusId=null;
  const stop=()=>{generation++;if(timer!==null)clearTimeout(timer);timer=null;if(active?.savedSourceState){active.savedSourceState.cancelled=true;for(const value of active.savedSourceState.timers||[])clearTimeout(value);}active=null;operatingView()?.stop();};
  function notifyRegional(){if(active?.store.getState().selectedView==='regions')active.onRegionalView?.();}
  function mount(options){
    stop();active=options;const slot=document.querySelector('#comparison-results');if(!slot)return;
    const s=options.store.getState();if(!s.ownCompanyId||!exactCurrent(s)){slot.innerHTML='';return;}
    void refresh(false,0);
  }
  async function refresh(force=false,attempt=0){
    if(!active)return;
    const options=active,id=++generation,tokenBox={value:options.store.requestToken()},s=options.store.getState(),slot=document.querySelector('#comparison-results'),status=document.querySelector('#comparison-status');
    if(timer!==null)clearTimeout(timer);timer=null;
    options.pendingToken=tokenBox;
    const current=()=>active===options&&id===generation&&slot?.isConnected&&options.store.isCurrent(tokenBox.value);
    if(!slot||!exactCurrent(s))return;
    loadSavedSources(options,s,force&&attempt===0);
    const saved=options.peek(s.ownCompanyId);
    if(saved&&matching(saved,s)){drawResults(slot,render(saved,s,options.state.companies,focusId),saved);notifyRegional();}
    else slot.innerHTML='<section class="card company-connection is-loading" role="status"><span class="connection-spinner" aria-hidden="true"></span><p>저장된 비교 자료를 연결하고 있습니다.</p></section>';
    if(status)status.textContent=saved?'저장 자료 표시 · 최신 자료 확인 중':'저장 자료 연결 중';
    try{
      const result=await options.read(s.ownCompanyId,{force});if(!current())return;
      const latest=options.peek(s.ownCompanyId),normal=latest&&latest.responseCache?.preview!==true?latest:saved&&saved.responseCache?.preview!==true?saved:null;
      const shown=result.responseCache?.preview===true&&normal?normal:result;
      drawResults(slot,render(shown,options.store.getState(),options.state.companies,focusId),shown);
      notifyRegional();
      const info=result.responseCache||{},preview=info.preview===true,failed=info.refreshFailed===true&&info.refreshing!==true;
      const pending=info.refreshing===true||!failed&&(info.revalidationRequired===true||preview||result.dataQuality?.issues?.some(row=>['COMPANY_INTEGRATION_UPDATING','COMPANY_INTEGRATION_PENDING'].includes(row.code)));
      if(status)status.textContent=failed?'최신 확인 실패 · 이전 정상 자료 유지':pending?'저장 자료 표시 · 최신 계산 확인 중':result.dataQuality?.status==='partial'?'일부 자료 확인 필요 · 정상 자료 표시':`저장 자료 확인 · ${time(info.checkedAt||result.generatedAt)}`;
      if(pending&&attempt<8)timer=setTimeout(()=>{timer=null;if(current())void refresh(false,attempt+1);},[2000,4000,8000,16000,30000,45000,45000,45000][attempt]);
    }catch(error){
      if(!current())return;
      if([401,403,404,409].includes(error.status)){
        if(options.savedSourceState){options.savedSourceState.cancelled=true;for(const value of options.savedSourceState.timers||[])clearTimeout(value);}
        options.lastRenderedReport=null;
        slot.innerHTML='<section class="card"><p class="collection-warning">매장 등록·기간과 조회 권한을 다시 확인해 주세요.</p></section>';if(status)status.textContent='';if(error.status===401)options.onSessionExpired?.();
      }
      else{const latest=options.peek(s.ownCompanyId),retained=latest&&matching(latest,s)?latest:saved&&matching(saved,s)?saved:null;if(retained){drawResults(slot,render(retained,options.store.getState(),options.state.companies,focusId),retained);if(status)status.textContent='최신 자료 연결 지연 · 이전 저장 자료를 유지합니다.';}else{slot.innerHTML='<section class="card"><p class="collection-warning">저장 자료를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.</p></section>';if(status)status.textContent='연결 확인 필요';}}
      /* failure handled above */
    }
  }
  if(typeof document!=='undefined'){
    document.addEventListener('submit',event=>{
      if(event.target.id!=='comparison-form'||!active)return;event.preventDefault();event.stopImmediatePropagation();
      const options=active,form=new FormData(event.target),before=options.store.getState(),ownId=form.get('comparisonOwnId');
      const patch={ownCompanyId:ownId,...(ownId===before.ownCompanyId?{comparisonIds:form.getAll('comparisonIds')}:{})};
      const updated=options.store.update(patch);if(!updated.ok)return;options.onSelectionChange?.(updated.state);const workspace=document.querySelector('#comparison-workspace');if(workspace)workspace.innerHTML=panel(options.state,updated.state);void refresh(true);
    });
    document.addEventListener('click',event=>{
      const button=event.target.closest?.('[data-comparison-view],[data-comparison-current],[data-dashboard-reset]');if(!button||!active)return;event.preventDefault();
      if(button.hasAttribute('data-dashboard-reset')){
        const s=active.store.getState(),slot=document.querySelector('#comparison-results'),report=active.lastRenderedReport;
        if(setFilters(s,{start:s.stayStart,end:s.stayEnd,dayFilter:'all'})&&slot&&report&&matching(report,s))drawResults(slot,render(report,s,active.state.companies,focusId),report);
        return;
      }
      const options=active,presentationCurrent=options.pendingToken&&options.store.isCurrent(options.pendingToken.value),patch=button.hasAttribute('data-comparison-current')?{stayMode:'upcoming30',asOfDate:today()}:{selectedView:button.dataset.comparisonView};
      const updated=options.store.update(patch);if(!updated.ok)return;options.onSelectionChange?.(updated.state);if(!button.hasAttribute('data-comparison-current')&&presentationCurrent)options.pendingToken.value=options.store.requestToken();if(button.hasAttribute('data-comparison-current')){const workspace=document.querySelector('#comparison-workspace');if(workspace)workspace.innerHTML=panel(options.state,updated.state);void refresh(false);}else{const data=options.peek(updated.state.ownCompanyId),slot=document.querySelector('#comparison-results');if(data&&slot&&matching(data,updated.state)){drawResults(slot,render(data,updated.state,options.state.companies,focusId),data);notifyRegional();}else void refresh(false);}
    });
    document.addEventListener('change',event=>{
      if(!active)return;
      const target=event.target;
      if(target.matches?.('[data-dashboard-start],[data-dashboard-end],[data-dashboard-day-filter]')){
        const s=active.store.getState(),before=filtersFor(s),key=target.hasAttribute('data-dashboard-start')?'start':target.hasAttribute('data-dashboard-end')?'end':'dayFilter';
        if(!setFilters(s,{...before,[key]:target.value})){
          target.value=before[key];const status=document.querySelector('#comparison-status');if(status)status.textContent='저장된 범위 안에서 시작일과 종료일을 확인해 주세요. 이전 조건을 유지합니다.';return;
        }
        const report=active.lastRenderedReport,slot=document.querySelector('#comparison-results');
        if(report&&slot&&matching(report,s)){drawResults(slot,render(report,s,active.state.companies,focusId),report);const status=document.querySelector('#comparison-status');if(status)status.textContent='선택한 기간·요일의 저장 자료 표시';}
        return;
      }
      if(!target.matches?.('[data-comparison-focus]'))return;
      focusId=target.value;const s=active.store.getState(),data=active.peek(s.ownCompanyId),slot=document.querySelector('#comparison-results');if(data&&slot&&matching(data,s))drawResults(slot,render(data,s,active.state.companies,focusId),data);
    });
  }
  return {panel,render,pairTable,chart,matching,exactCurrent,mount,stop};
});
