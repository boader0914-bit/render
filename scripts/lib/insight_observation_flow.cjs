'use strict';

const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(ms)&&new Date(ms).toISOString().slice(0,10)===value?value:null;
};
const observedDay = row => row.collectedAt && Number.isFinite(Date.parse(row.collectedAt))
  ? new Date(Date.parse(row.collectedAt)+9*3600000).toISOString().slice(0,10) : day(row.collectedDate);
const numeric = v => typeof v==='number'&&Number.isFinite(v)&&v>=0;
const valid = d => !d.missing&&!d.partial&&!d.inventoryConflict&&numeric(d.total)&&d.total>0
  &&numeric(d.publicBookings)&&numeric(d.phoneBookings)&&d.publicBookings+d.phoneBookings<=d.total;

// Inputs must already be restricted to canonical company IDs. normalize uses the
// same reviewed-capacity/read-only calculation as DataLab's company history.
function buildObservationFlow(observations, normalize) {
  const groups=new Map(),targets=new Map();
  for(const row of observations) {
    if(row.productType!=='lodging')continue;
    const date=day(row.stayDate||row.date),observed=observedDay(row);
    if(!date||!observed)continue;
    const bucket=groups.get(observed)||[];bucket.push({...row,date,stayDate:date});groups.set(observed,bucket);
    const month=date.slice(0,7),dates=targets.get(month)||new Set();dates.add(date);targets.set(month,dates);
  }
  const latest=new Map(),periods=new Map();
  for(const [observed,rows] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    const normalized=new Map(normalize(rows).map(d=>[d.date,d]));
    const updated=new Set(rows.map(r=>r.date)),months=new Set([...updated].map(d=>d.slice(0,7)));
    // A failed newer response remains unknown; it cannot silently carry forward
    // a successful older value for that same stay date.
    for(const date of updated)latest.set(date,normalized.get(date)||{date,missing:true});
    for(const month of months) {
      const [y,m]=month.split('-').map(Number),end=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10),expected=Number(end.slice(-2));
      const comparisonDates=[...targets.get(month)].sort(),days=comparisonDates.map(date=>latest.get(date));
      const usable=days.filter(d=>d&&valid(d)),complete=usable.length===comparisonDates.length;
      const sum=key=>complete&&usable.every(d=>numeric(d[key]))?usable.reduce((a,d)=>a+d[key],0):null;
      const publicBookings=sum('publicBookings'),phoneBookings=sum('phoneBookings'),supply=sum('total');
      const priced=complete&&usable.every(d=>!d.revenuePartial&&numeric(d.publicRevenue)&&numeric(d.phoneRevenue));
      const publicRevenue=priced?sum('publicRevenue'):null,phoneRevenue=priced?sum('phoneRevenue'):null;
      const point={observedDate:observed,observedDays:days.filter(Boolean).length,validDays:usable.length,
        freshDays:days.filter(d=>d&&updated.has(d.date)).length,calendarDays:expected,comparisonDays:comparisonDates.length,status:complete?'complete':'partial',
        publicBookings,phoneBookings,publicRevenue,phoneRevenue,
        estimatedRevenue:priced?publicRevenue+phoneRevenue:null,
        reservationRate:supply>0?(publicBookings+phoneBookings)/supply:null};
      const period=periods.get(month)||{month,start:month+'-01',end,calendarDays:expected,comparisonDates,completeMonth:comparisonDates.length===expected,points:[]};
      period.points.push(point);periods.set(month,period);
    }
  }
  return {basis:'latest_known_as_of_kst_day',reviewBasis:'current_db_review',periods:[...periods.values()].sort((a,b)=>a.month.localeCompare(b.month))};
}
module.exports={buildObservationFlow};
