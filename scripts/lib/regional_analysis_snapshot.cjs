"use strict";

const crypto = require("node:crypto");
const { DEFINITIONS } = require("./kosis.cjs");

const VERSION = "regional-observations-v1";
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const shiftMonth = (month, offset) => {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7);
};
const monthsEnding = (month, count) => Array.from({ length: count }, (_, i) => shiftMonth(month, i + 1 - count));
const TOURISM = [
  ["visitors", "지역 방문자", "collectVisitorHistory", [["averageDailyVisitors", "일평균 방문자", "명"], ["visitorDays", "월간 방문자 누계", "인일"]]],
  ["demandStrength", "체류·소비 지수", "collectDemandStrengthHistory", [["stayOverall", "체류 지수", "지수"], ["spendOverall", "소비 지수", "지수"]]],
  ["resourceDemand", "관광자원 수요 지수", "collectResourceDemandHistory", [["service", "서비스 수요", "지수"], ["culture", "문화 수요", "지수"]]],
  ["diversity", "관광 다양성 지수", "collectDiversityHistory", [["visitor", "관광객 다양성", "지수"], ["spend", "소비 다양성", "지수"], ["international", "국제 관광 다양성", "지수"]]]
];
const SAFE = new Set(["NO_DATA", "NOT_COLLECTED", "PUBLICATION_PENDING", "PARTIAL_DATA", "MISSING_VALUES", "AUTH_ERROR", "MISSING_KEY", "QUOTA_EXCEEDED", "TIMEOUT", "NETWORK_ERROR", "CACHE_READ_ERROR", "CACHE_WRITE_ERROR", "INVALID_RESPONSE", "REGION_MISMATCH", "PERIOD_MISMATCH", "COOLDOWN", "PROVIDER_FAILED", "PROVIDER_UNAVAILABLE", "REGIONAL_SOURCE_BUSY", "MAPPING_MISSING"]);
const safeCode = (value, fallback = "PROVIDER_FAILED") => SAFE.has(value) ? value : fallback;
const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
function safeDiagnostics(value) {
  const httpStatus = value?.httpStatus;
  const providerCode = value?.providerCode ?? value?.apiCode;
  return { ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof providerCode === "string" && /^\d{2,3}$/.test(providerCode) ? { providerCode } : {}) };
}
function assertCache(result) {
  if (result?.networkAttempted === true || Number(result?.collection?.networkAttemptedMonths || 0) > 0 || Number(result?.collection?.operationCallsAttempted || 0) > 0) {
    throw Object.assign(new Error("Regional analysis readers must be cache only"), { code: "REGIONAL_CACHE_ONLY_VIOLATION" });
  }
}
function stateOf(point) {
  if (point?.status === "complete" || point?.status === "observed") return "observed";
  if (point?.status === "publication_pending" || ["period_not_closed", "publication_pending", "not_published"].includes(point?.reason)) return "publication_pending";
  if (point?.status === "partial") return "partial";
  if (["failed", "error", "blocked"].includes(point?.status)) return "error";
  return "missing";
}
function metricState(point, groupKey, field, value) {
  const base = stateOf(point);
  if (!["observed", "partial"].includes(base)) return base;
  if (groupKey === "demandStrength") {
    const status = field === "stayOverall" ? point?.stayStatus : point?.spendStatus;
    if (["failed", "error", "blocked"].includes(status)) return "error";
    if (["ok", "complete", "observed"].includes(status) && numeric(value)) return "observed";
  }
  if (["resourceDemand", "diversity"].includes(groupKey)) {
    const operation = point?.operations?.[field], quality = operation?.quality || {};
    const badQuality = ["conflicting_rows", "region_or_period_mismatch", "invalid_rows"].includes(quality.status)
      || [quality.invalidRowCount, quality.mismatchedRowCount, quality.conflictCount].some(count => Number(count) > 0);
    if (["failed", "error", "blocked"].includes(operation?.status) || badQuality) return "error";
    if (operation?.status === "ok" && numeric(value)) return "observed";
    const overall = (operation?.metrics || []).find(metric => metric.code === operation.overallCode);
    if (operation?.status === "partial" && quality.overallComplete === true && numeric(value)
      && operation.overallValue === value && overall?.value === value) return "observed";
  }
  return base;
}
function pointProvenance(point, status, { errorCode = "", duplicate = false, field = "", result = null, requestedPeriod = "" } = {}) {
  const operation = point?.operations?.[field];
  const evidence = [operation, operation?.quality, point, point?.quality, point?.diagnostics,
    ...(result?.collection?.refreshErrors || []).filter(row => row.yearMonth === requestedPeriod)].filter(Boolean);
  const httpStatus = evidence.map(item => item.httpStatus).find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const providerCode = evidence.map(item => item.apiCode ?? item.providerCode).find(value => typeof value === "string" && /^\d{2,3}$/.test(value));
  const diagnostics = { ...(httpStatus ? { httpStatus } : {}), ...(providerCode ? { providerCode } : {}) };
  const mappings = { monthly_cache_missing: "NOT_COLLECTED", cache_refresh_required: "NOT_COLLECTED", period_not_closed: "PUBLICATION_PENDING",
    publication_pending: "PUBLICATION_PENDING", not_published: "PUBLICATION_PENDING", missing_service_key: "MISSING_KEY", disabled: "PROVIDER_UNAVAILABLE",
    missing_endpoint: "PROVIDER_UNAVAILABLE", invalid_endpoint: "PROVIDER_UNAVAILABLE", untrusted_endpoint: "PROVIDER_UNAVAILABLE", fetch_unavailable: "PROVIDER_UNAVAILABLE",
    requested_region_not_matched: "REGION_MISMATCH", region_not_matched: "REGION_MISMATCH", region_code_verify_required: "MAPPING_MISSING",
    schema_error: "INVALID_RESPONSE", invalid_response: "INVALID_RESPONSE", page_number_mismatch: "INVALID_RESPONSE", total_count_changed: "INVALID_RESPONSE",
    incomplete_pagination: "PARTIAL_DATA", page_limit_exceeded: "PARTIAL_DATA", gateway_error: "PROVIDER_FAILED", api_error: "PROVIDER_FAILED", http_error: "PROVIDER_FAILED",
    timeout: "TIMEOUT", request_failed: "NETWORK_ERROR", evidence_write_failed: "CACHE_WRITE_ERROR", no_observation: "NO_DATA", empty_verified: "NO_DATA" };
  const reasons = [operation?.reason, field === "stayOverall" ? point?.stayReason : field === "spendOverall" ? point?.spendReason : "", point?.reason];
  const invalidQuality = ["conflicting_rows", "region_or_period_mismatch", "invalid_rows"].includes(operation?.quality?.status)
    || [operation?.quality?.invalidRowCount, operation?.quality?.mismatchedRowCount, operation?.quality?.conflictCount].some(count => Number(count) > 0);
  const diagnosed = httpStatus === 429 || providerCode === "22" ? "QUOTA_EXCEEDED"
    : [401, 403].includes(httpStatus) || ["20", "21", "30", "31", "32"].includes(providerCode) ? "AUTH_ERROR"
      : httpStatus >= 400 ? "PROVIDER_FAILED" : invalidQuality ? "INVALID_RESPONSE"
        : evidence.map(item => item.errorCode).find(code => SAFE.has(code)) || reasons.map(reason => mappings[reason]).find(Boolean) || (providerCode === "03" ? "NO_DATA" : "");
  const reasonCode = status === "observed" ? "" : duplicate ? "INVALID_RESPONSE" : errorCode || diagnosed
    || (status === "publication_pending" ? "PUBLICATION_PENDING" : "UNRECORDED_REASON");
  return { reasonCode, reasonEvidence: reasonCode === "UNRECORDED_REASON" ? "unknown" : "recorded", diagnostics,
    ...(point?.refreshFailed ? { refreshErrorCode: diagnosed && !["NO_DATA", "PUBLICATION_PENDING"].includes(diagnosed) ? diagnosed : "PROVIDER_FAILED" } : {}) };
}
function preparationDiagnostics(preparation) {
  const allowed = new Set(["visitors", "demandStrength", "resourceDemand", "diversity", "kosis", "searchTrend"]);
  const statuses = new Set(["ready", "complete", "completed", "partial", "missing", "failed", "error", "blocked", "publication_pending", "queued", "running", "interrupted", "stale"]);
  const safePeriod = value => typeof value === "string" && (/^20\d{2}(0[1-9]|1[0-2])$/.test(value) || MONTH.test(value)) ? value : "";
  const subset = step => ({ status: statuses.has(step?.status) ? step.status : "missing", errorCode: SAFE.has(step?.errorCode) ? step.errorCode : step?.errorCode ? "PROVIDER_FAILED" : "",
    startedAt: stamp(step?.startedAt), finishedAt: stamp(step?.finishedAt), retrievedAt: stamp(step?.retrievedAt),
    networkAttempted: typeof step?.networkAttempted === "boolean" ? step.networkAttempted : null,
    requestedPeriod: safePeriod(step?.requestedPeriod), period: safePeriod(step?.period), latestRequestedPeriod: safePeriod(step?.latestRequestedPeriod),
    latestRequestedStatus: statuses.has(step?.latestRequestedStatus) ? step.latestRequestedStatus : "",
    latestRequestedErrorCode: SAFE.has(step?.latestRequestedErrorCode) ? step.latestRequestedErrorCode : step?.latestRequestedErrorCode ? "PROVIDER_FAILED" : "" });
  if (!preparation) return null;
  return { status: statuses.has(preparation.status) ? preparation.status : "partial", steps: (preparation.steps || []).filter(step => allowed.has(step?.key)).map(step => ({
    key: step.key, ...subset(step), periods: (Array.isArray(step.periods) ? step.periods : []).slice(-36).map(subset) })) };
}
function delta(current, previous, unit) {
  if (!numeric(current) || !numeric(previous)) return { value: null, kind: "unavailable" };
  if (["지수", "상대지수"].includes(unit)) return { value: current - previous, kind: "index_difference" };
  return previous === 0 ? { value: null, kind: "zero_baseline" } : { value: (current - previous) / previous * 100, kind: "percent" };
}
function metricWindow(key, label, unit, points, end, count, includeHistory = false) {
  // A delayed source ends at its own latest normal month, never a fabricated
  // common month. Retain missing months inside that window.
  const latest = points.filter(p => p.status === "observed" && numeric(p.value) && p.period <= end).at(-1);
  const targetEnd = latest?.period || end;
  const rows = monthsEnding(targetEnd, count).map(period => points.find(p => p.period === period) || { period, status: "missing", value: null, retrievedAt: "" });
  const valueAt = period => rows.find(row => row.period === period && row.status === "observed")?.value ?? null;
  return { key, label, unit, rows, requestedThrough: end,
    requestedPoint: points.find(point => point.period === end) || { period: end, status: "missing", value: null, retrievedAt: "", reasonCode: "UNRECORDED_REASON", reasonEvidence: "unknown" },
    ...(includeHistory ? { historyRows: points.filter(point => MONTH.test(point.period) && point.period <= end).slice(-36) } : {}), latestPeriod: latest?.period || "", latestValue: latest?.value ?? null,
    availableMonths: rows.filter(row => row.status === "observed").length, expectedMonths: count,
    mom: delta(latest?.value, valueAt(shiftMonth(targetEnd, -1)), unit),
    yoy: delta(latest?.value, valueAt(shiftMonth(targetEnd, -12)), unit) };
}
function finishGroup(group, metrics, end, count) {
  const availableMonths = Math.min(...metrics.map(metric => metric.availableMonths));
  const hasData = metrics.some(metric => metric.availableMonths > 0);
  const latestPeriods = [...new Set(metrics.map(metric => metric.latestPeriod).filter(Boolean))].sort();
  return { ...group, metrics, status: availableMonths === count ? "ready" : hasData ? "partial" : group.errorCode && !["NO_DATA", "PUBLICATION_PENDING"].includes(group.errorCode) ? "failed" : group.errorCode === "PUBLICATION_PENDING" ? "publication_pending" : "missing",
    latestPeriod: latestPeriods.at(-1) || "", latestPeriods, availableMonths, expectedMonths: count,
    requestedThrough: end, publicationLagMonths: latestPeriods.length ? (Number(end.slice(0, 4)) - Number(latestPeriods.at(-1).slice(0, 4))) * 12 + Number(end.slice(5)) - Number(latestPeriods.at(-1).slice(5)) : null,
    errorCode: group.errorCode || (availableMonths === count ? "" : hasData ? "PARTIAL_DATA" : "NO_DATA") };
}

