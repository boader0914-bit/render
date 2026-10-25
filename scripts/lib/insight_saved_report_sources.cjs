'use strict';
// Read only the published company-month projection. In particular, do not
// initialize the integrated DB, inspect raw history, enqueue a refresh, acquire
// an analytical lease or call the normal company-detail/evidence reader.
const fs=require('node:fs/promises'),{constants}=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {projectIntegrated}=require('./insight_company_integrated.cjs');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(stable(value))).digest('hex');
const fault=code=>Object.assign(Error(code),{code,statusCode:503});
const need=(condition,code='SAVED_COMPANY_SOURCE_INVALID')=>{if(!condition)throw fault(code);};
const signature=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
const validDay=value=>typeof value==='string'&&/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
// Explicit saved formats, not an open-ended prefix match. These versions use
// the same company/month envelope; newer calculations require an audited read
// contract before they can become a customer preview.
const SUPPORTED_CALCULATIONS=new Set(['company-integrated-v1','company-integrated-v2-price-observation-time','company-integrated-v3-saved-product-recovery',
  'company-integrated-v4-product-max-room-reuse']);
function validQuantities(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const known=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
  const fields=['supply','sold','publicBookings','phoneBookings'];
  if(fields.some(key=>value[key]!==undefined&&value[key]!==null&&!known(value[key])))return false;
  if(known(value.supply)&&known(value.sold)&&value.sold>value.supply)return false;
  return !['sold','publicBookings','phoneBookings'].every(key=>known(value[key]))||value.sold===value.publicBookings+value.phoneBookings;
}
function createInsightSavedReportSources({dataDir,fileSystem=fs,maxBytes=16*1024*1024,now=Date.now}={}) {
  if(typeof dataDir!=='string'||!dataDir||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>32*1024*1024||typeof now!=='function')throw TypeError('Saved report sources require a data directory and bounded reads');
  const directory=path.resolve(dataDir,'company_integrated');
  async function readMonth(companyId,month) {
    const folder=path.join(directory,digest(companyId)),file=path.join(folder,month+'.json');let handle;
    try {
      for(const parent of [directory,folder]){const stat=await fileSystem.lstat(parent);need(stat.isDirectory()&&!stat.isSymbolicLink());}
      const before=await fileSystem.lstat(file);need(before.isFile()&&!before.isSymbolicLink()&&Number.isSafeInteger(before.size)&&before.size<=maxBytes);
      handle=await fileSystem.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const opened=await handle.stat();need(opened.isFile()&&signature(opened)===signature(before));
      const buffer=Buffer.alloc(Math.min(maxBytes,opened.size)+1);let length=0;
      while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}
      need(length===opened.size&&signature(await handle.stat())===signature(opened)&&signature(await fileSystem.lstat(file))===signature(opened));
      return JSON.parse(buffer.toString('utf8',0,length));
    }catch(error){
      if(error.code==='ENOENT')throw Object.assign(fault('MONTH_NOT_OBSERVED'),{statusCode:400});
      throw fault(error.code==='SAVED_COMPANY_SOURCE_INVALID'?error.code:'SAVED_COMPANY_SOURCE_UNAVAILABLE');
    }finally{await handle?.close().catch(()=>{});}
  }
  async function companyDetail(companyId,{month,company}={}) {
    need(typeof companyId==='string'&&/^[a-zA-Z0-9_-]{1,300}$/.test(companyId));
    need(typeof month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(month));
    const value=await readMonth(companyId,month),snapshot=value?.snapshot,request=snapshot?.request;
    const [year,number]=month.split('-').map(Number),lastDay=new Date(Date.UTC(year,number,0)).toISOString().slice(0,10),today=new Date(Number(now())+32400000).toISOString().slice(0,10);
    need(value?.schemaVersion===1&&value.companyId===companyId&&value.month===month&&SUPPORTED_CALCULATIONS.has(value.calculationVersion)
      &&snapshot?.schemaVersion===1&&snapshot.target?.type==='company'&&snapshot.target.id===companyId&&request?.type==='company'
      &&request.targetId===companyId&&request.month===month&&request.cutoffDate===value.cutoffDate&&validDay(value.cutoffDate)&&value.cutoffDate<=today&&value.cutoffDate<=lastDay
      &&snapshot.period?.start===month+'-01'&&snapshot.period.end===lastDay&&snapshot.period.cutoffDate===value.cutoffDate
      &&snapshot.quality&&typeof snapshot.quality.status==='string'&&snapshot.summary?.lodging&&Array.isArray(snapshot.daily)
      &&Array.isArray(snapshot.companies)&&Array.isArray(snapshot.sources?.observations)&&Array.isArray(value.latestAttempts)&&Array.isArray(value.failedAttempts)
      &&Number.isFinite(Date.parse(value.calculatedAt))&&Date.parse(value.calculatedAt)<=Number(now())+60000);
    need(snapshot.companies.every(row=>row.companyId===companyId)&&snapshot.sources.observations.every(row=>row.companyId===companyId)
      &&snapshot.daily.every(row=>validDay(row.date)&&row.date.startsWith(month+'-'))
      &&validQuantities(snapshot.summary.lodging)&&snapshot.daily.every(row=>validQuantities(row.lodging))
      &&snapshot.sources.observations.every(validQuantities));
    // v1 may predate persisted revision markers. All supported later versions
    // must carry both integrity markers; accepting the version never bypasses
    // verification of the complete saved envelope.
    if(value.calculationVersion!=='company-integrated-v1')need(/^[a-f0-9]{64}$/.test(value.sourceRevision||'')&&/^[a-f0-9]{64}$/.test(value.cacheDigest||''));
    if(value.sourceRevision||value.cacheDigest){const {cacheDigest,...content}=value;need(typeof cacheDigest==='string'&&cacheDigest===digest(content));}
    const integrated=projectIntegrated(companyId,{...value,status:'ready',selectedMonth:month},month);
    need(Boolean(integrated.snapshot));
    // A saved estimate must not appear to use a newer reviewed room count.
    // Leave those quantities unknown until the normal read refreshes its model.
    if(company&&typeof company.rooms==='number'&&Number.isFinite(company.rooms)&&company.rooms>0
      &&integrated.roomBasis?.count!==company.rooms)throw fault('COMPANY_CAPACITY_REVIEW_CHANGED');
    return {companyId,legacyObservationView:false,integrated,current:{summary:integrated.snapshot.summary,daily:integrated.snapshot.daily}};
  }
  return {companyDetail};
}
module.exports={createInsightSavedReportSources};
