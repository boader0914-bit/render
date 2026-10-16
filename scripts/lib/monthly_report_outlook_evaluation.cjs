"use strict";

// This adapter projects an already saved evaluation. It has no calculator,
// publication journal, provider or queue dependency. Report publication freezes
// this bounded projection separately from the lodging observation cutoff.
const SCHEMA_VERSION = 1;
const MAX_REGIONS = 24;
const MAX_ROWS = 40;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const ID = /^[A-Za-z0-9_:-]{1,120}$/;
const STATUSES = new Set(["compared", "pending", "excluded"]);
const REASONS = Object.freeze({
  TARGET_MONTH_OPEN: "대상월이 아직 끝나지 않았습니다.",
  OFFICIAL_OBSERVATION_NOT_AVAILABLE: "후속 공식 관측자료가 아직 없습니다.",
  OFFICIAL_PUBLICATION_PENDING: "공식자료 공표를 기다리고 있습니다.",
  ACTUAL_OBSERVATION_PARTIAL: "공식 관측자료가 일부만 확보됐습니다.",
  ACTUAL_OBSERVATION_ERROR: "공식 관측자료 확인이 실패해 검증을 기다립니다.",
  ACTUAL_OBSERVATION_MISSING: "공식 관측자료가 누락돼 검증을 기다립니다.",
  STALE_ACTUAL_OBSERVATION: "이전 공식자료를 사용 중이어서 검증을 기다립니다.",
  SEARCH_NORMALIZATION_NOT_COMPARABLE: "검색어·조회기간의 정규화 기준이 달라 검색지수를 비교할 수 없습니다.",
  UNSUPPORTED_SEARCH_NORMALIZATION: "검색지수 정규화 기준을 확인할 수 없습니다.",
  PUBLICATION_NOT_PROVEN: "당시 발행을 확인할 보존 기록이 없습니다.",
  FORECAST_NOT_AVAILABLE_AS_OF: "검증 기준시점 뒤에 생성·발행된 전망입니다.",
  ISSUE_TIME_MISMATCH: "발행 기준월과 생성·발행시각이 맞지 않습니다.",
  TARGET_KIND_MISMATCH: "당시 이번 달·다음 달과 대상월이 맞지 않습니다.",
  INPUT_PERIOD_NOT_VERIFIABLE: "당시 사용한 자료의 기준기간을 검증할 수 없습니다.",
  INPUT_REGION_MISMATCH: "당시 사용한 자료의 지역이 다릅니다.",
  INPUT_RECEIVED_AFTER_PUBLICATION: "발행 이후 받은 자료가 포함돼 비교에서 제외합니다.",
  ALREADY_OBSERVED_AT_ISSUE: "발행 당시 이미 공식값이어서 예측 검증 대상이 아닙니다.",
  FORECAST_NOT_PRODUCED: "당시 산출된 전망값이 없습니다.",
  INVALID_FORECAST_VALUE: "당시 전망값이 유효하지 않습니다.",
  PUBLISHED_AFTER_TARGET_CLOSED: "대상월이 끝난 뒤 발행된 전망입니다.",
  UNSUPPORTED_FORECAST_METADATA: "당시 전망의 지표·발행 조건을 확인할 수 없습니다.",
  UNSUPPORTED_FORECAST_UNIT: "당시 전망의 단위가 검증 기준과 다릅니다.",
  UNSUPPORTED_ACTUAL_TIMESTAMP: "공식자료 확인시각을 검증할 수 없습니다.",
  DUPLICATE_ACTUAL_OBSERVATION: "같은 월에 공식 관측자료가 중복돼 있습니다.",
  ACTUAL_SCOPE_PERIOD_MISMATCH: "공식 관측자료의 기준기간이 다릅니다.",
  UNSUPPORTED_ACTUAL_METADATA: "공식 관측자료의 지표 조건을 확인할 수 없습니다.",
  PROVIDER_MISMATCH: "전망과 공식 관측자료의 제공기관이 다릅니다.",
  UNIT_MISMATCH: "전망과 공식 관측자료의 단위가 다릅니다.",
  UNSUPPORTED_ACTUAL_PERIOD_TYPE: "월간 지표끼리 비교할 수 있는 자료가 아닙니다.",
  ACTUAL_RECEIVED_BEFORE_MONTH_CLOSED: "대상월 마감 전 자료여서 공식값으로 비교하지 않습니다.",
  INVALID_ACTUAL_VALUE: "공식 관측값이 유효하지 않습니다.",
  CONFLICTING_ACTUAL_OBSERVATIONS: "같은 시점의 공식 관측값이 서로 다릅니다.",
  DUPLICATE_FORECAST_OBSERVATION: "같은 지표·대상월의 전망이 중복돼 있습니다.",
  CONFLICTING_FORECAST_REFERENCE: "같은 전망 발행 번호에 다른 값이 보존돼 있습니다.",
  ZERO_ACTUAL_DENOMINATOR: "실제값이 0이므로 오차율을 계산하지 않습니다.",
  NO_SAVED_EVALUATION: "작성 시점에 저장된 전망 검증 자료가 없습니다.",
  NO_TARGET_MONTH_FORECAST: "저장된 검증 자료에 이 보고월을 대상으로 한 전망이 없습니다.",
  EVALUATION_READ_FAILED: "저장된 전망 검증 자료를 읽지 못했습니다.",
  EVALUATION_UNAVAILABLE: "전망 검증 기능이 연결되지 않았습니다.",
  EVALUATION_AFTER_AS_OF: "리포트 작성시점 이후의 검증 자료여서 연결하지 않았습니다.",
  INVALID_SAVED_EVALUATION: "저장된 전망 검증 자료의 조건을 확인해야 합니다.",
  REGION_LEVEL_UNSUPPORTED: "이 지역 단위의 전망을 다른 지역에서 합산하지 않았습니다.",
  INVALID_EVALUATION_ROW: "저장된 개별 검증 자료의 값이나 근거를 확인해야 합니다."
});
const text = (value, limit = 160) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, limit) : "";
const id = value => typeof value === "string" && ID.test(value) ? value : "";
const numeric = value => typeof value === "number" && Number.isFinite(value);
const nonnegative = value => numeric(value) && value >= 0;
const safeNumber = value => numeric(value) ? value : null;
function instant(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return null;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10) ? new Date(value).toISOString() : null;
}
const kstMonth = value => new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 7);
const shiftMonth = (value, shift) => new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5)) - 1 + shift, 1)).toISOString().slice(0, 7);
const reasonLabel = value => REASONS[value] || "비교 조건이나 자료를 확인해야 합니다.";
const safeError = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(value) ? value : "";

