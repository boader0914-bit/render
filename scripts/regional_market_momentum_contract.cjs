"use strict";

const crypto = require("node:crypto");

const SCHEMA_VERSIONS = Object.freeze({
  signalObservation: "regional-signal.observation.v1",
  momentum: "regional-market-momentum.v1",
  revenueValidation: "regional-market-momentum.revenue-validation.v1",
  maintenanceForecast: "regional-maintenance-forecast.v1"
});

const STATUSES = Object.freeze(["ready", "zero", "missing", "partial", "stale", "conflict"]);
const CONFIDENCE_GRADES = Object.freeze(["A", "B", "C", "D", "U"]);
const MOMENTUM_SCOPES = Object.freeze(["within_region_time_series", "cross_region_snapshot"]);
const SIGNAL_DIRECTIONS = Object.freeze(["increase_positive", "decrease_positive"]);
const REVENUE_TOKEN_PATTERN = /(?:^|[._-])(revenue|sales|gmv|turnover|매출)(?:$|[._-])/i;

class RegionalMomentumContractError extends Error {
  constructor(contractType, errors = []) {
    super(`Invalid ${contractType} contract: ${errors.map((entry) => `${entry.path}:${entry.code}`).join(", ")}`);
    this.name = "RegionalMomentumContractError";
    this.code = "REGIONAL_MOMENTUM_CONTRACT_INVALID";
    this.contractType = contractType;
    this.errors = errors;
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function text(value, max = 320) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = finite(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function timestamp(value) {
  const raw = value instanceof Date ? value.toISOString() : text(value, 48);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function date(value) {
  const raw = text(value, 48);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00.000Z`))) return raw;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : raw;
}

function validTime(value) {
  return Boolean(value) && Number.isFinite(Date.parse(String(value)));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value)), "utf8").digest("hex");
}

function normalizePenalty(value = {}) {
  if (typeof value === "string") return { code: text(value, 100), message: "", points: null };
  return {
    code: text(value.code, 100),
    message: text(value.message, 400),
    points: finite(value.points)
  };
}

function normalizeCoverage(value = {}) {
  const numerator = nonNegativeInteger(value.numerator);
  const denominator = nonNegativeInteger(value.denominator);
  return {
    numerator,
    denominator,
    ratio: numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null,
    note: text(value.note, 400)
  };
}

function normalizeConfidence(value = {}, status = "missing") {
  const penalties = Array.isArray(value.penalties) ? value.penalties.map(normalizePenalty) : [];
  return {
    grade: text(value.grade || (status === "missing" ? "U" : ""), 8).toUpperCase(),
    score: status === "missing" ? null : finite(value.score),
    penalties
  };
}

function sensitiveUrl(value = "") {
  const raw = text(value, 2000);
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return [...parsed.searchParams.keys()].some((key) => /(?:key|secret|token|password|authorization|signature)/i.test(key));
  } catch {
    return true;
  }
}

function error(errors, path, code, message) {
  errors.push({ path, code, message });
}

function normalizeRegionalSignalObservation(input = {}) {
  const status = text(input.status || "missing", 24).toLowerCase();
  const rawValue = status === "missing" || status === "conflict" ? null : finite(input.rawValue ?? input.value);
  const normalizedValue = status === "missing" || status === "conflict" ? null : finite(input.normalizedValue);
  const refreshedAt = timestamp(input.refreshedAt || input.fetchedAt);
  const asOf = timestamp(input.asOf || input.featureAsOf || refreshedAt);
  const observedAt = timestamp(input.observedAt || input.measurementPeriod?.to || asOf);
  const sourceInput = input.source && typeof input.source === "object" ? input.source : {};
  const provenanceInput = input.provenance && typeof input.provenance === "object" ? input.provenance : {};
  return {
    schemaVersion: text(input.schemaVersion || SCHEMA_VERSIONS.signalObservation, 100),
    contractType: "regional_signal_observation",
    regionKey: text(input.regionKey, 160),
    signalKey: text(input.signalKey || input.metricKey, 160),
    signalRole: text(input.signalRole, 80).toLowerCase(),
    source: {
      sourceId: text(sourceInput.sourceId || input.sourceId, 160),
      provider: text(sourceInput.provider || input.provider, 160),
      datasetId: text(sourceInput.datasetId || input.datasetId, 200),
      officialUrl: text(sourceInput.officialUrl || input.officialUrl, 2000)
    },
    observedAt,
    measurementPeriod: {
      from: timestamp(input.measurementPeriod?.from || input.observedFrom),
      to: timestamp(input.measurementPeriod?.to || input.observedTo)
    },
    sampleCount: nonNegativeInteger(input.sampleCount ?? input.sample?.n),
    coverage: normalizeCoverage(input.coverage),
    refreshedAt,
    asOf,
    availableAt: timestamp(input.availableAt || refreshedAt),
    status,
    confidence: normalizeConfidence(input.confidence, status),
    penalties: (Array.isArray(input.penalties) ? input.penalties : []).map(normalizePenalty),
    rawValue: status === "zero" && rawValue === null ? 0 : rawValue,
    normalizedValue: status === "zero" && normalizedValue === null ? 0 : normalizedValue,
    normalization: {
      method: text(input.normalization?.method, 120),
      version: text(input.normalization?.version, 120),
      parameters: stable(input.normalization?.parameters || {})
    },
    provenance: {
      catalogVersion: text(provenanceInput.catalogVersion, 120),
      fixtureId: text(provenanceInput.fixtureId, 160),
      payloadHash: text(provenanceInput.payloadHash || input.payloadHash, 64).toLowerCase(),
      license: text(provenanceInput.license || input.license, 200)
    }
  };
}

function validateRegionalSignalObservation(value = {}) {
  const errors = [];
  if (value.schemaVersion !== SCHEMA_VERSIONS.signalObservation) error(errors, "schemaVersion", "invalid_version", "signal observation schemaVersion is invalid");
  if (!/^kr_[a-z0-9_]+$/.test(value.regionKey || "")) error(errors, "regionKey", "invalid_region_key", "canonical regionKey is required");
  for (const field of ["signalKey", "signalRole"]) if (!text(value[field], 160)) error(errors, field, "required", `${field} is required`);
  for (const field of ["sourceId", "provider", "datasetId", "officialUrl"]) {
    if (!text(value.source?.[field], 2000)) error(errors, `source.${field}`, "required", `source.${field} is required`);
  }
  if (sensitiveUrl(value.source?.officialUrl)) error(errors, "source.officialUrl", "credential_url_forbidden", "official source URLs must not contain credentials");
  for (const [path, temporal] of [
    ["observedAt", value.observedAt], ["measurementPeriod.from", value.measurementPeriod?.from],
    ["measurementPeriod.to", value.measurementPeriod?.to], ["refreshedAt", value.refreshedAt],
    ["asOf", value.asOf], ["availableAt", value.availableAt]
  ]) if (!validTime(temporal)) error(errors, path, "invalid_time", `${path} must be an ISO date or timestamp`);
  if (validTime(value.measurementPeriod?.from) && validTime(value.measurementPeriod?.to) && Date.parse(value.measurementPeriod.from) > Date.parse(value.measurementPeriod.to)) {
    error(errors, "measurementPeriod.to", "invalid_range", "measurementPeriod.to must not precede from");
  }
  if (validTime(value.measurementPeriod?.to) && validTime(value.asOf) && Date.parse(value.measurementPeriod.to) > Date.parse(value.asOf)) {
    error(errors, "measurementPeriod.to", "feature_leakage", "measurement period must not extend past asOf");
  }
  if (validTime(value.availableAt) && validTime(value.asOf) && Date.parse(value.availableAt) > Date.parse(value.asOf)) {
    error(errors, "availableAt", "feature_leakage", "source data must have been available by asOf");
  }
  if (!STATUSES.includes(value.status)) error(errors, "status", "invalid_status", "unsupported observation status");
  if (!CONFIDENCE_GRADES.includes(value.confidence?.grade)) error(errors, "confidence.grade", "invalid_grade", "confidence grade is invalid");
  if (value.status === "missing") {
    if (value.rawValue !== null || value.normalizedValue !== null) error(errors, "rawValue", "missing_requires_null", "missing is not numeric zero");
    if (value.confidence?.grade !== "U" || value.confidence?.score !== null) error(errors, "confidence", "missing_requires_unknown_quality", "missing observations use U/null confidence");
  } else if (value.status === "conflict") {
    if (value.normalizedValue !== null) error(errors, "normalizedValue", "conflict_requires_null", "conflicting observations cannot be normalized");
  } else {
    if (value.rawValue === null) error(errors, "rawValue", "value_required", "observed statuses require a raw value");
    if (!Number.isFinite(value.normalizedValue) || value.normalizedValue < 0 || value.normalizedValue > 100) error(errors, "normalizedValue", "invalid_normalized_value", "normalizedValue must be between 0 and 100");
    if (!Number.isFinite(value.confidence?.score) || value.confidence.score < 0 || value.confidence.score > 100) error(errors, "confidence.score", "invalid_score", "observed statuses require a 0-100 confidence score");
  }
  if (value.status === "zero" && value.rawValue !== 0) error(errors, "rawValue", "zero_requires_zero", "zero status requires numeric zero");
  if (nonNegativeInteger(value.sampleCount) === null) error(errors, "sampleCount", "invalid_count", "sampleCount must be a non-negative integer");
  const coverage = value.coverage || {};
  if (coverage.numerator === null || coverage.denominator === null || coverage.numerator > coverage.denominator) error(errors, "coverage", "invalid_coverage", "coverage counts must be valid");
  if (coverage.denominator > 0 && Math.abs(coverage.ratio - coverage.numerator / coverage.denominator) > 1e-12) error(errors, "coverage.ratio", "inconsistent_ratio", "coverage ratio must equal numerator / denominator");
  if (!text(value.normalization?.method, 120) || !text(value.normalization?.version, 120)) error(errors, "normalization", "required", "normalization method and version are required");
  if (!/^[a-f0-9]{64}$/.test(value.provenance?.payloadHash || "")) error(errors, "provenance.payloadHash", "invalid_hash", "fixture payload hash is required");
  if (!text(value.provenance?.catalogVersion, 120) || !text(value.provenance?.license, 200)) error(errors, "provenance", "required", "catalogVersion and license are required");
  if (value.status === "partial" && value.coverage?.ratio === 1 && !(value.penalties?.length || value.confidence?.penalties?.length)) error(errors, "status", "partial_requires_limitation", "partial requires incomplete coverage or a penalty");
  return { valid: errors.length === 0, errors };
}

function buildRegionalSignalObservation(input = {}) {
  const normalized = normalizeRegionalSignalObservation(input);
  const validation = validateRegionalSignalObservation(normalized);
  if (!validation.valid) throw new RegionalMomentumContractError("regional_signal_observation", validation.errors);
  return deepFreeze(normalized);
}

function momentumComponentFromObservation(input = {}, options = {}) {
  const observation = buildRegionalSignalObservation(input);
  return deepFreeze({
    key: text(options.key || observation.signalKey, 160),
    signalRole: observation.signalRole,
    sourceId: observation.source.sourceId,
    metricKey: text(options.metricKey || observation.signalKey, 160),
    direction: text(options.direction || "increase_positive", 40).toLowerCase(),
    normalizedValue: observation.normalizedValue,
    weight: finite(options.weight),
    status: observation.status,
    availableAt: observation.availableAt,
    measurementPeriod: { ...observation.measurementPeriod },
    coverage: { ...observation.coverage },
    confidence: { ...observation.confidence }
  });
}

function normalizeMomentumComponent(input = {}) {
  const status = text(input.status || "missing", 24).toLowerCase();
  const normalizedValue = status === "missing" || status === "conflict" ? null : finite(input.normalizedValue);
  const direction = text(input.direction || "increase_positive", 40).toLowerCase();
  return {
    key: text(input.key || input.signalKey, 160),
    signalRole: text(input.signalRole, 80).toLowerCase(),
    sourceId: text(input.sourceId || input.source?.sourceId, 160),
    metricKey: text(input.metricKey || input.signalKey, 160),
    direction,
    normalizedValue,
    alignedValue: normalizedValue === null ? null : direction === "decrease_positive" ? 100 - normalizedValue : normalizedValue,
    weight: finite(input.weight),
    status,
    availableAt: timestamp(input.availableAt),
    measurementPeriod: {
      from: timestamp(input.measurementPeriod?.from),
      to: timestamp(input.measurementPeriod?.to)
    },
    coverage: normalizeCoverage(input.coverage),
    confidence: normalizeConfidence(input.confidence, status)
  };
}

function containsRevenueIdentity(component = {}) {
  return [component.key, component.signalRole, component.sourceId, component.metricKey]
    .some((value) => REVENUE_TOKEN_PATTERN.test(text(value, 200)));
}

function normalizeMomentum(input = {}) {
  const components = (Array.isArray(input.components) ? input.components : []).map(normalizeMomentumComponent);
  const totalWeight = components.reduce((sum, component) => sum + Math.max(0, component.weight || 0), 0);
  const usable = components.filter((component) => Number.isFinite(component.alignedValue) && !["missing", "conflict"].includes(component.status));
  const observedWeight = usable.reduce((sum, component) => sum + Math.max(0, component.weight || 0), 0);
  const weightCoverage = totalWeight > 0 ? observedWeight / totalWeight : 0;
  const minimumWeightCoverage = finite(input.minimumWeightCoverage) ?? 0.7;
  const hasConflict = components.some((component) => component.status === "conflict");
  const weightedValue = observedWeight > 0
    ? usable.reduce((sum, component) => sum + component.alignedValue * component.weight, 0) / observedWeight
    : null;
  let status = "ready";
  let value = weightedValue;
  if (hasConflict) {
    status = "conflict";
    value = null;
  } else if (!usable.length) {
    status = "missing";
    value = null;
  } else if (weightCoverage < minimumWeightCoverage) {
    status = "partial";
    value = null;
  } else if (components.some((component) => component.status === "stale")) {
    status = "stale";
  } else if (components.some((component) => ["partial", "missing"].includes(component.status)) || weightCoverage < 1) {
    status = "partial";
  } else if (weightedValue === 0) {
    status = "zero";
  }
  const dataQualityStatus = text(
    input.dataQuality?.status || (status === "missing" ? "missing" : status === "ready" || status === "zero" ? "ready" : "partial"),
    24
  ).toLowerCase();
  const normalized = {
    schemaVersion: text(input.schemaVersion || SCHEMA_VERSIONS.momentum, 100),
    contractType: "regional_market_momentum",
    metricKey: "regionalMarketMomentum",
    regionKey: text(input.regionKey, 160),
    scope: text(input.scope || "within_region_time_series", 80),
    period: { from: date(input.period?.from), to: date(input.period?.to) },
    featureAsOf: timestamp(input.featureAsOf),
    modelVersion: text(input.modelVersion, 120),
    weightsVersion: text(input.weightsVersion, 120),
    normalizationVersion: text(input.normalizationVersion, 120),
    minimumWeightCoverage,
    status,
    value: value === null ? null : Math.round(value * 1e6) / 1e6,
    publishable: ["ready", "zero"].includes(status) && ["ready", "zero"].includes(dataQualityStatus),
    components,
    calculation: {
      formula: "sum(alignedValue*weight)/sum(observedWeight)",
      totalWeight,
      observedWeight,
      weightCoverage,
      qualityAdjustsValue: false,
      revenueUsedAsFeature: false
    },
    dataQuality: {
      status: dataQualityStatus,
      grade: text(input.dataQuality?.grade || (status === "missing" ? "U" : ""), 8).toUpperCase(),
      score: status === "missing" ? null : finite(input.dataQuality?.score),
      coverage: normalizeCoverage(input.dataQuality?.coverage || { numerator: usable.length, denominator: components.length }),
      penalties: (Array.isArray(input.dataQuality?.penalties) ? input.dataQuality.penalties : []).map(normalizePenalty)
    }
  };
  normalized.snapshotHash = hash({
    ...normalized,
    snapshotHash: undefined
  });
  return normalized;
}

function validateMomentum(value = {}) {
  const errors = [];
  if (value.schemaVersion !== SCHEMA_VERSIONS.momentum) error(errors, "schemaVersion", "invalid_version", "momentum schemaVersion is invalid");
  if (!/^kr_[a-z0-9_]+$/.test(value.regionKey || "")) error(errors, "regionKey", "invalid_region_key", "canonical regionKey is required");
  if (!MOMENTUM_SCOPES.includes(value.scope)) error(errors, "scope", "invalid_scope", "momentum scope must separate within-region and cross-region uses");
  for (const field of ["from", "to"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(value.period?.[field] || "") || !validTime(value.period[field])) error(errors, `period.${field}`, "invalid_date", `period.${field} is required`);
  if (validTime(value.period?.from) && validTime(value.period?.to) && Date.parse(value.period.from) > Date.parse(value.period.to)) error(errors, "period.to", "invalid_range", "period.to must not precede period.from");
  if (!validTime(value.featureAsOf)) error(errors, "featureAsOf", "invalid_time", "featureAsOf is required");
  for (const field of ["modelVersion", "weightsVersion", "normalizationVersion"]) if (!text(value[field], 120)) error(errors, field, "required", `${field} is required`);
  if (!STATUSES.includes(value.status)) error(errors, "status", "invalid_status", "momentum status is invalid");
  if (!Array.isArray(value.components) || value.components.length < 2) error(errors, "components", "insufficient_components", "at least two driver components are required");
  const keys = new Set();
  for (const [index, component] of (value.components || []).entries()) {
    const prefix = `components.${index}`;
    if (!component.key || keys.has(component.key)) error(errors, `${prefix}.key`, component.key ? "duplicate" : "required", "component key must be unique");
    keys.add(component.key);
    if (!component.signalRole || !component.sourceId || !component.metricKey) error(errors, prefix, "identity_required", "component role/source/metric are required");
    if (containsRevenueIdentity(component)) error(errors, prefix, "target_leakage", "revenue targets cannot be momentum features");
    if (!SIGNAL_DIRECTIONS.includes(component.direction)) error(errors, `${prefix}.direction`, "invalid_direction", "component direction is invalid");
    if (!Number.isFinite(component.weight) || component.weight <= 0) error(errors, `${prefix}.weight`, "invalid_weight", "component weight must be positive");
    if (!STATUSES.includes(component.status)) error(errors, `${prefix}.status`, "invalid_status", "component status is invalid");
    if (component.normalizedValue !== null && (!Number.isFinite(component.normalizedValue) || component.normalizedValue < 0 || component.normalizedValue > 100)) error(errors, `${prefix}.normalizedValue`, "invalid_value", "component normalizedValue must be 0-100 or null");
    if (["missing", "conflict"].includes(component.status) && component.normalizedValue !== null) error(errors, `${prefix}.normalizedValue`, "status_requires_null", "missing/conflict cannot have a normalized value");
    if (!["missing", "conflict"].includes(component.status) && !Number.isFinite(component.normalizedValue)) error(errors, `${prefix}.normalizedValue`, "value_required", "observed component statuses require a normalized value");
    if (component.status === "zero" && component.normalizedValue !== 0) error(errors, `${prefix}.normalizedValue`, "zero_requires_zero", "zero status requires numeric zero");
    if (!validTime(component.availableAt)) error(errors, `${prefix}.availableAt`, "invalid_time", "component availableAt is required");
    if (!validTime(component.measurementPeriod?.from)) error(errors, `${prefix}.measurementPeriod.from`, "invalid_time", "component measurementPeriod.from is required");
    if (!validTime(component.measurementPeriod?.to)) error(errors, `${prefix}.measurementPeriod.to`, "invalid_time", "component measurementPeriod.to is required");
    if (validTime(component.measurementPeriod?.from) && validTime(component.measurementPeriod?.to) && Date.parse(component.measurementPeriod.from) > Date.parse(component.measurementPeriod.to)) error(errors, `${prefix}.measurementPeriod.to`, "invalid_range", "component measurement period is invalid");
    if (validTime(component.availableAt) && validTime(value.featureAsOf) && Date.parse(component.availableAt) > Date.parse(value.featureAsOf)) error(errors, `${prefix}.availableAt`, "feature_leakage", "component was unavailable at featureAsOf");
    if (validTime(component.measurementPeriod?.to) && validTime(value.featureAsOf) && Date.parse(component.measurementPeriod.to) > Date.parse(value.featureAsOf)) error(errors, `${prefix}.measurementPeriod.to`, "feature_leakage", "component measurement period exceeds featureAsOf");
    if (!CONFIDENCE_GRADES.includes(component.confidence?.grade)) error(errors, `${prefix}.confidence.grade`, "invalid_grade", "component confidence grade is invalid");
    if (component.status === "missing" && (component.confidence?.grade !== "U" || component.confidence?.score !== null)) error(errors, `${prefix}.confidence`, "missing_requires_unknown_quality", "missing components use U/null confidence");
    if (component.status !== "missing" && (!Number.isFinite(component.confidence?.score) || component.confidence.score < 0 || component.confidence.score > 100)) error(errors, `${prefix}.confidence.score`, "invalid_score", "observed components require a 0-100 confidence score");
    if (component.coverage?.numerator === null || component.coverage?.denominator === null || component.coverage.numerator > component.coverage.denominator) error(errors, `${prefix}.coverage`, "invalid_coverage", "component coverage counts must be valid");
    if (component.coverage?.denominator > 0 && Math.abs(component.coverage.ratio - component.coverage.numerator / component.coverage.denominator) > 1e-12) error(errors, `${prefix}.coverage.ratio`, "inconsistent_ratio", "component coverage ratio must match its counts");
  }
  if (!Number.isFinite(value.minimumWeightCoverage) || value.minimumWeightCoverage <= 0 || value.minimumWeightCoverage > 1) error(errors, "minimumWeightCoverage", "invalid_rate", "minimumWeightCoverage must be in (0,1]");
  if (value.value !== null && (!Number.isFinite(value.value) || value.value < 0 || value.value > 100)) error(errors, "value", "invalid_value", "momentum value must be 0-100 or null");
  if (["missing", "conflict"].includes(value.status) && value.value !== null) error(errors, "value", "status_requires_null", "missing/conflict momentum must be null");
  if (value.calculation?.qualityAdjustsValue !== false || value.calculation?.revenueUsedAsFeature !== false) error(errors, "calculation", "separation_required", "quality and revenue must not alter the momentum score");
  const expectedPublishable = ["ready", "zero"].includes(value.status) && ["ready", "zero"].includes(value.dataQuality?.status);
  if (value.publishable !== expectedPublishable) error(errors, "publishable", "inconsistent_publishability", "only ready/zero momentum with ready/zero data quality may be published");
  if (!STATUSES.includes(value.dataQuality?.status)) error(errors, "dataQuality.status", "invalid_status", "data quality status is invalid");
  if (!CONFIDENCE_GRADES.includes(value.dataQuality?.grade)) error(errors, "dataQuality.grade", "invalid_grade", "data quality grade is invalid");
  if (value.dataQuality?.status === "missing" && (value.dataQuality.grade !== "U" || value.dataQuality.score !== null)) error(errors, "dataQuality", "missing_requires_unknown_quality", "missing quality uses U/null");
  if (value.dataQuality?.status !== "missing" && (!Number.isFinite(value.dataQuality?.score) || value.dataQuality.score < 0 || value.dataQuality.score > 100)) error(errors, "dataQuality.score", "invalid_score", "data quality score must be between 0 and 100");
  if (value.dataQuality?.coverage?.numerator === null || value.dataQuality?.coverage?.denominator === null || value.dataQuality.coverage.numerator > value.dataQuality.coverage.denominator) error(errors, "dataQuality.coverage", "invalid_coverage", "data quality coverage counts must be valid");
  if (!/^[a-f0-9]{64}$/.test(value.snapshotHash || "")) error(errors, "snapshotHash", "invalid_hash", "snapshotHash is required");
  const expectedHash = hash({ ...value, snapshotHash: undefined });
  if (value.snapshotHash && value.snapshotHash !== expectedHash) error(errors, "snapshotHash", "hash_mismatch", "snapshotHash must match the score inputs");
  return { valid: errors.length === 0, errors };
}

function buildRegionalMarketMomentum(input = {}) {
  const normalized = normalizeMomentum(input);
  const validation = validateMomentum(normalized);
  if (!validation.valid) throw new RegionalMomentumContractError("regional_market_momentum", validation.errors);
  return deepFreeze(normalized);
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function pearson(left = [], right = []) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 0 ? numerator / denominator : null;
}

function ranks(values = []) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = Array(values.length);
  let cursor = 0;
  while (cursor < ordered.length) {
    let end = cursor;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[cursor].value) end += 1;
    const rank = (cursor + end + 2) / 2;
    for (let index = cursor; index <= end; index += 1) result[ordered[index].index] = rank;
    cursor = end + 1;
  }
  return result;
}

function directionAgreement(left = [], right = []) {
  let comparable = 0;
  let agreed = 0;
  for (let index = 1; index < left.length; index += 1) {
    const leftDirection = Math.sign(left[index] - left[index - 1]);
    const rightDirection = Math.sign(right[index] - right[index - 1]);
    if (leftDirection === 0 || rightDirection === 0) continue;
    comparable += 1;
    if (leftDirection === rightDirection) agreed += 1;
  }
  return { comparable, agreed, rate: comparable ? agreed / comparable : null };
}

function laggedPairs(momentum = [], revenue = [], lag = 0) {
  const left = [];
  const right = [];
  for (let index = 0; index < momentum.length; index += 1) {
    const revenueIndex = index + lag;
    if (revenueIndex < 0 || revenueIndex >= revenue.length) continue;
    left.push(momentum[index]);
    right.push(revenue[revenueIndex]);
  }
  return { left, right };
}

function buildMomentumRevenueValidation(input = {}) {
  const momentumSeries = Array.isArray(input.momentumSeries) ? input.momentumSeries : [];
  const revenueSeries = Array.isArray(input.revenueSeries) ? input.revenueSeries : [];
  const minimumSampleCount = Math.max(3, nonNegativeInteger(input.minimumSampleCount) || 6);
  const revenueByKey = new Map(revenueSeries.map((entry) => [text(entry.periodKey, 120), entry]));
  const aligned = momentumSeries
    .map((momentum) => ({ momentum, revenue: revenueByKey.get(text(momentum.periodKey, 120)) }))
    .filter(({ momentum, revenue }) => Number.isFinite(momentum?.value) && Number.isFinite(revenue?.value));
  const duplicateMomentumPeriods = momentumSeries.length !== new Set(momentumSeries.map((entry) => text(entry.periodKey, 120))).size;
  const duplicateRevenuePeriods = revenueSeries.length !== new Set(revenueSeries.map((entry) => text(entry.periodKey, 120))).size;
  const leakageErrors = aligned.filter(({ momentum, revenue }) => (
    momentum.revenueUsedAsFeature === true
    || momentum.calculation?.revenueUsedAsFeature === true
    || revenue.revenueBasis !== "settled_actual"
    || revenue.isFinal !== true
  ));
  const momentumValues = leakageErrors.length ? [] : aligned.map((entry) => Number(entry.momentum.value));
  const revenueValues = leakageErrors.length ? [] : aligned.map((entry) => Number(entry.revenue.value));
  const sampleCount = aligned.length;
  const status = leakageErrors.length || duplicateMomentumPeriods || duplicateRevenuePeriods ? "conflict" : sampleCount < minimumSampleCount ? (sampleCount ? "partial" : "missing") : "ready";
  const lagSet = [...new Set((Array.isArray(input.lags) ? input.lags : [0, 1, 2]).map((value) => Number(value)).filter(Number.isInteger))];
  const validation = {
    schemaVersion: SCHEMA_VERSIONS.revenueValidation,
    contractType: "regional_market_momentum_revenue_validation",
    regionKey: text(input.regionKey, 160),
    modelVersion: text(input.modelVersion, 120),
    evaluatedAt: timestamp(input.evaluatedAt),
    status,
    sampleCount,
    minimumSampleCount,
    revenueTarget: {
      key: "regional_average_revenue",
      requiredBasis: "settled_actual",
      finalOnly: true,
      usedAsFeature: false
    },
    metrics: {
      pearson: status === "ready" ? pearson(momentumValues, revenueValues) : null,
      spearman: status === "ready" ? pearson(ranks(momentumValues), ranks(revenueValues)) : null,
      directionAgreement: status === "ready" ? directionAgreement(momentumValues, revenueValues) : { comparable: 0, agreed: 0, rate: null },
      lagCorrelations: status === "ready"
        ? lagSet.map((lag) => {
            const pair = laggedPairs(momentumValues, revenueValues, lag);
            return { lag, sampleCount: pair.left.length, pearson: pearson(pair.left, pair.right) };
          })
        : []
    },
    guardrails: {
      forcedRevenueScaling: false,
      targetLeakageDetected: leakageErrors.some(({ momentum }) => momentum.revenueUsedAsFeature === true || momentum.calculation?.revenueUsedAsFeature === true),
      targetBasisConflict: leakageErrors.some(({ revenue }) => revenue.revenueBasis !== "settled_actual" || revenue.isFinal !== true),
      duplicatePeriodConflict: duplicateMomentumPeriods || duplicateRevenuePeriods,
      publishable: status === "ready" && Number.isFinite(pearson(momentumValues, revenueValues))
    },
    evidenceHash: hash({ momentumSeries, revenueSeries: revenueSeries.map((entry) => ({ ...entry, value: entry.value })) })
  };
  if (!/^kr_[a-z0-9_]+$/.test(validation.regionKey)) throw new RegionalMomentumContractError("revenue_validation", [{ path: "regionKey", code: "invalid_region_key", message: "canonical regionKey is required" }]);
  if (!validation.modelVersion || !validTime(validation.evaluatedAt)) throw new RegionalMomentumContractError("revenue_validation", [{ path: "metadata", code: "required", message: "modelVersion and evaluatedAt are required" }]);
  return deepFreeze(validation);
}

function buildRegionalMaintenanceForecast(input = {}) {
  const status = text(input.status || "missing", 24).toLowerCase();
  const demandPressure = status === "missing" || status === "conflict" ? null : finite(input.demandPressure);
  const forecast = {
    schemaVersion: SCHEMA_VERSIONS.maintenanceForecast,
    contractType: "regional_maintenance_forecast",
    regionKey: text(input.regionKey, 160),
    forecastHorizon: {
      from: date(input.forecastHorizon?.from),
      to: date(input.forecastHorizon?.to),
      days: nonNegativeInteger(input.forecastHorizon?.days)
    },
    modelVersion: text(input.modelVersion, 120),
    featureAsOf: timestamp(input.featureAsOf),
    generatedAt: timestamp(input.generatedAt),
    inputCoverage: normalizeCoverage(input.inputCoverage),
    sourceObservationCount: nonNegativeInteger(input.sourceObservationCount),
    demandPressure,
    confidenceInterval: {
      lower: status === "missing" || status === "conflict" ? null : finite(input.confidenceInterval?.lower),
      upper: status === "missing" || status === "conflict" ? null : finite(input.confidenceInterval?.upper),
      level: finite(input.confidenceInterval?.level)
    },
    status,
    confidence: normalizeConfidence(input.confidence, status),
    penalties: (Array.isArray(input.penalties) ? input.penalties : []).map(normalizePenalty),
    operationalOnly: true
  };
  const errors = [];
  if (!/^kr_[a-z0-9_]+$/.test(forecast.regionKey)) error(errors, "regionKey", "invalid_region_key", "canonical regionKey is required");
  if (!STATUSES.includes(status)) error(errors, "status", "invalid_status", "forecast status is invalid");
  if (!forecast.modelVersion) error(errors, "modelVersion", "required", "modelVersion is required");
  if (!validTime(forecast.featureAsOf) || !validTime(forecast.generatedAt) || Date.parse(forecast.generatedAt) < Date.parse(forecast.featureAsOf)) error(errors, "generatedAt", "invalid_time", "forecast must be generated after featureAsOf");
  if (!validTime(forecast.forecastHorizon.from) || !validTime(forecast.forecastHorizon.to) || Date.parse(forecast.forecastHorizon.from) > Date.parse(forecast.forecastHorizon.to)) error(errors, "forecastHorizon", "invalid_range", "forecast horizon is invalid");
  const expectedDays = validTime(forecast.forecastHorizon.from) && validTime(forecast.forecastHorizon.to)
    ? Math.round((Date.parse(`${forecast.forecastHorizon.to}T00:00:00.000Z`) - Date.parse(`${forecast.forecastHorizon.from}T00:00:00.000Z`)) / 86400000) + 1
    : null;
  if (expectedDays !== forecast.forecastHorizon.days) error(errors, "forecastHorizon.days", "inconsistent_duration", "days must include both horizon dates");
  if (forecast.inputCoverage.numerator === null || forecast.inputCoverage.denominator === null || forecast.inputCoverage.numerator > forecast.inputCoverage.denominator) error(errors, "inputCoverage", "invalid_coverage", "input coverage is invalid");
  if (forecast.inputCoverage.denominator > 0 && Math.abs(forecast.inputCoverage.ratio - forecast.inputCoverage.numerator / forecast.inputCoverage.denominator) > 1e-12) error(errors, "inputCoverage.ratio", "inconsistent_ratio", "input coverage ratio must match its counts");
  if (nonNegativeInteger(forecast.sourceObservationCount) === null) error(errors, "sourceObservationCount", "invalid_count", "sourceObservationCount is required");
  if (!CONFIDENCE_GRADES.includes(forecast.confidence.grade)) error(errors, "confidence.grade", "invalid_grade", "forecast confidence grade is invalid");
  if (["missing", "conflict"].includes(status)) {
    if (forecast.demandPressure !== null || forecast.confidenceInterval.lower !== null || forecast.confidenceInterval.upper !== null) error(errors, "demandPressure", "status_requires_null", "missing/conflict forecast cannot invent a value");
    if (status === "missing" && (forecast.confidence.grade !== "U" || forecast.confidence.score !== null)) error(errors, "confidence", "missing_requires_unknown_quality", "missing forecast uses U/null confidence");
  } else {
    if (!Number.isFinite(forecast.demandPressure) || forecast.demandPressure < 0 || forecast.demandPressure > 100) error(errors, "demandPressure", "invalid_value", "demandPressure must be 0-100");
    if (!Number.isFinite(forecast.confidenceInterval.lower) || !Number.isFinite(forecast.confidenceInterval.upper) || forecast.confidenceInterval.lower > forecast.demandPressure || forecast.confidenceInterval.upper < forecast.demandPressure) error(errors, "confidenceInterval", "invalid_interval", "confidence interval must contain demandPressure");
    if (!Number.isFinite(forecast.confidenceInterval.level) || forecast.confidenceInterval.level <= 0 || forecast.confidenceInterval.level >= 1) error(errors, "confidenceInterval.level", "invalid_level", "confidence level must be between 0 and 1");
    if (!Number.isFinite(forecast.confidence.score) || forecast.confidence.score < 0 || forecast.confidence.score > 100) error(errors, "confidence.score", "invalid_score", "observed forecast requires a 0-100 confidence score");
  }
  if (errors.length) throw new RegionalMomentumContractError("regional_maintenance_forecast", errors);
  return deepFreeze(forecast);
}

module.exports = {
  CONFIDENCE_GRADES,
  MOMENTUM_SCOPES,
  RegionalMomentumContractError,
  SCHEMA_VERSIONS,
  SIGNAL_DIRECTIONS,
  STATUSES,
  buildMomentumRevenueValidation,
  buildRegionalMaintenanceForecast,
  buildRegionalMarketMomentum,
  buildRegionalSignalObservation,
  directionAgreement,
  momentumComponentFromObservation,
  normalizeRegionalSignalObservation,
  pearson,
  ranks,
  validateMomentum,
  validateRegionalSignalObservation
};
