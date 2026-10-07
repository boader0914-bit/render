(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const choices={bookings:'예약 수량',revenue:'매출',rate:'예약률'};
  const config=metric=>metric==='revenue'?{unit:'만원',scale:10000,series:[['publicRevenue','네이버','public'],['phoneRevenue','타채널·전화','estimate']]}:
    metric==='rate'?{unit:'%',scale:.01,series:[['reservationRate','추정 예약률','combined']]}:
      {unit:'실',scale:1,series:[['publicBookings','네이버','public'],['phoneBookings','타채널·전화','estimate']]};
  const quality=d=>d&&!d.missing&&!d.partial&&!d.inventoryConflict;
  function dailyRate(d) {
    if(!quality(d)||!numeric(d.total)||d.total<=0||!numeric(d.publicBookings)||!numeric(d.phoneBookings))return null;
    const sold=d.publicBookings+d.phoneBookings,rate=sold/d.total;
    if(rate>1)return null;
    if(d.sold!=null&&(!numeric(d.sold)||Math.abs(d.sold-sold)>1e-6))return null;
    // The central daily projection rounds reservationRate to four decimal places.
    if(d.reservationRate!=null&&(!numeric(d.reservationRate)||d.reservationRate>1||Math.abs(d.reservationRate-rate)>0.0000500001))return null;
    return rate;
  }
  function fillDays(rows) {
    const data=[...rows].filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')).sort((a,b)=>a.date.localeCompare(b.date));
    if(!data.length)return [];
    const byDate=new Map(data.map(d=>[d.date,d])),out=[];
    for(let ms=Date.parse(data[0].date+'T00:00:00Z'),end=Date.parse(data.at(-1).date+'T00:00:00Z');ms<=end;ms+=86400000){const date=new Date(ms).toISOString().slice(0,10);out.push(byDate.get(date)||{date,missing:true});}
    return out;
  }
  const legend=()=>'<div class="collection-legend flow-legend"><span class="flow-label-public">■ 네이버 관측</span><span class="flow-label-estimate">■ 타채널·전화 추정</span><span class="flow-label-combined">━ 합계</span></div>';
  function chart(points,cfg,label) {
    if(!points.length)return '<p class="empty-note">흐름을 표시할 저장 자료가 없습니다.</p>';
    const stacked=cfg.series.length===2;
    const total=p=>cfg.series.every(([key])=>numeric(p[key]))?cfg.series.reduce((sum,[key])=>sum+p[key],0):null;
    const values=points.map(total).filter(numeric).map(v=>v/cfg.scale);
    if(!values.length&&!cfg.showEmpty)return '<p class="empty-note">표시할 정상 수치가 없습니다. 미확인은 0으로 표시하지 않습니다.</p>';
    const max=numeric(cfg.max)&&cfg.max>0?cfg.max:Math.max(1,...values),start=Date.parse(points[0].date),end=Date.parse(points.at(-1).date);
    const chartWidth=cfg.wide?960:480;
    const x=d=>52+(end===start ? .5 :(Date.parse(d)-start)/(end-start))*(chartWidth-88),y=v=>204-v/max*166;
    const step=points.length<=7?1:Math.ceil(points.length/5);
    const gaps=points.slice(1).map((p,i)=>x(p.date)-x(points[i].date)).filter(v=>v>0),width=Math.min(28,gaps.length?Math.min(...gaps)*.58:28);
    const axis=v=>v>=10000?`${n(v/10000)}만`:v>=1000?`${n(v/1000)}천`:n(v);
    const segments=[];let segment=[];
    for(const p of points){const v=total(p);if(numeric(v))segment.push(`${x(p.date)},${y(v/cfg.scale)}`);else{if(segment.length)segments.push(segment);segment=[];}}
    if(segment.length)segments.push(segment);
    return `<div class="company-flow-chart"><svg viewBox="0 0 ${chartWidth} 252" role="group" aria-label="${esc(label)}. 단위 ${esc(cfg.unit)}"><title>${esc(label)}</title>${(cfg.ticks||[0,.25,.5,.75,1]).map(v=>`<line class="flow-grid" x1="52" x2="${chartWidth-26}" y1="${y(v*max)}" y2="${y(v*max)}"/><text x="6" y="${y(v*max)+4}">${axis(v*max)}${cfg.axisUnit?esc(cfg.unit):''}</text>`).join('')}${points.map(p=>{
      const v=total(p),valid=numeric(v),selected=p.date===cfg.selectedDate;
      const tooltip=cfg.tooltip?cfg.tooltip(p):`${p.date} · ${cfg.valueLabel||'합계'} ${valid?n(v/cfg.scale):'미확인'}${valid?' '+cfg.unit:''}`+(stacked?' · '+cfg.series.map(([key,name])=>`${name} ${numeric(p[key])?n(p[key]/cfg.scale)+' '+cfg.unit:'미확인'}`).join(' · '):'');
      let base=0;
      const bars=stacked?cfg.series.map(([key,name,tone])=>{
        const value=p[key];if(!numeric(value))return '';
        const bottom=base;base+=value/cfg.scale;
        if(!valid||value===0)return '';
        return `<rect class="flow-${tone}" x="${x(p.date)-width/2}" y="${y(base)}" width="${width}" height="${y(bottom)-y(base)}"><title>${esc(cfg.tooltip?tooltip:`${p.date} · ${name} ${n(value/cfg.scale)} ${cfg.unit}`)}</title></rect>`;
      }).join(''):'';
      return `<g ${cfg.selectable?`role="button" tabindex="0" data-company-date="${esc(p.date)}" aria-pressed="${selected}"`:''} aria-label="${esc(tooltip)}"><title>${esc(tooltip)}</title>${selected?`<rect class="flow-selection" x="${x(p.date)-Math.max(12,width/2+4)}" y="24" width="${Math.max(24,width+8)}" height="216" rx="4"/>`:''}<rect class="flow-hit" x="${x(p.date)-Math.max(6,width/2)}" y="24" width="${Math.max(12,width)}" height="216"/>${bars}${valid?(!cfg.barsOnly||v===0?`<circle class="flow-combined" cx="${x(p.date)}" cy="${y(v/cfg.scale)}" r="3.5"/>`:''):`<text class="flow-unknown" x="${x(p.date)}" y="216" text-anchor="middle">×</text>`}</g>`;
    }).join('')}${cfg.barsOnly?'':`<g class="flow-combined flow-total-line" aria-hidden="true">${segments.map(s=>`<polyline points="${s.join(' ')}"/>`).join('')}</g>`}${points.filter((_,i)=>i===0||i===points.length-1||(i%step===0&&points.length-1-i>=step*.6)).map(p=>`<text x="${x(p.date)}" y="240" text-anchor="middle">${esc(p.date.slice(5).replace('-','/'))}</text>`).join('')}</svg></div>${cfg.hideLegend?'':stacked?legend():`<div class="collection-legend"><span>단위 ${esc(cfg.unit)}</span></div>`}`;
  }
  const metricSelect=(value,id)=>`<label class="field"><span>표시 지표</span><select data-flow-metric aria-label="${id} 표시 지표">${Object.entries(choices).map(([k,v])=>`<option value="${k}" ${k===value?'selected':''}>${v}</option>`).join('')}</select></label>`;
  function daily(rows,options={}) {
    if(typeof options==='string')options={};
    const filled=fillDays(rows);
    const points=filled.map(d=>{const valid=dailyRate(d)!=null;return {...d,publicRate:valid?d.publicBookings/d.total:null,phoneRate:valid?d.phoneBookings/d.total:null};});
    const cfg={unit:'%',scale:.01,series:[['publicRate','네이버','public'],['phoneRate','타채널·전화','estimate']],hideLegend:true,selectable:true,selectedDate:options.selectedDate,max:100,ticks:[0,.5,1],axisUnit:true,showEmpty:true,wide:true,barsOnly:true,
      tooltip:p=>dailyRate(p)==null?`${p.date} · 예약률 미확인 · 예약 미확인`:`${p.date} · 예약률 ${n(dailyRate(p)*100)} % · 예약 ${n(p.publicBookings+p.phoneBookings)}실 / 전체 ${n(p.total)}실 · 네이버 ${n(p.publicBookings)}실 · 타채널·전화 ${n(p.phoneBookings)}실`};
    return `<div class="company-flow company-reservation-flow"><div class="company-flow-heading"><div><h3>예약 흐름</h3><p class="muted">날짜별 추정 예약률·수량</p></div><span class="muted">${esc(filled[0]?.date||'')} ~ ${esc(filled.at(-1)?.date||'')}</span></div><div class="collection-legend flow-legend"><span class="flow-label-public">■ 네이버 관측</span><span class="flow-label-estimate">■ 타채널·전화 추정</span><span>× 미확인</span></div><section class="company-chart-panel company-rate-panel" data-chart-metric="rate">${chart(points,cfg,'날짜별 추정 예약률과 예약 수량')}</section></div>`;
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
  const api={daily,history,chart,fillDays,dailyRate};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightCompanyFlow=api;
})();