function predictionRef(reference) {
  if (!reference || typeof reference !== "object") return null;
  return { resultId: id(reference.resultId) || null, publishedAt: instant(reference.publishedAt), generatedAt: instant(reference.generatedAt),
    proof: ["journal", "saved_reference"].includes(reference.proof) ? reference.proof : null,
    coverage: ["recorded", "legacy_reference"].includes(reference.coverage) ? reference.coverage : null,
    inputLatestPeriod: MONTH.test(reference.inputLatestPeriod || "") ? reference.inputLatestPeriod : "",
    selection: reference.selection === "earliest_retained_publication" ? reference.selection : null,
    selectionLabel: reference.selection === "earliest_retained_publication" ? "보존된 발행본 중 첫 전망" : "",
    retainedPublicationCount: Number.isSafeInteger(reference.retainedPublicationCount) && reference.retainedPublicationCount > 0 ? reference.retainedPublicationCount : null };
}
function actualRef(reference) {
  if (!reference || typeof reference !== "object") return null;
  return { receivedAt: instant(reference.receivedAt), period: MONTH.test(reference.period || "") ? reference.period : "",
    sourceFingerprint: id(reference.sourceFingerprint) || null, snapshotAt: instant(reference.snapshotAt),
    receiptEvidence: ["source_timestamp", "snapshot_timestamp"].includes(reference.receiptEvidence) ? reference.receiptEvidence : null,
    policy: reference.policy === "latest_official_as_of" ? reference.policy : null,
    firstObservedValue: nonnegative(reference.firstObservedValue) ? reference.firstObservedValue : null, revised: reference.revised === true,
    sourceBatchId: id(reference.sourceBatchId) || null, normalizationPeriod: text(reference.normalizationPeriod, 64) || null };
}
function projectRow(input, regionKey, reportMonth, asOfAt) {
  const row = { regionKey, issueMonth: MONTH.test(input.issueMonth || "") ? input.issueMonth : "", targetPeriod: reportMonth,
    kind: ["current", "next"].includes(input.kind) ? input.kind : "", groupKey: id(input.groupKey), metricKey: id(input.metricKey),
    label: text(input.label), unit: text(input.unit, 40), provider: text(input.provider), modelVersion: id(input.modelVersion),
    status: STATUSES.has(input.status) ? input.status : "excluded", reasonCode: safeError(input.reasonCode),
    forecastValue: nonnegative(input.forecastValue) ? input.forecastValue : null,
    actualValue: null, difference: null, absoluteError: null, errorPct: null,
    percentageReasonCode: "", predictionRef: predictionRef(input.predictionRef), actualRef: null };
  const forecast = row.predictionRef;
  const validForecast = forecast?.resultId && forecast.publishedAt && forecast.generatedAt && forecast.proof && forecast.coverage
    && forecast.publishedAt <= asOfAt && forecast.generatedAt <= forecast.publishedAt
    && kstMonth(forecast.publishedAt) === row.issueMonth && kstMonth(forecast.generatedAt) === row.issueMonth
    && row.issueMonth === shiftMonth(reportMonth, row.kind === "next" ? -1 : 0);
  let valid = input.regionKey === regionKey && STATUSES.has(input.status);
  if (row.status !== "excluded") valid = valid && row.kind && row.groupKey && row.metricKey && row.unit && row.provider && row.modelVersion
    && validForecast && nonnegative(input.forecastValue);
  else if (!REASONS[row.reasonCode]) row.reasonCode = "INVALID_EVALUATION_ROW";
  if (row.status === "pending" && !REASONS[row.reasonCode]) valid = false;
  if (!validForecast) row.forecastValue = null;
  if (row.status === "compared") {
    const actual = actualRef(input.actualRef);
    valid = valid && nonnegative(input.actualValue) && numeric(input.difference) && nonnegative(input.absoluteError)
      && (input.errorPct === null || nonnegative(input.errorPct)) && actual?.receivedAt && actual.receivedAt <= asOfAt
      && actual.period === reportMonth && actual.policy === "latest_official_as_of"
      && (!actual.snapshotAt || actual.snapshotAt <= asOfAt);
    if (valid) Object.assign(row, { actualValue: input.actualValue, difference: input.difference, absoluteError: input.absoluteError,
      errorPct: input.actualValue === 0 ? null : safeNumber(input.errorPct),
      percentageReasonCode: input.actualValue === 0 ? "ZERO_ACTUAL_DENOMINATOR" : safeError(input.percentageReasonCode), actualRef: actual, reasonCode: "" });
  }
  if (!valid) Object.assign(row, { status: "excluded", reasonCode: "INVALID_EVALUATION_ROW", forecastValue: null,
    actualValue: null, difference: null, absoluteError: null, errorPct: null, percentageReasonCode: "", actualRef: null });
  else if (row.status !== "compared" && !row.reasonCode) row.reasonCode = "INVALID_EVALUATION_ROW";
  row.reasonLabel = row.reasonCode ? reasonLabel(row.reasonCode) : "";
  return row;
}
function selectedRegions(request, catalog) {
  const companies = Array.isArray(catalog?.companies) ? catalog.companies : [], regions = Array.isArray(catalog?.regions) ? catalog.regions : [];
  const keys = request.type === "region" ? [request.targetId] : request.type === "company"
    ? companies.filter(company => company.companyId === request.targetId).map(company => company.regionKey)
    : companies.map(company => company.regionKey);
  const basis = request.type === "region" ? "selected_region" : request.type === "company" ? "company_actual_location" : "observed_companies_actual_locations";
  return [...new Set(keys.filter(key => id(key)))].sort().map(regionKey => {
    const region = regions.find(item => item.id === regionKey);
    return { regionKey, regionLabel: text(region?.label || companies.find(company => company.regionKey === regionKey)?.regionLabel || regionKey),
      basis, level: region?.level || "" };
  });
}

