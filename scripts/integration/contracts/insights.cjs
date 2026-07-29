"use strict";

const crypto = require("node:crypto");

const INSIGHTS_STAGE = 229;
const INSIGHTS_SCHEMA_VERSION = 1;
const INSIGHTS_STORE_KIND = "glamping-datalab-v2-stage229-insights-store";
const INSIGHTS_ALGORITHM_VERSION = "v2-stage229-location-forecast-v1";
const INSIGHTS_FIXTURE_VERSION = "stage229-deterministic-signals-v1";
const INSIGHTS_PROVIDER_ID = "stage229-deterministic-signal-fixture";
const INSIGHTS_API_BASE = "/api/integration/insights";
const INSIGHTS_MINIMUM_COHORT_SIZE = 3;
const INSIGHTS_MINIMUM_FORECAST_SERIES = 3;
const INSIGHTS_REQUIRED_LEAD_DAYS = Object.freeze([14, 7, 1]);
const INSIGHTS_OBSERVATION_FRESH_HOURS = 24;
const INSIGHTS_SIGNAL_FRESH_HOURS = 168;

const INSIGHTS_READINESS_STATES = Object.freeze([
  "not-collected",
  "collecting",
  "insufficient-data",
  "not-published",
  "ready"
]);

const INSIGHTS_LIFECYCLE_STATES = Object.freeze([
  "requested",
  "draft",
  "in-review",
  "changes-requested",
  "reviewed",
  "published"
]);

const INSIGHTS_SIGNAL_KINDS = Object.freeze([
  "tourism.visitors",
  "tourism.resource-demand",
  "tourism.diversity",
  "search.volume",
  "trend.index",
  "sns.mentions",
  "structure.industry",
  "structure.catchment",
  "structure.accessibility"
]);

const INSIGHTS_DIMENSIONS = Object.freeze([
  { key: "tourism", label: "관광" },
  { key: "industry", label: "산업" },
  { key: "catchment", label: "생활권" },
  { key: "accessibility", label: "접근성" },
  { key: "interest", label: "관심도" },
  { key: "ota", label: "OTA" },
  { key: "leadtime", label: "리드타임" }
]);

function insightsError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function cleanText(value, maximum = 240) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function cleanId(value, label = "id", maximum = 160) {
  const text = cleanText(value, maximum);
  if (!text || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(text)) {
    throw insightsError(`${label} must be a URL-safe identifier`, "INSIGHTS_ID_INVALID");
  }
  return text;
}

function requiredIso(value, label = "timestamp") {
  const text = cleanText(value, 48);
  const timestamp = Date.parse(text);
  if (!text || !Number.isFinite(timestamp)) {
    throw insightsError(`${label} must be an ISO timestamp`, "INSIGHTS_TIMESTAMP_INVALID");
  }
  return new Date(timestamp).toISOString();
}

function requiredMonth(value, label = "month") {
  const text = cleanText(value, 12);
  if (!/^\d{4}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}-01T00:00:00.000Z`))) {
    throw insightsError(`${label} must use YYYY-MM`, "INSIGHTS_MONTH_INVALID");
  }
  return text;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableHash(value, length = 32) {
  const input = typeof value === "string" ? value : canonicalJson(value);
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

function clamp(value, minimum = 0, maximum = 100) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return minimum;
  return Math.min(maximum, Math.max(minimum, numeric));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function assertFixtureUrl(value, label = "sourceUrl") {
  let parsed;
  try {
    parsed = new URL(cleanText(value, 2048));
  } catch {
    throw insightsError(`${label} must be an absolute URL`, "INSIGHTS_SOURCE_URL_INVALID");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "example.invalid" && !hostname.endsWith(".example.invalid"))) {
    throw insightsError(`${label} must use the HTTPS example.invalid fixture boundary`, "INSIGHTS_EXTERNAL_PROVIDER_FORBIDDEN");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

function assertNoPrivateString(value, keyPath = "value") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPrivateString(entry, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) assertNoPrivateString(entry, `${keyPath}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  const text = value.trim();
  if (/^(?:[A-Za-z]:[\\/]|\/var\/|\/tmp\/|\/home\/|\\\\)/.test(text)) {
    throw insightsError(`Fixture value contains a filesystem path at ${keyPath}`, "INSIGHTS_RAW_PATH_FORBIDDEN");
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) assertFixtureUrl(match[0], keyPath);
}

