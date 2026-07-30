"use strict";

const FRESH_API_BASE = "/api/integration/fresh";

function sessionRole(session = {}) {
  return String(session.account?.role || session.role || "").trim().toLowerCase();
}

function isAdminSession(session = {}) {
  return sessionRole(session) === "admin";
}

function omitBusinessCompanyIds(value) {
  if (Array.isArray(value)) return value.map(omitBusinessCompanyIds);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "companyId")
    .map(([key, child]) => [key, omitBusinessCompanyIds(child)]));
}

function createFreshDataHttpHandler(options = {}) {
  const service = options.service;
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  if (!service || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Fresh data HTTP handler dependencies are required");
  }

  function isFreshPath(pathname) {
    return pathname === FRESH_API_BASE || pathname.startsWith(`${FRESH_API_BASE}/`);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "FRESH_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, {
      mutation,
      requireCsrf: mutation,
      session
    });
    return { session, context };
  }

  function publicJobResult(result) {
    return {
      ok: true,
      idempotent: Boolean(result.idempotent),
      outcome: result.outcome || result.job?.status || "",
      job: result.job,
      metadata: service.metadata()
    };
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isFreshPath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session, context } = sessionAndContext(req, mutation);

      if (method === "GET" && pathname === `${FRESH_API_BASE}/metadata`) {
        send(res, 200, { ok: true, metadata: service.metadata() });
        return true;
      }
      if (method === "GET" && pathname === `${FRESH_API_BASE}/exploration`) {
        const requestedCompanyId = reqUrl.searchParams.get("companyId") || "";
        if (requestedCompanyId && !isAdminSession(session)) {
          const error = new Error("Business exploration selection requires an opaque companyRef");
          error.statusCode = 400;
          error.code = "FRESH_EXPLORATION_COMPANY_REF_REQUIRED";
          throw error;
        }
        const exploration = await service.getExploration(
          session,
          reqUrl.searchParams.get("tenantCompanyId") || "",
          isAdminSession(session) ? requestedCompanyId : "",
          context,
          reqUrl.searchParams.get("companyRef") || ""
        );
        send(res, 200, {
          ok: true,
          metadata: {
            ...service.metadata(),
            exploration: service.explorationMetadata()
          },
          exploration: isAdminSession(session) ? exploration : omitBusinessCompanyIds(exploration)
        });
        return true;
      }
      if (method === "GET" && pathname === `${FRESH_API_BASE}/companies`) {
        const companies = await service.listCompanies(
          session,
          reqUrl.searchParams.get("tenantCompanyId") || "",
          context
        );
        send(res, 200, { ok: true, metadata: service.metadata(), companies });
        return true;
      }
      const companyMatch = pathname.match(/^\/api\/integration\/fresh\/companies\/([^/]+)$/);
      if (method === "GET" && companyMatch) {
        const company = await service.getCompany(
          session,
          decodeURIComponent(companyMatch[1]),
          reqUrl.searchParams.get("tenantCompanyId") || "",
          context
        );
        send(res, 200, { ok: true, metadata: service.metadata(), company });
        return true;
      }
      const reviewMatch = pathname.match(/^\/api\/integration\/fresh\/companies\/([^/]+)\/review$/);
      if (method === "POST" && reviewMatch) {
        const result = await service.reviewCompany(
          session,
          decodeURIComponent(reviewMatch[1]),
          await parseBody(req)
        );
        send(res, result.idempotent ? 200 : 201, { ...result, metadata: service.metadata() });
        return true;
      }
      if (method === "POST" && pathname === `${FRESH_API_BASE}/runs`) {
        const result = await service.submitCollection(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 202, publicJobResult(result));
        return true;
      }
      const runMatch = pathname.match(/^\/api\/integration\/fresh\/runs\/([^/]+)$/);
      if (method === "GET" && runMatch) {
        const result = await service.getJob(session, decodeURIComponent(runMatch[1]));
        send(res, 200, publicJobResult(result));
        return true;
      }
      const runMutationMatch = pathname.match(/^\/api\/integration\/fresh\/runs\/([^/]+)\/(cancel|resume)$/);
      if (method === "POST" && runMutationMatch) {
        const clientRequestId = decodeURIComponent(runMutationMatch[1]);
        const payload = await parseBody(req);
        const result = runMutationMatch[2] === "cancel"
          ? await service.cancelJob(session, clientRequestId, payload)
          : await service.resumeJob(session, clientRequestId, payload);
        send(res, 200, publicJobResult(result));
        return true;
      }
      if (method === "GET" && pathname === `${FRESH_API_BASE}/snapshots`) {
        send(res, 200, { ...(await service.listSnapshots(session)), metadata: service.metadata() });
        return true;
      }
      if (method === "POST" && pathname === `${FRESH_API_BASE}/snapshots`) {
        const payload = await parseBody(req);
        send(res, 201, {
          ...(await service.createSnapshot(session, payload.label || "manual")),
          metadata: service.metadata()
        });
        return true;
      }
      const rollbackMatch = pathname.match(/^\/api\/integration\/fresh\/snapshots\/([^/]+)\/rollback$/);
      if (method === "POST" && rollbackMatch) {
        send(res, 200, {
          ...(await service.rollbackSnapshot(session, decodeURIComponent(rollbackMatch[1]))),
          metadata: service.metadata()
        });
        return true;
      }
      send(res, 404, {
        error: "Stage 228 fresh data API route not found",
        code: "FRESH_ROUTE_NOT_FOUND",
        metadata: service.metadata()
      });
      return true;
    } catch (error) {
      const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {};
      const statusCode = Number(error.statusCode || 500);
      const internalFailure = statusCode >= 500;
      send(res, statusCode, {
        error: internalFailure ? "통합 데이터를 처리하지 못했습니다." : (error.message || String(error)),
        code: internalFailure ? "FRESH_INTERNAL_ERROR" : (error.code || undefined),
        reauthenticationRequired: error.reauthenticationRequired || undefined,
        metadata: service.metadata()
      }, "application/json; charset=utf-8", headers);
      return true;
    }
  }

  return Object.freeze({ handle, isFreshPath });
}

module.exports = {
  FRESH_API_BASE,
  createFreshDataHttpHandler,
  omitBusinessCompanyIds
};
