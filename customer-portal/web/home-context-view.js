(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.InsightHomeContextView=api;})(typeof window==='undefined'?globalThis:window,()=>{
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v),n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const signed=v=>numeric(v)?`${v>0?'+':''}${n(v)}`:'미확인';
  const companyHref=id=>'#company='+encodeURIComponent(id);
  const exact=(r,s)=>s.stayMode==='upcoming30'&&s.asOfDate===s.stayStart&&r?.mode==='current_briefing'&&r.ownId===s.ownCompanyId&&r.period?.start===s.stayStart&&r.period?.end===s.stayEnd;
  function panel(state,s){
    const owns=state.customer.relations.filter(r=>r.kind==='own'&&['active','pending'].includes(r.status)).map(r=>state.companies.find(c=>c.companyId===r.companyId)).filter(Boolean);
    const selected=state.customer.relations.find(r=>r.kind==='own'&&r.companyId===s.ownCompanyId&&['active','pending'].includes(r.status));
    const statusNote=state.customer.accountKind==='admin_preview'?'관리자 체험':selected?.status==='pending'?'내 매장 확인 대기 · 관리자 확인이 필요합니다. 저장된 업체자료는 바로 볼 수 있습니다.':'';
    if(!owns.length&&state.view?.readOnly===true)return '<section class="card home-start"><h2>등록된 내 매장이 없습니다.</h2><p class="muted">고객의 현재 등록 상태를 읽기 전용으로 보고 있습니다.</p><a class="button" href="#regions">등록 지역 참고자료</a></section><div id="home-context-status" role="status" aria-live="polite"></div><div id="home-context-output"></div>';
    if(!owns.length)return `<section class="card home-start"><span class="eyebrow">YOUR NEXT STEP</span><h2>${state.customer.businessStatus==='planning'?'준비 중인 매장의 비교 기준을 만들어 보세요.':'내 매장을 연결해 주세요.'}</h2><p class="muted">매장을 등록하면 기본정보·예약 흐름과 지역 배경이 연결됩니다. 경쟁업체와 관심지역은 설정에서 관리합니다.</p><a class="button primary" href="#register-own">내 매장 등록</a> <a class="button" href="#regions">등록 지역 참고자료</a></section><div id="home-context-status" role="status" aria-live="polite"></div><div id="home-context-output"></div>`;
    return `<section class="card home-scope"><div><span class="eyebrow">YOUR BUSINESS IN CONTEXT</span><h2>지금 확인할 운영 흐름</h2></div><label class="field"><span>기준 내 매장</span><select data-context-own aria-label="홈 기준 내 매장">${owns.map(c=>`<option value="${esc(c.companyId)}" ${s.ownCompanyId===c.companyId?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><div class="home-period"><span>숙박기간</span><strong>${esc(s.stayStart)} ~ ${esc(s.stayEnd)}</strong><small>관측 기준 ${esc(s.asOfDate)} · 한국시간</small></div></section>${statusNote?`<p class="muted registration-note">${esc(statusNote)}</p>`:''}<p id="home-context-status" class="connection-check" role="status" aria-live="polite"></p><div id="home-context-output" aria-live="polite"></div>`;
  }
  function model(r,regional,state,s){
    const result={own:null,comparisons:[],regional:null,tasks:[],matched:exact(r,s)};
    if(result.matched){
      result.own=r.companies.find(c=>c.kind==='own'&&c.companyId===s.ownCompanyId)||null;
      result.comparisons=r.comparisons.filter(c=>s.comparisonIds.includes(c.companyId));
      if(result.own){
        const days=result.own.summary.days,count=Number.isInteger(days)&&days>=0&&days<=30?30-days:null;
        if(count>0)result.tasks.push({label:`내 매장의 미확인 ${count}일을 확인하세요.`,reason:'공백은 예약 0실로 계산하지 않습니다.',href:companyHref(s.ownCompanyId)});
        if(result.own.summary.estimatedRevenue===null)result.tasks.push({label:'금액이 빠진 날짜를 확인하세요.',reason:'확인된 금액과 전체 매출을 구별합니다.',href:companyHref(s.ownCompanyId)});
      }
      const cross=result.comparisons.filter(c=>c.regionRelation==='cross');
      if(cross.length)result.tasks.push({label:'다른 지역의 수요 배경을 함께 보세요.',reason:`선택한 타지역 ${cross.length}곳의 예약률 차이에는 지역 차이가 포함됩니다.`,href:'#regions'});
      const held=result.comparisons.filter(c=>c.comparable!==true);
      if(held.length)result.tasks.push({label:'비교가 보류된 근거를 확인하세요.',reason:`${held.length}곳의 관측일·객실 기준·공통 날짜를 먼저 확인합니다.`,href:'#competitors'});
    }
    if(regional?.ownId===(s.ownCompanyId||null))result.regional=regional.groups.find(g=>g.kinds.includes('own'))||null;
    result.tasks=result.tasks.slice(0,3);return result;
  }
  function render(r,regional,{state,selection:s}){
    const m=model(r,regional,state,s),own=m.own,summary=own?.summary;
    const company=state.companies.find(c=>c.companyId===s.ownCompanyId);
    const relation=state.customer.relations.find(r=>r.companyId===s.ownCompanyId&&r.kind==='own'&&['active','pending'].includes(r.status));
    const registration=state.customer.accountKind==='admin_preview'?'관리자 체험':relation?.status==='pending'?'내 매장 확인 대기 · 등록 승인과 별개로 저장 자료를 볼 수 있습니다.':'등록 완료';
    const inventory=summary?`<article class="card home-reservations"><span class="eyebrow">RESERVATION SNAPSHOT</span><h2>${esc(company?.name||own.name)}</h2><p class="muted">${esc(registration)}</p><div class="home-kpi-grid"><div><span>추정 예약률</span><strong>${numeric(summary.reservationRate)?n(summary.reservationRate*100)+'%':'미확인'}</strong></div><div><span>예약 수량</span><strong>${n(summary.sold)}<small> 실·박</small></strong></div><div><span>${summary.estimatedRevenue===null?'확인된 금액 소계':'관측 추정매출'}</span><strong>${numeric(summary.knownRevenueSubtotal??summary.estimatedRevenue)?n((summary.knownRevenueSubtotal??summary.estimatedRevenue)/10000)+'<small> 만원</small>':'미확인'}</strong></div></div><p class="muted">유효 ${n(summary.days)} / 30일 · 공개 예약 ${n(summary.publicBookings)} + 타채널 추정 ${n(summary.phoneBookings)} 실·박</p>${summary.estimatedRevenue===null?'<p class="collection-warning">일부 금액 미확인 · 표시한 소계는 전체 매출이 아닙니다.</p>':''}<a class="text-link" href="${companyHref(s.ownCompanyId)}">기본정보·채널·통합관측 →</a></article>`:`<section class="card"><h2>${esc(company?.name||'내 매장')} 예약 흐름</h2><p class="muted">${m.matched?'저장된 관측 자료를 확인해 주세요.':'선택한 기간의 저장 자료를 확인 중입니다. 현재 30일 이외의 기간은 업체자료에서 확인하세요.'}</p>${company?`<a class="text-link" href="${companyHref(company.companyId)}">업체자료 보기 →</a>`:''}</section>`;
    const comparisons=`<article class="card home-comparisons"><span class="eyebrow">COMPARISON CONTEXT</span><h2>선택한 경쟁업체</h2><div class="home-comparison-rows">${m.comparisons.map(c=>`<div><span><a href="${companyHref(c.companyId)}">${esc(c.name)}</a><small>${c.regionRelation==='same'?'같은 지역':c.regionRelation==='cross'?'다른 지역 · 참고':'지역 확인 필요'} · ${c.purpose==='direct'?'직접 경쟁':'운영 참고'}${c.industryRelation==='mixed'?' · 업종 다름':''} · 공통 ${n(c.commonDays)}일</small></span><strong>${c.comparable===true&&numeric(c.gapPp)?signed(c.gapPp)+'%p':'비교 보류'}</strong></div>`).join('')||(s.comparisonIds.length?'<p class="muted">공통 조건이 확인된 비교 자료를 연결합니다.</p>':'<p class="muted">선택한 업체가 없습니다. 경쟁분석에서 비교업체를 선택하세요.</p>')}</div><p class="muted">차이 = 내 매장 − 비교업체 · 지역 평균이나 성과 순위가 아닙니다.</p><a class="text-link" href="#competitors">비교 조건·예약 흐름 →</a></article>`;
    const sources=m.regional?.summary?.sources||[],signal=sources.flatMap(src=>(src.metrics||[]).filter(metric=>numeric(metric.latest?.value)).slice(0,1).map(metric=>({src,metric}))).slice(0,2);
    const region=`<article class="card home-region"><span class="eyebrow">REGIONAL SIGNALS</span><h2>${esc(m.regional?.region.label||company?.regionLabel||'내 매장 지역')}</h2>${signal.map(({src,metric})=>`<div class="home-signal"><span>${esc(src.label)}<small>실제 확보월 ${esc(metric.latest.month)}</small></span><strong>${n(metric.latest.value)} <small>${esc(metric.unit)}</small></strong></div>`).join('')||'<p class="muted">저장된 지역 요약을 확인 중이거나 표시할 지표가 없습니다.</p>'}<p class="muted">지표별 실제 공표기간이 예약 숙박기간과 다를 수 있습니다.</p><a class="text-link" href="#regions">수요·관심·배경·관광 구성 →</a></article>`;
    const tasks=`<section class="card home-next"><div><span class="eyebrow">WHAT TO REVIEW</span><h2>먼저 확인할 항목</h2></div>${m.tasks.length?`<ol>${m.tasks.map(t=>`<li><a href="${t.href}">${esc(t.label)}</a><p class="muted">${esc(t.reason)}</p></li>`).join('')}</ol>`:'<p class="muted">확인된 자료에 따라 최대 3개 항목을 표시합니다. 예약 변화는 내 매장 C의 같은 숙박일·관측 간격에서 확인할 수 있습니다.</p>'}<a class="text-link" href="#reports">현재 브리핑·발행 리포트 →</a></section>`;
    if(!s.ownCompanyId){const groups=(regional?.groups||[]).filter(g=>g.companyIds?.some(id=>s.comparisonIds.includes(id))||g.kinds.includes('interest')&&state.customer.regions?.some(r=>r.status==='active'&&r.regionKey===g.region.id));return `<section class="card"><h2>등록한 지역 참고자료</h2><p class="muted">${groups.map(g=>esc(g.region.label)).join(' · ')||'선택한 업체·관심지역의 저장 자료를 확인해 주세요.'}</p><a class="text-link" href="#regions">지역 배경 보기 →</a></section>`;}
    return `<div class="home-context-grid">${inventory}${comparisons}${region}${tasks}</div>`;
  }
  return {panel,model,render,exact};
});
