(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./operating-strategy.js'):root.InsightOperatingStrategy);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightOperatingStrategyView=api;
})(typeof window==='undefined'?globalThis:window,function(modelApi){
  'use strict';
  const DAY=86400000,MAX_DAYS=3660;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=(value,fallback='')=>typeof value==='string'&&value.length<=4000&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)?value:fallback;
  const list=value=>Array.isArray(value)?value:[];
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  const n=value=>number(value)!==null?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value)?value:null;
  const date=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
  const rate=value=>number(value)!==null&&value<=1?`${(value*100).toFixed(1)}%`:'미확인';
  const quantity=value=>count(value)!==null?`${n(value)}실`:'수량 미확인';
  const money=value=>number(value)!==null?`${n(value)}원`:'금액 미확인';
  const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const strings=value=>list(value).filter(v=>text(v)).slice(0,64);
  function periodOf(value){
    const start=date(value?.start),end=date(value?.end),days=count(value?.days);
    const empty=value?.start===null&&value?.end===null&&days===0;
    const valid=empty||!!start&&!!end&&days!==null&&days>0&&days<=MAX_DAYS&&days===(Date.parse(end)-Date.parse(start))/DAY+1;
    return {start:valid?start:null,end:valid?end:null,days:valid?days:null,asOf:date(value?.asOf),valid};
  }
  function dateList(value,period){
    if(!Array.isArray(value)||value.length>MAX_DAYS)return [];
    return [...new Set(value.filter(day=>date(day)&&(!period.start||day>=period.start&&day<=period.end)))].sort();
  }
  function sourceNotice(source){
    if(source.preview===true)return source.refreshFailed===true?'저장 자료 미리보기 · 계산 확인 필요 · 제안 보류':'저장 자료 미리보기 · 계산 확인 중 · 제안 보류';
    if(source.refreshing===true)return '저장 자료 표시 · 최신 근거 확인 중';
    if(source.refreshFailed===true)return '최신 확인 지연 · 저장된 근거 기준';
    return '저장된 관측 근거 기준';
  }
  function metric(label,value,detail,extra=''){
    return `<div class="operating-strategy-metric ${extra}"><dt>${label}</dt><dd>${value}${detail?`<span class="operating-strategy-metric-detail">${detail}</span>`:''}</dd></div>`;
  }
  function metrics(summary,period){
    const valid=count(summary.validDays),selected=count(summary.selectedDays),missing=count(summary.missingDays);
    const coverage=valid!==null&&selected!==null?`${n(valid)}<small> / ${n(selected)}일</small>`:'확보 범위 미확인';
    const missingLabel=missing===null?'미확인 일수 확인 필요':`수량 미확인 ${n(missing)}일`;
    const unknown=Array.isArray(summary.unknownRevenueDays)?dateList(summary.unknownRevenueDays,period).length:count(summary.unknownRevenueDays);
    return `<dl class="operating-strategy-metrics">${metric('수량 확보일 / 선택일',coverage,missingLabel)}${metric('예약 수량',quantity(summary.sold),`공개 ${quantity(summary.publicBookings)} · 타채널 추정 ${quantity(summary.phoneBookings)}`)}${metric('추정 예약률',rate(summary.rate),`확인된 공급 ${quantity(summary.supply)}`)}${metric('확인된 매출 소계',money(summary.knownRevenueSubtotal),unknown===null?'금액 미확인 범위 확인 필요':`금액 미확인 ${n(unknown)}일`, 'operating-strategy-money')}</dl><p class="operating-strategy-subtotal-note">확인된 매출 소계는 전체 매출을 뜻하지 않습니다. 미확인 값은 0으로 채우지 않습니다.</p>`;
  }
  function weekdayView(segments){
    const rows=list(segments).slice(0,14).filter(row=>row&&typeof row==='object');
    if(!rows.length)return '<p class="operating-strategy-empty">요일별로 나눌 날짜별 근거가 없습니다.</p>';
    return `<div class="operating-strategy-weekdays" aria-label="내 매장 요일별 예약 흐름">${rows.map(row=>{
      const days=count(row.days),selected=count(row.selectedDays),missing=count(row.missingDays);
      return `<article class="operating-strategy-weekday"><h4>${esc(text(row.label,'요일 확인 필요'))}</h4><strong>${rate(row.rate)}</strong><span>예약 ${quantity(row.sold)} / 공급 ${quantity(row.supply)}</span><small>${days!==null&&selected!==null?`유효 ${n(days)} / ${n(selected)}일`:'유효일 미확인'} · ${missing===null?'미확인 일수 확인 필요':`미확인 ${n(missing)}일`}</small></article>`;
    }).join('')}</div>`;
  }
  function evidence(action,index,period){
    const basis=strings(action.basis),limits=strings(action.limits),dates=dateList(action.dates,period);
    const key=id(action.id)||'action_'+index;
    return `<details class="operating-strategy-evidence" data-operating-strategy-evidence="${esc(key)}"><summary><span>판단 근거와 한계${dates.length?` · 숙박일 ${n(dates.length)}일`:''}</span><b aria-hidden="true">+</b></summary><div class="operating-strategy-evidence-body"><div><h4>사용한 근거</h4>${basis.length?`<ul>${basis.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:'<p>개별 근거 확인이 필요합니다.</p>'}</div><div><h4>판단의 한계</h4>${limits.length?`<ul>${limits.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:'<p>이 제안은 선택한 기간의 저장 자료 범위에서 검토합니다.</p>'}</div>${dates.length?`<div class="operating-strategy-date-box"><h4>근거 숙박일 · 전체 ${n(dates.length)}일</h4><div class="operating-strategy-dates" tabindex="0" aria-label="근거 숙박일 전체 목록">${dates.map(day=>`<time datetime="${day}">${day}</time>`).join('')}</div></div>`:'<p class="operating-strategy-date-empty">특정 숙박일 근거를 확인하지 못했습니다.</p>'}</div></details>`;
  }
  function actionCard(action,index,period,source,held){
    const kind=['operation','experiment','data'].includes(action.kind)?action.kind:'data';
    const status=held||source.preview===true?'held':['proposal','review','held'].includes(action.status)?action.status:'held';
    const statusLabel={proposal:'제안',review:'검토',held:'보류'}[status],kindLabel={operation:'운영 검토',experiment:'작은 실험',data:'자료 확인'}[kind];
    const preview=source.preview===true;
    const next=preview?'리포트 계산 상태와 근거를 확인한 뒤 제안을 다시 검토하세요.':held?'내 매장과 선택 기간의 자료 연결을 확인한 뒤 검토하세요.':text(action.next,'선택한 기간의 근거를 먼저 확인하세요.');
    const check=preview?'계산 완료 여부와 선택한 숙박기간':text(action.check,'유효 관측일과 미확인 범위');
    return `<article class="operating-strategy-action is-${status}" data-operating-strategy-action="${esc(id(action.id)||'action_'+index)}"><header class="operating-strategy-action-heading"><span class="operating-strategy-action-number">${String(index+1).padStart(2,'0')}</span><div><span class="operating-strategy-kind">${kindLabel}</span><h3>${esc(text(action.title,'근거를 확인한 뒤 검토하세요.'))}</h3></div><span class="operating-strategy-state is-${status}">${statusLabel}</span></header><dl class="operating-strategy-steps"><div><dt>확인한 흐름</dt><dd>${esc(text(action.finding,'저장 자료에서 판단 근거를 확인해야 합니다.'))}</dd></div><div class="operating-strategy-next"><dt>${status==='held'?'보류 중인 행동':'제안 행동'}</dt><dd>${esc(next)}</dd></div><div><dt>다음 확인 지표</dt><dd>${esc(check)}</dd></div></dl>${evidence(action,index,period)}</article>`;
  }
  function renderModel(model){
    const validModel=!!model&&typeof model==='object'&&['ready','limited','unavailable'].includes(model.status);
    const input=validModel?model:{},period=periodOf(input.period),source=input.source&&typeof input.source==='object'?input.source:{};
    const company=input.company&&typeof input.company==='object'?input.company:{},companyId=id(company.companyId),summary=input.summary&&typeof input.summary==='object'?input.summary:{};
    const showFacts=validModel&&period.valid&&!!companyId;
    const held=!period.valid||!period.days||!companyId||input.status==='unavailable';
    const status=held?'unavailable':source.preview===true?'limited':input.status;
    const statusLabel={ready:'근거에 따른 제안',limited:'확인 범위 내 검토',unavailable:'자료 확인 필요'}[status];
    const mode=period.end&&period.asOf?period.end<period.asOf?'선택 기간 회고':period.start>=period.asOf?source.mode==='current'&&period.days===30?'현재 30일 관측':'향후 숙박일 관측':'과거·향후 함께 보기':'선택한 저장 기간';
    const periodLabel=period.start?`${period.start} ~ ${period.end}${period.days!==null?` · ${n(period.days)}일`:''}`:period.valid?'저장된 관측기간이 없습니다.':'숙박기간 확인 필요';
    const actions=list(input.actions).slice(0,24).filter(action=>action&&typeof action==='object');
    const limitations=strings(input.limitations);
    return `<section class="card operating-strategy" data-operating-strategy data-strategy-status="${status}"><header class="operating-strategy-heading"><div class="operating-strategy-title"><b aria-hidden="true">4</b><h2>운영 전략과 다음 행동</h2></div><span class="operating-strategy-overall is-${status}">${statusLabel}</span></header><div class="operating-strategy-context"><div><span class="operating-strategy-mode">${mode}</span><h3>${esc(text(company.name,'내 매장 확인 전'))}${count(company.rooms)!==null&&company.rooms>0?` <small>객실 ${n(company.rooms)}실</small>`:''}</h3><p>${esc(periodLabel)}${period.asOf?` · 관측 기준 ${period.asOf}`:''}</p></div>${companyId?`<a class="operating-strategy-company-link" href="#company=${encodeURIComponent(companyId)}">내 매장 근거 보기 <span aria-hidden="true">↗</span></a>`:''}</div><p class="operating-strategy-source" role="status">${esc(sourceNotice(source))} · 자료 시각 ${esc(stamp(source.generatedAt))}</p>${showFacts?metrics(summary,period):''}<div class="operating-strategy-flow"><div class="operating-strategy-subheading"><h3>내 매장의 요일별 흐름</h3><p>선택기간의 유효 관측 · 요일별 예약률과 수량</p></div>${weekdayView(showFacts?input.weekdaySegments:[])}</div><div class="operating-strategy-action-list">${actions.length?actions.map((action,index)=>actionCard(action,index,period,source,held)).join(''):`<p class="operating-strategy-empty">${source.preview===true?'리포트 계산 결과를 확인한 뒤 다음 행동을 검토할 수 있습니다.':held?'운영 전략을 표시할 내 매장·선택 기간의 저장 자료를 확인하지 못했습니다.':'현재 저장 자료에서 추가 행동 제안을 만들지 않았습니다. 관측 근거와 요일별 흐름을 확인하세요.'}</p>`}</div>${limitations.length?`<aside class="operating-strategy-limitations" aria-label="전략 판단의 한계"><strong>이 제안을 볼 때</strong><ul>${limitations.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></aside>`:''}<p class="operating-strategy-footnote">제안은 운영자가 검토할 다음 행동입니다. 공개 예약과 타채널 추정, 정상 0실과 미확인을 구분해 해석합니다.</p></section>`;
  }
  function project(report,options={}){
    if(typeof modelApi?.build!=='function')return null;
    try{return modelApi.build(report,options);}catch{return null;}
  }
  function render(report,options={}){return renderModel(project(report,options));}
  return Object.freeze({render,renderModel,project});
});
