import { describe, expect, it } from "vitest";
import { coreJobRequestBody, normalizeCoreWorkspace } from "./coreClient";

const metadata = {
  stage: 227,
  provisional: true,
  dataBoundary: "fresh-only",
  source: "synthetic-fresh-collection"
};

describe("Stage 227 compatibility client", () => {
  it("sends the complete V2 collection scope required by live approval", () => {
    expect(coreJobRequestBody({
      clientRequestId: "live-request-0001",
      kind: "business-search",
      keyword: "가평 실제 숙소",
      companyId: "tenant-live-001",
      regionCode: "가평군",
      regionLabel: "가평군",
      targetDate: "2026-08-01",
      checkIn: "2026-08-01",
      checkOut: "2026-08-07",
      discoveryQuery: "가평 실제 숙소",
      rankingQuery: "가평 글램핑",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      detailRankRanges: "1-10",
      bookingRangePlaceLimit: 10
    })).toEqual({
      clientRequestId: "live-request-0001",
      kind: "business-search",
      keyword: "가평 실제 숙소",
      tenantCompanyId: "tenant-live-001",
      regionCode: "가평군",
      regionLabel: "가평군",
      targetDate: "2026-08-01",
      checkIn: "2026-08-01",
      checkOut: "2026-08-07",
      discoveryQuery: "가평 실제 숙소",
      rankingQuery: "가평 글램핑",
      collectionMode: "precision",
      collectionPurpose: "revenue_detail",
      productMode: "all",
      detailRankRanges: "1-10",
      bookingRangePlaceLimit: 10
    });
  });

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
    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "unavailable",
      executionEnabled: false,
      realProviderEnabled: false,
      sourceLabel: "테스트 데이터 · fixture",
      actionLabel: "실수집 미연결"
    });
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
    expect(workspace.collectionCapability).toMatchObject({ providerMode: "unavailable", executionEnabled: false, sourceLabel: "실수집 미연결" });
  });

  it("enables only an explicitly confirmed real provider capability", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: {
        ...metadata,
        source: "empty",
        capabilities: {
          collection: {
            providerMode: "real",
            executionEnabled: true,
            realProviderEnabled: true
          }
        }
      },
      state: { kind: "empty" }
    }, "admin-collection");

    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "real",
      executionEnabled: true,
      realProviderEnabled: true,
      testExecutionEnabled: false,
      sourceLabel: "실제 수집 연결 · 데이터 대기",
      actionLabel: "실제 수집 실행"
    });
  });

  it("accepts the additive Stage 228 collection capability without requiring old clients to send it", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: {
        stage: 228,
        source: "v2-live-fresh-collection",
        providerMode: "live",
        collection: {
          enabled: true,
          configured: true,
          mode: "live",
          reason: ""
        }
      },
      state: { kind: "ready" }
    }, "business-activity");

    expect(workspace.source).toBe("v2-live-fresh-collection");
    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "real",
      executionEnabled: true,
      realProviderEnabled: true,
      sourceLabel: "V2 신규 실수집",
      actionLabel: "실제 수집 실행"
    });
  });

  it("uses the server reason while keeping a configured synthetic provider fail-closed", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: {
        stage: 228,
        source: "synthetic-test-data",
        providerMode: "synthetic",
        collection: {
          enabled: false,
          configured: true,
          mode: "synthetic",
          reason: "테스트 provider는 사용자 실수집에 사용할 수 없습니다."
        }
      },
      state: { kind: "empty" }
    }, "business-activity");

    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "unavailable",
      executionEnabled: false,
      sourceLabel: "테스트 데이터 · fixture",
      detail: "테스트 provider는 사용자 실수집에 사용할 수 없습니다."
    });
  });

  it("keeps explicit fixture execution visibly test-only", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: {
        ...metadata,
        capabilities: {
          collection: {
            providerMode: "fixture",
            executionEnabled: true,
            testExecutionEnabled: true
          }
        }
      }
    }, "business-activity");

    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "test",
      executionEnabled: true,
      realProviderEnabled: false,
      testExecutionEnabled: true,
      sourceLabel: "테스트 데이터 · fixture",
      actionLabel: "테스트 데이터 생성"
    });
  });

  it("fails closed when an incomplete capability claims a provider mode", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: {
        ...metadata,
        capabilities: { collection: { providerMode: "real", executionEnabled: true } }
      }
    }, "business-activity");

    expect(workspace.collectionCapability).toMatchObject({
      providerMode: "unavailable",
      executionEnabled: false,
      realProviderEnabled: false,
      actionLabel: "실수집 미연결"
    });
  });
});
