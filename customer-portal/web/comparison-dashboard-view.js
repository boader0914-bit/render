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
  const reasonLabels=Object.freeze({OBSERVATION_DATE_MISMATCH:'관측일 차이로 비교 보류',OBSERVATION_DAY_MISMATCH:'관측일 차이로 비교 보류',
    NO_COMMON_OBSERVATION:'공통 관측 없음',NO_ELIGIBLE_PEERS:'동일지역·업종 표본 없음',INSUFFICIENT_COMMON_DAYS:'공통 관측일 부족',INSUFFICIENT_COMMON_OBSERVATIONS:'공통 관측일 부족',
    PRICE_NOT_FOUND:'가격 자료 없음',NO_PRICE_DATA:'가격 자료 없음',PRICE_UNAVAILABLE:'가격 자료 없음',
    NO_PREVIOUS_OBSERVATION:'이전 관측 없음',NO_PICKUP_INTERVALS:'이전 관측 없음',PICKUP_NOT_CONNECTED:'저장 이력 미연결',
    HISTORY_NOT_CONNECTED:'저장 이력 미연결',SOURCE_NOT_CONNECTED:'저장 자료 미연결',LOADING:'저장 자료 조회 중',
    SOURCE_LOADING:'저장 자료 조회 중',FETCH_FAILED:'저장 자료 조회 실패',SOURCE_FAILED:'저장 자료 조회 실패',SOURCE_READ_FAILED:'저장 자료 조회 실패',
    NO_SELECTED_DATES:'선택 날짜 자료 없음',OUTSIDE_SELECTION:'선택 기간 자료 없음',CONTEXT_MISMATCH:'업체·기간 확인 필요',
    SOURCE_CONTEXT_MISMATCH:'업체·기간 확인 필요',PRICE_NOT_CONNECTED:'저장 자료 미연결',PRICE_MISSING:'가격 자료 없음',
    PRICE_PARTIAL:'일부 가격 자료',PRICE_DUPLICATE_CONFLICT:'가격 중복 충돌',PICKUP_NO_PREVIOUS_OBSERVATION:'이전 관측 없음',
    PICKUP_OUTSIDE_SELECTED_DATES:'선택 기간 비교 없음',PICKUP_INVALID_EVIDENCE:'관측 근거 확인 필요',
    PICKUP_REFERENCE_ONLY:'관측 변화 · 참고',PICKUP_PUBLIC_ONLY_REFERENCE:'공개예약만 비교 · 참고',PICKUP_RECENT_SUBSET:'일부 관측 변화 · 참고'});
  const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  const missingLabel=metric=>metric?.reasonLabel||reasonLabels[metric?.reasonCode]||(!finite(metric?.value)?'자료 미확인':metric?.status==='reference'?'관측 변화 · 참고':metric?.status==='partial'?'일부 저장 자료':'저장 자료');
  function title(kicker,heading,detail='',id=''){
    return `<header class="dashboard-section-heading"><div><span class="dashboard-kicker">${esc(kicker)}</span><h2${id?` id="${esc(id)}"`:''}>${esc(heading)}</h2>${detail?`<p>${esc(detail)}</p>`:''}</div></header>`;
  }
  function controls(model,options={}){
    const source=model.sourcePeriod||{},filters=model.filters||{},start=date(filters.start||model.period?.start),end=date(filters.end||model.period?.end);
    const pickup=arr(model.metrics).find(m=>m.id==='public_change'),pickupNotice=finite(pickup?.value)?'이전·현재 저장 관측 비교 · 참고':pickup?.reasonCode?missingLabel(pickup):'이전 관측 비교 미연결';
    const companies=arr(model.companies).filter(c=>c.kind!=='own'&&c.companyId!==model.own?.companyId),same=companies.filter(c=>c.regionRelation==='same').length,cross=companies.filter(c=>c.regionRelation==='cross').length,unknown=companies.filter(c=>!['same','cross'].includes(c.regionRelation)).length;
    const body=`<div class="dashboard-condition-grid"><label class="field"><span>숙박 시작일</span><input type="date" aria-label="대시보드 숙박 시작일" data-dashboard-start value="${start}" min="${date(source.start)}" max="${date(source.end)}"></label><label class="field"><span>숙박 종료일</span><input type="date" aria-label="대시보드 숙박 종료일" data-dashboard-end value="${end}" min="${date(source.start)}" max="${date(source.end)}"></label><label class="field"><span>요일</span><select aria-label="대시보드 요일" data-dashboard-day-filter>${[['all','전체 요일'],['weekday','월~목'],['friday','금요일'],['saturday','토요일'],['sunday','일요일']].map(([key,label])=>`<option value="${key}" ${filters.dayFilter===key?'selected':''}>${label}</option>`).join('')}</select></label></div><div class="dashboard-scope-notes"><span>관측 기준 <strong>${esc(date(source.asOf||model.period?.asOf)||'미확인')}</strong> · 최신 저장 자료</span><span>${esc(pickupNotice)}</span><span>선택 ${number(model.period?.days??arr(model.dates).length)}일</span><span>같은 지역 ${same} · 다른 지역 ${cross}${unknown?' · 지역 미확인 '+unknown:''}</span></div>`;
    if(options?.embedded===true)return body;
    return `<section class="card dashboard-controls" aria-labelledby="dashboard-conditions-heading"><header class="dashboard-section-heading"><div><span class="dashboard-kicker">01 · 비교 조건</span><h2 id="dashboard-conditions-heading">저장 자료에서 비교할 기간</h2></div><button type="button" class="button" data-dashboard-reset>전체 기간</button></header>${body}<p class="dashboard-note">${esc(date(source.start))} ~ ${esc(date(source.end))} 저장 범위에서 선택합니다. 관측 공백은 미확인으로 유지합니다.</p></section>`;
  }
  function metricValue(metric){
    if(!finite(metric.value))return '미확인';
    if(metric.unit==='%')return rate(metric.value);
    if(metric.unit==='원')return number(metric.value)+'원';
    if(metric.id==='public_change')return (metric.value>0?'+':'')+number(metric.value)+'실';
    return number(metric.value)+(metric.unit||'');
  }
  function metricEvidence(metric){
    const evidence=arr(metric?.evidence).map(text).filter(Boolean);
    if(!evidence.length)return '';
    return `<details class="dashboard-metric-evidence" data-dashboard-detail="metric-${esc(metric.id)}"><summary>계산 근거 <b aria-hidden="true">+</b></summary><ul>${evidence.map(row=>`<li>${esc(row)}</li>`).join('')}</ul></details>`;
  }
  function savedMetricProvenance(metric){
    const source=metric?.source||{},parts=[];
    if(stamp(source.collectedAt))parts.push('관측 '+stamp(source.collectedAt));
    if(stamp(source.previousObservedAt)&&stamp(source.currentObservedAt))parts.push(stamp(source.previousObservedAt)+' → '+stamp(source.currentObservedAt));
    if(source.runId)parts.push('수집번호 '+source.runId);
    if(source.previousRunId)parts.push('이전 수집번호 '+source.previousRunId);
    if(source.currentRunId)parts.push('현재 수집번호 '+source.currentRunId);
    if(source.calculationVersion)parts.push('계산 기준 '+source.calculationVersion);
    if(typeof source.sourceDigests?.previous==='string'&&typeof source.sourceDigests?.current==='string')parts.push('원본 지문 '+source.sourceDigests.previous.slice(0,12)+'… → '+source.sourceDigests.current.slice(0,12)+'…');
    return [...new Set(parts)];
  }
  function savedCell(metric,kind){
    const m=metric||{},numeric=finite(m.value),parts=[],proof=savedMetricProvenance(m),limitations=arr(m.limitations).map(text).filter(Boolean);
    if(kind==='price'){
      if(finite(m.products)&&finite(m.days))parts.push(number(m.products)+'상품 · '+number(m.days)+'일');
      if(finite(m.rowCount))parts.push(number(m.rowCount)+'건');
      if(finite(m.min)&&finite(m.max))parts.push(number(m.min)+'~'+number(m.max)+'원');
    }else{
      if(finite(m.days))parts.push('같은 숙박일 '+number(m.days)+'일');
      if(finite(m.intervalCount))parts.push('관측 비교 '+number(m.intervalCount)+'건');
      const rows=arr(m.rows),pairs=[...new Set(rows.map(row=>stamp(row.previousCollectedAt)&&stamp(row.collectedAt)?stamp(row.previousCollectedAt)+' → '+stamp(row.collectedAt):'').filter(Boolean))];
      if(pairs.length===1&&!proof.some(row=>row.includes(' → ')))proof.unshift(pairs[0]);
      if(numeric)parts.push('신규 예약수 아님');
    }
    const reason=numeric?(m.status==='partial'?m.reason:null):m.reason,descriptions=[...(reason?[reason]:[]),...proof,...limitations];
    return `<strong class="dashboard-saved-value">${esc(metricValue({id:kind==='price'?'product_price':'public_change',value:m.value,unit:kind==='price'?'원':'실'}))}</strong><span class="dashboard-reason is-${tone(m.status)}"${m.reasonCode?` data-reason-code="${esc(m.reasonCode)}"`:''}>${esc(missingLabel(m))}</span>${parts.length?`<small>${parts.map(esc).join(' · ')}</small>`:''}${descriptions.length?`<details class="dashboard-saved-proof"><summary>${reason?'사유·근거':'관측 근거'} <b aria-hidden="true">+</b></summary>${descriptions.map(row=>`<p>${esc(row)}</p>`).join('')}</details>`:''}`;
  }
  function selectedId(model,options={}){
    return options.selectedCompanyId!==undefined?options.selectedCompanyId:model.selectedCompanyId!==undefined?model.selectedCompanyId:model.own?.companyId||arr(model.companies).find(c=>c.kind==='own')?.companyId||null;
  }
  function savedMetrics(model,options={}){
    const companies=arr(model.companies);
    if(!companies.length)return '';
    const selected=selectedId(model,options);
    return `<section class="card dashboard-saved-metrics" data-dashboard-company-comparison aria-labelledby="dashboard-company-comparison-heading"><header class="dashboard-company-table-heading"><h3 id="dashboard-company-comparison-heading">업체별 비교</h3><span>업체 ${number(companies.length)}곳 · 선택 ${number(model.period?.days)}일</span></header><div class="dashboard-table-scroll" tabindex="0" aria-label="업체별 객실 기준·예약률·가격·공개예약 변화"><table data-dashboard-company-table><caption class="sr-only">선택한 숙박일의 업체별 지역, 객실 기준, 추정 예약률, 상품가격, 공개예약 순변화와 수량 확보일</caption><thead><tr><th scope="col">업체</th><th scope="col">지역</th><th scope="col">객실 기준</th><th scope="col">추정 예약률</th><th scope="col">상품가격</th><th scope="col">공개예약 순변화</th><th scope="col">수량 확보</th></tr></thead><tbody>${companies.map(c=>{
      const s=c.summary||{},capacity=c.capacity||{},knownRooms=finite(c.rooms)&&c.rooms>0,observed=finite(s.days)&&s.days>=0,expected=finite(model.period?.days)&&model.period.days>=0;
      const roomState=capacity.conflict?'객실 기준 충돌':capacity.label||(!knownRooms||capacity.reviewRequired?'객실 검토 필요':'');
      return `<tr data-dashboard-saved-company="${esc(c.companyId)}" data-dashboard-selected="${c.companyId===selected}"${c.kind==='own'?' class="is-own"':''}><th scope="row" data-dashboard-cell="company"><button type="button" class="dashboard-company-select" data-dashboard-company-select="${esc(c.companyId)}" aria-pressed="${c.companyId===selected}" aria-controls="dashboard-company-detail">${esc(c.name||'업체')}</button>${c.kind==='own'?'<small class="dashboard-own-label">내 매장</small>':''}<a class="dashboard-company-source-link" href="${link(c.companyId)}">A·B·C 자료 →</a></th><td data-dashboard-cell="region"><span>${esc(c.regionLabel||'지역 미확인')}</span><small>${esc(c.kind==='own'?'내 매장 소재지':relation(c.regionRelation))}${c.industryRelation==='mixed'?' · 다른 업종':c.industryRelation==='unknown'?' · 업종 미확인':''}</small></td><td data-dashboard-cell="rooms"><strong class="dashboard-saved-value">${knownRooms?number(c.rooms)+'실':'미확인'}</strong>${roomState?`<small${capacity.conflict||capacity.reviewRequired?' class="dashboard-review-label"':''}>${esc(roomState)}</small>`:''}</td><td data-dashboard-cell="reservation-rate"><strong class="dashboard-saved-value">${rate(s.reservationRate??s.rate)}</strong>${ratio(s.reservationRate??s.rate)&&finite(s.publicBookings)&&finite(s.phoneBookings)?`<small>공개 ${number(s.publicBookings)}실 + 타채널 ${number(s.phoneBookings)}실</small>`:'<small>수량·객실 기준 확인 필요</small>'}</td><td data-dashboard-cell="price">${savedCell(c.savedMetrics?.price,'price')}</td><td data-dashboard-cell="public-change">${savedCell(c.savedMetrics?.pickup,'pickup')}</td><td data-dashboard-cell="coverage"><strong class="dashboard-saved-value">${observed&&expected?number(s.days)+' / '+number(model.period.days)+'일':'미확인'}</strong>${observed&&expected&&s.days<model.period.days?`<small>미확인 ${number(model.period.days-s.days)}일</small>`:''}</td></tr>`;
    }).join('')}</tbody></table></div><p class="dashboard-note">가격은 숙박상품 표시가격 중앙값입니다. 확보일·관측 구간이 다른 업체는 참고로 구분하며, 공개예약 증감을 전체 예약 변화로 대신하지 않습니다.</p></section>`;
  }
  function summary(model,options={}){
    return `<section class="dashboard-metrics-section" aria-labelledby="dashboard-metrics-heading">${title('02 · 핵심 지표','선택 기간 한눈에 보기','','dashboard-metrics-heading')}<div class="dashboard-metrics">${arr(model.metrics).map(metric=>`<article class="dashboard-metric is-${tone(metric.status)}" data-dashboard-metric="${esc(metric.id)}"><span class="dashboard-metric-label">${esc(metric.label)}</span><strong>${esc(metricValue(metric))}</strong>${metric.reasonCode?`<span class="dashboard-reason is-${tone(metric.status)}" data-reason-code="${esc(metric.reasonCode)}">${esc(missingLabel(metric))}</span>`:''}<p>${esc(metric.detail||metric.reason||'저장 근거 확인 필요')}</p>${metric.detail&&metric.reason&&metric.reason!==metric.detail?`<small>${esc(metric.reason)}</small>`:''}${metricEvidence(metric)}</article>`).join('')}</div>${savedMetrics(model,options)}</section>`;
  }
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const signedRooms=v=>Number.isSafeInteger(v)?(v>0?'+':'')+number(v)+'실':'미확인';
  function detailRows(model,company){
    const dates=[...new Set(arr(model.dates).filter(date))],selected=new Set(dates),points=new Map(),prices=new Map(),changes=new Map(),conflicts=new Set(),productRanges=new Map();
    for(const point of arr(company.points))if(selected.has(point?.date))points.set(point.date,points.has(point.date)?null:point);
    const price=company.savedMetrics?.price,pickup=company.savedMetrics?.pickup;
    if(['ready','partial'].includes(price?.status))for(const row of arr(price.rows)){
      if(!selected.has(row?.date)||typeof row.productId!=='string'||!finite(row.price)||row.price<0)continue;
      const key=row.date+'\u0000'+row.productId;if(conflicts.has(key))continue;
      const old=prices.get(key);if(old&&old.price!==row.price){prices.delete(key);conflicts.add(key);}else if(!old)prices.set(key,row);
    }
    if(pickup?.status==='reference')for(const row of arr(pickup.rows)){
      if(!selected.has(row?.date)||!Number.isSafeInteger(row.publicChange))continue;
      const old=changes.get(row.date);if(old===null)continue;
      if(old&&(old.publicChange!==row.publicChange||old.previousCollectedAt!==row.previousCollectedAt||old.collectedAt!==row.collectedAt))changes.set(row.date,null);
      else if(!old)changes.set(row.date,row);
    }
    for(const row of prices.values()){
      let product=productRanges.get(row.productId);if(!product){product={name:typeof row.productName==='string'?row.productName:'숙박상품',prices:[],days:new Set()};productRanges.set(row.productId,product);}
      product.prices.push(row.price);product.days.add(row.date);
    }
    return {products:[...productRanges.values()],rows:dates.map(day=>{
      const point=points.get(day),valid=point?.status==='ready'&&[point.sold,point.supply,point.publicBookings,point.phoneBookings].every(count)
        &&point.supply>0&&point.sold===point.publicBookings+point.phoneBookings&&point.sold<=point.supply;
      const productRows=[...prices.values()].filter(row=>row.date===day),ordered=productRows.map(row=>row.price).sort((a,b)=>a-b),mid=Math.floor(ordered.length/2);
      const median=ordered.length?ordered.length%2?ordered[mid]:(ordered[mid-1]+ordered[mid])/2:null;
      return {date:day,valid,point,publicBookings:valid?point.publicBookings:null,inferredBookings:valid?point.phoneBookings:null,sold:valid?point.sold:null,
        supply:valid?point.supply:null,rate:valid&&ratio(point.rate??point.reservationRate)?point.rate??point.reservationRate:null,prices:productRows,price:median,change:changes.get(day)||null};
    })};
  }
  function detailFlow(company,rows){
    if(!rows.some(row=>row.valid))return '<p class="dashboard-detail-empty">전체 예약수량의 날짜별 근거가 미확인입니다. 확인된 상품가격과 공개예약 증감은 아래에 별도로 표시합니다.</p>';
    const width=720,left=32,right=704,bottom=134,height=104,max=Math.max(1,finite(company.rooms)?company.rooms:0,...rows.filter(row=>row.valid).map(row=>row.supply)),step=(right-left)/rows.length,w=Math.min(18,step*.62);
    const bars=rows.map((row,i)=>{
      const x=left+step*(i+.5),tick=i===0||i===rows.length-1||i%7===0&&i<rows.length-3?`<text x="${x.toFixed(2)}" y="155" text-anchor="middle">${esc(short(row.date))}</text>`:'';
      if(!row.valid)return `<g class="dashboard-detail-missing"><path d="M${(x-2).toFixed(2)} ${bottom-5}l4 4m-4 0l4-4"/><title>${esc(row.date)} · 예약수량 미확인</title></g>${tick}`;
      const ph=row.publicBookings/max*height,ih=row.inferredBookings/max*height;
      return `<g><title>${esc(row.date)} · 예약 ${number(row.sold)}실 (공개 ${number(row.publicBookings)}실 + 타채널 추정 ${number(row.inferredBookings)}실) · 예약률 ${rate(row.rate)}</title>${row.publicBookings>0?`<rect class="dashboard-detail-public" x="${(x-w/2).toFixed(2)}" y="${(bottom-ph).toFixed(2)}" width="${w.toFixed(2)}" height="${ph.toFixed(2)}"/>`:''}${row.inferredBookings>0?`<rect class="dashboard-detail-inferred" x="${(x-w/2).toFixed(2)}" y="${(bottom-ph-ih).toFixed(2)}" width="${w.toFixed(2)}" height="${ih.toFixed(2)}"/>`:''}${row.sold===0?`<circle class="dashboard-detail-public" cx="${x.toFixed(2)}" cy="${bottom}" r="2"/>`:''}</g>${tick}`;
    }).join('');
    return `<svg class="dashboard-detail-flow" viewBox="0 0 ${width} 174" role="img" aria-label="${esc(company.name)} 선택 숙박일별 공개예약과 타채널 추정 예약수량. 정상 0실은 점, 미확인은 ×로 표시합니다."><text x="${left-8}" y="${bottom-height+3}" text-anchor="end">${number(max)}</text><text x="${left-8}" y="${bottom+3}" text-anchor="end">0</text><line class="dashboard-chart-grid" x1="${left}" x2="${right}" y1="${bottom-height}" y2="${bottom-height}"/><line class="dashboard-chart-grid" x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>${bars}</svg>`;
  }
  function detailSource(metric,kind){
    const source=metric?.source||{},raw=savedMetricProvenance(metric),time=kind==='price'?stamp(source.collectedAt):stamp(source.previousObservedAt)&&stamp(source.currentObservedAt)?stamp(source.previousObservedAt)+' → '+stamp(source.currentObservedAt):'';
    const limits=[...new Set(arr(metric?.limitations).map(text).filter(value=>value&&value!==metric?.reason))];
    return `<div class="dashboard-detail-source" data-dashboard-detail-source="${kind}"><p>${time?`관측 ${esc(time)}`:'관측 시각 미확인'}</p>${metric?.reason?`<p class="dashboard-detail-source-reason">${esc(metric.reason)}</p>`:''}${limits.length?`<ul class="dashboard-detail-limits">${limits.map(value=>`<li>${esc(value)}</li>`).join('')}</ul>`:''}${raw.length?`<details><summary>수집번호·계산 근거 <b aria-hidden="true">+</b></summary>${raw.map(value=>`<p>${esc(value)}</p>`).join('')}</details>`:''}</div>`;
  }
  function companyDetail(model,companyId){
    if(model?.contextValid!==true)return '';
    const company=arr(model.companies).find(row=>row.companyId===companyId);if(!company)return '';
    const evidence=detailRows(model,company),rows=evidence.rows,s=company.summary||{},price=company.savedMetrics?.price,pickup=company.savedMetrics?.pickup,changed=rows.filter(row=>row.change&&row.change.publicChange!==0);
    const rowsHtml=rows.map(row=>`<tr data-dashboard-detail-date="${esc(row.date)}"><th scope="row">${esc(row.date)}</th><td data-dashboard-detail-cell="public">${row.valid?number(row.publicBookings)+'실':'미확인'}</td><td data-dashboard-detail-cell="inferred">${row.valid?number(row.inferredBookings)+'실':'미확인'}</td><td data-dashboard-detail-cell="total">${row.valid?number(row.sold)+'실':'미확인'}</td><td data-dashboard-detail-cell="rate">${rate(row.rate)}</td><td data-dashboard-detail-cell="price">${finite(row.price)?number(row.price)+'원':'미확인'}${row.prices.length?`<small>${number(row.prices.length)}상품</small>`:''}</td><td data-dashboard-detail-cell="public-change">${row.change?signedRooms(row.change.publicChange):'미확인'}${row.change&&count(row.change.previousPublic)&&count(row.change.currentPublic)?`<small>${number(row.change.previousPublic)} → ${number(row.change.currentPublic)}실</small>`:''}</td></tr>`).join('');
    const productList=products=>`<ul class="dashboard-detail-products">${products.map(product=>{const min=Math.min(...product.prices),max=Math.max(...product.prices);return `<li><span>${esc(product.name)}</span><strong>${number(min)}${min!==max?'~'+number(max):''}원</strong><small>${number(product.days.size)}일</small></li>`;}).join('')}</ul>`;
    const priceProducts=evidence.products.length?productList(evidence.products.slice(0,10))+(evidence.products.length>10?`<details class="dashboard-detail-more-products"><summary>${number(evidence.products.length-10)}개 상품 더보기 <b aria-hidden="true">+</b></summary>${productList(evidence.products.slice(10))}</details>`:''):'<p class="dashboard-detail-empty">선택 날짜의 상품별 가격 근거가 미확인입니다.</p>';
    return `<section id="dashboard-company-detail" class="card dashboard-company-detail" tabindex="-1" data-dashboard-company-detail="${esc(companyId)}" aria-labelledby="dashboard-company-detail-heading"><header class="dashboard-detail-heading"><div><span class="dashboard-kicker">선택 업체 · ${esc(company.kind==='own'?'내 매장':relation(company.regionRelation))}</span><h3 id="dashboard-company-detail-heading">${esc(company.name||'업체')} · 날짜별 예약 흐름</h3><p>${esc(company.regionLabel||'지역 미확인')} · 숙박 ${esc(model.period?.start||'미확인')} ~ ${esc(model.period?.end||'미확인')} · 선택 ${number(rows.length)}일</p></div><button type="button" class="button secondary" data-dashboard-company-back>업체 표로 ↑</button></header><div class="dashboard-detail-overview"><article><span>추정 예약률</span><strong>${rate(s.reservationRate??s.rate)}</strong><small>${count(s.publicBookings)&&count(s.phoneBookings)?'공개 '+number(s.publicBookings)+'실 + 타채널 추정 '+number(s.phoneBookings)+'실':'전체 예약수량 미확인'}</small></article><article><span>숙박상품 표시가격 중앙값</span><strong>${metricValue({id:'product_price',value:price?.value,unit:'원'})}</strong><small>${esc(missingLabel(price))}</small></article><article><span>공개예약 순변화 · 참고</span><strong>${signedRooms(pickup?.value)}</strong><small>${esc(missingLabel(pickup))}</small></article></div><div class="dashboard-detail-reservations">${legend()}${detailFlow(company,rows)}</div><div class="dashboard-detail-evidence-grid"><article><h4>상품별 표시가격</h4>${priceProducts}${detailSource(price,'price')}</article><article><h4>공개예약 변화 근거</h4>${changed.length?`<ul class="dashboard-detail-changes">${changed.map(row=>`<li><time>${esc(row.date)}</time><strong>${signedRooms(row.change.publicChange)}</strong>${count(row.change.previousPublic)&&count(row.change.currentPublic)?`<span>공개 ${number(row.change.previousPublic)} → ${number(row.change.currentPublic)}실</span>`:''}</li>`).join('')}</ul>`:rows.some(row=>row.change)?'<p class="dashboard-detail-empty">확인된 날짜의 공개예약 순변화는 0실입니다.</p>':'<p class="dashboard-detail-empty">비교 가능한 날짜별 공개예약 증감이 미확인입니다.</p>'}${detailSource(pickup,'pickup')}</article></div><div class="dashboard-detail-daily-heading"><h4>날짜별 수량·가격·공개예약 증감</h4><span>가격은 해당 날짜의 상품별 표시가격 중앙값</span></div><div class="dashboard-table-scroll dashboard-detail-daily-scroll" tabindex="0" aria-label="${esc(company.name||'업체')} 날짜별 예약·가격·공개예약 증감"><table data-dashboard-company-daily><caption class="sr-only">선택 업체의 날짜별 예약수량, 상품가격과 공개예약 증감. 오류·누락은 정상 0실과 구별합니다.</caption><thead><tr><th scope="col">숙박일</th><th scope="col">공개예약</th><th scope="col">타채널 추정</th><th scope="col">합계</th><th scope="col">예약률</th><th scope="col">상품가격</th><th scope="col">공개예약 순변화</th></tr></thead><tbody>${rowsHtml||'<tr><td colspan="7">선택한 숙박일이 없습니다.</td></tr>'}</tbody></table></div><p class="dashboard-note">공개예약 증감은 저장된 두 관측 사이의 변화입니다. 전체 예약수량·타채널 수량이 미확인이어도 검증된 공개예약 증감은 별도로 표시하며, 신규 예약·취소 확정 수량으로 해석하지 않습니다.</p></section>`;
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
    return `<div class="comparison-dashboard" data-comparison-dashboard>${controls(model)}${summary(model)}${companyDetail(model,selectedId(model))}${judgments(model)}${graphs(model)}</div>`;
  }
  return {render,controls,summary,judgments,graphs,metricValue,rateFlow,savedMetrics,missingLabel,companyDetail};
});
