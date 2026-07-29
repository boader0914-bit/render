import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminLocationView, BusinessLocationView, BusinessReportView } from "./Stage229Pages";
import { normalizeStage229Workspace } from "./stage229Client";

const forecast = {
  state: "ready",
  asOf: "2026-07-29T00:00:00.000Z",
  inputPeriod: { from: "2026-07-01", to: "2026-07-28" },
  sampleCount: 3,
  minimumSampleCount: 3,
  interval: { display: "58.2~74.8점", low: 58.2, high: 74.8 },
  bookingPacePerDay: 2.4,
  confidence: "medium"
};

const payload = {
  metadata: { stage: 229, algorithmVersion: "v2-stage229-location-forecast-v1" },
  state: "ready",
  subject: { companyId: "cmp_owner_001", companyName: "신규 숙소", regionLabel: "경남" },
  subjects: [
    { companyId: "cmp_owner_001", companyName: "신규 숙소", regionLabel: "경남" },
    { companyId: "cmp_peer_002", companyName: "두 번째 신규 숙소", regionLabel: "강원" }
  ],
  readiness: {
    state: "ready",
    label: "공개 준비 완료",
    detail: "최소 반복 관측과 freshness 기준 충족",
    sampleCount: 3,
    minimumSampleCount: 3,
    freshness: { observations: "fresh", signals: "fresh" },
    confidence: "medium",
    confidenceCauses: ["신규 관측 3개 완전 시계열"]
  },
  locationCard: {
    cardId: "card_001",
    lifecycle: "published",
    title: "신규 숙소 입지카드",
    companyName: "신규 숙소",
    regionLabel: "경남",
    summary: "신규 관측 기반 지역 구조 요약",
    evidenceSummary: "입력 기간과 관측 수의 공개 요약",
    publishedAt: "2026-07-29",
    analysis: {
      algorithmVersion: "v2-stage229-location-forecast-v1",
      dimensions: [
        { key: "tourism", state: "ready", score: 81 },
        { key: "industry", state: "ready", score: 72 },
        { key: "catchment", state: "ready", score: 74 },
        { key: "accessibility", state: "ready", score: 69 },
        { key: "interest", state: "ready", score: 77 },
        { key: "ota", state: "ready", score: 68 },
        { key: "leadtime", state: "ready", score: 71 }
      ],
      forecast,
      readiness: { confidence: "medium", confidenceCauses: ["7개 차원 준비"], freshness: { observations: "fresh", signals: "fresh" } }
    }
  },
  monthlyReport: {
    state: "ready",
    month: "2026-08",
    title: "8월 월간 리포트",
    summary: "전국·지역·내 숙소·익명 비교군 신규 관측 요약",
    publishedAt: "2026-07-29",
    algorithmVersion: "v2-stage229-location-forecast-v1",
    locationCardPath: "/app/location",
    scopes: [
      { id: "national", label: "전국", state: "ready", value: "68점", detail: "전국 비식별 집계" },
      { id: "regional", label: "지역", state: "ready", value: "71점", detail: "지역 비식별 집계" },
      { id: "own", label: "내 숙소", state: "ready", value: "73점", detail: "내 숙소 신규 관측" },
      { id: "anonymous-cohort", label: "익명 비교군", state: "ready", value: "70점", detail: "k=3 익명 비교군" }
    ],
    cohort: { label: "익명 비교군", summary: "다른 업체 식별자를 제외한 k=3 집계", sampleCount: 3, minimumSampleCount: 3 },
    forecast
  },
  allowedActions: [],
  audit: []
};