function normalizeSignalObservation(record = {}) {
  if (record.synthetic !== true) {
    throw insightsError("Stage 229 signals must be explicitly synthetic", "INSIGHTS_SYNTHETIC_REQUIRED");
  }
  const kind = cleanText(record.kind || record.signalKind, 80);
  if (!INSIGHTS_SIGNAL_KINDS.includes(kind)) {
    throw insightsError("Unsupported Stage 229 signal kind", "INSIGHTS_SIGNAL_KIND_INVALID");
  }
  const companyId = cleanId(record.companyId, "companyId");
  const runId = cleanId(record.runId, "runId");
  const observedAt = requiredIso(record.observedAt, "observedAt");
  const periodMonth = requiredMonth(record.periodMonth, "periodMonth");
  const sourceUrl = assertFixtureUrl(record.sourceUrl);
  const source = cleanText(record.source || INSIGHTS_PROVIDER_ID, 120);
  if (source !== INSIGHTS_PROVIDER_ID) {
    throw insightsError("Stage 229 accepts only the deterministic fixture provider", "INSIGHTS_PROVIDER_FORBIDDEN");
  }
  const index = round(clamp(record.index ?? record.value), 2);
  const fixtureVersion = cleanText(record.fixtureVersion || INSIGHTS_FIXTURE_VERSION, 120);
  if (fixtureVersion !== INSIGHTS_FIXTURE_VERSION) {
    throw insightsError("Unsupported Stage 229 fixture version", "INSIGHTS_FIXTURE_VERSION_INVALID");
  }
  const provenance = clone(record.provenance || {});
  assertNoPrivateString(provenance, "signal.provenance");
  // The UTC-day bucket is carried by runId. Same-day replay stays idempotent,
  // while a later collection day in the same month remains a new observation
  // and can refresh the 168-hour signal SLA.
  const logicalKey = `${companyId}|${kind}|${periodMonth}|${fixtureVersion}|${runId}`;
  const signalId = cleanText(record.signalId, 160)
    ? cleanId(record.signalId, "signalId")
    : `signal_${stableHash(logicalKey, 32)}`;
  return {
    schemaVersion: INSIGHTS_SCHEMA_VERSION,
    signalId,
    synthetic: true,
    source,
    sourceUrl,
    fixtureVersion,
    runId,
    companyId,
    region: cleanText(record.region, 160),
    periodMonth,
    observedAt,
    kind,
    index,
    unit: "index-0-100",
    provenance: {
      ...provenance,
      source,
      sourceUrl,
      runId,
      observedAt,
      periodMonth,
      synthetic: true,
      fixtureVersion,
      externalNetworkCalls: 0
    }
  };
}

function valueOf(row) {
  return row?.values ?? row?.value;
}

function numericValue(row) {
  const value = Number(valueOf(row));
  return Number.isFinite(value) ? value : null;
}

function ageHours(value, asOf) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.parse(asOf) - timestamp) / 3_600_000);
}

function nextMonth(asOf) {
  const date = new Date(requiredIso(asOf, "asOf"));
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
}

