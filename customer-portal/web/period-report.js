(() => {
  'use strict';
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  const shift=(d,n)=>new Date(Date.parse(d+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const validDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  const observed=d=>Number.isFinite(Date.parse(d?.collectedAt))?new Date(Date.parse(d.collectedAt)+9*3600000).toISOString().slice(0,10):validDate(d?.collectedDate)?d.collectedDate:null;
  const valid=d=>d&&!d.missing&&!d.partial&&!d.inventoryConflict&&number(d.total)&&d.total>0&&number(d.publicBookings)&&number(d.phoneBookings)&&d.publicBookings+d.phoneBookings<=d.total&&(d.sold==null||(number(d.sold)&&Math.abs(d.sold-d.publicBookings-d.phoneBookings)<.001));
  function range(type,value,today) {
    let start,end;
    if(type==='monthly') {
      if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value||''))throw Error('숙박월을 선택해 주세요.');
      start=value+'-01';end=new Date(Date.UTC(+value.slice(0,4),+value.slice(5,7),0)).toISOString().slice(0,10);
    } else if(type==='weekly'&&/^20\d{2}-/.test(value||'')&&validDate(value)){start=value;end=shift(value,6);}
    else throw Error('유효한 숙박기간을 선택해 주세요.');
    if(start>today)throw Error('오늘 이전에 시작하는 기간을 선택해 주세요.');
    return {type,start,end,days:Math.round((Date.parse(end)-Date.parse(start))/86400000)+1,closed:end<today};
  }
  function selectDays(detail,period) {
    const byDate=new Map();
    for(const d of [...(detail?.history?.months||[]).flatMap(m=>m.daily||[]),...(detail?.current?.daily||[])]) {
      if(!validDate(d.date)||d.date<period.start||d.date>period.end)continue;
      const old=byDate.get(d.date),stamp=x=>Date.parse(x.collectedAt||((x.collectedDate||'')+'T00:00:00Z'))||0;
      if(!old||stamp(d)>=stamp(old))byDate.set(d.date,{...d});
    }
    return [...byDate.values()].sort((a,b)=>a.date.localeCompare(b.date));
  }
  function totals(days) {
    const rows=days.filter(valid),sum=key=>rows.length&&rows.every(d=>number(d[key]))?rows.reduce((s,d)=>s+d[key],0):null;
    const publicBookings=sum('publicBookings'),phoneBookings=sum('phoneBookings'),sold=rows.length?publicBookings+phoneBookings:null,supply=sum('total');
    const priced=rows.filter(d=>!d.revenuePartial&&number(d.estimatedRevenue)&&number(d.publicRevenue)&&number(d.phoneRevenue));
    const money=key=>priced.length===rows.length&&rows.length?priced.reduce((s,d)=>s+d[key],0):null;
    const revenue=money('estimatedRevenue');
    return {days:rows.length,revenueDays:priced.length,supply,sold,publicBookings,phoneBookings,publicRevenue:money('publicRevenue'),phoneRevenue:money('phoneRevenue'),estimatedRevenue:revenue,reservationRate:supply>0?sold/supply:null,averageRate:sold>0&&revenue!==null?revenue/sold:null};
  }
  function build(entries,period,{ownId,generatedAt=new Date().toISOString(),regions=[]}={}) {
    const unique=new Map();for(const e of entries)if(!unique.has(e.companyId)||e.kind==='own')unique.set(e.companyId,e);
    const companies=[...unique.values()].map(e=>{const days=selectDays(e.detail,period);return {...e,detail:undefined,days,summary:totals(days),lastObservedAt:days.map(d=>d.collectedAt).filter(Boolean).sort().at(-1)||null};});
    const own=companies.find(c=>c.kind==='own'&&c.companyId===ownId);
    const comparisons=own?companies.filter(c=>c.kind==='competitor').map(c=>{
      const map=new Map(c.days.filter(valid).map(d=>[d.date,d]));
      const pairs=own.days.filter(valid).map(d=>[d,map.get(d.date)]).filter(([a,b])=>b&&observed(a)&&observed(a)===observed(b));
      const a=totals(pairs.map(p=>p[0])),b=totals(pairs.map(p=>p[1]));
      return {companyId:c.companyId,name:c.name,dates:pairs.map(p=>p[0].date),commonDays:pairs.length,own:a,competitor:b,gapPp:a.reservationRate!==null&&b.reservationRate!==null?(a.reservationRate-b.reservationRate)*100:null,status:pairs.length>=7?'comparable':'insufficient'};
    }):[];
    const actions=[];
    if(!own)actions.push({title:'기준 매장을 등록하세요.',reason:'내 매장이 연결되어 있지 않습니다.',next:'내 매장 등록 후 같은 기간으로 다시 확인하세요.',check:'내 매장 연결 상태',source:'등록 정보'});
    else {
      const missing=period.days-own.summary.days;
      actions.push(missing?{title:'확보한 숙박일 범위를 먼저 확인하세요.',reason:`${period.days}일 중 정상 수량 ${own.summary.days}일입니다.`,next:'누락 날짜와 객실 수 충돌을 업체 자료에서 확인하세요. 일부 기간 합계를 월 전체 실적으로 보지 않습니다.',check:'정상 숙박일 수',source:'업체별 저장 자료'}:{title:'예약과 판매금액을 함께 점검하세요.',reason:`선택한 숙박일 ${period.days}일의 수량 자료가 있습니다.`,next:'날짜별 예약률과 판매금액을 비교해 개선할 날짜를 선택하세요.',check:'날짜별 예약·매출',source:'업체별 저장 자료'});
      const comparable=comparisons.filter(c=>c.status==='comparable');
      if(comparable.length)actions.push({title:'같은 날짜의 경쟁 조건을 비교하세요.',reason:`등록 경쟁업체 ${comparable.length}곳에 비교 가능한 공통 날짜가 있습니다.`,next:'아래 공통 날짜 기준의 예약률·객실당 금액을 보고 시설·상품 조건과 함께 판단하세요.',check:'공통 날짜와 관측 시점',source:'동일 숙박일·관측일 비교'});
    }
    return {mode:'period_review',published:false,generatedAt,period,ownId,companies,comparisons,regions,actions,definitions:['숙박일 기준으로 동일 업체·날짜를 한 번만 집계합니다. 수집 회차별 매출은 더하지 않습니다.','DB에 저장된 최신 관측과 현재 검수값을 사용합니다. 실제 결제 매출과는 다른 추정 자료입니다.','네이버 관측과 타채널·전화 추정을 합산합니다. 오류·누락은 0으로 바꾸지 않습니다.','경쟁 비교는 같은 숙박일·같은 한국시간 관측일만 사용합니다. 공통 날짜가 7일 미만이면 판단을 보류합니다.','서버 발행본이 아닌 검토용 보고서입니다. PDF 또는 보고서 파일로 저장할 수 있습니다.']};
  }
  const api={range,selectDays,totals,build,valid,observed};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else window.InsightPeriodReport=api;
})();
