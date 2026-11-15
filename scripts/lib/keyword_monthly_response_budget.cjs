"use strict";
const fault = code => Object.assign(new Error(code), { code, statusCode: 503 });
const unavailable = res => res.destroyed || res.closed || res.writableFinished;

// Reserve before the read, keep the reservation through JSON preparation and
// socket completion, and never await a slow socket under an analytical lease.
// Header policy remains owned by the application's existing send() callback.
function createKeywordMonthlyResponseBudget({ maxResponseBytes = 8 * 1024 * 1024,
  maxReservedBytes = 16 * 1024 * 1024, timeoutMs = 30000,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (![maxResponseBytes,maxReservedBytes,timeoutMs].every(x=>Number.isSafeInteger(x)&&x>0)
    || maxResponseBytes>maxReservedBytes || [setTimeoutImpl,clearTimeoutImpl].some(fn=>typeof fn!=="function")) throw new TypeError("Invalid keyword response budget");
  let reservedBytes=0,activeResponses=0;
  async function run(res, operation) {
    if (typeof operation!=="function") throw new TypeError("Keyword response producer required");
    if (unavailable(res)) return false;
    // Lightweight handler unit doubles have no socket. Real HTTP responses
    // always take the bounded reservation/finish/close path below.
    if (typeof res.writeHead!=="function" || typeof res.end!=="function" || typeof res.on!=="function") {
      await operation({maxResponseBytes,nativeResponse:false});return true;
    }
    if(reservedBytes+maxResponseBytes>maxReservedBytes)throw fault("KEYWORD_MONTHLY_RESPONSE_BUSY");
    reservedBytes+=maxResponseBytes;activeResponses++;
    const controller=new AbortController();let timer=null,stopped=false,completed=false,released=false,preparing=true,invoke=operation,wake;
    operation=null;
    const done=new Promise(resolve=>{wake=resolve;});
    const release=()=>{if(!released){released=true;reservedBytes-=maxResponseBytes;activeResponses--;}};
    const detach=()=>{try{if(timer!==null)clearTimeoutImpl(timer);}catch{}for(const [name,listener] of [["finish",finish],["close",close],["error",error]]){try{res.removeListener(name,listener);}catch{}}};
    const stop=success=>{if(stopped)return;stopped=true;completed=success===true;controller.abort();detach();wake();};
    const finish=()=>stop(true),close=()=>stop(false),error=()=>{stop(false);res.destroy?.();};
    try{
      res.on("finish",finish);res.on("close",close);res.on("error",error);
      timer=setTimeoutImpl(()=>{stop(false);try{res.destroy?.();}catch{}},timeoutMs);timer?.unref?.();
    }catch(cause){preparing=false;stop(false);release();throw cause;}
    const production=Promise.resolve().then(()=>{
      if(stopped)return;const work=invoke;invoke=null;return work({signal:controller.signal,maxResponseBytes,nativeResponse:true});
    }).then(()=>{preparing=false;if(stopped)release();return true;},cause=>{preparing=false;if(stopped){release();return false;}throw cause;});
    try {
      const produced=await Promise.race([production,done.then(()=>false)]);
      if(!produced||stopped)return completed;
      await done;return completed;
    } finally {
      stop(false);detach();invoke=null;
      // A caller cannot recycle its reservation while an ignored cancellation
      // still retains preparation data. The shared read itself is not canceled.
      if(!preparing)release();
    }
  }
  return Object.freeze({run,status:()=>({maxResponseBytes,maxReservedBytes,timeoutMs,reservedBytes,activeResponses})});
}
module.exports={createKeywordMonthlyResponseBudget};
