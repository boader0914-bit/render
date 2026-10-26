'use strict';
// Allowlisted display-only period contract. No raw product/customer records.
const DAY=86400000,MAX_DAYS=3660;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const month=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(v);
const shift=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*DAY).toISOString().slice(0,10);
const days=(start,end)=>Math.round((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/DAY)+1;
const empty=()=>({start:null,end:null,days:0});
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function selection(input={}){
 if(!object(input)||Object.keys(input).some(k=>!['stayMode','month','start','end'].includes(k)))return null;
 const stayMode=input.stayMode===undefined?'all_available':input.stayMode,result={stayMode,month:null,start:null,end:null};
 if(!['all_available','month','upcoming30','custom'].includes(stayMode))return null;
 if(stayMode==='month'){if(!month(input.month)||input.start!=null||input.end!=null)return null;result.month=input.month;}
 else if(stayMode==='custom'){if(input.month!=null||!date(input.start)||!date(input.end)||input.start>input.end||days(input.start,input.end)>MAX_DAYS)return null;result.start=input.start;result.end=input.end;}
 else if(input.month!=null||input.start!=null||input.end!=null)return null;
 return result;
}
function period(value,{allowEmpty=false}={}){
 if(!object(value))return null;
 if(allowEmpty&&value.start===null&&value.end===null&&value.days===0)return empty();
 return date(value.start)&&date(value.end)&&value.start<=value.end&&Number.isSafeInteger(value.days)&&value.days===days(value.start,value.end)&&value.days<=MAX_DAYS?{start:value.start,end:value.end,days:value.days}:null;
}
function available(value){
 if(!object(value)||!['all','selection'].includes(value.scope)||!Array.isArray(value.months)||value.months.length>122||!value.months.every(month)||new Set(value.months).size!==value.months.length||!eq([...value.months].sort(),value.months))return null;
 if(value.start===null&&value.end===null)return value.months.length?null:{start:null,end:null,months:[],scope:value.scope};
 if(!date(value.start)||!date(value.end)||value.start>value.end||days(value.start,value.end)>MAX_DAYS||value.months.some(m=>m<value.start.slice(0,7)||m>value.end.slice(0,7)))return null;
 return {start:value.start,end:value.end,months:[...value.months],scope:value.scope};
}
function expectedPeriod(selected,availablePeriod,asOf){
 if(selected.stayMode==='all_available')return availablePeriod.start===null?empty():{start:availablePeriod.start,end:availablePeriod.end,days:days(availablePeriod.start,availablePeriod.end)};
 if(selected.stayMode==='upcoming30')return {start:asOf,end:shift(asOf,29),days:30};
 if(selected.stayMode==='custom')return {start:selected.start,end:selected.end,days:days(selected.start,selected.end)};
 const start=selected.month+'-01',end=new Date(Date.UTC(+start.slice(0,4),+start.slice(5,7),0)).toISOString().slice(0,10);return {start,end,days:days(start,end)};
}
function envelope(value,{anchor}={}){
 if(!object(value)||!Object.hasOwn(value,'selection'))return null;
 const selected=selection(value.selection),availablePeriod=available(value.availablePeriod),p=period(value.period,{allowEmpty:true});
 if(!selected||Object.keys(value.selection).length!==4||Object.entries(selected).some(([k,v])=>value.selection[k]!==v)||!availablePeriod||availablePeriod.scope!==(selected.stayMode==='all_available'?'all':'selection')||!p||!date(value.asOf)||anchor&&value.asOf!==anchor||!eq(p,expectedPeriod(selected,availablePeriod,value.asOf))||!Array.isArray(value.availableMonths)||value.availableMonths.length>122||!value.availableMonths.every(month)||new Set(value.availableMonths).size!==value.availableMonths.length||!eq([...value.availableMonths].sort(),value.availableMonths))return null;
 const mode=selected.stayMode==='upcoming30'?'current':'historical';
 if(value.comparisonPolicy!==undefined&&(!object(value.comparisonPolicy)||value.comparisonPolicy.mode!==mode||value.comparisonPolicy.asOf!==value.asOf))return null;
 return {selection:selected,availablePeriod,availableMonths:[...value.availableMonths],period:p,asOf:value.asOf,...(value.comparisonPolicy?{comparisonPolicy:{mode,asOf:value.asOf}}:{})};
}
const count=v=>Number.isSafeInteger(v)&&v>=0;
const number=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const instant=v=>typeof v==='string'&&/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
const nullable=(check,v)=>v===null||check(v);
const COUNT_FIELDS=['days','supply','sold','publicBookings','phoneBookings','revenueUnknownRooms','knownMissingPhonePriceRooms','calendarDays','observedDays','missingDays','knownSoldSubtotal','knownPublicBookingsSubtotal','knownPhoneBookingsSubtotal'];
const MONEY_FIELDS=['estimatedRevenue','knownRevenueSubtotal','completeRevenueSubtotal','partialKnownRevenueSubtotal','separatePartialRevenueSubtotal'];
function summary(value,p){
 if(!object(value))return null;const out={};
 for(const key of COUNT_FIELDS)if(Object.hasOwn(value,key)){if(!nullable(count,value[key]))return null;out[key]=value[key];}
 for(const key of MONEY_FIELDS)if(Object.hasOwn(value,key)){if(!nullable(number,value[key]))return null;out[key]=value[key];}
 if(!nullable(v=>number(v)&&v<=1,value.reservationRate)||!Array.isArray(value.revenueUnknownDays)||value.revenueUnknownDays.some(d=>!date(d)||d<p.start||d>p.end)||new Set(value.revenueUnknownDays).size!==value.revenueUnknownDays.length)return null;
 if(!['ready','partial','unknown'].includes(value.quantityStatus)||value.calendarDays!==p.days||!count(value.observedDays)||!count(value.missingDays)||value.observedDays+value.missingDays!==p.days)return null;
 out.reservationRate=value.reservationRate;out.revenueUnknownDays=[...value.revenueUnknownDays];out.quantityStatus=value.quantityStatus;return out;
}
function daily(value){
 if(!object(value)||!date(value.date)||!['ready','unknown','conflict'].includes(value.quantityStatus)||typeof value.missing!=='boolean'||typeof value.revenuePartial!=='boolean'||!Array.isArray(value.codes)||value.codes.length>64||value.codes.some(c=>typeof c!=='string'||!/^[A-Z][A-Z0-9_]{1,99}$/.test(c))||new Set(value.codes).size!==value.codes.length)return null;
 const out={date:value.date};for(const key of ['total','sold','publicBookings','phoneBookings']){if(!nullable(count,value[key]))return null;out[key]=value[key];}
 for(const key of ['estimatedRevenue','publicRevenue','phoneRevenue','knownPartialRevenue','knownRevenueSubtotal']){if(!nullable(number,value[key]))return null;out[key]=value[key];}
 if(!nullable(v=>number(v)&&v<=1,value.reservationRate)||!nullable(instant,value.collectedAt)||!nullable(date,value.collectedDate))return null;
 if(value.collectedAt!==null&&value.collectedDate!==null&&new Date(Date.parse(value.collectedAt)+9*3600000).toISOString().slice(0,10)!==value.collectedDate)return null;
 Object.assign(out,{reservationRate:value.reservationRate,collectedAt:value.collectedAt,collectedDate:value.collectedDate,missing:value.missing,quantityStatus:value.quantityStatus,revenuePartial:value.revenuePartial,codes:[...value.codes]});
 if(out.quantityStatus==='ready'?(out.missing||out.sold===null||out.publicBookings===null||out.phoneBookings===null||out.sold!==out.publicBookings+out.phoneBookings):!out.missing)return null;
 if(out.quantityStatus!=='ready'&&(!out.codes.length||['total','sold','publicBookings','phoneBookings','estimatedRevenue','publicRevenue','phoneRevenue','knownPartialRevenue','knownRevenueSubtotal','reservationRate'].some(key=>out[key]!==null)||out.revenuePartial))return null;
 return out;
}
function consistentSummary(s,records){
 const ready=records.filter(d=>d.quantityStatus==='ready'),sum=key=>ready.reduce((total,d)=>total+(d[key]??0),0),missing=records.length-ready.length;
 if(s.days!==ready.length||s.observedDays!==ready.length||s.missingDays!==missing||s.quantityStatus!==(missing?(ready.length?'partial':'unknown'):'ready'))return false;
 for(const [key,known] of [['sold','knownSoldSubtotal'],['publicBookings','knownPublicBookingsSubtotal'],['phoneBookings','knownPhoneBookingsSubtotal']])if(s[known]!== (ready.length?sum(key):null)||s[key]!==(!missing&&ready.length?sum(key):null))return false;
 const total=(rows,key)=>rows.length?rows.reduce((v,d)=>v+d[key],0):null,priced=ready.filter(d=>d.knownRevenueSubtotal!==null);
 const subtotal=total(priced,'knownRevenueSubtotal'),complete=total(priced.filter(d=>!d.revenuePartial),'knownRevenueSubtotal'),partial=total(priced.filter(d=>d.revenuePartial),'knownRevenueSubtotal'),separate=total(ready.filter(d=>d.knownPartialRevenue!==null),'knownPartialRevenue');
 for(const [key,expected] of [['knownRevenueSubtotal',subtotal],['completeRevenueSubtotal',complete],['partialKnownRevenueSubtotal',partial],['separatePartialRevenueSubtotal',separate]])if(s[key]!==expected)return false;
 const unknown=ready.filter(d=>d.revenuePartial||d.knownRevenueSubtotal===null).map(d=>d.date);
 if(!eq(s.revenueUnknownDays,unknown)||s.estimatedRevenue!==(missing||unknown.length?null:subtotal))return false;
 const supply=!missing&&ready.length&&ready.every(d=>d.total!==null)?sum('total'):null,rate=supply>0&&ready.every(d=>d.reservationRate!==null)?sum('sold')/supply:null;
 if(s.supply!==supply||s.reservationRate!==rate)return false;
 return true;
}
function reservationPeriods(value,company,report){
 try{
  if(!object(value)||!eq(period(value.period,{allowEmpty:true}),report.period)||value.asOf!==report.asOf||!Array.isArray(value.months)||value.months.length>122)return null;
  if(report.period.days===0)return value.months.length?null:{period:empty(),asOf:report.asOf,months:[]};
  let expected=report.period.start;const months=[];
  for(const row of value.months){
   if(!object(row)||!month(row.month)||row.month!==expected.slice(0,7)||!Array.isArray(row.weeks)||row.weeks.length>6)return null;
   const p=period(row.period),s=p&&summary(row.summary,p),monthEnd=new Date(Date.UTC(+row.month.slice(0,4),+row.month.slice(5,7),0)).toISOString().slice(0,10);if(!p||!s||p.start!==expected||p.end!==(monthEnd<report.period.end?monthEnd:report.period.end))return null;
   const weeks=[];let current=p.start;
   for(const week of row.weeks){
    const wp=period(week.period),ws=wp&&summary(week.summary,wp);if(!wp||!ws||!date(week.weekStart)||new Date(week.weekStart+'T00:00:00Z').getUTCDay()!==1||wp.start!==current||wp.start<week.weekStart||wp.end!==(shift(week.weekStart,6)<p.end?shift(week.weekStart,6):p.end)||!Array.isArray(week.daily)||week.daily.length!==wp.days)return null;
    const records=week.daily.map(daily);if(records.some((d,i)=>!d||d.date!==shift(wp.start,i)||d.collectedDate&&d.collectedDate>report.asOf&&(d.quantityStatus==='ready'||!d.codes.includes('OBSERVATION_AFTER_CUTOFF'))))return null;
    if(!consistentSummary(ws,records))return null;weeks.push({weekStart:week.weekStart,period:wp,summary:ws,daily:records});current=shift(wp.end,1);
   }
   if(current!==shift(p.end,1)||!consistentSummary(s,weeks.flatMap(w=>w.daily)))return null;
   months.push({month:row.month,period:p,summary:s,weeks});expected=shift(p.end,1);
  }
  if(expected!==shift(report.period.end,1))return null;
  return {period:{...report.period},asOf:report.asOf,months};
 }catch{return null;}
}
module.exports={selection,period,available,envelope,reservationPeriods,expectedPeriod,date,shift,days};
