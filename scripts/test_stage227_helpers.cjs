"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { totp } = require("./integration/services/auth_crypto.cjs");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "scripts", "glamping_app_server.cjs");
const TEST_KEYS = Object.freeze({
  bootstrap: "stage227-bootstrap-secret-at-least-32-characters",
  session: "stage227-session-secret-at-least-32-characters",
  fingerprint: "stage227-fingerprint-secret-at-least-32-characters",
  mfa: "stage227-mfa-encryption-at-least-32-characters"
});

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
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(!["GET", "HEAD", "OPTIONS"].includes(method) && options.includeOrigin !== false
      ? { Origin: options.origin || instance.baseUrl }
      : {}),
    ...(Object.keys(options.jar || {}).length ? { Cookie: cookieHeader(options.jar) } : {}),
    ...(options.csrf !== false && (options.jar?.lodging_v2_csrf || options.jar?.lodging_v2_anon_csrf)
      ? { "X-CSRF-Token": options.jar.lodging_v2_csrf || options.jar.lodging_v2_anon_csrf }
      : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${instance.baseUrl}${pathname}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    redirect: "manual"
  });
  if (options.jar) processCookies(response, options.jar);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, status: response.status, body, text };
}

async function waitForServer(instance) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (instance.child.exitCode !== null) {
      throw new Error(`Stage 227 server exited early (${instance.child.exitCode})\n${instance.output()}`);
    }
    try {
      const response = await fetch(`${instance.baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Stage 227 server\n${instance.output()}`);
}

async function startServer(options = {}) {
  const port = options.port || await availablePort();
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "stage227-server-"));
  const freshFlagsEnabled = Boolean(options.freshCompanyFlag || options.freshObservationFlag);
  const integrationDataDir = Object.hasOwn(options, "integrationDataDir")
    ? String(options.integrationDataDir || "")
    : (freshFlagsEnabled ? fs.mkdtempSync(path.join(os.tmpdir(), "stage228-fresh-server-")) : "");
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    RENDER: "",
    RENDER_EXTERNAL_URL: "",
    HOST: options.host || "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    OUTPUTS_DIR: path.join(dataDir, "legacy-outputs-must-stay-unread"),
    CONFIG_DIR: path.join(dataDir, "legacy-config-must-stay-unread"),
    SEED_OUTPUTS_FROM_REPO: "0",
    V2_UI_V3_ENABLED: options.uiFlag ? "true" : "",
    V2_INTEGRATION_AUTH_ENABLED: options.authFlag === false ? "" : "true",
    V2_INTEGRATION_PLATFORM_CORE_ENABLED: options.coreFlag ? "true" : "",
    V2_INTEGRATION_FRESH_COMPANY_ENABLED: options.freshCompanyFlag ? "true" : "",
    V2_INTEGRATION_FRESH_OBSERVATION_ENABLED: options.freshObservationFlag ? "true" : "",
    V2_INTEGRATION_RELIABILITY_ENABLED: options.reliabilityFlag ? "true" : "",
    V2_INTEGRATION_LOCATION_CARD_ENABLED: options.locationCardFlag ? "true" : "",
    V2_INTEGRATION_DATA_DIR: integrationDataDir,
    V2_INTEGRATION_FRESH_PROVIDER: "synthetic",
    V2_STAGE227_FIXTURE_MODE: options.fixtureMode ? "true" : "",
    V2_STAGE227_FIXTURE_PATH: options.fixturePath || "",
    V2_INTEGRATION_COMPANY_ENABLED: "",
    V2_INTEGRATION_OBSERVATION_ENABLED: "",
    V2_INTEGRATION_BUSINESS_REPORT_ENABLED: options.businessReportFlag ? "true" : "",
    V2_INTEGRATION_AUTH_STORE_PATH: path.join(dataDir, "fresh-integration", "auth-store-v1.json"),
    V2_AUTH_BOOTSTRAP_SECRET: TEST_KEYS.bootstrap,
    V2_AUTH_SESSION_KEY_VERSION: "stage227-test-v1",
    V2_AUTH_SESSION_HASH_KEY_CURRENT: TEST_KEYS.session,
    V2_AUTH_SESSION_HASH_KEYS_PREVIOUS: "{}",
    V2_AUTH_FINGERPRINT_KEY: TEST_KEYS.fingerprint,
    V2_AUTH_MFA_ENCRYPTION_KEY: TEST_KEYS.mfa,
    V2_AUTH_ALLOWED_HOSTS: options.allowedHosts || `127.0.0.1:${port}`,
    V2_AUTH_ALLOWED_ORIGINS: options.allowedOrigins || baseUrl,
    V2_AUTH_EMAIL_PROVIDER: "mock",
    V2_AUTH_MOCK_PREVIEW_ENABLED: "true",
    GLAMPING_ADMIN_USER: options.legacyAdmin?.username || "stage227-legacy-admin",
    GLAMPING_ADMIN_PASSWORD: options.legacyAdmin?.password || "Stage227LegacyAdmin!",
    GLAMPING_B2B_USER: options.legacyBusiness?.username || "stage227-legacy-business",
    GLAMPING_B2B_PASSWORD: options.legacyBusiness?.password || "Stage227LegacyBusiness!",
    GLAMPING_B2B_ENABLED: options.authFlag === false ? "1" : "0",
    ...(options.extraEnv || {})
  };
  const child = childProcess.spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const instance = { child, dataDir, integrationDataDir, baseUrl, output: () => output, env };
  await waitForServer(instance);
  return instance;
}

