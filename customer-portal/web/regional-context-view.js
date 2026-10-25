(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightRegionalContextView=api;
})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  const n=value=>numeric(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const id=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value)?value:null;
  const month=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  const rows=value=>Array.isArray(value)?value:[];
  const failed=new Set(['missing','error','failed','unavailable','publication_pending','blocked','conflict','unknown','not_collected','mapping_missing','needs_key','cooldown','suppressed']);
  const status=value=>({ready:'정상 자료',complete:'정상 자료',observed:'정상 자료',partial:'일부 자료',missing:'자료 없음',unavailable:'자료 없음',publication_pending:'공표 대기',error:'확인 필요',failed:'확인 필요',blocked:'확인 필요',conflict:'확인 필요',unknown:'미확인',not_collected:'미수집',stale:'이전 저장 자료',mapping_missing:'지역 연결 필요',needs_key:'인증키 설정 필요',cooldown:'재확인 대기',suppressed:'비공개'})[value]||'미확인';
  const categories=[
    {key:'demand',label:'수요 흐름',note:'방문·체류·소비의 움직임',sources:['tourism_visitors','tourism_stay_spend']},
    {key:'interest',label:'관심 흐름',note:'검색 관심도의 움직임',sources:['naver_search_trend']},
    {key:'background',label:'수요 배경',note:'인구·산업의 공표 통계',prefix:'kosis_'},
    {key:'composition',label:'관광 구성',note:'관광자원 수요와 다양성',sources:['tourism_resource','tourism_diversity']}
  ];
  const belongs=(source,category)=>category.prefix?String(source?.key||'').startsWith(category.prefix):category.sources.includes(source?.key);
  const roles=group=>[group.own?'내 매장':null,group.competitor?'경쟁업체':null,group.interest?'관심지역':null].filter(Boolean);
  const companyName=(state,companyId)=>rows(state?.companies).find(c=>c.companyId===companyId)?.name||'등록 업체';
  function model(data,{state,selection={}}={}){
    const invalid=()=>({valid:false,groups:[],unresolved:[],message:'선택한 내 매장·기간의 지역 요약을 확인하지 못했습니다. 이전 조건의 지표를 표시하지 않습니다.'});
    if(!state?.customer||data?.schemaVersion!==1||data.mode!=='comparison_region_summary'||data.source!=='datalab_saved'||data.networkAttempted!==false||data.access?.summaryOnly!==true||data.access.fullAnalysis!==false||data.access.preparation!==false||!month(data.month))return invalid();
    const ownId=selection.ownCompanyId||null,requestedMonth=selection.regionMonth||selection.month||(selection.stayMode==='month'?selection.stayMonth:null);
    if(data.ownId!==ownId||requestedMonth&&requestedMonth!==data.month)return invalid();
    const relations=rows(state.customer.relations).filter(r=>['active','pending'].includes(r?.status)&&['own','competitor'].includes(r.kind));
    if(ownId&&!relations.some(r=>r.kind==='own'&&r.companyId===ownId))return invalid();
    const comparisons=new Set(rows(selection.comparisonIds).filter(value=>id(value)&&relations.some(r=>r.kind==='competitor'&&r.companyId===value)));
    const permitted=new Map(relations.filter(r=>r.kind==='own'?r.companyId===ownId:comparisons.has(r.companyId)).map(r=>[r.companyId,{kind:r.kind,status:r.status}]));
    const bindings=rows(data.bindings).filter(b=>id(b?.companyId)&&['active','pending'].includes(b.relationStatus)&&permitted.get(b.companyId)?.kind===b.kind&&permitted.get(b.companyId)?.status===b.relationStatus&&id(b.analysisRegionKey||b.regionKey));
    const full=new Set(rows(state.regions).map(r=>id(r?.id)).filter(Boolean));
    const interests=new Set(rows(state.customer.regions).filter(r=>r?.status==='active').map(r=>{
      const saved=rows(state.regions).find(s=>s.id===r.regionKey);return id(saved?.analysisRegionKey)||id(r.regionKey);
    }).filter(Boolean));
    const visible=new Map();
    for(const source of rows(data.groups).slice(0,30)){
      const regionId=id(source?.region?.id);if(!regionId)continue;
      const matched=bindings.filter(b=>(b.analysisRegionKey||b.regionKey)===regionId&&rows(source.companyIds).includes(b.companyId));
      const own=matched.some(b=>b.kind==='own'),competitor=matched.some(b=>b.kind==='competitor'),interest=rows(source.kinds).includes('interest')&&interests.has(regionId);
      if(!own&&!competitor&&!interest)continue;
      const previous=visible.get(regionId),summary=source.summary&&typeof source.summary==='object'?source.summary:{sources:[],sourceIssues:[]};
      const next={region:{id:regionId,label:source.region.label||'지역명 미확인'},own,competitor,interest,companyIds:matched.map(b=>b.companyId),pending:matched.some(b=>b.relationStatus==='pending'),status:['ready','partial','unavailable'].includes(source.status)?source.status:'unavailable',summary,full:full.has(regionId),hierarchy:matched.some(b=>b.hierarchyApplied===true),relationToOwn:own?'same':['same','cross','unknown'].includes(source.relationToOwn)?source.relationToOwn:'unknown'};
      if(previous){
        next.own||=previous.own;next.competitor||=previous.competitor;next.interest||=previous.interest;next.pending||=previous.pending;next.companyIds=[...new Set([...previous.companyIds,...next.companyIds])];next.hierarchy||=previous.hierarchy;
        if(JSON.stringify(previous.summary)!==JSON.stringify(summary)){next.summary={sources:[],sourceIssues:[{code:'DUPLICATE_REGION_SUMMARY',reason:'같은 지역의 요약 값이 달라 지표 확인이 필요합니다.'}]};next.status='unavailable';}
        if(next.own)next.relationToOwn='same';
      }
      visible.set(regionId,next);
    }
    const groups=[...visible.values()].sort((a,b)=>Number(b.own)-Number(a.own)||Number(b.competitor)-Number(a.competitor)||a.region.label.localeCompare(b.region.label,'ko'));
    const unresolved=rows(data.unresolved).filter(row=>permitted.has(row?.companyId)).slice(0,30).map(row=>({name:companyName(state,row.companyId),reason:row.reason||'업체 소재지 확인이 필요합니다.'}));
    return {valid:true,month:data.month,ownId,groups,unresolved,state};
  }
  function metricPoints(source,metric,cutoff){
    const byMonth=new Map();
    for(const point of rows(source.series).slice(0,24)){
      if(!month(point?.month)||point.month>cutoff)continue;
      const candidates=rows(point.rows).filter(row=>row?.key===metric.key),row=candidates.length===1?candidates[0]:null;
      const value=row&&numeric(row.value)&&!failed.has(point.status)&&!failed.has(row.status)?row.value:null;
      const next={month:point.month,value,status:value===null?(failed.has(point.status)?point.status:row?.status||'missing'):point.status==='partial'||row?.status==='partial'?'partial':'observed'};
      if(byMonth.has(point.month))byMonth.set(point.month,{month:point.month,value:null,status:'conflict'});else byMonth.set(point.month,next);
    }
    const ordered=[...byMonth.values()].sort((a,b)=>a.month.localeCompare(b.month));
    if(!ordered.length)return [];
    const ordinal=value=>Number(value.slice(0,4))*12+Number(value.slice(5,7))-1,last=ordinal(ordered.at(-1).month),first=Math.max(ordinal(ordered[0].month),last-11);
    return Array.from({length:last-first+1},(_,i)=>{const at=first+i,m=String(Math.floor(at/12))+'-'+String(at%12+1).padStart(2,'0');return byMonth.get(m)||{month:m,value:null,status:'missing'};});
  }
  function chart(points,label,unit){
    const known=points.filter(p=>numeric(p.value));if(!known.length)return '<p class="regional-context-empty">표시할 월별 수치가 없습니다.</p>';
    const width=520,left=30,right=502,bottom=102,height=72,max=Math.max(1,...known.map(p=>p.value)),step=(right-left)/Math.max(1,points.length-1),x=i=>points.length===1?(left+right)/2:left+i*step,y=value=>bottom-value/max*height;
    let segments=[],segment=[];for(let i=0;i<points.length;i++){if(numeric(points[i].value))segment.push(`${x(i)},${y(points[i].value)}`);else if(segment.length){segments.push(segment);segment=[];}}if(segment.length)segments.push(segment);
    return `<svg class="regional-context-chart" viewBox="0 0 ${width} 132" role="img" aria-label="${esc(label)} 월별 흐름. 정상 수치 ${known.length}개월, 미확인은 선으로 연결하지 않습니다."><title>${esc(label)} · ${esc(unit)}</title><line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/><line x1="${left}" x2="${right}" y1="${bottom-height}" y2="${bottom-height}"/><text x="2" y="${bottom-height+4}">${n(max)}</text><text x="14" y="${bottom+4}">0</text>${segments.map(s=>`<polyline points="${s.join(' ')}"/>`).join('')}${points.map((p,i)=>`${numeric(p.value)?`<circle cx="${x(i)}" cy="${y(p.value)}" r="3"><title>${esc(p.month)}: ${n(p.value)} ${esc(unit)}</title></circle>`:`<text class="regional-context-gap" x="${x(i)}" y="${bottom-4}" text-anchor="middle">—<title>${esc(p.month)} · ${esc(status(p.status))}</title></text>`}${i===0||i===points.length-1||i%3===0?`<text x="${x(i)}" y="124" text-anchor="middle">${esc(p.month.slice(2).replace('-','.'))}</text>`:''}`).join('')}</svg>`;
  }
  function delta(value){
    if(!value||typeof value.value!=='number'||!Number.isFinite(value.value))return value?.kind==='zero_baseline'?'비교 불가 · 기준값 0':'비교 자료 없음';
    const suffix=value.kind==='percent'?'%':value.kind==='index_difference'?' 지수':null;if(suffix===null)return '비교 자료 없음';
    return `${value.value>0?'+':''}${value.value.toLocaleString('ko-KR',{maximumFractionDigits:1})}${suffix}`;
  }
  function monthlySource(source,cutoff){
    const metrics=rows(source.metrics).filter(m=>typeof m?.key==='string').slice(0,20),metric=metrics[0];
    if(!metric)return `<article class="regional-context-source"><h4>${esc(source.label||'저장 지표')}</h4><p class="regional-context-empty">월별 지표 항목을 확인하지 못했습니다.</p></article>`;
    const points=metricPoints(source,metric,cutoff),known=points.filter(p=>numeric(p.value)),latest=known.at(-1),shown=latest?points.filter(p=>p.month<=latest.month):points,missing=points.filter(p=>p.value===null),lead=shown[0]?.month;
    const otherMetrics=metrics.slice(1).map(m=>{const known=metricPoints(source,m,cutoff).filter(p=>numeric(p.value)),last=known.at(-1);return `<div><dt>${esc(m.label||m.key)}</dt><dd>${n(last?.value)} ${esc(m.unit||'')}<small>${last?esc(last.month):'확보월 미확인'}</small></dd></div>`;}).join('');
    return `<article class="regional-context-source"><div class="regional-context-source-heading"><h4>${esc(source.label||'저장 지표')}</h4><span class="regional-context-source-state ${!known.length||known.length<points.length||source.status==='partial'?'is-partial':''}">${known.length}/${points.length||12}개월 확보</span></div><p class="regional-context-source-meta">${esc(source.provider||'제공기관 미확인')} · ${latest?'최신 확보 '+esc(latest.month):'확보월 미확인'}</p><div class="regional-context-value"><div><span>${esc(metric.label||metric.key)}</span><strong>${n(latest?.value)} <small>${esc(metric.unit||'')}</small></strong></div><div class="regional-context-change"><span>전월 대비</span><b>${esc(latest&&metric.latest?.month===latest.month&&metric.latest.value===latest.value?delta(metric.mom):'비교 자료 없음')}</b></div></div>${otherMetrics?'<dl class="regional-context-other-metrics">'+otherMetrics+'</dl>':''}<p class="regional-context-period">${latest?`실제 표시 ${esc(lead)} ~ ${esc(latest.month)} · ${shown.length}개월`:'실제 표시기간 미확인'}${missing.length?` · 미확인 ${missing.length}개월`:''}</p>${chart(shown,metric.label||metric.key,metric.unit||'')}${source.key==='naver_search_trend'?`<p class="regional-context-caution">${source.keyword?'검색어 '+esc(source.keyword)+' · ':''}산정기간 ${esc(source.normalizationPeriod||'미확인')}<br>조회기간의 최고값 100인 상대지수입니다. 다른 지역·산정기간과 직접 비교하지 않습니다.</p>`:''}<details class="regional-context-evidence"><summary>월별 수치·출처 <span aria-hidden="true">+</span></summary><div class="regional-context-table-wrap"><table><caption>${esc(source.label)} · 월별 저장 자료</caption><thead><tr><th>월</th>${metrics.map(m=>`<th>${esc(m.label||m.key)}${m.unit?' ('+esc(m.unit)+')':''}</th>`).join('')}<th>상태</th></tr></thead><tbody>${points.map(p=>`<tr><th>${esc(p.month)}</th>${metrics.map(m=>`<td>${n(metricPoints(source,m,cutoff).find(q=>q.month===p.month)?.value)}</td>`).join('')}<td>${esc(status(p.status))}</td></tr>`).join('')||'<tr><td colspan="2">저장 자료 없음</td></tr>'}</tbody></table></div><p>제공기관 ${esc(source.provider||'미확인')} · 원본 공표기간 ${esc(source.period||'미확인')}</p>${missing.length?`<p>미확인 월: ${missing.map(p=>`${esc(p.month)} (${esc(status(p.status))})`).join(', ')}</p>`:''}<p>미확인은 0으로 채우지 않습니다. 실제 공표월이 서로 다른 지표를 같은 달로 간주하지 않습니다.</p></details></article>`;
  }
  function backgroundSource(source){
    const values=rows(source.rows).slice(0,30),first=values.find(row=>['total','all','population','establishments','employees'].includes(row?.key))||values[0];
    const value=first&&!failed.has(first.status)?first.value:null;
    return `<article class="regional-context-source"><div class="regional-context-source-heading"><h4>${esc(source.label||'인구·산업 통계')}</h4><span class="regional-context-source-state">${esc(status(source.status))}</span></div><p class="regional-context-source-meta">${esc(source.provider||'제공기관 미확인')} · 실제 공표기간 ${esc(source.period||'미확인')}</p><div class="regional-context-value"><div><span>${esc(first?.label||'저장 수치')}</span><strong>${n(value)} <small>${esc(first?.unit||'')}</small></strong></div></div><p class="regional-context-period">${source.periodType==='Y'?'연간 통계 · 월별 값으로 환산하지 않습니다.':'공표된 기간의 배경 통계입니다.'}</p><details class="regional-context-evidence"><summary>세부 수치·출처 <span aria-hidden="true">+</span></summary><div class="regional-context-table-wrap"><table><caption>${esc(source.label)} · 실제 공표기간 ${esc(source.period||'미확인')}</caption><thead><tr><th>항목</th><th>수치</th><th>상태</th></tr></thead><tbody>${values.map(row=>`<tr><th>${esc(row.label||row.key)}</th><td>${n(failed.has(row.status)?null:row.value)} ${esc(row.unit||'')}</td><td>${esc(status(row.status||source.status))}</td></tr>`).join('')||'<tr><td colspan="3">저장 자료 없음</td></tr>'}</tbody></table></div><p>제공기관 ${esc(source.provider||'미확인')} · 공표기간 ${esc(source.period||'미확인')}</p></details></article>`;
  }
  function groupHeading(group,state,link=false){
    return `<div class="regional-context-region-heading"><div><div class="regional-context-roles">${roles(group).map(role=>`<span>${role}</span>`).join('')}</div><h3>${esc(group.region.label)}</h3></div>${link&&group.full?`<a class="regional-context-link" href="#regions=${encodeURIComponent(group.region.id)}">상세 분석 보기 →</a>`:''}</div><p class="regional-context-companies">${group.companyIds.map(companyId=>esc(companyName(state,companyId))).join(' · ')||'등록 관심지역'}${group.hierarchy?' · 시 단위로 묶음':''}</p>`;
  }
  function render(data,options={}){
    const result=model(data,options);if(!result.valid)return `<section class="regional-context-error" role="status">${esc(result.message)}</section>`;
    const groups=result.groups,state=result.state;
    if(!groups.length)return `<section class="regional-context-empty-state"><h2>지역을 연결할 자료가 없습니다.</h2><p>내 매장 소재지나 등록한 관심지역을 확인해 주세요.</p>${result.unresolved.length?`<ul>${result.unresolved.map(row=>`<li>${esc(row.name)} · ${esc(row.reason)}</li>`).join('')}</ul>`:''}</section>`;
    const cross=groups.some(g=>g.relationToOwn==='cross'&&g.competitor),normalizations=new Set(groups.flatMap(g=>rows(g.summary.sources).filter(s=>s.key==='naver_search_trend').map(s=>s.normalizationPeriod||'미확인')));
    return `<div class="regional-context" data-regional-context-month="${esc(result.month)}"><section class="regional-context-overview"><div class="regional-context-intro"><div><span>REGIONAL CONTEXT</span><h2>등록 업체의 지역을 함께 읽기</h2></div><p>요약 기준 ${esc(result.month)} · 지표별 실제 공표기간은 아래에 표시합니다.</p></div><div class="regional-context-region-grid">${groups.map(g=>`<article class="${g.own?'is-own':''}">${groupHeading(g,state,true)}<p class="regional-context-region-state">${g.own?'내 매장 기준 지역':g.relationToOwn==='cross'?'다른 지역 · 참고 비교':g.relationToOwn==='same'?'내 매장과 같은 지역':'소재지 비교 확인 필요'} · ${esc(status(g.status))}${g.pending?' · 연결 확인 대기 · 저장요약':g.full?'':' · 요약 자료'}</p></article>`).join('')}</div><p class="regional-context-caution">${cross?'타지역 경쟁업체는 지역 수요 차이를 포함한 참고자료입니다. 지역을 합산하거나 평균·보정 순위를 만들지 않습니다.':'같은 시·군의 자료는 한 번만 표시합니다. 등록 업체를 지역 전체의 평균으로 해석하지 않습니다.'}</p>${normalizations.size>1?'<p class="regional-context-caution">검색지수 산정기간이 달라 지역 간 수치의 크기를 직접 비교하지 않습니다.</p>':''}</section>${categories.map(category=>`<section class="regional-context-category" aria-label="${esc(category.label)}"><div class="regional-context-category-heading"><h2>${category.label}</h2><p>${category.note}</p></div><div class="regional-context-category-grid">${groups.map(group=>{const sources=rows(group.summary.sources).filter(source=>belongs(source,category)).slice(0,10);return `<article class="regional-context-region-card">${groupHeading(group,state)}${sources.map(source=>Array.isArray(source.series)?monthlySource(source,result.month):backgroundSource(source)).join('')||'<p class="regional-context-empty">이 종류의 저장 자료가 없습니다.</p>'}</article>`;}).join('')}</div></section>`).join('')}${result.unresolved.length||groups.some(g=>rows(g.summary.sourceIssues).length)?`<details class="regional-context-issues"><summary>지역 연결·자료 확인 사유 <span aria-hidden="true">+</span></summary><ul>${result.unresolved.map(row=>`<li><strong>${esc(row.name)}</strong> · ${esc(row.reason)}</li>`).join('')}${groups.flatMap(g=>rows(g.summary.sourceIssues).slice(0,20).map(issue=>`<li><strong>${esc(g.region.label)}</strong> · ${esc(issue.reason||'저장 지표를 확인하지 못했습니다.')}</li>`)).join('')}</ul></details>`:''}<p class="regional-context-footnote">지표는 데이터랩에 저장된 자료를 사용합니다. 지역 흐름과 예약이 함께 움직여도 원인이나 향후 예약을 확정하지 않습니다.</p></div>`;
  }
  function panel(state,selection={}){
    const own=selection.ownCompanyId?companyName(state,selection.ownCompanyId):'등록한 관심지역';
    return `<section class="regional-context-panel"><div class="regional-context-panel-heading"><span>REGIONAL CONTEXT</span><h2>지역 배경 요약</h2><p>${esc(own)}을 기준으로 등록 업체의 지역 흐름을 함께 확인합니다.</p></div><p id="regional-context-status" class="regional-context-status" role="status" aria-live="polite"></p><div id="regional-context-output" aria-live="polite"></div></section>`;
  }
  return {panel,render,model,chart,metricPoints,delta};
});
