"use strict";
const { fault } = require("./regional_market.cjs");
function createRegionalMarketHttpHandler({ service, requireAdmin, send } = {}) {
  if (typeof service?.get !== "function" || typeof requireAdmin !== "function" || typeof send !== "function") throw new TypeError("Regional market service and HTTP helpers are required");
  return async function handle(req, res, url, session) {
    if (url.pathname !== "/api/regional-market") return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method !== "GET") { send(res, 405, { code: "REGIONAL_MARKET_METHOD_NOT_ALLOWED", error: "저장된 지역 배후시장 조회만 지원합니다." }); return true; }
      const keys = [...url.searchParams.keys()];
      if (keys.some(k => !["regionKey", "month", "months"].includes(k)) || new Set(keys).size !== keys.length || !url.searchParams.get("regionKey")
        || keys.some(k => !url.searchParams.get(k)) || keys.includes("months") && !["13", "24"].includes(url.searchParams.get("months"))) throw fault("REGIONAL_MARKET_INVALID_SCOPE");
      const input = { regionKey: url.searchParams.get("regionKey"), ...(keys.includes("month") ? { month: url.searchParams.get("month") } : {}),
        ...(keys.includes("months") ? { months: Number(url.searchParams.get("months")) } : {}) };
      send(res, 200, await service.get(input));
    } catch (error) {
      const code = /^REGIONAL_MARKET_[A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "REGIONAL_MARKET_SOURCE_UNAVAILABLE";
      const status = error.statusCode === 400 ? 400 : 503;
      send(res, status, { code, error: status === 400 ? "시군구 지역과 조회 마감월·기간을 확인하세요." : "저장 지역 자료의 조건·근거를 확인하지 못했습니다. 미확보나 0으로 바꾸지 않습니다.", networkAttempted: false, readOnly: true });
    }
    return true;
  };
}
module.exports = { createRegionalMarketHttpHandler };
