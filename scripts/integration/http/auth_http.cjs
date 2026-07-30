"use strict";

const SESSION_COOKIE_NAME = "glamping_datalab_session";
const CSRF_COOKIE_NAME = "lodging_v2_csrf";
const ANONYMOUS_CSRF_COOKIE_NAME = "lodging_v2_anon_csrf";
const PUBLIC_AUTH_MUTATION_PATHS = Object.freeze(new Set([
  "/api/login",
  "/login",
  "/api/signup",
  "/signup",
  "/api/auth/bootstrap",
  "/api/auth/mfa/enroll",
  "/api/auth/mfa/confirm",
  "/api/auth/mfa/verify",
  "/api/auth/invitations/activate",
  "/api/auth/password-reset/request",
  "/api/auth/password-reset/confirm"
]));
const AUTH_MUTATION_PATHS = Object.freeze(new Set([
  "/api/login",
  "/login",
  "/api/signup",
  "/signup",
  "/api/auth/bootstrap",
  "/api/auth/mfa/enroll",
  "/api/auth/mfa/confirm",
  "/api/auth/mfa/verify",
  "/api/auth/invitations/activate",
  "/api/auth/password-reset/request",
  "/api/auth/password-reset/confirm",
  "/api/auth/mfa/reset",
  "/api/auth/reauth",
  "/api/auth/invitations",
  "/api/auth/session-keys/retire",
  "/api/logout"
]));

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return [part, ""];
      return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
    })
  );
}

function cookie(name, value, options = {}) {
  return [
    `${name}=${encodeURIComponent(value || "")}`,
    "Path=/",
    options.httpOnly ? "HttpOnly" : "",
    `SameSite=${options.sameSite || "Lax"}`,
    options.secure ? "Secure" : "",
    options.priority ? `Priority=${options.priority}` : "",
    `Max-Age=${Math.max(0, Math.floor(Number(options.maxAgeSeconds || 0)))}`
  ].filter(Boolean).join("; ");
}

