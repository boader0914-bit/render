'use strict';
// Account-isolated display projection. Never accepts authentication fields or
// raw day/product records, and never recomputes central reservation estimates.
const {createHash}=require('node:crypto');
const {RULES_VERSION,REASONS}=require('../scripts/lib/insight_comparison.cjs');
const NEW_KEYS=['rulesVersion','ownId','displayable','comparable','actionable','purpose','requestedPurpose','purposeExplicit','regionRelation','industryRelation','region','industry','reasons','quality','basisDetail','reference'];
const EXTENDED_SUMMARY_KEYS=['knownRevenueSubtotal','completeRevenueSubtotal','partialKnownRevenueSubtotal','separatePartialRevenueSubtotal','revenueUnknownDays','revenueUnknownRooms','knownMissingPhonePriceRooms'];
const bad=()=>{throw new TypeError('INVALID_COMPARISON_PROJECTION');};
const value=(condition,input)=>condition?input:bad();
const object=input=>value(input&&typeof input==='object'&&!Array.isArray(input),input);
const own=(input,key)=>Object.hasOwn(input,key);
const text=(input,max=200)=>value(typeof input==='string'&&input.length<=max,input);
const id=input=>value(typeof input==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(input),input);
const labelKey=input=>value(typeof input==='string'&&input.trim()===input&&input.length>0&&input.length<=200,input);
const normalizedRegionKey=input=>typeof input==='string'&&input.trim()===input&&input.length>0&&input.length<=200?input:null;
const bool=input=>value(typeof input==='boolean',input);
const count=input=>value(Number.isSafeInteger(input)&&input>=0,input);
const numeric=input=>value(typeof input==='number'&&Number.isFinite(input),input);
const money=input=>value(typeof input==='number'&&Number.isFinite(input)&&input>=0,input);
const date=input=>value(typeof input==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(input)&&Number.isFinite(Date.parse(input+'T00:00:00Z'))&&new Date(input+'T00:00:00Z').toISOString().slice(0,10)===input,input);
const instant=input=>value(typeof input==='string'&&input.length<=50&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(input)&&Number.isFinite(Date.parse(input)),input);
const nullable=parser=>input=>input===null?null:parser(input);
const oneOf=values=>input=>value(values.includes(input),input);
const array=(parser,max=3660)=>input=>{value(Array.isArray(input)&&input.length<=max,input);return input.map(parser);};
const shape=(input,fields,{optional=false}={})=>{
  object(input);const result={};
  for(const [key,parser] of Object.entries(fields)){
    if(!own(input,key)){if(!optional)bad();continue;}
    result[key]=parser(input[key]);
  }
  return result;
};
const period=input=>{const result=shape(input,{start:date,end:date});value(result.start<=result.end,input);return result;};
const status=oneOf(['ready','partial','unavailable']);
const scope=oneOf(['action','quantity','reservationRate','revenue','timing']);
const code=input=>value(typeof input==='string'&&own(REASONS,input),input);
const reason=input=>{const result=shape(input,{code,scope,reason:v=>text(v,1000)});result.reason=REASONS[result.code];return result;};
const excluded=input=>shape(input,{date,codes:array(code,64)});
const rateIssue=input=>shape(input,{date,side:oneOf(['own','competitor']),codes:array(code,64)});
const observationPolicy=input=>{
  const result=shape(input,{confirmed:bool,maxSkewMs:nullable(money)});
  value(result.confirmed?result.maxSkewMs!==null:result.maxSkewMs===null,input);return result;
};
const summaryShape={days:count,supply:nullable(count),sold:nullable(count),reservationRate:nullable(v=>value(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1,v)),publicBookings:nullable(count),phoneBookings:nullable(count),estimatedRevenue:nullable(money),
  knownRevenueSubtotal:nullable(money),completeRevenueSubtotal:nullable(money),partialKnownRevenueSubtotal:nullable(money),separatePartialRevenueSubtotal:nullable(money),revenueUnknownDays:array(date),revenueUnknownRooms:nullable(count),knownMissingPhonePriceRooms:nullable(count)};
