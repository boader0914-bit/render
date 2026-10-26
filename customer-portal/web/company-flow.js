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
    const axis=v=>v>=10000?`${n(v/10000)}만`:v>=1000?`${n(v/1000)}천`:n(v);
    return `<div class="company-flow-chart"><svg viewBox="0 0 688 224" role="img" aria-label="${esc(label)}. 단위 ${esc(cfg.unit)}. 누락 구간은 연결하지 않습니다."><title>${esc(label)}</title>${[0,.5,1].map(v=>`<line class="flow-grid" x1="56" x2="640" y1="${y(v*max)}" y2="${y(v*max)}"/><text x="8" y="${y(v*max)-5}">${axis(v*max)}</text>`).join('')}${cfg.series.map(([key,name,tone])=>{
      const segments=[];let segment=[];for(const p of points){if(numeric(p[key]))segment.push(`${x(p.date)},${y(p[key]/cfg.scale)}`);else{if(segment.length)segments.push(segment);segment=[];}}if(segment.length)segments.push(segment);
      return `<g class="flow-${tone}">${segments.map(s=>`<polyline points="${s.join(' ')}"/>`).join('')}${points.filter(p=>numeric(p[key])).map(p=>`<circle cx="${x(p.date)}" cy="${y(p[key]/cfg.scale)}" r="3.5"><title>${esc(p.date)} · ${esc(name)} ${n(p[key]/cfg.scale)} ${esc(cfg.unit)}</title></circle>`).join('')}</g>`;
    }).join('')}${points.filter((_,i)=>i%step===0||i===points.length-1).map(p=>`<text x="${x(p.date)}" y="206" text-anchor="middle">${esc(p.date.slice(5).replace('-','/'))}</text>`).join('')}</svg></div><div class="collection-legend">${cfg.series.map(([,name,tone])=>`<span class="flow-label-${tone}">● ${esc(name)}</span>`).join('')}<span>단위 ${esc(cfg.unit)} · 미확인은 선을 끊어 표시</span></div>`;
  }
  const metricSelect=(value,id)=>`<label class="field"><span>표시 지표</span><select data-flow-metric aria-label="${id} 표시 지표">${Object.entries(choices).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('')}</select></label>`;
  function daily(rows) {
    const points=fillDays(rows);
    if(!points.length)return '<p class="empty-note">표시할 예약 관측 자료가 없습니다.</p>';
    const valid=d=>!d.missing&&!d.inventoryConflict&&numeric(d.publicBookings)&&numeric(d.phoneBookings);
    // These are the existing companyDB quantities, not a new inventory estimate.
    const totals=points.filter(valid).map(d=>d.publicBookings+d.phoneBookings);
    const max=Math.max(2,Math.ceil(Math.max(0,...totals)/2)*2),left=50,right=658,top=22,bottom=140,width=right-left,step=width/points.length;
    const barWidth=Math.min(28,step*.65),x=i=>left+step*(i+.5),height=value=>value/max*(bottom-top);
    // Only horizontal coordinates follow the container. Text and vertical
    // geometry remain CSS pixels so narrow screens do not shrink the labels.
    const percent=value=>`${value/688*100}%`;
    const labelStep=Math.max(1,Math.ceil(points.length/8));
    const showDateLabel=i=>i===0||i===points.length-1||i%labelStep===0&&i<=points.length-1-labelStep;
    const mobileDateLabels=new Set([0,Math.round((points.length-1)/3),Math.round((points.length-1)*2/3),points.length-1]);
    const bars=points.map((d,i)=>{
      const cx=x(i),dateLabel=esc(d.date);
      if(!valid(d))return `<g class="flow-missing"><line x1="${percent(cx-3)}" x2="${percent(cx+3)}" y1="${bottom-8}" y2="${bottom-2}"/><line x1="${percent(cx-3)}" x2="${percent(cx+3)}" y1="${bottom-2}" y2="${bottom-8}"/><title>${dateLabel} · 미확인${d.inventoryConflict?' · 객실 수 검토 필요':''}</title></g>`;
      const publicHeight=height(d.publicBookings),blockedHeight=height(d.phoneBookings),total=d.publicBookings+d.phoneBookings;
      const warning=d.partial?' · 일부 확인 필요':'';
      const title=`${d.date} · 공개 예약 ${n(d.publicBookings)}실 + 방막기 ${n(d.phoneBookings)}실 · 합계 ${n(total)}실${warning}`;
      return `<g aria-label="${esc(title)}"><title>${esc(title)}</title>${d.publicBookings>0?`<rect class="flow-public" x="${percent(cx-barWidth/2)}" y="${bottom-publicHeight}" width="${percent(barWidth)}" height="${publicHeight}"/>`:''}${d.phoneBookings>0?`<rect class="flow-estimate" x="${percent(cx-barWidth/2)}" y="${bottom-publicHeight-blockedHeight}" width="${percent(barWidth)}" height="${blockedHeight}"/>`:''}${total===0?`<circle class="flow-zero" cx="${percent(cx)}" cy="${bottom}" r="2"><title>${dateLabel} · ${d.partial?'확인된 예약 0실 · 일부 확인 필요':'정상 응답 · 예약 0실'}</title></circle>`:''}${d.partial?`<text class="flow-partial" x="${percent(cx)}" y="${bottom-publicHeight-blockedHeight-5}" text-anchor="middle">!</text>`:''}</g>`;
    }).join('');
    const dateLabels=(show,className)=>points.map((d,i)=>show(i)?`<text class="${className}" x="${percent(x(i))}" y="166" text-anchor="middle">${esc(d.date.slice(5).replace('-','/'))}</text>`:'').join('');
    return `<div class="company-flow"><h3>예약 수량 <small class="flow-unit">객실 수</small></h3><div class="company-flow-chart company-booking-chart"><svg width="100%" height="190" role="img" aria-label="날짜별 추정 예약 막대그래프. 공개 예약과 방막기를 합산하며, 단위는 객실 수입니다. 미확인은 0실과 구분합니다."><title>공개 예약과 방막기의 날짜별 합계</title>${[0,.5,1].map(ratio=>{const value=max*ratio,y=bottom-height(value);return `<line class="flow-grid" x1="${percent(left)}" x2="${percent(right)}" y1="${y}" y2="${y}"/><text x="${percent(8)}" y="${y+4}">${n(value)}</text>`;}).join('')}${bars}${dateLabels(showDateLabel,'flow-date-desktop')}${dateLabels(i=>mobileDateLabels.has(i),'flow-date-mobile')}</svg></div><div class="collection-legend"><span class="flow-label-public">● 공개 예약</span><span class="flow-label-estimate">● 방막기</span><span>× 미확인 · ● 정상 0실</span>${points.some(d=>d.partial)?'<span>! 일부 확인 필요</span>':''}</div></div>`;
  }
  function history(flow,options={}) {
    const periods=flow?.periods||[],thisMonth=new Date(Date.now()+9*3600000).toISOString().slice(0,7);
    const selected=periods.find(p=>p.month===options.month)||periods.find(p=>p.month===thisMonth)||periods.findLast(p=>p.points.some(d=>d.status==='complete'))||periods.at(-1);
    if(!selected)return '<p class="empty-note">관측일별 비교 자료가 없습니다. 같은 숙박월의 관측이 쌓이면 흐름을 표시합니다.</p>';
    const metric=options.metric||'bookings',cfg=config(metric);
    const points=selected.points.map(p=>({...p,date:p.observedDate}));
    const numericPoints=points.filter(p=>cfg.series.every(([key])=>numeric(p[key]))),last=numericPoints.at(-1),previous=numericPoints.at(-2);
    const change=last&&previous?cfg.series.map(([key,label,tone])=>`<span class="flow-label-${tone}">${esc(label)} ${last[key]>=previous[key]?'+':''}${( (last[key]-previous[key])/cfg.scale).toLocaleString('ko-KR',{maximumFractionDigits:1})}${metric==='rate'?'%p':esc(cfg.unit)}</span>`).join(' · '):'동일 숙박월의 유효 관측 2회가 필요합니다.';
    return `<div class="company-flow"><div class="company-flow-heading"><div><h3>같은 숙박월의 예약 변화</h3><p class="muted">가로축은 수집한 관측일입니다.</p></div><label class="field"><span>비교할 숙박월</span><select data-flow-month>${[...periods].reverse().map(p=>`<option value="${esc(p.month)}" ${p.month===selected.month?'selected':''}>${esc(p.month)}</option>`).join('')}</select></label>${metricSelect(metric,'관측일별')}</div><p class="flow-period">숙박월 <strong>${esc(selected.start)} ~ ${esc(selected.end)}</strong>비교 대상 ${selected.comparisonDates.length}/${selected.calendarDays}일 · ${selected.completeMonth?'월 전체':'일부 숙박일 · 월 전체 합계 아님'}</p>${chart(points,cfg,'관측일별 '+choices[metric])}<p class="flow-change">${last&&previous?`${esc(previous.date)} → ${esc(last.date)} 변화 · `:''}${change}</p><p class="muted">각 관측일까지 확인한 최신 자료를 사용합니다. 그날 다시 확인하지 않은 숙박일은 이전 자료를 유지하며, 오류가 확인된 날짜는 미확인으로 바꿉니다. 모든 시점에서 같은 숙박일 묶음을 비교하며, 그중 미확인 날짜가 있으면 합계 표시를 보류합니다. 현재 DB 검수값으로 재계산한 추정이며 실제 예약 접수액·취소액은 아닙니다.</p><details><summary>관측일별 수치와 확보 범위</summary><p class="muted">고정 비교 숙박일: ${selected.comparisonDates.map(esc).join(', ')}</p><div class="collection-table-wrap"><table><thead><tr><th>관측일</th><th>정상 숙박일</th><th>당일 재관측</th>${cfg.series.map(([,name])=>`<th>${esc(name)} (${esc(cfg.unit)})</th>`).join('')}</tr></thead><tbody>${points.map(p=>`<tr><th>${esc(p.date)}</th><td>${n(p.validDays)}/${n(p.comparisonDays)}일</td><td>${n(p.freshDays)}일</td>${cfg.series.map(([key])=>`<td>${numeric(p[key])?n(p[key]/cfg.scale):'미확인'}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></div>`;
  }
  const api={daily,history,chart,fillDays};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightCompanyFlow=api;
})();
