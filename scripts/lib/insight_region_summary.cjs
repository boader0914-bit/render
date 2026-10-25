'use strict';
// Registration-derived, read-only geography. These bindings are deliberately
// independent of full-analysis/preparation/interest-registration permissions.
const {createHash}=require('node:crypto');
const REGION_SUMMARY_REASONS=Object.freeze({
  COMPANY_METADATA_UNAVAILABLE:'등록 업체의 기본자료를 확인할 수 없습니다.',
  COMPANY_REGION_UNKNOWN:'등록 업체의 공식 소재지역 연결을 확인해야 합니다.',
  COMPANY_RELATION_CONFLICT:'같은 업체의 등록 관계가 서로 달라 확인이 필요합니다.',
  INTEREST_REGION_UNKNOWN:'등록한 관심지역의 공식 연결을 확인해야 합니다.'
});
const REGION_SUMMARY_SOURCE_REASONS=Object.freeze({
  REGION_NOT_READY:'지역 자료 연결이 준비되지 않았습니다.',
  REGION_INDICATOR_FAILED:'저장된 지역 지표 일부를 확인하지 못했습니다.',
  REGION_INDICATOR_UNAVAILABLE:'해당 기간의 지역 지표 자료를 이용할 수 없습니다.',
  REGION_INDICATOR_BLOCKED:'해당 기간의 지역 지표 자료 연결이 제한된 상태입니다.',
  REGION_ADDITIONAL_ISSUES:'추가 지표 오류가 있어 일부 사유만 표시합니다.',
  REGION_SOURCE_UNAVAILABLE:'저장된 지역 자료를 읽지 못했습니다.'
});
const key=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=200?value:null;
const text=(value,max=200)=>typeof value==='string'&&!/[\u0000-\u001f\u007f]/.test(value)?value.slice(0,max):'';
const active=row=>row&&['active','pending'].includes(row.status);
const shiftMonth=(month,offset)=>{const[y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+offset,1)).toISOString().slice(0,7);};
function officialRegion(regionKey,data) {
  const original=key(regionKey),mapped=original&&Object.hasOwn(data.regionHierarchy||{},original)?key(data.regionHierarchy[original]):original;
  const region=mapped&&(data.regions||[]).find(r=>r.id===mapped&&r.level==='local');
  return {regionKey:original,analysisRegionKey:region?mapped:null,regionLabel:region?text(region.label)||null:null,hierarchyApplied:Boolean(region&&original!==mapped),regionStatus:region?'ready':'unknown'};
}
function comparisonRegionBindings(customer,data) {
  const grouped=new Map();
  for(const relation of customer?.relations||[]) {
    if(!active(relation)||!['own','competitor'].includes(relation.kind)||!key(relation.companyId))continue;
    const old=grouped.get(relation.companyId);
    if(old){if(old.kind!==relation.kind||old.relationStatus!==relation.status)old.conflict=true;continue;}
    const company=(data.companies||[]).find(c=>c.companyId===relation.companyId);
    grouped.set(relation.companyId,{companyId:relation.companyId,kind:relation.kind,relationStatus:relation.status,...officialRegion(company?.regionKey,data),...(!company?{metadataMissing:true}:{})});
  }
  return [...grouped.values()].map(({conflict,metadataMissing,...row})=>conflict?{...row,analysisRegionKey:null,regionLabel:null,hierarchyApplied:false,regionStatus:'unknown'}:row);
}
function buildRegionSummarySelection(customer,data,{ownId=null,month}={}) {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month||''))throw Object.assign(new Error('조회할 마감월을 확인해 주세요.'),{code:'INVALID_MONTH',statusCode:400});
  const all=comparisonRegionBindings(customer,data),anchor=ownId?all.find(row=>row.companyId===ownId&&row.kind==='own'):null;
  if(ownId&&!anchor)throw Object.assign(new Error('등록한 내 매장을 선택해 주세요.'),{code:'NOT_FOUND',statusCode:404});
  const bindings=all.filter(row=>row.kind==='competitor'||anchor&&row.companyId===anchor.companyId),groups=new Map(),unresolved=[];
  const add=(id,label,kind,companyId)=>{
    const group=groups.get(id)||{region:{id,label},companyIds:[],kinds:[],relationToOwn:anchor?.analysisRegionKey?anchor.analysisRegionKey===id?'same':'cross':'unknown'};
    if(companyId&&!group.companyIds.includes(companyId))group.companyIds.push(companyId);
    if(!group.kinds.includes(kind))group.kinds.push(kind);
    groups.set(id,group);
  };
  for(const binding of bindings) {
    if(binding.analysisRegionKey)add(binding.analysisRegionKey,binding.regionLabel,binding.kind,binding.companyId);
    else {
      const relations=(customer.relations||[]).filter(r=>active(r)&&r.companyId===binding.companyId),conflict=relations.some(r=>r.kind!==binding.kind||r.status!==binding.relationStatus);
      const code=conflict?'COMPANY_RELATION_CONFLICT':!(data.companies||[]).some(c=>c.companyId===binding.companyId)?'COMPANY_METADATA_UNAVAILABLE':'COMPANY_REGION_UNKNOWN';
      unresolved.push({scope:'company',companyId:binding.companyId,kind:binding.kind,regionKey:binding.regionKey,code,reason:REGION_SUMMARY_REASONS[code]});
    }
  }
  const interests=[...new Set((customer.regions||[]).filter(r=>r.status==='active').map(r=>key(r.regionKey)).filter(Boolean))];
  for(const regionKey of interests) {
    // Interest registration already accepts canonical local keys only. A legacy
    // general district is not upgraded into a new permission by this endpoint.
    const region=(data.regions||[]).find(r=>r.id===regionKey&&r.level==='local');
    if(region)add(regionKey,text(region.label)||null,'interest',null);
    else unresolved.push({scope:'interest',companyId:null,kind:'interest',regionKey,code:'INTEREST_REGION_UNKNOWN',reason:REGION_SUMMARY_REASONS.INTEREST_REGION_UNKNOWN});
  }
  const result={schemaVersion:1,mode:'comparison_region_summary',ownId:anchor?.companyId||null,month,source:'datalab_saved',networkAttempted:false,
    bindings,groups:[...groups.values()],unresolved,access:{summaryOnly:true,fullAnalysis:false,preparation:false}};
  const fingerprint=createHash('sha256').update(JSON.stringify([customer?.customerId||null,customer?.accountStatus||null,customer?.revision??null,result])).digest('hex');
  return {value:result,fingerprint};
}
function projectRegionSummary(value,month) {
  if(value?.networkAttempted!==false)throw Object.assign(new Error('저장된 지역 자료만 연결할 수 있습니다.'),{code:'READ_ONLY_SOURCE_REQUIRED',statusCode:503});
  const number=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
  const rows=list=>(list||[]).map(row=>({key:text(row.key),label:text(row.label),value:row.status==='observed'?number(row.value):null,unit:text(row.unit),status:text(row.status)}));
  const point=value=>value?{month:text(value.month),value:number(value.value)}:null;
  const delta=value=>({value:number(value?.value),kind:text(value?.kind)});
  const safeUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&![...url.searchParams.keys()].some(key=>/key|token|secret|password|auth|signature|credential|session|cookie/i.test(key))?url.href:null;}catch{return null;}};
  const start=shiftMonth(month,-11),sources=(value.sources||[]).map(source=>{
    if(source.networkAttempted===true||source.refreshAvailable===true)throw Object.assign(new Error('저장된 지역 자료만 연결할 수 있습니다.'),{code:'READ_ONLY_SOURCE_REQUIRED',statusCode:503});
    const result={key:text(source.key),label:text(source.label),provider:text(source.provider),status:text(source.status),period:text(source.period),periodType:text(source.periodType),keyword:text(source.keyword),normalizationPeriod:text(source.normalizationPeriod),partialMonth:source.partialMonth===true,referenceOnly:source.referenceOnly===true,sourceUrl:safeUrl(source.sourceUrl),retrievedAt:text(source.retrievedAt),sourceUpdatedAt:text(source.sourceUpdatedAt),rows:rows(source.rows)};
    if(Array.isArray(source.series))result.series=source.series.filter(point=>point.month>=start&&point.month<=month).slice(0,12).map(point=>({month:text(point.month),status:text(point.status),retrievedAt:text(point.retrievedAt),rows:rows(point.rows)}));
    if(Array.isArray(source.metrics))result.metrics=source.metrics.map(metric=>({key:text(metric.key),label:text(metric.label),unit:text(metric.unit),observedMonths:Number.isSafeInteger(metric.observedMonths)&&metric.observedMonths>=0?metric.observedMonths:null,latest:point(metric.latest),mom:delta(metric.mom),yoy:delta(metric.yoy),peak:point(metric.peak),low:point(metric.low)}));
    return result;
  });
  const observedRows=list=>(list||[]).some(row=>row.status==='observed'&&row.value!==null);
  const availableSources=sources.filter(source=>observedRows(source.rows)
    ||(source.series||[]).some(point=>point.status==='observed'&&observedRows(point.rows))
    ||(source.metrics||[]).some(metric=>metric.latest&&metric.latest.month>=start&&metric.latest.month<=month&&metric.latest.value!==null)).length;
  const sourceIssues=(value.sourceIssues||[]).map(issue=>{
    const code=Object.hasOwn(REGION_SUMMARY_SOURCE_REASONS,issue.code)?issue.code:'REGION_SOURCE_UNAVAILABLE';
    return {scope:'region',regionId:value.region.id,name:text(value.region.label),month:text(issue.month),period:{start:text(issue.period?.start),end:text(issue.period?.end)},code,reason:REGION_SUMMARY_SOURCE_REASONS[code],...(issue.sourceKey?{sourceKey:text(issue.sourceKey),sourceName:text(issue.sourceName)}:{})};
  }),partial=sourceIssues.length>0||sources.some(source=>['partial','missing','error','failed','blocked','unavailable','publication_pending','not_collected','stale','mapping_missing','needs_key','cooldown'].includes(source.status));
  const sourceStatus=!availableSources?'unavailable':partial?'partial':'ready';
  return {month,window:{start,end:month,months:12},availableSources,sourceStatus,sourceIssues,sources};
}
module.exports={REGION_SUMMARY_REASONS,REGION_SUMMARY_SOURCE_REASONS,comparisonRegionBindings,buildRegionSummarySelection,projectRegionSummary};
