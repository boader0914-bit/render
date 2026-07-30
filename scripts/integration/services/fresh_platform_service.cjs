"use strict";

const crypto = require("node:crypto");
const { FRESH_KOREA_COORDINATE_BOUNDS, cleanText, deriveCompanyQuality } = require("../contracts/fresh_data.cjs");

const PROFILE_LABELS = Object.freeze({
  primaryName: "업체명",
  region: "지역",
  address: "주소",
  phone: "대표 전화",
  website: "웹사이트",
  notes: "검수 메모"
});

const FRESH_EXPLORATION_WINDOW_DAYS = 30;
const FRESH_EXPLORATION_MAX_COMPANIES = 250;
const FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY = 5_000;
const FRESH_EXPLORATION_READ_CONCURRENCY = 8;
const FRESH_EXPLORATION_SOURCE_ASSET = Object.freeze({
  source: "https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2013/json/skorea_municipalities_geo_simple.json",
  version: "KOSTAT-2013; WGS84; 1%-simplified",
  license: "KOSTAT: free to share or remix; upstream attribution retained",
  checksum: "sha256:1cd70bc95ec6ce5cbce1a98ea49fe7a81bdaada98a536b075f25c471e998aae8"
});
const FRESH_EXPLORATION_BOUNDS = FRESH_KOREA_COORDINATE_BOUNDS;
const TIMELINE_KINDS = new Set([
  "product.price",
  "product.total-stock",
  "product.available-stock",
  "ota.exposure"
]);
const BOOKING_PACE_REQUIRED_LEAD_DAYS = Object.freeze([14, 7, 1]);

const COLLECTION_CONNECTOR_LABELS = Object.freeze({
  "naver-search": "NAVER 업체 검색",
  "naver-booking": "NAVER 예약·재고",
  nol: "NOL OTA 노출",
  ddnayo: "떠나요 OTA 노출"
});

const COLLECTION_BLOCKER_LABELS = Object.freeze({
  "requested-stage-empty": "승인된 수집 단계가 없습니다.",
  "live-disabled": "실수집 실행 스위치가 꺼져 있습니다.",
  "approval-manifest-invalid": "승인 manifest가 없거나 올바르지 않습니다.",
  "approval-manifest-digest-invalid": "승인 manifest digest가 일치하지 않습니다.",
  "approval-not-active": "승인 시작 시각 전입니다.",
  "approval-expired": "승인 기간이 만료되었습니다.",
  "per-run-budget-manifest-mismatch": "run 요청 상한이 승인값과 다릅니다.",
  "daily-budget-manifest-mismatch": "일일 요청 상한이 승인값과 다릅니다.",
  "durable-quota-repository-required": "durable quota 저장소가 준비되지 않았습니다.",
  "seed-source-missing": "승인된 검색 source가 없습니다.",
  "transport-disabled": "실제 provider 전송기가 비활성 상태입니다.",
  "per-run-budget-disabled": "run 요청 상한이 0이어서 호출을 차단했습니다.",
  "daily-budget-disabled": "일일 요청 상한이 0이어서 호출을 차단했습니다.",
  "search-credentials-missing": "공식 검색 API 인증정보가 준비되지 않았습니다.",
  "naver-search-mode-disabled": "NAVER 검색 전송 모드가 꺼져 있습니다.",
  "naver-search-mode-invalid": "NAVER 검색 전송 모드가 올바르지 않습니다.",
  "naver-api-hub-credentials-missing": "NAVER API HUB 키가 준비되지 않았습니다.",
  "naver-api-hub-sort-invalid": "NAVER API HUB 정렬 기준이 올바르지 않습니다."
});

function safeCollectionBlockers(values = []) {
  const labels = (Array.isArray(values) ? values : [])
    .map((value) => cleanText(value, 120).toLowerCase())
    .filter((value) => /^[a-z0-9][a-z0-9:-]{0,119}$/.test(value))
    .map((value) => COLLECTION_BLOCKER_LABELS[value]
      || (value.startsWith("provider-kill-switch:") || value.startsWith("kill-switch-open:") ? "provider 중단 스위치가 켜져 있습니다."
          : value.startsWith("provider-not-approved:") || value.startsWith("provider-not-in-manifest:") ? "provider 승인 범위가 일치하지 않습니다."
            : value.startsWith("stage-not-approved:") ? "수집 단계가 승인 범위에 없습니다."
              : value.startsWith("hostname-allowlist-empty:") || value.startsWith("seed-source-invalid:") ? "provider 허용 호스트 설정이 올바르지 않습니다."
                : value.startsWith("endpoint-builder-missing:") ? "provider 요청 구성이 완성되지 않았습니다."
            : "실수집 승인 조건을 확인해야 합니다."));
  return [...new Set(labels)];
}

function publicCollectionConnectors(provider = {}, providerKind = "disabled", live = false) {
  const liveConfigured = providerKind === "live";
  const requiredProviders = new Set(Array.isArray(provider.requiredProviders) ? provider.requiredProviders.map(String) : []);
  const killSwitches = provider.killSwitches && typeof provider.killSwitches === "object" ? provider.killSwitches : {};
  const blockers = safeCollectionBlockers(provider.reasons);
  const rows = Object.entries(COLLECTION_CONNECTOR_LABELS).map(([id, label]) => {
    const configured = liveConfigured && requiredProviders.has(id);
    const stopped = killSwitches[id] !== false;
    const status = live && configured && !stopped ? "ready" : configured ? "approval-required" : "disabled";
    return {
      id,
      label,
      status,
      configured,
      detail: status === "ready"
        ? "승인 범위·quota·중단 스위치를 확인했습니다."
        : configured
          ? blockers[0] || "실수집 승인 조건을 모두 충족해야 합니다."
          : "현재 실행 계획에 구성되지 않았습니다."
    };
  });
  return [
    ...rows,
    { id: "tourism", label: "관광공사 관광 신호", status: "disabled", configured: false, detail: "별도 공식 API 승인과 인증키가 필요합니다." },
    { id: "search-volume", label: "검색량 신호", status: "disabled", configured: false, detail: "공식 connector 승인 전에는 호출하지 않습니다." },
    { id: "trend", label: "검색 트렌드 신호", status: "disabled", configured: false, detail: "공식 connector 승인 전에는 호출하지 않습니다." },
    { id: "sns", label: "SNS 관심도 신호", status: "disabled", configured: false, detail: "공식 connector 승인 전에는 호출하지 않습니다." }
  ];
}

function platformError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function roleFor(session) {
  return session?.account?.role === "admin" ? "admin" : "b2b";
}

function requireSession(session) {
  if (!session?.accountId || !session?.account) {
    throw platformError("로그인이 필요합니다.", 401, "FRESH_AUTH_REQUIRED");
  }
  return session;
}

function requireAdmin(session) {
  requireSession(session);
  if (roleFor(session) !== "admin") {
    throw platformError("관리자 권한이 필요합니다.", 403, "FRESH_ROLE_FORBIDDEN");
  }
}