function latestBy(rows, keyFactory) {
  const selected = new Map();
  for (const row of rows) {
    const key = keyFactory(row);
    if (!key) continue;
    const current = selected.get(key);
    if (!current || String(row.observedAt || "").localeCompare(String(current.observedAt || "")) > 0) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function latestSignal(signals, kind, asOf) {
  const row = signals.filter((entry) => entry.kind === kind)
    .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null;
  if (!row || ageHours(row.observedAt, asOf) > INSIGHTS_SIGNAL_FRESH_HOURS) return null;
  return row;
}

function average(values) {
  const rows = values.map(Number).filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function observedStockPoints(observations = []) {
  const groups = new Map();
  for (const row of observations) {
    const kind = row.observationType || row.kind;
    if (!['product.total-stock', 'product.available-stock'].includes(kind)) continue;
    const key = [row.productKey, row.targetDate, row.observedAt].join("|");
    const group = groups.get(key) || {
      productKey: row.productKey,
      targetDate: row.targetDate,
      observedAt: row.observedAt,
      total: null,
      available: null,
      totalRow: null,
      availableRow: null
    };
    if (kind === "product.total-stock") {
      group.total = numericValue(row);
      group.totalRow = row;
    } else {
      group.available = numericValue(row);
      group.availableRow = row;
    }
    groups.set(key, group);
  }
  return [...groups.values()].filter((row) => (
    Number.isFinite(row.total) && row.total > 0 && Number.isFinite(row.available)
  )).map((row) => ({
    ...row,
    available: clamp(row.available, 0, row.total),
    observationRows: [row.totalRow, row.availableRow].filter(Boolean),
    leadDays: Math.round((Date.parse(`${row.targetDate}T00:00:00.000Z`) - Date.parse(row.observedAt)) / 86_400_000),
    soldRate: round(clamp(((row.total - row.available) / row.total) * 100), 4)
  }));
}

function forecastSeriesSelection(observations = [], options = {}) {
  const asOf = requiredIso(options.asOf || new Date().toISOString(), "asOf");
  const inputWindowDays = Math.max(30, Math.min(365, Number(options.inputWindowDays || 90)));
  const asOfDate = asOf.slice(0, 10);
  const inputWindowStart = new Date(Date.parse(`${asOfDate}T00:00:00.000Z`) - inputWindowDays * 86_400_000)
    .toISOString().slice(0, 10);
  const points = observedStockPoints(observations).filter((row) => (
    row.targetDate >= inputWindowStart && row.targetDate <= asOfDate
  ));
  const seriesMap = new Map();
  for (const point of points) {
    const key = `${point.productKey}|${point.targetDate}`;
    if (!seriesMap.has(key)) seriesMap.set(key, []);
    seriesMap.get(key).push(point);
  }
  const complete = [];
  for (const [seriesKey, series] of seriesMap.entries()) {
    const selected = {};
    for (const leadDay of INSIGHTS_REQUIRED_LEAD_DAYS) {
      const candidates = series.filter((row) => row.leadDays === leadDay)
        .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)));
      if (candidates[0]) selected[leadDay] = candidates[0];
    }
    if (INSIGHTS_REQUIRED_LEAD_DAYS.every((leadDay) => selected[leadDay])) {
      complete.push({
        seriesKey,
        d14: selected[14],
        d7: selected[7],
        d1: selected[1],
        finalSoldRate: selected[1].soldRate,
        pacePerDay: round((selected[1].soldRate - selected[14].soldRate) / 13, 4)
      });
    }
  }
  const completeInputTimes = complete
    .flatMap((row) => [row.d14.observedAt, row.d7.observedAt, row.d1.observedAt])
    .filter(Boolean)
    .sort();
  return { asOf, points, complete, completeInputTimes };
}

