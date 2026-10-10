(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=v=>v==null?'미확인':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1});
  const rate=v=>v==null?'비교 보류':`${(v*100).toFixed(1)}%`;
  const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const today=()=>new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const prior=()=>{const d=today();return new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7)-2,1)).toISOString().slice(0,7);};
  let seq=0,api,kind,regionData=null,pollTimer=null,viewState=null,currentReport=null;
  const cache=new Map();
  async function saved(url,force=false){const entry=cache.get(url);if(!force&&entry&&Date.now()-entry.at<60000)return entry.promise;const promise=api(url);cache.set(url,{at:Date.now(),promise});if(cache.size>20)cache.delete(cache.keys().next().value);try{return await promise;}catch(e){if(cache.get(url)?.promise===promise)cache.delete(url);throw e;}}
  const money=v=>v==null?'산출 보류':`${n(v/10000)}만원`;
  const reservation=s=>s.sold??(s.publicBookings!=null&&s.phoneBookings!=null?s.publicBookings+s.phoneBookings:null);
  const mean=s=>s.averageRate??(reservation(s)>0&&s.estimatedRevenue!=null?s.estimatedRevenue/reservation(s):null);
  function panel(mode,s) {
    const own=s.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>s.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const choices=mode==='regions'?s.regions:own;
    const titles={regions:'지역의 최근 흐름',reports:'현재 상황과 기간별 리포트',home:'내 매장 운영 요약',competitors:'같은 조건으로 경쟁 비교'};
    return `<section class="card analysis-intro ${['home','competitors'].includes(mode)?'overview-intro':''}"><h2>${titles[mode]}</h2><p class="muted">${mode==='regions'?'방문·체류·소비·검색 관심의 흐름을 확인합니다.':'기존 저장 자료를 사용합니다. 이 화면 조회로 수집이 시작되지 않습니다.'}</p><form id="analysis-form" data-analysis-form><div class="form-grid"><label class="field"><span>${mode==='regions'?'분석 지역':'기준 내 매장'}</span><select name="${mode==='regions'?'regionKey':'ownId'}" ${!choices.length?'disabled':''}>${choices.map(c=>`<option value="${esc(c.id||c.companyId)}">${esc(c.label||c.name)}</option>`).join('')||'<option>등록 대기</option>'}</select></label>${mode==='regions'?`<label class="field"><span>마지막 기준월</span><input name="month" type="month" min="2017-12" max="${prior()}" value="${prior()}" required></label>`:mode==='reports'?`<label class="field"><span>리포트 종류</span><select name="reportType"><option value="current">현재 상황 · 향후 30일</option><option value="weekly">주간 · 숙박일 기준</option><option value="monthly">월간 · 숙박월 기준</option></select></label><label class="field" data-report-month hidden><span>숙박월</span><input name="reportMonth" type="month" value="${prior()}" max="${today().slice(0,7)}"></label><label class="field" data-report-week hidden><span>주간 시작일 · 포함 7일</span><input name="weekStart" type="date" value="${today()}" max="${today()}"></label>`:'<p class="muted">오늘 포함 향후 30일 · 업체별 확보 범위와 공통 비교 날짜를 구분합니다.</p>'}</div><button class="button" type="submit" ${mode==='regions'&&!choices.length?'disabled':''}>저장 자료 다시 확인</button></form></section><section id="analysis-output" aria-live="polite"><p class="empty-note">${mode==='regions'&&!choices.length?'관심지역을 등록하면 지역 자료가 연결됩니다.':'저장 자료를 불러오고 있습니다.'}</p></section>`;
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
      return `<p><strong>${esc(m?.label||({averageDailyVisitors:'일평균 방문자',spendOverall:'소비 지수',interest:'검색 관심도'}[metric]))}</strong> · ${source?.confirmedPeriod?.status==='confirmed'?`최근 ${source.confirmedPeriod.months}개월 (${esc(source.confirmedPeriod.start)} ~ ${esc(source.confirmedPeriod.end)})<br>`:source?.confirmedPeriod?'참고 자료 · 연속 11개월 미만<br>':''}${m?.latest?`${esc(m.latest.month)} ${n(m.latest.value)} ${esc(m.unit)}<br>전월 ${window.InsightRegionHistory?.delta(m.mom)||'비교 자료 없음'} · 전년 동월 ${window.InsightRegionHistory?.delta(m.yoy)||'비교 자료 없음'}`:'월별 자료 확인 필요'}</p>`;
    }).join('')}</div>`;
  }
  function reportView(r) {
    const own=r.companies.find(c=>c.kind==='own');
    currentReport=r;
    return `<section class="briefing-banner"><span class="eyebrow">${r.mode==='period_review'?(r.period.type==='monthly'?'월간':'주간')+' 리포트 · 검토본':'현재 상황 브리핑 · 미발행'}</span><h2>${esc(own?.name||'사업 준비')}의 다음 판단</h2><p>숙박일 ${esc(r.period.start)} ~ ${esc(r.period.end)}</p><p class="muted">확인 시각 ${esc(time(r.generatedAt))}${r.mode==='period_review'?r.period.closed?' · 종료된 숙박기간':' · 진행 중인 기간':''}</p><div class="report-tools"><button class="button" type="button" data-report-print>인쇄 · PDF 저장</button><button class="button" type="button" data-report-download>보고서 파일 저장</button><small>현재 검토 내용을 파일로 보관합니다. 서버 발행본은 아닙니다.</small></div></section><section class="card"><div class="db-section-heading"><b>1</b><h2>현재 상황</h2></div><div class="briefing-company-grid">${r.companies.map(c=>`<article><span class="status-pill">${c.kind==='own'?'내 매장':'경쟁업체'}</span><h3>${esc(c.name)}</h3><p class="muted">객실 ${c.rooms==null?'미확인':n(c.rooms)+'실'} · 수량 유효 ${c.summary.days}/${r.period.days||30}일<br>마지막 관측 ${esc(c.lastObservedAt?time(c.lastObservedAt):(c.lastObservedDay||'확인 전'))}</p><dl><div><dt>예약 합계</dt><dd>${reservation(c.summary)==null?'미확인':n(reservation(c.summary))+'실'}</dd></div><div><dt>추정 예약률</dt><dd>${rate(c.summary.reservationRate)}</dd></div><div><dt>네이버 예약</dt><dd class="public-value">${c.summary.publicBookings==null?'미확인':n(c.summary.publicBookings)+'실'}</dd></div><div><dt>타채널·전화 예약</dt><dd class="estimated-value">${c.summary.phoneBookings==null?'미확인':n(c.summary.phoneBookings)+'실'}</dd></div><div><dt>매출 합계</dt><dd>${money(c.summary.estimatedRevenue)}</dd></div></dl><p class="muted">${c.unavailable?'자료 연결 확인 필요':'확보한 숙박일의 추정 합계입니다. 미확보 날짜를 0으로 합산하지 않습니다.'}</p><a class="text-link" href="#collection=${encodeURIComponent(c.companyId)}">근거·수집 결과 확인</a></article>`).join('')||'<p class="empty-note">등록한 업체가 없습니다.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>2</b><h2>경쟁업체와의 차이</h2></div><p class="muted">같은 숙박일과 같은 관측일이 겹치는 자료만 비교합니다. 가격·시설·연휴 등의 원인은 이 차이만으로 확정하지 않습니다.</p>${comparisonView(r)}</section><section class="card"><div class="db-section-heading"><b>3</b><h2>지역 수요 배경</h2></div><div class="briefing-region-grid">${r.regions.map(g=>`<article><span class="status-pill">${g.region.id===own?.regionKey?'매장 소재지':'관심지역'}</span><h3>${esc(g.region.label)}</h3><p>${g.window?`확인된 월까지 최근 11~12개월 · 지표별 기준 기간`:`기준월 ${esc(g.month)}`} · 저장 지표 ${g.availableSources}종</p><p class="muted">${esc(g.location?.interpretation||'입지 해석 자료 확인 전')}</p>${trendBrief(g)}<a href="#regions=${encodeURIComponent(g.region.id)}" class="text-link">지역별 지표·출처 확인</a></article>`).join('')||'<p class="empty-note">매장 소재지 또는 관심지역을 연결해 주세요.</p>'}</div></section><section class="card"><div class="db-section-heading"><b>4</b><h2>다음 행동</h2></div><div class="briefing-actions">${r.actions.map((a,i)=>`<article><span class="action-number">${String(i+1).padStart(2,'0')}</span><div><h3>${esc(a.title)}</h3><p>${esc(a.reason)}</p><p class="action-step">${esc(a.next)}</p><p class="muted">실행 후 확인: ${esc(a.check)}</p><small class="muted">근거: ${esc(a.source)}</small></div></article>`).join('')}</div></section><details class="card analysis-notes"><summary>집계 범위와 판단 기준</summary><ul>${r.definitions.map(d=>`<li>${esc(d)}</li>`).join('')}</ul></details>`;
  }
  function comparisonView(r) {
    return `<div class="comparison-cards">${r.comparisons.map(c=>{const safe=c.status==='comparable',a=c.own,b=c.competitor;return `<article><h3>${esc(c.name)}</h3><p class="muted">공통 숙박일 ${c.commonDays}일 · ${safe?'비교 가능':'7일 미만 · 판단 보류'}</p>${safe?`<svg viewBox="0 0 300 66" role="img" aria-label="내 매장 ${rate(a.reservationRate)}, 경쟁업체 ${rate(b.reservationRate)}"><text x="0" y="18">내 매장</text><rect class="compare-own" x="80" y="4" width="${Math.max(0,Math.min(1,a.reservationRate||0))*210}" height="16" rx="3"/><text x="0" y="52">경쟁업체</text><rect class="compare-other" x="80" y="38" width="${Math.max(0,Math.min(1,b.reservationRate||0))*210}" height="16" rx="3"/></svg>`:''}<div class="collection-table-wrap"><table><thead><tr><th>같은 날짜 기준</th><th>내 매장</th><th>경쟁업체</th></tr></thead><tbody><tr><th>예약률</th><td>${rate(a.reservationRate)}</td><td>${rate(b.reservationRate)}</td></tr><tr><th>평균 객실 판매금액</th><td>${money(mean(a))}</td><td>${money(mean(b))}</td></tr><tr><th>매출</th><td>${money(a.estimatedRevenue)}</td><td>${money(b.estimatedRevenue)}</td></tr></tbody></table></div><p>${safe&&c.gapPp!==null?'내 매장 예약률 '+(c.gapPp>0?'+':'')+n(c.gapPp)+'%p':'표본 부족으로 우열을 판단하지 않습니다.'}</p><details><summary>비교 날짜 확인</summary><p>${(c.dates||[]).map(esc).join(' · ')||'공통 날짜 없음'}</p></details><a class="text-link" href="#company=${encodeURIComponent(c.companyId)}">업체 자료 보기</a></article>`;}).join('')||'<p class="empty-note">내 매장과 경쟁업체를 등록하면 같은 날짜 기준으로 비교합니다.</p>'}</div>`;
  }
  function overview(r,mode) {
    const own=r.companies.find(c=>c.kind==='own'),s=own?.summary;
    return `<div class="overview-heading"><h3>${esc(own?.name||'내 매장 등록 대기')}</h3><p class="muted">숙박일 ${esc(r.period.start)} ~ ${esc(r.period.end)} · 확인 ${esc(time(r.generatedAt))}</p></div>${s?`<div class="overview-metrics"><article><span>예약 합계</span><strong>${reservation(s)==null?'미확인':n(reservation(s))+'실'}</strong><small>네이버 ${n(s.publicBookings)}실 · 타채널·전화 ${n(s.phoneBookings)}실</small></article><article><span>매출 합계</span><strong>${money(s.estimatedRevenue)}</strong><small>확보한 숙박일 기준 추정</small></article><article><span>예약률</span><strong>${rate(s.reservationRate)}</strong><small>수량 유효 ${s.days}/${r.period.days||30}일</small></article></div><a class="text-link" href="#company=${encodeURIComponent(own.companyId)}">날짜별 흐름과 관측 이력 보기 →</a>`:'<p class="empty-note">내 매장을 등록하면 운영 지표가 표시됩니다.</p>'}${mode==='competitors'?`<section class="card"><h3>공통 날짜로 비교</h3><p class="muted">같은 숙박일·같은 관측일의 정상 자료만 비교합니다. 금액은 예약 기준 추정입니다.</p>${comparisonView(r)}</section>`:`<section class="card next-actions"><h3>이번에 확인할 사항</h3>${r.actions.slice(0,3).map(a=>`<article><h4>${esc(a.title)}</h4><p>${esc(a.reason)}</p><small>${esc(a.next)}</small></article>`).join('')}<a class="text-link" href="#reports">전체 리포트 보기 →</a></section>`}`;
  }
  async function periodReport(params,id) {
    const period=window.InsightPeriodReport.range(params.reportType,params.reportType==='monthly'?params.reportMonth:params.weekStart,today());
    const relations=viewState.customer.relations.filter(r=>['active','pending'].includes(r.status)&&(r.kind==='competitor'||r.companyId===params.ownId)),entries=[];
    for(const rel of relations){if(id!==seq)return null;const company=viewState.companies.find(c=>c.companyId===rel.companyId);if(!company)continue;
      const slot=document.querySelector('#analysis-output');if(slot)slot.textContent=`저장 이력을 확인합니다. ${entries.length+1}/${relations.length}개 업체`;
      try{
        const months=[...new Set([period.start.slice(0,7),period.end.slice(0,7)])],details=[];let unavailable=false;
        for(const month of months){
          try{const result=await saved(`/companies/${encodeURIComponent(company.companyId)}/collection?month=${encodeURIComponent(month)}`);if(result.companyDetail)details.push(result.companyDetail);}
          catch(e){if(e.status===401)throw e;unavailable=true;}
        }
        const detail=details[0];
        entries.push({...company,kind:rel.kind,unavailable:unavailable||!detail,detail:detail?{...detail,history:{...detail.history,months:details.flatMap(d=>d.history?.months||[])},current:{...detail.current,daily:details.flatMap(d=>d.current?.daily||[])}}:null});
      }
      catch(e){if(e.status===401)throw e;entries.push({...company,kind:rel.kind,unavailable:true});}
    }
    const regions=[],month=period.end.slice(0,7)>prior()?prior():period.end.slice(0,7);
    for(const region of viewState.regions||[]){if(id!==seq)return null;try{regions.push(await saved(`/regions/${encodeURIComponent(region.id)}/analysis?month=${encodeURIComponent(month)}`));}catch(e){if(e.status===401)throw e;regions.push({region,month,availableSources:0,sources:[]});}}
    return window.InsightPeriodReport.build(entries,period,{ownId:params.ownId,regions});
  }
  function downloadReport() {
    if(!currentReport)return;
    const content=document.querySelector('#analysis-output')?.cloneNode(true);if(!content)return;
    content.querySelectorAll('.report-tools').forEach(el=>el.remove());content.querySelectorAll('details').forEach(el=>el.open=true);
    const html='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:"><title>사분 인사이트 검토 보고서</title><style>body{font-family:Arial,"Malgun Gothic",sans-serif;max-width:1000px;margin:32px auto;padding:20px;color:#243e36;line-height:1.8}h2{margin-top:32px}article,.card{border:1px solid #d7e1dc;padding:20px;margin:18px 0;break-inside:avoid}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px;border-bottom:1px solid #d7e1dc}dd{font-weight:bold}.public-value{color:#146849}.estimated-value{color:#713a9b}svg{max-width:420px}.compare-own{fill:#386854}.compare-other{fill:#849997}svg text{fill:#243e36}a,button{display:none}small,.muted{color:#55675f}@page{size:A4;margin:16mm}@media print{body{margin:0;padding:0}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style><body><p>SABUN INSIGHT · 저장 자료 검토본 · 서버 발행본 아님</p>'+content.innerHTML+'</body></html>';
    const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`sabun-insight-${currentReport.period.start}-${currentReport.period.end}.html`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
      slot.innerHTML=job&&window.InsightRegionHistory?.preparation?window.InsightRegionHistory.preparation(job,regionData):job?`<p>${job.reused?'방금 준비한 결과를 사용합니다. ':''}${jobStatus(job.status)} · ${job.progress.completed}/${job.progress.total} 항목</p><ul>${job.steps.map(s=>`<li>${esc(s.label)} · ${jobStatus(s.status)}${s.observedMonths!==null&&s.observedMonths!==undefined?` (${s.observedMonths}/${s.expectedMonths}개월)`:''}${s.errorCode?` · ${esc(jobError(s.errorCode))}`:''}</li>`).join('')}</ul>${active?'<p>화면을 이동해도 서버에서 준비를 계속합니다.</p>':'<p>같은 지역·기간은 공유하며 1시간 안의 반복 요청은 저장 결과를 사용합니다.</p>'}`:'';
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
  async function load(force=false) {
    const id=++seq,slot=document.querySelector('#analysis-output'),form=document.querySelector('#analysis-form');if(!slot||!form)return;
    const params=Object.fromEntries(new FormData(form));if(force&&kind==='reports')cache.clear();if(kind==='regions'&&!params.regionKey)return;
    const button=form.querySelector('button');button.disabled=true;currentReport=null;slot.innerHTML='<p class="empty-note" role="status">'+(kind==='reports'?'업체별 보존 이력을 계산하고 있습니다. 자료량에 따라 최대 3분 정도 걸릴 수 있습니다.':'저장 자료를 연결하고 있습니다.')+'</p>';
    try {const data=kind==='reports'&&params.reportType&&params.reportType!=='current'?await periodReport(params,id):await saved(kind==='regions'?`/regions/${encodeURIComponent(params.regionKey)}/analysis?month=${encodeURIComponent(params.month)}`:`/reports/briefing${params.ownId?'?ownId='+encodeURIComponent(params.ownId):''}`,force);if(id===seq&&slot.isConnected&&data){regionData=kind==='regions'?data:null;slot.innerHTML=kind==='regions'?regionView(data):['home','competitors'].includes(kind)?overview(data,kind):reportView(data);if(kind==='regions'&&data.refreshAvailable)void checkPreparation(id,params);}}
    catch(e){if(id===seq&&slot.isConnected)slot.innerHTML=`<p class="collection-warning">${esc(e.message)}</p>`;}
    finally{if(id===seq&&button.isConnected)button.disabled=false;}
  }
  document.addEventListener('submit',e=>{if(e.target.id!=='analysis-form')return;e.preventDefault();e.stopImmediatePropagation();load(true);});
  let printDetails=[];window.addEventListener?.('beforeprint',()=>{printDetails=[...document.querySelectorAll('#analysis-output details')].map(el=>[el,el.open]);printDetails.forEach(([el])=>el.open=true);});window.addEventListener?.('afterprint',()=>{printDetails.forEach(([el,open])=>el.open=open);printDetails=[];});
  document.addEventListener('click',e=>{if(e.target.closest?.('[data-report-print]')){window.print();}else if(e.target.closest?.('[data-report-download]'))downloadReport();});
  document.addEventListener('change',e=>{if(e.target.name==='reportType'){const form=document.querySelector('#analysis-form');form.querySelector('[data-report-month]').hidden=e.target.value!=='monthly';form.querySelector('[data-report-week]').hidden=e.target.value!=='weekly';}if(e.target.matches?.('[data-history-metric]')&&regionData){const card=e.target.closest('[data-history-source]'),s=regionData.sources.find(s=>s.key===card.dataset.historySource);if(s)card.outerHTML=window.InsightRegionHistory.source(s,regionData.window,e.target.value);return;}if(e.target.closest?.('#analysis-form'))load();});
  window.InsightAnalysis={panel,regionView,reportView,comparisonView,overview,clearCache(){cache.clear();},mount(mode,request,s,selectedRegion){kind=mode;api=request;viewState=s;
    if(mode==='regions'&&selectedRegion&&s.regions.some(r=>r.id===selectedRegion))document.querySelector('#analysis-form select').value=selectedRegion;
    load();},stop(){seq++;regionData=null;currentReport=null;if(pollTimer!==null){clearTimeout(pollTimer);pollTimer=null;}}};
})();
