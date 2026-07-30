"use strict";

const SIGNAL_CONNECTOR_API_BASE = "/api/integration/connectors";

function createSignalConnectorHttpHandler(options = {}) {
  const service = options.service;
  const repository = options.repository;
  const runtime = options.runtime;
  const status = options.status;
  const projectJob = options.projectJob;
  const providerPolicies = options.providerPolicies || [];
  const schedulerConfigured = Boolean(options.schedulerConfigured);
  const authService = options.authService;
  const authHttp = options.authHttp;
  const send = options.send;
  const parseBody = options.parseBody;
  if (!service || !repository || !runtime?.submit || !runtime?.resume || !status || !projectJob || !authService || !authHttp || !send || !parseBody) {
    throw new Error("Stage 231 signal connector HTTP dependencies are required");
  }
  const providerIds = new Set(providerPolicies.map((row) => row.id));
  const providerById = new Map(providerPolicies.map((row) => [row.id, row]));

  function isConnectorPath(pathname) {
    return pathname === SIGNAL_CONNECTOR_API_BASE || pathname.startsWith(`${SIGNAL_CONNECTOR_API_BASE}/`);
  }

  function sessionAndContext(req, mutation) {
    const context = authHttp.requestContext(req);
    const session = authHttp.sessionForRequest(req);
    if (!session) {
      const error = new Error("로그인이 필요합니다.");
      error.statusCode = 401;
      error.code = "SIGNAL_CONNECTOR_AUTH_REQUIRED";
      throw error;
    }
    authService.assertRequestBoundary(context, { mutation, requireCsrf: mutation, session });
    if ((session.account?.role || session.role) !== "admin") {
      const error = new Error("관리자 권한이 필요합니다.");
      error.statusCode = 403;
      error.code = "SIGNAL_CONNECTOR_ROLE_FORBIDDEN";
      throw error;
    }
    return { session, context };
  }

  function actor(session) {
    return {
      type: "account",
      accountId: session.account?.accountId || session.accountId || "admin",
      role: "admin"
    };
  }

  function knownProvider(raw) {
    const providerId = decodeURIComponent(String(raw || ""));
    if (!providerIds.has(providerId)) {
      const error = new Error("지원하는 signal provider가 아닙니다.");
      error.statusCode = 404;
      error.code = "SIGNAL_CONNECTOR_PROVIDER_NOT_FOUND";
      throw error;
    }
    return providerId;
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    if (!isConnectorPath(pathname)) return false;
    const method = String(req.method || "GET").toUpperCase();
    try {
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
      const { session } = sessionAndContext(req, mutation);
      const requestActor = actor(session);

      if (method === "GET" && (pathname === SIGNAL_CONNECTOR_API_BASE || pathname === `${SIGNAL_CONNECTOR_API_BASE}/status`)) {
        send(res, 200, await status());
        return true;
      }
      if (method === "GET" && pathname === `${SIGNAL_CONNECTOR_API_BASE}/jobs`) {
        const providerId = reqUrl.searchParams.get("providerId") || "";
        if (providerId) knownProvider(providerId);
        const requestedStatus = reqUrl.searchParams.get("status") || "";
        const rows = await repository.listJobs({
          ...(providerId ? { providerId } : {}),
          ...(requestedStatus ? { statuses: [requestedStatus] } : {})
        });
        send(res, 200, {
          ok: true,
          jobs: rows.slice().sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 100).map(projectJob)
        });
        return true;
      }
      if (method === "POST" && pathname === `${SIGNAL_CONNECTOR_API_BASE}/jobs`) {
        const payload = await parseBody(req);
        knownProvider(payload.providerId);
        const result = await runtime.submit(payload, { actor: requestActor });
        send(res, result.idempotent ? 200 : 202, { ok: true, idempotent: Boolean(result.idempotent), job: projectJob(result.job) });
        return true;
      }
      const jobReadMatch = pathname.match(/^\/api\/integration\/connectors\/jobs\/([^/]+)$/);
      if (method === "GET" && jobReadMatch) {
        const reference = decodeURIComponent(jobReadMatch[1]);
        const row = await repository.getJob(reference);
        if (!row || row.clientRequestId !== reference) {
          const error = new Error("signal connector job을 찾을 수 없습니다.");
          error.statusCode = 404;
          error.code = "SIGNAL_CONNECTOR_JOB_NOT_FOUND";
          throw error;
        }
        send(res, 200, { ok: true, job: projectJob(row) });
        return true;
      }
      const jobActionMatch = pathname.match(/^\/api\/integration\/connectors\/jobs\/([^/]+)\/(cancel|resume)$/);
      if (method === "POST" && jobActionMatch) {
        const reference = decodeURIComponent(jobActionMatch[1]);
        const existing = await repository.getJob(reference);
        if (!existing || existing.clientRequestId !== reference) {
          const error = new Error("signal connector job을 찾을 수 없습니다.");
          error.statusCode = 404;
          error.code = "SIGNAL_CONNECTOR_JOB_NOT_FOUND";
          throw error;
        }
        const body = await parseBody(req);
        const context = { actor: requestActor, reason: String(body.reason || "manual-admin-control") };
        const row = jobActionMatch[2] === "cancel"
          ? await service.cancel(reference, context)
          : await runtime.resume(reference, context);
        send(res, 200, { ok: true, job: projectJob(row) });
        return true;
      }
      const providerActionMatch = pathname.match(/^\/api\/integration\/connectors\/providers\/([^/]+)\/(stop|resume)$/);
      if (method === "POST" && providerActionMatch) {
        const providerId = knownProvider(providerActionMatch[1]);
        const body = await parseBody(req);
        const context = { actor: requestActor, reason: String(body.reason || "manual-admin-control") };
        const result = providerActionMatch[2] === "stop"
          ? await service.stopProvider(providerId, context)
          : await service.resumeProvider(providerId, context);
        send(res, 200, {
          ok: true,
          provider: {
            id: providerId,
            state: result.open ? "stopped" : (providerById.get(providerId)?.operational ? "operational" : "approval-required"),
            cancelledJobs: Number(result.cancelledJobs || 0),
            updatedAt: result.updatedAt || ""
          }
        });
        return true;
      }
      if (method === "POST" && pathname === `${SIGNAL_CONNECTOR_API_BASE}/scheduler/stop`) {
        const body = await parseBody(req);
        const result = await service.stopScheduler({ actor: requestActor, reason: String(body.reason || "manual-admin-stop") });
        send(res, 200, { ok: true, scheduler: { stopped: true, updatedAt: result.updatedAt || "" } });
        return true;
      }
      if (method === "POST" && pathname === `${SIGNAL_CONNECTOR_API_BASE}/scheduler/enable`) {
        if (!schedulerConfigured) {
          const error = new Error("scheduler feature flag가 꺼져 있습니다.");
          error.statusCode = 409;
          error.code = "SIGNAL_CONNECTOR_SCHEDULER_DISABLED";
          throw error;
        }
        const error = new Error("승인된 scheduler 대상 manifest와 주기 실행기가 아직 구성되지 않았습니다.");
        error.statusCode = 503;
        error.code = "SIGNAL_CONNECTOR_SCHEDULER_TARGETS_REQUIRED";
        throw error;
      }

      send(res, 404, {
        error: "Stage 231 signal connector API route not found",
        code: "SIGNAL_CONNECTOR_ROUTE_NOT_FOUND"
      });
      return true;
    } catch (error) {
      const statusCode = Number(error.statusCode || 500);
      const publicServerCodes = new Set([
        "SIGNAL_CONNECTOR_ADAPTER_REQUIRED",
        "SIGNAL_CONNECTOR_SCHEDULER_TARGETS_REQUIRED"
      ]);
      send(res, statusCode, {
        error: statusCode >= 500 ? "Signal connector 요청을 안전하게 처리하지 못했습니다." : (error.message || "요청을 처리하지 못했습니다."),
        code: statusCode >= 500 && !publicServerCodes.has(error.code)
          ? "SIGNAL_CONNECTOR_INTERNAL_ERROR"
          : (error.code || "SIGNAL_CONNECTOR_REQUEST_FAILED")
      });
      return true;
    }
  }

  return Object.freeze({ handle, isConnectorPath });
}

module.exports = {
  SIGNAL_CONNECTOR_API_BASE,
  createSignalConnectorHttpHandler
};