function deriveForecast(observations = [], options = {}) {
  const selection = forecastSeriesSelection(observations, options);
  const { asOf, points, complete, completeInputTimes } = selection;
  const forecastMonth = requiredMonth(options.forecastMonth || nextMonth(asOf), "forecastMonth");
  // Forecast month is the output period. Input series must be completed stays
  // known at the as-of time; requiring D-1 for a future stay would make the
  // cold-start gate structurally impossible to satisfy.
  // Only the D-14/D-7/D-1 points that actually make up a complete forecast
  // series may satisfy freshness. An unrelated quick/OTA observation, or a
  // fresh but incomplete stock series, must not make an old lead-time input
  // appear current.
  const inputLatestObservedAt = completeInputTimes.at(-1) || "";
  const freshnessState = inputLatestObservedAt && ageHours(inputLatestObservedAt, asOf) <= INSIGHTS_OBSERVATION_FRESH_HOURS
    ? "fresh"
    : (inputLatestObservedAt ? "stale" : "missing");
  const reasons = [];
  if (complete.length < INSIGHTS_MINIMUM_FORECAST_SERIES) {
    reasons.push(`다음달 D-14·D-7·D-1 완전 시계열이 ${INSIGHTS_MINIMUM_FORECAST_SERIES}개 미만입니다.`);
  }
  if (freshnessState !== "fresh") reasons.push("최신 detail/leadtime 관측이 24시간 기준을 충족하지 않습니다.");
  const ready = complete.length >= INSIGHTS_MINIMUM_FORECAST_SERIES && freshnessState === "fresh";
  const values = complete.map((row) => row.finalSoldRate);
  const mean = average(values);
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1)
    : 0;
  const standardDeviation = Math.sqrt(variance);
  const margin = mean === null ? null : Math.max(5, 1.96 * standardDeviation / Math.sqrt(Math.max(1, values.length)));
  const interval = ready ? {
    low: round(clamp(mean - margin), 1),
    high: round(clamp(mean + margin), 1),
    display: `${round(clamp(mean - margin), 1)}~${round(clamp(mean + margin), 1)}점`
  } : null;
  return {
    state: ready ? "ready" : (points.length ? "insufficient-data" : "not-collected"),
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
    forecastMonth,
    asOf,
    inputPeriod: {
      from: completeInputTimes[0] || "",
      to: completeInputTimes.at(-1) || ""
    },
    sampleCount: complete.length,
    minimumSampleCount: INSIGHTS_MINIMUM_FORECAST_SERIES,
    pointsPerSeries: INSIGHTS_REQUIRED_LEAD_DAYS.length,
    requiredLeadDays: [...INSIGHTS_REQUIRED_LEAD_DAYS],
    freshness: {
      state: freshnessState,
      inputLatestObservedAt,
      latestFreshObservationAt: inputLatestObservedAt,
      maximumAgeHours: INSIGHTS_OBSERVATION_FRESH_HOURS
    },
    value: ready ? round(mean, 1) : null,
    bookingPacePerDay: ready ? round(average(complete.map((row) => row.pacePerDay)), 2) : null,
    interval,
    missingReasons: reasons,
    confidence: ready ? (complete.length >= 7 ? "high" : "medium") : "insufficient"
  };
}

function latestObservationValues(observations, kind) {
  return latestBy(
    observations.filter((row) => (row.observationType || row.kind) === kind),
    (row) => `${row.productKey || "company"}|${row.channel || "direct"}|${row.targetDate || ""}`
  );
}

function uniqueEvidenceRows(rows = [], idKey = "observationId") {
  const selected = new Map();
  for (const row of rows.filter(Boolean)) {
    const key = cleanText(row?.[idKey], 160) || stableHash(canonicalJson(row), 64);
    if (!selected.has(key)) selected.set(key, row);
  }
  return [...selected.values()];
}

function selectLocationEvidence(observations = [], signals = [], options = {}) {
  const asOf = requiredIso(options.asOf || new Date().toISOString(), "asOf");
  const forecast = forecastSeriesSelection(observations, { ...options, asOf });
  const forecastObservations = forecast.complete.flatMap((series) => (
    [series.d14, series.d7, series.d1].flatMap((point) => point.observationRows || [])
  ));
  const otaObservations = latestObservationValues(observations, "ota.exposure");
  const selectedSignals = INSIGHTS_SIGNAL_KINDS.map((kind) => (
    signals.filter((row) => row.kind === kind)
      .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null
  )).filter(Boolean);
  return {
    asOf,
    observations: uniqueEvidenceRows([...forecastObservations, ...otaObservations]),
    signals: uniqueEvidenceRows(selectedSignals, "signalId"),
    completeSeriesCount: forecast.complete.length
  };
}

