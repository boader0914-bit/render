"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createSignalConnectorRepository } = require("./integration/repositories/signal_connector_store.cjs");
const {
  assertZeroNetworkAttempts,
  bootstrapAdmin,
  networkGuardEnvironment,
  requestJson,
  signupBusiness,
  startServer,
  stopServer,
  temporaryDirectory
} = require("./test_support/stage230_test_helpers.cjs");

function assertSafeProjection(value, forbiddenValues = []) {
  const json = JSON.stringify(value);
  for (const key of ["jobId", "signature", "companyId", "tenantCompanyId", "sourceUrl", "rawPath", "actor", "reservationId"]) {
    assert.equal(json.includes(`\"${key}\"`), false, `connector response exposed ${key}`);
  }
  for (const value of forbiddenValues.filter(Boolean)) {
    assert.equal(json.includes(String(value)), false, `connector response exposed a configured path`);
  }
  assert.doesNotMatch(json, /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,})/);
}

async function missingFreshRootFailsClosed() {
  const dataDir = temporaryDirectory("stage231-connector-missing-root-");
  let failure;
  try {
    await startServer({
      dataDir,
      integrationDataDir: "",
      authFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: { V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED: "true" }
    });
  } catch (error) {
    failure = error;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  assert.ok(failure, "connector runtime unexpectedly started without V2_INTEGRATION_DATA_DIR");
  assert.match(String(failure.stack || failure), /V2_INTEGRATION_DATA_DIR is required|explicit fresh integration root is required/i);
}

async function flagOffRegression() {
  const integrationDataDir = temporaryDirectory("stage231-connector-off-");
  let server;
  try {
    server = await startServer({ authFlag: true, integrationDataDir });
    const admin = await bootstrapAdmin(server, {
      username: "stage231-off-admin",
      email: "stage231-off-admin@example.test",
      password: "Stage231OffAdmin!1"
    });
    const disabled = await requestJson(server, "/api/integration/connectors/status", { jar: admin.jar });
    assert.equal(disabled.status, 404, "connector API must not exist while its runtime flag is off");
  } finally {
    if (server) await stopServer(server);
    else fs.rmSync(integrationDataDir, { recursive: true, force: true });
  }
}

async function adminOperationsBoundary() {
  const dataDir = temporaryDirectory("stage231-connector-auth-");
  const integrationDataDir = temporaryDirectory("stage231-connector-fresh-");
  const guardDir = temporaryDirectory("stage231-connector-network-");
  const guardLog = path.join(guardDir, "attempts.jsonl");
  let server;
  try {
    server = await startServer({
      dataDir,
      integrationDataDir,
      authFlag: true,
      uiFlag: true,
      coreFlag: true,
      freshCompanyFlag: true,
      freshObservationFlag: true,
      extraEnv: networkGuardEnvironment(guardLog, {
        V2_INTEGRATION_CONNECTOR_RUNTIME_ENABLED: "true",
        V2_INTEGRATION_SCHEDULER_ENABLED: "true",
        V2_CONNECTOR_NAVER_TREND_REAL_ENABLED: "true",
        V2_CONNECTOR_SECRET_THAT_MUST_NOT_BE_READ: "stage231-do-not-read-secret"
      })
    });
    const admin = await bootstrapAdmin(server, {
      username: "stage231-admin",
      email: "stage231-admin@example.test",
      password: "Stage231Admin!1"
    });
    const business = await signupBusiness(server, "stage231");

    const anonymous = await requestJson(server, "/api/integration/connectors/status");
    assert.equal(anonymous.status, 401);
    const forbidden = await requestJson(server, "/api/integration/connectors/status", { jar: business.jar });
    assert.equal(forbidden.status, 403);

    const initial = await requestJson(server, "/api/integration/connectors/status", { jar: admin.jar });
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.metadata.stage, 231);
    assert.equal(initial.body.metadata.adapterMode, "explicit-official-provider-only");
    assert.equal(initial.body.metadata.fixtureAvailable, false);
    assert.equal(initial.body.scheduler.stopped, true);
    assert.equal(initial.body.scheduler.operational, false);
    assert.equal(initial.body.providers.length, 4);
    assert.equal(initial.body.providers.every((provider) => provider.adapterConfigured === false && provider.operational === false), true);
    assert.equal(initial.body.providers.find((provider) => provider.id === "naver-trend").rolloutRequested, true);
    assert.equal(initial.body.diagnostics.externalNetworkCalls, 0);
    assert.equal(initial.body.diagnostics.credentialReads, 0);
    assert.equal(initial.body.diagnostics.legacyRuntimeReads, 0);
    assert.equal(initial.body.diagnostics.legacyRuntimeCopies, 0);
    assertSafeProjection(initial.body, [dataDir, integrationDataDir, "stage231-do-not-read-secret"]);

    const jobPayload = {
      clientRequestId: "stage231-real-request-0001",
      mode: "real",
      providerId: "naver-trend",
      companyId: business.companyId,
      tenantCompanyId: business.companyId,
      periodMonth: "2026-08",
      region: "경남",
      signalKinds: ["trend.index"],
      callsPerRun: 1,
      dailyCallCap: 10,
      monthlyCallCap: 100,
      costPerCall: 0,
      dailyCostCap: 0,
      monthlyCostCap: 0,
      currency: "KRW",
      maxAttempts: 3,
      timeoutMs: 1000
    };
    const noCsrf = await requestJson(server, "/api/integration/connectors/jobs", {
      method: "POST", jar: admin.jar, csrf: false, body: jobPayload
    });
    assert.equal(noCsrf.status, 403, "connector mutations require CSRF");
    const forgedPolicy = await requestJson(server, "/api/integration/connectors/jobs", {
      method: "POST", jar: admin.jar, body: jobPayload
    });
    assert.equal(forgedPolicy.status, 400);
    assert.equal(forgedPolicy.body.code, "SIGNAL_CONNECTOR_POLICY_FIELDS_FORBIDDEN");
    const blockedJob = await requestJson(server, "/api/integration/connectors/jobs", {
      method: "POST", jar: admin.jar, body: {
        clientRequestId: jobPayload.clientRequestId,
        providerId: jobPayload.providerId,
        companyId: jobPayload.companyId,
        periodMonth: jobPayload.periodMonth
      }
    });
    assert.equal(blockedJob.status, 503);
    assert.equal(blockedJob.body.code, "SIGNAL_CONNECTOR_ADAPTER_REQUIRED");

    const jobs = await requestJson(server, "/api/integration/connectors/jobs", { jar: admin.jar });
    assert.equal(jobs.status, 200);
    assert.deepEqual(jobs.body.jobs, [], "an adapter rejection must not persist a job");

    const durableRepository = createSignalConnectorRepository({ integrationRoot: integrationDataDir, env: { NODE_ENV: "test" } });
    await durableRepository.initialize();
    await durableRepository.createJob(jobPayload, { actor: { type: "test", id: "durable-control-seed", role: "system" } });
    const projectedJob = await requestJson(server, "/api/integration/connectors/jobs/stage231-real-request-0001", { jar: admin.jar });
    assert.equal(projectedJob.status, 200);
    assert.equal(projectedJob.body.job.status, "queued");
    assertSafeProjection(projectedJob.body, [business.companyId, dataDir, integrationDataDir]);
    const cancelledJob = await requestJson(server, "/api/integration/connectors/jobs/stage231-real-request-0001/cancel", {
      method: "POST", jar: admin.jar, body: {}
    });
    assert.equal(cancelledJob.status, 200);
    assert.equal(cancelledJob.body.job.status, "cancelled");
    assertSafeProjection(cancelledJob.body, [business.companyId]);
    const blockedResume = await requestJson(server, "/api/integration/connectors/jobs/stage231-real-request-0001/resume", {
      method: "POST", jar: admin.jar, body: {}
    });
    assert.equal(blockedResume.status, 503);
    assert.equal(blockedResume.body.code, "SIGNAL_CONNECTOR_ADAPTER_REQUIRED");

    const stopped = await requestJson(server, "/api/integration/connectors/providers/naver-trend/stop", {
      method: "POST", jar: admin.jar, body: { reason: "must-not-leak-C:\\secret" }
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.provider.state, "stopped");
    const stoppedStatus = await requestJson(server, "/api/integration/connectors/status", { jar: admin.jar });
    assert.equal(stoppedStatus.body.providers.find((provider) => provider.id === "naver-trend").state, "stopped");
    assertSafeProjection(stoppedStatus.body, ["must-not-leak-C:\\secret"]);

    const resumed = await requestJson(server, "/api/integration/connectors/providers/naver-trend/resume", {
      method: "POST", jar: admin.jar, body: {}
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.provider.state, "approval-required");

    const schedulerBlocked = await requestJson(server, "/api/integration/connectors/scheduler/enable", {
      method: "POST", jar: admin.jar, body: {}
    });
    assert.equal(schedulerBlocked.status, 503);
    assert.equal(schedulerBlocked.body.code, "SIGNAL_CONNECTOR_SCHEDULER_TARGETS_REQUIRED");
    const schedulerStopped = await requestJson(server, "/api/integration/connectors/scheduler/stop", {
      method: "POST", jar: admin.jar, body: { reason: "stop" }
    });
    assert.equal(schedulerStopped.status, 200);
    assert.equal(schedulerStopped.body.scheduler.stopped, true);

    const missingCancel = await requestJson(server, "/api/integration/connectors/jobs/missing-client-request/cancel", {
      method: "POST", jar: admin.jar, body: {}
    });
    assert.equal(missingCancel.status, 404);
    const finalStatus = await requestJson(server, "/api/integration/connectors/status", { jar: admin.jar });
    assert.equal(finalStatus.body.diagnostics.externalNetworkCalls, 0);
    assert.equal(finalStatus.body.diagnostics.configuredAdapterCount, 0);
    assertSafeProjection(finalStatus.body, [dataDir, integrationDataDir, "stage231-do-not-read-secret"]);
  } finally {
    if (server) await stopServer(server, false);
    assertZeroNetworkAttempts(guardLog);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(integrationDataDir, { recursive: true, force: true });
    fs.rmSync(guardDir, { recursive: true, force: true });
  }
}

async function main() {
  await missingFreshRootFailsClosed();
  await flagOffRegression();
  await adminOperationsBoundary();
  console.log("Stage 231 signal connector HTTP boundary: PASS");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
