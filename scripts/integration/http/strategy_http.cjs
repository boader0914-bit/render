"use strict";

const { STRATEGY_API_BASE } = require("../contracts/strategy_execution.cjs");

function createStrategyHttpHandler(options = {}) {
  const service = options.service;
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  if (!service || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Stage 230 strategy HTTP dependencies are required");
  }

  function isStrategyPath(pathname) {
    return pathname === STRATEGY_API_BASE || pathname.startsWith(`${STRATEGY_API_BASE}/`);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "STRATEGY_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, { mutation, requireCsrf: mutation, session });
    return { session, context };
  }

  function query(reqUrl) {
    return {
      view: reqUrl.searchParams.get("view") || "",
      companyId: reqUrl.searchParams.get("companyId") || "",
      tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || "",
      month: reqUrl.searchParams.get("month") || "",
      reportId: reqUrl.searchParams.get("reportId") || "",
      domain: reqUrl.searchParams.get("domain") || "",
      status: reqUrl.searchParams.get("status") || "",
      owner: reqUrl.searchParams.get("owner") || "",
      due: reqUrl.searchParams.get("due") || "",
      targetMonth: reqUrl.searchParams.get("targetMonth") || "",
      type: reqUrl.searchParams.get("type") || "",
      planId: reqUrl.searchParams.get("planId") || "",
      retrospectiveId: reqUrl.searchParams.get("retrospectiveId") || ""
    };
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isStrategyPath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session, context } = sessionAndContext(req, mutation);
      if (pathname.startsWith(`${STRATEGY_API_BASE}/admin/`) && (session.account?.role || session.role) !== "admin") {
        const error = new Error("관리자 권한이 필요합니다.");
        error.statusCode = 403;
        error.code = "STRATEGY_ROLE_FORBIDDEN";
        throw error;
      }
      const routePath = pathname.replace(`${STRATEGY_API_BASE}/admin/`, `${STRATEGY_API_BASE}/`);
      const requestQuery = query(reqUrl);

      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/metadata`) {
        send(res, 200, { ok: true, metadata: service.metadata() });
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/workspace`) {
        send(res, 200, await service.workspace(session, requestQuery, context));
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/strategies`) {
        send(res, 200, await service.listStrategies(session, requestQuery, context));
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/plans`) {
        send(res, 200, await service.listPlans(session, requestQuery, context));
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/board`) {
        send(res, 200, await service.board(session, requestQuery, context));
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/retrospectives`) {
        send(res, 200, await service.listRetrospectives(session, requestQuery, context));
        return true;
      }
      if (method === "GET" && routePath === `${STRATEGY_API_BASE}/candidates`) {
        send(res, 200, await service.listCandidates(session, requestQuery, context));
        return true;
      }

      if (method === "POST" && routePath === `${STRATEGY_API_BASE}/strategies/generate`) {
        const result = await service.generateStrategies(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      if (method === "POST" && routePath === `${STRATEGY_API_BASE}/plans`) {
        const result = await service.createPlan(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const planMatch = routePath.match(/^\/api\/integration\/strategy\/plans\/([^/]+)$/);
      if (method === "PATCH" && planMatch) {
        send(res, 200, await service.updatePlan(session, decodeURIComponent(planMatch[1]), await parseBody(req), context));
        return true;
      }
      const itemCreateMatch = routePath.match(/^\/api\/integration\/strategy\/plans\/([^/]+)\/items$/);
      if (method === "POST" && itemCreateMatch) {
        const result = await service.addPlanItem(session, decodeURIComponent(itemCreateMatch[1]), await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const itemMatch = routePath.match(/^\/api\/integration\/strategy\/plans\/([^/]+)\/items\/([^/]+)$/);
      if (method === "PATCH" && itemMatch) {
        send(res, 200, await service.updatePlanItem(
          session,
          decodeURIComponent(itemMatch[1]),
          decodeURIComponent(itemMatch[2]),
          await parseBody(req),
          context
        ));
        return true;
      }
      const kpiCreateMatch = routePath.match(/^\/api\/integration\/strategy\/plans\/([^/]+)\/items\/([^/]+)\/kpis$/);
      if (method === "POST" && kpiCreateMatch) {
        const result = await service.addKpi(
          session,
          decodeURIComponent(kpiCreateMatch[1]),
          decodeURIComponent(kpiCreateMatch[2]),
          await parseBody(req),
          context
        );
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const kpiMatch = routePath.match(/^\/api\/integration\/strategy\/plans\/([^/]+)\/items\/([^/]+)\/kpis\/([^/]+)$/);
      if (method === "PATCH" && kpiMatch) {
        send(res, 200, await service.updateKpi(
          session,
          decodeURIComponent(kpiMatch[1]),
          decodeURIComponent(kpiMatch[2]),
          decodeURIComponent(kpiMatch[3]),
          await parseBody(req),
          context
        ));
        return true;
      }
      if (method === "POST" && routePath === `${STRATEGY_API_BASE}/retrospectives`) {
        const result = await service.createRetrospective(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const candidateMatch = routePath.match(/^\/api\/integration\/strategy\/retrospectives\/([^/]+)\/candidates$/);
      if (method === "POST" && candidateMatch) {
        const result = await service.generateNextMonthCandidates(
          session,
          decodeURIComponent(candidateMatch[1]),
          await parseBody(req),
          context
        );
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }

      send(res, 404, {
        error: "Stage 230 strategy API route not found",
        code: "STRATEGY_ROUTE_NOT_FOUND",
        metadata: service.metadata()
      });
      return true;
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      const internal = statusCode >= 500;
      send(res, statusCode, {
        error: internal ? "Stage 230 전략·실행 요청을 안전하게 처리하지 못했습니다." : (error.message || "요청을 처리하지 못했습니다."),
        code: internal ? "STRATEGY_INTERNAL_ERROR" : (error.code || "STRATEGY_REQUEST_FAILED"),
        metadata: service.metadata()
      });
      return true;
    }
  }

  return Object.freeze({ handle, isStrategyPath });
}

module.exports = {
  STRATEGY_API_BASE,
  createStrategyHttpHandler
};