function deriveCohortDescriptor(company = {}, observations = []) {
  // A cohort descriptor is a point-in-time company profile. Repeated stay
  // dates and lead-time observations must not inflate company size or weight
  // price/OTA bands merely because that company has been observed more often.
  const totalRows = latestBy(
    observations.filter((row) => (row.observationType || row.kind) === "product.total-stock"),
    (row) => row.productKey || "company"
  );
  const priceRows = latestBy(
    observations.filter((row) => (row.observationType || row.kind) === "product.price"),
    (row) => `${row.productKey || "company"}|${row.channel || "direct"}`
  );
  const otaRows = latestBy(
    observations.filter((row) => (row.observationType || row.kind) === "ota.exposure"),
    (row) => `${row.productKey || "company"}|${row.channel || "unknown"}`
  );
  const totalStock = totalRows.map(numericValue).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const averagePrice = average(priceRows.map(numericValue));
  const exposedChannels = new Set(otaRows.filter((row) => Boolean(valueOf(row))).map((row) => row.channel).filter(Boolean)).size;
  return {
    region: cleanText(company.region || company.regionLabel, 160),
    category: cleanText(company.category || "glamping", 80).toLowerCase(),
    sizeBand: totalStock <= 8 ? "small" : totalStock <= 20 ? "medium" : "large",
    priceBand: averagePrice === null ? "unknown" : averagePrice < 120_000 ? "budget" : averagePrice < 200_000 ? "standard" : "premium",
    otaBand: exposedChannels <= 1 ? "low" : exposedChannels === 2 ? "medium" : "high"
  };
}

function descriptorsEqual(left, right) {
  return ["region", "category", "sizeBand", "priceBand", "otaBand"].every((key) => left[key] === right[key]);
}

function eligibleReportCompany(entry = {}, asOf = "") {
  const company = entry.company || {};
  const observations = Array.isArray(entry.observations) ? entry.observations : [];
  const hasRegion = Boolean(cleanText(company.region || company.regionLabel, 160));
  const hasCategory = Boolean(cleanText(company.category, 80));
  const stockPoints = observedStockPoints(observations);
  const prices = observations.filter((row) => (
    (row.observationType || row.kind) === "product.price" && Number.isFinite(numericValue(row))
  ));
  const ota = observations.filter((row) => (row.observationType || row.kind) === "ota.exposure");
  const fresh = (rows) => {
    const latest = rows.map((row) => row.observedAt).filter(Boolean).sort().at(-1) || "";
    const elapsed = Date.parse(asOf) - Date.parse(latest);
    return Boolean(latest) && Number.isFinite(elapsed) && elapsed >= 0
      && elapsed <= INSIGHTS_OBSERVATION_FRESH_HOURS * 3_600_000;
  };
  return hasRegion && hasCategory && fresh(stockPoints) && fresh(prices) && fresh(ota);
}

function reportMetricRows(entry = {}) {
  const observations = entry.observations || [];
  const prices = latestBy(
    observations.filter((row) => (row.observationType || row.kind) === "product.price"),
    (row) => `${row.productKey || "company"}|${row.channel || "direct"}`
  );
  const stockPoints = latestBy(
    observedStockPoints(observations),
    (row) => `${row.productKey || "company"}|${row.targetDate || ""}`
  );
  const ota = latestBy(
    observations.filter((row) => (row.observationType || row.kind) === "ota.exposure"),
    (row) => `${row.productKey || "company"}|${row.channel || "unknown"}`
  );
  return {
    prices,
    stockPoints,
    ota,
    observations: uniqueEvidenceRows([
      ...prices,
      ...stockPoints.flatMap((row) => row.observationRows || []),
      ...ota
    ])
  };
}

