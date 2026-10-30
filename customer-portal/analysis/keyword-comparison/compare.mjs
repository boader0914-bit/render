// Pure saved-data projection. No IO, collection, pricing or coupon execution.
export const median=values=>{const v=values.filter(x=>typeof x==='number'&&Number.isFinite(x)).sort((a,b)=>a-b);return v.length?v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2:null;};
export function datesBetween(start,end){if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end||''))return [];const a=Date.parse(start+'T00:00:00Z'),b=Date.parse(end+'T00:00:00Z');if(!Number.isFinite(a)||!Number.isFinite(b)||new Date(a).toISOString().slice(0,10)!==start||new Date(b).toISOString().slice(0,10)!==end||b<a||(b-a)/864e5>366)return [];return Array.from({length:(b-a)/864e5+1},(_,i)=>new Date(a+i*864e5).toISOString().slice(0,10));}
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const known=r=>r?.quantityStatus==='valid'&&[r.supply,r.publicBookings,r.inferredBookings,r.sold].every(x=>Number.isSafeInteger(x)&&x>=0)&&r.supply>0&&r.sold<=r.supply&&r.sold===r.publicBookings+r.inferredBookings;
const sum=(rows,key)=>rows.reduce((a,r)=>a+(finite(r[key])?r[key]:0),0);
export function aggregateRows(rows,expectedDays=rows.length){
  const valid=rows.filter(known),supply=sum(valid,'supply'),sold=sum(valid,'sold');
  const prices=rows.flatMap(r=>Array.isArray(r.priceValues)?r.priceValues:[]).filter(v=>finite(v)&&v>0);
  const expectedPrices=sum(rows,'productCount');
  return {coveredDays:valid.length,expectedDays,supply:supply||null,publicBookings:valid.length?sum(valid,'publicBookings'):null,inferredBookings:valid.length?sum(valid,'inferredBookings'):null,sold:valid.length?sold:null,rate:supply?sold/supply:null,rateDenominator:'covered_supply',quantityUnit:'실',publicRate:supply?sum(valid,'publicBookings')/supply:null,inferredRate:supply?sum(valid,'inferredBookings')/supply:null,available:valid.length?sum(valid,'available'):null,dayUseExcluded:valid.length?sum(valid,'dayUseExcluded'):null,medianProductPrice:median(prices),priceCount:prices.length,priceExpectedCount:expectedPrices,priceCoverage:expectedPrices?prices.length/expectedPrices:null,quantityCoverage:expectedDays?valid.length/expectedDays:null,reasons:[...new Set(rows.flatMap(r=>r.reasons||[]))],sourceRefs:[...new Set(rows.flatMap(r=>r.sourceRefs||[]))],priceValues:prices};
}
function changeRows(current,previous){
  const old=new Map(previous.map(r=>[r.companyId+'|'+r.date,r]));const pairs=[];const priceChanges=[];const excluded=[];
  for(const r of current){const p=old.get(r.companyId+'|'+r.date);if(!p)continue;
    if(known(r)&&known(p)&&r.supply===p.supply&&typeof r.productSignature==='string'&&r.productSignature.length>0&&r.productSignature===p.productSignature&&typeof r.capacityRevision==='string'&&r.capacityRevision.length>0&&r.capacityRevision===p.capacityRevision)pairs.push({current:r,previous:p});
    else excluded.push({companyId:r.companyId,date:r.date,reason:!known(r)||!known(p)?'quantity_unverified':r.supply!==p.supply||r.capacityRevision!==p.capacityRevision?'capacity_changed':'product_set_changed'});
    const oldPrices=new Map((p.productPrices||[]).map(x=>[x.id,x]));
    for(const x of r.productPrices||[]){const y=oldPrices.get(x.id);if(y&&x.name===y.name&&x.price>0&&y.price>0)priceChanges.push(x.price-y.price);}
  }
  const c=aggregateRows(pairs.map(p=>p.current)),p=aggregateRows(pairs.map(p=>p.previous));
  return {publicNetChange:pairs.length?c.publicBookings-p.publicBookings:null,inferredNetChange:pairs.length?c.inferredBookings-p.inferredBookings:null,soldNetChange:pairs.length?c.sold-p.sold:null,rateChangePp:pairs.length?(c.rate-p.rate)*100:null,comparableDays:pairs.length,comparableCompanyDays:pairs.length,commonStayDays:new Set(pairs.map(p=>p.current.date)).size,previousCoveredDays:previous.filter(known).length,currentCoveredDays:current.filter(known).length,productMatchedPriceMedianChange:median(priceChanges),matchedProductPricePairs:priceChanges.length,excludedPairs:excluded.length,excluded,reason:pairs.length?'같은 업체·상품구성과 공급 기준의 공통 숙박일 순증감':'공통 날짜의 수량·객실 기준을 확인하지 못해 예약 변화 비교를 보류합니다.'};
}
function visibleDay(date,filter){const day=new Date(date+'T00:00:00Z').getUTCDay();return filter==='all'||filter==='weekday'&&day>=1&&day<=4||filter==='friday'&&day===5||filter==='saturday'&&day===6||filter==='sunday'&&day===0;}
const pct=n=>finite(n)?(n*100).toFixed(1)+'%':'미확인';
const won=n=>finite(n)?Math.round(n).toLocaleString('ko-KR')+'원':'미확인';
function decisionCards(owner,benchmark,selection){
  const comparable=finite(owner.rate)&&finite(benchmark.rate);const gap=comparable?(owner.rate-benchmark.rate)*100:null;
  const priceComparable=finite(owner.medianProductPrice)&&finite(benchmark.medianProductPrice);
  const changeComparable=owner.change?.comparableDays>0;
  return [
    {id:'reservation-reference',title:'같은 숙박일의 예약 수준',status:comparable?'reference_only':'hold',finding:comparable?`월명 ${pct(owner.rate)} · 상위 20개 표본 ${pct(benchmark.rate)} · 차이 ${gap>=0?'+':''}${gap.toFixed(1)}%p`:'수량 근거를 확보하지 못한 날짜가 있어 예약률 비교를 보류합니다.',action:comparable?'차이가 나타나는 숙박일과 요일을 먼저 확인하고, 내 매장의 실제 판매 가능 재고와 상품 조건을 대조하세요.':'상품별 수량 응답과 객실 기준의 원본을 먼저 확인하세요. 유효한 기준을 확보한 뒤 같은 숙박일을 비교하며, 그 전에는 운영 변경 판단을 보류합니다.',evidence:[`숙박일 ${selection.start}~${selection.end}`,`월명 유효 ${owner.coveredDays}/${owner.expectedDays}일 · 표본 유효 ${benchmark.coveredDays}/${benchmark.expectedDays}업체·일`,`표본 ${benchmark.companyCount}곳, ${benchmark.includingOwner?'월명 포함':'월명은 별도 비교 대상'}`],limits:['과거 저장 관측의 추정 예약률이며 최종 판매 실적이 아닙니다.','표본에 객실수 검수 전 업체가 포함돼 수치는 참고용입니다.','지역 전체의 예약률이나 가격 인하 필요성을 뜻하지 않습니다.']},
    {id:'price-reference',title:'가격을 비교하기 전에 상품 조건 확인',status:priceComparable?'reference_only':'hold',finding:`숙박상품 표시가격 중앙값 · 월명 ${won(owner.medianProductPrice)} · 표본 ${won(benchmark.medianProductPrice)}`,action:priceComparable?'인원·포함 혜택·박수·취소조건이 같은 상품을 확인한 뒤 가격 또는 쿠폰 적용 대상을 검토하세요. 할인율은 아직 정하지 않습니다.':'미확인 상품의 판매가격과 인원·박수·혜택·취소조건 근거를 먼저 확보하세요. 가격 비교와 가격·쿠폰 조건 변경 판단은 그때까지 보류합니다.',evidence:[`월명 가격 ${owner.priceCount}/${owner.priceExpectedCount}개 상품·날짜`, `표본 가격 ${benchmark.priceCount}/${benchmark.priceExpectedCount}개 상품·날짜`],limits:['상품×숙박일의 양의 표시가격 전체에서 계산한 중앙값이며 실제 예약 평균단가가 아닙니다.','타 업체 상품 조건이 완전히 일치하는지 확인되지 않아 가격 적정성 판단은 보류합니다.','쿠폰 노출만으로 사용·비용·효과를 알 수 없습니다.']},
    {id:'change-reference',title:'예약 변화가 관측된 구간',status:changeComparable?'reference_only':'hold',finding:changeComparable?`공개예약 ${owner.change.publicNetChange>=0?'+':''}${owner.change.publicNetChange}실 · 타채널 추정 ${owner.change.inferredNetChange>=0?'+':''}${owner.change.inferredNetChange}실 · 공통 ${owner.change.comparableDays}일`:'선택한 두 회차 사이의 예약 변화는 비교 가능한 수량 근거가 부족합니다.',action:changeComparable?'예약이 늘거나 줄어든 날짜와 그때의 상품 가격을 확인하세요. 쿠폰의 적용 시점은 실제 예약 기록과 운영 조건을 함께 보고 정합니다.':'같은 업체·숙박일·상품구성·객실 기준의 원본과 유효한 이전 회차를 먼저 확인하세요. 비교 근거를 확보하기 전에는 쿠폰 적용 시점과 운영 변경 판단을 보류합니다.',evidence:[`이전 ${selection.previousRunId||'선택 없음'}`,`이후 ${selection.runId}`,`관측 간격 ${selection.observationGapDays===null?'미확인':selection.observationGapDays.toFixed(2)+'일'}`],limits:['두 관측 사이의 순증감입니다. 실제 예약접수일·신규 예약 건수·실제 리드타임이 아닙니다.','취소·재예약·채널 재고 변경 등이 섞일 수 있습니다.','가격·쿠폰 변경이 예약 증가의 원인이라고 단정하지 않습니다.']}
  ];
}
export function computeComparison(snapshot,options={}){
  const runs=snapshot.runs||[],last=runs.at(-1),run=runs.find(r=>r.id===(options.runId||snapshot.meta.defaultRunId))||last;
  if(!run)throw Error('RUN_REQUIRED');
  const previousCandidate=Object.hasOwn(options,'previousRunId')?runs.find(r=>r.id===options.previousRunId):runs.filter(r=>Date.parse(r.observedAt)<Date.parse(run.observedAt)).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)).at(-1);
  const previous=previousCandidate&&Date.parse(previousCandidate.observedAt)<Date.parse(run.observedAt)?previousCandidate:undefined;
  const start=options.start||snapshot.meta.defaultStart,end=options.end||snapshot.meta.defaultEnd,dayFilter=options.dayFilter||'all';
  const days=datesBetween(start,end).filter(d=>visibleDay(d,dayFilter));if(!days.length)throw Error('VALID_STAY_DATES_REQUIRED');
  const daySet=new Set(days),memberIds=(options.cohort==='run'?run:last).members;
  const ownerCompany=(snapshot.companies||[]).find(c=>c.placeId===snapshot.meta.ownerPlaceId);if(!ownerCompany)throw Error('OWNER_ID_REQUIRED');
  const current=(snapshot.daily||[]).filter(r=>r.runId===run.id&&daySet.has(r.date)),before=(snapshot.daily||[]).filter(r=>r.runId===previous?.id&&daySet.has(r.date));
  const companyFor=c=>{const rows=current.filter(r=>r.companyId===c.id),old=before.filter(r=>r.companyId===c.id),a=aggregateRows(rows,days.length);return {...c,companyId:c.id,rank:c.ranks?.[run.id]??null,...a,priceValues:undefined,daily:rows,change:changeRows(rows,old)};};
  const companies=memberIds.map(id=>(snapshot.companies||[]).find(c=>c.id===id)).filter(Boolean).map(companyFor).sort((a,b)=>(a.rank??999)-(b.rank??999));
  const owner=companies.find(c=>c.id===ownerCompany.id)||companyFor(ownerCompany);
  const set=new Set(memberIds),benchmarkRows=current.filter(r=>set.has(r.companyId));
  const benchmark={...aggregateRows(benchmarkRows,days.length*memberIds.length),companyCount:memberIds.length,includingOwner:memberIds.includes(owner.id),reviewedCompanies:companies.filter(c=>c.capacity?.reviewed).length,change:changeRows(benchmarkRows,before.filter(r=>set.has(r.companyId))),priceValues:undefined};
  const selection={runId:run.id,previousRunId:previous?.id||null,start,end,dayFilter,cohort:options.cohort==='run'?'run':'latest',days:days.length,observedAt:run.observedAt,previousObservedAt:previous?.observedAt||null,observationGapDays:previous?(Date.parse(run.observedAt)-Date.parse(previous.observedAt))/864e5:null};
  const daily=days.map(date=>({date,owner:aggregateRows(current.filter(r=>r.companyId===owner.id&&r.date===date),1),benchmark:aggregateRows(benchmarkRows.filter(r=>r.date===date),memberIds.length)}));
  const cards=decisionCards(owner,benchmark,selection);
  return {selection,owner,benchmark,companies,daily,changes:{owner:owner.change,benchmark:benchmark.change},cards,quality:{archiveDate:snapshot.meta.archiveDirectoryDate,missingCompanyDays:benchmark.expectedDays-benchmark.coveredDays,unreviewedCompanies:memberIds.length-benchmark.reviewedCompanies,liveConnected:false,collectionEnabled:false,legacyRows:current.filter(r=>r.quantityStatus==='legacy_unverified').length}};
}
