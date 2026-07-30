import { describe, expect, it } from "vitest";
import { connectorJobPayload, normalizeConnectorStatus } from "./connectorClient";

describe("Stage 231 connector client", () => {
  it("projects only the business-safe admin operations contract", () => {
    const status = normalizeConnectorStatus({
      metadata: { stage: 231, dataBoundary: "fresh-only", adapterMode: "explicit-injection-only", fixtureAvailable: false, rawPath: "C:\\secret" },
      scheduler: { stopped: true, configured: false, operational: false, reason: "no-approved-adapter", actor: "internal" },
      providers: [{
        id: "naver-trend", label: "트렌드", signalKinds: ["trend.index"], state: "approval-required",
        rolloutRequested: false, adapterConfigured: false, operational: false, freshness: "not-collected",
        coverage: 0, successRate: null, jobs: 0, completed: 0, failed: 0,
        quota: { day: "2026-07-30", month: "2026-07", daily: { calls: 0, cost: 0 }, monthly: { calls: 0, cost: 0 }, externalNetworkCalls: 0 }
      }],
      jobs: [{
        clientRequestId: "signal-request-0001", providerId: "naver-trend", mode: "real", status: "queued",
        attempts: 0, maxAttempts: 3, target: { region: "경남", periodMonth: "2026-08", signalKinds: ["trend.index"], companyId: "cmp_internal" },
        quota: { callsPerRun: 1, dailyCallCap: 10, monthlyCallCap: 100, dailyCostCap: 0, monthlyCostCap: 0, currency: "KRW" },
        jobId: "internal-job-id", signature: "internal-signature"
      }],
      diagnostics: { externalNetworkCalls: 0, credentialReads: 0, legacyRuntimeReads: 0, legacyRuntimeCopies: 0 }
    });
    expect(status.metadata.stage).toBe(231);
    expect(status.providers[0].freshness).toBe("not-collected");
    expect(status.jobs[0].target.region).toBe("경남");
    expect(JSON.stringify(status)).not.toContain("cmp_internal");
    expect(JSON.stringify(status)).not.toContain("internal-job-id");
    expect(JSON.stringify(status)).not.toContain("C:\\secret");
  });

  it("fails closed for malformed operational values", () => {
    const status = normalizeConnectorStatus({ providers: [{ id: "sns", state: "ready", operational: "true" }], scheduler: {} });
    expect(status.providers[0].state).toBe("approval-required");
    expect(status.providers[0].operational).toBe(false);
    expect(status.scheduler.stopped).toBe(true);
  });

  it("submits only the server-approved target identity fields", () => {
    const payload = connectorJobPayload({
      clientRequestId: "signal_manual_0001",
      providerId: "naver-trend",
      companyId: "cmp_live_0001",
      periodMonth: "2026-07",
      dailyCallCap: 999999,
      tenantCompanyId: "forged-tenant",
      signalKinds: ["sns.mentions"]
    } as never);
    expect(Object.keys(payload).sort()).toEqual(["clientRequestId", "companyId", "periodMonth", "providerId"]);
    expect(JSON.stringify(payload)).not.toContain("forged-tenant");
    expect(JSON.stringify(payload)).not.toContain("dailyCallCap");
    expect(JSON.stringify(payload)).not.toContain("sns.mentions");
  });
});
