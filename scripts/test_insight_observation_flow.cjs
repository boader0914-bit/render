'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildObservationFlow}=require('./lib/insight_observation_flow.cjs');
const {projectCompanyDetail}=require('./lib/insight_company_detail.cjs');
const row=(date,at,bookings,extra={})=>({productType:'lodging',stayDate:date,collectedAt:at,total:16,publicBookings:bookings,phoneBookings:2,publicRevenue:bookings*100000,phoneRevenue:200000,...extra});
function normalize(rows){const dates=new Map();for(const r of [...rows].sort((a,b)=>a.collectedAt.localeCompare(b.collectedAt)))dates.set(r.date,r);return [...dates.values()];}
test('different keywords and same-day observations are replacements, not additions; KST days are explicit',()=>{
  const rows=[row('2026-10-03','2026-09-30T14:00:00Z',0),row('2026-10-04','2026-09-30T14:00:00Z',1),
    row('2026-10-03','2026-09-30T16:00:00Z',2,{keyword:'경남글램핑'}),row('2026-10-03','2026-09-30T18:00:00Z',3,{keyword:'산청글램핑'})];
  const [p]=buildObservationFlow(rows,normalize).periods;
  assert.deepEqual(p.comparisonDates,['2026-10-03','2026-10-04']);assert.equal(p.completeMonth,false);
  assert.deepEqual(p.points.map(p=>p.observedDate),['2026-09-30','2026-10-01']);
  assert.equal(p.points[0].publicBookings,1);assert.equal(p.points[1].publicBookings,4);
  assert.equal(p.points[1].phoneBookings,4);assert.equal(p.points[1].estimatedRevenue,800000);
  assert.equal(p.points[1].freshDays,1);assert.equal(p.points[1].comparisonDays,2);
});
test('fixed comparison dates prevent changing coverage from looking like booking growth; failures never become zero or older success',()=>{
  const rows=[row('2026-10-03','2026-09-20T00:00:00Z',0),row('2026-10-04','2026-09-21T00:00:00Z',0),
    row('2026-10-03','2026-09-22T00:00:00Z',0,{missing:true}),row('2026-10-03','2026-09-23T00:00:00Z',0,{revenuePartial:true})];
  const points=buildObservationFlow(rows,normalize).periods[0].points;
  assert.equal(points[0].publicBookings,null);assert.equal(points[1].publicBookings,0);
  assert.equal(points[2].publicBookings,null);assert.equal(points[2].estimatedRevenue,null);
  assert.equal(points[3].publicBookings,0);assert.equal(points[3].estimatedRevenue,null);
});
test('day-use does not add lodging units and full-month scope is marked only for all dates',()=>{
  const rows=Array.from({length:28},(_,i)=>row(`2026-02-${String(i+1).padStart(2,'0')}`,'2026-01-25T00:00:00Z',1));
  rows.push(row('2026-02-01','2026-01-25T00:00:00Z',100,{productType:'dayuse'}));
  const p=buildObservationFlow(rows,normalize).periods[0];
  assert.equal(p.completeMonth,true);assert.equal(p.points[0].publicBookings,28);assert.equal(p.points[0].phoneBookings,56);
});
test('company projection exposes only safe flow fields without source or private fields',()=>{
  const flow=buildObservationFlow([row('2026-10-03','2026-09-20T00:00:00Z',0)],normalize);flow.secret='private';flow.periods[0].points[0].secret='private';
  const result=projectCompanyDetail({companyId:'c',name:'C'},{company:{companyId:'c'},observationFlow:flow});
  assert.equal(result.history.observationFlow.periods[0].points[0].publicBookings,0);
  assert.equal(JSON.stringify(result).includes('private'),false);
});
