'use strict';

// Source values stay in their original units. Missing months never become zero.
const shiftMonth = (month, offset) => {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
};
const monthsEnding = (end, count) => Array.from({length: count}, (_, i) => shiftMonth(end, i + 1 - count));
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const SOURCES = [
  ['visitors', '지역 방문자', 'collectVisitorHistory', [['averageDailyVisitors','일평균 방문자','명'],['visitorDays','월간 방문자 누계','인일']]],
  ['stay_spend', '체류·소비 지수', 'collectDemandStrengthHistory', [['stayOverall','체류 지수','지수'],['spendOverall','소비 지수','지수']]],
  ['resource', '관광자원 수요 지수', 'collectResourceDemandHistory', [['service','서비스 수요','지수'],['culture','문화 수요','지수']]],
  ['diversity', '관광 다양성 지수', 'collectDiversityHistory', [['visitor','관광객 다양성','지수'],['spend','소비 다양성','지수'],['international','국제 관광 다양성','지수']]]
];
function assertCache(result) {
  if (result?.networkAttempted || Number(result?.collection?.networkAttemptedMonths || result?.collection?.operationCallsAttempted || 0)) throw new Error('INSIGHT_HISTORY_MUST_BE_CACHE_ONLY');
}
function pointStatus(point) {
  if (point?.status === 'complete') return 'observed';
  if (point?.status === 'publication_pending' || point?.reason === 'period_not_closed') return 'publication_pending';
  if (point?.status === 'partial') return 'partial';
  if (['failed','error'].includes(point?.status)) return 'error';
  return 'missing';
}
function change(current, previous, unit) {
  if (!numeric(current) || !numeric(previous)) return {value:null,kind:'unavailable'};
  if (['지수','상대지수'].includes(unit)) return {value:current-previous,kind:'index_difference'};
  if (previous === 0) return {value:null,kind:'zero_baseline'};
  return {value:(current-previous)/previous*100,kind:'percent'};
}
function metricsFor(series, fields, window) {
  return fields.map(([key,label,unit]) => {
    const points=series.map(p=>({month:p.month,value:p.rows.find(r=>r.key===key)?.value??null}));
    const visible=points.filter(p=>p.month>=window.start&&p.month<=window.end);
    const observed=visible.filter(p=>numeric(p.value));
    const latest=observed.at(-1)||null;
    const valueAt=month=>points.find(p=>p.month===month)?.value??null;
    return {key,label,unit,observedMonths:observed.length,latest,
      mom:latest?change(latest.value,valueAt(shiftMonth(latest.month,-1)),unit):change(null,null,unit),
      yoy:latest?change(latest.value,valueAt(shiftMonth(latest.month,-12)),unit):change(null,null,unit),
      peak:observed.length?observed.reduce((a,b)=>b.value>a.value?b:a):null,
      low:observed.length?observed.reduce((a,b)=>b.value<a.value?b:a):null};
  });
}
function sourceWithHistory(source, series, fields, window) {
  const metrics=metricsFor(series,fields,window);
  const observed=series.filter(p=>p.month>=window.start&&p.rows.some(r=>r.value!==null));
  return {...source,period:`${window.start} ~ ${window.end}`,periodType:'M',series,metrics,
    status:observed.length===12&&series.filter(p=>p.month>=window.start).every(p=>p.rows.every(r=>r.value!==null))?'ready':observed.length?'partial':['error','failed','publication_pending'].includes(source.status)?source.status:'missing',
    rows:metrics.map(m=>({key:m.key,label:m.label,value:m.latest?.value??null,unit:m.unit,status:m.latest?'observed':'missing'}))};
}
function createInsightRegionHistory({readMonthlyContext,tourismCollector,searchTrendService,now=()=>Date.now()}) {
  return async function readHistory(request,catalog) {
    const today=new Date(new Date(now()).getTime()+9*3600000).toISOString().slice(0,10);
    const end=request.month, regionKey=request.targetId;
    const window={start:shiftMonth(end,-11),end,months:12,storageStart:shiftMonth(end,-23),storageMonths:24,currentMonth:today.slice(0,7)};
    const months=monthsEnding(end,24),base=await readMonthlyContext(request,catalog);
    assertCache(base);
    const sources=base.sources.filter(s=>s.key.startsWith('kosis_'));
    const warnings=['최근 12개월을 표시하고 같은 조건의 24개월 자료로 전년 동월을 비교합니다. 빈 달은 0으로 채우거나 선으로 연결하지 않습니다.',
      '월별 추이와 숙소 예약이 함께 움직이더라도 원인이나 미래 예약을 확정하지 않습니다. 인구·산업은 실제 공표기간의 배경 통계입니다.'];
    const input={regionKey,regionKeys:[regionKey],endYearMonth:end.replace('-',''),months:24,analysisMonths:24,collectMissing:false,refresh:false,force:false,maxPagesPerOperation:1};
    for (const [key,label,method,fields] of SOURCES) {
      let result=null,error=false;
      try { result=await tourismCollector[method](input); assertCache(result); }
      catch(e) {if(e.message==='INSIGHT_HISTORY_MUST_BE_CACHE_ONLY')throw e;error=true;}
      const regions=result?.regions||[];
      const matching=regions.filter(r=>r.regionKey===regionKey);
      const regionValid=key==='visitors'?matching.length===1:result?.region?.regionKey===regionKey;
      const raw=regionValid?(key==='visitors'?matching[0].series:result.series)||[]:[];
      if(result&&!regionValid)warnings.push(`${label}: 요청한 지역과 자료가 일치하지 않아 표시하지 않았습니다.`);
      const series=months.map(month=>{
        const matches=raw.filter(p=>p.yearMonth===month.replace('-',''));
        const p=matches.length===1?matches[0]:null,status=error||matches.length>1||result&&!regionValid?'error':pointStatus(p);
        return {month,status,retrievedAt:p?.collectedAt||'',rows:fields.map(([field,name,unit])=>{
          const value=['resource','diversity'].includes(key)?p?.values?.[field]:p?.[field];
          return {key:field,label:name,unit,value:status==='observed'&&numeric(value)?value:null,status:status==='observed'&&numeric(value)?'observed':status==='observed'?'missing':status};
        })};
      });
      sources.push(sourceWithHistory({key:`tourism_${key}`,label,provider:'한국관광공사',status:error?'error':'missing',sourceUrl:result?.source?.referenceUrl||'',
        retrievedAt:series.map(p=>p.retrievedAt).filter(Boolean).sort().at(-1)||'',referenceOnly:false},series,fields,window));
    }
    if(searchTrendService) {
      let trend=null;
      try {
        trend=await searchTrendService.get({regionKey,month:end,months:24});assertCache(trend);
        // An old 12-month snapshot is useful by itself, but must not be joined to
        // another independently normalized query for a year-over-year comparison.
        if(!(trend.series||[]).some(p=>p.status==='observed'&&numeric(p.value))) {
          const older=await searchTrendService.get({regionKey,month:end});assertCache(older);
          if((older.series||[]).some(p=>p.status==='observed'&&numeric(p.value)))trend=older;
        }
      } catch(e) {if(e.message==='INSIGHT_HISTORY_MUST_BE_CACHE_ONLY')throw e;}
      const fields=[['interest','검색 관심도','상대지수']];
      const valid=trend?.regionKey===regionKey&&trend?.month===end&&trend?.partialMonth===false;
      const series=months.map(month=>{
        const matches=valid?(trend.series||[]).filter(p=>p.period===`${month}-01`):[];
        const point=matches.length===1?matches[0]:null,observed=point?.status==='observed'&&numeric(point.value)&&point.value<=100;
        return {month,status:observed?'observed':'missing',retrievedAt:trend?.retrievedAt||'',rows:[{key:'interest',label:'검색 관심도',unit:'상대지수',value:observed?point.value:null,status:observed?'observed':'missing'}]};
      });
      sources.push(sourceWithHistory({key:'naver_search_trend',label:`검색 트렌드 · ${trend?.keyword||'기준 검색어 확인 전'}`,provider:'네이버 데이터랩',status:trend?.status||'missing',
        keyword:trend?.keyword||'',normalizationPeriod:valid?`${trend.startDate} ~ ${trend.endDate}`:'',sourceUrl:'https://developers.naver.com/docs/serviceapi/datalab/search/search.md',retrievedAt:trend?.retrievedAt||'',referenceOnly:true},series,fields,window));
      warnings.push('검색 관심도는 표시된 조회기간에서 최고값을 100으로 정한 상대지수입니다. 다른 지역·조회기간의 지수와 직접 비교하거나 합산하지 않습니다.');
    }
    // An unfinished month stays separate from all completed-month comparisons.
    let interim=null;
    if(end===shiftMonth(window.currentMonth,-1)) {
      try {
        const current=await readMonthlyContext({...request,month:window.currentMonth},catalog);assertCache(current);
        interim={month:window.currentMonth,status:'partial_month',sources:current.sources.filter(s=>s.key.startsWith('tourism_')||s.key==='naver_search_trend').map(s=>({...s,
          rows:s.key==='naver_search_trend'?(s.rows||[]).filter(r=>r.key?.startsWith(window.currentMonth)):s.rows}))};
      } catch(e) {if(e.message==='INSIGHT_HISTORY_MUST_BE_CACHE_ONLY')throw e;interim={month:window.currentMonth,status:'partial_month',sources:[]};warnings.push('이번 달 중간 현황은 현재 확인할 수 없습니다. 마감월 흐름과 별도로 확인해 주세요.');}
    }
    return {sources,warnings,window,interim,networkAttempted:false};
  };
}
module.exports={createInsightRegionHistory,shiftMonth,monthsEnding,metricsFor,change};
