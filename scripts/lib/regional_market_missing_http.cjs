"use strict";

// Separate explicit collection command. Ordinary market reads stay read-only.
function createRegionalMarketMissingHttpHandler({ service, requireAdmin, parseJsonBody, send, rateLimit = () => {} }) {
  return async function handle(req, res, url, session) {
    if (url.pathname !== "/api/regional-market/missing-check") return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (url.searchParams.size) return send(res, 400, { code: "REGIONAL_MARKET_MISSING_INVALID_REQUEST" }), true;
      if (req.method === "GET") return send(res, 200, await service.get()), true;
      if (req.method !== "POST") return send(res, 405, { code: "REGIONAL_MARKET_MISSING_METHOD_NOT_ALLOWED" }), true;
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, { code: "REGIONAL_MARKET_MISSING_JSON_REQUIRED" }), true;
      if (req.headers.origin) {
        let host = ""; try { host = new URL(req.headers.origin).host; } catch {}
        if (!host || host !== req.headers.host) return send(res, 403, { code: "REGIONAL_MARKET_MISSING_ORIGIN_REJECTED" }), true;
      }
      let payload; try { payload = await parseJsonBody(req); } catch { return send(res, 400, { code: "REGIONAL_MARKET_MISSING_INVALID_REQUEST" }), true; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length) return send(res, 400, { code: "REGIONAL_MARKET_MISSING_INVALID_REQUEST" }), true;
      rateLimit(req, session);
      const result = await service.request();
      send(res, ["queued", "running"].includes(result?.job?.status) ? 202 : 200, result);
    } catch (error) {
      send(res, 503, { code: /^REGIONAL_MARKET_MISSING_[A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "REGIONAL_MARKET_MISSING_UNAVAILABLE",
        error: "누락 통계 확인 상태를 검증하지 못했습니다. 정상 자료와 기존 수집 일정은 유지됩니다." });
    }
    return true;
  };
}
module.exports = { createRegionalMarketMissingHttpHandler };
