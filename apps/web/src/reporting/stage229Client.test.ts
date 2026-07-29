import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveInsightLocationCardReview,
  normalizeStage229Workspace,
  publishInsightLocationCard,
  readStage229Workspace,
  requestInsightLocationCardChanges,
  submitInsightLocationCardReview,
  updateInsightLocationCardDraft,
  safeInsightText
} from "./stage229Client";

const readyForecast = {
  state: "ready",
  asOf: "2026-07-29T00:00:00.000Z",
  inputPeriod: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-28T00:00:00.000Z" },
  sampleCount: 3,
  minimumSampleCount: 3,
  interval: { low: 58.2, high: 74.8, display: "58.2~74.8점" },
  bookingPacePerDay: 2.4,
  confidence: "medium",
  missingReasons: []
};

const readyPayload = {
  metadata: {
    stage: 229,
    algorithmVersion: "v2-stage229-location-forecast-v1",
    generatedAt: "2026-07-29T00:00:00.000Z"
  },
  state: "ready",
  subject: { companyId: "cmp_subject_001", companyName: "신규 해변 숙소", regionLabel: "경남" },
  subjects: [
    { companyId: "cmp_subject_001", companyName: "신규 해변 숙소", regionLabel: "경남" },
    { companyId: "cmp_peer_002", companyName: "신규 산 숙소", regionLabel: "강원" }
  ],
  readiness: {
    state: "ready",
    sampleCount: 3,
    minimumSampleCount: 3,
    freshness: { observations: "fresh", signals: "fresh" },
    confidence: "medium",
    confidenceCauses: ["7개 지역 구조 차원 준비"],
    inputPeriod: { from: "2026-07-01", to: "2026-07-28" }
  },
  metrics: [{ id: "published", label: "공개 카드", value: "1", detail: "신규 관측 기준", tone: "success" }],
  locationCard: {
    cardId: "card_stage229_001",
    lifecycle: "reviewed",
    title: "신규 해변 숙소 입지카드",
    companyName: "신규 해변 숙소",
    regionLabel: "경남",
    summary: "반복 관측과 deterministic signal fixture 기반 요약",
    evidenceSummary: "입력 기간 내 신규 관측 9개와 신호 9개",
    analysis: {
      algorithmVersion: "v2-stage229-location-forecast-v1",
      dimensions: [
        { key: "tourism", label: "관광", state: "ready", score: 81.2 },
        { key: "industry", label: "산업", state: "ready", score: 67.5 },
        { key: "catchment", label: "생활권", state: "ready", score: 72.1 },
        { key: "accessibility", label: "접근성", state: "ready", score: 69.8 },
        { key: "interest", label: "관심도", state: "ready", score: 75.4 },
        { key: "ota", label: "OTA", state: "ready", score: 66.7 },
        { key: "leadtime", label: "리드타임", state: "ready", score: 70.1 }
      ],
      forecast: readyForecast,
      readiness: { confidence: "medium", confidenceCauses: ["고정 fixture backtest 통과"], freshness: { observations: "fresh", signals: "fresh" } }
    },
    allowedActions: ["publish"]
  },
  monthlyReport: {
    state: "ready",
    month: "2026-08",
    title: "2026년 8월 월간 리포트",
    summary: "신규 관측으로 생성한 business-safe 리포트",
    publishedAt: "2026-07-29T00:00:00.000Z",
    algorithmVersion: "v2-stage229-location-forecast-v1",
    forecast: readyForecast,
    cohort: { label: "익명 비교군", summary: "k=3 이상 비식별 집계", sampleCount: 3, minimumSampleCount: 3 }
  },
  reportScopes: [
    { scope: "national", label: "전국", state: "ready", displayValue: "68.2점", detail: "비식별 전국 집계" },
    { scope: "region", label: "지역", state: "ready", displayValue: "71.4점", detail: "비식별 지역 집계" },
    { scope: "own", label: "내 숙소", state: "ready", displayValue: "73.1점", detail: "내 숙소 신규 관측" },
    { scope: "cohort", label: "익명 비교군", state: "ready", displayValue: "69.8점", detail: "k=3 비교군" }
  ],
  locationCardPath: "/app/location",
  allowedActions: ["approve-review"],
  audit: [{ auditId: "audit_001", action: "reviewed", label: "검수 승인", detail: "공개 전 검수 완료", occurredAt: "2026-07-29T00:00:00.000Z" }]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stage 229 business-safe client", () => {
  it("normalizes backend aliases without recomputing server-authored forecast values", () => {
    const admin = normalizeStage229Workspace(readyPayload, "admin-location");
    expect(admin).toMatchObject({
      stage: 229,
      state: "ready",
      algorithmVersion: "v2-stage229-location-forecast-v1",
      dataBoundary: "fresh-integration-only",
      projection: "business-safe"
    });
    expect(admin.locationCard).toMatchObject({ lifecycle: "reviewed", confidenceLabel: "medium" });
    expect(admin.locationCard?.scores).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "living-area", label: "생활권", displayValue: "72.1" })
    ]));
    expect(admin.locationCard?.forecast).toMatchObject({
      state: "ready",
      asOfDate: "2026-07-29T00:00:00.000Z",
      interval: { displayValue: "58.2~74.8점" },
      bookingPace: { displayValue: "2.4" }
    });
    expect(admin.allowedActions).toContain("approve-review");
    expect(admin.subjects).toHaveLength(2);
  });

  it("keeps four report scopes and allows only the fixed report-to-location path", () => {
    const business = normalizeStage229Workspace({
      ...readyPayload,
      locationCard: { ...readyPayload.locationCard, lifecycle: "published", publishedAt: "2026-07-29T00:00:00.000Z" }
    }, "business-report");
    expect(business.monthlyReport?.scopes.map((scope) => scope.id)).toEqual(["national", "regional", "own", "anonymous-cohort"]);
    expect(business.monthlyReport?.locationCardPath).toBe("/app/location");
    expect(business.subject.companyId).toBe("");
    expect(business.subjects).toEqual([]);
    expect(business.audit).toEqual([]);

    const unsafe = normalizeStage229Workspace({
      ...readyPayload,
      locationCardPath: "https://provider.example.invalid/private",
      locationCard: { ...readyPayload.locationCard, lifecycle: "published", publishedAt: "2026-07-29T00:00:00.000Z" }
    }, "business-report");
    expect(unsafe.monthlyReport?.locationCardPath).toBe("/app/location");
  });

  it("suppresses drafts and downgrades incomplete ready forecasts", () => {
    const draft = normalizeStage229Workspace(readyPayload, "business-location");
    expect(draft.state).toBe("not-published");
    expect(draft.locationCard).toBeNull();

    const insufficient = normalizeStage229Workspace({
      ...readyPayload,
      locationCard: { ...readyPayload.locationCard, lifecycle: "published", forecast: { state: "ready", sampleCount: 1, minimumSampleCount: 3, value: 99 } },
      monthlyReport: { ...readyPayload.monthlyReport, forecast: { state: "ready", sampleCount: 1, minimumSampleCount: 3, value: 99 } }
    }, "business-report");
    expect(insufficient.state).toBe("insufficient-data");
    expect(insufficient.monthlyReport?.forecast.state).toBe("insufficient-data");
    expect(insufficient.monthlyReport?.forecast.interval).toBeNull();
    expect(insufficient.monthlyReport?.forecast.bookingPace).toBeNull();
  });

  it("drops path, URL, raw evidence, formula and peer identifier text", () => {
    expect(safeInsightText("C:\\Users\\USER\\private.json", "숨김")).toBe("숨김");
    expect(safeInsightText("https://provider.example.invalid/raw", "숨김")).toBe("숨김");
    expect(safeInsightText("sourceKey nav-123", "숨김")).toBe("숨김");
    const normalized = normalizeStage229Workspace({
      ...readyPayload,
      locationCard: {
        ...readyPayload.locationCard,
        summary: "/var/data/private.json",
        evidenceSummary: "evidenceId raw-001",
        rawEvidence: { sourceKey: "secret" },
        internalFormula: "peer company id cmp_peer_002"
      }
    }, "admin-location");
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toMatch(/(?:\\Users\\|\/var\/|provider\.example\.invalid|sourceKey|evidenceId|rawEvidence|internalFormula)/i);
  });

  it("adds only a validated admin companyId to the workspace query", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(readyPayload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await readStage229Workspace("admin-location", "cmp_subject_001");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/integration/insights/workspace?view=admin-location&companyId=cmp_subject_001", expect.any(Object));
    fetchMock.mockClear();
    await readStage229Workspace("business-report", "cmp_peer_002");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/integration/insights/workspace?view=business-report", expect.any(Object));
  });

  it("normalizes the exact backend workspace projection without exposing source internals", () => {
    const workspace = normalizeStage229Workspace({
      metadata: { algorithmVersion: "v2-stage229-location-forecast-v1", generatedAt: "2026-07-29T00:00:00.000Z" },
      view: "admin-location",
      state: "ready",
      companyId: "cmp_fresh_001",
      subjects: [{ companyId: "cmp_fresh_001", companyName: "새로 수집한 숙소", regionLabel: "강원" }],
      readiness: {
        state: "ready",
        sampleCount: 3,
        minimumSampleCount: 3,
        freshness: { observations: "fresh", signals: "fresh" },
        freshnessLabel: "최신성 충족",
        confidence: "medium",
        confidenceLabel: "보통",
        confidenceCauses: ["신규 완전 시계열 3개"],
        inputPeriod: { from: "2026-07-01", to: "2026-07-28" }
      },
      locationCard: {
        cardId: "card_fresh_001",
        companyId: "cmp_fresh_001",
        lifecycle: "published",
        version: 6,
        state: "ready",
        editorial: { headline: "새로 수집한 숙소 입지카드", summary: "신규 관측 기반 지역 구조 요약" },
        algorithmVersion: "v2-stage229-location-forecast-v1",
        dimensions: [
          { key: "tourism", label: "관광", state: "ready", score: 81 },
          { key: "catchment", label: "생활권", state: "ready", score: 72 }
        ],
        forecast: readyForecast,
        readiness: { state: "ready", freshness: { observations: "fresh", signals: "fresh" }, confidence: "medium" },
        evidence: {
          algorithmVersion: "v2-stage229-location-forecast-v1",
          inputRange: { from: "2026-07-01", to: "2026-07-28" },
          observationCount: 14,
          signalCount: 9,
          sourceBoundary: "fresh-integration-stage229-only"
        },
        allowedActions: []
      },
      monthlyReport: {
        lifecycle: "published",
        state: "ready",
        month: "2026-08",
        publishedAt: "2026-07-29T00:00:00.000Z",
        editorial: { headline: "8월 월간 리포트", summary: "신규 관측 네 범위 요약" },
        algorithmVersion: "v2-stage229-location-forecast-v1",
        scopes: [
          { scope: "national", label: "전국", state: "ready", sampleCount: 3, minimumSampleCount: 3, metrics: { averagePrice: 180000, soldRate: 55, otaExposureRate: 75 } },
          { scope: "region", label: "지역", state: "ready", sampleCount: 3, minimumSampleCount: 3, metrics: { averagePrice: 170000, soldRate: 57, otaExposureRate: 70 } },
          { scope: "own", label: "내 숙소", state: "ready", sampleCount: 1, minimumSampleCount: 1, metrics: { averagePrice: 190000, soldRate: 60, otaExposureRate: 80 } },
          { scope: "anonymous-cohort", label: "익명 비교군", state: "ready", sampleCount: 3, minimumSampleCount: 3, cohort: { region: "강원", category: "glamping", sizeBand: "small", priceBand: "standard", otaBand: "medium" }, metrics: { averagePrice: 175000, soldRate: 58, otaExposureRate: 72 } }
        ],
        forecast: readyForecast,
        locationCardPath: "/app/location"
      },
      allowedActions: [],
      audit: { count: 1, latest: [{ auditId: "audit_001", event: "location-card.published", at: "2026-07-29T00:00:00.000Z", actorRole: "admin" }] }
    }, "admin-location");

    expect(workspace.subject).toMatchObject({ companyId: "cmp_fresh_001", companyName: "새로 수집한 숙소" });
    expect(workspace.locationCard).toMatchObject({ version: 6, title: "새로 수집한 숙소 입지카드" });
    expect(workspace.locationCard?.evidenceSummary).toContain("관측 14건");
    expect(workspace.monthlyReport).toMatchObject({ title: "8월 월간 리포트" });
    expect(workspace.monthlyReport?.scopes).toHaveLength(4);
    expect(workspace.monthlyReport?.scopes[1]).toMatchObject({ id: "regional", displayValue: "평균가 170,000원" });
    expect(workspace.monthlyReport?.cohort).toMatchObject({ sampleCount: 3, minimumSampleCount: 3 });
    expect(workspace.audit[0]).toMatchObject({ action: "location-card.published", occurredAt: "2026-07-29T00:00:00.000Z" });
    expect(JSON.stringify(workspace)).not.toMatch(/sourceBoundary|fixtureVersion|observationIds|signalIds|rawPath|internalFormula/);
  });

  it("uses the draft resource, review decisions and expected versions for lifecycle mutations", async () => {
    const fetchMock = vi.fn(async (path: string | URL | Request, init?: RequestInit) => {
      if (String(path) === "/api/auth/csrf") {
        return new Response(JSON.stringify({ csrfToken: "csrf-stage229" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true, card: { cardId: "card_fresh_001", lifecycle: "draft" } }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateInsightLocationCardDraft("card_fresh_001", 1, "초안 생성", "requested");
    await updateInsightLocationCardDraft("card_fresh_001", 2, "초안 수정", "draft");
    await submitInsightLocationCardReview("card_fresh_001", 3, "검수 요청");
    await approveInsightLocationCardReview("card_fresh_001", 4, "검수 승인");
    await requestInsightLocationCardChanges("card_fresh_001", 5, "근거 보강");
    await publishInsightLocationCard("card_fresh_001", 6, "공개");

    const lifecycleCalls = fetchMock.mock.calls.filter(([path]) => String(path).startsWith("/api/integration/insights/location-cards/"));
    expect(lifecycleCalls.map(([, init]) => init?.method)).toEqual(["POST", "PATCH", "POST", "POST", "POST", "POST"]);
    expect(lifecycleCalls.slice(0, 2).map(([path]) => String(path))).toEqual([
      "/api/integration/insights/location-cards/card_fresh_001/draft",
      "/api/integration/insights/location-cards/card_fresh_001/draft"
    ]);
    expect(lifecycleCalls.slice(2, 5).map(([path]) => String(path))).toEqual(Array(3).fill("/api/integration/insights/location-cards/card_fresh_001/review"));
    expect(lifecycleCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { expectedVersion: 1, editorial: { note: "초안 생성" } },
      { expectedVersion: 2, editorial: { note: "초안 수정" } },
      { expectedVersion: 3, decision: "submit", reason: "검수 요청" },
      { expectedVersion: 4, decision: "approve", reason: "검수 승인" },
      { expectedVersion: 5, decision: "request-changes", reason: "근거 보강" },
      { expectedVersion: 6, note: "공개" }
    ]);
  });
});
