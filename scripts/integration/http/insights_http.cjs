"use strict";

const { INSIGHTS_API_BASE } = require("../contracts/insights.cjs");

function createInsightsHttpHandler(options = {}) {
  const service = options.service;
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  if (!service || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Stage 229 insights HTTP dependencies are required");
  }

  function isInsightsPath(pathname) {
    return pathname === INSIGHTS_API_BASE || pathname.startsWith(`${INSIGHTS_API_BASE}/`);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "INSIGHTS_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, { mutation, requireCsrf: mutation, session });
    return { session, context };
  }

  function adminAlias(pathname) {
    return pathname.replace(`${INSIGHTS_API_BASE}/admin/`, `${INSIGHTS_API_BASE}/`);
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isInsightsPath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session, context } = sessionAndContext(req, mutation);
      if (pathname.startsWith(`${INSIGHTS_API_BASE}/admin/`) && session.account?.role !== "admin") {
        const error = new Error("관리자 권한이 필요합니다.");
        error.statusCode = 403;
        error.code = "INSIGHTS_ROLE_FORBIDDEN";
        throw error;
      }
      const routePath = adminAlias(pathname);

      if (method === "GET" && pathname === `${INSIGHTS_API_BASE}/metadata`) {
        send(res, 200, { ok: true, metadata: service.metadata() });
        return true;
      }
      if (method === "GET" && pathname === `${INSIGHTS_API_BASE}/workspace`) {
        send(res, 200, await service.workspace(session, {
          view: reqUrl.searchParams.get("view") || "",
          companyId: reqUrl.searchParams.get("companyId") || "",
          tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || "",
          month: reqUrl.searchParams.get("month") || ""
        }, context));
        return true;
      }
      if (method === "GET" && pathname === `${INSIGHTS_API_BASE}/location-cards`) {
        send(res, 200, await service.listLocationCards(session, {
          companyId: reqUrl.searchParams.get("companyId") || "",
          tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || ""
        }, context));
        return true;
      }
      if (method === "GET" && pathname === `${INSIGHTS_API_BASE}/monthly-reports`) {
        send(res, 200, await service.listMonthlyReports(session, {
          companyId: reqUrl.searchParams.get("companyId") || "",
          tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || "",
          month: reqUrl.searchParams.get("month") || ""
        }, context));
        return true;
      }

      if (method === "POST" && routePath === `${INSIGHTS_API_BASE}/location-cards`) {
        const result = await service.requestLocationCard(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const cardDraftMatch = routePath.match(/^\/api\/integration\/insights\/location-cards\/([^/]+)\/draft$/);
      if (cardDraftMatch && method === "POST") {
        send(res, 201, await service.createLocationDraft(session, decodeURIComponent(cardDraftMatch[1]), await parseBody(req)));
        return true;
      }
      if (cardDraftMatch && method === "PATCH") {
        send(res, 200, await service.editLocationDraft(session, decodeURIComponent(cardDraftMatch[1]), await parseBody(req)));
        return true;
      }
      const cardEditAliasMatch = routePath.match(/^\/api\/integration\/insights\/location-cards\/([^/]+)$/);
      if (cardEditAliasMatch && method === "PATCH") {
        send(res, 200, await service.createOrEditLocationDraft(
          session,
          decodeURIComponent(cardEditAliasMatch[1]),
          await parseBody(req)
        ));
        return true;
      }
      const cardActionMatch = routePath.match(/^\/api\/integration\/insights\/location-cards\/([^/]+)\/(review|approve|changes-request|publish)$/);
      if (cardActionMatch && method === "POST") {
        const payload = await parseBody(req);
        const action = cardActionMatch[2];
        const result = action === "publish"
          ? await service.publishLocationCard(session, decodeURIComponent(cardActionMatch[1]), payload)
          : await service.reviewLocationCard(session, decodeURIComponent(cardActionMatch[1]), {
            ...payload,
            decision: action === "approve"
              ? "approve"
              : action === "changes-request" ? "request-changes" : payload.decision
          });
        send(res, 200, result);
        return true;
      }

      if (method === "POST" && routePath === `${INSIGHTS_API_BASE}/monthly-reports`) {
        const result = await service.createMonthlyReport(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const reportDraftMatch = routePath.match(/^\/api\/integration\/insights\/monthly-reports\/([^/]+)\/draft$/);
      if (reportDraftMatch && method === "POST") {
        send(res, 201, await service.createReportDraft(session, decodeURIComponent(reportDraftMatch[1]), await parseBody(req)));
        return true;
      }
      if (reportDraftMatch && method === "PATCH") {
        send(res, 200, await service.editReportDraft(session, decodeURIComponent(reportDraftMatch[1]), await parseBody(req)));
        return true;
      }
      const reportActionMatch = routePath.match(/^\/api\/integration\/insights\/monthly-reports\/([^/]+)\/(review|publish)$/);
      if (reportActionMatch && method === "POST") {
        const payload = await parseBody(req);
        const result = reportActionMatch[2] === "review"
          ? await service.reviewMonthlyReport(session, decodeURIComponent(reportActionMatch[1]), payload)
          : await service.publishMonthlyReport(session, decodeURIComponent(reportActionMatch[1]), payload);
        send(res, 200, result);
        return true;
      }

      if (method === "GET" && routePath === `${INSIGHTS_API_BASE}/snapshots`) {
        send(res, 200, await service.listSnapshots(session));
        return true;
      }
      if (method === "POST" && routePath === `${INSIGHTS_API_BASE}/snapshots`) {
        const payload = await parseBody(req);
        send(res, 201, await service.createSnapshot(session, payload.label || "manual"));
        return true;
      }
      const rollbackMatch = routePath.match(/^\/api\/integration\/insights\/snapshots\/([^/]+)\/rollback$/);
      if (method === "POST" && rollbackMatch) {
        send(res, 200, await service.rollbackSnapshot(session, decodeURIComponent(rollbackMatch[1])));
        return true;
      }

      send(res, 404, {
        error: "Stage 229 insights API route not found",
        code: "INSIGHTS_ROUTE_NOT_FOUND",
        metadata: service.metadata()
      });
      return true;
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      const internal = statusCode >= 500;
      send(res, statusCode, {
        error: internal ? "Stage 229 분석 요청을 안전하게 처리하지 못했습니다." : (error.message || "요청을 처리하지 못했습니다."),
        code: internal ? "INSIGHTS_INTERNAL_ERROR" : (error.code || "INSIGHTS_REQUEST_FAILED"),
        reauthenticationRequired: error.reauthenticationRequired || undefined,
        metadata: service.metadata()
      });
      return true;
    }
  }

  return Object.freeze({ handle, isInsightsPath });
}

module.exports = {
  INSIGHTS_API_BASE,
  createInsightsHttpHandler
};