function actorFor(session) {
  requireSession(session);
  return {
    type: "account",
    id: session.accountId,
    accountId: session.accountId,
    actorAccountId: session.accountId,
    role: roleFor(session),
    actorRole: roleFor(session)
  };
}

function safeScalar(value) {
  if (value === null || value === undefined || value === "") return "미입력";
  const text = cleanText(value, 320);
  if (/^(?:file:\/\/|[A-Za-z]:[\\/]|\/(?:var|tmp|home|Users|outputs?|data|db)(?:[\\/]|$)|\\\\)/i.test(text)) return "공개되지 않음";
  return text;
}

function livePublicText(value) {
  const text = safeScalar(value);
  if (!text || ["미입력", "공개되지 않음"].includes(text)) return "";
  if (/(?:https?:\/\/|sourceUrl|rawPath|evidenceId|tenantId)/i.test(text)) return "";
  return text;
}

function latestObservation(rows, kind) {
  return rows.filter((row) => (row.observationType || row.kind) === kind)
    .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null;
}

function observedValue(row) {
  if (!row) return null;
  const value = row.values ?? row.value;
  return value && typeof value === "object" && !Array.isArray(value) ? null : value;
}

function observationKind(row = {}) {
  return cleanText(row.observationType || row.kind, 80);
}

function isLiveFreshRecord(row = {}) {
  return row.synthetic === false && row.dataMode === "live";
}

