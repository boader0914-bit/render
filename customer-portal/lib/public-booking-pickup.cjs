'use strict';

const {createHash} = require('node:crypto');
const VERSION = 'public-booking-pickup-ledger-v1';
const CALCULATION_VERSION = 'public-booking-pickup-v1';
const DAY = 86400000;
const LIMITS = Object.freeze({sources:100, productsPerSource:10000, rowsPerSource:366000, selectedDays:3660});
const REASONS = Object.freeze({
  LEDGER_NOT_AVAILABLE:'저장 원본의 공개예약 비교 근거가 없습니다.',
  LEDGER_INVALID:'저장 원본의 비교 근거 형식을 확인해야 합니다.',
  SOURCE_CONTEXT_MISMATCH:'선택한 업체와 저장 원본의 업체 번호가 일치하지 않습니다.',
  SOURCE_DIGEST_MISMATCH:'저장 원본의 무결성 확인값이 일치하지 않습니다.',
  SOURCE_OBSERVATION_CONFLICT:'같은 관측 시각에 서로 다른 원본이 있어 비교를 보류합니다.',
  NO_PREVIOUS_OBSERVATION:'같은 숙박일을 비교할 이전 저장 원본이 없습니다.',
  NO_SELECTED_DATE_OVERLAP:'최근 두 원본에 선택한 숙박일이 함께 포함되지 않습니다.',
  PRODUCT_SET_CHANGED:'최근 두 원본의 숙박상품 구성이 달라 비교를 보류합니다.',
  PUBLIC_RESPONSE_UNVERIFIED:'선택 숙박일의 공개예약 응답·수량을 확인하지 못했습니다.',
  STOCK_BASIS_CHANGED:'같은 상품의 재고 기준이 달라 해당 숙박일을 비교에서 제외했습니다.',
  DUPLICATE_PRODUCT_CONFLICT:'같은 상품·숙박일의 중복 원본이 서로 달라 비교에서 제외했습니다.',
  PUBLIC_PICKUP_REFERENCE:'같은 숙박일의 공개예약 관측 수량 변화입니다. 실제 신규 예약·취소 확정 수량과 구별합니다.'
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max=180) => typeof value==='string' && value.length>0 && value.length<=max && !/[\u0000-\u001f\u007f]/.test(value);
const id = value => typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value);
const companyId = value => typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,179}$/.test(value);
const placeId = value => typeof value==='string' && /^[1-9]\d{0,19}$/.test(value);
const count = value => Number.isSafeInteger(value) && value>=0;
const signed = value => Number.isSafeInteger(value);
const sha = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value==='string' && /^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const instant = value => typeof value==='string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(value)
  && date(value.slice(0,10)) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const kst = time => new Date(time+9*3600000).toISOString().slice(0,10);
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(object(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const pick = (value,keys) => Object.fromEntries(keys.map(key=>[key,value[key]]));
const PRODUCT_KEYS = ['bizItemId','productType','listType','availabilityUnit'];
const ROW_KEYS = ['companyId','placeId','runId','collectedAt','bizItemId','productType','listType','availabilityUnit','date','stock','bookingCount','responseStatus','collectionFailed','errorCode','stockObserved','inventoryObserved','inventoryConflict','salesEvidence'];
const sum = values => {let result=0;for(const value of values){if(!signed(value)||!signed(result+value))return null;result+=value;}return result;};

// sourceDigest is the immutable SHA-256 of the stored original file. This
// calculator validates its format and carries it through, without pretending to
// re-read that original file. The importing server verifies the file hash.
function normalizedSource(source){
  return {runId:source.runId,collectedAt:new Date(instant(source.collectedAt)).toISOString(),sourceDigest:source.sourceDigest,
    products:source.products.map(row=>pick(row,PRODUCT_KEYS)).sort((a,b)=>a.bizItemId.localeCompare(b.bizItemId)),
    rows:source.rows.map(row=>({...pick(row,ROW_KEYS),collectedAt:new Date(instant(row.collectedAt)).toISOString()}))
      .sort((a,b)=>a.date.localeCompare(b.date)||a.bizItemId.localeCompare(b.bizItemId)||JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))))};
}
function validatePublicBookingLedger(input){
  const invalid=(reasonCode,detail=null)=>({ok:false,reasonCode,reason:REASONS[reasonCode],...(detail?{detail}:{})});
  if(!object(input)||input.version!==VERSION||!companyId(input.companyId)||!placeId(input.placeId)||!Array.isArray(input.sources)
    ||input.sources.length>LIMITS.sources)return invalid('LEDGER_INVALID');
  const sources=[],identities=new Map(),runIdentities=new Map();
  for(const source of input.sources){
    if(!object(source)||!id(source.runId)||instant(source.collectedAt)===null||!sha(source.sourceDigest)
      ||!Array.isArray(source.products)||!source.products.length||source.products.length>LIMITS.productsPerSource
      ||!Array.isArray(source.rows)||source.rows.length>LIMITS.rowsPerSource)return invalid('LEDGER_INVALID');
    const products=new Map();
    for(const row of source.products){
      if(!object(row)||!id(row.bizItemId)||row.productType!=='lodging'||!text(row.listType)||!text(row.availabilityUnit))return invalid('LEDGER_INVALID');
      const product=pick(row,PRODUCT_KEYS),old=products.get(row.bizItemId);
      if(old&&JSON.stringify(old)!==JSON.stringify(product))return invalid('PRODUCT_SET_CHANGED');
      products.set(row.bizItemId,product);
    }
    for(const row of source.rows){
      if(!object(row)||row.companyId!==input.companyId||row.placeId!==input.placeId||row.runId!==source.runId
        ||instant(row.collectedAt)!==instant(source.collectedAt))return invalid('SOURCE_CONTEXT_MISMATCH');
      if(!id(row.bizItemId)||row.productType!=='lodging'||!date(row.date)||!text(row.listType)||!text(row.availabilityUnit)
        ||!products.has(row.bizItemId))return invalid('LEDGER_INVALID');
      const scalar=value=>value===undefined||value===null||typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'||typeof value==='string'&&value.length<=180;
      if(['stock','bookingCount','responseStatus','collectionFailed','errorCode','stockObserved','inventoryObserved','inventoryConflict','salesEvidence'].some(key=>!scalar(row[key])))return invalid('LEDGER_INVALID');
      const declared=products.get(row.bizItemId);
      if(row.listType!==declared.listType||row.availabilityUnit!==declared.availabilityUnit)return invalid('PRODUCT_SET_CHANGED');
    }
    const normalized=normalizedSource({...source,products:[...products.values()]});
    if(source.normalizedDigest!==undefined&&(!sha(source.normalizedDigest)||source.normalizedDigest!==digest(normalized)))return invalid('SOURCE_DIGEST_MISMATCH');
    const key=source.runId+'\u0000'+normalized.collectedAt,old=identities.get(key),sourceHash=digest(normalized);
    const oldRun=runIdentities.get(source.runId);
    if(oldRun&&oldRun!==key)return invalid('SOURCE_OBSERVATION_CONFLICT');
    if(old&&old.hash!==sourceHash)return invalid('SOURCE_OBSERVATION_CONFLICT');
    if(!old){identities.set(key,{hash:sourceHash});runIdentities.set(source.runId,key);sources.push(normalized);}
  }
  sources.sort((a,b)=>Date.parse(a.collectedAt)-Date.parse(b.collectedAt)||a.runId.localeCompare(b.runId));
  const ledger={version:VERSION,companyId:input.companyId,placeId:input.placeId,sources};
  const ledgerDigest=digest(ledger);
  if(input.ledgerDigest!==undefined&&(!sha(input.ledgerDigest)||input.ledgerDigest!==ledgerDigest))return invalid('SOURCE_DIGEST_MISMATCH');
  return {ok:true,ledger,ledgerDigest};
}
function empty(reasonCode,options={},excludedDates=[]){
  return {companyId:companyId(options.companyId)?options.companyId:null,placeId:placeId(options.placeId)?options.placeId:null,calculationVersion:CALCULATION_VERSION,
    status:'unavailable',publicOnly:true,publicChange:null,previousPublic:null,currentPublic:null,days:0,rows:[],
    reasonCode,reason:REASONS[reasonCode],excludedDates,source:null,limitations:[],wholeReservationRestored:false,inferredChange:null,estimatedRevenue:null,
    actionable:false,executionAllowed:false};
}
function rowVerified(row){
  return row.responseStatus===200&&row.collectionFailed===false&&(row.errorCode===null||row.errorCode==='')
    &&row.stockObserved===true&&row.inventoryObserved===true&&row.inventoryConflict===false&&row.salesEvidence==='bookingCount'
    &&count(row.stock)&&count(row.bookingCount)&&row.bookingCount<=row.stock;
}
function rowsByDate(source){
  const dates=new Map();
  for(const row of source.rows){
    const value=dates.get(row.date)||{products:new Map(),conflicts:new Set()};
    const old=value.products.get(row.bizItemId);
    if(!value.conflicts.has(row.bizItemId)){
      if(old&&JSON.stringify(stable(old))!==JSON.stringify(stable(row))){value.products.delete(row.bizItemId);value.conflicts.add(row.bizItemId);}
      else if(!old)value.products.set(row.bizItemId,row);
    }
    dates.set(row.date,value);
  }
  return dates;
}
function computePublicBookingPickup(input,options={}){
  if(!object(options))return empty('LEDGER_INVALID');
  if(input===null||input===undefined)return empty('LEDGER_NOT_AVAILABLE',options);
  const checked=validatePublicBookingLedger(input);
  if(!checked.ok)return empty(checked.reasonCode,options);
  const validDates=Array.isArray(options.dates)&&options.dates.length>0&&options.dates.length<=LIMITS.selectedDays
    &&options.dates.every(date)&&new Set(options.dates).size===options.dates.length;
  if(!companyId(options.companyId)||!placeId(options.placeId)||!date(options.asOf)||!validDates)return empty('LEDGER_INVALID',options);
  const ledger=checked.ledger;
  if(ledger.companyId!==options.companyId||ledger.placeId!==options.placeId)return empty('SOURCE_CONTEXT_MISMATCH',options);
  const eligible=ledger.sources.filter(source=>kst(Date.parse(source.collectedAt))<=options.asOf)
    .sort((a,b)=>Date.parse(b.collectedAt)-Date.parse(a.collectedAt)||b.runId.localeCompare(a.runId));
  if(eligible.length<2)return empty('NO_PREVIOUS_OBSERVATION',options);
  // A same-time alternate run is ambiguous, not an earlier observation. Do not
  // bypass it by silently selecting a third, older source.
  if(eligible[0].collectedAt===eligible[1].collectedAt)return empty('SOURCE_OBSERVATION_CONFLICT',options);
  const current=eligible[0],previous=eligible[1];
  if(eligible.filter(source=>source.collectedAt===previous.collectedAt).length!==1)return empty('SOURCE_OBSERVATION_CONFLICT',options);
  const previousIds=previous.products.map(row=>row.bizItemId),currentIds=current.products.map(row=>row.bizItemId);
  if(JSON.stringify(previousIds)!==JSON.stringify(currentIds))return empty('PRODUCT_SET_CHANGED',options);
  const previousProducts=new Map(previous.products.map(row=>[row.bizItemId,row]));
  for(const row of current.products){
    const old=previousProducts.get(row.bizItemId);
    if(old.listType!==row.listType||old.availabilityUnit!==row.availabilityUnit)return empty('PRODUCT_SET_CHANGED',options);
  }
  const before=rowsByDate(previous),after=rowsByDate(current),rows=[],excludedDates=[];
  let overlap=0;
  for(const stayDate of [...options.dates].sort()){
    const a=before.get(stayDate),b=after.get(stayDate);
    if(!a||!b){excludedDates.push({date:stayDate,reasonCode:'NO_SELECTED_DATE_OVERLAP',reason:REASONS.NO_SELECTED_DATE_OVERLAP});continue;}
    overlap++;
    let reasonCode=null;
    if(a.conflicts.size||b.conflicts.size)reasonCode='DUPLICATE_PRODUCT_CONFLICT';
    else if(a.products.size!==previousIds.length||b.products.size!==currentIds.length)reasonCode='PUBLIC_RESPONSE_UNVERIFIED';
    const evidence=[];
    if(!reasonCode)for(const productId of previousIds){
      const old=a.products.get(productId),row=b.products.get(productId);
      if(!old||!row||!rowVerified(old)||!rowVerified(row)||kst(Date.parse(previous.collectedAt))>stayDate||kst(Date.parse(current.collectedAt))>stayDate){reasonCode='PUBLIC_RESPONSE_UNVERIFIED';break;}
      if(old.stock!==row.stock){reasonCode='STOCK_BASIS_CHANGED';break;}
      const delta=row.bookingCount-old.bookingCount;
      evidence.push({bizItemId:productId,productType:'lodging',listType:row.listType,availabilityUnit:row.availabilityUnit,
        stock:row.stock,previousPublic:old.bookingCount,currentPublic:row.bookingCount,publicChange:delta,
        previousRowDigest:digest(old),currentRowDigest:digest(row)});
    }
    if(reasonCode){excludedDates.push({date:stayDate,reasonCode,reason:REASONS[reasonCode]});continue;}
    const previousPublic=sum(evidence.map(row=>row.previousPublic)),currentPublic=sum(evidence.map(row=>row.currentPublic)),publicChange=sum(evidence.map(row=>row.publicChange));
    if(previousPublic===null||currentPublic===null||publicChange===null){excludedDates.push({date:stayDate,reasonCode:'PUBLIC_RESPONSE_UNVERIFIED',reason:REASONS.PUBLIC_RESPONSE_UNVERIFIED});continue;}
    rows.push({date:stayDate,previousPublic,currentPublic,publicChange,productCount:evidence.length,matchedProductIds:[...previousIds],productEvidence:evidence});
  }
  if(!rows.length)return empty(!overlap?'NO_SELECTED_DATE_OVERLAP':excludedDates[0]?.reasonCode||'PUBLIC_RESPONSE_UNVERIFIED',options,excludedDates);
  const previousPublic=sum(rows.map(row=>row.previousPublic)),currentPublic=sum(rows.map(row=>row.currentPublic)),publicChange=sum(rows.map(row=>row.publicChange));
  if(previousPublic===null||currentPublic===null||publicChange===null)return empty('PUBLIC_RESPONSE_UNVERIFIED',options,excludedDates);
  return {companyId:ledger.companyId,placeId:ledger.placeId,calculationVersion:CALCULATION_VERSION,status:'reference',publicOnly:true,
    publicChange,previousPublic,currentPublic,days:rows.length,rows,reasonCode:'PUBLIC_PICKUP_REFERENCE',reason:REASONS.PUBLIC_PICKUP_REFERENCE,excludedDates,
    source:{previousRunId:previous.runId,currentRunId:current.runId,previousObservedAt:previous.collectedAt,currentObservedAt:current.collectedAt,
      sourceDigests:{previous:previous.sourceDigest,current:current.sourceDigest},ledgerDigest:checked.ledgerDigest},
    limitations:[REASONS.PUBLIC_PICKUP_REFERENCE,'두 저장 원본의 동일 숙박상품·수량 기준에서 직접 확인한 공개예약만 비교합니다.',
      '방막기·데이유즈 공유객실·전체 예약률·매출의 복구를 뜻하지 않습니다.',
      ...(rows.length<options.dates.length?['선택 '+options.dates.length+'일 중 정상 비교 가능한 '+rows.length+'일만 반영했습니다. 나머지 날짜는 미확인입니다.']:[])],
    wholeReservationRestored:false,inferredChange:null,estimatedRevenue:null,actionable:false,executionAllowed:false};
}

module.exports={VERSION,CALCULATION_VERSION,LIMITS,REASONS,validatePublicBookingLedger,computePublicBookingPickup};
