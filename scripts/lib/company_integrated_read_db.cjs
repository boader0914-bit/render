'use strict';

// Read scheduling only. Keep the calculation engine and its source fingerprint
// unchanged: the existing scoped repair owns all source/generation validation.
const {createCompanyIntegratedDb:createEngine}=require('./company_integrated_db.cjs');
const {createScheduledSingleFlight}=require('./scheduled_single_flight.cjs');
const month=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const safeCode=error=>typeof error?.code==='string'&&/^[A-Za-z0-9_:-]{1,100}$/.test(error.code)?error.code:'COMPANY_SELECTED_MONTH_REFRESH_FAILED';
const readFailure=error=>Object.assign(new Error('선택한 숙박월의 최신 자료를 확인하지 못했습니다.'),{code:safeCode(error),statusCode:503});
function verifiedRead(value){
  if(value?.status==='failed'||value?.freshness?.selectedMonthVerificationError)
    throw readFailure({code:value?.freshness?.selectedMonthVerificationError||value?.errorCode});
  return value;
}

function createCompanyIntegratedDb(options={}){
  const engine=createEngine(options),runWork=options.runWork||((operation)=>operation());
  const reads=createScheduledSingleFlight({runWork,kind:'company-selected-month-read'});
  async function selectedRead(companyId,request){
    const previous=verifiedRead(await engine.get(companyId,request)),selected=previous?.selectedMonth,snapshot=previous?.snapshot;
    const canRepair=typeof options.readRevision==='function'&&request.cutoffDate===undefined
      &&['refreshing','updating','pending'].includes(previous?.status)&&month(selected)&&(!request.month||request.month===selected)
      &&previous.companyId===companyId&&snapshot?.target?.type==='company'&&snapshot.target.id===companyId
      &&snapshot.request?.type==='company'&&snapshot.request.targetId===companyId&&snapshot.request.month===selected
      &&Array.isArray(snapshot.daily)&&snapshot.summary?.lodging;
    if(!canRepair)return previous;
    try{
      // refreshMonth leaves every durable job, its remaining months, generation
      // and queue order intact. It verifies the selected source and publishes
      // the matching certificate atomically under the original analytical lease.
      await engine.refreshMonth(companyId,{month:selected});
      // Never manufacture ready from the repair return value. A concurrent
      // source/job change can invalidate its proof before this final read.
      return verifiedRead(await engine.get(companyId,request));
    }catch(error){
      // An HTTP 200 failed projection could replace the BFF's last normal
      // memory entry. Fail the read instead; the engine keeps its old files and
      // the BFF retains its previous display with refreshFailed=true.
      throw readFailure(error);
    }
  }
  return {...engine,get(companyId,request={}){
    // A saved preview must remain a read of the last stored view. The normal
    // web route opts into scoped verification separately from month discovery,
    // so it does not change existing unknown-period/cutoff semantics.
    if(request.savedPreview===true||request.knownMonthsOnly!==true
      &&(request.verifySelectedMonth!==true||request.cutoffDate!==undefined))return engine.get(companyId,request);
    // Publish only a small group before admission. Actual source promises start
    // or join after ownership, including callers nested inside an existing view.
    const fallback=()=>reads.run(JSON.stringify([companyId,request.month||'',request.cutoffDate||'',request.knownMonthsOnly===true]),()=>selectedRead(companyId,request));
    if(request.verifySelectedMonth!==true||request.cutoffDate!==undefined||typeof options.runCheckpointRead!=='function')return fallback();
    return (async()=>{
      const cached=await options.runCheckpointRead(info=>engine.tryCachedMonth(companyId,{month:request.month,budgetMs:750,signal:info?.signal}),{kind:'company-month-cached-verification'});
      return cached||fallback();
    })();
  }};
}

module.exports={createCompanyIntegratedDb};
