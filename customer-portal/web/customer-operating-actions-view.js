(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./customer-operating-actions.js'):root.InsightCustomerOperatingActions);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightCustomerOperatingActionsView=api;
})(typeof window==='undefined'?globalThis:window,function(engine){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const n=v=>finite(v)?v.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const rate=v=>finite(v)?`${(v*100).toFixed(1)}%`:'미확인';
  const won=v=>finite(v)?`${Math.round(v).toLocaleString('ko-KR')}원`:'미확인';
  const rooms=v=>finite(v)?`${n(v)}실`:'미확인';
  const sign=v=>finite(v)?`${v>0?'+':''}${n(v)}`:'미확인';
  const arr=v=>Array.isArray(v)?v:[];
  const short=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')?`${Number(d.slice(5,7))}/${Number(d.slice(8))}`:'일자 미확인';
  const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const sourceNotice=report=>report.responseCache?.preview?'계산 전 미리보기 · 제안 근거 확인 필요':report.responseCache?.refreshFailed&&!report.responseCache?.refreshing?'최신 확인 지연 · 저장된 정상 근거 기준':report.responseCache?.refreshing?'저장 자료 표시 · 최신 근거 확인 중':'저장된 관측 근거 기준';
  const message=v=>typeof v==='string'?v:v?.reason||v?.message||v?.label||'';
  const list=(values,ordered=false)=>{const rows=arr(values).map(message).filter(Boolean);return rows.length?`<${ordered?'ol':'ul'}>${rows.map(v=>`<li>${esc(v)}</li>`).join('')}</${ordered?'ol':'ul'}>`:'';};
  const defaults=()=>({productId:'manual',productName:'',productNameBasis:'',price:'',discount:'0',variableCost:'',commission:'',baseline:'',capacity:''});
  const blankNumber=v=>typeof v==='number'&&finite(v)?v:typeof v==='string'&&v.trim()&&finite(Number(v))?Number(v):null;
  const contextKey=(selection,scope='')=>JSON.stringify([scope,selection?.ownCompanyId,arr(selection?.comparisonIds).slice().sort(),selection?.stayMode,selection?.stayStart,selection?.stayEnd,selection?.asOfDate]);
  let currentState=null,mounted=null;
  function freshState(key){return {key,gapPp:10,leadDays:14,filter:'all',selectedDate:null,basisKey:null,scenario:defaults(),scenarioOpen:false,evidenceOpen:false,rulesOpen:false};}
  function stateFor(selection,scope){const key=contextKey(selection,scope);if(!currentState||currentState.key!==key)currentState=freshState(key);return currentState;}
  const priority={limited_coupon_review:0,sales_conditions_review:1,maintain_price:2,hold:3};
  function visibleDays(days,filter){return arr(days).filter(d=>filter==='all'||d.action===filter).slice().sort((a,b)=>(priority[a.action]??4)-(priority[b.action]??4)||(a.leadDays??Infinity)-(b.leadDays??Infinity)||String(a.date).localeCompare(String(b.date)));}
  function productsFor(day){return arr(day?.owner?.products||day?.products).filter(p=>p&&finite(p.price)&&p.price>0&&typeof p.id==='string');}
  function selectedDay(plan,state){const rows=visibleDays(plan.days,state.filter);return rows.find(d=>d.date===state.selectedDate)||rows[0]||null;}
  function syncBasis(day,state){
    const basis=JSON.stringify([day?.date,productsFor(day).map(p=>[p.id,p.price])]);
    if(state.basisKey!==basis){state.basisKey=basis;state.selectedDate=day?.date||null;state.scenario=defaults();state.scenarioOpen=false;state.evidenceOpen=false;}
  }
  function scenarioModel(day,state){
    const product=productsFor(day).find(p=>p.id===state.scenario.productId);
    const input={price:product?product.price:blankNumber(state.scenario.price),discountPercent:blankNumber(state.scenario.discount),variableCost:blankNumber(state.scenario.variableCost),commissionPercent:blankNumber(state.scenario.commission),baselineRooms:blankNumber(state.scenario.baseline),capacity:blankNumber(state.scenario.capacity)};
    return {product,input,result:engine.computeCouponScenario(input)};
  }
  function scenarioResult(day,state){
    const {result}=scenarioModel(day,state);
    const notice=result.capacityFeasible===false?'필요한 판매수량이 입력한 상품 판매한도를 넘습니다. 할인 조건을 다시 검토하세요.':result.capacityFeasible===true?'입력한 한도 안의 산술 결과입니다. 실제 판매와 쿠폰 효과를 보장하지 않습니다.':'비용·수수료·기준 수량·상품 판매한도를 입력하기 전에는 손익을 판단하지 않습니다.';
    return `<div class="customer-coupon-results" aria-live="polite"><div><span>할인 후 판매가격</span><strong>${won(result.discountedPrice)}</strong></div><div><span>1실당 쿠폰 부담</span><strong>${won(result.discountPerRoom)}</strong></div><div><span>1실당 원가·수수료 제외 금액</span><strong>${won(result.baselineContributionPerRoom)} → ${won(result.couponContributionPerRoom)}</strong></div><div><span>같은 금액을 남기는 데 필요한 판매수량</span><strong>${rooms(result.breakEvenRooms)}</strong><small>${finite(result.extraRooms)?`기준보다 ${sign(result.extraRooms)}실`:'입력 조건 확인 후 계산'}</small></div></div><p class="customer-operating-notice ${result.capacityFeasible===false?'is-warning':''}" role="status">${notice}</p>${list(result.reasons)}`;
  }
  function scenario(day,state){
    const value=state.scenario,products=productsFor(day),product=products.find(p=>p.id===value.productId),input=(key,label,options={})=>`<label class="field"><span>${label}</span><input data-customer-coupon-field="${key}" aria-label="${label}" type="number" min="0" ${options.max!==undefined?`max="${options.max}"`:''} step="${options.step||1}" value="${esc(value[key])}" placeholder="${esc(options.placeholder||'직접 입력')}" /></label>`;
    return `<details class="customer-coupon-scenario" data-customer-operating-detail="scenario" ${state.scenarioOpen?'open':''}><summary>쿠폰 금액·판매수량 가정해 보기 <b aria-hidden="true">+</b></summary><div class="customer-coupon-body"><h3>${esc(short(day.date))} · 쿠폰 계산</h3><p class="muted">${product?'선택한 숙박상품의 저장 표시가격을 사용합니다.':'이 비교 자료에는 상품별 판매가격이 연결되지 않았습니다. 가격은 직접 입력한 가정으로만 사용하며 매출을 예약수량으로 나눠 대신하지 않습니다.'}</p><form data-customer-coupon-form><div class="customer-coupon-form">${products.length?`<label class="field customer-coupon-wide"><span>가격 기준</span><select data-customer-operating-product aria-label="쿠폰 계산 가격 기준"><option value="manual" ${value.productId==='manual'?'selected':''}>직접 입력 가정</option>${products.map(p=>`<option value="${esc(p.id)}" ${value.productId===p.id?'selected':''}>${esc(p.name||'숙박상품')} · ${won(p.price)}</option>`).join('')}</select></label>`:''}<label class="field customer-coupon-wide"><span>검토할 상품·객실 이름 (가정)</span><input type="text" maxlength="120" data-customer-coupon-field="productName" aria-label="검토할 상품·객실 이름 가정" value="${esc(value.productName)}" placeholder="선택 사항" /></label>${product?`<div class="field"><span>저장된 상품 표시가격</span><strong>${won(product.price)}</strong></div>`:input('price','상품 판매가격 가정 (원)',{step:1000})}${input('discount','할인율 가정 (%)',{max:100,step:0.1})}${input('variableCost','1실 판매 시 변동비 (원)',{step:1000})}${input('commission','할인 후 매출 수수료 (%)',{max:100,step:0.1})}${input('baseline','쿠폰 없이 앞으로 팔릴 수량 가정 (실)')}${input('capacity','해당 상품의 남은 판매한도 (실)')}<button class="button small" type="button" data-customer-operating-reset>가정 초기화</button></div></form><p class="customer-coupon-assumptions">할인율 기본 0% · 원가·수수료·수량은 직접 입력합니다. 이미 예약된 객실에는 소급하지 않습니다. 쿠폰은 업체 전액 부담, 수수료는 할인 후 가격에 적용하며 고정비·세금은 제외합니다. 입력한 가정은 저장·발급되지 않습니다.</p><div data-customer-coupon-output>${scenarioResult(day,state)}</div></div></details>`;
  }
  function ruleControls(plan,state){return `<details class="customer-operating-rules" data-customer-operating-detail="rules" ${state.rulesOpen?'open':''}><summary>날짜 선별 기준 <b aria-hidden="true">+</b></summary><div><label class="field"><span>표본보다 낮은 예약률 차이</span><select aria-label="쿠폰 검토 예약률 차이 가정" data-customer-operating-rule="gapPp">${[5,10,15].map(v=>`<option value="${v}" ${state.gapPp===v?'selected':''}>${v}%p 이상</option>`).join('')}</select></label><label class="field"><span>검토 기준일부터 숙박일까지</span><select aria-label="쿠폰 검토 남은 기간 가정" data-customer-operating-rule="leadDays">${[7,14,21].map(v=>`<option value="${v}" ${state.leadDays===v?'selected':''}>${v}일 이내</option>`).join('')}</select></label><p>검토 순서를 정하는 가정이며 검증된 할인 기준이 아닙니다. 같은 지역·업종의 공통 자료를 가진 업체 ${n(plan.rules?.minimumPeerCompanies)}곳 이상, 확보율 ${finite(plan.rules?.minimumPeerCoverage)?n(plan.rules.minimumPeerCoverage*100)+'%':'미확인'} 기준입니다. 남은 날짜는 실제 예약 리드타임과 다릅니다.</p></div></details>`;}
  function displayPlan(plan,state){
    if(!Array.isArray(state.displayDates)||!plan.contextValid)return plan;
    const allowed=new Set(state.displayDates),days=arr(plan.days).filter(day=>allowed.has(day.date)).map(day=>state.displayComparisonActionable===false?{...day,action:'hold',actionLabel:'판단 보류',status:'hold',policyActionable:false,
      reasons:[...arr(day.reasons),state.displayHoldReason||'선택한 기간·요일의 공통 관측 조건을 확인해야 합니다.'],
      steps:['선택한 기간·요일의 공통 관측과 비교 제외 사유를 확인합니다.','공통 비교 조건이 확인될 때까지 가격·쿠폰 적용 판단을 보류합니다.']} :day);
    const validDays=days.filter(day=>finite(day.owner?.rate)).length;
    return {...plan,days,summary:{...plan.summary,selectedDays:days.length,validDays,missingDays:days.length-validDays,
      couponReviewDays:days.filter(day=>day.action==='limited_coupon_review').length,conditionReviewDays:days.filter(day=>day.action==='sales_conditions_review').length,
      maintainPriceDays:days.filter(day=>day.action==='maintain_price').length,holdDays:days.filter(day=>day.action==='hold').length}};
  }
  function renderBody(report,selection,catalog,state){
    const plan=displayPlan(engine.computeOperatingPlan(report,selection,catalog,{gapPp:state.gapPp,couponLeadDays:state.leadDays}),state);
    if(!plan.contextValid)return '<div class="card"><h2>가격·쿠폰 운영 제안</h2><p class="collection-warning">선택한 고객·매장·기간에 맞는 저장 자료를 확인한 뒤 제안을 표시합니다.</p></div>';
    const rows=visibleDays(plan.days,state.filter),day=selectedDay(plan,state);syncBasis(day,state);
    const summary=plan.summary||{},same=arr(plan.groups?.same),cross=arr(plan.groups?.cross),unknown=arr(plan.groups?.unknown);
    const source=`${state.displayPeriod?.start||selection.stayStart} ~ ${state.displayPeriod?.end||selection.stayEnd} · 검토 기준 ${selection.asOfDate}${Array.isArray(state.displayDates)?' · 선택 요일 '+state.displayDates.length+'일':''}`;
    return `<header class="customer-operating-heading"><div><span class="customer-operating-eyebrow">등록한 내 매장 기준</span><h2>${esc(plan.company?.name||'내 매장')} 가격·쿠폰 운영 검토</h2><p>${esc(source)}</p><p>${esc(sourceNotice(report))} · 자료 시각 ${esc(stamp(report.responseCache?.checkedAt||report.generatedAt))}</p></div><span class="status-pill">읽기 전용 검토 · 자동 실행 없음</span></header><div class="customer-operating-groups"><p><strong>같은 지역 ${same.length}곳</strong>${same.length?' · '+same.map(c=>esc(c.name)).join(' · '):' · 할인 비교의 동일지역 근거가 없습니다.'}</p><p><strong>다른 지역 ${cross.length}곳</strong>${cross.length?' · '+cross.map(c=>esc(c.name)).join(' · '):''}${cross.length?' · 상품·운영 참고로만 봅니다.':''}</p>${unknown.length?`<p class="is-warning">지역 확인 필요 ${unknown.length}곳 · ${unknown.map(c=>esc(c.name)).join(' · ')}</p>`:''}</div><div class="customer-operating-counts"><span><b>${n(summary.couponReviewDays)}</b>일 쿠폰 조건 검토</span><span><b>${n(summary.conditionReviewDays)}</b>일 판매 조건 점검</span><span><b>${n(summary.maintainPriceDays)}</b>일 가격 유지 검토</span><span><b>${n(summary.holdDays)}</b>일 판단 보류</span><span class="muted">수량 확보 ${n(summary.validDays)} / ${n(summary.selectedDays)}일</span></div>${ruleControls(plan,state)}<label class="customer-operating-filter"><span>표시할 운영 검토 방향</span><select data-customer-operating-filter aria-label="표시할 운영 검토 방향">${[['all','전체 숙박일'],['limited_coupon_review','쿠폰 조건 검토'],['sales_conditions_review','판매 조건 점검'],['maintain_price','가격 유지 검토'],['hold','판단 보류']].map(([id,label])=>`<option value="${id}" ${state.filter===id?'selected':''}>${label}</option>`).join('')}</select></label><div class="customer-operating-table-wrap" tabindex="0" aria-label="숙박일별 운영 검토 목록"><table><thead><tr><th>숙박일</th><th>검토 기준</th><th>검토 방향</th><th>내 매장 예약률</th><th>같은 지역·업종 비교</th><th>차이</th></tr></thead><tbody>${rows.map(row=>`<tr class="${row.date===day?.date?'is-selected':''}"><th><button type="button" data-customer-operating-date="${esc(row.date)}" aria-pressed="${row.date===day?.date}" aria-label="${esc(row.date)} 운영 검토 근거 보기">${esc(short(row.date))} (${esc(row.weekday)})</button></th><td>${finite(row.leadDays)?row.leadDays<0?'지난 숙박일':`${n(row.leadDays)}일 남음`:'미확인'}</td><td><span class="customer-operating-direction is-${esc(row.action)}">${esc(row.actionLabel||'판단 보류')}</span>${row.status==='review'?'<small>근거 확인 후 검토</small>':''}</td><td>${rate(row.owner?.rate)}</td><td>${rate(row.peers?.rate)}<small>${n(row.peers?.validCompanies)}/${n(row.peers?.expectedCompanies)}곳</small></td><td>${finite(row.gapPp)?sign(row.gapPp)+'%p':'미확인'}</td></tr>`).join('')||'<tr><td colspan="6">선택한 방향에 해당하는 숙박일이 없습니다.</td></tr>'}</tbody></table></div>${day?`<div class="customer-operating-detail"><header><div><span>${esc(day.status==='review'?'근거 확인 후 검토':day.status==='hold'?'판단 보류':'조건부 검토')}</span><h3>${esc(day.date)} · ${esc(day.actionLabel||'판단 보류')}</h3></div><span>공개 ${rooms(day.owner?.publicBookings)} + 타채널 추정 ${rooms(day.owner?.inferredBookings)}</span></header><p class="customer-operating-evidence-number">내 매장 ${rate(day.owner?.rate)} · 같은 지역·업종 비교 ${rate(day.peers?.rate)} · 차이 ${finite(day.gapPp)?sign(day.gapPp)+'%p':'미확인'}</p>${list(day.reasons)}${arr(day.reviewReasons).length?'<h4>선택기간 전체의 추가 확인 사유</h4>'+list(day.reviewReasons):''}${arr(day.excludedPeerReferences).length?'<h4>쿠폰 비교에서 제외한 업체</h4>'+list(day.excludedPeerReferences.map(row=>`${row.name}: ${row.reason}`)):''}${day.owner?.collectedDate?`<p class="customer-operating-observed">수량 관측 ${esc(day.owner.collectedDate)} · 검토 기준 ${esc(selection.asOfDate)}</p>`:''}<h4>다음 행동</h4>${list(day.steps,true)}<details data-customer-operating-detail="evidence" ${state.evidenceOpen?'open':''}><summary>사용한 근거·실행 전 확인 조건 <b aria-hidden="true">+</b></summary>${list(day.evidence)}${list(day.preconditions)}<p class="muted">계산 기준 ${esc(plan.version)} · 업체 <a href="#company=${encodeURIComponent(plan.company.companyId)}">${esc(plan.company.name)} 자료 보기</a> · ${esc(source)}</p>${list(same.map(c=>`${c.name}: 공통 ${n(c.commonDays)}일 · ${c.actionable?'같은 조건 확인':'자동 판단 조건 미충족'}`))}${list(plan.limits)}</details></div>${scenario(day,state)}`:''}<p class="customer-operating-footnote">공개예약과 타채널 추정, 정상 0실과 미확인을 구분합니다. 다른 지역의 차이를 하나의 평균이나 할인 근거로 합치지 않습니다. 새로운 수집·가격 저장·쿠폰 발급은 하지 않습니다.</p>`;
  }
  function render(report,selection,catalog=[],options={}){
    if(!engine?.computeOperatingPlan)return '';
    const state=stateFor(selection,options.scope||'');
    state.displayDates=Array.isArray(options.displayDates)?options.displayDates.slice():null;
    state.displayPeriod=options.displayPeriod||null;
    state.displayComparisonActionable=options.displayComparisonActionable;
    state.displayHoldReason=options.displayHoldReason||null;
    let body;
    try{body=renderBody(report,selection,catalog,state);}catch{body='<h2>가격·쿠폰 운영 검토</h2><p class="collection-warning">가격·쿠폰 조건의 저장 근거를 확인하지 못했습니다. 위의 정상 비교 자료를 먼저 확인해 주세요.</p>';}
    return `<section id="customer-operating-actions" class="card customer-operating-actions" data-customer-operating-root>${body}</section>`;
  }
  function mount(options){mounted=options;}
  function stop(){mounted=null;currentState=null;}
  function isCurrent(){return !!mounted&&(!mounted.isCurrent||mounted.isCurrent());}
  function refreshView(){
    if(!isCurrent())return;
    const container=document.querySelector('#customer-operating-actions');if(!container)return;
    const state=stateFor(mounted.selection,mounted.scope||'');
    container.innerHTML=renderBody(mounted.report,mounted.selection,mounted.catalog||[],state);
  }
  if(typeof document!=='undefined'){
    document.addEventListener('submit',event=>{if(event.target.matches?.('[data-customer-coupon-form]')){event.preventDefault();event.stopImmediatePropagation?.();}});
    document.addEventListener('input',event=>{
      const field=event.target.dataset?.customerCouponField;if(!field||!event.target.closest?.('[data-customer-operating-root]')||!isCurrent()||!currentState)return;
      if(!Object.hasOwn(currentState.scenario,field))return;
      currentState.scenario[field]=String(event.target.value).slice(0,160);
      const plan=displayPlan(engine.computeOperatingPlan(mounted.report,mounted.selection,mounted.catalog||[],{gapPp:currentState.gapPp,couponLeadDays:currentState.leadDays}),currentState),day=selectedDay(plan,currentState);
      const output=document.querySelector('[data-customer-coupon-output]');if(day&&output)output.innerHTML=scenarioResult(day,currentState);
    });
    document.addEventListener('change',event=>{
      if(!event.target.closest?.('[data-customer-operating-root]')||!isCurrent()||!currentState)return;
      if(event.target.hasAttribute('data-customer-operating-filter'))currentState.filter=event.target.value;
      else if(event.target.hasAttribute('data-customer-operating-rule')){const key=event.target.dataset.customerOperatingRule;if(['gapPp','leadDays'].includes(key))currentState[key]=Number(event.target.value);}
      else if(event.target.hasAttribute('data-customer-operating-product')){currentState.scenario=defaults();currentState.scenario.productId=event.target.value;}
      else if(event.target.dataset.customerCouponField==='productName'&&currentState.scenario.productNameBasis!==event.target.value){const name=String(event.target.value).slice(0,120);currentState.scenario=defaults();currentState.scenario.productName=name;currentState.scenario.productNameBasis=name;}
      else return;
      refreshView();
    });
    document.addEventListener('click',event=>{
      const target=event.target.closest?.('[data-customer-operating-date],[data-customer-operating-reset]');if(!target||!target.closest?.('[data-customer-operating-root]')||!isCurrent()||!currentState)return;
      event.preventDefault();
      if(target.hasAttribute('data-customer-operating-reset'))currentState.scenario=defaults();
      else currentState.selectedDate=target.dataset.customerOperatingDate;
      refreshView();
    });
    document.addEventListener('toggle',event=>{const kind=event.target.dataset?.customerOperatingDetail;if(!kind||!currentState||!isCurrent()||!event.target.closest?.('[data-customer-operating-root]'))return;const key={scenario:'scenarioOpen',rules:'rulesOpen',evidence:'evidenceOpen'}[kind];if(key)currentState[key]=event.target.open===true;},true);
  }
  return {render,mount,stop,contextKey,visibleDays,blankNumber,defaults,displayPlan};
});
