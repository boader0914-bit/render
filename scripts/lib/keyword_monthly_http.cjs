"use strict";

function createKeywordMonthlyHttpHandler({ service, requireAdmin, send } = {}) {
  if (typeof service?.options !== "function" || typeof service?.analyze !== "function" || typeof requireAdmin !== "function" || typeof send !== "function") throw new TypeError("Read-only keyword monthly service and HTTP helpers are required");
  return async function handleKeywordMonthly(req, res, url, session) {
    const base = "/api/keyword-monthly";
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "Cookie");
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method !== "GET") { send(res, 405, { code: "KEYWORD_MONTHLY_METHOD_NOT_ALLOWED", error: "저장된 월별 키워드 자료 조회만 지원합니다.", readOnly: true, networkAttempted: false }); return true; }
      if (url.pathname === `${base}/options`) {
        if (url.searchParams.size) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
        const result = await service.options();
        send(res, result.status === "needs_verification" ? 503 : 200, result); return true;
      }
      if (url.pathname !== base) { send(res, 404, { code: "KEYWORD_MONTHLY_NOT_FOUND" }); return true; }
      const keys = [...url.searchParams.keys()];
      if (keys.some(key => !["keyword", "month", "cutoffDate"].includes(key)) || new Set(keys).size !== keys.length
        || keys.some(key => !url.searchParams.get(key))) throw Object.assign(new Error(), { code: "KEYWORD_MONTHLY_INVALID_REQUEST", statusCode: 400 });
      const result = await service.analyze(Object.fromEntries(url.searchParams));
      send(res, result.status === "needs_verification" ? 503 : 200, result);
    } catch (error) {
      const status = error.statusCode === 400 ? 400 : 503;
      send(res, status, { status: "needs_verification", code: /^KEYWORD_MONTHLY_[A-Z0-9_]{1,100}$/.test(error.code || "") ? error.code : "KEYWORD_MONTHLY_UNAVAILABLE",
        error: status === 400 ? "정확한 키워드·숙박월·관측 마감일을 확인해 주세요." : "저장 파생자료의 근거를 확인하지 못했습니다. 미확인 값을 0으로 바꾸지 않습니다.",
        snapshot: null, readOnly: true, networkAttempted: false });
    }
    return true;
  };
}
module.exports = { createKeywordMonthlyHttpHandler };
