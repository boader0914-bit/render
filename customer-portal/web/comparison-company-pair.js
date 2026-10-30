(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightComparisonCompanyPair=api;
})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  // Pure projection of the customer's already validated dashboard. No source
  // lookup, cache, collection, policy changes or guessed missing quantities.
  const VERSION='customer-company-pair-v1',DAY=86400000;
  const REASONS=Object.freeze({
    CONTEXT_MISMATCH:'선택한 고객·매장·경쟁업체·기간의 자료가 일치하지 않습니다.',
    QUANTITY_UNAVAILABLE:'객실 기준 또는 날짜별 예약수량이 미확인입니다.',
    DUPLICATE_QUANTITY:'같은 숙박일의 예약수량 근거가 서로 달라 제외했습니다.',
    PRICE_UNAVAILABLE:'이 숙박일의 검증된 상품가격이 없습니다.',
    PRICE_DUPLICATE_CONFLICT:'같은 상품·숙박일의 가격 근거가 서로 달라 제외했습니다.',
    PRICE_SOURCE_UNAVAILABLE:'상품가격의 수집번호·관측 시각을 확인하지 못했습니다.',
    PICKUP_UNAVAILABLE:'이 숙박일의 검증된 공개예약 증감이 없습니다.',
    PICKUP_DUPLICATE_CONFLICT:'같은 숙박일의 공개예약 증감 근거가 서로 달라 제외했습니다.',
    PICKUP_SOURCE_UNAVAILABLE:'공개예약 증감의 이전·현재 관측 근거를 확인하지 못했습니다.',
    NO_COMMON_QUANTITY_DATES:'두 업체가 함께 확인된 예약수량 날짜가 없습니다.',
    NO_COMMON_PRICE_DATES:'두 업체가 함께 확인된 상품가격 날짜가 없습니다.',
    NO_COMMON_PICKUP_DATES:'두 업체가 함께 확인된 공개예약 증감 날짜가 없습니다.',
    OBSERVATION_TIME_MISMATCH:'같은 숙박일이어도 업체별 관측 시각이 달라 나란히 참고합니다.',
    OBSERVATION_TIME_UNKNOWN:'예약수량의 관측 시각이 미확인이라 나란히 참고합니다.',
    PICKUP_INTERVAL_MISMATCH:'공개예약 증감의 이전·현재 관측 구간이 달라 비교 합산을 보류합니다.',
    PRICE_CONDITIONS_DIFFER:'상품 구성·인원·포함 혜택이 다를 수 있어 표시가격을 참고로 비교합니다.',
    DIFFERENT_REGION:'다른 지역의 숙소이며 지역 수요 차이를 보정하지 않은 참고 비교입니다.',
    DIFFERENT_INDUSTRY:'업종 구성이 다르거나 미확인이라 참고 비교로 표시합니다.',
    REFERENCE_ONLY:'같은 선택 기간·요일의 저장 자료 참고이며 가격 우열·순위·자동 행동을 결정하지 않습니다.',
    AGGREGATE_ONLY:'저장된 합계 근거만 있으며 날짜별 값으로 나누거나 공통일 비교에 사용하지 않습니다.'
  });
  const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const arr=v=>Array.isArray(v)?v:[];
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const count=v=>Number.isSafeInteger(v)&&v>=0;
  const signed=v=>Number.isSafeInteger(v);
  const ratio=v=>finite(v)&&v>=0&&v<=1;
  const text=(v,max=1000)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
  const label=(v,fallback='')=>text(v)?v:fallback;
  const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(v);
  const sha=v=>typeof v==='string'&&/^[a-fA-F0-9]{64}$/.test(v);
  const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
  const instant=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(v)&&date(v.slice(0,10))&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
  const kst=v=>new Date(v+9*3600000).toISOString().slice(0,10);
  const stamp=v=>instant(v)===null?null:new Date(instant(v)).toISOString();
  const unique=values=>[...new Set(values)];
  const issues=codes=>unique(codes).map(code=>({code,label:REASONS[code]||REASONS.REFERENCE_ONLY}));
  const sum=values=>{if(!values.length||values.some(v=>!signed(v)))return null;const value=values.reduce((total,row)=>total+row,0);return signed(value)?value:null;};
  const median=values=>{if(!values.length||values.some(value=>!finite(value)||value<0))return null;const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]:sorted[mid-1]/2+sorted[mid]/2;};
  const allowedDay=(value,filter)=>{const day=new Date(value+'T00:00:00Z').getUTCDay();return filter==='all'||filter==='weekday'&&day>=1&&day<=4||filter==='friday'&&day===5||filter==='saturday'&&day===6||filter==='sunday'&&day===0;};
  function scope(model,selectedCompanyId){
    if(model?.contextValid!==true||!id(selectedCompanyId)||!object(model.own)||!id(model.own.companyId)||!Array.isArray(model.companies)||!Array.isArray(model.dates)||model.dates.length>3660)return null;
    const ids=model.companies.map(row=>row?.companyId);
    if(ids.some(value=>!id(value))||unique(ids).length!==ids.length)return null;
    const own=model.companies.find(row=>row.companyId===model.own.companyId),competitor=model.companies.find(row=>row.companyId===selectedCompanyId);
    if(!own||own.kind!=='own'||!competitor||competitor.kind!=='competitor'||competitor.companyId===own.companyId)return null;
    const p=model.period||{},source=model.sourcePeriod||{},asOf=p.asOf||source.asOf,filter=model.filters?.dayFilter||'all';
    if(!date(p.start)||!date(p.end)||p.start>p.end||!date(asOf)||!date(source.start)||!date(source.end)||source.start>source.end
      ||p.start<source.start||p.end>source.end||source.asOf!==undefined&&source.asOf!==asOf||!['all','weekday','friday','saturday','sunday'].includes(filter)
      ||model.filters?.start!==undefined&&model.filters.start!==p.start||model.filters?.end!==undefined&&model.filters.end!==p.end
      ||!count(p.days)||p.days!==model.dates.length||(Date.parse(p.end)-Date.parse(p.start))/DAY>=3660)return null;
    const expected=Array.from({length:(Date.parse(p.end)-Date.parse(p.start))/DAY+1},(_,i)=>new Date(Date.parse(p.start+'T00:00:00Z')+i*DAY).toISOString().slice(0,10)).filter(value=>allowedDay(value,filter));
    if(JSON.stringify(expected)!==JSON.stringify(model.dates))return null;
    if(model.own.kind!==undefined&&model.own.kind!=='own')return null;
    if(model.own.rooms!==undefined&&model.own.rooms!==own.rooms)return null;
    return {own,competitor,period:{start:p.start,end:p.end,asOf,days:expected.length,dayFilter:filter},dates:expected};
  }
  function sourceProof(metric,kind,asOf){
    const value=metric||{},source=value.source||{},out={};
    if(kind==='price'){
      const at=instant(source.collectedAt);
      if(!['ready','partial'].includes(value.status)||!id(source.runId)||at===null||kst(at)>asOf)return null;
      out.runId=source.runId;out.collectedAt=new Date(at).toISOString();
    }else{
      const before=instant(source.previousObservedAt),current=instant(source.currentObservedAt);
      if(value.status!=='reference'||!text(source.calculationVersion,180)||before===null||current===null||before>=current||kst(current)>asOf)return null;
      out.calculationVersion=source.calculationVersion;out.previousObservedAt=new Date(before).toISOString();out.currentObservedAt=new Date(current).toISOString();
      if(source.calculationVersion==='public-booking-pickup-v1'){
        if(!id(source.previousRunId)||!id(source.currentRunId)||source.previousRunId===source.currentRunId||!sha(source.sourceDigests?.previous)||!sha(source.sourceDigests?.current)||source.ledgerDigest!==undefined&&!sha(source.ledgerDigest))return null;
        out.previousRunId=source.previousRunId;out.currentRunId=source.currentRunId;out.sourceDigests={previous:source.sourceDigests.previous.toLowerCase(),current:source.sourceDigests.current.toLowerCase()};
        if(source.ledgerDigest)out.ledgerDigest=source.ledgerDigest.toLowerCase();
      }
    }
    return {status:value.status,source:out,reasonCode:label(value.reasonCode),reason:label(value.reason),limitations:arr(value.limitations).filter(row=>text(row)).slice(0,100)};
  }
  function reservationMap(company,dates,asOf){
    const rows=new Map(),conflicts=new Set();
    for(const row of arr(company.points)){
      if(!object(row)||!dates.has(row.date))continue;
      const rate=row.rate===undefined?row.reservationRate:row.rate,rateConflict=row.rate!==undefined&&row.reservationRate!==undefined&&row.rate!==row.reservationRate;
      const value={status:row.status,sold:row.sold,supply:row.supply,publicBookings:row.publicBookings,phoneBookings:row.phoneBookings,rate,rateConflict,collectedAt:row.collectedAt??null,collectedDate:row.collectedDate??null};
      if(conflicts.has(row.date))continue;
      if(rows.has(row.date)&&JSON.stringify(rows.get(row.date))!==JSON.stringify(value)){rows.delete(row.date);conflicts.add(row.date);}
      else rows.set(row.date,value);
    }
    const valid=new Map();
    for(const [day,row] of rows){
      const at=instant(row.collectedAt),observed=row.collectedDate|| (at!==null?kst(at):null);
      if(row.status!=='ready'||row.rateConflict||company.capacity?.conflict===true||!count(company.rooms)||company.rooms<1||!count(row.supply)||row.supply!==company.rooms||row.supply<1
        ||![row.sold,row.publicBookings,row.phoneBookings].every(count)||row.sold!==row.publicBookings+row.phoneBookings||row.sold>row.supply||!ratio(row.rate)
        ||Math.abs(row.rate-row.sold/row.supply)>1e-10||!date(observed)||observed>asOf||observed>day
        ||row.collectedAt!==null&&(at===null||kst(at)!==observed))continue;
      valid.set(day,{rate:row.rate,sold:row.sold,supply:row.supply,publicBookings:row.publicBookings,phoneBookings:row.phoneBookings,collectedAt:at!==null?new Date(at).toISOString():null,collectedDate:observed});
    }
    return {valid,conflicts};
  }
  function priceMap(company,dates,asOf){
    const metric=company.savedMetrics?.price,proof=sourceProof(metric,'price',asOf),rows=new Map(),conflicts=new Set();
    if(!proof)return {valid:new Map(),conflicts,proof:null};
    const observed=kst(instant(proof.source.collectedAt));
    for(const row of arr(metric.rows)){
      if(!object(row)||!dates.has(row.date)||!text(row.productId,180))continue;
      const key=row.date+'\u0000'+row.productId,value={productId:row.productId,productName:label(row.productName,'숙박상품'),price:row.price};
      if(!finite(row.price)||row.price<0||observed>row.date){rows.delete(key);conflicts.add(key);continue;}
      if(conflicts.has(key))continue;
      if(rows.has(key)&&JSON.stringify(rows.get(key))!==JSON.stringify(value)){rows.delete(key);conflicts.add(key);}else rows.set(key,value);
    }
    const valid=new Map();
    for(const [key,row] of rows){const day=key.split('\u0000')[0],list=valid.get(day)||[];list.push(row);valid.set(day,list);}
    for(const list of valid.values())list.sort((a,b)=>a.productId.localeCompare(b.productId));
    const all=[...valid.values()].flat();
    proof.value=all.length?median(all.map(row=>row.price)):!arr(metric.rows).length&&finite(metric.value)&&metric.value>=0?metric.value:null;
    proof.days=valid.size;proof.aggregateOnly=!all.length&&proof.value!==null;
    if(proof.aggregateOnly)proof.limitations=[...proof.limitations,REASONS.AGGREGATE_ONLY];
    return {valid,conflicts,proof};
  }
  function pickupMap(company,dates,asOf){
    const metric=company.savedMetrics?.pickup,proof=sourceProof(metric,'pickup',asOf),valid=new Map(),conflicts=new Set();
    if(!proof)return {valid,conflicts,proof:null};
    const before=proof.source.previousObservedAt,current=proof.source.currentObservedAt,isPublic=proof.source.calculationVersion==='public-booking-pickup-v1';
    for(const row of arr(metric.rows)){
      if(!object(row)||!dates.has(row.date))continue;
      let accepted=signed(row.publicChange)&&kst(instant(current))<=row.date&&kst(instant(before))<=row.date;
      if(row.previousCollectedAt!==undefined&&stamp(row.previousCollectedAt)!==before||row.collectedAt!==undefined&&stamp(row.collectedAt)!==current)accepted=false;
      if(isPublic){
        accepted=accepted&&count(row.previousPublic)&&count(row.currentPublic)&&row.publicChange===row.currentPublic-row.previousPublic&&count(row.productCount)&&row.productCount>0&&row.productCount<=10000
          &&Array.isArray(row.matchedProductIds)&&row.matchedProductIds.length===row.productCount&&row.matchedProductIds.every(value=>text(value,180))&&unique(row.matchedProductIds).length===row.productCount;
      }else accepted=accepted&&signed(row.blockedChange)&&signed(row.netChange)&&row.netChange===row.publicChange+row.blockedChange;
      if(!accepted){valid.delete(row.date);conflicts.add(row.date);continue;}
      if(conflicts.has(row.date))continue;
      const value={publicChange:row.publicChange,previousPublic:isPublic?row.previousPublic:null,currentPublic:isPublic?row.currentPublic:null,
        previousObservedAt:before,currentObservedAt:current,...(isPublic?{productCount:row.productCount,matchedProductIds:[...row.matchedProductIds].sort()}:{} )};
      if(valid.has(row.date)&&JSON.stringify(valid.get(row.date))!==JSON.stringify(value)){valid.delete(row.date);conflicts.add(row.date);}else valid.set(row.date,value);
    }
    proof.value=valid.size?sum([...valid.values()].map(row=>row.publicChange)):!arr(metric.rows).length&&signed(metric.value)?metric.value:null;
    proof.days=valid.size;proof.aggregateOnly=!valid.size&&proof.value!==null;
    if(proof.aggregateOnly)proof.limitations=[...proof.limitations,REASONS.AGGREGATE_ONLY];
    return {valid,conflicts,proof};
  }
  function companyData(company,scope){
    const dates=new Set(scope.dates),quantity=reservationMap(company,dates,scope.period.asOf),price=priceMap(company,dates,scope.period.asOf),pickup=pickupMap(company,dates,scope.period.asOf);
    const rows=new Map();
    for(const day of scope.dates){
      const q=quantity.valid.get(day),prices=price.valid.get(day)||[],change=pickup.valid.get(day),codes=[];
      const priceConflict=[...price.conflicts].some(key=>key.startsWith(day+'\u0000'));
      if(!q)codes.push(quantity.conflicts.has(day)?'DUPLICATE_QUANTITY':'QUANTITY_UNAVAILABLE');
      if(!prices.length)codes.push(!price.proof?'PRICE_SOURCE_UNAVAILABLE':priceConflict?'PRICE_DUPLICATE_CONFLICT':'PRICE_UNAVAILABLE');
      else if(priceConflict)codes.push('PRICE_DUPLICATE_CONFLICT');
      if(!change)codes.push(!pickup.proof?'PICKUP_SOURCE_UNAVAILABLE':pickup.conflicts.has(day)?'PICKUP_DUPLICATE_CONFLICT':'PICKUP_UNAVAILABLE');
      rows.set(day,{rate:q?.rate??null,sold:q?.sold??null,supply:q?.supply??null,publicBookings:q?.publicBookings??null,phoneBookings:q?.phoneBookings??null,collectedAt:q?.collectedAt??null,collectedDate:q?.collectedDate??null,
        price:median(prices.map(row=>row.price)),priceProducts:prices.map(row=>({...row})),priceProductCount:prices.length,priceRowCount:prices.length,
        publicChange:change?.publicChange??null,previousPublic:change?.previousPublic??null,currentPublic:change?.currentPublic??null,
        status:{rate:q?'ready':'unavailable',price:prices.length?priceConflict?'partial':'ready':'unavailable',publicChange:change?'reference':'unavailable'},reasons:issues(codes),
        sourceProof:{reservation:q?{collectedAt:q.collectedAt,collectedDate:q.collectedDate}:null,price:prices.length?{...price.proof.source}:null,pickup:change?{...pickup.proof.source}:null}});
    }
    const capacity=company.capacity||{};
    return {metadata:{companyId:company.companyId,name:label(company.name,company.kind==='own'?'내 매장':'등록 경쟁업체'),kind:company.kind,rooms:count(company.rooms)&&company.rooms>0?company.rooms:null,
      regionLabel:label(company.regionLabel,'지역 미확인'),regionRelation:label(company.regionRelation,'unknown'),industryRelation:label(company.industryRelation,'unknown'),
      capacity:{count:count(company.rooms)&&company.rooms>0?company.rooms:null,label:label(capacity.label),reviewRequired:capacity.reviewRequired===true,conflict:capacity.conflict===true},
      sourceProof:{price:price.proof,pickup:pickup.proof},reasons:arr(company.reasons).filter(value=>text(value)).slice(0,100)},rows};
  }
  function metric(status,code,dates,own=null,competitor=null,extra={}){
    return {own,competitor,commonDays:dates.length,dates:[...dates],status,reasonCode:code,reason:REASONS[code]||REASONS.REFERENCE_ONLY,reasonCodes:[code],limits:[REASONS.REFERENCE_ONLY],gapPp:null,actionable:false,executionAllowed:false,...extra};
  }
  function summarize(rows,own,competitor){
    const quantity=rows.filter(row=>ratio(row.own.rate)&&ratio(row.competitor.rate)),quantityDates=quantity.map(row=>row.date);
    let rateMetric;
    if(!quantity.length)rateMetric=metric('unavailable','NO_COMMON_QUANTITY_DATES',[]);
    else{
      const ownSold=sum(quantity.map(row=>row.own.sold)),ownSupply=sum(quantity.map(row=>row.own.supply)),peerSold=sum(quantity.map(row=>row.competitor.sold)),peerSupply=sum(quantity.map(row=>row.competitor.supply));
      const unknown=quantity.some(row=>!row.own.collectedAt||!row.competitor.collectedAt),different=quantity.some(row=>row.own.collectedAt!==row.competitor.collectedAt);
      const code=unknown?'OBSERVATION_TIME_UNKNOWN':different?'OBSERVATION_TIME_MISMATCH':'REFERENCE_ONLY';
      rateMetric=metric('reference',code,quantityDates,ownSupply>0&&ownSold!==null?ownSold/ownSupply:null,peerSupply>0&&peerSold!==null?peerSold/peerSupply:null,
        {ownSold,ownSupply,competitorSold:peerSold,competitorSupply:peerSupply,sameObservationTime:!unknown&&!different});
    }
    const prices=rows.filter(row=>finite(row.own.price)&&finite(row.competitor.price)),priceDates=prices.map(row=>row.date),ownPrices=prices.flatMap(row=>row.own.priceProducts),peerPrices=prices.flatMap(row=>row.competitor.priceProducts);
    const priceMetric=prices.length?metric('reference','PRICE_CONDITIONS_DIFFER',priceDates,median(ownPrices.map(row=>row.price)),median(peerPrices.map(row=>row.price)),
      {ownProducts:unique(ownPrices.map(row=>row.productId)).length,ownRows:ownPrices.length,competitorProducts:unique(peerPrices.map(row=>row.productId)).length,competitorRows:peerPrices.length,
        ownSource:own.sourceProof.price?.source||null,competitorSource:competitor.sourceProof.price?.source||null}):metric('unavailable','NO_COMMON_PRICE_DATES',[]);
    const changes=rows.filter(row=>signed(row.own.publicChange)&&signed(row.competitor.publicChange)),changeDates=changes.map(row=>row.date),a=own.sourceProof.pickup?.source,b=competitor.sourceProof.pickup?.source;
    const samePair=!!a&&!!b&&a.previousObservedAt===b.previousObservedAt&&a.currentObservedAt===b.currentObservedAt;
    let pickupMetric;
    if(!changes.length)pickupMetric=metric('unavailable','NO_COMMON_PICKUP_DATES',[],null,null,{ownSource:a||null,competitorSource:b||null,sameObservationPair:false});
    else if(!samePair)pickupMetric=metric('hold','PICKUP_INTERVAL_MISMATCH',changeDates,null,null,{ownSource:a||null,competitorSource:b||null,sameObservationPair:false});
    else pickupMetric=metric('reference','REFERENCE_ONLY',changeDates,sum(changes.map(row=>row.own.publicChange)),sum(changes.map(row=>row.competitor.publicChange)),
      {ownPreviousPublic:sum(changes.map(row=>row.own.previousPublic)),ownCurrentPublic:sum(changes.map(row=>row.own.currentPublic)),competitorPreviousPublic:sum(changes.map(row=>row.competitor.previousPublic)),competitorCurrentPublic:sum(changes.map(row=>row.competitor.currentPublic)),ownSource:a,competitorSource:b,sameObservationPair:true});
    return {rate:rateMetric,price:priceMetric,publicChange:pickupMetric};
  }
  function empty(){
    return {version:VERSION,contextValid:false,status:'unavailable',own:null,competitor:null,period:null,dates:[],rows:[],metrics:{rate:metric('unavailable','CONTEXT_MISMATCH',[]),price:metric('unavailable','CONTEXT_MISMATCH',[]),publicChange:metric('unavailable','CONTEXT_MISMATCH',[])},reasonCode:'CONTEXT_MISMATCH',reason:REASONS.CONTEXT_MISMATCH,actionable:false,executionAllowed:false};
  }
  function project(model,selectedCompanyId){
    const selected=scope(model,selectedCompanyId);if(!selected)return empty();
    const own=companyData(selected.own,selected),competitor=companyData(selected.competitor,selected),rows=selected.dates.map(date=>({date,own:own.rows.get(date),competitor:competitor.rows.get(date)}));
    const metrics=summarize(rows,own.metadata,competitor.metadata),limits=[REASONS.REFERENCE_ONLY];
    if(competitor.metadata.regionRelation==='cross')limits.push(REASONS.DIFFERENT_REGION);
    if(!['common','same'].includes(competitor.metadata.industryRelation))limits.push(REASONS.DIFFERENT_INDUSTRY);
    for(const value of Object.values(metrics))value.limits=unique([...value.limits,...limits]);
    return {version:VERSION,contextValid:true,status:Object.values(metrics).every(value=>value.status==='unavailable')?'unavailable':'reference',own:own.metadata,competitor:competitor.metadata,period:selected.period,dates:[...selected.dates],rows,metrics,
      reasonCode:'REFERENCE_ONLY',reason:REASONS.REFERENCE_ONLY,limits,actionable:false,executionAllowed:false};
  }
  return Object.freeze({VERSION,REASONS,project,buildPair:project});
});
