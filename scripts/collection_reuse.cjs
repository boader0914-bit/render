const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { inspectManifest } = require('./daily_collection_quality.cjs');

function serialExecutor() {
  let tail = Promise.resolve();
  const context = new AsyncLocalStorage();
  return fn => {
    if (context.getStore()) return Promise.resolve().then(fn);
    const result = tail.then(() => context.run(true, fn));
    tail = result.catch(() => {});
    return result;
  };
}
const dayKey = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
const keywordKey = value => String(value || '').normalize('NFKC').trim().toLowerCase();
function problem(code, message, extra = {}) { return Object.assign(new Error(message), {code, statusCode:409, ...extra}); }
function rankSet(value) {
  const values = new Set();
  for (const part of String(value || '').split(',')) {
    const m = /^\s*(\d+)(?:\s*[-~–]\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2] || a);
    if (a < 1 || b < a || b > 1000) return null;
    for (let n = a; n <= b; n++) values.add(n);
  }
  return [...values].sort((a,b)=>a-b);
}
function scope(value) {
  const ranks=rankSet(value.detailRankRanges || '1-20');
  const cap=Number(value.bookingRangePlaceLimit || 0);
  return {
    keyword:keywordKey(value.keyword), checkIn:value.checkIn || '', checkOut:value.checkOut || '',
    bookingRangeDays:Number(value.bookingRangeDays || 1), adults:Number(value.adults || 2),
    searchMode:value.resolvedSearchMode || value.searchMode || 'keyword', searchIntent:value.searchIntent || '',
    searchRegion:value.searchRegion || '', searchScope:value.searchScope || '',
    productMode:value.productMode || 'all', collectionMode:value.collectionMode || 'precision',
    collectionPurpose:value.collectionPurpose || 'revenue_detail',
    ranks, bookingRangePlaceLimit:cap > 0 && ranks && cap < ranks.length ? cap : 0
  };
}
function covers(have, wanted) {
  for (const key of ['keyword','adults','searchMode','searchIntent','searchRegion','searchScope','collectionMode','collectionPurpose']) {
    if (have[key] !== wanted[key]) return false;
  }
  if (have.productMode !== wanted.productMode && have.productMode !== 'all') return false;
  if (!have.ranks || !wanted.ranks || wanted.ranks.some(n => !have.ranks.includes(n))) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(have.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(wanted.checkIn)) return false;
  // Arrival/departure affect the initial search and prices, independently of the daily snapshot range.
  if (have.checkIn !== wanted.checkIn || have.checkOut !== wanted.checkOut || have.bookingRangeDays < wanted.bookingRangeDays) return false;
  // A place cap is applied after rank selection; equal caps do not prove coverage of a shifted rank subset.
  if ((have.bookingRangePlaceLimit > 0 || wanted.bookingRangePlaceLimit > 0)
    && (have.bookingRangePlaceLimit !== wanted.bookingRangePlaceLimit || JSON.stringify(have.ranks)!==JSON.stringify(wanted.ranks))) return false;
  if (have.bookingRangePlaceLimit > 0 && (wanted.bookingRangePlaceLimit === 0 || have.bookingRangePlaceLimit < wanted.bookingRangePlaceLimit)) return false;
  return true;
}
async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), {flag:'wx', mode:0o600});
  await fs.rename(tmp,file);
}
function createCollectionReuse({dataDir, outputsDir, now = () => new Date(), inspect = inspectManifest, onJoin = () => {}}) {
  const file = path.join(dataDir,'history','collection-reuse.json');
  const lock = serialExecutor();
  const active = new Map();
  let initialized = false;
  let rows = [];
  async function initialize() {
    if (initialized) return;
    try {
      const stored = JSON.parse(await fs.readFile(file,'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.entries)) throw new Error();
      rows = stored.entries;
    } catch(error) { if(error.code !== 'ENOENT') throw problem('COLLECTION_HISTORY_UNREADABLE','중복 확인 기록을 읽을 수 없어 수집을 보류합니다.'); }
    let changed = false;
    for (const row of rows) if(row.status === 'running') { row.status='interrupted'; changed=true; }
    if(changed) await persist();
    initialized=true;
  }
  async function persist() { await atomicJson(file,{version:1,entries:rows}); }
  async function resultsToday(day) {
    let dirs;
    try { dirs=await fs.readdir(outputsDir,{withFileTypes:true}); } catch(error) { if(error.code==='ENOENT') return []; throw error; }
    const results=[];
    for(const dir of dirs) {
      if(!dir.isDirectory() || !/^[a-z0-9][a-z0-9_-]*_glamping_\d{8}(?:_\d{6})?$/.test(dir.name)) continue;
      try {
        const outputDir=path.join(outputsDir,dir.name);
        const m=JSON.parse(await fs.readFile(path.join(outputDir,'manifest.json'),'utf8'));
        const observed=m.startedAt || m.collectionStartedAt || m.collectedAt;
        if(!observed || !Number.isFinite(Date.parse(observed)) || dayKey(observed)!==day)continue;
        const quality=inspect(m);
        const listed=[...(m.files||[]),...(m.detailJsonFiles||[]).map(v=>v.file)];
        let valid=listed.length>0;
        for(const name of listed) {
          if(typeof name!=='string' || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) {valid=false;break;}
          const stat=await fs.lstat(path.join(outputDir,name)).catch(()=>null);
          if(!stat || !stat.isFile() || stat.isSymbolicLink()) {valid=false;break;}
        }
        results.push({runId:dir.name,manifest:m,scope:scope(m),observedAt:observed,quality,valid});
      } catch { /* An incomplete artifact can never be reused as a successful result. */ }
    }
    return results.sort((a,b)=>b.observedAt.localeCompare(a.observedAt));
  }
  async function run(payload, execute) {
    const wanted=scope(payload), day=dayKey(now());
    const bypass=payload.allowRepeat===true && String(payload.repeatReason||'').trim().length>=4;
    const choice=await lock(async()=>{
      await initialize();
      const same=rows.filter(row=>row.scope?.keyword===wanted.keyword && (row.day===day || active.has(row.id)));
      const running=same.find(row=>active.has(row.id) && covers(row.scope,wanted));
      if(running) { await onJoin(running, payload); return {promise:active.get(running.id), shared:true}; }
      if(same.some(row=>active.has(row.id))) throw problem('COLLECTION_SCOPE_BUSY','같은 키워드의 수집이 진행 중입니다. 완료 후 범위를 확인해 주세요.');
      const available=await resultsToday(day);
      const reusable=available.find(row=>row.valid && row.quality.status==='complete' && covers(row.scope,wanted));
      if(reusable && !bypass) return {reusable};
      if(!bypass && (same.some(row=>['failed','partial','blocked','interrupted','running'].includes(row.status))
        || available.some(row=>row.scope.keyword===wanted.keyword && (!row.valid || row.quality.status!=='complete')))) {
        throw problem('COLLECTION_REVIEW_REQUIRED','오늘 같은 키워드의 미완료 기록이 있습니다. 원인을 확인한 뒤 별도 재수집 사유를 입력해 주세요.');
      }
      if(!bypass && (available.some(row=>row.scope.keyword===wanted.keyword) || same.some(row=>row.status==='complete'))) {
        throw problem('COLLECTION_SCOPE_REVIEW','오늘 수집한 자료와 요청 범위가 다르거나 저장 파일 확인이 필요합니다. 필요한 범위를 확인하고 재수집 사유를 입력해 주세요.');
      }
      const row={id:crypto.randomUUID(),day,scope:wanted,status:'running',workerKey:payload.workerKey||'manual',trigger:payload.trigger||'manual',createdAt:new Date(now()).toISOString(),repeatReason:bypass?String(payload.repeatReason).trim():''};
      rows.push(row); await persist();
      let resolve,reject;
      const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
      promise.catch(()=>{});
      active.set(row.id,promise);
      return {row,promise,resolve,reject};
    });
    if(choice.reusable) {
      const r=choice.reusable;
      return {runId:r.runId,collectionQuality:inspect(r.manifest),reused:true,reuse:{mode:'same_day',runId:r.runId,observedAt:r.observedAt},
        workerKey:r.manifest.workerKey||null,trigger:r.manifest.trigger||null,collectorEngine:r.manifest.collectorEngine||null,
        crawlTiming:{recorded:false,reused:true,reuseMode:'same_day',reusedRunId:r.runId,reusedCompletedAt:r.manifest.collectedAt||r.observedAt,durationSeconds:0,success:true},
        queueStatus:{mode:'completed_reuse'}};
    }
    if(choice.shared) return {...await choice.promise,reused:true,reuse:{mode:'shared'},queueStatus:{mode:'shared'}};
    try {
      const result=await execute();
      const quality=result.collectionQuality || inspect(result.output);
      await lock(async()=>{Object.assign(choice.row,{status:quality.status,runId:result.runId||null,finishedAt:new Date(now()).toISOString()});await persist();active.delete(choice.row.id);});
      choice.resolve(result); return result;
    } catch(error) {
      try {
        await lock(async()=>{Object.assign(choice.row,{status:error.code?.includes('BLOCK')?'blocked':'failed',errorCode:error.code||'COLLECTION_FAILED',finishedAt:new Date(now()).toISOString()});await persist();});
      } finally {
        active.delete(choice.row.id);
        choice.reject(error);
      }
      throw error;
    }
  }
  async function recoveryScope({keyword,workerKey,createdAt,jobCreatedAt}) {return lock(async()=>{
    await initialize();
    const matches=rows.filter(row=>row.workerKey===workerKey && row.scope?.keyword===keywordKey(keyword)
      && row.status==='failed' && row.errorCode==='COLLECTOR_UPLOAD_FAILED'
      && Date.parse(row.createdAt)>=Date.parse(createdAt) && Date.parse(row.createdAt)<=Date.parse(jobCreatedAt));
    if(matches.length!==1)throw problem('COLLECTION_RECOVERY_SCOPE_UNCONFIRMED','원 수집 조건을 하나로 확인하지 못했습니다.');
    return structuredClone(matches[0].scope);
  });}
  return {run, recoveryScope, initialize:()=>lock(initialize)};
}
module.exports={createCollectionReuse,serialExecutor,dayKey,keywordKey,scope,covers};
