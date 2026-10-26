'use strict';
const clone=value=>JSON.parse(JSON.stringify(value));
const NOW=Date.parse('2026-10-26T01:00:00Z');
function day(date,sold=2,overrides={}) {
  return {date,total:16,sold,publicBookings:sold,phoneBookings:0,estimatedRevenue:sold*100000,publicRevenue:sold*100000,phoneRevenue:0,collectedAt:'2026-09-20T01:00:00Z',...overrides};
}
function fixture({empty=false,failMonth=null,duplicates=false}={}) {
  const calls=[],catalog={companies:[{companyId:'own',name:'내 매장',regionKey:'home',rooms:16,roomCountSource:'db_review'},
    {companyId:'competitor',name:'경쟁업체',regionKey:'away',rooms:16,roomCountSource:'db_review'}],regions:[{id:'home',label:'내 지역',level:'local'},{id:'away',label:'다른 지역',level:'local'}]};
  const customer={customerId:'test-customer',relations:[{companyId:'own',kind:'own',status:'pending'},{companyId:'competitor',kind:'competitor',status:'active'}],regions:[]};
  const rows={
    '2026-09':[{date:'2026-09-01',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null},day('2026-09-10',2),day('2026-09-12',0),day('2026-09-29',1,{estimatedRevenue:50000,revenuePartial:true,knownPartialRevenue:20000,revenueUnknownRooms:1,phoneMissingPriceBookings:0}),{date:'2026-09-30',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}],
    '2026-10':[day('2026-10-26',3,{collectedAt:'2026-10-26T01:00:00Z'})],
    '2026-11':[day('2026-11-03',1,{collectedAt:'2026-10-26T01:00:00Z'}),{date:'2026-11-30',missing:true,total:null,sold:null,publicBookings:null,phoneBookings:null,estimatedRevenue:null}]
  };
  let active=0,maxActive=0;
  const reader={companyMonths:async id=>{calls.push({type:'months',id});return empty?[]:[{month:'2026-11'},{month:'2026-09'},{month:'2026-10'},{month:'2026-09'}];},
    companyDetail:async(id,{month}={})=>{
      calls.push({type:'detail',id,month});active++;maxActive=Math.max(active,maxActive);await Promise.resolve();active--;
      if(month===failMonth)throw Object.assign(Error('PRIVATE_PATH_OR_KEY'),{code:'PRIVATE_PROVIDER_ERROR'});
      let daily=clone(rows[month]||[]);if(duplicates&&month==='2026-09')daily.push(clone(daily[1]));
      return {companyId:id,legacyObservationView:false,integrated:{selectedMonth:month,status:'ready',snapshot:{},calculatedAt:'2026-10-26T01:00:00Z',roomBasis:{count:16,source:'db_review'}},current:{daily}};
    }};
  return {NOW,customer,catalog,rows,calls,reader,get maxActive(){return maxActive;},args:{catalog:async()=>clone(catalog),collectionResults:reader,savedCollectionResults:reader,now:()=>NOW,readRegionContext:async()=>({networkAttempted:false,sources:[]})}};
}
module.exports={fixture,day,NOW};