function createRegionalAnalysisSnapshotBuilder({ tourismCollector, kosisService, searchTrendService, prepare, now = () => new Date(), includeHistory = false }) {
  return async function buildSnapshot(scope, { collectMissing = false } = {}) {
    let preparation = null;
    if (collectMissing) {
      if (typeof prepare !== "function") throw Object.assign(new Error("Preparation unavailable"), { code: "REGIONAL_PREPARATION_UNAVAILABLE" });
      preparation = await prepare(scope);
    }
    const groups = [], end = scope.month, count = scope.months;
    // Extra stored history lets a publication-delayed source supply 13 normal
    // months. This is a cache-only read in a background build, never a UI GET.
    const readCount = includeHistory ? 36 : Math.min(36, count + 12);
    const input = { regionKey: scope.regionKey, regionKeys: [scope.regionKey], endYearMonth: end.replace("-", ""), months: readCount,
      analysisMonths: readCount, collectMissing: false, refresh: false, force: false, maxPagesPerOperation: 1, concurrency: 1 };
    const diagnostics = key => preparation?.steps?.find(step => step.key === key);
    for (const [key, label, method, fields] of TOURISM) {
      let result, errorCode = "";
      try {
        if (typeof tourismCollector?.[method] !== "function") throw { code: "PROVIDER_UNAVAILABLE" };
        result = await tourismCollector[method](input); assertCache(result);
      } catch (error) {
        if (error.code === "REGIONAL_CACHE_ONLY_VIOLATION") throw error;
        errorCode = safeCode(error.code);
      }
      const matching = (result?.regions || []).filter(region => region.regionKey === scope.regionKey);
      const validRegion = !result || (key === "visitors" ? matching.length === 1 : result.region?.regionKey === scope.regionKey);
      if (!validRegion) errorCode = "REGION_MISMATCH";
      if (result?.period?.endYearMonth && result.period.endYearMonth !== input.endYearMonth) errorCode = "PERIOD_MISMATCH";
      const raw = errorCode ? [] : key === "visitors" ? matching[0]?.series || [] : result?.series || [];
      const periods = monthsEnding(end, readCount);
      const metrics = fields.map(([field, name, unit]) => metricWindow(field, name, unit, periods.map(period => {
        const matches = raw.filter(point => point.yearMonth === period.replace("-", ""));
        const point = matches.length === 1 ? matches[0] : null;
        const value = ["resourceDemand", "diversity"].includes(key) ? point?.values?.[field] : point?.[field];
        const status = errorCode || matches.length > 1 ? "error" : metricState(point, key, field, value);
        let actualStatus = status === "observed" && !numeric(value) ? "missing" : status;
        const provenance = pointProvenance(point, actualStatus, { errorCode: errorCode || (status === "observed" && !numeric(value) ? "MISSING_VALUES" : ""),
          duplicate: matches.length > 1, field, result, requestedPeriod: period.replace("-", "") });
        if (actualStatus === "missing" && provenance.reasonCode === "PUBLICATION_PENDING") actualStatus = "publication_pending";
        else if (actualStatus === "missing" && SAFE.has(provenance.reasonCode) && !["NO_DATA", "NOT_COLLECTED", "MISSING_VALUES", "PARTIAL_DATA"].includes(provenance.reasonCode)) actualStatus = "error";
        return { period, value: actualStatus === "observed" ? value : null, status: actualStatus, retrievedAt: stamp(point?.collectedAt), ...provenance };
      }), end, count, includeHistory));
      const step = diagnostics(key);
      const requested = metrics.map(metric => metric.requestedPoint);
      const latestRequestedStatus = requested.every(point => point.status === "observed") ? "ready" : requested.some(point => point.status === "observed") ? "partial"
        : requested.some(point => point.status === "error") ? "failed" : requested.some(point => point.status === "publication_pending") ? "publication_pending"
          : requested.some(point => point.status === "partial") ? "partial" : "missing";
      groups.push(finishGroup({ key, label, category: "tourism", provider: "한국관광공사", periodType: "M", errorCode: errorCode || (step?.errorCode ? safeCode(step.errorCode) : ""),
        diagnostics: safeDiagnostics(step?.diagnostics), latestRequestedPeriod: step?.latestRequestedPeriod || end.replace("-", ""),
        latestRequestedStatus: step?.latestRequestedStatus || latestRequestedStatus, latestRequestedErrorCode: step?.latestRequestedErrorCode ? safeCode(step.latestRequestedErrorCode)
          : requested.find(point => SAFE.has(point.reasonCode))?.reasonCode || "",
        refreshedStatus: step?.status || "", retrievedAt: metrics.flatMap(metric => metric.rows.map(row => row.retrievedAt)).filter(Boolean).sort().at(-1) || "" }, metrics, end, count));
    }
    let kosis = null, kosisError = "";
    try { kosis = await kosisService.getRegion(scope.regionKey); assertCache(kosis); }
    catch (error) { if (error.code === "REGIONAL_CACHE_ONLY_VIOLATION") throw error; kosisError = safeCode(error.code); }
    if (kosis && kosis.region?.regionKey !== scope.regionKey) { kosis = null; kosisError = "REGION_MISMATCH"; }
    const datasets = DEFINITIONS.map(definition => {
      const matches = (kosis?.datasets || []).filter(dataset => dataset.key === definition.key);
      const dataset = matches.length === 1 ? matches[0] : null;
      const validPeriod = definition.periodType === "Y" ? /^20\d{2}$/.test(dataset?.period || "") : /^20\d{2}(0[1-9]|1[0-2])$/.test(dataset?.period || "");
      const period = validPeriod ? definition.periodType === "Y" ? dataset.period : `${dataset.period.slice(0, 4)}-${dataset.period.slice(4)}` : "";
      const expected = definition.metrics.flatMap(metric => (definition.breakdowns || [null]).map(breakdown => ({ key: breakdown?.key || metric.key, label: breakdown?.label || metric.label, unit: metric.unit })));
      return { key: definition.key, label: definition.label, periodType: definition.periodType, period,
        retrievedAt: stamp(dataset?.retrievedAt), rows: expected.map(field => {
          const rows = (dataset?.rows || []).filter(row => row.key === field.key && row.unit === field.unit);
          const row = rows.length === 1 ? rows[0] : null;
          const observed = validPeriod && dataset?.periodType === definition.periodType && ["ready", "partial", "stale"].includes(dataset?.status) && row?.status === "observed" && numeric(row.value);
          const reasonCode = observed ? "" : kosisError || (SAFE.has(dataset?.errorCode) ? dataset.errorCode : SAFE.has(dataset?.error?.code) ? dataset.error.code : "")
            || (dataset && validPeriod ? "MISSING_VALUES" : "UNRECORDED_REASON");
          return { ...field, value: observed ? row.value : null, status: observed ? "observed" : "missing", reasonCode,
            reasonEvidence: reasonCode === "UNRECORDED_REASON" ? "unknown" : "recorded" };
        }) };
    });
    const kosisMetrics = datasets.flatMap(dataset => dataset.rows.map(row => ({ ...row, key: `${dataset.key}:${row.key}`, label: `${dataset.label} · ${row.label}`, periodType: dataset.periodType,
      latestPeriod: row.status === "observed" ? dataset.period : "", latestValue: row.value,
      rows: [{ period: dataset.period, status: row.status, value: row.value, retrievedAt: dataset.retrievedAt, reasonCode: row.reasonCode, reasonEvidence: row.reasonEvidence }] })));
    const kosisObserved = kosisMetrics.filter(metric => metric.latestValue !== null).length;
    groups.push({ key: "kosis", label: "인구·산업 통계", category: "background", provider: "KOSIS", periodType: "mixed", datasets, metrics: kosisMetrics,
      status: kosisObserved === kosisMetrics.length ? "ready" : kosisObserved ? "partial" : kosisError ? "failed" : "missing",
      latestPeriod: [...new Set(kosisMetrics.map(metric => metric.latestPeriod).filter(Boolean))].sort().join(" · "),
      availableMonths: null, expectedMonths: null, observedItems: kosisObserved, expectedItems: kosisMetrics.length,
      stale: kosis?.status === "stale" || datasets.some(dataset => (kosis?.datasets || []).find(item => item.key === dataset.key)?.status === "stale"),
      errorCode: kosisError || (kosis?.error?.code ? safeCode(kosis.error.code) : diagnostics("kosis")?.errorCode ? safeCode(diagnostics("kosis").errorCode) : kosisObserved === kosisMetrics.length ? "" : "MISSING_VALUES") });
    let trend = null, trendError = "";
    const trendCandidates = [];
    for (const months of [...new Set(includeHistory ? [24, count, 13, 12] : [count, 24, 12])]) {
      try {
        const candidate = await searchTrendService.get({ regionKey: scope.regionKey, month: end, months }); assertCache(candidate);
        if (candidate?.regionKey !== scope.regionKey || candidate.month !== end) throw { code: "REGION_MISMATCH" };
        if (candidate.partialMonth) throw { code: "PERIOD_MISMATCH" };
        if (includeHistory) {
          const points = (candidate.series || []).map(point => ({ ...point, period: String(point.period || "").slice(0, 7) }))
            .filter(point => MONTH.test(point.period) && point.period <= end);
          if (new Set(points.map(point => point.period)).size !== points.length) throw { code: "INVALID_RESPONSE" };
          const observed = points.filter(point => point.status === "observed" && numeric(point.value) && point.value <= 100);
          const periods = new Set(observed.map(point => point.period)), latest = [...periods].sort().at(-1) || "";
          const recentCount = latest ? [0, -1, -2].filter(offset => periods.has(shiftMonth(latest, offset))).length : 0;
          // Prefer a whole response that can support both forecast targets,
          // then the freshest normal month, then more normal history. Never
          // join separately normalised responses to fill another one's gaps.
          const forecastTargets = observed.length < 6 || !latest ? 0 : [1, 2].filter(offset => {
            const target = shiftMonth(end, offset);
            return latest >= shiftMonth(target, -3) && (recentCount >= 2 || periods.has(shiftMonth(target, -12)));
          }).length;
          trendCandidates.push({ candidate, observedCount: observed.length, latest, forecastTargets, window: months });
          continue;
        }
        if ((candidate.series || []).some(point => point.status === "observed" && numeric(point.value))) { trend = candidate; break; }
        if (!trend) trend = candidate;
      } catch (error) { if (error.code === "REGIONAL_CACHE_ONLY_VIOLATION") throw error; trendError = safeCode(error.code); }
    }
    if (includeHistory && trendCandidates.length) {
      trendCandidates.sort((a, b) => b.forecastTargets - a.forecastTargets || b.latest.localeCompare(a.latest)
        || b.observedCount - a.observedCount || b.window - a.window);
      const selected = trendCandidates[0]; trend = selected.candidate;
      // A failed larger cache does not taint a different, valid response.
      if (selected.observedCount) trendError = "";
    }
    const sourceTrendReason = trendError || (SAFE.has(trend?.errorCode) ? trend.errorCode : "")
      || (diagnostics("searchTrend")?.errorCode ? safeCode(diagnostics("searchTrend").errorCode) : "");
    const unavailableTrendState = sourceTrendReason === "PUBLICATION_PENDING" ? "publication_pending"
      : sourceTrendReason && !["NO_DATA", "MISSING_VALUES", "PARTIAL_DATA"].includes(sourceTrendReason) ? "error" : "missing";
    const trendRows = (trend?.series || []).map(point => {
      const observed = point.status === "observed" && numeric(point.value) && point.value <= 100;
      return { period: String(point.period || "").slice(0, 7), status: observed ? "observed" : unavailableTrendState, value: observed ? point.value : null,
        retrievedAt: stamp(trend?.retrievedAt), reasonCode: observed ? "" : sourceTrendReason || "MISSING_VALUES", reasonEvidence: "recorded" };
    }).filter(point => MONTH.test(point.period));
    if (new Set(trendRows.map(row => row.period)).size !== trendRows.length) { trendRows.length = 0; trendError = "INVALID_RESPONSE"; }
    const metric = metricWindow("interest", "검색 관심도", "상대지수", trendRows, end, count, includeHistory);
    if (metric.requestedPoint.reasonCode === "UNRECORDED_REASON" && sourceTrendReason) metric.requestedPoint = {
      period: end, status: unavailableTrendState, value: null, retrievedAt: "", reasonCode: sourceTrendReason, reasonEvidence: "recorded"
    };
    groups.push(finishGroup({ key: "searchTrend", label: "검색 트렌드", category: "search", provider: "네이버 데이터랩", periodType: "M", keyword: String(trend?.keyword || ""),
      normalizationPeriod: trend?.startDate && trend?.endDate ? `${trend.startDate} ~ ${trend.endDate}` : "",
      sourceBatchId: trend ? crypto.createHash("sha256").update(JSON.stringify([trend.regionKey, trend.keyword, trend.startDate, trend.endDate])).digest("hex") : "",
      errorCode: trendError || (diagnostics("searchTrend")?.errorCode ? safeCode(diagnostics("searchTrend").errorCode) : trend?.errorCode ? safeCode(trend.errorCode) : "") }, [metric], end, count));
    const hasData = groups.some(group => group.metrics.some(metric => metric.rows.some(row => row.status === "observed")));
    const payload = { calculationVersion: VERSION, indicatorVersion: VERSION, status: groups.every(group => group.status === "ready") ? "ready" : hasData ? "partial" : "missing", groups,
      builtAt: new Date(now()).toISOString(), scope: { ...scope }, networkAttempted: false,
      refreshRequested: collectMissing, preparation: preparation ? { id: preparation.id, status: preparation.status, finishedAt: preparation.finishedAt } : null,
      refreshDiagnostics: preparationDiagnostics(preparation),
      summary: { total: groups.length, ready: groups.filter(group => group.status === "ready").length, partial: groups.filter(group => group.status === "partial").length,
        failed: groups.filter(group => group.status === "failed").length, missing: groups.filter(group => ["missing", "publication_pending"].includes(group.status)).length },
      capabilities: { storedIndicators: true, spatialCatchment: false, monthlyForecast: false },
      notes: ["지표마다 최신 정상월을 기준으로 기간을 구성합니다. 미확보·오류는 0으로 채우지 않습니다.", "인구·산업은 실제 공표기간의 배경 통계이며 반경별 집계가 아닙니다.",
        "검색 관심도는 표시된 조회기간 안의 상대지수입니다. 서로 다른 조회 결과를 이어 붙이거나 합산하지 않습니다."] };
    // A repeated response with identical values is not a new calculation
    // version merely because its receive time changed.
    const fingerprintInput = JSON.parse(JSON.stringify({ scope, calculationVersion: VERSION, groups }, (key, value) => ["retrievedAt", "refreshedStatus"].includes(key) ? undefined : value));
    payload.sourceFingerprint = crypto.createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
    return payload;
  };
}

module.exports = { createRegionalAnalysisSnapshotBuilder, shiftMonth, metricWindow, VERSION };
