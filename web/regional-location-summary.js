(function (root) {
  "use strict";

  // Presentation only. The caller supplies the selected scope and the complete
  // RegionalAnalysis.savedResults response; this module never reads a legacy
  // location profile, the active lodging run, storage, or a provider.
  const VERSION = "regional-location-summary-v1";
  const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
  const DEFINITIONS = [
    { key: "visitor", groupKey: "visitors", title: "지역 방문자", tone: "is-visitor", metrics: [["averageDailyVisitors", "일평균 방문자", "명"], ["visitorDays", "월간 방문자 누계", "인일"]] },
    { key: "strength", groupKey: "demandStrength", title: "체류·소비", tone: "is-strength", metrics: [["stayOverall", "체류", "지수"], ["spendOverall", "소비", "지수"]] },
    { key: "resourceDemand", groupKey: "resourceDemand", title: "관광자원 수요", tone: "is-resource", metrics: [["service", "서비스", "지수"], ["culture", "문화", "지수"]] },
    { key: "diversity", groupKey: "diversity", title: "관광 다양성", tone: "is-diversity", metrics: [["visitor", "관광객", "지수"], ["spend", "소비", "지수"], ["international", "국제", "지수"]] }
  ];
  const text = value => typeof value === "string" ? value : "";
  const shift = (month, offset) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + offset, 1)).toISOString().slice(0, 7);
  let sharedContract;
  function contractApi() {
    if (root.RegionalDataContract) return root.RegionalDataContract;
    if (!sharedContract && typeof module !== "undefined" && module.exports && typeof require === "function") sharedContract = require("./regional-data-contract.js");
    return sharedContract;
  }
  function emptyCard(definition, status, reasonCode, scope) {
    // A successful, scope-validated empty read confirms no saved observations.
    // An unqueried, loading, failed, or mismatched read confirms no such count.
    const coverage = status === "missing" ? { expectedMonths: scope.months, completeMonths: 0, partialMonths: 0, missingMonths: scope.months,
      startPeriod: shift(scope.month, 1 - scope.months), endPeriod: scope.month, rate: 0 } : null;
    const items = definition.metrics.map(([key, label, unit]) => ({ key, label, unit, value: null, valueLabel: status === "loading" ? "확인 중" : status === "unqueried" ? "확인 전" : status === "mismatch" || status === "error" ? "확인 필요" : "관측 없음", period: "", status, reasonCode, coverage: coverage ? { ...coverage } : null }));
    return { key: definition.key, groupKey: definition.groupKey, title: definition.title, tone: definition.tone, status, items, metrics: items, coverage,
      note: status === "loading" ? "저장 결과 확인 중" : status === "unqueried" ? "저장 결과 확인 전" : status === "mismatch" ? "선택 지역·기준기간과 다른 저장 결과" : status === "error" ? "저장 결과 확인 실패" : "저장된 정상 관측 없음", coverageDetail: coverage ? "조회한 13개월의 저장 결과 미확보" : "" };
  }
  function emptyModel(scope, status, reasonCode = "", loading = false, error = "") {
    return { version: VERSION, status, reasonCode, scope, resultId: "", generatedAt: "", loading, error, stale: false,
      cards: DEFINITIONS.map(definition => emptyCard(definition, status, reasonCode, scope)) };
  }
  function scopeMatches(value, scope) { return value && value.regionKey === scope.regionKey && value.month === scope.month && value.months === scope.months; }
  function spatialOf(row, metric, group) {
    return row && Object.hasOwn(row, "spatialContract") ? row.spatialContract
      : metric && Object.hasOwn(metric, "spatialContract") ? metric.spatialContract : group?.spatialContract;
  }
  function spatialIssue(row, metric, group, regionKey) {
    // Unverified proof does not erase a normal observation. Explicit evidence
    // of a different geography must never supply this region's headline.
    const contracts = [group?.spatialContract, metric?.spatialContract, row?.spatialContract].filter(Boolean);
    if (contracts.some(contract => contract.requestedRegionKey && contract.requestedRegionKey !== regionKey)) return "REGION_MISMATCH";
    const status = spatialOf(row, metric, group)?.status;
    if (status === "response_mismatch") return "REGION_MISMATCH";
    if (["mapping_pending", "mapping_missing"].includes(status)) return text(row?.reasonCode || row?.errorCode) || (status === "mapping_pending" ? "MAPPING_PENDING" : "MAPPING_MISSING");
    return "";
  }
  function metricModel(definition, group, metric, scope, api, invalid = false) {
    const [key, label, defaultUnit] = definition, unit = text(metric?.unit) || defaultUnit;
    const periodType = metric?.periodType || group?.periodType || "M";
    const policy = api.temporalPolicy({ month: scope.month, months: scope.months, periodType });
    const byMonth = new Map(), duplicates = new Set();
    for (const row of Array.isArray(metric?.rows) ? metric.rows : []) {
      if (!MONTH.test(row?.period || "") || row.period > scope.month) continue;
      if (byMonth.has(row.period)) duplicates.add(row.period); else byMonth.set(row.period, row);
    }
    const point = (period, override) => {
      const row = override === undefined ? byMonth.get(period) : override;
      const scopeIssue = spatialIssue(row, metric, group, scope.regionKey);
      const rejected = invalid || duplicates.has(period) || policy.periodType !== "M" || scopeIssue;
      const availability = api.availabilityOf(rejected ? { status: "error", reasonCode: duplicates.has(period) || invalid ? "INVALID_RESPONSE" : policy.periodType !== "M" ? "PERIOD_TYPE_MISMATCH" : scopeIssue } : row);
      return { period, row, ...availability };
    };
    const latest = [...byMonth.keys()].sort().map(period => point(period)).filter(row => row.observed).at(-1) || null;
    const endPeriod = latest?.period || scope.month, expectedMonths = policy.expectedMonths || scope.months;
    const rows = Array.from({ length: expectedMonths }, (_, index) => point(shift(endPeriod, index + 1 - expectedMonths)));
    const count = status => rows.filter(row => row.status === status).length;
    const completeMonths = count("observed"), partialMonths = count("partial");
    const coverage = { expectedMonths, completeMonths, partialMonths, missingMonths: expectedMonths - completeMonths - partialMonths,
      failedMonths: count("error"), publicationPendingMonths: count("publication_pending"), suppressedMonths: count("suppressed"),
      startPeriod: rows[0].period, endPeriod, rate: completeMonths / expectedMonths };
    const comparisonOf = row => typeof api.comparisonEligibility === "function" ? api.comparisonEligibility([{ regionKey: scope.regionKey, group, metric: { ...metric, spatialContract: spatialOf(row, metric, group) } }]) : null;
    const proofOf = row => {
      if (typeof api.storedEvidenceSummary !== "function") return null;
      const verification = row?.storedEvidenceVerification || metric?.storedEvidenceVerification;
      const proof = api.storedEvidenceSummary(spatialOf(row, metric, group), verification);
      if (proof?.sourceKind === "stored_raw_response" && (proof.period !== row?.period || (proof.periodType || "M") !== "M"
        || comparisonOf(row)?.comparable !== true || verification?.status === "rejected")) return { label: "보관 근거 미확인", reason: "해당 기준월의 원본 검증 근거 확인 필요" };
      return proof;
    };
    const normalRows = rows.filter(row => row.observed), storedVerifiedMonths = normalRows.filter(row => proofOf(row.row)?.sourceKind === "stored_raw_response").length;
    const evidenceCoverage = { expectedMonths, observedMonths: completeMonths,
      scopeVerifiedMonths: normalRows.filter(row => comparisonOf(row.row)?.comparable === true).length, storedVerifiedMonths,
      unverifiedObservedMonths: completeMonths - storedVerifiedMonths, unobservedMonths: expectedMonths - completeMonths,
      pendingMonths: normalRows.filter(row => (row.row?.storedEvidenceVerification || metric?.storedEvidenceVerification)?.status === "pending").length,
      rejectedMonths: normalRows.filter(row => (row.row?.storedEvidenceVerification || metric?.storedEvidenceVerification)?.status === "rejected").length };
    // A delayed metric's canonical rows end at its latest normal month. Keep
    // the separately stored requestedPoint diagnostics without adding it to
    // the normal window or replacing the latest observed value.
    const requested = point(scope.month, metric?.requestedPoint?.period === scope.month ? metric.requestedPoint : undefined), spatialContract = spatialOf(latest?.row, metric, group);
    const requestedVerification = requested.row?.storedEvidenceVerification || null;
    const comparison = latest ? comparisonOf(latest.row) : null;
    const verification = latest?.row?.storedEvidenceVerification || metric?.storedEvidenceVerification || null;
    const value = latest?.value ?? null;
    return { key, label, unit, value, valueLabel: value === null ? "관측 없음" : `${value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} ${unit}`,
      period: latest?.period || "", status: latest ? completeMonths === expectedMonths ? "ready" : "partial" : coverage.failedMonths || invalid ? "error" : "missing",
      reasonCode: latest ? "" : requested.reasonCode, coverage, evidenceCoverage,
      requested: { period: scope.month, status: requested.status, reasonCode: requested.reasonCode, spatialStatus: spatialOf(requested.row, metric, group)?.status || "scope_unverified",
        evidenceStatus: requestedVerification?.status || "unrecorded", evidenceReasonCode: text(requestedVerification?.reasonCode) },
      lagMonths: latest ? (Number(scope.month.slice(0, 4)) - Number(latest.period.slice(0, 4))) * 12 + Number(scope.month.slice(5)) - Number(latest.period.slice(5)) : null,
      comparisonEligible: comparison?.comparable === true, referenceOnly: Boolean(latest && comparison?.comparable !== true), spatialStatus: spatialContract?.status || "scope_unverified",
      evidenceStatus: verification?.status || "unrecorded", evidenceReasonCode: text(verification?.reasonCode),
      originalVerified: Boolean(latest && proofOf(latest.row)?.sourceKind === "stored_raw_response"), storedEvidence: latest ? proofOf(latest.row) : null };
  }
  function cardModel(definition, groups, scope, api) {
    const matching = groups.filter(group => group?.key === definition.groupKey), group = matching.length === 1 ? matching[0] : null;
    const metrics = definition.metrics.map(spec => {
      const found = (Array.isArray(group?.metrics) ? group.metrics : []).filter(metric => metric?.key === spec[0]);
      return metricModel(spec, group, found.length === 1 ? found[0] : null, scope, api, matching.length > 1 || found.length > 1);
    });
    const observed = metrics.filter(metric => metric.value !== null), periods = [...new Set(observed.map(metric => metric.period))].sort();
    const completeMonths = Math.min(...metrics.map(metric => metric.coverage.completeMonths)), partialMonths = Math.min(...metrics.map(metric => metric.coverage.partialMonths));
    const coverage = { expectedMonths: scope.months, completeMonths, partialMonths, missingMonths: Math.max(0, scope.months - completeMonths - partialMonths),
      rate: completeMonths / scope.months, perMetricWindows: new Set(metrics.map(metric => metric.coverage.endPeriod)).size > 1 };
    const status = observed.length ? metrics.every(metric => metric.status === "ready") ? "ready" : "partial" : metrics.some(metric => metric.status === "error") ? "error" : "missing";
    return { key: definition.key, groupKey: definition.groupKey, title: definition.title, tone: definition.tone, status, items: metrics, metrics, coverage,
      note: !periods.length ? "저장된 정상 관측 없음" : periods.length === 1 ? `${periods[0]} 최근 정상월 · ${scope.months}개월 기준` : `지표별 최근 정상월 ${periods.join(" · ")}`,
      evidenceCoverage: { expectedMonths: scope.months, storedVerifiedMonths: Math.min(...metrics.map(metric => metric.evidenceCoverage.storedVerifiedMonths)),
        scopeVerifiedMonths: Math.min(...metrics.map(metric => metric.evidenceCoverage.scopeVerifiedMonths)), perMetricWindows: coverage.perMetricWindows },
      coverageDetail: "지표별 최신 정상월 기준 · 실제 0 포함 · 미확보는 0으로 계산하지 않음",
      stale: group?.stale === true, refreshErrorCode: text(group?.lastRefreshErrorCode || group?.refresh?.errorCode || group?.errorCode) };
  }
  function build({ regionKey = "", month = "", result, loading = false, error = "" } = {}) {
    const scope = { regionKey, month, months: 13 };
    if (!text(regionKey).trim() || regionKey !== regionKey.trim() || !MONTH.test(month)) return emptyModel(scope, "mismatch", "REGIONAL_INVALID_SCOPE", loading, error);
    if (result === undefined || result === null) return emptyModel(scope, loading ? "loading" : error ? "error" : "unqueried", "", loading, error);
    if (typeof result !== "object" || !Object.hasOwn(result, "snapshot") || !result.scope) return emptyModel(scope, "error", "REGIONAL_INVALID_RESULT", loading, error);
    if (!scopeMatches(result.scope, scope) || result.snapshot && !scopeMatches(result.snapshot.scope, scope)
      || result.management?.scope && !scopeMatches(result.management.scope, scope) || result.job?.scope && !scopeMatches(result.job.scope, scope)
      || result.job?.regionKey && result.job.regionKey !== regionKey) return emptyModel(scope, "mismatch", "REGIONAL_SCOPE_MISMATCH", loading, error);
    const storageError = text(result.storage?.errorCode), readError = error || storageError;
    if (result.snapshot === null) return emptyModel(scope, readError ? "error" : "missing", storageError, loading, readError);
    if (typeof result.snapshot !== "object" || !Array.isArray(result.snapshot.groups)) return emptyModel(scope, "error", "REGIONAL_INVALID_RESULT", loading, readError);
    const api = contractApi();
    if (!api?.availabilityOf || !api?.temporalPolicy) return emptyModel(scope, "error", "REGIONAL_CONTRACT_UNAVAILABLE", loading, readError);
    const cards = DEFINITIONS.map(definition => cardModel(definition, result.snapshot.groups, scope, api));
    const status = cards.some(card => ["ready", "partial"].includes(card.status)) ? cards.every(card => card.status === "ready") ? "ready" : "partial"
      : cards.some(card => card.status === "error") || readError ? "error" : "missing";
    return { version: VERSION, status, reasonCode: storageError, scope, resultId: text(result.snapshot.resultId), generatedAt: text(result.snapshot.generatedAt),
      loading, error: readError, stale: Boolean(readError || cards.some(card => card.stale)), cards };
  }

  const api = { VERSION, build };
  root.RegionalLocationSummary = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
