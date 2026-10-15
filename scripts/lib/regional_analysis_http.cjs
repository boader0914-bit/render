"use strict";

function createRegionalAnalysisHttpHandler({ service, requireAdmin, parseJsonBody, send, rateLimit = () => {}, basePath = "/api/regional-analysis", allowPolicy = true }) {
  if (!["/api/regional-analysis", "/api/regional-outlook"].includes(basePath)) throw new TypeError("Invalid regional API path");
  const routes = new Set([basePath, `${basePath}/refresh`, ...(allowPolicy ? [`${basePath}/policy`] : [])]);
  return async function handle(req, res, url, session) {
    if (!routes.has(url.pathname)) return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method === "GET" && url.pathname === basePath) {
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !["regionKey", "month", "months"].includes(key)) || new Set(keys).size !== keys.length || !url.searchParams.get("regionKey")) {
          send(res, 400, { error: "조회할 지역과 기간을 확인해 주세요.", code: "REGIONAL_INVALID_REQUEST" }); return true;
        }
        const input = { regionKey: url.searchParams.get("regionKey") };
        if (url.searchParams.has("month")) input.month = url.searchParams.get("month");
        if (url.searchParams.has("months")) input.months = Number(url.searchParams.get("months"));
        send(res, 200, await service.get(input)); return true;
      }
      if (req.method !== "POST" || url.pathname === basePath) {
        send(res, 405, { error: "지원하지 않는 요청입니다." }); return true;
      }
      if (url.searchParams.size) { send(res, 400, { error: "조건은 요청 본문으로 입력해 주세요." }); return true; }
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
        send(res, 415, { error: "JSON 형식으로 입력해 주세요." }); return true;
      }
      if (req.headers.origin) {
        let host = "";
        try { host = new URL(req.headers.origin).host; } catch { /* Reject malformed origins. */ }
        if (!host || host !== req.headers.host) { send(res, 403, { error: "현재 서비스 화면에서 요청해 주세요." }); return true; }
      }
      let payload;
      try { payload = await parseJsonBody(req); }
      catch { send(res, 400, { error: "올바른 JSON 형식으로 입력해 주세요.", code: "REGIONAL_INVALID_REQUEST" }); return true; }
      const isPolicy = url.pathname.endsWith("/policy");
      const allowed = isPolicy ? ["regionKey", "month", "months", "enabled", "hour", "minute", "intervalHours"] : ["regionKey", "month", "months", "collectMissing"];
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key)) || !payload.regionKey
        || !isPolicy && payload.collectMissing !== undefined && typeof payload.collectMissing !== "boolean") {
        send(res, 400, { error: "지역과 갱신 조건을 확인해 주세요.", code: "REGIONAL_INVALID_REQUEST" }); return true;
      }
      rateLimit(req, session);
      const input = { regionKey: payload.regionKey, ...(payload.month === undefined ? {} : { month: payload.month }), ...(payload.months === undefined ? {} : { months: payload.months }) };
      if (isPolicy) {
        const policy = await service.updatePolicy(input, { enabled: payload.enabled, hour: payload.hour, minute: payload.minute, intervalHours: payload.intervalHours });
        send(res, 200, { policy });
      } else {
        const result = await service.request(input, { collectMissing: payload.collectMissing === true, reason: "manual" });
        send(res, ["queued", "running"].includes(result.job?.status) ? 202 : 200, result);
      }
    } catch (error) {
      const status = [400, 404, 409, 429, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 500;
      send(res, status, { error: status === 429 ? "요청이 많습니다. 잠시 후 다시 확인해 주세요." : status === 400 ? "지역과 갱신 조건을 확인해 주세요." : "지역 분석 저장 상태를 처리하지 못했습니다. 이전 정상 자료는 유지됩니다.",
        code: /^REGIONAL_[A-Z0-9_]{1,70}$/.test(error.code || "") ? error.code : "REGIONAL_ANALYSIS_FAILED" });
    }
    return true;
  };
}

module.exports = { createRegionalAnalysisHttpHandler };
