'use strict';
const {fault,active}=require('./insight_store.cjs');
const {shiftMonth,metricsFor}=require('./insight_region_history.cjs');
const {evaluateComparison,buildComparisonSet,validQuantityDay,summarizeCompany,projectReservationSeries}=require('./insight_comparison.cjs');
const txt=v=>typeof v==='string'?v.slice(0,1500):'';
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const kst=v=>Number.isFinite(Date.parse(v))?new Date(Date.parse(v)+9*3600000).toISOString().slice(0,10):null;
const observedDay=d=>kst(d.collectedAt)||(/^\d{4}-\d{2}-\d{2}$/.test(d.collectedDate||'')?d.collectedDate:null);
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const monthEnd=month=>{const [year,number]=month.split('-').map(Number);return new Date(Date.UTC(year,number,0)).toISOString().slice(0,10);};
// Only controlled codes and explanations cross the report boundary. Exception
// messages can contain a file path, provider body or credential and are omitted.
const sourceReasons={
  MONTH_NOT_OBSERVED:'해당 숙박월의 수집 이력이 없습니다.',
  COMPANY_DETAIL_NOT_FOUND:'저장된 업체 자료를 찾지 못했습니다.',
  COMPANY_INTEGRATION_PENDING:'해당 월의 통합 자료를 준비하고 있습니다.',
  COMPANY_INTEGRATION_UPDATING:'해당 월의 통합 자료를 갱신하고 있어 이전 관측값을 표시합니다.',
  COMPANY_INTEGRATION_FAILED:'해당 월의 통합 자료 계산 또는 저장 확인에 실패했습니다.',
  COMPANY_OBSERVATION_INSUFFICIENT:'요청한 기간의 객실 수량을 확인할 수 있는 관측 자료가 없습니다.',
  SAVED_COMPANY_SOURCE_INVALID:'저장된 월별 자료의 대상 또는 형식을 확인하지 못했습니다.',
  SAVED_COMPANY_SOURCE_UNAVAILABLE:'저장된 월별 자료를 읽지 못했습니다.',
  COMPANY_CAPACITY_REVIEW_CHANGED:'현재 객실 기준과 저장 자료가 일치하는지 확인할 수 없어 다시 계산해야 합니다.',
  COMPANY_DETAIL_SOURCE_CHANGED:'업체 자료가 변경되어 최신 결과를 다시 확인해야 합니다.',
  COMPANY_DETAIL_MASTER_INVALID:'저장된 업체 기본자료의 형식을 확인하지 못했습니다.',
  COMPANY_DETAIL_SOURCE_UNAVAILABLE:'업체 관측 자료를 읽지 못했습니다.',
  COMPANY_DETAIL_CACHE_WRITE_FAILED:'확인한 업체 자료의 임시 저장에 실패했습니다.',
  COMPANY_INTEGRATION_STORE_UNAVAILABLE:'저장된 월별 통합 자료를 읽지 못했습니다.',
  COMPANY_SOURCE_REVISION_UNAVAILABLE:'업체 원본 자료의 변경 여부를 확인하지 못했습니다.',
  COMPANY_SOURCE_REVISION_INDEX_INVALID:'업체 원본 자료의 변경 기록을 확인하지 못했습니다.',
  REGION_NOT_READY:'지역 자료 연결이 준비되지 않았습니다.',
  READ_ONLY_SOURCE_REQUIRED:'저장된 지역 자료의 조회 조건을 확인하지 못했습니다.',
  REGION_INDICATOR_FAILED:'저장된 지역 지표 일부를 확인하지 못했습니다.',
  REGION_INDICATOR_UNAVAILABLE:'해당 기간의 지역 지표 자료를 이용할 수 없습니다.',
  REGION_INDICATOR_BLOCKED:'해당 기간의 지역 지표 자료 연결이 제한된 상태입니다.',
  REGION_ADDITIONAL_ISSUES:'추가 지표 오류가 있어 일부 사유만 표시합니다.',
  REGION_SOURCE_UNAVAILABLE:'저장된 지역 자료를 읽지 못했습니다.',
  COMPANY_SOURCE_UNAVAILABLE:'저장된 업체 자료를 확인하지 못했습니다.'
};
function sourceIssue({scope,companyId,regionId,name,month,period,code,sourceKey,sourceName}) {
  const fallback=scope==='region'?'REGION_SOURCE_UNAVAILABLE':'COMPANY_SOURCE_UNAVAILABLE';
  code=Object.hasOwn(sourceReasons,code)?code:fallback;
  return {scope,...(scope==='company'?{companyId}:{regionId}),name:txt(name),month,period:{start:period.start,end:period.end},code,reason:sourceReasons[code],
    ...(sourceKey?{sourceKey:txt(sourceKey),sourceName:txt(sourceName)}:{})};
}
function regionSourceQuality(value,sources=value.sources) {
  const issues=new Map(),validMonth=month=>typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month);
  const codeFor={error:'REGION_INDICATOR_FAILED',failed:'REGION_INDICATOR_FAILED',unavailable:'REGION_INDICATOR_UNAVAILABLE',blocked:'REGION_INDICATOR_BLOCKED'};
  let truncated=false;
  const actualMonth=(node,fallback)=>[node?.month,node?.period,node?.latest?.month].find(validMonth)||fallback;
  const add=(node,source,month)=>{
    const code=Object.hasOwn(codeFor,node?.status)?codeFor[node.status]:null;
    if(!code)return;
    month=actualMonth(node,month);
    const key=JSON.stringify([source.key||source.label||'',month,code]);
    if(issues.has(key))return;
    if(issues.size>=32){truncated=true;return;}
    issues.set(key,sourceIssue({scope:'region',regionId:value.region.id,name:value.region.label,month,
      period:{start:month+'-01',end:monthEnd(month)},code,sourceKey:source.key,sourceName:source.label}));
  };
  for(const source of sources||[]) {
    const month=actualMonth(source,value.month);add(source,source,month);
    for(const row of source.rows||[])add(row,source,month);
    for(const point of source.series||[]) {
      if(validMonth(point.month)&&(point.month>value.month||value.window?.storageStart&&point.month<value.window.storageStart))continue;
      const pointMonth=actualMonth(point,month);add(point,source,pointMonth);
      for(const row of point.rows||[])add(row,source,pointMonth);
    }
    for(const metric of source.metrics||[]) {
      const metricMonth=actualMonth(metric,month);add(metric,source,metricMonth);
      for(const part of ['latest','mom','yoy','peak','low'])if(metric[part])add(metric[part],source,metricMonth);
      for(const row of metric.rows||[])add(row,source,metricMonth);
    }
  }
  let sourceIssues=[...issues.values()];
  if(truncated)sourceIssues=[...sourceIssues.slice(0,31),sourceIssue({scope:'region',regionId:value.region.id,name:value.region.label,month:value.month,
    period:{start:(value.window?.storageStart||value.month)+'-01',end:monthEnd(value.month)},code:'REGION_ADDITIONAL_ISSUES'})];
  return {sourceStatus:sourceIssues.length?value.availableSources>0?'partial':'unavailable':'ready',sourceIssues};
}
function regionIds(customer,catalog) {
  const keys=new Set(customer.regions.filter(active).map(r=>r.regionKey));
  for(const rel of customer.relations.filter(r=>r.kind==='own'&&r.status==='active')) {
    const key=catalog.companies.find(c=>c.companyId===rel.companyId)?.regionKey;if(key)keys.add(key);
  }
  return keys;
}
// Viewing stored context does not approve ownership or grant preparation rights.
// Keep regionIds unchanged for preparation status and refresh requests.
function readableRegionIds(customer,catalog) {
  const keys=regionIds(customer,catalog);
  for(const rel of customer.relations.filter(r=>r.kind==='own'&&r.status==='pending')) {
    const key=catalog.companies.find(c=>c.companyId===rel.companyId)?.regionKey;
    if(key&&catalog.regions.some(r=>r.id===key&&r.level==='local'))keys.add(key);
  }
  return keys;
}
function safeUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function projectRegion(region,month,context,location) {
  if(context?.networkAttempted)throw fault('READ_ONLY_SOURCE_REQUIRED','저장된 지역 자료만 연결할 수 있습니다.',503);
  const rows=values=>(values||[]).map(r=>({key:txt(r.key),label:txt(r.label),value:r.status==='observed'?num(r.value):null,unit:txt(r.unit),status:txt(r.status)}));
  const window=context?.window?{start:shiftMonth(month,-11),end:month,months:12,storageStart:shiftMonth(month,-23),storageMonths:24,currentMonth:txt(context.window.currentMonth)}:null;
  const sources=(context?.sources||[]).map(s=>{
    const result={key:txt(s.key),label:txt(s.label),provider:txt(s.provider),status:txt(s.status),period:txt(s.period),periodType:txt(s.periodType),keyword:txt(s.keyword),normalizationPeriod:txt(s.normalizationPeriod),partialMonth:s.partialMonth===true,referenceOnly:s.referenceOnly===true,sourceUrl:safeUrl(s.sourceUrl),retrievedAt:txt(s.retrievedAt),sourceUpdatedAt:txt(s.sourceUpdatedAt),rows:rows(s.rows)};
    if(window&&Array.isArray(s.series)) {
      result.series=s.series.filter(p=>/^\d{4}-\d{2}$/.test(p.month)&&p.month>=window.storageStart&&p.month<=month).slice(0,24).map(p=>({month:p.month,status:txt(p.status),retrievedAt:txt(p.retrievedAt),rows:rows(p.rows)}));
      result.metrics=metricsFor(result.series,result.rows.map(r=>[r.key,r.label,r.unit]),window);
    }
    return result;
  });
  const loc=location?.regionKey===region.id?{interpretation:txt(location.interpretation),recommendedProduct:txt(location.recommendedProduct),caution:txt(location.caution),source:txt(location.source),updatedAt:txt(location.updatedAt),basis:'reference',clusters:(location.clusters||[]).map(c=>({name:txt(c.name),demand:txt(c.demand),product:txt(c.product)}))}:null;
  const interim=context?.interim?{month:txt(context.interim.month),status:'partial_month',sources:context.interim.sources.map(s=>({key:txt(s.key),label:txt(s.label),period:txt(s.period),status:txt(s.status),rows:rows(s.rows)}))}:null;
  const value={region:{id:region.id,label:region.label},month,window,interim,source:'datalab_saved',networkAttempted:false,location:loc,sources,
    availableSources:sources.filter(s=>s.rows.some(r=>r.value!==null)).length,warnings:(context?.warnings||[]).map(txt)};
  // Inspect original status fields before the public numeric projection drops
  // provider-specific metadata or replaces metrics with derived comparisons.
  return {...value,...regionSourceQuality(value,context?.sources||[])};
}
const validDay=d=>validQuantityDay(d);
function pairComparison(own,other,todayOrOptions) {
  return evaluateComparison(own,other,typeof todayOrOptions==='string'?{asOf:todayOrOptions}:todayOrOptions);
}
function buildBriefing(companies,regions,{today,ownId,mode='current',asOf=today,period,observationPolicy,regionHierarchy}={}) {
  const own=companies.find(c=>c.companyId===ownId&&c.kind==='own')||null;
  const comparisonSet=buildComparisonSet(own,own?companies.filter(c=>c.kind==='competitor'):[],{mode,asOf,period,observationPolicy,regionHierarchy});
  const comparisons=comparisonSet.comparisons;
  const actions=[];
  const add=(key,title,reason,next,check,source)=>actions.push({key,title,reason,next,check,source});
  if(!own)add('register','분석 기준이 될 내 매장을 등록하세요.','내 매장이 없어 경쟁업체와의 차이를 계산하지 않았습니다.','운영 매장을 등록하거나 준비 중인 사업의 기준 지역을 선택하세요.','내 매장·관심지역 연결 상태','등록 상태');
  else {
    const recentCount=summarizeCompany(own,{mode,asOf,period}).summary.days;
    if(own.relationStatus==='pending')add('verify','내 매장 연결 확인을 완료하세요.','등록한 매장의 소유·연결 확인이 대기 중입니다.','관리자에게 등록 매장 확인을 요청하세요.','매장 등록 완료 상태','등록 상태');
    const expectedDays=comparisonSet.period.start&&comparisonSet.period.end?Math.round((Date.parse(comparisonSet.period.end)-Date.parse(comparisonSet.period.start))/86400000)+1:30;
    if(recentCount<expectedDays)add('coverage','예약 판단에 필요한 관측을 먼저 보완하세요.',mode==='historical'?`선택한 숙박기간 ${expectedDays}일 중 관측 마감일까지 수량을 확인한 날짜는 ${recentCount}일입니다.`:`향후 ${expectedDays}일 중 최근 7일 안에 수량을 확인한 숙박일은 ${recentCount}일입니다.`,'업체 자료에서 누락·객실 수 경고를 확인하고 필요한 수집 또는 검수를 요청하세요.','유효 관측일 수와 객실 총량 오류','내 매장 업체DB');
    const behind=comparisons.filter(c=>c.actionable&&c.gapPp<0).sort((a,b)=>a.gapPp-b.gapPp)[0];
    if(behind)add('compare','예약률 차이가 있는 상품 조건을 점검하세요.',`${behind.name}와 같은 숙박일 ${behind.commonDays}일 비교에서 내 매장 추정 예약률이 ${Math.abs(behind.gapPp).toFixed(1)}%p 낮습니다.`,'같은 날짜의 판매금액·시설·사진·취소 조건을 비교하고, 한 가지 개선안을 시험하세요. 가격 인하가 원인 해결이라고 단정하지 않습니다.','동일 숙박일의 공개 예약 순증감·가격 확인 범위','같은 관측일·숙박일의 경쟁업체 자료');
    else if(!comparisons.some(c=>c.comparable))add('comparison_data','비교 기준과 공통 관측 자료를 확인하세요.','객실 기준이 확인되고 같은 관측일·숙박일이 겹치는 7일 이상 표본이 필요합니다.','경쟁업체의 객실 기준·관측 범위와 제외 사유를 확인하세요.','비교 가능한 공통 숙박일 수','경쟁업체 업체DB');
    else if(!comparisons.some(c=>c.actionable))add('comparison_review','예약 흐름을 참고하고 비교 조건을 먼저 확인하세요.','지역·업종·비교 목적 또는 관측 시차 조건이 달라 자동 우열 판단을 보류했습니다.','업체별 비교 근거와 해당 지역의 수요 배경을 함께 확인하세요.','지역 관계·공통 업종·관측 시차','공통 숙박일 비교');
    else add('track','현재 조건을 유지하며 예약 흐름을 확인하세요.','같은 지역·공통 업종의 직접 경쟁 중 행동 판단 조건을 충족한 자료에서 더 낮은 예약률 신호가 확인되지 않았습니다.','예약 감소와 판매금액 변화를 함께 확인한 뒤 변경 여부를 결정하세요.','같은 숙박일의 공개 예약 순증감','공통 숙박일 비교');
  }
  const ownRegion=own&&regions.find(r=>r.region.id===own.regionKey);
  const hasMonthlyFlow=ownRegion?.sources?.some(s=>s.metrics?.some(m=>m.observedMonths>0));
  if(own&&(!ownRegion||!ownRegion.availableSources))add('region_data','매장 소재지의 지역 자료를 보완하세요.','현재 연결된 매장 소재지 지표가 없거나 확인되지 않았습니다.','지역 연결을 확인하고 관리자에게 해당 기준월의 자료 준비를 요청하세요.','소재지 일치·공표기간·자료 확보 상태','지역 분석');
  else if(ownRegion?.window&&!hasMonthlyFlow)add('region_flow','지역의 월별 흐름 자료를 준비하세요.','인구·산업 배경과 별도로 최근 12개월 관광·검색 지표의 확보가 필요합니다.','지역 분석에서 지역 자료 갱신을 눌러 준비 상태와 누락 월을 확인하세요.','12개월 확보 범위·최신 공표월·전년 동월 비교 가능 여부','데이터랩 지역 분석');
  else if(ownRegion)add('region','지역 수요와 상품 설명을 대조하세요.',`${ownRegion.region.label}의 ${ownRegion.window?'최근 12개월 흐름과 ':''}저장 지표 ${ownRegion.availableSources}종이 연결되어 있습니다.`,'월별 방문·체류·소비·검색 관심의 변화와 실제 문의를 대조하세요. 지표별 최신 확보월이 다르면 같은 시점으로 단정하지 않습니다.','전월·전년 동월 변화와 고객 문의 유형','데이터랩 지역 분석');
  return {mode:mode==='historical'?'historical_briefing':'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{...comparisonSet.period,days:comparisonSet.period.start&&comparisonSet.period.end?Math.round((Date.parse(comparisonSet.period.end)-Date.parse(comparisonSet.period.start))/86400000)+1:0},asOf,ownId:own?.companyId||null,
    companies:companies.map(c=>({...c,...summarizeCompany(c,{mode,asOf,period}),...(mode==='current'?{reservationSeries:projectReservationSeries(c,{mode,asOf,period})}:{}),days:undefined})),comparisons,comparisonPolicy:{...comparisonSet,comparisons:undefined},regions,actions,
    dataQuality:{status:[...companies,...regions].some(row=>row.sourceIssues?.length)?'partial':'complete',issues:[...companies,...regions].flatMap(row=>row.sourceIssues||[])},
    definitions:['저장 자료만 읽으며 새로운 수집을 실행하지 않습니다. 실제 결제 매출이 아닌 예약·방막기 관측 기반 추정입니다.',mode==='historical'?'과거 비교는 선택한 숙박기간과 관측 마감일까지의 같은 한국시간 관측일 자료를 사용합니다. 현재 날짜의 최근 7일 기준을 과거월에 적용하지 않습니다.':'현재 경쟁 비교는 같은 숙박일·같은 한국시간 관측일, 최근 7일 이내의 정상 수량만 사용합니다.','공통 7일은 최소 표본 조건이며 통계적 신뢰를 보증하지 않습니다. 수량과 가격의 미확인은 따로 표시합니다.','자동 행동 판단은 같은 지역·공통 업종의 직접 경쟁과 확인된 객실 기준·관측 시차 정책을 충족한 자료로 제한합니다.','내 매장과 경쟁업체의 매출을 합산하지 않습니다. 지역은 실제 소재지와 등록 관심지역을 구분합니다.','이 화면은 발행된 주간·월간 보고서가 아닌 저장 관측 브리핑입니다.']};
}
function createInsightAnalysis({catalog,collectionResults,savedCollectionResults,readRegionContext,regionPreparation=null,readRegionLocation=async()=>null,now=()=>Date.now()}) {
  const today=()=>new Date(now()+9*3600000).toISOString().slice(0,10);
  const previousMonth=()=>new Date(Date.UTC(Number(today().slice(0,4)),Number(today().slice(5,7))-2,1)).toISOString().slice(0,7);
  async function region(customer,regionKey,month=previousMonth(),data) {
    data=data||await catalog();
    const item=data.regions.find(r=>r.id===regionKey&&r.level==='local');
    if(!item||!readableRegionIds(customer,data).has(regionKey))throw fault('NOT_FOUND','등록한 지역의 자료를 찾을 수 없습니다.',404);
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>'2099-12'||month<'2017-12'||month>previousMonth())throw fault('INVALID_MONTH','마감된 월을 마지막 기준월로 선택해 주세요.');
    if(!readRegionContext)throw fault('REGION_NOT_READY','지역 자료 연결을 준비 중입니다.',503);
    const context=await readRegionContext({type:'region',targetId:regionKey,month},data);
    return {...projectRegion(item,month,context,await readRegionLocation(regionKey)),refreshAvailable:Boolean(regionPreparation)&&regionIds(customer,data).has(regionKey)};
  }
  async function preparation(customer,regionKey,month=previousMonth(),start=false) {
    const data=await catalog();
    if(!data.regions.some(r=>r.id===regionKey&&r.level==='local')||!regionIds(customer,data).has(regionKey))throw fault('NOT_FOUND','등록한 지역의 자료를 찾을 수 없습니다.',404);
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month<'2017-12'||month>previousMonth())throw fault('INVALID_MONTH','마감된 월을 마지막 기준월로 선택해 주세요.');
    if(!regionPreparation)throw fault('REGION_NOT_READY','지역 자료 갱신을 준비 중입니다.',503);
    let job;
    try{job=start?await regionPreparation.start({regionKey,month,cutoffDate:today()}):await regionPreparation.get({regionKey,month});}
    catch{throw fault('REGION_PREPARATION_FAILED','지역 자료 준비를 시작하거나 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.',503);}
    return {regionKey,month,job:job?{id:txt(job.id),status:txt(job.status),reused:job.reused===true,updatedAt:txt(job.updatedAt),finishedAt:txt(job.finishedAt),progress:{completed:Number(job.progress?.completed)||0,total:6},
      steps:(job.steps||[]).map(s=>({key:txt(s.key),label:txt(s.label),status:txt(s.status),errorCode:txt(s.errorCode),observedMonths:num(s.observedMonths),expectedMonths:num(s.expectedMonths)}))}:null};
  }
  async function briefing(customer,ownId,{savedOnly=false}={}) {
    const data=await catalog(),rels=customer.relations.filter(active),own=rels.filter(r=>r.kind==='own');
    const reportDay=today(),reportEnd=shift(reportDay,29),startMonth=reportDay.slice(0,7),endMonth=reportEnd.slice(0,7),regionMonth=previousMonth();
    ownId=ownId||own[0]?.companyId||null;
    if(ownId&&!own.some(r=>r.companyId===ownId))throw fault('NOT_FOUND','등록한 내 매장을 선택해 주세요.',404);
    const companies=[],sourceTimes=[],reader=savedOnly?savedCollectionResults:collectionResults;
    for(const rel of rels.filter(r=>r.kind==='competitor'||r.companyId===ownId)) {
      const c=data.companies.find(c=>c.companyId===rel.companyId);if(!c)continue;
      const sourceDays=[],sourceIssues=[],monthRoomBases=[];
      for(const month of [...new Set([startMonth,endMonth])]) {
        const issue=code=>sourceIssues.push(sourceIssue({scope:'company',companyId:c.companyId,name:c.name,month,
          period:{start:[reportDay,month+'-01'].sort().at(-1),end:[reportEnd,monthEnd(month)].sort()[0]},code}));
        try {
          const detail=await reader?.companyDetail(c.companyId,{month,...(savedOnly?{company:c}:{})});
          if(!detail){issue('COMPANY_DETAIL_NOT_FOUND');continue;}
          if(savedOnly&&Number.isFinite(Date.parse(detail.integrated?.calculatedAt)))sourceTimes.push(detail.integrated.calculatedAt);
          const integrated=Boolean(detail.integrated&&!detail.legacyObservationView);
          if(integrated&&detail.integrated.roomBasis) {
            const basis=detail.integrated.roomBasis;
            monthRoomBases.push({month,count:Number.isSafeInteger(basis.count)&&basis.count>0?basis.count:null,source:['db_review','observed_locked'].includes(basis.source)?basis.source:'unknown',reviewRequired:basis.reviewRequired===true});
          }
          const selectedDays=(detail.current?.daily||[]).filter(d=>d.date>=reportDay&&d.date<=reportEnd&&(!integrated||d.date.startsWith(month+'-')));
          sourceDays.push(...selectedDays);
          if(integrated){
            const status=detail.integrated.status;
            if(status==='failed')issue('COMPANY_INTEGRATION_FAILED');
            else if(status==='updating'||status==='refreshing')issue('COMPANY_INTEGRATION_UPDATING');
            else if(!detail.integrated.snapshot)issue('COMPANY_INTEGRATION_PENDING');
            if(detail.integrated.snapshot&&!selectedDays.some(validDay))issue('COMPANY_OBSERVATION_INSUFFICIENT');
          } else break; // A legacy detail has no independently addressable month.
        } catch(error) {issue(error?.code==='month_not_observed'?'MONTH_NOT_OBSERVED':error?.code);}
      }
      const days=[...new Map(sourceDays.map(d=>[d.date,d])).values()];
      const capacityConflict=c.capacityConflict===true||monthRoomBases.some(b=>num(c.rooms)>0&&b.count>0&&c.rooms!==b.count),capacityReviewRequired=c.capacityReviewRequired===true||monthRoomBases.some(b=>b.reviewRequired);
      companies.push({companyId:c.companyId,name:c.name,rooms:c.rooms,regionKey:c.regionKey,regionLabel:typeof c.regionLabel==='string'&&c.regionLabel?txt(c.regionLabel):null,roomCountSource:typeof c.roomCountSource==='string'&&c.roomCountSource?txt(c.roomCountSource):null,industryTags:Array.isArray(c.industryTags)?c.industryTags:[],industrySource:c.industrySource||'unknown',industryEvidence:c.industryEvidence||[],comparisonPurpose:rel.comparisonPurpose||null,capacityStatus:capacityConflict?'conflict':capacityReviewRequired?'review_required':c.capacityStatus||null,capacityConflict,capacityReviewRequired,roomBasis:c.roomBasis||null,monthRoomBases,kind:rel.kind,relationStatus:rel.status,
        unavailable:sourceIssues.length>0,sourceStatus:sourceIssues.length?days.some(validDay)?'partial':'unavailable':'ready',sourceIssues,days});
    }
    const regions=[],keys=new Set(customer.regions.filter(active).map(r=>r.regionKey));
    const selectedOwn=companies.find(c=>c.kind==='own'&&c.companyId===ownId&&c.relationStatus==='active');
    if(selectedOwn?.regionKey)keys.add(selectedOwn.regionKey);
    for(const key of keys) {
      try{
        regions.push(await region(customer,key,regionMonth,data));
      }
      catch(error){const r=data.regions.find(r=>r.id===key);if(r){const issue=sourceIssue({scope:'region',regionId:key,name:r.label,month:regionMonth,period:{start:regionMonth+'-01',end:monthEnd(regionMonth)},code:error?.code});
        regions.push({region:{id:r.id,label:r.label},month:regionMonth,source:'datalab_saved',networkAttempted:false,sources:[],availableSources:0,sourceStatus:'unavailable',sourceIssues:[issue],warnings:[issue.reason]});}}
    }
    const report=buildBriefing(companies,regions,{today:reportDay,ownId,regionHierarchy:data.regionHierarchy||{}});
    if(savedOnly){sourceTimes.sort();report.calculation={mode:'saved_only',status:'pending',oldestSourceCalculatedAt:sourceTimes[0]||null,latestSourceCalculatedAt:sourceTimes.at(-1)||null};}
    return report;
  }
  return {region,briefing,preparation};
}
module.exports={createInsightAnalysis,regionIds,readableRegionIds,projectRegion,buildBriefing,pairComparison};
