"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ROOT,
  SERVER,
  availablePort,
  bootstrapAdmin,
  requestJson,
  signupBusiness,
  startServer,
  stopServer
} = require("./test_stage227_helpers.cjs");

async function assertCoreDependencyFailsClosed() {
  const port = await availablePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage227-core-dependency-"));
  const child = childProcess.spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
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
      V2_INTEGRATION_AUTH_ENABLED: "",
      V2_INTEGRATION_PLATFORM_CORE_ENABLED: "true"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  let timeout;
  try {
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("core dependency process did not fail closed")), 10_000); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.notEqual(child.exitCode, 0);
  assert.match(output, /V2_INTEGRATION_PLATFORM_CORE_ENABLED requires V2_INTEGRATION_AUTH_ENABLED/);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function assertLegacyFlagOff() {
  let instance;
  try {
    instance = await startServer({ authFlag: false, coreFlag: false, uiFlag: false });
    const health = await requestJson(instance, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(Object.hasOwn(health.body, "platformCore"), false, "flag-off health shape must not gain a core field");

    for (const pathname of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/favicon.svg"]) {
      const response = await fetch(`${instance.baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        fs.readFileSync(path.join(ROOT, "web", pathname.slice(1))),
        `${pathname} must stay byte-identical while the core flag is off`
      );
    }

    const login = await requestJson(instance, "/api/login", {
      method: "POST",
      includeOrigin: false,
      jar: {},
      body: { username: "stage227-legacy-admin", password: "Stage227LegacyAdmin!" }
    });
    assert.equal(login.status, 200);
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0] || "";
    assert.ok(cookie.includes("glamping_datalab_session="));
    const admin = await fetch(`${instance.baseUrl}/admin`, { headers: { Cookie: cookie }, redirect: "manual" });
    const expectedLegacyHtml = fs.readFileSync(path.join(ROOT, "web", "index.html"), "utf8")
      .replace('href="/styles.css"', 'href="/styles.css?v=v2-20260714-region-keyword-readability-v22"')
      .replace('src="/app.js"', 'src="/app.js?v=v2-20260714-region-keyword-readability-v22"');
    assert.equal(admin.status, 200);
    assert.equal(await admin.text(), expectedLegacyHtml, "legacy UI response must remain byte-equivalent after its frozen cache-buster transform");
    const newRoute = await fetch(`${instance.baseUrl}/api/integration/core/workspace`, { headers: { Cookie: cookie, Accept: "application/json" } });
    assert.equal(newRoute.status, 404, "the additive API must not exist with its flag off");
  } finally {
    if (instance) await stopServer(instance);
  }
}

async function main() {
  await assertCoreDependencyFailsClosed();
  await assertLegacyFlagOff();

  let instance;
  let dataDir;
  let port;
  let admin;
  let businessOne;
  let businessTwo;
  try {
    instance = await startServer({ authFlag: true, coreFlag: false, uiFlag: true });
    dataDir = instance.dataDir;
    port = Number(new URL(instance.baseUrl).port);
    admin = await bootstrapAdmin(instance);
    businessOne = await signupBusiness(instance, "one");
    businessTwo = await signupBusiness(instance, "two");

    const sessionBeforeFlag = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(sessionBeforeFlag.status, 200);
    const disabled = await requestJson(instance, "/api/integration/core/workspace?view=business-onboarding", { jar: businessOne.jar });
    assert.equal(disabled.status, 404, "core API must remain absent while the flag is false");

    await stopServer(instance, false); instance = null;
    instance = await startServer({ port, dataDir, authFlag: true, coreFlag: true, uiFlag: true, fixtureMode: false });
    const sessionAfterFlag = await requestJson(instance, "/api/session", { jar: businessOne.jar });
    assert.equal(sessionAfterFlag.status, 200, "turning the additive flag on must preserve the Stage 226 session");
    assert.equal(sessionAfterFlag.body.accountId, sessionBeforeFlag.body.accountId);
    assert.equal(sessionAfterFlag.body.companyId, sessionBeforeFlag.body.companyId);

    const empty = await requestJson(instance, "/api/integration/core/workspace?view=business-onboarding", { jar: businessOne.jar });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.metadata.source, "empty");
    assert.equal(empty.body.metadata.providerCalls, 0);
    assert.equal(empty.body.metadata.legacyRuntimeReads, 0);
    assert.equal(empty.body.state.kind, "empty");
    assert.deepEqual(empty.body.history, []);
    assert.deepEqual(empty.body.interests, []);

    const missingCsrf = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      csrf: false,
      body: { kind: "business-search", clientRequestId: "stage227-http-no-csrf", keyword: "denied" }
    });
    assert.equal(missingCsrf.status, 403, "core mutations require Stage 226 CSRF");
    const tenantEscape = await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST",
      jar: businessOne.jar,
      body: {
        kind: "business-search",
        clientRequestId: "stage227-http-tenant",
        keyword: "tenant escape",
        tenantCompanyId: businessTwo.companyId
      }
    });
    assert.equal(tenantEscape.status, 403, "business tenant escape must be blocked server-side");

    const request = {
      kind: "business-search",
      clientRequestId: "stage227-http-search-0001",
      keyword: "Fresh HTTP search",
      collectionMode: "precision"
    };
    const created = await requestJson(instance, "/api/integration/core/jobs", { method: "POST", jar: businessOne.jar, body: request });
    assert.equal(created.status, 202);
    assert.equal(created.body.idempotent, false);
    const replay = await requestJson(instance, "/api/integration/core/jobs", { method: "POST", jar: businessOne.jar, body: request });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.job.jobId, created.body.job.jobId);
    const recovered = await requestJson(instance, `/api/integration/core/jobs/${encodeURIComponent(request.clientRequestId)}`, { jar: businessOne.jar });
    assert.equal(recovered.status, 200, "a page refresh can recover progress by clientRequestId");
    assert.equal(recovered.body.job.status, "running");
    const cancelled = await requestJson(instance, `/api/integration/core/jobs/${encodeURIComponent(request.clientRequestId)}/cancel`, {
      method: "POST", jar: businessOne.jar, body: { reason: "user-requested" }
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.status, "cancelled");
    const cancelledAgain = await requestJson(instance, `/api/integration/core/jobs/${encodeURIComponent(request.clientRequestId)}/cancel`, {
      method: "POST", jar: businessOne.jar, body: { reason: "user-requested" }
    });
    assert.equal(cancelledAgain.status, 200);
    assert.equal(cancelledAgain.body.idempotent, true);
    const history = await requestJson(instance, "/api/integration/core/workspace?view=business-activity", { jar: businessOne.jar });
    assert.ok(history.body.history.some((row) => row.clientRequestId === request.clientRequestId && row.status === "cancelled"));
    assert.equal((await requestJson(instance, "/api/integration/core/admin/tourism-requests", {
      method: "POST", jar: businessOne.jar, body: { clientRequestId: "stage227-http-tourism-denied", regionCode: "all" }
    })).status, 403, "business accounts cannot use admin collection routes");
    assert.equal((await requestJson(instance, "/api/integration/core/jobs", {
      method: "POST", jar: admin.jar,
      body: { kind: "business-search", clientRequestId: "stage227-http-admin-denied", keyword: "denied" }
    })).status, 403, "administrators cannot execute business-only search routes");

    const forbiddenPage = await fetch(`${instance.baseUrl}/admin/companies`, {
      headers: { Cookie: Object.entries(businessOne.jar).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("; ") },
      redirect: "manual"
    });
    assert.equal(forbiddenPage.status, 403, "business sessions must be blocked from admin UI routes at the server");

    await stopServer(instance, false); instance = null;
    instance = await startServer({ port, dataDir, authFlag: true, coreFlag: true, uiFlag: true, fixtureMode: true });
    const fixtureWorkspace = await requestJson(instance, "/api/integration/core/workspace?view=business-activity", { jar: businessOne.jar });
    assert.equal(fixtureWorkspace.status, 200);
    assert.equal(fixtureWorkspace.body.metadata.source, "synthetic-fresh-collection");
    assert.equal(fixtureWorkspace.body.state.kind, "partial", "fixture must exercise the partial-data UI contract");
    assert.equal(fixtureWorkspace.body.companies.length, 3);
    const fixtureCompanyId = fixtureWorkspace.body.companies[0].companyId;

    const interest = await requestJson(instance, "/api/integration/core/interests", {
      method: "POST", jar: businessOne.jar, body: { companyId: fixtureCompanyId }
    });
    assert.equal(interest.status, 201);
    assert.equal((await requestJson(instance, "/api/integration/core/interests", {
      method: "POST", jar: businessOne.jar, body: { companyId: fixtureCompanyId }
    })).body.idempotent, true);
    const location = await requestJson(instance, "/api/integration/core/location-card-requests", {
      method: "POST", jar: businessOne.jar,
      body: { clientRequestId: "stage227-http-location-01", companyId: fixtureCompanyId }
    });
    assert.equal(location.status, 202);
    const tourism = await requestJson(instance, "/api/integration/core/admin/tourism-requests", {
      method: "POST", jar: admin.jar,
      body: { clientRequestId: "stage227-http-tourism-01", regionCode: "all" }
    });
    assert.equal(tourism.status, 202);
    const businessFixtureAfter = await requestJson(instance, "/api/integration/core/workspace?view=business-location", { jar: businessOne.jar });
    assert.equal(businessFixtureAfter.body.interests.length, 1);
    assert.equal(businessFixtureAfter.body.locationCardRequests.length, 1);
    assert.deepEqual(businessFixtureAfter.body.connectors, {}, "connector configuration is admin-only");
    const adminFixtureAfter = await requestJson(instance, "/api/integration/core/workspace?view=admin-settings", { jar: admin.jar });
    assert.equal(adminFixtureAfter.body.tourismRequests.length, 1);
    assert.equal(Object.keys(adminFixtureAfter.body.connectors).length, 3);

    const allBodies = JSON.stringify([empty.body, created.body, recovered.body, cancelled.body, fixtureWorkspace.body, businessFixtureAfter.body, adminFixtureAfter.body]);
    assert.equal(allBodies.includes(dataDir), false, "core responses must not expose a raw data path");
    assert.doesNotMatch(allBodies, /(?:customer_db|company_master|tourism_data|[\\/]outputs[\\/])/i);
    for (const forbiddenPath of ["customer_db", "history", "company_master", "tourism_data"]) {
      assert.equal(fs.existsSync(path.join(dataDir, forbiddenPath)), false, `${forbiddenPath} must not be read, copied or created by Stage 227`);
    }

    console.log("Stage 227 flag-off legacy parity and auth/CSRF/tenant/role/idempotent HTTP flow checks passed");
  } finally {
    if (instance) await stopServer(instance);
    else if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
