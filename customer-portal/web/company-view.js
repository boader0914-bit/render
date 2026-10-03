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
  function current(data) {
    if (data.companyDetail) return data.companyDetail.current;
    const rows=(data.result?.days||[]).filter(d=>d.productType==='lodging').map(d=>({date:d.date,total:d.total,sold:d.publicBookings!=null&&d.estimatedBlocked!=null?d.publicBookings+d.estimatedBlocked:null,publicBookings:d.publicBookings,phoneBookings:d.estimatedBlocked,publicRevenue:d.publicRevenue,phoneRevenue:d.estimatedRevenue,estimatedRevenue:d.publicRevenue!=null&&d.estimatedRevenue!=null?d.publicRevenue+d.estimatedRevenue:null,partial:d.status!=='observed',missing:d.status==='missing',sharedDayUseExcluded:d.sharedDayUseExcluded}));
    const supply=sum(rows,'total'),sold=sum(rows,'sold');
    return {daily:rows,summary:rows.length?{rangeStart:rows[0].date,rangeEnd:rows.at(-1).date,observedDays:rows.length,calendarDays:data.result.range.days,estimatedRevenue:sum(rows,'estimatedRevenue'),publicRevenue:sum(rows,'publicRevenue'),phoneRevenue:sum(rows,'phoneRevenue'),publicBookings:sum(rows,'publicBookings'),phoneBookings:sum(rows,'phoneBookings'),reservationRate:!rows.some(d=>d.partial)&&supply>0&&sold!=null?sold/supply:null,partial:rows.some(d=>d.partial)}:null};
  }
  function calendar(rows=[]) {
    const months=[...new Set(rows.filter(d=>d.date).map(d=>d.date.slice(0,7)))].sort();
    if(!months.length)return '<p class="empty-note">관측한 숙박일이 없습니다.</p>';
    const byDate=new Map(rows.map(d=>[d.date,d]));
    return `<div class="db-calendars">${months.map(month=>{
      const [y,m]=month.split('-').map(Number),start=new Date(Date.UTC(y,m-1,1)).getUTCDay(),days=new Date(Date.UTC(y,m,0)).getUTCDate();
      return `<section class="db-calendar" aria-label="${month} 예약 관측"><h3>${y}년 ${m}월</h3><p class="muted db-calendar-hint">달력을 좌우로 밀어 날짜별 자료를 확인하세요.</p><div class="db-calendar-grid">${['일','월','화','수','목','금','토'].map(d=>`<div class="db-weekday">${d}</div>`).join('')}${Array.from({length:start},()=>'<div aria-hidden="true"></div>').join('')}${Array.from({length:days},(_,i)=>{
        const date=`${month}-${String(i+1).padStart(2,'0')}`,d=byDate.get(date);
        return `<div class="db-calendar-day ${!d||d.missing?'unobserved':d.phoneBookings>0?'has-estimate':'has-public'}"><strong>${i+1}</strong>${!d||d.missing?'<small>미수집</small>':`<small>총량 ${rooms(d.total)}</small><small class="public-value">공개 ${n(d.publicBookings)}${d.publicBookings==null?'':'실'}</small><small class="estimated-value">방막기 ${n(d.phoneBookings)}${d.phoneBookings==null?'':'실'}</small><small>${d.estimatedRevenue==null?'매출 확인 전':`${n(Math.round(d.estimatedRevenue/10000*10)/10)}만원`}</small>${d.partial?'<small>일부 확인 필요</small>':''}`}</div>`;
      }).join('')}</div></section>`;
    }).join('')}</div>`;
  }
  function dailyTable(rows=[]) {
    return `<div class="collection-table-wrap"><table><thead><tr><th>숙박일</th><th>객실 총량</th><th>공개 예약</th><th>공개 예약 매출</th><th>방막기 추정</th><th>방막기 추정 매출</th><th>공유 데이유즈 제외</th><th>예약률</th><th>관측 상태</th></tr></thead><tbody>${rows.map(d=>`<tr><th>${esc(d.date)}</th><td>${n(d.total)}</td><td class="public-value">${n(d.publicBookings)}</td><td class="public-value">${won(d.publicRevenue)}</td><td class="estimated-value">${n(d.phoneBookings)}</td><td class="estimated-value">${won(d.phoneRevenue)}</td><td>${n(d.sharedDayUseExcluded)}</td><td>${rate(d.reservationRate)}</td><td>${d.missing?'미수집':d.partial?'일부 확인 필요':'관측'}</td></tr>`).join('')}</tbody></table></div>`;
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
    if(options.mode==='graph')return window.InsightCompanyFlow.daily(rows,options.metric);
    if(options.mode==='table')return dailyTable(rows);
    return calendar(rows)+(options.mode==='calendar'?'':'<details><summary>날짜별 예약·추정매출 표</summary>'+dailyTable(rows)+'</details>');
  }
  function controls(mode='default') {return '<div class="company-view-switch" role="group" aria-label="업체 자료 보기 방식">'+Object.entries({default:'기본 보기',graph:'그래프',calendar:'캘린더',table:'표'}).map(([key,label])=>'<button type="button" class="button small" data-company-view="'+key+'" aria-pressed="'+(key===mode)+'">'+label+'</button>').join('')+'</div>';}
  function flowView(data,options={}) {return window.InsightCompanyFlow?.history(data.companyDetail?.history?.observationFlow,options)||'<p class="empty-note">관측일별 흐름을 준비 중입니다.</p>';}
  function render(data,productsHtml,options={}) {
    const r=data.result,db=data.companyDetail,b=db?.basics||{},c=current(data),s=c.summary;
    const companySummary=r?`<div class="collection-summary">${metric('객실 총량',rooms(r.rooms),esc(r.roomCountSource)+(r.originalRooms!=null?` · 이번 관측 최대 ${rooms(r.originalRooms)}`:''))}${metric('상품 종류',`${r.productCount}개`,'상품 수와 객실 수는 다릅니다.')}${metric('최근 수집 범위',`${n(r.range.days)}일`,`${esc(r.range.start)} ~ ${esc(r.range.end)}`)}</div>`:'';
    return `${data.previousResult?'<p class="collection-warning">아래는 업체DB의 최신 저장 자료이며, 내 수집 요청과 다른 수집에서 확보한 자료입니다. 이번 요청의 완료 결과가 아닙니다.</p>':''}${r?.quality?.status && r.quality.status!=='complete'?`<p class="collection-warning">${esc({partial:'일부 완료',blocked:'접근 제한',failed:'실패'}[r.quality.status]||'품질 확인 필요')} · ${esc(r.quality.reason)}</p>`:''}${r?.truncated?'<p class="collection-warning">보존된 상품 목록이 일부만 남아 있습니다.</p>':''}
      <div class="db-reference-grid"><section class="card db-basics">${heading('A','업체 기본정보')}<h3>${esc(b.name||'등록 업체')}</h3><p class="muted">${esc(b.address)} ${esc((b.lodgingTypes||[]).join(' · '))}</p>${companySummary||`<p>객실 총량 ${rooms(b.rooms)} · ${esc(b.roomCountSource)}</p>`}<p class="muted">시설·편의정보: ${esc(b.facilities||'확인 전')}</p>${r?`<p class="muted">데이유즈 ${r.dayUse.presence==='present'?'상품 있음':r.dayUse.presence==='absent'?'상품 없음':'확인 전'} · 공유 여부 ${esc({shared:'숙박과 공유',confirmed:'숙박과 공유',separate:'별도 객실',confirmed_separate:'별도 객실'}[r.dayUse.sharing]||'확인 전')}</p>${r.capacityWarning?`<p class="collection-warning capacity-warning">${esc(r.capacityWarning)}</p>`:''}<details><summary>객실·상품 ${r.productCount}개 · 수량·가격·수정 요청</summary><div class="collection-products">${productsHtml}</div></details>`:'<p class="empty-note">객실·상품 관측 자료가 없습니다.</p>'}</section>
      <section class="card db-channels">${heading('B','예약 채널')}<div class="db-channel-list">${(db?.channels||[]).map(ch=>`<article><div><strong>${esc(ch.label)}</strong><small>${esc(ch.statusLabel)} · ${esc(when(ch.checkedAt))}</small></div>${ch.url?`<a class="button small" href="${esc(ch.url)}" target="_blank" rel="noreferrer">열기</a>`:''}</article>`).join('')||'<p class="muted">예약 채널 확인 전</p>'}</div><p class="muted">외부 채널은 데이터랩에서 확인·적용한 항목만 표시합니다. 연결 상태와 매출 확보 여부는 별개입니다.</p></section>
      <section class="card db-current">${heading('C','최근 운영 관측')}${controls(options.mode)}<p class="muted">${s?`${esc(s.rangeStart)} ~ ${esc(s.rangeEnd)} · 업체DB 통합 관측 ${n(s.observedDays)}/${n(s.calendarDays)}일`:'예약 관측 자료 없음'}</p>${r?`<p class="muted">최근 자료 수집 ${esc(when(r.collectedAt))}</p>`:''}<div class="collection-summary">${metric('예약·추정매출',won(s?.estimatedRevenue),s?.estimatedRevenue==null?'수량·가격·관측 범위 확인이 필요합니다.':s?.revenuePartial?'가격 근거가 확보된 일부 금액':'실제 결제 매출이 아닌 관측 기반 추정')}${metric('공개 예약',`${rooms(s?.publicBookings)}`,won(s?.publicRevenue),'public-value')}${metric('방막기 추정',`${rooms(s?.phoneBookings)}`,won(s?.phoneRevenue),'estimated-value')}${metric('추정 예약률',rate(s?.reservationRate),s?.partial?'수량 확인이 필요한 날짜가 있습니다.':'공유 데이유즈 제외·DB 검수 기준 적용')}</div><p class="muted">기간 합계는 날짜별 객실 수의 합입니다. 실제 전체 객실 수는 A의 객실 총량을 확인하세요.</p><div class="collection-legend"><span class="public-value">● 공개 예약</span><span class="estimated-value">● 방막기 추정</span><span>오류·누락은 정상 응답 0과 구분</span></div>${r?.issues.length?`<details class="collection-warning"><summary>미확보 자료 ${r.issues.length}건 · 원인 확인</summary><ul>${r.issues.map(i=>`<li>${esc(i.productName)} · ${esc(i.label||i.code)} · ${esc(i.dates.join(', '))}</li>`).join('')}</ul></details>`:''}<div id="company-current-view">${currentView(data,options)}</div></section>
      <section class="card db-history">${heading('D','누적 이력·관리')}<details id="company-flow-details" ${options.mode==='graph'?'open':''}><summary>같은 숙박월의 예약 변화 · 그래프</summary><div id="company-history-flow">${flowView(data,options)}</div></details>${history(db?.history)}</section></div>`;
  }
  window.InsightCompanyView={render,currentView,flowView};
})();
