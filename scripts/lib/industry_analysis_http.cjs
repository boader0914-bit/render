"use strict";

function createIndustryAnalysisHttpHandler({ service, requireAdmin, send, parseJsonBody, rateLimit = () => {} }) {
  return async function handleIndustryAnalysis(req, res, url, session) {
    const base = "/api/industry-analysis";
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (url.pathname === `${base}/rebuild`) {
        if (req.method !== "POST") { send(res, 405, { error: "집계 다시 준비는 POST 요청으로 실행합니다." }); return true; }
        if (url.searchParams.size) { send(res, 400, { error: "집계 조건은 요청 본문으로 입력해 주세요." }); return true; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
          send(res, 415, { error: "JSON 형식으로 입력해 주세요." }); return true;
        }
        if (req.headers.origin) {
          let origin;
          try { origin = new URL(req.headers.origin); } catch {}
          if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) {
            send(res, 403, { error: "현재 서비스 화면에서 다시 요청해 주세요." }); return true;
          }
        }
        const payload = await parseJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || Object.keys(payload).some(key => !["industry", "month", "region", "cutoffDate"].includes(key))) {
          send(res, 400, { error: "업종, 지역, 대상 월과 관측 마감일만 입력해 주세요." }); return true;
        }
        rateLimit(req, session);
        const result = await service.rebuild(payload);
        send(res, ["queued", "processing"].includes(result.storage?.status) ? 202 : 200, result);
        return true;
      }
      if (req.method !== "GET") { send(res, 405, { error: "업종 분석은 저장 자료 조회만 지원합니다." }); return true; }
      if (url.pathname === `${base}/options`) {
        if (url.searchParams.size) { send(res, 400, { error: "분석 조건 목록에는 URL 입력값을 사용하지 않습니다." }); return true; }
        send(res, 200, await service.options()); return true;
      }
      if (url.pathname !== base) { send(res, 404, { error: "업종 분석 경로를 확인해 주세요." }); return true; }
      const allowed = new Set(["industry", "month", "region", "cutoffDate"]);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length > 1)) {
        send(res, 400, { error: "분석 조건을 확인해 주세요." }); return true;
      }
      send(res, 200, await service.analyze(Object.fromEntries(url.searchParams)));
    } catch (error) {
      const status = [400, 404, 409, 429, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 500;
      send(res, status, { error: status === 400 || status === 404 ? "업종, 지역, 대상 월과 관측 마감일을 확인해 주세요."
        : status === 429 ? "집계 준비 요청이 많습니다. 잠시 후 다시 시도해 주세요."
          : "저장된 집계를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.",
        code: /^INDUSTRY_[A-Z0-9_]+$/.test(error.code || "") ? error.code : "INDUSTRY_ANALYSIS_UNAVAILABLE" });
    }
    return true;
  };
}
module.exports = { createIndustryAnalysisHttpHandler };
