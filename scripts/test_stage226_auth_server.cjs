"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { totp } = require("./integration/services/auth_crypto.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const TEST_KEYS = Object.freeze({
  bootstrap: "stage226-bootstrap-secret-32-characters-minimum",
  session: "stage226-session-hmac-secret-32-characters-minimum",
  sessionV2: "stage226-session-hmac-secret-v2-32-characters-minimum",
  fingerprint: "stage226-stable-fingerprint-secret-32-characters-minimum",
  mfa: "stage226-mfa-encryption-secret-32-characters-minimum"
});
const PREVIOUS_KEY_USER_AGENT = "Stage226-Previous-Key-UA/1.0";

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function processCookies(response, jar) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  for (const value of values) {
    for (const match of value.matchAll(/(?:^|,\s*)(glamping_datalab_session|lodging_v2_csrf|lodging_v2_anon_csrf)=([^;,]*)/g)) {
      if (match[2]) jar[match[1]] = decodeURIComponent(match[2]);
      else delete jar[match[1]];
    }
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("; ");
}

async function requestJson(instance, pathname, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(!["GET", "HEAD"].includes(options.method || "GET") && options.includeOrigin !== false ? { Origin: options.origin || instance.baseUrl } : {}),
    ...(Object.keys(options.jar || {}).length ? { Cookie: cookieHeader(options.jar) } : {}),
    ...(options.csrf !== false && (options.jar?.lodging_v2_csrf || options.jar?.lodging_v2_anon_csrf)
      ? { "X-CSRF-Token": options.jar.lodging_v2_csrf || options.jar.lodging_v2_anon_csrf }
      : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${instance.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: "manual"
  });
  if (options.jar) processCookies(response, options.jar);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, status: response.status, body };
}

async function anonymousCsrfJar(instance) {
  const jar = {};
  const csrf = await requestJson(instance, "/api/auth/csrf", { jar });
  assert.equal(csrf.status, 200);
  assert.ok(jar.lodging_v2_anon_csrf);
  assert.equal(csrf.body.csrfToken, jar.lodging_v2_anon_csrf);
  return jar;
}

function assertBootstrapRequired(result, label) {
  assert.equal(result.status, 503, `${label}: status`);
  assert.equal(result.body.code, "AUTH_BOOTSTRAP_REQUIRED", `${label}: code`);
}

async function requestWithHost(instance, pathname, host) {
  const target = new URL(instance.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method: "GET",
      headers: { Host: host, Accept: "application/json" }
    }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
    req.end();
  });
}

async function waitForServer(instance) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) throw new Error(`server exited early (${instance.child.exitCode})\n${instance.output()}`);
    try {
      const response = await fetch(`${instance.baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for Stage 226 server\n${instance.output()}`);
}

async function startServer(options = {}) {
  const port = options.port || await availablePort();
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "stage226-server-"));
  const baseUrl = `http://127.0.0.1:${port}`;
  const authStorePath = path.join(dataDir, "fresh-integration", "auth-store-v1.json");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    RENDER: "",
    RENDER_EXTERNAL_URL: "",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    OUTPUTS_DIR: path.join(dataDir, "outputs"),
    CONFIG_DIR: path.join(dataDir, "config"),
    SEED_OUTPUTS_FROM_REPO: "0",
    V2_UI_V3_ENABLED: options.uiFlag ? "true" : "",
    V2_INTEGRATION_AUTH_ENABLED: options.authFlag === false ? "" : "true",
    V2_INTEGRATION_COMPANY_ENABLED: "",
    V2_INTEGRATION_OBSERVATION_ENABLED: "",
    V2_INTEGRATION_BUSINESS_REPORT_ENABLED: "",
    V2_INTEGRATION_AUTH_STORE_PATH: authStorePath,
    V2_AUTH_BOOTSTRAP_SECRET: TEST_KEYS.bootstrap,
    V2_AUTH_SESSION_KEY_VERSION: options.sessionKeyVersion || "test-v1",
    V2_AUTH_SESSION_HASH_KEY_CURRENT: options.sessionKey || TEST_KEYS.session,
    V2_AUTH_SESSION_HASH_KEYS_PREVIOUS: JSON.stringify(options.previousSessionKeys || {}),
    V2_AUTH_FINGERPRINT_KEY: TEST_KEYS.fingerprint,
    V2_AUTH_MFA_ENCRYPTION_KEY: TEST_KEYS.mfa,
    V2_AUTH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    V2_AUTH_ALLOWED_ORIGINS: baseUrl,
    V2_AUTH_EMAIL_PROVIDER: "mock",
    V2_AUTH_MOCK_PREVIEW_ENABLED: "true",
    V2_AUTH_LOGIN_LOCK_MS: "60000",
    GLAMPING_ADMIN_USER: options.legacyAdmin?.username || "stage226-legacy-admin",
    GLAMPING_ADMIN_PASSWORD: options.legacyAdmin?.password || "Stage226LegacyAdmin!",
    GLAMPING_B2B_ENABLED: "0"
  };
  const child = childProcess.spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const instance = { child, dataDir, baseUrl, authStorePath, output: () => output };
  await waitForServer(instance);
  return instance;
}

