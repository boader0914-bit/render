import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyDetailPanel } from "./CompanyDetailPanel";
import {
  businessSafeDisplayText,
  normalizeCoreWorkspace,
  normalizeStage228CompanyDetail,
  type CoreCompany
} from "./coreClient";

const detailPayload = {
  state: "ready",
  completeness: {
    state: "complete",
    displayValue: "9 / 10",
    detail: "필수 공개 필드 9개 검증",
    verifiedFields: 9,
    totalFields: 10,
    missingFields: ["대표 전화"]
  },
  freshness: {
    state: "fresh",
    displayValue: "12시간 이내",
    detail: "최신 성공 관측 기준",
    observedAt: "2026-07-29T04:00:00.000Z",
    validUntil: "2026-07-30T04:00:00.000Z"
  },
  confidence: {
    state: "high",
    displayValue: "높음",
    detail: "독립 출처 교차 확인",
    basis: "예약 노출과 사업자 공개정보 일치"
  },
  provenance: {
    summary: "공개 웹과 승인된 신규 수집의 요약",
    sourceCount: 3,
    lastVerifiedAt: "2026-07-29T04:10:00.000Z",
    rawPath: "C:\\private\\raw.json"
  },
  verifiedValues: [
    { field: "averagePrice", label: "평균 가격", value: 178000, verified: true, verifiedAt: "2026-07-29T04:10:00.000Z" },
    { field: "unverified", label: "미검증 값", value: "표시 금지", verified: false },
    { field: "unsafe", label: "내부 파일", value: "/var/data/outputs/raw.json", verified: true },
    { field: "sourceUrl", label: "원본 URL", value: "https://provider.example.invalid/raw", verified: true }
  ],
  changes: [
    { changeId: "chg-1", fieldLabel: "평균 가격", previousValue: 169000, currentValue: 178000, changedAt: "2026-07-29T04:10:00.000Z" },
    { changeId: "chg-2", fieldLabel: "내부 근거", previousValue: "C:\\private\\before.json", currentValue: "/tmp/after.json", changedAt: "2026-07-29T04:11:00.000Z" }
  ],
  enrichment: {
    state: "recommended",
    ctaLabel: "대표 전화 보강 요청",
    detail: "승인된 신규 수집으로 누락 필드를 보강합니다.",
    missingFields: ["대표 전화"]
  },
  observations: {
    displayCount: "4회",
    repeatCount: 3,
    firstObservedAt: "2026-07-20T04:00:00.000Z",
    lastObservedAt: "2026-07-29T04:00:00.000Z",
    summary: "4회 중 3회에서 동일 업체 식별자가 확인되었습니다."
  },
  rawOutputPath: "/home/service/private.json"
};

describe("Stage 228 business-safe company detail contract", () => {
  it("whitelists expected detail fields, keeps server-authored values and removes raw paths", () => {
    const detail = normalizeStage228CompanyDetail(detailPayload);
    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      state: "ready",
      completeness: { displayValue: "9 / 10", verifiedFields: "9", totalFields: "10", missingFields: ["대표 전화"] },
      freshness: { displayValue: "12시간 이내", state: "fresh" },
      confidence: { displayValue: "높음", state: "high" },
      provenance: { sourceCount: "3" },
      observations: { displayCount: "4회", repeatCount: "3" }
    });
    expect(detail?.verifiedValues).toEqual([{
      field: "averagePrice",
      label: "평균 가격",
      value: "178000",
      verifiedAt: "2026-07-29T04:10:00.000Z"
    }]);
    expect(detail?.changes[1]).toMatchObject({ previousValue: "공개되지 않음", currentValue: "공개되지 않음" });
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toMatch(/(?:C:\\|\/var\/|\/tmp\/|\/home\/|outputs\/)/i);
    expect(serialized).not.toContain("rawOutputPath");
    expect(businessSafeDisplayText("/var/data/secret.json", "숨김")).toBe("숨김");
    expect(businessSafeDisplayText("outputs/private-result.json", "숨김")).toBe("숨김");
    expect(normalizeStage228CompanyDetail({ ...detailPayload, provenance: { summary: "https://provider.example.invalid/raw" } })?.provenance.summary).toBe("공개 가능한 출처 요약이 없습니다.");
    expect(normalizeStage228CompanyDetail({ ...detailPayload, observations: { ...detailPayload.observations, displayCount: 4 } })?.observations.displayCount).toBe("4회");
    expect(normalizeStage228CompanyDetail({ ...detailPayload, state: "empty" })?.state).toBe("empty");
  });

  it("attaches the small Stage 228 detail shape to fresh companies without manufacturing legacy values", () => {
    const workspace = normalizeCoreWorkspace({
      metadata: { source: "synthetic-fresh-collection" },
      state: { kind: "partial" },
      companies: [{ companyId: "syn_detail_001", companyName: "신규 업체", regionLabel: "강원", freshDetail: detailPayload }]
    }, "admin-companies");
    expect(workspace.companies).toHaveLength(1);
    expect(workspace.companies[0].freshDetail?.verifiedValues[0].value).toBe("178000");
    expect(workspace.companies[0].fields).toEqual([]);
    expect(normalizeStage228CompanyDetail(undefined)).toBeNull();

    const projected = normalizeCoreWorkspace({
      metadata: { stage: 228, provisional: false, source: "synthetic-fresh-integration", dataBoundary: "fresh-integration-only" },
      state: { kind: "partial" },
      companies: [{
        projection: "business-safe",
        sourceBoundary: "fresh-integration-only",
        companyId: "cmp_fresh_projection",
        name: "Store projection",
        collection: { observationCount: 4, modes: ["quick", "detail"], lastObservedAt: "2026-07-29T04:00:00.000Z" },
        verification: { status: "approved", reviewedAt: "2026-07-29T04:10:00.000Z" },
        dataQuality: {
          dataCompleteness: { score: 50, missingModes: ["ota", "leadtime"] },
          freshness: { state: "fresh", latestObservedAt: "2026-07-29T04:00:00.000Z", ageHours: 12 },
          confidence: { level: "medium", score: 60, verified: true },
          enrichmentCta: { required: true, action: "collect-ota", label: "데이터 보강 필요" }
        }
      }]
    }, "admin-companies");
    expect(projected).toMatchObject({
      stage: 228,
      provisional: false,
      source: "synthetic-fresh-integration",
      dataBoundary: "fresh-integration-only"
    });
    expect(projected.companies[0].freshDetail).toMatchObject({
      state: "partial",
      completeness: { displayValue: "50%", missingFields: ["ota", "leadtime"] },
      freshness: { displayValue: "fresh" },
      confidence: { displayValue: "60" },
      provenance: { summary: "fresh integration store에서 생성된 business-safe 요약" },
      observations: { displayCount: "4회" }
    });
    expect(projected.companies[0].freshDetail?.verifiedValues).toEqual([]);
    expect(projected.companies[0].freshDetail?.changes).toEqual([]);

    const nestedProjection = normalizeCoreWorkspace({
      metadata: { stage: 228, provisional: false, source: "synthetic-fresh-integration", dataBoundary: "fresh-integration-only" },
      state: { kind: "ready" },
      companies: [{ freshDetail: { ...detailPayload, companyId: "cmp_nested", name: "Nested safe company", region: "제주" } }]
    }, "business-activity");
    expect(nestedProjection.companies[0]).toMatchObject({ companyId: "cmp_nested", name: "Nested safe company", region: "제주", status: "ready" });
    expect(nestedProjection.companies[0].freshDetail?.verifiedValues[0].value).toBe("178000");
  });
});

