'use strict';
// A read-only view of centrally integrated company-day rows. Never select raw
// products, repair prices or mutate source observations at this boundary.
const {fault}=require('./insight_store.cjs');
const {summarizeCompany,validQuantityDay}=require('./insight_comparison.cjs');
const DAY=86400000;
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const day=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value?value:null;
const month=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)?value:null;
const shift=(value,count)=>new Date(Date.parse(value+'T00:00:00Z')+count*DAY).toISOString().slice(0,10);
const monthEnd=value=>{const[y,m]=value.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);};
const period=(start,end)=>({start:start||null,end:end||null,days:start&&end?Math.round((Date.parse(end)-Date.parse(start))/DAY)+1:0});
function selectionFor(input={},today) {
  const stayMode=input.stayMode===undefined?'all_available':input.stayMode;
  if(!['all_available','month','upcoming30','custom'].includes(stayMode))throw fault('INVALID_PERIOD','숙박기간 선택 방식을 확인해 주세요.');
  const has=field=>input[field]!==undefined&&input[field]!==null;
  if(stayMode==='month') {
    if(!month(input.month)||has('start')||has('end'))throw fault('INVALID_PERIOD','숙박월만 YYYY-MM 형식으로 선택해 주세요.');
    return {selection:{stayMode,month:input.month,start:null,end:null},period:period(input.month+'-01',monthEnd(input.month)),mode:'historical'};
  }
  if(stayMode==='custom') {
    if(!day(input.start)||!day(input.end)||has('month')||input.start>input.end||period(input.start,input.end).days>3660)throw fault('INVALID_PERIOD','시작일과 종료일을 10년 이내의 올바른 숙박기간으로 선택해 주세요.');
    return {selection:{stayMode,month:null,start:input.start,end:input.end},period:period(input.start,input.end),mode:'historical'};
  }
  if(['month','start','end'].some(has))throw fault('INVALID_PERIOD','선택한 기간 방식에 맞는 조건만 지정해 주세요.');
  return {selection:{stayMode,month:null,start:null,end:null},period:stayMode==='upcoming30'?period(today,shift(today,29)):period(null,null),mode:stayMode==='upcoming30'?'current':'historical'};
}
function monthsBetween(start,end) {
  if(!start||!end)return [];
  const result=[];let current=start.slice(0,7);
  while(current<=end.slice(0,7)){result.push(current);if(result.length>122)throw fault('INVALID_PERIOD','조회할 숙박기간을 10년 이내로 선택해 주세요.');const[y,m]=current.split('-').map(Number);current=new Date(Date.UTC(y,m,1)).toISOString().slice(0,7);}
  return result;
}
function observedBoundary(rows,asOf) {
  return rows.filter(row=>day(row?.date)).filter(row=>{
    const timestamp=[row.collectedAt,row.latestAttemptAt].find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)));
    const at=timestamp?new Date(Date.parse(timestamp)+9*3600000).toISOString().slice(0,10):day(row.collectedDate);
    // Missing calendar placeholders have no evidence. A failed/quantity-unknown
    // observation with a real timestamp still defines a truthful data boundary.
    return Boolean(at&&at<=asOf);
  }).map(row=>row.date);
}
function availableRange(companies,asOf) {
  const dates=companies.flatMap(company=>observedBoundary(company.days||[],asOf)).sort();
  const start=dates[0]||null,end=dates.at(-1)||null;
  if(period(start,end).days>3660)throw fault('INVALID_PERIOD','조회할 숙박기간을 10년 이내로 선택해 주세요.');
  return {start,end,months:monthsBetween(start,end)};
}
function dailyPeriods(company,selectedPeriod,{asOf,mode}) {
  const bounds=period(selectedPeriod.start,selectedPeriod.end);
  if(bounds.days>3660)throw fault('INVALID_PERIOD','조회할 숙박기간을 10년 이내로 선택해 주세요.');
  if(!bounds.days)return {period:bounds,asOf,months:[]};
  const all=summarizeCompany(company,{mode,asOf,period:bounds}),excluded=new Map(all.summaryQuality.excludedDates.map(row=>[row.date,row.codes]));
  const originals=new Map();for(const row of company.days||[])if(day(row?.date)&&!originals.has(row.date))originals.set(row.date,row);
  const rows=Array.from({length:bounds.days},(_,index)=>{
    const date=shift(bounds.start,index),source=originals.get(date),codes=excluded.get(date)||[],valid=Boolean(source&&validQuantityDay(source)&&!codes.length);
    const monetary=field=>valid?number(source[field]):null;
    const total=valid?number(source.total):null,sold=valid?number(source.sold):null;
    const conflict=codes.some(code=>['QUANTITY_INVALID','DUPLICATE_STAY_DATE','CAPACITY_CONFLICT'].includes(code));
    const collectedAt=typeof source?.collectedAt==='string'&&Number.isFinite(Date.parse(source.collectedAt))?source.collectedAt:null;
    const collectedDate=collectedAt?new Date(Date.parse(collectedAt)+9*3600000).toISOString().slice(0,10):day(source?.collectedDate);
    // Reuse the exact company/day denominator policy used by month/week
    // summaries. A reviewed-basis or inventory conflict must not leave a
    // numeric daily rate beside a deliberately unknown aggregate rate.
    const reservationRate=valid?summarizeCompany({...company,days:[source]},{mode,asOf,period:{start:date,end:date}}).summary.reservationRate:null;
    return {date,total,sold,publicBookings:valid?number(source.publicBookings):null,phoneBookings:valid?number(source.phoneBookings):null,
      estimatedRevenue:valid&&source.revenuePartial!==true?number(source.estimatedRevenue):null,knownRevenueSubtotal:monetary('estimatedRevenue'),publicRevenue:monetary('publicRevenue'),phoneRevenue:monetary('phoneRevenue'),
      knownPartialRevenue:monetary('knownPartialRevenue'),reservationRate,
      collectedAt,collectedDate,missing:!valid,quantityStatus:valid?'ready':conflict?'conflict':'unknown',revenuePartial:valid&&source.revenuePartial===true,
      codes:valid?[]:codes.length?codes:['QUANTITY_MISSING']};
  });
  function summarize(group) {
    const groupPeriod={start:group[0].date,end:group.at(-1).date},summary=summarizeCompany(company,{mode,asOf,period:groupPeriod}).summary;
    const observed=group.filter(row=>!row.missing),missing=group.length-observed.length;
    const subtotal=field=>observed.length?observed.reduce((sum,row)=>sum+(number(row[field])||0),0):null;
    return {...summary,...(missing?{supply:null,sold:null,publicBookings:null,phoneBookings:null,reservationRate:null,estimatedRevenue:null}:{}),
      calendarDays:group.length,observedDays:observed.length,missingDays:missing,quantityStatus:!observed.length?'unknown':missing?'partial':'ready',
      knownSoldSubtotal:subtotal('sold'),knownPublicBookingsSubtotal:subtotal('publicBookings'),knownPhoneBookingsSubtotal:subtotal('phoneBookings')};
  }
  const grouped=new Map();
  for(const row of rows){const key=row.date.slice(0,7),group=grouped.get(key)||[];group.push(row);grouped.set(key,group);}
  const months=[...grouped].map(([month,group])=>{
    const weeks=new Map();for(const row of group){const dayOfWeek=new Date(row.date+'T00:00:00Z').getUTCDay(),weekStart=shift(row.date,-((dayOfWeek+6)%7)),week=weeks.get(weekStart)||[];week.push(row);weeks.set(weekStart,week);}
    return {month,period:period(group[0].date,group.at(-1).date),summary:summarize(group),weeks:[...weeks].map(([weekStart,days])=>({weekStart,period:period(days[0].date,days.at(-1).date),summary:summarize(days),daily:days}))};
  });
  return {period:bounds,asOf,months};
}
module.exports={selectionFor,monthsBetween,availableRange,dailyPeriods,period,day,month,monthEnd};
