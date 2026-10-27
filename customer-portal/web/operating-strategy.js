(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./comparison-readiness.js'):root.InsightComparisonReadiness);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.InsightOperatingStrategy=api;
})(typeof window!=='undefined'?window:globalThis,function(readinessApi){
  'use strict';
  // Local, deterministic presentation of central daily projections. No source
  // repair, collection, settings, price changes or execution belongs here.
  const VERSION='insight-operating-strategy-v1',DAY=86400000,MAX_DAYS=3660;
  const GROUPS=[{key:'mon_thu',label:'월~목',accept:n=>n>=1&&n<=4},{key:'fri_sun',label:'금~일',accept:n=>n===0||n>=5}];
  const HEURISTIC='검토 기준: 유효 숙박일 7일 이상·각 요일군 2일 이상·예약률 차이 15%p 이상. 통계적 유의성이나 개선 효과를 뜻하지 않습니다.';
  const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:null;
  const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v?v:null;
  const instant=v=>typeof v==='string'&&v.length<=50&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
  const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
  const inPeriod=(d,p)=>!!date(d)&&d>=p.start&&d<=p.end;
  const matching=(v,p)=>!!v&&v.period?.start===p.start&&v.period?.end===p.end&&v.asOf===p.asOf;
  const unique=values=>[...new Set(values)];
  const pct=v=>(v*100).toLocaleString('ko-KR',{maximumFractionDigits:1})+'%';
  const sum=(rows,key)=>rows.length&&rows.every(r=>number(r[key])!==null)?rows.reduce((n,r)=>n+r[key],0):null;
  const same=(a,b)=>a===b||typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<1e-10;
  const allDates=p=>p.valid&&p.days?Array.from({length:p.days},(_,i)=>shift(p.start,i)):[];
  function centralRows(company,p){
    let rows=null,conflict=false;
    const periods=company.reservationPeriods;
    const periodRows=()=>{
      if(!matching(periods,p)||!Array.isArray(periods.months)||periods.months.length>121)return null;
      const result=[];let weeks=0;
      for(const month of periods.months){
        if(!Array.isArray(month?.weeks))return null;
        for(const week of month.weeks){
          if(++weeks>600||!Array.isArray(week?.daily))return null;
          for(const row of week.daily){if(result.length>=MAX_DAYS)return null;result.push(row);}
        }
      }
      return result;
    };
    if(company.reservationSeries){
      const series=company.reservationSeries;
      if(!matching(series,p)||series.companyId!==company.companyId||!Array.isArray(series.points)||series.points.length>MAX_DAYS)return {rows:[],conflict:true};
      rows=series.points;
      // Both representations may exist. Check agreement, never add them.
      if(periods){
        const secondary=periodRows();
        if(!secondary||secondary.length!==rows.length)conflict=true;
        else{
          const second=new Map();
          for(const row of secondary){if(second.has(row?.date))conflict=true;second.set(row?.date,row);}
          for(const row of rows){
            const other=second.get(row?.date);
            const unknown=value=>value&&value.missing===true&&['unknown','conflict'].includes(value.quantityStatus)&&['total','sold','publicBookings','phoneBookings','reservationRate'].every(k=>value[k]===null);
            // A centrally excluded period row may retain its failed/stale
            // observation time, while the series intentionally clears it.
            // Neither representation contributes that day's quantities.
            if(unknown(row)&&unknown(other))continue;
            if(!other||['total','sold','publicBookings','phoneBookings','reservationRate','collectedDate','quantityStatus','missing'].some(k=>!same(row[k],other[k])))conflict=true;
          }
        }
      }
    }else rows=periodRows();
    if(!rows)return {rows:[],conflict:true};
    const map=new Map();
    for(const row of rows){
      if(!inPeriod(row?.date,p)){conflict=true;continue;}
      // A repeated projected date is not another room-night or observation.
      if(map.has(row.date)){conflict=true;continue;}
      map.set(row.date,row);
    }
    return {rows:[...map.values()].sort((a,b)=>a.date.localeCompare(b.date)),conflict};
  }
  function quantityValid(row,p,current){
    if(row.quantityStatus!=='ready'||row.missing!==false||[row.sold,row.publicBookings,row.phoneBookings].some(v=>count(v)===null)||row.sold!==row.publicBookings+row.phoneBookings)return false;
    if(!date(row.collectedDate)||row.collectedDate>p.asOf||current&&row.collectedDate<shift(p.asOf,-7))return false;
    if(row.collectedAt!==null&&row.collectedAt!==undefined){
      if(!instant(row.collectedAt)||new Date(Date.parse(row.collectedAt)+9*3600000).toISOString().slice(0,10)!==row.collectedDate)return false;
    }
    return !Array.isArray(row.codes)||row.codes.every(c=>['CAPACITY_UNKNOWN','CAPACITY_CONFLICT'].includes(c));
  }
  function rateValid(row,rooms){
    return count(row.total)>0&&row.total===rooms&&row.sold<=row.total&&row.inventoryConflict!==true&&row.capacityConflict!==true&&(!Array.isArray(row.codes)||!row.codes.length)&&same(row.reservationRate,row.sold/row.total);
  }
  function segment(rows,calendar,group){
    const selected=calendar.filter(d=>group.accept(new Date(d+'T00:00:00Z').getUTCDay()));
    const values=rows.filter(r=>group.accept(new Date(r.date+'T00:00:00Z').getUTCDay()));
    const supply=sum(values,'total'),sold=sum(values,'sold');
    return {key:group.key,label:group.label,days:values.length,selectedDays:selected.length,missingDays:selected.length-values.length,sold,supply,rate:supply>0&&sold!==null?sold/supply:null};
  }
  function build(report,options={}){
    const ready=readinessApi.build(report,options),p=ready.period;
    const result={version:VERSION,status:'unavailable',period:p,source:ready.source,company:{companyId:null,name:'내 매장',rooms:null},summary:{validDays:null,selectedDays:p.valid?p.days:0,missingDays:null,sold:null,supply:null,rate:null,publicBookings:null,phoneBookings:null,knownRevenueSubtotal:null,unknownRevenueDays:[]},weekdaySegments:[],actions:[],limitations:[]};
    const own=ready.companies[0];
    const addData=(id,title,finding,next,check,basis=[],limits=[],dates=[])=>result.actions.push({id,kind:'data',status:'held',title,finding,next,check,basis,limits,dates,companyId:own?.companyId||null});
    if(!p.valid||!p.days||!own||report?.mode!=='current_briefing'||report?.published!==false){
      result.limitations.push('대상 매장과 숙박기간이 일치하는 저장 근거를 확인하지 못해 운영 판단을 보류합니다.');
      addData('strategy_source','운영 제안에 필요한 저장 근거를 확인하세요.','유효한 내 매장·기간 자료가 없습니다.','현재 선택한 매장과 숙박기간의 저장 자료를 확인하세요.','대상 업체·기간·관측 기준일');
      return result;
    }
    result.company={companyId:own.companyId,name:own.name,rooms:own.rooms};
    const companies=(Array.isArray(report.companies)?report.companies:[]).filter(c=>c?.companyId===own.companyId&&c.kind==='own');
    const raw=companies[0],q=raw?.summaryQuality,central=raw?.summary||{},daily=centralRows(raw||{},p),calendar=allDates(p);
    const context=companies.length===1&&matching(q,p)&&(!q.mode||q.mode===ready.source.mode)&&own.coverageKnown===true&&!daily.conflict&&!ready.issues.some(i=>['DUPLICATE_COMPANY','INVALID_COMPANY','CONTEXT_MISMATCH'].includes(i.code));
    const excluded=new Set((Array.isArray(q?.excludedDates)?q.excludedDates:[]).map(r=>r?.date));
    const quantities=daily.rows.filter(r=>!excluded.has(r.date)&&quantityValid(r,p,ready.source.mode==='current'));
    const centralMatches=context&&count(central.days)===quantities.length&&['sold','supply','publicBookings','phoneBookings'].every(k=>central[k]===null||same(central[k],sum(quantities,k==='supply'?'total':k)))&&(central.reservationRate===null||same(central.reservationRate,sum(quantities,'sold')/sum(quantities,'total')));
    const capacity=own.capacity.known&&!own.capacity.reviewRequired&&!own.capacity.conflict&&raw?.capacityConflict!==true&&!['conflict','review_required','unknown'].includes(raw?.capacityStatus)&&q?.reservationRateAvailable===true;
    const rated=quantities.filter(r=>rateValid(r,own.rooms));
    const shapeConflict=!centralMatches||rated.length!==quantities.length&&capacity;
    const preview=ready.source.preview===true;
    const blocked=shapeConflict||preview||!capacity;
    const review=raw?.relationStatus!=='active'||own.sourceStatus!=='ready'||ready.source.refreshFailed||ready.source.refreshing;
    const proposalStatus=review?'review':'proposal';
    if(centralMatches){
      result.summary={validDays:count(central.days),selectedDays:p.days,missingDays:p.days-central.days,sold:count(central.sold),supply:count(central.supply),rate:number(central.reservationRate),publicBookings:count(central.publicBookings),phoneBookings:count(central.phoneBookings),knownRevenueSubtotal:own.knownRevenueSubtotal,unknownRevenueDays:own.unknownRevenueDates.slice()};
      result.weekdaySegments=GROUPS.map(g=>segment(capacity?rated:[],calendar,g));
    }
    result.status=centralMatches&&quantities.length?'ready':'unavailable';
    if(blocked||review||ready.status!=='ready'||centralMatches&&central.days<p.days||own.unknownRevenueDates.length)if(result.status!=='unavailable')result.status='limited';
    result.limitations.push('저장된 공개 예약·타채널 추정 수량의 검토용 제안입니다. 실제 투숙·판매 가능 재고·수익을 보증하지 않습니다.');
    result.limitations.push('요일은 월~목 / 금~일로만 나눴으며 공휴일·지역 행사·계절 효과를 구분하지 않았습니다.');
    if(raw?.relationStatus==='pending')result.limitations.push('내 매장 연결 확인 대기 상태이므로 모든 운영 제안은 소유자가 검토할 초안입니다.');
    if(own.sourceStatus!=='ready')result.limitations.push('일부 저장 자료의 연결 상태를 확인하지 못해 확보된 날짜의 근거만 검토합니다.');
    if(ready.source.refreshing)result.limitations.push('최신 자료 확인 중이므로 저장 자료를 기준으로 검토합니다.');
    else if(ready.source.refreshFailed)result.limitations.push('최신 확인에 실패해 저장된 정상 근거를 유지했습니다. 실행 전 관측 기준일을 확인하세요.');
    if(preview)result.limitations.push('저장 자료 미리보기여서 최종 운영 제안 판단을 보류합니다.');
    if(!capacity)result.limitations.push('객실 기준이 미확인·충돌·검토 필요 상태여서 예약률 기반 운영 판단을 보류합니다.');
    if(shapeConflict)result.limitations.push('날짜별 수량·기간·관측일과 중앙 집계가 일치하지 않아 운영 판단을 보류합니다.');
    if(centralMatches&&result.summary.unknownRevenueDays.length)result.limitations.push(`금액 미확인 숙박일 ${result.summary.unknownRevenueDays.length}일이 있어 확인된 매출 소계만 표시합니다. 전체 매출·영업이익이 아닙니다.`);
    const past=rated.filter(r=>r.date<p.asOf),future=rated.filter(r=>r.date>=p.asOf);
    const mixed=p.start<p.asOf&&p.end>=p.asOf;
    if(mixed)result.limitations.push('선택기간에 과거와 향후 숙박일이 함께 있어 운영 패턴은 향후 자료를 우선하고 과거 자료와 합쳐 해석하지 않습니다.');
    const candidates=future.length>=7?future:past.length>=7?past:[],retrospective=candidates===past;
    const candidateCalendar=calendar.filter(d=>retrospective?d<p.asOf:d>=p.asOf),parts=GROUPS.map(g=>segment(candidates,candidateCalendar,g));
    const actionLimits=()=>[...result.limitations.filter(t=>/연결 확인 대기|최신|일부 저장/.test(t)),'자동 실행·가격 변경·수익 개선 예측은 포함하지 않습니다.'];
    const addOperation=(a)=>result.actions.push({status:proposalStatus,companyId:own.companyId,...a});
    if(!blocked&&candidates.length>=7&&parts.every(g=>g.days>=2)&&parts.every(g=>g.rate!==null)&&Math.abs(parts[0].rate-parts[1].rate)+1e-10>=0.15){
      const weak=parts[0].rate<parts[1].rate?parts[0]:parts[1],strong=weak===parts[0]?parts[1]:parts[0],group=GROUPS.find(g=>g.key===weak.key);
      const dates=candidates.filter(r=>group.accept(new Date(r.date+'T00:00:00Z').getUTCDay())).map(r=>r.date);
      addOperation({id:'weekday_product_trial',kind:'experiment',title:retrospective?`다음 ${weak.label} 숙박일의 상품 안내를 시험해 보세요.`:`${weak.label} 잔여 객실의 상품 안내를 시험해 보세요.`,finding:`${retrospective?'지난 숙박일':'향후 숙박일'} 관측에서 ${weak.label} ${pct(weak.rate)}(${weak.sold}/${weak.supply}실), ${strong.label} ${pct(strong.rate)}(${strong.sold}/${strong.supply}실)로 차이가 있습니다.`,next:retrospective?'다음 같은 요일의 실제 판매 가능 재고를 확인한 뒤, 기존 혜택·이용 장면 중 한 가지를 상품 설명에 명확히 제시하는 작은 실험을 검토하세요.':'실제 판매 가능 재고를 확인한 뒤, 해당 요일의 기존 혜택·이용 장면 중 한 가지를 상품 설명에 명확히 제시하는 작은 실험을 검토하세요.',check:'같은 요일·비슷한 예약 선행일의 공개 예약 수량과 예약률, 실험 전후 문의 수를 함께 기록하세요. 새 저장 근거가 생긴 뒤 검토하며 개선 원인을 단정하지 않습니다.',basis:[`내 매장 중앙 날짜별 근거 ${candidates.length}일`,`${weak.label} ${weak.days}일 / ${strong.label} ${strong.days}일`,`관측 기준일 ${p.asOf}`],limits:[...actionLimits(),HEURISTIC,...(retrospective?['표시 날짜는 과거 관측 근거입니다. 지난 예약을 변경하는 제안이 아닙니다.']:['향후 예약률은 관측 당시 값이며 최종 실적이 아닙니다.','요일군별 남은 예약 기간이 같지 않아 요일 자체의 영향으로 단정할 수 없습니다.'])],dates});
    }
    const full=(future.length>=7?future:past.length>=7?past:[]).filter(r=>r.sold===r.total&&r.total>0);
    if(!blocked&&full.length){
      const futureFull=full.some(r=>r.date>=p.asOf),dates=full.map(r=>r.date);
      addOperation({id:'full_dates_operation',kind:'operation',title:futureFull?'만실로 관측된 날짜의 입실 운영을 점검하세요.':'다음 수요 집중일의 입실 운영을 준비하세요.',finding:`${futureFull?'향후':'과거'} ${full.length}개 숙박일에서 관측 예약 수량이 객실 기준에 도달했습니다.`,next:futureFull?'예약 장부와 실제 판매 가능 재고를 대조하고 청소·입실 인력과 고객 안내를 점검하세요. 여유 재고가 확인된 다른 날짜 안내 문구를 준비하세요.':'과거 해당 날짜의 청소·입실 동선을 돌아보고, 다음 수요 집중일에 사용할 안내 문구와 인력 배치를 검토하세요.',check:'해당 날짜의 최종 확정 객실·취소 수량과 입실 문의·지연 건수를 기록하세요.',basis:[...dates.map(d=>`${d}: ${own.rooms}/${own.rooms}실`),`관측 기준일 ${p.asOf}`],limits:[...actionLimits(),'만실 관측은 추가 판매나 초과 예약의 근거가 아닙니다.',...(futureFull?['취소·재고 변경으로 관측 뒤 상태가 달라질 수 있습니다.']:['날짜는 과거 관측 근거이며 향후 같은 수요를 보장하지 않습니다.'])],dates});
    }
    const selectedPairs=ready.comparisons;
    const pair=selectedPairs.find(v=>v.comparable&&v.rate.comparable&&typeof v.rate.gapPp==='number'&&Math.abs(v.rate.gapPp)>=15&&!v.legacy);
    if(!blocked&&pair&&result.actions.filter(a=>a.kind!=='data').length<3){
      const external=pair.regionRelation!=='same'||pair.purpose!=='direct'||!pair.actionable;
      addOperation({id:'comparison_product_reference',kind:external?'data':'experiment',status:external?'review':proposalStatus,companyId:pair.companyId,title:external?'비교업체 상품 자료를 운영 참고로 정리하세요.':'공통 날짜의 차이를 바탕으로 상품 설명을 점검하세요.',finding:`${pair.name} · 동일 관측일·숙박일 ${pair.commonDays}일의 내 매장 예약률 차이는 ${pair.rate.gapPp.toLocaleString('ko-KR',{maximumFractionDigits:1})}%p입니다.`,next:external?'이미 제공되거나 저장된 상품 설명·포함 혜택·이용 조건만 사람이 대조할 참고 목록을 검토하세요. 비교 수치에 근거한 운영 변경은 보류합니다.':'저장 근거의 공통 날짜를 먼저 확인하고, 내 매장에 이미 제공하는 강점을 명확히 알리는 설명 실험 한 가지를 검토하세요.',check:external?'같은 숙박기간·지역 관계·상품 조건·관측 시차의 확인 여부를 검토 목록에 표시하세요.':'선택한 설명 변경 항목과 적용일을 기록하고, 다음 동일 요일·비슷한 예약 선행일의 내 매장 공개 예약 수량을 확인하세요.',basis:[`중앙 비교 결과 · 공통 ${pair.commonDays}일`,`지역 관계: ${pair.regionRelation==='cross'?'다른 지역':pair.regionRelation==='same'?'같은 지역':'미확인'}`,`중앙 행동 판단: ${pair.actionable?'허용':'보류'}`],limits:[...actionLimits(),'예약률 차이로 경쟁력·설명 변경 효과·가격 적정성의 원인을 단정하지 않습니다.',...(external?['지역·비교 목적·관측 시차 조건 때문에 운영 참고만 가능합니다. 중앙의 행동 판단 보류를 해제하지 않습니다.','참고 목록의 자동 저장·새 자료 조회·상품 수정은 실행하지 않습니다.']:[])],dates:pair.commonDates.slice()});
    }
    if(blocked||centralMatches&&central.days<p.days||centralMatches&&central.days<7){
      addData('strategy_evidence',blocked?'운영 판단에 필요한 근거를 먼저 검토하세요.':'확보된 숙박일과 미확인 범위를 구분해 검토하세요.',shapeConflict?'기간·날짜별 수량·중앙 집계 사이의 불일치 또는 중복이 있습니다.':preview?'현재 저장 자료는 최종 계산 전 미리보기입니다.':!capacity?'객실 기준에 대한 검토가 필요합니다.':`선택 ${p.days}일 중 수량 확인 ${central.days}일입니다.`,'업체 DB의 저장 근거와 제외 사유를 확인하고, 누락 범위를 표시한 상태로 운영 초안을 검토하세요.','유효 숙박일·객실 기준·동일 기간의 중앙 집계',[`선택기간 ${p.start} ~ ${p.end}`],['자료 보완은 별도 승인 범위입니다. 정기수집 재개나 새 수집을 실행하지 않습니다.'],own.missingDays.slice());
    }
    const unavailablePairs=selectedPairs.filter(v=>!v.comparable||v.legacy);
    if(unavailablePairs.length&&result.actions.filter(a=>a.kind==='data').length<2){
      addData('comparison_held','공통 관측이 부족한 업체의 우열 판단을 보류하세요.',unavailablePairs.map(v=>`${v.name}: 공통 ${v.commonDays===null?'미확인':v.commonDays+'일'}`).join(' · '),'경쟁업체별 같은 숙박일·관측일과 비교 제외 사유를 확인하세요.','중앙 비교 가능 여부와 공통 숙박일 7일 이상',['등록된 선택 업체의 중앙 비교 결과'],['자료가 없는 업체를 예약 0실로 간주하지 않습니다.']);
    }else if(result.summary.unknownRevenueDays.length&&result.actions.filter(a=>a.kind==='data').length<2){
      addData('revenue_partial','매출 미확인 범위를 표시한 채 운영안을 검토하세요.',`금액 미확인 숙박일 ${result.summary.unknownRevenueDays.length}일이 있어 확인된 소계만 표시합니다.`,'가격 변경이나 매출 증가 목표를 정하기 전에 금액 근거의 확보 범위를 확인하세요.','금액 미확인 날짜 수·확인된 매출 소계',['중앙 매출 집계'],['소계를 전체 매출이나 영업이익으로 해석하지 않습니다.'],result.summary.unknownRevenueDays.slice());
    }
    if(!result.actions.length){
      addData('no_pattern','현재 범위에서 뚜렷한 운영 패턴 판단을 보류합니다.','검토 기준을 충족하는 요일 차이 또는 만실 관측을 확인하지 못했습니다.','현재 저장 근거를 보관하고 다음 비교 가능한 자료가 생겼을 때 같은 기준으로 검토하세요.','같은 숙박일·비슷한 예약 선행일의 저장 수량',[],[HEURISTIC]);
    }
    result.limitations=unique(result.limitations);
    return result;
  }
  return Object.freeze({build});
});
