"use strict";

const { getAnalyticalPhaseDiagnostics } = require("./analytical_phase_runtime.cjs");
const { createKeywordMonthlyQueryLifecycle } = require("./keyword_monthly_query_lifecycle.cjs");
const { createKeywordMonthlyResponseBudget } = require("./keyword_monthly_response_budget.cjs");
const { boundedJsonBuffer } = require("./bounded_company_response.cjs");
const { runKeywordMonthlyMemoryAdmission } = require("./keyword_monthly_memory_admission.cjs");
const { KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS } = require("./keyword_monthly_prepared_results.cjs");

function createKeywordMonthlyHttpHandler({ service, requireAdmin, send, readRefreshStatus = null,
  queryLifecycle = createKeywordMonthlyQueryLifecycle(),
  statusLifecycle = createKeywordMonthlyQueryLifecycle({maxInFlight:1, timeoutMs:5000}),
  responseBudget = createKeywordMonthlyResponseBudget({maxResponseBytes:KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes,
    maxReservedBytes:2*KEYWORD_MONTHLY_PREPARED_RESULT_LIMITS.responseBytes}),
  statusResponseBudget = createKeywordMonthlyResponseBudget({maxResponseBytes:2*1024*1024,maxReservedBytes:4*1024*1024}) } = {}) {
  if (typeof service?.options !== "function" || typeof service?.analyze !== "function" || typeof requireAdmin !== "function" || typeof send !== "function") throw new TypeError("Read-only keyword monthly service and HTTP helpers are required");
  async function read(req, res, identity, operation, {lifecycle=queryLifecycle,signal}={}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    // IncomingMessage.close also fires for an ordinary fully-read GET. Only
    // request abort or response disconnect ends this caller's read lifetime.
    req.once?.("aborted", onAbort); res.once?.("close", onClose);signal?.addEventListener("abort",onAbort,{once:true});
    if (req.aborted || res.destroyed && !res.writableEnded || signal?.aborted) controller.abort();
    try { return await lifecycle.run(identity, operation, { signal: controller.signal }); }
    finally { req.removeListener?.("aborted", onAbort); res.removeListener?.("close", onClose);signal?.removeEventListener("abort",onAbort); }
  }
  async function deliver(req,res,identity,operation,{statusRead=false}={}) {
    return (statusRead?statusResponseBudget:responseBudget).run(res,async({signal,maxResponseBytes,nativeResponse})=>{
      const result=await read(req,res,identity,operation,{signal,lifecycle:statusRead?statusLifecycle:queryLifecycle});
      if(req.aborted||res.destroyed||signal?.aborted)return;
      let body=result.body;
      if(nativeResponse){
        try { body=await runKeywordMonthlyMemoryAdmission(()=>boundedJsonBuffer(body,maxResponseBytes)); }
        catch(error){if(error?.code==="COMPANY_RESPONSE_TOO_LARGE")error.code="KEYWORD_MONTHLY_RESPONSE_TOO_LARGE";throw error;}
      }
      if(req.aborted||res.destroyed||signal?.aborted)return;
      send(res,result.http,body);
    });
  }
  return async function handleKeywordMonthly(req, res, url, session) {
    const base = "/api/keyword-monthly";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method !== "GET") { send(res, 405, { code: "KEYWORD_MONTHLY_METHOD_NOT_ALLOWED", error: "저장된 월별 키워드 자료 조회만 지원합니다.", readOnly: true, networkAttempted: false }); return true; }
      if (url.pathname === `${base}/version`) {
        if (url.searchParams.size) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
        if (typeof service.version !== "function") throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_VERSION_UNAVAILABLE", statusCode: 503 });
        await deliver(req,res,"version",async()=>{const result=await service.version();return {http:result.status==="available"?200:503,body:result};},{statusRead:true});return true;
      }
      if (url.pathname === `${base}/refresh-status` && typeof readRefreshStatus === "function") {
        if (url.searchParams.size) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
        await deliver(req,res,"refresh-status",async()=>({http:200,body:{...(await readRefreshStatus()),phaseDiagnostics:getAnalyticalPhaseDiagnostics().status(),
          queryDiagnostics:queryLifecycle.status(),responseDiagnostics:responseBudget.status(),readOnly:true,networkAttempted:false}}),{statusRead:true});return true;
      }
      if (url.pathname === `${base}/options`) {
        if (url.searchParams.size) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
        await deliver(req,res,"options",async()=>{
          const result=await service.options();let refreshStatus;
          if(typeof readRefreshStatus==="function"){
            try{refreshStatus=await readRefreshStatus();}
            catch{refreshStatus={status:"needs_verification",readOnly:true,errorCode:"KEYWORD_MONTHLY_REFRESH_STATUS_UNAVAILABLE"};}
          }
          return {http:result.status==="needs_verification"?503:200,body:refreshStatus?{...result,refreshStatus}:result};
        });return true;
      }
      if (url.pathname !== base) { send(res, 404, { code: "KEYWORD_MONTHLY_NOT_FOUND" }); return true; }
      const preparedOnly = Object.hasOwn(req.headers || {}, "x-keyword-monthly-prepared-only");
      if (preparedOnly && req.headers["x-keyword-monthly-prepared-only"] !== "1") throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
      if (preparedOnly && typeof service.readPrepared !== "function") throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_PREPARED_READ_UNAVAILABLE", statusCode: 503 });
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !["keyword", "month", "cutoffDate"].includes(key)) || new Set(keys).size !== keys.length
        || keys.some(key => !url.searchParams.get(key))) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
      const input = Object.fromEntries(url.searchParams);
      if (Buffer.byteLength(JSON.stringify(input)) > 4096) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
      const identity = JSON.stringify([input.keyword, input.month, input.cutoffDate ?? null]);
      await deliver(req,res,`${preparedOnly?"prepared":"analyze"}:${identity}`,async()=>{const result=await (preparedOnly?service.readPrepared(input):service.analyze(input));return {http:result.status==="needs_verification"?503:200,body:result};});
    } catch (error) {
      if (req.aborted || res.destroyed) return true;
      const status = error.statusCode === 400 ? 400 : 503;
      send(res, status, { status: "needs_verification", code: /^KEYWORD_MONTHLY_[A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "KEYWORD_MONTHLY_UNAVAILABLE",
        error: status === 400 ? "정확한 키워드·숙박월·관측 마감일을 확인해 주세요." : "저장 파생자료의 근거를 확인하지 못했습니다. 미확인 값을 0으로 바꾸지 않습니다.",
        snapshot: null, readOnly: true, networkAttempted: false });
    }
    return true;
  };
}
module.exports = { createKeywordMonthlyHttpHandler };
