import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { normalizeExplorationWorkspace } from "./explorationClient";
import {
  chartLineSegments,
  clusterSchematicMarkers,
  DataState,
  ExplorationTimeline,
  ExplorationToolbar,
  LoadState,
  MapPage,
  RankingPage,
  requestExplorationCompanyTimeline
} from "./ExplorationPages";
import { liveExplorationPayload } from "./explorationTestFixtures";
import { boundaryPathsFromGeoJson, MAP_BOUNDARY_ENDPOINT, projectMapCoordinate } from "./mapBoundary";

describe("V3 live fresh exploration surfaces", () => {
  it("renders an accessible administrative-boundary map shell and list without private IDs, raw paths or source URLs", () => {
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload());
    const markup = renderToStaticMarkup(createElement(MapPage, { workspace, admin: true }));

    expect(markup).toContain('data-testid="exploration-map-page"');
    expect(markup).toContain('data-testid="exploration-map"');
    expect(markup).toContain("전국 행정경계 지도");
    expect(markup).toContain("승인된 KOSTAT 행정경계");
    expect(markup).toContain('aria-label="지도 레이어와 필터"');
    expect(markup).toContain("좌표 신뢰도");
    expect(markup).toContain("전체 지역");
    expect(markup).toContain('data-map-layer="companies"');
    expect(markup).toContain('aria-label="3개 실수집 업체의 행정경계 위치"');
    expect(markup).toContain('data-map-boundary-state="loading"');
    expect(markup).toContain("승인 행정경계를 불러오는 중입니다.");
    expect((markup.match(/v2-schematic-map__marker/g) || [])).toHaveLength(3);
    expect(markup).toContain("승인 행정경계 · 2026-01 · 공공누리");
    expect(markup).not.toMatch(/cmp_(?:owner|peer)|sel_(?:owner|peer)|tenant_private|sourceUrl|rawPath|https:\/\//i);
  });

  it("projects Polygon and MultiPolygon rings through the exact marker projection", () => {
    const bounds = { west: 0, south: 0, east: 10, north: 10 };
    const geoJson = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [
              [[0, 10], [10, 10], [10, 0], [0, 10]],
              [[2, 8], [3, 8], [3, 7], [2, 8]]
            ]
          }
        },
        {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [[[1, 9], [2, 9], [2, 8], [1, 9]]],
              [[[8, 2], [9, 2], [9, 1], [8, 2]]]
            ]
          }
        }
      ]
    };

    expect(MAP_BOUNDARY_ENDPOINT).toBe("/api/integration/fresh/map-boundary/kostat-2013-v1");
    expect(projectMapCoordinate(5, 5, bounds)).toEqual({ x: 50, y: 50 });
    const paths = boundaryPathsFromGeoJson(geoJson, bounds);
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("M8.000 8.000 L92.000 8.000 L92.000 92.000");
    expect((paths[0].match(/ M|^M/g) || [])).toHaveLength(2);
    expect(paths.every((path) => path.endsWith(" Z"))).toBe(true);
    expect(boundaryPathsFromGeoJson({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [1, 1] } }] }, bounds)).toEqual([]);
  });

  it("clusters nearby schematic markers while keeping a distant marker separate", () => {
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload());
    const markers = [
      workspace.map.markers[0],
      { ...workspace.map.markers[1], latitude: workspace.map.markers[0].latitude + 0.01, longitude: workspace.map.markers[0].longitude + 0.01 },
      workspace.map.markers[2]
    ];

    const clusters = clusterSchematicMarkers(markers, workspace.map.bounds);

    expect(clusters.map((cluster) => cluster.markers.length).sort()).toEqual([1, 2]);
  });

  it("renders server-authored V2 ranking values without exposing company IDs", () => {
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload());
    const markup = renderToStaticMarkup(createElement(RankingPage, { workspace }));

    expect(markup).toContain('data-testid="exploration-ranking-page"');
    expect(markup).toContain('data-testid="exploration-ranking"');
    expect(markup).toContain("V2 네이버 노출 순위 · 2026-07-30 · naver");
    expect(markup.indexOf("해변 스테이")).toBeLessThan(markup.indexOf("숲속 스테이"));
    expect(markup).toContain('<strong class="v2-exploration-rank">1</strong>');
    expect(markup).toContain("관측 순위");
    expect(markup).toContain("7위");
    expect(markup).toContain("4위");
    expect(markup).toContain('data-testid="exploration-platform-ranking"');
    expect(markup).toContain("플랫폼별 동일 조건 순위");
    expect(markup).not.toMatch(/cmp_(?:owner|peer)|sel_(?:owner|peer)|tenant_private/i);
  });

  it("routes map and ranking selection through only a validated opaque reference", () => {
    const onSelect = vi.fn();

    expect(requestExplorationCompanyTimeline("sel_peer_002", "숲속 스테이", onSelect)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("sel_peer_002", "숲속 스테이");
    expect(requestExplorationCompanyTimeline("cmp_private_002", "비공개", onSelect)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("disables selected-company timeline actions when the server omits a public reference", () => {
    const payload: any = liveExplorationPayload();
    delete payload.exploration.ranking.rows[0].companyRef;
    delete payload.exploration.ranking.rows[1].companyRef;
    const workspace = normalizeExplorationWorkspace(payload);
    const markup = renderToStaticMarkup(createElement(RankingPage, { workspace, onSelectCompany: vi.fn() }));

    expect((markup.match(/<button[^>]*disabled=""[^>]*>30일 보기<\/button>/g) || [])).toHaveLength(2);
  });

  it("renders a 30-day graph with fixed seven-day ticks and an accessible value list", () => {
    const workspace = normalizeExplorationWorkspace(liveExplorationPayload());
    const markup = renderToStaticMarkup(createElement(RankingPage, { workspace }));

    expect(markup).toContain('data-testid="exploration-timeline"');
    expect(markup).toContain('data-axis-every-days="7"');
    expect((markup.match(/data-timeline-tick="7-day"/g) || [])).toHaveLength(5);
    expect(markup).toContain("30일 가격·재고·OTA 관측");
    expect(markup).toContain("30일 관측값 목록");
    expect(markup).toContain("2026-07-30");
    expect(markup).toContain("184,800원");
    expect(markup).toContain("Booking pace");
    expect(markup).toContain("2.40%p/일");
    expect(markup).toContain("예약률");
  });

  it("breaks price lines at partial and null observations instead of bridging gaps", () => {
    const payload: any = liveExplorationPayload(6);
    payload.exploration.timeline.points = [
      { date: "2026-07-01", state: "ready", averagePrice: 100000, totalStock: 10, availableStock: 5, otaExposed: true },
      { date: "2026-07-02", state: "ready", averagePrice: 110000, totalStock: 10, availableStock: 4, otaExposed: true },
      { date: "2026-07-03", state: "partial", averagePrice: 120000, totalStock: 10, availableStock: 3, otaExposed: true },
      { date: "2026-07-04", state: "ready", averagePrice: 130000, totalStock: 10, availableStock: 2, otaExposed: true },
      { date: "2026-07-05", state: "ready", averagePrice: null, totalStock: 10, availableStock: 1, otaExposed: true },
      { date: "2026-07-06", state: "ready", averagePrice: 140000, totalStock: 10, availableStock: 0, otaExposed: false }
    ];
    const workspace = normalizeExplorationWorkspace(payload);
    const segments = chartLineSegments(workspace.timeline.points, (point) => point.averagePrice);
    const markup = renderToStaticMarkup(createElement(ExplorationTimeline, { workspace }));

    expect(segments.map((segment) => segment.dots.length)).toEqual([2, 1, 1]);
    expect((markup.match(/data-series-segment="price"/g) || [])).toHaveLength(3);
    expect((markup.match(/<polyline class="v2-exploration-chart__price"/g) || [])).toHaveLength(1);
  });

  it("labels disabled-provider live history as view-only and keeps controls outside status announcements", () => {
    const payload: any = liveExplorationPayload();
    payload.metadata.providerMode = "disabled";
    payload.metadata.collection = { enabled: false, configured: false, mode: "disabled" };
    const workspace = normalizeExplorationWorkspace(payload);
    const markup = renderToStaticMarkup(createElement(ExplorationToolbar, { workspace, refreshing: false, onRefresh: vi.fn() }));
    const status = markup.match(/<span role="status"[\s\S]*?<\/span>/)?.[0] || "";

    expect(workspace).toMatchObject({ live: true, providerConfigured: false, accessMode: "view-only" });
    expect(markup).toContain("live history 보기 전용");
    expect(markup).toContain("실제 provider가 미연결 또는 실행 중지 상태");
    expect(status).not.toContain("<button");
    expect(markup).toMatch(/<\/span><div>[\s\S]*<button/);
  });

  it("keeps loading, error, empty, not-collected, not-exposed and out-of-range visually distinct", () => {
    const loading = renderToStaticMarkup(createElement(LoadState, { state: "loading" }));
    const error = renderToStaticMarkup(createElement(LoadState, { state: "error" }));
    const empty = renderToStaticMarkup(createElement(DataState, { state: "empty" }));
    const notCollected = renderToStaticMarkup(createElement(DataState, { state: "not-collected" }));
    const notExposed = renderToStaticMarkup(createElement(DataState, { state: "not-exposed" }));
    const outOfRange = renderToStaticMarkup(createElement(DataState, { state: "out-of-range" }));

    expect(loading).toContain('data-exploration-load-state="loading"');
    expect(error).toContain('data-exploration-load-state="error"');
    expect(empty).toContain('data-exploration-state="empty"');
    expect(notCollected).toContain("아직 실수집되지 않았습니다");
    expect(notExposed).toContain("현재 공개 범위가 아닙니다");
    expect(outOfRange).toContain("지원 범위를 벗어났습니다");
    expect(new Set([loading, error, empty, notCollected, notExposed, outOfRange]).size).toBe(6);
  });
});
