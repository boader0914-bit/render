(() => {
  'use strict';
  const root = document.getElementById('insightCustomerManagement'); if (!root) return;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let selected = null, busy = false, loaded = false;
  const active = row => ['active','pending'].includes(row.status);
  const labels = {pending:'확인 대기',active:'등록 완료',archived:'보관',rejected:'반려',verified:'반영 확인',withdrawn:'철회',superseded:'새 요청으로 대체',needs_review:'자료 준비 접수'};
  async function request(suffix='', payload) {
    const response = await fetch(`/api/admin/insight-customers${suffix}`,{method:payload?'POST':'GET',headers:payload?{'Content-Type':'application/json'}:{Accept:'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message || data.error || '인사이트 이용자 연결을 확인해 주세요.');return data;
  }
  function header() { return '<div class="admin-console-head"><div><strong>인사이트 이용자 · 등록 업체</strong><small>고객별 제공 범위와 공통 업체 DB의 검수 요청을 관리합니다.</small></div><button type="button" data-insight-action="reload">목록 새로고침</button></div>'; }
  async function list() {
    selected=null;root.innerHTML=`${header()}<p role="status">이용자 목록을 불러옵니다.</p>`;
    try {const data=await request();root.innerHTML=`${header()}<div class="insight-admin-list">${data.customers.map(c=>`<button type="button" data-insight-customer="${esc(c.customerId)}"><strong>${esc(c.username)}</strong><span>${c.businessStatus==='planning'?'매장 준비 중':'매장 등록'} · ${c.relations.length}곳 · ${c.accountStatus==='active'?'이용 중':'중지'}</span></button>`).join('')||'<p class="empty">인사이트에 로그인한 이용자가 없습니다.</p>'}</div>`;}catch(error){root.innerHTML=`${header()}<p class="empty">${esc(error.message)}</p>`;}
  }
  function detail(data) {
    selected=data;const c=data.customer;
    const keep=(rows,name)=>rows.filter(active).map(row=>`<label class="insight-admin-check"><input type="checkbox" name="${name}" value="${esc(row.relationId)}" checked><span>${esc(data.companies.find(co=>co.companyId===row.companyId)?.name || data.regions.find(re=>re.id===row.regionKey)?.label || row.companyId || row.regionKey)}</span></label>`).join('');
    root.innerHTML=`${header()}<p><button type="button" data-insight-action="reload">← 이용자 목록</button></p><h3>${esc(c.username)} · 등록 업체</h3><div class="insight-admin-list">${c.relations.filter(active).map(row=>{const co=data.companies.find(item=>item.companyId===row.companyId);return `<article class="insight-admin-company"><strong>${esc(co?.name||row.companyId)}</strong><p>${row.kind==='own'?'내 매장':'경쟁업체'} · ${esc(labels[row.status])} · 객실 총량 ${co?.rooms===null?'확인 전':co?.rooms==null?'확인 전':esc(co.rooms)+'실'}</p><a class="company-edit-shortcut" href="/admin?adminCompany=${encodeURIComponent(row.companyId)}#admin-db-company=${encodeURIComponent(row.companyId)}" data-company-edit-shortcut="${esc(row.companyId)}" data-company-edit-fold="correction">업체 DB 정보 수정</a>${row.kind==='own'&&row.status==='pending'?`<form data-insight-review="${esc(row.relationId)}"><label>확인 근거<input name="reason" required maxlength="500"></label><button type="submit" name="decision" value="approve">내 매장 연결 승인</button><button type="submit" name="decision" value="reject">반려</button></form>`:''}</article>`;}).join('')||'<p class="empty">등록된 업체가 없습니다.</p>'}</div><details><summary>제공 수량 변경 · 유지 대상 선택</summary><form id="insightEntitlements"><div class="insight-admin-grid"><label>경쟁업체 허용 수<input type="number" name="competitorLimit" min="0" max="1000" value="${c.entitlements.competitorLimit}" required></label><label>관심지역 허용 수<input type="number" name="interestRegionLimit" min="0" max="1000" value="${c.entitlements.interestRegionLimit}" required></label></div><p>수량을 줄일 때 유지할 대상을 선택하세요.</p>${keep(c.relations.filter(row=>row.kind==='competitor'),'keepCompetitorRelationIds')}${keep(c.regions,'keepInterestRegionRelationIds')}<label>변경 사유<input name="reason" required maxlength="500"></label><button type="submit">제공 범위 저장</button></form></details><details open><summary>업체 정보 검수 요청</summary>${data.corrections.map(row=>`<article class="insight-admin-company"><strong>${esc(data.companies.find(co=>co.companyId===row.companyId)?.name||row.companyId)} · ${esc(labels[row.status])}</strong><dl>${Object.entries(row.proposed).map(([key,value])=>`<dt>${esc({name:'매장명',address:'주소',rooms:'객실 수',dayUse:'데이유즈',facilities:'시설'}[key]||key)}</dt><dd>${esc(row.baseValues[key]??'미확인')} → ${esc(value)}</dd>`).join('')}</dl><p>${esc(row.reason)}</p>${row.status==='pending'?`<a class="company-edit-shortcut" href="/admin?adminCompany=${encodeURIComponent(row.companyId)}#admin-db-company=${encodeURIComponent(row.companyId)}" data-company-edit-shortcut="${esc(row.companyId)}" data-company-edit-fold="correction">공통 업체 DB에서 검수·수정</a><form data-insight-correction="${esc(row.requestId)}"><label>고객에게 안내할 처리 사유<input name="reason" required maxlength="1000"></label><button type="submit" name="decision" value="verified">DB 반영값 확인</button><button type="submit" name="decision" value="rejected">반려</button></form>`:''}</article>`).join('')||'<p class="empty">검수 요청이 없습니다.</p>'}</details><details><summary>자료 준비 요청</summary>${data.preparations.map(row=>`<p>${esc(data.companies.find(co=>co.companyId===row.companyId)?.name||row.companyId)} · ${esc(labels[row.status]||row.status)} · ${esc(row.observationDay)}</p>`).join('')||'<p class="empty">접수한 요청이 없습니다.</p>'}</details><p class="insight-admin-status" role="status"></p>`;
  }
  function appendPreparationControls() {
    const section = root.querySelectorAll('details'); const target = section[section.length-1];
    if (!target || !selected) return;
    for (const row of selected.preparations.filter(row=>row.status==='needs_review'&&!row.jobId)) {
      const form=document.createElement('form'); form.dataset.insightPreparation=row.requestId;
      const name=selected.companies.find(company=>company.companyId===row.companyId)?.name||row.companyId;
      form.innerHTML=`<strong>${esc(name)} 자료 준비</strong><div class="insight-admin-grid"><label>숙박 시작일<input type="date" name="checkIn" required></label><label>조회 기간(일)<input type="number" name="bookingRangeDays" min="1" max="31" required></label></div><p>업체명 검색 · 상세 1위 · 데이유즈 유무 확인 · AWS worker. 같은 업체·당일·같은 조건은 작업을 공유합니다.</p><button type="submit">지정한 범위로 자료 준비 시작</button>`;
      target.append(form);
    }
  }
  root.addEventListener('click',async event=>{const button=event.target.closest('[data-insight-customer],[data-insight-action]');if(!button||busy)return;busy=true;try{if(button.dataset.insightCustomer){detail(await request(`/${encodeURIComponent(button.dataset.insightCustomer)}`));appendPreparationControls();}else await list();}catch(error){root.querySelector('.insight-admin-status')?.replaceChildren(document.createTextNode(error.message));}finally{busy=false;}});
  root.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!selected)return;busy=true;
    const form=event.target, values=new FormData(form), c=selected.customer;
    form.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{let suffix=`/${encodeURIComponent(c.customerId)}/commands`, action, payload;
      if(form.id==='insightEntitlements'){action='entitlements';payload={competitorLimit:Number(values.get('competitorLimit')),interestRegionLimit:Number(values.get('interestRegionLimit')),keepCompetitorRelationIds:values.getAll('keepCompetitorRelationIds'),keepInterestRegionRelationIds:values.getAll('keepInterestRegionRelationIds'),reason:values.get('reason')};}
      else if(form.dataset.insightReview){action='property-review';payload={relationId:form.dataset.insightReview,decision:event.submitter?.value,reason:values.get('reason')};}
      else if(form.dataset.insightCorrection){suffix=`/${encodeURIComponent(c.customerId)}/correction-review`;payload={requestId:form.dataset.insightCorrection,decision:event.submitter?.value,reason:values.get('reason')};}
      else if(form.dataset.insightPreparation){suffix=`/${encodeURIComponent(c.customerId)}/preparation-dispatch`;payload={requestId:form.dataset.insightPreparation,checkIn:values.get('checkIn'),bookingRangeDays:Number(values.get('bookingRangeDays'))};}
      else return;
      detail(await request(suffix,action?{revision:c.revision,requestKey:crypto.randomUUID(),action,payload}:payload));
      appendPreparationControls();
      root.querySelector('.insight-admin-status').textContent='저장했습니다.';
    }catch(error){root.querySelector('.insight-admin-status').textContent=error.message;}finally{busy=false;form.querySelectorAll('button').forEach(button=>button.disabled=false);}
  });
  const observer=new IntersectionObserver(entries=>{if(!loaded&&entries.some(entry=>entry.isIntersecting)){loaded=true;list();}});observer.observe(root);
})();