function createMonthlyReportOutlookEvaluation({ evaluationService, now = () => new Date() } = {}) {
  return async function readMonthlyReportOutlookEvaluation(request, catalog = {}, options = {}) {
    if (!request || !["company", "keyword", "region"].includes(request.type) || !MONTH.test(request.month || "")) throw new TypeError("A valid monthly report request is required");
    const currentAt = new Date(now()).toISOString(), asOfAt = options.asOfAt === undefined ? currentAt : instant(options.asOfAt);
    if (!asOfAt || asOfAt > currentAt) throw new TypeError("A valid report creation timestamp is required");
    const evaluationMonth = kstMonth(asOfAt), selected = selectedRegions(request, catalog), warnings = [];
    const scopedCompanies = request.type === "region" ? [] : (Array.isArray(catalog.companies) ? catalog.companies : [])
      .filter(company => request.type === "keyword" || company.companyId === request.targetId);
    const unmappedCompanyCount = new Set(scopedCompanies.filter(company => !id(company.regionKey)).map((company, index) => company.companyId || `unmapped_${index}`)).size;
    const result = { schemaVersion: SCHEMA_VERSION, reportMonth: request.month, cutoffDate: text(request.cutoffDate, 10), asOfAt,
      selectionBasis: "target_month", temporalBasis: "saved_evaluation_at_report_creation",
      temporalLabel: "작성 시점에 저장된 사후 검증 · 예약 관측 마감과 별도", status: "missing",
      selectionCoverage: { selectedRegionCount: selected.length, includedRegionCount: Math.min(selected.length, MAX_REGIONS),
        omittedRegionCount: Math.max(0, selected.length - MAX_REGIONS), unmappedCompanyCount },
      regions: [], warnings, networkAttempted: false };
    warnings.push("전망 검증은 리포트 작성 시점에 저장된 사후 자료입니다. 예약 관측 마감일 당시 알려진 결과를 뜻하지 않으며, 발행한 리포트의 검증 내용은 고정됩니다.");
    if (request.type === "keyword") warnings.push("키워드 검색 범위와 관측 업체의 실제 소재지는 구분합니다. 전망 검증은 실제 소재지별로 표시하며 지역 간 합산하지 않습니다.");
    if (!selected.length) warnings.push("대상 업체의 실제 소재지가 확인되지 않아 지역 전망 검증을 연결하지 않았습니다.");
    if (unmappedCompanyCount) warnings.push(`관측 업체 ${unmappedCompanyCount}곳은 실제 소재지가 확인되지 않아 해당 업체의 지역 전망 검증을 연결하지 않았습니다.`);
    if (selected.length > MAX_REGIONS) warnings.push(`실제 소재지가 ${MAX_REGIONS}개를 넘어 일부 지역의 검증만 표시합니다.`);
    for (const region of selected.slice(0, MAX_REGIONS)) {
      const block = { regionKey: region.regionKey, regionLabel: region.regionLabel, basis: region.basis,
        status: "missing", reasonCode: "", reasonLabel: "", summaryCounts: null, reasonCounts: [], rows: [], source: null, truncated: false };
      const missing = code => { block.reasonCode = code; block.reasonLabel = reasonLabel(code); return block; };
      if (region.level && region.level !== "local") { result.regions.push(missing("REGION_LEVEL_UNSUPPORTED")); continue; }
      if (typeof evaluationService?.get !== "function") { result.regions.push(missing("EVALUATION_UNAVAILABLE")); continue; }
      try {
        const saved = await evaluationService.get({ regionKey: region.regionKey, months: 13 });
        if (saved?.networkAttempted === true || saved?.snapshot?.networkAttempted === true) throw Object.assign(new Error("Cache-only evaluation reader required"), { code: "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY" });
        const snapshot = saved?.snapshot;
        block.source = { resultId: id(snapshot?.resultId) || null, generatedAt: instant(snapshot?.generatedAt), evaluatedThrough: instant(snapshot?.evaluatedThrough),
          evaluationScopeMonth: MONTH.test(snapshot?.scope?.month || "") ? snapshot.scope.month : "",
          jobStatus: ["queued", "running", "processing", "completed", "failed", "interrupted", "superseded"].includes(saved?.job?.status) ? saved.job.status : "",
          jobErrorCode: safeError(saved?.job?.errorCode), storageErrorCode: safeError(saved?.storage?.errorCode),
          selectionPolicy: snapshot?.selectionPolicy === "earliest_retained_publication" ? snapshot.selectionPolicy : "",
          actualPolicy: snapshot?.actualPolicy === "latest_official_as_of" ? snapshot.actualPolicy : "" };
        if (!snapshot) { result.regions.push(missing("NO_SAVED_EVALUATION")); continue; }
        if (snapshot.scope?.regionKey !== region.regionKey || snapshot.scope?.month !== evaluationMonth || snapshot.scope?.months !== 13
          || snapshot.schemaVersion !== 1 || snapshot.calculationVersion !== "regional-outlook-evaluation-storage-v1"
          || !block.source.resultId || !block.source.generatedAt || !block.source.evaluatedThrough || !Array.isArray(snapshot.rows)
          || block.source.selectionPolicy !== "earliest_retained_publication" || block.source.actualPolicy !== "latest_official_as_of") {
          result.regions.push(missing("INVALID_SAVED_EVALUATION")); continue;
        }
        if (block.source.generatedAt > asOfAt || block.source.evaluatedThrough > asOfAt) { result.regions.push(missing("EVALUATION_AFTER_AS_OF")); continue; }
        const rows = snapshot.rows.filter(row => row && row.targetPeriod === request.month)
          .map(row => projectRow(row, region.regionKey, request.month, asOfAt));
        block.summaryCounts = { total: rows.length, compared: rows.filter(row => row.status === "compared").length,
          pending: rows.filter(row => row.status === "pending").length, excluded: rows.filter(row => row.status === "excluded").length };
        const counts = new Map();
        for (const row of rows) if (row.reasonCode) counts.set(row.reasonCode, (counts.get(row.reasonCode) || 0) + 1);
        block.reasonCounts = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([code, count]) => ({ code, label: reasonLabel(code), count }));
        block.rows = rows.slice(0, MAX_ROWS); block.truncated = rows.length > MAX_ROWS;
        if (!rows.length) missing("NO_TARGET_MONTH_FORECAST");
        else block.status = block.summaryCounts.compared === rows.length ? "ready" : block.summaryCounts.compared ? "partial" : block.summaryCounts.pending ? "pending" : "excluded";
        if (block.source.storageErrorCode || ["failed", "interrupted"].includes(block.source.jobStatus)) warnings.push(`${region.regionLabel}: 최근 검증 갱신에 문제가 있어 마지막 정상 저장본과 갱신 상태를 함께 표시합니다.`);
        result.regions.push(block);
      } catch (error) {
        if (error?.code === "MONTHLY_CONTEXT_MUST_BE_CACHE_ONLY") throw error;
        result.regions.push(missing("EVALUATION_READ_FAILED"));
      }
    }
    const available = result.regions.filter(region => region.summaryCounts !== null);
    result.status = available.length && available.every(region => region.status === "ready") && available.length === result.regions.length ? "ready"
      : available.some(region => ["ready", "partial"].includes(region.status)) ? "partial"
        : available.some(region => region.status === "pending") ? "pending" : "missing";
    if (result.status === "ready" && (result.selectionCoverage.omittedRegionCount || unmappedCompanyCount)) result.status = "partial";
    return result;
  };
}

module.exports = { createMonthlyReportOutlookEvaluation, SCHEMA_VERSION, MAX_REGIONS, MAX_ROWS, reasonLabel };
