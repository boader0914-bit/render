'use strict';
// Tiny, read-only projection for Insight comparisons. IDs match the central
// industry registry. Stored category labels are exact matches; company names,
// keywords, addresses and facilities are never used to infer an industry.
const INDUSTRY_IDS=Object.freeze(['glamping','campground','caravan','pension','poolVilla','privateStay','hotelResort','motel']);
const allowed=new Set(INDUSTRY_IDS),object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const count=v=>Number.isSafeInteger(v)&&v>0?v:null;
const labels=Object.freeze({'글램핑':'glamping','캠핑장':'campground','야영장':'campground','오토캠핑':'campground','카라반':'caravan','캐러밴':'caravan','펜션':'pension','팬션':'pension','풀빌라':'poolVilla','독채숙소':'privateStay','독채':'privateStay','한옥':'privateStay','호텔':'hotelResort','리조트':'hotelResort','호텔/리조트':'hotelResort','모텔':'motel'});
function projectIndustryMetadata(company={}) {
  const evidence=[];
  for(const field of ['industryIds','industryTags'])for(const value of Array.isArray(company[field])?company[field]:[]) {
    if(typeof value==='string'&&allowed.has(value)&&!evidence.some(r=>r.industryId===value))evidence.push({industryId:value,source:field==='industryIds'?'stored_industry_id':'stored_industry_tag'});
  }
  for(const value of Array.isArray(company.lodgingTypes)?company.lodgingTypes:[]) {
    const id=typeof value==='string'?labels[value.normalize('NFKC').trim()]:null;
    if(id&&!evidence.some(r=>r.industryId===id))evidence.push({industryId:id,source:'stored_lodging_type'});
  }
  return {industryTags:evidence.map(r=>r.industryId).sort(),industryEvidence:evidence.sort((a,b)=>a.industryId.localeCompare(b.industryId)),industrySource:evidence.length?'stored_category':'unknown'};
}
function projectCapacityMetadata(company={}) {
  const basis=object(company.capacityBasis)?company.capacityBasis:object(company.roomBasis)?company.roomBasis:{};
  const rooms=count(company.capacity??company.rooms),source=['db_review','observed_locked'].includes(basis.source)?basis.source:'unknown';
  const conflict=company.capacityConflict===true||company.capacityStatus==='conflict'||basis.conflict===true;
  const reviewRequired=basis.reviewRequired===true||Array.isArray(basis.warnings)&&basis.warnings.length>0||company.capacityReviewRequired===true||Boolean(rooms&&source==='unknown');
  const status=conflict?'conflict':!rooms||source==='unknown'?'unknown':reviewRequired?'review_required':source==='db_review'?'reviewed':'observed';
  return {rooms,capacityStatus:status,capacityConflict:conflict,capacityReviewRequired:reviewRequired,
    roomBasis:{count:rooms,source,label:source==='db_review'?'관리자 검수값':source==='observed_locked'?'최대 관측 기준 고정 · 미검수':'객실 기준 출처 확인 필요',reviewRequired}};
}
function regionHierarchyFromUnits(units=[]) {
  const local=new Map(units.filter(r=>r?.active===true&&r.selectable===true&&r.level==='local'&&r.unitType!=='general_district').map(r=>[r.regionKey,r]));
  const result=Object.create(null);
  for(const row of units)if(row?.active===true&&row.unitType==='general_district'&&typeof row.regionKey==='string'&&local.has(row.parentRegionKey))result[row.regionKey]=row.parentRegionKey;
  return result;
}
module.exports={INDUSTRY_IDS,projectIndustryMetadata,projectCapacityMetadata,regionHierarchyFromUnits};
