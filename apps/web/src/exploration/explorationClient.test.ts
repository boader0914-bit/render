import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explorationRequestPath,
  explorationSafeText,
  normalizeExplorationState,
  normalizeExplorationWorkspace,
  normalizePublicCompanyRef,
  readExplorationWorkspace
} from "./explorationClient";
import { liveExplorationPayload } from "./explorationTestFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live fresh exploration client", () => {
  it("normalizes map, V2 ranking and a bounded 30-day timeline without recomputing server values", () => {
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload());

    expect(workspace).toMatchObject({ state: "ready", live: true, sourceLabel: "V2 신규 실수집", scopeLabel: "전국 승인 공개 범위" });
    expect(workspace.map.markers).toHaveLength(3);
    expect(workspace.map.markers[1]).toMatchObject({ companyName: "숲속 스테이", coordinateConfidence: "medium" });
    expect(workspace.map.sourceAssetLabel).toBe("승인 행정경계 · 2026-01 · 공공누리");
    expect(workspace.ranking.rows.map((row) => row.position)).toEqual([1, 2]);
    expect(workspace.ranking.rows[0]).toMatchObject({ companyRef: "sel_owner_001", companyName: "해변 스테이", position: 1, observedRank: 7, targetDate: "2026-07-30" });
    expect(workspace.ranking.platforms).toHaveLength(1);
    expect(workspace.ranking.platforms[0]).toMatchObject({ channel: "naver", targetDate: "2026-07-30" });
    expect(workspace.timeline).toMatchObject({ state: "ready", from: "2026-07-01", to: "2026-07-30", axisEveryDays: 7 });
    expect(workspace.timeline.points).toHaveLength(30);
    expect(workspace.timeline.points[0].averagePrice).toBe(150000);
    expect(workspace.timeline.points[0]).toMatchObject({ reservationRate: 0.2, reservationRateState: "ready", bookingPacePerDay: null, bookingPaceState: "not-exposed" });
    expect(workspace.timeline.points[29]).toMatchObject({ bookingPacePerDay: 2.4, bookingPaceState: "ready" });
    expect(workspace).toMatchObject({ providerConfigured: true, collectionExecutionEnabled: true, accessMode: "collect-and-view" });
  });

  it("keeps the opaque public selection reference while dropping internal tenant identifiers", () => {
    const workspace = normalizeExplorationWorkspace({
      metadata: {
        providerMode: "disabled",
        exploration: { synthetic: false, dataMode: "live", windowDays: 30, axisEveryDays: 7 }
      },
      exploration: {
        state: "ready",
        scope: { role: "b2b", tenantCompanyId: "tenant_private", dataMode: "live", synthetic: false },
        map: {
          state: "ready",
          markers: [{ peerRef: "peer-001", companyName: "익명 비교 숙소", regionLabel: "강원", latitude: 37.7, longitude: 127.8, coordinateConfidence: "medium", freshness: { state: "fresh", observedAt: "2026-07-30T00:00:00.000Z" } }],
          sourceAsset: { source: "https://raw.example/map.json", version: "v1", license: "public" }
        },
        ranking: {
          state: "ready",
          condition: { metric: "profile.rank", targetDate: "2026-07-30", channel: "naver" },
          rows: [{ peerRef: "peer-001", companyName: "익명 비교 숙소", regionLabel: "강원", rank: 7, freshness: { state: "current" } }]
        },
        timeline: {
          state: "ready",
          from: "2026-07-01",
          to: "2026-07-01",
          axisEveryDays: 7,
          points: [{ date: "2026-07-01", state: "ready", price: { state: "ready", value: 179000 }, totalStock: { state: "ready", value: 8 }, availableStock: { state: "ready", value: 3 }, ota: { state: "ready", exposed: true } }]
        }
      }
    });

    expect(workspace).toMatchObject({ live: true, scopeLabel: "내 업체 공개 범위", providerConfigured: false, collectionExecutionEnabled: false, accessMode: "view-only" });
    expect(workspace.map.markers[0]).toMatchObject({ companyRef: "peer-001", companyName: "익명 비교 숙소", freshness: "24시간 이내" });
    expect(workspace.ranking.rows[0]).toMatchObject({ companyRef: "peer-001", position: 1, observedRank: 7, targetDate: "2026-07-30", channel: "naver", freshness: "7일 이내" });
    expect(workspace.timeline.points[0]).toMatchObject({ averagePrice: 179000, totalStock: 8, availableStock: 3, otaExposed: true });
    expect(JSON.stringify(workspace)).not.toMatch(/tenant_private|raw\.example/);
  });

  it("drops synthetic rows from a live envelope without contaminating live public surfaces", () => {
    const payload: any = liveExplorationPayload(2);
    payload.exploration.map.markers.push({ companyRef: "sel_fixture_999", companyName: "합성 지도 업체", regionLabel: "테스트", latitude: 36, longitude: 128, dataMode: "fixture" });
    payload.exploration.ranking.rows.push({ companyRef: "sel_fixture_999", companyName: "합성 순위 업체", position: 3, observedRank: 1, dataMode: "synthetic-test" });
    payload.exploration.ranking.platforms.push({ channel: "fixture", dataMode: "fixture", rows: [{ companyRef: "sel_fixture_999", companyName: "합성 플랫폼 업체", position: 1, observedRank: 1 }] });
    payload.exploration.timeline.points.push({ date: "2026-07-03", state: "ready", averagePrice: 1, totalStock: 1, availableStock: 1, otaExposed: true, provenance: { synthetic: true } });

    const workspace = normalizeExplorationWorkspace(payload);

    expect(workspace.map.state).toBe("ready");
    expect(workspace.ranking.state).toBe("ready");
    expect(workspace.timeline.state).toBe("ready");
    expect(workspace.map.markers.map((row) => row.companyName)).not.toContain("합성 지도 업체");
    expect(workspace.ranking.rows.map((row) => row.companyName)).not.toContain("합성 순위 업체");
    expect(workspace.ranking.platforms.map((row) => row.channel)).not.toContain("fixture");
    expect(workspace.timeline.points.map((point) => point.date)).toEqual(["2026-07-01", "2026-07-02"]);
  });

  it("marks a ready surface not-exposed when every row has fixture provenance", () => {
    const payload: any = liveExplorationPayload(1);
    payload.exploration.map.markers = payload.exploration.map.markers.map((row: object) => ({ ...row, dataMode: "fixture" }));
    const workspace = normalizeExplorationWorkspace(payload);

    expect(workspace.live).toBe(true);
    expect(workspace.map).toMatchObject({ state: "not-exposed", markers: [] });
  });

  it("fails closed and drops every row when live provenance is not explicit", () => {
    const payload = liveExplorationPayload();
    payload.metadata.source = "synthetic-test-data";
    payload.metadata.providerMode = "synthetic";
    payload.metadata.collection = { enabled: false, configured: true, mode: "synthetic" };
    const workspace = normalizeExplorationWorkspace(payload);

    expect(workspace).toMatchObject({ state: "not-exposed", live: false, sourceLabel: "실수집 미확인" });
    expect(workspace.map.markers).toEqual([]);
    expect(workspace.ranking.rows).toEqual([]);
    expect(workspace.timeline.points).toEqual([]);
  });

  it("distinguishes all public no-data states and rejects a timeline beyond the 30-day/7-day-axis contract", () => {
    for (const state of ["empty", "not-collected", "not-exposed", "out-of-range"] as const) {
      expect(normalizeExplorationState(state)).toBe(state);
    }
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload(31));
    expect(workspace.timeline.state).toBe("out-of-range");
    expect(workspace.timeline.points).toEqual([]);
  });

  it("redacts raw paths, URLs and private identifiers from display text", () => {
    expect(explorationSafeText("C:\\private\\map.geojson", "비공개")).toBe("비공개");
    expect(explorationSafeText("https://provider.example/raw", "비공개")).toBe("비공개");
    expect(explorationSafeText("tenant_private_001", "비공개")).toBe("비공개");
    expect(explorationSafeText("공개 지역명", "비공개")).toBe("공개 지역명");
    expect(normalizePublicCompanyRef("sel_public-01")).toBe("sel_public-01");
    expect(normalizePublicCompanyRef("cmp_private_01")).toBe("");
  });

  it("requests only the same-origin exploration endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/integration/fresh/exploration");
      return new Response(JSON.stringify(liveExplorationPayload()), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const workspace = await readExplorationWorkspace();
    expect(workspace.live).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requeries a selected company using only an encoded opaque companyRef", async () => {
    const selectedPayload: any = liveExplorationPayload(1);
    selectedPayload.exploration.timeline.subjectLabel = "선택 숙소";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/integration/fresh/exploration?companyRef=sel_peer~002");
      expect(String(input)).not.toContain("companyId");
      return new Response(JSON.stringify(selectedPayload), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const workspace = await readExplorationWorkspace("sel_peer~002");

    expect(explorationRequestPath("sel_peer~002")).toBe("/api/integration/fresh/exploration?companyRef=sel_peer~002");
    expect(workspace.timeline.subjectLabel).toBe("선택 숙소");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(() => explorationRequestPath("cmp_private_002")).toThrow(/공개 업체 선택 참조/);
  });
});
