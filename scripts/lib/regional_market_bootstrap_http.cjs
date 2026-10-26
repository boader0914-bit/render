"use strict";

function createRegionalMarketBootstrapHttpHandler({ service, requireAdmin, parseJsonBody, send, rateLimit = () => {}, now = () => Date.now() }) {
  if (typeof service?.get !== "function" || typeof service?.configure !== "function" || [requireAdmin, parseJsonBody, send, rateLimit, now].some(value => typeof value !== "function")) throw new TypeError("Invalid bootstrap policy HTTP options");
  // This deliberately small global ceiling is in addition to the application's
  // session/IP limiter. It cannot leak or retain account identifiers.
  let accepted = [];
  return async function handle(req, res, url, session) {
    if (url.pathname !== "/api/regional-market/bootstrap-policy") return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (url.searchParams.size) return send(res, 400, { code: "REGIONAL_MARKET_BOOTSTRAP_INVALID_POLICY" }), true;
      if (req.method === "GET") return send(res, 200, await service.get()), true;
      if (req.method !== "POST") return send(res, 405, { code: "REGIONAL_MARKET_BOOTSTRAP_METHOD_NOT_ALLOWED" }), true;
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) return send(res, 415, { code: "REGIONAL_MARKET_BOOTSTRAP_JSON_REQUIRED" }), true;
      let origin;
      try { origin = new URL(req.headers.origin); } catch {}
      const forwardedProtocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
      const protocol = req.socket?.encrypted ? "https:" : ["http", "https"].includes(forwardedProtocol) ? forwardedProtocol + ":" : origin?.protocol;
      if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.protocol !== protocol || origin.host !== req.headers.host
        || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) return send(res, 403, { code: "REGIONAL_MARKET_BOOTSTRAP_ORIGIN_REJECTED" }), true;
      let payload; try { payload = await parseJsonBody(req); } catch { return send(res, 400, { code: "REGIONAL_MARKET_BOOTSTRAP_INVALID_POLICY" }), true; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "enabled") || typeof payload.enabled !== "boolean") return send(res, 400, { code: "REGIONAL_MARKET_BOOTSTRAP_INVALID_POLICY" }), true;
      const time = Number(now()); if (!Number.isFinite(time)) throw Object.assign(new Error("REGIONAL_MARKET_BOOTSTRAP_CLOCK_INVALID"), { code: "REGIONAL_MARKET_BOOTSTRAP_CLOCK_INVALID" });
      accepted = accepted.filter(value => value > time - 3600000);
      if (accepted.length >= 4) return send(res, 429, { code: "REGIONAL_MARKET_BOOTSTRAP_RATE_LIMITED" }), true;
      try { await rateLimit(req, session); } catch { return send(res, 429, { code: "REGIONAL_MARKET_BOOTSTRAP_RATE_LIMITED" }), true; }
      accepted.push(time);
      send(res, 200, await service.configure({ enabled: payload.enabled }));
    } catch (error) {
      send(res, 503, { code: /^REGIONAL_MARKET_BOOTSTRAP_[A-Z0-9_]{1,80}$/.test(error.code || "") ? error.code : "REGIONAL_MARKET_BOOTSTRAP_UNAVAILABLE",
        error: "초기 일일 보완 설정을 검증하지 못했습니다. 정상 자료와 기존 수집 일정은 유지됩니다." });
    }
    return true;
  };
}
module.exports = { createRegionalMarketBootstrapHttpHandler };
