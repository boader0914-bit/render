"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSignalConnectorRuntime } = require("./integration/bootstrap/signal_connector_runtime.cjs");
const { createInsightsService } = require("./integration/services/insights_service.cjs");
const { deriveLocationAnalysis } = require("./integration/contracts/insights.cjs");

const COMPANY_ID = "cmp_live_stage231_runtime";
const TENANT_ID = "tenant_live_stage231_runtime";

function error(message, code, statusCode) {
  const reason = new Error(message);
  reason.code = code;
  reason.statusCode = statusCode;
  return reason;
}

function freshLayer() {
  const identity = {
    companyId: COMPANY_ID,
    companyName: "실수집 런타임 숙소",
    regions: ["경상남도 창녕군"],
    tenantCompanyIds: [TENANT_ID],
    synthetic: false,
    dataMode: "live"
  };
  const safe = {
    companyId: COMPANY_ID,
    companyName: "실수집 런타임 숙소",
    name: "실수집 런타임 숙소",
    region: "경상남도 창녕군",
    synthetic: false,
    dataMode: "live"
  };
  return {
    async getCompany(companyId) {
      if (companyId !== COMPANY_ID) throw error("company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      return structuredClone(identity);
    },
    async getBusinessSafeCompany(companyId, tenantCompanyId) {
      if (companyId !== COMPANY_ID) throw error("company not found", "FRESH_COMPANY_NOT_FOUND", 404);
      if (tenantCompanyId !== TENANT_ID) throw error("tenant mismatch", "FRESH_TENANT_FORBIDDEN", 403);
      return structuredClone(safe);
    },
    async listCompanies() { return [structuredClone(identity)]; },
    async listObservations() { return []; },
    async listRuns() { return []; }
  };
}

function signal(kind, index, input) {
  return {
    kind,
    index,
    observedAt: "2026-07-30T01:00:00.000Z",
    sourceUrl: kind.startsWith("tourism.")
      ? "https://apis.data.go.kr/B551011/DataLabService/metcoRegnVisitrDDList"
      : "https://openapi.naver.com/v1/datalab/search",
    providerRequestId: `${input.clientRequestId}-${kind}`,
    adapterVersion: "stage231-runtime-injected-v1"
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for connector runtime");
}

async function main() {
  const integrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage231-runtime-"));
  const freshRepository = freshLayer();
  let trendInvocations = 0;
  let failFirst = true;
  const adapters = {
    "naver-trend": {
      id: "naver-trend",
      kind: "real",
      async collect() { throw new Error("replaced below"); }
    },
    tourism: {
      id: "tourism",
      kind: "real",
      async collect(input) {
        return { externalNetworkCalls: 0, signals: [
          signal("tourism.visitors", 61, input),
          signal("tourism.resource-demand", 71, input),
          signal("tourism.diversity", 81, input)
        ] };
      }
    }
  };
  // Preserve the explicit timeout category without attaching request or credential data.
  adapters["naver-trend"].collect = async function collect(input) {
    trendInvocations += 1;
    if (failFirst) {
      failFirst = false;
      const reason = error("temporary timeout", "SIGNAL_PROVIDER_TIMEOUT", 504);
      reason.category = "timeout";
      reason.externalNetworkCalls = 0;
      throw reason;
    }
    return { externalNetworkCalls: 0, signals: [signal("trend.index", 72, input)] };
  };
  const runtime = createSignalConnectorRuntime({
    env: { NODE_ENV: "test", V2_INTEGRATION_DATA_DIR: integrationRoot },
    integrationRoot,
    authRuntime: {
      service: { assertRequestBoundary() {} },
      http: {
        requestContext() { return {}; },
        sessionForRequest() { return { accountId: "account_stage231_admin", account: { accountId: "account_stage231_admin", role: "admin" } }; }
      }
    },
    freshRepository,
    adapters,
    featureFlags: { naverTrendReal: true, tourismReal: true, scheduler: false },
    providerPolicyOverrides: {
      "naver-trend": { dailyCallCap: 100, monthlyCallCap: 1000, timeoutMs: 1000 },
      tourism: { dailyCallCap: 100, monthlyCallCap: 1000, timeoutMs: 1000 }
    },
    pumpStageBudget: 2,
    retryBaseMs: 10,
    retryMaximumMs: 20,
    send(response, statusCode, body) { response.statusCode = statusCode; response.body = body; },
    async parseBody(request) { return request.body || {}; }
  });

  try {
    await runtime.initialize();
    const initialCount = (await runtime.repository.listJobs()).length;
    await assert.rejects(
      runtime.submit({ clientRequestId: "signal_unknown_0001", providerId: "naver-trend", companyId: "cmp_missing", periodMonth: "2026-07" }),
      (reason) => reason.statusCode === 404
    );
    await assert.rejects(
      runtime.submit({ clientRequestId: "signal_tenant_0001", providerId: "naver-trend", companyId: COMPANY_ID, tenantCompanyId: "tenant_other", periodMonth: "2026-07" }),
      (reason) => reason.statusCode === 403
    );
    await assert.rejects(
      runtime.submit({ clientRequestId: "signal_forged_0001", providerId: "naver-trend", companyId: COMPANY_ID, periodMonth: "2026-07", dailyCallCap: 999999 }),
      (reason) => reason.code === "SIGNAL_CONNECTOR_POLICY_FIELDS_FORBIDDEN"
    );
    assert.equal((await runtime.repository.listJobs()).length, initialCount, "invalid targets and forged policy must mutate zero jobs");

    const httpResponse = {};
    const handled = await runtime.http.handle({
      method: "POST",
      headers: {},
      body: { clientRequestId: "signal_http_0001", providerId: "naver-trend", companyId: COMPANY_ID, periodMonth: "2026-07" }
    }, httpResponse, new URL("http://localhost/api/integration/connectors/jobs"));
    assert.equal(handled, true);
    assert.equal(httpResponse.statusCode, 202);
    assert.equal(JSON.stringify(httpResponse.body).includes(COMPANY_ID), false, "HTTP job projection must hide internal company identity");

    const submissions = [];
    for (let index = 0; index < 7; index += 1) {
      submissions.push(runtime.submit({
        clientRequestId: `signal_queue_${String(index).padStart(4, "0")}`,
        providerId: "naver-trend",
        companyId: COMPANY_ID,
        periodMonth: "2026-07"
      }));
    }
    submissions.push(runtime.submit({
      clientRequestId: "signal_tourism_0001",
      providerId: "tourism",
      companyId: COMPANY_ID,
      periodMonth: "2026-07"
    }));
    await Promise.all(submissions);
    await waitFor(async () => {
      const jobs = await runtime.repository.listJobs();
      return jobs.length === 9 && jobs.every((job) => job.status === "completed") ? jobs : null;
    });
    assert.ok(trendInvocations >= 8, "timeout job must retry automatically and queue must drain past the pump budget");
    const storedSignals = await runtime.repository.listSignals({ companyId: COMPANY_ID, synthetic: false });
    assert.equal(storedSignals.some((row) => row.kind === "trend.index"), true);
    assert.equal(storedSignals.filter((row) => row.kind.startsWith("tourism.")).length, 3);
    assert.equal(storedSignals.every((row) => row.synthetic === false && row.dataMode === "live"), true);

    const disabledProvider = { id: "", kind: "disabled", enabled: false, diagnostics: () => ({}) };
    const authService = { assertCompanyAccess() { return true; }, assertRecentReauthentication() { return true; } };
    const freshService = {
      async getCompany(_session, companyId, tenantCompanyId) { return freshRepository.getBusinessSafeCompany(companyId, tenantCompanyId || TENANT_ID); },
      async listCompanies() { return [await freshRepository.getBusinessSafeCompany(COMPANY_ID, TENANT_ID)]; }
    };
    const syntheticIntruder = { ...storedSignals[0], signalId: "signal_synthetic_intruder", synthetic: true, dataMode: "test-fixture" };
    const service = createInsightsService({
      repository: { async listSignals() { return []; } },
      provider: disabledProvider,
      freshRepository,
      freshService,
      authService,
      signalRepository: {
        async listSignals(filter) { return [...await runtime.repository.listSignals(filter), syntheticIntruder]; }
      },
      capabilities: { reliability: true, locationCard: true, businessReport: true },
      clock: () => Date.parse("2026-07-30T02:00:00.000Z")
    });
    const admin = { accountId: "account_stage231_admin", account: { accountId: "account_stage231_admin", role: "admin" }, memberships: [], reauthenticatedAt: "2026-07-30T01:59:00.000Z" };
    const inputs = await service.analysisInputs(admin, COMPANY_ID, TENANT_ID);
    assert.equal(inputs.signals.some((row) => row.signalId === syntheticIntruder.signalId), false, "production insights bridge must reject synthetic signals");
    assert.equal(new Set(inputs.signals.map((row) => row.signalId)).size, inputs.signals.length, "connector and insights signals must dedupe by signalId");
    const analysis = deriveLocationAnalysis({ observations: inputs.observations, signals: inputs.signals, asOf: "2026-07-30T02:00:00.000Z", forecastMonth: "2026-08" });
    assert.equal(analysis.dimensions.find((row) => row.key === "tourism").state, "ready", "completed connector tourism signals must affect Stage 229 canonical analysis");
    assert.equal(analysis.readiness.freshness.presentSignalKinds >= 4, true);

    const diagnostics = await runtime.repository.diagnostics();
    assert.equal(diagnostics.legacyRuntimeReads, 0);
    assert.equal(diagnostics.legacyRuntimeCopies, 0);
    assert.equal(diagnostics.migrationRows, 0);
    assert.equal(diagnostics.backfillRows, 0);
    assert.equal(diagnostics.dualWriteRows, 0);
    console.log("Stage 231 target scope, policy injection, automatic retry/queue drain and connector-to-insights read bridge tests passed");
  } finally {
    fs.rmSync(integrationRoot, { recursive: true, force: true });
  }
}

main().catch((reason) => {
  console.error(reason.stack || reason);
  process.exitCode = 1;
});
