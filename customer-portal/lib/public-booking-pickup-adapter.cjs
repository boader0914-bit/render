'use strict';
// Proof-preserving projection only. The caller authenticates and verifies the
// original file digest. This module never fetches, collects or writes data.
const {VERSION,validatePublicBookingLedger}=require('./public-booking-pickup.cjs');
const labels=Object.freeze({
  PUBLIC_PRODUCT_PROOF_UNAVAILABLE:'현재 업체 응답에는 상품별 이전 관측을 검증할 원문 근거가 없습니다.',
  PUBLIC_LEDGER_SCOPE_MISMATCH:'업체·플레이스 번호 또는 수집 회차의 연결 근거가 일치하지 않습니다.',
  PUBLIC_LEDGER_INVALID:'저장된 상품별 공개예약 근거의 형식을 확인하지 못했습니다.',
  PUBLIC_PRODUCT_RESPONSE_UNVERIFIED:'상품별 응답 성공·수량·객실 단위의 근거를 확인하지 못했습니다.'
});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const company=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const place=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const unavailable=reasonCode=>({status:'unavailable',ledger:null,reasonCode,reason:labels[reasonCode]||'저장된 공개예약 근거를 다시 확인해 주세요.'});
const proofFields=['responseStatus','collectionFailed','errorCode','stockObserved','inventoryObserved','inventoryConflict','salesEvidence','stock','bookingCount'];
function fromImportedLedger(input,{companyId,placeId}={}){
  if(!company(companyId)||!place(placeId)||!object(input)||input.companyId!==companyId||input.placeId!==placeId)return unavailable('PUBLIC_LEDGER_SCOPE_MISMATCH');
  if(!Array.isArray(input.sources)||!input.sources.length||input.sources.some(source=>!Array.isArray(source?.rows)||!source.rows.length))return unavailable('PUBLIC_LEDGER_INVALID');
  const checked=validatePublicBookingLedger(input);
  if(!checked.ok)return unavailable(checked.reasonCode);
  // The calculator also accepts incomplete evidence to explain excluded dates.
  // An import adapter is narrower: raw proof fields must all be explicitly
  // present and have valid types; their false/error values are preserved, never
  // converted to success. The calculator decides which dates are usable.
  for(const source of input.sources)for(const row of source.rows){
    if(!proofFields.every(key=>Object.hasOwn(row,key))||!Number.isInteger(row.responseStatus)||row.responseStatus<100||row.responseStatus>599
      ||typeof row.collectionFailed!=='boolean'||!(row.errorCode===null||typeof row.errorCode==='string'&&row.errorCode.length<=180&&!/[\x00-\x1f\x7f]/.test(row.errorCode))
      ||['stockObserved','inventoryObserved','inventoryConflict'].some(key=>typeof row[key]!=='boolean')||row.salesEvidence!=='bookingCount'
      ||!(row.stock===null||count(row.stock))||!(row.bookingCount===null||count(row.bookingCount)))return unavailable('PUBLIC_PRODUCT_RESPONSE_UNVERIFIED');
  }
  return {status:'ready',ledger:checked.ledger,ledgerDigest:checked.ledgerDigest,reasonCode:null,reason:null};
}
function fromCollection(payload,{companyId,placeId}={}){
  if(!company(companyId)||!place(placeId)||!object(payload))return unavailable('PUBLIC_LEDGER_SCOPE_MISMATCH');
  const result=payload.result,ids=[result?.companyId,payload.companyDetail?.companyId,payload.companyDetail?.basics?.companyId].filter(value=>value!==undefined&&value!==null);
  if(!ids.length||ids.some(value=>value!==companyId))return unavailable('PUBLIC_LEDGER_SCOPE_MISMATCH');
  // Ordinary product.days omit room units, raw response flags and file digests.
  // Their weaker "observed" status must never manufacture those proof fields.
  if(!object(payload.publicBookingPickupLedger))return unavailable('PUBLIC_PRODUCT_PROOF_UNAVAILABLE');
  const adapted=fromImportedLedger(payload.publicBookingPickupLedger,{companyId,placeId});
  if(adapted.status!=='ready')return adapted;
  if(!object(result)||typeof result.runId!=='string'||typeof result.collectedAt!=='string'||!Number.isFinite(Date.parse(result.collectedAt))
    ||!adapted.ledger.sources.some(source=>source.runId===result.runId&&Date.parse(source.collectedAt)===Date.parse(result.collectedAt)))return unavailable('PUBLIC_LEDGER_SCOPE_MISMATCH');
  return adapted;
}
module.exports={VERSION,labels,fromImportedLedger,fromCollection};