function aggregateCompanyMetrics(rows = []) {
  const prices = [];
  const soldRates = [];
  const ota = [];
  for (const entry of rows) {
    const selected = reportMetricRows(entry);
    prices.push(...selected.prices.map(numericValue).filter(Number.isFinite));
    soldRates.push(...selected.stockPoints.map((row) => row.soldRate));
    ota.push(...selected.ota.map((row) => Boolean(valueOf(row)) ? 100 : 0));
  }
  return {
    averagePrice: prices.length ? Math.round(average(prices)) : null,
    soldRate: soldRates.length ? round(average(soldRates), 1) : null,
    otaExposureRate: ota.length ? round(average(ota), 1) : null
  };
}

function reportScopeSelection(companyId, companies = [], options = {}) {
  const own = companies.find((entry) => entry.company?.companyId === companyId) || null;
  if (!own) throw insightsError("Fresh company was not found", "INSIGHTS_COMPANY_NOT_FOUND", 404);
  const ownLatestObservedAt = (own.observations || []).map((row) => row.observedAt).filter(Boolean).sort().at(-1) || "";
  const asOf = requiredIso(options.asOf || ownLatestObservedAt || new Date().toISOString(), "asOf");
  const descriptor = deriveCohortDescriptor(own.company, own.observations || []);
  const eligible = companies.filter((entry) => eligibleReportCompany(entry, asOf));
  const regional = eligible.filter((entry) => cleanText(entry.company?.region || entry.company?.regionLabel, 160) === descriptor.region);
  const cohort = eligible.filter((entry) => (
    entry.company?.companyId !== companyId
    && descriptorsEqual(deriveCohortDescriptor(entry.company, entry.observations || []), descriptor)
  ));
  return { asOf, own, descriptor, eligible, regional, cohort };
}

function deriveReportScopes(companyId, companies = [], options = {}) {
  const { descriptor, eligible, regional, cohort, own } = reportScopeSelection(companyId, companies, options);
  const definitions = [
    { scope: "national", label: "전국", rows: eligible, minimumSampleCount: INSIGHTS_MINIMUM_COHORT_SIZE, anonymous: true },
    { scope: "region", label: "지역", rows: regional, minimumSampleCount: INSIGHTS_MINIMUM_COHORT_SIZE, anonymous: true },
    { scope: "own", label: "내 숙소", rows: eligible.includes(own) ? [own] : [], minimumSampleCount: 1, anonymous: false },
    { scope: "anonymous-cohort", label: "익명 비교군", rows: cohort, minimumSampleCount: INSIGHTS_MINIMUM_COHORT_SIZE, anonymous: true }
  ];
  return definitions.map((definition) => {
    const ready = definition.rows.length >= definition.minimumSampleCount;
    return {
      scope: definition.scope,
      label: definition.label,
      state: ready ? "ready" : "insufficient-data",
      sampleCount: definition.rows.length,
      minimumSampleCount: definition.minimumSampleCount,
      anonymous: definition.anonymous,
      cohort: definition.scope === "anonymous-cohort" ? clone(descriptor) : null,
      metrics: ready ? aggregateCompanyMetrics(definition.rows) : null,
      missingReasons: ready ? [] : [`${definition.label} 표본이 ${definition.minimumSampleCount}개 미만입니다.`]
    };
  });
}

function selectReportEvidence(companyId, companies = [], options = {}) {
  const selection = reportScopeSelection(companyId, companies, options);
  const scopeCompanyIds = {
    national: selection.eligible.map((entry) => entry.company.companyId).sort(),
    region: selection.regional.map((entry) => entry.company.companyId).sort(),
    own: selection.eligible.includes(selection.own) ? [companyId] : [],
    anonymousCohort: selection.cohort.map((entry) => entry.company.companyId).sort()
  };
  const observations = uniqueEvidenceRows(
    selection.eligible.flatMap((entry) => reportMetricRows(entry).observations)
  );
  return {
    asOf: selection.asOf,
    observations,
    companyIds: scopeCompanyIds.national,
    scopeCompanyIds,
    cohortSnapshotHash: stableHash({
      algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
      asOf: selection.asOf,
      descriptor: selection.descriptor,
      scopeCompanyIds
    }, 64)
  };
}

