import { ApiError, apiRequest } from "../apiClient";

export type ExplorationDataState = "ready" | "partial" | "empty" | "not-collected" | "not-exposed" | "out-of-range";
export type ExplorationRouteId = "business-map" | "business-ranking" | "admin-map" | "admin-ranking";

export interface ExplorationMarker {
  companyRef: string;
  companyName: string;
  regionLabel: string;
  latitude: number;
  longitude: number;
  coordinateConfidence: "high" | "medium" | "low" | "unknown";
  freshness: string;
}

export interface ExplorationBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface ExplorationRankingRow {
  companyRef: string;
  position: number;
  companyName: string;
  regionLabel: string;
  observedRank: number | null;
  targetDate: string;
  channel: string;
  freshness: string;
}

export interface ExplorationPlatformRanking {
  channel: string;
  targetDate: string;
  rows: readonly ExplorationRankingRow[];
}

export interface ExplorationTimelinePoint {
  date: string;
  state: ExplorationDataState;
  averagePrice: number | null;
  totalStock: number | null;
  availableStock: number | null;
  reservationRate: number | null;
  reservationRateState: ExplorationDataState;
  bookingPacePerDay: number | null;
  bookingPaceState: ExplorationDataState;
  otaExposed: boolean | null;
}

export interface ExplorationWorkspace {
  state: ExplorationDataState;
  scopeLabel: string;
  live: boolean;
  sourceLabel: string;
  providerConfigured: boolean;
  collectionExecutionEnabled: boolean;
  accessMode: "collect-and-view" | "view-only" | "unavailable";
  providerLabel: string;
  providerDetail: string;
  map: {
    state: ExplorationDataState;
    markers: readonly ExplorationMarker[];
    bounds: ExplorationBounds | null;
    sourceAssetLabel: string;
  };
  ranking: {
    state: ExplorationDataState;
    conditionLabel: string;
    rows: readonly ExplorationRankingRow[];
    platforms: readonly ExplorationPlatformRanking[];
  };
  timeline: {
    state: ExplorationDataState;
    from: string;
    to: string;
    axisEveryDays: 7;
    subjectLabel: string;
    points: readonly ExplorationTimelinePoint[];
  };
}

type UnknownRecord = Record<string, unknown>;

const RAW_OR_URL_PATTERN = /(?:https?:\/\/|file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?:var|tmp|home|Users|outputs?|data|db)(?:[\\/]|$)|(?:sourceUrl|rawPath|evidenceId|tenantId))/i;
const PRIVATE_ID_PATTERN = /(?:^|\b)(?:tenant|company|cmp|account|membership)[_:-][A-Za-z0-9][A-Za-z0-9_.:-]{2,}/i;
const PUBLIC_COMPANY_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{2,127}$/;
const record = (value: unknown): UnknownRecord => value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function explorationSafeText(value: unknown, fallback = ""): string {
  const candidate = (typeof value === "string" || typeof value === "number" ? String(value) : "").trim();
  return candidate && !RAW_OR_URL_PATTERN.test(candidate) && !PRIVATE_ID_PATTERN.test(candidate) ? candidate : fallback;
}

export function normalizePublicCompanyRef(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!PUBLIC_COMPANY_REF_PATTERN.test(candidate)) return "";
  if (/^(?:cmp|tenant|account|membership)[_:-]/i.test(candidate)) return "";
  return candidate;
}

function companyRefFor(row: UnknownRecord): string {
  const selection = record(row.selection);
  return normalizePublicCompanyRef(
    row.companyRef
    ?? row.publicSelectionRef
    ?? row.selectionRef
    ?? row.publicRef
    ?? row.peerRef
    ?? selection.companyRef
    ?? selection.ref
  );
}

function explicitlySynthetic(value: UnknownRecord): boolean {
  const provenance = record(value.provenance);
  const mode = explorationSafeText(value.dataMode ?? provenance.dataMode).toLowerCase();
  return value.synthetic === true || provenance.synthetic === true || ["synthetic", "synthetic-test", "fixture", "mock"].includes(mode);
}

