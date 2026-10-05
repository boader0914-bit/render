(() => {
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const n=v=>v==null?'확인 전':Number(v).toLocaleString('ko-KR');
  const rooms=v=>v==null?'확인 전':`${n(v)}실`;
  const won=v=>v==null?'산출 보류':`${n(v)}원`;
  const rate=v=>v==null?'확인 전':`${(Number(v)*100).toFixed(1)}%`;
  const when=v=>v?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'관측 전';
  const heading=(key,title)=>`<div class="db-section-heading"><b>${key}</b><h2>${title}</h2></div>`;
  const metric=(label,value,help='',tone='')=>`<article class="${tone}"><span>${label}</span><strong>${value}</strong><small>${help}</small></article>`;
  const sum=(rows,key)=>rows.length&&rows.every(d=>d[key]!=null)?rows.reduce((s,d)=>s+d[key],0):null;
  const numeric=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const known=d=>d&&!d.missing&&!d.partial&&!d.inventoryConflict;
  const amount=v=>numeric(v)?`${n(Math.round(v/10000*10)/10)}만원`:'미확인';
  const bookingTotal=d=>known(d)&&numeric(d.publicBookings)&&numeric(d.phoneBookings)?d.publicBookings+d.phoneBookings:null;
  const quantity=v=>numeric(v)?rooms(v):'미확인';
  function parts(d,key,format) {
    const publicKey=key==='bookings'?'publicBookings':'publicRevenue',otherKey=key==='bookings'?'phoneBookings':'phoneRevenue';
    const publicValue=known(d)?d[publicKey]:null,otherValue=known(d)?d[otherKey]:null;
    return `<div class="company-breakdown"><span class="${numeric(publicValue)?'public-value':'muted'}">네이버 <b>${format(publicValue)}</b></span>${numeric(otherValue)&&otherValue===0?'':`<span class="${numeric(otherValue)?'estimated-value':'muted'}">타채널·전화 <b>${format(otherValue)}</b></span>`}</div>`;
  }
  function selectedDate(data,options={}) {
    if(options.day==='period')return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(options.day||''))return options.day;
    const rows=current(data)?.daily||[],today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
    return rows.some(d=>d.date===today)?today:rows.find(d=>known(d))?.date||rows[0]?.date||'';
  }
  function summaryView(data,options={}) {
    const c=current(data)||{},s=c.summary,rows=c.daily||[],selected=selectedDate(data,options);
    const d=selected?rows.find(d=>d.date===selected):s;
    const roomTotal=data.companyDetail?.basics?.rooms??data.result?.rooms;
    const revenue=known(d)?d.estimatedRevenue:null;
    return `<div class="company-summary-heading"><h3>${selected?'선택일':'기간'} 추정 예약·매출</h3><div class="company-date-controls"><label class="field"><span>숙박일 선택</span><input type="date" data-company-day value="${esc(selected)}"></label><button type="button" class="button small" data-company-period aria-pressed="${!selected}">기간 합계</button></div></div><div class="collection-summary company-combined-summary">${metric('객실 총량',quantity(roomTotal))}<article><span>예약</span><strong>${quantity(bookingTotal(d))}</strong>${parts(d,'bookings',quantity)}</article><article><span>매출</span><strong>${amount(revenue)}</strong>${parts(d,'revenue',amount)}${d?.revenuePartial?'<small>일부 금액</small>':''}</article></div><p class="muted company-scope">${selected?esc(selected):s?`${esc(s.rangeStart)} ~ ${esc(s.rangeEnd)} · 날짜별 예약수량 합계`:''}${known(d)&&d.reservationRate!=null?` · 예약률 ${rate(d.reservationRate)}`:''}</p>`;
  }
  function channelRows(d) {
    const pub=known(d)?d.publicBookings:null,other=known(d)?d.phoneBookings:null;
    return `<small class="${numeric(pub)?'public-value':'muted'}">네이버 ${quantity(pub)} · ${amount(known(d)?d.publicRevenue:null)}</small>${other===0?'':`<small class="${numeric(other)?'estimated-value':'muted'}">타채널·전화 ${quantity(other)} · ${amount(known(d)?d.phoneRevenue:null)}</small>`}`;
  }
  function current(data) {
    if (data.companyDetail) return data.companyDetail.current;
    const rows=(data.result?.days||[]).filter(d=>d.productType==='lodging').map(d=>({date:d.date,total:d.total,sold:d.publicBookings!=null&&d.estimatedBlocked!=null?d.publicBookings+d.estimatedBlocked:null,publicBookings:d.publicBookings,phoneBookings:d.estimatedBlocked,publicRevenue:d.publicRevenue,phoneRevenue:d.estimatedRevenue,estimatedRevenue:d.publicRevenue!=null&&d.estimatedRevenue!=null?d.publicRevenue+d.estimatedRevenue:null,partial:d.status!=='observed',missing:d.status==='missing',sharedDayUseExcluded:d.sharedDayUseExcluded}));
    const supply=sum(rows,'total'),sold=sum(rows,'sold');
    return {daily:rows,summary:rows.length?{rangeStart:rows[0].date,rangeEnd:rows.at(-1).date,observedDays:rows.length,calendarDays:data.result.range.days,estimatedRevenue:sum(rows,'estimatedRevenue'),publicRevenue:sum(rows,'publicRevenue'),phoneRevenue:sum(rows,'phoneRevenue'),publicBookings:sum(rows,'publicBookings'),phoneBookings:sum(rows,'phoneBookings'),reservationRate:!rows.some(d=>d.partial)&&supply>0&&sold!=null?sold/supply:null,partial:rows.some(d=>d.partial)}:null};
  }
  function calendar(rows=[],selected='',selectedMonth='') {
    const months=[...new Set(rows.filter(d=>d.date).map(d=>d.date.slice(0,7)))].sort();
    if(!months.length)return '<p class="empty-note">관측한 숙박일이 없습니다.</p>';
    const byDate=new Map(rows.map(d=>[d.date,d]));
    const month=months.includes(selectedMonth)?selectedMonth:months.includes(selected.slice(0,7))?selected.slice(0,7):months[0],index=months.indexOf(month);
    const [y,m]=month.split('-').map(Number),start=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7,days=new Date(Date.UTC(y,m,0)).getUTCDate();
    return `<section class="company-month-calendar" aria-label="${month} 예약 관측"><div class="company-month-heading"><div><span class="eyebrow">MONTHLY CALENDAR</span><h3>날짜별 예약·매출</h3></div><div class="company-month-nav" role="group" aria-label="관측 월 이동"><button type="button" class="button small" data-calendar-month="${months[index-1]||''}" aria-label="이전 달" ${index===0?'disabled':''}>‹</button><label class="field"><span class="sr-only">표시할 숙박월</span><select data-calendar-month-select aria-label="표시할 숙박월">${months.map(value=>`<option value="${value}" ${value===month?'selected':''}>${Number(value.slice(0,4))}년 ${Number(value.slice(5))}월</option>`).join('')}</select></label><button type="button" class="button small" data-calendar-month="${months[index+1]||''}" aria-label="다음 달" ${index===months.length-1?'disabled':''}>›</button></div></div><p class="company-month-hint">날짜를 누르면 상세 보기 <span>네이버 <i class="public-dot"></i> · 타채널·전화 <i class="estimate-dot"></i></span></p><div class="company-month-scroll" tabindex="0" aria-label="월간 달력 가로 스크롤"><div class="db-calendar-grid company-ops-grid">${['월','화','수','목','금','토','일'].map((day,i)=>`<div class="db-weekday ${i===5?'saturday':i===6?'sunday':''}">${day}</div>`).join('')}${Array.from({length:start},()=>'<div class="company-month-blank" aria-hidden="true"></div>').join('')}${Array.from({length:days},(_,i)=>{
        const date=`${month}-${String(i+1).padStart(2,'0')}`,d=byDate.get(date),weekday=new Date(date+'T00:00:00Z').getUTCDay();
        const hasOther=known(d)&&numeric(d.phoneBookings)&&d.phoneBookings>=1;
        return `<button type="button" data-company-date="${date}" aria-pressed="${date===selected}" aria-label="${date} 예약·매출 보기" class="db-calendar-day ${!known(d)?'unobserved':hasOther?'has-estimate':'has-public'} ${weekday===6?'saturday':weekday===0?'sunday':''}"><strong class="company-day-number">${i+1}</strong>${!d||d.missing?'<small>예약 미확인</small><small>매출 미확인</small>':`<span class="calendar-total"><small>예약</small><b>${quantity(bookingTotal(d))}</b></span><span class="calendar-total"><small>매출</small><b>${amount(known(d)?d.estimatedRevenue:null)}</b></span>${channelRows(d)}${d.partial||d.inventoryConflict?'<small>일부 확인 필요</small>':d.revenuePartial?'<small>일부 금액</small>':''}`}</button>`;
      }).join('')}${Array.from({length:(7-(start+days)%7)%7},()=>'<div class="company-month-blank" aria-hidden="true"></div>').join('')}</div></div></section>`;
  }
  function dayDetail(data,options={}) {
    const selected=selectedDate(data,options),rows=current(data)?.daily||[],d=rows.find(row=>row.date===selected);
    if(!selected)return '';
    return `<section class="company-day-detail" aria-label="선택한 날짜 상세"><div class="company-day-heading"><h3>${esc(selected)} <span>선택일 상세</span></h3><span class="status-pill">${!d||d.missing?'미확인':d.inventoryConflict?'객실 수 충돌':d.partial?'일부 확인 필요':'관측 자료'}</span></div>${summaryView(data,{...options,day:selected})}${options.own&&window.InsightCompanyAdjustment?window.InsightCompanyAdjustment.render(d||{date:selected,missing:true},{own:true,capacity:data.companyDetail?.basics?.rooms??data.result?.rooms}):''}</section>`;
  }
  function dailyTable(rows=[]) {
    return `<div class="collection-table-wrap"><table><thead><tr><th>숙박일</th><th>객실 총량</th><th>예약 합계</th><th>매출 합계</th><th>네이버 예약</th><th>네이버 매출</th><th>타채널·전화 예약</th><th>타채널·전화 매출</th><th>공유 데이유즈 제외</th><th>예약률</th><th>관측 상태</th></tr></thead><tbody>${rows.map(d=>{const valid=known(d),v=k=>valid?d[k]:null;return `<tr><th>${esc(d.date)}</th><td>${quantity(v('total'))}</td><td>${quantity(bookingTotal(d))}</td><td>${amount(v('estimatedRevenue'))}${valid&&d.revenuePartial?' · 일부 금액':''}</td><td class="${valid?'public-value':'muted'}">${quantity(v('publicBookings'))}</td><td class="${valid?'public-value':'muted'}">${amount(v('publicRevenue'))}</td><td class="${valid?'estimated-value':'muted'}">${quantity(v('phoneBookings'))}</td><td class="${valid?'estimated-value':'muted'}">${amount(v('phoneRevenue'))}</td><td>${quantity(v('sharedDayUseExcluded'))}</td><td>${rate(v('reservationRate'))}</td><td>${d.missing?'미수집':d.inventoryConflict?'객실 수 충돌':d.partial?'일부 확인 필요':'관측'}</td></tr>`;}).join('')}</tbody></table></div>`;
  }
  function history(model) {
    if(!model)return '<p class="empty-note">누적 이력을 연결하지 못했습니다.</p>';
    const lead=model.leadTime;
    return `<div class="collection-summary">${metric('추정 평균 리드타임',lead.averageDays==null?'관측 대기':`${n(lead.averageDays)}일`,esc(lead.label))}${metric('수집한 관측일',lead.collectedDateCount==null?'확인 전':`${n(lead.collectedDateCount)}일`,'같은 숙박일의 예약 증가로 추정')}${metric('관측 예약 증가',rooms(lead.pickupCount),'실제 예약 접수 시각과 다를 수 있습니다.')}</div>
      <details><summary>키워드별 순위 이력</summary><p class="muted">키워드와 검색 범위별로 구분합니다.</p>${model.ranks.map(k=>`<details class="db-history-keyword"><summary>${esc(k.keyword)} · ${esc(k.scope)} · 최근 ${k.points.length}회 관측</summary><div class="collection-table-wrap"><table><thead><tr><th>관측 시각</th><th>순위</th><th>직전 대비</th></tr></thead><tbody>${k.points.map(p=>`<tr><th>${esc(when(p.collectedAt))}</th><td>${n(p.rank)}위</td><td>${p.delta==null?'비교 대기':`${p.delta>0?'▲':p.delta<0?'▼':''}${n(Math.abs(p.delta))}`}</td></tr>`).join('')}</tbody></table></div></details>`).join('')||'<p class="muted">순위 관측 이력이 없습니다.</p>'}</details>
      <details><summary>수집 시점별 예약·추정매출</summary><p class="muted">최근 수집 시점의 자료입니다. 조회 기간이 같은 자료끼리 비교하며, 수집 회차별 매출을 서로 더하지 않습니다.</p><div class="collection-table-wrap"><table><thead><tr><th>수집 시각</th><th>숙박 시작일</th><th>관측일수</th><th>추정 예약률</th><th>추정매출</th></tr></thead><tbody>${model.performance.map(p=>`<tr><th>${esc(when(p.collectedAt))}</th><td>${esc(p.checkIn)}</td><td>${n(p.observedDays)}일</td><td>${rate(p.reservationRate)}</td><td>${won(p.estimatedRevenue)}${p.partial?' · 일부 확인 필요':''}</td></tr>`).join('')}</tbody></table></div></details>
      <details><summary>지난 숙박일 · 월별 누적 자료</summary><p class="muted">동일 숙박일의 중복 관측은 업체DB 기준으로 정리합니다. 미수집은 0으로 계산하지 않습니다.</p>${model.months.map(m=>`<details class="db-history-month"><summary>${esc(m.month)} · 추정매출 ${won(m.summary?.estimatedRevenue)} · 관측 ${n(m.summary?.observedDays)}/${n(m.summary?.calendarDays)}일${m.summary?.revenuePartial?' · 일부 금액':''}</summary>${dailyTable(m.daily)}</details>`).join('')||'<p class="muted">지난 숙박일의 자료가 없습니다.</p>'}</details>`;
  }
  function currentView(data,options={}) {
    const rows=current(data)?.daily||[];
    if((!options.mode||['default','graph'].includes(options.mode))&&window.InsightCompanyFlow)return window.InsightCompanyFlow.daily(rows,{selectedDate:selectedDate(data,options)});
    if(options.mode==='table')return dailyTable(rows);
    if(options.mode==='list')return '<div class="company-date-list">'+(window.InsightCompanyFlow?.fillDays(rows)||rows).map(d=>`<button type="button" data-company-date="${esc(d.date)}" aria-pressed="${d.date===selectedDate(data,options)}"><strong>${esc(d.date)}</strong><span>예약 ${quantity(bookingTotal(d))} · 매출 ${amount(known(d)?d.estimatedRevenue:null)}</span>${channelRows(d)}${!known(d)?'<small>미확인 · 자료 상태 확인 필요</small>':d.revenuePartial?'<small>일부 금액</small>':''}</button>`).join('')+'</div>';
    return calendar(rows,selectedDate(data,options),options.calendarMonth);
  }
  function controls(mode='default') {return '<div class="company-view-switch" role="group" aria-label="업체 자료 보기 방식">'+Object.entries({graph:'그래프',calendar:'캘린더',list:'날짜 목록',table:'표'}).map(([key,label])=>'<button type="button" class="button small" data-company-view="'+key+'" aria-pressed="'+(key===(mode==='default'?'graph':mode))+'">'+label+'</button>').join('')+'</div>';}
  function flowView(data,options={}) {return window.InsightCompanyFlow?.history(data.companyDetail?.history?.observationFlow,options)||'<p class="empty-note">관측일별 흐름을 준비 중입니다.</p>';}
  function render(data,productsHtml,options={}) {
    const r=data.result,db=data.companyDetail,b=db?.basics||{},c=current(data)||{},s=c.summary;
    const roomTotal=b.rooms??r?.rooms,source=b.roomCountSource||r?.roomCountSource||'확인 전';
    const warnings=`${data.previousResult?'<p class="collection-warning">업체DB의 최신 저장 자료입니다. 이번 요청의 완료 결과가 아닙니다.</p>':''}${r?.quality?.status&&r.quality.status!=='complete'?`<p class="collection-warning">${esc({partial:'일부 완료',blocked:'접근 제한',failed:'실패'}[r.quality.status]||'품질 확인 필요')} · ${esc(r.quality.reason)}</p>`:''}${r?.truncated?'<p class="collection-warning">보존된 상품 목록이 일부만 남아 있습니다.</p>':''}`;
    const channels=(db?.channels||[]).map(ch=>{let url='';try{const u=new URL(ch.url);if(['https:','http:'].includes(u.protocol))url=u.href;}catch{}return `<article><div><strong>${esc(ch.label)}</strong><small>${esc(ch.statusLabel||'확인 전')}</small></div>${url?`<a class="button small" href="${esc(url)}" target="_blank" rel="noreferrer">열기 ↗</a>`:''}</article>`;}).join('');
    const dayUse=r?.dayUse?.presence==='present'?'데이유즈 있음':r?.dayUse?.presence==='absent'?'숙박 상품':'데이유즈 확인 전';
    return `${warnings}<div class="db-reference-grid company-detail-layout">
      <section class="card db-basics">${heading('A','객실·상품')}<div class="company-capacity"><div><span>객실 총량</span><strong>${quantity(roomTotal)}</strong><small>${esc(source)}</small></div><div><span>상품 종류</span><strong>${r?.productCount!=null?n(r.productCount)+'개':'미확인'}</strong><small>${dayUse}${r?.dayUse?.sharing==='shared'||r?.dayUse?.sharing==='confirmed'?' · 숙박과 공유':''}</small></div><div class="company-identity"><h3>${esc(b.name||'등록 업체')}</h3><p>${esc(b.address||'')} ${esc((b.lodgingTypes||[]).join(' · '))}</p></div></div>${r?.capacityWarning?`<p class="collection-warning capacity-warning">${esc(r.capacityWarning)}</p>`:''}${window.InsightCompanyProducts?window.InsightCompanyProducts.render(r):''}<details class="company-source-details"><summary>상품별 수량·가격 근거와 수정 요청</summary><div class="collection-products">${productsHtml||'<p class="empty-note">상품 관측 자료가 없습니다.</p>'}</div></details></section>
      <section class="card db-channels">${heading('B','예약 채널')}<div class="db-channel-list">${channels||'<p class="muted">예약 채널 확인 전</p>'}</div></section>
      <section class="card db-current"><div class="company-observation-heading">${heading('C','최근 운영 관측')}${controls(options.mode)}</div><p class="company-observation-scope">${s?`숙박일 ${esc(s.rangeStart)} ~ ${esc(s.rangeEnd)} · 수량 확인 ${n(s.observedDays)}/${n(s.calendarDays)}일`:'예약 관측 자료 없음'}${r?.collectedAt?`<span>최근 수집 ${esc(when(r.collectedAt))}</span>`:''}</p><div id="company-current-summary">${options.mode==='calendar'?'':summaryView(data,options)}</div>${r?.issues?.length?`<details class="collection-warning"><summary>미확보 자료 ${r.issues.length}건 · 원인 확인</summary><ul>${r.issues.map(i=>`<li>${esc(i.productName)} · ${esc(i.label||i.code)} · ${esc((i.dates||[]).join(', '))}</li>`).join('')}</ul></details>`:''}<div id="company-current-view">${currentView(data,options)}</div><div id="company-selected-detail">${options.mode==='calendar'?dayDetail(data,options):''}</div></section>
      <details class="card db-history"><summary>D. 누적 이력·관리</summary><details id="company-flow-details"><summary>같은 숙박월의 예약 변화</summary><div id="company-history-flow">${flowView(data,options)}</div></details>${history(db?.history)}</details></div>`;
  }
  window.InsightCompanyView={render,current,currentView,flowView,summaryView,selectedDate,dayDetail,calendar};
})();
