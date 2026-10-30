(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./comparison-readiness.js'):root.InsightComparisonReadiness);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightCustomerOperatingActions=api;
})(typeof window!=='undefined'?window:globalThis,function(readinessApi){
  'use strict';
  // Customer-scoped, deterministic hypotheses over already-authorized saved reports.
  // No network, storage, price modification, coupon issuance or collection execution.
  const VERSION='customer-operating-actions-v1',DAY=86400000;
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const positive=v=>finite(v)&&v>0;
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
  const text=(v,fallback='')=>typeof v==='string'&&v.length<=300&&!/[\u0000-\u001f\u007f]/.test(v)?v:fallback;
  const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
  const kst=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?new Date(Date.parse(v)+9*3600000).toISOString().slice(0,10):null;
  const sameInstant=(a,b)=>a===null&&b===null||kst(a)!==null&&kst(b)!==null&&Date.parse(a)===Date.parse(b);
  const unique=v=>[...new Set(v)];
  const sum=(rows,key)=>rows.length?rows.reduce((n,r)=>n+r[key],0):null;
  const pct=v=>finite(v)?(v*100).toFixed(1)+'%':'미확인';
  const names=['일','월','화','수','목','금','토'];
  const selectionOf=value=>Object.fromEntries(['ownCompanyId','comparisonIds','stayMode','stayMonth','stayStart','stayEnd','asOfDate','selectedView'].filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,Array.isArray(value[key])?value[key].slice():value[key]]));
  const median=rows=>{const values=rows.filter(positive).sort((a,b)=>a-b);return values.length?values.length%2?values[(values.length-1)/2]:(values[values.length/2-1]+values[values.length/2])/2:null;};
  function rulesOf(options){
    const rule=(key,fallback,min,max)=>finite(options[key])&&options[key]>=min&&options[key]<=max?options[key]:fallback;
    return {label:'검토용 가정',gapPp:rule('gapPp',10,0,100),couponLeadDays:rule('couponLeadDays',14,0,366),minimumPeerCoverage:rule('minimumPeerCoverage',.8,.01,1),minimumPeerCompanies:Math.max(1,Math.floor(rule('minimumPeerCompanies',1,1,100))),definition:'공통 업종이 확인된 등록 동일지역 업체의 공통 숙박일을 비교하는 검토용 가정입니다. 검증된 할인 기준·최적 가격·효과 예측이 아닙니다.'};
  }
  function empty(selection,rules,reason){return {version:VERSION,status:'unavailable',contextValid:false,selection:null,company:{companyId:null,name:'내 매장',rooms:null},rules,groups:{same:[],cross:[],unknown:[]},summary:{selectedDays:0,validDays:0,missingDays:0,couponReviewDays:0,conditionReviewDays:0,maintainPriceDays:0,holdDays:0},days:[],cards:[],limits:[reason],executionAllowed:false};}
  function validPoint(row,company,p,current){
    if(!row||row.quantityStatus!=='ready'||row.missing!==false||row.inventoryConflict===true||row.capacityConflict===true||!count(company.rooms)||company.rooms<1)return false;
    if(![row.total,row.sold,row.publicBookings,row.phoneBookings].every(count)||row.total!==company.rooms||row.sold>row.total||row.sold!==row.publicBookings+row.phoneBookings)return false;
    if(Array.isArray(row.codes)&&row.codes.length)return false;
    if(!finite(row.reservationRate)||Math.abs(row.reservationRate-row.sold/row.total)>1e-10)return false;
    if(!date(row.collectedDate)||row.collectedDate>p.asOf||current&&Date.parse(p.asOf)-Date.parse(row.collectedDate)>7*DAY)return false;
    return row.collectedAt===null||kst(row.collectedAt)===row.collectedDate;
  }
  function pointMap(company,p){
    const series=company.reservationSeries;
    if(!series||series.companyId!==company.companyId||series.period?.start!==p.start||series.period.end!==p.end||series.asOf!==p.asOf||!Array.isArray(series.points))return new Map();
    const rows=new Map();
    for(const row of series.points){if(!date(row?.date)||row.date<p.start||row.date>p.end)continue;rows.set(row.date,rows.has(row.date)?null:row);}
    return rows;
  }
  function priceProducts(priceRows,companyId,stayDate,collectedDate){
    const rows=new Map();
    for(const row of Array.isArray(priceRows)?priceRows:[]){
      if(row?.source!=='stored_product_price'||row.companyId!==companyId||row.date!==stayDate||!id(row.productId||row.id)||!positive(row.price)||!Number.isSafeInteger(row.price)||kst(row.observedAt)!==collectedDate)continue;
      const key=row.productId||row.id,value={id:key,name:text(row.name,'숙박상품'),price:row.price,source:'stored_product_price',observedAt:row.observedAt};
      if(rows.has(key)&&JSON.stringify(rows.get(key))!==JSON.stringify(value))rows.set(key,null);else if(!rows.has(key))rows.set(key,value);
    }
    return [...rows.values()].filter(Boolean);
  }
  function industryOf(pair){
    const data=pair?.industry,keys=value=>Array.isArray(value)?unique(value.filter(v=>typeof v==='string'&&v.length>0&&v.length<=200)):[];
    const own=keys(data?.ownIndustryKeys),other=keys(data?.competitorIndustryKeys),shared=own.filter(key=>other.includes(key)),declared=keys(data?.sharedIndustryKeys);
    const common=pair?.rulesVersion==='insight-comparison-v1'&&pair.industryRelation==='common'&&data?.relation==='common'&&shared.length>0&&JSON.stringify(shared)===JSON.stringify(declared);
    return {relation:common?'common':own.length&&other.length&&!shared.length?'mixed':'unknown',sharedIndustryKeys:common?shared:[]};
  }
  function computeOperatingPlan(report,selection,catalog=[],options={}){
    const rules=rulesOf(options),p={start:selection?.stayStart,end:selection?.stayEnd,asOf:selection?.asOfDate};
    const invalid=reason=>empty(selection,rules,reason);
    if(!selection||!id(selection.ownCompanyId)||!Array.isArray(selection.comparisonIds)||!date(p.start)||!date(p.end)||!date(p.asOf)||p.start>p.end||(Date.parse(p.end)-Date.parse(p.start))/DAY>=3660)return invalid('선택한 매장·숙박기간·관측 기준을 확인해 주세요.');
    p.days=(Date.parse(p.end)-Date.parse(p.start))/DAY+1;
    if(report?.mode!=='current_briefing'||report.published!==false||report.ownId!==selection.ownCompanyId||report.period?.start!==p.start||report.period.end!==p.end||report.period.days!==p.days||(report.asOf||report.period.start)!==p.asOf)return invalid('다른 매장·기간의 저장 자료를 운영 제안에 섞지 않습니다.');
    const rawCompanies=Array.isArray(report.companies)?report.companies:[],map=new Map(),duplicate=new Set();
    for(const row of rawCompanies)if(id(row?.companyId)){if(map.has(row.companyId))duplicate.add(row.companyId);else map.set(row.companyId,row);}
    const owner=map.get(selection.ownCompanyId),selectedIds=unique(selection.comparisonIds),allowedCatalog=new Set((Array.isArray(catalog)?catalog:[]).map(row=>row?.companyId).filter(id));
    if(!owner||owner.kind!=='own'||!['active','pending'].includes(owner.relationStatus)||duplicate.has(owner.companyId)||selectedIds.length!==selection.comparisonIds.length||selectedIds.includes(owner.companyId)||allowedCatalog.size&&!allowedCatalog.has(owner.companyId))return invalid('내 매장 연결과 고객별 업체 권한을 확인해 주세요.');
    if(selectedIds.some(value=>!id(value)||duplicate.has(value)||!map.has(value)||map.get(value).kind!=='competitor'||!['active','pending'].includes(map.get(value).relationStatus)||allowedCatalog.size&&!allowedCatalog.has(value)))return invalid('현재 고객이 등록한 경쟁업체만 비교할 수 있습니다.');
    const ready=readinessApi?.build(report,{ownCompanyId:owner.companyId,comparisonIds:selectedIds});
    if(!ready?.period?.valid||ready.issues.some(row=>['INVALID_COMPANY','DUPLICATE_COMPANY','CONTEXT_MISMATCH'].includes(row.code)))return invalid('고객·업체·기간의 저장 근거를 확인하지 못했습니다.');
    const selectedCompanies=[owner,...selectedIds.map(value=>map.get(value))],readyMap=new Map(ready.companies.map(row=>[row.companyId,row]));
    const points=new Map(selectedCompanies.map(company=>[company.companyId,pointMap(company,p)]));
    const groups={same:[],cross:[],unknown:[]},pairs=new Map(),rawPairs=Array.isArray(report.comparisons)?report.comparisons:[];
    for(const companyId of selectedIds){
      const c=map.get(companyId),r=ready.comparisons.find(row=>row.companyId===companyId),raw=rawPairs.filter(row=>row.companyId===companyId);
      const pair=r&&raw.length===1?r:null,group=pair&&['same','cross'].includes(pair.regionRelation)?pair.regionRelation:'unknown';
      const industry=industryOf(raw[0]);
      const value={companyId,name:text(c.name,'등록 경쟁업체'),rooms:count(c.rooms)&&c.rooms>0?c.rooms:null,regionRelation:group,regionLabel:text(c.regionLabel,'지역 확인 필요'),industryRelation:industry.relation,sharedIndustryKeys:industry.sharedIndustryKeys,operatingPeerEligible:group==='same'&&industry.relation==='common',comparable:pair?.comparable===true,actionable:pair?.actionable===true,commonDays:pair?.commonDays??null,commonDates:pair?.commonDates||[],reasons:(pair?.reasons||[]).map(row=>row.label).filter(Boolean),purpose:pair?.purpose||'reference',capacityReviewRequired:readyMap.get(companyId)?.capacity?.reviewRequired===true};
      groups[group].push(value);pairs.set(companyId,{...value,observationTimes:raw[0]?.basisDetail?.observationTimes||[]});
    }
    const current=selection.stayMode==='upcoming30',ownerReady=readyMap.get(owner.companyId),sameGroup=groups.same.filter(pair=>pair.operatingPeerEligible),excludedPeers=groups.same.filter(pair=>!pair.operatingPeerEligible).map(pair=>({companyId:pair.companyId,name:pair.name,reason:pair.industryRelation==='mixed'?'다른 업종이므로 가격·쿠폰 기준에서 제외합니다.':'공통 업종 근거를 확인하지 못해 가격·쿠폰 기준에서 제외합니다.'})),company={companyId:owner.companyId,name:text(owner.name,'내 매장'),rooms:count(owner.rooms)&&owner.rooms>0?owner.rooms:null};
    const limits=['등록한 경쟁업체는 지역 전체 표본이나 평균이 아닙니다. 동일지역과 타지역을 하나의 평균으로 합치지 않습니다. 가격·쿠폰 기준에는 공통 업종이 확인된 동일지역 업체만 포함합니다.','방막기는 타채널 예약 추정이며 확인된 예약 장부와 구별합니다.','남은 일수는 숙박일과 선택한 검토 기준일의 날짜 차이입니다. 실제 관측일은 날짜별 근거에 별도로 표시하며 실제 예약 리드타임이나 신규 예약 건수가 아닙니다.','상품 조건·가격·실제 판매 가능 재고·공휴일 정보는 별도로 확인해야 합니다. 쿠폰 효과나 최적 할인율을 예측하지 않습니다.'];
    if(owner.relationStatus!=='active')limits.push('내 매장 연결이 확인 대기 중입니다. 읽기 전용 조건 검토이며 중앙의 행동 판단 보류를 해제하지 않습니다.');
    if(ready.source.preview)limits.push('최종 계산 전 저장 자료 미리보기입니다. 비교 판단을 보류합니다.');
    if(ready.source.refreshing||ready.source.refreshFailed)limits.push('저장된 정상 자료를 먼저 표시했습니다. 최신 확인 상태와 근거 시각을 확인한 뒤 운영 조건을 검토하세요.');
    const days=Array.from({length:p.days},(_,i)=>new Date(Date.parse(p.start+'T00:00:00Z')+i*DAY).toISOString().slice(0,10)).map(stayDate=>{
      const row=points.get(owner.companyId).get(stayDate),ownValid=ownerReady?.coverageKnown===true&&validPoint(row,owner,p,current),ownProducts=ownValid?priceProducts(options.priceRows,owner.companyId,stayDate,row.collectedDate):[];
      const peerRows=sameGroup.flatMap(pair=>{const c=map.get(pair.companyId),r=points.get(pair.companyId).get(stayDate),at=pairs.get(pair.companyId).observationTimes.find(item=>item.date===stayDate);return pair.comparable&&pair.commonDates.includes(stayDate)&&readyMap.get(pair.companyId)?.coverageKnown===true&&validPoint(r,c,p,current)&&ownValid&&r.collectedDate===row.collectedDate&&at&&sameInstant(at.ownObservedAt,row.collectedAt)&&sameInstant(at.competitorObservedAt,r.collectedAt)?[{...r,companyId:c.companyId}]:[];});
      const peerSupply=sum(peerRows,'total'),peerSold=sum(peerRows,'sold'),priceValues=peerRows.flatMap(r=>priceProducts(options.priceRows,r.companyId,stayDate,r.collectedDate).map(product=>product.price));
      const peers={label:'같은 지역·업종 비교',rate:positive(peerSupply)?peerSold/peerSupply:null,validCompanies:peerRows.length,expectedCompanies:sameGroup.length,sameRegionCompanies:groups.same.length,excludedCompanies:excludedPeers.length,eligibleCompanyIds:sameGroup.map(pair=>pair.companyId),coverage:sameGroup.length?peerRows.length/sameGroup.length:0,supply:peerSupply,sold:peerSold,price:median(priceValues),unreviewedCompanies:peerRows.filter(r=>readyMap.get(r.companyId)?.capacity?.reviewRequired===true).length,observations:peerRows.map(r=>({companyId:r.companyId,collectedAt:r.collectedAt,collectedDate:r.collectedDate}))};
      const own={rate:ownValid?row.reservationRate:null,supply:ownValid?row.total:null,sold:ownValid?row.sold:null,publicBookings:ownValid?row.publicBookings:null,inferredBookings:ownValid?row.phoneBookings:null,observedUnsold:ownValid?row.total-row.sold:null,available:null,price:median(ownProducts.map(product=>product.price)),products:ownProducts,collectedDate:ownValid?row.collectedDate:null,collectedAt:ownValid?row.collectedAt:null,capacityReviewed:ownerReady?.capacity?.known===true&&!ownerReady.capacity.reviewRequired&&!ownerReady.capacity.conflict};
      const day={date:stayDate,weekday:names[new Date(stayDate+'T00:00:00Z').getUTCDay()],leadDays:(Date.parse(stayDate)-Date.parse(p.asOf))/DAY,owner:own,peers,gapPp:ownValid&&finite(peers.rate)?(own.rate-peers.rate)*100:null,change:{comparable:false,publicNetChange:null,inferredNetChange:null,reason:'이전 동일 조건 관측의 예약 순변화는 연결 전입니다.'},products:ownProducts,action:'hold',actionLabel:'판단 보류',status:'hold',policyActionable:false,executionAllowed:false,reasons:[],reviewReasons:[],preconditions:[],evidence:[],steps:[],excludedPeerReferences:excludedPeers.map(pair=>({...pair})),crossReferences:groups.cross.map(pair=>({companyId:pair.companyId,name:pair.name,regionLabel:pair.regionLabel,commonDays:pair.commonDays,comparable:pair.comparable,actionable:false}))};
      const eligiblePairs=peerRows.map(r=>pairs.get(r.companyId)),hasEnough=peerRows.length>=rules.minimumPeerCompanies&&peers.coverage>=rules.minimumPeerCoverage;
      day.reviewReasons=unique(eligiblePairs.flatMap(pair=>pair.reasons));
      day.policyActionable=hasEnough&&eligiblePairs.every(pair=>pair.actionable)&&owner.relationStatus==='active'&&ready.source.preview!==true&&ready.source.refreshFailed!==true;
      if(!ownValid)day.reasons.push('내 매장 객실 수량·관측 기준을 확인하지 못했습니다. 미확인은 정상 0실로 바꾸지 않습니다.');
      else if(ready.source.preview)day.reasons.push('최종 계산 전 저장 자료 미리보기입니다. 날짜별 가격·쿠폰 후보 선정은 보류합니다.');
      else if(day.leadDays<0)day.reasons.push('검토 기준일보다 지난 숙박일은 현재 쿠폰 대상으로 선정하지 않습니다.');
      else if(!sameGroup.length){day.action='sales_conditions_review';day.actionLabel='상품·운영 참고';day.status='review';day.reasons.push(groups.same.length?'같은 지역에 등록 업체가 있으나 공통 업종 근거가 없어 쿠폰 날짜를 선별하지 않습니다.':groups.cross.length?'동일지역 비교업체가 없습니다. 타지역 업체는 상품·운영 참고로만 보고 쿠폰 날짜를 선별하지 않습니다.':'선택한 동일지역 경쟁업체가 없어 내 매장의 저장 자료와 판매 조건부터 확인합니다.');}
      else if(!hasEnough)day.reasons.push(`같은 지역·업종 비교군의 같은 숙박일 근거가 ${peerRows.length}/${sameGroup.length}곳입니다. 공통 날짜·객실 기준·관측 조건을 먼저 확인합니다.`);
      else{
        const behind=day.gapPp<=-rules.gapPp;
        day.status=day.policyActionable?'conditional':'review';
        if(own.observedUnsold===0){day.action='maintain_price';day.actionLabel='가격 유지 검토';day.reasons.push('관측 예약 수량이 객실 기준에 도달했습니다. 새 쿠폰을 추가하기 전 실제 재고를 확인합니다.');}
        else if(behind&&day.leadDays<=rules.couponLeadDays&&!(positive(own.price)&&positive(peers.price)&&own.price<peers.price)){day.action='limited_coupon_review';day.actionLabel='한정 쿠폰 조건 검토';day.reasons.push(`검토 기준 ${day.leadDays}일 남은 숙박일의 예약률이 같은 지역·업종 비교군보다 ${Math.abs(day.gapPp).toFixed(1)}%p 낮습니다.`);}
        else if(behind){day.action='sales_conditions_review';day.actionLabel='판매 조건 점검';day.reasons.push(day.leadDays>rules.couponLeadDays?'숙박일까지 남은 기간이 검토용 쿠폰 범위보다 길어 상품 구성·노출 조건을 먼저 점검합니다.':'표시가격이 이미 비교 표본보다 낮아 추가 할인보다 상품 조건과 판매 가능 여부를 먼저 확인합니다.');}
        else{day.action='maintain_price';day.actionLabel='가격 유지 검토';day.reasons.push('검토용 기준에서 큰 예약률 열위가 보이지 않아 기본가격을 먼저 유지하며 관측 변화를 확인합니다. 가격 인상 근거를 뜻하지 않습니다.');}
      }
      if(ownValid&&own.inferredBookings>own.publicBookings)day.reasons.push('타채널 추정 비중이 높습니다. 실수요 강세나 가격 인상의 근거로 확정하지 않습니다.');
      if(ownValid&&row.collectedDate<p.asOf)day.reasons.push(`내 매장 수량은 ${row.collectedDate} 관측입니다. 그 뒤 검토 기준일까지의 변경은 확인되지 않았습니다.`);
      if(!day.policyActionable&&day.action!=='hold')day.reasons.push('중앙 비교의 행동 판단은 보류 상태입니다. 아래 조건을 확인할 읽기 전용 초안이며 확정 할인 지시가 아닙니다.');
      day.preconditions=unique([...day.reviewReasons,'실제 판매 가능한 해당 상품의 남은 수량과 최소 받을 금액 확인','인원·박수·포함 혜택·취소조건이 같은 상품인지 확인']);
      day.steps=day.action==='hold'?['미확인 날짜와 비교 제외 사유의 저장 근거를 확인합니다. 정상 0실과 구별한 채 자료를 유지합니다.']:day.action==='limited_coupon_review'?['해당 숙박일의 실제 판매 가능 객실과 상품 조건을 먼저 확인합니다.','해당 상품·날짜만 대상으로 쿠폰 수량·만료 시각·중복 할인 제외 조건을 정해 검토합니다.','원가·수수료·무할인으로 앞으로 팔릴 수량·상품별 남은 한도를 입력하고 같은 금액을 남길 수 있는지 비교합니다.']:day.action==='maintain_price'?['현재 기본가격을 우선 유지하며 공개예약과 타채널 추정, 실제 판매 가능 재고를 대조합니다.','새 저장 관측에서 같은 숙박일의 변화가 확보되면 다시 검토합니다.']:['저장된 상품 설명·포함 혜택·예약 조건을 대조하고 실제 판매 가능한 날짜와 상품을 확인합니다.','타지역 차이는 지역 수요 차이가 섞인 참고값으로 유지하며 가격을 일괄 조정하지 않습니다.'];
      day.evidence=[`${company.name}: 공개 ${own.publicBookings===null?'미확인':own.publicBookings}실 + 타채널 추정 ${own.inferredBookings===null?'미확인':own.inferredBookings}실 / 객실 기준 ${own.supply===null?'미확인':own.supply}실`,`같은 지역·업종 유효 ${peerRows.length}/${sameGroup.length}곳 · 예약률 ${pct(peers.rate)} · 공급 ${peerSupply===null?'미확인':peerSupply}실`,`숙박일 ${stayDate} · 검토 기준 ${p.asOf} · 남은 ${day.leadDays}일`,`실제 수량 관측일 ${own.collectedDate||'미확인'}`,`중앙 행동 판단 ${day.policyActionable?'조건 충족':'보류 · 선결조건 확인'}`,'객실 기준에서 예약 수량을 뺀 값은 데이유즈·판매중지 등을 확인한 실제 판매 가능 재고가 아닙니다.'];
      return day;
    });
    const valid=days.filter(day=>finite(day.owner.rate)),matched=days.filter(day=>finite(day.owner.rate)&&finite(day.peers.rate)),ownerSupply=sum(valid.map(day=>({supply:day.owner.supply})),'supply'),ownerSold=sum(valid.map(day=>({sold:day.owner.sold})),'sold'),peerSupply=sum(matched.map(day=>({supply:day.peers.supply})),'supply'),peerSold=sum(matched.map(day=>({sold:day.peers.sold})),'sold');
    const matchedOwnerSupply=sum(matched.map(day=>({supply:day.owner.supply})),'supply'),matchedOwnerSold=sum(matched.map(day=>({sold:day.owner.sold})),'sold');
    const summary={selectedDays:p.days,validDays:valid.length,missingDays:p.days-valid.length,couponReviewDays:days.filter(d=>d.action==='limited_coupon_review').length,conditionReviewDays:days.filter(d=>d.action==='sales_conditions_review').length,maintainPriceDays:days.filter(d=>d.action==='maintain_price').length,holdDays:days.filter(d=>d.action==='hold').length,ownerRate:positive(matchedOwnerSupply)?matchedOwnerSold/matchedOwnerSupply:null,observedOwnerRate:positive(ownerSupply)?ownerSold/ownerSupply:null,peerRate:positive(peerSupply)?peerSold/peerSupply:null,matchedDays:matched.length,sameRegionCompanies:groups.same.length,sameIndustryPeerCompanies:sameGroup.length,crossRegionCompanies:groups.cross.length,unknownRegionCompanies:groups.unknown.length,policyReviewDays:days.filter(d=>d.status==='review').length};
    const priority={limited_coupon_review:0,sales_conditions_review:1,maintain_price:2,hold:3},first=[...days].sort((a,b)=>priority[a.action]-priority[b.action]||a.leadDays-b.leadDays).find(d=>d.action!=='hold');
    const cards=[{id:'customer-operating-priority',title:'먼저 볼 숙박일',status:first?.status||'hold',finding:first?`${first.date} · ${first.actionLabel} · ${company.name} ${pct(first.owner.rate)} / 같은 지역·업종 ${pct(first.peers.rate)}`:'유효한 동일 조건 근거를 먼저 확인합니다.',action:first?.steps[0]||'객실 기준·미확인 날짜·공통 관측일을 확인합니다.',evidence:first?.evidence||[],limits:first?.reviewReasons||[],targetDates:first?[first.date]:[]},{id:'customer-comparison-groups',title:'비교군을 나눠 보기',status:'review',finding:`동일지역 ${groups.same.length}곳 · 타지역 ${groups.cross.length}곳 · 지역 미확인 ${groups.unknown.length}곳`,action:'동일지역의 공통 날짜로 검토하고, 타지역은 상품·운영 참고로 분리합니다.',evidence:[],limits:[limits[0]],targetDates:[]},{id:'customer-coupon-arithmetic',title:'쿠폰 조건 비교',status:'review',finding:'할인율 기본 0% · 원가·수수료·예상 판매수·상품 한도는 직접 입력',action:'실제 상품 가격이 없으면 사용자 입력 가정으로 구별합니다. 이미 예약된 객실에는 소급 적용하지 않습니다.',evidence:[],limits:['쿠폰 발급·가격 변경·수집 실행 기능은 없습니다.'],targetDates:[]}];
    return {version:VERSION,status:valid.length?summary.holdDays||summary.policyReviewDays?'limited':'ready':'unavailable',contextValid:true,selection:selectionOf(selection),period:p,company,rules,groups,summary,days,cards,limits,executionAllowed:false};
  }
  function computeCouponScenario(input={}){
    const price=input.price,discountPercent=input.discountPercent===undefined?0:input.discountPercent,{variableCost,commissionPercent,baselineRooms,capacity}=input;
    const result={status:'incomplete',price:positive(price)?price:null,discountPercent,discountedPrice:null,discountPerRoom:null,baselineContributionPerRoom:null,couponContributionPerRoom:null,baselineContribution:null,breakEvenRooms:null,extraRooms:null,capacityFeasible:null,reasons:[],assumptions:['한 숙박일·한 상품의 남은 재고 중 앞으로의 판매를 가정하며 기존 예약에는 할인을 소급하지 않습니다.','쿠폰은 업체 전액 부담이고 수수료는 할인 후 금액에 적용합니다. 변동비를 차감하며 고정비·세금·쿠폰 중복은 제외합니다.','필요 판매수량은 산술 조건이며 판매 가능성이나 매출 증가 예측이 아닙니다.']};
    if(!positive(price)||!finite(discountPercent)||discountPercent<0||discountPercent>100){result.status='invalid';result.reasons.push('양의 상품 가격과 0~100% 할인율을 입력하세요.');return result;}
    result.discountedPrice=Math.round(price*(1-discountPercent/100));result.discountPerRoom=price-result.discountedPrice;
    if(![price,result.discountedPrice,result.discountPerRoom].every(Number.isSafeInteger)){result.status='invalid';result.discountedPrice=null;result.discountPerRoom=null;result.reasons.push('원 단위로 안전하게 계산 가능한 가격을 입력하세요.');return result;}
    if([variableCost,commissionPercent,baselineRooms,capacity].some(v=>v===null||v===undefined||v==='')){result.reasons.push('변동비·수수료·무할인 판매 가정 수량·남은 상품 판매한도를 직접 입력해야 계산합니다.');return result;}
    if(!finite(variableCost)||variableCost<0||!finite(commissionPercent)||commissionPercent<0||commissionPercent>100||!count(baselineRooms)||!count(capacity)||baselineRooms>capacity){result.status='invalid';result.reasons.push('원가·수수료·정수 수량을 확인하세요. 무할인 판매 가정은 상품의 남은 한도를 넘을 수 없습니다.');return result;}
    result.baselineContributionPerRoom=price*(1-commissionPercent/100)-variableCost;result.couponContributionPerRoom=result.discountedPrice*(1-commissionPercent/100)-variableCost;result.baselineContribution=result.baselineContributionPerRoom*baselineRooms;
    if(![result.baselineContributionPerRoom,result.couponContributionPerRoom,result.baselineContribution].every(v=>finite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER)){result.status='invalid';result.baselineContributionPerRoom=null;result.couponContributionPerRoom=null;result.baselineContribution=null;result.reasons.push('안전한 계산 범위를 넘었습니다. 금액과 수량을 확인하세요.');return result;}
    if(result.baselineContributionPerRoom<=0||result.couponContributionPerRoom<=0){result.status='unprofitable';result.reasons.push('1실당 비용 제외 금액이 0원 이하라 판매수량 증가로 보전할 수량을 제시하지 않습니다.');return result;}
    const exact=result.baselineContribution/result.couponContributionPerRoom;
    if(!finite(exact)||exact>Number.MAX_SAFE_INTEGER){result.status='invalid';result.reasons.push('필요 판매수량의 계산 범위를 넘었습니다.');return result;}
    // Unchanged prices have an exact room-count identity. A rounding tolerance
    // must never grow into whole rooms for otherwise-safe large integers.
    const tolerance=Math.min(1e-9,Number.EPSILON*Math.max(1,Math.abs(exact))*4);
    result.breakEvenRooms=result.discountedPrice===price?baselineRooms:Math.max(0,Math.ceil(exact-tolerance));result.extraRooms=result.breakEvenRooms-baselineRooms;result.capacityFeasible=result.breakEvenRooms<=capacity;result.status=result.capacityFeasible?'calculated':'capacity_exceeded';result.reasons.push(result.capacityFeasible?'입력한 남은 상품 한도 안의 산술 조건입니다. 실제 판매를 예측하지 않습니다.':'같은 비용 제외 금액을 남기는 데 필요한 수량이 입력한 상품 판매한도를 넘습니다.');return result;
  }
  return Object.freeze({VERSION,computeOperatingPlan,computeCouponScenario});
});