function liveRowAllowed(value: UnknownRecord, workspaceLive: boolean): boolean {
  if (!workspaceLive || explicitlySynthetic(value)) return false;
  const provenance = record(value.provenance);
  const mode = explorationSafeText(value.dataMode ?? provenance.dataMode).toLowerCase();
  return !mode || mode === "live" || mode === "real";
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.round(number) : null;
}

function safeDate(value: unknown): string {
  const candidate = explorationSafeText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

export function normalizeExplorationState(value: unknown, fallback: ExplorationDataState = "empty"): ExplorationDataState {
  const candidate = explorationSafeText(value).toLowerCase().replaceAll("_", "-");
  if (["ready", "partial", "empty", "not-collected", "not-exposed", "out-of-range"].includes(candidate)) {
    return candidate as ExplorationDataState;
  }
  if (candidate === "unavailable" || candidate === "missing") return "not-collected";
  if (candidate === "hidden" || candidate === "forbidden") return "not-exposed";
  return fallback;
}

function normalizeCoordinateConfidence(value: unknown): ExplorationMarker["coordinateConfidence"] {
  const candidate = explorationSafeText(value).toLowerCase();
  if (["high", "verified", "exact", "certain"].includes(candidate)) return "high";
  if (["medium", "estimated"].includes(candidate)) return "medium";
  if (["low", "approximate"].includes(candidate)) return "low";
  return "unknown";
}

function freshnessLabel(value: unknown): string {
  const freshness = record(value);
  if (Object.keys(freshness).length) {
    const state = explorationSafeText(freshness.state).toLowerCase();
    if (state === "fresh") return "24시간 이내";
    if (state === "current") return "7일 이내";
    if (state === "stale") return "7일 초과";
    return "freshness 미확인";
  }
  return explorationSafeText(value, "freshness 미확인");
}

function normalizeMarker(value: unknown): ExplorationMarker | null {
  const row = record(value);
  const latitude = finiteNumber(row.latitude);
  const longitude = finiteNumber(row.longitude);
  const companyName = explorationSafeText(row.companyName, "이름 비공개 업체");
  if (latitude === null || longitude === null || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    companyRef: companyRefFor(row),
    companyName,
    regionLabel: explorationSafeText(row.regionLabel, "지역 미확인"),
    latitude,
    longitude,
    coordinateConfidence: normalizeCoordinateConfidence(row.coordinateConfidence),
    freshness: freshnessLabel(row.freshness)
  };
}

function normalizeBounds(value: unknown, markers: readonly ExplorationMarker[]): ExplorationBounds | null {
  const raw = record(value);
  const north = finiteNumber(raw.north ?? raw.maxLatitude ?? raw.maxLat);
  const south = finiteNumber(raw.south ?? raw.minLatitude ?? raw.minLat);
  const east = finiteNumber(raw.east ?? raw.maxLongitude ?? raw.maxLng);
  const west = finiteNumber(raw.west ?? raw.minLongitude ?? raw.minLng);
  if (north !== null && south !== null && east !== null && west !== null && north > south && east > west) {
    return { north, south, east, west };
  }
  if (!markers.length) return null;
  const latitudes = markers.map((marker) => marker.latitude);
  const longitudes = markers.map((marker) => marker.longitude);
  const derived = {
    north: Math.max(...latitudes),
    south: Math.min(...latitudes),
    east: Math.max(...longitudes),
    west: Math.min(...longitudes)
  };
  if (derived.north === derived.south) { derived.north += 0.01; derived.south -= 0.01; }
  if (derived.east === derived.west) { derived.east += 0.01; derived.west -= 0.01; }
  return derived;
}

function sourceAssetLabel(value: unknown): string {
  const asset = record(value);
  if (Object.keys(asset).length) {
    const label = explorationSafeText(asset.label ?? asset.name, "승인된 정적 경계 자산");
    const version = explorationSafeText(asset.version);
    const license = explorationSafeText(asset.license);
    return [label, version, license].filter(Boolean).join(" · ");
  }
  const label = explorationSafeText(value);
  return label || "승인된 정적 경계 자산";
}

function normalizeRankingRow(value: unknown, index: number, fallbackTargetDate = "", fallbackChannel = ""): ExplorationRankingRow | null {
  const row = record(value);
  const explicitPosition = positiveInteger(row.position);
  const position = explicitPosition !== null && explicitPosition >= 1 ? explicitPosition : index + 1;
  const companyName = explorationSafeText(row.companyName);
  if (position === null || position < 1 || !companyName) return null;
  const observedRank = positiveInteger(row.observedRank ?? row.naverRank ?? row.rank);
  return {
    companyRef: companyRefFor(row),
    position,
    companyName,
    regionLabel: explorationSafeText(row.regionLabel, "지역 미확인"),
    observedRank: observedRank !== null && observedRank >= 1 ? observedRank : null,
    targetDate: safeDate(row.targetDate) || fallbackTargetDate,
    channel: explorationSafeText(row.channel) || fallbackChannel || "채널 미확인",
    freshness: freshnessLabel(row.freshness)
  };
}

function conditionLabel(value: unknown): string {
  const condition = record(value);
  if (!Object.keys(condition).length) return explorationSafeText(value, "V2 순위 조건");
  const metricLabel = explorationSafeText(condition.metric) === "profile.rank" ? "V2 네이버 노출 순위" : "";
  return [
    explorationSafeText(condition.label) || metricLabel,
    explorationSafeText(condition.regionLabel),
    safeDate(condition.targetDate),
    explorationSafeText(condition.channel)
  ].filter(Boolean).join(" · ") || "V2 순위 조건";
}

function normalizeTimelinePoint(value: unknown): ExplorationTimelinePoint | null {
  const row = record(value);
  const price = record(row.price);
  const totalStock = record(row.totalStock);
  const availableStock = record(row.availableStock);
  const reservationRate = record(row.reservationRate);
  const bookingPace = record(row.bookingPace);
  const ota = record(row.ota);
  const date = safeDate(row.date);
  if (!date) return null;
  return {
    date,
    state: normalizeExplorationState(row.state, "ready"),
    averagePrice: positiveInteger(row.averagePrice ?? price.value),
    totalStock: positiveInteger(typeof row.totalStock === "object" ? totalStock.value : row.totalStock),
    availableStock: positiveInteger(typeof row.availableStock === "object" ? availableStock.value : row.availableStock),
    reservationRate: finiteNumber(row.reservationRateValue ?? reservationRate.value),
    reservationRateState: normalizeExplorationState(reservationRate.state, Object.keys(reservationRate).length ? "not-exposed" : "not-collected"),
    bookingPacePerDay: finiteNumber(row.bookingPacePerDay ?? bookingPace.value),
    bookingPaceState: normalizeExplorationState(bookingPace.state, Object.keys(bookingPace).length ? "not-exposed" : "not-collected"),
    otaExposed: typeof row.otaExposed === "boolean" ? row.otaExposed : typeof ota.exposed === "boolean" ? ota.exposed : null
  };
}

function timelinePointIsLive(value: unknown, workspaceLive: boolean): boolean {
  const row = record(value);
  if (!liveRowAllowed(row, workspaceLive)) return false;
  return [row.price, row.totalStock, row.availableStock, row.reservationRate, row.bookingPace, row.ota]
    .map(record)
    .every((metric) => !Object.keys(metric).length || liveRowAllowed(metric, workspaceLive));
}

function normalizePlatformRankings(value: unknown, fallbackTargetDate: string, workspaceLive: boolean): ExplorationPlatformRanking[] {
  const output: ExplorationPlatformRanking[] = [];
  for (const item of list(value)) {
    const platform = record(item);
    if (!liveRowAllowed(platform, workspaceLive)) continue;
    const channel = explorationSafeText(platform.channel);
    const targetDate = safeDate(platform.targetDate) || fallbackTargetDate;
    const rows = list(platform.rows).filter((row) => liveRowAllowed(record(row), workspaceLive))
      .map((row, index) => normalizeRankingRow(row, index, targetDate, channel))
      .filter((row): row is ExplorationRankingRow => Boolean(row));
    if (channel && rows.length) output.push({ channel, targetDate, rows });
  }
  return output;
}

function rangeExceedsThirtyDays(from: string, to: string): boolean {
  if (!from || !to) return false;
  const fromTime = Date.parse(`${from}T00:00:00Z`);
  const toTime = Date.parse(`${to}T00:00:00Z`);
  return !Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime < fromTime || (toTime - fromTime) / 86_400_000 > 29;
}

function explicitLiveMetadata(metadata: UnknownRecord, exploration: UnknownRecord): boolean {
  const collection = record(metadata.collection);
  const explorationMetadata = record(metadata.exploration);
  const scope = record(exploration.scope);
  const providerMode = explorationSafeText(
    exploration.providerMode
    ?? exploration.dataMode
    ?? scope.dataMode
    ?? explorationMetadata.dataMode
    ?? metadata.providerMode
    ?? metadata.dataMode
    ?? collection.mode
  ).toLowerCase();
  const source = explorationSafeText(exploration.source ?? metadata.source).toLowerCase();
  const synthetic = exploration.synthetic ?? scope.synthetic ?? explorationMetadata.synthetic ?? metadata.synthetic;
  if (synthetic === true) return false;
  return providerMode === "live"
    || providerMode === "real"
    || source === "v2-live-fresh-collection"
    || (collection.enabled === true && collection.configured === true && explorationSafeText(collection.mode).toLowerCase() === "live");
}

function scopeLabel(value: unknown): string {
  const scope = record(value);
  if (Object.keys(scope).length) return explorationSafeText(scope.role).toLowerCase() === "admin" ? "전국 승인 공개 범위" : "내 업체 공개 범위";
  const candidate = explorationSafeText(value).toLowerCase();
  return /(?:national|admin)/.test(candidate) || candidate === "all" ? "전국 승인 공개 범위" : "내 업체 공개 범위";
}

export function normalizeExplorationWorkspace(value: unknown): ExplorationWorkspace {
  const envelope = record(value);
  const metadata = { ...record(envelope.metadata), ...record(record(envelope.exploration).metadata) };
  const exploration = Object.keys(record(envelope.exploration)).length ? record(envelope.exploration) : record(envelope.data);
  const live = explicitLiveMetadata(metadata, exploration);
  const rawMap = record(exploration.map);
  const rawMarkers = list(rawMap.markers);
  const liveMarkerInputs = live ? rawMarkers.filter((row) => liveRowAllowed(record(row), live)) : [];
  const markers = liveMarkerInputs.map(normalizeMarker).filter((marker): marker is ExplorationMarker => Boolean(marker));
  const rawRanking = record(exploration.ranking);
  const rankingCondition = record(rawRanking.condition);
  const fallbackTargetDate = safeDate(rankingCondition.targetDate);
  const fallbackChannel = explorationSafeText(rankingCondition.channel);
  const rawRankingRows = list(rawRanking.rows);
  const liveRankingInputs = live ? rawRankingRows.filter((row) => liveRowAllowed(record(row), live)) : [];
  const rows = liveRankingInputs.map((row, index) => normalizeRankingRow(row, index, fallbackTargetDate, fallbackChannel)).filter((row): row is ExplorationRankingRow => Boolean(row));
  const platforms = live ? normalizePlatformRankings(rawRanking.platforms, fallbackTargetDate, live) : [];
  const rawTimeline = record(exploration.timeline);
  const from = safeDate(rawTimeline.from);
  const to = safeDate(rawTimeline.to);
  const rawTimelinePoints = list(rawTimeline.points);
  const liveTimelineInputs = live ? rawTimelinePoints.filter((point) => timelinePointIsLive(point, live)) : [];
  const invalidTimelineRange = rangeExceedsThirtyDays(from, to) || Number(rawTimeline.axisEveryDays || 7) !== 7 || rawTimelinePoints.length > 30;
  const points = live && !invalidTimelineRange
    ? liveTimelineInputs.map(normalizeTimelinePoint).filter((point): point is ExplorationTimelinePoint => Boolean(point))
    : [];
  const collection = record(metadata.collection);
  const collectionMode = explorationSafeText(collection.mode ?? metadata.providerMode).toLowerCase();
  const providerConfigured = collection.configured === true && ["live", "real"].includes(collectionMode);
  const collectionExecutionEnabled = providerConfigured && collection.enabled === true;
  const accessMode: ExplorationWorkspace["accessMode"] = !live ? "unavailable" : collectionExecutionEnabled ? "collect-and-view" : "view-only";
  const providerLabel = accessMode === "collect-and-view" ? "실수집 연결" : accessMode === "view-only" ? "live history 보기 전용" : "실수집 미확인";
  const providerDetail = accessMode === "collect-and-view"
    ? "실제 provider 연결이 확인되어 신규 수집과 live history 조회가 가능합니다."
    : accessMode === "view-only"
      ? "저장된 live fresh 이력은 볼 수 있지만 실제 provider가 미연결 또는 실행 중지 상태입니다."
      : "실수집 provenance가 확인된 공개 결과가 없습니다.";
  const explicitState = normalizeExplorationState(exploration.state, "empty");
  const state = !live && explicitState === "ready" ? "not-exposed" : explicitState;
  const mapState = !live && normalizeExplorationState(rawMap.state, state) === "ready"
    ? "not-exposed"
    : rawMarkers.length > 0 && liveMarkerInputs.length === 0
      ? "not-exposed"
      : liveMarkerInputs.length > 0 && markers.length === 0
      ? "out-of-range"
      : normalizeExplorationState(rawMap.state, markers.length ? "ready" : state);
  const rankingState = !live && normalizeExplorationState(rawRanking.state, state) === "ready"
    ? "not-exposed"
    : rawRankingRows.length > 0 && liveRankingInputs.length === 0
      ? "not-exposed"
      : liveRankingInputs.length > 0 && rows.length === 0
        ? "not-exposed"
        : normalizeExplorationState(rawRanking.state, rows.length ? "ready" : state);
  const timelineState = invalidTimelineRange
    ? "out-of-range"
    : !live && normalizeExplorationState(rawTimeline.state, state) === "ready"
      ? "not-exposed"
      : rawTimelinePoints.length > 0 && liveTimelineInputs.length === 0
        ? "not-exposed"
        : liveTimelineInputs.length > 0 && points.length === 0
          ? "not-exposed"
          : normalizeExplorationState(rawTimeline.state, points.length ? "ready" : state);

  return {
    state,
    scopeLabel: scopeLabel(exploration.scope),
    live,
    sourceLabel: live ? "V2 신규 실수집" : "실수집 미확인",
    providerConfigured,
    collectionExecutionEnabled,
    accessMode,
    providerLabel,
    providerDetail,
    map: {
      state: mapState,
      markers,
      bounds: live ? normalizeBounds(rawMap.bounds, markers) : null,
      sourceAssetLabel: sourceAssetLabel(rawMap.sourceAsset)
    },
    ranking: {
      state: rankingState,
      conditionLabel: conditionLabel(rawRanking.condition),
      rows: [...rows].sort((left, right) => left.position - right.position),
      platforms
    },
    timeline: {
      state: timelineState,
      from,
      to,
      axisEveryDays: 7,
      subjectLabel: explorationSafeText(rawTimeline.subjectLabel ?? rawTimeline.companyName ?? record(rawTimeline.subject).companyName),
      points
    }
  };
}

export function explorationRequestPath(companyRef = ""): string {
  if (!companyRef) return "/api/integration/fresh/exploration";
  const safeRef = normalizePublicCompanyRef(companyRef);
  if (!safeRef) throw new Error("공개 업체 선택 참조가 올바르지 않습니다.");
  return `/api/integration/fresh/exploration?companyRef=${encodeURIComponent(safeRef)}`;
}

export async function readExplorationWorkspace(companyRefOrSignal: string | AbortSignal = "", signal?: AbortSignal): Promise<ExplorationWorkspace> {
  const companyRef = typeof companyRefOrSignal === "string" ? companyRefOrSignal : "";
  const requestSignal = typeof companyRefOrSignal === "string" ? signal : companyRefOrSignal;
  const payload = await apiRequest<unknown>(explorationRequestPath(companyRef), { signal: requestSignal, cache: "no-store" });
  return normalizeExplorationWorkspace(payload);
}

export function explorationFailureState(reason: unknown): "permission" | "unavailable" | "error" {
  if (reason instanceof ApiError && reason.status === 403) return "permission";
  if (reason instanceof ApiError && (reason.status === 404 || reason.status === 503)) return "unavailable";
  return "error";
}

export function isExplorationRoute(routeId: string): routeId is ExplorationRouteId {
  return ["business-map", "business-ranking", "admin-map", "admin-ranking"].includes(routeId);
}
