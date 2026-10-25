'use strict';
const {performance}=require('node:perf_hooks');
const {setTimeout:delay}=require('node:timers/promises');

const transientStatuses=new Set([502,503,504]);
const neverRetryStatuses=new Set([401,403,429]);
const transientCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT']);
function routeLabel(route){
  return String(route).replace(/\/(companies|regions|customers)\/[^/]+/g,'/$1/:id');
}
function retryDelay(response,now){
  const value=response?.headers?.get?.('retry-after');
  if(value==null||value==='')return 120;
  const numeric=/^\d+(?:\.\d+)?$/.test(String(value).trim())?Number(value)*1000:null;
  // Date.parse also accepts strings such as "-1" as past dates. Only the
  // standard HTTP-date form may select an immediate/short automatic retry.
  const parsed=numeric===null&&/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(String(value).trim())?Date.parse(value):null;
  const wait=numeric===null?(Number.isFinite(parsed)?Math.max(0,parsed-now):null):numeric;
  // Do not ignore a long server-requested pause or turn an interactive read into
  // an extended retry loop. A later user read can try after that pause.
  return wait!==null&&wait<=750?wait:null;
}
function networkFailure(error){
  return error instanceof TypeError||transientCodes.has(error?.code)||transientCodes.has(error?.cause?.code);
}
function createUpstreamReader({backend,fetchImpl=globalThis.fetch,readTimeout,logger=entry=>console.warn('insight_upstream',JSON.stringify(entry)),sleep=delay,now=()=>Date.now(),clock=()=>performance.now()}){
  const emit=entry=>{try{logger(entry);}catch{/* Diagnostics must not change the request result. */}};
  return async function readUpstream(route,search,headers,{method='GET',body,stage='source',timing,timeoutMs,background=false}={}){
    const backgroundCompany=background===true&&method==='GET'&&stage==='source'&&/\/companies\/[a-zA-Z0-9_-]+\/collection$/.test(route);
    const configuredBudget=readTimeout(method,route,{background:backgroundCompany}),budget=Number.isSafeInteger(timeoutMs)&&timeoutMs>0?Math.min(configuredBudget,timeoutMs):configuredBudget,signal=AbortSignal.timeout(budget),requestStarted=clock();
    const transport=backgroundCompany&&fetchImpl===globalThis.fetch?require('./background-json-get.cjs').backgroundJsonGet:fetchImpl;
    const requestId=timing?.requestId||require('node:crypto').randomUUID();
    const base={requestId,route:routeLabel(route),method,stage:stage||'command'};
    let attempt=0;
    while(++attempt<=2){
      let phase='upstream_headers',started=clock(),response=null,data,problem=null;
      try{
        response=await transport(`${backend}/api/insight/v1${route}${search}`,{method,headers,body,redirect:'error',signal});
        timing?.add(phase,clock()-started);phase='upstream_body';started=clock();
        timing?.central(response.headers?.get?.('server-timing'));
        data=await response.json();timing?.add(phase,clock()-started);phase=null;
      }catch(error){
        if(phase)timing?.add(phase,clock()-started);
        problem=error;
      }
      const timedOut=problem?.name==='TimeoutError'||signal.aborted&&signal.reason?.name==='TimeoutError';
      const parseFailure=!!problem&&phase==='upstream_body';
      const transientStatus=transientStatuses.has(response?.status);
      const transientFailure=!timedOut&&!!problem&&(!response||response.ok||transientStatus)&&(parseFailure||networkFailure(problem));
      const failed=!!problem||!response?.ok;
      if(!failed){
        if(attempt>1)emit({...base,outcome:'recovered',attempt,status:response.status,phase:'complete',elapsedMs:Math.round(clock()-requestStarted)});
        return {status:response.status,ok:response.ok,data};
      }
      const errorClass=timedOut?'timeout':parseFailure?'invalid_json':problem?'network_error':'upstream_http';
      const pause=retryDelay(response,now());
      const retry=method==='GET'&&attempt===1&&!neverRetryStatuses.has(response?.status)&&(transientStatus||transientFailure)&&pause!==null&&!signal.aborted&&clock()-requestStarted+pause<budget;
      emit({...base,outcome:retry?'retrying':'failed',attempt,status:response?.status||null,phase:phase||'complete',errorClass,elapsedMs:Math.round(clock()-requestStarted),...(retry?{retryAfterMs:pause}:{})});
      if(retry){
        try{await sleep(pause,undefined,{signal});continue;}catch(error){
          problem=error;
          emit({...base,outcome:'failed',attempt,status:response?.status||null,phase:'retry_wait',errorClass:signal.aborted&&signal.reason?.name==='TimeoutError'?'timeout':'retry_delay_error',elapsedMs:Math.round(clock()-requestStarted)});
        }
      }
      if(stage&&(timedOut||signal.aborted&&signal.reason?.name==='TimeoutError'))return {status:504,ok:false,data:{error:{code:'UPSTREAM_TIMEOUT',stage,message:stage==='identity'?'로그인 확인이 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.':'자료 조회가 지연되어 연결하지 못했습니다. 잠시 후 다시 열어 주세요.'}}};
      if(problem){
        // A non-JSON authentication/rate-limit response must retain its status;
        // it must never become a retry or an authorized cached response.
        if(neverRetryStatuses.has(response?.status))return {status:response.status,ok:false,data:{error:{code:response.status===429?'UPSTREAM_RATE_LIMITED':response.status===401?'AUTHENTICATION_REQUIRED':'ACCESS_DENIED',message:response.status===429?'요청이 많아 잠시 조회할 수 없습니다. 잠시 후 다시 열어 주세요.':'로그인 및 접근 권한을 다시 확인해 주세요.'}}};
        throw problem;
      }
      return {status:response.status,ok:response.ok,data};
    }
  };
}
module.exports={createUpstreamReader,routeLabel,retryDelay};
