"use strict";

const PHASES=new Set(["module_initialization","seed_outputs","collector_coordination","rotation_state","company_bootstrap","monthly_selector","integrated_catalog","integrated_revision","listen"]);
const KINDS=new Set(["company-bootstrap","company-revision-prepare","monthly-report-options","company-integrated-catalog","company-month","industry-build","keyword_monthly_refresh","keyword_monthly_analysis","keyword_monthly_options","keyword_monthly_saved_read","company-month-cached-verification","collection-postprocess"]);
const REASONS=new Set(["KEYWORD_INCREMENTAL_PREPARED_CONVERSION_ACTIVE","KEYWORD_INCREMENTAL_PREPARED_CONVERSION_UNVERIFIED","ANALYTICAL_MAINTENANCE_UNVERIFIED"]);
const number=n=>typeof n==="number"&&Number.isFinite(n)&&n>=0?n:null;
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const boolean=n=>typeof n==="boolean"?n:null;
const safeCode=error=>typeof error?.code==="string"&&/^[A-Z][A-Z0-9_]{1,99}$/.test(error.code)?error.code:"APPLICATION_STARTUP_UNAVAILABLE";

// A promise is not an event-loop owner. Keep one referenced timer only until
// guarded readiness succeeds or explicitly fails; it never admits work, alters
// a protection, retries a phase, or declares an incomplete application ready.
function createApplicationStartupLifetime({now=Date.now,setIntervalImpl=setInterval,clearIntervalImpl=clearInterval,
  onLog=value=>console.info("application_startup_diagnostic",JSON.stringify(value)),readAnalyticalStatus=null,
  readMemory=()=>process.memoryUsage(),
  heartbeatMs=15000}={}){
  if(typeof now!=="function"||typeof setIntervalImpl!=="function"||typeof clearIntervalImpl!=="function"
    || onLog!==null&&typeof onLog!=="function"||readAnalyticalStatus!==null&&typeof readAnalyticalStatus!=="function"||readMemory!==null&&typeof readMemory!=="function"
    || !Number.isSafeInteger(heartbeatMs)||heartbeatMs<1000||heartbeatMs>60000)throw TypeError("Invalid startup lifetime");
  let timer=null,beganAt=null,lastLogAt=null,current=null,active=false,terminal=null,sequence=0;
  const counters={phasesStarted:0,phasesCompleted:0,phasesFailed:0,observerErrors:0};
  const clock=()=>{try{return number(now());}catch{return null;}};
  const elapsed=(start,end)=>start===null||end===null?null:Math.max(0,end-start);
  function analytical(){
    if(!readAnalyticalStatus)return null;
    try{const s=readAnalyticalStatus();if(s==null)return null;return {active:boolean(s?.active),activeKind:s?.activeKind===null?null:KINDS.has(s?.activeKind)?s.activeKind:"other",
      queuedForeground:count(s?.queuedForeground),queuedBackground:count(s?.queuedBackground),memoryPaused:boolean(s?.memory?.paused),memoryRatio:number(s?.memory?.ratio),
      maintenancePaused:boolean(s?.maintenance?.paused),maintenanceReasonCode:s?.maintenance?.reasonCode==null?null:REASONS.has(s.maintenance.reasonCode)?s.maintenance.reasonCode:"ANALYTICAL_MAINTENANCE_OTHER"};}
    catch{counters.observerErrors++;return null;}
  }
  function emit(event,extra={}){
    if(!onLog)return;const at=clock();lastLogAt=at;
    let memory=null;try{const m=readMemory?.();if(m)memory=Object.fromEntries(["rss","heapUsed","heapTotal","external"].map(key=>[key,count(m[key])]));}catch{counters.observerErrors++;}
    try{const pending=onLog({event,phase:current?.name||null,elapsedMs:elapsed(beganAt,at),phaseElapsedMs:current?elapsed(current.startedAt,at):null,
      analytical:analytical(),memory,...extra});if(pending&&typeof pending.then==="function")Promise.resolve(pending).catch(()=>{counters.observerErrors++;});}
    catch{counters.observerErrors++;}
  }
  function begin(initialPhase=null){
    if(active||terminal!==null||initialPhase!==null&&initialPhase!=="module_initialization")throw Error("APPLICATION_STARTUP_LIFETIME_REUSED");
    beganAt=clock();active=true;
    if(initialPhase){current={name:initialPhase,startedAt:beganAt,sequence:++sequence};counters.phasesStarted++;}
    try{timer=setIntervalImpl(()=>{const at=clock();if(active&&(lastLogAt===null||at===null||at-lastLogAt>=heartbeatMs))emit("pending");},heartbeatMs);timer?.ref?.();}
    catch(error){active=false;if(timer!==null)clearIntervalImpl(timer);timer=null;throw error;}
    emit("begin");
  }
  async function phase(name,operation){
    if(!active||!PHASES.has(name)||name==="module_initialization"||typeof operation!=="function")throw Error("APPLICATION_STARTUP_PHASE_INVALID");
    if(current?.name==="module_initialization"){counters.phasesCompleted++;emit("phase_complete");current=null;}
    if(current)throw Error("APPLICATION_STARTUP_PHASE_INVALID");
    const item={name,startedAt:clock(),sequence:++sequence};current=item;counters.phasesStarted++;emit("phase_start");
    try{const result=await operation();counters.phasesCompleted++;emit("phase_complete");return result;}
    catch(error){counters.phasesFailed++;emit("phase_failed",{code:safeCode(error)});throw error;}
    finally{if(current===item)current=null;}
  }
  function stop(outcome,error){
    if(!active)return;
    if(outcome==="listening"&&current)throw Error("APPLICATION_STARTUP_PHASE_PENDING");
    emit(outcome==="listening"?"listening":"failed",outcome==="failed"?{code:safeCode(error)}:{});
    active=false;terminal=outcome;if(timer!==null)clearIntervalImpl(timer);timer=null;
  }
  return Object.freeze({begin,phase,complete:()=>stop("listening"),fail:error=>stop("failed",error),
    status:()=>({active,terminal,phase:current?.name||null,elapsedMs:elapsed(beganAt,clock()),...counters})});
}

module.exports={createApplicationStartupLifetime};
