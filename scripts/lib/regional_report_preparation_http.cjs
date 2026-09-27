"use strict";

function createRegionalReportPreparationHttpHandler({ service, requireAdmin, parseJsonBody, send, rateLimit = () => {} }) {
  const base = "/api/regional-report-preparation";
  return async function handleRegionalReportPreparation(req, res, url, session) {
    if (url.pathname !== base) return false;
    if (!requireAdmin(session, req, res)) return true;
    try {
      if (req.method === "GET") {
        if ([...url.searchParams.keys()].some(key => !["regionKey", "month"].includes(key))
          || url.searchParams.getAll("regionKey").length !== 1 || url.searchParams.getAll("month").length !== 1) {
          send(res, 400, { error: "조회할 지역과 대상 월을 확인해 주세요." });
        } else {
          const job = await service.get({ regionKey: url.searchParams.get("regionKey"), month: url.searchParams.get("month") });
          send(res, 200, { job, searchTrendConnection: typeof service.connectionStatus === "function" ? await service.connectionStatus() : null });
        }
      } else if (req.method === "POST") {
        if (url.searchParams.size) { send(res, 400, { error: "수집 조건은 요청 본문으로 입력해 주세요." }); return true; }
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
          send(res, 415, { error: "JSON 형식으로 입력해 주세요." }); return true;
        }
        if (req.headers.origin) {
          let host = "";
          try { host = new URL(req.headers.origin).host; } catch { /* Reject malformed origins. */ }
          if (!host || host !== req.headers.host) { send(res, 403, { error: "현재 서비스 화면에서 다시 요청해 주세요." }); return true; }
        }
        const payload = await parseJsonBody(req);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || Object.keys(payload).some(key => !["regionKey", "month", "cutoffDate"].includes(key))) {
          send(res, 400, { error: "지역, 대상 월, 관측 마감일만 입력해 주세요." }); return true;
        }
        rateLimit(req, session);
        const job = await service.start(payload);
        send(res, ["queued", "running"].includes(job.status) ? 202 : 200, { job });
      } else send(res, 405, { error: "지원하지 않는 자료 준비 요청입니다." });
    } catch (error) {
      const status = [400, 404, 409, 429, 503].includes(Number(error.statusCode)) ? Number(error.statusCode) : 500;
      // Do not expose provider responses, authentication details or local paths.
      send(res, status, { error: status === 429 ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
        : status === 400 || status === 404 ? "시군구 지역과 올바른 대상 월·관측 마감일을 선택해 주세요."
          : status === 409 ? "다른 자료 준비 작업을 확인한 뒤 다시 시도해 주세요."
            : "자료 준비 상태를 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.",
        code: /^REGIONAL_[A-Z0-9_]+$/.test(error.code || "") ? error.code : "REGIONAL_PREPARATION_FAILED" });
    }
    return true;
  };
}

module.exports = { createRegionalReportPreparationHttpHandler };
