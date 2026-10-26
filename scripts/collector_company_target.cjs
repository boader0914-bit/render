'use strict';
function normalizeTargetPlaceId(value,searchMode){
  if(value===undefined||value==='')return '';
  if(typeof value!=='string'||!/^\d{1,30}$/.test(value)||value.startsWith('0')||searchMode!=='company')throw Object.assign(new Error('COLLECTION_TARGET_INVALID'),{code:'COLLECTION_TARGET_INVALID'});
  return value;
}
function filterTargetPlaceRows(rows,placeId){return placeId?rows.filter(row=>String(row.place_id||'')===placeId):rows;}
function assertCompanyTargetPresent(naver,placeId){
  if(placeId&&![...(naver.overall||[]),...(naver.ads||[])].some(row=>String(row.place_id||'')===placeId))throw Object.assign(new Error('COLLECTION_TARGET_PLACE_NOT_FOUND'),{code:'COLLECTION_TARGET_PLACE_NOT_FOUND',statusCode:Number(naver.status)||undefined});
}
module.exports={normalizeTargetPlaceId,filterTargetPlaceRows,assertCompanyTargetPresent};
