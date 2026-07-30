import { useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, MetricCard, StatusBadge } from "@glamping-datalab-v2/ui";
import type { SessionPayload } from "../apiClient";
import {
  isExplorationRoute,
  normalizePublicCompanyRef,
  type ExplorationBounds,
  type ExplorationDataState,
  type ExplorationMarker,
  type ExplorationTimelinePoint,
  type ExplorationWorkspace
} from "./explorationClient";
import { projectMapCoordinate, useMapBoundary } from "./mapBoundary";
import { useExploration, type ExplorationLoadState } from "./useExploration";

const DATA_STATE_COPY: Readonly<Record<Exclude<ExplorationDataState, "ready" | "partial">, { title: string; description: string }>> = Object.freeze({
  empty: { title: "조건에 맞는 공개 결과가 없습니다", description: "빈 결과를 과거 V2·Cluster 데이터로 채우지 않습니다. 조건을 확인하거나 신규 실수집을 기다려 주세요." },
  "not-collected": { title: "아직 실수집되지 않았습니다", description: "승인된 live fresh 관측이 생성되기 전까지 지도·순위·그래프 값을 표시하지 않습니다." },
  "not-exposed": { title: "현재 공개 범위가 아닙니다", description: "수집 여부와 별개로 검수·tenant·entitlement 공개 경계를 통과한 값만 표시합니다." },
  "out-of-range": { title: "지원 범위를 벗어났습니다", description: "승인된 좌표 경계와 최근 30일 기간 안에서 다시 확인해 주세요." }
});

const LOAD_STATE_COPY: Readonly<Record<Exclude<ExplorationLoadState, "ready">, { title: string; description: string }>> = Object.freeze({
  loading: { title: "live fresh 탐색 데이터를 확인하고 있습니다", description: "role-safe 공개 범위와 실수집 provenance를 함께 확인합니다." },
  permission: { title: "이 탐색 범위에 접근할 수 없습니다", description: "다른 tenant 또는 역할의 데이터는 server 403 경계에서 차단됩니다." },
  unavailable: { title: "탐색 기능을 사용할 수 없습니다", description: "통합 core flag와 fresh exploration API가 모두 준비된 환경에서만 열립니다." },
  error: { title: "탐색 데이터를 불러오지 못했습니다", description: "내부 오류나 원천 경로를 표시하지 않습니다. 잠시 후 다시 시도해 주세요." }
});

function DataSection({ title, description, actions, children, testId }: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return <section className="v2-data-section v2-exploration-section" data-testid={testId}>
    <header className="v2-section-header">
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="v2-section-actions">{actions}</div> : null}
    </header>
    {children}
  </section>;
}

export function DataState({ state }: { state: Exclude<ExplorationDataState, "ready" | "partial"> }) {
  const copy = DATA_STATE_COPY[state];
  return <div className="v2-exploration-state" data-exploration-state={state}>
    <EmptyState title={copy.title} description={copy.description} action={<StatusBadge tone="warning">{state}</StatusBadge>} />
  </div>;
}

export function LoadState({ state }: { state: Exclude<ExplorationLoadState, "ready"> }) {
  const copy = LOAD_STATE_COPY[state];
  return <div className="v2-exploration-state" data-exploration-load-state={state}>
    <EmptyState title={copy.title} description={copy.description} action={<StatusBadge tone={state === "loading" ? "info" : "warning"}>{state}</StatusBadge>} />
  </div>;
}

function confidenceLabel(value: ExplorationMarker["coordinateConfidence"]): string {
  return value === "high" ? "좌표 검증 높음" : value === "medium" ? "좌표 검증 보통" : value === "low" ? "좌표 검증 낮음" : "좌표 검증 대기";
}

function markerPosition(marker: ExplorationMarker, bounds: ExplorationBounds | null): { left: string; top: string } {
  if (!bounds) return { left: "50%", top: "50%" };
  const projected = projectMapCoordinate(marker.longitude, marker.latitude, bounds);
  return {
    left: `${projected.x}%`,
    top: `${projected.y}%`
  };
}

interface SchematicMarkerCluster {
  key: string;
  markers: readonly ExplorationMarker[];
  position: { left: string; top: string };
}

