(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightComparisonDashboardView=api;
})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const arr=v=>Array.isArray(v)?v:[];
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=v=>finite(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const ratio=v=>finite(v)&&v>=0&&v<=1;
  const rate=v=>ratio(v)?(v*100).toFixed(1)+'%':'미확인';
  const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:'';
  const short=v=>date(v)?v.slice(5).replace('-','/'):'미확인';
  const text=v=>typeof v==='string'?v:v?.label||v?.reason||v?.code||'';
  const link=id=>'#company='+encodeURIComponent(id||'');
  const relation=v=>({own:'내 매장',same:'같은 지역',cross:'다른 지역 · 참고',unknown:'지역 확인 필요'})[v]||'지역 확인 필요';
  const tone=status=>['ready','complete','reference','hold','partial','unavailable'].includes(status)?status:'hold';
  const statusLabel=status=>({ready:'저장 자료',complete:'저장 자료',reference:'참고',hold:'판단 보류',partial:'일부 자료',unavailable:'자료 미확인'})[status]||'확인 필요';
  function title(kicker,heading,detail='',id=''){
    return `<header class="dashboard-section-heading"><div><span class="dashboard-kicker">${esc(kicker)}</span><h2${id?` id="${esc(id)}"`:''}>${esc(heading)}</h2>${detail?`<p>${esc(detail)}</p>`:''}</div></header>`;
  }
  function controls(model){
    const source=model.sourcePeriod||{},filters=model.filters||{},start=date(filters.start||model.period?.start),end=date(filters.end||model.period?.end);
    const companies=arr(model.companies).filter(c=>c.kind!=='own'&&c.companyId!==model.own?.companyId),same=companies.filter(c=>c.regionRelation==='same').length,cross=companies.filter(c=>c.regionRelation==='cross').length,unknown=companies.filter(c=>!['same','cross'].includes(c.regionRelation)).length;
    return `<section class="card dashboard-controls" aria-labelledby="dashboard-conditions-heading"><header class="dashboard-section-heading"><div><span class="dashboard-kicker">01 · 비교 조건</span><h2 id="dashboard-conditions-heading">저장 자료에서 비교할 기간</h2></div><button type="button" class="button" data-dashboard-reset>전체 기간</button></header><div class="dashboard-condition-grid"><label class="field"><span>숙박 시작일</span><input type="date" aria-label="대시보드 숙박 시작일" data-dashboard-start value="${start}" min="${date(source.start)}" max="${date(source.end)}"></label><label class="field"><span>숙박 종료일</span><input type="date" aria-label="대시보드 숙박 종료일" data-dashboard-end value="${end}" min="${date(source.start)}" max="${date(source.end)}"></label><label class="field"><span>요일</span><select aria-label="대시보드 요일" data-dashboard-day-filter>${[['all','전체 요일'],['weekday','월~목'],['friday','금요일'],['saturday','토요일'],['sunday','일요일']].map(([key,label])=>`<option value="${key}" ${filters.dayFilter===key?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="dashboard-scope-notes"><span>관측 기준 <strong>${esc(date(source.asOf||model.period?.asOf)||'미확인')}</strong> · 최신 저장 자료</span><span>이전 관측 비교 미연결</span><span>선택 ${number(model.period?.days??arr(model.dates).length)}일</span><span>같은 지역 ${same} · 다른 지역 ${cross}${unknown?' · 지역 미확인 '+unknown:''}</span></div><p class="dashboard-note">${esc(date(source.start))} ~ ${esc(date(source.end))} 저장 범위에서 선택합니다. 관측 공백은 미확인으로 유지합니다.</p></section>`;
  }
  function metricValue(metric){
    if(!finite(metric.value))return '미확인';
    if(metric.unit==='%')return rate(metric.value);
    if(metric.unit==='원')return number(metric.value)+'원';
    if(metric.id==='public_change')return (metric.value>0?'+':'')+number(metric.value)+'실';
    return number(metric.value)+(metric.unit||'');
  }
  function summary(model){
    return `<section class="dashboard-metrics-section" aria-labelledby="dashboard-metrics-heading">${title('02 · 핵심 지표','선택 기간 한눈에 보기','','dashboard-metrics-heading')}<div class="dashboard-metrics">${arr(model.metrics).map(metric=>`<article class="dashboard-metric is-${tone(metric.status)}" data-dashboard-metric="${esc(metric.id)}"><span class="dashboard-metric-label">${esc(metric.label)}</span><strong>${esc(metricValue(metric))}</strong><p>${esc(metric.detail||metric.reason||'저장 근거 확인 필요')}</p>${metric.detail&&metric.reason&&metric.reason!==metric.detail?`<small>${esc(metric.reason)}</small>`:''}</article>`).join('')}</div></section>`;
  }
  function judgments(model){
    return `<section class="dashboard-judgments-section" aria-labelledby="dashboard-judgments-heading"><header class="dashboard-section-heading"><div><span class="dashboard-kicker">03 · 판단 카드</span><h2 id="dashboard-judgments-heading">먼저 검토할 판단</h2></div><span class="dashboard-readonly">검토용 · 자동 실행 없음</span></header><div class="dashboard-judgments">${arr(model.judgments).map((judgment,index)=>`<article class="dashboard-judgment is-${tone(judgment.status)}"><div class="dashboard-judgment-top"><span>${esc(judgment.label)}</span><span class="dashboard-status is-${tone(judgment.status)}">${statusLabel(judgment.status)}</span></div><h3>${esc(judgment.title)}</h3>${judgment.reason?`<p>${esc(judgment.reason)}</p>`:''}<p class="dashboard-next-action">${esc(judgment.nextAction||'날짜별 저장 근거를 확인합니다.')}</p><details data-dashboard-detail="judgment-${index}"><summary>근거와 적용 범위 <b aria-hidden="true">+</b></summary><ul>${arr(judgment.evidence).map(e=>`<li>${esc(text(e))}</li>`).join('')||'<li>비교 가능한 저장 근거가 없습니다.</li>'}</ul></details></article>`).join('')}</div></section>`;
  }
  function compositionRows(model){
    return arr(model.companies).map(company=>{
      const s=company.summary||{},supply=s.supply,publicRate=finite(s.publicBookings)&&finite(supply)&&supply>0?s.publicBookings/supply:null,inferredRate=finite(s.phoneBookings)&&finite(supply)&&supply>0?s.phoneBookings/supply:null;
      const valid=ratio(s.reservationRate??s.rate)&&ratio(publicRate)&&ratio(inferredRate)&&publicRate+inferredRate<=1.000001;
      const isOwn=company.companyId===model.own?.companyId||company.kind==='own';
      const label=`${company.name||'업체'} · ${valid?'예약률 '+rate(s.reservationRate??s.rate)+' · 공개 '+number(s.publicBookings)+'실 + 타채널 추정 '+number(s.phoneBookings)+'실 / 공급 '+number(supply)+'실':'예약률 미확인'} · 확보 ${number(s.days)}일`;
      return `<div class="dashboard-company-bar ${isOwn?'is-own':''}"><div class="dashboard-company-name"><a href="${link(company.companyId)}">${esc(company.name||'업체')}</a><small>${isOwn?'내 매장':relation(company.regionRelation)} · ${finite(company.rooms)?number(company.rooms)+'실':'객실 미확인'}</small></div><div class="dashboard-bar-cell"><div class="dashboard-bar-track" role="img" aria-label="${esc(label)}">${valid?`<span class="dashboard-public-bar" style="width:${Math.max(0,Math.min(100,publicRate*100)).toFixed(5)}%"></span><span class="dashboard-inferred-bar" style="width:${Math.max(0,Math.min(100,inferredRate*100)).toFixed(5)}%"></span>${s.publicBookings===0&&s.phoneBookings===0?'<span class="dashboard-zero-dot" aria-hidden="true"></span>':''}`:'<span class="dashboard-bar-unknown">미확인</span>'}</div><small>확보 ${number(s.days)} / ${number(model.period?.days)}일</small></div><strong class="dashboard-bar-value">${valid?rate(s.reservationRate??s.rate):'미확인'}</strong></div>`;
    }).join('');
  }
  function legend(){return '<div class="dashboard-legend"><span><i class="dashboard-public-dot" aria-hidden="true"></i>공개 예약</span><span><i class="dashboard-inferred-dot" aria-hidden="true"></i>타채널 추정</span><span>● 정상 0실 · 미확인 제외</span></div>';}
  function rateFlow(model){
    const rows=arr(model.daily),left=38,right=624,top=20,bottom=170,height=150;
    if(!rows.length)return '<p class="dashboard-empty">선택한 조건의 숙박일 자료가 없습니다.</p>';
    if(!rows.some(row=>ratio(row.ownRate)||ratio(row.peerRate)))return '<p class="dashboard-empty">선택 기간에 유효한 일별 표시 자료가 없습니다. 미확인 날짜와 원본 근거는 상세 근거에서 확인하세요.</p>';
    const x=i=>left+(rows.length===1?(right-left)/2:(right-left)*i/(rows.length-1)),y=v=>bottom-v*height;
    function series(key,className,label){
      const parts=[];let run=[];
      const flush=()=>{if(run.length>1)parts.push(`<polyline class="${className}" points="${run.map(p=>`${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}"/>`);run=[];};
      rows.forEach((row,i)=>{if(!ratio(row[key])){flush();return;}run.push({x:x(i),y:y(row[key])});});flush();
      return parts.join('')+rows.map((row,i)=>ratio(row[key])?`<circle class="${className}-point" cx="${x(i).toFixed(2)}" cy="${y(row[key]).toFixed(2)}" r="2.7"><title>${esc(row.date)} · ${esc(label)} ${rate(row[key])}</title></circle>`:'').join('');
    }
    const grid=[0,.5,1].map(v=>`<line class="dashboard-chart-grid" x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}"/><text x="${left-8}" y="${y(v)+4}" text-anchor="end">${v*100}%</text>`).join('');
    const ticks=rows.map((row,i)=>i===0||i===rows.length-1||i%7===0&&i<rows.length-3?`<text x="${x(i).toFixed(2)}" y="193" text-anchor="middle">${esc(short(row.date))}</text>`:'').join('');
    const table=rows.map(row=>`<tr><th scope="row">${esc(row.date)}</th><td>${rate(row.ownRate)}</td><td>${rate(row.peerRate)}</td><td>${finite(row.peerCompanyCount)?number(row.peerCompanyCount)+'곳':'미확인'}</td></tr>`).join('');
    return `<div class="dashboard-flow-legend"><span><i class="dashboard-own-line" aria-hidden="true"></i>${esc(model.own?.name||'내 매장')}</span><span><i class="dashboard-peer-line" aria-hidden="true"></i>같은 지역·업종 표본</span></div><svg class="dashboard-rate-flow" viewBox="0 0 640 210" role="img" aria-label="선택 숙박일별 내 매장과 같은 지역·업종 표본 예약률. 관측 공백은 선으로 연결하지 않습니다.">${grid}${series('peerRate','dashboard-peer-series','같은 지역·업종 표본')}${series('ownRate','dashboard-own-series',model.own?.name||'내 매장')}${ticks}</svg><p class="dashboard-note">숙박일별 예약 수준입니다. 예약 접수일 흐름·실제 예약 리드타임과 구별하며 미확인 날짜 사이는 연결하지 않습니다.</p><details class="dashboard-flow-numbers" data-dashboard-detail="flow-numbers"><summary>날짜별 수치 <b aria-hidden="true">+</b></summary><div class="dashboard-table-scroll" tabindex="0" aria-label="숙박일별 예약률 수치"><table><caption class="sr-only">숙박일별 예약률과 유효 비교업체 수</caption><thead><tr><th>숙박일</th><th>내 매장</th><th>같은 지역·업종</th><th>유효 표본</th></tr></thead><tbody>${table}</tbody></table></div></details>`;
  }
  function graphs(model){
    return `<section class="dashboard-graphs-section" aria-labelledby="dashboard-graphs-heading"><header class="dashboard-section-heading"><div><span class="dashboard-kicker">04 · 비교 그래프</span><h2 id="dashboard-graphs-heading">예약 수준과 날짜별 흐름</h2></div></header><div class="dashboard-graphs"><article class="card dashboard-composition"><header><h3>업체별 추정 예약률</h3><p>등록한 업체의 확보 자료 기준</p></header>${legend()}<div class="dashboard-company-bars">${compositionRows(model)||'<p class="dashboard-empty">등록한 비교업체 자료가 없습니다.</p>'}</div><div class="dashboard-bar-scale" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></div><p class="dashboard-note">업체별 확보일이 다를 수 있습니다. 타지역은 별도 참고이며, 같은 조건 비교 여부는 상세 근거에서 확인합니다.</p></article><article class="card dashboard-flow"><header><h3>숙박일별 예약률 흐름</h3><p>내 매장과 같은 지역·업종의 유효 공통 관측</p></header>${rateFlow(model)}</article></div></section>`;
  }
  function render(model){
    if(!model?.contextValid)return '<section class="card dashboard-empty" role="status">선택한 고객·매장·기간의 저장 자료를 확인한 뒤 비교 대시보드를 표시합니다.</section>';
    return `<div class="comparison-dashboard" data-comparison-dashboard>${controls(model)}${summary(model)}${judgments(model)}${graphs(model)}</div>`;
  }
  return {render,controls,summary,judgments,graphs,metricValue,rateFlow};
});
