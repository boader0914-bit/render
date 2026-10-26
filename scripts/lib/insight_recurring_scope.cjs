'use strict';
// Stored manifests must state the requested profile explicitly. Defaults or a
// successful HTTP response never prove that thirty dated observations exist.
const day=value=>typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const kstDay=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10):null;
function collectionTarget(value) {
  if(value===undefined||value==='')return '';
  if(typeof value!=='string'||!/^[1-9]\d{0,29}$/.test(value))throw Object.assign(new Error('업체 고유번호를 확인해 주세요.'),{statusCode:400,code:'COLLECTION_TARGET_INVALID'});
  return value;
}
function storedCompanyScopeMatches(run,scope,{observationDay,reused=false,keyword}={}) {
  if(!run||!scope||!day(observationDay)||!day(scope.checkIn)||!day(scope.checkOut)||!Number.isSafeInteger(scope.bookingRangeDays)||scope.bookingRangeDays<1||scope.bookingRangeDays>31||scope.adults!==2
    ||scope.collectionMode!=='precision'||scope.collectionPurpose!=='revenue_detail'||scope.productMode!=='all'||!['inspect','lodging_only','detail'].includes(scope.dayUseMode))return false;
  if(run.checkIn!==scope.checkIn||run.checkOut!==scope.checkOut||Number(run.bookingRangeDays)!==scope.bookingRangeDays||Number(run.adults)!==scope.adults
    ||run.collectionMode!==scope.collectionMode||run.collectionPurpose!==scope.collectionPurpose||run.productMode!==scope.productMode||run.dayUseMode!==scope.dayUseMode
    ||run.collectionQuality?.status!=='complete'||kstDay(run.collectedAt)!==observationDay)return false;
  if(!['company','keyword'].includes(run.searchMode))return false;
  return reused||(run.searchMode==='company'&&run.keyword===keyword&&['1','1-1'].includes(String(run.detailRankRanges||'').trim()));
}
function recurringScopeMatches(run,scope,options={}) {
  const day=options.observationDay;
  if(!scope||scope.checkIn!==day||scope.bookingRangeDays!==30||scope.dayUseMode!=='detail')return false;
  const nextDay=Number.isFinite(Date.parse(day+'T00:00:00Z'))?new Date(Date.parse(day+'T00:00:00Z')+86400000).toISOString().slice(0,10):null;
  return scope.checkOut===nextDay&&storedCompanyScopeMatches(run,scope,options);
}
module.exports={recurringScopeMatches,storedCompanyScopeMatches,kstDay,collectionTarget};
