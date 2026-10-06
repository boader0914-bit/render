(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=v=>v==null?'미확인':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1});
  const status=s=>({observed:'정상 자료',ready:'저장 자료',complete:'정상 자료',partial:'일부 자료',missing:'자료 없음',publication_pending:'공표 대기',error:'확인 필요',failed:'확인 필요'}[s]||'확인 전');
  const date=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'저장 전';
  const delta=d=>d?.value==null?(d?.kind==='zero_baseline'?'비교 불가 · 기준값 0':'비교 자료 없음'):`${d.value>0?'+':''}${n(d.value)}${d.kind==='percent'?'%':' 지수'}`;
  function chart(points,label,unit) {
    const observed=points.filter(p=>p.value!==null),max=Math.max(1,...observed.map(p=>p.value));
    const x=i=>38+i*(points.length>1?484/(points.length-1):0),y=v=>154-v/max*120;
    let paths=[],segment=[];
    points.forEach((p,i)=>{if(p.value!==null)segment.push(`${x(i)},${y(p.value)}`);else{if(segment.length)paths.push(segment);segment=[];}});
    if(segment.length)paths.push(segment);
    return `<svg class="history-chart" viewBox="0 0 558 193" role="img" aria-label="${esc(label)} 최근 ${points.length}개월 추이. ${observed.length}개월 자료 있음. 자세한 값은 월별 표에서 확인하세요."><title>${esc(label)} · ${esc(unit)}</title>${[0,.5,1].map(v=>`<line x1="38" x2="522" y1="${y(v*max)}" y2="${y(v*max)}" class="chart-grid"/><text x="4" y="${y(v*max)-5}">${n(v*max)}</text>`).join('')}${paths.map(p=>`<polyline points="${p.join(' ')}" class="history-line"/>`).join('')}${points.map((p,i)=>`${p.value===null?`<text class="chart-missing" x="${x(i)}" y="150" text-anchor="middle">—</text>`:`<circle cx="${x(i)}" cy="${y(p.value)}" r="3.5"><title>${esc(p.month)}: ${n(p.value)} ${esc(unit)}</title></circle>`}<text class="chart-month${i%2?' chart-month-secondary':''}" x="${x(i)}" y="178" text-anchor="middle">${esc(p.month.slice(2).replace('-','.'))}</text>`).join('')}</svg>`;
  }
  function source(s,w,selected) {
    w=s.confirmedPeriod||w;
    const metric=(s.metrics||[]).find(m=>m.key===selected)||s.metrics?.[0];
    if(!metric)return '';
    const points=Array.from({length:w.months||12},(_,i)=>{
      const month=new Date(Date.UTC(+w.start.slice(0,4),+w.start.slice(5)-1+i,1)).toISOString().slice(0,7),p=s.series?.find(p=>p.month===month);
      return {month,status:p?.status||'missing',value:p?.rows.find(r=>r.key===metric.key)?.value??null};
    });
    return `<article class="card history-source" data-history-source="${esc(s.key)}"><div class="analysis-card-top"><div><span class="eyebrow">MONTHLY TREND</span><h3>${esc(s.label)}</h3></div><span class="status-pill ${w.status==='confirmed'?'':'pending'}">${w.status==='confirmed'?`최근 ${w.months}개월 · 확인 완료`:`참고 자료 ${metric.observedMonths}/${w.months||12}개월`}</span></div><p class="muted">${esc(s.provider)} · ${esc(w.start)} ~ ${esc(w.end)}</p><label class="field history-metric"><span>표시 지표</span><select data-history-metric aria-label="${esc(s.label)} 표시 지표">${s.metrics.map(m=>`<option value="${esc(m.key)}" ${m.key===metric.key?'selected':''}>${esc(m.label)} (${esc(m.unit)})</option>`).join('')}</select></label><div class="history-latest"><div><span>최신 확보월 ${esc(metric.latest?.month||'없음')}</span><strong>${n(metric.latest?.value)} <small>${esc(metric.unit)}</small></strong></div><dl><div><dt>전월 대비</dt><dd>${delta(metric.mom)}</dd></div><div><dt>전년 동월 대비</dt><dd>${delta(metric.yoy)}</dd></div></dl></div>${chart(points,metric.label,metric.unit)}${w.excludedRecentMonths?.length?`<p class="history-note">${esc(w.excludedRecentMonths.join(', '))}은 미확인으로 기준 기간에서 제외했습니다.</p>`:''}<p class="history-note">${metric.observedMonths?`확보 자료 중 최고 ${esc(metric.peak?.month)} · 최저 ${esc(metric.low?.month)}`:'표시할 저장 자료가 없습니다. 지역 자료 갱신으로 준비할 수 있습니다.'} · 빈 달은 미확인입니다.</p>${s.normalizationPeriod?`<p class="history-note">검색지수 산정기간 ${esc(s.normalizationPeriod)} · 최고값 100 · 다른 조회기간의 지수와 합산하지 않습니다.</p>`:''}<details><summary>월별 수치·출처 확인</summary><div class="collection-table-wrap"><table><thead><tr><th>월</th><th>${esc(metric.label)}</th><th>전년 같은 달</th><th>상태</th></tr></thead><tbody>${points.map(p=>{const prev=`${Number(p.month.slice(0,4))-1}${p.month.slice(4)}`,value=s.series.find(r=>r.month===prev)?.rows.find(r=>r.key===metric.key)?.value;return `<tr><th>${esc(p.month)}</th><td>${n(p.value)} ${esc(metric.unit)}</td><td>${n(value)} ${esc(metric.unit)}</td><td>${esc(p.value===null?status(p.status==='observed'?'missing':p.status):'정상 자료')}</td></tr>`;}).join('')}</tbody></table></div><p class="muted">저장 ${esc(date(s.retrievedAt))}</p>${s.sourceUrl?`<a class="text-link" href="${esc(s.sourceUrl)}" target="_blank" rel="noreferrer">자료 출처</a>`:''}</details></article>`;
  }
  function background(s) {
    const row=s.rows.find(r=>r.key==='total'||r.key==='all')||s.rows[0];
    return `<article class="card region-source"><h3>${esc(s.label)}</h3><p class="muted">${esc(s.provider)} · 실제 공표기간 ${esc(s.period||'확인 전')}</p><p>${esc(row?.label||'저장 수치')} <strong>${n(row?.value)}</strong> ${esc(row?.unit)}</p><details><summary>세부 수치·출처</summary>${s.rows.map(r=>`<p>${esc(r.label)}: ${n(r.value)} ${esc(r.unit)}</p>`).join('')}<p class="muted">저장 ${esc(date(s.retrievedAt))}</p>${s.sourceUrl?`<a href="${esc(s.sourceUrl)}" class="text-link" target="_blank" rel="noreferrer">자료 출처</a>`:''}</details></article>`;
  }
  function highlights(r){
    const keys=[['tourism_visitors','averageDailyVisitors','방문자'],['tourism_stay_spend','spendOverall','소비 지수'],['naver_search_trend','interest','검색 관심도']];
    return `<section class="card regional-highlights"><h3>지역 흐름 요약</h3><div class="overview-metrics">${keys.map(([key,metric,label])=>{const m=r.sources.find(s=>s.key===key)?.metrics?.find(m=>m.key===metric);return `<article><span>${label}</span><strong>${n(m?.latest?.value)} <small>${esc(m?.unit||'')}</small></strong><small>최신 확보월 ${esc(m?.latest?.month||'없음')}</small><p>전월 ${delta(m?.mom)}<br>전년 동월 ${delta(m?.yoy)}</p></article>`;}).join('')}</div><p class="muted">각 지표의 최신 확보월을 먼저 확인한 뒤, 내 매장 예약 흐름과 같은 기간으로 비교하세요.</p></section>`;
  }
  function render(r) {
    const history=r.sources.filter(s=>s.series),stats=r.sources.filter(s=>!s.series),w=r.window;
    return `<div class="analysis-heading"><div><span class="eyebrow">CONFIRMED MONTHLY TREND</span><h2>${esc(r.region.label)}</h2></div><span class="status-pill">확인된 월까지 · 최근 11~12개월</span></div><p class="muted">마지막 정상 확보월까지의 연속 12개월을 기준으로 합니다. 12개월이 없으면 연속 11개월을 사용하며, 지표별 기간을 표시합니다.</p>${highlights(r)}<section class="history-refresh"><div><strong>지역 자료 준비</strong><p class="muted">저장된 값을 먼저 사용하고 없는 관광지표·검색 관심도와 갱신이 필요한 통계를 준비합니다.</p></div><button class="button primary" type="button" data-history-refresh ${r.refreshAvailable?'':'disabled'}>지역 자료 갱신</button><div id="history-progress" role="status" aria-live="polite"></div></section><div class="history-grid">${history.map(s=>source(s,w)).join('')}</div>${r.interim?`<details class="card history-interim"><summary>${esc(r.interim.month)} 이번 달 중간 현황 · 기준 집계에서 제외</summary><p class="muted">월 마감 전 자료는 월 전체 수치와 비교하지 않습니다. 검색 관심도는 별도 조회기간의 상대지수입니다.</p>${r.interim.sources.map(s=>`<p><strong>${esc(s.label)}</strong> · ${s.rows.some(p=>p.value!==null)?s.rows.map(p=>`${esc(p.label)} ${n(p.value)} ${esc(p.unit)}`).join(' · '):'아직 확보된 이번 달 자료가 없습니다.'}</p>`).join('')}</details>`:''}<h2 class="history-section-title">인구·산업 배경</h2><p class="muted">월별 관광 흐름의 배경으로 참고합니다. 연간 통계를 월간 값으로 바꾸지 않습니다.</p><div class="region-source-grid">${stats.map(background).join('')}</div>${r.location?`<section class="card region-location"><h3>입지·고객층 참고</h3><p>${esc(r.location.interpretation)}</p><div class="analysis-clusters">${r.location.clusters.map(c=>`<article><strong>${esc(c.name)}</strong><p>${esc(c.demand)}</p><small>${esc(c.product)}</small></article>`).join('')}</div><p class="muted">${esc(r.location.caution)}</p><small class="muted">${esc(r.location.source)} · 통계가 아닌 참고 해석</small></section>`:''}<details class="card analysis-notes"><summary>지표를 읽을 때 확인할 점</summary><ul>${r.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`;
  }
  const preparationSources={visitors:'tourism_visitors',demandStrength:'tourism_stay_spend',resourceDemand:'tourism_resource',diversity:'tourism_diversity',searchTrend:'naver_search_trend'};
  const preparationStatus=s=>({queued:'대기',running:'갱신 중',ready:'완료',complete:'완료',partial:'일부 응답',failed:'실패',missing:'자료 없음',interrupted:'중단',publication_pending:'공표 대기'}[s]||'확인 전');
  const preparationError=code=>({PARTIAL_DATA:'일부 월 자료가 불완전함',PROVIDER_FAILED:'일부 월 응답을 확보하지 못함',MISSING_VALUES:'일부 월 자료 없음',NO_DATA:'제공 자료 없음',PUBLICATION_PENDING:'아직 공표되지 않음',MISSING_KEY:'인증키 설정 필요',AUTH_ERROR:'이용 권한 확인 필요',QUOTA_EXCEEDED:'제공기관 요청 한도 도달',TIMEOUT:'응답 시간 초과',NETWORK_ERROR:'연결 실패',REGIONAL_SOURCE_BUSY:'다른 자료 갱신 중',CACHE_WRITE_ERROR:'자료 저장 실패'}[code]||'갱신 응답 확인 필요');
  function preparation(job,region) {
    if(!job)return '';
    const items=job.steps.map(step=>({step,source:region?.sources?.find(s=>s.key===preparationSources[step.key])}));
    const ready=items.filter(({step,source})=>step.key==='kosis'?step.status==='ready':source?.confirmedPeriod?.status==='confirmed').length;
    const active=['queued','running'].includes(job.status);
    return '<p>준비 처리 '+job.progress.completed+'/'+job.progress.total+' 항목'+(active?' 진행 중':' 종료')+' · 기준 자료 '+ready+'/'+job.progress.total+'종 확보</p><ul>'+items.map(({step,source})=>{
      const p=source?.confirmedPeriod;
      const description=p?.status==='confirmed'?'최근 '+p.months+'개월 · '+p.start+' ~ '+p.end:step.key==='kosis'?(step.status==='ready'?'공표된 인구·산업 통계 확보':preparationStatus(step.status)):p?'연속 11개월 미만 · 참고 자료':'자료 확인 전';
      return '<li><strong>'+esc(step.label)+'</strong> · '+esc(description)+'</li>';
    }).join('')+'</ul><details><summary>마지막 갱신 기록</summary><p>저장된 기준 자료와 갱신 시도 결과는 별도로 표시합니다.</p><ul>'+items.map(({step})=>'<li>'+esc(step.label)+' · '+esc(preparationStatus(step.status))+(step.errorCode?' · '+esc(preparationError(step.errorCode)):'')+'</li>').join('')+'</ul></details>'+(active?'<p>화면을 이동해도 서버에서 준비를 계속합니다.</p>':'<p>같은 지역·기간은 공유하며 1시간 안의 반복 요청은 저장 결과를 사용합니다.</p>');
  }
  const api={render,source,chart,delta,preparation};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightRegionHistory=api;
})();
