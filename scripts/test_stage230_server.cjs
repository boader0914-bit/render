"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
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
} = require("./test_support/stage230_test_helpers.cjs");

function stage230Env(guardLog = "") {
  return {
    V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture",
    V2_INTEGRATION_STRATEGY_ENABLED: "true",
    V2_INTEGRATION_EXECUTION_ENABLED: "true",
    V2_INTEGRATION_RETROSPECTIVE_ENABLED: "true",
    ...(guardLog ? networkGuardEnvironment(guardLog) : {})
  };
}

async function expectStartupFailure(options, pattern) {
  const dataDir = temporaryDirectory("stage230-startup-auth-");
  const integrationDataDir = temporaryDirectory("stage230-startup-fresh-");
  let server;
  let failure;
  try {
    server = await startServer({ ...options, dataDir, integrationDataDir });
  } catch (error) {
    failure = error;
  } finally {
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
  }
  assert.ok(failure, "invalid Stage 230 dependency flags unexpectedly started");
  assert.match(String(failure.stack || failure), pattern);
}

async function waitForCompletedJob(server, jar, clientRequestId) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await requestJson(server, `/api/integration/core/jobs/${encodeURIComponent(clientRequestId)}`, { jar });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.body.job?.status === "completed") return result.body.job;
    if (["failed", "cancelled"].includes(result.body.job?.status)) throw new Error(`collection ${result.body.job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Stage 230 fresh collection timed out");
}

async function collectCompany(server, account, suffix) {
  const clientRequestId = `stage230-http-collection-${suffix}`;
  const submitted = await requestJson(server, "/api/integration/core/jobs", {
    method: "POST",
    jar: account.jar,
    body: { kind: "business-search", clientRequestId, keyword: `Stage 230 fresh company ${suffix}`, regionLabel: `Stage 230 fixture ${suffix}` }
  });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.body));
  await waitForCompletedJob(server, account.jar, clientRequestId);
  const workspace = await requestJson(server, "/api/integration/core/workspace?view=business-activity", { jar: account.jar });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  assert.ok(workspace.body.companies.length >= 1);
  return workspace.body.companies[0].companyId;
}

async function assertFlagOffRegression() {
  let server;
  try {
    server = await startServer({
      authFlag: true, coreFlag: true, uiFlag: true,
      freshCompanyFlag: true, freshObservationFlag: true,
      reliabilityFlag: true, locationCardFlag: true, businessReportFlag: true,
      extraEnv: { V2_INTEGRATION_INSIGHTS_PROVIDER: "deterministic-fixture" }
    });
    await bootstrapAdmin(server, {
      username: "stage230-off-admin",
      email: "stage230-off-admin@example.test",
      password: "Stage230OffAdmin!1"
    });
    const business = await signupBusiness(server, "stage230-off");
    const disabled = await requestJson(server, "/api/integration/strategy/metadata", { jar: business.jar });
    assert.equal(disabled.status, 404, "Stage 230 API must not exist while all three flags are off");
    const stage229 = await requestJson(server, "/api/integration/insights/metadata", { jar: business.jar });
    assert.equal(stage229.status, 200);
    assert.equal(stage229.body.metadata.stage, 229);
    const core = await requestJson(server, "/api/integration/core/workspace?view=business-activity", { jar: business.jar });
    assert.equal(core.status, 200);
    assert.equal(core.body.metadata.stage, 228);
  } finally {
    if (server) await stopServer(server);
  }
}

async function assertFlagOnColdStartBoundary() {
  const dataDir = temporaryDirectory("stage230-server-auth-");
  const integrationDataDir = temporaryDirectory("stage230-server-fresh-");
  const guardDir = temporaryDirectory("stage230-server-network-");
  const guardLog = path.join(guardDir, "attempts.jsonl");
  const port = await availablePort();
  const options = {
    port, dataDir, integrationDataDir,
    authFlag: true, coreFlag: true, uiFlag: true,
    freshCompanyFlag: true, freshObservationFlag: true,
    reliabilityFlag: true, locationCardFlag: true, businessReportFlag: true,
    extraEnv: stage230Env(guardLog)
  };
  let server;
  try {
    server = await startServer(options);
    await bootstrapAdmin(server, {
      username: "stage230-http-admin",
      email: "stage230-http-admin@example.test",
      password: "Stage230HttpAdmin!1"
    });
    const one = await signupBusiness(server, "stage230-one");
    const two = await signupBusiness(server, "stage230-two");
    const oneCompanyId = await collectCompany(server, one, "one");
    const twoCompanyId = await collectCompany(server, two, "two");
    assert.notEqual(oneCompanyId, twoCompanyId);

    const anonymous = await requestJson(server, "/api/integration/strategy/metadata");
    assert.equal(anonymous.status, 401);
    const metadata = await requestJson(server, "/api/integration/strategy/metadata", { jar: one.jar });
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    assert.equal(metadata.body.metadata.stage, 230);
    assert.equal(metadata.body.metadata.ruleVersion, "v2-stage230-deterministic-strategy-v1");
    assert.deepEqual(metadata.body.metadata.capabilities, { strategy: true, execution: true, retrospective: true });
    for (const key of ["externalProviderCalls", "legacyRuntimeReads", "legacyRuntimeCopies", "productionMutations"]) {
      assert.equal(metadata.body.metadata[key], 0, `${key} must remain zero`);
    }

    const workspace = await requestJson(server, "/api/integration/strategy/workspace?view=business-strategy&month=2026-08", { jar: one.jar });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    assert.ok(["not-published-report", "insufficient-confidence"].includes(workspace.body.state));
    assert.deepEqual(workspace.body.strategies, []);
    assert.equal(Object.hasOwn(workspace.body, "tenantCompanyId"), false, "business projection must not expose tenant internals");
    assertBusinessSafe(workspace.body, { allowedCompanyIds: [oneCompanyId], forbiddenCompanyIds: [twoCompanyId] });

    const noCsrf = await requestJson(server, "/api/integration/strategy/strategies/generate", {
      method: "POST", jar: one.jar, csrf: false,
      body: { clientRequestId: "stage230-no-csrf", companyId: oneCompanyId, month: "2026-08" }
    });
    assert.equal(noCsrf.status, 403);
    const blockedGeneration = await requestJson(server, "/api/integration/strategy/strategies/generate", {
      method: "POST", jar: one.jar,
      body: { clientRequestId: "stage230-cold-start-generate", companyId: oneCompanyId, month: "2026-08" }
    });
    assert.equal(blockedGeneration.status, 409);
    assert.ok(["STRATEGY_REPORT_NOT_PUBLISHED", "STRATEGY_REPORT_CONFIDENCE_REQUIRED"].includes(blockedGeneration.body.code));
    const tenantEscape = await requestJson(
      server,
      `/api/integration/strategy/workspace?view=business-strategy&companyId=${encodeURIComponent(twoCompanyId)}`,
      { jar: one.jar }
    );
    assert.equal(tenantEscape.status, 403);
    const adminEscape = await requestJson(server, "/api/integration/strategy/admin/workspace?view=admin-strategy", { jar: one.jar });
    assert.equal(adminEscape.status, 403);

    assert.ok(fs.existsSync(path.join(integrationDataDir, "stage230-strategy", "manifest.json")));
    await stopServer(server, false);
    server = null;
    server = await startServer(options);
    const resumed = await requestJson(server, "/api/session", { jar: one.jar });
    assert.equal(resumed.status, 200, "Stage 226 session must survive Stage 230 runtime restart");
    const resumedWorkspace = await requestJson(server, "/api/integration/strategy/workspace?view=business-strategy&month=2026-08", { jar: one.jar });
    assert.equal(resumedWorkspace.status, 200);
    assert.deepEqual(resumedWorkspace.body.strategies, []);
    assertZeroNetworkAttempts(guardLog);
    console.log("Stage 230 HTTP flags, cold-start gate, CSRF, tenant, business-safe, restart and zero-network checks passed");
  } finally {
    if (server) await stopServer(server, false);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

async function main() {
  await expectStartupFailure(
    { authFlag: true, coreFlag: true, extraEnv: { V2_INTEGRATION_STRATEGY_ENABLED: "true" } },
    /V2_INTEGRATION_STRATEGY_ENABLED requires V2_INTEGRATION_BUSINESS_REPORT_ENABLED/
  );
  await expectStartupFailure(
    { authFlag: true, coreFlag: true, extraEnv: { V2_INTEGRATION_EXECUTION_ENABLED: "true" } },
    /V2_INTEGRATION_EXECUTION_ENABLED requires V2_INTEGRATION_STRATEGY_ENABLED/
  );
  await expectStartupFailure(
    { authFlag: true, coreFlag: true, extraEnv: { V2_INTEGRATION_RETROSPECTIVE_ENABLED: "true" } },
    /V2_INTEGRATION_RETROSPECTIVE_ENABLED requires V2_INTEGRATION_EXECUTION_ENABLED/
  );
  await assertFlagOffRegression();
  await assertFlagOnColdStartBoundary();
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
