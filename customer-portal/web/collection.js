(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count = v => v == null ? '확인 전' : `${Number(v).toLocaleString('ko-KR')}실`;
  const money = v => v == null ? '가격 없음' : `${Number(v).toLocaleString('ko-KR')}원`;
  const types = {lodging:'숙박',dayuse:'데이유즈',unknown:'구분 확인 전'};
  const statuses = {dispatching:'접수 확인',queued:'수집 대기',collecting:'수집 대기·진행 중',ready:'완료',partial:'일부 완료',blocked:'접근 제한',failed:'실패',needs_review:'확인 필요'};
  const active = r => ['dispatching','queued','collecting'].includes(r?.status);
  let api, companyId, view = null, serial = 0, timer, renderedVersion, loadOrder=0;
  const date = () => new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  let allowance=null,display={mode:'default',metric:'bookings',month:'',calendarMonth:'',day:undefined,own:false};
  function savedMode(){try{const mode=localStorage.getItem('insight-company-view');return ['default','graph','calendar','list','table'].includes(mode)?mode:'default';}catch{return 'default';}}
  function refreshDisplay(){
    if(!view)return;
    const active=document.activeElement,focusDate=active?.dataset?.companyDate,focusChart=active?.closest?.('[data-chart-metric]')?.dataset?.chartMetric,dateInput=active?.matches?.('[data-company-day]'),monthInput=active?.matches?.('[data-calendar-month-select]'),monthButton=active?.getAttribute?.('aria-label');
    const scrollLeft=document.querySelector('.company-month-scroll')?.scrollLeft||0;
    const current=document.querySelector('#company-current-view'),history=document.querySelector('#company-history-flow'),detail=document.querySelector('#company-selected-detail');
    if(current)current.innerHTML=window.InsightCompanyView.currentView(view,display);
    const summary=document.querySelector('#company-current-summary');
    if(summary&&window.InsightCompanyView.summaryView)summary.innerHTML=display.mode==='calendar'?'':window.InsightCompanyView.summaryView(view,display);
    if(history)history.innerHTML=window.InsightCompanyView.flowView(view,display);
    if(detail)detail.innerHTML=display.mode==='calendar'?window.InsightCompanyView.dayDetail(view,display):'';
    document.querySelectorAll?.('[data-company-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.companyView===(display.mode==='default'?'graph':display.mode))));
    const scroll=document.querySelector('.company-month-scroll');if(scroll)scroll.scrollLeft=scrollLeft;
    if(/^\d{4}-\d{2}-\d{2}$/.test(focusDate||'')){const prefix=['rate','bookings','revenue'].includes(focusChart)?`[data-chart-metric="${focusChart}"] `:'';document.querySelector(`${prefix}[data-company-date="${focusDate}"]`)?.focus?.({preventScroll:true});}
    else if(dateInput)document.querySelector('[data-company-day]')?.focus?.({preventScroll:true});
    else if(monthInput||['이전 달','다음 달'].includes(monthButton))document.querySelector('[data-calendar-month-select]')?.focus?.({preventScroll:true});
  }
  function chooseMonth(month){if(!/^\d{4}-\d{2}$/.test(month||''))return;display.calendarMonth=month;if(!display.day?.startsWith(month))display.day=window.InsightCompanyView.current(view)?.daily?.find(d=>d.date.startsWith(month))?.date||month+'-01';refreshDisplay();}
  document.addEventListener?.('click',event=>{
    const day=event.target.closest?.('[data-company-date]');if(day){display.day=day.dataset.companyDate;display.calendarMonth=display.day.slice(0,7);refreshDisplay();return;}
    const month=event.target.closest?.('[data-calendar-month]');if(month&&!month.disabled){chooseMonth(month.dataset.calendarMonth);return;}
    if(event.target.closest?.('[data-company-period]')){display.day='period';refreshDisplay();return;}
    const choice=event.target.closest?.('[data-company-view]');if(choice){display.mode=choice.dataset.companyView;try{localStorage.setItem('insight-company-view',display.mode);}catch{}refreshDisplay();return;}
    const button=event.target.closest?.('[data-open-collection]');if(button){const panel=document.querySelector('#collection-settings');if(panel){panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));}}
  });
  document.addEventListener?.('change',event=>{if(event.target.matches?.('[data-company-day]')){display.day=event.target.value||'period';if(display.day!=='period')display.calendarMonth=display.day.slice(0,7);refreshDisplay();}else if(event.target.matches?.('[data-calendar-month-select]'))chooseMonth(event.target.value);else if(event.target.matches?.('[data-flow-metric]')){display.metric=event.target.value;refreshDisplay();}else if(event.target.matches?.('[data-flow-month]')){display.month=event.target.value;refreshDisplay();}});
  document.addEventListener?.('keydown',event=>{const day=event.target.closest?.('svg [data-company-date]');if(day&&['Enter',' '].includes(event.key)){event.preventDefault();display.day=day.dataset.companyDate;display.calendarMonth=display.day.slice(0,7);refreshDisplay();}});
  document.addEventListener?.('submit',event=>{
    const form=event.target;if(!form.matches?.('[data-company-adjustment-preview]'))return;event.preventDefault();
    if(!window.InsightCompanyAdjustment?.isEnabled?.())return;
    const output=form.querySelector('[data-adjustment-output]');if(!output||!display.own)return;
    try{const row=window.InsightCompanyView.current(view)?.daily?.find(d=>d.date===form.dataset.companyAdjustmentDate)||{missing:true};const values=Object.fromEntries(new FormData(form)),capacity=view?.companyDetail?.basics?.rooms??view?.result?.rooms;
      const result=window.InsightCompanyAdjustment.calculate(row,values,capacity),delta=(value,unit)=>value==null?'비교 불가':(value>0?'+':'')+value.toLocaleString('ko-KR')+unit;
      output.textContent=`미리보기 · 예약 ${result.bookings==null?'미확인':result.bookings+'실'} (${delta(result.bookingDelta,'실')}) · 매출 ${result.revenue==null?'미확인':money(result.revenue)} (${delta(result.revenueDelta,'원')}). 저장·리포트에는 반영되지 않습니다.`;
    }catch(error){output.textContent=error.message;}
  });
  document.addEventListener?.('reset',event=>{if(event.target.matches?.('[data-company-adjustment-preview]')){const output=event.target.querySelector('[data-adjustment-output]');if(output)output.textContent='';}});
  function allowanceText(q) {
    if(!q)return '오늘 수집 가능 여부를 확인하고 있습니다.';
    if(q.limit===null)return '관리자는 일일 횟수 제한을 적용하지 않습니다. 동일 업체·조건은 기존 작업을 확인합니다.';
    return q.canRequest ? '일반 고객 · 계정 전체 하루 1회 · 오늘 요청 가능 · 한국시간 기준' : '오늘 수집 요청 1/1회 사용 · '+new Date(q.resetsAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+'부터 다시 요청 가능';
  }
  function panel(company, enabled, request, quota, openCollection=false) {
    allowance=quota||null;
    const intent=request?.intent || {}, start=intent.checkIn>=date()?intent.checkIn:date(), mode=intent.dayUseMode || 'inspect';
    return '<section class="card company-data-heading"><span class="eyebrow">COMPANY DATABASE</span><h1>'+esc(company.name)+' 업체 자료</h1><div class="connected-actions"><button type="button" class="button primary" data-open-collection aria-controls="collection-settings" aria-expanded="'+openCollection+'">30일 예약·추정매출 수집</button><button type="button" class="button" data-action="refresh-collection">저장 자료 다시 보기</button></div></section><section id="collection-settings" class="card collection-setup" '+(openCollection?'':'hidden')+'><h2>새로운 예약·추정매출 수집</h2><form data-collect="'+esc(company.companyId)+'"><div class="form-grid collection-fields"><label class="field"><span>숙박 시작일</span><input name="checkIn" type="date" min="'+date()+'" value="'+esc(start)+'" required></label><label class="field"><span>수집 기간</span><input value="시작일 포함 30일" readonly><input type="hidden" name="bookingRangeDays" value="30"></label><label class="field"><span>데이유즈</span><select name="dayUseMode">'+Object.entries({inspect:'유무 확인',lodging_only:'숙박만',detail:'상세 수집'}).map(([v,n])=>'<option value="'+v+'" '+(mode===v?'selected':'')+'>'+n+'</option>').join('')+'</select></label></div><p class="muted">30일의 날짜별 예약 수량과 숙박 객실 판매금액을 확인합니다. 데이유즈의 날짜별 수량은 상세 수집을 선택하세요.</p><p class="collection-allowance" id="collection-allowance" role="status">'+esc(allowanceText(allowance))+'</p><button class="button primary" type="submit" data-ready="'+enabled+'" '+(!enabled||!allowance?.canRequest?'disabled':'')+'>수집 시작</button><p class="muted">저장 자료 조회·정보 수정 요청은 횟수 제한 없이 이용할 수 있습니다. 접수 후 실패·차단된 요청은 관리자 확인이 필요합니다.</p>'+(!enabled?'<p class="muted">수집기 연결을 준비 중입니다.</p>':'')+'</form></section><section id="collection-progress" class="collection-progress" aria-live="polite"></section><section id="collection-result" aria-label="업체DB 수집 결과"><p role="status">저장된 결과를 불러옵니다.</p></section>';
  }
  function progress(data) {
    const r=data?.request;
    if(data?.collectionAllowance)allowance=data.collectionAllowance;
    const note=document.querySelector('#collection-allowance');if(note)note.textContent=allowanceText(allowance);
    const target=document.querySelector('#collection-progress'); if(!target)return;
    target.innerHTML=r?'<div class="collection-status '+(active(r)?'running':'')+'"><span class="activity-dot" aria-hidden="true"></span><strong>'+esc(statuses[r.status]||'상태 확인')+'</strong><span>'+esc(r.message)+'</span><button type="button" class="button small" data-action="refresh-collection">새로고침</button></div><p class="muted">접수 '+esc(new Date(r.submittedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))+(r.errorCode?' · 원인 코드 '+esc(r.errorCode):'')+'</p>':'';
    const submit=document.querySelector('[data-collect] button[type=submit]'); if(submit)submit.disabled=active(r)||submit.dataset.ready!=='true'||!allowance?.canRequest;
  }
  function renderResult(data) {
    return window.InsightCompanyView.render(data,(data.result?.products||[]).map((p,i)=>productCard(p,i,data.result)).join(''),display);
  }
  function productCard(p,index,r) {
    const observed=p.days.filter(d=>d.status==='observed'),valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0; const quantities=observed.map(d=>d.total).filter(valid),prices=observed.map(d=>d.price).filter(valid);
    return `<details class="collection-product"><summary><span>${esc(p.name)}</span><span class="status-pill">${esc(types[p.productType])}</span><small>${p.days.length}일 관측</small></summary><p class="muted">최대 공개 재고 ${quantities.length?count(Math.max(...quantities)):'확인 전'} · ${prices.length?money(Math.min(...prices)):'가격 확인 전'}${prices.length&&Math.max(...prices)!==Math.min(...prices)?` ~ ${money(Math.max(...prices))}`:''}</p><details class="product-days"><summary>날짜별 수량·판매금액 보기</summary><div class="collection-table-wrap"><table><thead><tr><th>숙박일</th><th>응답</th><th>공개 재고</th><th>예약 가능</th><th>공개 예약</th><th>${p.productType==='lodging'?'숙박 객실 판매금액':'상품 판매금액'}</th></tr></thead><tbody>${p.days.map(d=>`<tr><th>${esc(d.date||'날짜 확인 전')}</th><td>${esc({observed:'정상 응답',error:'오류·차단',missing:'자료 누락',not_requested:'유무만 확인'}[d.status])}${d.errorCode?`<small>${esc(d.errorCode)}</small>`:''}${d.saleStatus==='closure_unconfirmed'?'<small>판매중지 미확정</small>':''}</td><td>${count(d.total)}${p.original.find(o=>o.date===d.date)?.total!=null&&p.original.find(o=>o.date===d.date).total!==d.total?`<small>수집값 ${count(p.original.find(o=>o.date===d.date).total)} · DB 검수 적용</small>`:''}</td><td>${count(d.available)}</td><td class="public-value">${count(d.publicBookings)}</td><td>${money(d.price)}</td></tr>`).join('')}</tbody></table></div></details><details class="product-edit"><summary>이 상품 정보 수정 요청</summary><form data-product-correction="${index}"><p class="muted">요청은 검수 후 반영합니다. 전체 객실 수는 아래 ‘업체 정보 수정’에서 수정하세요.</p><div class="form-grid"><label class="field"><span>적용할 숙박일</span><select name="date" required>${p.days.filter(d=>d.date).map(d=>`<option value="${esc(d.date)}">${esc(d.date)} · ${count(d.total)} (${esc(d.status==='observed'?'정상':'수량 보정 불가')})</option>`).join('')}</select></label><label class="field"><span>객실 수 보정 제안</span><input type="number" name="total" min="1" max="10000" step="1" placeholder="변경할 때만 입력"></label><label class="field"><span>상품 구분</span><select name="productType">${Object.entries(types).map(([v,n])=>`<option value="${v}" ${v===p.productType?'selected':''}>${n}</option>`).join('')}</select></label></div><label class="field"><span>변경 근거</span><textarea name="reason" required maxlength="1000" placeholder="객실 구성, 공식 안내, 확인 날짜 등을 적어 주세요."></textarea></label><button class="button" type="submit">상품 검수 요청 보내기</button></form></details></details>`;
  }
  async function load(force=false) {
    const mine=serial, id=companyId, order=++loadOrder;
    clearTimeout(timer);
    try {
      const data=await api(`/companies/${encodeURIComponent(id)}/collection`);
      if(mine!==serial || order!==loadOrder || !document.querySelector('#collection-result'))return;
      progress(data);
      const version=JSON.stringify([data.result?.version,data.previousResult,data.companyDetail]);
      if(force || renderedVersion!==version) {
        if(!force && document.querySelector('#collection-result form:focus-within, #collection-result form[data-dirty]')) { const note=document.createElement('p'); note.className='muted';note.textContent='새 결과가 있습니다. 작성 중인 내용을 유지했습니다. 새로고침하면 최신 결과를 표시합니다.';document.querySelector('#collection-progress').append(note); if(active(data.request))timer=setTimeout(()=>load(),10000); return; }
        view=data;renderedVersion=version;document.querySelector('#collection-result').innerHTML=renderResult(data);
      }
      if(active(data.request))timer=setTimeout(()=>{if(!document.hidden)load();else timer=setTimeout(()=>load(),10000);},5000);
    } catch(error) { if(mine===serial && document.querySelector('#collection-progress'))document.querySelector('#collection-progress').innerHTML=`<p class="collection-warning">${esc(error.message)} <button class="button small" data-action="refresh-collection">다시 확인</button></p>`; }
  }
  window.InsightCollection={panel, mount(id,request,options={}){display={mode:savedMode(),metric:'bookings',month:'',calendarMonth:'',day:undefined,own:options.kind==='own'};serial++;clearTimeout(timer);companyId=id;api=request;view=null;renderedVersion=null;load();},stop(){serial++;clearTimeout(timer);},refresh:()=>load(true),
    correction(index,p){const r=view?.result, product=r?.products[Number(index)];if(!product)throw Error('수집 결과를 다시 열어 주세요.');const proposed={};if(p.total!=='')proposed.total=Number(p.total);if(p.productType!==product.productType)proposed.productType=p.productType;return {companyId,baseVersion:r.version,target:{runId:r.runId,productKey:product.key,date:p.date},proposed,reason:p.reason};}};
})();
