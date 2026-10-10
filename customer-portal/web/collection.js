(() => {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const count = v => v == null ? '확인 전' : `${Number(v).toLocaleString('ko-KR')}실`;
  const money = v => v == null ? '가격 없음' : `${Number(v).toLocaleString('ko-KR')}원`;
  const types = {lodging:'숙박',dayuse:'데이유즈',unknown:'구분 확인 전'};
  const statuses = {dispatching:'접수 확인',queued:'수집 대기',collecting:'수집 대기·진행 중',ready:'완료',partial:'일부 완료',blocked:'접근 제한',failed:'실패',needs_review:'확인 필요'};
  const active = r => ['dispatching','queued','collecting'].includes(r?.status);
  let api, companyId, view = null, serial = 0, timer, renderedVersion, loadOrder=0, selectedMonth='';
  const date = () => new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  let allowance=null,display={mode:'default',metric:'bookings',month:''};
  function savedMode(){try{const mode=localStorage.getItem('insight-company-view');return ['default','graph','calendar','table'].includes(mode)?mode:'default';}catch{return 'default';}}
  function refreshDisplay(){if(!view)return;const current=document.querySelector('#company-current-view'),history=document.querySelector('#company-history-flow');if(current)current.innerHTML=window.InsightCompanyView.currentView(view,display);if(history)history.innerHTML=window.InsightCompanyView.flowView(view,display);document.querySelectorAll?.('[data-company-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.companyView===display.mode)));const details=document.querySelector('#company-flow-details');if(details&&display.mode==='graph')details.open=true;}
  document.addEventListener?.('click',event=>{const choice=event.target.closest?.('[data-company-view]');if(choice){display.mode=choice.dataset.companyView;try{localStorage.setItem('insight-company-view',display.mode);}catch{}refreshDisplay();return;}const button=event.target.closest?.('[data-open-collection]');if(button){const panel=document.querySelector('#collection-settings');if(panel){panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden));}}});
  document.addEventListener?.('change',event=>{
    if(event.target.matches?.('[data-company-month]')){
      if(document.querySelector('#collection-result form[data-dirty]')){
        event.target.value=view?.companyDetail?.integrated?.selectedMonth||selectedMonth;
        const progress=document.querySelector('#collection-progress');
        if(progress)progress.innerHTML='<p class="collection-warning">작성 중인 수정 요청을 유지했습니다. 내용을 정리한 뒤 숙박월을 바꿔 주세요.</p>';
        return;
      }
      selectedMonth=event.target.value;display.month=selectedMonth;load(true);
    }else if(event.target.matches?.('[data-flow-metric]')){display.metric=event.target.value;refreshDisplay();}
    else if(event.target.matches?.('[data-flow-month]')){display.month=event.target.value;refreshDisplay();}
  });
  function allowanceText(q) {
    if(!q)return '오늘 수집 가능 여부를 확인하고 있습니다.';
    if(q.limit===null)return '관리자는 일일 횟수 제한을 적용하지 않습니다. 동일 업체·조건은 기존 작업을 확인합니다.';
    return q.canRequest ? '일반 고객 · 계정 전체 하루 1회 · 오늘 요청 가능 · 한국시간 기준' : '오늘 수집 요청 1/1회 사용 · '+new Date(q.resetsAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})+'부터 다시 요청 가능';
  }
  function panel(company, enabled, request, quota, openCollection=false) {
    allowance=quota||null;
    const intent=request?.intent || {}, start=intent.checkIn>=date()?intent.checkIn:date(), mode=intent.dayUseMode || 'inspect';
    return '<section class="card company-data-heading"><span class="eyebrow">COMPANY DATABASE</span><h1>'+esc(company.name)+' 업체 자료</h1><p class="muted">데이터랩 업체DB의 기본정보·예약 채널·최근 관측·누적 이력을 확인합니다.</p><div class="connected-actions"><button type="button" class="button primary" data-open-collection aria-controls="collection-settings" aria-expanded="'+openCollection+'">30일 예약·추정매출 수집</button><button type="button" class="button" data-action="refresh-collection">저장 자료 다시 보기</button></div><p class="muted">업체 자료는 DB에서 불러옵니다. 수집은 별도로 실행할 때만 시작됩니다.</p></section><section id="collection-settings" class="card collection-setup" '+(openCollection?'':'hidden')+'><h2>새로운 예약·추정매출 수집</h2><form data-collect="'+esc(company.companyId)+'"><div class="form-grid collection-fields"><label class="field"><span>숙박 시작일</span><input name="checkIn" type="date" min="'+date()+'" value="'+esc(start)+'" required></label><label class="field"><span>수집 기간</span><input value="시작일 포함 30일" readonly><input type="hidden" name="bookingRangeDays" value="30"></label><label class="field"><span>데이유즈</span><select name="dayUseMode">'+Object.entries({inspect:'유무 확인',lodging_only:'숙박만',detail:'상세 수집'}).map(([v,n])=>'<option value="'+v+'" '+(mode===v?'selected':'')+'>'+n+'</option>').join('')+'</select></label></div><p class="muted">30일의 날짜별 예약 수량과 숙박 객실 판매금액을 확인합니다. 데이유즈의 날짜별 수량은 상세 수집을 선택하세요.</p><p class="collection-allowance" id="collection-allowance" role="status">'+esc(allowanceText(allowance))+'</p><button class="button primary" type="submit" data-ready="'+enabled+'" '+(!enabled||!allowance?.canRequest?'disabled':'')+'>수집 시작</button><p class="muted">저장 자료 조회·정보 수정 요청은 횟수 제한 없이 이용할 수 있습니다. 접수 후 실패·차단된 요청은 관리자 확인이 필요합니다.</p>'+(!enabled?'<p class="muted">수집기 연결을 준비 중입니다.</p>':'')+'</form></section><section id="collection-progress" class="collection-progress" aria-live="polite"></section><section id="collection-result" aria-label="업체DB 수집 결과"><p role="status">저장된 결과를 불러옵니다.</p></section>';
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
    const quantities=p.days.map(d=>d.total).filter(v=>v!==null),prices=p.days.map(d=>d.price).filter(v=>v!==null);
    return `<details class="collection-product"><summary><span>${esc(p.name)}</span><span class="status-pill">${esc(types[p.productType])}</span><small>${p.days.length}일 관측</small></summary><p class="muted">최대 공개 재고 ${quantities.length?count(Math.max(...quantities)):'확인 전'} · ${prices.length?money(Math.min(...prices)):'가격 확인 전'}${prices.length&&Math.max(...prices)!==Math.min(...prices)?` ~ ${money(Math.max(...prices))}`:''}</p><details class="product-days"><summary>날짜별 수량·판매금액 보기</summary><div class="collection-table-wrap"><table><thead><tr><th>숙박일</th><th>응답</th><th>공개 재고</th><th>예약 가능</th><th>공개 예약</th><th>${p.productType==='lodging'?'숙박 객실 판매금액':'상품 판매금액'}</th></tr></thead><tbody>${p.days.map(d=>`<tr><th>${esc(d.date||'날짜 확인 전')}</th><td>${esc({observed:'정상 응답',error:'오류·차단',missing:'자료 누락',not_requested:'유무만 확인'}[d.status])}${d.errorCode?`<small>${esc(d.errorCode)}</small>`:''}${d.saleStatus==='closure_unconfirmed'?'<small>판매중지 미확정</small>':''}</td><td>${count(d.total)}${p.original.find(o=>o.date===d.date)?.total!=null&&p.original.find(o=>o.date===d.date).total!==d.total?`<small>수집값 ${count(p.original.find(o=>o.date===d.date).total)} · DB 검수 적용</small>`:''}</td><td>${count(d.available)}</td><td class="public-value">${count(d.publicBookings)}</td><td>${money(d.price)}</td></tr>`).join('')}</tbody></table></div></details><details class="product-edit"><summary>이 상품 정보 수정 요청</summary><form data-product-correction="${index}"><p class="muted">요청은 검수 후 반영합니다. 전체 객실 수는 아래 ‘업체 정보 수정’에서 수정하세요.</p><div class="form-grid"><label class="field"><span>적용할 숙박일</span><select name="date" required>${p.days.filter(d=>d.date).map(d=>`<option value="${esc(d.date)}">${esc(d.date)} · ${count(d.total)} (${esc(d.status==='observed'?'정상':'수량 보정 불가')})</option>`).join('')}</select></label><label class="field"><span>객실 수 보정 제안</span><input type="number" name="total" min="1" max="10000" step="1" placeholder="변경할 때만 입력"></label><label class="field"><span>상품 구분</span><select name="productType">${Object.entries(types).map(([v,n])=>`<option value="${v}" ${v===p.productType?'selected':''}>${n}</option>`).join('')}</select></label></div><label class="field"><span>변경 근거</span><textarea name="reason" required maxlength="1000" placeholder="객실 구성, 공식 안내, 확인 날짜 등을 적어 주세요."></textarea></label><button class="button" type="submit">상품 검수 요청 보내기</button></form></details></details>`;
  }
  async function load(force=false) {
    const mine=serial, id=companyId, order=++loadOrder;
    clearTimeout(timer);
    try {
      const data=await api(`/companies/${encodeURIComponent(id)}/collection${selectedMonth?'?month='+encodeURIComponent(selectedMonth):''}`);
      if(mine!==serial || order!==loadOrder || !document.querySelector('#collection-result'))return;
      progress(data);
      const version=JSON.stringify([data.result?.version,data.previousResult,data.companyDetail]);
      if(force || renderedVersion!==version) {
        if(!force && document.querySelector('#collection-result form:focus-within, #collection-result form[data-dirty]')) { const note=document.createElement('p'); note.className='muted';note.textContent='새 결과가 있습니다. 작성 중인 내용을 유지했습니다. 새로고침하면 최신 결과를 표시합니다.';document.querySelector('#collection-progress').append(note); if(active(data.request))timer=setTimeout(()=>load(),10000); return; }
        view=data;renderedVersion=version;document.querySelector('#collection-result').innerHTML=renderResult(data);
      }
      if(active(data.request)||['pending','updating'].includes(data.companyDetail?.integrated?.status)&&!data.companyDetail?.legacyObservationView)timer=setTimeout(()=>{if(!document.hidden)load();else timer=setTimeout(()=>load(),10000);},10000);
    } catch(error) { if(mine===serial && document.querySelector('#collection-progress'))document.querySelector('#collection-progress').innerHTML=`<p class="collection-warning">${esc(error.message)} <button class="button small" data-action="refresh-collection">다시 확인</button></p>`; }
  }
  window.InsightCollection={panel, mount(id,request){display={mode:savedMode(),metric:'bookings',month:''};selectedMonth='';serial++;clearTimeout(timer);companyId=id;api=request;view=null;renderedVersion=null;load();},stop(){serial++;clearTimeout(timer);},refresh:()=>load(true),
    correction(index,p){const r=view?.result, product=r?.products[Number(index)];if(!product)throw Error('수집 결과를 다시 열어 주세요.');const proposed={};if(p.total!=='')proposed.total=Number(p.total);if(p.productType!==product.productType)proposed.productType=p.productType;return {companyId,baseVersion:r.version,target:{runId:r.runId,productKey:product.key,date:p.date},proposed,reason:p.reason};}};
})();
