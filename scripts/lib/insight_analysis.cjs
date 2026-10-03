'use strict';
const {fault,active}=require('./insight_store.cjs');
const {shiftMonth,metricsFor}=require('./insight_region_history.cjs');
const txt=v=>typeof v==='string'?v.slice(0,1500):'';
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const kst=v=>Number.isFinite(Date.parse(v))?new Date(Date.parse(v)+9*3600000).toISOString().slice(0,10):null;
const observedDay=d=>kst(d.collectedAt)||(/^\d{4}-\d{2}-\d{2}$/.test(d.collectedDate||'')?d.collectedDate:null);
const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function regionIds(customer,catalog) {
  const keys=new Set(customer.regions.filter(active).map(r=>r.regionKey));
  for(const rel of customer.relations.filter(r=>r.kind==='own'&&r.status==='active')) {
    const key=catalog.companies.find(c=>c.companyId===rel.companyId)?.regionKey;if(key)keys.add(key);
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
  return {region:{id:region.id,label:region.label},month,window,interim,source:'datalab_saved',networkAttempted:false,location:loc,sources,
    availableSources:sources.filter(s=>s.rows.some(r=>r.value!==null)).length,warnings:(context?.warnings||[]).map(txt)};
}
const validDay=d=>d&&!d.missing&&!d.partial&&!d.inventoryConflict&&num(d.total)>0&&num(d.sold)!==null&&d.sold>=0&&d.sold<=d.total&&num(d.publicBookings)!==null&&num(d.phoneBookings)!==null&&Math.abs(d.publicBookings+d.phoneBookings-d.sold)<.001;
const sum=(rows,k)=>rows.length&&rows.every(d=>num(d[k])!==null)?rows.reduce((s,d)=>s+d[k],0):null;
function totals(rows) {
  const supply=sum(rows,'total'),sold=sum(rows,'sold');
  return {days:rows.length,supply,sold,reservationRate:supply>0?sold/supply:null,publicBookings:sum(rows,'publicBookings'),phoneBookings:sum(rows,'phoneBookings'),estimatedRevenue:rows.some(d=>d.revenuePartial)?null:sum(rows,'estimatedRevenue')};
}
function pairComparison(own,other,today) {
  const byDate=new Map(other.days.filter(validDay).map(d=>[d.date,d]));
  const pairs=own.days.filter(validDay).map(d=>[d,byDate.get(d.date)]).filter(([a,b])=>b&&observedDay(a)&&observedDay(a)===observedDay(b)&&observedDay(a)>=shift(today,-7)&&observedDay(a)<=today);
  const a=totals(pairs.map(p=>p[0])),b=totals(pairs.map(p=>p[1]));
  return {companyId:other.companyId,name:other.name,commonDays:pairs.length,dates:pairs.map(p=>p[0].date),own:a,competitor:b,
    gapPp:a.reservationRate!==null&&b.reservationRate!==null?(a.reservationRate-b.reservationRate)*100:null,
    status:pairs.length>=7?'comparable':'insufficient',basis:'same_stay_date_same_kst_observation_day_within_7_days'};
}
function buildBriefing(companies,regions,{today,ownId}) {
  const own=companies.find(c=>c.companyId===ownId&&c.kind==='own')||null;
  const comparisons=own?companies.filter(c=>c.kind==='competitor').map(c=>pairComparison(own,c,today)):[];
  const actions=[];
  const add=(key,title,reason,next,check,source)=>actions.push({key,title,reason,next,check,source});
  if(!own)add('register','분석 기준이 될 내 매장을 등록하세요.','내 매장이 없어 경쟁업체와의 차이를 계산하지 않았습니다.','운영 매장을 등록하거나 준비 중인 사업의 기준 지역을 선택하세요.','내 매장·관심지역 연결 상태','등록 상태');
  else {
    const valid=own.days.filter(validDay),recent=valid.filter(d=>observedDay(d)&&observedDay(d)>=shift(today,-7)&&observedDay(d)<=today);
    if(own.relationStatus==='pending')add('verify','내 매장 연결 확인을 완료하세요.','등록한 매장의 소유·연결 확인이 대기 중입니다.','관리자에게 등록 매장 확인을 요청하세요.','매장 등록 완료 상태','등록 상태');
    if(recent.length<30)add('coverage','예약 판단에 필요한 관측을 먼저 보완하세요.',`향후 30일 중 최근 7일 안에 수량을 확인한 숙박일은 ${recent.length}일입니다.`,'업체 자료에서 누락·객실 수 경고를 확인하고 필요한 수집 또는 검수를 요청하세요.','유효 관측일 수와 객실 총량 오류','내 매장 업체DB');
    const behind=comparisons.filter(c=>c.status==='comparable'&&c.gapPp<0).sort((a,b)=>a.gapPp-b.gapPp)[0];
    if(behind)add('compare','예약률 차이가 있는 상품 조건을 점검하세요.',`${behind.name}와 같은 숙박일 ${behind.commonDays}일 비교에서 내 매장 추정 예약률이 ${Math.abs(behind.gapPp).toFixed(1)}%p 낮습니다.`,'같은 날짜의 판매금액·시설·사진·취소 조건을 비교하고, 한 가지 개선안을 시험하세요. 가격 인하가 원인 해결이라고 단정하지 않습니다.','동일 숙박일의 공개 예약 순증감·가격 확인 범위','같은 관측일·숙박일의 경쟁업체 자료');
    else if(!comparisons.some(c=>c.status==='comparable'))add('comparison_data','같은 시점의 경쟁업체 자료를 확보하세요.','같은 관측일과 숙박일이 겹치는 7일 이상 표본이 없습니다.','경쟁업체 등록과 기존 관측 범위를 확인하세요.','비교 가능한 공통 숙박일 수','경쟁업체 업체DB');
    else add('track','현재 조건을 유지하며 예약 흐름을 확인하세요.','비교 가능한 등록 경쟁업체보다 낮은 예약률 신호가 확인되지 않았습니다.','예약 감소와 판매금액 변화를 함께 확인한 뒤 변경 여부를 결정하세요.','같은 숙박일의 공개 예약 순증감','공통 숙박일 비교');
  }
  const ownRegion=own&&regions.find(r=>r.region.id===own.regionKey);
  const hasMonthlyFlow=ownRegion?.sources?.some(s=>s.metrics?.some(m=>m.observedMonths>0));
  if(own&&(!ownRegion||!ownRegion.availableSources))add('region_data','매장 소재지의 지역 자료를 보완하세요.','현재 연결된 매장 소재지 지표가 없거나 확인되지 않았습니다.','지역 연결을 확인하고 관리자에게 해당 기준월의 자료 준비를 요청하세요.','소재지 일치·공표기간·자료 확보 상태','지역 분석');
  else if(ownRegion?.window&&!hasMonthlyFlow)add('region_flow','지역의 월별 흐름 자료를 준비하세요.','인구·산업 배경과 별도로 최근 12개월 관광·검색 지표의 확보가 필요합니다.','지역 분석에서 지역 자료 갱신을 눌러 준비 상태와 누락 월을 확인하세요.','12개월 확보 범위·최신 공표월·전년 동월 비교 가능 여부','데이터랩 지역 분석');
  else if(ownRegion)add('region','지역 수요와 상품 설명을 대조하세요.',`${ownRegion.region.label}의 ${ownRegion.window?'최근 12개월 흐름과 ':''}저장 지표 ${ownRegion.availableSources}종이 연결되어 있습니다.`,'월별 방문·체류·소비·검색 관심의 변화와 실제 문의를 대조하세요. 지표별 최신 확보월이 다르면 같은 시점으로 단정하지 않습니다.','전월·전년 동월 변화와 고객 문의 유형','데이터랩 지역 분석');
  return {mode:'current_briefing',published:false,generatedAt:new Date().toISOString(),period:{start:today,end:shift(today,29),days:30},ownId:own?.companyId||null,
    companies:companies.map(c=>({...c,lastObservedDay:c.days.map(observedDay).filter(Boolean).sort().at(-1)||null,lastObservedAt:c.days.map(d=>d.collectedAt).filter(v=>kst(v)).sort().at(-1)||null,summary:totals(c.days.filter(validDay)),days:undefined})),comparisons,regions,actions,
    definitions:['저장 자료만 읽으며 새로운 수집을 실행하지 않습니다. 실제 결제 매출이 아닌 예약·방막기 관측 기반 추정입니다.','경쟁 비교는 같은 숙박일·같은 한국시간 관측일, 최근 7일 이내의 정상 수량만 사용합니다. 7일 미만 공통 표본은 행동 판단을 보류합니다.','내 매장과 경쟁업체의 매출을 합산하지 않습니다. 지역은 실제 소재지와 등록 관심지역을 구분합니다.','이 화면은 현재 상황 브리핑이며 발행된 주간·월간 보고서가 아닙니다.']};
}
function createInsightAnalysis({catalog,collectionResults,readRegionContext,regionPreparation=null,readRegionLocation=async()=>null,now=()=>Date.now()}) {
  const today=()=>new Date(now()+9*3600000).toISOString().slice(0,10);
  const previousMonth=()=>new Date(Date.UTC(Number(today().slice(0,4)),Number(today().slice(5,7))-2,1)).toISOString().slice(0,7);
  async function region(customer,regionKey,month=previousMonth(),data) {
    data=data||await catalog();
    const item=data.regions.find(r=>r.id===regionKey&&r.level==='local');
    if(!item||!regionIds(customer,data).has(regionKey))throw fault('NOT_FOUND','등록한 지역의 자료를 찾을 수 없습니다.',404);
    if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)||month>'2099-12'||month<'2017-12'||month>previousMonth())throw fault('INVALID_MONTH','마감된 월을 마지막 기준월로 선택해 주세요.');
    if(!readRegionContext)throw fault('REGION_NOT_READY','지역 자료 연결을 준비 중입니다.',503);
    const context=await readRegionContext({type:'region',targetId:regionKey,month},data);
    return {...projectRegion(item,month,context,await readRegionLocation(regionKey)),refreshAvailable:Boolean(regionPreparation)};
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
  async function briefing(customer,ownId) {
    const data=await catalog(),rels=customer.relations.filter(active),own=rels.filter(r=>r.kind==='own');
    ownId=ownId||own[0]?.companyId||null;
    if(ownId&&!own.some(r=>r.companyId===ownId))throw fault('NOT_FOUND','등록한 내 매장을 선택해 주세요.',404);
    const companies=[];
    for(const rel of rels.filter(r=>r.kind==='competitor'||r.companyId===ownId)) {
      const c=data.companies.find(c=>c.companyId===rel.companyId);if(!c)continue;
      let detail=null,unavailable=false;try{detail=await collectionResults?.companyDetail(c.companyId);}catch{unavailable=true;}
      companies.push({companyId:c.companyId,name:c.name,rooms:c.rooms,regionKey:c.regionKey,kind:rel.kind,relationStatus:rel.status,unavailable,
        days:(detail?.current?.daily||[]).filter(d=>d.date>=today()&&d.date<=shift(today(),29))});
    }
    const regions=[],keys=new Set(customer.regions.filter(active).map(r=>r.regionKey));
    const selectedOwn=companies.find(c=>c.kind==='own'&&c.companyId===ownId&&c.relationStatus==='active');
    if(selectedOwn?.regionKey)keys.add(selectedOwn.regionKey);
    for(const key of keys) {
      try{regions.push(await region(customer,key,previousMonth(),data));}
      catch{const r=data.regions.find(r=>r.id===key);if(r)regions.push({region:r,month:previousMonth(),sources:[],availableSources:0,warnings:['저장된 지역 자료를 확인하지 못했습니다.']});}
    }
    return buildBriefing(companies,regions,{today:today(),ownId});
  }
  return {region,briefing,preparation};
}
module.exports={createInsightAnalysis,regionIds,projectRegion,buildBriefing};
