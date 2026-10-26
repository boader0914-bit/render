"use strict";

// Project already saved administrative evidence. There is no center, radius,
// source loader, collector, provider, or arithmetic aggregation in this module.
const crypto = require("node:crypto");
const { DEFINITIONS } = require("./kosis.cjs");
const { VERSION: CONTRACT_VERSION, storedProvenanceOf } = require("../../web/regional-data-contract.js");
const VERSION = "regional-market-v1", MODE = "administrative_region";
const ID = /^[A-Za-z0-9_:-]{1,120}$/, MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/, HASH = /^[a-f0-9]{64}$/;
const SPECS = Object.freeze([
  ["population", "population", "population", "총인구", "명"],
  ["registeredHouseholds", "households", "registered_households", "주민등록 세대 수 (가구 수와 다름)", "세대"],
  ["establishments", "establishments", "establishments", "사업체 수", "개"],
  ["employees", "employment", "employees", "총종사자 수", "명"],
  ["manufacturingEstablishments", "manufacturing_establishments", "manufacturing_establishments", "제조업 사업체 수", "개"],
  ["manufacturingEmployees", "manufacturing_employment", "manufacturing_employees", "제조업 종사자 수", "명"]
].map(([key, datasetKey, metricKey, label, unit]) => Object.freeze({ key, datasetKey, metricKey, label, unit,
  periodType: DEFINITIONS.find(d => d.key === datasetKey).periodType })));
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const safeText = (x, max = 300) => typeof x === "string" && !/[\x00-\x1f\x7f\uFFFD]/.test(x) ? x.trim().slice(0, max) : "";
const stamp = x => typeof x === "string" && /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(x)
  && Number.isFinite(Date.parse(x)) && new Date(x.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) === x.slice(0, 10) ? new Date(x).toISOString() : null;
