import { describe, expect, it } from "vitest";
import { normalizeCoreWorkspace } from "./coreClient";

const metadata = {
  stage: 227,
  provisional: true,
  dataBoundary: "fresh-only",
  source: "synthetic-fresh-collection"
};

describe("Stage 227 compatibility client", () => {
  it("maps the backend workspace envelope without recomputing V2 business values", () => {
    const workspace = normalizeCoreWorkspace({
      metadata,
      view: "business-activity",
      state: { kind: "partial", message: "일부 필드 누락", partialCount: 1 },
      tenant: { companyId: "tenant-new-1", companyName: "신규 계정 업체" },
      metrics: {
        companyCount: 3,
        freshCompanyCount: 3,
        activeJobCount: 1,
        completedJobCount: 4,
        interestCount: 1,
        locationCardRequestCount: 2,
        tourismRequestCount: 0
      },
      companies: [{
        companyId: "syn-1",
        companyName: "합성 숙소",
        regionLabel: "합성 지역",
        status: "fresh",
        freshAt: "2026-07-01T00:00:00.000Z",
        businessValues: { naverRank: 3, averagePrice: 178000, soldOutRate: 0.625 }
      }],
      jobs: [{
        clientRequestId: "request-12345678",
        kind: "business-search",
        status: "running",
        keyword: "합성 검색",
        progress: 24,
        remainingSeconds: 90,
        estimatedCompleteAt: "2026-07-01T00:01:30.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
        resultSummary: { companyCount: 3 }
      }],
      history: [{ id: "h1", runLabel: "합성 run", regionLabel: "합성 지역", status: "completed", createdAt: "2026-07-01" }],
      interests: [{ companyId: "syn-1", company: { companyName: "합성 숙소", regionLabel: "합성 지역" }, createdAt: "2026-07-01" }],
      locationCardRequests: [{ clientRequestId: "loc-12345678", companyId: "syn-1", status: "queued", createdAt: "2026-07-01" }],
      tourismRequests: [],
      connectors: { traffic: { state: "not-configured", configured: false }, tourism: { state: "fixture-ready", configured: false } }
    }, "business-activity");

    expect(workspace.state).toBe("partial");
    expect(workspace.tenantCompanyId).toBe("tenant-new-1");
    expect(workspace.metrics.find((item) => item.id === "companyCount")?.value).toBe("3");
    expect(workspace.companies[0]).toMatchObject({ name: "합성 숙소", region: "합성 지역", freshnessLabel: "2026-07-01T00:00:00.000Z" });
    expect(workspace.companies[0].fields).toEqual(expect.arrayContaining([
      { label: "네이버 순위", value: "3" },
      { label: "평균 가격", value: "178000" },
      { label: "매진율", value: "0.625" }
    ]));
    expect(workspace.jobs[0]).toMatchObject({ progressLabel: "24%", etaLabel: "90초", resultCount: "3" });
    expect(workspace.jobs[0].resultValues).toContainEqual({ id: "companyCount", label: "업체 수", value: "3" });
    expect(workspace.interests[0]).toMatchObject({ name: "합성 숙소", region: "합성 지역" });
    expect(workspace.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "traffic", status: "disabled" }),
      expect.objectContaining({ id: "tourism", status: "ready", configured: false })
    ]));
  });

  it("keeps an empty response empty and never manufactures historical rows", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: { ...metadata, source: "empty" },
      state: { kind: "empty", message: "비어 있음" },
      metrics: { companyCount: 0, freshCompanyCount: 0, activeJobCount: 0 },
      companies: [],
      jobs: [],
      history: [],
      interests: [],
      connectors: {}
    }, "admin-overview");

    expect(workspace.state).toBe("empty");
    expect(workspace.source).toBe("empty");
    expect(workspace.companies).toEqual([]);
    expect(workspace.history).toEqual([]);
    expect(workspace.interests).toEqual([]);
  });
});
