"use strict";

const crypto = require("node:crypto");
const VERSION = "regional-outlook-evaluation-v1";
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const METRICS = {
  visitors: { averageDailyVisitors: ["일평균 방문자", "명"], visitorDays: ["월간 방문자 누계", "인일"] },
  demandStrength: { stayOverall: ["체류 지수", "지수"], spendOverall: ["소비 지수", "지수"] },
  resourceDemand: { service: ["서비스 수요", "지수"], culture: ["문화 수요", "지수"] },
  diversity: { visitor: ["관광객 다양성", "지수"], spend: ["소비 다양성", "지수"], international: ["국제 관광 다양성", "지수"] },
  searchTrend: { interest: ["검색 관심도", "상대지수"] }
};
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round = value => !Number.isFinite(value) ? null : Math.abs(value) > Number.MAX_SAFE_INTEGER / 1e6 ? value : Math.round((value + Number.EPSILON) * 1e6) / 1e6;
const safeId = value => typeof value === "string" && ID.test(value) ? value : "";
const safeText = value => typeof value === "string" && /^[가-힣A-Za-z0-9 .·()_-]{1,100}$/.test(value) ? value : "";
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const shift = (month, amount) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + amount, 1)).toISOString().slice(0, 7);
const kstDate = instant => new Date(Date.parse(instant) + 9 * 3600000).toISOString().slice(0, 10);
const monthClose = month => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 1, -9);
function validDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function instant(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function normalization(value) {
  if (typeof value !== "string") return "";
  const match = /^(20\d{2}-\d{2}-\d{2}) ~ (20\d{2}-\d{2}-\d{2})$/.exec(value);
  return match && validDate(match[1]) && validDate(match[2]) && match[1] <= match[2] ? value : "";
}
function predictionMetrics(snapshot) {
  if (Array.isArray(snapshot?.metrics) && snapshot.metrics.length) return snapshot.metrics.map(metric => ({ ...metric,
    groupKey: metric.groupKey || "", metricKey: metric.metricKey || String(metric.key || "").split(":").at(-1) }));
  return (Array.isArray(snapshot?.groups) ? snapshot.groups : []).flatMap(group => (Array.isArray(group?.metrics) ? group.metrics : []).map(metric => ({ ...metric, groupKey: group.key,
    metricKey: metric.metricKey || String(metric.key || "").split(":").at(-1), provider: metric.provider || group.provider,
    sourceBatchId: metric.sourceBatchId || group.sourceBatchId, normalizationPeriod: metric.normalizationPeriod || group.normalizationPeriod })));
}
function forecastReference(snapshot) {
  const publication = snapshot?.publication;
  return { resultId: safeId(snapshot?.resultId) || null, publishedAt: instant(publication?.publishedAt), generatedAt: instant(snapshot?.generatedAt),
    proof: ["journal", "saved_reference"].includes(publication?.proof) ? publication.proof : null,
    coverage: ["recorded", "legacy_reference"].includes(publication?.coverage) ? publication.coverage : null };
}
function candidate(snapshot, metric, forecast, cutoff) {
  const groupKey = safeId(metric.groupKey), metricKey = safeId(metric.metricKey), definition = METRICS[groupKey]?.[metricKey];
  const issueMonth = MONTH.test(snapshot?.scope?.month || "") ? snapshot.scope.month : "";
  const targetPeriod = MONTH.test(forecast?.period || "") ? forecast.period : "";
  const provider = safeText(metric.provider), unit = safeText(metric.unit), kind = ["current", "next"].includes(forecast?.kind) ? forecast.kind : "";
  const modelVersion = safeId(snapshot?.modelVersion), reference = forecastReference(snapshot);
  const sourceRows = Array.isArray(metric.historyRows) ? metric.historyRows : Array.isArray(metric.rows) ? metric.rows : [];
  const inputLatestPeriod = MONTH.test(metric.latestPeriod || "") ? metric.latestPeriod : sourceRows.filter(row => row.status === "observed" && numeric(row.value) && MONTH.test(row.period || ""))
    .map(row => row.period).sort().at(-1) || "";
  const row = { regionKey: safeId(snapshot?.scope?.regionKey), issueMonth, targetPeriod, kind, groupKey, metricKey,
    label: definition?.[0] || "지원하지 않는 지표", unit: definition ? unit : "", provider: definition ? provider : "", modelVersion,
    status: "excluded", reasonCode: "", forecastValue: null, actualValue: null, difference: null, absoluteError: null, errorPct: null,
    predictionRef: { ...reference, inputLatestPeriod }, actualRef: null };
  let reason = !definition || !row.regionKey || !issueMonth || !targetPeriod || !kind || !provider || !unit || !modelVersion ? "UNSUPPORTED_FORECAST_METADATA" : "";
  if (!reason && unit !== definition[1]) reason = "UNSUPPORTED_FORECAST_UNIT";
  if (!reason && (snapshot?.publication?.status !== "published" || !reference.resultId || !reference.publishedAt || !reference.generatedAt || !reference.proof || !reference.coverage)) reason = "PUBLICATION_NOT_PROVEN";
  if (!reason && (reference.publishedAt > cutoff || reference.generatedAt > cutoff)) reason = "FORECAST_NOT_AVAILABLE_AS_OF";
  if (!reason && (reference.generatedAt > reference.publishedAt || kstDate(reference.publishedAt).slice(0, 7) !== issueMonth
    || kstDate(reference.generatedAt).slice(0, 7) !== issueMonth || !validDate(snapshot?.asOfDate) || snapshot.asOfDate.slice(0, 7) !== issueMonth
    || snapshot.asOfMonth !== issueMonth || snapshot.asOfDate > kstDate(reference.publishedAt))) reason = "ISSUE_TIME_MISMATCH";
  if (!reason && targetPeriod !== shift(issueMonth, kind === "next" ? 1 : 0)) reason = "TARGET_KIND_MISMATCH";
  if (!reason && (snapshot?.sourceScope?.month !== shift(issueMonth, -1) || !inputLatestPeriod || inputLatestPeriod >= issueMonth
    || sourceRows.some(point => point.status === "observed" && numeric(point.value) && MONTH.test(point.period || "") && point.period >= issueMonth))) reason = "INPUT_PERIOD_NOT_VERIFIABLE";
  if (!reason && snapshot?.sourceScope?.regionKey !== row.regionKey) reason = "INPUT_REGION_MISMATCH";
  if (!reason && sourceRows.some(point => point.status === "observed" && numeric(point.value) && instant(point.retrievedAt) && instant(point.retrievedAt) > reference.publishedAt)) reason = "INPUT_RECEIVED_AFTER_PUBLICATION";
  if (!reason && forecast?.status !== "forecast") reason = forecast?.status === "observed" ? "ALREADY_OBSERVED_AT_ISSUE" : "FORECAST_NOT_PRODUCED";
  if (!reason && (!numeric(forecast.value) || groupKey === "searchTrend" && forecast.value > 100)) reason = "INVALID_FORECAST_VALUE";
  const sourceBatchId = safeId(metric.sourceBatchId), normalizationPeriod = normalization(metric.normalizationPeriod);
  if (!reason && groupKey === "searchTrend" && (!sourceBatchId || !normalizationPeriod)) reason = "UNSUPPORTED_SEARCH_NORMALIZATION";
  if (!reason && Date.parse(reference.publishedAt) >= monthClose(targetPeriod)) reason = "PUBLISHED_AFTER_TARGET_CLOSED";
  if (reason) { row.reasonCode = reason; return { row, eligible: false }; }
  row.forecastValue = forecast.value;
  return { row, eligible: true, sourceBatchId, normalizationPeriod,
    key: JSON.stringify([row.regionKey, issueMonth, targetPeriod, kind, groupKey, metricKey, unit, provider]) };
}

function actualCandidates(selected, snapshots, cutoff) {
  const row = selected.row, contexts = [];
  for (const snapshot of snapshots) {
    if (snapshot?.scope?.regionKey !== row.regionKey) continue;
    const snapshotAt = instant(snapshot.generatedAt) || instant(snapshot.builtAt);
    if (snapshotAt && snapshotAt > cutoff) continue;
    for (const group of Array.isArray(snapshot?.groups) ? snapshot.groups : []) {
      if (group?.key !== row.groupKey) continue;
      const metrics = (Array.isArray(group.metrics) ? group.metrics : []).filter(metric => (metric.metricKey || String(metric.key || "").split(":").at(-1)) === row.metricKey);
      for (const metric of metrics) {
        const points = Array.isArray(metric.historyRows) ? metric.historyRows : Array.isArray(metric.rows) ? metric.rows : [];
        const matches = points.filter(point => point?.period === row.targetPeriod);
        if (!matches.length && metric.requestedPoint?.period === row.targetPeriod) matches.push(metric.requestedPoint);
        if (!matches.length) continue;
        const point = matches[0], receivedAt = instant(point.retrievedAt) || snapshotAt;
        if (receivedAt && receivedAt > cutoff) continue;
        const provider = metric.provider || group.provider, unit = metric.unit;
        const context = { snapshot, group, metric, point, receivedAt, snapshotAt,
          sourceFingerprint: safeId(snapshot.sourceFingerprint) || null,
          reasonCode: !receivedAt ? "UNSUPPORTED_ACTUAL_TIMESTAMP" : metrics.length > 1 || matches.length > 1 ? "DUPLICATE_ACTUAL_OBSERVATION"
            : !MONTH.test(snapshot?.scope?.month || "") || snapshot.scope.month < row.targetPeriod ? "ACTUAL_SCOPE_PERIOD_MISMATCH"
              : !safeText(provider) || !safeText(unit) ? "UNSUPPORTED_ACTUAL_METADATA" : provider !== row.provider ? "PROVIDER_MISMATCH"
                : unit !== row.unit ? "UNIT_MISMATCH" : group.periodType && group.periodType !== "M" ? "UNSUPPORTED_ACTUAL_PERIOD_TYPE"
                  : Date.parse(receivedAt) < monthClose(row.targetPeriod) || snapshotAt && Date.parse(snapshotAt) < monthClose(row.targetPeriod) ? "ACTUAL_RECEIVED_BEFORE_MONTH_CLOSED" : "" };
        if (!context.reasonCode && row.groupKey === "searchTrend" && (!safeId(metric.sourceBatchId || group.sourceBatchId)
          || !normalization(metric.normalizationPeriod || group.normalizationPeriod))) context.reasonCode = "UNSUPPORTED_SEARCH_NORMALIZATION";
        if (!context.reasonCode && row.groupKey === "searchTrend" && ((metric.sourceBatchId || group.sourceBatchId) !== selected.sourceBatchId
          || (metric.normalizationPeriod || group.normalizationPeriod) !== selected.normalizationPeriod)) context.reasonCode = "SEARCH_NORMALIZATION_NOT_COMPARABLE";
        if (!context.reasonCode && (group.stale === true || metric.stale === true || point.stale === true || point.refreshErrorCode)) context.reasonCode = "STALE_ACTUAL_OBSERVATION";
        if (!context.reasonCode && !["observed", "complete"].includes(point.status)) context.reasonCode = point.status === "publication_pending" ? "OFFICIAL_PUBLICATION_PENDING"
          : point.status === "partial" ? "ACTUAL_OBSERVATION_PARTIAL" : ["failed", "error", "blocked"].includes(point.status) ? "ACTUAL_OBSERVATION_ERROR" : "ACTUAL_OBSERVATION_MISSING";
        if (!context.reasonCode && (!numeric(point.value) || row.groupKey === "searchTrend" && point.value > 100)) context.reasonCode = "INVALID_ACTUAL_VALUE";
        contexts.push(context);
      }
    }
  }
  return contexts.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || ""))
    || String(b.snapshotAt || "").localeCompare(String(a.snapshotAt || "")) || String(a.sourceFingerprint || "").localeCompare(String(b.sourceFingerprint || "")));
}
function compare(selected, observations, cutoff) {
  const row = { ...selected.row }, close = monthClose(row.targetPeriod);
  if (close > Date.parse(cutoff)) return { ...row, status: "pending", reasonCode: "TARGET_MONTH_OPEN" };
  const contexts = actualCandidates(selected, observations, cutoff), latest = contexts[0];
  if (!latest) return { ...row, status: "pending", reasonCode: "OFFICIAL_OBSERVATION_NOT_AVAILABLE" };
  if (latest.reasonCode) return { ...row, status: ["OFFICIAL_PUBLICATION_PENDING", "ACTUAL_OBSERVATION_PARTIAL", "ACTUAL_OBSERVATION_ERROR", "ACTUAL_OBSERVATION_MISSING", "STALE_ACTUAL_OBSERVATION"].includes(latest.reasonCode) ? "pending" : "excluded",
    reasonCode: latest.reasonCode };
  const tied = contexts.filter(item => item.receivedAt === latest.receivedAt && item.snapshotAt === latest.snapshotAt && !item.reasonCode);
  if (new Set(tied.map(item => item.point.value)).size > 1) return { ...row, status: "excluded", reasonCode: "CONFLICTING_ACTUAL_OBSERVATIONS" };
  const normal = contexts.filter(item => !item.reasonCode), first = normal.at(-1), difference = latest.point.value - row.forecastValue;
  const actualRef = { receivedAt: latest.receivedAt, period: row.targetPeriod, sourceFingerprint: latest.sourceFingerprint,
    snapshotAt: latest.snapshotAt, receiptEvidence: instant(latest.point.retrievedAt) ? "source_timestamp" : "snapshot_timestamp",
    policy: "latest_official_as_of", firstObservedValue: first?.point.value ?? null,
    revised: new Set(normal.map(item => item.point.value)).size > 1,
    sourceBatchId: row.groupKey === "searchTrend" ? selected.sourceBatchId : null,
    normalizationPeriod: row.groupKey === "searchTrend" ? selected.normalizationPeriod : null };
  return { ...row, status: "compared", reasonCode: "", actualValue: latest.point.value, difference: round(difference), absoluteError: round(Math.abs(difference)),
    errorPct: latest.point.value > 0 ? round(Math.abs(difference) / latest.point.value * 100) : null,
    percentageReasonCode: latest.point.value === 0 ? "ZERO_ACTUAL_DENOMINATOR" : "", actualRef };
}

