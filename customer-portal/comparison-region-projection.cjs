'use strict';
const {createHash}=require('node:crypto');
const {REGION_SUMMARY_REASONS,REGION_SUMMARY_SOURCE_REASONS}=require('../scripts/lib/insight_region_summary.cjs');
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(v);
const month=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(v);
const date=v=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const text=(v,max=200)=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)?v:null;
const key=v=>typeof v==='string'&&v.trim()===v&&id(v)?v:null;
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const ordered=v=>[...v].sort();
const setEqual=(a,b)=>Array.isArray(a)&&new Set(a).size===a.length&&same(ordered(a),ordered(b));
const stable=v=>Array.isArray(v)?v.map(stable):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const shift=(v,n)=>{const [y,m]=v.split('-').map(Number);return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);};
const iso=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
function binding(v){
  if(!object(v)||!id(v.companyId)||!['own','competitor'].includes(v.kind)||!['active','pending'].includes(v.relationStatus)||!['ready','unknown'].includes(v.regionStatus)||typeof v.hierarchyApplied!=='boolean')return null;
  if(![v.regionKey,v.analysisRegionKey].every(k=>k===null||key(k))||!(v.regionLabel===null||text(v.regionLabel)))return null;
  if(v.regionStatus==='ready'?(!v.analysisRegionKey||!v.regionLabel||v.hierarchyApplied!==(v.regionKey!==v.analysisRegionKey)):(v.analysisRegionKey!==null||v.regionLabel!==null||v.hierarchyApplied))return null;
  return Object.fromEntries(['companyId','kind','relationStatus','regionKey','analysisRegionKey','regionLabel','hierarchyApplied','regionStatus'].map(k=>[k,v[k]]));
}
function identityContext(identity,ownId=''){
  const c=identity?.customer;
  if(!object(c)||!id(c.customerId)||c.accountStatus!=='active'||!Array.isArray(c.relations)||!Array.isArray(c.regions)||!Array.isArray(identity.companies)||!Array.isArray(identity.regions)||!Array.isArray(identity.comparisonRegionBindings)||ownId!==''&&!id(ownId))return null;
  const relations=c.relations.filter(r=>r&&['active','pending'].includes(r.status)&&['own','competitor'].includes(r.kind)&&id(r.companyId));
  const ids=[...new Set(relations.map(r=>r.companyId))],all=identity.comparisonRegionBindings.map(binding);
  if(all.some(v=>!v)||!setEqual(all.map(v=>v.companyId),ids))return null;
  for(const b of all){const r=relations.find(r=>r.companyId===b.companyId);if(b.kind!==r.kind||b.relationStatus!==r.status)return null;
    if(relations.some(r=>r.companyId===b.companyId&&(r.kind!==b.kind||r.status!==b.relationStatus))&&b.regionStatus!=='unknown')return null;}
  const anchor=ownId?all.find(b=>b.companyId===ownId&&b.kind==='own'):null;if(ownId&&!anchor)return null;
  const bindings=all.filter(b=>b.kind==='competitor'||anchor&&b.companyId===anchor.companyId),groups=new Map(),unresolved=[];
  const add=(regionId,label,kind,companyId)=>{let g=groups.get(regionId);if(!g){g={region:{id:regionId,label},companyIds:[],kinds:[],relationToOwn:anchor?.analysisRegionKey?anchor.analysisRegionKey===regionId?'same':'cross':'unknown'};groups.set(regionId,g);}if(companyId&&!g.companyIds.includes(companyId))g.companyIds.push(companyId);if(!g.kinds.includes(kind))g.kinds.push(kind);};
  for(const b of bindings){if(b.analysisRegionKey)add(b.analysisRegionKey,b.regionLabel,b.kind,b.companyId);else{const conflict=relations.some(r=>r.companyId===b.companyId&&(r.kind!==b.kind||r.status!==b.relationStatus));const code=conflict?'COMPANY_RELATION_CONFLICT':!identity.companies.some(r=>r.companyId===b.companyId)?'COMPANY_METADATA_UNAVAILABLE':'COMPANY_REGION_UNKNOWN';unresolved.push({scope:'company',companyId:b.companyId,kind:b.kind,regionKey:b.regionKey,code,reason:REGION_SUMMARY_REASONS[code]});}}
  for(const regionKey of new Set(c.regions.filter(r=>r.status==='active'&&key(r.regionKey)).map(r=>r.regionKey))){const r=identity.regions.find(r=>r.id===regionKey&&r.level==='local');if(r)add(regionKey,text(r.label)||null,'interest',null);else unresolved.push({scope:'interest',companyId:null,kind:'interest',regionKey,code:'INTEREST_REGION_UNKNOWN',reason:REGION_SUMMARY_REASONS.INTEREST_REGION_UNKNOWN});}
  const value={customerId:c.customerId,revision:c.revision??null,ownId:anchor?.companyId||null,bindings,groups:[...groups.values()],unresolved};
  // All relationships are in the fingerprint so removing a non-selected own
  // registration cannot leave a pending response with an older authority.
  return {...value,fingerprint:hash({value,all,relations})};
}
function safeUrl(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)return null;for(const k of u.searchParams.keys())if(/key|token|auth|pass|secret|credential|signature|session|cookie/i.test(k))return null;u.hash='';return u.href;}catch{return null;}}
const statuses=new Set(['observed','ready','complete','partial','missing','error','failed','blocked','unavailable','publication_pending','not_collected','stale','mapping_missing','needs_key','cooldown','suppressed']);
function rows(values){if(!Array.isArray(values)||values.length>100)return null;const result=[];for(const r of values){if(!object(r)||!text(r.key)||!text(r.label)||!text(r.unit)||!statuses.has(r.status)||r.value!==null&&number(r.value)===null)return null;if(r.status!=='observed'&&r.value!==null)return null;result.push({key:r.key,label:r.label,unit:r.unit,status:r.status,value:r.value});}return result;}
function point(v,end){return v===null?null:object(v)&&month(v.month)&&v.month>=shift(end,-11)&&v.month<=end&&number(v.value)!==null?{month:v.month,value:v.value}:undefined;}
function source(value,end){
  if(!object(value)||!text(value.key)||!text(value.label)||!statuses.has(value.status)||value.networkAttempted===true||value.refreshAvailable===true)return null;
  const r={};for(const k of ['key','label','provider','status','period','periodType','keyword','normalizationPeriod']){if(value[k]!==undefined){if(text(value[k],1500)===null)return null;r[k]=value[k];}}
  for(const k of ['partialMonth','referenceOnly'])if(value[k]!==undefined){if(typeof value[k]!=='boolean')return null;r[k]=value[k];}
  r.sourceUrl=safeUrl(value.sourceUrl);r.retrievedAt=iso(value.retrievedAt);r.sourceUpdatedAt=iso(value.sourceUpdatedAt);
  r.rows=rows(value.rows||[]);if(!r.rows)return null;
  if(value.series!==undefined){if(!Array.isArray(value.series)||value.series.length>12)return null;const seen=new Set();r.series=[];for(const p of value.series){if(!object(p)||!month(p.month)||p.month<shift(end,-11)||p.month>end||seen.has(p.month)||!statuses.has(p.status))return null;const projected=rows(p.rows);if(!projected)return null;seen.add(p.month);r.series.push({month:p.month,status:p.status,retrievedAt:iso(p.retrievedAt),rows:projected});}}
  if(value.metrics!==undefined){if(!Array.isArray(value.metrics)||value.metrics.length>100)return null;r.metrics=[];for(const m of value.metrics){if(!object(m)||!text(m.key)||!text(m.label)||!text(m.unit)||!Number.isInteger(m.observedMonths)||m.observedMonths<0||m.observedMonths>12)return null;const item={key:m.key,label:m.label,unit:m.unit,observedMonths:m.observedMonths};for(const k of ['latest','peak','low']){item[k]=point(m[k],end);if(item[k]===undefined)return null;}for(const k of ['mom','yoy']){const d=m[k];if(!object(d)||!['unavailable','zero_baseline','index_difference','percent'].includes(d.kind)||d.value!==null&&number(d.value)===null)return null;item[k]={kind:d.kind,value:d.value};}r.metrics.push(item);}}
  return r;
}
function sourceIssues(values,region,end){if(!Array.isArray(values)||values.length>100)return null;const output=[];for(const v of values){if(!object(v)||v.scope!=='region'||v.regionId!==region||!Object.hasOwn(REGION_SUMMARY_SOURCE_REASONS,v.code)||!month(v.month)||v.month<shift(end,-23)||v.month>end||!object(v.period)||!date(v.period.start)||!date(v.period.end)||v.period.start>v.period.end)return null;const from=v.period.start.slice(0,7),to=v.period.end.slice(0,7);if(v.code==='REGION_ADDITIONAL_ISSUES'?(v.month!==end||from<shift(end,-23)||to>end):(from!==v.month||to!==v.month))return null;const r={scope:'region',regionId:region,name:text(v.name)||'',month:v.month,period:{start:v.period.start,end:v.period.end},code:v.code,reason:REGION_SUMMARY_SOURCE_REASONS[v.code]};for(const k of ['sourceKey','sourceName'])if(v[k]!==undefined){if(text(v[k])===null)return null;r[k]=v[k];}output.push(r);}return output;}
function projectComparisonRegion(data,context,{month:end}={}){
  if(!context||!month(end)||!object(data)||data.schemaVersion!==1||data.mode!=='comparison_region_summary'||data.ownId!==context.ownId||data.month!==end||data.source!=='datalab_saved'||data.networkAttempted!==false||data.access?.summaryOnly!==true||data.access?.fullAnalysis!==false||data.access?.preparation!==false||!Array.isArray(data.bindings)||!Array.isArray(data.groups)||!Array.isArray(data.unresolved))return null;
  const bindings=data.bindings.map(binding);if(bindings.some(v=>!v)||!setEqual(bindings.map(v=>v.companyId),context.bindings.map(v=>v.companyId))||bindings.some(b=>!same(b,context.bindings.find(v=>v.companyId===b.companyId))))return null;
  if(!setEqual(data.groups.map(g=>g?.region?.id),context.groups.map(g=>g.region.id)))return null;
  if(data.unresolved.length!==context.unresolved.length)return null;
  const unresolved=[],unresolvedKeys=new Set();for(const v of data.unresolved){if(!object(v)||!Object.hasOwn(REGION_SUMMARY_REASONS,v.code))return null;const p=Object.fromEntries(['scope','companyId','kind','regionKey','code'].map(k=>[k,v[k]])),k=JSON.stringify(p);const expected=context.unresolved.find(e=>Object.keys(p).every(k=>same(e[k],p[k])));if(!expected||unresolvedKeys.has(k))return null;unresolvedKeys.add(k);unresolved.push({...p,reason:REGION_SUMMARY_REASONS[v.code]});}
  const groups=[];for(const g of data.groups){const expected=context.groups.find(e=>e.region.id===g.region.id);if(!expected||!setEqual(g.companyIds,expected.companyIds)||!setEqual(g.kinds,expected.kinds)||g.relationToOwn!==expected.relationToOwn||g.region.label!==expected.region.label||!['ready','partial','unavailable'].includes(g.status)||!object(g.summary)||!Array.isArray(g.summary.sources)||g.summary.sources.length>20)return null;const s=g.summary,sources=s.sources.map(v=>source(v,end));if(sources.some(v=>!v)||new Set(sources.map(v=>v.key)).size!==sources.length)return null;const issues=sourceIssues(s.sourceIssues,expected.region.id,end);if(!issues)return null;
    const observed=rows=>rows.some(row=>row.status==='observed'&&row.value!==null),available=sources.filter(source=>observed(source.rows)||(source.series||[]).some(p=>p.status==='observed'&&observed(p.rows))||(source.metrics||[]).some(m=>m.latest&&m.latest.value!==null)).length;
    const summary={sources,sourceIssues:issues};if(s.month!==undefined){if(s.month!==end)return null;summary.month=end;}if(s.window!==undefined){if(!object(s.window)||s.window.start!==shift(end,-11)||s.window.end!==end||s.window.months!==12)return null;summary.window={start:s.window.start,end,months:12};}if(s.availableSources!==undefined){if(s.availableSources!==available)return null;summary.availableSources=s.availableSources;}if(s.sourceStatus!==undefined){if(s.sourceStatus!==g.status)return null;summary.sourceStatus=s.sourceStatus;}if(!available&&g.status!=='unavailable')return null;groups.push({...expected,region:{...expected.region},companyIds:[...expected.companyIds],kinds:[...expected.kinds],status:g.status,summary});}
  return {schemaVersion:1,mode:'comparison_region_summary',ownId:context.ownId,month:end,source:'datalab_saved',networkAttempted:false,bindings,groups,unresolved,access:{summaryOnly:true,fullAnalysis:false,preparation:false}};
}
module.exports={identityContext,projectComparisonRegion,validMonth:month,validId:id,hash};