function dimensionScore(signals, kinds, weights, asOf) {
  const rows = kinds.map((kind) => latestSignal(signals, kind, asOf));
  if (rows.some((row) => !row)) return null;
  return round(rows.reduce((sum, row, index) => sum + row.index * weights[index], 0), 1);
}

function deriveLocationAnalysis(input = {}) {
  const observations = Array.isArray(input.observations) ? input.observations : [];
  const signals = Array.isArray(input.signals) ? input.signals : [];
  const asOf = requiredIso(input.asOf || new Date().toISOString(), "asOf");
  const forecast = deriveForecast(observations, { asOf, forecastMonth: input.forecastMonth });
  const otaRows = latestObservationValues(observations, "ota.exposure");
  const otaLatestObservedAt = otaRows.map((row) => row.observedAt).filter(Boolean).sort().at(-1) || "";
  const otaFresh = Boolean(otaLatestObservedAt)
    && ageHours(otaLatestObservedAt, asOf) <= INSIGHTS_OBSERVATION_FRESH_HOURS;
  const leadtimeLatestObservedAt = forecast.freshness.inputLatestObservedAt || "";
  const leadtimeFresh = forecast.freshness.state === "fresh";
  const observationFresh = leadtimeFresh && otaFresh;
  const observationFreshnessState = !leadtimeLatestObservedAt || !otaLatestObservedAt
    ? "missing"
    : observationFresh ? "fresh" : "stale";
  const requiredObservationTimes = [leadtimeLatestObservedAt, otaLatestObservedAt].filter(Boolean).sort();
  const latestObservationAt = requiredObservationTimes[0] || "";
  const latestSignalsByKind = INSIGHTS_SIGNAL_KINDS.map((kind) => (
    signals.filter((row) => row.kind === kind)
      .sort((left, right) => String(right.observedAt).localeCompare(String(left.observedAt)))[0] || null
  ));
  const signalMissing = latestSignalsByKind.some((row) => !row);
  const signalStale = !signalMissing && latestSignalsByKind.some((row) => (
    ageHours(row.observedAt, asOf) > INSIGHTS_SIGNAL_FRESH_HOURS
  ));
  const signalFreshnessState = signalMissing ? "missing" : signalStale ? "stale" : "fresh";
  const latestSignalAt = latestSignalsByKind.map((row) => row?.observedAt).filter(Boolean).sort()[0] || "";
  const scores = {
    tourism: dimensionScore(signals, ["tourism.visitors", "tourism.resource-demand", "tourism.diversity"], [0.4, 0.35, 0.25], asOf),
    industry: dimensionScore(signals, ["structure.industry"], [1], asOf),
    catchment: dimensionScore(signals, ["structure.catchment"], [1], asOf),
    accessibility: dimensionScore(signals, ["structure.accessibility"], [1], asOf),
    interest: dimensionScore(signals, ["search.volume", "trend.index", "sns.mentions"], [0.4, 0.35, 0.25], asOf),
    ota: otaRows.length && otaFresh ? round(average(otaRows.map((row) => Boolean(valueOf(row)) ? 100 : 0)), 1) : null,
    leadtime: forecast.state === "ready" ? forecast.value : null
  };
  const dimensions = INSIGHTS_DIMENSIONS.map((dimension) => ({
    ...dimension,
    state: Number.isFinite(scores[dimension.key]) ? "ready" : (observations.length || signals.length ? "insufficient-data" : "not-collected"),
    score: Number.isFinite(scores[dimension.key]) ? scores[dimension.key] : null
  }));
  const ready = dimensions.every((dimension) => dimension.state === "ready");
  const missingDimensions = dimensions.filter((dimension) => dimension.state !== "ready").map((dimension) => dimension.key);
  const overallScore = ready ? round(average(dimensions.map((dimension) => dimension.score)), 1) : null;
  const confidenceCauses = [
    ready ? "7개 지역 구조 차원의 신규 입력이 모두 준비되었습니다." : `미충족 차원: ${missingDimensions.join(", ") || "없음"}`,
    `forecast 완전 시계열 ${forecast.sampleCount}/${forecast.minimumSampleCount}`,
    `signal fixture version ${INSIGHTS_FIXTURE_VERSION}`
  ];
  return {
    state: ready ? "ready" : (observations.length || signals.length ? "insufficient-data" : "not-collected"),
    algorithmVersion: INSIGHTS_ALGORITHM_VERSION,
    asOf,
    overallScore,
    dimensions,
    forecast,
    readiness: {
      state: ready ? "ready" : (observations.length || signals.length ? "insufficient-data" : "not-collected"),
      sampleCount: forecast.sampleCount,
      minimumSampleCount: forecast.minimumSampleCount,
      freshness: {
        observations: observationFreshnessState,
        signals: signalFreshnessState,
        latestObservationAt,
        latestSignalAt,
        leadtimeLatestObservedAt,
        otaLatestObservedAt,
        requiredSignalKinds: INSIGHTS_SIGNAL_KINDS.length,
        presentSignalKinds: latestSignalsByKind.filter(Boolean).length
      },
      confidence: ready ? (forecast.confidence === "high" ? "high" : "medium") : "insufficient",
      confidenceCauses,
      nextCollectionCta: ready ? null : {
        kind: forecast.state !== "ready"
          ? "collect-leadtime"
          : !otaFresh ? "collect-ota" : "collect-signals",
        label: forecast.state !== "ready"
          ? "D-14·D-7·D-1 반복 관측 보강"
          : !otaFresh ? "OTA 신규 관측 보강" : "신호 fixture 갱신"
      }
    }
  };
}

