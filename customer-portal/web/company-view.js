(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const n=v=>numeric(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const rooms=v=>numeric(v)?`${n(v)}실`:'확인 전';
  const observedRooms=v=>numeric(v)?`${n(v)}실`:'미확인';
  const won=v=>numeric(v)?`${n(v)}원`:'미확인';
  const revenue=(value,partial)=>won(value)+(numeric(value)&&partial?'<small>일부 금액</small>':'');
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
    if(row.revenuePartial)notes.push('가격 일부 확인 필요');
    return notes.join(' · ')||'정상 관측';
  }
  function productTable(products=[]) {
    if(!products.length)return '<p class="empty-note">상품 관측 자료가 없습니다.</p>';
    const type={lodging:'숙박',dayuse:'데이유즈',unknown:'구분 확인 전'};
    return `<div class="collection-table-wrap db-product-table"><table><thead><tr><th>상품명</th><th>종류</th><th>관측 판매금액</th></tr></thead><tbody>${products.map(p=>{
      const prices=(p.days||[]).filter(d=>d.status==='observed'&&numeric(d.price)).map(d=>d.price);
      const min=prices.length?Math.min(...prices):null,max=prices.length?Math.max(...prices):null;
      return `<tr><th>${esc(p.name||'상품명 확인 전')}</th><td>${esc(type[p.productType]||type.unknown)}</td><td>${min==null?'가격 확인 전':min===max?won(min):`${won(min)} ~ ${won(max)}`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  function dailyTable(rows=[]) {
    const data=window.InsightCompanyFlow?.fillDays(rows)||rows;
    return `<div class="collection-table-wrap company-observation-table"><table><caption>날짜별 추정 예약·매출</caption><thead><tr><th>숙박일</th><th>예약 합계</th><th>공개 예약</th><th>방막기</th><th>예약률</th><th>매출 합계</th><th>공개 예약 매출</th><th>방막기 매출</th><th>관측 상태</th></tr></thead><tbody>${data.map(d=>{
      const known=!d.missing&&!d.inventoryConflict,publicBookings=known?d.publicBookings:null,blocked=known?d.phoneBookings:null;
      const total=numeric(publicBookings)&&numeric(blocked)?publicBookings+blocked:null;
      return `<tr class="${!known?'observation-unknown':''}"><th>${esc(d.date)}</th><td>${observedRooms(total)}</td><td class="public-value">${observedRooms(publicBookings)}</td><td class="${numeric(blocked)&&blocked>0?'estimated-value':''}">${observedRooms(blocked)}</td><td>${rate(known?d.reservationRate:null)}</td><td>${revenue(known?d.estimatedRevenue:null,d.revenuePartial)}</td><td class="public-value">${revenue(known?d.publicRevenue:null,d.revenuePartial)}</td><td class="${numeric(blocked)&&blocked>0?'estimated-value':''}">${revenue(known?d.phoneRevenue:null,d.revenuePartial)}</td><td>${esc(observationLabel(d))}</td></tr>`;
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
      return {...group,expectedDays,observedDays,revenueObservedDays,publicBookings,phoneBookings,
        bookings:observedDays?publicBookings+phoneBookings:null,estimatedRevenue:sum(revenueRows,'estimatedRevenue'),
        quantityPartial:observedDays<expectedDays||quantityRows.some(row=>row.partial),
        revenuePartial:revenueObservedDays<expectedDays||revenueRows.some(row=>row.revenuePartial||row.partial)};
    });
  }
  const shortDay=value=>`${Number(value.slice(5,7))}. ${Number(value.slice(8,10))}.`;
  function weeklyTable(rows,range) {
    const groups=weeklyGroups(rows,range);
    if(!groups.length)return '';
    return `<div class="week-label-row"><h3 class="week-table-title">주간 추정 예약·매출</h3><p class="muted">숙박일별 수량 합산</p></div><div class="company-week-list">${groups.map(group=>{
      const coverage=group.observedDays===group.revenueObservedDays?`관측 ${group.observedDays}/${group.expectedDays}일`:`예약 ${group.observedDays}/${group.expectedDays}일 · 매출 ${group.revenueObservedDays}/${group.expectedDays}일`;
      const partial=group.quantityPartial||group.revenuePartial;
      const status=!group.observedDays&&!group.revenueObservedDays?'미확인':`${group.quantityPartial?'일부 자료 · ':''}${coverage}`;
      return `<details class="company-week-group${partial?' is-partial':''}"><summary class="company-week-summary"><span class="week-period">${shortDay(group.start)} ~ ${shortDay(group.end)}</span><span class="week-bookings"><small>예약 합계</small><strong>${observedRooms(group.bookings)}</strong></span><span class="week-revenue"><small>매출 합계</small><strong>${won(group.estimatedRevenue)}</strong>${numeric(group.estimatedRevenue)&&group.revenuePartial?'<small>일부 금액</small>':''}</span><span class="week-state">${esc(status)}</span><span class="week-chevron" aria-hidden="true">⌄</span></summary><div class="week-label-row"><h4 class="week-table-title">${shortDay(group.start)} ~ ${shortDay(group.end)} · 날짜별 내역</h4><p class="company-mobile-hint">표를 좌우로 밀어 매출을 확인하세요.</p></div>${dailyTable(group.rows)}</details>`;
    }).join('')}</div>`;
  }
  function currentView(data) {
    const observation=current(data),rows=observation.daily||[];
    return (window.InsightCompanyFlow?.daily(rows)||'')+weeklyTable(rows,observation.summary||{});
  }
  // Keep the module interface for older callers; the company page shows only current observations.
  function flowView(data,options={}) {
    return window.InsightCompanyFlow?.history(data.companyDetail?.history?.observationFlow,options)||'';
  }
  function render(data) {
    const r=data.result,db=data.companyDetail,b=db?.basics||{},c=current(data),s=c.summary;
    const roomCount=db?.integrated?.roomBasis?.count??b.rooms??r?.rooms;
    const products=r?.products||[],productCount=r?.productCount??(r?.products?products.length:null);
    const qualityWarning=r?.quality?.status&&r.quality.status!=='complete'?`<p class="collection-warning">${esc({partial:'일부 자료 확인 필요',blocked:'접근 제한',failed:'수집 실패'}[r.quality.status]||'자료 확인 필요')}${r.quality.reason?` · ${esc(r.quality.reason)}`:''}</p>`:'';
    const basisWarning=db?.integrated?.roomBasis?.reviewRequired?'<p class="collection-warning">객실 총량 검토가 필요합니다. 기존 객실 기준을 유지합니다.</p>':'';
    const start=s?.rangeStart||c.daily?.[0]?.date,end=s?.rangeEnd||c.daily?.at(-1)?.date;
    const observationNote=[quantityNote(s),s?.revenuePartial?'일부 가격 미확인 · 매출은 확인된 금액만 표시':''].filter(Boolean).join(' · ');
    return `${data.previousResult?'<p class="collection-warning">최근 저장 자료입니다. 이번 수집 요청의 완료 결과는 아닙니다.</p>':''}<div class="db-reference-grid"><section class="card db-basics">${heading('A','업체 기본정보')}<h3>${esc(b.name||'등록 업체')}</h3>${b.address||b.lodgingTypes?.length?`<p class="muted">${esc(b.address)} ${esc((b.lodgingTypes||[]).join(' · '))}</p>`:''}<div class="collection-summary company-basic-summary">${metric('객실 총량',rooms(roomCount),esc(roomSource(db)))}${metric('상품 종류',(numeric(productCount)?`${n(productCount)}개`:'확인 전'))}</div>${b.facilities?`<p class="muted">${esc(b.facilities)}</p>`:''}${r?.dayUse?`<p class="muted">데이유즈 ${r.dayUse.presence==='present'?'상품 있음':r.dayUse.presence==='absent'?'상품 없음':'확인 전'}${['shared','confirmed','separate','confirmed_separate'].includes(r.dayUse.sharing)?` · ${esc({shared:'숙박과 객실 공유',confirmed:'숙박과 객실 공유',separate:'별도 객실',confirmed_separate:'별도 객실'}[r.dayUse.sharing])}`:''}</p>`:''}${basisWarning}${r?.capacityWarning?`<p class="collection-warning capacity-warning">${esc(r.capacityWarning)}</p>`:''}${qualityWarning}${r?.truncated?'<p class="collection-warning">일부 상품 자료가 남아 있지 않습니다.</p>':''}${productTable(products)}</section><section class="card db-channels">${heading('B','예약채널')}<div class="db-channel-list">${(db?.channels||[]).map(ch=>`<article><div><strong>${esc(ch.label)}</strong>${ch.statusLabel?`<small>${esc(ch.statusLabel)}</small>`:''}</div>${ch.url?`<a class="button small" href="${esc(ch.url)}" target="_blank" rel="noreferrer">열기</a>`:''}</article>`).join('')||'<p class="muted">예약채널 확인 전</p>'}</div></section>${hasObservation(data)?`<section class="card db-current"><div class="db-current-heading">${heading('C','통합관측')}<p class="muted">${esc(start)} ~ ${esc(end)}</p></div>${observationNote?`<p class="muted">${esc(observationNote)}</p>`:''}<div id="company-current-view">${currentView(data)}</div></section>`:''}</div>`;
  }
  window.InsightCompanyView={render,currentView,flowView,weeklyGroups};
})();