describe("Stage 229 V3 reporting surfaces", () => {
  it("renders the published business report with four scopes and a safe location link", () => {
    const workspace = normalizeStage229Workspace(payload, "business-report");
    const markup = renderToStaticMarkup(createElement(BusinessReportView, { workspace }));
    expect(markup).toContain('data-testid="stage229-report-scopes"');
    expect((markup.match(/data-scope=/g) || [])).toHaveLength(4);
    expect(markup).toContain('data-testid="stage229-forecast"');
    expect(markup).toContain("58.2~74.8점");
    expect(markup).toContain('data-testid="stage229-report-location-link"');
    expect(markup).toContain('href="/app/location"');
    expect(markup).not.toContain('data-testid="stage230-report-strategy-link"');
    const enabledMarkup = renderToStaticMarkup(createElement(BusinessReportView, { workspace, strategyLinkEnabled: true }));
    expect(enabledMarkup).toContain('data-testid="stage230-report-strategy-link"');
    expect(enabledMarkup).toContain('href="/app/strategy"');
    expect(markup).not.toMatch(/cmp_(?:owner|peer)|card_001|sourceKey|evidenceId|internalFormula/i);
  });

  it("shows cold-start reasons without forecast or booking pace values", () => {
    const workspace = normalizeStage229Workspace({
      metadata: payload.metadata,
      state: "insufficient-data",
      readiness: {
        state: "insufficient-data",
        sampleCount: 1,
        minimumSampleCount: 3,
        missingReasons: ["D-14·D-7·D-1 완전 시계열이 2개 부족합니다."],
        nextCollectionCta: { label: "반복 관측 보강", path: "/app/activity" }
      },
      monthlyReport: {
        ...payload.monthlyReport,
        forecast: { state: "ready", value: 99, bookingPacePerDay: 99, sampleCount: 1, minimumSampleCount: 3 }
      }
    }, "business-report");
    const markup = renderToStaticMarkup(createElement(BusinessReportView, { workspace }));
    expect(markup).toContain('data-insight-state="insufficient-data"');
    expect(markup).toContain("데이터가 부족합니다");
    expect(markup).toContain("D-14·D-7·D-1");
    expect(markup).not.toContain("Booking pace");
    expect(markup).not.toContain(">99<");
  });

  it("shows only a published card to business users", () => {
    const published = normalizeStage229Workspace(payload, "business-location");
    const publishedMarkup = renderToStaticMarkup(createElement(BusinessLocationView, { workspace: published }));
    expect(publishedMarkup).toContain('data-testid="stage229-location-card"');
    expect((publishedMarkup.match(/data-score=/g) || [])).toHaveLength(7);
    expect(publishedMarkup).toContain("생활권");

    const draft = normalizeStage229Workspace({ ...payload, locationCard: { ...payload.locationCard, lifecycle: "draft" } }, "business-location");
    const draftMarkup = renderToStaticMarkup(createElement(BusinessLocationView, { workspace: draft }));
    expect(draftMarkup).toContain('data-insight-state="not-published"');
    expect(draftMarkup).not.toContain("신규 숙소 입지카드");
    expect(draftMarkup).not.toContain("draft");
  });

  it("renders reviewed lifecycle, indexed company labels and allowed admin actions without IDs in the DOM", () => {
    const workspace = normalizeStage229Workspace({
      ...payload,
      locationCard: { ...payload.locationCard, lifecycle: "reviewed", allowedActions: ["publish"] },
      allowedActions: ["publish"],
      audit: [{ id: "audit_001", action: "reviewed", label: "검수 승인", detail: "공개 전 검수", occurredAt: "2026-07-29" }]
    }, "admin-location");
    const markup = renderToStaticMarkup(createElement(AdminLocationView, { workspace, revisionNote: "검수 메모" }));
    expect(markup).toContain('data-testid="stage229-company-select"');
    expect(markup).toContain("두 번째 신규 숙소 · 강원");
    expect(markup).toContain("검수 승인");
    expect(markup).toContain(">공개<");
    expect(markup).not.toContain("이전 snapshot 복원");
    expect(markup).toContain('data-testid="stage229-audit"');
    expect(markup).not.toMatch(/cmp_(?:owner|peer)|card_001|audit_001/);
  });
});
