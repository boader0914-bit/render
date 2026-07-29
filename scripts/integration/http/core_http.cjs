"use strict";

const { CORE_API_BASE } = require("../contracts/core_ui.cjs");

function createCoreHttpHandler(options = {}) {
  const service = options.service;
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  if (!service || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Core HTTP handler dependencies are required");
  }

  function isCorePath(pathname) {
    return pathname === CORE_API_BASE || pathname.startsWith(`${CORE_API_BASE}/`);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "CORE_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, {
      mutation,
      requireCsrf: mutation,
      session
    });
    return { session, context };
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isCorePath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session, context } = sessionAndContext(req, mutation);

      if (method === "GET" && pathname === `${CORE_API_BASE}/workspace`) {
        send(res, 200, await service.workspace(session, {
          view: reqUrl.searchParams.get("view") || "",
          companyId: reqUrl.searchParams.get("companyId") || "",
          tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || ""
        }, context));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/jobs`) {
        const result = await service.createJob(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      const jobStatusMatch = pathname.match(/^\/api\/integration\/core\/jobs\/([^/]+)$/);
      if (method === "GET" && jobStatusMatch) {
        send(res, 200, await service.jobFor(session, decodeURIComponent(jobStatusMatch[1])));
        return true;
      }
      const jobCancelMatch = pathname.match(/^\/api\/integration\/core\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && jobCancelMatch) {
        send(res, 200, await service.cancelJob(
          session,
          decodeURIComponent(jobCancelMatch[1]),
          await parseBody(req)
        ));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/interests`) {
        const result = await service.addInterest(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 201, result);
        return true;
      }
      const interestMatch = pathname.match(/^\/api\/integration\/core\/interests\/([^/]+)$/);
      if (method === "DELETE" && interestMatch) {
        send(res, 200, await service.removeInterest(
          session,
          decodeURIComponent(interestMatch[1]),
          { tenantCompanyId: reqUrl.searchParams.get("tenantCompanyId") || "" },
          context
        ));
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/location-card-requests`) {
        const result = await service.createLocationCardRequest(session, await parseBody(req), context);
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      if (method === "POST" && pathname === `${CORE_API_BASE}/admin/tourism-requests`) {
        const result = service.createTourismRequest(session, await parseBody(req));
        send(res, result.idempotent ? 200 : 202, result);
        return true;
      }
      send(res, 404, {
        error: "Stage 227 core API route not found",
        code: "CORE_ROUTE_NOT_FOUND",
        metadata: service.metadata()
      });
      return true;
    } catch (error) {
      const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {};
      send(res, error.statusCode || 500, {
        error: error.message || String(error),
        code: error.code || undefined,
        retryAfterSeconds: error.retryAfterSeconds || undefined,
        metadata: service.metadata()
      }, "application/json; charset=utf-8", headers);
      return true;
    }
  }

  return Object.freeze({ handle, isCorePath });
}

module.exports = { createCoreHttpHandler };
