(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightComparisonReadiness=api;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  // Presentation only. All reservation, revenue and eligibility values belong
  // to the central integrated report. Never fetch, repair, persist or collect.
  const VERSION='insight-comparison-v1',DAY=86400000,MAX_DAYS=3660;
  const LABELS=Object.freeze({
    DUPLICATE_COMPANY:'같은 업체는 한 번만 표시합니다.',DUPLICATE_STAY_DATE:'같은 숙박일의 자료가 중복되어 확인이 필요합니다.',
    INVALID_COMPANY:'등록 업체 연결을 확인해야 합니다.',INVALID_PERIOD:'숙박기간과 관측 기준일을 확인해야 합니다.',
    REGION_UNKNOWN:'업체 소재지 연결을 확인해야 합니다.',REGION_DIFFERENT:'다른 지역의 수요 배경을 함께 확인하세요.',
    INDUSTRY_UNKNOWN:'업종 연결을 확인해야 합니다.',INDUSTRY_DIFFERENT:'업종이 달라 상품·운영 참고로 봅니다.',
    PURPOSE_UNSPECIFIED:'비교 목적이 없어 참고자료로 표시합니다.',REFERENCE_PURPOSE:'상품·운영 참고 대상으로 선택했습니다.',
    CAPACITY_UNKNOWN:'객실 기준 미확인으로 예약률 비교를 보류합니다.',CAPACITY_CONFLICT:'객실 기준 충돌로 예약률 비교를 보류합니다.',
    CAPACITY_REVIEW_REQUIRED:'객실 기준을 검토해야 합니다.',QUANTITY_MISSING:'예약 수량을 확인하지 못했습니다.',
    QUANTITY_INVALID:'예약 수량의 합계나 자료를 확인해야 합니다.',REVENUE_UNKNOWN:'가격 또는 금액을 확인하지 못했습니다.',
    OBSERVATION_UNKNOWN:'관측일을 확인하지 못했습니다.',OBSERVATION_AFTER_CUTOFF:'관측 기준일 뒤의 자료는 제외했습니다.',
    OBSERVATION_STALE:'최근 관측 범위를 벗어난 자료입니다.',OBSERVATION_DAY_DIFFERENT:'관측일이 달라 같은 조건의 비교에서 제외했습니다.',
    OBSERVATION_TIME_UNKNOWN:'관측 시각 확인이 필요합니다.',OBSERVATION_TIME_POLICY_UNSET:'관측 시차 기준이 없어 자동 판단을 보류합니다.',
    OBSERVATION_SKEW_EXCEEDED:'관측 시각 차이가 기준을 넘었습니다.',INSUFFICIENT_COMMON_DAYS:'중앙 집계 기준의 공통 숙박일이 부족합니다.',
    RELATION_UNCONFIRMED:'내 매장 연결이 확인 대기 중입니다.',COMPANY_MONTH_NOT_OBSERVED:'해당 월의 저장 관측 자료가 없습니다.',
    MONTH_NOT_OBSERVED:'해당 월의 저장 관측 자료가 없습니다.',COMPANY_MONTH_UNAVAILABLE:'해당 월의 저장 자료를 불러오지 못했습니다.',
    COMPANY_MONTHS_UNAVAILABLE:'저장된 숙박월 목록을 확인하지 못했습니다.',COMPANY_SOURCE_UNAVAILABLE:'업체의 일부 저장 자료를 확인하지 못했습니다.',
    COMPANY_INTEGRATION_UPDATING:'통합 자료를 갱신하고 있습니다.',COMPANY_INTEGRATION_PENDING:'통합 자료 계산을 기다리고 있습니다.',
    COMPANY_DETAIL_NOT_FOUND:'저장된 업체 자료를 찾지 못했습니다.',COMPANY_INTEGRATION_FAILED:'통합 자료의 계산 또는 저장 확인에 실패했습니다.',
    COMPANY_OBSERVATION_INSUFFICIENT:'이 기간의 객실 수량을 확인할 관측 자료가 없습니다.',
    SAVED_COMPANY_SOURCE_INVALID:'저장된 월별 자료의 대상 또는 형식을 확인해야 합니다.',SAVED_COMPANY_SOURCE_UNAVAILABLE:'저장된 월별 자료를 읽지 못했습니다.',
    COMPANY_CAPACITY_REVIEW_CHANGED:'현재 객실 기준과 저장 자료가 달라 확인이 필요합니다.',COMPANY_DETAIL_SOURCE_CHANGED:'업체 원본이 변경되어 최신 결과 확인이 필요합니다.',
    COMPANY_DETAIL_MASTER_INVALID:'업체 기본자료의 형식을 확인해야 합니다.',COMPANY_DETAIL_SOURCE_UNAVAILABLE:'업체 관측 자료를 읽지 못했습니다.',
    COMPANY_DETAIL_CACHE_WRITE_FAILED:'확인한 업체 자료의 임시 저장에 실패했습니다.',COMPANY_INTEGRATION_STORE_UNAVAILABLE:'월별 통합 자료를 읽지 못했습니다.',
    COMPANY_SOURCE_REVISION_UNAVAILABLE:'업체 원본의 변경 여부를 확인하지 못했습니다.',COMPANY_SOURCE_REVISION_INDEX_INVALID:'업체 원본의 변경 기록을 확인하지 못했습니다.',
    SOURCE_CONFIRMATION_REQUIRED:'자료 연결 사유를 확인해야 합니다.',LEGACY_COMPARISON:'이전 비교 기준의 저장 자료입니다. 현재 기준 확인이 필요합니다.',
    DAILY_DETAIL_UNAVAILABLE:'날짜별 확보 범위를 확인할 자료가 없습니다.',CONTEXT_MISMATCH:'선택한 기간·관측 기준과 자료가 일치하지 않습니다.',
    PREVIEW_RESULT:'저장 자료 미리보기입니다. 계산 완료 전에는 비교 판단을 보류합니다.',COMPARISON_UNAVAILABLE:'같은 조건의 비교 결과가 아직 없습니다.',
    PARTIAL_INVENTORY:'상품 재고 일부를 확인하지 못했습니다.',SHARED_DAYUSE_UNVERIFIED:'숙박·데이유즈의 공유 수량 확인이 부족합니다.',
    MISSING_RESPONSE:'예약 응답과 수량을 확인하지 못했습니다.',RUN_BLOCKED:'수집 접근 제한으로 자료를 확인하지 못했습니다.',
    RUN_FAILED:'수집 실패로 자료를 확인하지 못했습니다.',RUN_INTERRUPTED:'수집 중단으로 자료를 확인하지 못했습니다.',RUN_UNKNOWN:'수집 결과를 확인해야 합니다.',
    LEGACY_INVENTORY_EVIDENCE:'구형 자료의 상품별 재고 근거를 확인해야 합니다.',POST_STAY_OBSERVATION:'숙박일 이후에 관측한 자료입니다.',
    CAPACITY_RECALCULATION_UNAVAILABLE:'객실 기준으로 수량을 다시 계산할 근거가 부족합니다.',QUANTITY_CONFLICT:'예약 수량의 근거가 서로 다릅니다.',
    INVENTORY_CONFLICT:'객실 재고의 근거가 서로 다릅니다.',RATE_UNAVAILABLE:'예약률 계산 근거를 확인해야 합니다.'
  });
  const MISSING_CODES=Object.freeze({partial_inventory:'PARTIAL_INVENTORY',shared_dayuse_unverified:'SHARED_DAYUSE_UNVERIFIED',missing_response:'MISSING_RESPONSE',run_blocked:'RUN_BLOCKED',run_failed:'RUN_FAILED',run_interrupted:'RUN_INTERRUPTED',run_unknown:'RUN_UNKNOWN',legacy_inventory_evidence:'LEGACY_INVENTORY_EVIDENCE',post_stay_observation:'POST_STAY_OBSERVATION',capacity_recalculation_unavailable:'CAPACITY_RECALCULATION_UNAVAILABLE',quantity_conflict:'QUANTITY_CONFLICT',inventory_conflict:'INVENTORY_CONFLICT',rate_unavailable:'RATE_UNAVAILABLE'});
  const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v)?v:null;
  const text=(v,fallback='')=>typeof v==='string'&&v.length<=200&&!/[\u0000-\u001f\u007f]/.test(v)?v:fallback;
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v?v:null;
  const instant=v=>typeof v==='string'&&v.length<=50&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
  const codes=v=>[...new Set((Array.isArray(v)?v:[]).slice(0,64).map(c=>Object.hasOwn(LABELS,c)?c:'SOURCE_CONFIRMATION_REQUIRED'))];
  const code=v=>Object.hasOwn(LABELS,v)?v:'SOURCE_CONFIRMATION_REQUIRED';
  const scope=v=>['quantity','reservationRate','revenue','timing','action','company'].includes(v)?v:'company';
  const issue=(value,extra={})=>({code:code(value),label:LABELS[code(value)],scope:'company',...extra});
  const status=v=>['ready','partial','unavailable'].includes(v)?v:'unavailable';
  function periodOf(r){
    const start=date(r?.period?.start),end=date(r?.period?.end),asOf=date(r?.asOf||r?.period?.start),days=start&&end?(Date.parse(end)-Date.parse(start))/DAY+1:0;
    const empty=r?.period?.start===null&&r?.period?.end===null&&r?.period?.days===0;
    const valid=!!asOf&&(empty||Number.isSafeInteger(days)&&days>0&&days<=MAX_DAYS&&r.period.days===days);
    return {start:valid?start:null,end:valid?end:null,days:valid?days:0,asOf,valid};
  }
  const inPeriod=(d,p)=>!!date(d)&&!!p.start&&d>=p.start&&d<=p.end;
  const dates=(values,p)=>[...new Set((Array.isArray(values)?values:[]).slice(0,MAX_DAYS).filter(d=>inPeriod(d,p)))].sort();
  const matching=(q,p)=>q?.period?.start===p.start&&q.period.end===p.end&&q.asOf===p.asOf;
  const allDates=p=>p.start?Array.from({length:p.days},(_,i)=>new Date(Date.parse(p.start)+i*DAY).toISOString().slice(0,10)):[];
  function safeSourceIssue(raw,p){
    const result=issue(raw?.code,{scope:scope(raw?.scope)});
    if(date(raw?.date))result.date=raw.date;
    const start=date(raw?.period?.start),end=date(raw?.period?.end);
    if(start&&end&&end>=start&&(Date.parse(end)-Date.parse(start))/DAY<MAX_DAYS)result.period={start,end};
    else if(typeof raw?.month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(raw.month))result.month=raw.month;
    return result;
  }
  function uniqueIssues(values){
    const seen=new Set();return values.filter(row=>{const key=JSON.stringify([row.code,row.scope,row.date,row.period,row.month]);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function missingRanges(values){
    const result=[];for(const d of values){const prev=result.at(-1);if(prev&&Date.parse(d)-Date.parse(prev.end)===DAY){prev.end=d;prev.days++;}else result.push({start:d,end:d,days:1});}return result;
  }
  const observationDate=value=>instant(value)?new Date(Date.parse(value)+9*3600000).toISOString().slice(0,10):null;
  function partialProof(row,companyId,p){
    const value=row?.partialRevenueEvidence,amount=number(row?.partialConfirmedRevenue),at=observationDate(value?.collectedAt);
    if(row?.quantityStatus==='ready'||row?.missing!==true||row.inventoryConflict===true||row.capacityConflict===true||codes(row?.codes).some(v=>['QUANTITY_INVALID','DUPLICATE_STAY_DATE','CAPACITY_CONFLICT'].includes(v))
      ||amount===null||value?.amount!==amount||value.companyId!==companyId||value.date!==row.date||value.productType!=='lodging'
      ||typeof value.runId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/.test(value.runId)
      ||!at||value.collectedDate!==at||at>p.asOf||at>row.date||!['partial_inventory','capacity_recalculation_unavailable'].includes(value.reason))return null;
    return {date:row.date,amount,runId:value.runId,collectedAt:value.collectedAt,collectedDate:at,reason:value.reason};
  }
  function storedProof(row,p){
    const value=row?.storedReference,at=observationDate(value?.collectedAt),values=[value?.total,value?.sold,value?.publicBookings,value?.phoneBookings];
    if(row?.quantityStatus==='ready'||row?.missing!==true||value?.source!=='stored_normal_observation'||value.reason!=='OBSERVATION_STALE'
      ||value.date!==row.date||codes(row.codes).length!==1||!codes(row.codes).includes('OBSERVATION_STALE')||!values.every(v=>count(v)!==null)||!(value.total>0)
      ||value.sold>value.total||value.sold!==value.publicBookings+value.phoneBookings||!at||value.collectedDate!==at||at>row.date||at>=p.asOf
      ||typeof value.reservationRate!=='number'||!Number.isFinite(value.reservationRate)||Math.abs(value.reservationRate-value.sold/value.total)>1e-10)return null;
    return {date:row.date,total:value.total,sold:value.sold,publicBookings:value.publicBookings,phoneBookings:value.phoneBookings,
      collectedAt:value.collectedAt,collectedDate:at,reservationRate:value.reservationRate,reason:value.reason};
  }
  function companyModel(c,p,report){
    const mode=report.selection&&report.selection.stayMode!=='upcoming30'?'historical':'current';
    const issues=[],q=c.summaryQuality,qualityMatches=!!q&&matching(q,p)&&(!q.mode||q.mode===mode),summary=c.summary||{};
    const contextMismatch=!!q&&!qualityMatches;
    if(contextMismatch)issues.push(issue('CONTEXT_MISMATCH'));
    const summaryAvailable=!contextMismatch;
    let availableDays=summaryAvailable&&count(summary.days)!==null&&summary.days<=p.days?summary.days:null;
    const missing=new Set(),pointDates=new Set(),ambiguous=new Set(),partialByDate=new Map(),storedByDate=new Map();let dailyKnown=false;
    const addRow=row=>{
      if(!inPeriod(row?.date,p))return;
      if(pointDates.has(row.date)){ambiguous.add(row.date);missing.add(row.date);partialByDate.delete(row.date);storedByDate.delete(row.date);issues.push(issue('DUPLICATE_STAY_DATE',{date:row.date,scope:'quantity'}));return;}
      pointDates.add(row.date);
      if(!contextMismatch){
        const partial=partialProof(row,c.companyId,p),stored=storedProof(row,p);
        if(partial)partialByDate.set(row.date,partial);
        if(stored)storedByDate.set(row.date,stored);
      }
      if(row.quantityStatus!=='ready'||row.missing===true){missing.add(row.date);for(const value of codes(row.codes).length?codes(row.codes):['QUANTITY_MISSING'])issues.push(issue(value,{date:row.date,scope:'quantity'}));}
      else for(const value of codes(row.codes))issues.push(issue(value,{date:row.date,scope:value.startsWith('CAPACITY_')?'reservationRate':'quantity'}));
      if(row.missing===true&&Object.hasOwn(MISSING_CODES,row.missingReason)){
        const value=MISSING_CODES[row.missingReason];issues.push(issue(value,{date:row.date,scope:value==='RATE_UNAVAILABLE'?'reservationRate':'quantity'}));
      }
      if(Object.hasOwn(MISSING_CODES,row.latestAttemptReason)){
        const value=MISSING_CODES[row.latestAttemptReason];issues.push(issue(value,{date:row.date,scope:'timing',label:'최근 재확인: '+LABELS[value]+(row.missing===true?'':' 저장된 정상 자료는 유지합니다.')}));
      }
    };
    if(c.reservationSeries){
      if(matching(c.reservationSeries,p)&&c.reservationSeries.companyId===c.companyId&&Array.isArray(c.reservationSeries.points)&&c.reservationSeries.points.length<=MAX_DAYS){dailyKnown=true;c.reservationSeries.points.forEach(addRow);}
      else issues.push(issue('CONTEXT_MISMATCH'));
    }else if(c.reservationPeriods){
      if(matching(c.reservationPeriods,p)&&Array.isArray(c.reservationPeriods.months)&&c.reservationPeriods.months.length<=121){
        let rows=0,weeks=0;dailyKnown=true;
        outer:for(const month of c.reservationPeriods.months)for(const week of Array.isArray(month?.weeks)?month.weeks:[]){
          if(++weeks>600){dailyKnown=false;break outer;}
          for(const row of Array.isArray(week?.daily)?week.daily:[]){if(++rows>MAX_DAYS){dailyKnown=false;break outer;}addRow(row);}
        }
      }else issues.push(issue('CONTEXT_MISMATCH'));
    }
    if(qualityMatches){
      for(const row of (Array.isArray(q.excludedDates)?q.excludedDates:[]).slice(0,MAX_DAYS))if(inPeriod(row?.date,p)){missing.add(row.date);for(const value of codes(row.codes))issues.push(issue(value,{date:row.date,scope:'quantity'}));}
      for(const d of dates(q.duplicateStayDates,p)){missing.add(d);ambiguous.add(d);partialByDate.delete(d);storedByDate.delete(d);issues.push(issue('DUPLICATE_STAY_DATE',{date:d,scope:'quantity'}));}
    }
    if(dailyKnown)for(const d of allDates(p))if(!pointDates.has(d))missing.add(d);
    const inconsistentCoverage=dailyKnown&&(availableDays===null||availableDays!==p.days-missing.size)||ambiguous.size>0;
    if(inconsistentCoverage){availableDays=null;issues.push(issue('CONTEXT_MISMATCH'));}
    const coverageKnown=!inconsistentCoverage&&(dailyKnown||qualityMatches&&availableDays!==null&&(availableDays===p.days||missing.size===p.days-availableDays));
    if(!coverageKnown&&p.days)issues.push(issue('DAILY_DETAIL_UNAVAILABLE'));
    const unknownRevenueDates=summaryAvailable?dates(summary.revenueUnknownDays,p):[];
    unknownRevenueDates.forEach(d=>issues.push(issue('REVENUE_UNKNOWN',{date:d,scope:'revenue'})));
    const sourceIssues=[...(Array.isArray(c.sourceIssues)?c.sourceIssues:[]),...(Array.isArray(report.dataQuality?.issues)?report.dataQuality.issues:[]).filter(row=>row?.scope==='company'&&row.companyId===c.companyId)];
    for(const row of sourceIssues.slice(0,256))if(row?.companyId===c.companyId)issues.push(safeSourceIssue(row,p));
    if(c.unavailable===true||['partial','unavailable'].includes(c.sourceStatus))if(!sourceIssues.length)issues.push(issue('COMPANY_SOURCE_UNAVAILABLE'));
    const rooms=count(c.rooms)>0?c.rooms:null,conflict=issues.some(r=>r.code==='CAPACITY_CONFLICT'),reviewRequired=c.capacityReviewRequired===true||c.capacityStatus==='review_required'||issues.some(r=>r.code==='CAPACITY_REVIEW_REQUIRED');
    const known=rooms!==null&&!issues.some(r=>r.code==='CAPACITY_UNKNOWN');
    const partialRows=[...partialByDate.values()].sort((a,b)=>a.date.localeCompare(b.date)),storedRows=[...storedByDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
    return {companyId:c.companyId,name:text(c.name,'업체'),kind:c.kind,rooms,
      capacity:{known,reviewRequired,conflict,label:conflict?'객실 기준 충돌':reviewRequired?'객실 기준 검토 필요':known?'객실 기준 '+rooms+'실':'객실 기준 미확인'},
      availableDays,missingDays:[...missing].sort(),missingRanges:missingRanges([...missing].sort()),missingDayCount:availableDays===null?null:p.days-availableDays,coverageKnown,
      unknownRevenueDates,knownRevenueSubtotal:summaryAvailable?number(summary.knownRevenueSubtotal??summary.estimatedRevenue):null,revenueUnknownRooms:summaryAvailable?count(summary.revenueUnknownRooms):null,
      quantity:{sold:summaryAvailable?count(summary.sold):null,publicBookings:summaryAvailable?count(summary.publicBookings):null,phoneBookings:summaryAvailable?count(summary.phoneBookings):null},
      partialRevenue:{days:partialRows.length,amount:partialRows.length?partialRows.reduce((sum,row)=>sum+row.amount,0):null,rows:partialRows},
      storedReference:{days:storedRows.length,rows:storedRows},
      unconfirmedDates:[...missing].filter(d=>!partialByDate.has(d)&&!storedByDate.has(d)).sort(),
      sourceStatus:['ready','partial','unavailable'].includes(c.sourceStatus)?c.sourceStatus:issues.length?'partial':'ready',
      lastObservedDay:date(c.lastObservedDay),lastObservedAt:instant(c.lastObservedAt),issues:uniqueIssues(issues)};
  }
  function comparisonModel(row,c,p,ownId,preview,mode){
    const unavailable={status:'unavailable',displayable:false,comparable:false};
    const base={companyId:c.companyId,name:text(c.name,'업체'),regionRelation:'unknown',purpose:'reference',comparable:false,actionable:false,commonDays:null,commonDates:[],minimumDays:null,quantity:{...unavailable},rate:{...unavailable,gapPp:null},revenue:{...unavailable,unknownDates:[]},excludedDates:[],reasons:[],status:'unavailable',legacy:false};
    if(!row)return {...base,reasons:[issue('COMPARISON_UNAVAILABLE')]};
    const current=row.rulesVersion===VERSION&&row.ownId===ownId&&matching(row.basisDetail,p)&&row.basisDetail.mode===mode&&row.quality?.quantity&&row.quality.reservationRate&&row.quality.revenue&&row.quality.timing;
    if(!current)return {...base,legacy:row.rulesVersion===undefined,reasons:[issue(row.rulesVersion===undefined?'LEGACY_COMPARISON':'CONTEXT_MISMATCH')]};
    const q=row.quality,commonDates=dates(row.dates,p),minimumDays=count(row.basisDetail.minCommonDays),valid=Array.isArray(row.dates)&&row.dates.length<=MAX_DAYS&&commonDates.length===row.commonDays&&new Set(row.dates).size===row.dates.length&&row.commonDays===q.quantity.commonDays&&minimumDays!==null&&minimumDays>=7;
    if(!valid)return {...base,reasons:[issue('CONTEXT_MISMATCH')]};
    const reasons=(Array.isArray(row.reasons)?row.reasons:[]).slice(0,128).map(r=>issue(r?.code,{scope:scope(r?.scope)}));
    // Pair-level flags do not identify which company needs room verification.
    // Keep the warning on the pair; never assign it to either company locally.
    if(q.quantity.capacityReviewRequired===true)reasons.push(issue('CAPACITY_REVIEW_REQUIRED',{scope:'action'}));
    if(q.quantity.capacityConflict===true)reasons.push(issue('CAPACITY_CONFLICT',{scope:'reservationRate'}));
    if(q.quantity.capacityKnown===false)reasons.push(issue('CAPACITY_UNKNOWN',{scope:'reservationRate'}));
    if(preview)reasons.push(issue('PREVIEW_RESULT'));
    const excludedDates=[];
    const addExcluded=(dateValue,side,values)=>{if(inPeriod(dateValue,p)){const list=codes(values);excludedDates.push({date:dateValue,codes:list,side,label:list.map(v=>LABELS[v]).join(' ')||LABELS.SOURCE_CONFIRMATION_REQUIRED});}};
    for(const [key,side] of [['ownExcludedDates','own'],['competitorExcludedDates','competitor']])for(const value of (Array.isArray(q.quantity[key])?q.quantity[key]:[]).slice(0,MAX_DAYS))addExcluded(value?.date,side,value?.codes);
    for(const d of dates(q.timing.referenceOnlyDates,p))addExcluded(d,'both',['OBSERVATION_DAY_DIFFERENT']);
    for(const value of (Array.isArray(q.reservationRate.issues)?q.reservationRate.issues:[]).slice(0,MAX_DAYS))addExcluded(value?.date,['own','competitor'].includes(value?.side)?value.side:'both',value?.codes);
    const quantityComparable=!preview&&q.quantity.comparable===true&&commonDates.length>=minimumDays;
    const comparable=!preview&&row.comparable===true&&quantityComparable&&q.reservationRate.comparable===true&&q.quantity.capacityKnown===true&&q.quantity.capacityConflict!==true;
    return {...base,regionRelation:['same','cross','unknown'].includes(row.regionRelation)?row.regionRelation:'unknown',purpose:row.purpose==='direct'?'direct':'reference',
      comparable,actionable:comparable&&row.actionable===true&&q.quantity.capacityReviewRequired!==true,status:comparable?'ready':'partial',commonDays:row.commonDays,commonDates,minimumDays,
      quantity:{status:status(q.quantity.status),displayable:q.quantity.displayable===true,comparable:quantityComparable},
      rate:{status:status(q.reservationRate.status),displayable:comparable&&q.reservationRate.displayable===true,comparable,gapPp:comparable&&typeof row.gapPp==='number'&&Number.isFinite(row.gapPp)?row.gapPp:null},
      revenue:{status:status(q.revenue.status),displayable:q.revenue.displayable===true,comparable:!preview&&quantityComparable&&q.revenue.comparable===true,unknownDates:dates(q.revenue.unknownDates,p)},
      excludedDates:excludedDates.filter((r,i,a)=>a.findIndex(v=>v.date===r.date&&v.side===r.side&&JSON.stringify(v.codes)===JSON.stringify(r.codes))===i).sort((a,b)=>a.date.localeCompare(b.date)),reasons:uniqueIssues(reasons)};
  }
  function build(report,options={}){
    const p=periodOf(report),issues=[],source={rulesVersion:VERSION,generatedAt:instant(report?.generatedAt),checkedAt:instant(report?.responseCache?.checkedAt),refreshing:report?.responseCache?.refreshing===true,refreshFailed:report?.responseCache?.refreshFailed===true,preview:report?.responseCache?.preview===true||report?.responseCache?.state==='preview'||report?.calculation?.mode==='saved_only',mode:report?.selection?.stayMode==='upcoming30'||!report?.selection?'current':'historical'};
    const result={status:'unavailable',period:p,companies:[],comparisons:[],source,issues};
    const ownId=id(options.ownCompanyId??report?.ownId);
    if(!p.valid){issues.push(issue('INVALID_PERIOD'));return result;}
    if(!ownId||ownId!==report?.ownId){issues.push(issue('INVALID_COMPANY'));return result;}
    const companyMap=new Map();
    for(const c of Array.isArray(report?.companies)?report.companies:[])if(id(c?.companyId)&&['own','competitor'].includes(c.kind)&&['active','pending'].includes(c.relationStatus)){
      if(companyMap.has(c.companyId)){issues.push(issue('DUPLICATE_COMPANY'));continue;}companyMap.set(c.companyId,c);
    }
    const own=companyMap.get(ownId);
    if(!own||own.kind!=='own'){issues.push(issue('INVALID_COMPANY'));return result;}
    const requested=Array.isArray(options.comparisonIds)?options.comparisonIds:[...companyMap.values()].filter(c=>c.kind==='competitor').map(c=>c.companyId),seen=new Set([ownId]),selected=[own];
    for(const value of requested){const target=id(value);if(!target||!companyMap.has(target)||companyMap.get(target).kind!=='competitor'){if(target!==ownId)issues.push(issue('INVALID_COMPANY'));else issues.push(issue('DUPLICATE_COMPANY'));continue;}if(seen.has(target)){issues.push(issue('DUPLICATE_COMPANY'));continue;}seen.add(target);selected.push(companyMap.get(target));}
    result.companies=selected.map(c=>companyModel(c,p,report));
    result.comparisons=selected.slice(1).map(c=>{const rows=(Array.isArray(report.comparisons)?report.comparisons:[]).filter(row=>row?.companyId===c.companyId);return comparisonModel(rows.length===1?rows[0]:null,c,p,ownId,source.preview,source.mode);});
    if(source.preview)issues.push(issue('PREVIEW_RESULT'));
    result.issues=uniqueIssues(issues);
    result.status=!p.days?'unavailable':result.issues.length||result.companies.some(c=>c.issues.length||!c.coverageKnown)||result.comparisons.some(c=>!c.comparable)?'partial':'ready';
    return result;
  }
  return Object.freeze({build});
});
