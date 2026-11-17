"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const { runKeywordMonthlyMemoryAdmission } = require("./keyword_monthly_memory_admission.cjs");
const { withKeywordMonthlyGuardDiagnostic } = require("./keyword_monthly_guard_diagnostics.cjs");
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });

// One immutable saved-result cohort, including ALL shared HTTP responses and
// ignored cancellation, owns the allocation permit. No result cache is kept.
// The permit uses an explicit isolated-child await window or pauses an exact
// eligible industry owner at its safe checkpoint. Fallback source calculations
// always reacquire the application's exclusive lease.
function createKeywordMonthlySavedReadService({ saved, runWork, acquirePermit, assertReadAdmission,
  runMemoryAdmission = runKeywordMonthlyMemoryAdmission, diagnostics = null } = {}) {
  if (![saved?.options,saved?.readPrepared,saved?.analyze,runWork,acquirePermit,assertReadAdmission,runMemoryAdmission].every(value=>typeof value==="function")) throw new TypeError("Explicit saved-read capabilities required");
  const context = new AsyncLocalStorage(), entries = new Map(); let owner = null;
  const counts = { started:0, completed:0, fallback:0, busy:0, cleanupErrors:0 };
  const busy = () => { counts.busy++; return fault("KEYWORD_MONTHLY_QUERY_BUSY"); };
  function releasePermit(entry) {
    if (!entry.permit) return true;
    try { entry.permit.release(); entry.permit = null; return true; }
    catch { counts.cleanupErrors++; return false; }
  }
  function clean(entry) {
    if (entry.refs.size || entry.flightActive || entry.producers || entry.responseOperations) return;
    if (!releasePermit(entry)) return;
    if (owner === entry) owner = null;
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }
  function current() { const entry=context.getStore(); if(!entry)throw fault("KEYWORD_MONTHLY_SAVED_READ_CONTEXT_REQUIRED");return entry; }
  async function withResponse(identity,res,operation) {
    if(typeof identity!=="string"||!identity||Buffer.byteLength(identity)>8192||!res||typeof operation!=="function")throw new TypeError("Invalid saved response owner");
    if(res.destroyed)throw fault("KEYWORD_MONTHLY_QUERY_ABORTED");
    await assertReadAdmission();
    if(res.destroyed)throw fault("KEYWORD_MONTHLY_QUERY_ABORTED");
    const key=crypto.createHash("sha256").update(identity).digest("hex");let entry=entries.get(key);
    // A closed child window can drain only its original callers. Repeated
    // joins cannot indefinitely postpone final parent decode/publication.
    const responseWindowClosed = Boolean(entry?.permit && !entry.permit.acceptsNewResponses());
    if(entry && (responseWindowClosed
      || entry.readStarted && !entry.flightActive))throw withKeywordMonthlyGuardDiagnostic(fault("KEYWORD_MONTHLY_ANALYTICAL_BUSY"), {
        component:"saved_read",reason:responseWindowClosed?"response_window_closed":"response_flight_settled",activeKind:null
      });
    if(!entry){if(entries.size>=4)throw busy();entry={key,refs:new Set(),producers:0,responseOperations:0,flightActive:false,readStarted:false,permit:null};entries.set(key,entry);}
    const ref={released:false};entry.refs.add(ref);entry.responseOperations++;
    const native=typeof res.once==="function"&&typeof res.removeListener==="function"&&typeof res.writeHead==="function"&&typeof res.end==="function";
    const release=()=>{if(ref.released)return;ref.released=true;entry.refs.delete(ref);if(native){res.removeListener("finish",release);res.removeListener("close",release);res.removeListener("error",release);}clean(entry);};
    try {
      if(native){res.once("finish",release);res.once("close",release);res.once("error",release);if(res.destroyed)throw fault("KEYWORD_MONTHLY_QUERY_ABORTED");}
      return await context.run(entry,operation);
    } catch(error){release();throw error;}
    finally{entry.responseOperations--;if(!native)release();clean(entry);}
  }
  async function withProducer(operation) {
    const entry=current();entry.producers++;
    try{return await operation();}finally{entry.producers--;clean(entry);}
  }
  function lifecycleOptions() {
    const entry=context.getStore();if(!entry)return {};
    return {onOperationSettled:()=>{entry.flightActive=false;clean(entry);}};
  }
  async function savedRead(operation) {
    const entry=current();entry.flightActive=true;
    if(entry.readStarted || owner && owner!==entry)throw busy();
    entry.readStarted=true;owner=entry;counts.started++;
    await assertReadAdmission();
    entry.permit=acquirePermit();
    const work=async info=>runMemoryAdmission(async()=>{
      await assertReadAdmission();
      const result=await operation();
      await assertReadAdmission();
      return result;
    });
    const result=await entry.permit.run(diagnostics?diagnostics.work(work):work);counts.completed++;return result;
  }
  // Publication detection is a bounded pointer-only status read. It owns no
  // saved graph permit and never falls back to a projection/source calculation.
  async function version(){
    if(typeof saved.version!=="function")throw fault("KEYWORD_MONTHLY_VERSION_UNAVAILABLE");
    return saved.version();
  }
  async function options(){return savedRead(()=>saved.options());}
  // Automatic refresh is an explicit capability: even the not_prepared
  // sentinel returns unchanged; only a manual analyze call may fall back.
  async function readPrepared(input){return savedRead(()=>saved.readPrepared(input));}
  async function analyze(input){
    const result=await savedRead(()=>saved.readPrepared(input));
    if(result?.preparedResult?.status!=="not_prepared")return result;
    const entry=current();
    // Only the small explicit not_prepared sentinel permits fallback. The
    // cohort remains single-owner through fallback work and slow responses.
    const permit=entry.permit;
    if(!releasePermit(entry))throw fault("KEYWORD_MONTHLY_SAVED_READ_RELEASE_UNVERIFIED");
    // A borrowed checkpoint must settle before entering the ordinary queue;
    // waiting for fallback while the industry owner is suspended is a cycle.
    if(typeof permit?.waitForRelease==="function")await permit.waitForRelease();
    counts.fallback++;
    return runWork(diagnostics?diagnostics.work(()=>saved.analyze(input)):()=>saved.analyze(input),
      {kind:"keyword_monthly_analysis",...(diagnostics?diagnostics.schedulerOptions():{})});
  }
  async function beforeResponse(){
    current();await runMemoryAdmission(async()=>undefined);await assertReadAdmission();
  }
  return Object.freeze({version,options,readPrepared,analyze,withResponse,withProducer,lifecycleOptions,beforeResponse,
    status:()=>({...counts,active:Boolean(owner),cohorts:entries.size,responseOwners:[...entries.values()].reduce((n,e)=>n+e.refs.size,0),
      operationPending:[...entries.values()].filter(e=>e.flightActive).length,producers:[...entries.values()].reduce((n,e)=>n+e.producers,0),
      responseOperations:[...entries.values()].reduce((n,e)=>n+e.responseOperations,0),permitActive:Boolean(owner?.permit)})});
}

module.exports={createKeywordMonthlySavedReadService};
