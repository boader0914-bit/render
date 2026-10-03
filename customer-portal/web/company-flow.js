(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const choices={bookings:'예약 수량',revenue:'숙박 추정매출',rate:'추정 예약률'};
  const config=metric=>metric==='revenue'?{unit:'만원',scale:10000,series:[['publicRevenue','공개 예약 매출','public'],['phoneRevenue','방막기 추정 매출','estimate']]}:
    metric==='rate'?{unit:'%',scale:.01,series:[['reservationRate','추정 예약률','combined']]}:
      {unit:'실',scale:1,series:[['publicBookings','공개 예약','public'],['phoneBookings','방막기 추정','estimate']]};
  const quality=d=>d&&!d.missing&&!d.partial&&!d.inventoryConflict;
  function fillDays(rows) {
    const data=[...rows].filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')).sort((a,b)=>a.date.localeCompare(b.date));
    if(!data.length)return [];
    const byDate=new Map(data.map(d=>[d.date,d])),out=[];
    for(let ms=Date.parse(data[0].date+'T00:00:00Z'),end=Date.parse(data.at(-1).date+'T00:00:00Z');ms<=end;ms+=86400000){const date=new Date(ms).toISOString().slice(0,10);out.push(byDate.get(date)||{date,missing:true});}
    return out;
  }
  function chart(points,cfg,label) {
    if(!points.length)return '<p class="empty-note">흐름을 표시할 저장 자료가 없습니다.</p>';
    const values=points.flatMap(p=>cfg.series.map(([key])=>p[key])).filter(numeric).map(v=>v/cfg.scale);
    if(!values.length)return '<p class="empty-note">표시할 정상 수치가 없습니다. 오류·누락·객실 수 충돌을 확인해 주세요. 미확인은 0으로 표시하지 않습니다.</p>';
    const max=Math.max(1,...values),start=Date.parse(points[0].date),end=Date.parse(points.at(-1).date);
    const x=d=>56+(end===start ? .5 : (Date.parse(d)-start)/(end-start))*584,y=v=>176-v/max*134;
    const step=Math.max(1,Math.ceil(points.length/6));
    const gaps=points.slice(1).map((p,i)=>x(p.date)-x(points[i].date)).filter(v=>v>0),barWidth=Math.min(18,gaps.length?Math.min(...gaps)*.55:18);
    const unknown=points.filter(p=>cfg.series.some(([key])=>!numeric(p[key])));
    const axis=v=>v>=10000?`${n(v/10000)}만`:v>=1000?`${n(v/1000)}천`:n(v);
    return `<div class="company-flow-chart"><svg viewBox="0 0 688 224" role="img" aria-label="${esc(label)}. 단위 ${esc(cfg.unit)}. 방막기는 있는 날짜만 막대로, 미확인은 ×로 표시합니다."><title>${esc(label)}</title>${[0,.5,1].map(v=>`<line class="flow-grid" x1="56" x2="640" y1="${y(v*max)}" y2="${y(v*max)}"/><text x="8" y="${y(v*max)-5}">${axis(v*max)}</text>`).join('')}${[...cfg.series].sort((a,b)=>(b[2]==='estimate')-(a[2]==='estimate')).map(([key,name,tone])=>{
      if(tone==='estimate')return `<g class="flow-estimate">${points.filter(p=>numeric(p[key])&&p[key]>0&&numeric(p.phoneBookings)&&p.phoneBookings>=1).map(p=>`<rect x="${x(p.date)-barWidth/2}" y="${y(p[key]/cfg.scale)}" width="${barWidth}" height="${176-y(p[key]/cfg.scale)}" rx="2"><title>${esc(p.date)} · ${esc(name)} ${n(p[key]/cfg.scale)} ${esc(cfg.unit)}</title></rect>`).join('')}</g>`;
      const segments=[];let segment=[];for(const p of points){if(numeric(p[key]))segment.push(`${x(p.date)},${y(p[key]/cfg.scale)}`);else{if(segment.length)segments.push(segment);segment=[];}}if(segment.length)segments.push(segment);
      return `<g class="flow-${tone}">${segments.map(s=>`<polyline points="${s.join(' ')}"/>`).join('')}${points.filter(p=>numeric(p[key])).map(p=>`<circle cx="${x(p.date)}" cy="${y(p[key]/cfg.scale)}" r="3.5"><title>${esc(p.date)} · ${esc(name)} ${n(p[key]/cfg.scale)} ${esc(cfg.unit)}</title></circle>`).join('')}</g>`;
    }).join('')}${unknown.map(p=>`<text class="flow-unknown" x="${x(p.date)}" y="189" text-anchor="middle"><title>${esc(p.date)} · 미확인</title>×</text>`).join('')}${points.filter((_,i)=>i%step===0||i===points.length-1).map(p=>`<text x="${x(p.date)}" y="214" text-anchor="middle">${esc(p.date.slice(5).replace('-','/'))}</text>`).join('')}</svg></div><div class="collection-legend">${cfg.series.map(([,name,tone])=>`<span class="flow-label-${tone}">${tone==='estimate'?'▮':'●'} ${esc(name)}</span>`).join('')}<span>단위 ${esc(cfg.unit)} · × 미확인${cfg.series.some(s=>s[2]==='estimate')?' · 방막기 0은 표시 생략':''}</span></div>`;
  }
  const metricSelect=(value,id)=>`<label class="field"><span>표시 지표</span><select data-flow-metric aria-label="${id} 표시 지표">${Object.entries(choices).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('')}</select></label>`;
  function daily(rows,metric='bookings') {
    const cfg=config(metric),points=fillDays(rows).map(d=>({...d,...Object.fromEntries(cfg.series.map(([key])=>[key,quality(d)&&!(metric==='revenue'&&d.revenuePartial)&&numeric(d[key])?d[key]:null]))}));
    return `<div class="company-flow"><div class="company-flow-heading"><div><h3>숙박일별 흐름</h3><p class="muted">${esc(points[0]?.date||'')} ~ ${esc(points.at(-1)?.date||'')} · 날짜별 최신 저장 자료</p></div>${metricSelect(metric,'숙박일별')}</div>${chart(points,cfg,'숙박일별 '+choices[metric])}<p class="muted">숙박일에 예약·추정매출이 얼마나 집중되는지 보여줍니다. 상품 수가 아닌 객실 수 기준입니다.</p></div>`;
  }
  function history(flow,options={}) {
    const periods=flow?.periods||[],thisMonth=new Date(Date.now()+9*3600000).toISOString().slice(0,7);
    const selected=periods.find(p=>p.month===options.month)||periods.find(p=>p.month===thisMonth)||periods.findLast(p=>p.points.some(d=>d.status==='complete'))||periods.at(-1);
    if(!selected)return '<p class="empty-note">관측일별 비교 자료가 없습니다. 같은 숙박월의 관측이 쌓이면 흐름을 표시합니다.</p>';
    const metric=options.metric||'bookings',cfg=config(metric);if(metric==='bookings')cfg.unit='객실·박';
    const points=selected.points.map(p=>({...p,date:p.observedDate}));
    const numericPoints=points.filter(p=>cfg.series.every(([key])=>numeric(p[key]))),last=numericPoints.at(-1),previous=numericPoints.at(-2);
    const change=last&&previous?cfg.series.map(([key,label,tone])=>`<span class="flow-label-${tone}">${esc(label)} ${last[key]>=previous[key]?'+':''}${( (last[key]-previous[key])/cfg.scale).toLocaleString('ko-KR',{maximumFractionDigits:1})}${metric==='rate'?'%p':esc(cfg.unit)}</span>`).join(' · '):'동일 숙박월의 유효 관측 2회가 필요합니다.';
    return `<div class="company-flow"><div class="company-flow-heading"><div><h3>같은 숙박월의 예약 변화</h3><p class="muted">가로축은 수집한 관측일입니다.</p></div><label class="field"><span>비교할 숙박월</span><select data-flow-month>${[...periods].reverse().map(p=>`<option value="${esc(p.month)}" ${p.month===selected.month?'selected':''}>${esc(p.month)}</option>`).join('')}</select></label>${metricSelect(metric,'관측일별')}</div><p class="flow-period">숙박월 <strong>${esc(selected.start)} ~ ${esc(selected.end)}</strong>비교 대상 ${selected.comparisonDates.length}/${selected.calendarDays}일 · ${selected.completeMonth?'월 전체':'일부 숙박일 · 월 전체 합계 아님'}</p>${chart(points,cfg,'관측일별 '+choices[metric])}<p class="flow-change">${last&&previous?`${esc(previous.date)} → ${esc(last.date)} 변화 · `:''}${change}</p><p class="muted">각 관측일까지 확인한 최신 자료를 사용합니다. 그날 다시 확인하지 않은 숙박일은 이전 자료를 유지하며, 오류가 확인된 날짜는 미확인으로 바꿉니다. 모든 시점에서 같은 숙박일 묶음을 비교하며, 그중 미확인 날짜가 있으면 합계 표시를 보류합니다. 현재 DB 검수값으로 재계산한 추정이며 실제 예약 접수액·취소액은 아닙니다.</p><details><summary>관측일별 수치와 확보 범위</summary><p class="muted">고정 비교 숙박일: ${selected.comparisonDates.map(esc).join(', ')}</p><div class="collection-table-wrap"><table><thead><tr><th>관측일</th><th>정상 숙박일</th><th>당일 재관측</th>${cfg.series.map(([,name])=>`<th>${esc(name)} (${esc(cfg.unit)})</th>`).join('')}</tr></thead><tbody>${points.map(p=>`<tr><th>${esc(p.date)}</th><td>${n(p.validDays)}/${n(p.comparisonDays)}일</td><td>${n(p.freshDays)}일</td>${cfg.series.map(([key])=>`<td>${numeric(p[key])?n(p[key]/cfg.scale):'미확인'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></div>`;
  }
  const api={daily,history,chart,fillDays};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightCompanyFlow=api;
})();