function projectSummary(input,{required=false}={}){
  try{
    const projected=shape(input,summaryShape,{optional:!required});
    if(required){value(projected.revenueUnknownDays.length<=projected.days,input);if(projected.sold!==null&&projected.publicBookings!==null&&projected.phoneBookings!==null)value(projected.sold===projected.publicBookings+projected.phoneBookings,input);}
    return projected;
  }catch{return null;}
}
function projectSummaryQuality(input){
  try{const extended=own(input,'mode'),result=shape(input,{excludedDates:array(excluded),duplicateStayDates:array(date),reservationRateAvailable:bool,period:v=>extended&&v?.start===null&&v?.end===null?{start:null,end:null}:period(v),asOf:date});if(extended)result.mode=oneOf(['historical','current'])(input.mode);value([...result.excludedDates.map(r=>r.date),...result.duplicateStayDates].every(day=>day>=result.period.start&&day<=result.period.end),input);if(result.period.start===null)value(!result.reservationRateAvailable&&!result.excludedDates.length&&!result.duplicateStayDates.length,input);return result;}catch{return null;}
}
const region=input=>{
  const result=shape(input,{relation:oneOf(['same','cross','unknown']),ownRegionKey:nullable(labelKey),competitorRegionKey:nullable(labelKey),ownAnalysisRegionKey:nullable(labelKey),competitorAnalysisRegionKey:nullable(labelKey),hierarchyApplied:bool});
  const relation=result.ownAnalysisRegionKey&&result.competitorAnalysisRegionKey?result.ownAnalysisRegionKey===result.competitorAnalysisRegionKey?'same':'cross':'unknown';
  value(result.relation===relation&&result.hierarchyApplied===(result.ownRegionKey!==result.ownAnalysisRegionKey||result.competitorRegionKey!==result.competitorAnalysisRegionKey),input);
  return result;
};
const industry=input=>{
  const result=shape(input,{relation:oneOf(['common','mixed','unknown']),ownIndustryKeys:array(labelKey,100),competitorIndustryKeys:array(labelKey,100),sharedIndustryKeys:array(labelKey,100),composite:bool});
  const left=result.ownIndustryKeys,right=result.competitorIndustryKeys,shared=left.filter(key=>right.includes(key));
  value(new Set(left).size===left.length&&new Set(right).size===right.length&&JSON.stringify(shared)===JSON.stringify(result.sharedIndustryKeys),input);
  value(result.relation===(!left.length||!right.length?'unknown':shared.length?'common':'mixed')&&result.composite===(left.length>1||right.length>1),input);
  return result;
};
const quality=input=>shape(input,{
  quantity:v=>shape(v,{status,displayable:bool,comparable:bool,capacityKnown:bool,capacityConflict:bool,capacityReviewRequired:bool,ownEligibleDays:count,competitorEligibleDays:count,commonDays:count,ownExcludedDates:array(excluded),competitorExcludedDates:array(excluded)}),
  reservationRate:v=>shape(v,{status,displayable:bool,comparable:bool,issues:array(rateIssue)}),
  revenue:v=>shape(v,{status,displayable:bool,comparable:bool,unknownDates:array(date)}),
  timing:v=>shape(v,{sameObservationDay:bool,referenceOnlyDates:array(date),unknownTimeDates:array(date),maximumObservedSkewMs:nullable(money),exceededDates:array(date),policy:observationPolicy})
});
const basisDetail=input=>shape(input,{
  mode:oneOf(['current','historical']),asOf:date,period:v=>input.mode==='historical'&&v?.start===null&&v?.end===null?{start:null,end:null}:period(v),minCommonDays:v=>value(Number.isSafeInteger(v)&&v>=7,v),currentFreshnessDays:nullable(count),
  observationTimes:array(v=>shape(v,{date,ownObservedAt:nullable(instant),competitorObservedAt:nullable(instant),skewMs:nullable(money)})),
  duplicateStayDates:v=>shape(v,{own:array(date),competitor:array(date)}),source:oneOf(['central_integrated_observation']),regionAdjusted:oneOf([false]),statisticalConfidenceClaim:oneOf([false])
});
const summaryRequired=input=>projectSummary(input,{required:true})||bad();
function hasComparisonContract(input){return !!input&&NEW_KEYS.some(key=>own(input,key));}
function projectComparison(input){
  try{
    const result=shape(input,{
      rulesVersion:oneOf([RULES_VERSION]),companyId:id,name:v=>text(v,200),ownId:id,
      commonDays:count,dates:array(date),own:summaryRequired,competitor:summaryRequired,gapPp:nullable(numeric),status:oneOf(['excluded','comparable','insufficient']),basis:oneOf(['same_stay_date_same_kst_observation_day_at_historical_cutoff','same_stay_date_same_kst_observation_day_within_7_days']),
      displayable:bool,comparable:bool,actionable:bool,purpose:oneOf(['direct','reference']),requestedPurpose:nullable(oneOf(['direct','reference'])),purposeExplicit:bool,
      regionRelation:oneOf(['same','cross','unknown']),industryRelation:oneOf(['common','mixed','unknown']),region,industry,reasons:array(reason,128),quality,basisDetail,
      reference:v=>shape(v,{own:summaryRequired,competitor:summaryRequired})
    });
    value(result.commonDays===result.dates.length&&result.commonDays===result.own.days&&result.commonDays===result.competitor.days&&result.commonDays===result.quality.quantity.commonDays,input);
    value(result.regionRelation===result.region.relation&&result.industryRelation===result.industry.relation,input);
    value(result.purposeExplicit===(result.requestedPurpose!==null)&&result.purpose===(result.requestedPurpose==='direct'?'direct':'reference'),input);
    value(result.comparable===result.quality.reservationRate.comparable&&result.displayable===result.quality.quantity.displayable,input);
    value(!result.comparable||result.quality.quantity.comparable&&result.quality.quantity.capacityKnown&&!result.quality.quantity.capacityConflict,input);
    value(!result.actionable||result.displayable&&result.comparable&&!result.quality.quantity.capacityReviewRequired&&result.purpose==='direct'&&result.purposeExplicit&&result.regionRelation==='same'&&result.industryRelation==='common'&&result.quality.timing.policy.confirmed&&!result.quality.timing.unknownTimeDates.length&&!result.quality.timing.exceededDates.length,input);
    value(!result.quality.quantity.comparable||result.commonDays>=result.basisDetail.minCommonDays,input);
    value(result.quality.reservationRate.displayable===result.comparable&&(result.quality.reservationRate.status==='ready')===result.comparable,input);
    value(result.comparable||result.gapPp===null,input);
    value(new Set(result.dates).size===result.dates.length&&result.basisDetail.observationTimes.length===result.commonDays,input);
    value(result.basisDetail.observationTimes.every((row,index)=>row.date===result.dates[index]&&(row.ownObservedAt===null||row.competitorObservedAt===null?row.skewMs===null:row.skewMs===Math.abs(Date.parse(row.ownObservedAt)-Date.parse(row.competitorObservedAt)))),input);
    const kstDay=at=>new Date(Date.parse(at)+9*3600000).toISOString().slice(0,10),oldest=result.basisDetail.mode==='current'?new Date(Date.parse(result.basisDetail.asOf+'T00:00:00Z')-result.basisDetail.currentFreshnessDays*86400000).toISOString().slice(0,10):null;
    value(result.basisDetail.observationTimes.every(row=>{
      const days=[row.ownObservedAt,row.competitorObservedAt].filter(at=>at!==null).map(kstDay);
      return days.every(day=>day<=result.basisDetail.asOf&&(!oldest||day>=oldest))&&(days.length<2||days[0]===days[1]);
    }),input);
    value(result.quality.timing.sameObservationDay===(result.commonDays>0),input);
    const unknownTimes=result.basisDetail.observationTimes.filter(row=>row.skewMs===null).map(row=>row.date),exceeded=result.basisDetail.observationTimes.filter(row=>row.skewMs!==null&&result.quality.timing.policy.confirmed&&row.skewMs>result.quality.timing.policy.maxSkewMs).map(row=>row.date);
    value(JSON.stringify(unknownTimes)===JSON.stringify(result.quality.timing.unknownTimeDates)&&JSON.stringify(exceeded)===JSON.stringify(result.quality.timing.exceededDates),input);
    value(result.quality.revenue.status!=='partial'||result.own.estimatedRevenue===null||result.competitor.estimatedRevenue===null,input);
    value(result.basisDetail.mode==='current'?result.basisDetail.currentFreshnessDays!==null:result.basisDetail.currentFreshnessDays===null,input);
    const allDates=[...result.dates,...result.quality.revenue.unknownDates,...result.quality.timing.referenceOnlyDates,...result.quality.timing.unknownTimeDates,...result.quality.timing.exceededDates,...result.basisDetail.observationTimes.map(r=>r.date),...result.quality.quantity.ownExcludedDates.map(r=>r.date),...result.quality.quantity.competitorExcludedDates.map(r=>r.date),...result.quality.reservationRate.issues.map(r=>r.date),...result.basisDetail.duplicateStayDates.own,...result.basisDetail.duplicateStayDates.competitor,...result.own.revenueUnknownDays,...result.competitor.revenueUnknownDays,...result.reference.own.revenueUnknownDays,...result.reference.competitor.revenueUnknownDays];
    if(result.basisDetail.period.start===null)value(!result.displayable&&!result.comparable&&!result.actionable&&result.commonDays===0&&result.status==='insufficient'&&!allDates.length&&[result.own,result.competitor,result.reference.own,result.reference.competitor].every(s=>s.days===0&&s.sold===null&&s.supply===null&&s.estimatedRevenue===null&&s.publicBookings===null&&s.phoneBookings===null&&s.knownRevenueSubtotal===null),input);
    value(allDates.every(day=>day>=result.basisDetail.period.start&&day<=result.basisDetail.period.end),input);
    return result;
  }catch{return null;}
}
function comparisonWithinReport(comparison,report){
  const extended=!!report.selection,mode=extended&&report.selection.stayMode!=='upcoming30'?'historical':'current',asOf=extended?report.asOf:report.period?.start;
  if(!comparison||comparison.ownId!==report.ownId||comparison.basisDetail?.mode!==mode||comparison.basisDetail.asOf!==asOf||comparison.basisDetail.period.start!==report.period.start||comparison.basisDetail.period.end!==report.period.end)return false;
  const ownCompany=report.companies?.find(row=>row.companyId===report.ownId&&row.kind==='own'),competitor=report.companies?.find(row=>row.companyId===comparison.companyId&&row.kind==='competitor');
  if(!ownCompany||!competitor||comparison.region.ownRegionKey!==normalizedRegionKey(ownCompany.regionKey)||comparison.region.competitorRegionKey!==normalizedRegionKey(competitor.regionKey))return false;
  if(comparison.actionable&&!report.companies?.some(row=>row.companyId===report.ownId&&row.kind==='own'&&row.relationStatus==='active'))return false;
  return true;
}
function projectCompanyLabels(input){
  try{return shape(input,{regionLabel:nullable(v=>value(typeof v==='string'&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v),v)),roomCountSource:nullable(v=>value(typeof v==='string'&&v.length<=300&&!/[\u0000-\u001f\u007f]/.test(v),v))},{optional:true});}catch{return null;}
}
function projectReservationSeries(input,company,report){
  try{
    const extended=!!report.selection,asOf=extended?report.asOf:report.period?.start,expectedDays=extended?report.period.days:30,current=!extended||report.selection.stayMode==='upcoming30';
    if(extended&&expectedDays===0){value(input?.companyId===company.companyId&&input.period?.start===null&&input.period?.end===null&&input.asOf===asOf&&Array.isArray(input.points)&&input.points.length===0,input);return {companyId:company.companyId,period:{start:null,end:null},asOf,points:[]};}
    value(Number.isSafeInteger(expectedDays)&&expectedDays>0&&expectedDays<=3660,input);
    const result=shape(input,{companyId:id,period,asOf:date,points:array(point=>shape(point,{
      date,total:nullable(count),sold:nullable(count),publicBookings:nullable(count),phoneBookings:nullable(count),quantityStatus:oneOf(['ready','unknown','conflict']),codes:array(code,64),missing:bool,inventoryConflict:bool,collectedAt:nullable(instant),collectedDate:nullable(date),reservationRate:nullable(v=>value(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1,v))
    }),3660)});
    value(result.companyId===company.companyId&&result.period.start===report.period?.start&&result.period.end===report.period.end&&result.asOf===asOf&&report.period.days===expectedDays&&result.points.length===expectedDays,input);
    const start=Date.parse(result.period.start+'T00:00:00Z'),oldest=new Date(Date.parse(asOf+'T00:00:00Z')-7*86400000).toISOString().slice(0,10);
    value(new Date(start+(expectedDays-1)*86400000).toISOString().slice(0,10)===result.period.end,input);
    for(const [index,point] of result.points.entries()){
      value(point.date===new Date(start+index*86400000).toISOString().slice(0,10)&&new Set(point.codes).size===point.codes.length,input);
      if(point.quantityStatus!=='ready'){
        value(point.total===null&&point.sold===null&&point.publicBookings===null&&point.phoneBookings===null&&point.reservationRate===null&&point.missing===true&&point.inventoryConflict===false&&point.collectedAt===null&&point.collectedDate===null&&point.codes.length>0,input);
        value(point.quantityStatus===(point.codes.some(c=>['QUANTITY_INVALID','DUPLICATE_STAY_DATE'].includes(c))?'conflict':'unknown'),input);
        continue;
      }
      value(point.missing===false&&point.sold!==null&&point.publicBookings!==null&&point.phoneBookings!==null&&point.sold===point.publicBookings+point.phoneBookings,input);
      value(point.total===null||point.total>0,input);
      value(point.collectedDate!==null&&point.collectedDate<=result.asOf&&(!current||point.collectedDate>=oldest),input);
      if(point.collectedAt!==null)value(point.collectedAt===new Date(Date.parse(point.collectedAt)).toISOString()&&new Date(Date.parse(point.collectedAt)+9*3600000).toISOString().slice(0,10)===point.collectedDate,input);
      const capacityKnown=Number.isSafeInteger(company.rooms)&&company.rooms>0&&point.total!==null;
      value(point.codes.every(c=>['CAPACITY_UNKNOWN','CAPACITY_CONFLICT'].includes(c)),input);
      value(point.inventoryConflict===point.codes.includes('CAPACITY_CONFLICT'),input);
      if(!capacityKnown)value(point.codes.includes('CAPACITY_UNKNOWN')&&point.reservationRate===null,input);
      else if(point.inventoryConflict)value(point.reservationRate===null,input);
      else value(!point.codes.length&&company.rooms===point.total&&point.sold<=point.total&&point.reservationRate===point.sold/point.total,input);
      if(point.codes.length)value(point.reservationRate===null,input);
    }
    return result;
  }catch{return null;}
}
function projectCompetitiveActions(actions,comparisons){
  const eligible=comparisons.filter(row=>row.rulesVersion===RULES_VERSION&&row.actionable===true&&row.comparable===true&&typeof row.gapPp==='number'&&Number.isFinite(row.gapPp));
  const behind=eligible.some(row=>row.gapPp<0),legacy=comparisons.some(row=>!hasComparisonContract(row));
  let reviewAdded=false;
  return actions.flatMap(action=>{
    if(!['compare','track'].includes(action.key)||action.key==='compare'&&behind||action.key==='track'&&eligible.length>0&&!behind)return [action];
    if(reviewAdded||actions.some(row=>row.key==='comparison_review'))return [];
    reviewAdded=true;
    return [{key:'comparison_review',title:'경쟁 비교 기준을 먼저 확인하세요.',
      reason:legacy?'이전 비교 기준의 참고자료입니다. 현재 기준으로 확인한 비교 근거가 없어 자동 행동 판단을 보류합니다.':'현재 비교 조건에서 자동 행동 판단을 보류합니다.',
      next:'업체별 비교 가능 범위와 확인 사유를 확인하세요.',check:'동일 숙박기간·관측 기준일·지역·업종·자료 품질',source:'저장된 비교 기준과 검수 상태'}];
  });
}
const PROJECTION_SIGNATURE=createHash('sha256').update(JSON.stringify([RULES_VERSION,NEW_KEYS,EXTENDED_SUMMARY_KEYS,Object.keys(REASONS),...[
  object,text,id,labelKey,normalizedRegionKey,bool,count,numeric,money,date,instant,nullable,oneOf,array,shape,period,status,scope,code,reason,excluded,rateIssue,observationPolicy,projectSummary,projectSummaryQuality,region,industry,quality,basisDetail,hasComparisonContract,projectComparison,comparisonWithinReport,projectCompanyLabels,projectReservationSeries,projectCompetitiveActions
].map(fn=>fn.toString())])).digest('hex');
module.exports={hasComparisonContract,projectComparison,projectSummary,projectSummaryQuality,comparisonWithinReport,projectCompanyLabels,projectReservationSeries,projectCompetitiveActions,EXTENDED_SUMMARY_KEYS,PROJECTION_SIGNATURE};
