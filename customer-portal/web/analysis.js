(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=v=>v==null?'미확인':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1});
  const rate=v=>v==null?'비교 보류':`${(v*100).toFixed(1)}%`;
  const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const prior=()=>{const d=today();return new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7)-2,1)).toISOString().slice(0,7);};
  let seq=0,api,kind,regionData=null,pollTimer=null;
  function panel(mode,s) {
    const own=s.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>s.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const choices=mode==='regions'?s.regions:own;
    return `<section class="card analysis-intro"><span class="eyebrow">${mode==='regions'?'REGIONAL CONTEXT':'SITUATION → NEXT ACTION'}</span><h2>${mode==='regions'?'지역의 12개월 흐름':'현재 상황과 다음 행동'}</h2><p class="muted">${mode==='regions'?'등록한 관심지역과 매장 소재지의 방문·체류·소비·검색 관심 변화를 확인합니다.':'내 매장·등록 경쟁업체·지역 배경을 함께 확인합니다. 저장 자료로 보는 현재 상황 브리핑입니다.'}</p><form id="analysis-form" data-analysis-form><div class="form-grid"><label class="field"><span>${mode==='regions'?'분석 지역':'기준 내 매장'}</span><select name="${mode==='regions'?'regionKey':'ownId'}" ${!choices.length?'disabled':''}>${choices.map(c=>`<option value="${esc(c.id||c.companyId)}">${esc(c.label||c.name)}</option>`).join('')||'<option>등록 대기</option>'}</select></label>${mode==='regions'?`<label class="field"><span>마지막 기준월</span><input name="month" type="month" min="2017-12" max="${prior()}" value="${prior()}" required></label>`:'<p class="muted">예약 전망은 오늘 포함 향후 30일, 지역 배경은 최근 12개월 흐름과 각 통계의 실제 공표기간을 사용합니다.</p>'}</div><button class="button" type="submit" ${mode==='regions'&&!choices.length?'disabled':''}>저장 자료 확인</button></form></section><section id="analysis-output" aria-live="polite"><p class="empty-note">${mode==='regions'&&!choices.length?'관심지역을 등록하면 지역 자료가 연결됩니다.':'저장 자료를 불러오고 있습니다.'}</p></section>`;
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
    if(!slot||id!==seq)return;
    if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null;}
    if(button)button.disabled=true;
    if(start)slot.textContent='24개월 지역 자료 갱신을 요청하고 있습니다.';
    let active=false;
    try {
      const base=`/regions/${encodeURIComponent(params.regionKey)}/preparation`;
      const result=await api(start?base:`${base}?month=${encodeURIComponent(params.month)}`,start?{month:params.month}:undefined);
      if(id!==seq||!slot.isConnected)return;
      if(result.regionKey!==params.regionKey||result.month!==params.month)throw Error('선택한 지역·기간과 응답이 다릅니다.');
      const job=result.job;active=['queued','running'].includes(job?.status);
      slot.innerHTML=job?`<p>${job.reused?'방금 준비한 결과를 사용합니다. ':''}${jobStatus(job.status)} · ${job.progress.completed}/${job.progress.total} 항목</p><ul>${job.steps.map(s=>`<li>${esc(s.label)} · ${jobStatus(s.status)}${s.observedMonths!==null&&s.observedMonths!==undefined?` (${s.observedMonths}/${s.expectedMonths}개월)`:''}${s.errorCode?` · ${esc(jobError(s.errorCode))}`:''}</li>`).join('')}</ul>${active?'<p>화면을 이동해도 서버에서 준비를 계속합니다.</p>':'<p>같은 지역·기간은 공유하며 1시간 안의 반복 요청은 저장 결과를 사용합니다.</p>'}`:'';
      if(active)pollTimer=setTimeout(()=>{pollTimer=null;void checkPreparation(id,params,false,true);},3000);
      else if(start||wasActive)await load();
    } catch(e) {if(id===seq&&slot.isConnected)slot.textContent=e.message;}
    finally {if(id===seq&&button?.isConnected)button.disabled=active;}
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('[data-history-refresh]');if(!button||button.disabled||!regionData)return;
    e.preventDefault();e.stopImmediatePropagation();
    const params=Object.fromEntries(new FormData(document.querySelector('#analysis-form')));
    void checkPreparation(seq,params,true);
  });
  async function load() {
    const id=++seq,slot=document.querySelector('#analysis-output'),form=document.querySelector('#analysis-form');if(!slot||!form)return;
    const params=Object.fromEntries(new FormData(form));if(kind==='regions'&&!params.regionKey)return;
    const button=form.querySelector('button');button.disabled=true;slot.innerHTML='<p class="empty-note" role="status">'+(kind==='reports'?'업체별 보존 이력을 계산하고 있습니다. 자료량에 따라 최대 3분 정도 걸릴 수 있습니다.':'저장 자료를 연결하고 있습니다.')+'</p>';
    try {const data=await api(kind==='regions'?`/regions/${encodeURIComponent(params.regionKey)}/analysis?month=${encodeURIComponent(params.month)}`:`/reports/briefing${params.ownId?'?ownId='+encodeURIComponent(params.ownId):''}`);if(id===seq&&slot.isConnected){regionData=kind==='regions'?data:null;slot.innerHTML=kind==='regions'?regionView(data):reportView(data);if(kind==='regions'&&data.refreshAvailable)void checkPreparation(id,params);}}
    catch(e){if(id===seq&&slot.isConnected)slot.innerHTML=`<p class="collection-warning">${esc(e.message)}</p>`;}
    finally{if(id===seq&&button.isConnected)button.disabled=false;}
  }
  document.addEventListener('submit',e=>{if(e.target.id!=='analysis-form')return;e.preventDefault();e.stopImmediatePropagation();load();});
  document.addEventListener('change',e=>{if(e.target.matches?.('[data-history-metric]')&&regionData){const card=e.target.closest('[data-history-source]'),s=regionData.sources.find(s=>s.key===card.dataset.historySource);if(s)card.outerHTML=window.InsightRegionHistory.source(s,regionData.window,e.target.value);return;}if(e.target.closest?.('#analysis-form'))load();});
  window.InsightAnalysis={panel,regionView,reportView,mount(mode,request,s,selectedRegion){kind=mode;api=request;
    if(mode==='regions'&&selectedRegion&&s.regions.some(r=>r.id===selectedRegion))document.querySelector('#analysis-form select').value=selectedRegion;
    load();},stop(){seq++;regionData=null;if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null;}}};
})();
