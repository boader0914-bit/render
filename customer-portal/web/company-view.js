(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const rooms=v=>numeric(v)?`${n(v)}실`:'확인 전';
  const observedRooms=v=>numeric(v)?`${n(v)}실`:'미확인';
  const won=v=>numeric(v)?`${n(v)}원`:'미확인';
  const revenuePartial=row=>row?.revenuePartial===true||row?.phoneMissingPriceBookings>0;
  const revenueUnknown=(value,partial,bookings)=>numeric(value)&&value===0&&partial&&numeric(bookings)&&bookings>0;
  const revenueText=summary=>summary.estimatedRevenue===0&&summary.revenueUnconfirmed?'금액 미확인':won(summary.estimatedRevenue);
  const revenue=(value,partial,bookings,label='')=>revenueUnknown(value,partial,bookings)?`${label}금액 미확인`:won(value)+(numeric(value)&&partial?'<small>확인된 소계</small>':'');
  const rate=v=>numeric(v)?`${(v*100).toFixed(1)}%`:'미확인';
  const roomSource=db=>db?.integrated?.roomBasis?.label||({db_review:'DB 검수값',observed_locked:'최대 관측 고정값'}[db?.integrated?.roomBasis?.source])||db?.basics?.roomCountSource||'객실 기준 확인 전';
  const when=v=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'관측 전';
  const heading=(key,title)=>`<div class="db-section-heading"><b>${key}</b><h2>${title}</h2></div>`;
  const metric=(label,value,help='',tone='')=>`<article class="${tone}"><span>${label}</span><strong>${value}</strong>${help?`<small>${help}</small>`:''}</article>`;
  function current(data) {
    const db=data.companyDetail;
    if(db?.integrated&&!db.legacyObservationView&&!db.integrated.snapshot)return {daily:[],summary:null};
    return db?.current||{daily:[],summary:null};
  }
  function hasObservation(data) {
    return current(data).daily?.some(d=>!d.missing&&(numeric(d.publicBookings)||numeric(d.phoneBookings)||numeric(d.estimatedRevenue)))||false;
  }
  function quantityNote(summary) {
    if(summary?.quantityPartial===true||summary?.missingDays>0)return '미확인 날짜는 합계에서 제외';
    if(summary?.staleDays>0)return '숙박일 이전 마지막 관측 포함';
    if(summary?.containsPartialRun)return '일부 완료 회차의 정상 수량 포함';
    if(summary?.quantityPartial===undefined&&summary?.missingDays==null&&summary?.partial)return '관측 범위 확인 필요';
    return '';
  }
  function observationLabel(row) {
    if(row.missing)return '미관측';
    if(row.inventoryConflict)return '객실 수 검토 필요';
    const notes=[];
    if(row.latestAttemptStatus==='excluded')notes.push('최근 응답 제외 · 저장 자료 유지');
    if(row.partial)notes.push('일부 확인 필요');
    if(row.phoneMissingPriceBookings>0)notes.push('타채널 금액 미확인');
    else if(row.revenuePartial)notes.push('가격 일부 확인 필요');
    if(row.phoneAllocatedBookings>0)notes.push('상품 배분 추정');
    if(row.sharedDayUseEvidence?.groups?.some(group=>group.reusedBookings>0))notes.push('런치·디너 재사용 반영');
    return notes.join(' · ')||'정상 관측';
  }
  function productTable(products=[],collapse=false) {
    if(!products.length)return '<p class="empty-note">상품 관측 자료가 없습니다.</p>';
    const type={lodging:'숙박',dayuse:'데이유즈',unknown:'구분 확인 전'};
    const table=`<div class="collection-table-wrap db-product-table"><table><thead><tr><th>상품명</th><th>종류</th><th>관측 판매금액</th></tr></thead><tbody>${products.map(p=>{
      const prices=(p.days||[]).filter(d=>d.status==='observed'&&numeric(d.price)).map(d=>d.price);
      const min=prices.length?Math.min(...prices):null,max=prices.length?Math.max(...prices):null;
      return `<tr><th>${esc(p.name||'상품명 확인 전')}</th><td>${esc(type[p.productType]||type.unknown)}</td><td>${min==null?'가격 확인 전':min===max?won(min):`${won(min)} ~ ${won(max)}`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
    return collapse&&products.length>10?`<details class="company-products"><summary><span>상품 목록 · ${n(products.length)}개</span><span class="products-expand">펼치기 +</span><span class="products-collapse">접기 −</span></summary>${table}</details>`:table;
  }
  function dailyTable(rows=[]) {
    const data=window.InsightCompanyFlow?.fillDays(rows)||rows;
    return `<div class="collection-table-wrap company-observation-table"><table><caption>날짜별 추정 예약·매출</caption><thead><tr><th>숙박일</th><th>예약 합계</th><th>공개 예약</th><th>방막기</th><th>예약률</th><th>매출 합계</th><th>공개 예약 매출</th><th>방막기 매출</th><th>관측 상태</th></tr></thead><tbody>${data.map(d=>{
      const known=!d.missing&&!d.inventoryConflict,publicBookings=known?d.publicBookings:null,blocked=known?d.phoneBookings:null;
      const total=numeric(publicBookings)&&numeric(blocked)?publicBookings+blocked:null;
      const partial=revenuePartial(d),publicPartial=publicBookings===0?false:partial,phonePartial=blocked===0?false:numeric(d.phoneMissingPriceBookings)?d.phoneMissingPriceBookings>0:partial;
      return `<tr class="${!known?'observation-unknown':''}"><th>${esc(d.date)}</th><td>${observedRooms(total)}</td><td class="public-value">${observedRooms(publicBookings)}</td><td class="${numeric(blocked)&&blocked>0?'estimated-value':''}">${observedRooms(blocked)}</td><td>${rate(known?d.reservationRate:null)}</td><td>${revenue(known?d.estimatedRevenue:null,partial,total)}</td><td class="public-value">${revenue(known?d.publicRevenue:null,publicPartial,publicBookings)}</td><td class="${numeric(blocked)&&blocked>0?'estimated-value':''}">${revenue(known?d.phoneRevenue:null,phonePartial,blocked,'타채널 ')}</td><td>${esc(observationLabel(d))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  const dayMs=86400000;
  function dayTime(value) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return null;
    const time=Date.parse(value+'T00:00:00Z');
    return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?time:null;
  }
  function weeklyGroups(rows=[],range={}) {
    // These rows already contain one integrated value per stay date. Match the
    // daily chart's last-row-wins behavior rather than summing duplicate dates.
    const data=rows.filter(row=>dayTime(row?.date)!==null).sort((a,b)=>a.date.localeCompare(b.date));
    if(!data.length)return [];
    const first=dayTime(data[0].date),last=dayTime(data.at(-1).date);
    const requestedStart=dayTime(range.rangeStart),requestedEnd=dayTime(range.rangeEnd);
    const start=requestedStart??first,end=requestedEnd??last;
    if(end<start)return [];
    const byDate=new Map(data.map(row=>[row.date,row])),groups=[];
    let group;
    for(let time=start;time<=end;time+=dayMs){
      const date=new Date(time).toISOString().slice(0,10),weekday=new Date(time).getUTCDay();
      if(!group||weekday===1){group={start:date,end:date,rows:[]};groups.push(group);}
      group.end=date;group.rows.push(byDate.get(date)||{date,missing:true});
    }
    return groups.map(group=>{
      const known=row=>!row.missing&&!row.inventoryConflict;
      const quantityRows=group.rows.filter(row=>known(row)&&numeric(row.publicBookings)&&numeric(row.phoneBookings));
      const revenueRows=group.rows.filter(row=>known(row)&&numeric(row.estimatedRevenue));
      const expectedDays=group.rows.length,observedDays=quantityRows.length,revenueObservedDays=revenueRows.length;
      const sum=(selected,key)=>selected.length?selected.reduce((total,row)=>total+row[key],0):null;
      const publicBookings=sum(quantityRows,'publicBookings'),phoneBookings=sum(quantityRows,'phoneBookings');
      const revenueUnconfirmed=quantityRows.some(row=>row.publicBookings+row.phoneBookings>0&&(!numeric(row.estimatedRevenue)||revenueUnknown(row.estimatedRevenue,revenuePartial(row),row.publicBookings+row.phoneBookings)));
      return {...group,expectedDays,observedDays,revenueObservedDays,publicBookings,phoneBookings,
        bookings:observedDays?publicBookings+phoneBookings:null,estimatedRevenue:sum(revenueRows,'estimatedRevenue'),
        revenueUnconfirmed,
        quantityPartial:observedDays<expectedDays||quantityRows.some(row=>row.partial),
        revenuePartial:revenueObservedDays<expectedDays||revenueRows.some(row=>revenuePartial(row)||row.partial)};
    });
  }
  function monthTotals(rows=[],range={}) {
    const groups=weeklyGroups(rows,range);
    if(!groups.length)return null;
    const sum=key=>{
      const known=groups.filter(group=>numeric(group[key]));
      return known.length?known.reduce((total,group)=>total+group[key],0):null;
    };
    const days=groups.flatMap(group=>group.rows),revenueRows=days.filter(row=>!row.missing&&!row.inventoryConflict&&numeric(row.estimatedRevenue));
    const channelRevenue=key=>{
      const known=revenueRows.filter(row=>numeric(row[key]));
      return known.length?known.reduce((total,row)=>total+row[key],0):null;
    };
    const start=groups[0].start,end=groups.at(-1).end,sameMonth=start.slice(0,7)===end.slice(0,7);
    const lastDay=new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7)),0)).toISOString().slice(0,10);
    const wholeMonth=sameMonth&&start.endsWith('-01')&&end===lastDay;
    return {start,end,wholeMonth,bookings:sum('bookings'),publicBookings:sum('publicBookings'),phoneBookings:sum('phoneBookings'),
      estimatedRevenue:sum('estimatedRevenue'),publicRevenue:channelRevenue('publicRevenue'),phoneRevenue:channelRevenue('phoneRevenue'),
      expectedDays:groups.reduce((total,group)=>total+group.expectedDays,0),observedDays:groups.reduce((total,group)=>total+group.observedDays,0),
      revenueObservedDays:revenueRows.length,priceCompleteDays:revenueRows.filter(row=>!row.partial&&!revenuePartial(row)).length,
      quantityPartial:groups.some(group=>group.quantityPartial),revenuePartial:groups.some(group=>group.revenuePartial),revenueUnconfirmed:groups.some(group=>group.revenueUnconfirmed)};
  }
  function monthSummary(rows,range) {
    const total=monthTotals(rows,range);
    if(!total)return '';
    const prefix=total.wholeMonth?'월':'기간',title=total.wholeMonth?'월간':'기간',month=total.start.slice(0,7)===total.end.slice(0,7)?`${Number(total.start.slice(0,4))}년 ${Number(total.start.slice(5,7))}월 · `:'';
    return `<section class="company-month-summary"><div class="month-summary-heading"><div><h3>${title} 추정 예약·매출</h3><p>${month}현재 관측 합계</p></div><p class="month-note">숙박일 ${esc(total.start)} ~ ${esc(total.end)}</p></div><div class="month-summary-metrics"><article class="month-bookings"><span>${prefix} 예약 합계</span><strong>${observedRooms(total.bookings)}</strong><p>공개 예약 + 방막기</p></article><article class="month-revenue"><span>${prefix} 매출 ${total.revenuePartial?'소계':'합계'}</span><strong>${revenueText(total)}</strong><p>${numeric(total.estimatedRevenue)&&total.revenuePartial&&!(total.estimatedRevenue===0&&total.revenueUnconfirmed)?'<span class="month-partial">확인된 소계</span> · ':''}가격 확인 ${total.priceCompleteDays}/${total.expectedDays}일</p></article></div><p class="month-note">예약 관측 ${total.observedDays}/${total.expectedDays}일 · 숙박일별 수량 합산${total.revenuePartial?' · 매출은 확인된 금액만 합산':''}</p></section>`;
  }
  const shortDay=value=>`${Number(value.slice(5,7))}. ${Number(value.slice(8,10))}.`;
  function weeklyTable(rows,range) {
    const groups=weeklyGroups(rows,range);
    if(!groups.length)return '';
    return `<div class="week-label-row"><h3 class="week-table-title">주간 추정 예약·매출</h3><p class="muted">숙박일별 수량 합산</p></div><div class="company-week-list"><div class="week-column-head" aria-hidden="true"><span>숙박 기간</span><span>예약 합계</span><span>매출 합계</span><span>관측 상태</span><span></span></div>${groups.map(group=>{
      const coverage=group.observedDays===group.revenueObservedDays?`관측 ${group.observedDays}/${group.expectedDays}일`:`예약 ${group.observedDays}/${group.expectedDays}일 · 매출 ${group.revenueObservedDays}/${group.expectedDays}일`;
      const partial=group.quantityPartial||group.revenuePartial;
      const status=!group.observedDays&&!group.revenueObservedDays?'미확인':`${group.quantityPartial?'일부 자료 · ':''}${coverage}`;
      return `<details class="company-week-group${partial?' is-partial':''}"><summary class="company-week-summary"><span class="week-period">${shortDay(group.start)} ~ ${shortDay(group.end)}</span><span class="week-bookings"><small class="week-metric-label">예약 합계</small><strong>${observedRooms(group.bookings)}</strong></span><span class="week-revenue"><small class="week-metric-label">매출 ${group.revenuePartial?'소계':'합계'}</small><strong>${revenueText(group)}</strong>${numeric(group.estimatedRevenue)&&group.revenuePartial&&!(group.estimatedRevenue===0&&group.revenueUnconfirmed)?'<small>확인된 소계</small>':''}</span><span class="week-state">${esc(status)}</span><span class="week-toggle" aria-hidden="true"><span class="week-toggle-open">+</span><span class="week-toggle-close">−</span></span></summary><div class="week-label-row"><h4 class="week-table-title">${shortDay(group.start)} ~ ${shortDay(group.end)} · 날짜별 내역</h4><p class="company-mobile-hint">표를 좌우로 밀어 매출을 확인하세요.</p></div>${dailyTable(group.rows)}</details>`;
    }).join('')}</div>`;
  }
  function currentView(data) {
    const observation=current(data),rows=observation.daily||[];
    return monthSummary(rows,observation.summary||{})+pickupView(data)+(window.InsightCompanyFlow?.daily(rows)||'')+weeklyTable(rows,observation.summary||{});
  }
  const signedCount=value=>Number.isSafeInteger(value);
  const signedRooms=value=>signedCount(value)?`${value>0?'+':value<0?'−':''}${Math.abs(value).toLocaleString('ko-KR')}실`:'미확인';
  const pickupReasons={
    scope:'선택한 업체·숙박월의 비교 근거 확인 필요',
    date:'숙박일 또는 관측기간 확인 필요',
    time:'이전·이번 관측 시각 확인 필요',
    cutoff:'관측 마감일 또는 숙박일 뒤의 근거 제외',
    quantity:'공개 예약·방막기 변화 수량 확인 필요',
    lead:'숙박일까지의 관측 간격 확인 필요',
    conflict:'같은 숙박일의 비교 근거가 서로 달라 제외'
  };
  function pickupInstant(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value))return null;
    if(dayTime(value.slice(0,10))===null)return null;
    const time=Date.parse(value);return Number.isFinite(time)?time:null;
  }
  const pickupDay=time=>new Date(time+9*3600000).toISOString().slice(0,10);
  const pickupWhen=value=>pickupInstant(value)===null?'시각 미확인':new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  function pickupModel(data) {
    const detail=data?.companyDetail,integrated=detail?.integrated,snapshot=integrated?.snapshot,pickup=snapshot?.analysis?.pickup;
    const model={status:'insufficient',message:'같은 숙박일의 유효 관측이 2회 이상 쌓이면 변화를 표시합니다.',rows:[],issues:[],otherGroups:0,duplicateCount:0,sourceIntervalCount:null,providedIntervalCount:0,capacityWarning:integrated?.roomBasis?.reviewRequired===true};
    // The legacy observationFlow uses a different calculation. Never revive it
    // or treat a raw result as a selected, integrated comparison.
    if(!integrated||detail.legacyObservationView||!snapshot)return model;
    if(!pickup||!Array.isArray(pickup.intervals))return model;
    const period=snapshot.period,month=integrated.selectedMonth;
    if(!detail.companyId||detail.companyId!==integrated.companyId||!validMonth(month)||dayTime(period?.start)===null||dayTime(period?.end)===null||dayTime(period?.cutoffDate)===null||period.start>period.end||period.cutoffDate>period.end||!period.start.startsWith(month+'-')||!period.end.startsWith(month+'-')){
      model.message=pickupReasons.scope;return model;
    }
    if((pickup.status===''||pickup.status===null||pickup.status===undefined)&&!pickup.intervals.length)return model;
    if(!['ready','no_increase','insufficient'].includes(pickup.status)){
      model.message='변화 자료의 판정 상태를 확인해야 합니다.';return model;
    }
    if(pickup.status==='insufficient'&&pickup.intervals.length){model.message='비교 근거와 판정 상태가 일치하지 않아 표시를 보류합니다.';return model;}
    model.sourceIntervalCount=Number.isSafeInteger(pickup.comparableIntervals)&&pickup.comparableIntervals>=0?pickup.comparableIntervals:null;
    model.providedIntervalCount=pickup.intervals.length;
    const issueMap=new Map(),byKey=new Map(),ambiguous=new Set();
    const issue=(code,row)=>{const dates=issueMap.get(code)||new Set();if(dayTime(row?.date)!==null)dates.add(row.date);issueMap.set(code,dates);};
    for(const row of pickup.intervals.slice(0,240)){
      if(dayTime(row?.date)===null||row.date<period.start||row.date>period.end||!row.date.startsWith(month+'-')){issue('date',row);continue;}
      const previousTime=pickupInstant(row.previousCollectedAt),time=pickupInstant(row.collectedAt);
      if(previousTime===null||time===null||previousTime>=time){issue('time',row);continue;}
      const previousDay=pickupDay(previousTime),day=pickupDay(time);
      if(day>period.cutoffDate||day>row.date||previousDay>row.date){issue('cutoff',row);continue;}
      if(![row.publicChange,row.blockedChange,row.netChange].every(signedCount)||row.netChange!==row.publicChange+row.blockedChange){issue('quantity',row);continue;}
      const leadValid=Number.isSafeInteger(row.previousLeadDays)&&Number.isSafeInteger(row.currentLeadDays)&&row.currentLeadDays>=0&&row.previousLeadDays>=row.currentLeadDays&&row.previousLeadDays===(dayTime(row.date)-dayTime(previousDay))/dayMs&&row.currentLeadDays===(dayTime(row.date)-dayTime(day))/dayMs;
      if(!leadValid)issue('lead',row);
      const key=JSON.stringify([row.date,previousTime,time]),value={date:row.date,previousCollectedAt:row.previousCollectedAt,collectedAt:row.collectedAt,previousTime,time,publicChange:row.publicChange,blockedChange:row.blockedChange,netChange:row.netChange,previousLeadDays:leadValid?row.previousLeadDays:null,currentLeadDays:leadValid?row.currentLeadDays:null};
      if(ambiguous.has(key))continue;
      const old=byKey.get(key);
      if(old){
        if(['publicChange','blockedChange','netChange','previousLeadDays','currentLeadDays'].some(field=>old[field]!==value[field])){byKey.delete(key);ambiguous.add(key);issue('conflict',row);}
        else model.duplicateCount++;
        continue;
      }
      byKey.set(key,value);
    }
    model.issues=[...issueMap].map(([code,dates])=>({code,label:pickupReasons[code],dates:[...dates].sort()}));
    const groups=new Map();
    for(const row of byKey.values()){
      const key=JSON.stringify([row.previousTime,row.time]),group=groups.get(key)||{previousTime:row.previousTime,time:row.time,rows:[]};group.rows.push(row);groups.set(key,group);
    }
    // A current observation may refer back to different previous observations.
    // Keep exact timestamp pairs separate instead of inventing one common gap.
    const ordered=[...groups.values()].sort((a,b)=>b.time-a.time||b.rows.length-a.rows.length||b.previousTime-a.previousTime),selected=ordered[0];
    model.otherGroups=Math.max(0,ordered.length-1);
    if(!selected){if(model.issues.length)model.message='비교에 사용할 정상 관측 근거를 확인하지 못했습니다.';return model;}
    model.rows=selected.rows.sort((a,b)=>a.date.localeCompare(b.date));
    if(pickup.status==='no_increase'&&model.rows.some(row=>row.publicChange>0)){
      model.rows=[];model.message='공개 예약 변화의 판정 상태와 근거가 일치하지 않아 표시를 보류합니다.';return model;
    }
    model.status='ready';model.message='';
    model.publicChange=model.rows.reduce((sum,row)=>sum+row.publicChange,0);
    model.blockedChange=model.rows.reduce((sum,row)=>sum+row.blockedChange,0);
    if(!signedCount(model.publicChange)){model.publicChange=null;model.issues.push({code:'quantity',label:pickupReasons.quantity,dates:model.rows.map(row=>row.date)});}
    if(!signedCount(model.blockedChange)){model.blockedChange=null;model.issues.push({code:'quantity',label:pickupReasons.quantity,dates:model.rows.map(row=>row.date)});}
    model.previousCollectedAt=model.rows[0].previousCollectedAt;model.collectedAt=model.rows[0].collectedAt;
    const selectedDates=new Set(model.rows.map(row=>row.date));
    model.pricePartial=(current(data).daily||[]).some(row=>selectedDates.has(row.date)&&revenuePartial(row));
    return model;
  }
  function pickupView(data) {
    if(data?.companyDetail?.legacyObservationView||!data?.companyDetail?.integrated?.snapshot?.analysis?.pickup)return '';
    const model=pickupModel(data),ready=model.status==='ready';
    const lead=row=>row.publicChange>0?row.currentLeadDays===null||row.previousLeadDays===null?'미확인':`${n(row.currentLeadDays)}${row.currentLeadDays===row.previousLeadDays?'':'~'+n(row.previousLeadDays)}일 전`:'증가 관측 없음';
    const notes=[model.capacityWarning?'객실 총량 검토가 필요합니다. 저장된 비교 수량을 표시하며 예약률의 우열은 판단하지 않습니다.':'',model.pricePartial?'가격이 빠진 날짜도 정상 수량의 변화는 유지했습니다.':'',model.otherGroups?`이전·이번 관측 시각이 다른 ${n(model.otherGroups)}개 구간은 위 요약에 합산하지 않았습니다.`:'',model.sourceIntervalCount!==null&&model.sourceIntervalCount>model.providedIntervalCount?`월 전체 비교 근거 ${n(model.sourceIntervalCount)}개 중 최근 ${n(model.providedIntervalCount)}개가 제공됩니다. 위 수치는 월 전체 증감이 아닙니다.`:'',model.providedIntervalCount>240?'근거가 많아 처음 240개만 확인했습니다.':'',model.duplicateCount?`중복된 동일 근거 ${n(model.duplicateCount)}개는 한 번만 사용했습니다.`:''].filter(Boolean);
    return `<section class="company-pickup" aria-label="최근 관측 간 변화"><div class="company-pickup-heading"><h3>최근 관측 간 변화</h3><span>같은 숙박일끼리 비교</span></div>${ready?`<div class="company-pickup-grid"><article class="company-pickup-public"><span>공개 예약 변화</span><strong>${signedRooms(model.publicChange)}</strong></article><article class="company-pickup-estimate ${signedCount(model.blockedChange)&&model.blockedChange!==0?'is-nonzero':''}"><span>방막기 변화</span><strong>${signedRooms(model.blockedChange)}</strong></article><article class="company-pickup-period"><span>관측 구간 · 공통 숙박일 ${n(model.rows.length)}일</span><strong>${esc(shortDay(pickupDay(pickupInstant(model.previousCollectedAt))))} → ${esc(shortDay(pickupDay(pickupInstant(model.collectedAt))))}</strong></article></div>`:`<p class="company-pickup-empty">${esc(model.message)}</p>`}<p class="company-pickup-note">예약 접수·취소 확정이 아닌 관측 수량의 변화입니다.</p>${model.capacityWarning?`<p class="company-pickup-warning">${esc(notes.shift())}</p>`:''}<details class="company-pickup-details"><summary>비교 근거·미확인 사유 <span aria-hidden="true">+</span></summary>${ready?`<p class="company-pickup-basis">${esc(pickupWhen(model.previousCollectedAt))} → ${esc(pickupWhen(model.collectedAt))}<br>고정 비교 숙박일: ${model.rows.map(row=>esc(row.date)).join(', ')}</p><div class="company-pickup-table-wrap"><table><caption>숙박일별 관측 변화와 추정 리드타임 범위</caption><thead><tr><th>숙박일</th><th>공개 예약 변화</th><th>방막기 변화</th><th>이전 관측</th><th>이번 관측</th><th>공개 예약 증가 시점</th></tr></thead><tbody>${model.rows.map(row=>`<tr><th>${esc(row.date)}</th><td class="company-pickup-public">${signedRooms(row.publicChange)}</td><td class="${row.blockedChange!==0?'company-pickup-estimate is-nonzero':''}">${signedRooms(row.blockedChange)}</td><td>${esc(pickupWhen(row.previousCollectedAt))}</td><td>${esc(pickupWhen(row.collectedAt))}</td><td>${lead(row)}</td></tr>`).join('')}</tbody></table></div><p class="company-pickup-note">증가 시점은 두 관측 사이의 범위이며 실제 예약 접수일이 아닙니다.</p>`:''}${notes.length?`<ul class="company-pickup-notes">${notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul>`:''}${model.issues.length?`<ul class="company-pickup-notes">${model.issues.map(issue=>`<li>${esc(issue.label)}${issue.dates.length?' · '+issue.dates.map(esc).join(', '):''}</li>`).join('')}</ul>`:ready?'':`<p class="company-pickup-basis">${esc(model.message)}</p>`}</details></section>`;
  }
  // Keep the module interface for older callers; the company page shows only current observations.
  function flowView(data,options={}) {
    return window.InsightCompanyFlow?.history(data.companyDetail?.history?.observationFlow,options)||'';
  }
  const validMonth=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
  function monthSelection(data,options){
    const integrated=data.companyDetail?.integrated,selected=options.selectedMonth||integrated?.selectedMonth||current(data).summary?.rangeStart?.slice(0,7)||'';
    const months=new Map();
    for(const row of [...(Array.isArray(options.months)?options.months:[]),...(Array.isArray(integrated?.months)?integrated.months:[])])if(validMonth(row?.month))months.set(row.month,row.status);
    if(validMonth(selected)&&!months.has(selected))months.set(selected,integrated?.snapshot?'ready':'missing');
    if(!months.size)return {visible:false,html:''};
    const html=`<label class="company-stay-month"><span>숙박월</span><select data-company-month aria-label="통합관측 숙박월">${[...months].sort(([a],[b])=>b.localeCompare(a)).map(([month,status])=>`<option value="${esc(month)}"${month===selected?' selected':''}>${Number(month.slice(0,4))}년 ${Number(month.slice(5,7))}월${status==='partial'?' · 일부 자료':['missing','unavailable','failed'].includes(status)?' · 자료 확인 필요':''}</option>`).join('')}</select></label>`;
    return {visible:true,html};
  }
  function render(data,options={}) {
    const r=data.result,db=data.companyDetail,b=db?.basics||{},c=current(data),s=c.summary;
    const roomCount=db?.integrated?.roomBasis?.count??b.rooms??r?.rooms;
    const products=r?.products||[],productCount=r?.productCount??(r?.products?products.length:null);
    const qualityWarning=r?.quality?.status&&r.quality.status!=='complete'?`<p class="collection-warning">${esc({partial:'일부 자료 확인 필요',blocked:'접근 제한',failed:'수집 실패'}[r.quality.status]||'자료 확인 필요')}${r.quality.reason?` · ${esc(r.quality.reason)}`:''}</p>`:'';
    const basisWarning=db?.integrated?.roomBasis?.reviewRequired?'<p class="collection-warning">객실 총량 검토가 필요합니다. 기존 객실 기준을 유지합니다.</p>':'';
    const start=s?.rangeStart||c.daily?.[0]?.date,end=s?.rangeEnd||c.daily?.at(-1)?.date;
    const selection=monthSelection(data,options),observed=hasObservation(data);
    const observationCard=observed||selection.visible||data.referenceLoading?`<section class="card db-current"><div class="db-current-heading">${heading('C','통합관측')}${selection.html}${observed?`<p class="muted">${esc(start)} ~ ${esc(end)}</p>`:''}</div>${observed?`${[quantityNote(s),revenuePartial(s)?'일부 가격 미확인 · 매출은 확인된 금액만 표시':''].filter(Boolean).map(note=>`<p class="muted">${esc(note)}</p>`).join('')}<div id="company-current-view">${currentView(data)}</div>`:`<p class="muted" role="status" data-reference-status="observation">${data.referenceLoading||['pending','updating'].includes(db?.integrated?.status)?'선택한 숙박월의 저장된 통합관측 자료를 확인하고 있습니다.':'선택한 숙박월의 통합관측 자료가 없습니다. 예약과 금액은 미확인입니다.'}</p>`}</section>`:'';
    return `${data.previousResult?'<p class="collection-warning">최근 저장 자료입니다. 이번 수집 요청의 완료 결과는 아닙니다.</p>':''}<div class="db-reference-grid"><section class="card db-basics">${heading('A','업체 기본정보')}${options.editHtml||''}<h3>${esc(b.name||'등록 업체')}</h3>${b.address||b.lodgingTypes?.length?`<p class="muted">${esc(b.address)} ${esc((b.lodgingTypes||[]).join(' · '))}</p>`:''}<div class="collection-summary company-basic-summary">${metric('객실 총량',rooms(roomCount),esc(roomSource(db)))}${metric('상품 종류',(numeric(productCount)?`${n(productCount)}개`:'확인 전'))}</div>${b.facilities?`<p class="muted">${esc(b.facilities)}</p>`:''}${r?.dayUse?`<p class="muted">데이유즈 ${r.dayUse.presence==='present'?'상품 있음':r.dayUse.presence==='absent'?'상품 없음':'확인 전'}${['shared','confirmed','separate','confirmed_separate'].includes(r.dayUse.sharing)?` · ${esc({shared:'숙박과 객실 공유',confirmed:'숙박과 객실 공유',separate:'별도 객실',confirmed_separate:'별도 객실'}[r.dayUse.sharing])}`:''}</p>`:''}${basisWarning}${r?.capacityWarning?`<p class="collection-warning capacity-warning">${esc(r.capacityWarning)}</p>`:''}${qualityWarning}${r?.truncated?'<p class="collection-warning">일부 상품 자료가 남아 있지 않습니다.</p>':''}${data.referenceLoading&&!data.referenceCatalogReady?'<p class="muted reference-pending" role="status" data-reference-status="products"><span class="connection-spinner" aria-hidden="true"></span>상품 자료 연결 중</p>':data.referenceError&&!data.referenceCatalogReady?'<p class="muted">상품 자료 연결 확인 필요</p>':productTable(products,options.collapseProducts)}</section><section class="card db-channels">${heading('B','예약채널')}<div class="db-channel-list">${(db?.channels||[]).map(ch=>`<article><div><strong>${esc(ch.label)}</strong>${ch.statusLabel?`<small>${esc(ch.statusLabel)}</small>`:''}</div>${ch.url?`<a class="button small" href="${esc(ch.url)}" target="_blank" rel="noreferrer">열기</a>`:''}</article>`).join('')|| (data.referenceLoading?'<p class="muted" role="status" data-reference-status="channels">저장된 예약채널 연결 중</p>':data.referenceError?'<p class="muted">예약채널 연결 확인 필요</p>':'<p class="muted">예약채널 확인 전</p>')}</div></section>${observationCard}</div>`;
  }
  window.InsightCompanyView={render,currentView,flowView,weeklyGroups,monthTotals,pickupModel,pickupView};
})();