async function stopServer(instance, removeData = true) {
  if (!instance) return;
  if (instance.child.exitCode === null) instance.child.kill();
  await new Promise((resolve) => {
    if (instance.child.exitCode !== null) return resolve();
    instance.child.once("exit", resolve);
    setTimeout(resolve, 2000).unref();
  });
  if (removeData) fs.rmSync(instance.dataDir, { recursive: true, force: true });
}

async function assertProductionFailClosed() {
  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage226-fail-closed-"));
  const child = childProcess.spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      RENDER: "",
      RENDER_EXTERNAL_URL: "",
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      OUTPUTS_DIR: path.join(dataDir, "outputs"),
      CONFIG_DIR: path.join(dataDir, "config"),
      SEED_OUTPUTS_FROM_REPO: "0",
      V2_INTEGRATION_AUTH_ENABLED: "true",
      V2_INTEGRATION_AUTH_STORE_PATH: "",
      V2_AUTH_BOOTSTRAP_SECRET: TEST_KEYS.bootstrap,
      V2_AUTH_SESSION_KEY_VERSION: "test-v1",
      V2_AUTH_SESSION_HASH_KEY_CURRENT: TEST_KEYS.session,
      V2_AUTH_MFA_ENCRYPTION_KEY: TEST_KEYS.mfa,
      V2_AUTH_ALLOWED_HOSTS: `127.0.0.1:${port}`,
      V2_AUTH_ALLOWED_ORIGINS: `https://127.0.0.1:${port}`,
      V2_AUTH_EMAIL_PROVIDER: "mock"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(child.exitCode, 0, "production must not start without an explicit auth store");
  assert.match(output, /V2_INTEGRATION_AUTH_STORE_PATH is required/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function main() {
  await assertProductionFailClosed();
  let integration;
  let legacy;
  const admin = { username: "stage226-admin", email: "admin226@example.test", password: "Stage226Admin!" };
  try {
    integration = await startServer({ uiFlag: true });

    const wrongHostStatus = await requestWithHost(integration, "/api/auth/capabilities", "evil.invalid");
    assert.equal(wrongHostStatus, 403, "Host allowlist must fail closed before routing");
    const wrongOrigin = await requestJson(integration, "/api/login", {
      method: "POST", origin: "https://evil.invalid", body: { username: admin.username, password: admin.password }
    });
    assert.equal(wrongOrigin.status, 403, "Origin allowlist must reject cross-origin login");
    const preBootstrapJar = await anonymousCsrfJar(integration);
    assertBootstrapRequired(await requestJson(integration, "/api/signup/check-username?username=before-bootstrap", {
      jar: preBootstrapJar
    }), "username check before bootstrap");
    assertBootstrapRequired(await requestJson(integration, "/api/login", {
      method: "POST", jar: preBootstrapJar,
      body: { username: "before-bootstrap", password: "BeforeBootstrap!1" }
    }), "login before bootstrap");
    assertBootstrapRequired(await requestJson(integration, "/api/signup", {
      method: "POST", jar: preBootstrapJar,
      body: {
        username: "before-bootstrap", email: "before-bootstrap@example.test", phone: "010-0000-0099",
        companyName: "Before Bootstrap Company", ownershipStatus: "owned",
        password: "BeforeBootstrap!1", passwordConfirm: "BeforeBootstrap!1",
        agreeTerms: true, agreePrivacy: true, agreeMarketing: false, confirmAge: true
      }
    }), "signup before bootstrap");
    assertBootstrapRequired(await requestJson(integration, "/api/auth/password-reset/request", {
      method: "POST", jar: preBootstrapJar,
      body: { identity: "before-bootstrap@example.test" }
    }), "reset before bootstrap");
    assertBootstrapRequired(await requestJson(integration, "/api/auth/invitations/activate", {
      method: "POST", jar: preBootstrapJar,
      body: { token: "before-bootstrap-token", password: "BeforeBootstrap!1", passwordConfirm: "BeforeBootstrap!1" }
    }), "invite activation before bootstrap");

    const bootstrap = await requestJson(integration, "/api/auth/bootstrap", {
      method: "POST", jar: preBootstrapJar,
      headers: { "X-Bootstrap-Secret": TEST_KEYS.bootstrap },
      body: { username: admin.username, email: admin.email, displayName: "Stage 226 관리자", password: admin.password }
    });
    assert.equal(bootstrap.status, 201);
    assert.equal(bootstrap.body.mfaEnrollmentRequired, true);
    const repeated = await requestJson(integration, "/api/auth/bootstrap", {
      method: "POST", jar: preBootstrapJar,
      headers: { "X-Bootstrap-Secret": TEST_KEYS.bootstrap },
      body: { username: admin.username, email: admin.email, displayName: "Stage 226 관리자", password: admin.password }
    });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.account.accountId, bootstrap.body.account.accountId);

    const conflictingBootstrap = await requestJson(integration, "/api/auth/bootstrap", {
      method: "POST", jar: preBootstrapJar,
      headers: { "X-Bootstrap-Secret": TEST_KEYS.bootstrap },
      body: { username: "conflicting-admin", email: "conflicting-admin@example.test", displayName: "Conflict", password: admin.password }
    });
    assert.equal(conflictingBootstrap.status, 409, "bootstrap must reject a different identity");
    assertBootstrapRequired(await requestJson(integration, "/api/login", {
      method: "POST", jar: preBootstrapJar,
      body: { username: admin.username, password: admin.password }
    }), "login before bootstrap MFA completion");

    const enrollment = await requestJson(integration, "/api/auth/mfa/enroll", {
      method: "POST", jar: preBootstrapJar,
      body: { enrollmentToken: bootstrap.body.enrollmentToken }
    });
    assert.equal(enrollment.status, 200);
    assert.match(enrollment.body.otpauthUri, /^otpauth:\/\/totp\//);
    const confirmMfa = await requestJson(integration, "/api/auth/mfa/confirm", {
      method: "POST", jar: preBootstrapJar,
      body: { enrollmentToken: bootstrap.body.enrollmentToken, code: totp(enrollment.body.secret, Date.now() - 30_000) }
    });
    assert.equal(confirmMfa.status, 200);
    assert.equal(confirmMfa.body.recoveryCodes.length, 8);

    const adminLogin = await requestJson(integration, "/api/login", {
      method: "POST", jar: preBootstrapJar,
      body: { username: admin.email, password: admin.password }
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.body.mfaRequired, true);
    assert.equal(adminLogin.body.authenticated, false);
    const adminJar = preBootstrapJar;
    const adminMfa = await requestJson(integration, "/api/auth/mfa/verify", {
      method: "POST", jar: adminJar,
      body: { challengeToken: adminLogin.body.challengeToken, recoveryCode: confirmMfa.body.recoveryCodes[0] }
    });
    assert.equal(adminMfa.status, 200);
    assert.equal(adminMfa.body.role, "admin");
    assert.ok(adminJar.glamping_datalab_session);
    assert.ok(adminJar.lodging_v2_csrf);
    const adminSession = await requestJson(integration, "/api/session", { jar: adminJar });
    assert.equal(adminSession.status, 200);
    assert.equal(adminSession.body.authenticated, true);
    assert.equal(adminSession.body.mfaVerified, true);
    assert.equal(adminSession.body.entitlements.searchUnlimited, true);
    assert.equal(adminSession.body.entitlements.dailySearchLimit, 0);

    const sessionCsrfBeforeCapabilities = adminJar.lodging_v2_csrf;
    const authenticatedCapabilities = await requestJson(integration, "/api/auth/capabilities", { jar: adminJar });
    assert.equal(authenticatedCapabilities.status, 200);
    assert.equal(
      adminJar.lodging_v2_csrf,
      sessionCsrfBeforeCapabilities,
      "capabilities must not replace an authenticated session CSRF cookie"
    );
    const capabilitySetCookies = typeof authenticatedCapabilities.response.headers.getSetCookie === "function"
      ? authenticatedCapabilities.response.headers.getSetCookie()
      : [authenticatedCapabilities.response.headers.get("set-cookie") || ""];
    assert.equal(
      capabilitySetCookies.some((value) => value.includes("lodging_v2_csrf=")),
      false,
      "authenticated capabilities must not emit a CSRF Set-Cookie"
    );

    delete adminJar.lodging_v2_csrf;
    const recoveredCsrf = await requestJson(integration, "/api/auth/csrf", { jar: adminJar });
    assert.equal(recoveredCsrf.status, 200);
    assert.ok(adminJar.lodging_v2_csrf, "authenticated /api/auth/csrf must restore a lost CSRF cookie");
    assert.equal(recoveredCsrf.body.csrfToken, adminJar.lodging_v2_csrf);
    assert.notEqual(adminJar.lodging_v2_csrf, sessionCsrfBeforeCapabilities, "session CSRF recovery must rotate the token");
    const recoveredCsrfReauth = await requestJson(integration, "/api/auth/reauth", {
      method: "POST", jar: adminJar,
      body: { password: admin.password, code: totp(enrollment.body.secret) }
    });
    assert.equal(recoveredCsrfReauth.status, 200, "the rotated session CSRF token must authorize a mutation");

    for (const [label, pathname, body] of [
      ["login", "/api/login", { username: "admin", password: "0914" }],
      ["signup", "/api/signup", {
        username: "missing-csrf-signup", email: "missing-csrf-signup@example.test", phone: "010-0000-0088",
        companyName: "Missing CSRF", password: "MissingCsrf!1", passwordConfirm: "MissingCsrf!1",
        agreeTerms: true, agreePrivacy: true, confirmAge: true
      }],
      ["reset", "/api/auth/password-reset/request", { identity: "missing-csrf@example.test" }],
      ["activation", "/api/auth/invitations/activate", {
        token: "missing-csrf-token", password: "MissingCsrf!1", passwordConfirm: "MissingCsrf!1"
      }]
    ]) {
      const denied = await requestJson(integration, pathname, { method: "POST", body });
      assert.equal(denied.status, 403, `${label} must require an anonymous CSRF token`);
    }
    assert.equal((await requestJson(integration, "/api/b2b-members", { jar: adminJar })).status, 404, "integration auth must not read the legacy member store");
    assert.equal((await requestJson(integration, "/api/security-hardening", { jar: adminJar })).status, 404, "integration auth must not project legacy auth policy data");
    assert.equal((await requestJson(integration, "/api/b2b-search", { method: "POST", jar: adminJar, body: { keyword: "blocked" } })).status, 404, "legacy data mutations must stay disconnected while integration auth is enabled");

    const csrfDenied = await requestJson(integration, "/api/logout", { method: "POST", jar: { ...adminJar }, csrf: false, body: {} });
    assert.equal(csrfDenied.status, 403);
    assert.equal((await requestJson(integration, "/api/session", { jar: adminJar })).status, 200);

    const businessOneJar = await anonymousCsrfJar(integration);
    const signupOne = await requestJson(integration, "/api/signup", {
      method: "POST", jar: businessOneJar,
      body: {
        username: "business-one", email: "business-one@example.test", phone: "010-1111-2222",
        companyName: "신규 업체 하나", ownershipStatus: "owned",
        password: "BusinessOne!1", passwordConfirm: "BusinessOne!1",
        agreeTerms: true, agreePrivacy: true, agreeMarketing: false, confirmAge: true
      }
    });
    assert.equal(signupOne.status, 200);
    assert.equal(signupOne.body.role, "b2b");
    assert.equal(signupOne.body.plan, "free");
    assert.equal(signupOne.body.entitlements.dailySearchLimit, 2);
    assert.equal(signupOne.body.entitlements.searchUnlimited, false);
    const companyOne = signupOne.body.companyId;
    assert.equal((await requestJson(integration, `/api/auth/companies/${encodeURIComponent(companyOne)}/context`, { jar: businessOneJar })).status, 200);

    const businessTwoJar = await anonymousCsrfJar(integration);
    const signupTwo = await requestJson(integration, "/api/signup", {
      method: "POST", jar: businessTwoJar,
      headers: { "User-Agent": PREVIOUS_KEY_USER_AGENT },
      body: {
        username: "business-two", email: "business-two@example.test", phone: "010-3333-4444",
        companyName: "신규 업체 둘", ownershipStatus: "planning",
        password: "BusinessTwo!2", passwordConfirm: "BusinessTwo!2",
        agreeTerms: true, agreePrivacy: true, agreeMarketing: false, confirmAge: true
      }
    });
    assert.equal(signupTwo.status, 200);
    const adminCompanyContext = await requestJson(
      integration,
      `/api/auth/companies/${encodeURIComponent(signupTwo.body.companyId)}/context`,
      { jar: adminJar }
    );
    assert.equal(adminCompanyContext.status, 200);
    assert.equal(adminCompanyContext.body.entitlements.searchUnlimited, true);
    assert.equal(adminCompanyContext.body.entitlements.dailySearchLimit, 0);
    const tenantEscape = await requestJson(integration, `/api/auth/companies/${encodeURIComponent(signupTwo.body.companyId)}/context`, { jar: businessOneJar });
    assert.equal(tenantEscape.status, 403, "cross-company access must be a server-side 403");

    const accountLockJar = await anonymousCsrfJar(integration);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await requestJson(integration, "/api/login", {
        method: "POST", jar: accountLockJar,
        headers: { "X-Forwarded-For": "198.51.100.10" },
        body: { username: "business-two", password: "WrongBusinessTwo!9" }
      });
      assert.equal(failure.status, attempt === 4 ? 429 : 401, `account login failure ${attempt + 1}`);
    }
    const changedIpBypass = await requestJson(integration, "/api/login", {
      method: "POST", jar: accountLockJar,
      headers: { "X-Forwarded-For": "198.51.100.11" },
      body: { username: "business-two@example.test", password: "BusinessTwo!2" }
    });
    assert.equal(changedIpBypass.status, 429, "spoofed X-Forwarded-For and an identity alias must not bypass an account lock");
    const adminUnlock = await requestJson(
      integration,
      `/api/auth/accounts/${encodeURIComponent(signupTwo.body.accountId)}/unlock-login`,
      { method: "POST", jar: adminJar, body: {} }
    );
    assert.equal(adminUnlock.status, 200, "a recently reauthenticated administrator must be able to unlock login guards");
    assert.equal(adminUnlock.body.ok, true);
    assert.ok(adminUnlock.body.unlocked >= 1);
    const loginAfterAdminUnlock = await requestJson(integration, "/api/login", {
      method: "POST", jar: accountLockJar,
      headers: { "X-Forwarded-For": "198.51.100.11" },
      body: { username: "business-two@example.test", password: "BusinessTwo!2" }
    });
    assert.equal(loginAfterAdminUnlock.status, 200);
    assert.equal(loginAfterAdminUnlock.body.accountId, signupTwo.body.accountId);

    const ipOnlyLockJar = await anonymousCsrfJar(integration);
    const fallbackDenied = await requestJson(integration, "/api/login", {
      method: "POST", jar: ipOnlyLockJar,
      body: { username: "admin", password: "0914" }
    });
    assert.equal(fallbackDenied.status, 401, "legacy fallback credentials must be unreachable when integration auth is enabled");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failure = await requestJson(integration, "/api/login", {
        method: "POST", jar: ipOnlyLockJar,
        headers: { "X-Forwarded-For": "203.0.113.50" },
        body: { username: `unknown-ip-login-${attempt}`, password: "WrongUnknown!9" }
      });
      assert.equal(failure.status, attempt === 3 ? 429 : 401, `IP-only login failure ${attempt + 2}`);
    }
    const ipOnlyBypass = await requestJson(integration, "/api/login", {
      method: "POST", jar: ipOnlyLockJar,
      headers: { "X-Forwarded-For": "203.0.113.50" },
      body: { username: "business-one", password: "BusinessOne!1" }
    });
    assert.equal(ipOnlyBypass.status, 429, "an IP-only lock must aggregate attempts across identities");

    const keyRotationDataDir = integration.dataDir;
    const keyRotationPort = Number(new URL(integration.baseUrl).port);
    await stopServer(integration, false); integration = null;
    integration = await startServer({
      port: keyRotationPort,
      dataDir: keyRotationDataDir,
      uiFlag: true,
      sessionKeyVersion: "test-v2",
      sessionKey: TEST_KEYS.sessionV2,
      previousSessionKeys: { "test-v1": TEST_KEYS.session }
    });
    const previousKeySession = await requestJson(integration, "/api/session", {
      jar: businessTwoJar,
      headers: { "User-Agent": PREVIOUS_KEY_USER_AGENT }
    });
    assert.equal(previousKeySession.status, 200, "a previous-key session must survive an HTTP restart with the same raw User-Agent");
    assert.equal(previousKeySession.body.accountId, signupTwo.body.accountId);
    const wrongUaJar = { ...businessTwoJar };
    const wrongUaPreviousKeySession = await requestJson(integration, "/api/session", {
      jar: wrongUaJar,
      headers: { "User-Agent": "Stage226-Different-UA/1.0" }
    });
    assert.equal(wrongUaPreviousKeySession.status, 401, "a previous-key session must remain bound to its original User-Agent");

    const resetJar = await anonymousCsrfJar(integration);
    const resetRequest = await requestJson(integration, "/api/auth/password-reset/request", {
      method: "POST", jar: resetJar, body: { identity: "business-one@example.test" }
    });
    assert.equal(resetRequest.status, 200);
    assert.ok(resetRequest.body.previewToken);
    const missingReset = await requestJson(integration, "/api/auth/password-reset/request", {
      method: "POST", jar: resetJar, body: { identity: "missing@example.test" }
    });
    assert.equal(missingReset.status, 200);
    assert.equal(missingReset.body.message, resetRequest.body.message, "reset response must not enumerate accounts");
    const resetConfirm = await requestJson(integration, "/api/auth/password-reset/confirm", {
      method: "POST", jar: resetJar,
      body: { token: resetRequest.body.previewToken, password: "BusinessOne!9", passwordConfirm: "BusinessOne!9" }
    });
    assert.equal(resetConfirm.status, 200);
    assert.equal((await requestJson(integration, "/api/session", { jar: businessOneJar })).status, 401, "password reset must revoke existing sessions");

    const rollbackCookie = businessTwoJar.glamping_datalab_session;
    const sharedDataDir = integration.dataDir;
    const rollbackPort = Number(new URL(integration.baseUrl).port);
    await stopServer(integration, false); integration = null;
    legacy = await startServer({ port: rollbackPort, dataDir: sharedDataDir, authFlag: false, legacyAdmin: { username: "legacy-admin", password: "LegacyAdmin!226" } });
    const staleJar = { glamping_datalab_session: rollbackCookie };
    const staleSession = await requestJson(legacy, "/api/session", { jar: staleJar });
    assert.equal(staleSession.status, 401, "rollback must require a safe re-login instead of copying integration sessions");
    const legacyLogin = await requestJson(legacy, "/api/login", { method: "POST", jar: {}, includeOrigin: false, body: { username: "legacy-admin", password: "LegacyAdmin!226" } });
    assert.equal(legacyLogin.status, 200, "legacy credentials must work again only after auth flag rollback");

    const stored = fs.readFileSync(path.join(sharedDataDir, "fresh-integration", "auth-store-v1.json"), "utf8");
    assert.equal(stored.includes(admin.password), false);
    assert.equal(stored.includes("BusinessOne!1"), false);
    assert.equal(stored.includes(rollbackCookie), false, "raw session token must never be stored");
    assert.equal(stored.includes(resetRequest.body.previewToken), false, "raw reset token must never be stored");
    assert.equal(fs.existsSync(path.join(sharedDataDir, "customer_db", "b2b_members.json")), false, "legacy B2B member store must not be copied or created");

    console.log("Stage 226 auth HTTP, security, tenant and safe re-login rollback checks passed");
  } finally {
    if (integration) await stopServer(integration);
    if (legacy) await stopServer(legacy);
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