export function clusterSchematicMarkers(markers: readonly ExplorationMarker[], bounds: ExplorationBounds | null): readonly SchematicMarkerCluster[] {
  const groups = new Map<string, ExplorationMarker[]>();
  for (const marker of markers) {
    const position = markerPosition(marker, bounds);
    const x = Number.parseFloat(position.left);
    const y = Number.parseFloat(position.top);
    const key = `${Math.floor(x / 12)}:${Math.floor(y / 12)}`;
    groups.set(key, [...(groups.get(key) || []), marker]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const positions = rows.map((marker) => markerPosition(marker, bounds));
    const left = positions.reduce((sum, position) => sum + Number.parseFloat(position.left), 0) / positions.length;
    const top = positions.reduce((sum, position) => sum + Number.parseFloat(position.top), 0) / positions.length;
    return { key, markers: rows, position: { left: `${left}%`, top: `${top}%` } };
  });
}

type ExplorationSelectionHandler = (companyRef: string, companyLabel: string) => void;

export function requestExplorationCompanyTimeline(
  companyRef: string,
  companyLabel: string,
  onSelectCompany?: ExplorationSelectionHandler
): boolean {
  const safeRef = normalizePublicCompanyRef(companyRef);
  if (!safeRef || !onSelectCompany) return false;
  onSelectCompany(safeRef, companyLabel);
  return true;
}

