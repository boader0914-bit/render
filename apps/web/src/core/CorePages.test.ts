import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionPayload } from "../apiClient";
import { normalizeCoreWorkspace } from "./coreClient";
import {
  AdminCollectionPage,
  AdminSettingsPage,
  BusinessActivityPage,
  OnboardingPage,
  adminLodgingCollectionBlockReason,
  collectionPlanValidationError,
  defaultCollectionPlan
} from "./CorePages";

const businessSession: SessionPayload = {
  authenticated: true,
  username: "preview-business",
  role: "b2b",
  roleLabel: "사업자",
  companyId: "company-new-001"
};

const adminSession: SessionPayload = {
  authenticated: true,
  username: "preview-admin",
  role: "admin",
  roleLabel: "관리자"
};

function workspaceWithCollectionCapability(collection?: Record<string, unknown>) {
  return normalizeCoreWorkspace({
    metadata: {
      stage: 228,
      provisional: false,
      source: "synthetic-fresh-integration",
      dataBoundary: "fresh-integration-only",
      ...(collection ? { capabilities: { collection } } : {})
    },
    state: { kind: "ready" },
    tenant: { companyId: "company-new-001", companyName: "테스트 숙소" },
    companies: [{ companyId: "company-new-001", companyName: "테스트 숙소", regionLabel: "테스트 지역", status: "ready" }],
    jobs: [],
    history: [],
    interests: [],
    locationCardRequests: [],
    tourismRequests: [],
    connectors: {}
  }, "business-activity");
}

describe("V3 core collection capability UI", () => {
  const livePlan = {
    regionCode: "가평군",
    targetDate: "2026-08-01",
    checkIn: "2026-08-01",
    checkOut: "2026-08-31",
    rankingQuery: "가평 글램핑",
    collectionMode: "precision" as const,
    collectionPurpose: "revenue_detail" as const,
    productMode: "all" as const,
    detailRankRanges: "1-10",
    bookingRangePlaceLimit: 10
  };

  it("starts with the bounded official-search plan instead of silently opting into detail and OTA providers", () => {
    expect(defaultCollectionPlan()).toMatchObject({
      collectionMode: "fast",
      collectionPurpose: "basic_db",
      targetDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    });
  });

  it("does not gate lodging collection on the separate tourism connector", () => {
    const capability = workspaceWithCollectionCapability({
      providerMode: "real",
      executionEnabled: true,
      realProviderEnabled: true
    }).collectionCapability;

    expect(adminLodgingCollectionBlockReason(capability, "가평 실제 숙소", livePlan)).toBe("");
    expect(collectionPlanValidationError({ ...livePlan, checkOut: "2026-09-01" })).toBe("상세 수집 기간은 최대 31일입니다.");
    expect(collectionPlanValidationError({ ...livePlan, checkOut: "2026-07-31" })).toBe("상세 수집 종료일은 시작일보다 빠를 수 없습니다.");
  });

  it("labels synthetic results as test data and fails closed when capability is missing", () => {
    const workspace = workspaceWithCollectionCapability();
    const businessMarkup = renderToStaticMarkup(createElement(BusinessActivityPage, {
      workspace,
      session: businessSession,
      reload: async () => undefined
    }));
    const adminMarkup = renderToStaticMarkup(createElement(AdminCollectionPage, {
      workspace,
      session: adminSession,
      reload: async () => undefined
    }));
    const onboardingMarkup = renderToStaticMarkup(createElement(OnboardingPage, {
      workspace,
      session: businessSession,
      reload: async () => undefined
    }));

    expect(`${businessMarkup}${adminMarkup}${onboardingMarkup}`).toContain("테스트 데이터 · 합성 provider");
    expect(businessMarkup).toContain('data-testid="company-data-source"');
    expect(businessMarkup).toMatch(/<button[^>]*disabled=""[^>]*>실수집 미연결<\/button>/);
    expect(adminMarkup).toMatch(/<button[^>]*disabled=""[^>]*>실수집 미연결<\/button>/);
    expect(onboardingMarkup).toContain("실제 provider</span><strong>미연결");
    expect(`${businessMarkup}${adminMarkup}`).not.toContain("Stage 228 fresh store");
    expect(`${businessMarkup}${adminMarkup}`).not.toContain("합성 신규 수집");
  });

  it("keeps an explicitly enabled fixture action visibly test-only", () => {
    const workspace = workspaceWithCollectionCapability({
      providerMode: "fixture",
      executionEnabled: true,
      testExecutionEnabled: true
    });
    const markup = renderToStaticMarkup(createElement(AdminCollectionPage, {
      workspace,
      session: adminSession,
      reload: async () => undefined
    }));

    expect(markup).toContain("테스트 데이터 생성");
    expect(markup).toContain("테스트 전용 fixture 실행입니다. 실제 provider 수집이 아닙니다.");
    expect(markup).not.toContain("실제 수집 실행");
  });

  it("uses an actual-collection label only for an explicitly confirmed real provider", () => {
    const workspace = workspaceWithCollectionCapability({
      providerMode: "real",
      executionEnabled: true,
      realProviderEnabled: true
    });
    const markup = renderToStaticMarkup(createElement(AdminCollectionPage, {
      workspace,
      session: adminSession,
      reload: async () => undefined
    }));

    expect(markup).toContain("실제 수집 실행");
    expect(markup).toContain("실제 provider 연결과 실행 권한을 명시적으로 확인했습니다.");
    for (const label of ["승인 지역 코드·명", "수집 기준일", "상세 수집 시작일", "상세 수집 종료일", "순위 검색어", "수집 목적", "실행 방식", "상품 범위", "상세 순위 범위", "리드타임 업체 상한"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("관광 실수집 미연결");
    expect(markup).toContain("숙소 수집 provider와 관광 provider는 별도입니다.");
    expect(markup).not.toContain("테스트 데이터 생성");
  });

  it("keeps workspace-dependent settings free of the independently rendered MFA reset card", () => {
    const markup = renderToStaticMarkup(createElement(AdminSettingsPage, {
      workspace: workspaceWithCollectionCapability(),
      session: adminSession,
      reload: async () => undefined
    }));

    expect(markup).toContain('data-testid="connector-status"');
    expect(markup).not.toContain('data-testid="admin-mfa-reset"');
    expect(markup).not.toContain('data-testid="admin-mfa-reset-form"');
  });
});