function allowedActionsForLifecycle(lifecycle) {
  return {
    requested: ["create-draft"],
    draft: ["edit-draft", "submit-review"],
    "in-review": ["approve-review", "request-changes"],
    "changes-requested": ["edit-draft"],
    reviewed: ["publish"],
    published: []
  }[lifecycle] || [];
}

function assertLifecycleTransition(from, to) {
  const allowed = {
    requested: ["draft"],
    draft: ["draft", "in-review"],
    "in-review": ["reviewed", "changes-requested"],
    "changes-requested": ["draft"],
    reviewed: ["published"],
    published: []
  }[from] || [];
  if (!allowed.includes(to)) {
    throw insightsError(`Invalid Stage 229 lifecycle transition: ${from} -> ${to}`, "INSIGHTS_LIFECYCLE_INVALID", 409);
  }
  return true;
}

module.exports = {
  INSIGHTS_ALGORITHM_VERSION,
  INSIGHTS_API_BASE,
  INSIGHTS_DIMENSIONS,
  INSIGHTS_FIXTURE_VERSION,
  INSIGHTS_LIFECYCLE_STATES,
  INSIGHTS_MINIMUM_COHORT_SIZE,
  INSIGHTS_MINIMUM_FORECAST_SERIES,
  INSIGHTS_OBSERVATION_FRESH_HOURS,
  INSIGHTS_PROVIDER_ID,
  INSIGHTS_READINESS_STATES,
  INSIGHTS_REQUIRED_LEAD_DAYS,
  INSIGHTS_SCHEMA_VERSION,
  INSIGHTS_SIGNAL_FRESH_HOURS,
  INSIGHTS_SIGNAL_KINDS,
  INSIGHTS_STAGE,
  INSIGHTS_STORE_KIND,
  aggregateCompanyMetrics,
  allowedActionsForLifecycle,
  assertFixtureUrl,
  assertLifecycleTransition,
  assertNoPrivateString,
  canonicalJson,
  cleanId,
  cleanText,
  clone,
  deriveCohortDescriptor,
  deriveForecast,
  deriveLocationAnalysis,
  deriveReportScopes,
  insightsError,
  nextMonth,
  normalizeSignalObservation,
  requiredIso,
  requiredMonth,
  selectLocationEvidence,
  selectReportEvidence,
  stableHash
};
