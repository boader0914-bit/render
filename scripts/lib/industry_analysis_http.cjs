"use strict";

function createIndustryAnalysisHttpHandler({ service, requireAdmin, send }) {
  return async function handleIndustryAnalysis(req, res, url, session) {
    const base = "/api/industry-analysis";
    if (url.pathname !== base && !url.pathname.startsWith(base + "/")) return false;
    if (!requireAdmin(session, req, res)) return true;
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
    return true;
  };
}
module.exports = { createIndustryAnalysisHttpHandler };
