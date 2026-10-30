'use strict';
// Read-only presentation policy. Reservation/revenue values are accepted from
// the central integration result; this module never repairs inventory or prices.
const RULES_VERSION='insight-comparison-v1';
const DAY=86400000,KST=9*3600000;
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const key=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=200?v:null;
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const capacity=v=>count(v)!==null&&v>0;
const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v?v:null;
const shift=(v,n)=>new Date(Date.parse(v+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const instant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const observationDay=row=>{const at=instant(row?.collectedAt);return at===null?date(row?.collectedDate):new Date(at+KST).toISOString().slice(0,10);};
const MISSING_REASONS=new Set(['partial_inventory','shared_dayuse_unverified','missing_response','run_blocked','run_failed','run_interrupted','run_unknown','legacy_inventory_evidence','post_stay_observation','capacity_recalculation_unavailable','quantity_conflict','inventory_conflict','rate_unavailable']);
function projectObservationDisplayEvidence(source,{companyId,stayDate,asOf,ready=false,conflict=false}={}) {
  const timestamp=instant(source?.latestAttemptAt),attemptDay=timestamp===null?null:observationDay({collectedAt:source.latestAttemptAt});
  const attemptValid=attemptDay&&attemptDay<=asOf&&attemptDay<=stayDate;
  const latestAttemptAt=attemptValid?new Date(timestamp).toISOString():null;
  const latestAttemptStatus=attemptValid&&['selected','not_selected','excluded'].includes(source?.latestAttemptStatus)?source.latestAttemptStatus:null;
  const latestAttemptReason=attemptValid&&MISSING_REASONS.has(source?.latestAttemptReason)?source.latestAttemptReason:null;
  const candidate=source?.partialRevenueEvidence,amount=num(source?.partialConfirmedRevenue),at=instant(candidate?.collectedAt),observed=at===null?null:observationDay(candidate);
  const partialRevenueEvidence=!ready&&!conflict&&source?.missing===true&&!source.inventoryConflict&&!source.capacityConflict
    &&amount!==null&&amount>=0&&num(source.knownPartialRevenue)===amount&&candidate?.amount===amount
    &&candidate.companyId===companyId&&candidate.date===stayDate&&candidate.productType==='lodging'
    &&typeof candidate.runId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(candidate.runId)
    &&observed&&candidate.collectedDate===observed&&observed<=asOf&&observed<=stayDate
    &&['partial_inventory','capacity_recalculation_unavailable'].includes(candidate.reason)
    ?{companyId,runId:candidate.runId,date:stayDate,productType:'lodging',collectedAt:new Date(at).toISOString(),collectedDate:observed,reason:candidate.reason,amount}:null;
  return {missingReason:ready?null:MISSING_REASONS.has(source?.missingReason)?source.missingReason:latestAttemptReason||partialRevenueEvidence?.reason||null,
    latestAttemptAt,latestAttemptStatus,latestAttemptReason,partialConfirmedRevenue:partialRevenueEvidence?.amount??null,partialRevenueEvidence};
}
function projectUniqueObservationDisplayEvidence(sources,context) {
  const projected=(Array.isArray(sources)?sources:[]).map(source=>projectObservationDisplayEvidence(source,context));
  return projected.length&&projected.every(row=>JSON.stringify(row)===JSON.stringify(projected[0]))?projected[0]:projectObservationDisplayEvidence(null,context);
}
const REASONS=Object.freeze({
  DUPLICATE_COMPANY:'같은 업체는 비교 대상에서 한 번만 사용합니다.',
  DUPLICATE_STAY_DATE:'같은 숙박일에 서로 다른 선택 결과가 있어 중앙 통합 자료 확인이 필요합니다.',
  INVALID_COMPANY:'업체 고유 번호를 확인할 수 없습니다.',
  INVALID_PERIOD:'숙박기간 또는 관측 기준일을 확인해야 합니다.',
  REGION_UNKNOWN:'공식 지역 연결을 확인해야 합니다.',
  REGION_DIFFERENT:'서로 다른 지역의 수요 배경을 함께 확인해야 합니다.',
  INDUSTRY_UNKNOWN:'업종 연결을 확인해야 합니다.',
  INDUSTRY_DIFFERENT:'공통 업종이 없어 상품·운영 참고로 표시합니다.',
  PURPOSE_UNSPECIFIED:'비교 목적이 선택되지 않아 참고로 표시합니다.',
  REFERENCE_PURPOSE:'운영·상품 참고 대상으로 선택했습니다.',
  CAPACITY_UNKNOWN:'객실 기준을 확인할 수 없어 예약률 판단을 보류합니다.',
  CAPACITY_CONFLICT:'객실 기준 충돌이 있어 예약률 판단을 보류합니다.',
  CAPACITY_REVIEW_REQUIRED:'객실 기준의 검토가 필요해 자동 행동 판단을 보류합니다.',
  QUANTITY_MISSING:'수량을 확인하지 못한 날짜가 있습니다.',
  QUANTITY_INVALID:'수량 오류 또는 공개 예약·타채널 추정의 합계 불일치가 있습니다.',
  REVENUE_UNKNOWN:'가격 또는 금액을 확인하지 못한 날짜가 있습니다.',
  OBSERVATION_UNKNOWN:'관측일을 확인하지 못한 날짜가 있습니다.',
  OBSERVATION_AFTER_CUTOFF:'관측 마감일 뒤의 자료는 이번 비교에 사용하지 않습니다.',
  OBSERVATION_STALE:'현재 브리핑의 최근 관측 범위를 벗어난 날짜가 있습니다.',
  OBSERVATION_DAY_DIFFERENT:'같은 숙박일이라도 관측일이 달라 수치 참고로만 제공합니다.',
  OBSERVATION_TIME_UNKNOWN:'관측 시각이 없어 자동 행동 판단을 보류합니다.',
  OBSERVATION_TIME_POLICY_UNSET:'허용 관측 시차 정책이 확정되지 않아 자동 행동 판단을 보류합니다.',
  OBSERVATION_SKEW_EXCEEDED:'관측 시각 차이가 허용 범위를 넘어 자동 행동 판단을 보류합니다.',
  INSUFFICIENT_COMMON_DAYS:'비교 가능한 공통 숙박일이 7일 미만입니다.',
  RELATION_UNCONFIRMED:'내 매장 연결 확인이 완료되지 않았습니다.'
});
const reason=(code,scope='action')=>({code,scope,reason:REASONS[code]});
function classifyRegion(own,other,{regionHierarchy={}}={}) {
  const a=key(own?.regionKey),b=key(other?.regionKey);
  // The caller may supply the existing official general-district -> analysis-city
  // mapping. No province/address/name prefix inference is allowed here.
  const mapped=value=>value&&(Object.hasOwn(regionHierarchy,value)?key(regionHierarchy[value]):value);
  const left=mapped(a),right=mapped(b);
  return {relation:left&&right?left===right?'same':'cross':'unknown',ownRegionKey:a,competitorRegionKey:b,
    ownAnalysisRegionKey:left,competitorAnalysisRegionKey:right,hierarchyApplied:a!==left||b!==right};
}
function industryKeys(company) {
  const values=Array.isArray(company?.industryTags)?company.industryTags:Array.isArray(company?.industryKeys)?company.industryKeys:[];
  return [...new Set(values.map(key).filter(Boolean))].sort();
}
function classifyIndustry(own,other) {
  const left=industryKeys(own),right=industryKeys(other),shared=left.filter(v=>right.includes(v));
  return {relation:!left.length||!right.length?'unknown':shared.length?'common':'mixed',ownIndustryKeys:left,competitorIndustryKeys:right,sharedIndustryKeys:shared,
    composite:left.length>1||right.length>1};
}
function quantityCodes(row,company) {
  if(!row||row.missing===true||row.quantityMissing===true)return ['QUANTITY_MISSING'];
  if(row.quantityPartial===true||row.partial===true&&row.revenuePartial!==true&&row.inventoryConflict!==true&&row.capacityConflict!==true)return ['QUANTITY_INVALID'];
  const sold=num(row.sold),pub=num(row.publicBookings),blocked=num(row.phoneBookings);
  if([sold,pub,blocked].some(v=>count(v)===null)||pub+blocked!==sold)return ['QUANTITY_INVALID'];
  return [];
}
function rateCodes(row,company) {
  if(!capacity(company?.rooms)||!capacity(row?.total))return ['CAPACITY_UNKNOWN'];
  if(row.inventoryConflict===true||row.capacityConflict===true||company.inventoryConflict===true||company.capacityConflict===true||company.capacityStatus==='conflict'||Math.abs(company.rooms-row.total)>.001||row.sold>row.total)return ['CAPACITY_CONFLICT'];
  return [];
}
function validQuantityDay(row,company) {return quantityCodes(row,company).length===0;}
function summarizeDays(rows,{capacityKnown=true}={}) {
  const sum=field=>rows.length&&rows.every(r=>num(r[field])!==null)?rows.reduce((a,r)=>a+r[field],0):null;
  const supply=sum('total'),sold=sum('sold'),priceAvailable=rows.filter(r=>num(r.estimatedRevenue)!==null&&r.estimatedRevenue>=0);
  const priceUnknown=rows.filter(r=>r.revenuePartial===true||!priceAvailable.includes(r));
  const completePrices=priceAvailable.filter(r=>r.revenuePartial!==true),partialPrices=priceAvailable.filter(r=>r.revenuePartial===true);
  return {days:rows.length,supply,sold,reservationRate:capacityKnown&&supply>0?sold/supply:null,
    publicBookings:sum('publicBookings'),phoneBookings:sum('phoneBookings'),
    estimatedRevenue:priceUnknown.length?null:sum('estimatedRevenue'),
    knownRevenueSubtotal:priceAvailable.length?priceAvailable.reduce((a,r)=>a+r.estimatedRevenue,0):null,
    completeRevenueSubtotal:completePrices.length?completePrices.reduce((a,r)=>a+r.estimatedRevenue,0):null,
    partialKnownRevenueSubtotal:partialPrices.length?partialPrices.reduce((a,r)=>a+r.estimatedRevenue,0):null,
    // Central knownPartialRevenue is explicitly separate from normal estimated
    // revenue. Keep it separate here too; never add it twice to known subtotal.
    separatePartialRevenueSubtotal:rows.some(r=>num(r.knownPartialRevenue)!==null)?rows.reduce((a,r)=>a+(num(r.knownPartialRevenue)||0),0):null,
    revenueUnknownDays:priceUnknown.map(r=>r.date),revenueUnknownRooms:priceUnknown.length?priceUnknown.every(r=>count(r.revenueUnknownRooms)!==null&&r.revenueUnknownRooms<=r.sold)?priceUnknown.reduce((a,r)=>a+r.revenueUnknownRooms,0):null:0,
    knownMissingPhonePriceRooms:priceUnknown.length?priceUnknown.every(r=>count(r.phoneMissingPriceBookings)!==null&&r.phoneMissingPriceBookings<=r.phoneBookings)?priceUnknown.reduce((a,r)=>a+r.phoneMissingPriceBookings,0):null:0};
}
function optionsFor(input={}) {
  const asOf=date(input.asOf??input.today),mode=input.mode??'current',explicitPeriod=input.period!==undefined;
  const start=explicitPeriod?date(input.period?.start):mode==='current'?asOf:null,end=explicitPeriod?date(input.period?.end):mode==='current'&&asOf?shift(asOf,29):null;
  const policy=input.observationPolicy;
  return {...input,asOf,mode,period:{start,end},valid:Boolean(['current','historical'].includes(mode)&&asOf&&start&&end&&start<=end),
    minCommonDays:Math.max(7,Number.isInteger(input.minCommonDays)?input.minCommonDays:7),freshnessDays:Math.max(0,Number.isInteger(input.freshnessDays)?input.freshnessDays:7),
    observationPolicy:policy?.confirmed===true&&num(policy.maxSkewMs)!==null&&policy.maxSkewMs>=0?{confirmed:true,maxSkewMs:policy.maxSkewMs}:{confirmed:false,maxSkewMs:null}};
}
function selectedRows(company,options) {
  const result=new Map(),excluded=[],duplicates=[],ambiguous=new Set(),seen=new Map();
  if(!options.valid)return {rows:result,excluded,duplicates};
  for(const row of Array.isArray(company?.days)?company.days:[]) {
    if(!date(row?.date)||row.date<options.period.start||row.date>options.period.end)continue;
    const fingerprint=JSON.stringify([row.total,row.sold,row.publicBookings,row.phoneBookings,row.estimatedRevenue,row.revenuePartial===true,row.missing===true,row.partial===true,row.inventoryConflict===true,row.capacityConflict===true,row.quantityPartial===true,row.quantityMissing===true,row.collectedAt,row.collectedDate,row.knownPartialRevenue,row.revenueUnknownRooms,row.phoneMissingPriceBookings]);
    if(seen.has(row.date)) {
      duplicates.push(row.date);
      if(seen.get(row.date)!==fingerprint) {
        result.delete(row.date);
        if(!ambiguous.has(row.date))excluded.push({date:row.date,codes:['DUPLICATE_STAY_DATE']});
        ambiguous.add(row.date);
      }
      // Central integration owns selecting the observation. Exact repeated
      // projections are deduplicated; conflicting projections are never merged
      // or independently resolved by this customer-facing comparison policy.
      continue;
    }
    seen.set(row.date,fingerprint);
    const codes=quantityCodes(row,company),observed=observationDay(row);
    if(!observed)codes.push('OBSERVATION_UNKNOWN');
    else if(observed>options.asOf)codes.push('OBSERVATION_AFTER_CUTOFF');
    else if(options.mode==='current'&&observed<shift(options.asOf,-options.freshnessDays))codes.push('OBSERVATION_STALE');
    if(codes.length){excluded.push({date:row.date,codes:[...new Set(codes)]});continue;}
    result.set(row.date,row);
  }
  return {rows:result,excluded,duplicates:[...new Set(duplicates)]};
}
function evaluateComparison(own,other,input={}) {
  const options=optionsFor(input),region=classifyRegion(own,other,options),industry=classifyIndustry(own,other),reasons=[];
  const add=(code,scope)=>{if(!reasons.some(r=>r.code===code&&r.scope===(scope||'action')))reasons.push(reason(code,scope));};
  const candidatePurpose=input.purpose||other?.comparisonPurpose,requestedPurpose=candidatePurpose==='direct'||candidatePurpose==='reference'?candidatePurpose:null,purpose=requestedPurpose==='direct'?'direct':'reference',purposeExplicit=requestedPurpose!==null;
  const ownId=key(own?.companyId),otherId=key(other?.companyId),duplicate=Boolean(ownId&&ownId===otherId);
  if(!options.valid)add('INVALID_PERIOD','quantity');
  if(!ownId||!otherId)add('INVALID_COMPANY','quantity');
  if(duplicate)add('DUPLICATE_COMPANY','quantity');
  if(region.relation==='unknown')add('REGION_UNKNOWN');
  if(region.relation==='cross')add('REGION_DIFFERENT');
  if(industry.relation==='unknown')add('INDUSTRY_UNKNOWN');
  if(industry.relation==='mixed')add('INDUSTRY_DIFFERENT');
  if(!purposeExplicit)add('PURPOSE_UNSPECIFIED');else if(purpose==='reference')add('REFERENCE_PURPOSE');
  let capacityKnown=[own,other].every(c=>capacity(c?.rooms)),capacityConflict=[own,other].some(c=>c?.inventoryConflict===true||c?.capacityConflict===true||c?.capacityStatus==='conflict');
  const left=selectedRows(own,options),right=selectedRows(other,options),pairs=[],referenceDates=[];
  for(const [stay,a] of [...left.rows.entries()].sort(([a],[b])=>a.localeCompare(b))) {
    const b=right.rows.get(stay);if(!b)continue;
    if(observationDay(a)!==observationDay(b)){referenceDates.push(stay);add('OBSERVATION_DAY_DIFFERENT');continue;}
    if(!duplicate&&ownId&&otherId)pairs.push([a,b]);
  }
  for(const row of [...left.excluded,...right.excluded])for(const code of row.codes)add(code,code.startsWith('OBSERVATION_')?'timing':'quantity');
  const rateIssues=pairs.flatMap(([a,b])=>[{date:a.date,side:'own',codes:rateCodes(a,own)},{date:b.date,side:'competitor',codes:rateCodes(b,other)}]).filter(r=>r.codes.length);
  capacityKnown=capacityKnown&&!rateIssues.some(r=>r.codes.includes('CAPACITY_UNKNOWN'));
  capacityConflict=capacityConflict||rateIssues.some(r=>r.codes.includes('CAPACITY_CONFLICT'));
  if(!capacityKnown)add('CAPACITY_UNKNOWN','reservationRate');
  if(capacityConflict)add('CAPACITY_CONFLICT','reservationRate');
  const capacityReviewRequired=[own,other].some(c=>c?.capacityReviewRequired===true||c?.capacityStatus==='review_required');
  if(capacityReviewRequired)add('CAPACITY_REVIEW_REQUIRED');
  const times=pairs.map(([a,b])=>{const left=instant(a.collectedAt),right=instant(b.collectedAt);return {date:a.date,ownObservedAt:left===null?null:a.collectedAt,competitorObservedAt:right===null?null:b.collectedAt,skewMs:left===null||right===null?null:Math.abs(left-right)};});
  const knownSkews=times.map(r=>r.skewMs).filter(v=>v!==null),unknownTimes=times.filter(r=>r.skewMs===null).map(r=>r.date);
  if(unknownTimes.length)add('OBSERVATION_TIME_UNKNOWN');
  if(!options.observationPolicy.confirmed)add('OBSERVATION_TIME_POLICY_UNSET');
  const exceededDates=times.filter(r=>r.skewMs!==null&&options.observationPolicy.confirmed&&r.skewMs>options.observationPolicy.maxSkewMs).map(r=>r.date);
  if(exceededDates.length)add('OBSERVATION_SKEW_EXCEEDED');
  if(pairs.length<options.minCommonDays)add('INSUFFICIENT_COMMON_DAYS','quantity');
  const leftSummary=summarizeDays(pairs.map(p=>p[0]),{capacityKnown:capacityKnown&&!capacityConflict}),rightSummary=summarizeDays(pairs.map(p=>p[1]),{capacityKnown:capacityKnown&&!capacityConflict});
  const priceUnknown=[...new Set([...leftSummary.revenueUnknownDays,...rightSummary.revenueUnknownDays])];
  if(priceUnknown.length)add('REVENUE_UNKNOWN','revenue');
  const quantityComparable=Boolean(options.valid&&!duplicate&&ownId&&otherId&&pairs.length>=options.minCommonDays);
  const comparable=quantityComparable&&capacityKnown&&!capacityConflict;
  const relationConfirmed=own?.relationStatus==='active'||own?.relationStatus==='confirmed';
  if(!relationConfirmed)add('RELATION_UNCONFIRMED');
  const actionable=comparable&&!capacityReviewRequired&&purpose==='direct'&&purposeExplicit&&region.relation==='same'&&industry.relation==='common'&&relationConfirmed&&options.observationPolicy.confirmed&&!unknownTimes.length&&!exceededDates.length;
  const quantityDisplayable=!duplicate&&Boolean(left.rows.size||right.rows.size),displayable=quantityDisplayable;
  return {rulesVersion:RULES_VERSION,companyId:otherId,name:typeof other?.name==='string'?other.name.slice(0,200):'',ownId,
    commonDays:pairs.length,dates:pairs.map(p=>p[0].date),own:leftSummary,competitor:rightSummary,
    gapPp:comparable&&leftSummary.reservationRate!==null&&rightSummary.reservationRate!==null?(leftSummary.reservationRate-rightSummary.reservationRate)*100:null,
    status:duplicate?'excluded':comparable?'comparable':'insufficient',basis:options.mode==='historical'?'same_stay_date_same_kst_observation_day_at_historical_cutoff':'same_stay_date_same_kst_observation_day_within_7_days',
    displayable,comparable,actionable,purpose,requestedPurpose,purposeExplicit,regionRelation:region.relation,industryRelation:industry.relation,region,industry,reasons,
    quality:{quantity:{status:!quantityDisplayable?'unavailable':quantityComparable&&!left.excluded.length&&!right.excluded.length?'ready':'partial',displayable:quantityDisplayable,comparable:quantityComparable,capacityKnown,capacityConflict,capacityReviewRequired,
      ownEligibleDays:left.rows.size,competitorEligibleDays:right.rows.size,commonDays:pairs.length,ownExcludedDates:left.excluded,competitorExcludedDates:right.excluded},
      reservationRate:{status:comparable?'ready':pairs.length?'partial':'unavailable',displayable:comparable,comparable,issues:rateIssues},
      revenue:{status:!pairs.length?'unavailable':priceUnknown.length?'partial':'ready',displayable:displayable&&(leftSummary.knownRevenueSubtotal!==null||rightSummary.knownRevenueSubtotal!==null),comparable:quantityComparable&&!priceUnknown.length,unknownDates:priceUnknown},
      timing:{sameObservationDay:pairs.length>0,referenceOnlyDates:referenceDates,unknownTimeDates:unknownTimes,maximumObservedSkewMs:knownSkews.length?Math.max(...knownSkews):null,exceededDates,policy:options.observationPolicy}},
    basisDetail:{mode:options.mode,asOf:options.asOf,period:options.period,minCommonDays:options.minCommonDays,currentFreshnessDays:options.mode==='current'?options.freshnessDays:null,
      observationTimes:times,duplicateStayDates:{own:left.duplicates,competitor:right.duplicates},source:'central_integrated_observation',regionAdjusted:false,statisticalConfidenceClaim:false},
    reference:{own:summarizeDays([...left.rows.values()],{capacityKnown:capacity(own?.rooms)&&[...left.rows.values()].every(r=>!rateCodes(r,own).length)}),competitor:summarizeDays([...right.rows.values()],{capacityKnown:capacity(other?.rooms)&&[...right.rows.values()].every(r=>!rateCodes(r,other).length)})}};
}
function buildComparisonSet(own,competitors,input={}) {
  const options=optionsFor(input),seen=new Set([key(own?.companyId)].filter(Boolean)),comparisons=[],excluded=[];
  for(const company of Array.isArray(competitors)?competitors:[]) {
    const id=key(company?.companyId);
    if(!id){excluded.push({companyId:null,code:'INVALID_COMPANY'});continue;}
    if(seen.has(id)){excluded.push({companyId:id,code:'DUPLICATE_COMPANY'});continue;}
    seen.add(id);comparisons.push(evaluateComparison(own,company,input));
  }
  const count=field=>comparisons.filter(c=>c.regionRelation===field).length,same=count('same'),cross=count('cross'),unknown=count('unknown');
  return {rulesVersion:RULES_VERSION,ownId:key(own?.companyId),period:options.period,asOf:options.asOf,
    regionMode:same&&cross?'mixed':unknown||!comparisons.length?'unknown':same?'same':'cross',comparisons,excluded,
    summary:{same,cross,unknown,direct:comparisons.filter(c=>c.purpose==='direct').length,reference:comparisons.filter(c=>c.purpose==='reference').length,duplicateExcluded:excluded.filter(c=>c.code==='DUPLICATE_COMPANY').length}};
}
function summarizeCompany(company,input={}) {
  const options=optionsFor(input),selected=selectedRows(company,options),rows=[...selected.rows.values()],capacityKnown=capacity(company?.rooms)&&rows.every(r=>rateCodes(r,company).length===0);
  const dates=rows.map(observationDay).filter(Boolean).sort(),times=rows.map(r=>r.collectedAt).filter(v=>instant(v)!==null).sort((a,b)=>instant(a)-instant(b));
  return {summary:summarizeDays(rows,{capacityKnown}),lastObservedDay:dates.at(-1)||null,lastObservedAt:times.at(-1)||null,
    summaryQuality:{excludedDates:selected.excluded,duplicateStayDates:selected.duplicates,reservationRateAvailable:capacityKnown,period:options.period,asOf:options.asOf}};
}
function projectReservationSeries(company,input={}) {
  const options=optionsFor(input);
  // The connected API currently authorizes only its existing current-30-day
  // briefing. Historical/custom series are deliberately left to a later API.
  if(!options.valid||options.mode!=='current'||options.period.start!==options.asOf||options.period.end!==shift(options.asOf,29))return null;
  const selected=selectedRows(company,options),excluded=new Map(),originals=new Map();
  for(const row of Array.isArray(company?.days)?company.days:[])if(date(row?.date)){const sources=originals.get(row.date)||[];sources.push(row);originals.set(row.date,sources);}
  for(const item of selected.excluded)excluded.set(item.date,[...new Set([...(excluded.get(item.date)||[]),...item.codes])]);
  const points=Array.from({length:30},(_,i)=>{
    const day=shift(options.asOf,i),row=selected.rows.get(day),codes=excluded.get(day)||[];
    if(!row){
      const sources=originals.get(day)||[],source=sources[0],conflict=codes.some(c=>['QUANTITY_INVALID','DUPLICATE_STAY_DATE','CAPACITY_CONFLICT'].includes(c));
      const display=projectUniqueObservationDisplayEvidence(sources,{companyId:key(company?.companyId),stayDate:day,asOf:options.asOf,conflict});
      // Preserve an old normal observation only as a separately dated reference.
      // It remains excluded from current quantities, rates and operating actions.
      const storedReference=source&&codes.length===1&&codes[0]==='OBSERVATION_STALE'&&quantityCodes(source,company).length===0&&rateCodes(source,company).length===0
        ?{source:'stored_normal_observation',date:day,total:source.total,sold:source.sold,publicBookings:source.publicBookings,phoneBookings:source.phoneBookings,
          collectedAt:instant(source.collectedAt)===null?null:new Date(instant(source.collectedAt)).toISOString(),collectedDate:observationDay(source),reservationRate:source.sold/source.total,reason:'OBSERVATION_STALE'}:null;
      return {date:day,total:null,sold:null,publicBookings:null,phoneBookings:null,quantityStatus:codes.some(c=>['QUANTITY_INVALID','DUPLICATE_STAY_DATE'].includes(c))?'conflict':'unknown',codes:codes.length?codes:['QUANTITY_MISSING'],missing:true,inventoryConflict:false,collectedAt:null,collectedDate:null,reservationRate:null,...display,storedReference};
    }
    const rateIssues=rateCodes(row,company),at=instant(row.collectedAt);
    return {date:day,total:capacity(row.total)?row.total:null,sold:row.sold,publicBookings:row.publicBookings,phoneBookings:row.phoneBookings,
      quantityStatus:'ready',codes:rateIssues,missing:false,inventoryConflict:rateIssues.includes('CAPACITY_CONFLICT'),collectedAt:at===null?null:new Date(at).toISOString(),collectedDate:observationDay(row),reservationRate:rateIssues.length?null:row.sold/row.total,
      ...projectUniqueObservationDisplayEvidence(originals.get(day),{companyId:key(company?.companyId),stayDate:day,asOf:options.asOf,ready:true}),storedReference:null};
  });
  return {companyId:key(company?.companyId),period:options.period,asOf:options.asOf,points};
}
module.exports={RULES_VERSION,REASONS,evaluateComparison,buildComparisonSet,classifyRegion,classifyIndustry,validQuantityDay,summarizeDays,summarizeCompany,projectReservationSeries,projectObservationDisplayEvidence,projectUniqueObservationDisplayEvidence};