describe("Stage 228 V3 company detail rendering", () => {
  const company: CoreCompany = {
    companyId: "syn_detail_001",
    name: "신규 업체",
    region: "강원",
    status: "fresh",
    freshDetail: normalizeStage228CompanyDetail(detailPayload)
  };

  it("shows the same safe detail for business and admin with role-appropriate enrichment links", () => {
    const business = renderToStaticMarkup(createElement(CompanyDetailPanel, { company, role: "business" }));
    const admin = renderToStaticMarkup(createElement(CompanyDetailPanel, { company, role: "admin" }));
    for (const markup of [business, admin]) {
      expect(markup).toContain('data-testid="company-detail-metrics"');
      expect(markup).toContain('data-testid="company-provenance-summary"');
      expect(markup).toContain('data-testid="company-verified-values"');
      expect(markup).toContain('data-testid="company-observation-summary"');
      expect(markup).toContain('data-testid="company-change-history"');
      expect(markup).toContain('data-testid="company-enrichment-cta"');
      expect(markup).toContain("178000");
      expect(markup).toContain("4회 중 3회");
      expect(markup).not.toMatch(/(?:C:\\|\/var\/|\/tmp\/|\/home\/|outputs\/)/i);
      expect(markup).not.toContain("provider.example.invalid");
    }
    expect(business).toContain("/app/activity?companyId=syn_detail_001");
    expect(admin).toContain("/admin/collection?companyId=syn_detail_001");
    expect(business).toContain('data-detail-role="business"');
    expect(admin).toContain('data-detail-role="admin"');
  });

  it("renders explicit empty, loading, error and partial states without fallback data", () => {
    const empty = renderToStaticMarkup(createElement(CompanyDetailPanel, { company: null, role: "business", state: "empty" }));
    const loading = renderToStaticMarkup(createElement(CompanyDetailPanel, { company: null, role: "business", state: "loading" }));
    const error = renderToStaticMarkup(createElement(CompanyDetailPanel, { company: null, role: "admin", state: "error", onRetry: vi.fn() }));
    const partial = renderToStaticMarkup(createElement(CompanyDetailPanel, {
      company: { ...company, freshDetail: { ...company.freshDetail!, state: "partial" } },
      role: "admin"
    }));
    const storeEmpty = renderToStaticMarkup(createElement(CompanyDetailPanel, {
      company: { ...company, freshDetail: { ...company.freshDetail!, state: "empty" } },
      role: "admin"
    }));
    expect(empty).toContain('data-detail-state="empty"');
    expect(loading).toContain('data-detail-state="loading"');
    expect(error).toContain('data-detail-state="error"');
    expect(error).toContain("다시 시도");
    expect(partial).toContain('data-detail-state="partial"');
    expect(partial).toContain("일부 필드가 비어 있습니다");
    expect(storeEmpty).toContain('data-detail-state="empty"');
  });
});