function scoresFor(rows) {
  const groups = new Map();
  for (const row of rows.filter(row => row.status === "compared")) {
    const key = JSON.stringify([row.regionKey, row.groupKey, row.metricKey, row.unit, row.provider, row.kind, row.modelVersion]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(rows => {
    const first = rows[0], count = rows.length, scale = Math.max(...rows.flatMap(row => [row.actualValue, row.absoluteError]));
    const denominator = scale ? rows.reduce((sum, row) => sum + row.actualValue / scale, 0) : 0;
    const numerator = scale ? rows.reduce((sum, row) => sum + row.absoluteError / scale, 0) : 0;
    return { regionKey: first.regionKey, groupKey: first.groupKey, metricKey: first.metricKey, label: first.label, unit: first.unit, provider: first.provider,
      kind: first.kind, modelVersion: first.modelVersion, sampleCount: count,
      mae: round(rows.reduce((sum, row) => sum + row.absoluteError / count, 0)),
      wapePct: denominator > 0 ? round(numerator / denominator * 100) : null,
      wapeReasonCode: denominator === 0 ? "ZERO_ACTUAL_DENOMINATOR" : "",
      bias: round(rows.reduce((sum, row) => sum + row.difference / count, 0)), actualZeroCount: rows.filter(row => row.actualValue === 0).length };
  }).sort((a, b) => JSON.stringify([a.regionKey, a.groupKey, a.metricKey, a.kind, a.modelVersion]).localeCompare(JSON.stringify([b.regionKey, b.groupKey, b.metricKey, b.kind, b.modelVersion])));
}

function buildRegionalOutlookEvaluation({ forecastSnapshots = [], observationSnapshots = [], asOfAt } = {}) {
  const cutoff = instant(asOfAt);
  if (!cutoff) throw Object.assign(new Error("An explicit ISO evaluation timestamp is required"), { code: "INVALID_EVALUATION_AS_OF" });
  if (!Array.isArray(forecastSnapshots) || !Array.isArray(observationSnapshots)) throw Object.assign(new Error("Snapshot arrays required"), { code: "INVALID_EVALUATION_INPUT" });
  const candidates = [], signatures = new Map(), conflicting = new Set(), seen = new Set();
  for (const snapshot of forecastSnapshots) {
    const metrics = predictionMetrics(snapshot);
    const signature = hash({ scope: snapshot?.scope, generatedAt: snapshot?.generatedAt, asOfDate: snapshot?.asOfDate,
      asOfMonth: snapshot?.asOfMonth, modelVersion: snapshot?.modelVersion, sourceScope: snapshot?.sourceScope, metrics });
    const id = safeId(snapshot?.resultId);
    if (id && signatures.has(id) && signatures.get(id) !== signature) conflicting.add(id);
    if (id) signatures.set(id, signature);
    const metricCounts = new Map();
    for (const metric of metrics) { const key = `${metric.groupKey}:${metric.metricKey}`; metricCounts.set(key, (metricCounts.get(key) || 0) + 1); }
    for (const metric of metrics) {
      const forecasts = Array.isArray(metric.forecasts) ? metric.forecasts : [];
      for (const forecast of forecasts) {
        const value = candidate(snapshot, metric, forecast, cutoff), targetDuplicates = forecasts.filter(row => row?.period === forecast?.period && row?.kind === forecast?.kind).length;
        if (metricCounts.get(`${metric.groupKey}:${metric.metricKey}`) > 1 || targetDuplicates > 1) {
          value.eligible = false; value.row.reasonCode = "DUPLICATE_FORECAST_OBSERVATION"; value.row.forecastValue = null;
        }
        const identity = hash([id, signature, value.row, snapshot?.publication]);
        if (!seen.has(identity)) { seen.add(identity); candidates.push(value); }
      }
    }
  }
  for (const value of candidates) if (conflicting.has(value.row.predictionRef.resultId)) {
    value.eligible = false; value.row.reasonCode = "CONFLICTING_FORECAST_REFERENCE"; value.row.forecastValue = null;
  }
  const primary = new Map(), excluded = candidates.filter(item => !item.eligible).map(item => item.row);
  for (const value of candidates.filter(item => item.eligible).sort((a, b) => a.row.predictionRef.publishedAt.localeCompare(b.row.predictionRef.publishedAt)
    || a.row.predictionRef.generatedAt.localeCompare(b.row.predictionRef.generatedAt) || a.row.predictionRef.resultId.localeCompare(b.row.predictionRef.resultId))) {
    if (!primary.has(value.key)) primary.set(value.key, []);
    primary.get(value.key).push(value);
  }
  const selected = [...primary.values()].map(values => {
    const first = values[0];
    first.row.predictionRef.selection = "earliest_retained_publication";
    first.row.predictionRef.selectionLabel = "보존된 발행본 중 첫 전망";
    first.row.predictionRef.retainedPublicationCount = values.length;
    return compare(first, observationSnapshots, cutoff);
  });
  const rows = [...selected, ...excluded].sort((a, b) => JSON.stringify([a.regionKey, a.targetPeriod, a.issueMonth, a.kind, a.groupKey, a.metricKey, a.predictionRef.resultId, a.reasonCode])
    .localeCompare(JSON.stringify([b.regionKey, b.targetPeriod, b.issueMonth, b.kind, b.groupKey, b.metricKey, b.predictionRef.resultId, b.reasonCode])));
  const scores = scoresFor(rows), summaryCounts = { total: rows.length, compared: rows.filter(row => row.status === "compared").length,
    pending: rows.filter(row => row.status === "pending").length, excluded: rows.filter(row => row.status === "excluded").length };
  const fingerprintRows = rows.map(row => ({ ...row, actualRef: row.actualRef ? { ...row.actualRef, receivedAt: undefined, snapshotAt: undefined, sourceFingerprint: undefined } : null }));
  return { version: VERSION, calculationVersion: VERSION, evaluatedThrough: cutoff,
    status: summaryCounts.compared ? summaryCounts.compared === summaryCounts.total ? "ready" : "partial" : "missing", groups: [], rows, scores, summaryCounts,
    sourceFingerprint: hash({ version: VERSION, rows: fingerprintRows, scores }),
    selectionPolicy: "earliest_retained_publication", actualPolicy: "latest_official_as_of", networkAttempted: false,
    notes: ["보존된 발행본 중 첫 전망을 선택하며 사후 재계산과 공식 관측은 전망으로 평가하지 않습니다.",
      "이번 달 예상과 다음 달 전망, 지표·단위·제공기관·모델별 오차를 분리합니다. 표본 수가 적으면 정확도를 일반화할 수 없습니다.",
      "정상 관측 0은 포함하며 오류·부분·누락·이전자료 사용은 검증 대기입니다. 실제값 합계가 0이면 WAPE를 계산하지 않습니다.",
      "검색 정규화 기간이나 응답 묶음이 다르면 지수의 수치를 직접 비교하지 않습니다."] };
}

module.exports = { buildRegionalOutlookEvaluation, VERSION };