async function stopServer(instance, removeData = true) {
  if (!instance) return;
  if (instance.child.exitCode === null) instance.child.kill();
  await new Promise((resolve) => {
    if (instance.child.exitCode !== null) return resolve();
    instance.child.once("exit", resolve);
    setTimeout(resolve, 2_000).unref();
  });
  if (removeData) fs.rmSync(instance.dataDir, { recursive: true, force: true });
  if (removeData && instance.integrationDataDir) {
    fs.rmSync(instance.integrationDataDir, { recursive: true, force: true });
  }
}

async function anonymousCsrfJar(instance) {
  const jar = {};
  const response = await requestJson(instance, "/api/auth/csrf", { jar });
  assert.equal(response.status, 200, "anonymous CSRF bootstrap status");
  assert.ok(jar.lodging_v2_anon_csrf, "anonymous CSRF cookie");
  return jar;
}

async function bootstrapAdmin(instance, overrides = {}) {
  const account = {
    username: overrides.username || "stage227-admin",
    email: overrides.email || "stage227-admin@example.test",
    password: overrides.password || "Stage227Admin!1"
  };
  const jar = await anonymousCsrfJar(instance);
  const bootstrap = await requestJson(instance, "/api/auth/bootstrap", {
    method: "POST",
    jar,
    headers: { "X-Bootstrap-Secret": TEST_KEYS.bootstrap },
    body: { ...account, displayName: "Stage 227 Admin" }
  });
  assert.equal(bootstrap.status, 201, `admin bootstrap: ${JSON.stringify(bootstrap.body)}`);
  const enrollment = await requestJson(instance, "/api/auth/mfa/enroll", {
    method: "POST",
    jar,
    body: { enrollmentToken: bootstrap.body.enrollmentToken }
  });
  assert.equal(enrollment.status, 200, "admin MFA enrollment start");
  const confirmation = await requestJson(instance, "/api/auth/mfa/confirm", {
    method: "POST",
    jar,
    body: { enrollmentToken: bootstrap.body.enrollmentToken, code: totp(enrollment.body.secret, Date.now() - 30_000) }
  });
  assert.equal(confirmation.status, 200, "admin MFA confirmation");
  const login = await requestJson(instance, "/api/login", {
    method: "POST",
    jar,
    body: { username: account.email, password: account.password }
  });
  assert.equal(login.status, 200, "admin login");
  const verification = await requestJson(instance, "/api/auth/mfa/verify", {
    method: "POST",
    jar,
    body: { challengeToken: login.body.challengeToken, recoveryCode: confirmation.body.recoveryCodes[0] }
  });
  assert.equal(verification.status, 200, "admin MFA login verification");
  return { account, jar, bootstrap, enrollment, confirmation, verification };
}

async function signupBusiness(instance, suffix = "one") {
  const jar = await anonymousCsrfJar(instance);
  const account = {
    username: `stage227-business-${suffix}`,
    email: `stage227-business-${suffix}@example.test`,
    password: "Stage227Business!1"
  };
  const signup = await requestJson(instance, "/api/signup", {
    method: "POST",
    jar,
    body: {
      ...account,
      phone: `010-2270-${suffix === "one" ? "0001" : "0002"}`,
      companyName: `Stage 227 Fresh Company ${suffix}`,
      ownershipStatus: "owned",
      passwordConfirm: account.password,
      agreeTerms: true,
      agreePrivacy: true,
      agreeMarketing: false,
      confirmAge: true
    }
  });
  assert.equal(signup.status, 200, `business signup: ${JSON.stringify(signup.body)}`);
  assert.equal(signup.body.role, "b2b");
  assert.ok(jar.glamping_datalab_session, "business signup must establish a session");
  return { account, jar, signup, companyId: signup.body.companyId };
}

module.exports = {
  ROOT,
  SERVER,
  TEST_KEYS,
  availablePort,
  processCookies,
  cookieHeader,
  requestJson,
  startServer,
  stopServer,
  anonymousCsrfJar,
  bootstrapAdmin,
  signupBusiness
};