export function ExplorationMap({ workspace, admin = false, selectionBusy = false, onSelectCompany }: {
  workspace: ExplorationWorkspace;
  admin?: boolean;
  selectionBusy?: boolean;
  onSelectCompany?: ExplorationSelectionHandler;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [layer, setLayer] = useState<"companies" | "confidence">("companies");
  const [region, setRegion] = useState("all");
  const [confidence, setConfidence] = useState("all");
  const regions = useMemo(() => [...new Set(workspace.map.markers.map((marker) => marker.regionLabel))].sort(), [workspace.map.markers]);
  const filteredMarkers = useMemo(() => workspace.map.markers.filter((marker) => (
    (region === "all" || marker.regionLabel === region)
    && (confidence === "all" || marker.coordinateConfidence === confidence)
  )), [confidence, region, workspace.map.markers]);
  const clusters = useMemo(() => clusterSchematicMarkers(filteredMarkers, workspace.map.bounds), [filteredMarkers, workspace.map.bounds]);
  const boundary = useMapBoundary(workspace.map.bounds);
  if (workspace.map.state !== "ready" && workspace.map.state !== "partial") return <DataState state={workspace.map.state} />;
  if (!workspace.map.markers.length) return <DataState state="empty" />;
  const selected = filteredMarkers[selectedIndex] || filteredMarkers[0] || null;
  const selectMarker = (marker: ExplorationMarker, index: number) => {
    setSelectedIndex(index);
    requestExplorationCompanyTimeline(marker.companyRef, marker.companyName, onSelectCompany);
  };
  return <>
    {workspace.map.state === "partial" ? <p className="v2-core-notice" data-tone="warning" role="status">일부 좌표만 승인 경계 안에서 표시합니다.</p> : null}
    <div className="v2-exploration-map-controls" aria-label="지도 레이어와 필터">
      <fieldset><legend>레이어</legend><div>
        <button type="button" aria-pressed={layer === "companies"} onClick={() => setLayer("companies")}>업체</button>
        <button type="button" aria-pressed={layer === "confidence"} onClick={() => setLayer("confidence")}>좌표 신뢰도</button>
      </div></fieldset>
      <label><span>지역</span><select value={region} onChange={(event) => { setRegion(event.target.value); setSelectedIndex(0); }}><option value="all">전체 지역</option>{regions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label><span>좌표 신뢰도</span><select value={confidence} onChange={(event) => { setConfidence(event.target.value); setSelectedIndex(0); }}><option value="all">전체</option><option value="high">높음</option><option value="medium">보통</option><option value="low">낮음</option><option value="unknown">검증 대기</option></select></label>
    </div>
    {!filteredMarkers.length ? <DataState state="empty" /> :
    <div className="v2-exploration-map-layout" data-testid="exploration-map">
      <figure className="v2-schematic-map">
        <figcaption>
          <strong>{admin ? "전국" : "내 공개 범위"} 행정경계 지도</strong>
          <span>승인된 KOSTAT 행정경계와 같은 좌표 투영으로 실수집 위치만 표시합니다.</span>
        </figcaption>
        {boundary.state !== "ready" ? <p
          className="v2-schematic-map__boundary-state"
          data-boundary-state={boundary.state}
          role={boundary.state === "error" ? "alert" : "status"}
        >{boundary.state === "loading"
          ? "승인 행정경계를 불러오는 중입니다."
          : "행정경계를 불러오지 못해 공개 좌표만 표시하는 부분 보기입니다."}</p> : null}
        <div
          className="v2-schematic-map__canvas"
          role="group"
          aria-label={`${filteredMarkers.length}개 실수집 업체의 행정경계 위치`}
          data-map-layer={layer}
          data-map-boundary-state={boundary.state}
        >
          {boundary.state === "ready" ? <svg
            className="v2-schematic-map__boundary"
            data-testid="exploration-map-boundary"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            role="img"
            aria-label="승인된 대한민국 시군구 행정경계"
          >
            {boundary.paths.map((path, index) => <path key={index} d={path} fillRule="evenodd" />)}
          </svg> : null}
          <span className="v2-schematic-map__north" aria-hidden="true">N</span>
          {clusters.map((cluster) => {
            const marker = cluster.markers[0];
            const markerIndex = filteredMarkers.indexOf(marker);
            const confidenceValue = cluster.markers.every((row) => row.coordinateConfidence === marker.coordinateConfidence) ? marker.coordinateConfidence : "mixed";
            return <button
            className="v2-schematic-map__marker"
            type="button"
            key={cluster.key}
            style={cluster.position}
            data-cluster-size={cluster.markers.length}
            data-coordinate-confidence={layer === "confidence" ? confidenceValue : undefined}
            aria-label={cluster.markers.length > 1 ? `${marker.regionLabel} 근접 업체 ${cluster.markers.length}개` : `${marker.companyName}, ${marker.regionLabel}, ${confidenceLabel(marker.coordinateConfidence)}`}
            aria-pressed={Boolean(selected && cluster.markers.includes(selected))}
            disabled={selectionBusy}
            onClick={() => selectMarker(marker, markerIndex)}
          ><span aria-hidden="true">{cluster.markers.length > 1 ? cluster.markers.length : markerIndex + 1}</span></button>;
          })}
        </div>
        <p className="v2-schematic-map__asset">경계 자산: {workspace.map.sourceAssetLabel}</p>
      </figure>
      <div className="v2-exploration-map-list" aria-label="지도 업체 목록">
        {selected ? <article className="v2-exploration-selected" aria-live="polite">
          <span>선택 업체</span><strong>{selected.companyName}</strong><p>{selected.regionLabel}</p>
          <div><StatusBadge tone={selected.coordinateConfidence === "high" ? "success" : "info"}>{confidenceLabel(selected.coordinateConfidence)}</StatusBadge><small>{selected.freshness}</small></div>
        </article> : null}
        <ol>
          {filteredMarkers.map((marker, index) => <li key={`${marker.companyName}-${marker.regionLabel}-${index}`}>
            <button type="button" aria-current={selected === marker ? "true" : undefined} disabled={selectionBusy} onClick={() => selectMarker(marker, index)}>
              <span>{index + 1}</span><span><strong>{marker.companyName}</strong><small>{marker.regionLabel} · {marker.freshness}</small></span>
            </button>
          </li>)}
        </ol>
      </div>
    </div>}
  </>;
}

function formatPrice(value: number | null): string {
  return value === null ? "미수집" : `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

function formatReservationRate(value: number | null, state: ExplorationDataState): string {
  if (state !== "ready" || value === null) return state === "not-exposed" ? "표본 부족" : "미수집";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBookingPace(value: number | null, state: ExplorationDataState): string {
  if (state !== "ready" || value === null) return state === "not-exposed" ? "D-14·D-7·D-1 부족" : "미수집";
  return `${value.toFixed(2)}%p/일`;
}

export interface ExplorationChartSegment {
  points: string;
  dots: readonly { x: number; y: number }[];
}

export function chartLineSegments(points: readonly ExplorationTimelinePoint[], value: (point: ExplorationTimelinePoint) => number | null): readonly ExplorationChartSegment[] {
  const rows = points.map((point, index) => ({ index, state: point.state, value: value(point) }));
  const validRows = rows.filter((row): row is { index: number; state: ExplorationDataState; value: number } => row.state === "ready" && row.value !== null && Number.isFinite(row.value));
  if (!validRows.length) return [];
  const values = validRows.map((row) => row.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const positioned = (row: { index: number; value: number }) => {
    const x = points.length === 1 ? 350 : 42 + (row.index / (points.length - 1)) * 616;
    const y = 205 - ((row.value - minimum) / Math.max(1, maximum - minimum)) * 145;
    return { x, y };
  };
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const row of rows) {
    if (row.state !== "ready" || row.value === null || !Number.isFinite(row.value)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(positioned({ index: row.index, value: row.value }));
  }
  if (current.length) segments.push(current);
  return segments.map((dots) => ({
    dots,
    points: dots.map((dot) => `${dot.x.toFixed(1)},${dot.y.toFixed(1)}`).join(" ")
  }));
}

export function ExplorationTimeline({ workspace, subjectLabel = "" }: { workspace: ExplorationWorkspace; subjectLabel?: string }) {
  const timeline = workspace.timeline;
  if (timeline.state !== "ready" && timeline.state !== "partial") return <DataState state={timeline.state} />;
  if (!timeline.points.length) return <DataState state="empty" />;
  const priceSegments = chartLineSegments(timeline.points, (point) => point.averagePrice);
  const availabilitySegments = chartLineSegments(timeline.points, (point) => (
    point.totalStock !== null && point.totalStock > 0 && point.availableStock !== null
      ? Math.round((point.availableStock / point.totalStock) * 100)
      : null
  ));
  const ticks = timeline.points.filter((_point, index) => index % timeline.axisEveryDays === 0);
  const latest = timeline.points[timeline.points.length - 1];
  return <DataSection
    title={`${subjectLabel || timeline.subjectLabel ? `${subjectLabel || timeline.subjectLabel} · ` : ""}30일 가격·재고·OTA 관측`}
    description={`${timeline.from || "시작일 미확인"} ~ ${timeline.to || "종료일 미확인"} · 7일 간격 축`}
    testId="exploration-timeline"
  >
    <div className="v2-exploration-timeline-summary">
      <div><span>최근 평균 가격</span><strong>{formatPrice(latest.averagePrice)}</strong></div>
      <div><span>최근 가용 재고</span><strong>{latest.availableStock === null || latest.totalStock === null ? "미수집" : `${latest.availableStock}/${latest.totalStock}`}</strong></div>
      <div><span>최근 예약률</span><strong>{formatReservationRate(latest.reservationRate, latest.reservationRateState)}</strong></div>
      <div><span>Booking pace</span><strong>{formatBookingPace(latest.bookingPacePerDay, latest.bookingPaceState)}</strong></div>
      <div><span>OTA 노출</span><strong>{latest.otaExposed === null ? "미수집" : latest.otaExposed ? "확인" : "미노출"}</strong></div>
    </div>
    <figure className="v2-exploration-chart" data-axis-every-days="7">
      <svg viewBox="0 0 700 250" role="img" aria-labelledby="exploration-chart-title exploration-chart-description" preserveAspectRatio="xMidYMid meet">
        <title id="exploration-chart-title">30일 가격과 가용 재고 추이</title>
        <desc id="exploration-chart-description">7일 간격 날짜 축으로 표시한 신규 실수집 가격과 가용 재고 비율입니다.</desc>
        {[60, 108, 156, 204].map((y) => <line key={y} className="v2-exploration-chart__grid" x1="42" x2="658" y1={y} y2={y} />)}
        {priceSegments.map((segment, index) => <g key={`price-${index}`} data-series-segment="price">
          {segment.dots.length > 1 ? <polyline className="v2-exploration-chart__price" points={segment.points} fill="none" /> : null}
          {segment.dots.map((dot, dotIndex) => <circle key={dotIndex} className="v2-exploration-chart__price-dot" cx={dot.x} cy={dot.y} r="4" />)}
        </g>)}
        {availabilitySegments.map((segment, index) => <g key={`stock-${index}`} data-series-segment="stock">
          {segment.dots.length > 1 ? <polyline className="v2-exploration-chart__stock" points={segment.points} fill="none" /> : null}
          {segment.dots.map((dot, dotIndex) => <circle key={dotIndex} className="v2-exploration-chart__stock-dot" cx={dot.x} cy={dot.y} r="4" />)}
        </g>)}
        {ticks.map((point, index) => {
          const sourceIndex = timeline.points.indexOf(point);
          const x = timeline.points.length === 1 ? 350 : 42 + (sourceIndex / (timeline.points.length - 1)) * 616;
          return <g key={`${point.date}-${index}`} data-timeline-tick="7-day"><line className="v2-exploration-chart__tick" x1={x} x2={x} y1="205" y2="213" /><text x={x} y="233" textAnchor="middle">{point.date.slice(5)}</text></g>;
        })}
      </svg>
      <figcaption><span><i data-series="price" />평균 가격</span><span><i data-series="stock" />가용 재고 비율</span></figcaption>
    </figure>
    <details className="v2-exploration-values">
      <summary>30일 관측값 목록</summary>
      <ol>{timeline.points.map((point) => <li key={point.date}>
        <strong>{point.date}</strong><span>상태 {point.state}</span><span>가격 {formatPrice(point.averagePrice)}</span><span>재고 {point.availableStock === null || point.totalStock === null ? "미수집" : `${point.availableStock}/${point.totalStock}`}</span><span>예약률 {formatReservationRate(point.reservationRate, point.reservationRateState)}</span><span>Booking pace {formatBookingPace(point.bookingPacePerDay, point.bookingPaceState)}</span><span>OTA {point.otaExposed === null ? "미수집" : point.otaExposed ? "노출" : "미노출"}</span>
      </li>)}</ol>
    </details>
  </DataSection>;
}

export function ExplorationRanking({ workspace, selectionBusy = false, onSelectCompany }: {
  workspace: ExplorationWorkspace;
  selectionBusy?: boolean;
  onSelectCompany?: ExplorationSelectionHandler;
}) {
  if (workspace.ranking.state !== "ready" && workspace.ranking.state !== "partial") return <DataState state={workspace.ranking.state} />;
  if (!workspace.ranking.rows.length) return <DataState state="empty" />;
  return <DataSection title="V2 규칙 업체 순위" description={workspace.ranking.conditionLabel} testId="exploration-ranking">
    {workspace.ranking.state === "partial" ? <p className="v2-core-notice" data-tone="warning" role="status">공개 가능한 관측만 포함한 일부 순위입니다.</p> : null}
    <ol className="v2-exploration-ranking-list">
      {workspace.ranking.rows.map((row, index) => <li key={`${row.position}-${row.companyName}-${index}`}>
        <strong className="v2-exploration-rank">{row.position}</strong>
        <div className="v2-exploration-rank-company"><strong>{row.companyName}</strong><span>{row.regionLabel}</span></div>
        <dl><div><dt>관측 순위</dt><dd>{row.observedRank === null ? "미수집" : `${row.observedRank}위`}</dd></div><div><dt>기준일</dt><dd>{row.targetDate || "미수집"}</dd></div><div><dt>채널</dt><dd>{row.channel}</dd></div></dl>
        <StatusBadge tone="info">{row.freshness}</StatusBadge>
        <Button variant="quiet" type="button" disabled={selectionBusy || !row.companyRef} onClick={() => requestExplorationCompanyTimeline(row.companyRef, row.companyName, onSelectCompany)}>30일 보기</Button>
      </li>)}
    </ol>
    <div className="v2-exploration-platforms" data-testid="exploration-platform-ranking">
      <h3>플랫폼별 동일 조건 순위</h3>
      {workspace.ranking.platforms.length ? workspace.ranking.platforms.map((platform) => <article key={`${platform.channel}-${platform.targetDate}`}>
        <header><strong>{platform.channel}</strong><span>{platform.targetDate}</span></header>
        <ol>{platform.rows.map((row) => <li key={`${platform.channel}-${row.companyRef || row.companyName}`}><span>{row.position}위</span><strong>{row.companyName}</strong><small>관측 {row.observedRank ?? "미수집"}위</small></li>)}</ol>
      </article>) : <p className="v2-inline-empty">동일 조건으로 비교 가능한 플랫폼 순위가 아직 없습니다.</p>}
    </div>
  </DataSection>;
}

function ExplorationMetrics({ workspace, surface }: { workspace: ExplorationWorkspace; surface: "map" | "ranking" }) {
  const values = surface === "map"
    ? [
      { label: "공개 마커", value: `${workspace.map.markers.length}개`, detail: "승인 좌표만", tone: "success" as const },
      { label: "높은 좌표 신뢰도", value: `${workspace.map.markers.filter((marker) => marker.coordinateConfidence === "high").length}개`, detail: "server 검증 값", tone: "info" as const },
      { label: "관측 기간", value: workspace.timeline.points.length ? `${workspace.timeline.points.length}일` : "미수집", detail: "최대 최근 30일", tone: "neutral" as const }
    ]
    : [
      { label: "공개 순위", value: `${workspace.ranking.rows.length}개`, detail: "V2 규칙 유지", tone: "success" as const },
      { label: "채널", value: `${new Set(workspace.ranking.rows.map((row) => row.channel)).size}개`, detail: "공개 채널 기준", tone: "info" as const },
      { label: "관측 기간", value: workspace.timeline.points.length ? `${workspace.timeline.points.length}일` : "미수집", detail: "최대 최근 30일", tone: "neutral" as const }
    ];
  return <div className="v2-metric-grid v2-exploration-metrics" aria-label="live fresh 탐색 지표">{values.map((metric) => <MetricCard key={metric.label} {...metric} />)}</div>;
}

export function MapPage({ workspace, admin = false, selectionBusy = false, timelineSubjectLabel = "", onSelectCompany }: {
  workspace: ExplorationWorkspace;
  admin?: boolean;
  selectionBusy?: boolean;
  timelineSubjectLabel?: string;
  onSelectCompany?: ExplorationSelectionHandler;
}) {
  return <div className="v2-exploration-page" data-testid="exploration-map-page" data-live={workspace.live ? "true" : "false"}>
    <ExplorationMetrics workspace={workspace} surface="map" />
    <DataSection title={admin ? "전국 live fresh 지도" : "지역 live fresh 지도"} description={`${workspace.scopeLabel} · ${workspace.providerLabel}`} testId="exploration-map-section">
      <ExplorationMap workspace={workspace} admin={admin} selectionBusy={selectionBusy} onSelectCompany={onSelectCompany} />
    </DataSection>
    <ExplorationTimeline workspace={workspace} subjectLabel={timelineSubjectLabel} />
  </div>;
}

export function RankingPage({ workspace, selectionBusy = false, timelineSubjectLabel = "", onSelectCompany }: {
  workspace: ExplorationWorkspace;
  selectionBusy?: boolean;
  timelineSubjectLabel?: string;
  onSelectCompany?: ExplorationSelectionHandler;
}) {
  return <div className="v2-exploration-page" data-testid="exploration-ranking-page" data-live={workspace.live ? "true" : "false"}>
    <ExplorationMetrics workspace={workspace} surface="ranking" />
    <ExplorationRanking workspace={workspace} selectionBusy={selectionBusy} onSelectCompany={onSelectCompany} />
    <ExplorationTimeline workspace={workspace} subjectLabel={timelineSubjectLabel} />
  </div>;
}

export function ExplorationToolbar({ workspace, refreshing, onRefresh }: {
  workspace: ExplorationWorkspace;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return <div className="v2-exploration-toolbar">
    <span role="status" aria-live="polite"><strong>{workspace.providerLabel}</strong><small>{workspace.providerDetail} · {workspace.scopeLabel}</small></span>
    <div><StatusBadge tone={workspace.accessMode === "collect-and-view" ? "success" : workspace.accessMode === "view-only" ? "info" : "warning"}>{workspace.accessMode}</StatusBadge><Button variant="secondary" type="button" disabled={refreshing} onClick={onRefresh}>{refreshing ? "확인 중" : "새로고침"}</Button></div>
  </div>;
}

export function ExplorationRoutePage({ routeId, session, enabled }: { routeId: string; session: SessionPayload; enabled: boolean }) {
  const { workspace, loadState, refreshing, reload } = useExploration(enabled);
  const [timelineSubjectLabel, setTimelineSubjectLabel] = useState("");
  const admin = session.role === "admin";
  const surface = useMemo(() => routeId.endsWith("map") ? "map" : "ranking", [routeId]);
  if (!isExplorationRoute(routeId)) return <LoadState state="unavailable" />;
  if (loadState !== "ready") return <LoadState state={loadState} />;
  if (!workspace) return <LoadState state="error" />;
  const selectCompany: ExplorationSelectionHandler = (companyRef, companyLabel) => {
    if (!companyRef || refreshing) return;
    setTimelineSubjectLabel(companyLabel);
    void reload(companyRef);
  };
  return <>
    <ExplorationToolbar workspace={workspace} refreshing={refreshing} onRefresh={() => void reload()} />
    {workspace.state !== "ready" && workspace.state !== "partial" ? <DataState state={workspace.state} /> : <>
    {workspace.state === "partial" ? <p className="v2-core-notice" data-tone="warning" role="status">일부 공개 데이터만 준비되었습니다. 결측을 0으로 바꾸지 않습니다.</p> : null}
    {surface === "map"
      ? <MapPage workspace={workspace} admin={admin} selectionBusy={refreshing} timelineSubjectLabel={timelineSubjectLabel} onSelectCompany={selectCompany} />
      : <RankingPage workspace={workspace} selectionBusy={refreshing} timelineSubjectLabel={timelineSubjectLabel} onSelectCompany={selectCompany} />}
    </>}
  </>;
}