const numeric = x => Number.isSafeInteger(x) && x >= 0;
const year = x => Number.isInteger(x) && x >= 2000 && x <= 2099 ? x : null;
const hash = x => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const fault = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const validPeriod = (x, type) => type === "M" ? MONTH.test(x || "") : /^20\d{2}$/.test(x || "");
const periodInScope = (x, type, month) => validPeriod(x, type) && (type === "M" ? x <= month : x <= month.slice(0, 4));
const REQUIRED_CHECKS = ["safe_original_path", "original_sha256", "source_table_and_period", "metadata_region_ancestry", "raw_region_code", "metric_unit_and_period", "stored_metric_values"];
const keysOnly = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
function verifiedProof(value, period, periodType) {
  const proof = storedProvenanceOf(value);
  return proof?.version === "stored-kosis-spatial-evidence-v1" && proof.period === period && (proof.periodType || "M") === periodType
    && stamp(proof.verifiedAt) && REQUIRED_CHECKS.every(key => proof.checks.includes(key)) ? proof : null;
}
function normalizeRegion(region, scope) {
  if (!object(region) || !object(scope) || !ID.test(scope.regionKey || "") || region.regionKey !== scope.regionKey
    || region.level !== "local" || region.active === false || region.selectable === false || region.unitType === "general_district"
    || !/^\d{5}(?:\d{5})?$/.test(String(region.officialCode || "")) || !MONTH.test(scope.month || "") || ![13, 24].includes(scope.months)) throw fault("REGIONAL_MARKET_INVALID_SCOPE");
  return { regionKey: scope.regionKey, label: safeText(region.label || region.fullName || region.name), officialCode: String(region.officialCode),
    level: "sigungu", unitType: safeText(region.unitType, 50) || "unknown", month: scope.month, months: scope.months,
    boundaryYear: null, boundaryYearStatus: "unrecorded" };
}
function validContract(contract, scope, period, periodType) {
  const proof = verifiedProof(contract?.storedProvenance, period, periodType);
  return contract?.version === CONTRACT_VERSION && contract.requestedRegionKey === scope.regionKey && contract.officialCode === scope.officialCode
    && contract.requestedLevel === "sigungu" && contract.providedLevel === "sigungu" && contract.requestedUnitType === scope.unitType
    && contract.scopeKind === "administrative" && contract.status === "matched" && contract.evidence === "response"
    && contract.aggregation === "none" && contract.provider === "KOSIS" && /^[A-Za-z0-9_.-]{1,32}$/.test(contract.providerRegionCode || "")
    && proof ? proof : null;
}
function emptyMetric(spec) {
  const definition = DEFINITIONS.find(d => d.key === spec.datasetKey);
  return { key: spec.key, label: spec.label, unit: spec.unit, periodType: spec.periodType, period: null, value: null, status: "missing",
    reasonCode: "REGIONAL_MARKET_NOT_ACQUIRED", source: { provider: "KOSIS", tableId: definition.tableId, orgId: definition.orgId,
      sourceUrl: `https://kosis.kr/statHtml/statHtml.do?orgId=${definition.orgId}&tblId=${definition.tableId}`,
      providerRegionCode: null, storedProvenance: null, retrievedAt: null, period: null, boundaryYear: null, boundaryYearStatus: "unrecorded" } };
}
function buildRegionalMarketSnapshot({ region, scope, savedSnapshot = null, source = {}, now = () => new Date() } = {}) {
  const selected = normalizeRegion(region, scope), observedAt = stamp(new Date(now()).toISOString());
  const warnings = new Set(["ADMINISTRATIVE_AREA_NOT_RADIUS", "RESIDENTS_ARE_NOT_VISITOR_ORIGINS"]);
  const saved = object(savedSnapshot) ? savedSnapshot : null;
  if (savedSnapshot !== null && !saved || saved && (saved.schemaVersion !== 1 || saved.calculationVersion !== "regional-analysis-v1"
    || saved.contractVersion !== CONTRACT_VERSION || !["ready", "partial", "missing"].includes(saved.status))) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
  if (saved && (saved.scope?.regionKey !== selected.regionKey || saved.scope?.month !== selected.month || saved.scope?.months !== selected.months
    || saved.networkAttempted !== false || saved.regionIdentity?.regionKey !== selected.regionKey || saved.regionIdentity?.officialCode !== selected.officialCode
    || saved.regionIdentity?.level !== "local" || saved.regionIdentity?.unitType !== selected.unitType || !Array.isArray(saved.groups))) throw fault("REGIONAL_MARKET_SOURCE_SCOPE_MISMATCH", 503);
  const groups = saved?.groups.filter(g => g?.key === "kosis") || [];
  if (groups.length > 1) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
  if (groups.length && !Array.isArray(groups[0].datasets)) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
  const group = groups[0], datasets = Array.isArray(group?.datasets) ? group.datasets : [];
  if (datasets.length > 32) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
  const metrics = SPECS.map(spec => {
    const metric = emptyMetric(spec), matches = datasets.filter(d => d?.key === spec.datasetKey);
    if (matches.length > 1) { metric.status = "error"; metric.reasonCode = "REGIONAL_MARKET_DUPLICATE_DATASET"; return metric; }
    const dataset = matches[0]; if (!dataset) return metric;
    const period = safeText(dataset.period, 7), retrievedAt = stamp(dataset.retrievedAt);
    metric.period = validPeriod(period, spec.periodType) ? period : null; metric.source.period = metric.period;
    metric.source.retrievedAt = retrievedAt;
    const boundary = year(dataset.boundaryYear ?? dataset.spatialContract?.boundaryYear);
    metric.source.boundaryYear = boundary; metric.source.boundaryYearStatus = boundary === null ? "unrecorded" : "recorded";
    if (boundary === null) warnings.add("BOUNDARY_YEAR_UNRECORDED");
    if (!Array.isArray(dataset.rows) || dataset.rows.length > 128) { metric.status = "error"; metric.reasonCode = "REGIONAL_MARKET_SOURCE_INVALID"; return metric; }
    const rows = dataset.rows.filter(r => r?.key === spec.metricKey && r?.unit === spec.unit);
    if (rows.length > 1) { metric.status = "error"; metric.reasonCode = "REGIONAL_MARKET_DUPLICATE_METRIC"; return metric; }
    const row = rows[0]; if (!row) return metric;
    const unavailable = { suppressed: "SUPPRESSED", partial: "PARTIAL_DATA", publication_pending: "PUBLICATION_PENDING", error: "REGIONAL_MARKET_SOURCE_ERROR", failed: "REGIONAL_MARKET_SOURCE_ERROR", blocked: "REGIONAL_MARKET_SOURCE_ERROR" };
    if (unavailable[row.status]) { metric.status = ["failed", "blocked"].includes(row.status) ? "error" : row.status; metric.reasonCode = unavailable[row.status]; return metric; }
    if (row.status !== "observed") { metric.reasonCode = safeText(row.reasonCode, 100).match(/^[A-Z][A-Z0-9_]{1,99}$/)?.[0] || "REGIONAL_MARKET_NOT_ACQUIRED"; return metric; }
    const proof = validContract(dataset.spatialContract, selected, period, spec.periodType);
    const verification = dataset.storedEvidenceVerification;
    const definition = DEFINITIONS.find(d => d.key === spec.datasetKey), expectedUrl = metric.source.sourceUrl;
    // Saved standardized snapshots predate optional table metadata. Their
    // dataset key is bound by the exact builder version and original proof.
    // Any explicit metadata must agree; it never overrides that definition.
    const identityMismatch = ["definition", "source"].some(key => dataset[key] !== undefined && !object(dataset[key])) || [dataset, dataset.definition, dataset.source].filter(object).some(identity =>
      identity.tableId !== undefined && identity.tableId !== definition.tableId || identity.orgId !== undefined && identity.orgId !== definition.orgId
      || identity.sourceUrl !== undefined && identity.sourceUrl !== expectedUrl);
    const rowPeriod = typeof row.period === "string" && spec.periodType === "M" && /^20\d{2}(0[1-9]|1[0-2])$/.test(row.period)
      ? row.period.slice(0, 4) + "-" + row.period.slice(4) : row.period;
    if (group?.provider !== "KOSIS" || dataset.periodType !== spec.periodType || !periodInScope(period, spec.periodType, selected.month)
      || identityMismatch || dataset.mapping !== undefined && (!object(dataset.mapping) || dataset.mapping.code !== dataset.spatialContract?.providerRegionCode)
      || row.period !== undefined && rowPeriod !== period || row.periodType !== undefined && row.periodType !== spec.periodType
      || !retrievedAt || !numeric(row.value) || !proof || verification && !["restored", "already_verified"].includes(verification.status)) {
      metric.status = "unverified"; metric.reasonCode = "REGIONAL_MARKET_EVIDENCE_UNVERIFIED"; return metric;
    }
    metric.status = "observed"; metric.reasonCode = null; metric.value = row.value;
    metric.source.providerRegionCode = dataset.spatialContract.providerRegionCode;
    metric.source.storedProvenance = proof;
    return metric;
  });
  const observed = metrics.filter(m => m.status === "observed").length;
  const years = [...new Set(metrics.map(m => m.source.boundaryYear).filter(x => x !== null))];
  if (years.length === 1 && metrics.every(m => m.source.boundaryYear === years[0])) { selected.boundaryYear = years[0]; selected.boundaryYearStatus = "recorded"; }
  if (selected.boundaryYear === null) warnings.add("BOUNDARY_YEAR_UNRECORDED");
  const generatedAt = stamp(saved?.generatedAt), calculatedAt = stamp(saved?.builtAt || saved?.generatedAt);
  if (saved && (!generatedAt || !calculatedAt || !HASH.test(saved.sourceFingerprint || "") || !/^[a-f0-9-]{36}$/.test(saved.resultId || ""))) throw fault("REGIONAL_MARKET_SOURCE_INVALID", 503);
  const result = { schemaVersion: 1, calculationVersion: VERSION, mode: MODE, originKind: MODE,
    status: metrics.some(m => ["error", "unverified"].includes(m.status)) ? "needs_verification" : observed === metrics.length && selected.boundaryYear !== null ? "ready" : observed ? "partial" : "missing",
    scope: selected, metrics, visitorOrigins: { status: "not_acquired", value: null, reasonCode: "VISITOR_ORIGINS_NOT_AVAILABLE" },
    generatedAt, calculatedAt, retrievedAt: metrics.map(m => m.source.retrievedAt).filter(Boolean).sort().at(-1) || null, observedAt,
    source: { kind: "saved_regional_analysis", resultId: saved?.resultId || null, sourceFingerprint: saved?.sourceFingerprint || null,
      resultSha256: HASH.test(source.resultSha256 || "") ? source.resultSha256 : null, generatedAt, calculatedAt },
    networkAttempted: false, readOnly: true, warnings: [...warnings], notes: ["시군구 행정범위의 저장 통계이며 업체 중심 반경이나 실제 방문객 거주지 분포가 아닙니다.",
      "월간·연간 공표기간을 그대로 표시하며 기간이 다른 수치를 합산하지 않습니다.", "미확보·미검증·비공개 값은 실제 0과 구분합니다. 경계연도가 없으면 확인되지 않은 상태로 남깁니다."] };
  result.fingerprint = hash({ ...result, observedAt: undefined });
  return result;
}
function validateRegionalMarketSnapshot(value, { regionKey, month, asOfAt } = {}) {
  const bad = () => { throw fault("REGIONAL_MARKET_RESULT_INVALID", 503); };
  if (!keysOnly(value, ["schemaVersion", "calculationVersion", "mode", "originKind", "status", "scope", "metrics", "visitorOrigins", "generatedAt", "calculatedAt", "retrievedAt", "observedAt", "source", "networkAttempted", "readOnly", "warnings", "notes", "fingerprint"])
    || value.schemaVersion !== 1 || value.calculationVersion !== VERSION || value.mode !== MODE || value.originKind !== MODE
    || !["ready", "partial", "missing", "needs_verification"].includes(value.status) || value.networkAttempted !== false || value.readOnly !== true
    || !keysOnly(value.scope, ["regionKey", "label", "officialCode", "level", "unitType", "month", "months", "boundaryYear", "boundaryYearStatus"])
    || !ID.test(value.scope.regionKey || "") || !/^\d{5}(?:\d{5})?$/.test(value.scope.officialCode || "")
    || value.scope.level !== "sigungu" || !MONTH.test(value.scope.month || "") || ![13, 24].includes(value.scope.months)
    || regionKey !== undefined && value.scope.regionKey !== regionKey || month !== undefined && value.scope.month !== month
    || !Array.isArray(value.metrics) || value.metrics.length !== SPECS.length || !keysOnly(value.source, ["kind", "resultId", "sourceFingerprint", "resultSha256", "generatedAt", "calculatedAt"]) || value.source.kind !== "saved_regional_analysis"
    || !keysOnly(value.visitorOrigins, ["status", "value", "reasonCode"])
    || value.visitorOrigins?.status !== "not_acquired" || value.visitorOrigins?.value !== null || value.visitorOrigins?.reasonCode !== "VISITOR_ORIGINS_NOT_AVAILABLE"
    || !HASH.test(value.fingerprint || "") || hash({ ...value, fingerprint: undefined, observedAt: undefined }) !== value.fingerprint) bad();
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024 || !Array.isArray(value.warnings) || value.warnings.length > 16 || !Array.isArray(value.notes) || value.notes.length > 8) bad();
  if (value.source.resultId !== null && (!/^[a-f0-9-]{36}$/.test(value.source.resultId || "") || !HASH.test(value.source.sourceFingerprint || "") || !HASH.test(value.source.resultSha256 || "")
    || !stamp(value.source.generatedAt) || !stamp(value.source.calculatedAt) || value.generatedAt !== value.source.generatedAt || value.calculatedAt !== value.source.calculatedAt)) bad();
  const cutoff = asOfAt === undefined ? null : stamp(asOfAt); if (asOfAt !== undefined && !cutoff) bad();
  const times = [value.generatedAt, value.calculatedAt, value.retrievedAt, value.source.generatedAt, value.source.calculatedAt].filter(x => x !== null);
  for (const [index, metric] of value.metrics.entries()) {
    const spec = SPECS[index], definition = DEFINITIONS.find(d => d.key === spec.datasetKey);
    if (!keysOnly(metric, ["key", "label", "unit", "periodType", "period", "value", "status", "reasonCode", "source"]) || metric.key !== spec.key || metric.label !== spec.label || metric.unit !== spec.unit || metric.periodType !== spec.periodType
      || !["observed", "missing", "suppressed", "partial", "publication_pending", "error", "unverified"].includes(metric.status)
      || !keysOnly(metric.source, ["provider", "tableId", "orgId", "sourceUrl", "providerRegionCode", "storedProvenance", "retrievedAt", "period", "boundaryYear", "boundaryYearStatus"])
      || metric.source.provider !== "KOSIS" || metric.source.tableId !== definition.tableId || metric.source.orgId !== definition.orgId
      || metric.source.sourceUrl !== `https://kosis.kr/statHtml/statHtml.do?orgId=${definition.orgId}&tblId=${definition.tableId}`
      || metric.source.period !== metric.period || metric.period !== null && !validPeriod(metric.period, spec.periodType)
      || metric.source.boundaryYear !== null && year(metric.source.boundaryYear) === null || !["recorded", "unrecorded"].includes(metric.source.boundaryYearStatus)) bad();
    if (metric.status === "observed") {
      const proof = verifiedProof(metric.source.storedProvenance, metric.period, spec.periodType);
      if (!numeric(metric.value) || metric.reasonCode !== null || !periodInScope(metric.period, spec.periodType, value.scope.month) || !proof
        || !/^[A-Za-z0-9_.-]{1,32}$/.test(metric.source.providerRegionCode || "") || !stamp(metric.source.retrievedAt)) bad();
      times.push(proof.verifiedAt);
    } else if (metric.value !== null || !/^[A-Z][A-Z0-9_]{1,99}$/.test(metric.reasonCode || "")) bad();
    if (metric.source.retrievedAt !== null) times.push(metric.source.retrievedAt);
  }
  const observed = value.metrics.filter(m => m.status === "observed").length;
  const expectedStatus = value.metrics.some(m => ["error", "unverified"].includes(m.status)) ? "needs_verification" : observed === SPECS.length && value.scope.boundaryYear !== null ? "ready" : observed ? "partial" : "missing";
  if (value.status !== expectedStatus || observed && value.source.resultId === null || !["recorded", "unrecorded"].includes(value.scope.boundaryYearStatus)
    || value.scope.boundaryYear !== null && year(value.scope.boundaryYear) === null
    || value.scope.boundaryYearStatus !== (value.scope.boundaryYear === null ? "unrecorded" : "recorded")
    || value.metrics.some(m => m.source.boundaryYearStatus !== (m.source.boundaryYear === null ? "unrecorded" : "recorded"))
    || value.scope.boundaryYear !== null && value.metrics.some(m => m.source.boundaryYear !== value.scope.boundaryYear)
    || value.warnings.some(x => !/^[A-Z][A-Z0-9_]{1,99}$/.test(x)) || value.notes.some(x => !safeText(x, 1000) || x.length > 1000)) bad();
  if (times.some(x => !stamp(x) || cutoff && stamp(x) > cutoff)) bad();
  return value;
}
module.exports = { VERSION, MODE, SPECS, buildRegionalMarketSnapshot, validateRegionalMarketSnapshot, normalizeRegion, fault };
