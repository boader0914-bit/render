'use strict';
const {performance}=require('node:perf_hooks');

function selection(headers,identity){
  const view=headers?.['x-insight-bootstrap-view'];
  if(!['home','property','company','competitors','regions','reports','settings'].includes(view))return {company:true,region:true,report:true};
  const relations=Array.isArray(identity?.customer?.relations)?identity.customer.relations:[];
  const permitted=relations.filter(row=>['active','pending'].includes(row.status));
  if(view==='company'){
    const id=headers?.['x-insight-bootstrap-company'];
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,180}$/.test(id))return {company:true,region:true,report:true};
    // A browser hint only narrows the freshly verified relationship set.
    return {company:true,companyIds:permitted.some(row=>row.companyId===id)?[id]:[],region:false,report:false};
  }
  return {company:['home','property','competitors'].includes(view),companyIds:permitted.filter(row=>row.kind===(view==='competitors'?'competitor':'own')).map(row=>row.companyId),region:['home','regions'].includes(view),report:view==='reports'};
}

function createBootstrapSnapshots({companyReads,regionReads,reportReads}){
  return async function snapshots({headers,scope,audience,identity,timing}){
    const selected=selection(headers,identity);
    const measured=async(name,read)=>{const started=performance.now();try{return await read();}finally{timing?.add(name,performance.now()-started);}};
    const [companyViews,regionViews,reportViews]=await Promise.all([
      selected.company?measured('snapshot_company',()=>companyReads.snapshot({scope,audience,identity,...(selected.companyIds?{companyIds:selected.companyIds}:{})})):[],
      selected.region?measured('snapshot_region',()=>regionReads.snapshot({scope,identity})):[],
      selected.report?measured('snapshot_report',()=>reportReads.snapshot({scope,audience,identity})):[],
    ]);
    return {companyViews,regionViews,reportViews};
  };
}
module.exports={createBootstrapSnapshots,selection};