function createAuthHttpHandler(options = {}) {
  const service = options.service;
  const send = options.send;
  const parseBody = options.parseBody;
  const redirectPathForRole = options.redirectPathForRole;
  const isProduction = Boolean(options.isProduction);
  if (!service || !send || !parseBody) throw new Error("Auth HTTP handler dependencies are required");

  function requestContext(req) {
    const ip = req.socket?.remoteAddress || "unknown";
    const userAgent = String(req.headers["user-agent"] || "");
    return {
      host: String(req.headers.host || ""),
      origin: String(req.headers.origin || ""),
      csrfToken: String(req.headers["x-csrf-token"] || ""),
      ipHash: service.hashRequestFingerprint("ip", ip),
      userAgentHash: service.hashRequestFingerprint("ua", userAgent)
    };
  }

  function sessionForRequest(req) {
    const rawToken = parseCookies(req)[SESSION_COOKIE_NAME] || "";
    return service.getSession(rawToken, requestContext(req));
  }

  function sessionCookies(result) {
    const maxAgeSeconds = Math.max(1, Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000));
    return [
      cookie(SESSION_COOKIE_NAME, result.token, { httpOnly: true, sameSite: "Lax", secure: isProduction, priority: "High", maxAgeSeconds }),
      cookie(CSRF_COOKIE_NAME, result.csrfToken, { httpOnly: false, sameSite: "Strict", secure: isProduction, priority: "High", maxAgeSeconds }),
      cookie(ANONYMOUS_CSRF_COOKIE_NAME, "", { httpOnly: false, sameSite: "Strict", secure: isProduction, priority: "High", maxAgeSeconds: 0 })
    ];
  }

  function clearCookies() {
    return [
      cookie(SESSION_COOKIE_NAME, "", { httpOnly: true, sameSite: "Lax", secure: isProduction, priority: "High", maxAgeSeconds: 0 }),
      cookie(CSRF_COOKIE_NAME, "", { httpOnly: false, sameSite: "Strict", secure: isProduction, priority: "High", maxAgeSeconds: 0 }),
      cookie(ANONYMOUS_CSRF_COOKIE_NAME, "", { httpOnly: false, sameSite: "Strict", secure: isProduction, priority: "High", maxAgeSeconds: 0 })
    ];
  }

  function csrfBootstrapCookie(token) {
    return cookie(ANONYMOUS_CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      sameSite: "Strict",
      secure: isProduction,
      priority: "High",
      maxAgeSeconds: 15 * 60
    });
  }

  function sessionCsrfCookie(token, expiresAt) {
    return cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      sameSite: "Strict",
      secure: isProduction,
      priority: "High",
      maxAgeSeconds: Math.max(1, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
    });
  }

  function assertHost(req) {
    return service.assertRequestBoundary(requestContext(req), { mutation: false });
  }

  async function createAuthenticatedSession(account, req, optionsForSession = {}) {
    const context = requestContext(req);
    return service.createSession(account, context, optionsForSession);
  }

  async function handle(req, res, reqUrl) {
    const pathname = reqUrl.pathname;
    const method = req.method || "GET";
    const known = pathname === "/api/auth/capabilities"
      || pathname === "/api/auth/csrf"
      || pathname === "/api/signup/check-username"
      || pathname === "/api/session"
      || (method === "POST" && AUTH_MUTATION_PATHS.has(pathname))
      || pathname.startsWith("/api/auth/invitations/")
      || pathname.startsWith("/api/auth/accounts/")
      || pathname.startsWith("/api/auth/companies/");
    if (!known) return false;

    const context = requestContext(req);
    try {
      service.assertRequestBoundary(context, { mutation: !["GET", "HEAD", "OPTIONS"].includes(method) });
      if (method === "POST" && PUBLIC_AUTH_MUTATION_PATHS.has(pathname)) {
        service.assertRequestBoundary(context, { mutation: true, requireAnonymousCsrf: true });
      }

      if (method === "GET" && pathname === "/api/auth/capabilities") {
        const session = sessionForRequest(req);
        if (session) {
          send(res, 200, { ...service.capabilities(), csrfToken: "" });
        } else {
          const csrfToken = service.createAnonymousCsrfToken();
          send(res, 200, { ...service.capabilities(), csrfToken }, "application/json; charset=utf-8", { "Set-Cookie": csrfBootstrapCookie(csrfToken), "X-CSRF-Token": csrfToken });
        }
        return true;
      }
      if (method === "GET" && pathname === "/api/auth/csrf") {
        const session = sessionForRequest(req);
        if (session) {
          const rotated = await service.rotateSessionCsrf(session, context);
          send(res, 200, { ok: true, csrfToken: rotated.csrfToken }, "application/json; charset=utf-8", {
            "Set-Cookie": sessionCsrfCookie(rotated.csrfToken, rotated.expiresAt),
            "X-CSRF-Token": rotated.csrfToken
          });
        } else {
          const csrfToken = service.createAnonymousCsrfToken();
          send(res, 200, { ok: true, csrfToken }, "application/json; charset=utf-8", {
            "Set-Cookie": csrfBootstrapCookie(csrfToken),
            "X-CSRF-Token": csrfToken
          });
        }
        return true;
      }
      if (method === "GET" && pathname === "/api/signup/check-username") {
        send(res, 200, await service.checkUsernameAvailability(reqUrl.searchParams.get("username") || "", context));
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/bootstrap") {
        const payload = await parseBody(req);
        const result = await service.bootstrapAdmin({
          ...payload,
          bootstrapSecret: String(req.headers["x-bootstrap-secret"] || payload.bootstrapSecret || "")
        }, context);
        send(res, result.created ? 201 : 200, { ok: true, ...result });
        return true;
      }
      if (method === "POST" && (pathname === "/api/signup" || pathname === "/signup")) {
        const result = await service.signup(await parseBody(req), context);
        const sessionResult = await createAuthenticatedSession(result.account, req);
        if (pathname === "/signup") {
          send(res, 302, "", "text/plain; charset=utf-8", { "Set-Cookie": sessionCookies(sessionResult), "X-CSRF-Token": sessionResult.csrfToken, Location: "/b2b" });
        } else {
          send(res, 200, { ok: true, ...sessionResult.public }, "application/json; charset=utf-8", { "Set-Cookie": sessionCookies(sessionResult), "X-CSRF-Token": sessionResult.csrfToken });
        }
        return true;
      }
      if (method === "POST" && (pathname === "/api/login" || pathname === "/login")) {
        const payload = await parseBody(req);
        const result = await service.authenticate(payload.username || payload.email || "", payload.password || "", context);
        if (result.mfaRequired || result.mfaEnrollmentRequired) {
          if (pathname === "/login") {
            send(res, 403, "추가 인증은 새 로그인 화면에서 완료하세요.", "text/plain; charset=utf-8");
          } else {
            send(res, 200, { ok: true, authenticated: false, ...result });
          }
          return true;
        }
        const sessionResult = await createAuthenticatedSession(result.account, req);
        if (pathname === "/login") {
          send(res, 302, "", "text/plain; charset=utf-8", {
            "Set-Cookie": sessionCookies(sessionResult),
            "X-CSRF-Token": sessionResult.csrfToken,
            Location: redirectPathForRole(result.account.role)
          });
        } else {
          send(res, 200, { ok: true, ...sessionResult.public }, "application/json; charset=utf-8", { "Set-Cookie": sessionCookies(sessionResult), "X-CSRF-Token": sessionResult.csrfToken });
        }
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/mfa/enroll") {
        const payload = await parseBody(req);
        send(res, 200, { ok: true, ...(await service.beginMfaEnrollment(payload.enrollmentToken || payload.challengeToken, context)) });
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/mfa/confirm") {
        const payload = await parseBody(req);
        send(res, 200, { ok: true, loginRequired: true, ...(await service.confirmMfaEnrollment(payload.enrollmentToken || payload.challengeToken, payload.code, context)) });
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/mfa/verify") {
        const payload = await parseBody(req);
        const result = await service.verifyMfaLogin(payload.challengeToken, payload.code || payload.recoveryCode, context);
        const sessionResult = await createAuthenticatedSession(result.account, req, { mfaVerified: true });
        send(res, 200, { ok: true, ...sessionResult.public }, "application/json; charset=utf-8", { "Set-Cookie": sessionCookies(sessionResult), "X-CSRF-Token": sessionResult.csrfToken });
        return true;
      }
      if (method === "GET" && pathname === "/api/session") {
        const session = sessionForRequest(req);
        if (!session) {
          send(res, 401, { error: "로그인이 필요합니다." }, "application/json; charset=utf-8", { "Set-Cookie": clearCookies() });
        } else {
          send(res, 200, service.projectSession(session));
        }
        return true;
      }
      if (method === "POST" && pathname === "/api/logout") {
        const session = sessionForRequest(req);
        if (session) service.assertRequestBoundary(context, { mutation: true, requireCsrf: true, session });
        await service.logout(session, context);
        send(res, 200, { ok: true }, "application/json; charset=utf-8", { "Set-Cookie": clearCookies() });
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/invitations/activate") {
        send(res, 200, await service.activateInvite(await parseBody(req), context));
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/password-reset/request") {
        const payload = await parseBody(req);
        send(res, 200, await service.requestPasswordReset(payload.identity || payload.username || payload.email, context));
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/password-reset/confirm") {
        send(res, 200, await service.confirmPasswordReset(await parseBody(req), context));
        return true;
      }

      const session = sessionForRequest(req);
      if (!session) {
        send(res, 401, { error: "로그인이 필요합니다." }, "application/json; charset=utf-8", { "Set-Cookie": clearCookies() });
        return true;
      }
      if (!["GET", "HEAD"].includes(method)) {
        service.assertRequestBoundary(context, { mutation: true, requireCsrf: true, session });
      }
      if (method === "POST" && pathname === "/api/auth/reauth") {
        send(res, 200, await service.reauthenticate(session, await parseBody(req), context));
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/mfa/reset") {
        const result = await service.resetMfa(session, await parseBody(req), context);
        send(res, 200, {
          ok: true,
          authenticated: false,
          mfaEnrollmentRequired: true,
          enrollmentToken: result.enrollmentToken,
          expiresAt: result.expiresAt
        }, "application/json; charset=utf-8", { "Set-Cookie": clearCookies() });
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/invitations") {
        send(res, 201, await service.createInvite(session, await parseBody(req), context));
        return true;
      }
      if (method === "POST" && pathname.startsWith("/api/auth/invitations/") && pathname.endsWith("/cancel")) {
        const inviteId = decodeURIComponent(pathname.slice("/api/auth/invitations/".length, -"/cancel".length));
        send(res, 200, await service.cancelInvite(session, inviteId, context));
        return true;
      }
      if (method === "POST" && pathname.startsWith("/api/auth/invitations/") && pathname.endsWith("/reissue")) {
        const inviteId = decodeURIComponent(pathname.slice("/api/auth/invitations/".length, -"/reissue".length));
        send(res, 201, await service.reissueInvite(session, inviteId, context));
        return true;
      }
      if (method === "POST" && pathname.startsWith("/api/auth/accounts/") && pathname.endsWith("/force-logout")) {
        const accountId = decodeURIComponent(pathname.slice("/api/auth/accounts/".length, -"/force-logout".length));
        send(res, 200, await service.forceLogout(session, accountId, context));
        return true;
      }
      if (method === "POST" && pathname.startsWith("/api/auth/accounts/") && pathname.endsWith("/unlock-login")) {
        const accountId = decodeURIComponent(pathname.slice("/api/auth/accounts/".length, -"/unlock-login".length));
        send(res, 200, await service.unlockLoginGuards(session, accountId, context));
        return true;
      }
      if (method === "POST" && pathname === "/api/auth/session-keys/retire") {
        const payload = await parseBody(req);
        send(res, 200, await service.retireSessionKeyVersion(session, payload.keyVersion, context));
        return true;
      }
      if (method === "GET" && pathname.startsWith("/api/auth/companies/") && pathname.endsWith("/context")) {
        const companyId = decodeURIComponent(pathname.slice("/api/auth/companies/".length, -"/context".length));
        send(res, 200, await service.assertCompanyAccess(session, companyId, context));
        return true;
      }
      send(res, 405, { error: "Method not allowed" });
      return true;
    } catch (error) {
      const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {};
      send(res, error.statusCode || 500, {
        error: error.message || String(error),
        code: error.code || undefined,
        retryAfterSeconds: error.retryAfterSeconds || undefined,
        reauthenticationRequired: error.reauthenticationRequired || undefined
      }, "application/json; charset=utf-8", headers);
      return true;
    }
  }

  return Object.freeze({
    assertHost,
    clearCookies,
    handle,
    parseCookies,
    requestContext,
    sessionForRequest
  });
}

module.exports = {
  ANONYMOUS_CSRF_COOKIE_NAME,
  AUTH_MUTATION_PATHS,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  PUBLIC_AUTH_MUTATION_PATHS,
  cookie,
  createAuthHttpHandler,
  parseCookies
};
