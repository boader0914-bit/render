(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./comparison-readiness.js'):root.InsightComparisonReadiness);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightComparisonReadinessView=api;
})(typeof window==='undefined'?this:window,function(modelApi){
  'use strict';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const n=value=>numeric(value)?value.toLocaleString('ko-KR',{maximumFractionDigits:1}):'미확인';
  const list=value=>Array.isArray(value)?value:[];
  const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?value:'확인 필요';
  const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'확인 전';
  const companyLink=id=>`#company=${encodeURIComponent(id)}`;
  const metricStatus=metric=>metric?.comparable===true?'비교 가능':metric?.displayable===true?'수치 참고 · 비교 보류':'미확인 · 비교 보류';
  const tone=metric=>metric?.comparable===true?'ready':metric?.displayable===true?'reference':'unknown';
  const amount=value=>numeric(value)?`${n(value/10000)}만원`:'금액 미확인';
  const sourceReason=value=>({shared_dayuse_unverified:'데이유즈 공유 수량 미확인',partial_inventory:'상품 재고 일부 미확인',capacity_recalculation_unavailable:'객실 기준 계산 근거 부족'})[value]||'전체 수량 확인 필요';
  function savedAvailability(company){
    const partial=company.partialRevenue||{},stored=company.storedReference||{};
    return `${partial.days>0?`<small class="readiness-supplement-label is-partial">부분 금액 ${n(partial.days)}일 · ${amount(partial.amount)}</small>`:''}${stored.days>0?`<small class="readiness-supplement-label is-stored">오래된 참고 ${n(stored.days)}일</small>`:''}`;
  }
  function metricCell(metric,extra=''){
    return `<span class="readiness-state is-${tone(metric)}">${metricStatus(metric)}</span>${extra?`<small>${extra}</small>`:''}`;
  }
  function periodText(period){return `${date(period?.start)} ~ ${date(period?.end)}`;}
  function scopeNotice(source={}){
    if(source.preview)return '저장 자료 미리보기 · 최종 비교 계산 전';
    if(source.refreshFailed)return '최신 확인 지연 · 저장 자료 유지';
    if(source.refreshing)return '저장 자료 표시 · 최신 자료 확인 중';
    return '저장 자료 기준';
  }
  function companyRow(company,pair,period){
    const own=company.kind==='own',capacity=company.capacity||{};
    const coverage=company.coverageKnown===true&&numeric(company.availableDays)&&numeric(period.days)?`${n(company.availableDays)} / ${n(period.days)}일`:'확보 범위 미확인';
    const capacityTone=!capacity.known||capacity.reviewRequired||capacity.conflict?'unknown':'ready';
    const roomLabel=numeric(company.rooms)?`${n(company.rooms)}실`:'객실 미확인';
    const quantity=numeric(company.quantity?.sold)?`${n(company.quantity.sold)}실`:'수량 미확인';
    const money=amount(company.knownRevenueSubtotal);
    const quantityLabel=numeric(company.quantity?.sold)?`선택기간 수량 ${quantity}`:quantity;
    const moneyLabel=numeric(company.knownRevenueSubtotal)?`선택기간 소계 ${money}`:money;
    const commonLabel=own?'':`<small>공통 비교 ${numeric(pair?.commonDays)?n(pair.commonDays)+'일':'미확인'}</small>`;
    const ownMetric=label=>`<span class="readiness-state is-reference">비교 기준</span><small>${label}</small>`;
    return `<tr data-readiness-company="${esc(company.companyId)}"><th scope="row"><a href="${companyLink(company.companyId)}">${esc(company.name||'업체')}</a><small>${own?'내 매장':pair?.regionRelation==='cross'?'다른 지역 · 운영 참고':pair?.regionRelation==='same'?'같은 지역':'지역 확인 필요'}</small></th><td data-label="객실 기준"><strong class="readiness-state is-${capacityTone}">${roomLabel}</strong><small>${esc(capacity.label||'객실 기준 확인 필요')}</small></td><td data-label="확보일 / 선택일"><strong>${coverage}</strong>${commonLabel}<small>마지막 관측 ${esc(date(company.lastObservedDay))}</small>${savedAvailability(company)}</td><td data-label="수량 비교">${own?ownMetric(quantityLabel):metricCell(pair?.quantity,quantityLabel)}</td><td data-label="예약률 비교">${own?ownMetric('객실 기준과 유효 날짜 확인'):metricCell(pair?.rate)}</td><td data-label="매출 비교">${own?ownMetric(moneyLabel):metricCell(pair?.revenue,moneyLabel)}${numeric(company.knownRevenueSubtotal)&&(list(company.unknownRevenueDates).length||company.revenueUnknownRooms>0||company.coverageKnown!==true||company.availableDays<period.days)?'<small class="readiness-state is-unknown">확인된 소계 · 전체 매출 아님</small>':''}</td></tr>`;
  }
  function groupedIssues(issues){
    const groups=[],byReason=new Map();
    for(const issue of issues){
      // Provider/source failures keep their original period. Only repeated
      // date-level reasons share one visible reason and an exact date list.
      if(issue.period){groups.push(issue);continue;}
      const key=JSON.stringify([issue.code||'',issue.label||'',issue.side||'',issue.scope||'']);
      let group=byReason.get(key);
      if(!group){group={...issue,dates:[]};delete group.date;byReason.set(key,group);groups.push(group);}
      if(issue.date&&!group.dates.includes(issue.date))group.dates.push(issue.date);
    }
    return groups.map(group=>group.dates?.length?{...group,dates:group.dates.sort()}:group);
  }
  function issueLine(issue){
    const scope=issue.date?date(issue.date):issue.period?typeof issue.period==='string'?issue.period:periodText(issue.period):null;
    const dates=list(issue.dates);
    return `<li>${scope?`<time>${esc(scope)}</time>`:''}<span>${esc(issue.label||'근거 확인 필요')}</span>${issue.code?`<code>${esc(issue.code)}</code>`:''}${dates.length?`<span class="readiness-dates">${dates.length>1?`${n(dates.length)}일 · `:''}${dates.map(day=>esc(date(day))).join(' · ')}</span>`:''}</li>`;
  }
  function companyEvidence(company){
    const missing=list(company.missingDays),unknownMoney=list(company.unknownRevenueDates),issues=list(company.issues);
    const partial=list(company.partialRevenue?.rows),stored=list(company.storedReference?.rows),unconfirmed=list(company.unconfirmedDates??missing);
    const partialDetail=partial.length?`<section class="readiness-supplement is-partial"><h5>일부 상품 금액(추정 포함) · ${n(partial.length)}일</h5><p><strong>${amount(company.partialRevenue.amount)}</strong><span>정상 매출 소계와 별도 · 전체 예약수량·금액 미확인</span></p><details><summary>날짜별 부분금액·수집 근거 <span aria-hidden="true">+</span></summary><div class="readiness-supplement-table"><table><thead><tr><th>숙박일</th><th>부분 금액</th><th>수량 미확인 사유</th><th>관측·수집 근거</th></tr></thead><tbody>${partial.map(row=>`<tr><th scope="row">${esc(date(row.date))}</th><td>${amount(row.amount)}</td><td>${esc(sourceReason(row.reason))}</td><td>${esc(stamp(row.collectedAt))}<code>${esc(row.runId)}</code></td></tr>`).join('')}</tbody></table></div></details></section>`:'';
    const storedDetail=stored.length?`<section class="readiness-supplement is-stored"><h5>오래된 저장 수량 · ${n(stored.length)}일</h5><p>자료는 보존되어 있습니다. 최근 관측 범위 밖이므로 현재 예약률·쿠폰 판단에서 제외합니다.</p><details><summary>날짜별 저장 수량·관측일 <span aria-hidden="true">+</span></summary><div class="readiness-supplement-table"><table><thead><tr><th>숙박일</th><th>당시 예약수량</th><th>구분</th><th>관측일</th></tr></thead><tbody>${stored.map(row=>`<tr><th scope="row">${esc(date(row.date))}</th><td>${n(row.sold)}실 / ${n(row.total)}실</td><td>공개 ${n(row.publicBookings)}실 + 타채널 추정 ${n(row.phoneBookings)}실</td><td>${esc(stamp(row.collectedAt))}</td></tr>`).join('')}</tbody></table></div></details></section>`:'';
    return `<article class="readiness-company-evidence"><h4>${esc(company.name||'업체')} <a class="text-link" href="${companyLink(company.companyId)}">업체 DB 보기 →</a></h4>${partialDetail}${storedDetail}${unconfirmed.length?`<p><strong>수량 미확인 ${n(unconfirmed.length)}일</strong><span class="readiness-dates">${unconfirmed.map(day=>esc(date(day))).join(' · ')}</span></p>`:''}${missing.length&&(partial.length||stored.length)?`<p class="muted">현재 수량 비교 제외 ${n(missing.length)}일 · 부분 금액과 오래된 참고 자료는 위에 구분했습니다.</p>`:''}${unknownMoney.length?`<p><strong>금액 미확인 ${n(unknownMoney.length)}일</strong><span class="readiness-dates">${unknownMoney.map(day=>esc(date(day))).join(' · ')}</span></p>`:''}${company.revenueUnknownRooms>0?`<p>금액 미확인 예약 ${n(company.revenueUnknownRooms)}실 · 확인된 매출 소계에 포함되지 않음</p>`:''}${issues.length?`<ul>${groupedIssues(issues).map(issueLine).join('')}</ul>`:!missing.length&&!unknownMoney.length?`<p class="muted">${company.coverageKnown===true?'개별 미확인 사유가 보고되지 않았습니다. 비교 가능 여부는 위 표를 확인하세요.':'날짜별 근거가 없어 확보 범위를 확정하지 않습니다.'}</p>`:''}</article>`;
  }
  function pairEvidence(pair){
    const dates=list(pair.commonDates),excluded=list(pair.excludedDates),reasons=list(pair.reasons);
    const excludedReasons=excluded.map(row=>({date:row.date,side:row.side,scope:'comparison',label:(row.side==='own'?'내 매장 · ':row.side==='competitor'?'비교업체 · ':'')+(row.label||'비교 근거 확인 필요'),code:list(row.codes).join(' · ')}));
    return `<article class="readiness-pair-evidence"><h4>${esc(pair.name||'비교업체')}와 공통 날짜</h4><p>${numeric(pair.commonDays)?`${n(pair.commonDays)}일`:'일수 확인 필요'}${dates.length?` · ${esc(date(dates[0]))} ~ ${esc(date(dates[dates.length-1]))}`:''}${numeric(pair.minimumDays)?` · 비교 최소 ${n(pair.minimumDays)}일`:''}${pair.regionRelation==='cross'?' · 다른 지역은 운영 참고':''}</p>${dates.length?`<p class="readiness-dates">${dates.map(day=>esc(date(day))).join(' · ')}</p>`:'<p class="muted">동일 조건의 공통 날짜를 확인하지 못했습니다.</p>'}${reasons.length?`<ul>${groupedIssues(reasons).map(issueLine).join('')}</ul>`:''}${excluded.length?`<div class="readiness-excluded"><strong>비교 제외 날짜와 사유</strong><ul>${groupedIssues(excludedReasons).map(issueLine).join('')}</ul></div>`:''}</article>`;
  }
  function renderModel(model){
    if(!model||!Array.isArray(model.companies))return '';
    const period=model.period||{},pairs=list(model.comparisons),companies=model.companies,issues=list(model.issues),source=model.source||{};
    const status=model.status==='ready'?'비교 근거 확인됨':model.status==='partial'?'일부 자료 확인 필요':'비교 근거 확인 필요';
    return `<section class="card comparison-readiness" data-comparison-readiness><header class="readiness-heading"><div><h2>비교 자료 확인</h2><p>${esc(periodText(period))}${numeric(period.days)?` · 선택 ${n(period.days)}일`:''}${period.asOf?` · 관측 기준 ${esc(date(period.asOf))}`:''}</p></div><span class="readiness-state is-${model.status==='ready'?'ready':'unknown'}">${status}</span></header><p class="readiness-source">${esc(scopeNotice(source))} · 자료 시각 ${esc(stamp(source.generatedAt))}${source.checkedAt?` · 최신 확인 ${esc(stamp(source.checkedAt))}`:''}</p>${companies.length?`<div class="readiness-table-wrap"><table class="readiness-table"><caption class="sr-only">업체별 객실 기준과 선택 기간의 확보일, 수량·예약률·매출 비교 가능 여부</caption><thead><tr><th scope="col">업체</th><th scope="col">객실 기준</th><th scope="col">확보일 / 선택일</th><th scope="col">수량 비교</th><th scope="col">예약률 비교</th><th scope="col">매출 비교</th></tr></thead><tbody>${companies.map(company=>companyRow(company,pairs.find(pair=>pair.companyId===company.companyId),period)).join('')}</tbody></table></div>`:'<p class="empty-note">선택한 업체의 저장 자료를 확인하지 못했습니다.</p>'}${issues.length?`<ul class="readiness-notices">${issues.map(issueLine).join('')}</ul>`:''}<details class="readiness-details" data-readiness-details="evidence"><summary>공통 날짜·미확인·제외 사유 <span aria-hidden="true">+</span></summary><div class="readiness-evidence">${companies.map(companyEvidence).join('')}${pairs.map(pairEvidence).join('')}</div></details><p class="readiness-footnote">수량·금액은 업체별 선택기간 소계이며, 비교 여부는 공통 날짜 기준입니다. 공개 예약과 타채널 추정은 구분합니다. 정상 0실과 미확인은 다르며, 수치 참고는 전략 판단 가능을 뜻하지 않습니다. 부분 금액·오래된 참고는 현재 예약률·쿠폰 판단에 포함하지 않습니다.</p></section>`;
  }
  function project(report,selection={}){
    if(typeof modelApi?.build!=='function')return null;
    try{return modelApi.build(report,selection);}catch{return null;}
  }
  function render(report,selection={}){return renderModel(project(report,selection));}
  return {render,renderModel,metricStatus,project,savedAvailability};
});