function clockTimestamp(clock) {
  const value = clock();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function utcDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function addUtcDays(dateValue, days) {
  const timestamp = Date.parse(`${dateValue}T00:00:00.000Z`);
  return new Date(timestamp + Number(days || 0) * 86_400_000).toISOString().slice(0, 10);
}

function dateWindow(from, days = FRESH_EXPLORATION_WINDOW_DAYS) {
  return Array.from({ length: days }, (_, index) => addUtcDays(from, index));
}

function observationTimestamp(row = {}) {
  const source = row.row && typeof row.row === "object" ? row.row : row;
  const timestamp = Date.parse(source.observedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function latestRows(rows = [], keyFor) {
  const latest = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const current = latest.get(key);
    if (!current || observationTimestamp(row) > observationTimestamp(current)) latest.set(key, row);
  }
  return [...latest.values()];
}

function publicFreshness(observedAt, now) {
  const timestamp = Date.parse(observedAt || "");
  if (!Number.isFinite(timestamp)) return { state: "missing", observedAt: "" };
  const ageHours = Math.max(0, (now - timestamp) / 3_600_000);
  return {
    state: ageHours <= 24 ? "fresh" : ageHours <= 168 ? "current" : "stale",
    observedAt
  };
}

function coordinateFrom(row = {}) {
  const value = row.values ?? row.value ?? row;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const latitudeValue = value.latitude ?? value.lat;
  const longitudeValue = value.longitude ?? value.lng ?? value.lon;
  if (latitudeValue === null || latitudeValue === undefined || latitudeValue === ""
    || longitudeValue === null || longitudeValue === undefined || longitudeValue === "") return null;
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function coordinateInBounds(coordinate) {
  return Boolean(coordinate
    && coordinate.latitude >= FRESH_EXPLORATION_BOUNDS.south
    && coordinate.latitude <= FRESH_EXPLORATION_BOUNDS.north
    && coordinate.longitude >= FRESH_EXPLORATION_BOUNDS.west
    && coordinate.longitude <= FRESH_EXPLORATION_BOUNDS.east);
}

function coordinateConfidence(row = {}, projection = {}) {
  void projection;
  const provenance = row.provenance && typeof row.provenance === "object" ? row.provenance : {};
  const reviewStatus = cleanText(
    provenance.coordinateReviewStatus || provenance.coordinateVerificationStatus || provenance.reviewStatus,
    32
  ).toLowerCase();
  const explicitlyVerified = provenance.coordinateVerified === true || ["approved", "verified"].includes(reviewStatus);
  const candidate = cleanText(
    provenance.coordinateConfidence
      || provenance.geocodeConfidence
      || (explicitlyVerified ? "verified" : "")
      || "unverified",
    32
  ).toLowerCase();
  return ["verified", "certain", "high", "medium", "low", "review", "unverified"].includes(candidate)
    ? candidate
    : "unverified";
}

function searchConditionId(row = {}) {
  const provenance = row.provenance && typeof row.provenance === "object" ? row.provenance : {};
  const candidate = cleanText(
    row.searchConditionId
      || row.queryDigest
      || row.conditionHash
      || provenance.searchConditionId
      || provenance.queryDigest
      || provenance.searchQueryDigest
      || provenance.conditionHash,
    160
  );
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/.test(candidate) ? candidate : "";
}

function livePublicProjection(projection = {}, observations = []) {
  const nameObservation = latestObservation(observations, "profile.company-name");
  const regionObservation = latestObservation(observations, "profile.region");
  const categoryObservation = latestObservation(observations, "profile.category");
  const name = livePublicText(observedValue(nameObservation));
  const region = livePublicText(observedValue(regionObservation));
  if (!name || !region) return null;
  const category = livePublicText(observedValue(categoryObservation));
  const identitySource = livePublicText(nameObservation?.source || regionObservation?.source);
  return {
    ...projection,
    name,
    region,
    category,
    sourceLabel: identitySource ? "V2 신규 실수집" : "실수집 출처 미확인",
    synthetic: false,
    dataMode: "live"
  };
}

async function mapWithConcurrency(rows, concurrency, operation) {
  const output = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, rows.length)) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(rows[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function numericMetric(rows = [], kind, aggregation) {
  const typed = latestRows(
    rows.filter((row) => observationKind(row) === kind),
    (row) => `${row.companyId}|${row.channel}|${row.productKey}|${kind}`
  );
  if (!typed.length) {
    return { state: "not-collected", value: null, unit: kind === "product.price" ? "KRW" : "room", aggregation, sampleCount: 0 };
  }
  const values = typed.map(observedValue)
    .filter((value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!values.length) {
    return { state: "not-exposed", value: null, unit: kind === "product.price" ? "KRW" : "room", aggregation, sampleCount: 0 };
  }
  const value = aggregation === "mean"
    ? Math.round(values.reduce((sum, current) => sum + current, 0) / values.length)
    : values.reduce((sum, current) => sum + current, 0);
  return { state: "ready", value, unit: kind === "product.price" ? "KRW" : "room", aggregation, sampleCount: values.length };
}

function roundMetric(value, digits = 4) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

// Preserve the V2 reservation-rate meaning: sold inventory is total minus
// available inventory, and the rate is sold / total. A point is valid only
// when total and available were observed together for the same product,
// channel, target date and observed-at snapshot.
function pairedStockPoints(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const kind = observationKind(row);
    if (!["product.total-stock", "product.available-stock"].includes(kind)) continue;
    const key = [row.companyId, row.channel, row.productKey, row.targetDate, row.observedAt].join("|");
    const current = groups.get(key) || {
      companyId: row.companyId,
      channel: row.channel,
      productKey: row.productKey,
      targetDate: row.targetDate,
      observedAt: row.observedAt,
      total: null,
      available: null
    };
    const value = observedValue(row);
    const number = value === null || value === undefined || value === "" ? null : Number(value);
    if (kind === "product.total-stock") current.total = number;
    else current.available = number;
    groups.set(key, current);
  }
  return [...groups.values()].filter((row) => (
    Number.isFinite(row.total)
    && row.total > 0
    && Number.isFinite(row.available)
    && row.available >= 0
    && row.available <= row.total
    && /^\d{4}-\d{2}-\d{2}$/.test(String(row.targetDate || ""))
    && Number.isFinite(Date.parse(row.observedAt || ""))
  )).map((row) => ({
    ...row,
    sold: row.total - row.available,
    soldRate: roundMetric(((row.total - row.available) / row.total) * 100, 4),
    leadDays: Math.round((Date.parse(`${row.targetDate}T00:00:00.000Z`) - Date.parse(row.observedAt)) / 86_400_000)
  }));
}

function reservationMetric(stockPoints = []) {
  const latest = latestRows(stockPoints, (row) => `${row.companyId}|${row.channel}|${row.productKey}`);
  if (!latest.length) {
    return { state: "not-collected", value: null, unit: "ratio", soldStock: null, totalStock: null, sampleCount: 0 };
  }
  const totalStock = latest.reduce((sum, row) => sum + row.total, 0);
  const soldStock = latest.reduce((sum, row) => sum + row.sold, 0);
  if (!(totalStock > 0) || soldStock < 0 || soldStock > totalStock) {
    return { state: "not-exposed", value: null, unit: "ratio", soldStock: null, totalStock: null, sampleCount: latest.length };
  }
  return {
    state: "ready",
    value: roundMetric(soldStock / totalStock, 4),
    unit: "ratio",
    soldStock,
    totalStock,
    sampleCount: latest.length
  };
}

// Stage 229 froze booking pace as the D-14 to D-1 sold-rate change divided
// by 13 days. Require the same D-14/D-7/D-1 series before publishing a point;
// incomplete repeat observations stay explicitly not-exposed.
function bookingPaceMetric(stockPoints = []) {
  if (!stockPoints.length) {
    return {
      state: "not-collected",
      value: null,
      unit: "percentage-point-per-day",
      sampleCount: 0,
      requiredLeadDays: [...BOOKING_PACE_REQUIRED_LEAD_DAYS]
    };
  }
  const series = new Map();
  for (const point of stockPoints) {
    const key = `${point.companyId}|${point.channel}|${point.productKey}|${point.targetDate}`;
    if (!series.has(key)) series.set(key, []);
    series.get(key).push(point);
  }
  const complete = [];
  for (const points of series.values()) {
    const selected = {};
    for (const leadDay of BOOKING_PACE_REQUIRED_LEAD_DAYS) {
      selected[leadDay] = points
        .filter((row) => row.leadDays === leadDay)
        .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null;
    }
    if (BOOKING_PACE_REQUIRED_LEAD_DAYS.every((leadDay) => selected[leadDay])) {
      complete.push(roundMetric((selected[1].soldRate - selected[14].soldRate) / 13, 4));
    }
  }
  if (!complete.length) {
    return {
      state: "not-exposed",
      value: null,
      unit: "percentage-point-per-day",
      sampleCount: 0,
      requiredLeadDays: [...BOOKING_PACE_REQUIRED_LEAD_DAYS]
    };
  }
  return {
    state: "ready",
    value: roundMetric(complete.reduce((sum, value) => sum + value, 0) / complete.length, 2),
    unit: "percentage-point-per-day",
    sampleCount: complete.length,
    requiredLeadDays: [...BOOKING_PACE_REQUIRED_LEAD_DAYS]
  };
}

function otaMetric(rows = []) {
  const typed = latestRows(
    rows.filter((row) => observationKind(row) === "ota.exposure"),
    (row) => `${row.companyId}|${row.channel}|${row.productKey}|ota.exposure`
  );
  if (!typed.length) {
    return { state: "not-collected", exposed: null, exposedChannels: [], observedChannels: [], sampleCount: 0 };
  }
  const observedChannels = [...new Set(typed.map((row) => cleanText(row.channel, 80)).filter(Boolean))].sort();
  const exposedChannels = [...new Set(typed.filter((row) => observedValue(row) === true).map((row) => cleanText(row.channel, 80)).filter(Boolean))].sort();
  return {
    state: exposedChannels.length ? "ready" : "not-exposed",
    exposed: exposedChannels.length > 0,
    exposedChannels,
    observedChannels,
    sampleCount: typed.length
  };
}

function explorationCompanyRef(companyId) {
  const value = cleanText(companyId, 160);
  return value ? `company-ref-${crypto.createHash("sha256").update(`fresh-exploration:${value}`).digest("hex").slice(0, 24)}` : "";
}

function publicCompanyReference(projection = {}, role, selectedCompanyId, peerNumber) {
  return {
    ...(role === "admin" || projection.companyId === selectedCompanyId ? { companyId: projection.companyId } : {}),
    ...(role !== "admin" && projection.companyId !== selectedCompanyId ? { peerRef: `peer-${String(peerNumber).padStart(3, "0")}` } : {}),
    companyRef: explorationCompanyRef(projection.companyId),
    companyName: safeScalar(projection.name),
    regionLabel: safeScalar(projection.region)
  };
}

function explorationState(sections = []) {
  if (sections.every((state) => state === "ready")) return "ready";
  if (sections.some((state) => ["ready", "partial"].includes(state))) return "partial";
  if (sections.some((state) => state === "out-of-range")) return "out-of-range";
  if (sections.some((state) => state === "not-exposed")) return "not-exposed";
  return "not-collected";
}

function repeatObservationCount(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = [
      row.companyId,
      row.observationType || row.kind,
      row.targetDate,
      row.channel,
      row.productKey
    ].join("|");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
}

function verifiedChanges(auditRows, options = {}) {
  const permittedEvents = options.admin === true
    ? ["verified.approved", "verified.rejected", "coordinates.approved", "coordinates.rejected"]
    : ["verified.approved", "coordinates.approved"];
  return auditRows
    .filter((row) => permittedEvents.includes(row.event))
    .flatMap((row) => {
      if (["coordinates.approved", "coordinates.rejected"].includes(row.event)) {
        const before = row.details?.before?.approvedCoordinates || {};
        const after = row.details?.after?.candidate || row.details?.after?.approvedCoordinates || {};
        return [["latitude", "위도"], ["longitude", "경도"]]
          .filter(([field]) => safeScalar(before[field]) !== safeScalar(after[field]))
          .map(([field, fieldLabel]) => ({
            changeId: `${row.auditId || row.eventId || "change"}:${field}`,
            fieldLabel,
            previousValue: safeScalar(before[field]),
            currentValue: safeScalar(after[field]),
            changedAt: row.at || row.createdAt || row.occurredAt || ""
          }));
      }
      const before = row.details?.before?.profile || {};
      const after = row.details?.after?.profile || row.details?.after?.rejectedCandidate || {};
      return Object.keys(PROFILE_LABELS).filter((field) => safeScalar(before[field]) !== safeScalar(after[field])).map((field) => ({
        changeId: `${row.auditId || row.eventId || "change"}:${field}`,
        fieldLabel: PROFILE_LABELS[field],
        previousValue: safeScalar(before[field]),
        currentValue: safeScalar(after[field]),
        changedAt: row.at || row.createdAt || row.occurredAt || ""
      }));
    })
    .filter((row) => row.changedAt)
    .slice(-40)
    .reverse();
}

function createFreshPlatformService(options = {}) {
  const repository = options.repository;
  const collectionService = options.collectionService;
  const worker = options.worker;
  const authService = options.authService;
  const clock = options.clock || (() => Date.now());
  const allowSynthetic = options.allowSynthetic === true;
  const scheduleWork = typeof options.scheduleWork === "function" ? options.scheduleWork : (() => false);
  if (!repository || !collectionService || !worker || !authService) {
    throw new Error("Fresh platform service dependencies are required");
  }

  function notifyWorker(reason) {
    try {
      return scheduleWork(reason) !== false;
    } catch {
      // The run is already durable. A later bounded runtime pump or process
      // restart recovery can safely claim it without failing the HTTP mutation.
      return false;
    }
  }

  function metadata() {
    const workerDiagnostics = worker.diagnostics();
    const provider = workerDiagnostics.provider;
    const providerKind = workerDiagnostics.providerKind || "disabled";
    const providerEnabled = workerDiagnostics.providerEnabled === true;
    const liveConfigured = providerKind === "live";
    const live = providerEnabled && liveConfigured;
    const blockers = safeCollectionBlockers(provider?.reasons);
    return {
      stage: 228,
      provisional: false,
      acceptance: live ? "v2-live-fresh-collection" : (providerEnabled ? "test-data-only" : "provider-not-configured"),
      dataBoundary: "fresh-integration-only",
      store: "glamping-datalab-v2-fresh-integration-store",
      source: live ? "v2-live-fresh-collection" : (providerEnabled ? "synthetic-test-data" : "fresh-collection-not-configured"),
      fixtureMode: providerKind === "synthetic",
      providerId: workerDiagnostics.providerId || "",
      providerMode: providerKind,
      collection: {
        enabled: live,
        configured: liveConfigured,
        mode: providerKind,
        reason: live
          ? ""
          : liveConfigured
            ? blockers[0] || "실수집 승인 조건을 모두 충족해야 합니다."
            : (providerEnabled ? "테스트 provider는 사용자 실수집에 사용할 수 없습니다." : "실제 V2 수집 provider가 구성되지 않았습니다."),
        blockers
      },
      connectors: publicCollectionConnectors(provider, providerKind, live),
      providerCalls: Number(provider?.externalNetworkCalls || provider?.externalRequests || 0),
      syntheticProviderCalls: Number(provider?.syntheticCalls || 0),
      legacyRuntimeReads: 0,
      legacyRuntimeCopies: 0,
      processRestartRecovery: true
    };
  }

  function explorationMetadata() {
    return {
      stage: 231,
      dataBoundary: "fresh-live-only",
      synthetic: false,
      dataMode: "live",
      windowDays: FRESH_EXPLORATION_WINDOW_DAYS,
      axisEveryDays: 7
    };
  }

  async function tenantFor(session, requestedCompanyId = "", context = {}) {
    requireSession(session);
    if (roleFor(session) === "admin") {
      const requested = cleanText(requestedCompanyId, 160);
      if (!requested) return "";
      const access = await authService.assertCompanyAccess(session, requested, context);
      return cleanText(access?.company?.companyId || requested, 160);
    }
    const primary = session.memberships?.[0];
    if (!primary?.companyId) {
      throw platformError("활성 업체 소속이 필요합니다.", 403, "FRESH_MEMBERSHIP_REQUIRED");
    }
    const requested = cleanText(requestedCompanyId || primary.companyId, 160);
    if (requested !== primary.companyId) {
      throw platformError("다른 업체의 통합 데이터에는 접근할 수 없습니다.", 403, "FRESH_TENANT_FORBIDDEN");
    }
    await authService.assertCompanyAccess(session, requested, context);
    return requested;
  }

  async function scopedExplorationCompanies(session, requestedTenantCompanyId = "", requestedCompanyId = "", context = {}, requestedCompanyRef = "") {
    const role = roleFor(session);
    const tenantCompanyId = await tenantFor(session, requestedTenantCompanyId, context);
    let companyId = cleanText(requestedCompanyId, 160);
    const companyRef = cleanText(requestedCompanyRef, 80);
    const projections = role === "admin"
      ? await repository.listCompanies({
        projection: "business-safe",
        ...(tenantCompanyId ? { tenantCompanyId } : {})
      })
      : await repository.listBusinessSafeCompanies(tenantCompanyId);

    if (companyRef) {
      const selectedByRef = projections.find((row) => explorationCompanyRef(row.companyId) === companyRef) || null;
      if (!selectedByRef) {
        throw platformError("선택한 업체를 공개 범위에서 찾을 수 없습니다.", 404, "FRESH_EXPLORATION_SELECTION_NOT_FOUND");
      }
      if (companyId && companyId !== selectedByRef.companyId) {
        throw platformError("업체 선택 조건이 서로 일치하지 않습니다.", 409, "FRESH_EXPLORATION_SELECTION_CONFLICT");
      }
      companyId = selectedByRef.companyId;
    }
    if (companyId) {
      const selected = role === "admin"
        ? await repository.getCompany(companyId, {
          projection: "business-safe",
          ...(tenantCompanyId ? { tenantCompanyId } : {})
        })
        : await repository.getBusinessSafeCompany(companyId, tenantCompanyId);
      if (!projections.some((row) => row.companyId === selected.companyId)) projections.push(selected);
    }
    return {
      role,
      tenantCompanyId,
      companyId,
      companyRef: companyId ? explorationCompanyRef(companyId) : "",
      projections
    };
  }

  function explorationMap(entries, role, selectedCompanyId, now, quality = {}) {
    const markers = [];
    let locationRows = 0;
    let invalidCoordinates = 0;
    let outsideCoordinates = 0;
    let peerNumber = 0;
    for (const entry of entries.slice().sort((left, right) => String(left.projection.companyId).localeCompare(String(right.projection.companyId)))) {
      const location = latestObservation(entry.observations, "profile.location");
      const verifiedCoordinate = coordinateFrom(entry.projection.coordinates || {});
      if (!location && !verifiedCoordinate) continue;
      locationRows += 1;
      const coordinate = verifiedCoordinate || coordinateFrom(location);
      if (!coordinate) {
        invalidCoordinates += 1;
        continue;
      }
      if (!coordinateInBounds(coordinate)) {
        outsideCoordinates += 1;
        continue;
      }
      peerNumber += 1;
      markers.push({
        ...publicCompanyReference(entry.projection, role, selectedCompanyId, peerNumber),
        latitude: coordinate.latitude,
        longitude: coordinate.longitude,
        coordinateConfidence: verifiedCoordinate ? "verified" : coordinateConfidence(location, entry.projection),
        freshness: publicFreshness(verifiedCoordinate ? entry.projection.coordinates?.reviewedAt : location?.observedAt, now)
      });
    }
    let state = "ready";
    const missingLocations = Math.max(0, entries.length - locationRows);
    const incomplete = Boolean(
      quality.truncated
      || quality.quarantinedCount
      || quality.uncollectedCount
      || quality.observationTruncatedCount
      || missingLocations
      || invalidCoordinates
      || outsideCoordinates
    );
    if (!entries.length && quality.quarantinedCount) state = "not-exposed";
    else if (!entries.length || !locationRows) state = "not-collected";
    else if (!markers.length && outsideCoordinates) state = "out-of-range";
    else if (!markers.length && invalidCoordinates) state = "not-exposed";
    else if (markers.length && incomplete) state = "partial";
    return {
      state,
      markers,
      bounds: { ...FRESH_EXPLORATION_BOUNDS },
      sourceAsset: { ...FRESH_EXPLORATION_SOURCE_ASSET }
    };
  }

  function explorationRanking(entries, role, selectedCompanyId, now, quality = {}) {
    const ranked = entries.flatMap((entry) => entry.observations
      .filter((row) => observationKind(row) === "profile.rank")
      .map((row) => ({ row, projection: entry.projection, searchConditionId: searchConditionId(row) })));
    const conditioned = ranked.filter((entry) => entry.searchConditionId);
    const sorted = conditioned.slice().sort((left, right) => (
      String(right.row.targetDate || "").localeCompare(String(left.row.targetDate || ""))
      || observationTimestamp(right.row) - observationTimestamp(left.row)
    ));
    const anchor = selectedCompanyId
      ? sorted.find((entry) => entry.projection.companyId === selectedCompanyId) || null
      : sorted[0] || null;
    const condition = {
      metric: "profile.rank",
      targetDate: anchor?.row?.targetDate || "",
      channel: anchor?.row?.channel || "",
      comparison: "same-targetDate-and-channel",
      meaning: "v2-observed-rank-preserved",
      recalculated: false,
      searchCondition: anchor ? "matched" : "required"
    };
    if (!conditioned.length || !anchor) {
      return { state: quality.quarantinedCount ? "not-exposed" : "not-collected", condition, rows: [], platforms: [] };
    }

    const matching = latestRows(
      conditioned.filter((entry) => (
        entry.searchConditionId === anchor.searchConditionId
        && entry.row.targetDate === condition.targetDate
        && entry.row.channel === condition.channel
      )),
      (entry) => entry.projection.companyId
    );
    const matchingCompanyIds = new Set(matching.map((entry) => entry.projection.companyId));
    const conditionMissingCount = entries.filter((entry) => !matchingCompanyIds.has(entry.projection.companyId)).length;
    let missingValues = 0;
    let outOfRangeValues = 0;
    const valid = [];
    for (const entry of matching) {
      const raw = observedValue(entry.row);
      if (raw === null || raw === undefined || raw === "") {
        missingValues += 1;
        continue;
      }
      const rank = Number(raw);
      if (!Number.isInteger(rank) || rank < 1) {
        outOfRangeValues += 1;
        continue;
      }
      valid.push({ ...entry, rank });
    }
    valid.sort((left, right) => left.rank - right.rank || String(left.projection.companyId).localeCompare(String(right.projection.companyId)));
    const rows = valid.map((entry, index) => ({
      ...publicCompanyReference(entry.projection, role, selectedCompanyId, index + 1),
      position: index + 1,
      observedRank: entry.rank,
      rank: entry.rank,
      observedAt: entry.row.observedAt || "",
      freshness: publicFreshness(entry.row.observedAt, now)
    }));
    const state = rows.length
      ? (missingValues
          || outOfRangeValues
          || conditionMissingCount
          || quality.truncated
          || quality.quarantinedCount
          || quality.uncollectedCount
          || quality.observationTruncatedCount
        ? "partial"
        : "ready")
      : outOfRangeValues
        ? "out-of-range"
        : missingValues
          ? "not-exposed"
          : "not-collected";
    const platformCandidates = latestRows(
      conditioned.filter((entry) => (
        entry.searchConditionId === anchor.searchConditionId
        && entry.row.targetDate === condition.targetDate
      )),
      (entry) => `${entry.row.channel}|${entry.projection.companyId}`
    );
    const platformGroups = new Map();
    for (const entry of platformCandidates) {
      const channel = cleanText(entry.row.channel, 80);
      const rank = Number(observedValue(entry.row));
      if (!channel || !Number.isInteger(rank) || rank < 1) continue;
      if (!platformGroups.has(channel)) platformGroups.set(channel, []);
      platformGroups.get(channel).push({ ...entry, rank });
    }
    const platforms = [...platformGroups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([channel, platformRows]) => {
      platformRows.sort((left, right) => left.rank - right.rank || String(left.projection.companyId).localeCompare(String(right.projection.companyId)));
      return {
        channel,
        targetDate: condition.targetDate,
        comparison: "same-search-condition-and-targetDate",
        rows: platformRows.map((entry, index) => ({
          ...publicCompanyReference(entry.projection, role, selectedCompanyId, index + 1),
          position: index + 1,
          observedRank: entry.rank,
          rank: entry.rank,
          observedAt: entry.row.observedAt || "",
          freshness: publicFreshness(entry.row.observedAt, now)
        }))
      };
    });
    return { state, condition, rows, platforms };
  }

  function explorationTimeline(entries, selectedCompanyId, now, quality = {}) {
    const from = utcDate(now);
    const dates = dateWindow(from);
    const to = dates.at(-1);
    const selected = selectedCompanyId
      ? entries.find((entry) => entry.projection.companyId === selectedCompanyId) || null
      : entries.length === 1
        ? entries[0]
        : null;
    const relevant = selected
      ? selected.observations.filter((row) => TIMELINE_KINDS.has(observationKind(row)))
      : [];
    const inWindow = relevant.filter((row) => row.targetDate >= from && row.targetDate <= to);
    const points = dates.map((targetDate) => {
      const rows = inWindow.filter((row) => row.targetDate === targetDate);
      const price = numericMetric(rows, "product.price", "mean");
      const totalStock = numericMetric(rows, "product.total-stock", "sum");
      const availableStock = numericMetric(rows, "product.available-stock", "sum");
      const ota = otaMetric(rows);
      const pairedStock = pairedStockPoints(rows);
      const reservationRate = reservationMetric(pairedStock);
      const bookingPace = bookingPaceMetric(pairedStock);
      const collected = [price, totalStock, availableStock].map((metric) => metric.sampleCount > 0);
      collected.push(ota.sampleCount > 0);
      const valid = [price, totalStock, availableStock].map((metric) => metric.state === "ready");
      valid.push(ota.sampleCount > 0);
      return {
        date: targetDate,
        targetDate,
        state: valid.every(Boolean)
          ? "ready"
          : valid.some(Boolean)
            ? "partial"
            : collected.some(Boolean)
            ? "not-exposed"
            : "not-collected",
        price,
        totalStock,
        availableStock,
        reservationRate,
        bookingPace,
        ota
      };
    });
    let state = "not-collected";
    if (!entries.length && quality.quarantinedCount) state = "not-exposed";
    else if (!selected && entries.length > 1) state = "not-exposed";
    else if (relevant.length && !inWindow.length) state = "out-of-range";
    else if (points.every((point) => point.state === "ready") && !quality.observationTruncatedCount) state = "ready";
    else if (points.some((point) => ["ready", "partial"].includes(point.state))) state = "partial";
    else if (points.some((point) => point.state === "not-exposed")) state = "not-exposed";
    return { state, from, to, axisEveryDays: 7, points };
  }

  async function getExploration(session, requestedTenantCompanyId = "", requestedCompanyId = "", context = {}, requestedCompanyRef = "") {
    const scoped = await scopedExplorationCompanies(
      session,
      requestedTenantCompanyId,
      requestedCompanyId,
      context,
      requestedCompanyRef
    );
    const liveProjections = scoped.projections.filter(isLiveFreshRecord);
    const orderedProjections = liveProjections.slice().sort((left, right) => (
      Number(right.companyId === scoped.companyId) - Number(left.companyId === scoped.companyId)
      || String(left.companyId).localeCompare(String(right.companyId))
    ));
    const boundedProjections = orderedProjections.slice(0, FRESH_EXPLORATION_MAX_COMPANIES);
    const loaded = await mapWithConcurrency(
      boundedProjections,
      FRESH_EXPLORATION_READ_CONCURRENCY,
      async (projection) => {
        const stored = await repository.listObservations({
          companyId: projection.companyId,
          limit: FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY + 1
        });
        const observationTruncated = stored.length > FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY;
        const observations = stored
          .slice(-FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY)
          .filter(isLiveFreshRecord);
        return {
          projection,
          publicProjection: livePublicProjection(projection, observations),
          observations,
          observationTruncated
        };
      }
    );
    const quarantinedCount = loaded.filter((entry) => entry.observations.length && !entry.publicProjection).length;
    const uncollectedCount = loaded.filter((entry) => !entry.observations.length).length;
    const observationTruncatedCount = loaded.filter((entry) => entry.observationTruncated).length;
    const entries = loaded.filter((entry) => entry.publicProjection).map((entry) => ({
      projection: entry.publicProjection,
      observations: entry.observations
    }));
    const quality = {
      truncated: liveProjections.length > boundedProjections.length,
      quarantinedCount,
      uncollectedCount,
      observationTruncatedCount
    };
    const now = clockTimestamp(clock);
    const publicSelectedCompanyId = entries.some((entry) => entry.projection.companyId === scoped.companyId)
      ? scoped.companyId
      : "";
    const publicSelectedCompanyRef = publicSelectedCompanyId ? explorationCompanyRef(publicSelectedCompanyId) : "";
    const map = explorationMap(entries, scoped.role, publicSelectedCompanyId, now, quality);
    const ranking = explorationRanking(entries, scoped.role, publicSelectedCompanyId, now, quality);
    const timeline = explorationTimeline(entries, publicSelectedCompanyId, now, quality);
    return {
      state: explorationState([map.state, ranking.state, timeline.state]),
      scope: {
        role: scoped.role,
        tenantCompanyId: scoped.tenantCompanyId,
        companyId: publicSelectedCompanyId,
        companyRef: publicSelectedCompanyRef,
        companyCount: entries.length,
        observationCount: entries.reduce((sum, entry) => sum + entry.observations.length, 0),
        quarantinedCompanyCount: quarantinedCount,
        uncollectedCompanyCount: uncollectedCount,
        companyLimitReached: quality.truncated,
        observationLimitReached: observationTruncatedCount > 0,
        dataMode: "live",
        synthetic: false,
        windowDays: FRESH_EXPLORATION_WINDOW_DAYS
      },
      map,
      ranking,
      timeline
    };
  }

  async function detailFor(projection, options = {}) {
    const admin = options.admin === true;
    const companyId = projection.companyId;
    const [storedObservations, verified, audits] = await Promise.all([
      repository.listObservations({ companyId, limit: 100_000 }),
      repository.getCompany(companyId, { projection: "verified" }),
      repository.listAudit({ companyId, limit: 1000 })
    ]);
    const observations = allowSynthetic
      ? storedObservations
      : storedObservations.filter((row) => row.synthetic === false && row.dataMode === "live");
    const derived = allowSynthetic
      ? (projection.dataQuality || {})
      : deriveCompanyQuality(projection, observations, verified, clock());
    const completeness = derived.dataCompleteness || {};
    const freshness = derived.freshness || {};
    const confidence = derived.confidence || {};
    const profile = verified?.status === "approved" ? verified.profile || {} : {};
    const latestLocation = latestObservation(observations, "profile.location");
    const observedCoordinate = coordinateFrom(latestLocation || {});
    const coordinateReview = verified?.coordinateReview && typeof verified.coordinateReview === "object"
      ? verified.coordinateReview
      : null;
    const approvedCoordinate = coordinateFrom(coordinateReview?.approvedCoordinates || {});
    const candidateCoordinate = coordinateFrom(coordinateReview?.candidate || {});
    const reviewedCoordinate = coordinateReview?.status === "rejected"
      ? candidateCoordinate || approvedCoordinate || observedCoordinate
      : approvedCoordinate || candidateCoordinate || observedCoordinate;
    const publicCoordinate = approvedCoordinate;
    const displayedCoordinate = admin ? reviewedCoordinate : publicCoordinate;
    const coordinateState = admin
      ? (coordinateReview?.status || (observedCoordinate ? "pending" : "not-collected"))
      : (approvedCoordinate ? "approved" : "not-collected");
    const profileFields = Object.entries(PROFILE_LABELS).filter(([field]) => cleanText(profile[field], 1));
    const latestAt = freshness.latestObservedAt || projection.collection?.lastObservedAt || "";
    const validUntil = latestAt
      ? new Date(Date.parse(latestAt) + 7 * 24 * 60 * 60 * 1000).toISOString()
      : "";
    const sources = new Set(observations.map((row) => row.source).filter(Boolean));
    const liveObservations = observations.filter((row) => row.synthetic === false && row.dataMode === "live");
    const repeatCount = repeatObservationCount(observations);
    const firstObservedAt = observations.map((row) => row.observedAt).filter(Boolean).sort()[0] || "";
    const missingModes = Array.isArray(completeness.missingModes) ? completeness.missingModes : [];
    const enrichmentAction = projection.dataQuality?.enrichmentCta?.action || "none";
    const verificationRequired = enrichmentAction === "request-verification";
    return {
      state: Number(completeness.score || 0) === 100 ? "ready" : "partial",
      completeness: {
        state: Number(completeness.score || 0) === 100 ? "complete" : "partial",
        displayValue: `${Number(completeness.score || 0)}%`,
        detail: `quick/detail/OTA ${Number((completeness.collectedModes || []).length)} / 3 계층 수집`,
        verifiedFields: profileFields.length,
        totalFields: Object.keys(PROFILE_LABELS).length,
        missingFields: missingModes
      },
      freshness: {
        state: freshness.state || "missing",
        displayValue: freshness.state === "fresh" ? "최신" : (freshness.state || "미수집"),
        detail: latestAt ? `마지막 관측 ${latestAt}` : "신규 관측이 필요합니다.",
        observedAt: latestAt,
        validUntil
      },
      confidence: {
        state: confidence.level || "insufficient",
        displayValue: `${Number(confidence.score || 0)}점`,
        detail: confidence.verified ? "수동 검수와 신규 관측을 반영했습니다." : "신규 관측 기반이며 수동 검수를 기다립니다.",
        basis: `수집 완전성 ${Number(completeness.score || 0)}%, 검수 ${confidence.verified ? "승인" : "대기"}`
      },
      coordinateReview: {
        state: coordinateState,
        latitude: displayedCoordinate?.latitude ?? null,
        longitude: displayedCoordinate?.longitude ?? null,
        confidence: approvedCoordinate && coordinateState === "approved"
          ? "verified"
          : (admin && displayedCoordinate ? coordinateConfidence(latestLocation || {}, projection) : "unverified"),
        observedAt: admin || approvedCoordinate ? latestLocation?.observedAt || "" : "",
        reviewedAt: admin
          ? coordinateReview?.reviewedAt || ""
          : approvedCoordinate
            ? coordinateReview?.approvedAt || coordinateReview?.reviewedAt || ""
            : "",
        version: admin ? Number(coordinateReview?.version || 0) : 0
      },
      provenance: {
        summary: liveObservations.length
          ? `V2 신규 실수집 ${sources.size}개 provider 출처 · raw 경로 비공개`
          : "테스트 데이터는 사용자 결과에 공개하지 않습니다.",
        sourceCount: sources.size,
        lastVerifiedAt: verified?.reviewedAt || ""
      },
      verifiedValues: profileFields.map(([field, label]) => ({
        field,
        label,
        value: safeScalar(profile[field]),
        verified: true,
        verifiedAt: verified.reviewedAt || ""
      })),
      changes: verifiedChanges(audits, { admin }),
      enrichment: {
        state: projection.dataQuality?.enrichmentCta?.required ? "required" : "complete",
        ctaLabel: verificationRequired
          ? "관리자 검수 요청하기"
          : (missingModes.length ? "신규 수집으로 보강하기" : "보강 완료"),
        detail: verificationRequired
          ? "필수 수집 계층은 완료되었으며 수동 검수 승인을 기다립니다."
          : (missingModes.length ? `${missingModes.join(", ")} 계층을 보강해야 합니다.` : "필수 수집과 검수가 모두 준비되었습니다."),
        missingFields: missingModes
      },
      observations: {
        displayCount: `${observations.length}건`,
        repeatCount,
        firstObservedAt,
        lastObservedAt: latestAt,
        summary: repeatCount ? `동일 관측 키의 후속 시점 ${repeatCount}건을 보존했습니다.` : "첫 관측 세트를 보존했습니다."
      }
    };
  }

  async function publicCompany(projection, options = {}) {
    const storedObservations = await repository.listObservations({ companyId: projection.companyId, limit: 100_000 });
    const observations = allowSynthetic
      ? storedObservations
      : storedObservations.filter(isLiveFreshRecord);
    const publicProjection = allowSynthetic ? projection : livePublicProjection(projection, observations);
    if (!publicProjection) {
      throw platformError(
        "실수집 profile identity가 완성되지 않은 업체는 공개하지 않습니다.",
        404,
        "FRESH_COMPANY_IDENTITY_QUARANTINED"
      );
    }
    const detail = await detailFor(publicProjection, options);
    const rank = observedValue(latestObservation(observations, "profile.rank"));
    const reviewCount = observedValue(latestObservation(observations, "profile.review-count"));
    const prices = observations
      .filter((row) => (row.observationType || row.kind) === "product.price")
      .map(observedValue).map(Number).filter(Number.isFinite);
    const averagePrice = prices.length ? Math.round(prices.reduce((sum, value) => sum + value, 0) / prices.length) : null;
    const live = isLiveFreshRecord(publicProjection) && observations.some(isLiveFreshRecord);
    return {
      companyId: publicProjection.companyId,
      companyName: publicProjection.name,
      regionLabel: publicProjection.region,
      category: allowSynthetic ? "glamping" : (publicProjection.category || "미수집"),
      status: detail.state === "ready" ? "fresh" : "partial",
      freshAt: detail.freshness.observedAt || "",
      freshnessLabel: detail.freshness.displayValue,
      observationCount: observations.length,
      dataQuality: detail.state === "ready" ? "complete" : "partial",
      missingFields: detail.completeness.missingFields,
      businessValues: {
        naverRank: Number.isFinite(Number(rank)) ? Number(rank) : null,
        averagePrice,
        weeklyRevenue: null,
        soldOutRate: null,
        reviewCount: Number.isFinite(Number(reviewCount)) ? Number(reviewCount) : null
      },
      freshDetail: detail,
      sourceLabel: live ? publicProjection.sourceLabel : "테스트 데이터",
      synthetic: !live,
      dataMode: live ? "live" : "synthetic-test"
    };
  }

  async function listCompanies(session, requestedTenantCompanyId = "", context = {}) {
    const tenantCompanyId = await tenantFor(session, requestedTenantCompanyId, context);
    const admin = roleFor(session) === "admin";
    const projections = admin
      ? await repository.listCompanies({ projection: "business-safe" })
      : await repository.listBusinessSafeCompanies(tenantCompanyId);
    const visible = allowSynthetic ? projections : projections.filter(isLiveFreshRecord);
    const projected = await Promise.all(visible.map(async (projection) => {
      try {
        return await publicCompany(projection, { admin });
      } catch (error) {
        if (error?.code === "FRESH_COMPANY_IDENTITY_QUARANTINED") return null;
        throw error;
      }
    }));
    return projected.filter(Boolean);
  }

  async function getCompany(session, companyId, requestedTenantCompanyId = "", context = {}) {
    const tenantCompanyId = await tenantFor(session, requestedTenantCompanyId, context);
    const admin = roleFor(session) === "admin";
    const projection = admin
      ? await repository.getCompany(companyId, { projection: "business-safe" })
      : await repository.getBusinessSafeCompany(companyId, tenantCompanyId);
    if (!allowSynthetic && !isLiveFreshRecord(projection)) {
      throw platformError("실수집되지 않은 테스트 업체는 사용자 화면에 공개하지 않습니다.", 404, "FRESH_COMPANY_NOT_COLLECTED");
    }
    return publicCompany(projection, { admin });
  }

  async function listJobs(session) {
    requireSession(session);
    const role = roleFor(session);
    const rows = await repository.listRuns(role === "admin" ? {} : { actorAccountId: session.accountId });
    const visible = allowSynthetic ? rows : rows.filter((row) => row.synthetic === false && row.dataMode === "live");
    return visible.map((row) => collectionService.projectStage227Job(row, { role }))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  function publicJobResult(session, result = {}) {
    const run = result.run || {};
    return {
      ok: true,
      idempotent: Boolean(result.idempotent),
      outcome: cleanText(result.outcome || run.status, 40),
      job: collectionService.projectStage227Job(run, { role: roleFor(session) })
    };
  }

  async function internalJob(session, clientRequestId) {
    requireSession(session);
    const result = await collectionService.getByClientRequestId(clientRequestId, actorFor(session));
    if (!allowSynthetic && (result.run?.synthetic !== false || result.run?.dataMode !== "live")) {
      throw platformError("Fresh collection job was not found", 404, "FRESH_RUN_NOT_FOUND");
    }
    return result;
  }

  async function submitCollection(session, payload = {}, context = {}) {
    requireSession(session);
    const role = roleFor(session);
    const kind = cleanText(payload.kind || (role === "admin" ? "admin-collection" : "business-search"), 48);
    if (role === "admin" && kind !== "admin-collection") {
      throw platformError("관리자는 관리자 수집만 실행할 수 있습니다.", 403, "FRESH_ROLE_FORBIDDEN");
    }
    if (role === "b2b" && !["business-search", "business-my-lodge"].includes(kind)) {
      throw platformError("사업자 수집 유형이 아닙니다.", 403, "FRESH_ROLE_FORBIDDEN");
    }
    const tenantCompanyId = await tenantFor(session, payload.tenantCompanyId, context);
    const actor = actorFor(session);
    const submitted = await collectionService.submit({
      ...payload,
      kind,
      tenantCompanyId,
      targetDate: cleanText(payload.targetDate, 16) || new Date(clock()).toISOString().slice(0, 10)
    }, actor);
    if (!["completed", "cancelled", "failed"].includes(submitted.run?.status)) {
      notifyWorker("collection-submitted");
    }
    return publicJobResult(session, { ...submitted, outcome: submitted.run.status });
  }

  async function getJob(session, clientRequestId) {
    requireSession(session);
    const result = await internalJob(session, clientRequestId);
    if (!allowSynthetic && (result.run?.synthetic !== false || result.run?.dataMode !== "live")) {
      throw platformError("테스트 수집 작업은 사용자 화면에 공개하지 않습니다.", 404, "FRESH_RUN_NOT_FOUND");
    }
    return publicJobResult(session, result);
  }

  async function cancelJob(session, clientRequestId, payload = {}) {
    const existing = await internalJob(session, clientRequestId);
    const cancelled = await collectionService.cancel(existing.run.runId, payload, actorFor(session));
    if (cancelled.run?.status === "cancel-requested") notifyWorker("collection-cancel-requested");
    return publicJobResult(session, { ...cancelled, outcome: cancelled.run?.status || "cancel-requested" });
  }

  async function resumeJob(session, clientRequestId, payload = {}) {
    const existing = await internalJob(session, clientRequestId);
    const resumed = await collectionService.resume(existing.run.runId, payload, actorFor(session));
    if (!["completed", "cancelled", "failed"].includes(resumed.run?.status)) {
      notifyWorker("collection-resumed");
    }
    return publicJobResult(session, { ...resumed, outcome: resumed.run?.status || "queued" });
  }

  async function reviewCompany(session, companyId, payload = {}) {
    requireAdmin(session);
    if (typeof authService.assertRecentReauthentication === "function") {
      authService.assertRecentReauthentication(session);
    }
    // Resolve the public live projection before mutating. In production this
    // prevents a caller from reviewing a quarantined synthetic company.
    await getCompany(session, companyId);
    if (payload.profilePatch && typeof payload.profilePatch === "object" && !Array.isArray(payload.profilePatch)) {
      const patchKeys = Object.keys(payload.profilePatch);
      if (!patchKeys.length || patchKeys.some((key) => !["latitude", "longitude"].includes(key))) {
        throw platformError("좌표 검수는 위도와 경도 필드만 수정할 수 있습니다.", 400, "FRESH_COORDINATE_REVIEW_FIELDS_INVALID");
      }
      const reviewedCoordinate = coordinateFrom(payload.profilePatch);
      if (!reviewedCoordinate || !coordinateInBounds(reviewedCoordinate)) {
        throw platformError("승인 좌표는 지원하는 대한민국 WGS84 경계 안에 있어야 합니다.", 400, "FRESH_COORDINATE_REVIEW_OUT_OF_RANGE");
      }
      const reviewed = await repository.reviewCoordinates({
        ...payload,
        companyId,
        coordinates: reviewedCoordinate
      }, actorFor(session));
      return { ok: true, ...reviewed, company: await getCompany(session, companyId) };
    }
    const reviewed = await repository.reviewVerifiedProfile({ ...payload, companyId }, actorFor(session));
    await repository.refreshDerivedProfile(companyId, actorFor(session));
    return { ok: true, ...reviewed, company: await getCompany(session, companyId) };
  }

  async function createSnapshot(session, label) {
    requireAdmin(session);
    const row = await repository.createSnapshot(actorFor(session), label);
    return { ok: true, snapshot: {
      snapshotId: row.snapshotId,
      snapshotKind: row.snapshotKind,
      storeRevision: row.storeRevision,
      label: row.label,
      createdAt: row.createdAt,
      fileCount: row.fileCount
    } };
  }

  async function listSnapshots(session) {
    requireAdmin(session);
    const rows = await repository.listSnapshots();
    return { ok: true, snapshots: rows.map((row) => ({
      snapshotId: row.snapshotId,
      snapshotKind: row.snapshotKind,
      storeRevision: row.storeRevision,
      label: row.label,
      createdAt: row.createdAt,
      fileCount: row.fileCount
    })) };
  }

  async function rollbackSnapshot(session, snapshotId) {
    requireAdmin(session);
    if (typeof authService.assertRecentReauthentication === "function") {
      authService.assertRecentReauthentication(session);
    }
    return repository.rollbackSnapshot(snapshotId, actorFor(session));
  }

  return Object.freeze({
    metadata,
    explorationMetadata,
    getExploration,
    listCompanies,
    getCompany,
    listJobs,
    submitCollection,
    getJob,
    cancelJob,
    resumeJob,
    reviewCompany,
    createSnapshot,
    listSnapshots,
    rollbackSnapshot,
    actorFor
  });
}

module.exports = {
  FRESH_EXPLORATION_BOUNDS,
  FRESH_EXPLORATION_MAX_COMPANIES,
  FRESH_EXPLORATION_MAX_OBSERVATIONS_PER_COMPANY,
  FRESH_EXPLORATION_SOURCE_ASSET,
  FRESH_EXPLORATION_WINDOW_DAYS,
  createFreshPlatformService,
  explorationCompanyRef,
  isLiveFreshRecord,
  publicCollectionConnectors,
  repeatObservationCount,
  safeCollectionBlockers,
  safeScalar,
  verifiedChanges
};
