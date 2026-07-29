"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { totp } = require("./integration/services/auth_crypto.cjs");
const {
  ROOT,
  assertBusinessSafe,
  assertZeroNetworkAttempts,
  availablePort,
  bootstrapAdmin,
  networkGuardEnvironment,
  requestJson,
  signupBusiness,
  startServer,
  stopServer,
  temporaryDirectory
} = require("./test_support/stage229_test_helpers.cjs");

async function expectStartupFailure(options, pattern) {
  const dataDir = temporaryDirectory("stage229-startup-fail-auth-");
  const integrationDataDir = temporaryDirectory("stage229-startup-fail-fresh-");
  let instance;
  let reason;
  try {
    instance = await startServer({ ...options, dataDir, integrationDataDir });
  } catch (error) {
    reason = error;
  } finally {
    if (instance) await stopServer(instance, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
  }
  assert.ok(reason, "misconfigured Stage 229 server unexpectedly started");
  assert.match(String(reason.stack || reason), pattern);
}

async function assertUiRuntimeFlagSeparation() {
  const baseOptions = {
    authFlag: true,
    coreFlag: true,
    uiFlag: true,
    freshCompanyFlag: true,
    freshObservationFlag: true
  };
  const cases = [
    {
      name: "location-only",
      options: { reliabilityFlag: true, locationCardFlag: true, businessReportFlag: false },
      location: "true",
      report: "false"
    },
    {
      name: "report-only",
      options: { reliabilityFlag: false, locationCardFlag: false, businessReportFlag: true },
      location: "false",
      report: "true"
    }
  ];
  for (const testCase of cases) {
    let server;
    try {
      server = await startServer({ ...baseOptions, ...testCase.options });
      const response = await fetch(`${server.baseUrl}/login`);
      assert.equal(response.status, 200, `${testCase.name} V3 index status`);
      const html = await response.text();
      assert.match(html, new RegExp(`<meta name="lodging-v2-location-card-enabled" content="${testCase.location}"`));
      assert.match(html, new RegExp(`<meta name="lodging-v2-business-report-enabled" content="${testCase.report}"`));
      assert.doesNotMatch(html, /__V2_(?:LOCATION_CARD|BUSINESS_REPORT)_ENABLED__/);
    } finally {
      if (server) await stopServer(server);
    }
  }
}

async function waitForCompletedJob(server, jar, clientRequestId) {
  const deadline = Date.now() + 25_000;
  const statuses = new Set();
  while (Date.now() < deadline) {
    const result = await requestJson(
      server,
      `/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}`,
      { jar }
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const status = result.body.job?.status || "";
    statuses.add(status);
    if (status === "completed") return result.body.job;
    if (["failed", "cancelled"].includes(status)) throw new Error(`fresh collection ended as ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fresh collection timed out; statuses=${[...statuses].join(",")}`);
}

async function collectCompany(server, account, suffix) {
  const clientRequestId = `stage229-http-collection-${suffix}`;
  const submitted = await requestJson(server, "/api/integration/core/jobs", {
    method: "POST",
    jar: account.jar,
    body: {
      kind: "business-search",
      clientRequestId,
      keyword: `Stage 229 fresh company ${suffix}`,
      regionLabel: suffix === "one" ? "Stage 229 합성 지역" : "Stage 229 격리 지역"
    }
  });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  await waitForCompletedJob(server, account.jar, clientRequestId);
  const workspace = await requestJson(server, "/api/integration/core/workspace?view=business-activity", { jar: account.jar });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  assert.ok(workspace.body.companies.length >= 1);
  return { companyId: workspace.body.companies[0].companyId, workspace: workspace.body };
}

async function assertFlagOffRegression() {
  let server;
  try {
    server = await startServer({ authFlag: true, coreFlag: true, uiFlag: false, fixtureMode: true });
    await bootstrapAdmin(server, {
      username: "stage229-off-admin",
      email: "stage229-off-admin@example.test",
      password: "Stage229OffAdmin!1"
    });
    const business = await signupBusiness(server, "stage229-off");
    const disabled = await requestJson(server, "/api/integration/insights/metadata", { jar: business.jar });
    assert.equal(disabled.status, 404, "insights API must not exist when all Stage 229 flags are off");
    const workspace = await requestJson(server, "/api/integration/core/workspace?view=business-location", { jar: business.jar });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.metadata.stage, 227);
    assert.ok(workspace.body.companies.length >= 1);
    const companyId = workspace.body.companies[0].companyId;
    const request = {
      clientRequestId: "stage229-off-core-location-0001",
      companyId
    };
    const created = await requestJson(server, "/api/integration/core/location-card-requests", {
      method: "POST",
      jar: business.jar,
      body: request
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.idempotent, false);
    assert.equal(created.body.request.provisional, true, "flag-off core path must keep the Stage 227 provisional request store");
    const replay = await requestJson(server, "/api/integration/core/location-card-requests", {
      method: "POST",
      jar: business.jar,
      body: request
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    const after = await requestJson(server, "/api/integration/core/workspace?view=business-location", { jar: business.jar });
    assert.equal(after.body.locationCardRequests.length, 1);
    assert.equal(after.body.locationCardRequests[0].provisional, true);

    for (const pathname of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/favicon.svg"]) {
      const response = await fetch(`${server.baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(path.join(ROOT, "web", pathname.slice(1))));
    }
  } finally {
    if (server) await stopServer(server);
  }
}

async function assertFlagOnDurableFlow() {
  const dataDir = temporaryDirectory("stage229-server-auth-");
  const integrationDataDir = temporaryDirectory("stage229-server-fresh-");
  const guardDir = temporaryDirectory("stage229-server-guard-");
  const guardLog = path.join(guardDir, "attempts.jsonl");
  const port = await availablePort();
  let server;
  let businessOne;
  let businessTwo;
  let admin;
  try {
    const options = {
      port,
      dataDir,
      integrationDataDir,
      uiFlag: true,
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      reliabilityFlag: true,
      locationCardFlag: true,
      businessReportFlag: true,
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture"
      })
    };
    server = await startServer(options);
    admin = await bootstrapAdmin(server, {
      username: "stage229-http-admin",
      email: "stage229-http-admin@example.test",
      password: "Stage229HttpAdmin!1"
    });
    businessOne = await signupBusiness(server, "stage229-one");
    businessTwo = await signupBusiness(server, "stage229-two");

    const one = await collectCompany(server, businessOne, "one");
    const two = await collectCompany(server, businessTwo, "two");
    assert.notEqual(one.companyId, two.companyId);

    const noSession = await requestJson(server, "/api/integration/insights/metadata");
    assert.equal(noSession.status, 401);
    const metadata = await requestJson(server, "/api/integration/insights/metadata", { jar: businessOne.jar });
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    assert.equal(metadata.body.metadata.stage, 229);
    assert.equal(metadata.body.metadata.providerId, "stage229-deterministic-signal-fixture");
    assert.equal(metadata.body.metadata.externalProviderCalls, 0);
    assert.equal(metadata.body.metadata.credentialReads, 0);
    assert.equal(metadata.body.metadata.legacyRuntimeReads, 0);
    assert.equal(metadata.body.metadata.legacyRuntimeCopies, 0);
    assert.equal(metadata.body.metadata.productionMutations, 0);

    const initialReport = await requestJson(server, "/api/integration/insights/workspace?view=business-report", { jar: businessOne.jar });
    assert.equal(initialReport.status, 200);
    assert.ok(["not-collected", "not-published", "insufficient-data"].includes(initialReport.body.state));
    assertBusinessSafe(initialReport.body, {
      allowedCompanyIds: [one.companyId],
      forbiddenCompanyIds: [two.companyId]
    });

    const missingCsrf = await requestJson(server, "/api/integration/core/location-card-requests", {
      method: "POST",
      jar: businessOne.jar,
      csrf: false,
      body: { clientRequestId: "stage229-http-no-csrf", companyId: one.companyId }
    });
    assert.equal(missingCsrf.status, 403, "Stage 229 mutations must retain Stage 226 CSRF protection");
    const tenantEscape = await requestJson(
      server,
      `/api/integration/insights/location-cards?companyId=${encodeURIComponent(two.companyId)}`,
      { jar: businessOne.jar }
    );
    assert.equal(tenantEscape.status, 403, "cross-tenant company lookup must fail server-side");
    const workspaceEscape = await requestJson(
      server,
      `/api/integration/insights/workspace?view=business-report&companyId=${encodeURIComponent(two.companyId)}`,
      { jar: businessOne.jar }
    );
    assert.equal(workspaceEscape.status, 403, "business workspace must reject arbitrary company IDs");
    const adminNamespaceEscape = await requestJson(server, "/api/integration/insights/admin/location-cards", {
      method: "POST",
      jar: businessOne.jar,
      body: { clientRequestId: "stage229-admin-namespace-escape", companyId: one.companyId }
    });
    assert.equal(adminNamespaceEscape.status, 403, "business accounts must not use the admin alias namespace");

    const requestPayload = {
      clientRequestId: "stage229-core-durable-location-0001",
      companyId: one.companyId
    };
    const created = await requestJson(server, "/api/integration/core/location-card-requests", {
      method: "POST",
      jar: businessOne.jar,
      body: requestPayload
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.idempotent, false);
    assert.equal(created.body.request.provisional, false, "flag-on core route must delegate to the durable Stage 229 store");
    assert.equal(created.body.request.lifecycle, "requested");
    const replay = await requestJson(server, "/api/integration/core/location-card-requests", {
      method: "POST",
      jar: businessOne.jar,
      body: requestPayload
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);
    assert.equal(replay.body.request.cardId, created.body.request.cardId);

    const delegatedWorkspace = await requestJson(server, "/api/integration/core/workspace?view=business-location", { jar: businessOne.jar });
    assert.equal(delegatedWorkspace.status, 200, JSON.stringify(delegatedWorkspace.body));
    assert.equal(delegatedWorkspace.body.locationCardRequests.length, 1);
    assert.equal(delegatedWorkspace.body.locationCardRequests[0].provisional, false);
    assert.equal(delegatedWorkspace.body.locationCardRequests[0].cardId, created.body.request.cardId);

    const hidden = await requestJson(
      server,
      `/api/integration/insights/location-cards?companyId=${encodeURIComponent(one.companyId)}`,
      { jar: businessOne.jar }
    );
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.state, "not-published");
    assert.deepEqual(hidden.body.cards, []);

    await stopServer(server, false);
    server = null;
    server = await startServer(options);
    const sessionAfterRestart = await requestJson(server, "/api/session", { jar: businessOne.jar });
    assert.equal(sessionAfterRestart.status, 200, "Stage 229 restart must preserve the Stage 226 session");
    assert.equal(sessionAfterRestart.body.accountId, businessOne.signup.body.accountId);
    const adminReauth = await requestJson(server, "/api/auth/reauth", {
      method: "POST",
      jar: admin.jar,
      body: { password: admin.account.password, code: totp(admin.enrollment.body.secret) }
    });
    assert.equal(adminReauth.status, 200, "admin publish/review requires a fresh password + MFA step-up after restart");
    const recovered = await requestJson(server, "/api/integration/core/workspace?view=business-location", { jar: businessOne.jar });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.locationCardRequests.length, 1, "durable request must survive process restart");
    assert.equal(recovered.body.locationCardRequests[0].cardId, created.body.request.cardId);

    const adminList = await requestJson(
      server,
      `/api/integration/insights/location-cards?companyId=${encodeURIComponent(one.companyId)}&tenantCompanyId=${encodeURIComponent(businessOne.companyId)}`,
      { jar: admin.jar }
    );
    assert.equal(adminList.status, 200, JSON.stringify(adminList.body));
    assert.equal(adminList.body.cards.length, 1);
    assert.equal(adminList.body.cards[0].lifecycle, "requested");

    const draftWithoutCsrf = await requestJson(
      server,
      `/api/integration/insights/admin/location-cards/${encodeURIComponent(created.body.request.cardId)}/draft`,
      {
        method: "POST",
        jar: admin.jar,
        csrf: false,
        body: { expectedVersion: 1, month: "2026-07", forecastMonth: "2026-08" }
      }
    );
    assert.equal(draftWithoutCsrf.status, 403);
    const draft = await requestJson(
      server,
      `/api/integration/insights/admin/location-cards/${encodeURIComponent(created.body.request.cardId)}/draft`,
      {
        method: "POST",
        jar: admin.jar,
        body: {
          expectedVersion: 1,
          month: "2026-07",
          forecastMonth: "2026-08",
          editorial: { headline: "Stage 229 HTTP 표본 gate" }
        }
      }
    );
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    assert.equal(draft.body.card.state, "insufficient-data");
    assert.equal(draft.body.card.overallScore, null);
    assert.equal(draft.body.card.forecast.value, null);
    const submitted = await requestJson(
      server,
      `/api/integration/insights/admin/location-cards/${encodeURIComponent(created.body.request.cardId)}/review`,
      {
        method: "POST", jar: admin.jar,
        body: { expectedVersion: draft.body.card.version, decision: "submit", reason: "HTTP 검수" }
      }
    );
    assert.equal(submitted.status, 200);
    const reviewed = await requestJson(
      server,
      `/api/integration/insights/admin/location-cards/${encodeURIComponent(created.body.request.cardId)}/review`,
      {
        method: "POST", jar: admin.jar,
        body: { expectedVersion: submitted.body.card.version, decision: "approve", reason: "공개 gate 확인" }
      }
    );
    assert.equal(reviewed.status, 200);
    const blockedPublish = await requestJson(
      server,
      `/api/integration/insights/admin/location-cards/${encodeURIComponent(created.body.request.cardId)}/publish`,
      {
        method: "POST", jar: admin.jar,
        body: { expectedVersion: reviewed.body.card.version }
      }
    );
    assert.equal(blockedPublish.status, 409);
    assert.equal(blockedPublish.body.code, "INSIGHTS_SAMPLE_GATE");

    const stillHidden = await requestJson(
      server,
      `/api/integration/insights/location-cards?companyId=${encodeURIComponent(one.companyId)}`,
      { jar: businessOne.jar }
    );
    assert.deepEqual(stillHidden.body.cards, []);
    assertBusinessSafe(stillHidden.body, {
      allowedCompanyIds: [one.companyId],
      forbiddenCompanyIds: [two.companyId]
    });
    const allBodies = JSON.stringify([
      metadata.body, initialReport.body, created.body, delegatedWorkspace.body, hidden.body, stillHidden.body
    ]);
    assert.equal(allBodies.includes(dataDir), false);
    assert.equal(allBodies.includes(integrationDataDir), false);
    assert.doesNotMatch(allBodies, /(?:customer_db|company_master|tourism_data|[\\/]outputs[\\/])/i);
    for (const forbidden of ["customer_db", "company_master", "tourism_data", "history"] ) {
      assert.equal(fs.existsSync(path.join(dataDir, forbidden)), false, `${forbidden} must not be created by Stage 229`);
    }
    assertZeroNetworkAttempts(guardLog);
    console.log("Stage 229 HTTP flags, delegation, restart, auth, CSRF, tenant, business-safe and sample-gate checks passed");
  } finally {
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

async function main() {
  await expectStartupFailure(
    { authFlag: true, coreFlag: true, reliabilityFlag: true },
    /V2_INTEGRATION_RELIABILITY_ENABLED requires V2_INTEGRATION_FRESH_OBSERVATION_ENABLED/
  );
  await expectStartupFailure(
    {
      authFlag: true, coreFlag: true,
      freshCompanyFlag: true, freshObservationFlag: true,
      locationCardFlag: true
    },
    /V2_INTEGRATION_LOCATION_CARD_ENABLED requires V2_INTEGRATION_RELIABILITY_ENABLED/
  );
  await expectStartupFailure(
    { authFlag: true, coreFlag: true, businessReportFlag: true },
    /V2_INTEGRATION_BUSINESS_REPORT_ENABLED requires V2_INTEGRATION_FRESH_OBSERVATION_ENABLED/
  );
  await expectStartupFailure(
    {
      authFlag: true, coreFlag: true,
      freshCompanyFlag: true, freshObservationFlag: true,
      reliabilityFlag: true, locationCardFlag: true, businessReportFlag: true,
      extraEnv: { V2_INTEGRATION_INSIGHTS_PROVIDER: "real-provider" }
    },
    /real providers, credentials, scheduler and quota traffic are forbidden|INSIGHTS_REAL_PROVIDER_FORBIDDEN/i
  );
  await assertUiRuntimeFlagSeparation();
  await assertFlagOffRegression();
  await assertFlagOnDurableFlow();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
