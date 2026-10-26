'use strict';
const {identityContext}=require('../comparison-region-projection.cjs');
const clone=v=>JSON.parse(JSON.stringify(v));
function identity({otherRegion='r2',own=true,unknown=false,interest='r3'}={}){
  const companies=[...(own?[{companyId:'own_a',name:'Own',regionKey:'r1'}]:[]),{companyId:'comp_b',name:'Other',regionKey:unknown?'':otherRegion}];
  const regions=['r1','r2','r3'].map(id=>({id,label:'Region '+id,level:'local'}));
  const relations=companies.map(c=>({companyId:c.companyId,kind:c.companyId==='own_a'?'own':'competitor',status:'active'}));
  return {customer:{customerId:'cus_fixture',accountStatus:'active',revision:1,relations,regions:interest?[{regionKey:interest,status:'active'}]:[]},companies,regions:regions.filter(r=>r.id==='r1'||r.id===interest),comparisonRegionBindings:companies.map(c=>({companyId:c.companyId,kind:c.companyId==='own_a'?'own':'competitor',relationStatus:'active',regionKey:c.regionKey||null,analysisRegionKey:c.regionKey||null,regionLabel:c.regionKey?'Region '+c.regionKey:null,hierarchyApplied:false,regionStatus:c.regionKey?'ready':'unknown'})),csrfToken:'PRIVATE-CSRF'};
}
function source(account=identity(),{ownId='own_a',month='2026-09',value=0}={}){
  const context=identityContext(account,ownId);if(!context)throw new Error('bad fixture');
  return {schemaVersion:1,mode:'comparison_region_summary',ownId:context.ownId,month,source:'datalab_saved',networkAttempted:false,bindings:clone(context.bindings),groups:context.groups.map(g=>({...clone(g),status:'ready',summary:{month,window:{start:require('../../scripts/lib/insight_region_history.cjs').shiftMonth(month,-11),end:month,months:12},availableSources:1,sourceStatus:'ready',sources:[{key:'tourism_visitors',label:'Visitors',provider:'Public',status:'ready',period:'2025-10 ~ '+month,periodType:'M',sourceUrl:'https://example.org/statistics',retrievedAt:'2026-10-01T00:00:00Z',sourceUpdatedAt:null,rows:[{key:'visitors',label:'Visitors',unit:'people',status:'observed',value},{key:'unknown',label:'Unknown',unit:'people',status:'missing',value:null}],series:[{month,status:'observed',retrievedAt:'2026-10-01T00:00:00Z',rows:[{key:'visitors',label:'Visitors',unit:'people',status:'observed',value}]}],metrics:[{key:'visitors',label:'Visitors',unit:'people',observedMonths:1,latest:{month,value},peak:{month,value},low:{month,value},mom:{kind:'unavailable',value:null},yoy:{kind:'percent',value:3}}]}],sourceIssues:[]}})),unresolved:clone(context.unresolved),access:{summaryOnly:true,fullAnalysis:false,preparation:false}};
}
module.exports={identity,source,clone};
